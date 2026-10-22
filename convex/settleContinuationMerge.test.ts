// A YIELDED TURN'S CONTINUATION, AND THE REPLAY OF ONE 0.96.0 MERGED.
//
// Since 0.102.0 a continuation opens its OWN bubble, grouped with its turn by the
// display (displayGroups.regroup, `chainRoot`) — no continuation merges into the
// yielded turn's bubble any more. What remains of 0.96.0's merge is its REPLAY: a
// bubble a continuation was merged into is still in the data, and a retry wake or a
// rebroadcast of that batch must stay idempotent on it (`seedLegacySettleMerge`). The
// history below is 0.96.0's.
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

import { convexTest } from "convex-test";
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

  test("a heuristic (non-exact) anchor on a bubble the conversation moved past", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId, userId } = await seedYieldedTurn(t, {
      children: [{ key: CHILD_KEY, runId: CHILD_RUN, anchorExact: false }],
    });
    // A positional anchor is a guess: it never makes the wake land in that bubble.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Et ensuite ?",
        updatedAt: 3000,
      }),
    );
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
    // Delivered: its own bubble (a continuation never reopens the turn's since 0.102.0).
    expect(opened).not.toBeNull();
    expect(opened).not.toBe(parentId);
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
describe("a retry wake of a batch 0.96.0 already merged", () => {
  const RETRY = settleRun([CHILD_RUN], ":yield-1:retry-1");
  const SECOND = settleRun([CHILD_RUN_2]);
  const PREFIX = "Je délègue.";

  /** The yielded turn's bubble as 0.96.0 left it after merging `batches` (the last one
   *  owning it): the bubble took the last wake's run, recorded every merged run and one
   *  continuation position per batch, kept the turn's own words parked as the prefix
   *  while the last merge was not settled complete, and was stamped a turn. */
  async function seedLegacySettleMerge(
    t: T,
    state: {
      status: "complete" | "error" | "streaming";
      answers: string[];
      batches?: Array<{ run: string; childRunIds: string[] }>;
    },
  ) {
    const seeded = await seedYieldedTurn(t, { parentText: PREFIX });
    const batches = state.batches ?? [{ run: PROD_SETTLE, childRunIds: [CHILD_RUN] }];
    // A second batch's child was spawned inside the first continuation (its carrier).
    if (batches.length > 1) await childSpawnedInContinuation(t, seeded.chatId, seeded.parentId, batches[0]!.run);
    const continuations: Array<{ at: number; childRunIds: string[] }> = [];
    let text = PREFIX;
    batches.forEach((b, i) => {
      continuations.push({ at: text.length + 2, childRunIds: b.childRunIds });
      text = `${text}\n\n${state.answers[i] ?? ""}`;
    });
    const last = batches[batches.length - 1]!;
    const parked = state.status === "complete" ? undefined : text.slice(0, continuations[continuations.length - 1]!.at - 2);
    await t.run((ctx) =>
      ctx.db.patch(seeded.parentId, {
        status: state.status,
        text,
        runId: last.run,
        continuations,
        mergedAnnounceRuns: batches.map((x) => x.run),
        mergedIntoTurn: true,
        ...(parked !== undefined ? { announcePrefix: parked } : {}),
        ...(state.status === "error" ? { error: "provider failed" } : {}),
      }),
    );
    return seeded;
  }

  async function runGeneration(t: T, messageId: Id<"messages">, runId: string, text: string) {
    await t.mutation(internal.stream.appendDelta, { messageId, text, expectedRunId: runId });
    await t.mutation(internal.stream.finalize, { messageId, status: "complete", text, expectedRunId: runId });
  }

  test("after a first wake that ANSWERED: a silent replay — one answer, still complete", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, { status: "complete", answers: ["Réponse."] });
    const before = await t.run((ctx) => ctx.db.get(parentId));
    const bubbles = (await assistants(t, chatId)).length;

    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    expect(opened).toBe(parentId); // handed back as a sink, never a new bubble
    await runGeneration(t, parentId, RETRY, "Réponse bis.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text).toBe(before?.text);
    expect(doc?.status).toBe("complete");
    expect(doc?.runId).toBe(PROD_SETTLE);
    expect(await assistants(t, chatId)).toHaveLength(bubbles);
  });

  test("after a first wake that ENDED IN ERROR: the retry resumes it and completes", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, { status: "error", answers: ["Répo"] });
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
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, { status: "complete", answers: [""] });
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY })).toBe(parentId);
    await runGeneration(t, parentId, RETRY, "Voici la synthèse.");

    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text?.endsWith("Voici la synthèse.")).toBe(true);
    expect(doc?.text?.startsWith("Je délègue.")).toBe(true);
    expect(doc?.status).toBe("complete");
  });

  test("a CRON card the batch wrote is an answer: the retry stays silent", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, { status: "complete", answers: [""] });
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: parentId,
        order: 9,
        part: { kind: "cron" as const, op: "created" as const, jobId: "job-1", name: "Rappel" },
        announceRun: PROD_SETTLE,
      });
    });
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Rappel créé.", expectedRunId: RETRY });
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.text).toBe(settled?.text);
    expect(doc?.runId).toBe(PROD_SETTLE);
  });

  test("a FILE the batch delivered is an answer: the retry stays silent, one file", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, { status: "complete", answers: [""] });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["pdf-v1"])));
    await t.run((ctx) =>
      ctx.db.insert("messageParts", {
        messageId: parentId,
        order: 9,
        announceRun: PROD_SETTLE,
        part: { kind: "media", storageId, filename: "synthese.pdf", mimeType: "application/pdf" },
      }),
    );
    const settled = await t.run((ctx) => ctx.db.get(parentId));
    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await t.mutation(internal.stream.finalize, { messageId: parentId, status: "complete", text: "Voici le PDF.", expectedRunId: RETRY });
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text).toBe(settled?.text);
    expect(doc?.runId).toBe(PROD_SETTLE);
  });

  test("A complete, B in error, a REBROADCAST of A's original run: B's error is left alone (codex pass 13)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, {
      status: "error",
      answers: ["Première.", "Seco"],
      batches: [
        { run: PROD_SETTLE, childRunIds: [CHILD_RUN] },
        { run: SECOND, childRunIds: [CHILD_RUN_2] },
      ],
    });
    const failed = await t.run((ctx) => ctx.db.get(parentId));
    // The REBROADCAST of A's own run (bridge restart), carrying A's answer again.
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE })).toBe(parentId);
    await runGeneration(t, parentId, PROD_SETTLE, "Première rejouée.");
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("error");
    expect(doc?.text).toBe(failed?.text);
    expect(doc?.runId).toBe(SECOND);
  });

  test("…while B's OWN rebroadcast still resumes B", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, {
      status: "error",
      answers: ["Première.", "Seco"],
      batches: [
        { run: PROD_SETTLE, childRunIds: [CHILD_RUN] },
        { run: SECOND, childRunIds: [CHILD_RUN_2] },
      ],
    });
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND })).toBe(parentId);
    await runGeneration(t, parentId, SECOND, "Seconde.");
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("complete");
    expect(doc?.text).toBe("Je délègue.\n\nPremière.\n\nSeconde.");
  });

  test("…and the first batch's retry never RESUMES a later continuation's failure it does not own", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, {
      status: "error",
      answers: ["Première.", "Seco"],
      batches: [
        { run: PROD_SETTLE, childRunIds: [CHILD_RUN] },
        { run: SECOND, childRunIds: [CHILD_RUN_2] },
      ],
    });
    const failed = await t.run((ctx) => ctx.db.get(parentId));
    await t.mutation(internal.stream.startAssistant, { chatId, runId: RETRY });
    await runGeneration(t, parentId, RETRY, "Première bis.");
    const doc = await t.run((ctx) => ctx.db.get(parentId));
    expect(doc?.status).toBe("error");
    expect(doc?.text).toBe(failed?.text);
    expect(doc?.runId).toBe(SECOND);
  });

  test("a NEW batch's wake (never merged here) opens its own bubble beside the legacy merge", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacySettleMerge(t, { status: "complete", answers: ["Réponse."] });
    await childSpawnedInContinuation(t, chatId, parentId, PROD_SETTLE);
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: SECOND });
    expect(opened).not.toBeNull();
    expect(opened).not.toBe(parentId);
    expect((await t.run((ctx) => ctx.db.get(parentId)))?.status).toBe("complete");
  });
});

// A DECLARED TIME LIMIT on a child (`runTimeoutSeconds`), through the real ingest door
// (`/bridge/ingest`, per-bridge secret), in the shape the observer emits
// (bridge/test/sub-agent-timeout.test.ts).
describe("the sub-agent ingest bounds a declared time limit", () => {
  const C1_KEY = "agent:files:subagent:7a1c2e90-4b3d-4f6e-8a21-9c0d1e2f3a4b";
  const C1_RUN = "3e9b7c10-2d4a-4c8e-9f1b-6a5d4c3b2a19";
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

  test("a carrier that is a settle wake WITHOUT a yield and landed NOWHERE: never walked up", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t);
    // A no-yield wake has no requester bubble to belong to, lost or not.
    await parallelChildren(t, chatId, parentId, settleRun([CHILD_RUN], ""));
    const next = settleRun([C2A_RUN, C2B_RUN].sort());
    expect(await t.mutation(internal.stream.startAssistant, { chatId, runId: next })).not.toBe(parentId);
  });

});

// Codex pass 1 (P3): a chain of successive continuations, each re-delegating to
// children spawned TOGETHER (no direct anchor — only their carrier run). Resolving
// generation N used to re-walk the whole chain back to the turn's own child, one
// carrier per generation, under a depth cap: long enough, the chain fell off the cap
// and the delivery opened a new bubble. The resolved anchor is now recorded on the
// members at each successful join, so the next generation needs one hop.
// codex phase 4 pass 12 #3: under the transcript projection (`on`), the transcript may
// record the first wake's ERROR terminal before its replay arrives. The replay of that
// same run must resume the bubble exactly as 0.95.0 does (the `off` run below is the
// reference): reopened, its deltas kept, completed.
describe("a replayed requester-settle after a transcript-recorded error resumes its own bubble", () => {
  test("the wake's OWN bubble resumes and completes with the recovered result, the parent untouched, the run no longer held as settled", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedYieldedTurn(t, { parentText: "Je délègue." });
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "lacneu", gatewayUrl: "ws://gw" });
      await ctx.db.patch(chatId, { transcriptSeenAt: 1 });
    });
    // The wake opens its own bubble.
    const bubbleId = (await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE }))!;
    expect(bubbleId).not.toBe(parentId);
    await t.mutation(internal.stream.appendDelta, { messageId: bubbleId, text: "partial result", expectedRunId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, {
      messageId: bubbleId,
      status: "error",
      text: "partial result",
      error: "provider failed",
      expectedRunId: PROD_SETTLE,
    });
    // The transcript read recorded the run's error terminal (sticky, settled).
    await t.run(async (ctx) => {
      await ctx.db.insert("transcriptRuns", {
        chatId,
        sessionKey: REQUESTER,
        runId: PROD_SETTLE,
        status: "error",
        terminalAt: 3000,
        settledAt: 3000,
        updatedAt: 3000,
      });
    });
    const bubbles = (await assistants(t, chatId)).length;
    // The gateway replays the SAME run (error resume).
    const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId: PROD_SETTLE });
    expect(opened).toBe(bubbleId);
    expect((await t.run((ctx) => ctx.db.get(bubbleId)))?.status).toBe("streaming");
    await t.mutation(internal.stream.appendDelta, { messageId: bubbleId, text: "recovered result", expectedRunId: PROD_SETTLE });
    await t.mutation(internal.stream.finalize, {
      messageId: bubbleId,
      status: "complete",
      text: "recovered result",
      expectedRunId: PROD_SETTLE,
    });
    const doc = await t.run((ctx) => ctx.db.get(bubbleId));
    expect(doc?.status).toBe("complete");
    expect(doc?.errorCode).toBeUndefined();
    expect(doc?.text).toContain("recovered result");
    expect((await t.run((ctx) => ctx.db.get(parentId)))?.text).toBe("Je délègue.");
    expect(await assistants(t, chatId)).toHaveLength(bubbles);
    // The resumed run streams again for the projection: the transcript must not settle
    // the reopened bubble back to its old error before the replay's own terminal.
    const runs = await t.run((ctx) => ctx.db.query("transcriptRuns").collect());
    expect(runs.map((r) => ({ status: r.status, settled: r.settledAt !== undefined }))).toEqual([
      { status: "streaming", settled: false },
    ]);
  });
});
