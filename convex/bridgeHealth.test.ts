/// <reference types="vite/client" />
//
// Bridge health: the poller's pure helpers (normalize a network /health body,
// decide availability) + the upsert that the cron writes through. The fetch
// action and the auth'd queries are thin wrappers over these — verified live.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal, api } from "./_generated/api";
import schema from "./schema";
import type { Doc } from "./_generated/dataModel";
import { normalizeTarget, computeAvailability } from "./bridgeHealth";
import { maxRawInboundBytes } from "./lib/attachmentLimits";

const modules = import.meta.glob("./**/*.ts");

describe("normalizeTarget (defensive parse of the bridge /health body)", () => {
  test("a full target flattens lastError {code,at} -> code/at", () => {
    const t = normalizeTarget({
      key: "alice",
      instanceName: "alice",
      canonical: "alice",
      agentId: "main",
      gatewayHost: "gateway.example.org:18789",
      state: "error",
      lastOkAt: null,
      lastError: { code: "AGENT_NOT_FOUND", at: 123 },
      attempts: 2,
      okCount: 0,
      errorCount: 2,
    });
    expect(t).toMatchObject({
      key: "alice",
      agentId: "main",
      state: "error",
      lastErrorCode: "AGENT_NOT_FOUND",
      lastErrorAt: 123,
      errorCount: 2,
    });
  });

  test("a healthy target with no lastError -> nulls, not crash", () => {
    const t = normalizeTarget({
      key: "o",
      canonical: "o",
      agentId: "main",
      gatewayHost: "h:1",
      state: "connected",
      lastOkAt: 9,
      attempts: 1,
      okCount: 1,
      errorCount: 0,
    });
    expect(t?.lastErrorCode).toBeNull();
    expect(t?.lastOkAt).toBe(9);
  });

  test("parses the per-instance gatewayVersion (null when absent/non-string)", () => {
    const withV = normalizeTarget({
      key: "k",
      canonical: "c",
      agentId: "main",
      gatewayHost: "h:1",
      state: "connected",
      gatewayVersion: "2026.6.5",
    });
    expect(withV?.gatewayVersion).toBe("2026.6.5");
    const without = normalizeTarget({
      key: "k",
      canonical: "c",
      agentId: "main",
      gatewayHost: "h:1",
      state: "connected",
    });
    expect(without?.gatewayVersion).toBeNull();
  });

  test("a malformed target (missing required field) -> null (dropped)", () => {
    expect(normalizeTarget({ key: "x", state: "error" })).toBeNull();
    expect(normalizeTarget(null)).toBeNull();
    expect(normalizeTarget("nope")).toBeNull();
  });

  test("a downstream-reject target flattens lastDownstreamReject {code,at} + count", () => {
    const t = normalizeTarget({
      key: "olivier",
      instanceName: "primary",
      canonical: "olivier",
      agentId: "olivier",
      gatewayHost: "192.0.2.10:18789",
      // The bridge stayed connected (it reached the gateway, which refused the file).
      state: "connected",
      lastOkAt: null,
      lastError: null,
      lastDownstreamReject: { code: "ATTACHMENT_REJECTED", at: 456 },
      attempts: 1,
      okCount: 0,
      errorCount: 0,
      downstreamRejectCount: 1,
    });
    expect(t).toMatchObject({
      state: "connected",
      lastErrorCode: null, // NOT a bridge error
      lastDownstreamRejectCode: "ATTACHMENT_REJECTED",
      lastDownstreamRejectAt: 456,
      downstreamRejectCount: 1,
    });
  });

  test("an older bridge body without downstream fields -> nulls/0 (back-compat)", () => {
    const t = normalizeTarget({
      key: "o",
      canonical: "o",
      agentId: "main",
      gatewayHost: "h:1",
      state: "connected",
      lastOkAt: 9,
      attempts: 1,
      okCount: 1,
      errorCount: 0,
      // no lastDownstreamReject / downstreamRejectCount (pre-this-release bridge)
    });
    expect(t?.lastDownstreamRejectCode).toBeNull();
    expect(t?.lastDownstreamRejectAt).toBeNull();
    expect(t?.downstreamRejectCount).toBe(0);
  });
});

function doc(p: {
  reachable: boolean;
  checkedAt: number;
  lastError?: string;
  maxPayload?: number | null;
  targets?: {
    state: string;
    instanceName?: string;
    agentId?: string;
    canonical?: string;
    maxPayload?: number;
  }[];
}): Doc<"bridgeHealth"> {
  return {
    _id: "x" as Doc<"bridgeHealth">["_id"],
    _creationTime: 0,
    key: "singleton",
    reachable: p.reachable,
    checkedAt: p.checkedAt,
    lastError: p.lastError,
    maxPayload: p.maxPayload,
    targets: (p.targets ?? []) as Doc<"bridgeHealth">["targets"],
  } as Doc<"bridgeHealth">;
}

describe("computeAvailability (chat gate decision — fail OPEN)", () => {
  const NOW = 1_000_000;

  test("no data -> known:false, available:true (never block blindly)", () => {
    expect(computeAvailability(null, NOW)).toEqual({
      known: false,
      available: true,
      degraded: false,
      reason: null,
      checkedAt: null,
      maxInboundBytes: null,
    });
  });

  test("maxInboundBytes is DERIVED from the gateway maxPayload (not hardcoded)", () => {
    const a = computeAvailability(
      doc({ reachable: true, checkedAt: NOW, maxPayload: 26214400, targets: [] }),
      NOW,
    );
    // (26214400 - 131072 envelope) * 3/4 — the base64-adjusted raw cap, ~18.6 MiB.
    expect(a.maxInboundBytes).toBe(maxRawInboundBytes(26214400));
    expect(a.maxInboundBytes).toBeGreaterThan(18 * 1024 * 1024);
    expect(a.maxInboundBytes).toBeLessThan(26214400);
  });

  test("maxInboundBytes scales with maxPayload (a bigger gateway frame -> bigger cap)", () => {
    const small = computeAvailability(
      doc({ reachable: true, checkedAt: NOW, maxPayload: 26214400 }),
      NOW,
    ).maxInboundBytes;
    const big = computeAvailability(
      doc({ reachable: true, checkedAt: NOW, maxPayload: 52428800 }),
      NOW,
    ).maxInboundBytes;
    expect(big!).toBeGreaterThan(small!);
  });

  test("maxInboundBytes is null when the gateway has not reported maxPayload yet", () => {
    const a = computeAvailability(doc({ reachable: true, checkedAt: NOW }), NOW);
    expect(a.maxInboundBytes).toBeNull(); // composer fails open; server is the backstop
  });

  test("reachable, no target error, fresh -> available, not degraded", () => {
    const a = computeAvailability(
      doc({ reachable: true, checkedAt: NOW, targets: [{ state: "connected" }] }),
      NOW,
    );
    expect(a.available).toBe(true);
    expect(a.degraded).toBe(false);
    expect(a.reason).toBeNull();
  });

  test("per-instance scope: one gateway down does NOT degrade the other (one bridge, N gateways)", () => {
    // olivier connected, jerome erroring, on ONE bridge. Scoping by olivier must show
    // NOT degraded; by jerome, degraded; the global view (no scope) IS degraded.
    const d = doc({
      reachable: true,
      checkedAt: NOW,
      maxPayload: 26214400,
      targets: [
        { state: "connected", instanceName: "olivier", maxPayload: 26214400 },
        { state: "error", instanceName: "jerome", maxPayload: 52428800 },
      ],
    });
    expect(computeAvailability(d, NOW, "olivier").degraded).toBe(false);
    expect(computeAvailability(d, NOW, "jerome").degraded).toBe(true);
    expect(computeAvailability(d, NOW).degraded).toBe(true); // global = any target error
    // available stays the GLOBAL bridge-reachable gate for every scope (no lockout).
    expect(computeAvailability(d, NOW, "jerome").available).toBe(true);
  });

  test("per-AGENT scope: another agent erroring on the SAME instance does not degrade this chat (codex P2)", () => {
    // alice connected, bob erroring, BOTH on instance olivier. A chat routed to
    // alice must NOT read degraded; a bob chat must; the instance-level view
    // (Settings-style, no agent) still reads degraded (any target).
    const d = doc({
      reachable: true,
      checkedAt: NOW,
      targets: [
        { state: "connected", instanceName: "olivier", agentId: "alice" },
        { state: "error", instanceName: "olivier", agentId: "bob" },
      ],
    });
    expect(computeAvailability(d, NOW, "olivier", "alice").degraded).toBe(false);
    expect(computeAvailability(d, NOW, "olivier", "bob").degraded).toBe(true);
    expect(computeAvailability(d, NOW, "olivier").degraded).toBe(true);
  });

  test("per-CANONICAL scope: another user's canonical on a SHARED agent does not degrade this chat (codex P2 round 2)", () => {
    const d = doc({
      reachable: true,
      checkedAt: NOW,
      targets: [
        { state: "connected", instanceName: "olivier", agentId: "alice", canonical: "user-a" },
        { state: "error", instanceName: "olivier", agentId: "alice", canonical: "user-b" },
      ],
    });
    expect(
      computeAvailability(d, NOW, "olivier", "alice", "user-a").degraded,
    ).toBe(false);
    expect(
      computeAvailability(d, NOW, "olivier", "alice", "user-b").degraded,
    ).toBe(true);
    // Agent-level view (no canonical) still reads any-of (Settings-style).
    expect(computeAvailability(d, NOW, "olivier", "alice").degraded).toBe(true);
  });

  test("agent scope with NO target row yet -> not degraded (fail open)", () => {
    const d = doc({
      reachable: true,
      checkedAt: NOW,
      targets: [{ state: "error", instanceName: "olivier", agentId: "bob" }],
    });
    // alice never dispatched since bridge boot: no row -> no outage claim for her.
    expect(computeAvailability(d, NOW, "olivier", "alice").degraded).toBe(false);
  });

  test("per-instance maxInboundBytes uses THAT instance's gateway frame, not the doc MIN", () => {
    const d = doc({
      reachable: true,
      checkedAt: NOW,
      maxPayload: 26214400, // doc-level MIN (global)
      targets: [
        { state: "connected", instanceName: "olivier", maxPayload: 26214400 },
        { state: "connected", instanceName: "jerome", maxPayload: 52428800 },
      ],
    });
    // jerome's bigger frame yields a bigger cap than the global MIN-derived one.
    const jerome = computeAvailability(d, NOW, "jerome").maxInboundBytes;
    const global = computeAvailability(d, NOW).maxInboundBytes;
    expect(jerome).toBe(maxRawInboundBytes(52428800));
    expect(global).toBe(maxRawInboundBytes(26214400));
    expect(jerome!).toBeGreaterThan(global!);
  });

  test("an instance with NO target yet (idle) falls back to the conservative doc cap, NOT null", () => {
    // Idle bridge / just restarted: a chat's instance has no /health target yet.
    // computeAvailability(chatId->instanceName) must NOT return null (the composer
    // treats null as fail-open and lets oversized files through to fail at dispatch);
    // it falls back to the doc-level MIN. Regression guard (codex P2).
    const d = doc({
      reachable: true,
      checkedAt: NOW,
      maxPayload: 26214400, // doc-level conservative cap
      targets: [{ state: "connected", instanceName: "jerome", maxPayload: 52428800 }],
    });
    // "olivier" has no target -> must still get the conservative doc cap, not null.
    expect(computeAvailability(d, NOW, "olivier").maxInboundBytes).toBe(
      maxRawInboundBytes(26214400),
    );
  });

  test("unreachable -> unavailable with the poll reason", () => {
    const a = computeAvailability(
      doc({ reachable: false, checkedAt: NOW, lastError: "unreachable" }),
      NOW,
    );
    expect(a.available).toBe(false);
    expect(a.reason).toBe("unreachable");
  });

  // REGRESSION GATE for the global-readonly deadlock: a single agent/target in
  // `error` while the bridge is reachable must keep the composer AVAILABLE for
  // everyone (only `degraded` is flagged). If this ever flips back to
  // available:false, one agent's failed send locks out every chat and — since the
  // target only clears on a SUCCESSFUL send the lockout itself blocks — it deadlocks
  // until a manual bridge restart. The per-chat failDispatch bubble is the backstop.
  test("a target in error (bridge reachable) -> STILL available, degraded:true", () => {
    const a = computeAvailability(
      doc({
        reachable: true,
        checkedAt: NOW,
        targets: [{ state: "error" }, { state: "connected" }],
      }),
      NOW,
    );
    expect(a.available).toBe(true); // NOT false — no global lockout on one agent
    expect(a.degraded).toBe(true); // informational only
    expect(a.reason).toBeNull(); // no blocking reason
  });

  test("unreachable still wins even if a target happens to be 'error'", () => {
    const a = computeAvailability(
      doc({
        reachable: false,
        checkedAt: NOW,
        lastError: "http_502",
        targets: [{ state: "error" }],
      }),
      NOW,
    );
    expect(a.available).toBe(false); // bridge process is down -> genuine block
    expect(a.reason).toBe("http_502");
  });

  test("stale snapshot (poller wedged) -> unavailable (stale)", () => {
    const a = computeAvailability(
      doc({ reachable: true, checkedAt: NOW - 10 * 60 * 1000, targets: [] }),
      NOW,
    );
    expect(a.available).toBe(false);
    expect(a.reason).toBe("stale");
  });
});

describe("upsertBridgeHealth (cron write path)", () => {
  test("inserts the singleton, then a recovered poll CLEARS the old lastError", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.bridgeHealth.upsertBridgeHealth, {
      reachable: false,
      lastError: "unreachable",
      targets: [],
    });
    let doc1 = await t.run((ctx) =>
      ctx.db.query("bridgeHealth").withIndex("by_key", (q) => q.eq("key", "singleton")).unique(),
    );
    expect(doc1?.reachable).toBe(false);
    expect(doc1?.lastError).toBe("unreachable");

    // Recovered poll: reachable, no lastError -> the field must be CLEARED.
    await t.mutation(internal.bridgeHealth.upsertBridgeHealth, {
      reachable: true,
      status: "ok",
      targets: [],
    });
    const doc2 = await t.run((ctx) =>
      ctx.db.query("bridgeHealth").withIndex("by_key", (q) => q.eq("key", "singleton")).unique(),
    );
    expect(doc2?.reachable).toBe(true);
    expect(doc2?.lastError).toBeUndefined(); // not the stale "unreachable"
    // still a single singleton row
    const all = await t.run((ctx) => ctx.db.query("bridgeHealth").collect());
    expect(all).toHaveLength(1);
  });
});

describe("getBridgeAvailability (ownership-scoped, one bridge / N gateways)", () => {
  const mkTarget = (instanceName: string, state: string) => ({
    key: `${instanceName}:u`,
    instanceName,
    canonical: "u",
    agentId: "main",
    gatewayHost: "h:1",
    state,
    lastOkAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    attempts: 1,
    okCount: state === "connected" ? 1 : 0,
    errorCount: state === "error" ? 1 : 0,
  });

  test("scopes to the CALLER's OWN chat instance; a third party's chatId is NOT used", async () => {
    const t = convexTest(schema, modules);
    const { a, b, chatA } = await t.run(async (ctx) => {
      const a = await ctx.db.insert("users", {});
      const b = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: a, role: "admin" });
      await ctx.db.insert("profiles", { userId: b, role: "admin" });
      // jerome connected, olivier erroring -> GLOBAL degraded, jerome-scoped NOT.
      await ctx.db.insert("bridgeHealth", {
        key: "singleton",
        reachable: true,
        checkedAt: 1,
        maxPayload: null,
        targets: [mkTarget("jerome", "connected"), mkTarget("olivier", "error")],
      });
      const chatA = await ctx.db.insert("chats", {
        userId: a,
        instanceName: "jerome",
        updatedAt: 1,
      });
      return { a, b, chatA };
    });
    const asA = t.withIdentity({ subject: `${a}|s` });
    const asB = t.withIdentity({ subject: `${b}|s` });
    // A OWNS chatA (jerome) -> scoped to jerome -> NOT degraded.
    expect(
      (await asA.query(api.bridgeHealth.getBridgeAvailability, { chatId: chatA }))
        .degraded,
    ).toBe(false);
    // B does NOT own chatA -> the chat's instance is IGNORED -> GLOBAL view ->
    // degraded (olivier erroring). Regression guard: without the ownership check B
    // would read A's chat and get the jerome-scoped (false) verdict.
    expect(
      (await asB.query(api.bridgeHealth.getBridgeAvailability, { chatId: chatA }))
        .degraded,
    ).toBe(true);
  });
});
