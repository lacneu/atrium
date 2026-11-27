/// <reference types="vite/client" />
//
// A STEER'S TARGET IS APPEND-ONLY. OpenClaw 2026.10.33 broadcasts the steered user row twice
// under the same seq: first without `__openclaw.steerTargetRunId`, then with it, once the
// transcript commit is confirmed (src/sessions/user-turn-transcript-updates.ts
// `confirmPersistedSteerTargetRunId`, which only ever ADDS the target). A late first copy,
// or a read still serving it, must never erase the cut the second copy stated.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { steerSeqsOf } from "./lib/transcriptProjection";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

const SK = "agent:main:atrium:chat:u:c1";
const R = "run-r";
let clock = 1_000;

async function apply(t: T, chatId: Id<"chats">, rows: unknown[], extra: Record<string, unknown> = {}) {
  clock += 10;
  await t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${clock}`,
    readAt: clock,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    hasActiveRun: true,
    activeRunIds: [R],
    ...extra,
  } as never);
}

const userRow = (withTarget: boolean) => ({
  entryId: "s1:user",
  seq: 3,
  role: "user",
  runId: "s1",
  sendId: "s1",
  ...(withTarget ? { steerTargetRunId: R } : {}),
  hidden: false,
  visible: true,
  text: "et aussi ?",
});

describe("the steered row's target, once stored, stays", () => {
  test("the copy without target after the one with it: the cut is kept", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
      return await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    });
    await apply(t, chatId, [], { kind: "page" });
    await apply(t, chatId, [userRow(true)]);
    await apply(t, chatId, [userRow(false)]);
    const row = await t.run((ctx) =>
      ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) => q.eq("chatId", chatId).eq("sessionKey", SK).eq("entryId", "s1:user"))
        .first(),
    );
    expect(row?.steerTargetRunId).toBe(R);
    expect((await t.run((ctx) => steerSeqsOf(ctx, chatId, SK, R))).seqs).toEqual([3]);
  });

  test("the copy without target first, then with it: the cut is stated", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
      return await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    });
    await apply(t, chatId, [], { kind: "page" });
    await apply(t, chatId, [userRow(false)]);
    expect((await t.run((ctx) => steerSeqsOf(ctx, chatId, SK, R))).seqs).toEqual([]);
    await apply(t, chatId, [userRow(true)]);
    expect((await t.run((ctx) => steerSeqsOf(ctx, chatId, SK, R))).seqs).toEqual([3]);
  });
});
