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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
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
