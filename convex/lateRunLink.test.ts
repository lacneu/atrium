/// <reference types="vite/client" />
//
// ONE RUN, TWO NAMES, THE LINK STATED LATE (OpenClaw 2026.10.33) — the Convex half.
//
// A queued input's execution is broadcast under the input's CLIENT run while its
// transcript rows keep the EXECUTION run (src/gateway/server-methods/
// chat-send-turn-adoption.ts:289-302, src/gateway/server-chat.ts:1158 at v2026.10.33).
// The bridge reads both under the execution run once it knows the link; when the live
// stream speaks first, the bubble is already open under the client run. The gateway's
// statement of the link (`sessions.changed` carrying `clientRunId` ≠ `runId`) then reaches
// Convex as a fact of the bubble (`stream.linkRunBubble`): the rows of the execution run
// land on it, and it is settled and recomposed by them like any other.
//
// Each case goes through the real doors: `startAssistant`, the stream writes, the link,
// `applyTranscript`, `finalize`.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { liveBubbleFor } from "./lib/projectedRuns";
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
/** The client run: the queued `chat.send`'s idempotency key, the name of the live stream. */
const C = `webchat-${"c".repeat(64)}`;
/** The execution run: the name the transcript rows carry. */
const X = "11111111-2222-4333-8444-555555555555";
const ANSWER = "HOLD_USER_OK";

type Ids = { userId: Id<"users">; chatId: Id<"chats"> };

async function seed(t: T): Promise<Ids> {
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
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    const userMessageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "question",
      sendId: C,
      updatedAt: 1,
    });
    await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "a",
      messageId: userMessageId,
      text: "question",
      attachmentIds: [],
      status: "sent",
      sendId: C,
    });
    return { userId, chatId };
  });
  // The first read sets the floor at 0: every row after it is projected.
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

function apply(t: T, chatId: Id<"chats">, rows: unknown[], extra: Record<string, unknown> = {}) {
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

/** The durable read that follows the run's end: the input's row, the answer's row under
 *  the EXECUTION run, the session idle. */
const settlingRead = (t: T, chatId: Id<"chats">) =>
  apply(
    t,
    chatId,
    [
      { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
      { entryId: "a3", seq: 3, role: "assistant", runId: X, hidden: false, visible: true, text: ANSWER },
    ],
    { terminals: [{ runId: X, status: "completed", at: Date.now() }], hasActiveRun: false, activeRunIds: [] },
  );

/** The live stream speaks first, under the client run: the bubble the bridge opens. */
async function liveBubble(t: T, chatId: Id<"chats">): Promise<Id<"messages">> {
  const id = (await t.mutation(internal.stream.startAssistant, {
    chatId,
    runId: C,
    turnSessionKey: SK,
    boundInstanceName: "prod",
    projectedTurn: true,
  })) as Id<"messages">;
  await t.mutation(internal.stream.appendDelta, {
    messageId: id,
    text: ANSWER,
    expectedRunId: C,
    boundInstanceName: "prod",
  } as never);
  return id;
}

const link = (t: T, messageId: Id<"messages">) =>
  t.mutation(internal.stream.linkRunBubble, {
    messageId,
    clientRunId: C,
    runId: X,
    boundInstanceName: "prod",
  });

/** The live terminal, under the name the bridge writes with. */
const liveFinal = (t: T, messageId: Id<"messages">) =>
  t.mutation(internal.stream.finalize, {
    messageId,
    status: "complete",
    text: ANSWER,
    expectedRunId: C,
    boundInstanceName: "prod",
  } as never);

const answers = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter(
      (m) => m.role === "assistant",
    ),
  );

const rowsOf = (t: T, chatId: Id<"chats">) =>
  t.run((ctx) => ctx.db.query("transcriptRows").withIndex("by_chat_session_entry", (q) => q.eq("chatId", chatId)).collect());

describe("the link stated after the bubble opened under the client run", () => {
  test("the rows of the execution run settle THAT bubble: one answer, recomposed from its row", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    expect(await link(t, bubble)).toEqual({ linked: true });
    // Still the bridge's bubble: its name, its generation — the stream keeps writing.
    const linked = await t.run((ctx) => ctx.db.get(bubble));
    expect(linked).toMatchObject({ runId: C, transcriptRunId: X, status: "streaming" });
    // The transcript proves the execution run over while the bubble still streams.
    await settlingRead(t, chatId);
    const all = await answers(t, chatId);
    expect(all.map((m) => m._id)).toEqual([bubble]);
    expect(all[0]).toMatchObject({ status: "complete", text: ANSWER, finalizeCause: "transcript_settled" });
    expect(all[0]!.rowLayout).toHaveLength(1);
    expect((await rowsOf(t, chatId)).find((r) => r.entryId === "a3")?.messageId).toBe(bubble);
    // The live terminal arrives after: the same bubble, nothing new.
    await liveFinal(t, bubble);
    expect((await answers(t, chatId)).map((m) => [m._id, m.status, m.text])).toEqual([[bubble, "complete", ANSWER]]);
  });

  test("the live terminal first, the rows after: still that one bubble, then recomposed", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await link(t, bubble);
    await liveFinal(t, bubble);
    await settlingRead(t, chatId);
    const all = await answers(t, chatId);
    expect(all.map((m) => m._id)).toEqual([bubble]);
    expect(all[0]).toMatchObject({ status: "complete", text: ANSWER });
    expect(all[0]!.rowLayout).toHaveLength(1);
  });

  test("stated once the bubble is closed (the `end` statement): the rows still land on it", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await liveFinal(t, bubble);
    expect(await link(t, bubble)).toEqual({ linked: true });
    await settlingRead(t, chatId);
    const all = await answers(t, chatId);
    expect(all.map((m) => m._id)).toEqual([bubble]);
    expect(all[0]!.rowLayout).toHaveLength(1);
  });

  test("stated twice, or by a bridge that restarted: the same fact, once", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    expect(await link(t, bubble)).toEqual({ linked: true });
    expect(await link(t, bubble)).toEqual({ linked: true });
    const records = await t.run((ctx) =>
      ctx.db.query("runBubbles").withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", X)).collect(),
    );
    expect(records.map((r) => r.messageId)).toEqual([bubble]);
    await settlingRead(t, chatId);
    expect((await answers(t, chatId)).map((m) => m._id)).toEqual([bubble]);
  });

  test("a late live frame of the client run opens nothing once the transcript settled its bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await link(t, bubble);
    await settlingRead(t, chatId);
    // A stashed or replayed frame, or a bridge that restarted without resuming.
    const again = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: C,
      turnSessionKey: SK,
      boundInstanceName: "prod",
      projectedTurn: true,
    });
    expect(again).toBe(bubble);
    expect((await answers(t, chatId)).map((m) => m._id)).toEqual([bubble]);
  });
});

// A message STEERED into the linked run cuts its bubble (stream.splitSegment): the run
// then shows in one bubble per segment, all opened under the client run, and the rows of
// EACH segment carry the execution run.
describe("a linked run cut by a steer: every segment is the execution run's", () => {
  const C2 = `webchat-${"d".repeat(64)}`;

  async function steeredInput(t: T, ids: Ids): Promise<Id<"messages">> {
    return await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "et aussi ?",
        sendId: C2,
        updatedAt: 2,
      }),
    );
  }
  const cut = async (t: T, bubble: Id<"messages">, after: Id<"messages">) => {
    const next = (await t.mutation(internal.stream.splitSegment, {
      messageId: bubble,
      afterMessageId: after,
      text: "avant",
      boundInstanceName: "prod",
    })) as Id<"messages">;
    await t.mutation(internal.stream.appendDelta, { messageId: next, text: "après", expectedRunId: C, boundInstanceName: "prod" } as never);
    return next;
  };
  /** The durable read: both segments' rows under the EXECUTION run, the steer between them. */
  const steeredRead = (t: T, chatId: Id<"chats">) =>
    apply(
      t,
      chatId,
      [
        { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
        { entryId: "a3", seq: 3, role: "assistant", runId: X, hidden: false, visible: true, text: "avant" },
        { entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" },
        { entryId: "a5", seq: 5, role: "assistant", runId: X, hidden: false, visible: true, text: "après" },
      ],
      { terminals: [{ runId: X, status: "completed", at: Date.now() }], hasActiveRun: false, activeRunIds: [] },
    );
  const placed = async (t: T, chatId: Id<"chats">) =>
    Object.fromEntries((await rowsOf(t, chatId)).filter((r) => r.role === "assistant").map((r) => [r.entryId, r.messageId]));

  test("linked BEFORE the cut: the new segment is born naming the execution run, and each segment takes its rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const first = await liveBubble(t, ids.chatId);
    await link(t, first);
    const second = await cut(t, first, await steeredInput(t, ids));
    expect(await t.run((ctx) => ctx.db.get(second))).toMatchObject({ runId: C, runSegment: 1, transcriptRunId: X });
    await steeredRead(t, ids.chatId);
    const all = await answers(t, ids.chatId);
    expect(all.map((m) => m._id).sort()).toEqual([first, second].sort());
    expect(await placed(t, ids.chatId)).toEqual({ a3: first, a5: second });
    expect(all.find((m) => m._id === second)).toMatchObject({ status: "complete", text: "après" });
  });

  test("linked AFTER the cut (stated on the open segment): every bubble of the run is linked", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const first = await liveBubble(t, ids.chatId);
    const second = await cut(t, first, await steeredInput(t, ids));
    expect(await link(t, second)).toEqual({ linked: true });
    expect((await t.run((ctx) => ctx.db.get(first)))?.transcriptRunId).toBe(X);
    expect((await t.run((ctx) => ctx.db.get(second)))?.transcriptRunId).toBe(X);
    // Asked again, on either segment: the same fact.
    expect(await link(t, first)).toEqual({ linked: true });
    expect(await link(t, second)).toEqual({ linked: true });
    await steeredRead(t, ids.chatId);
    const all = await answers(t, ids.chatId);
    expect(all.map((m) => m._id).sort()).toEqual([first, second].sort());
    expect(await placed(t, ids.chatId)).toEqual({ a3: first, a5: second });
  });

  // A deleted segment is tombstoned under the name its ROWS carry too (codex 0.105.1 #1):
  // tombstoned under the client run only, the execution run's rows read after the deletion
  // found no tombstone and gave the deleted answer a new bubble.
  test.each([
    ["after the deletion's follow-up ran", true],
    ["before the deletion's follow-up ran", false],
  ])("a linked segment deleted before its rows arrive (%s): its rows never make it again", async (_when, followedUp) => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const first = await liveBubble(t, ids.chatId);
      await link(t, first);
      const second = await cut(t, first, await steeredInput(t, ids));
      await t.mutation(internal.stream.finalize, {
        messageId: second,
        status: "complete",
        text: "après",
        expectedRunId: C,
        boundInstanceName: "prod",
      } as never);
      expect(await t.run((ctx) => ctx.db.get(second))).toMatchObject({ runSegment: 1, transcriptRunId: X, status: "complete" });
      await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: second });
      if (followedUp) await t.finishAllScheduledFunctions(vi.runAllTimers);
      await steeredRead(t, ids.chatId);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      // Deleting the last answer re-sends its question; with no bridge configured here that
      // dispatch fails into an error card of its own, which names no run.
      const ofRun = (await answers(t, ids.chatId)).filter((m) => m.runId !== undefined);
      expect(ofRun.map((m) => m._id)).toEqual([first]);
      expect(ofRun.some((m) => m.text.includes("après"))).toBe(false);
      // The deleted segment's row is kept as an identity only: its text is gone.
      const a5 = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a5");
      expect(a5?.messageId).toBe(second);
      const texts = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
      expect(texts.some((d) => d.rowId === a5?._id)).toBe(false);
      // The segment before the deleted one keeps its row and what it said.
      const a3 = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a3");
      expect(a3?.messageId).toBe(first);
      expect(texts.find((d) => d.rowId === a3?._id)?.text).toBe("avant");
      expect(ofRun[0]).toMatchObject({ text: "avant" });
      // Under the execution run, the deleted span is frozen at the steer's cut once that cut
      // is known — by the follow-up, or by the read that brings the cut when the follow-up
      // ran first (codex 0.105.2 pass 3).
      const underX = await t.run((ctx) =>
        ctx.db.query("transcriptTombstones").withIndex("by_chat_run", (q) => q.eq("chatId", ids.chatId).eq("runId", X)).collect(),
      );
      expect(underX.map((d) => [d.messageId, d.segment, d.fromSeq])).toEqual([[second, 1, 4]]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The rows read in SEPARATE batches after the deletion (codex 0.105.1 pass 6): the kept
  // segment's row first, ALONE — the cut that starts the deleted segment not read yet —
  // then the cut, then the deleted segment's row. A tombstone under the execution run read
  // as the run's start purged that first row for good (a purged row never takes a text
  // again); until the cut is known, nothing of the run is taken for deleted by it.
  test.each([
    ["right after the deletion", 0],
    ["after the kept segment's row", 1],
    ["after the cut", 2],
    ["after every batch", 3],
  ])("a linked segment deleted, its run read a batch at a time (follow-up %s): the kept segment keeps its row", async (_when, followUpAt) => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const first = await liveBubble(t, ids.chatId);
      await link(t, first);
      const second = await cut(t, first, await steeredInput(t, ids));
      await t.mutation(internal.stream.finalize, {
        messageId: second,
        status: "complete",
        text: "après",
        expectedRunId: C,
        boundInstanceName: "prod",
      } as never);
      await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: second });
      const running = { hasActiveRun: true, activeRunIds: [X] };
      const batches: Array<() => Promise<unknown>> = [
        () =>
          apply(
            t,
            ids.chatId,
            [
              { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
              { entryId: "a3", seq: 3, role: "assistant", runId: X, hidden: false, visible: true, text: "avant" },
            ],
            running,
          ),
        () =>
          apply(
            t,
            ids.chatId,
            [{ entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" }],
            running,
          ),
        () =>
          apply(t, ids.chatId, [{ entryId: "a5", seq: 5, role: "assistant", runId: X, hidden: false, visible: true, text: "après" }], {
            terminals: [{ runId: X, status: "completed", at: Date.now() }],
            hasActiveRun: false,
            activeRunIds: [],
          }),
      ];
      for (const [i, batch] of batches.entries()) {
        if (i === followUpAt) await t.finishAllScheduledFunctions(vi.runAllTimers);
        await batch();
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const rows = await rowsOf(t, ids.chatId);
      const texts = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
      const a3 = rows.find((r) => r.entryId === "a3");
      expect(a3?.textSig).not.toBe("purged");
      expect(a3?.messageId).toBe(first);
      expect(texts.find((d) => d.rowId === a3?._id)?.text).toBe("avant");
      const a5 = rows.find((r) => r.entryId === "a5");
      expect(a5).toMatchObject({ textSig: "purged", messageId: second });
      expect(texts.some((d) => d.rowId === a5?._id)).toBe(false);
      const ofRun = (await answers(t, ids.chatId)).filter((m) => m.runId !== undefined);
      expect(ofRun.map((m) => m._id)).toEqual([first]);
      expect(ofRun[0]).toMatchObject({ text: "avant" });
      expect(ofRun[0]!.rowLayout?.map((r) => r.entryId)).toEqual(["a3"]);
      // The input's own row, under the client run, is no row of the deleted answer.
      expect(rows.find((r) => r.entryId === "u2")?.messageId).not.toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A linked run whose segment 1 is deleted before any of its rows is read. */
  async function deletedBeforeRows(t: T) {
    const ids = await seed(t);
    const first = await liveBubble(t, ids.chatId);
    await link(t, first);
    const second = await cut(t, first, await steeredInput(t, ids));
    await t.mutation(internal.stream.finalize, { messageId: second, status: "complete", text: "après", expectedRunId: C, boundInstanceName: "prod" } as never);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: second });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return { ...ids, first, second };
  }
  /** Both segments' rows, the cut between them NOT among them. */
  const rowsWithoutCut = [
    { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
    { entryId: "a3", seq: 3, role: "assistant", runId: X, hidden: false, visible: true, text: "avant" },
    { entryId: "a5", seq: 5, role: "assistant", runId: X, hidden: false, visible: true, text: "après" },
  ];
  const xOver = { terminals: [{ runId: X, status: "completed", at: Date.now() }], hasActiveRun: false, activeRunIds: [] };
  /** What a reader is shown of the run's answers: `listByChat`, and the stored text. */
  async function shown(t: T, ids: Ids) {
    const view = (await t
      .withIdentity({ subject: `${ids.userId}|session` })
      .query(api.messages.listByChat, { chatId: ids.chatId as string })) as Array<{ role: string; runId?: string; text: string }>;
    const stored = (await answers(t, ids.chatId)).filter((m) => m.runId !== undefined).map((m) => m.text);
    return { view: view.filter((m) => m.role === "assistant" && m.runId !== undefined).map((m) => m.text), stored };
  }

  // The other side of waiting: a row of the deleted segment read BEFORE its cut (a gap, a
  // live row ahead of the read) is not yet known deleted. Its segment cannot be told, so
  // no row of the segment it may share with a kept one is placed — on a running run or a
  // TERMINAL one (codex 0.105.1 pass 7: the terminal read recomposed the first bubble as
  // "avant\n\naprès") — until the cut is read: then the deleted row's text goes, and the
  // kept one is placed.
  test.each([
    ["the run still running", { hasActiveRun: true, activeRunIds: [X] }],
    ["the run's terminal read", xOver],
  ])("a deleted segment's row read before its cut (%s): never shown, purged once the cut is read", async (_when, state) => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await deletedBeforeRows(t);
      const { first } = ids;
      await apply(t, ids.chatId, rowsWithoutCut, state);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const before = await shown(t, ids);
      expect(before.view.join("|")).not.toContain("après");
      expect(before.stored.join("|")).not.toContain("après");
      await apply(
        t,
        ids.chatId,
        [{ entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" }],
        xOver,
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await shown(t, ids)).toEqual({ view: ["avant"], stored: ["avant"] });
      const rows = await rowsOf(t, ids.chatId);
      const texts = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
      const a5 = rows.find((r) => r.entryId === "a5");
      expect(a5?.textSig).toBe("purged");
      expect(texts.some((d) => d.rowId === a5?._id)).toBe(false);
      const a3 = rows.find((r) => r.entryId === "a3");
      expect(texts.find((d) => d.rowId === a3?._id)?.text).toBe("avant");
      const ofRun = (await answers(t, ids.chatId)).filter((m) => m.runId !== undefined);
      expect(ofRun.map((m) => m._id)).toEqual([first]);
      expect(ofRun[0]).toMatchObject({ text: "avant" });
      expect(ofRun[0]!.rowLayout?.map((r) => r.entryId)).toEqual(["a3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // OpenClaw 2026.10.33 does not guarantee the cut: the steered row is stamped with its
  // target only once its transcript commit is confirmed (src/auto-reply/reply/reply-run-
  // registry.message-injection.ts:584-592), and a failed stamp is swallowed
  // (src/sessions/user-turn-transcript.ts:555-580). Without it, what the person deleted
  // never comes back: the rows the deleted segment may share with a kept one stay
  // unplaced — the kept bubble keeps the text it was finalized with, not recomposed.
  test("the cut never arrives: the deleted text is never shown, the kept bubble keeps its own text", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await deletedBeforeRows(t);
      await apply(t, ids.chatId, rowsWithoutCut, xOver);
      await apply(t, ids.chatId, [], { hasActiveRun: false, activeRunIds: [] });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await shown(t, ids)).toEqual({ view: ["avant"], stored: ["avant"] });
      const rows = await rowsOf(t, ids.chatId);
      // Unplaced, not purged: a cut read later still places the kept one.
      for (const entryId of ["a3", "a5"]) {
        const row = rows.find((r) => r.entryId === entryId);
        expect(row?.messageId).toBeUndefined();
        expect(row?.textSig).not.toBe("purged");
      }
      expect((await t.run((ctx) => ctx.db.get(ids.first)))?.rowLayout).toBeUndefined();
      // …and a cut read later places it: the deleted row's text goes, the kept one is shown.
      await apply(
        t,
        ids.chatId,
        [{ entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" }],
        { hasActiveRun: false, activeRunIds: [] },
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await shown(t, ids)).toEqual({ view: ["avant"], stored: ["avant"] });
      const after = await rowsOf(t, ids.chatId);
      expect(after.find((r) => r.entryId === "a3")?.messageId).toBe(ids.first);
      expect(after.find((r) => r.entryId === "a5")).toMatchObject({ textSig: "purged", messageId: ids.second });
      expect((await t.run((ctx) => ctx.db.get(ids.first)))?.rowLayout?.map((r) => r.entryId)).toEqual(["a3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The reasoning of a row a deleted segment awaiting its cut may share (codex 0.105.2 pass
  // 4): unplaced, it is no bubble's yet — the kept bubble does not read it until the cut
  // tells whose it is; then the kept row's reasoning reads, the deleted one's never.
  test("a row a deleted segment awaiting its cut may share: no bubble reads its reasoning before the cut", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await deletedBeforeRows(t);
      await t.run((ctx) => ctx.db.patch(ids.chatId, { sessionSettings: { showReasoning: true } }));
      await apply(
        t,
        ids.chatId,
        [
          rowsWithoutCut[0]!,
          { ...rowsWithoutCut[1]!, thinking: "pensée gardée" },
          { ...rowsWithoutCut[2]!, thinking: "pensée supprimée" },
        ],
        { hasActiveRun: true, activeRunIds: [X] },
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const read = (entryId: string) =>
        t.withIdentity({ subject: ids.userId }).query(api.messages.getRowReasoning, { messageId: ids.first, entryId });
      expect((await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a5")?.messageId).toBeUndefined();
      expect(await read("a5")).toBeNull();
      expect(await read("a3")).toBeNull();
      await apply(
        t,
        ids.chatId,
        [{ entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" }],
        xOver,
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await read("a3")).toEqual({ text: "pensée gardée" });
      expect(await read("a5")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A steer sent from ELSEWHERE (another client of the session) counts among the run's cuts
  // and not among Atrium's splits (codex 0.105.2 pass 7): the deleted segment starts at the
  // cut of the send that opened it, never at the run's first cut — the kept row between the
  // two stays. (Deleted AFTER the rows were placed, the placement itself counts the cuts —
  // the same in 0.105.1, docs/UPSTREAM_INTERPRETATION.md.)
  test.each([["deleted before its rows are read", true]])("an external steer before the local one (%s): the kept row between them keeps its text", async (_when, deleteFirst) => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const first = await liveBubble(t, ids.chatId);
      await link(t, first);
      const second = await cut(t, first, await steeredInput(t, ids));
      expect((await t.run((ctx) => ctx.db.get(second)))?.segmentSendId).toBe(C2);
      await t.mutation(internal.stream.finalize, { messageId: second, status: "complete", text: "après", expectedRunId: C, boundInstanceName: "prod" } as never);
      const EXTERNAL = `webchat-${"f".repeat(64)}`;
      const read = () =>
        apply(
          t,
          ids.chatId,
          [
            { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
            { entryId: "a3", seq: 3, role: "assistant", runId: X, hidden: false, visible: true, text: "avant" },
            { entryId: "e4", seq: 4, role: "user", runId: EXTERNAL, sendId: EXTERNAL, steerTargetRunId: X, hidden: false, visible: true, text: "d'ailleurs" },
            { entryId: "a5", seq: 5, role: "assistant", runId: X, hidden: false, visible: true, text: "gardé" },
            { entryId: "s6", seq: 6, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" },
            { entryId: "a7", seq: 7, role: "assistant", runId: X, hidden: false, visible: true, text: "après" },
          ],
          xOver,
        );
      const remove = async () => {
        await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: second });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
      };
      if (deleteFirst) await remove();
      await read();
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      if (!deleteFirst) await remove();
      const underX = await t.run((ctx) =>
        ctx.db.query("transcriptTombstones").withIndex("by_chat_run", (q) => q.eq("chatId", ids.chatId).eq("runId", X)).collect(),
      );
      expect(underX.map((d) => [d.cutSendId, d.fromSeq])).toEqual([[C2, 6]]);
      const rows = await rowsOf(t, ids.chatId);
      const texts = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
      const a5 = rows.find((r) => r.entryId === "a5");
      expect(a5?.textSig).not.toBe("purged");
      expect(texts.find((d) => d.rowId === a5?._id)?.text).toBe("gardé");
      expect(rows.find((r) => r.entryId === "a7")?.textSig).toBe("purged");
    } finally {
      vi.useRealTimers();
    }
  });

  // The follow-up ran before any cut (codex 0.105.2 pass 3): the span is frozen at its cut
  // by the read that brings it. Read again against the cuts of each later read instead, a
  // cut stored late BEFORE it moved the span back over a row already shown as kept, and
  // purged that row for good.
  test("a cut stored late before the awaited one moves nothing: the kept row keeps its text", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await deletedBeforeRows(t);
      const steer = (entryId: string, seq: number, run: string) => ({
        entryId,
        seq,
        role: "user",
        runId: run,
        sendId: run,
        steerTargetRunId: X,
        hidden: false,
        visible: true,
        text: "et aussi ?",
      });
      await apply(
        t,
        ids.chatId,
        [
          rowsWithoutCut[0]!,
          rowsWithoutCut[1]!,
          { entryId: "a5", seq: 5, role: "assistant", runId: X, hidden: false, visible: true, text: "gardé" },
          steer("s6", 6, C2),
          { entryId: "a7", seq: 7, role: "assistant", runId: X, hidden: false, visible: true, text: "après" },
        ],
        xOver,
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const tombOfX = async () =>
        (
          await t.run((ctx) =>
            ctx.db.query("transcriptTombstones").withIndex("by_chat_run", (q) => q.eq("chatId", ids.chatId).eq("runId", X)).collect(),
          )
        ).map((d) => d.fromSeq);
      expect(await tombOfX()).toEqual([6]);
      const LATE = `webchat-${"e".repeat(64)}`;
      await apply(t, ids.chatId, [steer("s4", 4, LATE)], { hasActiveRun: false, activeRunIds: [] });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await tombOfX()).toEqual([6]);
      const rows = await rowsOf(t, ids.chatId);
      const texts = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
      const a5 = rows.find((r) => r.entryId === "a5");
      expect(a5?.textSig).not.toBe("purged");
      expect(texts.find((d) => d.rowId === a5?._id)?.text).toBe("gardé");
      expect(rows.find((r) => r.entryId === "a7")?.textSig).toBe("purged");
      expect((await shown(t, ids)).view.join("|")).not.toContain("après");
    } finally {
      vi.useRealTimers();
    }
  });

  // The cut received by a TEXT post (transcript-shadow.ts `postTexts`, the first half of a
  // live post): it is stored there, so the post that follows finds no new cut — the run it
  // releases is projected by the text post itself (codex 0.105.1 pass 8).
  test("the cut received by a text post, then its live post: the held run is placed", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await deletedBeforeRows(t);
      await apply(t, ids.chatId, rowsWithoutCut, xOver);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const s4 = { entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" };
      await apply(t, ids.chatId, [s4], { kind: "live", textsOnly: true });
      await apply(t, ids.chatId, [s4], { kind: "live" });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await shown(t, ids)).toEqual({ view: ["avant"], stored: ["avant"] });
      const rows = await rowsOf(t, ids.chatId);
      expect(rows.find((r) => r.entryId === "a3")?.messageId).toBe(ids.first);
      expect(rows.find((r) => r.entryId === "a5")).toMatchObject({ textSig: "purged", messageId: ids.second });
      expect((await t.run((ctx) => ctx.db.get(ids.first)))?.rowLayout?.map((r) => r.entryId)).toEqual(["a3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cut BEFORE it showed anything (the bridge's deferred opening counts the cut,
  // turn-sink `pendingSegment`): the run's only bubble is born at segment 1, and no first
  // segment exists to carry the run's record.
  test("the only bubble is a LATER segment: linked, it takes that segment's rows and stands for no other segment", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await steeredInput(t, ids);
    const only = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: C,
      turnSessionKey: SK,
      boundInstanceName: "prod",
      projectedTurn: true,
      runSegment: 1,
    } as never)) as Id<"messages">;
    await t.mutation(internal.stream.appendDelta, { messageId: only, text: "après", expectedRunId: C, boundInstanceName: "prod" } as never);
    expect(await link(t, only)).toEqual({ linked: true });
    expect(await link(t, only)).toEqual({ linked: true });
    // The run's record names that bubble; it stands for segment 1, never for the first.
    expect(await t.run((ctx) => liveBubbleFor(ctx as never, ids.chatId, X, 1))).toBe(only);
    expect(await t.run((ctx) => liveBubbleFor(ctx as never, ids.chatId, X, 0))).toBeNull();
    await apply(
      t,
      ids.chatId,
      [
        { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
        { entryId: "s4", seq: 4, role: "user", runId: C2, sendId: C2, steerTargetRunId: X, hidden: false, visible: true, text: "et aussi ?" },
        { entryId: "a5", seq: 5, role: "assistant", runId: X, hidden: false, visible: true, text: "après" },
      ],
      { terminals: [{ runId: X, status: "completed", at: Date.now() }], hasActiveRun: false, activeRunIds: [] },
    );
    const all = await answers(t, ids.chatId);
    expect(all.map((m) => m._id)).toEqual([only]);
    expect(await placed(t, ids.chatId)).toEqual({ a5: only });
  });
});

// A run cut into more segments than one call reads (codex pass 3): the link is confirmed
// only once every segment is named, a page at a time — the bridge asks again with the
// answer's cursor (convex-writer `linkRunBubble`).
describe("a linked run cut into more segments than one page", () => {
  const SEGMENTS = 34;

  /** The bubbles the live stream opened under the client run: segment 0 … SEGMENTS-1, the
   *  last one still streaming (the statement arrives on it). */
  async function cutRun(t: T, chatId: Id<"chats">): Promise<Id<"messages">[]> {
    const first = await liveBubble(t, chatId);
    const doc = (await t.run((ctx) => ctx.db.get(first)))!;
    const { _id, _creationTime, ...base } = doc;
    void _id;
    void _creationTime;
    const ids = [first];
    for (let k = 1; k < SEGMENTS; k++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("messages", {
            ...base,
            runSegment: k,
            status: k === SEGMENTS - 1 ? ("streaming" as const) : ("complete" as const),
          }),
        ),
      );
    }
    await t.run((ctx) => ctx.db.patch(first, { status: "complete" as const }));
    return ids;
  }

  /** What the bridge does: ask again with the cursor until Convex answers without one. */
  async function linkAll(t: T, messageId: Id<"messages">) {
    const answers: Array<{ linked: boolean; continueCursor?: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await t.mutation(internal.stream.linkRunBubble, {
        messageId,
        clientRunId: C,
        runId: X,
        boundInstanceName: "prod",
        ...(cursor !== undefined ? { cursor } : {}),
      } as never);
      answers.push(res);
      if (!res.linked || res.continueCursor === undefined) break;
      cursor = res.continueCursor;
    }
    return answers;
  }

  test("stated on the last segment: the first answer does not claim the run, and every segment ends up named", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const bubbles = await cutRun(t, ids.chatId);
    const answers = await linkAll(t, bubbles.at(-1)!);
    expect(answers[0]).toMatchObject({ linked: true, continueCursor: expect.any(String) });
    expect(answers.at(-1)).toEqual({ linked: true });
    const named = await t.run(async (ctx) => Promise.all(bubbles.map(async (b) => (await ctx.db.get(b))?.transcriptRunId)));
    expect(named).toEqual(bubbles.map(() => X));
    // Each segment is found under the execution run: its rows land on it, none makes another.
    for (const k of [0, 31, 32, 33]) {
      expect(await t.run((ctx) => liveBubbleFor(ctx as never, ids.chatId, X, k))).toBe(bubbles[k]);
    }
    // Asked again (a retried write): the same fact, nothing doubled.
    expect((await linkAll(t, bubbles[0]!)).at(-1)).toEqual({ linked: true });
    expect(await t.run((ctx) => ctx.db.query("runBubbles").collect())).toHaveLength(1);
  });
});

// More held runs released by ONE read than one apply handles (codex 0.105.1 pass 8): the
// cuts past the apply's bound go to its continuation, which must project those runs again
// too — no later read necessarily names them (each is over, and its rows already read).
describe("cuts released for more runs than one apply reaches", () => {
  const RUNS = 21;
  const run = (i: number) => `exec-held-${i}`;
  const base = (i: number) => 10 + i * 10;

  /** Every run's first segment kept, its later one deleted awaiting its cut, all read to
   *  their end held, then every cut in ONE read; `between` runs after that read and before
   *  any of its continuations. */
  async function releaseHeldRuns(
    between?: (t: T, ids: Ids, gone: Array<Id<"messages">>) => Promise<void>,
    after?: (t: T, ids: Ids) => Promise<void>,
  ): Promise<void> {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const gone: Array<Id<"messages">> = [];
      // Each run's first segment shows in the bubble the live stream wrote, closed.
      const kept: Id<"messages">[] = [];
      for (let i = 0; i < RUNS; i++) {
        const m = (await t.mutation(internal.stream.startAssistant, {
          chatId: ids.chatId,
          runId: run(i),
          turnSessionKey: SK,
          boundInstanceName: "prod",
          projectedTurn: true,
        })) as Id<"messages">;
        await t.mutation(internal.stream.finalize, { messageId: m, status: "complete", text: `live ${i}`, expectedRunId: run(i), boundInstanceName: "prod" } as never);
        kept.push(m);
      }
      // …and its later segment was deleted before any of its rows was read, its tombstone
      // awaiting the cut (what `deletionTombstones` writes for a late-linked answer).
      await t.run(async (ctx) => {
        for (let i = 0; i < RUNS; i++) {
          const m = await ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "assistant" as const, status: "complete" as const, text: "", updatedAt: 1 });
          await ctx.db.delete(m);
          gone.push(m);
          await ctx.db.insert("transcriptTombstones", {
            chatId: ids.chatId,
            sessionKey: SK,
            runId: run(i),
            segment: 1,
            awaitsCut: true as const,
            cutSendId: `send-${i}`,
            messageId: m,
            createdAt: 1,
          });
        }
      });
      // Every run read to its end without its cut — two reads (one takes 40 texts at most):
      // held, nothing placed.
      for (const runs of [[0, 11], [11, RUNS]]) {
        const range = Array.from({ length: runs[1]! - runs[0]! }, (_, j) => runs[0]! + j);
        const res = await apply(
          t,
          ids.chatId,
          range.flatMap((i) => [
            { entryId: `k${i}`, seq: base(i) + 1, role: "assistant", runId: run(i), hidden: false, visible: true, text: `kept ${i}` },
            { entryId: `d${i}`, seq: base(i) + 3, role: "assistant", runId: run(i), hidden: false, visible: true, text: `deleted ${i}` },
          ]),
          { terminals: range.map((i) => ({ runId: run(i), status: "completed", at: Date.now() })), hasActiveRun: false, activeRunIds: [] },
        );
        expect(res).toMatchObject({ ok: true });
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await rowsOf(t, ids.chatId)).toHaveLength(2 * RUNS);
      const held = await t.run((ctx) => Promise.all(kept.map((m) => ctx.db.get(m))));
      expect(held.map((m) => [m?.text, m?.rowLayout])).toEqual(kept.map((_, i) => [`live ${i}`, undefined]));
      // Then their cuts, all in ONE read of user rows only.
      const cutsRead = await apply(
        t,
        ids.chatId,
        Array.from({ length: RUNS }, (_, i) => ({
          entryId: `s${i}`,
          seq: base(i) + 2,
          role: "user",
          runId: `send-${i}`,
          sendId: `send-${i}`,
          steerTargetRunId: run(i),
          hidden: false,
          visible: true,
          text: `steer ${i}`,
        })),
        { hasActiveRun: false, activeRunIds: [] },
      );
      expect(cutsRead).toMatchObject({ ok: true });
      if (between !== undefined) await between(t, ids, gone);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await apply(t, ids.chatId, [], { hasActiveRun: false, activeRunIds: [] });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      if (after !== undefined) {
        await after(t, ids);
        return;
      }
      const all = (await answers(t, ids.chatId)).filter((m) => m.runId !== undefined);
      expect(all.map((m) => m._id).sort()).toEqual([...kept].sort());
      const rows = await rowsOf(t, ids.chatId);
      for (let i = 0; i < RUNS; i++) {
        const bubble = all.find((m) => m._id === kept[i]);
        expect(bubble, `run ${i}`).toMatchObject({ text: `kept ${i}` });
        expect(bubble!.rowLayout?.map((r) => r.entryId), `run ${i}`).toEqual([`k${i}`]);
        expect(rows.find((r) => r.entryId === `k${i}`)?.messageId, `run ${i}`).toBe(bubble!._id);
        expect(rows.find((r) => r.entryId === `d${i}`)?.textSig, `run ${i}`).toBe("purged");
      }
    } finally {
      vi.useRealTimers();
    }
  }

  test("every run awaiting its cut is projected once the cut is read, the 21st too", () => releaseHeldRuns());

  // The deletion's follow-up lands between the read and the continuation that takes the
  // 21st run (codex 0.105.1 pass 9): it freezes that run's tombstone at the cut just read,
  // so the continuation finds a resolved span, no longer one awaiting — the rows held
  // back still owe their projection.
  test("the 21st run's tombstone resolved by the follow-up before its continuation: still projected", () =>
    releaseHeldRuns(async (t, ids, gone) => {
      const last = RUNS - 1;
      await t.mutation(internal.transcriptProjection.followUpDeletion, {
        chatId: ids.chatId,
        deleted: [{ id: gone[last]!, sessionKey: SK, runId: run(last), segment: 1 }],
        index: 0,
        after: null,
      });
      const tomb = await t.run((ctx) =>
        ctx.db
          .query("transcriptTombstones")
          .withIndex("by_chat_run", (q) => q.eq("chatId", ids.chatId).eq("runId", run(last)))
          .first(),
      );
      expect(tomb).toMatchObject({ awaitsCut: true, fromSeq: base(last) + 2 });
    }));

  // Past the purge bound, the 21st run is frozen by the read itself (codex 0.105.2 pass 4):
  // left to the continuation, a later read that brings a cut stored late before it moved the
  // span back over the kept row, and purged it.
  test("the 21st run is frozen at its cut by the read, before a later read brings an earlier cut", () => {
    const last = RUNS - 1;
    return releaseHeldRuns(
      async (t, ids) => {
        await apply(
          t,
          ids.chatId,
          [{ entryId: "late", seq: base(last), role: "user", runId: "send-late", sendId: "send-late", steerTargetRunId: run(last), hidden: false, visible: true, text: "plus tôt" }],
          { hasActiveRun: false, activeRunIds: [] },
        );
      },
      async (t, ids) => {
        const tomb = await t.run((ctx) =>
          ctx.db
            .query("transcriptTombstones")
            .withIndex("by_chat_run", (q) => q.eq("chatId", ids.chatId).eq("runId", run(last)))
            .first(),
        );
        expect(tomb).toMatchObject({ awaitsCut: true, fromSeq: base(last) + 2 });
        const rows = await rowsOf(t, ids.chatId);
        expect(rows.find((r) => r.entryId === `k${last}`)?.textSig).not.toBe("purged");
        expect(rows.find((r) => r.entryId === `d${last}`)?.textSig).toBe("purged");
      },
    );
  });
});

// The freezes a read's cuts owe are bounded by what they read (codex 0.105.2 pass 6): many
// runs each holding many cuts and a tombstone awaiting a far cut made the apply read past
// Convex's 16 MiB, and every replay of that read failed the same way. Under the real
// transaction limits, the read applies, and every run is frozen by the steps it hands on.
describe("freezing the awaited cuts stays within one transaction's reads", () => {
  test("20 runs of 999 cuts each, all reached by one read: applied, then every run frozen", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules, transactionLimits: true });
      const ids = await seed(t);
      const RUNS = 20;
      const CUTS = 999;
      const run = (i: number) => `exec-many-cuts-${i}`;
      const pad = "p".repeat(600);
      for (let i = 0; i < RUNS; i++) {
        await t.run(async (ctx) => {
          const gone = await ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "assistant" as const, status: "complete" as const, text: "", updatedAt: 1 });
          await ctx.db.delete(gone);
          await ctx.db.insert("transcriptTombstones", { chatId: ids.chatId, sessionKey: SK, runId: run(i), segment: CUTS + 1, awaitsCut: true as const, cutSendId: `send-last-${i}`, messageId: gone, createdAt: 1 });
          for (let j = 0; j < CUTS; j++) {
            await ctx.db.insert("transcriptRows", {
              chatId: ids.chatId,
              instanceName: "prod",
              sessionKey: SK,
              sessionId: "s-1",
              entryId: `cut-${i}-${j}-${pad}`,
              seq: 10 + j,
              role: "user",
              runId: `send-${i}-${j}`,
              sendId: `send-${i}-${j}`,
              steerTargetRunId: run(i),
              hidden: false,
              visible: true,
              updatedAt: 1,
            });
          }
        });
      }
      const res = await apply(
        t,
        ids.chatId,
        Array.from({ length: RUNS }, (_, i) => ({
          entryId: `last-${i}`,
          seq: 5000,
          role: "user",
          runId: `send-last-${i}`,
          sendId: `send-last-${i}`,
          steerTargetRunId: run(i),
          hidden: false,
          visible: true,
          text: "encore",
        })),
        { hasActiveRun: false, activeRunIds: [] },
      );
      expect(res).toMatchObject({ ok: true });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const tombs = await t.run((ctx) => ctx.db.query("transcriptTombstones").collect());
      expect(tombs.map((d) => d.fromSeq)).toEqual(Array.from({ length: RUNS }, () => 5000));
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});

// The reasoning of a row the open bubble already shows (codex 0.105.1 pass 9): the active
// layout reads the rows under the execution run (`activeRowLayout`), so the row's reasoning
// is read under that name too — not only once the row is placed.
describe("the reasoning of a linked run's row while the bubble streams", () => {
  test("read under the execution run, its row still unassigned; another bubble's is not", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.patch(ids.chatId, { sessionSettings: { showReasoning: true } }));
    const bubble = await liveBubble(t, ids.chatId);
    await link(t, bubble);
    const thought = "Lire la question, puis répondre.";
    await apply(
      t,
      ids.chatId,
      [
        { entryId: "u2", seq: 2, role: "user", runId: C, sendId: C, hidden: false, visible: true, text: "question" },
        { entryId: "a3", seq: 3, role: "assistant", runId: X, hidden: false, visible: true, thinking: thought, blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "call" }] },
      ],
      { hasActiveRun: true, activeRunIds: [X] },
    );
    // Still streaming, the row not placed: the view marks its reasoning from the active rows…
    expect((await t.run((ctx) => ctx.db.get(bubble)))?.status).toBe("streaming");
    expect((await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a3")?.messageId).toBeUndefined();
    const view = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
      _id: Id<"messages">;
      rowLayout?: Array<{ entryId: string; thinking?: boolean }>;
    }>;
    expect(view.find((m) => m._id === bubble)?.rowLayout?.find((r) => r.entryId === "a3")?.thinking).toBe(true);
    // …and opening the block reads it.
    const read = (messageId: Id<"messages">) =>
      t.withIdentity({ subject: ids.userId }).query(api.messages.getRowReasoning, { messageId, entryId: "a3" });
    expect(await read(bubble)).toEqual({ text: thought });
    // A bubble of another run of the same conversation does not read that row.
    const other = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "other-run",
      turnSessionKey: SK,
      boundInstanceName: "prod",
      projectedTurn: true,
    })) as Id<"messages">;
    expect(await read(other)).toBeNull();
  });
});

describe("what the link is NOT taken for", () => {
  test("another instance's bridge cannot state it", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await expect(
      t.mutation(internal.stream.linkRunBubble, { messageId: bubble, clientRunId: C, runId: X, boundInstanceName: "other" }),
    ).rejects.toThrow(/forbidden/);
    expect((await t.run((ctx) => ctx.db.get(bubble)))?.transcriptRunId).toBeUndefined();
  });

  test("a bubble that is not the client run's, a name that is its own, an oversized name: refused, nothing written", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    const state = (clientRunId: string, runId: string) =>
      t.mutation(internal.stream.linkRunBubble, { messageId: bubble, clientRunId, runId, boundInstanceName: "prod" });
    expect(await state("webchat-someone-else", X)).toEqual({ linked: false });
    expect(await state(C, C)).toEqual({ linked: false });
    expect(await state(C, "x".repeat(600))).toEqual({ linked: false });
    expect((await t.run((ctx) => ctx.db.get(bubble)))?.transcriptRunId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("runBubbles").collect())).toEqual([]);
  });

  test("a bubble already linked names ONE execution run", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await link(t, bubble);
    expect(
      await t.mutation(internal.stream.linkRunBubble, { messageId: bubble, clientRunId: C, runId: "another-execution", boundInstanceName: "prod" }),
    ).toEqual({ linked: false });
    expect((await t.run((ctx) => ctx.db.get(bubble)))?.transcriptRunId).toBe(X);
  });
});

describe("the limits, pinned as they are", () => {
  // The gateway's statement is best-effort (`dropIfSlow`, another socket): when it never
  // reaches the bridge, nothing on the wire Atrium reads joins the two names, and the rows
  // of the execution run give birth to a bubble of their own beside the live one.
  test("NO statement at all: the transcript's rows make a second bubble (known, not solved here)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await liveFinal(t, bubble);
    await settlingRead(t, chatId);
    const all = await answers(t, chatId);
    expect(all.map((m) => m.runId).sort()).toEqual([X, C].sort());
  });

  // The statement reaching Convex only after the rows gave birth to their bubble: two
  // bubbles exist and nothing here chooses between them (no text is ever compared).
  test("stated AFTER the rows made their own bubble: refused, both stay", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const bubble = await liveBubble(t, chatId);
    await liveFinal(t, bubble);
    await settlingRead(t, chatId);
    expect(await link(t, bubble)).toEqual({ linked: false });
    expect(await answers(t, chatId)).toHaveLength(2);
    expect((await t.run((ctx) => ctx.db.get(bubble)))?.transcriptRunId).toBeUndefined();
  });
});
