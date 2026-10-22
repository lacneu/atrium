/// <reference types="vite/client" />
//
// PHASE 6 — the gateway's own queue, as the composer reads it (`followUp.followUpState`
// `gatewayQueue`). The gateway states how many inputs it queues behind the run in progress
// (2026.9.7+ `pendingInputs.queuedCount`, chat-pending-inputs.ts:72-99 at v2026.9.8); the
// last read's cursor carries it (`transcriptCursors.pendingQueuedCount`). Asserted on an
// OpenClaw instance (always projected) and on a Hermes one, where nothing changes.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { gatewayQueueOf } from "./followUp";
import { SESSION_ACTIVE_FRESH_MS } from "./lib/outboxQueue";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
const SK = "agent:main:atrium:chat:u:c1";

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

async function seed(t: T, mode: "on" | "hermes", cursors: Array<{ queued?: number; updatedAt: number; sessionKey?: string }>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", ...(mode === "hermes" ? { kind: "hermes" as const } : {}) });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    for (const c of cursors) {
      await ctx.db.insert("transcriptCursors", {
        chatId,
        sessionKey: c.sessionKey ?? SK,
        instanceName: "prod",
        sessionId: "s-1",
        floorSeq: 0,
        floorAt: 1,
        lastKind: "delta",
        reads: 1,
        resets: 0,
        unidentified: 0,
        ...(c.queued !== undefined
          ? { pendingQueuedCount: c.queued, pendingInputsTotal: c.queued, pendingQueuedAt: c.updatedAt }
          : {}),
        updatedAt: c.updatedAt,
      } as never);
    }
    return { userId, chatId };
  });
}

const stateOf = (t: T, userId: Id<"users">, chatId: Id<"chats">) =>
  t.withIdentity({ subject: `${userId}|session` }).query(api.followUp.followUpState, { chatId });
type QueueState = { projection: true; gatewayQueue: { sessions: Array<{ count: number; until: number; sendIds: string[] }> } };
/** The one session's queue fact (tests with a single session), without its message list. */
const one = async (t: T, userId: Id<"users">, chatId: Id<"chats">) => {
  const st = (await stateOf(t, userId, chatId)) as unknown as QueueState;
  const f = st.gatewayQueue.sessions[0];
  return f === undefined ? null : { count: f.count, until: f.until };
};

describe("followUpState.gatewayQueue", () => {
  test("ON: each FRESH session's own queued count and deadline; empty and expired queues left out", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { userId, chatId } = await seed(t, "on", [
      { queued: 5, updatedAt: now - 60_000, sessionKey: `${SK}:older` },
      { queued: 2, updatedAt: now },
      { queued: 0, updatedAt: now, sessionKey: `${SK}:idle` },
      { queued: 3, updatedAt: now - SESSION_ACTIVE_FRESH_MS - 1, sessionKey: `${SK}:stale` },
    ]);
    const st = (await stateOf(t, userId, chatId)) as unknown as QueueState;
    expect(st.projection).toBe(true);
    const facts = st.gatewayQueue.sessions.map((f) => ({ count: f.count, until: f.until })).sort((x, y) => x.count - y.count);
    expect(facts).toEqual([
      { count: 2, until: now + SESSION_ACTIVE_FRESH_MS },
      { count: 5, until: now - 60_000 + SESSION_ACTIVE_FRESH_MS },
    ]);
  });

  test("ON: a read that never stated a queue (9.6, or before phase 2) says nothing", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on", [{ updatedAt: Date.now() }]);
    expect(await one(t, userId, chatId)).toBeNull();
  });

  test("hermes: nothing but `projection: false`, as in 0.97.0", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "hermes", [{ queued: 2, updatedAt: Date.now() }]);
    expect(await stateOf(t, userId, chatId)).toStrictEqual({ projection: false });
  });

  test("gatewayQueueOf: a negative or fractional count from a divergent body is bounded", () => {
    expect(gatewayQueueOf({ pendingQueuedCount: -3, pendingQueuedAt: 10 })).toEqual({ count: 0, until: 10 + SESSION_ACTIVE_FRESH_MS });
    expect(gatewayQueueOf({ pendingQueuedCount: 2.7, pendingQueuedAt: 10 })?.count).toBe(2);
    expect(gatewayQueueOf(null)).toBeNull();
    // A count with no stamp of the read that stated it (a shadow-era cursor): no claim.
    expect(gatewayQueueOf({ pendingQueuedCount: 2, pendingQueuedAt: undefined })).toBeNull();
  });
});

describe("the queue's freshness belongs to the read that stated it (codex phase 6 pass 1)", () => {
  const read = (t: T, chatId: Id<"chats">, extra: Record<string, unknown>) =>
    t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "delta",
      deltaCursor: `c:${Math.random()}`,
      rows: [],
      terminals: [],
      unidentified: 0,
      ...extra,
    } as never);

  test("ON: an hour-old queue is NOT renewed by a reset, nor by a read without the counter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on", []);
    const first = Date.now();
    await read(t, chatId, { readAt: first, pendingInputs: { items: [], total: 2, queuedCount: 2, complete: true } });
    vi.setSystemTime(first + 60 * 60_000);
    await read(t, chatId, { kind: "reset", deltaCursor: undefined, readAt: Date.now() });
    await read(t, chatId, { readAt: Date.now() });
    const q = await one(t, userId, chatId);
    vi.useRealTimers();
    // The hour-old queue is expired: left out (a reset that renewed it would list it).
    expect(q, "the reset renewed the queue's freshness").toBeNull();
  });

  test.each([
    ["an hour AHEAD", 60 * 60_000],
    ["an hour BEHIND", -60 * 60_000],
  ])("ON: a bridge clock %s never sets the queue's deadline (codex phase 6 pass 2)", async (_n, skew) => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on", []);
    const before = Date.now();
    await read(t, chatId, { readAt: before + skew, pendingInputs: { items: [], total: 1, queuedCount: 1, complete: true } });
    const q = await one(t, userId, chatId);
    expect(q!.until).toBeGreaterThanOrEqual(before + SESSION_ACTIVE_FRESH_MS);
    expect(q!.until).toBeLessThanOrEqual(Date.now() + SESSION_ACTIVE_FRESH_MS);
  });

  test("ON: a read that DOES state the counter renews it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on", []);
    const first = Date.now();
    await read(t, chatId, { readAt: first, pendingInputs: { items: [], total: 2, queuedCount: 2, complete: true } });
    vi.setSystemTime(first + 60 * 60_000);
    const later = Date.now();
    await read(t, chatId, { readAt: later, pendingInputs: { items: [], total: 1, queuedCount: 1, complete: true } });
    const q = await one(t, userId, chatId);
    vi.useRealTimers();
    expect(q).toEqual({ count: 1, until: later + SESSION_ACTIVE_FRESH_MS });
  });

});

describe("each session names ONLY its own queued inputs (codex phase 6 passes 4-5)", () => {
  async function twoSessions(
    t: T,
    a: { queued: number; at: number },
    b: { queued: number; at: number },
    text = (name: string) => name,
  ) {
    const { userId, chatId } = await seed(t, "on", [
      { queued: a.queued, updatedAt: a.at, sessionKey: SK },
      { queued: b.queued, updatedAt: b.at, sessionKey: `${SK}:b` },
    ]);
    await t.run(async (ctx) => {
      for (const [name, sessionKey] of [["A", SK], ["B", `${SK}:b`]] as const) {
        const sendId = `send-${name}`;
        await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: text(name), sendId, custody: "queued", updatedAt: 1 } as never);
        await ctx.db.insert("transcriptInputs", { chatId, sessionKey, sendId, pendingState: "queued", pendingQueued: true, updatedAt: 1 } as never);
      }
    });
    return { userId, chatId };
  }

  test("A's queue of 1 names A's input; B's NEWER read saying 0 names nothing", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { userId, chatId } = await twoSessions(t, { queued: 1, at: now - 60_000 }, { queued: 0, at: now });
    const st = (await stateOf(t, userId, chatId)) as unknown as QueueState;
    expect(st.gatewayQueue.sessions).toHaveLength(1);
    expect(st.gatewayQueue.sessions[0]).toMatchObject({ count: 1, sendIds: ["send-A"] });
  });

  test("a fresh queue on B, an expired one on A: only B is listed, with only B's input", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const { userId, chatId } = await twoSessions(t, { queued: 1, at: now - SESSION_ACTIVE_FRESH_MS - 1 }, { queued: 2, at: now });
    const st = (await stateOf(t, userId, chatId)) as unknown as QueueState;
    expect(st.gatewayQueue.sessions).toEqual([{ count: 2, until: now + SESSION_ACTIVE_FRESH_MS, sendIds: ["send-B"] }]);
  });

  test("huge messages never weigh on the query: 20 x 900 KB queued, stale AND fresh (transactionLimits)", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const now = Date.now();
    const { userId, chatId } = await seed(t, "on", [
      { queued: 20, updatedAt: now - SESSION_ACTIVE_FRESH_MS - 1, sessionKey: SK },
      { queued: 20, updatedAt: now, sessionKey: `${SK}:b` },
    ]);
    for (let i = 0; i < 20; i++) {
      for (const [name, sessionKey] of [["A", SK], ["B", `${SK}:b`]] as const) {
        await t.run(async (ctx) => {
          const sendId = `send-${name}-${i}`;
          await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "x".repeat(900_000), sendId, custody: "queued", updatedAt: 1 } as never);
          await ctx.db.insert("transcriptInputs", { chatId, sessionKey, sendId, pendingState: "queued", pendingQueued: true, updatedAt: 1 } as never);
        });
      }
    }
    const st = (await stateOf(t, userId, chatId)) as unknown as QueueState;
    expect(st.gatewayQueue.sessions).toHaveLength(1);
    expect(st.gatewayQueue.sessions[0]!.sendIds).toHaveLength(20);
  }, 120_000);
});
