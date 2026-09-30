// A SILENT CONTINUATION IN THE MIDDLE OF A DELEGATION IS NOT A FAILED DELIVERY.
//
// Production, 2026-09-29 (instance ataraxis, agent denis, chat mh70qh2y…): two
// requester-settle continuations ran only bookkeeping tools — ph77vqr3v3 one `exec`,
// ph7ajwt1ej read/edit/exec — said nothing, and were closed by the bridge's
// lifecycle-end grace (`finalizeCause: lifecycle_end_timeout`). Convex's "the
// delivery brought nothing" rule painted both red (`empty_response`), though the
// chain went on for hours and upstream asks a yielded turn's continuation for its
// visible answer only "after the requested outcome is complete or genuinely blocked"
// (subagent-announce.requester-settle-message.ts:44-45 at v2026.9.6).
//
// Merged into the turn's bubble, the same verdict is worse: an `error` bubble refuses
// every later continuation (the reopen only takes a complete one), so the chain falls
// apart into one bubble per continuation.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
// Under the full suite the first test of a file pays the cold module load.

const REQUESTER = "agent:denis:atrium:chat:denis.crozet:mh70qh2y70e9yg1r4vneamh0qx8f9x2t";
const settleRun = (ids: string[], suffix = ":yield-1") =>
  `announce:requester-settle:denis:${REQUESTER}:${[...ids].sort().join(",")}${suffix}`;
const RUN = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const KEY = (n: number) => `agent:denis:subagent:child-${n}`;

type T = ReturnType<typeof convexTest>;

/** The user turn: bubble A, spawn + yield, no text; its child 1 settled, exactly anchored. */
async function seed(t: T) {
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
      text: "Traite le dossier",
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
      childSessionKey: KEY(1),
      childRunId: RUN(1),
      status: "done" as const,
      createdAt: 1800,
      updatedAt: 2500,
    });
    return { userId, chatId, bubble };
  });
}

async function childRow(
  t: T,
  chatId: Id<"chats">,
  n: number,
  status: "running" | "done",
  anchor?: Id<"messages">,
  extra?: { bornOfRun?: string; positional?: boolean },
) {
  await t.run((ctx) =>
    ctx.db.insert("subAgents", {
      chatId,
      ...(anchor !== undefined
        ? { parentMessageId: anchor, ...(extra?.positional === true ? {} : { anchorExact: true }) }
        : {}),
      ...(extra?.bornOfRun !== undefined ? { bornOfRun: extra.bornOfRun } : {}),
      childSessionKey: KEY(n),
      childRunId: RUN(n),
      status,
      createdAt: 2600,
      updatedAt: 2700,
    }),
  );
}

type ToolPart = { name: string; output?: unknown };

/** One continuation that ran `tools` (item-derived cards, stamped with its run),
 *  said nothing, and was closed by the lifecycle-end grace. */
async function silentContinuation(
  t: T,
  chatId: Id<"chats">,
  runId: string,
  tools: ToolPart[],
) {
  const messageId = await t.mutation(internal.stream.startAssistant, { chatId, runId });
  expect(messageId).not.toBeNull();
  for (const tool of tools) {
    await t.mutation(internal.stream.addPart, {
      messageId: messageId!,
      expectedRunId: runId,
      part: {
        kind: "tool" as const,
        name: tool.name,
        phase: "completed",
        ...(tool.output !== undefined ? { output: tool.output } : {}),
      },
    });
  }
  await t.mutation(internal.stream.finalize, {
    messageId: messageId!,
    status: "complete",
    text: "",
    expectedRunId: runId,
    finalizeCause: "lifecycle_end_timeout",
  });
  return (await t.run((ctx) => ctx.db.get(messageId!))) as Doc<"messages">;
}

const BOOKKEEPING: ToolPart[] = [{ name: "read" }, { name: "edit" }, { name: "exec" }];

describe("the chain still under way: no failure", { timeout: 30_000 }, () => {
  test("a child of this bubble is still running (ph77vqr3v3 / ph7ajwt1ej shape)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    await childRow(t, chatId, 2, "running", bubble);
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(m._id).toBe(bubble); // merged into the turn's bubble
    expect(m.status).toBe("complete");
    expect(m.errorCode).toBeUndefined();
    expect(m.finalizeCause).toBe("lifecycle_end_timeout");
  });

  test("a child spawned in a run that wrote to this bubble is still running (a parallel batch: carrier only)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    // An earlier continuation of the chain merged here and spawned in parallel.
    const earlier = settleRun([RUN(1)]);
    const first = await silentContinuation(t, chatId, earlier, [
      { name: "sessions_yield", output: { details: { status: "yielded" } } },
    ]);
    expect(first._id).toBe(bubble);
    await childRow(t, chatId, 3, "done", bubble);
    await childRow(t, chatId, 4, "running", undefined, { bornOfRun: earlier });
    const m = await silentContinuation(t, chatId, settleRun([RUN(3)]), BOOKKEEPING);
    expect(m._id).toBe(bubble);
    expect(m.status).toBe("complete");
  });

  test("the continuation delegated again (an accepted spawn IT wrote), nothing running yet", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), [
      { name: "exec" },
      // A continuation spawns through item frames: no result at all.
      { name: "sessions_spawn" },
    ]);
    expect(m.status).toBe("complete");
    expect(m.errorCode).toBeUndefined();
  });
});

describe("the chain ends with nothing: the verdict stands", { timeout: 30_000 }, () => {
  test("no text, no file, no further delegation, nothing running", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await childRow(t, chatId, 2, "done");
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(m.status).toBe("error");
    expect(m.errorCode).toBe("empty_response");
  });

  test("a running child of ANOTHER turn does not hide it: exact to another bubble, carried by an unrelated run, or only positional", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seed(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Une autre réponse.",
        runId: "webchat-other",
        updatedAt: 1500,
      }),
    );
    await childRow(t, chatId, 2, "running", other);
    await childRow(t, chatId, 3, "running", undefined, { bornOfRun: settleRun([RUN(9)]) });
    await childRow(t, chatId, 4, "running", bubble, { positional: true });
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(m._id).toBe(bubble);
    expect(m.status).toBe("error");
    expect(m.errorCode).toBe("empty_response");
  });

  // Codex pass 3 (P3): the bubble's runs are never listed under a cap; each running
  // child's birth run is looked up where it wrote.
  test("a running child born of a run the bubble no longer names (rotated past its merge list): still this delegation", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    // Seventy runs wrote to this bubble BEFORE the one we need — a listing of the
    // bubble's runs capped below that stops short of it — and later merges pushed
    // it out of the bubble's bounded merge list.
    const filler = Array.from({ length: 70 }, (_, i) => `announce:v1:${KEY(500 + i)}:${RUN(500 + i)}`);
    await t.run(async (ctx) => {
      for (const run of filler) {
        await ctx.db.insert("runBubbles", { chatId, runId: run, messageId: bubble, createdAt: 1 });
      }
    });
    const earlier = settleRun([RUN(1)]);
    const first = await silentContinuation(t, chatId, earlier, [
      { name: "sessions_yield", output: { details: { status: "yielded" } } },
    ]);
    expect(first._id).toBe(bubble);
    await t.run((ctx) => ctx.db.patch(bubble, { mergedAnnounceRuns: filler.slice(-50) }));
    await childRow(t, chatId, 3, "done", bubble);
    await childRow(t, chatId, 4, "running", undefined, { bornOfRun: earlier });
    const m = await silentContinuation(t, chatId, settleRun([RUN(3)]), BOOKKEEPING);
    expect(m._id).toBe(bubble);
    expect(m.status).toBe("complete");
  });

  test("…unless more children run than the probe reads: inconclusive never names a failure", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    for (let n = 100; n < 165; n++) await childRow(t, chatId, n, "running");
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(m.status).toBe("complete");
  });

  test("a REFUSED spawn delegated nothing", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), [
      { name: "sessions_spawn", output: { details: { status: "forbidden" } } },
    ]);
    expect(m.status).toBe("error");
    expect(m.errorCode).toBe("empty_response");
  });

  test("a spawn the TURN wrote (not this continuation) is not this run's delegation", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("messageParts", {
        messageId: bubble,
        order: 0,
        part: { kind: "tool" as const, name: "sessions_spawn", phase: "completed" },
      }),
    );
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), [{ name: "exec" }]);
    expect(m.status).toBe("error");
  });

  test("a running child does not excuse a DIFFERENT delivery family (a child's announce)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await childRow(t, chatId, 2, "running");
    const m = await silentContinuation(t, chatId, `announce:v1:${KEY(9)}:${RUN(9)}`, [
      { name: "exec" },
    ]);
    expect(m.status).toBe("error");
    expect(m.errorCode).toBe("empty_response");
  });
});

/** Was the verdict on `messageId`'s run taken back (the paired trace)? */
async function repaired(t: T, runId: string | undefined) {
  const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
  return traces.some(
    (e) =>
      e.kind === "assistant.stream" &&
      e.runId === runId &&
      JSON.parse(e.meta ?? "{}").phase === "finalize_repaired",
  );
}

async function statusOf(t: T, id: Id<"messages">) {
  return ((await t.run((ctx) => ctx.db.get(id))) as Doc<"messages"> | null)?.status;
}

// Only a wave PROVEN to continue the same bubble takes the verdict back: an exact
// join of a yielded wave to the bubble that carries it (codex pass 1, P2). A delayed
// wave of another turn must never erase the card of a continuation that really ended
// with nothing.
describe("a wave linked to the silent bubble takes its verdict back", { timeout: 30_000 }, () => {
  test("merged into the turn's bubble: the chain's next continuation joins it, the verdict is repaired", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    const silent = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(silent._id).toBe(bubble);
    expect(silent.status).toBe("error");
    // A sibling wave of the turn (exactly anchored to it), queued behind it.
    await childRow(t, chatId, 3, "done", bubble);
    const opened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([RUN(3)]),
    });
    expect(opened).toBe(bubble);
    const doc = await t.run((ctx) => ctx.db.get(bubble));
    expect(doc?.status).toBe("streaming");
    expect(doc?.errorCode).toBeUndefined();
    expect(doc?.error).toBeUndefined();
    expect(await repaired(t, silent.runId)).toBe(true);
  });

  test("…even once the conversation moved past the chain's bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble, userId } = await seed(t);
    const silent = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(silent.status).toBe("error");
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Où en es-tu ?",
        updatedAt: 9000,
      }),
    );
    await childRow(t, chatId, 3, "done", bubble);
    expect(
      await t.mutation(internal.stream.startAssistant, { chatId, runId: settleRun([RUN(3)]) }),
    ).toBe(bubble);
  });
});

describe("a wave NOT linked to the silent bubble leaves its verdict alone", { timeout: 30_000 }, () => {
  test("a wave whose children belong nowhere known (another turn's, delayed): the card stays", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    // Members unknown to Convex: this continuation keeps a bubble of its own, and
    // it really ended with nothing.
    const silent = await silentContinuation(t, chatId, settleRun([RUN(5), RUN(6)]), BOOKKEEPING);
    expect(silent.status).toBe("error");
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([RUN(7), RUN(8)]),
    });
    expect(await statusOf(t, silent._id)).toBe("error");
    expect(await repaired(t, silent.runId)).toBe(false);
  });

  test("a wave linked only POSITIONALLY to it: a guess proves nothing — the card stays", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const silent = await silentContinuation(t, chatId, settleRun([RUN(5)]), BOOKKEEPING);
    // The bridge's positional fallback: the last-known message, no `anchorExact`.
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: silent._id,
        childSessionKey: KEY(7),
        childRunId: RUN(7),
        status: "done" as const,
        createdAt: 2600,
        updatedAt: 2700,
      }),
    );
    const opened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([RUN(7)]),
    });
    expect(opened).not.toBe(silent._id);
    expect(await statusOf(t, silent._id)).toBe("error");
  });

  test("a wake WITHOUT a yield: its batch may span several turns — the card stays", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const silent = await silentContinuation(t, chatId, settleRun([RUN(5)]), BOOKKEEPING);
    await childRow(t, chatId, 7, "done", silent._id);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([RUN(7)], ""),
    });
    expect(await statusOf(t, silent._id)).toBe("error");
    expect(await repaired(t, silent.runId)).toBe(false);
  });

  test("never a GATEWAY's own failure, even exactly linked: only the verdict this platform stamps", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await seed(t);
    const failed = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        runId: settleRun([RUN(5)]),
        errorCode: "empty_response",
        error: "The agent returned an empty response.",
        updatedAt: 3000,
      }),
    );
    await childRow(t, chatId, 7, "done", failed);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: settleRun([RUN(7)]) });
    expect(await statusOf(t, failed)).toBe("error");
  });

  test("never by another delivery family (a child's own announce)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const silent = await silentContinuation(t, chatId, settleRun([RUN(5)]), BOOKKEEPING);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `announce:v1:${KEY(9)}:${RUN(9)}`,
    });
    expect(await statusOf(t, silent._id)).toBe("error");
  });

  // Codex pass 2 (P1): a late REPLAY of an older wave is refused by the ownership
  // gates — and must not erase, on its way out, the verdict a NEWER wave earned.
  test("a late replay (and a retry) of an OLDER wave never erases a newer wave's verdict", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    const older = settleRun([RUN(1)]);
    const first = await silentContinuation(t, chatId, older, [
      { name: "sessions_yield", output: { details: { status: "yielded" } } },
    ]);
    expect(first.status).toBe("complete");
    await childRow(t, chatId, 3, "done", bubble);
    const newer = await silentContinuation(t, chatId, settleRun([RUN(3)]), BOOKKEEPING);
    expect(newer._id).toBe(bubble);
    expect(newer.status).toBe("error");
    for (const replay of [older, settleRun([RUN(1)], ":yield-1:retry-1")]) {
      await t.mutation(internal.stream.startAssistant, { chatId, runId: replay });
      const doc = (await t.run((ctx) => ctx.db.get(bubble))) as Doc<"messages"> | null;
      expect(doc?.status, replay).toBe("error");
      expect(doc?.errorCode, replay).toBe("empty_response");
      expect(doc?.runId, replay).toBe(newer.runId);
    }
    expect(await repaired(t, newer.runId)).toBe(false);
  });

  test("never by a retry of the SAME batch: that one resumes its own failure, it does not repair it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seed(t);
    const silent = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(silent._id).toBe(bubble);
    expect(silent.status).toBe("error");
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: settleRun([RUN(1)], ":yield-1:retry-1"),
    });
    expect(await repaired(t, silent.runId)).toBe(false);
  });
});
