/// <reference types="vite/client" />
//
// A TURN CUT BY A GATEWAY RESTART OR STOP — the Convex hop.
//
// The rows are the ones the bridge reads from two live proofs on OpenClaw 2026.9.36
// (bridge/test/restart-recovery-rows.test.ts produces this file's input,
// `bridge/test/fixtures/restart-recovery-projected-2026.9.36.json`): a turn waiting on a
// tool, the gateway's recovery entry (`provenance.sourceTool:
// "main_session_restart_recovery"`, a row of the NEW run), then that run's answer.
//
// What a reader must end with: the interrupted bubble STATES the interruption — from the
// shutdown the gateway announced on the turn's socket and/or the recovery entry — and the
// recovery answer reads as its continuation (one display group). Nothing is decided by a
// clock: every fact is a row, or the bridge's report of a socket close.

import { convexTest, type TestConvex } from "convex-test";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { compareOrder } from "./lib/messageOrder";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Row = Record<string, unknown> & { entryId: string; seq: number; role: string; runId?: string };

const projected = JSON.parse(
  readFileSync(new URL("../bridge/test/fixtures/restart-recovery-projected-2026.9.36.json", import.meta.url), "utf8"),
) as { restart: Row[]; stop: Row[] };

const SK = "agent:alice:atrium:chat:u-repro:turn-nx78dqkpq6ad35yh16z22fp6m18jms0v";
const INTERRUPTED = "webchat-f5d1f2db9ee87713854fde13ad4d7448c962f4e5dcd7fa9d485b1bef4d73fabf";
const RECOVERY = "a784bc6d-61a0-48df-a1b7-a7b3ecaab9fd";
const STOPPED = projected.stop.find((r) => r.seq === 39)!.runId!;
const STOP_RECOVERY = projected.stop.find((r) => r.seq === 95)!.runId!;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
  vi.useFakeTimers();
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A projected conversation whose user message is the send of `runId`, and a first, empty
 *  read (floor 0). */
async function seed(t: T, runId: string) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "alice", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    const userMessageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "sleep 70",
      sendId: runId,
      updatedAt: 1,
    });
    await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "a",
      messageId: userMessageId,
      text: "sleep 70",
      attachmentIds: [],
      status: "sent",
      sendId: runId,
    });
    return { userId, chatId, userMessageId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Record<string, unknown> = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${Math.random()}`,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

/** The turn's live bubble, streaming, as the bridge's sink opened it. */
const liveBubble = (t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }, runId: string) =>
  t.run(async (ctx) => {
    const id = await ctx.db.insert("messages", {
      chatId: ids.chatId,
      userId: ids.userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId,
      turnSessionKey: SK,
      boundInstance: "prod",
      projectedTurn: true,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("streamingText", {
      messageId: id,
      chatId: ids.chatId,
      userId: ids.userId,
      generation: runId,
      boundInstance: "prod",
      text: "",
      updatedAt: Date.now(),
    });
    return id;
  });

/** The bridge reports the close of the turn's socket; its gateway is away (502). */
async function socketClosed(t: T, chatId: Id<"chats">, shutdown?: "restart" | "stop") {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, error: { code: "GATEWAY_DISCONNECTED" } }), { status: 502 }));
  await t.mutation(internal.stuckStreams.resumeChatStreams, {
    instanceName: "prod",
    chatId,
    ...(shutdown === "restart" ? { restartExpectedMs: 1500 } : {}),
    ...(shutdown !== undefined ? { shutdown } : {}),
  } as never);
}

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const get = (t: T, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"messages"> | null>;
const assistants = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.role === "assistant"),
  );
const IDLE = { hasActiveRun: false, activeRunIds: [] };

describe("a restart cuts a turn, the gateway's recovery answers (bench proof C2-3a)", () => {
  test("the interrupted bubble states the restart and its recovery; the answer is its continuation", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "restart");
    // The announced shutdown is a fact about the bubble from the moment the socket closed.
    expect((await get(t, cut))?.interruption).toEqual({ shutdown: "restart" });

    // The reconnected bridge reads the interrupted run's rows, then the recovery's.
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 11), { hasActiveRun: true, activeRunIds: [RECOVERY] });
    // The recovery entry alone, its run still working: the bubble says so, in the
    // transaction that follows the row's (the ingestion reads no message for it).
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 12), { kind: "live" });
    await settle(t);
    expect((await get(t, cut))?.interruption?.recoveryRunId).toBe(RECOVERY);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 11), IDLE);
    await settle(t);

    const all = await assistants(t, ids.chatId);
    expect(all).toHaveLength(2);
    const first = (await get(t, cut))!;
    expect(first.status).toBe("complete");
    expect(first.text).toBe("");
    expect(first.error).toBeUndefined();
    // `unanswered`: its own rows stop on a tool call — true with or without a recovery.
    expect(first.interruption).toEqual({ shutdown: "restart", recoveryRunId: RECOVERY, unanswered: true });
    // Its unfinished call stays what the transcript says: a call with no result.
    const tools = (first.rowLayout ?? []).flatMap((r) => r.tools ?? []);
    expect(tools.filter((x) => x.status === "call").map((x) => x.name)).toEqual(["wait"]);

    const answer = all.find((m) => m._id !== cut)!;
    expect(answer.runId).toBe(RECOVERY);
    expect(answer.text).toContain("interrompue");
    expect(answer.interruption).toBeUndefined();
    // One display group: the recovery reads as the continuation of the turn it resumes.
    expect(first.displayGroupId).toBe(String(cut));
    expect(answer.displayGroupId).toBe(String(cut));
  });

  test("live order (bench run of 2026-11-21): the recovery's terminal arrives BEFORE the interrupted run is known over — its bubble is still placed AFTER the interrupted one", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    // The turn's bubble opens seconds after the question, as it does live.
    vi.advanceTimersByTime(9_000);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    vi.advanceTimersByTime(30_000);
    await socketClosed(t, ids.chatId, "restart");
    // The reconnected bridge reads the interrupted run's rows and the entry: the session
    // is busy (the recovery runs), so nothing says yet that the interrupted run is over.
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 12), { hasActiveRun: true });
    expect((await get(t, cut))?.status).toBe("streaming");
    // The recovery's rows, live, then its terminal: its bubble is born while the
    // interrupted bubble is still the live one of its run (its rows not placed yet).
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12), { kind: "live" });
    await apply(t, ids.chatId, [], { terminals: [{ runId: RECOVERY, status: "completed", at: Date.now() }], hasActiveRun: true });
    // …and only then does an idle read say the interrupted run is over.
    await apply(t, ids.chatId, [], IDLE);
    await settle(t);
    const shown = (await t.run((ctx) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", ids.chatId)).collect())).sort(compareOrder);
    expect(shown.map((m) => [m.role, m.runId ?? null])).toEqual([
      ["user", null],
      ["assistant", INTERRUPTED],
      ["assistant", RECOVERY],
    ]);
    expect(shown.map((m) => m.displayGroupId)).toEqual([undefined, String(cut), String(cut)]);
    expect(shown[1]!.interruption).toEqual({ shutdown: "restart", recoveryRunId: RECOVERY, unanswered: true });
  });

  test("without the bridge's report of the shutdown, the recovery entry alone states the interruption", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart, IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toEqual({ recoveryRunId: RECOVERY });
  });

  test("a recovery entry stored BEFORE the rows it follows is resolved once they are there", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    // An EARLIER run's row is already stored; the live `session.message` of the entry
    // reaches Convex before the rows it follows. The earlier run is not the one resumed.
    await apply(t, ids.chatId, [{ entryId: "old", seq: 2, role: "assistant", runId: "webchat-earlier", hidden: false, visible: true, text: "earlier" }], {
      hasActiveRun: true,
      activeRunIds: [INTERRUPTED],
    });
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 12), { kind: "live" });
    expect((await get(t, cut))?.interruption).toBeUndefined();
    expect((await assistants(t, ids.chatId)).every((m) => m.interruption === undefined)).toBe(true);
    // Neither later read returns the entry again: it is resolved when its run is over.
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 11), { hasActiveRun: true, activeRunIds: [RECOVERY] });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12), IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toEqual({ recoveryRunId: RECOVERY });
    const all = await assistants(t, ids.chatId);
    expect(all.map((m) => [m.runId, m.displayGroupId])).toEqual([
      ["webchat-earlier", undefined],
      [INTERRUPTED, String(cut)],
      [RECOVERY, String(cut)],
    ]);
  });

  test("a bubble BORN from the interrupted run's rows carries the same statement", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart, IDLE);
    await settle(t);
    const all = await assistants(t, ids.chatId);
    const first = all.find((m) => m.runId === INTERRUPTED)!;
    expect(first.interruption).toEqual({ recoveryRunId: RECOVERY });
    expect(all.find((m) => m.runId === RECOVERY)?.displayGroupId).toBe(String(first._id));
  });

  test("replaying the same reads changes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "restart");
    await apply(t, ids.chatId, projected.restart, IDLE);
    await settle(t);
    const before = await assistants(t, ids.chatId);
    await apply(t, ids.chatId, projected.restart, IDLE);
    await settle(t);
    const after = await assistants(t, ids.chatId);
    expect(after.map((m) => [m._id, m.text, m.status, m.interruption, m.displayGroupId])).toEqual(
      before.map((m) => [m._id, m.text, m.status, m.interruption, m.displayGroupId]),
    );
    expect((await get(t, cut))?.interruption).toEqual({ shutdown: "restart", recoveryRunId: RECOVERY, unanswered: true });
  });
});

describe("a stop cuts a turn (bench proof C2-3d)", () => {
  test("the interrupted bubble states the STOP, and its recovery once the gateway is back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, STOPPED);
    const cut = await liveBubble(t, ids, STOPPED);
    await socketClosed(t, ids.chatId, "stop");
    expect((await get(t, cut))?.interruption).toEqual({ shutdown: "stop" });
    await apply(t, ids.chatId, projected.stop, IDLE);
    await settle(t);
    const first = (await get(t, cut))!;
    expect(first.status).toBe("complete");
    expect(first.interruption).toEqual({ shutdown: "stop", recoveryRunId: STOP_RECOVERY, unanswered: true });
    const answer = (await assistants(t, ids.chatId)).find((m) => m.runId === STOP_RECOVERY)!;
    expect(answer.displayGroupId).toBe(String(cut));
  });
});

describe("the gateway's recovery does NOT answer", () => {
  const cutOnly = projected.restart.filter((r) => r.seq <= 11);

  test("a run the gateway no longer runs, stopped on a tool exchange after an announced shutdown: stated, and kept", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "restart");
    await apply(t, ids.chatId, cutOnly, IDLE);
    await settle(t);
    const first = (await get(t, cut))!;
    // The existing rule for a run the gateway no longer runs: settled by its transcript.
    expect(first.status).toBe("complete");
    expect(first.finalizeCause).toBe("transcript_settled");
    expect(first.interruption).toEqual({ shutdown: "restart", unanswered: true });
  });

  test("…even when the run had written nothing a reader sees: the bubble is not dropped", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "stop");
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 3), IDLE);
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId: ids.chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "delta",
      deltaCursor: "c:end",
      rows: [],
      terminals: [{ runId: INTERRUPTED, status: "aborted", at: Date.now() }],
      unidentified: 0,
    } as never);
    await settle(t);
    const first = await get(t, cut);
    expect(first).not.toBeNull();
    expect(first?.interruption).toEqual({ shutdown: "stop", unanswered: true });
  });

  test("a run cut before it wrote anything, then resumed: its bubble is kept to say so", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    // The turn's own input row only, its run active; then the entry right after it and
    // the recovery's answer (the fixture's rows, renumbered to follow the input).
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 3), { hasActiveRun: true, activeRunIds: [INTERRUPTED] });
    const tail = projected.restart.filter((r) => r.seq === 12 || r.seq === 16).map((r, i) => ({ ...r, seq: 4 + i }));
    await apply(t, ids.chatId, tail, IDLE);
    await settle(t);
    const first = await get(t, cut);
    expect(first).not.toBeNull();
    expect(first).toMatchObject({ status: "complete", text: "", interruption: { recoveryRunId: RECOVERY } });
    expect((await assistants(t, ids.chatId)).map((m) => m.displayGroupId)).toEqual([String(cut), String(cut)]);
  });

  test("a run that ANSWERED before the announced shutdown is not called interrupted", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, RECOVERY);
    const done = await liveBubble(t, ids, RECOVERY);
    await socketClosed(t, ids.chatId, "restart");
    // The recovery run's own rows end on an answer (`stopReason: "stop"`).
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12), IDLE);
    await settle(t);
    const m = (await get(t, done))!;
    expect(m.status).toBe("complete");
    expect(m.text).toContain("interrompue");
    expect(m.interruption).toEqual({ shutdown: "restart" });
  });

  test("a run that ANSWERED, then a live `aborted` row the durable transcript does not hold: retracted, it does not make the turn unanswered", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, RECOVERY);
    const done = await liveBubble(t, ids, RECOVERY);
    await socketClosed(t, ids.chatId, "restart");
    const own = projected.restart.filter((r) => r.seq > 12);
    const last = Math.max(...own.map((r) => r.seq));
    await apply(t, ids.chatId, own, { hasActiveRun: true, activeRunIds: [RECOVERY] });
    await apply(t, ids.chatId, [{ entryId: "ephemeral-abort", seq: last + 1, role: "assistant", runId: RECOVERY, stopReason: "aborted", hidden: false, visible: false }], {
      kind: "live",
      deltaCursor: undefined,
    });
    // The durable read covers that place with another row: the live one is retracted.
    const NEXT = "webchat-" + "9".repeat(64);
    await apply(t, ids.chatId, [...own, { entryId: "next-input", seq: last + 1, role: "user", runId: NEXT, sendId: NEXT, hidden: false, visible: true }], { kind: "page", ...IDLE });
    await settle(t);
    const m = (await get(t, done))!;
    expect(m.text).toContain("interrompue");
    expect(m.interruption).toEqual({ shutdown: "restart" });
  });

  test("a run CUT on a tool call, then a live answer row the durable transcript does not hold: retracted, the cut is still stated and the bubble kept", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "restart");
    const own = projected.restart.filter((r) => r.seq <= 11);
    await apply(t, ids.chatId, own, { hasActiveRun: true, activeRunIds: [INTERRUPTED] });
    await apply(t, ids.chatId, [{ entryId: "ephemeral-answer", seq: 12, role: "assistant", runId: INTERRUPTED, stopReason: "stop", hidden: false, visible: false }], {
      kind: "live",
      deltaCursor: undefined,
    });
    const NEXT = "webchat-" + "9".repeat(64);
    await apply(t, ids.chatId, [...own, { entryId: "next-input", seq: 12, role: "user", runId: NEXT, sendId: NEXT, hidden: false, visible: true }], { kind: "page", ...IDLE });
    await settle(t);
    const m = await get(t, cut);
    expect(m).not.toBeNull();
    expect(m!.interruption).toEqual({ shutdown: "restart", unanswered: true });
  });

  test("a snapshot that still ends on a tool call is read first, the answer row comes later: `unanswered` goes away with it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, RECOVERY);
    const done = await liveBubble(t, ids, RECOVERY);
    await socketClosed(t, ids.chatId, "restart");
    // An idle read whose rows stop before the run's last one (an older snapshot).
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12 && r.seq < 16), IDLE);
    await settle(t);
    expect((await get(t, done))?.interruption).toEqual({ shutdown: "restart", unanswered: true });
    // The answer row is read after all: the bubble no longer says it stopped unanswered.
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 16), IDLE);
    await settle(t);
    const m = (await get(t, done))!;
    expect(m.text).toContain("interrompue");
    expect(m.interruption).toEqual({ shutdown: "restart" });
  });

  test("the turn RESUMED live after the announced shutdown: the announcement is no longer a fact about it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "restart");
    expect((await get(t, cut))?.interruption).toEqual({ shutdown: "restart" });
    await t.mutation(internal.stuckStreams.markResumed, { messageId: cut });
    expect((await get(t, cut))?.interruption).toBeUndefined();
    // Whatever its transcript shows afterwards, nothing calls it interrupted.
    await apply(t, ids.chatId, cutOnly, IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toBeUndefined();
  });

  test("a close with no announced shutdown states nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId);
    await apply(t, ids.chatId, cutOnly, IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toBeUndefined();
  });
});

describe("what a recovery entry may and may not join", () => {
  test("a user message between the two bubbles keeps them apart (transcript order prevails)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 11), { hasActiveRun: true, activeRunIds: [RECOVERY] });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "user" as const, status: "complete" as const, text: "et alors ?", updatedAt: Date.now() });
    });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 11), IDLE);
    await settle(t);
    const all = await assistants(t, ids.chatId);
    expect((await get(t, cut))?.interruption).toEqual({ recoveryRunId: RECOVERY });
    expect(all.map((m) => m.displayGroupId)).toEqual([undefined, undefined]);
  });

  test("the run was cut right after a STEERED input: the recovery resumes the run it was steered into, not the input's own send", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    const STEER = "webchat-" + "c".repeat(64);
    const steered = { entryId: "steer-1", seq: 12, role: "user", runId: STEER, sendId: STEER, steerTargetRunId: INTERRUPTED, hidden: false, visible: true };
    const tail = projected.restart.filter((r) => r.seq >= 12).map((r) => ({ ...r, seq: r.seq + 1 }));
    await apply(t, ids.chatId, [...projected.restart.filter((r) => r.seq <= 11), steered, ...tail], IDLE);
    await settle(t);
    const all = await assistants(t, ids.chatId);
    expect(all.filter((m) => m.interruption?.recoveryRunId === RECOVERY).map((m) => m.runId)).toEqual([INTERRUPTED]);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).find((r) => r.recoversRunId !== undefined)?.recoversRunId)).toBe(INTERRUPTED);
    void cut;
  });

  test("an input of a send that never ran (a queued input) right before the entry: nothing is attributed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    await liveBubble(t, ids, INTERRUPTED);
    const QUEUED = "webchat-" + "d".repeat(64);
    const queued = { entryId: "queued-1", seq: 12, role: "user", runId: QUEUED, sendId: QUEUED, hidden: false, visible: true };
    const tail = projected.restart.filter((r) => r.seq >= 12).map((r) => ({ ...r, seq: r.seq + 1 }));
    await apply(t, ids.chatId, [...projected.restart.filter((r) => r.seq <= 11), queued, ...tail], IDLE);
    await settle(t);
    expect((await assistants(t, ids.chatId)).every((m) => m.interruption === undefined)).toBe(true);
    // …and nothing is recorded: no later bubble of that id could ever be taken for it.
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).filter((r) => r.recoversRunId !== undefined).length)).toBe(0);
  });

  test("ANOTHER run answered between the cut and the recovery (a heartbeat): its last row is right before the entry, and nothing is attributed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    await liveBubble(t, ids, INTERRUPTED);
    const BEAT = "webchat-" + "e".repeat(64);
    const between = [
      { entryId: "beat-in", seq: 12, role: "user", runId: BEAT, sendId: BEAT, hidden: true, visible: false },
      { entryId: "beat-out", seq: 13, role: "assistant", runId: BEAT, stopReason: "stop", hidden: true, visible: false },
    ];
    const tail = projected.restart.filter((r) => r.seq >= 12).map((r) => ({ ...r, seq: r.seq + 2 }));
    await apply(t, ids.chatId, [...projected.restart.filter((r) => r.seq <= 11), ...between, ...tail], IDLE);
    await settle(t);
    expect((await assistants(t, ids.chatId)).every((m) => m.interruption?.recoveryRunId === undefined)).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).filter((r) => r.recoversRunId !== undefined).length)).toBe(0);
  });

  test("an entry of another provenance is no recovery", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    const rows = projected.restart.map((r) => (r.seq === 12 ? { ...r, provenanceSourceTool: "progress_card_refresh" } : r));
    await apply(t, ids.chatId, rows, IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toBeUndefined();
    expect((await assistants(t, ids.chatId)).map((m) => m.displayGroupId)).toEqual([undefined, undefined]);
  });

  test("an entry of another provenance KIND is no recovery either", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    const rows = projected.restart.map((r) => (r.seq === 12 ? { ...r, provenanceKind: "inter_session" } : r));
    await apply(t, ids.chatId, rows, IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toBeUndefined();
  });
});

describe("what a bubble says of its recovery is read from the rows at every pass", () => {
  const rowsWith = (t: T) => t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).filter((r) => r.recoversRunId !== undefined));

  test("the recovery entry was only seen LIVE and a durable read that covers its place does not return it: the bubble stops saying a recovery resumed it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 11), IDLE);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 12), { kind: "live", deltaCursor: undefined });
    await settle(t);
    expect((await get(t, cut))?.interruption).toEqual({ recoveryRunId: RECOVERY });
    expect((await rowsWith(t)).map((r) => r.recoversRunId)).toEqual([INTERRUPTED]);
    // The durable transcript holds another entry there: the live one is retracted.
    const OTHER = "webchat-" + "f".repeat(64);
    // (A delta that returns none of the interrupted run's rows and ends no run: only the
    // retraction brings that run back to be read.)
    await apply(t, ids.chatId, [{ entryId: "other-12", seq: 12, role: "user", runId: OTHER, sendId: OTHER, hidden: false, visible: true }], {
      hasActiveRun: true,
      activeRunIds: [OTHER],
    });
    await settle(t);
    expect((await get(t, cut))?.interruption?.recoveryRunId).toBeUndefined();
    expect(await rowsWith(t)).toEqual([]);
  });

  test("the row BEFORE the entry was only seen live and is retracted: the entry stops naming its run, the bubble stops saying it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 10), { hasActiveRun: true, activeRunIds: [INTERRUPTED] });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 11), { kind: "live", deltaCursor: undefined });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 12), { kind: "live", deltaCursor: undefined });
    await settle(t);
    expect((await get(t, cut))?.interruption).toEqual({ recoveryRunId: RECOVERY });
    // The durable read covers its place and does not return it.
    await apply(
      t,
      ids.chatId,
      [...projected.restart.filter((r) => r.seq <= 10), ...projected.restart.filter((r) => r.seq === 12)],
      { kind: "page", hasActiveRun: true, activeRunIds: [RECOVERY] },
    );
    await settle(t);
    expect(await rowsWith(t)).toEqual([]);
    expect((await get(t, cut))?.interruption?.recoveryRunId).toBeUndefined();
  });

  test("the entry was resolved while the interrupted run had no bubble yet: the pass that makes the bubble asks for it to be told", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 12), { hasActiveRun: true, activeRunIds: [INTERRUPTED, RECOVERY] });
    await settle(t);
    expect(await assistants(t, ids.chatId)).toEqual([]);
    // The interrupted run is now known over: its bubble is born from its rows.
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12), IDLE);
    await settle(t);
    const born = (await assistants(t, ids.chatId)).filter((m) => m.runId === INTERRUPTED);
    expect(born).toHaveLength(1);
    expect(born[0]!.interruption?.recoveryRunId).toBe(RECOVERY);
  });

  test("the entry stands: every later pass says the same", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart, IDLE);
    await settle(t);
    const before = (await get(t, cut))?.interruption;
    expect(before?.recoveryRunId).toBe(RECOVERY);
    await apply(t, ids.chatId, projected.restart, { kind: "page", ...IDLE });
    await settle(t);
    expect((await get(t, cut))?.interruption).toEqual(before);
    expect((await rowsWith(t)).map((r) => r.recoversRunId)).toEqual([INTERRUPTED]);
  });
});

describe("the recovery of a run is said on ONE bubble of that run: the one that shows its end", () => {
  const STEER = "webchat-" + "c".repeat(64);
  /** The interrupted run's rows without seq 9, whose place a steered input holds. */
  const withoutNine = projected.restart.filter((r) => r.seq <= 11 && r.seq !== 9);
  const steerRow = { entryId: "steer-9", seq: 9, role: "user", runId: STEER, sendId: STEER, steerTargetRunId: INTERRUPTED, hidden: false, visible: true };
  const saying = async (t: T, chatId: Id<"chats">) =>
    (await assistants(t, chatId)).filter((m) => m.runId === INTERRUPTED).map((m) => [m.runSegment ?? 0, m.interruption?.recoveryRunId ?? null]);

  test("a steer cut received AFTER the bubble was told: the fact moves to the last segment's bubble, the first stops saying it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    // The run is not known over yet: its rows are not placed, its one bubble is told.
    await apply(t, ids.chatId, [...withoutNine, ...projected.restart.filter((r) => r.seq === 12)], { hasActiveRun: true, activeRunIds: [INTERRUPTED, RECOVERY] });
    await settle(t);
    expect((await get(t, cut))?.interruption?.recoveryRunId).toBe(RECOVERY);
    // The steered input is read, and the run is over: its rows after the cut make a bubble.
    await apply(t, ids.chatId, [steerRow, ...projected.restart.filter((r) => r.seq === 10 || r.seq === 11)], { hasActiveRun: true, activeRunIds: [RECOVERY] });
    await settle(t);
    expect((await saying(t, ids.chatId)).sort()).toEqual([
      [0, null],
      [1, RECOVERY],
    ]);
  });

  test("…then the entry is retracted: no bubble of the run says it any more", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, withoutNine, { hasActiveRun: true, activeRunIds: [INTERRUPTED, RECOVERY] });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 12), { kind: "live", deltaCursor: undefined });
    await settle(t);
    expect((await get(t, cut))?.interruption?.recoveryRunId).toBe(RECOVERY);
    // The cut and the retraction arrive together: the first bubble was the one told.
    const OTHER = "webchat-" + "f".repeat(64);
    await apply(t, ids.chatId, [steerRow, ...projected.restart.filter((r) => r.seq === 10 || r.seq === 11), { entryId: "other-12", seq: 12, role: "user", runId: OTHER, sendId: OTHER, hidden: false, visible: true }], {
      hasActiveRun: true,
      activeRunIds: [OTHER],
    });
    await settle(t);
    expect((await saying(t, ids.chatId)).sort()).toEqual([
      [0, null],
      [1, null],
    ]);
  });

  test("`unanswered` too is said by the last segment's bubble only", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await socketClosed(t, ids.chatId, "restart");
    await apply(t, ids.chatId, [...withoutNine, steerRow], IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption).toEqual({ shutdown: "restart" });
  });
});

describe("the recovery's bubble is placed after the LAST bubble of the turn it resumes", () => {
  /** Ten bubbles of the interrupted run, one per steer segment, the last still open. */
  async function tenSegments(t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }) {
    const first = await liveBubble(t, ids, INTERRUPTED);
    await t.run((ctx) => ctx.db.patch(first, { status: "complete" as const }));
    const made: Array<Id<"messages">> = [first];
    for (let k = 1; k <= 9; k++) {
      // Each segment is born well after the one before (a real turn's are seconds apart).
      vi.advanceTimersByTime(1_000);
      made.push(
        await t.run((ctx) =>
          ctx.db.insert("messages", {
            chatId: ids.chatId,
            userId: ids.userId,
            role: "assistant" as const,
            status: k === 9 ? ("streaming" as const) : ("complete" as const),
            text: `segment ${k}`,
            runId: INTERRUPTED,
            runSegment: k,
            turnSessionKey: SK,
            boundInstance: "prod",
            projectedTurn: true,
            updatedAt: Date.now(),
          }),
        ),
      );
    }
    return made;
  }
  const order = async (t: T, chatId: Id<"chats">) =>
    (await t.run((ctx) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()))
      .filter((m) => m.role === "assistant")
      .sort(compareOrder)
      .map((m) => (m.runId === RECOVERY ? "recovery" : `segment ${m.runSegment ?? 0}`));

  test("the recovery ends before the interrupted turn of TEN segments is known over: its bubble comes after the tenth, not in the middle", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    await tenSegments(t, ids);
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq <= 12), { hasActiveRun: true, activeRunIds: [INTERRUPTED, RECOVERY] });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12), { hasActiveRun: true, activeRunIds: [INTERRUPTED] });
    await settle(t);
    const shown = await order(t, ids.chatId);
    expect(shown.at(-1)).toBe("recovery");
    expect(shown.slice(0, -1)).toEqual(Array.from({ length: 10 }, (_, k) => `segment ${k}`));
  });

  test("a run of TEN bubbles that all say a recovery no row states: every one is cleared, eight per transaction", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const made = await tenSegments(t, ids);
    await t.run(async (ctx) => {
      for (const id of made) await ctx.db.patch(id, { interruption: { recoveryRunId: RECOVERY } });
    });
    await t.mutation(internal.transcriptProjection.noteRunRecovery, { chatId: ids.chatId, sessionKey: SK, instanceName: "prod", runId: INTERRUPTED, withdraw: RECOVERY });
    // The first transaction reaches the bubble that shows the run's end (no steer row is
    // stored here: its first) and the eight newest; the continuation reaches the rest.
    expect((await assistants(t, ids.chatId)).filter((m) => m.interruption !== undefined).map((m) => m.runSegment)).toEqual([1]);
    await settle(t);
    expect((await assistants(t, ids.chatId)).filter((m) => m.interruption !== undefined)).toEqual([]);
  });

  test("a segment of the interrupted run whose bubble is BORN after the recovery's still comes before it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    await liveBubble(t, ids, INTERRUPTED);
    const STEER = "webchat-" + "c".repeat(64);
    const withoutNine = projected.restart.filter((r) => r.seq <= 11 && r.seq !== 9);
    // The recovery answers while the interrupted run is not known over.
    await apply(t, ids.chatId, [...withoutNine, ...projected.restart.filter((r) => r.seq === 12)], { hasActiveRun: true, activeRunIds: [INTERRUPTED, RECOVERY] });
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq > 12), { hasActiveRun: true, activeRunIds: [INTERRUPTED] });
    await settle(t);
    expect(await order(t, ids.chatId)).toEqual(["segment 0", "recovery"]);
    // Then the steered input is read and the run is over: its second segment is born.
    await apply(
      t,
      ids.chatId,
      [{ entryId: "steer-9", seq: 9, role: "user", runId: STEER, sendId: STEER, steerTargetRunId: INTERRUPTED, hidden: false, visible: true }, ...projected.restart.filter((r) => r.seq === 10 || r.seq === 11)],
      IDLE,
    );
    await settle(t);
    expect(await order(t, ids.chatId)).toEqual(["segment 0", "segment 1", "recovery"]);
  });
});

// A RUN ID IS A GATEWAY'S CHOICE. In a conversation several instances serve, or several
// sessions of one, another one's bubble can carry the very id of the run recovered here:
// nothing of the recovery — told, cleared, grouped — reaches it.
describe("the recovery never reaches a bubble of another instance or another session that carries the same run id", () => {
  /** A settled bubble of the SAME run id, bound to `instance` in session `sessionKey`. */
  const foreign = (t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }, instance: string, sessionKey: string, interruption?: Doc<"messages">["interruption"]) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "theirs",
        runId: INTERRUPTED,
        turnSessionKey: sessionKey,
        boundInstance: instance,
        projectedTurn: true,
        ...(interruption !== undefined ? { interruption } : {}),
        updatedAt: Date.now(),
      }),
    );
  const OTHER_SK = "agent:alice:atrium:chat:u-repro:turn-another";

  test("TOLD and GROUPED: only this instance's, this session's bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const theirs = await foreign(t, ids, "other", SK);
    const elsewhere = await foreign(t, ids, "prod", OTHER_SK);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    await apply(t, ids.chatId, projected.restart, IDLE);
    await settle(t);
    expect((await get(t, cut))?.interruption?.recoveryRunId).toBe(RECOVERY);
    expect((await get(t, cut))?.displayGroupId).toBe(String(cut));
    for (const id of [theirs, elsewhere]) {
      const m = (await get(t, id))!;
      expect(m.interruption).toBeUndefined();
      expect(m.displayGroupId).toBeUndefined();
      expect(m.text).toBe("theirs");
    }
  });

  test("CLEARED: a withdrawal takes the fact from this scope's bubbles and leaves theirs saying what they say", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const said = { recoveryRunId: RECOVERY };
    const theirs = await foreign(t, ids, "other", SK, said);
    const elsewhere = await foreign(t, ids, "prod", OTHER_SK, said);
    const cut = await liveBubble(t, ids, INTERRUPTED);
    const mine = await foreign(t, ids, "prod", SK, said);
    await t.run((ctx) => ctx.db.patch(cut, { interruption: said }));
    await t.mutation(internal.transcriptProjection.noteRunRecovery, { chatId: ids.chatId, sessionKey: SK, instanceName: "prod", runId: INTERRUPTED, withdraw: RECOVERY });
    await settle(t);
    expect((await get(t, cut))?.interruption).toBeUndefined();
    expect((await get(t, mine))?.interruption).toBeUndefined();
    expect((await get(t, theirs))?.interruption).toEqual(said);
    expect((await get(t, elsewhere))?.interruption).toEqual(said);
  });

  test("…and through a run's recorded bubble (`runBubbles`) too", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, INTERRUPTED);
    const said = { recoveryRunId: RECOVERY };
    const MERGED = "webchat-" + "7".repeat(64);
    // Another instance's bubble of another run, recorded as where this run id wrote.
    const theirs = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "theirs",
        runId: MERGED,
        turnSessionKey: SK,
        boundInstance: "other",
        interruption: said,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: INTERRUPTED, messageId: id, createdAt: 1 });
      return id;
    });
    await t.mutation(internal.transcriptProjection.noteRunRecovery, { chatId: ids.chatId, sessionKey: SK, instanceName: "prod", runId: INTERRUPTED, withdraw: RECOVERY });
    await settle(t);
    expect((await get(t, theirs))?.interruption).toEqual(said);
  });
});
