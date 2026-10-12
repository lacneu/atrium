/// <reference types="vite/client" />
//
// A BUBBLE THE SYSTEM REMOVES IS NOT A BUBBLE A PERSON DELETED (codex phase 5 pass 13,
// design §14.24). A person's deletion refuses its runs for good — tombstones, and the
// run → bubble records left pointing at the missing bubble (`deletedMergeOf`). An automatic
// removal must not borrow that verdict: an own delivery bubble dropped empty at its
// terminal leaves its run recoverable — from the transcript, and by its replay after a
// rollback — and the turn-replacing paths (auto-retry, preempt re-park) never take a
// delivery's own bubble for a user turn.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { maybeReparkPreemptedTurn } from "./preemptRepark";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

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

const SK = "agent:main:atrium:chat:u:c1";
const P = "sendA";
const CHILD = "agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e";
const CHILD_RUN = "742ca132-060c-4cf8-8c0a-3f1377095ea3";
const A = `announce:v1:${CHILD}:${CHILD_RUN}`;

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "délègue", sendId: P, updatedAt: 1 });
    return { userId, chatId };
  });
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
    rows,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}
const start = (t: T, chatId: Id<"chats">, runId: string) =>
  t.mutation(internal.stream.startAssistant, { chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" }) as Promise<Id<"messages"> | null>;
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const said = (entryId: string, seq: number, runId: string, text: string) => ({ entryId, seq, role: "assistant", runId, hidden: false, visible: true, text });
const assistantsOf = (t: T, chatId: Id<"chats">, runId: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.role === "assistant" && m.runId === runId),
  );
const setMode = (t: T, mode: "on" | "shadow") =>
  t.run(async (ctx) => {
    const inst = (await ctx.db.query("instances").collect())[0]!;
    await ctx.db.patch(inst._id, { config: { transcriptProjection: mode } as never });
  });

/** The turn P answered and settled, its launch read; then delivery A's own bubble: a
 *  visible delta, an authorized empty snapshot, an empty terminal — dropped. */
async function droppedOwnDelivery(t: T) {
  const { chatId, userId } = await seed(t);
  const mP = (await start(t, chatId, P))!;
  await t.mutation(internal.stream.finalize, { messageId: mP, status: "complete", text: "Je délègue." } as never);
  await apply(
    t,
    chatId,
    [
      { entryId: "u1", seq: 1, role: "user", runId: P, sendId: P, hidden: false, visible: true },
      said("a1", 2, P, "Je délègue."),
      { entryId: "n1", seq: 3, role: "custom", runId: P, hidden: false, visible: true, spawns: [{ childSessionKey: CHILD, childRunId: CHILD_RUN }] },
    ],
    { terminals: [{ runId: P, status: "completed", at: Date.now() }] },
  );
  await settle(t);
  const mA = (await start(t, chatId, A))!;
  expect((await t.run((ctx) => ctx.db.get(mA)))?.deliveryOwnBubble).toBe(true);
  await t.mutation(internal.stream.appendDelta, { messageId: mA, text: "x", expectedRunId: A } as never);
  await t.mutation(internal.stream.setSnapshot, { messageId: mA, text: "", replace: true, expectedRunId: A } as never);
  await t.mutation(internal.stream.finalize, { messageId: mA, status: "complete", text: "", dropIfEmpty: true } as never);
  expect(await t.run((ctx) => ctx.db.get(mA))).toBeNull();
  return { chatId, userId, mP, mA };
}

describe("an own delivery bubble dropped empty leaves its run recoverable", () => {
  test("its run → bubble records go with it", async () => {
    const t = convexTest({ schema, modules });
    const { mA } = await droppedOwnDelivery(t);
    const links = await t.run((ctx) => ctx.db.query("runBubbles").withIndex("by_message", (q) => q.eq("messageId", mA)).collect());
    expect(links).toEqual([]);
  });

  test("the transcript's answer for the run makes its bubble, and the run may start again", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await droppedOwnDelivery(t);
    await apply(t, chatId, [said("a2", 5, A, "Résultat.")], { terminals: [{ runId: A, status: "completed", at: Date.now() }] });
    await settle(t);
    const shown = await assistantsOf(t, chatId, A);
    expect(shown.map((m) => m.text)).toEqual(["Résultat."]);
    expect(await start(t, chatId, A)).toBe(shown[0]!._id);
  });

  test("after a rollback to shadow, its replay opens a bubble as in 0.96.0, never refused", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await droppedOwnDelivery(t);
    await setMode(t, "shadow");
    // No sub-agent row anchors the child (its launch was read from the transcript): 0.96.0's
    // path opens a bubble of its own for the delivery.
    const landed = await start(t, chatId, A);
    expect(landed).not.toBeNull();
    expect((await assistantsOf(t, chatId, A)).map((m) => [m._id, m.status])).toEqual([[landed, "streaming"]]);
  });
});

describe("the turn-replacing paths never take a delivery's own bubble for a user turn", () => {
  /** An own delivery bubble, the conversation's last message, right below a user message. */
  async function ownBelowUser(t: T, status: "streaming" | "error" | "aborted", opts: { childRow?: boolean } = {}) {
    const { chatId, userId } = await seed(t);
    return t.run(async (ctx) => {
      const u = await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "et ça ?", sendId: "sendB", updatedAt: 2 });
      await ctx.db.insert("outbox", { chatId, userId, clientMessageId: "b", messageId: u, text: "et ça ?", attachmentIds: [], status: "sent", sendId: "sendB" } as never);
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status,
        text: "",
        runId: A,
        turnSessionKey: SK,
        boundInstance: "prod",
        deliveryOwnBubble: true,
        deliveryKey: `run:${A}`,
        ...(status === "error" ? { errorCode: "session_init_conflict", error: "x" } : {}),
        updatedAt: 3,
      } as never);
      if (status === "streaming") {
        await ctx.db.insert("streamingText", { messageId: id, chatId, userId, generation: A, boundInstance: "prod", text: "", updatedAt: 3 });
      }
      await ctx.db.insert("runBubbles", { chatId, runId: A, messageId: id, createdAt: 3 });
      // The preempt re-park wants a recent child (its attribution). For the retry, no row:
      // the delegation guard would stand down on its own, and a child's row ages out.
      if (opts.childRow === true) {
        await ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", childSessionKey: CHILD, childRunId: CHILD_RUN, kind: "subagent" as const, status: "done" as const, createdAt: Date.now(), updatedAt: Date.now() });
      }
      return { chatId, id };
    });
  }

  test("auto-retry: a retryable failure of the own bubble schedules nothing", async () => {
    const t = convexTest({ schema, modules });
    const { id } = await ownBelowUser(t, "streaming");
    await t.mutation(internal.stream.finalize, { messageId: id, status: "error", error: "x", errorKind: "session_init_conflict" } as never);
    const m = (await t.run((ctx) => ctx.db.get(id))) as Doc<"messages">;
    expect(m.autoRetry).toBeUndefined();
  });

  test("auto-retry at fire time: the own bubble is kept", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, id } = await ownBelowUser(t, "error");
    await t.mutation(internal.turnRetry.autoRetryTurn, { chatId, messageId: id, attempt: 1 } as never);
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  });

  test("preempt re-park: the own bubble is kept", async () => {
    const t = convexTest({ schema, modules });
    const { id } = await ownBelowUser(t, "aborted", { childRow: true });
    await t.run(async (ctx) => maybeReparkPreemptedTurn(ctx, (await ctx.db.get(id))!, 0));
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  });
});

// ── codex phase 5 pass 14: the transcript rows of a dropped own bubble ──────────────────
describe("an own delivery bubble dropped by its rows' settle releases those rows", () => {
  const hidden = (entryId: string, seq: number, runId: string, text: string) => ({ entryId, seq, role: "assistant", runId, hidden: true, visible: false, text });
  const rowOf = (t: T, entryId: string) =>
    t.run((ctx) => ctx.db.query("transcriptRows").filter((q) => q.eq(q.field("entryId"), entryId)).first()) as Promise<Doc<"transcriptRows"> | null>;
  const textOf = (t: T, rowId: Id<"transcriptRows">) =>
    t.run((ctx) => ctx.db.query("transcriptRowTexts").withIndex("by_row", (q) => q.eq("rowId", rowId)).first());

  /** Codex's repro: delivery A opens its bubble, its snapshot empties, a HIDDEN row of A and
   *  its terminal are read — the settle drops the bubble that row was assigned to. */
  async function droppedByItsRows(t: T) {
    const { chatId, userId } = await seed(t);
    const mP = (await start(t, chatId, P))!;
    await t.mutation(internal.stream.finalize, { messageId: mP, status: "complete", text: "Je délègue." } as never);
    await apply(t, chatId, [{ entryId: "u1", seq: 1, role: "user", runId: P, sendId: P, hidden: false, visible: true }, said("a1", 2, P, "Je délègue.")], {
      terminals: [{ runId: P, status: "completed", at: Date.now() }],
    });
    await settle(t);
    const mA = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.appendDelta, { messageId: mA, text: "x", expectedRunId: A } as never);
    await t.mutation(internal.stream.setSnapshot, { messageId: mA, text: "", replace: true, expectedRunId: A } as never);
    await apply(t, chatId, [hidden("h1", 5, A, "réflexion")], { terminals: [{ runId: A, status: "completed", at: Date.now() }] });
    expect(await t.run((ctx) => ctx.db.get(mA))).toBeNull();
    return { chatId, userId, mA };
  }

  test("a row assigned before the drop is released, its text kept; the late answer is shown", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await droppedByItsRows(t);
    const h1 = (await rowOf(t, "h1"))!;
    expect(h1.messageId).toBeUndefined();
    await settle(t);
    expect(await textOf(t, h1._id)).not.toBeNull();
    await apply(t, chatId, [said("a2", 6, A, "Résultat tardif.")]);
    await settle(t);
    expect((await assistantsOf(t, chatId, A)).map((m) => m.text)).toEqual(["Résultat tardif."]);
  });

  test("a purge already scheduled for the dropped bubble erases nothing; after a rollback the replay lands", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, mA } = await droppedByItsRows(t);
    const h1 = (await rowOf(t, "h1"))!;
    // As an older deployment scheduled it at the drop.
    await t.mutation(internal.transcriptProjection.purgeDeletedBubbleTexts, { chatId, messageId: mA });
    await settle(t);
    expect(await textOf(t, h1._id)).not.toBeNull();
    expect((await rowOf(t, "h1"))?.messageId).toBeUndefined();
    await setMode(t, "shadow");
    const landed = await start(t, chatId, A);
    expect(landed).not.toBeNull();
    expect((await assistantsOf(t, chatId, A)).map((m) => m._id)).toEqual([landed]);
  });

  test("a person's deletion still purges, and the run's late rows never bring the answer back", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t);
    const mP = (await start(t, chatId, P))!;
    await t.mutation(internal.stream.finalize, { messageId: mP, status: "complete", text: "Je délègue." } as never);
    await apply(t, chatId, [{ entryId: "u1", seq: 1, role: "user", runId: P, sendId: P, hidden: false, visible: true }, said("a1", 2, P, "Je délègue.")], {
      terminals: [{ runId: P, status: "completed", at: Date.now() }],
    });
    await settle(t);
    const mA = (await start(t, chatId, A))!;
    await apply(t, chatId, [said("a2", 5, A, "Résultat.")], { terminals: [{ runId: A, status: "completed", at: Date.now() }] });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(mA)))?.text).toBe("Résultat.");
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId: mA });
    await settle(t);
    const a2 = (await rowOf(t, "a2"))!;
    expect(await textOf(t, a2._id)).toBeNull();
    await apply(t, chatId, [said("a3", 6, A, "Encore.")]);
    await settle(t);
    expect(await assistantsOf(t, chatId, A)).toEqual([]);
    expect(await textOf(t, (await rowOf(t, "a3"))!._id)).toBeNull();
    expect(await start(t, chatId, A)).toBeNull();
  });
});

describe("an own bubble holding more rows than one transaction releases", () => {
  test("is kept, settled and empty — never dropped half-released", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t);
    const mA = (await start(t, chatId, A))!;
    for (let batch = 0; batch < 3; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 100; i++) {
          const n = batch * 100 + i;
          await ctx.db.insert("transcriptRows", { chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1", entryId: `h${n}`, seq: 10 + n, role: "assistant", runId: A, hidden: true, visible: false, messageId: mA, updatedAt: 1 });
        }
      });
    }
    await t.mutation(internal.stream.finalize, { messageId: mA, status: "complete", text: "", dropIfEmpty: true } as never);
    expect((await t.run((ctx) => ctx.db.get(mA)))?.status).toBe("complete");
    const dangling = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").withIndex("by_message_seq", (q) => q.eq("messageId", mA)).collect()).length);
    expect(dangling).toBe(300);
  });
});

// ── codex phase 5 pass 17: a delivery bubble born again from its rows keeps its identity ──
describe("a delivery bubble born from transcript rows carries the delivery's identity (§14.28)", () => {
  const CR_W = "742ca132-060c-4cf8-8c0a-3f1377095ea9";
  const W = `announce:requester-settle:main:${SK}:${CR_W}:yield-1`;
  /** Settle W opens its own bubble, empties, is dropped at its terminal; the transcript then
   *  brings its answer late: the bubble is born again from the rows. */
  async function droppedThenReborn(t: T) {
    const { chatId, userId } = await seed(t);
    const mP = (await start(t, chatId, P))!;
    await t.mutation(internal.stream.finalize, { messageId: mP, status: "complete", text: "Je délègue." } as never);
    await apply(t, chatId, [{ entryId: "u1", seq: 1, role: "user", runId: P, sendId: P, hidden: false, visible: true }, said("a1", 2, P, "Je délègue.")], {
      terminals: [{ runId: P, status: "completed", at: Date.now() }],
    });
    await settle(t);
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mP, anchorExact: true, childSessionKey: CHILD, childRunId: CR_W, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 }),
    );
    const mW = (await start(t, chatId, W))!;
    expect((await t.run((ctx) => ctx.db.get(mW)))?.deliveryOwnBubble).toBe(true);
    await t.mutation(internal.stream.setSnapshot, { messageId: mW, text: "", replace: true, expectedRunId: W } as never);
    await t.mutation(internal.stream.finalize, { messageId: mW, status: "complete", text: "", dropIfEmpty: true } as never);
    expect(await t.run((ctx) => ctx.db.get(mW))).toBeNull();
    await apply(t, chatId, [said("w1", 5, W, "Résultat tardif.")], { terminals: [{ runId: W, status: "completed", at: Date.now() }] });
    await settle(t);
    const reborn = await assistantsOf(t, chatId, W);
    expect(reborn.map((m) => m.text)).toEqual(["Résultat tardif."]);
    const doc = reborn[0]!;
    expect(doc.deliveryOwnBubble).toBe(true);
    expect(doc.deliveryKey).toBe(`settle:${CR_W}`);
    const links = await t.run((ctx) => ctx.db.query("runBubbles").withIndex("by_message", (q) => q.eq("messageId", doc._id)).collect());
    expect(links.map((l) => l.runId)).toEqual([W]);
    return { chatId, mP, reborn: doc._id };
  }
  const answerBubbles = (t: T, chatId: Id<"chats">) =>
    t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.role === "assistant" && m.text.includes("Résultat tardif.")),
    );

  test("in `on`: its :retry-1 lands on the reborn bubble — one answer", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, reborn } = await droppedThenReborn(t);
    expect(await start(t, chatId, `${W}:retry-1`)).toBe(reborn);
    expect((await answerBubbles(t, chatId)).map((m) => m._id)).toEqual([reborn]);
  });

  test("after a rollback to shadow: its :retry-1 lands on the reborn bubble, never merges into the parent", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, mP, reborn } = await droppedThenReborn(t);
    await setMode(t, "shadow");
    expect(await start(t, chatId, `${W}:retry-1`)).toBe(reborn);
    expect((await t.run((ctx) => ctx.db.get(mP)))?.text).toBe("Je délègue.");
    expect((await answerBubbles(t, chatId)).map((m) => m._id)).toEqual([reborn]);
  });
});

describe("a delivery's late final with no bubble is born its own (§14.28)", () => {
  test("appendLateFinal in `on`: identity, record, and the replay finds it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t);
    const created = (await t.mutation(internal.stream.appendLateFinal, { chatId, runId: A, text: "Résultat.", turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    const doc = (await t.run((ctx) => ctx.db.get(created)))!;
    expect({ own: doc.deliveryOwnBubble, key: doc.deliveryKey }).toEqual({ own: true, key: `run:${A}` });
    expect(await start(t, chatId, A)).toBe(created);
    expect((await assistantsOf(t, chatId, A)).map((m) => m._id)).toEqual([created]);
  });
});

// ── codex phase 5 pass 18: a late final after a rollback keeps the delivery's identity ──
describe("a late final born after a rollback, for a run whose own bubble was dropped (§14.29)", () => {
  test("on → empty drop → shadow → late final → replay: exactly one answer", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId, mA } = await droppedOwnDelivery(t);
    // The child stays anchored to the turn's bubble: 0.96.0's path would reopen it.
    const mP = (await assistantsOf(t, chatId, P))[0]!._id;
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mP, anchorExact: true, childSessionKey: CHILD, childRunId: CHILD_RUN, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 }),
    );
    await setMode(t, "shadow");
    const late = (await t.mutation(internal.stream.appendLateFinal, { chatId, runId: A, messageId: mA, text: "Résultat.", turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    const doc = (await t.run((ctx) => ctx.db.get(late)))!;
    expect({ own: doc.deliveryOwnBubble, key: doc.deliveryKey }).toEqual({ own: true, key: `run:${A}` });
    expect(await start(t, chatId, A)).toBe(late);
    const shown = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.role === "assistant" && m.text.includes("Résultat.")),
    );
    expect(shown.map((m) => m._id)).toEqual([late]);
    expect((await t.run((ctx) => ctx.db.get(mP)))?.text).toBe("Je délègue.");
  });
});
