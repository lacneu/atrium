/// <reference types="vite/client" />
//
// Bridge health: the poller's pure helpers (normalize a network /health body,
// decide availability) + the upsert that the cron writes through. The fetch
// action and the auth'd queries are thin wrappers over these — verified live.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc } from "./_generated/dataModel";
import { normalizeTarget, computeAvailability } from "./bridgeHealth";

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

  test("a malformed target (missing required field) -> null (dropped)", () => {
    expect(normalizeTarget({ key: "x", state: "error" })).toBeNull();
    expect(normalizeTarget(null)).toBeNull();
    expect(normalizeTarget("nope")).toBeNull();
  });
});

function doc(p: {
  reachable: boolean;
  checkedAt: number;
  lastError?: string;
  targets?: { state: string }[];
}): Doc<"bridgeHealth"> {
  return {
    _id: "x" as Doc<"bridgeHealth">["_id"],
    _creationTime: 0,
    key: "singleton",
    reachable: p.reachable,
    checkedAt: p.checkedAt,
    lastError: p.lastError,
    targets: (p.targets ?? []) as Doc<"bridgeHealth">["targets"],
  } as Doc<"bridgeHealth">;
}

describe("computeAvailability (chat gate decision — fail OPEN)", () => {
  const NOW = 1_000_000;

  test("no data -> known:false, available:true (never block blindly)", () => {
    expect(computeAvailability(null, NOW)).toEqual({
      known: false,
      available: true,
      reason: null,
      checkedAt: null,
    });
  });

  test("reachable, no target error, fresh -> available", () => {
    const a = computeAvailability(
      doc({ reachable: true, checkedAt: NOW, targets: [{ state: "connected" }] }),
      NOW,
    );
    expect(a.available).toBe(true);
    expect(a.reason).toBeNull();
  });

  test("unreachable -> unavailable with the poll reason", () => {
    const a = computeAvailability(
      doc({ reachable: false, checkedAt: NOW, lastError: "unreachable" }),
      NOW,
    );
    expect(a.available).toBe(false);
    expect(a.reason).toBe("unreachable");
  });

  test("a target in error -> unavailable (target_error)", () => {
    const a = computeAvailability(
      doc({ reachable: true, checkedAt: NOW, targets: [{ state: "error" }] }),
      NOW,
    );
    expect(a.available).toBe(false);
    expect(a.reason).toBe("target_error");
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
