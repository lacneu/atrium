/// <reference types="vite/client" />
//
// CODEX REVIEW 2 OF 0.101.1 [medium]: the child is done, the last read saw `hasActiveRun:true`,
// then the parent's terminal arrives with no content and every re-read of `chat.history`
// fails. No read replaced the fact, so `followUpState.workingUntil` stayed valid for 15 min —
// and the thread's waiting line with it. The terminal received live (`finalize`) ends the
// activity correlated with its run, without waiting for a read (the Control UI ends the run
// on its terminal, `handleTerminalChatEvent`).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
const RESUME = "announce:requester-settle:main:agent:main:atrium:chat:u:c1:turn-1:child-run-1:yield-1";

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    return { userId, chatId };
  });
}
async function read(t: T, chatId: Id<"chats">, activeRunIds: string[]) {
  await t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "page",
    deltaCursor: `c:${Date.now()}`,
    readAt: Date.now(),
    rows: [],
    terminals: [],
    unidentified: 0,
    hasActiveRun: activeRunIds.length > 0,
    activeRunIds,
  } as never);
}
const workingUntil = async (t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) =>
  ((await t.withIdentity({ subject: ids.userId }).query(api.followUp.followUpState, { chatId: ids.chatId })) as { workingUntil?: number | null }).workingUntil ?? null;

describe("the run's terminal received live ends the activity correlated with it", () => {
  test("a silent terminal, then failing re-reads: no `workingUntil` from the terminal on", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // The read that states the resume run active, then its own bubble opens (`on`).
    await read(t, ids.chatId, [RESUME]);
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: RESUME, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    expect((await t.run((ctx) => ctx.db.get(m)))?.deliveryOwnBubble).toBe(true);
    expect(await workingUntil(t, ids)).not.toBeNull();
    // The terminal, with nothing to show (the bubble is dropped) — and no read after it.
    await t.mutation(internal.stream.finalize, { messageId: m, status: "complete", text: "", expectedRunId: RESUME, boundInstanceName: "prod", dropIfEmpty: true } as never);
    expect(await workingUntil(t, ids)).toBeNull();
  });

  test("another run still active keeps the claim: only the run that ended leaves it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // The read that states the resume run active, then its own bubble opens (`on`).
    await read(t, ids.chatId, [RESUME, "other-run"]);
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: RESUME, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    expect((await t.run((ctx) => ctx.db.get(m)))?.deliveryOwnBubble).toBe(true);
    await t.mutation(internal.stream.finalize, { messageId: m, status: "complete", text: "Fait.", expectedRunId: RESUME, boundInstanceName: "prod" } as never);
    expect(await workingUntil(t, ids)).not.toBeNull();
    const cursor = await t.run((ctx) => ctx.db.query("transcriptCursors").first());
    expect(cursor?.activeRunIds).toEqual(["other-run"]);
  });
});
