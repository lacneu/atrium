/// <reference types="vite/client" />
//
// A TOOL CARD WHOSE RESULT FRAME NEVER REACHED THE BRIDGE (live bench, 2026-11-22, gateway
// frozen 125 s during an `exec`): the socket was closed for silence while the tool ran, the
// result passed while it was closed, the run was resumed live and ended `gateway_final`.
// The transcript holds the result row; the stored card stayed `start`, because the sink
// that tracked it as open died with the socket. The rows settle the STORED card, under the
// view's own rule — and invent nothing for a call no row gives a result to.
//
// The rows are the shape of that run (seq 13-15): the assistant row naming the `exec`
// call, the nested `process` activity row (call and result in one row), the `toolresult`.

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
const RUN = "webchat-run-1";
const EXEC = "call_bc0e|fc_01";
const NESTED = "tool_call:call_bc0e_fc_01:process:1";
type Row = Record<string, unknown>;

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    return { userId, chatId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}
let clock = 1_000;
function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
  clock += 10;
  return t.mutation(internal.transcriptProjection.applyTranscript, {
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
    ...extra,
  } as never);
}
const over = { terminals: [{ runId: RUN, status: "completed", at: 1 }], hasActiveRun: false };

const row = (entryId: string, seq: number, role: string, blocks: Row[], extra: Row = {}): Row => ({
  entryId,
  seq,
  role,
  runId: RUN,
  hidden: false,
  visible: false,
  blocks,
  ...extra,
});
const callRow = row("a13", 13, "assistant", [{ type: "tool", toolCallId: EXEC, name: "exec", status: "call" }], { stopReason: "toolUse" });
const nestedRow = (status: "result" | "error") =>
  row("c14", 14, "custom", [
    { type: "tool", toolCallId: NESTED, name: "process", status: "call", parentToolCallId: EXEC },
    { type: "tool", toolCallId: NESTED, name: "process", status, parentToolCallId: EXEC },
  ]);
const resultRow = (status: "result" | "error") =>
  row("t15", 15, "toolresult", [{ type: "tool", toolCallId: EXEC, name: "exec", status, output: { details: { status: "completed", exitCode: 0 } } }]);
const finalRow = row("a16", 16, "assistant", [{ type: "text", text: "TURN_DONE" }], { visible: true, text: "TURN_DONE", stopReason: "stop" });

/** The bubble as the resumed turn left it: both cards written `start` before the socket
 *  closed, then the gateway's terminal. */
async function settledLiveBubble(t: T, chatId: Id<"chats">, phases: { exec: string; nested: string } = { exec: "start", nested: "start" }) {
  const m = (await t.mutation(internal.stream.startAssistant, { chatId, runId: RUN, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
  await t.mutation(internal.stream.addPart, {
    messageId: m,
    part: { kind: "tool", name: "exec", phase: phases.exec, toolCallId: EXEC, textOffset: 0, input: { command: "sleep 200" } },
    boundInstanceName: "prod",
  } as never);
  await t.mutation(internal.stream.addPart, {
    messageId: m,
    part: { kind: "tool", name: "process", phase: phases.nested, toolCallId: NESTED, parentToolCallId: EXEC, textOffset: 0 },
    boundInstanceName: "prod",
  } as never);
  await t.mutation(internal.stream.finalize, { messageId: m, status: "complete", text: "TURN_DONE", expectedRunId: RUN, boundInstanceName: "prod" } as never);
  return m;
}
async function storedPhases(t: T, m: Id<"messages">): Promise<Record<string, string>> {
  const parts = await t.run((ctx) => ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", m)).collect());
  const out: Record<string, string> = {};
  for (const p of parts) if (p.part.kind === "tool" && p.part.toolCallId !== undefined) out[p.part.toolCallId] = p.part.phase;
  return out;
}
async function viewPhases(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }, m: Id<"messages">): Promise<Record<string, string>> {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
    _id: Id<"messages">;
    parts: Array<{ kind: string; toolCallId?: string; phase?: string }>;
  }>;
  const out: Record<string, string> = {};
  for (const p of all.find((x) => x._id === m)!.parts) if (p.kind === "tool" && p.toolCallId !== undefined) out[p.toolCallId] = p.phase ?? "";
  return out;
}

describe("a settled bubble's stored tool cards read their outcome from its rows", () => {
  test("the result passed while the socket was closed: the row's result closes the stored card", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await settledLiveBubble(t, ids.chatId);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "start", [NESTED]: "start" });
    await apply(t, ids.chatId, [callRow, nestedRow("result"), resultRow("result"), finalRow], over);
    expect((await t.run((ctx) => ctx.db.get(m)))?.rowLayout).toBeDefined();
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
    // The view said so already (lib/viewReconcile.ts): both now agree.
    expect(await viewPhases(t, ids, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
  });

  test("a row's error is shown from the row and never stored: a later read that corrects the row corrects the card", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await settledLiveBubble(t, ids.chatId);
    await apply(t, ids.chatId, [callRow, nestedRow("error"), resultRow("error"), finalRow], over);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "start", [NESTED]: "start" });
    expect(await viewPhases(t, ids, m)).toEqual({ [EXEC]: "error", [NESTED]: "error" });
    await apply(t, ids.chatId, [nestedRow("result"), resultRow("result")], over);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
    expect(await viewPhases(t, ids, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
  });

  test("a card the live stream completed, its row read as an error then corrected: the card follows the row both times", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await settledLiveBubble(t, ids.chatId, { exec: "completed", nested: "completed" });
    await apply(t, ids.chatId, [callRow, nestedRow("error"), resultRow("error"), finalRow], over);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
    expect(await viewPhases(t, ids, m)).toEqual({ [EXEC]: "error", [NESTED]: "error" });
    await apply(t, ids.chatId, [nestedRow("result"), resultRow("result")], over);
    expect(await viewPhases(t, ids, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
  });

  test("a call no row gives a result to keeps its phase: nothing is invented", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await settledLiveBubble(t, ids.chatId);
    await apply(t, ids.chatId, [callRow, finalRow], over);
    expect((await t.run((ctx) => ctx.db.get(m)))?.rowLayout).toBeDefined();
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "start", [NESTED]: "start" });
  });

  test("a failure the live stream reported is not undone by a row that read no error", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await settledLiveBubble(t, ids.chatId, { exec: "error", nested: "completed" });
    await apply(t, ids.chatId, [callRow, nestedRow("result"), resultRow("result"), finalRow], over);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "error", [NESTED]: "completed" });
    expect(await viewPhases(t, ids, m)).toEqual({ [EXEC]: "error", [NESTED]: "completed" });
  });

  test("the result row read AFTER the bubble was composed closes the card at that read", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await settledLiveBubble(t, ids.chatId);
    await apply(t, ids.chatId, [callRow, finalRow], over);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "start", [NESTED]: "start" });
    await apply(t, ids.chatId, [nestedRow("result"), resultRow("result")], over);
    expect(await storedPhases(t, m)).toEqual({ [EXEC]: "completed", [NESTED]: "completed" });
  });
});
