// A YIELDED TURN'S CONTINUATION LANDS IN THAT TURN'S BUBBLE.
//
// Production, 2026-09-26 (chat mh74rj7t…, OpenClaw 2026.9.6, agent "meta"): the
// turn ran exec ×5, `sessions_spawn`, `sessions_yield` and said nothing — bubble A.
// When the child settled, the gateway woke the requester with
// `announce:requester-settle:meta:<requesterSessionKey>:<childRunId>:yield-1`, the
// continuation of the yielded turn carrying its REAL answer
// (subagent-announce.requester-settle-wake.ts:362-364, 426-440, 623-625). Atrium
// correlated that family to nothing, so the answer opened bubble B — and 180 s
// after the child finished, A's empty-state fallback printed the child's own
// reply BELOW B's conclusion. The reader saw: promise, conclusion, then the input
// the conclusion was built from.
//
// The join is the settled children's RUN ids (the only child identity the wake
// names), recorded on each subAgents row from its spawn result.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { toBase64 } from "./lib/crypto/cipher";

const modules = import.meta.glob("./**/*.ts");

const REQUESTER = "agent:meta:atrium:chat:olivier:mh74rj7t29mhnp7rc1yy5r9nj18f5358";
const CHILD_RUN = "5c2543ae-a10b-4bcd-a346-6e3f8ab0e70e";
const CHILD_RUN_2 = "0d1f7a52-8a4e-4c55-9e07-6b1c9d0c2b11";
const CHILD_KEY = "agent:files:subagent:0f7e3a6e-1c55-4a3c-9a0b-7c5f4b6e2d10";
const CHILD_KEY_2 = "agent:files:subagent:9e2b1d44-7a31-4f0c-8f6e-2d3c4b5a6978";
const settleRun = (ids: string[], suffix = ":yield-1") =>
  `announce:requester-settle:meta:${REQUESTER}:${ids.join(",")}${suffix}`;
// The exact production id.
const PROD_SETTLE = settleRun([CHILD_RUN]);

type T = ReturnType<typeof convexTest>;

/** The production shape: a turn that spawned, yielded and said nothing. */
async function seedYieldedTurn(
  t: T,
  opts?: {
    parentText?: string;
    children?: Array<{
      key: string;
      runId?: string;
      anchorExact?: boolean;
      parent?: "A" | "other";
      kind?: "task";
    }>;
  },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "olivier" });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "lacneu",
      agentId: "meta",
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Renomme l'archive mémoire",
      updatedAt: 1000,
    });
    const otherId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "An older, unrelated answer.",
      runId: "webchat-older",
      finalizedAt: 1500,
      updatedAt: 1500,
    });
    const parentId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: opts?.parentText ?? "",
      runId: "webchat-6309c12f",
      finalizedAt: 2000,
      updatedAt: 2000,
    });
    // The parent's OWN parts — written by its webchat run, so unstamped.
    await ctx.db.insert("messageParts", {
      messageId: parentId,
      order: 0,
      part: {
        kind: "tool" as const,
        name: "sessions_spawn",
        phase: "completed",
        output: { details: { status: "accepted", childSessionKey: CHILD_KEY, runId: CHILD_RUN } },
      },
    });
    await ctx.db.insert("messageParts", {
      messageId: parentId,
      order: 1,
      part: {
        kind: "tool" as const,
        name: "sessions_yield",
        phase: "completed",
        output: { details: { status: "yielded" } },
      },
    });
    const children = opts?.children ?? [{ key: CHILD_KEY, runId: CHILD_RUN }];
    for (const c of children) {
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: c.parent === "other" ? otherId : parentId,
        ...(c.anchorExact === false ? {} : { anchorExact: true }),
        childSessionKey: c.key,
        ...(c.runId !== undefined ? { childRunId: c.runId } : {}),
        ...(c.kind !== undefined ? { kind: c.kind } : {}),
        status: "done" as const,
        resultText: "Archive renommée en memory-2026-09.tar.gz.",
        createdAt: 1800,
        updatedAt: 2500,
      });
    }
    return { userId, chatId, parentId, otherId };
  });
}

async function assistants(t: T, chatId: Id<"chats">) {
  return t.run(async (ctx) =>
    (await ctx.db.query("messages").collect()).filter(
      (m) => m.chatId === chatId && m.role === "assistant",
    ),
  );
}

/** A child the CONTINUATION `carrierRun` spawned, written through the mutation the
 *  bridge ingest calls, in the records the bridge observer emits for it
 *  (bridge/test/sub-agent-child-run-id.test.ts, "a child spawned inside a
 *  continuation…"): at its `lifecycle start` — the correlated anchor of the item
 *  sighting, the carrier run, and the run id read from that very frame — then its
 *  terminal. No field is seeded behind the bridge's back. */
async function childSpawnedInContinuation(
  t: T,
  chatId: Id<"chats">,
  parentId: Id<"messages">,
  carrierRun: string,
  opts?: { key?: string; runId?: string | null; anchored?: boolean },
) {
  const key = opts?.key ?? CHILD_KEY_2;
  const runId = opts?.runId === undefined ? CHILD_RUN_2 : opts.runId;
  const anchored = opts?.anchored ?? true;
  const identity = {
    chatId,
    childSessionKey: key,
    ...(anchored ? { parentMessageId: parentId, anchorExact: true } : {}),
    ...(runId !== null ? { childRunId: runId } : {}),
  };
  await t.mutation(internal.subAgents.upsertSubAgent, {
    ...identity,
    bornOfRun: carrierRun,
    taskName: "Rédige le rapport en PDF",
    status: "running",
    phase: "start",
  });
  await t.mutation(internal.subAgents.upsertSubAgent, {
    ...identity,
    status: "done",
    resultText: "PDF prêt : rapport.pdf",
  });
}

describe("requester-settle continuation merges into the yielded turn", () => {
  test("the production id reopens bubble A — one bubble, the conclusion in it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    const before = (await assistants(t, chatId)).length;

    const opened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: PROD_SETTLE,
    });
    expect(opened).toBe(parentId);
    const reopened = await t.run((ctx) => ctx.db.get(parentId));
    expect(reopened?.status).toBe("streaming");
    expect(reopened?.runId).toBe(PROD_SETTLE);
    // The turn said nothing: its continuation begins at the very start, and it
    // answers for the child its settle run named.
    expect(reopened?.continuations).toEqual([{ at: 0, childRunIds: [CHILD_RUN] }]);

    await t.mutation(internal.stream.appendDelta, {
      messageId: parentId,
      text: "C'est fait : l'archive s'appelle désormais memory-2026-09.",
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "C'est fait : l'archive s'appelle désormais memory-2026-09.",
    });

    const after = await assistants(t, chatId);
    expect(after).toHaveLength(before); // NO second bubble
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    // The bubble that carried the finishing promise now carries the answer: the
    // empty-state decision (src/chat/assistantEmptyState.ts) reads `hasText` and
    // stands down — the promise resolves when the merged run settles.
    expect(settled?.status).toBe("complete");
    expect(settled?.text).toBe("C'est fait : l'archive s'appelle désormais memory-2026-09.");
    expect(settled?.mergedAnnounceRuns).toContain(PROD_SETTLE);
    expect(settled?.announcePrefix).toBeUndefined();
  });

  test("a multi-child batch, a later yield generation and a retry suffix all join", async () => {
    const t = convexTest(schema, modules);
    const { parentId, chatId } = await seedYieldedTurn(t, {
      parentText: "Je confie les deux tâches.",
      children: [
        { key: CHILD_KEY, runId: CHILD_RUN },
        { key: CHILD_KEY_2, runId: CHILD_RUN_2 },
      ],
    });
    const run = settleRun([CHILD_RUN_2, CHILD_RUN].sort(), ":yield-2:retry-1");
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: run });
    expect(opened).toBe(parentId);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    // After the turn's own words and the merge separator.
    expect(doc?.continuations).toEqual([
      { at: "Je confie les deux tâches.".length + 2, childRunIds: [CHILD_RUN_2, CHILD_RUN].sort() },
    ]);
    expect(doc?.announcePrefix).toBe("Je confie les deux tâches.");
  });

  test("a continuation that delegates and yields AGAIN gets its own position (codex pass 2, P2)", async () => {
    const t = convexTest(schema, modules);
    const { parentId, chatId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Première conclusion.",
    });
    // The continuation delegated again and yielded again. Its child is written the
    // way the bridge writes it — the run id learned from the child's own startup,
    // the correlated anchor from the item sighting — and ITS settle run is a new
    // requester run, so its generation counter restarts: `yield-1` again.
    await childSpawnedInContinuation(t, chatId, parentId, PROD_SETTLE);
    const second = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([CHILD_RUN_2]),
    });
    expect(second).toBe(parentId);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    // The first batch keeps its place; the second is recorded where ITS continuation
    // begins — after the first conclusion — so its child's reply precedes the second
    // conclusion instead of the text that asked for it.
    expect(doc?.continuations).toEqual([
      { at: 0, childRunIds: [CHILD_RUN] },
      { at: "Première conclusion.".length + 2, childRunIds: [CHILD_RUN_2] },
    ]);
    // A per-batch bubble writes no legacy single offset.
    expect(doc?.continuationAt).toBeUndefined();
  });

  test("a replay of the SAME batch (retry wake, error resume) keeps its first position", async () => {
    const t = convexTest(schema, modules);
    const { parentId, chatId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "error", text: "Partiel", error: "lost" });
    // The rebroadcast resumes the errored merge (same run), then a retry wake of the
    // same batch arrives under its `:retry-1` id.
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Fin." });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([CHILD_RUN], ":yield-1:retry-1"),
    });
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.continuations).toEqual([{ at: 0, childRunIds: [CHILD_RUN] }]);
  });

  test("the list is bounded: a batch past the bound gets no entry, the merge still happens", async () => {
    const t = convexTest(schema, modules);
    const { parentId, chatId } = await seedYieldedTurn(t);
    const full = Array.from({ length: 16 }, (_, i) => ({ at: i, childRunIds: [`old-${i}`] }));
    await t.run((ctx) => ctx.db.patch(parentId, { continuations: full }));
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    expect(opened).toBe(parentId);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("streaming");
    expect(doc?.continuations).toEqual(full);
  });
});

describe("the merge fails CLOSED to its own bubble whenever the join is not exact", () => {
  async function expectOwnBubble(
    t: T,
    chatId: Id<"chats">,
    parentId: Id<"messages">,
    runId: string,
  ) {
    const before = await t.run((ctx) => ctx.db.get(parentId));
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId });
    expect(opened).not.toBeNull();
    expect(opened).not.toBe(parentId);
    const after = await t.run((ctx) => ctx.db.get(parentId));
    expect(after?.status).toBe(before?.status);
    expect(after?.runId).toBe(before?.runId);
    expect(after?.continuationAt).toBeUndefined();
    expect(after?.continuations).toBeUndefined();
  }

  test("an unknown child run id", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await expectOwnBubble(t, chatId, parentId, settleRun(["ffffffff-0000-4000-8000-000000000000"]));
  });

  test("a batch split across two bubbles", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [
        { key: CHILD_KEY, runId: CHILD_RUN },
        { key: CHILD_KEY_2, runId: CHILD_RUN_2, parent: "other" },
      ],
    });
    await expectOwnBubble(t, chatId, parentId, settleRun([CHILD_RUN, CHILD_RUN_2].sort()));
  });

  test("a heuristic (non-exact) anchor", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [{ key: CHILD_KEY, runId: CHILD_RUN, anchorExact: false }],
    });
    await expectOwnBubble(t, chatId, parentId, PROD_SETTLE);
  });

  test("an ambiguous run id (two rows claim it)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [
        { key: CHILD_KEY, runId: CHILD_RUN },
        { key: CHILD_KEY_2, runId: CHILD_RUN },
      ],
    });
    await expectOwnBubble(t, chatId, parentId, PROD_SETTLE);
  });

  test("a background-task engagement row is never a settle anchor", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [{ key: CHILD_KEY, runId: CHILD_RUN, kind: "task" }],
    });
    await expectOwnBubble(t, chatId, parentId, PROD_SETTLE);
  });

  test("a wake WITHOUT a yield suffix: the turn already answered — its own bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await expectOwnBubble(t, chatId, parentId, settleRun([CHILD_RUN], ""));
  });

  test("the child row belongs to ANOTHER chat", async () => {
    const t = convexTest(schema, modules);
    const a = await seedYieldedTurn(t);
    const b = await seedYieldedTurn(t, { children: [] });
    await expectOwnBubble(t, b.chatId, b.parentId, PROD_SETTLE);
    const untouched = await t.run((ctx) => ctx.db.get(a.parentId));
    expect(untouched?.status).toBe("complete");
    expect(untouched?.runId).toBe("webchat-6309c12f");
  });

  test("the parent bubble was deleted", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.run((ctx) => ctx.db.delete(parentId));
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    expect(opened).not.toBeNull();
    expect(opened).not.toBe(parentId);
  });
});

describe("a merged continuation writes in its OWN generation", () => {
  test("its parts are stamped, so the parent's own yield cannot excuse an empty continuation", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "call-1" },
    });
    const parts = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .collect(),
    );
    expect(parts.find((p) => p.part.kind === "tool" && p.part.name === "exec")?.announceRun).toBe(
      PROD_SETTLE,
    );
    // The continuation was REQUIRED to answer (requireVisibleReply) and brought
    // nothing: named, not excused by the stale `sessions_yield` of the turn it
    // continues.
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "" });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("error");
    expect(settled?.errorCode).toBe("empty_response");
  });

  test("a continuation whose answer arrived as a SNAPSHOT, then a text-less close, is not named empty", async () => {
    // Bench 2026-09-26 (chat m971j0qw…): the answer was sent through the message tool and
    // the run's own final was NO_REPLY, so the bridge recovers the text from the transcript
    // and writes it as a snapshot; the close that follows carries no text of its own. The
    // verdict must read the bubble's stored text, not the close's.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "call-e" },
    });
    await t.mutation(internal.stream.setSnapshot, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      text: "SYNTHESE: L’agent files a terminé.",
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "" });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("complete");
    expect(settled?.errorCode).toBeUndefined();
    expect(settled?.text).toBe("SYNTHESE: L’agent files a terminé.");
  });

  test("a continuation that yields AGAIN (its own, stamped yield) is still a hand-off", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: {
        kind: "tool",
        name: "sessions_yield",
        phase: "completed",
        toolCallId: "call-y2",
        output: { details: { status: "yielded" } },
      },
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "" });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("complete");
  });

  test("a continuation's tool anchor is rebased past the text the turn already held", async () => {
    const t = convexTest(schema, modules);
    const prefix = "Je délègue le renommage.";
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: prefix });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    // The sink stamps against the text IT streamed — zero at the continuation's start.
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "tool", name: "exec", phase: "start", toolCallId: "call-2", textOffset: 0 },
    });
    const part = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", parentId))
          .collect()
      ).find((p) => p.part.kind === "tool" && p.part.toolCallId === "call-2"),
    );
    const offset = part?.part.kind === "tool" ? part.part.textOffset : undefined;
    expect(offset).toBe(prefix.length + 2);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(offset).toBe(doc?.continuations?.[0]?.at);
  });
});

describe("the child run id is recorded from the spawn result, once", () => {
  test("fill-only: a later run of the same child session does not re-point the join", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { children: [] });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      parentMessageId: parentId,
      anchorExact: true,
      childSessionKey: CHILD_KEY,
      childRunId: CHILD_RUN,
      status: "running",
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD_KEY,
      childRunId: CHILD_RUN_2,
      status: "done",
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD_KEY))
        .first(),
    );
    expect(row?.childRunId).toBe(CHILD_RUN);
    // …and the join works off it end to end.
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    expect(opened).toBe(parentId);
  });
});

// THE STOP, AND WHAT CONVEX DOES NOT KNOW (codex pass 3, P2).
//
// A settle run names its children by RUN id only, so the interruption epoch at the
// delivery door (which looks a delivery's child up by session KEY) never found one: a
// batch whose join then failed opened a NEW bubble carrying the result the user had
// stopped. The rule mirrored is the announce family's: a delivery whose child started
// at or before `chat.stoppedAt` is dropped whole.
describe("the interruption epoch applies to the children a settle run names", () => {
  async function stopAt(t: T, chatId: Id<"chats">, at: number) {
    await t.run((ctx) => ctx.db.patch(chatId, { stoppedAt: at }));
  }
  async function expectDropped(t: T, chatId: Id<"chats">, parentId: Id<"messages">, runId: string) {
    const before = (await assistants(t, chatId)).length;
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId });
    expect(opened).toBeNull();
    expect(await assistants(t, chatId)).toHaveLength(before); // no new bubble
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete");
    expect(parent?.runId).toBe("webchat-6309c12f");
  }

  test("a STOPPED child beside an unknown one: dropped, never a new bubble (the reported case)", async () => {
    const t = convexTest(schema, modules);
    // Children created at 1800; the user pressed Stop at 1900.
    const { chatId, parentId } = await seedYieldedTurn(t);
    await stopAt(t, chatId, 1900);
    await expectDropped(t, chatId, parentId, settleRun([CHILD_RUN, CHILD_RUN_2].sort()));
  });

  test("a stopped child in a fully known batch: dropped too, even though the merge would succeed", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await stopAt(t, chatId, 1900);
    await expectDropped(t, chatId, parentId, PROD_SETTLE);
  });

  test("ONE refused member refuses the batch — the continuation consumes every result", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [
        { key: CHILD_KEY, runId: CHILD_RUN },
        { key: CHILD_KEY_2, runId: CHILD_RUN_2 },
      ],
    });
    // One member started before the Stop, the other after it.
    await t.run(async (ctx) => {
      const late = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD_KEY_2))
        .first();
      if (late !== null) await ctx.db.patch(late._id, { createdAt: 2500 });
    });
    await stopAt(t, chatId, 1900);
    await expectDropped(t, chatId, parentId, settleRun([CHILD_RUN, CHILD_RUN_2].sort()));
  });

  test("a Stop OLDER than the children does not mute them — stopping one turn never mutes the next", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await stopAt(t, chatId, 1000);
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    expect(opened).toBe(parentId);
  });

  test("NO named child known and a Stop on record: its own bubble — the work cannot be dated", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { children: [] });
    await stopAt(t, chatId, 1900);
    const opened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun(["ffffffff-0000-4000-8000-000000000000"]),
    });
    expect(opened).not.toBeNull();
    expect(opened).not.toBe(parentId);
  });
});

describe("partial knowledge: the known members anchor the batch (codex pass 3)", () => {
  test("one member known, one unknown: merges into the known member's bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [{ key: CHILD_KEY, runId: CHILD_RUN }, { key: CHILD_KEY_2 }],
    });
    const opened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([CHILD_RUN, CHILD_RUN_2].sort()),
    });
    expect(opened).toBe(parentId);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    // The batch is recorded whole: the unknown member's reply, once its row learns its
    // run id, belongs at this continuation too.
    expect(doc?.continuations?.[0]?.childRunIds).toEqual([CHILD_RUN, CHILD_RUN_2].sort());
  });

  test("…but the known members must still agree: a split stays its own bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, {
      children: [
        { key: CHILD_KEY, runId: CHILD_RUN },
        { key: CHILD_KEY_2, runId: CHILD_RUN_2, parent: "other" },
      ],
    });
    const opened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([CHILD_RUN, CHILD_RUN_2, "ffffffff-0000-4000-8000-000000000000"].sort()),
    });
    expect(opened).not.toBe(parentId);
  });
});

// A `:retry-N` WAKE OF A BATCH ALREADY MERGED (codex pass 10, P2).
//
// Upstream mints `:retry-N` only after an attempt came back `delivered:false` with a
// retryable disposition (requester-settle-wake.ts:501-505, 695-721) — but that attempt
// may have RUN a turn Atrium merged: a channel delivery failure after the run finished
// (subagent-announce-direct-response.ts ~100-118) is retryable. The retry is a NEW run
// of the same batch, so `alreadyMerged` (keyed on the run id) never matched it, and the
// reopen appended a second answer. Every test drives the bridge's own writes — tagged
// with their run, as the writer tags them — and asserts the TEXT and the STATUS.
describe("a retry wake of a batch already merged", () => {
  const RETRY = settleRun([CHILD_RUN], ":yield-1:retry-1");

  async function runGeneration(t: T, messageId: Id<"messages">, runId: string, text: string, status: "complete" | "error" = "complete") {
    await t.mutation(internal.stream.appendDelta, { messageId, text, expectedRunId: runId });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status,
      text,
      expectedRunId: runId,
      ...(status === "error" ? { error: "provider failed" } : {}),
    });
  }

  test("after a first wake that ANSWERED: a silent replay — one answer, still complete", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await runGeneration(t, parentId, PROD_SETTLE, "Réponse.");
    const before = (await assistants(t, chatId)).length;

    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    expect(opened).toBe(parentId); // handed back as a sink, never a new bubble
    await runGeneration(t, parentId, RETRY, "Réponse bis.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text).toBe("Réponse.");
    expect(doc?.status).toBe("complete");
    expect(doc?.runId).toBe(PROD_SETTLE);
    expect(await assistants(t, chatId)).toHaveLength(before);
  });

  test("after a first wake that ENDED IN ERROR: the retry resumes it and completes", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await runGeneration(t, parentId, PROD_SETTLE, "Répo", "error");

    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    expect(opened).toBe(parentId);
    await runGeneration(t, parentId, RETRY, "Réponse complète.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    // The failed fragment is replaced, the turn's own words kept.
    expect(doc?.text).toBe("Je délègue.\n\nRéponse complète.");
    expect(doc?.status).toBe("complete");
    expect(doc?.errorCode).toBeUndefined();
  });

  test("after a first wake that settled WITHOUT an answer of its own: the retry brings it", async () => {
    // `visible_reply_missing` can be retryable upstream: the first run did work (here a
    // live checklist) but wrote no text, and the bubble settled complete on its prefix.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "plan", steps: [{ step: "Synthèse", status: "in_progress" }] },
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "", expectedRunId: PROD_SETTLE });
    expect((await t.run((ctx) => ctx.db.get(parentId)))?.status).toBe("complete");

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await runGeneration(t, parentId, RETRY, "Voici la synthèse.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text?.endsWith("Voici la synthèse.")).toBe(true);
    expect(doc?.text?.startsWith("Je délègue.")).toBe(true);
    expect(doc?.status).toBe("complete");
  });

  test("a retry arriving while the first wake is STILL streaming: no second bubble, no interleave", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    const before = (await assistants(t, chatId)).length;

    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    expect(opened).toBe(parentId);
    expect(await assistants(t, chatId)).toHaveLength(before);
    await t.mutation(internal.stream.appendDelta, { messageId: parentId, text: "Doublon.", expectedRunId: RETRY });
    await runGeneration(t, parentId, PROD_SETTLE, "Réponse.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text).toBe("Réponse.");
    expect(doc?.status).toBe("complete");
  });

  test("a retry of an OLDER batch, once a later continuation owns the bubble: silent", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await runGeneration(t, parentId, PROD_SETTLE, "Première.");
    await childSpawnedInContinuation(t, chatId, parentId, PROD_SETTLE);
    const SECOND = settleRun([CHILD_RUN_2]);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND });
    await runGeneration(t, parentId, SECOND, "Seconde.");

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await runGeneration(t, parentId, RETRY, "Première bis.");
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text).toBe("Première.\n\nSeconde.");
    expect(doc?.status).toBe("complete");
  });

  // What "answered" means (codex pass 11): the SAME verdict that named the first run's
  // delivery (stream.ts `carriesDeliveredContent`) — text, or a file the reader can open,
  // or a live checklist / a cron card. Text alone was the first rule, and a first run
  // that delivered only a FILE was reopened by its retry: the file landed twice.
  async function mediaPart(t: T, messageId: Id<"messages">, runId: string, bytes: string) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: runId,
      part: { kind: "media", storageId, filename: "synthese.pdf", mimeType: "application/pdf" },
    });
  }
  async function partsOf(t: TestConvex<typeof schema>, messageId: Id<"messages">) {
    return t.run((ctx) =>
      ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect(),
    );
  }

  test("after a first wake that delivered only a FILE: silent — one file, still complete", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await mediaPart(t, parentId, PROD_SETTLE, "pdf-v1");
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "", expectedRunId: PROD_SETTLE });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("complete");

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await mediaPart(t, parentId, RETRY, "pdf-v2");
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Voici le PDF.", expectedRunId: RETRY });

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text).toBe(settled?.text);
    expect(doc?.runId).toBe(PROD_SETTLE);
    const files = (await partsOf(t, parentId)).filter((p) => p.part.kind === "media");
    expect(files).toHaveLength(1);
    expect(files[0]?.announceRun).toBe(PROD_SETTLE);
  });

  test("only THIS batch's parts count: a file the turn itself delivered does not silence the retry", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    // The yielded turn's OWN attachment — written by its webchat run, so unstamped.
    const own = await t.run((ctx) => ctx.storage.store(new Blob(["brief"])));
    await t.run((ctx) =>
      ctx.db.insert("messageParts", {
        messageId: parentId,
        order: 5,
        part: { kind: "media", storageId: own, filename: "brief.pdf", mimeType: "application/pdf" },
      }),
    );
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "c1" },
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "", expectedRunId: PROD_SETTLE });
    expect((await t.run((ctx) => ctx.db.get(parentId)))?.status).toBe("complete");

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Voici la synthèse.", expectedRunId: RETRY });
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text?.endsWith("Voici la synthèse.")).toBe(true);
    expect(doc?.status).toBe("complete");
  });

  test("a CRON card the batch wrote is an answer: the retry stays silent", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: parentId,
        order: 9,
        part: { kind: "cron" as const, op: "created" as const, jobId: "job-1", name: "Rappel" },
        announceRun: PROD_SETTLE,
      });
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "", expectedRunId: PROD_SETTLE });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    expect(settled?.status).toBe("complete");

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Rappel créé.", expectedRunId: RETRY });
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text).toBe(settled?.text);
    expect(doc?.runId).toBe(PROD_SETTLE);
  });

  test("a first wake with only TOOL cards has not answered: the retry brings the answer", async () => {
    // Tool cards are work, not an answer — the delivery verdict says so, and the retry
    // exists precisely because that run delivered nothing. Its own tools ran again, so
    // their cards are added: a second execution, not a duplicate of the first.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "c1" },
    });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: PROD_SETTLE,
      part: { kind: "plan", steps: [{ step: "Synthèse", status: "in_progress" }] },
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "", expectedRunId: PROD_SETTLE });
    // The live checklist kept that bubble complete; clear it, as the run's own later plan
    // update would, so the only thing left from the first run is a tool card.
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", parentId)).collect()) {
        if (p.part.kind === "plan") await ctx.db.delete(p._id);
      }
    });

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: RETRY,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "c2" },
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Voici la synthèse.", expectedRunId: RETRY });

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text?.endsWith("Voici la synthèse.")).toBe(true);
    const tools = (await partsOf(t, parentId)).filter((p) => p.part.kind === "tool" && p.part.name === "exec");
    expect(tools.map((p) => p.announceRun)).toEqual(expect.arrayContaining([PROD_SETTLE, RETRY]));
  });

  // A FAILED ATTEMPT'S FILE, AND THE RETRY THAT RE-SENDS IT (codex pass 12). The resume
  // of a failed run keeps what it already attached and dedupes a re-upload by name,
  // while its text is re-seeded from the parked prefix. A retry is a new run of the SAME
  // batch: it must meet the first attempt's parts under the same rule, or the file is
  // attached twice — in the bubble AND in the chat's files list.
  test("an errored first wake's FILE, re-sent by the retry: one copy in the bubble and in the files list", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await mediaPart(t, parentId, PROD_SETTLE, "pdf-v1");
    await t.mutation(internal.stream.appendDelta, { messageId: parentId, text: "Voici", expectedRunId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "error",
      text: "Voici",
      error: "provider failed",
      expectedRunId: PROD_SETTLE,
    });

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await mediaPart(t, parentId, RETRY, "pdf-v2"); // the same document, re-uploaded
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Voici le PDF.",
      expectedRunId: RETRY,
    });

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text).toBe("Je délègue.\n\nVoici le PDF.");
    const files = (await partsOf(t, parentId)).filter((p) => p.part.kind === "media");
    expect(files).toHaveLength(1);
    const rows = await t.run((ctx) =>
      ctx.db.query("files").collect(),
    );
    const listed = rows.filter((r) => r.messageId === parentId);
    expect(listed).toHaveLength(1);
    // The row points at the copy the bubble shows — never at a reclaimed blob.
    expect(listed[0]?.storageId).toBe(files[0]?.part.kind === "media" ? files[0].part.storageId : null);
    const url = await t.run((ctx) => ctx.storage.getUrl(listed[0]!.storageId));
    expect(url).not.toBeNull();
  });

  test("…while a DIFFERENT file the retry sends is kept beside it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await mediaPart(t, parentId, PROD_SETTLE, "pdf-v1");
    await t.mutation(internal.stream.finalize, {
      messageId: parentId, status: "error", text: "", error: "provider failed", expectedRunId: PROD_SETTLE,
    });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    const other = await t.run((ctx) => ctx.storage.store(new Blob(["xlsx"])));
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: RETRY,
      part: { kind: "media", storageId: other, filename: "annexe.xlsx", mimeType: "application/vnd.ms-excel" },
    });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Deux fichiers.", expectedRunId: RETRY });
    const names = (await partsOf(t, parentId))
      .flatMap((p) => (p.part.kind === "media" ? [p.part.filename] : []))
      .sort();
    expect(names).toEqual(["annexe.xlsx", "synthese.pdf"]);
    expect((await t.run((ctx) => ctx.db.get(parentId)))?.status).toBe("complete");
  });

  test("a SILENT retry's late, untagged re-upload is deduped like a rebroadcast's", async () => {
    // Self-audit, same class: a retry handed back as a silent sink cannot write through
    // the generation guard — until its message is forgotten by the writer at finalize,
    // after which a late upload goes out UNTAGGED (convex-writer.ts `genTag`). The
    // terminal-rebroadcast sink arms the replay window for exactly this; this one must.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await mediaPart(t, parentId, PROD_SETTLE, "pdf-v1");
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Voici.", expectedRunId: PROD_SETTLE });

    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    expect(opened).toBe(parentId);
    // The late upload, untagged: no `expectedRunId`.
    const late = await t.run((ctx) => ctx.storage.store(new Blob(["pdf-v2"])));
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "media", storageId: late, filename: "synthese.pdf", mimeType: "application/pdf" },
    });

    const files = (await partsOf(t, parentId)).filter((p) => p.part.kind === "media");
    expect(files).toHaveLength(1);
    const listed = (await t.run((ctx) => ctx.db.query("files").collect())).filter((r) => r.messageId === parentId);
    expect(listed).toHaveLength(1);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text).toBe("Je délègue.\n\nVoici.");
  });

  test("A complete, B in error, a REBROADCAST of A's original run: B's error is left alone (codex pass 13)", async () => {
    // `alreadyMerged` knows every run the bubble ever took — A included — and the resume
    // gate trusted it: A's replay re-seeded B's failed merge and wrote A's text over it.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await mediaPart(t, parentId, PROD_SETTLE, "pdf-a");
    await runGeneration(t, parentId, PROD_SETTLE, "Première.");
    await childSpawnedInContinuation(t, chatId, parentId, PROD_SETTLE);
    const SECOND = settleRun([CHILD_RUN_2]);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND });
    await runGeneration(t, parentId, SECOND, "Seco", "error");
    const failed = await t.run((ctx) => ctx.db.get(parentId));
    const partsBefore = (await partsOf(t, parentId)).length;

    // The REBROADCAST of A's own run (bridge restart), carrying A's answer and file again.
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    expect(opened).toBe(parentId);
    await mediaPart(t, parentId, PROD_SETTLE, "pdf-a-again");
    await runGeneration(t, parentId, PROD_SETTLE, "Première rejouée.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("error");
    expect(doc?.text).toBe(failed?.text);
    expect(doc?.text).not.toContain("rejouée");
    expect(doc?.runId).toBe(SECOND);
    expect(doc?.errorCode).toBe(failed?.errorCode);
    expect(await partsOf(t, parentId)).toHaveLength(partsBefore);
  });

  test("…while B's OWN rebroadcast still resumes B", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await runGeneration(t, parentId, PROD_SETTLE, "Première.");
    await childSpawnedInContinuation(t, chatId, parentId, PROD_SETTLE);
    const SECOND = settleRun([CHILD_RUN_2]);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND });
    await runGeneration(t, parentId, SECOND, "Seco", "error");
    await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND });
    await runGeneration(t, parentId, SECOND, "Seconde.");
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text).toBe("Je délègue.\n\nPremière.\n\nSeconde.");
  });

  test("…and it never RESUMES a later continuation's failure it does not own", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await runGeneration(t, parentId, PROD_SETTLE, "Première.");
    await childSpawnedInContinuation(t, chatId, parentId, PROD_SETTLE);
    const SECOND = settleRun([CHILD_RUN_2]);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND });
    // The SECOND continuation failed: its own rebroadcast may resume it, the first
    // batch's retry may not.
    await runGeneration(t, parentId, SECOND, "Seco", "error");
    const failed = await t.run((ctx) => ctx.db.get(parentId));

    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await runGeneration(t, parentId, RETRY, "Première bis.");
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("error");
    expect(doc?.text).toBe(failed?.text);
    expect(doc?.runId).toBe(SECOND);
  });
});

// PRODUCTION, 2026-09-27 (chat mh71qt6…, gateway 2026.9.6, bridge 0.87.0). The turn
// delegated to C1 (`runTimeoutSeconds: 900`) and yielded: bubble B. C1 timed out; its
// settle run `…:<C1>:yield-1` merged into B. Inside that continuation the agent
// delegated AGAIN, to C2, and yielded again. C2 finished, and ITS settle run —
// `…:<C2>:yield-1`, a new requester run, so a counter that restarts — carried the PDF
// into a SECOND bubble: C2 was spawned by item frames only, no spawn result named its
// run id, and the join had no member to anchor on.
//
// Every write the bridge makes goes through the real ingest door (`/bridge/ingest`,
// per-bridge secret), in the shapes the observer emits (bridge/test/
// sub-agent-child-run-id.test.ts, sub-agent-timeout.test.ts). The stream is driven
// through the mutations the ingest routes to, as everywhere else in this file.
describe("a continuation that re-delegates and yields AGAIN lands in the SAME bubble", () => {
  const C1_KEY = "agent:files:subagent:7a1c2e90-4b3d-4f6e-8a21-9c0d1e2f3a4b";
  const C1_RUN = "3e9b7c10-2d4a-4c8e-9f1b-6a5d4c3b2a19";
  const C2_KEY = "agent:files:subagent:b82f0d6e-91c4-4e7a-a3d5-0f2e4c6b8a17";
  const C2_RUN = "c4d2e1f0-7b6a-4958-8c3d-2e1f0a9b8c7d";
  const GEN1 = settleRun([C1_RUN]);
  const GEN2 = settleRun([C2_RUN]); // `yield-1` too: the production id
  const TIMEOUT_TEXT =
    "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";

  let prevKey: string | undefined;
  beforeEach(() => {
    prevKey = process.env.ATRIUM_SECRET_KEY;
    process.env.ATRIUM_SECRET_KEY = toBase64(new Uint8Array(32).fill(7));
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.ATRIUM_SECRET_KEY;
    else process.env.ATRIUM_SECRET_KEY = prevKey;
  });

  /** The bubble B the turn left, C1 registered from its spawn RESULT (a normal turn:
   *  tool frames reach the bridge), and the bridge's per-bridge secret. */
  async function seedProd(t: T) {
    const { chatId, parentId } = await seedYieldedTurn(t, {
      parentText: "Je confie la rédaction du rapport.",
      children: [],
    });
    const admin = await t.run(async (ctx) => {
      const a = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: a, role: "admin" });
      return a;
    });
    const instanceId = await t.run((ctx) =>
      ctx.db.insert("instances", { name: "lacneu", gatewayUrl: "ws://lacneu", kind: "openclaw" as const }),
    );
    const minted = await t
      .withIdentity({ subject: `${admin}|session` })
      .action(api.bridgeAuth.mintBridgeSecret, { instanceId });
    const ingest = async (body: Record<string, unknown>) => {
      const res = await t.fetch("/bridge/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.plaintext}` },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body.op)).toBe(200);
    };
    // C1: the spawn result's registration, then its time-limit failure.
    const c1 = {
      op: "upsertSubAgent",
      chatId,
      parentMessageId: parentId,
      anchorExact: true,
      childSessionKey: C1_KEY,
      childRunId: C1_RUN,
      runTimeoutSeconds: 900,
    };
    await ingest({ ...c1, taskName: "Rédige le rapport", status: "running" });
    await ingest({ ...c1, status: "error", errorMessage: TIMEOUT_TEXT, errorCode: "timeout" });
    return { chatId, parentId, ingest };
  }

  /** C2 as the bridge writes it at its `lifecycle start` (item-only spawn inside GEN1),
   *  then at its final. `learnedRunId: false` = the bridge before this fix. */
  async function c2(
    ingest: (b: Record<string, unknown>) => Promise<void>,
    chatId: Id<"chats">,
    parentId: Id<"messages">,
    learnedRunId: boolean,
  ) {
    const c = {
      op: "upsertSubAgent",
      chatId,
      parentMessageId: parentId,
      anchorExact: true,
      childSessionKey: C2_KEY,
      ...(learnedRunId ? { childRunId: C2_RUN } : {}),
    };
    await ingest({ ...c, bornOfRun: GEN1, taskName: "Rédige le rapport en PDF", status: "running", phase: "start" });
    await ingest({ ...c, status: "done", resultText: "PDF prêt : rapport.pdf" });
  }

  async function generation(t: T, messageId: Id<"messages">, runId: string, text: string) {
    await t.mutation(internal.stream.appendDelta, { messageId, text, expectedRunId: runId });
    await t.mutation(internal.stream.finalize, { messageId, status: "complete", text, expectedRunId: runId });
  }

  test("ONE bubble: both continuations recorded, the PDF in it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId, ingest } = await seedProd(t);
    const before = (await assistants(t, chatId)).length;

    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: GEN1 })).toBe(parentId);
    await c2(ingest, chatId, parentId, true);
    await generation(t, parentId, GEN1, "Le premier sous-agent a expiré ; je relance la rédaction.");

    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: GEN2 });
    expect(opened).toBe(parentId);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.7"])));
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      expectedRunId: GEN2,
      part: { kind: "media", storageId, filename: "rapport.pdf", mimeType: "application/pdf" },
    });
    await generation(t, parentId, GEN2, "Voici le rapport en PDF.");

    expect(await assistants(t, chatId)).toHaveLength(before); // NO second bubble
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.continuations?.map((c) => c.childRunIds)).toEqual([[C1_RUN], [C2_RUN]]);
    expect(doc?.mergedAnnounceRuns).toEqual(expect.arrayContaining([GEN1, GEN2]));
    expect(doc?.text?.endsWith("Voici le rapport en PDF.")).toBe(true);
    const pdf = (
      await t.run((ctx) =>
        ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", parentId)).collect(),
      )
    ).filter((p) => p.part.kind === "media");
    expect(pdf).toHaveLength(1);
    expect(pdf[0]?.announceRun).toBe(GEN2);
    // The rows the bridge wrote carry what the triage needs.
    const rows = await t.run((ctx) =>
      ctx.db.query("subAgents").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
    );
    const byKey = new Map(rows.map((r) => [r.childSessionKey, r]));
    expect(byKey.get(C2_KEY)?.childRunId).toBe(C2_RUN);
    expect(byKey.get(C1_KEY)?.errorCode).toBe("timeout");
    expect(byKey.get(C1_KEY)?.runTimeoutSeconds).toBe(900);
    // The reader's projection: both batches were visibly followed up (text after
    // each point, and the PDF delivered by the second run) — so C1's failure, which
    // the agent answered by re-delegating, is not the bubble's verdict.
    const userId = (await t.run((ctx) => ctx.db.get(chatId)))!.userId;
    const view = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listByChat, { chatId: chatId as string });
    const b = (view as Array<{ _id: string; followedUpChildRunIds?: string[] }>).find(
      (m) => m._id === parentId,
    );
    expect(b?.followedUpChildRunIds).toEqual([C1_RUN, C2_RUN]);
  });

  test("a continuation that received C1's failure and ended on NOTHING follows nothing up", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedProd(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: GEN1 });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "", expectedRunId: GEN1 });
    const userId = (await t.run((ctx) => ctx.db.get(chatId)))!.userId;
    const view = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listByChat, { chatId: chatId as string });
    const b = (view as Array<{ _id: string; followedUpChildRunIds?: string[] }>).find(
      (m) => m._id === parentId,
    );
    expect(b?.followedUpChildRunIds).toEqual([]);
  });

  test("RED without the learned run id — today's two bubbles, reproduced", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId, ingest } = await seedProd(t);
    const before = (await assistants(t, chatId)).length;
    await t.mutation(internal.stream.startAssistant, { chatId, runId: GEN1 });
    await c2(ingest, chatId, parentId, false);
    await generation(t, parentId, GEN1, "Je relance.");
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: GEN2 });
    expect(opened).not.toBe(parentId);
    expect(await assistants(t, chatId)).toHaveLength(before + 1);
  });

  test("the ingest refuses a declared limit that is not a whole, bounded number of seconds", async () => {
    const t = convexTest(schema, modules);
    const { chatId, ingest } = await seedProd(t);
    const cases: Array<[string, unknown, number | undefined]> = [
      ["agent:files:subagent:ok", 900, 900],
      ["agent:files:subagent:zero", 0, 0],
      ["agent:files:subagent:frac", 12.5, undefined],
      ["agent:files:subagent:neg", -1, undefined],
      ["agent:files:subagent:str", "900", undefined],
      ["agent:files:subagent:huge", 8 * 24 * 3600, undefined],
    ];
    for (const [key, v] of cases) {
      await ingest({ op: "upsertSubAgent", chatId, childSessionKey: key, runTimeoutSeconds: v, status: "running" });
    }
    for (const [key, , stored] of cases) {
      const row = await t.run((ctx) =>
        ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", key)).first(),
      );
      expect(row?.runTimeoutSeconds, key).toBe(stored);
    }
    // A registration write that went out without it (or was lost) is repaired by the
    // terminal write that re-carries it — and never re-pointed afterwards.
    const late = "agent:files:subagent:late";
    await ingest({ op: "upsertSubAgent", chatId, childSessionKey: late, status: "running" });
    await ingest({ op: "upsertSubAgent", chatId, childSessionKey: late, runTimeoutSeconds: 600, status: "error" });
    await ingest({ op: "upsertSubAgent", chatId, childSessionKey: late, runTimeoutSeconds: 30, status: "error" });
    const lateRow = await t.run((ctx) =>
      ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", late)).first(),
    );
    expect(lateRow?.runTimeoutSeconds).toBe(600);
  });
});

// PARALLEL spawns inside a continuation: the bridge cannot tell which spawn each child
// matches, so it anchors NONE of them — but the run they were spawned in is certain and
// rides as `bornOfRun`. That run wrote to one bubble; the join resolves through it, and
// confirms it on the bubble itself (the run is the bubble's run or one it merged).
describe("children spawned together inside a continuation join through their carrier run", () => {
  const C2A = "agent:files:subagent:1111aaaa-0000-4000-8000-000000000001";
  const C2B = "agent:files:subagent:2222bbbb-0000-4000-8000-000000000002";
  const C2A_RUN = "a1a1a1a1-0000-4000-8000-000000000001";
  const C2B_RUN = "b2b2b2b2-0000-4000-8000-000000000002";

  async function parallelChildren(t: T, chatId: Id<"chats">, parentId: Id<"messages">, carrier: string) {
    await childSpawnedInContinuation(t, chatId, parentId, carrier, { key: C2A, runId: C2A_RUN, anchored: false });
    await childSpawnedInContinuation(t, chatId, parentId, carrier, { key: C2B, runId: C2B_RUN, anchored: false });
  }

  test("the carrier merged into B: the next continuation merges into B", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await parallelChildren(t, chatId, parentId, PROD_SETTLE);
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Deux relectures lancées.", expectedRunId: PROD_SETTLE });
    const next = settleRun([C2A_RUN, C2B_RUN].sort());
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: next })).toBe(parentId);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.continuations?.map((c) => c.childRunIds)).toEqual([[CHILD_RUN], [C2A_RUN, C2B_RUN].sort()]);
  });

  test("a carrier that never merged here (its own bubble): fails closed", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    // The carrier names the known child, but it did NOT run on B — B holds no trace of it.
    await parallelChildren(t, chatId, parentId, PROD_SETTLE);
    const next = settleRun([C2A_RUN, C2B_RUN].sort());
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: next })).not.toBe(parentId);
  });

  test("a carrier that is a settle wake WITHOUT a yield (it merges nowhere): fails closed", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    const noYield = settleRun([CHILD_RUN], "");
    await t.run((ctx) => ctx.db.patch(parentId, { mergedAnnounceRuns: [noYield] }));
    await parallelChildren(t, chatId, parentId, noYield);
    const next = settleRun([C2A_RUN, C2B_RUN].sort());
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: next })).not.toBe(parentId);
  });

  test("a HEURISTIC anchor with a carrier is still refused", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "x", expectedRunId: PROD_SETTLE });
    // The bridge's positional fallback: an anchor, but not a correlated one.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      parentMessageId: parentId,
      childSessionKey: C2A,
      childRunId: C2A_RUN,
      bornOfRun: PROD_SETTLE,
      status: "done",
    });
    expect(
      await t.mutation(internal.stream.startAssistant, { chatId, runId: settleRun([C2A_RUN]) }),
    ).not.toBe(parentId);
  });
});

// Codex pass 1 (P3): a chain of successive continuations, each re-delegating to
// children spawned TOGETHER (no direct anchor — only their carrier run). Resolving
// generation N used to re-walk the whole chain back to the turn's own child, one
// carrier per generation, under a depth cap: long enough, the chain fell off the cap
// and the delivery opened a new bubble. The resolved anchor is now recorded on the
// members at each successful join, so the next generation needs one hop.
describe("a long chain of parallel re-delegations stays in ONE bubble", () => {
  test("eight generations, every batch spawned in parallel without a direct anchor", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    const before = (await assistants(t, chatId)).length;
    let carrier = PROD_SETTLE; // generation 1: the turn's own child, exactly anchored
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: carrier })).toBe(parentId);
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "g1", expectedRunId: carrier });
    for (let g = 2; g <= 8; g++) {
      const ids = [`g${g}a-0000-4000-8000-000000000001`, `g${g}b-0000-4000-8000-000000000002`];
      for (const [i, id] of ids.entries()) {
        await childSpawnedInContinuation(t, chatId, parentId, carrier, {
          key: `agent:files:subagent:g${g}-${i}`,
          runId: id,
          anchored: false,
        });
      }
      const next = settleRun([...ids].sort());
      const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: next });
      expect(opened, `generation ${g}`).toBe(parentId);
      await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: `g${g}`, expectedRunId: next });
      carrier = next;
    }
    expect(await assistants(t, chatId)).toHaveLength(before);
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.continuations).toHaveLength(8);
    // The joined members now carry the anchor they were proven to belong to.
    const rows = await t.run((ctx) =>
      ctx.db.query("subAgents").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
    );
    for (const r of rows) {
      expect(r.parentMessageId, r.childSessionKey).toBe(parentId);
      expect(r.anchorExact, r.childSessionKey).toBe(true);
    }
  });
});
