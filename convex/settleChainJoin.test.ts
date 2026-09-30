// A DELEGATION CHAIN STAYS IN ONE BUBBLE, WHATEVER HAPPENED TO ONE OF ITS LINKS.
//
// Production, 2026-09-29 (instance ataraxis, agent denis, chat mh70qh2y…): a long
// autonomous job. The user turn spawned one child and yielded; each requester-settle
// continuation (`announce:requester-settle:denis:<requesterKey>:<childRunIds>:yield-1`)
// re-delegated IN PARALLEL and yielded again. The first three generations merged into
// bubble ph76fzg3hm (1 spawn, then 2, then 5). The continuation of the five children
// (09:34:41Z, ph73yy2f6s) opened a bubble of its own — and so did EVERY continuation
// after it, twenty of them, each one an empty bubble in the user's view.
//
// Two defects, one after the other:
//   1. THE FIRST BREAK. A continuation spawns its children through item frames only,
//      so the bridge anchors a batch of parallel children by their CARRIER run
//      (`bornOfRun`) and no message — except a child it meets without a sighting to
//      claim, which it anchors to the session's last-known message WITHOUT
//      `anchorExact` (the positional fallback, sub-agent-observer.ts lazy registration).
//      Production row 24152ba9 is exactly that: aborted at 09:34:26Z, 15 s before the
//      five-child continuation started, `parentMessageId: ph76fzg3hm`,
//      `anchorExact: false` — and the only spawns between the previous continuation
//      (09:01Z) and that one were the five. ONE such member vetoed the whole join,
//      though every member of a yielded batch comes from the same requester turn by
//      construction (subagent-registry-requester-yield.ts:180-188 at v2026.9.6).
//   2. THE CASCADE. The next batch's children were born of that continuation. Its
//      bubble was found only by re-running the continuation's OWN join and checking
//      the run had merged there — which it never had. So the chain could never recover:
//      one broken link broke every link after it.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
// Under the full suite the first test of a file pays the cold module load.

const REQUESTER = "agent:denis:atrium:chat:denis.crozet:mh70qh2y70e9yg1r4vneamh0qx8f9x2t";
const settleRun = (ids: string[], suffix = ":yield-1") =>
  `announce:requester-settle:denis:${REQUESTER}:${[...ids].sort().join(",")}${suffix}`;
const runIdOf = (g: number, i: number) =>
  `${String(g).padStart(4, "0")}${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`;
const keyOf = (g: number, i: number) => `agent:denis:subagent:g${g}-c${i}`;

type T = ReturnType<typeof convexTest>;

/** The user turn: one exactly anchored child, spawn + yield, no text (production). */
async function seedTurn(t: T) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "denis" });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "ataraxis",
      agentId: "denis",
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Continue le traitement du dossier",
      updatedAt: 1000,
    });
    const bubble = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "",
      runId: "webchat-1635935a",
      finalizedAt: 2000,
      updatedAt: 2000,
    });
    await ctx.db.insert("subAgents", {
      chatId,
      parentMessageId: bubble,
      anchorExact: true,
      childSessionKey: keyOf(1, 0),
      childRunId: runIdOf(1, 0),
      status: "done" as const,
      createdAt: 1800,
      updatedAt: 2500,
    });
    return { userId, chatId, bubble };
  });
}

type Shape = "carrier" | "heuristic" | "none";

/** A child spawned INSIDE `carrierRun`, written through the mutation the bridge
 *  ingest calls, in the shape the observer emits for it:
 *   - "carrier": part of an ambiguous batch — no anchor, the carrier run;
 *   - "heuristic": met without a sighting — the last-known message, no
 *     `anchorExact`, no carrier (production row 24152ba9);
 *   - "none": nothing but its run id. */
async function child(
  t: T,
  chatId: Id<"chats">,
  carrierRun: string,
  key: string,
  runId: string,
  shape: Shape,
  heuristicAnchor?: Id<"messages">,
) {
  const identity = {
    chatId,
    childSessionKey: key,
    childRunId: runId,
    ...(shape === "heuristic" && heuristicAnchor !== undefined
      ? { parentMessageId: heuristicAnchor }
      : {}),
  };
  await t.mutation(internal.subAgents.upsertSubAgent, {
    ...identity,
    ...(shape === "carrier" ? { bornOfRun: carrierRun } : {}),
    status: "running",
    phase: "start",
  });
  await t.mutation(internal.subAgents.upsertSubAgent, { ...identity, status: "done" });
}

async function assistantCount(t: T, chatId: Id<"chats">) {
  return t.run(async (ctx) =>
    (await ctx.db.query("messages").collect()).filter(
      (m) => m.chatId === chatId && m.role === "assistant",
    ).length,
  );
}

/** One continuation as production ran it: it re-delegates and yields (its own,
 *  stamped `sessions_yield` — the hand-off), says nothing (textLen 0), finalizes. */
async function runContinuation(t: T, chatId: Id<"chats">, runId: string) {
  const opened = await t.mutation(internal.stream.startAssistant, { chatId, runId });
  if (opened !== null) {
    await t.mutation(internal.stream.addPart, {
      messageId: opened,
      expectedRunId: runId,
      part: {
        kind: "tool" as const,
        name: "sessions_yield",
        phase: "completed",
        output: { details: { status: "yielded" } },
      },
    });
    await t.mutation(internal.stream.finalize, {
      messageId: opened,
      status: "complete",
      text: "",
      expectedRunId: runId,
    });
  }
  return opened;
}

describe("the production chain, reproduced (chat mh70qh2y…, 2026-09-29)", { timeout: 30_000 }, () => {
  test("1 → 2 → 5 parallel re-delegations with ONE positional member: every continuation joins the turn's bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    const before = await assistantCount(t, chatId);

    // Generation 1: the turn's own child — exact anchor (spawn result on the turn).
    const g1 = settleRun([runIdOf(1, 0)]);
    expect(await runContinuation(t, chatId, g1)).toBe(bubble);

    // Generation 2: two children spawned together inside g1 (carrier only).
    for (let i = 0; i < 2; i++) await child(t, chatId, g1, keyOf(2, i), runIdOf(2, i), "carrier");
    const g2 = settleRun([runIdOf(2, 0), runIdOf(2, 1)]);
    expect(await runContinuation(t, chatId, g2)).toBe(bubble);

    // Generation 3: five children spawned together inside g2 — four carried, one met
    // without a sighting and positionally anchored (the 24152ba9 shape).
    for (let i = 0; i < 4; i++) await child(t, chatId, g2, keyOf(3, i), runIdOf(3, i), "carrier");
    await child(t, chatId, g2, keyOf(3, 4), runIdOf(3, 4), "heuristic", bubble);
    const g3 = settleRun([0, 1, 2, 3, 4].map((i) => runIdOf(3, i)));
    expect(await runContinuation(t, chatId, g3)).toBe(bubble);

    // Generation 4: three children spawned together inside g3.
    for (let i = 0; i < 3; i++) await child(t, chatId, g3, keyOf(4, i), runIdOf(4, i), "carrier");
    const g4 = settleRun([0, 1, 2].map((i) => runIdOf(4, i)));
    expect(await runContinuation(t, chatId, g4)).toBe(bubble);

    expect(await assistantCount(t, chatId)).toBe(before);
    const doc = await t.run((ctx) => ctx.db.get(bubble));
    expect(doc?.continuations).toHaveLength(4);
    // Every member the joins proved now sits under the bubble, exactly.
    const rows = await t.run((ctx) =>
      ctx.db.query("subAgents").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
    );
    for (const r of rows) {
      expect(r.parentMessageId, r.childSessionKey).toBe(bubble);
      expect(r.anchorExact, r.childSessionKey).toBe(true);
    }
  });
});

describe("a broken link does not break the links after it", { timeout: 30_000 }, () => {
  test("the carrier opened a bubble of its own: the next continuation joins THAT bubble, not a third", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    const g1 = settleRun([runIdOf(1, 0)]);
    expect(await runContinuation(t, chatId, g1)).toBe(bubble);
    // g2's members are unknown to Convex (their spawn never reached us): g2 cannot
    // join and opens bubble X — the first break, whatever its cause.
    const g2 = settleRun([runIdOf(2, 0), runIdOf(2, 1)]);
    const x = await runContinuation(t, chatId, g2);
    expect(x).not.toBeNull();
    expect(x).not.toBe(bubble);
    // g2 re-delegated in parallel; their continuation belongs where g2 wrote.
    for (let i = 0; i < 3; i++) await child(t, chatId, g2, keyOf(3, i), runIdOf(3, i), "carrier");
    const before = await assistantCount(t, chatId);
    const g3 = settleRun([0, 1, 2].map((i) => runIdOf(3, i)));
    expect(await runContinuation(t, chatId, g3)).toBe(x);
    expect(await assistantCount(t, chatId)).toBe(before);
  });

  test("the carrier was merged and then ROTATED off the bubble by a sibling batch: found through the merge record", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    const g1 = settleRun([runIdOf(1, 0)]);
    expect(await runContinuation(t, chatId, g1)).toBe(bubble);
    // g1 spawned four children in parallel; they settle as TWO wakes (production:
    // ph77vqr3v3 and ph78r9agkw both continue ph70ehytq3). The first rotates the
    // bubble's run away from g1.
    for (let i = 0; i < 4; i++) await child(t, chatId, g1, keyOf(2, i), runIdOf(2, i), "carrier");
    const first = settleRun([runIdOf(2, 0), runIdOf(2, 1)]);
    expect(await runContinuation(t, chatId, first)).toBe(bubble);
    const second = settleRun([runIdOf(2, 2), runIdOf(2, 3)]);
    expect(await runContinuation(t, chatId, second)).toBe(bubble);
  });

  test("a carrier that opened its OWN bubble and was rotated off it by a sibling wave: still found there", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    // g2 cannot join (its members never reached us): it opens W and spawns four.
    const g2 = settleRun([runIdOf(2, 0), runIdOf(2, 1)]);
    const w = await runContinuation(t, chatId, g2);
    expect(w).not.toBe(bubble);
    for (let i = 0; i < 4; i++) await child(t, chatId, g2, keyOf(3, i), runIdOf(3, i), "carrier");
    // The first wave takes W over; the second must still find where g2 wrote.
    expect(await runContinuation(t, chatId, settleRun([runIdOf(3, 0), runIdOf(3, 1)]))).toBe(w);
    expect(await runContinuation(t, chatId, settleRun([runIdOf(3, 2), runIdOf(3, 3)]))).toBe(w);
  });

  // Codex pass 1 (P1): the carrier is found through a DURABLE record of where it
  // wrote, never inferred from a bounded scan. Here its merge was refused (the turn's
  // bubble was busy), it opened W, a sibling wave took W over, and forty messages
  // later W has left any scan window. Re-deriving the carrier's own join would land
  // its children in the turn's bubble A — where the carrier never wrote.
  test("a carrier that opened its own bubble, was rotated off it and scrolled far away: still THAT bubble, never the original", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seedTurn(t);
    // g1's member is exactly A's — but A is busy when g1 starts, so g1 opens W.
    const g1 = settleRun([runIdOf(1, 0)]);
    await t.run((ctx) => ctx.db.patch(bubble, { status: "streaming" as const }));
    const w = await runContinuation(t, chatId, g1);
    await t.run((ctx) => ctx.db.patch(bubble, { status: "complete" as const }));
    expect(w).not.toBeNull();
    expect(w).not.toBe(bubble);
    for (let i = 0; i < 4; i++) await child(t, chatId, g1, keyOf(2, i), runIdOf(2, i), "carrier");
    expect(await runContinuation(t, chatId, settleRun([runIdOf(2, 0), runIdOf(2, 1)]))).toBe(w);
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          status: "complete" as const,
          text: `filler ${i}`,
          updatedAt: 5000 + i,
        });
      }
    });
    expect(await runContinuation(t, chatId, settleRun([runIdOf(2, 2), runIdOf(2, 3)]))).toBe(w);
  });

  test("a carrier Convex has NO record of: unknown is never \"lost\" — its children's continuation fails closed", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    // g1 never opened or merged into anything here (lost, or silent: Convex cannot
    // tell the two apart). Its children are placed nowhere by guesswork.
    const g1 = settleRun([runIdOf(1, 0)]);
    for (let i = 0; i < 2; i++) await child(t, chatId, g1, keyOf(2, i), runIdOf(2, i), "carrier");
    const g2 = settleRun([runIdOf(2, 0), runIdOf(2, 1)]);
    expect(await runContinuation(t, chatId, g2)).not.toBe(bubble);
    const doc = await t.run((ctx) => ctx.db.get(bubble));
    expect(doc?.runId).toBe("webchat-1635935a");
  });
});

describe("the evidence a member carries, ranked", { timeout: 30_000 }, () => {
  // Codex pass 3 (P1): a positional anchor is neutral, never deciding — a wrong
  // merge is worse than a separate bubble.
  test("a positional anchor alone never joins, even on the conversation's last bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    await child(t, chatId, "webchat-x", keyOf(2, 0), runIdOf(2, 0), "heuristic", bubble);
    expect(await runContinuation(t, chatId, settleRun([runIdOf(2, 0)]))).not.toBe(bubble);
  });

  test("turn A's child registered late against turn B's answer: A's continuation never lands in B", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble: a, userId } = await seedTurn(t);
    // The user moved on; turn B answered and is the conversation's last bubble.
    const b = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Autre question",
        updatedAt: 3000,
      });
      return ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Réponse du tour B.",
        runId: "webchat-turn-b",
        finalizedAt: 3500,
        updatedAt: 3500,
      });
    });
    // A's child, met by the bridge only now: the session's last-known message is B.
    await child(t, chatId, "webchat-1635935a", keyOf(2, 0), runIdOf(2, 0), "heuristic", b);
    const opened = await runContinuation(t, chatId, settleRun([runIdOf(2, 0)]));
    expect(opened).not.toBe(b);
    expect(opened).not.toBe(a);
    const doc = await t.run((ctx) => ctx.db.get(b));
    expect(doc?.runId).toBe("webchat-turn-b");
    expect(doc?.text).toBe("Réponse du tour B.");
  });

  test("…and never once the conversation moved past it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seedTurn(t);
    await child(t, chatId, "webchat-x", keyOf(2, 0), runIdOf(2, 0), "heuristic", bubble);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Autre chose",
        updatedAt: 3000,
      }),
    );
    expect(await runContinuation(t, chatId, settleRun([runIdOf(2, 0)]))).not.toBe(bubble);
  });

  test("two positional anchors that disagree: no join", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seedTurn(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "older",
        runId: "webchat-older",
        updatedAt: 1500,
      }),
    );
    await child(t, chatId, "webchat-x", keyOf(2, 0), runIdOf(2, 0), "heuristic", bubble);
    await child(t, chatId, "webchat-x", keyOf(2, 1), runIdOf(2, 1), "heuristic", other);
    expect(
      await runContinuation(t, chatId, settleRun([runIdOf(2, 0), runIdOf(2, 1)])),
    ).not.toBe(bubble);
  });

  test("exact evidence outranks a positional guess pointing elsewhere", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seedTurn(t);
    const g1 = settleRun([runIdOf(1, 0)]);
    expect(await runContinuation(t, chatId, g1)).toBe(bubble);
    const stray = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        runId: "webchat-stray",
        updatedAt: 1500,
      }),
    );
    await child(t, chatId, g1, keyOf(2, 0), runIdOf(2, 0), "carrier");
    await child(t, chatId, g1, keyOf(2, 1), runIdOf(2, 1), "heuristic", stray);
    expect(await runContinuation(t, chatId, settleRun([runIdOf(2, 0), runIdOf(2, 1)]))).toBe(bubble);
  });

  test("two EXACT resolutions that disagree still refuse the join", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seedTurn(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "older",
        runId: "webchat-older",
        updatedAt: 1500,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: other,
        anchorExact: true,
        childSessionKey: keyOf(1, 1),
        childRunId: runIdOf(1, 1),
        status: "done" as const,
        createdAt: 1800,
        updatedAt: 2500,
      }),
    );
    expect(
      await runContinuation(t, chatId, settleRun([runIdOf(1, 0), runIdOf(1, 1)])),
    ).not.toBe(bubble);
  });
});

describe("width and depth", { timeout: 30_000 }, () => {
  test("twelve generations, each fanning out to 16 children, one of them positional: one bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedTurn(t);
    const before = await assistantCount(t, chatId);
    let carrier = settleRun([runIdOf(1, 0)]);
    expect(await runContinuation(t, chatId, carrier)).toBe(bubble);
    for (let g = 2; g <= 13; g++) {
      const ids: string[] = [];
      for (let i = 0; i < 16; i++) {
        const shape: Shape = i === 7 ? "heuristic" : "carrier";
        await child(t, chatId, carrier, keyOf(g, i), runIdOf(g, i), shape, bubble);
        ids.push(runIdOf(g, i));
      }
      const next = settleRun(ids);
      expect(await runContinuation(t, chatId, next), `generation ${g}`).toBe(bubble);
      carrier = next;
    }
    expect(await assistantCount(t, chatId)).toBe(before);
  });
});
