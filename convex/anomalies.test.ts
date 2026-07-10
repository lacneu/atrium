/// <reference types="vite/client" />
//
// Deterministic unit test for anomaly detection + heartbeat (increment 6).
//
// Exercises the DETERMINISTIC core only — no @convex-dev/auth session
// simulation (the key-authed HTTP path is live-verified by the lead). We:
//   1. seed traceEvents that should trip the error-ratio AND dispatch-failure
//      detectors (inside the detector's recent window),
//   2. run detectAnomalies and assert OPEN anomalies are created,
//   3. re-run and assert NO duplicate is created (one open row per kind),
//   4. resolveAnomalyInternal flips status + stamps resolvedAt,
//   5. heartbeatInternal counts {openCount, criticalCount, latestAt, bySeverity},
//   6. reportAnomalyInternal inserts a source:"agent" row.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// Discover function modules for convex-test (required).
const modules = import.meta.glob("./**/*.ts");

/** Insert a trace event directly (db context — no auth needed). */
async function seedTrace(
  ctx: any,
  e: {
    kind: string;
    at?: number;
    status?: number;
    meta?: Record<string, unknown>;
    correlationId?: string;
  },
): Promise<void> {
  await ctx.db.insert("traceEvents", {
    at: e.at ?? Date.now(),
    kind: e.kind,
    principalType: "system",
    status: e.status,
    redacted: true,
    correlationId: e.correlationId,
    meta: e.meta ? JSON.stringify(e.meta) : undefined,
  });
}

describe("anomaly detection", () => {
  test("a SINGLE dispatch failure trips a WARN anomaly with root cause + drill-down anchor (threshold 1)", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      // ONE failed dispatch, carrying the curated root-cause code (errorCode) and
      // the failing turn's correlationId — exactly what bridge.ts now writes.
      await seedTrace(ctx, {
        kind: "openclaw.dispatch",
        at: now - 1000,
        correlationId: "chat123:outbox456",
        meta: { dispatchStatus: "failed", errorCode: "AGENT_NOT_FOUND" },
      });
    });

    const r = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r.detected).toContain("openclaw.dispatch_failures");

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "openclaw.dispatch_failures"),
        )
        .first(),
    );
    expect(row).not.toBeNull();
    // 1 failure is a WARN (CRITICAL only at >=10) — so a self-repair signal keyed
    // on criticalCount is NOT tripped by a single failure.
    expect(row!.severity).toBe("warn");
    const ev = JSON.parse(row!.evidence!) as {
      dispatchFailures: number;
      dominantCode: string;
      sampleCorrelationId: string;
    };
    expect(ev.dispatchFailures).toBe(1);
    expect(ev.dominantCode).toBe("AGENT_NOT_FOUND"); // the actionable root cause
    expect(ev.sampleCorrelationId).toBe("chat123:outbox456"); // drill-down anchor
  });

  test("detects, de-dupes, resolves, and heartbeats", async () => {
    const t = convexTest(schema, modules);

    // Seed a window that trips BOTH the error-ratio (>=10 calls, >=50% errors
    // => critical) AND the dispatch-failure (>=10 failures => critical) detectors.
    await t.run(async (ctx) => {
      const now = Date.now();
      // 12 api.call: 8 errors (>=400), 4 ok -> ratio 0.66 >= critical 0.5.
      for (let i = 0; i < 8; i++) {
        await seedTrace(ctx, { kind: "api.call", at: now - i * 1000, status: 500 });
      }
      for (let i = 0; i < 4; i++) {
        await seedTrace(ctx, { kind: "api.call", at: now - i * 1000, status: 200 });
      }
      // 11 failed dispatches -> critical (>=10).
      for (let i = 0; i < 11; i++) {
        await seedTrace(ctx, {
          kind: "openclaw.dispatch",
          at: now - i * 1000,
          meta: { dispatchStatus: "failed" },
        });
      }
      // A few SUCCESSFUL dispatches must NOT count.
      for (let i = 0; i < 3; i++) {
        await seedTrace(ctx, {
          kind: "openclaw.dispatch",
          at: now - i * 1000,
          meta: { dispatchStatus: "sent" },
        });
      }
    });

    // First detection run -> creates open anomalies.
    const r1 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r1.detected).toContain("api.error_ratio");
    expect(r1.detected).toContain("openclaw.dispatch_failures");

    const afterFirst = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    expect(afterFirst.length).toBe(2);
    // Both should be critical given the seeded magnitudes.
    expect(afterFirst.every((a) => a.severity === "critical")).toBe(true);
    expect(afterFirst.every((a) => a.source === "detector")).toBe(true);

    // Second run over the SAME window -> de-dupe: still exactly 2 open rows.
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const afterSecond = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    expect(afterSecond.length).toBe(2);

    // Heartbeat reflects the 2 open critical anomalies.
    const hb1 = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb1.openCount).toBe(2);
    expect(hb1.criticalCount).toBe(2);
    expect(hb1.bySeverity.critical).toBe(2);
    expect(hb1.latestAt).not.toBeNull();

    // Resolve one anomaly -> status flips + resolvedAt stamped.
    const target = afterSecond.find((a) => a.kind === "api.error_ratio")!;
    const res = await t.mutation(internal.anomalies.resolveAnomalyInternal, {
      anomalyId: target._id as Id<"anomalies">,
      resolvedBy: "test",
    });
    expect(res.ok).toBe(true);

    const resolved = await t.run(async (ctx) => {
      return await ctx.db.get(target._id as Id<"anomalies">);
    });
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolvedAt).not.toBeUndefined();
    expect(resolved!.resolvedBy).toBe("test");

    // Heartbeat now counts only the 1 remaining open critical anomaly.
    const hb2 = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb2.openCount).toBe(1);
    expect(hb2.criticalCount).toBe(1);
  });

  test("TWO real stream errors trip the WARN (the 2026-07-09 live incident sat under the old threshold of 3)", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 1000 - i * 100,
          correlationId: `chatJ:webchat-run${i}`,
          meta: { phase: "finalize", streamStatus: "error", textLen: 0 },
        });
      }
    });
    const r = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r.detected).toContain("assistant.stream_errors");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.stream_errors"),
        )
        .first(),
    );
    expect(row!.severity).toBe("warn");
    const ev = JSON.parse(row!.evidence!) as {
      streamErrors: number;
      streamAborts: number;
      sampleCorrelationId: string;
    };
    expect(ev.streamErrors).toBe(2);
    expect(ev.streamAborts).toBe(0);
    // Drill-down anchor: the most RECENT failed turn's correlation chain.
    expect(ev.sampleCorrelationId).toBe("chatJ:webchat-run0");
  });

  test("user STOPS (aborted) never trip the WARN — but a mass combined burst reaches CRITICAL", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    // 4 user aborts, zero errors -> NO anomaly (a Stop is a user choice).
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 1000 - i * 100,
          meta: { phase: "finalize", streamStatus: "aborted" },
        });
      }
    });
    const r1 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r1.detected).not.toContain("assistant.stream_errors");
    // 10 combined (1 error + 9 aborts) -> CRITICAL (mass-interrupt burst).
    await t.run(async (ctx) => {
      await seedTrace(ctx, {
        kind: "assistant.stream",
        at: now - 500,
        meta: { phase: "finalize", streamStatus: "error", textLen: 0 },
      });
      for (let i = 0; i < 5; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 900 - i * 10,
          meta: { phase: "finalize", streamStatus: "aborted" },
        });
      }
    });
    const r2 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r2.detected).toContain("assistant.stream_errors");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.stream_errors"),
        )
        .first(),
    );
    expect(row!.severity).toBe("critical"); // 1 error + 9 aborts = combined 10
  });

  test("a COMPLETE finalize never counts toward stream errors", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 1000 - i * 100,
          meta: { phase: "finalize", streamStatus: "complete", textLen: 42 },
        });
      }
    });
    const r = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r.detected).not.toContain("assistant.stream_errors");
  });

  test("reportAnomalyInternal inserts a source:agent anomaly", async () => {
    const t = convexTest(schema, modules);

    const { id } = await t.mutation(internal.anomalies.reportAnomalyInternal, {
      kind: "self.repair",
      severity: "info",
      message: "agent restarted bridge connection",
      evidence: JSON.stringify({ reportedBy: "svc-account-1" }),
    });

    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row).not.toBeNull();
    expect(row!.source).toBe("agent");
    expect(row!.status).toBe("open");
    expect(row!.kind).toBe("self.repair");
    // A fresh "open" agent-reported row must NOT carry resolution-time fields.
    expect(row!.resolvedBy).toBeUndefined();
    expect(row!.resolvedAt).toBeUndefined();
    // Reporter attribution lives in evidence (the route folds it in; here we
    // assert the mutation faithfully persists whatever evidence string it gets).
    expect(JSON.parse(row!.evidence!).reportedBy).toBe("svc-account-1");

    // It shows up in the open listing.
    const open = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    expect(open.some((a) => a.kind === "self.repair")).toBe(true);
  });

  test("access-scan: a key reading many distinct chats trips an ACCESS_SCAN anomaly", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      // "scanner" reads 30 distinct chats (> 25 WARN, < 100 CRITICAL); "legit"
      // reads only 2 (a normal debug session). status 200 -> not an error burst.
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("traceEvents", {
          at: now - i * 1000,
          kind: "api.call",
          principalType: "service",
          principalId: "scanner",
          roleKey: "agent",
          route: "/api/v1/chat-state",
          status: 200,
          chatId: `chat-${i}`,
          redacted: true,
        });
      }
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("traceEvents", {
          at: now - i * 1000,
          kind: "api.call",
          principalType: "service",
          principalId: "legit",
          roleKey: "agent",
          route: "/api/v1/chat-state",
          status: 200,
          chatId: `c-${i}`,
          redacted: true,
        });
      }
    });
    const r = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r.detected).toContain("api.access_scan");
    const rows = await t.run((ctx) => ctx.db.query("anomalies").collect());
    const scan = rows.find((a) => a.kind === "api.access_scan");
    expect(scan).toBeDefined();
    expect(scan!.severity).toBe("warn");
    const ev = JSON.parse(scan!.evidence!) as {
      principalId: string;
      distinctChats: number;
    };
    expect(ev.principalId).toBe("scanner"); // the worst key, not "legit"
    expect(ev.distinctChats).toBe(30);
  });

  test("error ratio below the minimum denominator does not fire", async () => {
    const t = convexTest(schema, modules);
    // 1 error / 1 call = 100% ratio but only 1 call -> below the floor (10).
    await t.run(async (ctx) => {
      await seedTrace(ctx, { kind: "api.call", status: 500 });
    });
    const r = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r.detected).not.toContain("api.error_ratio");
    const open = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    expect(open.length).toBe(0);
  });

  // --- M2: auto-resolve when the condition clears ---------------------------
  test("auto-resolves a detector anomaly once its condition is gone", async () => {
    const t = convexTest(schema, modules);

    // Seed a window that trips the dispatch-failure detector (>=10 failures).
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 11; i++) {
        await seedTrace(ctx, {
          kind: "openclaw.dispatch",
          at: now - i * 1000,
          meta: { dispatchStatus: "failed" },
        });
      }
    });

    const r1 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r1.detected).toContain("openclaw.dispatch_failures");
    let hb = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb.openCount).toBe(1);

    // The condition clears (delete the failing traces), then re-run: the open
    // detector row is auto-resolved and openCount returns to 0.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("traceEvents").collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    const r2 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r2.detected).not.toContain("openclaw.dispatch_failures");
    expect(r2.autoResolved).toContain("openclaw.dispatch_failures");

    hb = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb.openCount).toBe(0);

    // The row is resolved (not deleted) for audit, attributed to the detector.
    const resolved = await t.query(internal.anomalies.anomaliesInternal, {
      status: "resolved",
    });
    expect(resolved.some((a) => a.kind === "openclaw.dispatch_failures")).toBe(
      true,
    );
  });

  // --- M2: de-dupe stays correct past the old OPEN_SCAN=500 cap -------------
  test("de-dupe finds the open row even with >500 open anomalies", async () => {
    const t = convexTest(schema, modules);

    // Seed 520 OPEN agent anomalies of OTHER kinds so a naive .take(500) scan of
    // the open set could miss the detector's own open row. Also seed ONE open
    // detector row for the dispatch-failures kind.
    await t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("anomalies", {
          at: Date.now() - i,
          kind: `noise.kind.${i}`,
          severity: "info",
          status: "open",
          message: "noise",
          source: "agent",
        });
      }
      await ctx.db.insert("anomalies", {
        at: Date.now() - 999999,
        kind: "openclaw.dispatch_failures",
        severity: "warn",
        status: "open",
        message: "pre-existing open detector row",
        source: "detector",
        evidence: JSON.stringify({ dispatchFailures: 3 }),
      });
    });

    // Now seed a window that re-trips dispatch failures and run the detector.
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 11; i++) {
        await seedTrace(ctx, {
          kind: "openclaw.dispatch",
          at: now - i * 1000,
          meta: { dispatchStatus: "failed" },
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});

    // The detector must PATCH the existing open row (not insert a duplicate):
    // exactly ONE open detector row for the kind, regardless of open-set size.
    const openDetectorOfKind = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "openclaw.dispatch_failures"),
        )
        .collect();
      return rows.filter((r) => r.source === "detector");
    });
    expect(openDetectorOfKind.length).toBe(1);
    // It was patched (severity bumped to critical: 11 failures >= 10).
    expect(openDetectorOfKind[0]!.severity).toBe("critical");

    // M2 heartbeat completeness: 520 noise + 1 detector = 521 open rows, which
    // is > OPEN_SCAN (500). The heartbeat must count ALL of them across pages
    // (no silent truncation at a single .take cap).
    const hb = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb.openCount).toBe(521);
    expect(hb.bySeverity.info).toBe(520);
    expect(hb.bySeverity.critical).toBe(1);
    expect(hb.criticalCount).toBe(1);
  });

  // --- M2: admin resolveAnomaly (requireAdmin + audit) ---------------------
  test("admin resolveAnomaly flips status and writes an audit row", async () => {
    const t = convexTest(schema, modules);

    const { adminUserId, anomalyId } = await t.run(async (ctx) => {
      const adminUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: adminUserId, role: "admin" });
      const anomalyId = await ctx.db.insert("anomalies", {
        at: Date.now(),
        kind: "manual.kind",
        severity: "warn",
        status: "open",
        message: "open anomaly",
        source: "agent",
      });
      return { adminUserId, anomalyId };
    });

    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session` });
    const res = await asAdmin.mutation(api.anomalies.resolveAnomaly, {
      anomalyId,
    });
    expect(res.ok).toBe(true);

    const row = await t.run(async (ctx) => await ctx.db.get(anomalyId));
    expect(row!.status).toBe("resolved");
    expect(row!.resolvedAt).not.toBeUndefined();

    // Audit attribution recorded.
    const audit = await t.run(async (ctx) =>
      ctx.db.query("auditLog").collect(),
    );
    expect(audit.some((a) => a.action === "anomaly.resolve")).toBe(true);

    // A non-admin is rejected.
    const otherUserId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" });
      return id;
    });
    const asUser = t.withIdentity({ subject: `${otherUserId}|session` });
    await expect(
      asUser.mutation(api.anomalies.resolveAnomaly, { anomalyId }),
    ).rejects.toThrow(/admin/i);
  });

  // --- L8: anomalies `since` filter ----------------------------------------
  test("anomaliesInternal filters by `since` (numeric ms)", async () => {
    const t = convexTest(schema, modules);
    const base = 1_000_000;
    await t.run(async (ctx) => {
      for (const at of [base, base + 100, base + 200]) {
        await ctx.db.insert("anomalies", {
          at,
          kind: "k",
          severity: "info",
          status: "open",
          message: "m",
          source: "agent",
        });
      }
    });
    const all = await t.query(internal.anomalies.anomaliesInternal, {});
    expect(all.length).toBe(3);
    const recent = await t.query(internal.anomalies.anomaliesInternal, {
      since: base + 100,
    });
    expect(recent.map((a) => a.at).sort()).toEqual([base + 100, base + 200]);
    // With a status filter too.
    const recentOpen = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
      since: base + 200,
    });
    expect(recentOpen.map((a) => a.at)).toEqual([base + 200]);
  });

  // --- L3: negative/non-integer limit is clamped (no throw) -----------------
  test("a negative limit is clamped to 0 (returns empty, never throws)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("anomalies", {
        at: Date.now(),
        kind: "k",
        severity: "info",
        status: "open",
        message: "m",
        source: "agent",
      });
    });
    const out = await t.query(internal.anomalies.anomaliesInternal, {
      limit: -5,
    });
    expect(out).toEqual([]);
    // A fractional limit floors (1.9 -> 1).
    const one = await t.query(internal.anomalies.anomaliesInternal, {
      limit: 1.9,
    });
    expect(one.length).toBe(1);
  });
});
