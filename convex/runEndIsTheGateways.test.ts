/// <reference types="vite/client" />
//
// A PROJECTED RUN ENDS ON THE GATEWAY'S WORD, NEVER ON ATRIUM'S CLOCK (0.102.1).
//
// Prod 2026-10-25 (instance lacneu, OpenClaw 2026.9.33): one model call streamed an
// unfinished tool call for 17 min 20 s — no agent/chat frame reaches a client meanwhile —
// while every `chat.history` read said the run active. The 12-min stuck-stream watchdog
// closed the bubble `stream_orphaned`; the run answered two minutes later and the bubble
// stayed an error card over its own answer (`errorCardWithAnswer`). The Control UI ends a
// run only on the gateway's terminal (ui/src/pages/chat/chat-gateway.ts:128-200 at
// v2026.9.33) or a read that finds it over (chat-history-stream.ts:187-215), and re-reads
// the gateway's state on reconnect (chat-history-hydration.ts:195-243). Pinned here:
//   - the watchdog leaves a projected OpenClaw bubble alone, however long its silence;
//     a Hermes bubble keeps the net, unchanged;
//   - a bubble the watchdog closed is corrected by the end of ITS run — the live terminal
//     or the transcript's settle — never by another run's; a Stop or a gateway error keeps;
//   - the reconnection question (`resumeOrClose`) applies the gateway's answer, and no
//     answer is never taken for « over »;
//   - the reconnection triggers (the instance answering again) ask, and close nothing.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  STALE_STREAM_MS,
  STUCK_STREAM_ERROR_CODE,
  SWEEP_ERROR_CODE,
  resumeCursorFor,
  resumeVerdict,
} from "./stuckStreams";
import { isWatchdogOrphan } from "./lib/streamOrphan";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

const SK = "agent:main:atrium:chat:u:c1";
const RUN = "webchat-run-A";
const MIN = 60_000;

let prevAnon: string | undefined;
let prevSecret: string | undefined;
beforeEach(() => {
  // Scheduled steps run only when a test drives them (a real timer would let one test's
  // scheduled question reach the next test's stubbed bridge).
  vi.useFakeTimers();
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
  prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_SHARED_SECRET = "s";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
  else process.env.BRIDGE_SHARED_SECRET = prevSecret;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Row = {
  entryId: string;
  seq: number;
  role: string;
  runId?: string;
  sendId?: string;
  hidden: boolean;
  visible: boolean;
  text?: string;
};
const user = (entryId: string, seq: number, sendId: string): Row => ({
  entryId,
  seq,
  role: "user",
  runId: sendId,
  sendId,
  hidden: false,
  visible: true,
});
const said = (entryId: string, seq: number, runId: string, text: string): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId,
  hidden: false,
  visible: true,
  text,
});

/** An OpenClaw instance (projected `on` since 0.102.0) or a Hermes one (never projected). */
async function seed(t: T, kind: "openclaw" | "hermes" = "openclaw", opts: { firstRead?: boolean } = {}) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "prod",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://gw",
      bridgeUrl: "http://bridge-prod",
      ...(kind === "hermes" ? { kind: "hermes" as const } : {}),
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "question",
      sendId: RUN,
      updatedAt: 1,
    });
    return { userId, chatId };
  });
  // The projection's first read (floor 0) — it also stamps `transcriptSeenAt`.
  if (kind === "openclaw" && opts.firstRead !== false) await apply(t, ids.chatId, [], { kind: "page" });
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

/** A live bubble of `runId`, its live row last written `ageMs` ago. */
async function liveBubble(
  t: T,
  ids: { chatId: Id<"chats">; userId: Id<"users"> },
  ageMs: number,
  runId = RUN,
  liveText = "",
) {
  return t.run(async (ctx) => {
    const at = Date.now() - ageMs;
    const id = await ctx.db.insert("messages", {
      chatId: ids.chatId,
      userId: ids.userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId,
      turnSessionKey: SK,
      boundInstance: "prod",
      updatedAt: at,
    });
    await ctx.db.insert("streamingText", {
      messageId: id,
      chatId: ids.chatId,
      userId: ids.userId,
      generation: runId,
      boundInstance: "prod",
      text: liveText,
      updatedAt: at,
    });
    return id;
  });
}

/** What the watchdog did to a bubble before 0.102.1 (stuckStreams.reconcileStuckStreams):
 *  `error` + `stream_orphaned`, partial text kept, live row deleted, no finalize stamp. */
async function orphanAsBefore(t: T, id: Id<"messages">, text = "") {
  await t.run(async (ctx) => {
    await ctx.db.patch(id, { status: "error", error: STUCK_STREAM_ERROR_CODE, ...(text ? { text } : {}) });
    const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first();
    if (row) await ctx.db.delete(row._id);
  });
}

const get = (t: T, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

describe("the watchdog never closes a projected OpenClaw bubble on its clock", () => {
  test("17 min, then 3 h of silence while the gateway says the run active: the bubble streams on", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 17 * MIN);
    await apply(t, ids.chatId, [user("u1", 1, RUN)], { hasActiveRun: true, activeRunIds: [RUN] });
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await get(t, b))?.status).toBe("streaming");
    // No duration at all: three hours, and no read since.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first())!;
      await ctx.db.patch(row._id, { updatedAt: Date.now() - 180 * MIN });
    });
    const res = await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect(res).toMatchObject({ reconciled: 0, skipped: 1 });
    const m = await get(t, b);
    expect(m?.status).toBe("streaming");
    expect(m?.error).toBeUndefined();
  });

  test("…then the gateway's terminal ends it: complete, its answer", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 20 * MIN);
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Envoyé.")], {
      terminals: [{ runId: RUN, status: "completed", at: Date.now() }],
      hasActiveRun: false,
      activeRunIds: [],
    });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Envoyé.");
  });

  test("a Hermes bubble keeps the net, unchanged: closed stream_orphaned past STALE_STREAM_MS", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "hermes");
    const b = await liveBubble(t, ids, STALE_STREAM_MS + MIN);
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    const m = await get(t, b);
    expect(m?.status).toBe("error");
    expect(m?.error).toBe(STUCK_STREAM_ERROR_CODE);
  });

  test("a page of projected rows never blocks the pass: it reads past them (no loop on the same page)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    for (let i = 0; i < 110; i++) await liveBubble(t, ids, 60 * MIN - i * 1000, `run-${i}`);
    const first = await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect(first).toMatchObject({ reconciled: 0, skipped: 100 });
    const next = (await scheduled(t)).filter((s) => s.name.includes("reconcileStuckStreams"));
    expect(next).toHaveLength(1);
    const after = (next[0]!.args[0] as { after?: number }).after;
    expect(typeof after).toBe("number");
    const second = await t.mutation(internal.stuckStreams.reconcileStuckStreams, { after });
    expect(second).toMatchObject({ reconciled: 0, skipped: 10 });
    // The continuation ends: fewer than a scan, nothing acted on.
    expect((await scheduled(t)).filter((s) => s.name.includes("reconcileStuckStreams"))).toHaveLength(1);
  });

  test("the deliberate reconcile (reconcile_chat) ASKS the gateway for a projected bubble, never flips it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 5 * MIN);
    const res = await t.mutation(internal.stuckStreams.reconcileChatStuckStreams, { chatId: ids.chatId });
    expect(res).toMatchObject({ ok: true, reconciled: 0, asked: 1 });
    expect((await get(t, b))?.status).toBe("streaming");
    expect((await scheduled(t)).some((s) => s.name.includes("resumeOrClose"))).toBe(true);
  });
});

describe("a bubble the watchdog closed is corrected by the end of ITS run", () => {
  test("THE INCIDENT: orphaned, then the run's rows (its retry: same runId, new rows) and its terminal — one bubble, complete, the answer", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 12.5 * MIN);
    await orphanAsBefore(t, b);
    expect(isWatchdogOrphan((await get(t, b))!)).toBe(true);
    // The run goes on: its rows arrive while the gateway still says it active — the card
    // is not settled by a run that is not over.
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Je regarde.")], {
      hasActiveRun: true,
      activeRunIds: [RUN],
    });
    expect((await get(t, b))?.status).toBe("error");
    // The gateway's retry of the same run writes more rows, then its final answer.
    await apply(t, ids.chatId, [said("a2", 30, RUN, "Courriel envoyé.")], {
      terminals: [{ runId: RUN, status: "completed", at: Date.now() }],
      hasActiveRun: false,
      activeRunIds: [],
    });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.error).toBeUndefined();
    expect(m?.text).toBe("Je regarde.\n\nCourriel envoyé.");
    expect(m?.finalizedAt).toBeTypeOf("number");
    const assistants = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter(
        (x) => x.role === "assistant",
      ),
    );
    expect(assistants.map((x) => x._id)).toEqual([b]);
    // The run's live terminal that follows changes nothing (the first terminal wins).
    const late = await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "complete",
      text: "",
      expectedRunId: RUN,
    });
    expect(late.transitioned).toBe(false);
    expect((await get(t, b))?.status).toBe("complete");
  });

  test("the run's LIVE terminal alone corrects it: status, text, error cleared, traced", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 13 * MIN);
    await orphanAsBefore(t, b, "partiel");
    const res = await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "complete",
      text: "Réponse finale.",
      expectedRunId: RUN,
    });
    expect(res.transitioned).toBe(true);
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Réponse finale.");
    expect(m?.error).toBeUndefined();
    expect(m?.finalizedAt).toBeTypeOf("number");
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    expect(
      traces.some((e) => e.kind === "assistant.reconcile" && (e.meta ?? "").includes("orphan_corrected")),
    ).toBe(true);
  });

  test("the run's own error terminal turns it into the gateway's error (the truth, not the watchdog's)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 13 * MIN);
    await orphanAsBefore(t, b, "partiel");
    await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "error",
      text: "",
      error: "provider failed",
      expectedRunId: RUN,
    });
    const m = await get(t, b);
    expect(m?.status).toBe("error");
    expect(m?.error).toBe("provider failed");
    expect(isWatchdogOrphan(m!)).toBe(false);
  });

  test("ANOTHER run's terminal, or one naming no run, leaves it as it is", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 13 * MIN);
    await orphanAsBefore(t, b, "partiel");
    const other = await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "complete",
      text: "autre",
      expectedRunId: "webchat-run-B",
    });
    expect(other.transitioned).toBe(false);
    const untagged = await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "complete",
      text: "autre",
    });
    expect(untagged.transitioned).toBe(false);
    const m = await get(t, b);
    expect(m?.status).toBe("error");
    expect(m?.error).toBe(STUCK_STREAM_ERROR_CODE);
    expect(m?.text).toBe("partiel");
  });

  test("a user Stop stays aborted, a gateway error stays an error — they ARE terminals", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const stopped = await liveBubble(t, ids, MIN);
    await t.mutation(internal.stream.finalize, { messageId: stopped, status: "aborted", text: "", expectedRunId: RUN });
    const late = await t.mutation(internal.stream.finalize, {
      messageId: stopped,
      status: "complete",
      text: "trop tard",
      expectedRunId: RUN,
    });
    expect(late.transitioned).toBe(false);
    expect((await get(t, stopped))?.status).toBe("aborted");

    const failed = await liveBubble(t, ids, MIN, "webchat-run-C");
    await t.mutation(internal.stream.finalize, {
      messageId: failed,
      status: "error",
      text: "",
      error: STUCK_STREAM_ERROR_CODE, // even the same code: a finalize stamped it
      expectedRunId: "webchat-run-C",
    });
    expect(isWatchdogOrphan((await get(t, failed))!)).toBe(false);
    const after = await t.mutation(internal.stream.finalize, {
      messageId: failed,
      status: "complete",
      text: "x",
      expectedRunId: "webchat-run-C",
    });
    expect(after.transitioned).toBe(false);
    expect((await get(t, failed))?.status).toBe("error");
  });

  test("Codex pass 1 — a SWEEP's connection_lost close is the same guess: the end of its run corrects it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN, RUN, "partiel");
    // What closeAfterResumeRefused / the boot sweep write: no finalize.
    await t.run(async (ctx) => {
      await ctx.db.patch(b, { status: "error", error: SWEEP_ERROR_CODE, text: "partiel" });
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first();
      if (row) await ctx.db.delete(row._id);
    });
    expect(isWatchdogOrphan((await get(t, b))!)).toBe(true);
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "La vraie réponse.")], {
      terminals: [{ runId: RUN, status: "completed", at: Date.now() }],
      hasActiveRun: false,
      activeRunIds: [],
    });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("La vraie réponse.");
    expect(m?.error).toBeUndefined();
    // …while the bridge's OWN connection_lost terminal (a finalize) is a terminal and stays.
    const other = await liveBubble(t, ids, MIN, "webchat-run-D");
    await t.mutation(internal.stream.finalize, {
      messageId: other,
      status: "error",
      text: "",
      error: SWEEP_ERROR_CODE,
      expectedRunId: "webchat-run-D",
    });
    expect(isWatchdogOrphan((await get(t, other))!)).toBe(false);
  });

  test("an error no finalize stamped but that is not the watchdog's (a refused dispatch) is kept", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, MIN);
    await t.run(async (ctx) => {
      await ctx.db.patch(b, { status: "error", error: "gateway refused the send" });
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first();
      if (row) await ctx.db.delete(row._id);
    });
    const res = await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "complete",
      text: "x",
      expectedRunId: RUN,
    });
    expect(res.transitioned).toBe(false);
    expect((await get(t, b))?.status).toBe("error");
  });

  test("a bubble closed BEFORE 0.102.1 whose run has since ended: `reprojectOrphanedBubble` settles it from its rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 13 * MIN);
    // The pre-fix state: the run's rows were assigned and its end recorded while the
    // bubble was an orphan the projection did not settle (finalizedAt stands in for that).
    await orphanAsBefore(t, b);
    await t.run((ctx) => ctx.db.patch(b, { finalizedAt: 1 }));
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "La réponse.")], {
      terminals: [{ runId: RUN, status: "completed", at: Date.now() }],
      hasActiveRun: false,
      activeRunIds: [],
    });
    await t.run((ctx) => ctx.db.patch(b, { finalizedAt: undefined }));
    expect((await get(t, b))?.status).toBe("error");
    const res = await t.mutation(internal.stuckStreams.reprojectOrphanedBubble, { messageId: b });
    expect(res).toEqual({ scheduled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("La réponse.");
    expect(m?.error).toBeUndefined();
    // Idempotent: nothing more to do.
    expect(await t.mutation(internal.stuckStreams.reprojectOrphanedBubble, { messageId: b })).toMatchObject({
      scheduled: false,
      reason: "not_an_orphan",
    });
  });

  test("the repair refuses a bubble whose run is not known over", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 13 * MIN);
    await orphanAsBefore(t, b);
    expect(await t.mutation(internal.stuckStreams.reprojectOrphanedBubble, { messageId: b })).toMatchObject({
      scheduled: false,
      reason: "run_not_settled",
    });
  });
});

describe("the reconnection question applies the gateway's answer — none is never « over »", () => {
  test("resumeVerdict: the bridge's answer, read", () => {
    expect(resumeVerdict(true, { ok: true, resumed: true })).toBe("resumed");
    expect(resumeVerdict(true, { ok: true, resumed: false, reason: "not_running" })).toBe("not_running");
    expect(resumeVerdict(true, { ok: true, resumed: false, reason: "stale" })).toBe("stale");
    expect(resumeVerdict(true, { ok: true, resumed: false, reason: "busy" })).toBe("busy");
    expect(resumeVerdict(true, { ok: true, resumed: false, reason: "followed" })).toBe("followed");
    expect(resumeVerdict(true, { ok: true, resumed: false, reason: "unknown" })).toBe("unknown");
    expect(resumeVerdict(true, { ok: true, resumed: false, reason: "later-word" })).toBe("unknown");
    // A bridge before 0.102.1 refuses without a reason — for a stale session as for a busy
    // chat: no proof of an end (Codex pass 10).
    expect(resumeVerdict(true, { ok: true, resumed: false })).toBe("unknown");
    expect(resumeVerdict(false, { ok: false })).toBe("unknown");
    expect(resumeVerdict(true, null)).toBe("unknown");
  });

  const answering = (respond: () => Response | Promise<Response>) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return respond();
    });
    return urls;
  };

  test("unreachable (the bridge or its gateway): the bubble stays streaming; no timer — the next cycle asks", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    const urls = answering(() => {
      throw new Error("ECONNREFUSED");
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect(urls).toEqual(["http://bridge-prod/resume"]);
    expect((await get(t, b))?.status).toBe("streaming");
    // A 502 is no answer either. Nothing is planned: the reconciliation cycle asks again.
    answering(() => new Response("{}", { status: 502 }));
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect((await get(t, b))?.status).toBe("streaming");
    expect((await scheduled(t)).filter((s) => s.name.includes("resumeOrClose"))).toHaveLength(0);
  });

  test("Codex pass 5 — `busy` (a send holds the chat) and `followed` (a live socket listens) change nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    const rowAt = async () =>
      (await t.run((ctx) => ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first()))!
        .updatedAt;
    const before = await rowAt();
    for (const reason of ["busy", "followed"]) {
      answering(() => new Response(JSON.stringify({ ok: true, resumed: false, reason }), { status: 200 }));
      await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
      expect((await get(t, b))?.status).toBe("streaming");
    }
    expect(await rowAt()).toBe(before); // nothing written
    expect((await scheduled(t)).filter((s) => s.name.includes("resumeOrClose"))).toHaveLength(0);
  });

  test("Codex pass 1 — no proof the run ended (bridge answers `unknown`): streams on, and its real end completes it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    answering(() => new Response(JSON.stringify({ ok: true, resumed: false, reason: "unknown" }), { status: 200 }));
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect((await get(t, b))?.status).toBe("streaming");
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Réponse tardive.")], {
      terminals: [{ runId: RUN, status: "completed", at: Date.now() }],
      hasActiveRun: false,
      activeRunIds: [],
    });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Réponse tardive.");
  });

  test("still running: resumed — streams on", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    answering(() => new Response(JSON.stringify({ ok: true, resumed: true }), { status: 200 }));
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect((await get(t, b))?.status).toBe("streaming");
    const row = await t.run((ctx) =>
      ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first(),
    );
    expect(row!.updatedAt).toBeGreaterThan(Date.now() - MIN);
  });

  test("the chat's socket carries other work (stale): left as it is, not asked again by a timer", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    answering(() => new Response(JSON.stringify({ ok: true, resumed: false, reason: "stale" }), { status: 200 }));
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect((await get(t, b))?.status).toBe("streaming");
    expect((await scheduled(t)).filter((s) => s.name.includes("resumeOrClose"))).toHaveLength(0);
  });

  test("the gateway says it no longer runs it: what the transcript read left streaming is closed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN, RUN, "partiel");
    answering(() => new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 }));
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    const m = await get(t, b);
    expect(m?.status).toBe("error");
    expect(m?.text).toBe("partiel");
  });

  test("…and never a bubble written since the question was asked (the run's own frames came back)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    answering(async () => {
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first())!;
        await ctx.db.patch(row._id, { updatedAt: Date.now() + 1 });
      });
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect((await get(t, b))?.status).toBe("streaming");
  });

  test("…unless the read that came with the answer settled it (or anything wrote to it since the question)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    answering(async () => {
      // The bridge's transcript read lands before it answers.
      await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Fini.")], {
        hasActiveRun: false,
        activeRunIds: [],
      });
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Fini.");
  });
});

describe("the instance answering again is a reconnection: it asks, and closes nothing", () => {
  test("Codex pass 5 — EVERY successful discovery of an OpenClaw instance is a reconciliation cycle; a failed one is not", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const sweeps = async () => (await scheduled(t)).filter((s) => s.name.includes("sweepInstanceStreams"));
    await t.mutation(internal.agents.recordDiscoveryFailure, { instanceName: "prod", error: "unreachable" } as never);
    expect(await sweeps()).toHaveLength(0); // the gateway does not answer: nothing asked
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "prod", agents: [] });
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "prod", agents: [] });
    expect((await sweeps()).map((s) => s.args[0])).toEqual([
      { instanceName: "prod", projectedOnly: true },
      { instanceName: "prod", projectedOnly: true },
    ]);
  });

  test("…a Hermes instance's discovery schedules nothing (Hermes unchanged)", async () => {
    const t = convexTest(schema, modules);
    await seed(t, "hermes");
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "prod", agents: [] });
    expect((await scheduled(t)).filter((s) => s.name.includes("sweepInstanceStreams"))).toHaveLength(0);
  });

  test("two OpenClaw instances: a reconnection of one asks about ITS bubbles only", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const mine = await liveBubble(t, ids, 10 * MIN);
    const theirs = await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://gw2", bridgeUrl: "http://bridge-other" });
      const chatId = await ctx.db.insert("chats", {
        userId: ids.userId,
        updatedAt: 1,
        instanceName: "other",
        agentId: "main",
        transcriptSeenAt: 1,
      });
      const id = await ctx.db.insert("messages", {
        chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "webchat-run-O",
        turnSessionKey: SK,
        boundInstance: "other",
        updatedAt: Date.now() - 10 * MIN,
      });
      await ctx.db.insert("streamingText", {
        messageId: id,
        chatId,
        userId: ids.userId,
        generation: "webchat-run-O",
        boundInstance: "other",
        text: "",
        updatedAt: Date.now() - 10 * MIN,
      });
      return id;
    });
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    const asked = (await scheduled(t))
      .filter((s) => s.name.includes("resumeOrClose"))
      .map((s) => (s.args[0] as { messageId: string; instanceName: string }));
    expect(asked).toEqual([{ messageId: mine, instanceName: "prod" }]);
    expect((await get(t, theirs))?.status).toBe("streaming");
  });

  test("the projected-only sweep asks about a projected bubble and never closes a Hermes one", async () => {
    const t = convexTest(schema, modules);
    const on = await seed(t);
    const projected = await liveBubble(t, on, 10 * MIN);
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    expect((await get(t, projected))?.status).toBe("streaming");
    expect((await scheduled(t)).some((s) => s.name.includes("resumeOrClose"))).toBe(true);

    const t2 = convexTest(schema, modules);
    const hermes = await seed(t2, "hermes");
    const h = await liveBubble(t2, hermes, 10 * MIN);
    await t2.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    expect((await get(t2, h))?.status).toBe("streaming");
    // …while the BOOT sweep (the bridge restarted: no run of its is in flight) still does.
    await t2.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod" });
    expect((await get(t2, h))?.status).toBe("error");
  });
});

describe("Codex pass 2 — the run's owner decides, and a fresh projected bubble is asked later, not never", () => {
  /** A NEW conversation whose transcript reads all failed: no `transcriptSeenAt`, no cursor. */
  async function freshConversation(t: T) {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", bridgeUrl: "http://bridge-prod" });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
      return { userId, chatId };
    });
  }
  const open = (t: T, chatId: Id<"chats">, projectedTurn?: boolean) =>
    t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: RUN,
      turnSessionKey: SK,
      boundInstanceName: "prod",
      ...(projectedTurn ? { projectedTurn: true } : {}),
    });
  const age = (t: T, id: Id<"messages">, ms: number) =>
    t.run(async (ctx) => {
      const row = (await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first())!;
      await ctx.db.patch(row._id, { updatedAt: Date.now() - ms });
      await ctx.db.patch(id, { updatedAt: Date.now() - ms });
    });

  test("a new conversation, no transcript read ever landed, a long silence: no orphan — its owner said projected", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await freshConversation(t);
    const b = (await open(t, chatId, true))!;
    expect((await get(t, b))?.projectedTurn).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.transcriptSeenAt).toBeUndefined();
    await age(t, b, 60 * MIN);
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await get(t, b))?.status).toBe("streaming");
    // …and the gateway IS asked: the deliberate reconcile, a reconnection.
    const res = await t.mutation(internal.stuckStreams.reconcileChatStuckStreams, { chatId });
    expect(res).toMatchObject({ reconciled: 0, asked: 1 });
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    const asked = (await scheduled(t)).filter((s) => s.name.includes("resumeOrClose"));
    expect(asked.length).toBe(2);
    expect(asked.every((s) => (s.args[0] as { messageId: string }).messageId === b)).toBe(true);
    expect((await get(t, b))?.status).toBe("streaming");
  });

  test("the steer split carries the stamp to the next segment", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await freshConversation(t);
    const b = (await open(t, chatId, true))!;
    const next = await t.mutation(internal.stream.splitSegment, { messageId: b, boundInstanceName: "prod" });
    expect(next).not.toBeNull();
    expect((await get(t, next!))?.projectedTurn).toBe(true);
  });

  test("a turn its bridge did NOT call projected (Hermes) is never stamped and keeps the net", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await freshConversation(t);
    await t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first())!;
      await ctx.db.patch(inst._id, { kind: "hermes" as const });
    });
    const b = (await open(t, chatId))!;
    expect((await get(t, b))?.projectedTurn).toBeUndefined();
    await age(t, b, STALE_STREAM_MS + MIN);
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await get(t, b))?.error).toBe(STUCK_STREAM_ERROR_CODE);
  });

  test("a projected-only pass plans no rerun: the cycle is the rerun (the boot sweep keeps its one deferred pass)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await open(t, ids.chatId, true); // fresh
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    expect((await scheduled(t)).filter((s) => s.name.includes("sweepInstanceStreams"))).toHaveLength(0);
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod" });
    expect((await scheduled(t)).filter((s) => s.name.includes("sweepInstanceStreams")).map((s) => s.args[0])).toEqual([
      { instanceName: "prod", rerun: true },
    ]);
  });

  test("cut, then a late append: too fresh for the close's question — the cycle asks once it is quiet, and the gateway settles it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const b = (await open(t, ids.chatId, true))!;
    // An append in flight lands 10 s after the cut; a cycle at t+60 s finds it too fresh.
    vi.setSystemTime(t0 + 10_000);
    await t.mutation(internal.stream.appendDelta, { messageId: b, text: "tard", boundInstanceName: "prod" } as never);
    vi.setSystemTime(t0 + 60_000);
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "prod", agents: [] });
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    expect((await scheduled(t)).some((s) => s.name.includes("resumeOrClose"))).toBe(false);
    // A later cycle, the bubble quiet: it is asked.
    vi.setSystemTime(t0 + 420_000);
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    expect((await scheduled(t)).some((s) => s.name.includes("resumeOrClose"))).toBe(true);
    vi.stubGlobal("fetch", async () => {
      await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Réponse finale.")], {
        hasActiveRun: false,
        activeRunIds: [],
      });
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Réponse finale.");
  });

  test("Codex pass 5 (a) — the socket dropped while the bubble was being opened: the early question finds nothing, the cycle finds the bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const t0 = Date.now();
    vi.setSystemTime(t0);
    // The close's question lands BEFORE startAssistant: nothing streaming yet.
    expect(await t.mutation(internal.stuckStreams.resumeChatStreams, { instanceName: "prod", chatId: ids.chatId })).toEqual({
      asked: 0,
    });
    const b = (await open(t, ids.chatId, true))!;
    // Nobody reads it now — and the next cycle with the bubble quiet asks about it.
    vi.setSystemTime(t0 + 400_000);
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    const asked = (await scheduled(t)).filter((s) => s.name.includes("resumeOrClose")).map((s) => s.args[0]);
    expect(asked).toEqual([{ messageId: b, instanceName: "prod" }]);
  });

  test("Codex pass 5 (b) — `busy` (a send held the gate) is not the last word: the next cycle asks again", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: true, resumed: false, reason: "busy" }), { status: 200 }),
    );
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect((await get(t, b))?.status).toBe("streaming");
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod", projectedOnly: true });
    expect((await scheduled(t)).filter((s) => s.name.includes("resumeOrClose")).map((s) => s.args[0])).toEqual([
      { messageId: b, instanceName: "prod" },
    ]);
  });

  test("a restarted bridge with N projected bubbles streaming: every one is asked at the first pass", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const bubbles = [];
    for (let i = 0; i < 5; i++) bubbles.push(await liveBubble(t, ids, 10 * MIN, `webchat-run-${i}`));
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod" });
    const asked = (await scheduled(t))
      .filter((s) => s.name.includes("resumeOrClose"))
      .map((s) => (s.args[0] as { messageId: string }).messageId)
      .sort();
    expect(asked).toEqual([...bubbles].sort());
  });
});

describe("Codex pass 3 — asking stops, listening does not", () => {
  test("4× unknown, then the run's terminal and rows: the one bubble closes", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: true, resumed: false, reason: "unknown" }), { status: 200 }),
    );
    for (let i = 0; i < 4; i++) {
      await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
      expect((await get(t, b))?.status).toBe("streaming");
    }
    // Nothing is planned by the answers themselves…
    expect((await scheduled(t)).filter((s) => s.name.includes("resumeOrClose"))).toHaveLength(0);
    // …the listening bridge posts what the gateway then says: the run's end, its rows.
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Enfin fini.")], {
      terminals: [{ runId: RUN, status: "completed", at: Date.now() }],
      hasActiveRun: false,
      activeRunIds: [],
    });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Enfin fini.");
    const assistants = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter(
        (x) => x.role === "assistant",
      ),
    );
    expect(assistants.map((x) => x._id)).toEqual([b]);
  });
});

describe("Codex pass 4 — a socket's close asks; Convex decides from its own state", () => {
  test("the chat has a projected bubble streaming: the gateway is asked at once (no age gate)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 0);
    const res = await t.mutation(internal.stuckStreams.resumeChatStreams, { instanceName: "prod", chatId: ids.chatId });
    expect(res).toEqual({ asked: 1 });
    const asked = (await scheduled(t)).filter((s) => s.name.includes("resumeOrClose"));
    expect(asked.map((s) => s.args[0])).toEqual([{ messageId: b, instanceName: "prod" }]);
  });

  test("nothing streaming in the chat: a no-op — nothing written, nothing scheduled", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const before = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
    }));
    const res = await t.mutation(internal.stuckStreams.resumeChatStreams, { instanceName: "prod", chatId: ids.chatId });
    expect(res).toEqual({ asked: 0 });
    const after = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
    }));
    expect(after).toEqual(before);
  });

  test("only THIS chat's bubbles, and only for the instance the chat routes to", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await liveBubble(t, ids, 0);
    const otherChat = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ids.userId, updatedAt: 1, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 }),
    );
    await liveBubble(t, { chatId: otherChat, userId: ids.userId }, 0, "webchat-run-X");
    expect(await t.mutation(internal.stuckStreams.resumeChatStreams, { instanceName: "prod", chatId: ids.chatId })).toEqual({
      asked: 1,
    });
    // Another instance cannot ask about this chat — even for a bubble that names no
    // instance (opened before the per-turn stamp): the chat's routing is the barrier.
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://gw2" });
      for (const m of await ctx.db.query("messages").collect()) {
        if (m.role === "assistant") await ctx.db.patch(m._id, { boundInstance: undefined });
      }
    });
    expect(
      await t.mutation(internal.stuckStreams.resumeChatStreams, { instanceName: "other", chatId: ids.chatId }),
    ).toEqual({ asked: 0 });
  });

  test("4× unknown, then the socket closes: the close's question settles the bubble as the gateway says", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN);
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: true, resumed: false, reason: "unknown" }), { status: 200 }),
    );
    for (let i = 0; i < 4; i++) {
      await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    }
    expect((await get(t, b))?.status).toBe("streaming");
    // The socket closes; the bridge asks for the chat. The gateway, asked again on a new
    // socket, no longer runs it: its transcript read settles the one bubble.
    expect(await t.mutation(internal.stuckStreams.resumeChatStreams, { instanceName: "prod", chatId: ids.chatId })).toEqual({
      asked: 1,
    });
    vi.stubGlobal("fetch", async () => {
      await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "Terminé.")], {
        hasActiveRun: false,
        activeRunIds: [],
      });
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Terminé.");
  });
});

describe("Codex pass 8 — the resume names the bubble's OWN session, after a per-turn switch", () => {
  test("A's bubble, the conversation now on B (another instance, another segment): the bridge of A's instance is asked with A's session key and agent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const keyA = "agent:main:atrium:chat:u:turn-first";
    const b = await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://gw2", bridgeUrl: "http://bridge-other" });
      await ctx.db.insert("userAgents", {
        userId: ids.userId,
        instanceName: "other",
        agentId: "agent-b",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      // The conversation switched to B: its CURRENT routing tuple and segment are B's.
      await ctx.db.patch(ids.chatId, {
        perTurnRouting: true,
        lastRoutedInstanceName: "other",
        lastRoutedAgentId: "agent-b",
        routingSegment: "turn:second",
      });
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: RUN,
        turnSessionKey: keyA,
        boundInstance: "prod",
        routedInstanceName: "prod",
        routedAgentId: "main",
        projectedTurn: true,
        updatedAt: Date.now() - 30 * MIN,
      });
      await ctx.db.insert("streamingText", {
        messageId: id,
        chatId: ids.chatId,
        userId: ids.userId,
        generation: RUN,
        boundInstance: "prod",
        text: "",
        updatedAt: Date.now() - 30 * MIN,
      });
      return id;
    });
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "unknown" }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.url).toBe("http://bridge-prod/resume");
    // A's own session key and A's agent and instance — what the bridge derives A's segment
    // from (bridge/test/resume-unknown-listens.test.ts, pass 8), whatever segment the
    // conversation names now.
    expect(bodies[0]!.body).toMatchObject({
      sessionKey: keyA,
      instanceName: "prod",
      agentId: "main",
      liveBubble: { messageId: b, runId: RUN },
    });
  });
});

describe("Codex pass 9 — an ORDINARY reply on the secondary instance carries its route through its send", () => {
  test("opened for real (no hand stamp), long silence, discovery cycle: the SECONDARY is asked; open while it runs, settled at its end", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const keyB = "agent:agent-b:atrium:chat:u:turn-b";
    const outboxId = await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://gw2", bridgeUrl: "http://bridge-other" });
      await ctx.db.insert("userAgents", {
        userId: ids.userId,
        instanceName: "other",
        agentId: "agent-b",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      // The conversation is bound to `prod`; this turn was addressed to agent-b on `other`.
      await ctx.db.patch(ids.chatId, { perTurnRouting: true, lastRoutedInstanceName: "other", lastRoutedAgentId: "agent-b" });
      const userMsg = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "@agent-b ?",
        routedInstanceName: "other",
        routedAgentId: "agent-b",
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("outbox", {
        chatId: ids.chatId,
        userId: ids.userId,
        clientMessageId: "b1",
        messageId: userMsg,
        text: "@agent-b ?",
        attachmentIds: [],
        status: "sent",
        sendId: RUN,
        routedAgent: { instanceName: "other", agentId: "agent-b" },
        sentToInstance: "other",
      });
    });
    // The bridge of `other` opens the ORDINARY reply: no route on the message itself.
    const b = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: RUN,
      turnSessionKey: keyB,
      dispatchOutboxId: outboxId,
      projectedTurn: true,
      boundInstanceName: "other",
    }))!;
    const opened = await get(t, b);
    expect(opened?.routedInstanceName).toBeUndefined();
    expect(opened?.routedAgentId).toBeUndefined();
    // Long silence: the watchdog leaves it.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first())!;
      await ctx.db.patch(row._id, { updatedAt: Date.now() - 60 * MIN });
    });
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await get(t, b))?.status).toBe("streaming");
    // A discovery cycle of `other` asks about it — through the SECONDARY's bridge.
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "other", agents: [] });
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "other", projectedOnly: true });
    const asked = (await scheduled(t)).filter((s) => s.name.includes("resumeOrClose")).map((s) => s.args[0]);
    expect(asked).toContainEqual({ messageId: b, instanceName: "other" });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let answer: "resumed" | "over" = "resumed";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (answer === "resumed") return new Response(JSON.stringify({ ok: true, resumed: true }), { status: 200 });
      await t.mutation(internal.transcriptProjection.applyTranscript, {
        chatId: ids.chatId,
        boundInstanceName: "other",
        sessionKey: keyB,
        sessionId: "s-b",
        kind: "page",
        rows: [user("u1", 1, RUN), said("a1", 2, RUN, "Réponse de B.")] as never,
        terminals: [],
        unidentified: 0,
        hasActiveRun: false,
        activeRunIds: [],
      } as never);
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 });
    });
    // While it runs: resumed, open.
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "other" });
    expect(calls[0]!.url).toBe("http://bridge-other/resume");
    expect(calls[0]!.body).toMatchObject({ instanceName: "other", agentId: "agent-b", sessionKey: keyB });
    expect((await get(t, b))?.status).toBe("streaming");
    // Its end: the secondary's transcript settles it.
    answer = "over";
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "other" });
    expect(calls[1]!.url).toBe("http://bridge-other/resume");
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Réponse de B.");
  });

  test("a reply whose route cannot be resolved to its own instance stays OPEN (no proof of its end)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://gw2", bridgeUrl: "http://bridge-other" });
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: RUN,
        turnSessionKey: "agent:x:atrium:chat:u:c",
        boundInstance: "other",
        projectedTurn: true,
        updatedAt: Date.now() - 60 * MIN,
      });
      await ctx.db.insert("streamingText", {
        messageId: id,
        chatId: ids.chatId,
        userId: ids.userId,
        generation: RUN,
        boundInstance: "other",
        text: "partiel",
        updatedAt: Date.now() - 60 * MIN,
      });
      return id;
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true, resumed: false }), { status: 200 });
    });
    // No route of its own: the chat's routing resolves to `prod`, not the bubble's `other`.
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "other" });
    expect(urls).toEqual([]);
    expect((await get(t, b))?.status).toBe("streaming");
  });
});

describe("Codex pass 9 — the inventory: nothing closes a projected bubble without the gateway's proof", () => {
  test("its send's route no longer resolves (the agent is not granted any more): asked nowhere, OPEN", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://gw2", bridgeUrl: "http://bridge-other" });
      const ob = await ctx.db.insert("outbox", {
        chatId: ids.chatId,
        userId: ids.userId,
        clientMessageId: "g1",
        text: "x",
        attachmentIds: [],
        status: "sent",
        routedAgent: { instanceName: "other", agentId: "ghost" },
      });
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: RUN,
        turnSessionKey: "agent:ghost:atrium:chat:u:c",
        boundInstance: "other",
        dispatchOutboxId: String(ob),
        projectedTurn: true,
        updatedAt: Date.now() - 60 * MIN,
      });
      await ctx.db.insert("streamingText", {
        messageId: id,
        chatId: ids.chatId,
        userId: ids.userId,
        generation: RUN,
        boundInstance: "other",
        text: "",
        updatedAt: Date.now() - 60 * MIN,
      });
      return id;
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true, resumed: false }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "other" });
    expect(urls).toEqual([]);
    expect((await get(t, b))?.status).toBe("streaming");
  });

  test("a bubble opened BEFORE 0.102.1 (no stamp) in a conversation never read: the watchdog asks its instance, and leaves an OpenClaw one", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw" });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
      return { userId, chatId };
    });
    const b = await liveBubble(t, ids, STALE_STREAM_MS + MIN);
    expect((await get(t, b))?.projectedTurn).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(ids.chatId)))?.transcriptSeenAt).toBeUndefined();
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await get(t, b))?.status).toBe("streaming");
  });
});

describe("Codex passes 10-11 — no close without the gateway's proof, whatever the bridge; the reader resumes at the store's cursor", () => {
  const bodies: Array<Record<string, unknown>> = [];
  const bridgeAnswering = (respond: () => Response | Promise<Response>) => {
    bodies.length = 0;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return respond();
    });
  };

  test("an OLD bridge's refusal without a reason (a stale session, a busy chat during a rolling deploy): OPEN; the next cycle, on the updated bridge, settles it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = await liveBubble(t, ids, 30 * MIN, RUN, "partiel");
    bridgeAnswering(() => new Response(JSON.stringify({ ok: true, resumed: false }), { status: 200 }));
    for (let i = 0; i < 3; i++) {
      await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
      expect((await get(t, b))?.status).toBe("streaming");
    }
    // The bridge updated: its read lands, then it answers not_running.
    bridgeAnswering(async () => {
      await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "La réponse entière.")], {
        hasActiveRun: false,
        activeRunIds: [],
      });
      return new Response(JSON.stringify({ ok: true, resumed: false, reason: "not_running" }), { status: 200 });
    });
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("La réponse entière.");
  });

  test("the /resume carries the store's cursor of the bubble's OWN session: the bridge reads every row after it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a1", 2, RUN, "début")], { deltaCursor: "c:2" });
    const b = await liveBubble(t, ids, 30 * MIN);
    bridgeAnswering(() => new Response(JSON.stringify({ ok: true, resumed: false, reason: "unknown" }), { status: 200 }));
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: b, instanceName: "prod" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.sessionKey).toBe(SK);
    expect(bodies[0]!.resumeCursor).toEqual({ sessionId: "s-1", deltaCursor: "c:2" });
  });

  test("THE PASS-10 REPRO, on the upstream model: the store holds the start, the delta answered `reset`, the newest page (with the final answer) and the run's end are applied — the bubble shows the final answer and settles", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const b = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: RUN,
      turnSessionKey: SK,
      projectedTurn: true,
      boundInstanceName: "prod",
    }))!;
    // What streamed live before the conversation's socket moved on (agent A → B).
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first())!;
      await ctx.db.patch(row._id, { text: "début" });
    });
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a2", 2, RUN, "début")], {
      deltaCursor: "c:2",
      hasActiveRun: true,
      activeRunIds: [RUN],
    });
    // The catch-up reader: `reset` from c:2, then the newest page — rows 141..180 here (the
    // test's apply carries texts inline, bounded at 40 rows), the last one the answer.
    await apply(t, ids.chatId, [], { kind: "reset" });
    const tail = Array.from({ length: 40 }, (_, i) =>
      said(`a${141 + i}`, 141 + i, RUN, i === 39 ? "RÉPONSE FINALE" : `part ${141 + i}`),
    );
    await apply(t, ids.chatId, tail, { kind: "page", deltaCursor: "c:180", hasActiveRun: false, activeRunIds: [] });
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toContain("RÉPONSE FINALE");
    expect(m?.text?.startsWith("début")).toBe(true);
    // The hole stays recorded on the cursor: what is missing is said, never invented.
    const cursor = await t.run((ctx) => ctx.db.query("transcriptCursors").first());
    expect(cursor?.gaps).toEqual([expect.objectContaining({ fromSeq: 3, toSeq: 140 })]);
  });

  test("Codex pass 12 — NO cursor stored before (no read ever landed): the newest page no longer holds the user's row, the first-read floor lands on its last row — the run's OWN bubble still shows the final answer and settles, no paging", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "openclaw", { firstRead: false });
    const b = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: RUN,
      turnSessionKey: SK,
      projectedTurn: true,
      boundInstanceName: "prod",
    }))!;
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first())!;
      await ctx.db.patch(row._id, { text: "début" });
    });
    expect(await t.run((ctx) => ctx.db.query("transcriptCursors").collect())).toEqual([]);
    const page = Array.from({ length: 40 }, (_, i) =>
      said(`a${141 + i}`, 141 + i, RUN, i === 39 ? "RÉPONSE FINALE" : `part ${141 + i}`),
    );
    await apply(t, ids.chatId, page, { kind: "page", deltaCursor: "c:180", hasActiveRun: false, activeRunIds: [] });
    const cursor = await t.run((ctx) => ctx.db.query("transcriptCursors").first());
    expect(cursor?.floorSeq).toBe(180);
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toContain("RÉPONSE FINALE");
    // …and the floor still keeps those rows from giving birth to another bubble.
    const assistants = (await t.run((ctx) => ctx.db.query("messages").collect())).filter((x) => x.role === "assistant");
    expect(assistants.map((x) => x._id)).toEqual([b]);
  });

  test("…below the floor, a run with NO bubble of its own gives birth to none (a legacy bubble shows it)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "openclaw", { firstRead: false });
    await apply(t, ids.chatId, [said("a41", 41, RUN, "ancienne réponse")], {
      kind: "page",
      deltaCursor: "c:41",
      hasActiveRun: false,
      activeRunIds: [],
    });
    const assistants = (await t.run((ctx) => ctx.db.query("messages").collect())).filter((x) => x.role === "assistant");
    expect(assistants).toEqual([]);
  });

  test("…and no bubble is BORN from a run a hole overlaps (only an existing one is recomposed)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [user("u1", 1, RUN), said("a2", 2, RUN, "début")], {
      deltaCursor: "c:2",
      hasActiveRun: true,
      activeRunIds: [RUN],
    });
    await apply(t, ids.chatId, [said("a50", 50, RUN, "RÉPONSE FINALE")], {
      kind: "page",
      deltaCursor: "c:50",
      hasActiveRun: false,
      activeRunIds: [],
    });
    const born = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(born.filter((x) => x.role === "assistant")).toEqual([]);
  });

  test("resumeCursorFor: the cursor of the instance asked; none ⇒ none sent", () => {
    const cursors = [
      { instanceName: "other", sessionId: "s-o", deltaCursor: "c:o" },
      { instanceName: "prod", sessionId: "s-1", deltaCursor: "c:9" },
    ];
    expect(resumeCursorFor(cursors, "prod")).toEqual({ sessionId: "s-1", deltaCursor: "c:9" });
    expect(resumeCursorFor(cursors, "third")).toBeUndefined();
    expect(resumeCursorFor([], "prod")).toBeUndefined();
  });
});
