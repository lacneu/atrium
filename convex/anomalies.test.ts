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
import { BUILTIN_ROLES, PERMISSIONS, WILDCARD } from "./lib/rbac";

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
    // The access-scan detector keys on (principal, distinct chats), so those two
    // fields have to be seedable.
    principalId?: string;
    chatId?: string;
  },
): Promise<void> {
  await ctx.db.insert("traceEvents", {
    at: e.at ?? Date.now(),
    kind: e.kind,
    principalType: "system",
    status: e.status,
    redacted: true,
    correlationId: e.correlationId,
    principalId: e.principalId,
    chatId: e.chatId,
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
    // This burst CONTAINS a real error, so it stays on the turn-costing class (one
    // lost turn among nine stops is still a lost turn) — critical from the combined
    // rule, and waiting for a human rather than clearing itself.
    expect(r2.detected).toContain("assistant.stream_errors");
    expect(r2.detected).not.toContain("assistant.stop_bursts");
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

  test("a burst with NO errors at all is the self-clearing condition class", async () => {
    // Ten stops and zero errors: nobody lost a turn, so this must clear by itself.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 1000 - i * 100,
          meta: { phase: "finalize", streamStatus: "aborted" },
        });
      }
    });
    const r1 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r1.detected).toContain("assistant.stop_bursts");
    expect(r1.detected).not.toContain("assistant.stream_errors");
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("traceEvents").collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    const r2 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r2.autoResolved).toContain("assistant.stop_bursts");
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

  test("attachments: stored verbatim, list views carry METADATA only (name+chars)", async () => {
    const t = convexTest(schema, modules);

    const proposal = "# Proposition\n\nConstat chiffre...\n\nRemede propose...";
    const { id } = await t.mutation(internal.anomalies.reportAnomalyInternal, {
      kind: "improvement_proposal",
      severity: "info",
      message: "proposal with full text attached",
      evidence: JSON.stringify({ reportedBy: "svc-account-1" }),
      attachments: [{ name: "2026-07-10-proposal.md", content: proposal }],
    });

    // The ROW carries metadata only; the text lives in the anomalyAttachments
    // child table (bounded anomaly list scans must never load bodies).
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row!.attachments).toEqual([
      { name: "2026-07-10-proposal.md", chars: proposal.length },
    ]);
    const children = await t.run(async (ctx) =>
      ctx.db
        .query("anomalyAttachments")
        .withIndex("by_anomaly", (q) => q.eq("anomalyId", id))
        .collect(),
    );
    expect(children.map((c) => ({ name: c.name, content: c.content }))).toEqual([
      { name: "2026-07-10-proposal.md", content: proposal },
    ]);

    // The LIST projection must NOT stream the content — name + size only.
    // This is the payload-weight guarantee the UI relies on (a 200-row table
    // must never carry megabytes of proposal text).
    const open = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    const view = open.find((a) => a.kind === "improvement_proposal");
    expect(view).toBeDefined();
    expect(view!.attachments).toEqual([
      { name: "2026-07-10-proposal.md", chars: proposal.length },
    ]);
    expect(JSON.stringify(view)).not.toContain("Constat chiffre");

    // A row WITHOUT attachments projects null (not []): the UI renders no
    // button at all for it.
    const plain = open.find((a) => a.kind === "self.repair");
    // (self.repair row is from the previous test's isolated instance — insert
    // one here to assert within THIS instance.)
    expect(plain ?? null).toBeNull();
    const { id: plainId } = await t.mutation(
      internal.anomalies.reportAnomalyInternal,
      { kind: "self.repair", severity: "info", message: "no attachments" },
    );
    const open2 = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    const plainView = open2.find((a) => a._id === plainId);
    expect(plainView!.attachments).toBeNull();
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
  test("auto-resolves a CONDITION class once it clears (rate/ratio, no lost work)", async () => {
    const t = convexTest(schema, modules);

    // Ingest-denied spikes are a CONDITION, not a lost turn: they clear on their
    // own, so the heartbeat must return to 0 without a human.
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 11; i++) {
        await seedTrace(ctx, {
          kind: "openclaw.ingest.denied",
          at: now - i * 1000,
        });
      }
    });

    const r1 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r1.detected).toContain("openclaw.ingest_denied");
    let hb = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb.openCount).toBe(1);

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("traceEvents").collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    const r2 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r2.detected).not.toContain("openclaw.ingest_denied");
    expect(r2.autoResolved).toContain("openclaw.ingest_denied");

    hb = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb.openCount).toBe(0);

    // Resolved (not deleted) for audit, attributed to the detector.
    const resolved = await t.query(internal.anomalies.anomaliesInternal, {
      status: "resolved",
    });
    expect(resolved.some((a) => a.kind === "openclaw.ingest_denied")).toBe(true);
  });

  test("names the CAUSE of a failed turn, not just a count", async () => {
    // "Assistant stream errors: 2 over 15m" told an operator nothing to act on. A
    // context overflow needs a budget change and a saturated connection needs
    // bridge headroom — the old channel called both the same thing.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - i * 1000,
          correlationId: `chat:run-${i}`,
          meta: {
            phase: "finalize",
            streamStatus: "error",
            errorCode: "context_length",
          },
        });
      }
      await seedTrace(ctx, {
        kind: "assistant.stream",
        at: now - 5000,
        meta: {
          phase: "finalize",
          streamStatus: "error",
          errorCode: "connection_saturated",
        },
      });
    });
    const res = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(res.detected).toContain("assistant.cause.context_length");
    expect(res.detected).toContain("assistant.cause.connection_saturated");
    const open = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    const overflow = open.find(
      (a) => a.kind === "assistant.cause.context_length",
    );
    expect(overflow?.message).toMatch(/context_length/);
    // Two overflows in the window is already the pattern, not a blip.
    expect(overflow?.severity).toBe("critical");
  });

  test("an UNKNOWN cause still surfaces through the generic class", async () => {
    // A cause without an entry in the map must never be dropped for that reason.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - i * 1000,
          meta: {
            phase: "finalize",
            streamStatus: "error",
            errorCode: "a_cause_nobody_mapped",
          },
        });
      }
    });
    const res = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(res.detected).toContain("assistant.stream_errors");
    expect(
      res.detected.filter((k) => k.startsWith("assistant.cause.")),
    ).toHaveLength(0);
  });

  test("keeps the HISTORY of every occurrence instead of overwriting it", async () => {
    // One open row per kind + a patched `evidence` meant the second occurrence
    // erased the first, so the table could not answer "how often?". Prod could not
    // say "four times in three days" about a recurring failure — the fact an
    // operator actually decides on.
    const t = convexTest(schema, modules);
    // EXPLICIT timestamps: the second wave must be provably NEWER than the first, or
    // the run reduces to "the same failure re-read" (which is a different test). Two
    // calls to Date.now() can land in the same millisecond, so relying on the clock
    // advancing made this flaky — it failed about half the time in the full suite.
    const base = Date.now();
    const seedErrors = async (count: number, code: string, at: number) =>
      await t.run(async (ctx) => {
        for (let i = 0; i < count; i++) {
          await seedTrace(ctx, {
            kind: "assistant.stream",
            at: at - i * 10,
            meta: { phase: "finalize", streamStatus: "error", errorCode: code },
          });
        }
      });
    await seedErrors(2, "context_length", base - 60_000);
    await t.mutation(internal.anomalies.detectAnomalies, {});
    await seedErrors(1, "context_length", base - 1_000);
    await t.mutation(internal.anomalies.detectAnomalies, {});

    const rows = await t.run(async (ctx) => {
      const occ = await ctx.db.query("anomalyOccurrences").collect();
      const open = await ctx.db
        .query("anomalies")
        .filter((q) => q.eq(q.field("kind"), "assistant.cause.context_length"))
        .collect();
      return { occ, open };
    });
    // ONE aggregate row, TWO immutable observations behind it.
    const forCause = rows.occ.filter(
      (o) => o.kind === "assistant.cause.context_length",
    );
    expect(rows.open).toHaveLength(1);
    expect(forCause).toHaveLength(2);
    expect(rows.open[0]?.occurrenceCount).toBe(2);
    // …and the aggregate spans them: first-seen kept, last-seen advanced.
    expect(rows.open[0]?.firstAt).toBeLessThanOrEqual(rows.open[0]!.at);
    // The FIRST observation's evidence survives the second (it used to be patched).
    const counts = forCause
      .map((o) => JSON.parse(o.evidence ?? "{}").count as number)
      .sort();
    expect(counts).toEqual([2, 3]);
  });

  test("the same failure re-read on the next cron tick is not a new occurrence", async () => {
    // The detection window (15 min) is wider than the cron period, so one failing
    // turn is re-detected on every tick. Counting ticks would turn a single lost
    // turn into fifteen "occurrences" and make the history a lie (codex P1).
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - i * 1000,
          meta: {
            phase: "finalize",
            streamStatus: "error",
            errorCode: "context_length",
          },
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    await t.mutation(internal.anomalies.detectAnomalies, {});
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const state = await t.run(async (ctx) => ({
      occ: (await ctx.db.query("anomalyOccurrences").collect()).filter(
        (o) => o.kind === "assistant.cause.context_length",
      ),
      row: await ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.cause.context_length"),
        )
        .first(),
    }));
    expect(state.occ).toHaveLength(1);
    expect(state.row?.occurrenceCount).toBe(1);
  });

  test("the occurrence history is readable, by anomaly and by cause", async () => {
    const t = convexTest(schema, modules);
    const seedOne = async (code: string, at: number) =>
      await t.run(async (ctx) => {
        for (let i = 0; i < 2; i++) {
          await seedTrace(ctx, {
            kind: "assistant.stream",
            at: at - i * 10,
            meta: { phase: "finalize", streamStatus: "error", errorCode: code },
          });
        }
      });
    // Explicit, well-separated waves (see the note in the history test above).
    const now = Date.now();
    await seedOne("context_length", now - 60_000);
    await t.mutation(internal.anomalies.detectAnomalies, {});
    await seedOne("context_length", now - 1_000);
    await t.mutation(internal.anomalies.detectAnomalies, {});

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.cause.context_length"),
        )
        .first(),
    );
    const byAnomaly = await t.query(internal.anomalies.occurrencesInternal, {
      anomalyId: row!._id,
    });
    const byCause = await t.query(internal.anomalies.occurrencesInternal, {
      kind: "assistant.cause.context_length",
    });
    expect(byAnomaly.occurrences).toHaveLength(2);
    expect(byCause.occurrences).toHaveLength(2);
    // Recent first, so an operator reads the latest observation without paging.
    expect(byAnomaly.occurrences[0]!.at).toBeGreaterThanOrEqual(
      byAnomaly.occurrences[1]!.at,
    );
    // The row was born with this history, so it covers the row's whole life.
    expect(byAnomaly.historyComplete).toBe(true);
    // …and a TRUNCATED page does not fake a gap: coverage is judged on the oldest
    // occurrence overall, not the oldest one that fit.
    const onePage = await t.query(internal.anomalies.occurrencesInternal, {
      anomalyId: row!._id,
      limit: 1,
    });
    expect(onePage.occurrences).toHaveLength(1);
    expect(onePage.historyComplete).toBe(true);
    // …and the aggregate the listing carries agrees with the history.
    const listed = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    const view = listed.find(
      (a) => a.kind === "assistant.cause.context_length",
    );
    expect(view?.occurrenceCount).toBe(2);
    expect(view?.firstAt).not.toBeNull();
  });

  test("a MIXED burst stays critical (the split must not downgrade it)", async () => {
    // 2 real errors + 8 stops was critical under the old combined rule. Splitting
    // the burst into its own class must not divide the severity between them.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - i * 100,
          meta: { phase: "finalize", streamStatus: "error" },
        });
      }
      for (let i = 0; i < 8; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 1000 - i * 100,
          meta: { phase: "finalize", streamStatus: "aborted" },
        });
      }
    });
    const res = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(res.detected).toContain("assistant.stream_errors");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.stream_errors"),
        )
        .first(),
    );
    expect(row?.severity).toBe("critical");
  });

  test("a user STOP does not manufacture an occurrence of the ERROR class", async () => {
    // The two classes have separate watermarks: a new Stop is a new observation for
    // the burst class and NOT for the turn-costing one (codex P2).
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 5000 - i * 100,
          meta: { phase: "finalize", streamStatus: "error" },
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    // A later Stop arrives; the old errors are still inside the window.
    await t.run(async (ctx) => {
      await seedTrace(ctx, {
        kind: "assistant.stream",
        at: now,
        meta: { phase: "finalize", streamStatus: "aborted" },
      });
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.stream_errors"),
        )
        .first(),
    );
    expect(row?.occurrenceCount).toBe(1); // no new ERROR happened
  });

  test("a row opened BEFORE this feature reports a count its history can back", async () => {
    // Deploy-time reality: an open detector row with no watermark and no occurrence
    // rows. Claiming "2×" over a one-entry history would be a fresh version of the
    // defect this lot removes (codex P2).
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("anomalies", {
        at: Date.now() - 60_000,
        kind: "assistant.cause.context_length",
        severity: "warn",
        status: "open",
        message: "legacy row, no aggregate fields",
        source: "detector",
      });
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - i * 100,
          meta: {
            phase: "finalize",
            streamStatus: "error",
            errorCode: "context_length",
          },
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const state = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.cause.context_length"),
        )
        .first(),
      // Only THIS class's history (the generic class legitimately records its own).
      occ: (await ctx.db.query("anomalyOccurrences").collect()).filter(
        (o) => o.kind === "assistant.cause.context_length",
      ).length,
    }));
    // The count matches what the history can show.
    expect(state.row?.occurrenceCount).toBe(1);
    expect(state.occ).toBe(1);
    // …and the row's TRUE first-seen is kept, with the gap reported rather than
    // rewritten: the history cannot cover a life that started before it existed.
    const history = await t.query(internal.anomalies.occurrencesInternal, {
      anomalyId: state.row!._id,
    });
    expect(history.historyComplete).toBe(false);
  });

  test("successful API calls do not inflate the error-ratio history", async () => {
    // The ratio's denominator is every call, so watermarking on any call let normal
    // traffic manufacture occurrences — polling the diagnostic API would have
    // inflated its own alert's history (codex P2).
    const t = convexTest(schema, modules);
    const base = Date.now() - 60_000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        await seedTrace(ctx, {
          kind: "api.call",
          at: base - i * 10,
          status: 500,
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    // A burst of SUCCESSFUL calls afterwards — still above the ratio threshold.
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await seedTrace(ctx, {
          kind: "api.call",
          at: base + 5_000 + i * 10,
          status: 200,
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "api.error_ratio"),
        )
        .first(),
    );
    expect(row).not.toBeNull();
    expect(row?.occurrenceCount).toBe(1); // no NEW error happened
  });

  test("a legacy row with NO history is reported as incomplete, not complete", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("anomalies", {
        at: Date.now() - 120_000,
        kind: "assistant.cause.context_length",
        severity: "warn",
        status: "open",
        message: "legacy row, never observed by the new history",
        source: "detector",
      }),
    );
    const history = await t.query(internal.anomalies.occurrencesInternal, {
      anomalyId: id,
    });
    expect(history.occurrences).toHaveLength(0);
    // An empty history for a row that predates it is NOT a complete history.
    expect(history.historyComplete).toBe(false);
  });

  test("an INHERITED abort-only stream_errors row still clears", async () => {
    // The old detector raised `assistant.stream_errors` for an abort-only burst. That
    // row is a CONDITION by the new rule, and treating it as lost work would pin a
    // stale critical alert in the heartbeat forever (codex P2).
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("anomalies", {
        at: Date.now() - 60_000,
        kind: "assistant.stream_errors",
        severity: "critical",
        status: "open",
        message: "Assistant stream errors: 0 (+10 user abort(s)) over 15m",
        source: "detector",
        // ZERO errors: a pure stop burst, which is why it may clear. With even one
        // error the row stays open (the next test).
        evidence: JSON.stringify({ streamErrors: 0, streamAborts: 10 }),
      });
    });
    const res = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(res.autoResolved).toContain("assistant.stream_errors");
    const hb = await t.query(internal.anomalies.heartbeatInternal, {});
    expect(hb.openCount).toBe(0);
  });

  test("an inherited row with even ONE real error is NOT cleared", async () => {
    // The exception is narrow twice over: only a row that predates this change AND
    // whose evidence shows zero errors may clear. One lost turn among nine stops is
    // still a lost turn, and the current rule legitimately opens such rows.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("anomalies", {
        at: Date.now() - 60_000,
        kind: "assistant.stream_errors",
        severity: "critical",
        status: "open",
        message: "Assistant stream errors: 1 (+9 user abort(s)) over 15m",
        source: "detector",
        evidence: JSON.stringify({ streamErrors: 1, streamAborts: 9 }),
      });
    });
    const res = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(res.autoResolved).not.toContain("assistant.stream_errors");
  });

  test("a row this rule just opened is never mistaken for an inherited burst", async () => {
    // Rows created now carry the observation watermark; an inherited one does not.
    // Without that distinction the mixed-burst fix would undo itself on the next tick.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedTrace(ctx, {
        kind: "assistant.stream",
        at: now - 1000,
        meta: { phase: "finalize", streamStatus: "error" },
      });
      for (let i = 0; i < 9; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - 2000 - i * 100,
          meta: { phase: "finalize", streamStatus: "aborted" },
        });
      }
    });
    const r1 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r1.detected).toContain("assistant.stream_errors");
    // The window empties; the row must NOT be auto-resolved.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("traceEvents").collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    const r2 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r2.autoResolved).not.toContain("assistant.stream_errors");
  });

  test("providing BOTH selectors is rejected, not silently resolved one way", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("anomalies", {
        at: Date.now(),
        kind: "assistant.cause.context_length",
        severity: "warn",
        status: "open",
        message: "row",
        source: "detector",
      }),
    );
    await expect(
      t.query(internal.anomalies.occurrencesInternal, {
        anomalyId: id,
        kind: "assistant.cause.context_length",
      }),
    ).rejects.toThrow(/exactly one/i);
  });

  test("an unknown anomalyId is an absent resource, not an empty history", async () => {
    const t = convexTest(schema, modules);
    // A well-formed id belonging to a row that was deleted.
    const id = await t.run(async (ctx) => {
      const tmp = await ctx.db.insert("anomalies", {
        at: Date.now(),
        kind: "assistant.cause.context_length",
        severity: "warn",
        status: "open",
        message: "temporary",
        source: "detector",
      });
      await ctx.db.delete(tmp);
      return tmp;
    });
    const history = await t.query(internal.anomalies.occurrencesInternal, {
      anomalyId: id,
    });
    expect(history.found).toBe(false);
  });

  test("re-reading the SAME chat does not inflate the access-scan history", async () => {
    // The alert is about BREADTH (distinct chats). Re-reading one chat does not widen
    // the scan, so it must not count as a new observation (codex P2).
    const t = convexTest(schema, modules);
    const base = Date.now() - 120_000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await seedTrace(ctx, {
          kind: "api.call",
          at: base - i * 10,
          status: 200,
          principalId: "svc-key",
          chatId: `chat-${i}`,
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const first = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "api.access_scan"),
        )
        .first(),
    );
    expect(first).not.toBeNull();
    // Twenty more reads of a chat already counted.
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await seedTrace(ctx, {
          kind: "api.call",
          at: base + 10_000 + i * 10,
          status: 200,
          principalId: "svc-key",
          chatId: "chat-0",
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const after = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "api.access_scan"),
        )
        .first(),
    );
    expect(after?.occurrenceCount).toBe(1);
  });

  test("a fractional limit still returns a page", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at: now - i * 100,
          meta: {
            phase: "finalize",
            streamStatus: "error",
            errorCode: "context_length",
          },
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const rows = await t.query(internal.anomalies.occurrencesInternal, {
      kind: "assistant.cause.context_length",
      limit: 1.5,
    });
    expect(rows.occurrences).toHaveLength(1);
  });

  test("two failures in the SAME millisecond are two occurrences", async () => {
    // Traces are stamped with Date.now(), so a real second failure can share the
    // millisecond of the first. Deduping on the timestamp alone would swallow it —
    // the identity of the newest contributing trace is what decides (codex P2).
    const t = convexTest(schema, modules);
    const at = Date.now() - 30_000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await seedTrace(ctx, {
          kind: "assistant.stream",
          at,
          meta: {
            phase: "finalize",
            streamStatus: "error",
            errorCode: "context_length",
          },
        });
      }
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    // A THIRD failure at the very same instant.
    await t.run(async (ctx) => {
      await seedTrace(ctx, {
        kind: "assistant.stream",
        at,
        meta: {
          phase: "finalize",
          streamStatus: "error",
          errorCode: "context_length",
        },
      });
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("anomalies")
        .withIndex("by_status_kind", (q) =>
          q.eq("status", "open").eq("kind", "assistant.cause.context_length"),
        )
        .first(),
    );
    expect(row?.occurrenceCount).toBe(2);
  });

  test("a class that COST A TURN is never auto-resolved", async () => {
    // Prod, 14 days: every detector row was closed by `detector:auto` five minutes
    // after opening — including the one that fired during the 2026-07-20 context
    // overflow, which then had to be re-reported by hand. The condition leaving the
    // window does not give the user back the turn that failed.
    const t = convexTest(schema, modules);
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

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("traceEvents").collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    const r2 = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(r2.autoResolved).not.toContain("openclaw.dispatch_failures");
    // Still open, waiting for a human — which is the point of raising it.
    const open = await t.query(internal.anomalies.anomaliesInternal, {
      status: "open",
    });
    expect(open.some((a) => a.kind === "openclaw.dispatch_failures")).toBe(true);
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

describe("anomaly management RBAC contract", () => {
  test("ONLY admin (wildcard) and agent hold anomalies.report — observer/user/pending never", () => {
    // The /api/v1/anomalies POST + /api/v1/anomalies/resolve routes gate on
    // anomalies.report. This pins WHO can manage anomalies: a read-only
    // observer key must stay 403 on resolve, forever.
    expect(BUILTIN_ROLES.admin!.permissions).toBe(WILDCARD);
    expect(BUILTIN_ROLES.agent!.permissions).toContain(
      PERMISSIONS.ANOMALIES_REPORT,
    );
    for (const role of ["observer", "user", "pending"] as const) {
      const perms = BUILTIN_ROLES[role]!.permissions;
      expect(perms).not.toBe(WILDCARD);
      expect(perms).not.toContain(PERMISSIONS.ANOMALIES_REPORT);
    }
    // Observer keeps READ access (dashboards), which is the whole point of
    // the role split.
    expect(BUILTIN_ROLES.observer!.permissions).toContain(
      PERMISSIONS.ANOMALIES_READ,
    );
  });
});
