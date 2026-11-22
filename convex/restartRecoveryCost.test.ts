/// <reference types="vite/client" />
//
// WHAT THE GATEWAY'S RECOVERY COSTS THE TRANSCRIPT'S TRANSACTIONS (lib/restartRecovery.ts).
//
// Saying on a bubble that a recovery resumed it means reading that message, text included.
// The ingestion and the projection read within a byte budget; this feature reads ROWS
// there, charged to that budget, and tells the bubble in a transaction of its own. A
// conversation with no recovery entry pays one empty index range per projected run.

import { convexTest, type TestConvex } from "convex-test";
// The tracker every transaction of convex-test charges (deep import: no package exports).
import { TransactionMetricsTracker } from "convex-test/dist/transactionMetrics.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { recoveryFactsOf, recoveryOf } from "./lib/restartRecovery";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

const counts = { ranges: 0, reads: 0, bytesRead: 0 };
const proto = TransactionMetricsTracker.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const [method, key] of [
  ["trackIndexRange", "ranges"],
  ["trackRead", "reads"],
] as const) {
  const original = proto[method]!;
  proto[method] = function (this: unknown, ...args: unknown[]) {
    counts[key]++;
    if (key === "reads") counts.bytesRead += typeof args[0] === "number" ? args[0] : 0;
    return original.apply(this, args);
  };
}

const SK = "agent:alice:atrium:chat:u-cost:turn-1";
const run = (i: number) => `webchat-${String(i).padStart(2, "0")}${"a".repeat(62)}`;
const recovery = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const BIG = 600_000;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
  vi.useFakeTimers();
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

/** A projected conversation with `n` settled answers of `chars` characters, one per run. */
async function seed(t: T, n: number, chars: number) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "alice", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    return { userId, chatId };
  });
  const bubbles: Array<Id<"messages">> = [];
  for (let i = 0; i < n; i++) {
    bubbles.push(
      await t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId: ids.chatId,
          userId: ids.userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: "x".repeat(chars),
          runId: run(i),
          turnSessionKey: SK,
          boundInstance: "prod",
          projectedTurn: true,
          updatedAt: 1,
        }),
      ),
    );
  }
  await apply(t, ids.chatId, []);
  return { ...ids, bubbles };
}

function apply(t: T, chatId: Id<"chats">, rows: unknown[], extra: Record<string, unknown> = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "page",
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

/** Run `i`, cut on a tool call, then the gateway's recovery entry right after it. */
const cutThenRecovered = (i: number) => [
  { entryId: `cut-${i}`, seq: 2 * i + 1, role: "assistant", runId: run(i), stopReason: "toolUse", hidden: false, visible: false, toolCallIds: [`call-${i}`] },
  {
    entryId: `entry-${i}`,
    seq: 2 * i + 2,
    role: "user",
    runId: recovery(i),
    sendId: recovery(i),
    provenanceKind: "internal_system",
    provenanceSourceTool: "main_session_restart_recovery",
    hidden: false,
    visible: true,
  },
];

describe("the recovery never spends the transcript's read budget on message text", () => {
  test("a page of 28 rows naming 14 bubbles of 600,000 characters is stored under the real transaction limits, and every bubble is told", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const N = 14;
    const ids = await seed(t, N, BIG);
    const rows = Array.from({ length: N }, (_, i) => cutThenRecovered(i)).flat();
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: Array.from({ length: N }, (_, i) => recovery(i)) });
    const stored = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(stored).toHaveLength(2 * N);
    expect(stored.filter((r) => r.recoversRunId !== undefined).map((r) => r.recoversRunId).sort()).toEqual(Array.from({ length: N }, (_, i) => run(i)));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const told = await t.run(async (ctx) => Promise.all(ids.bubbles.map(async (id) => (await ctx.db.get(id))?.interruption?.recoveryRunId)));
    expect(told).toEqual(Array.from({ length: N }, (_, i) => recovery(i)));
  });

  test("the ingestion of a recovery entry reads no message: its bytes read do not grow with the bubble it names", async () => {
    const cost = async (chars: number) => {
      const t = convexTest(schema, modules);
      const ids = await seed(t, 1, chars);
      counts.reads = counts.ranges = counts.bytesRead = 0;
      await apply(t, ids.chatId, cutThenRecovered(0), { hasActiveRun: true, activeRunIds: [run(0), recovery(0)] });
      return { ...counts };
    };
    const small = await cost(10);
    const large = await cost(BIG);
    expect(large).toEqual(small);
  });
});

describe("a conversation with no recovery entry", () => {
  test("`recoveryOf` is one empty index range: no document read, no byte, nothing charged but the query", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, 1, 10);
    await apply(t, ids.chatId, [{ entryId: "a-1", seq: 1, role: "assistant", runId: run(0), stopReason: "stop", hidden: false, visible: true }], {
      hasActiveRun: false,
      activeRunIds: [],
    });
    const meter = { queries: 0, bytes: 0 };
    counts.reads = counts.ranges = counts.bytesRead = 0;
    const by = await t.run((ctx) => recoveryOf(ctx, { chatId: ids.chatId, sessionKey: SK, instanceName: "prod" }, run(0), meter));
    expect(by).toBeNull();
    expect(counts).toEqual({ ranges: 1, reads: 0, bytesRead: 0 });
    expect(meter).toEqual({ queries: 1, bytes: 0 });
  });

  test("a projection pass schedules nothing for it and leaves its bubble as it was", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, 1, 10);
    await apply(t, ids.chatId, [{ entryId: "a-1", seq: 1, role: "assistant", runId: run(0), stopReason: "stop", hidden: false, visible: true }], {
      hasActiveRun: false,
      activeRunIds: [],
    });
    const scheduled = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.includes("noteRunRecovery")));
    expect(scheduled).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(ids.bubbles[0]!)))?.interruption).toBeUndefined();
  });
});

describe("a run a recovery entry names", () => {
  test("its interrupted calls cost ONE more index range of rows, the few right before the entry — and no message", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, 1, BIG);
    await apply(t, ids.chatId, cutThenRecovered(0), { hasActiveRun: true, activeRunIds: [run(0), recovery(0)] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const meter = { queries: 0, bytes: 0 };
    counts.reads = counts.ranges = counts.bytesRead = 0;
    const facts = await t.run((ctx) => recoveryFactsOf(ctx, { chatId: ids.chatId, sessionKey: SK, instanceName: "prod" }, run(0), meter));
    expect(facts).toEqual({ recoveryRunId: recovery(0), cutCallIds: ["call-0"] });
    // The entries that name the run, the row before the entry (read again), the walk.
    expect(counts.ranges).toBe(3);
    expect(meter.queries).toBe(3);
    // Rows only: the entry, then twice the one row stored before it.
    expect(counts.reads).toBe(3);
    expect(meter.bytes).toBeLessThan(4096);
  });
});
