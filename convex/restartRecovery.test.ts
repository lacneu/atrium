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
    // The recovery entry alone, its run still working: the bubble says so at once.
    await apply(t, ids.chatId, projected.restart.filter((r) => r.seq === 12), { kind: "live" });
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
