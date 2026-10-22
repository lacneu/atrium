import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { assessChat, type DiagAvailability } from "./lib/diagnose";

const modules = import.meta.glob("./**/*.ts");

// SUB-AGENT ANNOUNCE DELIVERIES — until 0.102.0 a delivery run
// (`announce:v1:<childSessionKey>:<childRunId>`, a task delivery) REOPENED the finished
// parent message and streamed into it (0.96.0's merge). Since 0.102.0 every delivery
// opens its OWN bubble, grouped with its chain by the display (displayGroups.regroup);
// what remains of the merge is its REPLAY: a bubble 0.96.0 merged a delivery into is
// still in the data, and a replay of that delivery (a rebroadcast, a resume after an
// error) must stay idempotent on it. `seedLegacyMerge` builds that state as 0.96.0
// wrote it; the cases below replay it.

const CHILD_KEY = "agent:files:subagent:9af5b6c1-d161-4994-a5df-6e256c5b4336";
const ANNOUNCE_RUN = `announce:v1:${CHILD_KEY}:650150d5-fa3d-4c7c-825c-e6684997f82d`;

async function seedDelegatedTurn(
  t: ReturnType<typeof convexTest>,
  opts?: {
    parentStatus?: "complete" | "error";
    parentText?: string;
    withSubAgentRow?: boolean;
    withParentPointer?: boolean;
    /** FALSE = an uncorrelated (fallback / pre-flag) anchor. Default TRUE:
     *  the nominal row is spawn-result/engagement-correlated. */
    anchorExact?: boolean;
  },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "alice",
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Crée le document",
      updatedAt: 1000,
    });
    const parentId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: opts?.parentStatus ?? ("complete" as const),
      text: opts?.parentText ?? "La tâche est lancée.",
      runId: "webchat-parent-run",
      finalizedAt: 2000,
      updatedAt: 2000,
    });
    if (opts?.withSubAgentRow !== false) {
      await ctx.db.insert("subAgents", {
        chatId,
        ...(opts?.withParentPointer !== false
          ? { parentMessageId: parentId }
          : {}),
        ...(opts?.withParentPointer !== false && opts?.anchorExact !== false
          ? { anchorExact: true }
          : {}),
        childSessionKey: CHILD_KEY,
        status: "done" as const,
        createdAt: 1500,
        updatedAt: 2500,
      });
    }
    return { userId, chatId, parentId };
  });
}

/** A bubble 0.96.0 MERGED `runs` (the last one owning it) into, as that version left
 *  it: the bubble took the delivery's run, recorded every merged run, kept the parent's
 *  reply as the parked prefix while the merge was not settled complete (a complete
 *  finalize consumed it), and was stamped a turn. */
async function seedLegacyMerge(
  t: ReturnType<typeof convexTest>,
  state: { status: "complete" | "error" | "aborted"; text: string; runs?: string[] },
) {
  const seeded = await seedDelegatedTurn(t);
  const runs = state.runs ?? [ANNOUNCE_RUN];
  await t.run((ctx) =>
    ctx.db.patch(seeded.parentId, {
      status: state.status,
      text: state.text,
      runId: runs[runs.length - 1]!,
      mergedAnnounceRuns: runs,
      mergedIntoTurn: true,
      ...(state.status !== "complete" ? { announcePrefix: "La tâche est lancée." } : {}),
    }),
  );
  return seeded;
}

async function assistantMessages(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
) {
  return t.run(async (ctx) => {
    const all = await ctx.db.query("messages").collect();
    return all.filter((m) => m.chatId === chatId && m.role === "assistant");
  });
}

describe("announce deliveries and the replay of a legacy merge", () => {
  test("a REPLACE snapshot on a RESUMED legacy merge keeps the parent text", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\nRésultat par",
    });
    expect(
      await t.mutation(internal.stream.startAssistant, { chatId, runId: ANNOUNCE_RUN }),
    ).toBe(parentId);
    await t.mutation(internal.stream.setSnapshot, {
      messageId: parentId,
      text: "Résultat (révision complète).",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .first(),
    );
    expect(row?.text).toBe("La tâche est lancée.\n\nRésultat (révision complète).");
  });

  test("PREEMPTED resumed merge (finalize with no text): the parked reply is never lost to a bare replayed head", async () => {
    // The bridge closes a preempted announce turn with finalize(no text). The
    // fallback normally reads the seeded/prefixed stream row — but a row
    // rewritten WITHOUT the prefix (legacy writer / lost seed) must still
    // honor the parked reply: a replayed HEAD of it keeps the reply alone,
    // genuinely new partial content recomposes behind it.
    for (const [rowText, expected] of [
      // Replayed head of the parked reply -> keep the full parked reply.
      ["La tâche est", "La tâche est lancée."],
      // New partial content -> recompose behind the parked reply.
      ["Résultat partiel inédit", "La tâche est lancée.\n\nRésultat partiel inédit"],
      // Row still carries the seeded prefix -> unchanged fallback.
      ["La tâche est lancée.\n\nDébut du rapport", "La tâche est lancée.\n\nDébut du rapport"],
    ] as const) {
      const t = convexTest(schema, modules);
      const { parentId } = await seedLegacyMerge(t, { status: "error", text: "La tâche est lancée.\n\n" });
      await t.mutation(internal.stream.startAssistant, {
        chatId: (await t.run((ctx) => ctx.db.get(parentId)))!.chatId,
        runId: ANNOUNCE_RUN,
      });
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", parentId))
          .first();
        await ctx.db.patch(row!._id, { text: rowText });
      });
      await t.mutation(internal.stream.finalize, {
        messageId: parentId,
        status: "error",
        error: "announce interrupted by a queued dispatch — replaying",
        errorKind: "announce_preempted",
      });
      const doc = await t.run((ctx) => ctx.db.get(parentId));
      expect(doc?.text, `row=${JSON.stringify(rowText)}`).toBe(expected);
      // Error close PARKS the prefix — the replayed announce can resume.
      expect(doc?.announcePrefix).toBe("La tâche est lancée.");
      expect(doc?.errorCode).toBe("announce_preempted");
    }
  });

  test("an UNCORRELATED anchor keeps the positional gate: conversation moved -> fresh bubble", async () => {
    const t = convexTest(schema, modules);
    // The bridge missed the spawn result and anchored the row to the
    // session's last-known message (no anchorExact flag — also the shape of
    // every pre-flag row). Once the conversation moves on, merging there
    // could paint the result into an unrelated turn: fail closed.
    const { userId, chatId, parentId } = await seedDelegatedTurn(t, {
      anchorExact: false,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Autre question entre-temps",
        updatedAt: 3000,
      });
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(created).not.toBe(parentId);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete"); // untouched
  });

  test("an anchored delivery does NOT merge into a parent evicted from the loaded window (fresh bubble)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    // 200 newer messages push the parent OUT of loadChatView's window: a
    // merge would stream into a bubble the client no longer renders — the
    // delivery must fall back to a visible fresh bubble instead.
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text: `filler ${i}`,
          updatedAt: 3000 + i,
        });
      }
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(created).not.toBe(parentId);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete"); // untouched
  });

  test("NO merge into an error/aborted parent (never repaint a failure)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      parentStatus: "error",
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(created).not.toBe(parentId);
  });

  test("NO merge without the subAgents join (row absent, or no parent pointer)", async () => {
    for (const opts of [
      { withSubAgentRow: false },
      { withParentPointer: false },
    ]) {
      const t = convexTest(schema, modules);
      const { chatId, parentId } = await seedDelegatedTurn(t, opts);
      const created = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: ANNOUNCE_RUN,
      });
      expect(created).not.toBe(parentId);
    }
  });

  test("a NON-announce run never merges (normal turns unchanged)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "webchat-regular-run",
    });
    expect(created).not.toBe(parentId);
  });

  test("ingest RETRY of a resumed merge's start is idempotent (same message, one live row)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\n",
    });
    const first = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    const second = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(first).toBe(parentId);
    expect(second).toBe(parentId);
    const rows = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", parentId))
          .collect()
      ).length,
    );
    expect(rows).toBe(1);
    const assts = await assistantMessages(t, chatId);
    expect(assts).toHaveLength(1);
  });

  test("terminal REBROADCAST of a merged announce never duplicates the result", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "complete",
      text: "La tâche est lancée.\n\nDocument créé.",
    });
    const settledText = (await t.run((ctx) => ctx.db.get(parentId)))!.text;
    // Bridge restarts, loses its in-memory dedupe, replays the announce run.
    const again = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(again).toBe(parentId); // settled parent handed back, NOT reopened
    await t.mutation(internal.stream.appendDelta, {
      messageId: parentId,
      text: "Document créé.",
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Document créé.",
    });
    const after = await t.run((ctx) => ctx.db.get(parentId));
    expect(after?.text).toBe(settledText); // unchanged — no double append
    const assts = await assistantMessages(t, chatId);
    expect(assts).toHaveLength(1);
  });

  test("a resumed merge publishes the seeded prefix as an SSE replace chunk", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\nRésultat par",
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    const chunks = await t.run(async (ctx) =>
      ctx.db
        .query("streamChunks")
        .withIndex("by_message_seq", (q) => q.eq("messageId", parentId))
        .collect(),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("replace");
    expect(chunks[0]?.text).toBe("La tâche est lancée.\n\n");
    // The live row's next-seq cursor continues AFTER the seed chunk.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .first(),
    );
    expect(row?.chunkSeq).toBe((chunks[0]?.seq ?? 0) + 1);
  });

  test("replayed parts on a settled merged parent dedupe (no visible duplicates)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "complete",
      text: "La tâche est lancée.\n\nDocument créé.",
    });
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["docx-bytes"])),
    );
    const mediaPart = {
      kind: "media" as const,
      storageId,
      filename: "rapport.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    // The file the merge attached, stamped with its delivery.
    await t.run((ctx) =>
      ctx.db.insert("messageParts", { messageId: parentId, order: 0, announceRun: ANNOUNCE_RUN, part: mediaPart }),
    );
    // Rebroadcast: the replayed run re-registers (arming the replay window),
    // then RE-UPLOADS the bytes (new storageId, same file) — the dedup must be
    // storage-independent or every replay stacks a visible duplicate.
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    const replayStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["docx-bytes-reuploaded"])),
    );
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { ...mediaPart, storageId: replayStorageId },
    });
    // A genuinely NEW late part (different content) still lands.
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "tool" as const, name: "exec", phase: "completed" as const },
    });
    const parts = await t.run(async (ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .collect(),
    );
    const medias = parts.filter((p) => p.part.kind === "media");
    expect(medias).toHaveLength(1); // replay deduped
    expect(parts.some((p) => p.part.kind === "tool")).toBe(true); // late part kept
  });

  test("replaying an OLDER announce of sequential merges never re-appends", async () => {
    const t = convexTest(schema, modules);
    const RUN_A = ANNOUNCE_RUN;
    const RUN_B = `announce:v1:${CHILD_KEY}:aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000`;
    // 0.96.0 merged A then B: B rotated the runId, both recorded.
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "complete",
      text: "La tâche est lancée.\n\nRésultat A.\n\nRésultat B.",
      runs: [RUN_A, RUN_B],
    });
    const settled = (await t.run((ctx) => ctx.db.get(parentId)))!;
    // Replay A after B rotated runId: must NOT reopen nor re-append.
    const again = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: RUN_A,
    });
    expect(again).toBe(parentId);
    const after = (await t.run((ctx) => ctx.db.get(parentId)))!;
    expect(after.status).toBe("complete");
    expect(after.text).toBe(settled.text);
    expect((await assistantMessages(t, chatId)).length).toBe(1);
  });

  test("a DIFFERENT announce during an in-flight merge gets its own bubble (no interleaving)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    const RUN_B = `announce:v1:${CHILD_KEY}:aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000`;
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    }); // A is merging (parent streaming)
    const other = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: RUN_B,
    });
    expect(other).not.toBe(parentId); // B streams into its own message
  });

  test("a rediffused announce RESUMES a merge the watchdog settled as error — original prefix, no duplicated partial", async () => {
    const t = convexTest(schema, modules);
    // The first delivery reopened, streamed a PARTIAL, then the bridge died — the
    // watchdog settled the parent as error (text `original + partial`, prefix parked).
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\nRésultat par",
    });
    // Rebroadcast after restart: the SAME announce must reopen and deliver
    // the FULL result behind the ORIGINAL prefix (never `+ partial +` too).
    const again = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(again).toBe(parentId);
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat livré au 2e essai.",
    });
    const parent = (await t.run((ctx) => ctx.db.get(parentId)))!;
    expect(parent.status).toBe("complete");
    expect(parent.text).toBe(
      "La tâche est lancée.\n\nRésultat livré au 2e essai.",
    );
    expect((await assistantMessages(t, chatId)).length).toBe(1);
  });

  test("a rebroadcast after a user ABORT stays a silent sink (never reopens)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "aborted",
      text: "La tâche est lancée.\n\n",
    });
    const again = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(again).toBe(parentId); // handed back settled — writes will no-op
    const parent = (await t.run((ctx) => ctx.db.get(parentId)))!;
    expect(parent.status).toBe("aborted"); // the user's stop is final
    expect((await assistantMessages(t, chatId)).length).toBe(1);
  });

  test("outside the replay window, a late same-named DIFFERENT file is kept", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    const s1 = await t.run(async (ctx) => ctx.storage.store(new Blob(["v1"])));
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "media" as const, storageId: s1, filename: "r.docx", mimeType: "application/x" },
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "OK.",
    });
    // NO rebroadcast (window not armed): a late, genuinely different file
    // with a reused name must land, not be swallowed as a replay.
    const s2 = await t.run(async (ctx) => ctx.storage.store(new Blob(["v2"])));
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "media" as const, storageId: s2, filename: "r.docx", mimeType: "application/x" },
    });
    const parts = await t.run(async (ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .collect(),
    );
    expect(parts.filter((p) => p.part.kind === "media")).toHaveLength(2);
  });

  test("a LATE delta/finalize from the PREVIOUS generation drops after a resume", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\n",
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    }); // resumed — owned by the announce run
    // A retried write from the ORIGINAL parent run (generation mismatch).
    await t.mutation(internal.stream.appendDelta, {
      messageId: parentId,
      text: "delta fantôme du vieux run",
      expectedRunId: "webchat-parent-run",
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "texte fantôme",
      expectedRunId: "webchat-parent-run",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .first(),
    );
    expect(row?.text).toBe("La tâche est lancée.\n\n"); // untouched
    const parent = (await t.run((ctx) => ctx.db.get(parentId)))!;
    expect(parent.status).toBe("streaming"); // the ghost finalize was dropped
    // The announce's OWN writes (correct generation) still flow.
    await t.mutation(internal.stream.appendDelta, {
      messageId: parentId,
      text: "Résultat réel.",
      expectedRunId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat réel.",
      expectedRunId: ANNOUNCE_RUN,
    });
    const settled = (await t.run((ctx) => ctx.db.get(parentId)))!;
    expect(settled.status).toBe("complete");
    expect(settled.text).toBe("La tâche est lancée.\n\nRésultat réel.");
  });

  test("a resumed merge that FAILS again still keeps the parent's own reply", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\n",
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "error",
      error: "gateway died mid-announce",
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    // The streamed row was seeded with the parent text — an error finalize
    // falls back to it, so the original reply survives; and the prefix is
    // PRESERVED so a rebroadcast can resume with it.
    expect(parent?.text).toContain("La tâche est lancée.");
    expect(parent?.announcePrefix).toBe("La tâche est lancée.");
  });
});

// Background-task delivery runs (`<tool>:<taskId>:ok`) settle the ENGAGEMENT row
// written when the task started, and open their own bubble.
describe("task deliveries (async tools)", () => {
  const TASK_ID = "c3e21208-67c2-40ca-b9a4-7368a7109605";
  const DELIVERY_RUN = `image_generate:${TASK_ID}:ok`;

  async function seedEngagement(
    t: ReturnType<typeof convexTest>,
    withAnchor = true,
  ) {
    const seeded = await seedDelegatedTurn(t, { withSubAgentRow: false });
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId: seeded.chatId,
        ...(withAnchor ? { parentMessageId: seeded.parentId } : {}),
        childSessionKey: `task:${TASK_ID}`,
        kind: "task" as const,
        status: "running" as const,
        taskName: "image_generate",
        createdAt: 1500,
        updatedAt: 1500,
      });
    });
    return seeded;
  }

  test("the delivery run opens its OWN bubble + settles the engagement", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedEngagement(t);
    const own = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: DELIVERY_RUN,
    });
    expect(own).not.toBe(parentId);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    // The requesting turn's bubble is left as it was.
    expect(parent?.status).toBe("complete");
    expect(parent?.runId).toBe("webchat-parent-run");
    // The engagement row settled (thread indicator off).
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${TASK_ID}`),
        )
        .first(),
    );
    expect(row?.status).toBe("done");
  });

  test("an :error delivery settles the engagement as error", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedEngagement(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `image_generate:${TASK_ID}:error`,
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${TASK_ID}`),
        )
        .first(),
    );
    expect(row?.status).toBe("error");
  });

  test("no engagement row -> fail closed (fresh bubble, no crash)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      withSubAgentRow: false,
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: DELIVERY_RUN,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete"); // untouched — separate bubble
  });

  // Sequential chains: the gateway emits NO tool frames on delivery runs
  // (measured live, 2026.7.1-beta.5), so a task started INSIDE one has no
  // acked engagement. The chain fallback merges the next link into the last
  // same-tool delivery bubble — and anchors its row at merge time.
  const NEXT_ID = "7d10a2be-0000-4a11-8b22-93c344d55e66";

  test("CHAIN fail-closed: the conversation moved on (anchor no longer last) -> fresh bubble", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedEngagement(t);
    // A newer user message arrived after the anchor bubble.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        text: "autre sujet",
        status: "complete" as const,
        updatedAt: 3000,
      });
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `image_generate:${NEXT_ID}:ok`,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete"); // untouched — separate bubble
  });

  test("adoptDiscoveredTask: creates the row EARLY with the inherited chain anchor (indicator between links)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedEngagement(t); // task 1 anchored
    await t.mutation(internal.subAgents.adoptDiscoveredTask, {
      chatId,
      taskId: NEXT_ID,
      toolName: "image_generate",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${NEXT_ID}`),
        )
        .first(),
    );
    expect(row?.status).toBe("running"); // lights the activity indicator
    expect(row?.kind).toBe("task");
    expect(row?.parentMessageId).toBe(parentId); // chain anchor inherited
    // Idempotent: a second sighting only refreshes, never duplicates.
    await t.mutation(internal.subAgents.adoptDiscoveredTask, {
      chatId,
      taskId: NEXT_ID,
      toolName: "image_generate",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${NEXT_ID}`),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("adoptDiscoveredTask fail-closed: conversation moved on -> row created WITHOUT anchor", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedEngagement(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        text: "autre sujet",
        status: "complete" as const,
        updatedAt: 3000,
      });
    });
    await t.mutation(internal.subAgents.adoptDiscoveredTask, {
      chatId,
      taskId: NEXT_ID,
      toolName: "image_generate",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${NEXT_ID}`),
        )
        .first(),
    );
    expect(row?.status).toBe("running"); // indicator still lights up
    expect(row?.parentMessageId).toBeUndefined(); // but no wrong anchor
  });

  test("CHAIN fail-closed: a DIFFERENT tool's delivery never chain-merges", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      withSubAgentRow: false,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(parentId, {
        runId: `video_generate:${TASK_ID}:ok`,
      });
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `image_generate:${NEXT_ID}:ok`,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete"); // untouched — separate bubble
  });
});

// Thread-level activity signal (subAgents.turnActivity) — powers the clean
// view's spinner while a delegated turn still works after the parent settled.
describe("subAgents.turnActivity", () => {
  test("running child → running; done child before re-settle → delivering; after re-settle → quiet", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });

    // Child RUNNING → running:true, anchored to its parent bubble (the
    // indicator renders UNDER the working turn, not at the thread bottom
    // where a queued follow-up would claim it — user report).
    const childCreatedAt = await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      // updatedAt fresh, as the real upsert stamps on every status change —
      // the staleness gate must not hide a live transition.
      await ctx.db.patch(sub!._id, {
        status: "running" as const,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(chatId, { lastAssistantAt: 1000 });
      return sub!.createdAt;
    });
    let a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(true);
    expect(a.anchorMessageId).toBe(parentId);
    // The elapsed-clock baseline: the delegated treatment starts at the
    // child's birth (prod report 2026-07-22: no timer on a delegated turn).
    expect(a.workingSince).toBe(childCreatedAt);

    // Child DONE after the last settle → delivering (announce being composed).
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, updatedAt: 5000 });
    });
    a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(false);
    expect(a.deliveringSince).toBe(5000);
    // The delivery being composed anchors to the finished child's bubble.
    expect(a.anchorMessageId).toBe(parentId);
    // The clock keeps its birth baseline through the delivery window — the
    // user perceives one continuous treatment, never a timer reset.
    expect(a.workingSince).toBe(childCreatedAt);

    // The merge settles (finalize re-stamps lastAssistantAt) → quiet.
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat.",
    });
    a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(false);
    expect(a.deliveringSince).toBeNull();
    expect(a.workingSince).toBeNull(); // quiet → no clock
  });

  test("a resume bubble that names the child's run ends the delivery window (projection `on`)", async () => {
    // prod report prod-ms7dc0ne…: in `on` the resume (`announce:requester-settle:…`) is a
    // bubble of its own and names the child by its RUN; the hand-off bubble settled before
    // the child finished. Without this fact, only the 45 s window ended "composing".
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const childRunId = "248d41ff-bb53-458f-9e2c-28d676bc5fdc";
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, childRunId, updatedAt: Date.now() });
    });
    expect((await asUser.query(api.subAgents.turnActivity, { chatId })).deliveringSince).not.toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: `announce:requester-settle:main:agent:main:atrium:chat:u:c1:${childRunId}:yield-1`,
        updatedAt: Date.now(),
      });
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBeNull();
    expect(a.workingSince).toBeNull();
  });

  test("a merge whose parent scrolled beyond the recent-message window stays quiet", async () => {
    // The announce merged into the parent, then 11 newer messages pushed it
    // out of the 10-message mergedRuns scan, and the child's detached
    // terminal upsert landed AFTER the parent finalized (so the finalizedAt
    // test alone cannot filter it). The parent's own merge history must.
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedLegacyMerge(t, {
      status: "complete",
      text: "La tâche est lancée.\n\nRésultat livré.",
    });
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      const parent = (await ctx.db.get(parentId))!;
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, {
        status: "done" as const,
        updatedAt: (parent.finalizedAt ?? 0) + 60_000,
      });
      for (let i = 0; i < 11; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: `Tour ${i}`,
          updatedAt: 10_000 + i,
        });
      }
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBeNull();
  });

  test("a NEWER settled turn does NOT mask a child still delivering (no chat-clock filter)", async () => {
    // Child of turn N finishes (announce not merged yet), then the user runs
    // turn N+1 which settles AFTER the child's terminal — lastAssistantAt is
    // now beyond the child's updatedAt, but its result is STILL in flight.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, updatedAt: 5000 });
      // A newer, unrelated turn settles after the child finished.
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Autre sujet.",
        runId: "webchat-later-run",
        finalizedAt: 9000,
        updatedAt: 9000,
      });
      await ctx.db.patch(chatId, { lastAssistantAt: 9000 });
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBe(5000);
  });

  test("a long-lived child that JUST finished is not pushed out by 20 younger siblings", async () => {
    // by_chat_status orders by _creationTime: 21 younger done children would
    // evict the OLDEST row from a creation-ordered take(20) even though it is
    // the freshest TERMINATION. The updatedAt-ordered index must keep it.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, updatedAt: 5000 });
      for (let i = 0; i < 21; i++) {
        await ctx.db.insert("subAgents", {
          chatId,
          childSessionKey: `agent:files:subagent:younger-${i}`,
          status: "done" as const,
          createdAt: 3000 + i,
          updatedAt: 100,
        });
      }
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBe(5000);
  });

  // The remaining delivery time is what lets a client that OPENS the
  // conversation mid-delivery know whether what it sees is live. Measured on
  // the server, because a client comparing this server timestamp to its own
  // clock gets it wrong under skew — which is why the client used to refuse to
  // trust the first value it saw, and showed nothing at all on a reopen.
  test("a fresh delivery ships the time LEFT in its window", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const justNow = Date.now() - 1_000;
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, updatedAt: justNow });
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBe(justNow);
    // A second old: most of the window is left, and it is a DURATION, never
    // the timestamp itself.
    expect(a.deliveringTtlRemainingMs).toBeGreaterThan(30_000);
    expect(a.deliveringTtlRemainingMs).toBeLessThanOrEqual(45_000);
  });

  // The NO_REPLY case: a terminal row whose announce never arrives keeps this
  // same timestamp for ever. It must arrive with its window already spent, so
  // that reopening the conversation a day later shows nothing rather than a
  // phantom "finalising".
  test("a delivery older than its window ships ZERO remaining, not a live one", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const longAgo = Date.now() - 10 * 60 * 1000;
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, updatedAt: longAgo });
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBe(longAgo);
    expect(a.deliveringTtlRemainingMs).toBe(0);
  });

  // A conversation that never delegated: nothing is delivering, so there is no
  // window at all to report the remaining time of.
  test("nothing delivering reports no remaining time at all", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("subAgents").collect()) {
        await ctx.db.delete(row._id);
      }
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.deliveringSince).toBeNull();
    expect(a.deliveringTtlRemainingMs).toBeNull();
  });

  // THE USER SAID STOP, and the child's announce arrives anyway — the kill and
  // the child's own terminal frame race. Reopening here would repaint the very
  // block the user interrupted with the result they refused to wait for: the
  // reply they DID get overwritten, under an "Interrompu" marker.
  // THE INTERRUPTION EPOCH — the four ways the refused result used to come back,
  // each asked at the ONE door every post-turn delivery walks through.
  describe("the interruption epoch", () => {
    /** Press Stop: stamp the chat's epoch and the child's own marker. */
    async function stop(t: ReturnType<typeof convexTest>, chatId: Id<"chats">) {
      const at = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.patch(chatId, { stoppedAt: at });
        const rows = (await ctx.db.query("subAgents").collect()).filter(
          (r) => r.chatId === chatId && r.status === "running",
        );
        for (const row of rows) {
          await ctx.db.patch(row._id, {
            status: "aborted" as const,
            stopRequestedAt: at,
            updatedAt: at,
          });
        }
      });
      return at;
    }

    const countMessages = async (
      t: ReturnType<typeof convexTest>,
      chatId: Id<"chats">,
    ) =>
      (
        await t.run(async (ctx) =>
          (await ctx.db.query("messages").collect()).filter(
            (m) => m.chatId === chatId,
          ),
        )
      ).length;

    test("the delivery of stopped work creates NO bubble at all", async () => {
      const t = convexTest(schema, modules);
      const { chatId } = await seedDelegatedTurn(t);
      await stop(t, chatId);
      const before = await countMessages(t, chatId);
      const landed = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: ANNOUNCE_RUN,
      });
      expect(landed, "the run has nowhere to land").toBeNull();
      expect(await countMessages(t, chatId)).toBe(before);
    });

    // Pass-3 path: the parent was still STREAMING when Stop was pressed, so it
    // never carried a marker of its own. The epoch does not care.
    test("…even when the parent was still streaming at Stop time", async () => {
      const t = convexTest(schema, modules);
      const { chatId, parentId } = await seedDelegatedTurn(t);
      await t.run(async (ctx) => {
        await ctx.db.patch(parentId, { status: "streaming" as const });
      });
      await stop(t, chatId);
      const before = await countMessages(t, chatId);
      const landed = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: ANNOUNCE_RUN,
      });
      expect(landed).toBeNull();
      expect(await countMessages(t, chatId)).toBe(before);
    });

    // Pass-3 path: the spawn was never anchored, so there is no block to mark.
    test("…even when the child was never anchored to a block", async () => {
      const t = convexTest(schema, modules);
      const { chatId } = await seedDelegatedTurn(t);
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .first();
        await ctx.db.patch(row!._id, { parentMessageId: undefined });
      });
      await stop(t, chatId);
      const before = await countMessages(t, chatId);
      const landed = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: ANNOUNCE_RUN,
      });
      expect(landed).toBeNull();
      expect(await countMessages(t, chatId)).toBe(before);
    });

    // STOPPING THIS TURN MUST NOT MUTE THE NEXT ONE. A child spawned after the
    // stop is younger than the epoch and delivers normally.
    test("work started AFTER the stop delivers normally", async () => {
      const t = convexTest(schema, modules);
      const { chatId } = await seedDelegatedTurn(t);
      const at = await stop(t, chatId);
      // A fresh child, born after the epoch, under the same key.
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .first();
        await ctx.db.patch(row!._id, {
          createdAt: at + 1000,
          status: "running" as const,
          stopRequestedAt: undefined,
        });
      });
      const landed = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: ANNOUNCE_RUN,
      });
      expect(landed, "a stop must not mute everything that follows").not.toBeNull();
    });

    // Pass-3 path: a late terminal frame turns the row `done` and carries the
    // very text the user refused. The status may move; the CONTENT may not.
    test("a late terminal frame cannot restore the refused report", async () => {
      const t = convexTest(schema, modules);
      const { chatId } = await seedDelegatedTurn(t);
      // The seed's row is already terminal; the case is a child that was STILL
      // RUNNING when Stop landed and whose terminal frame arrives afterwards.
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD_KEY))
          .first();
        await ctx.db.patch(row!._id, { status: "running" as const });
      });
      await stop(t, chatId);
      await t.mutation(internal.subAgents.upsertSubAgent, {
        chatId,
        childSessionKey: CHILD_KEY,
        status: "done",
        resultText: "LE RAPPORT QUE L'UTILISATEUR A REFUSÉ",
      });
      const row = await t.run(async (ctx) =>
        ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD_KEY))
          .first(),
      );
      expect(
        row?.resultText,
        "the panel renders resultText — the refused report must not reach it",
      ).toBeUndefined();
    });
  });

  test("a stopped merged block is never reopened by a late replay", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "complete",
      text: "La tâche est lancée.",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(parentId, { interruptedAt: Date.now() });
    });
    const countMessages = async () =>
      (await t.run(async (ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      )).length;
    const before = await countMessages();
    const landed = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    // Counting is what catches a refused replay falling through to a NEW message;
    // an id comparison alone would pass precisely BECAUSE one was created.
    expect(await countMessages(), "no new bubble for a refused report").toBe(
      before,
    );
    expect(landed, "the replay is sunk into the stopped block").toBe(parentId);
    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent?.status, "…which is not dragged back into streaming").toBe(
      "complete",
    );
    expect(parent?.text, "the reply the user did get is untouched").toBe(
      "La tâche est lancée.",
    );
    // And the deltas that follow the refused start must not write either.
    await t.mutation(internal.stream.appendDelta, {
      messageId: parentId,
      text: "RAPPORT TARDIF QUE L'UTILISATEUR A REFUSÉ",
    });
    const after = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(after?.text, "a late delta cannot repaint a stopped block").toBe(
      "La tâche est lancée.",
    );
  });

  test("a LATE terminal upsert after the merge settled stays quiet (write order must not matter)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    // The announce merges and settles FIRST…
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat livré.",
    });
    // …then the child's detached terminal upsert lands LATE (updatedAt beyond
    // lastAssistantAt) — the reply is already on screen, no spinner.
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, {
        status: "done" as const,
        updatedAt: Date.now() + 60_000,
      });
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(false);
    expect(a.deliveringSince).toBeNull();
  });
});

// SUB-AGENT CHAINS — a child spawned INSIDE another child's announce run
// (delivery runs carry no tool frames, so only the item sighting + bornOfRun
// register it). Its row must inherit the ROOT anchor at birth, and its own
// announce must merge into the ROOT bubble — never fragment the pipeline into
// one bubble per link (live incident 2026-07-14: seven announce bubbles for
// one prompt, plan card frozen).
describe("sub-agent announce CHAIN (bornOfRun = announce run)", () => {
  const CHAIN_CHILD =
    "agent:files:subagent:c0dec0de-1111-2222-3333-444455556666";
  const CHAIN_ANNOUNCE = `announce:v1:${CHAIN_CHILD}:aa0150d5-fa3d-4c7c-825c-e6684997f82d`;

  test("upsertSubAgent inherits the carrier's ROOT anchor at birth (announce-family bornOfRun)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    // The chained child registers with NO anchor of its own, born inside the
    // FIRST child's announce run (the bridge stamps bornOfRun).
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHAIN_CHILD,
      bornOfRun: ANNOUNCE_RUN,
      status: "running",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHAIN_CHILD))
        .first(),
    );
    expect(row?.parentMessageId).toBe(parentId);
    expect(row?.anchorExact).toBe(true);
  });

  test("the announce SETTLES a still-running child row (timeout-killed child, no terminal frame)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedDelegatedTurn(t);
    // The child died gateway-side without a terminal frame: its row is stuck
    // running when the announce arrives.
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "running" as const });
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD_KEY))
        .first(),
    );
    expect(row?.status).toBe("done");
  });

  test("turnActivity ignores a STALE running row (spinner never armed by a dead child)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, {
        status: "running" as const,
        updatedAt: Date.now() - 30 * 60_000,
      });
    });
    const stale = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(stale.running).toBe(false);
    // A FRESH running row still arms it.
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { updatedAt: Date.now() });
    });
    const fresh = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(fresh.running).toBe(true);
  });

  test("settleAnnouncedChild flips ONLY a running row (silent NO_REPLY announce path)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedDelegatedTurn(t);
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "running" as const });
    });
    await t.mutation(internal.subAgents.settleAnnouncedChild, {
      chatId,
      childSessionKey: CHILD_KEY,
    });
    let row = await t.run(async (ctx) => ctx.db.query("subAgents").first());
    expect(row?.status).toBe("done");
    // An observer-recorded failure stands.
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "error" as const });
    });
    await t.mutation(internal.subAgents.settleAnnouncedChild, {
      chatId,
      childSessionKey: CHILD_KEY,
    });
    row = await t.run(async (ctx) => ctx.db.query("subAgents").first());
    expect(row?.status).toBe("error");
  });

  test("a STALE sub-agent row never masks an older still-active task (eligible pick)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      // Older long-running TASK (legitimately quiet).
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "task:11112222-3333-4444-5555-666677778888",
        kind: "task" as const,
        status: "running" as const,
        createdAt: Date.now() - 60 * 60_000,
        updatedAt: Date.now() - 40 * 60_000,
      });
      // Newer STALE sub-agent (dead observer).
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, {
        status: "running" as const,
        updatedAt: Date.now() - 30 * 60_000,
      });
    });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(true); // the task holds the signal
    expect(a.runningTtlRemainingMs).toBeNull(); // task rows have no display TTL
  });

  test("LATE bornOfRun fill runs the birth-inheritance too (upsert ordering race)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    // First write persisted WITHOUT bornOfRun (e.g. a session-meta capture).
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHAIN_CHILD,
      status: "running",
    });
    // The correlated write lands next: the anchor must inherit NOW.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHAIN_CHILD,
      bornOfRun: ANNOUNCE_RUN,
      status: "running",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHAIN_CHILD))
        .first(),
    );
    expect(row?.parentMessageId).toBe(parentId);
    expect(row?.anchorExact).toBe(true);
  });

  test("a DONE child is never repainted error by a late observer sweep", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedDelegatedTurn(t);
    // Announce settle already flipped the child done…
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const });
    });
    // …then the in-memory observer's TTL sweep synthesizes a timeout error.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD_KEY,
      status: "error",
      errorMessage: "Sub-agent timed out",
    });
    const row = await t.run(async (ctx) => ctx.db.query("subAgents").first());
    expect(row?.status).toBe("done");
    // The documented recovery direction still works: error -> done.
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "error" as const });
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD_KEY,
      status: "done",
    });
    const row2 = await t.run(async (ctx) => ctx.db.query("subAgents").first());
    expect(row2?.status).toBe("done");
  });

  test("carrier row missing -> fail closed (fresh bubble)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      withSubAgentRow: false,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: CHAIN_CHILD,
        bornOfRun: ANNOUNCE_RUN,
        status: "done" as const,
        createdAt: 2600,
        updatedAt: 2700,
      });
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: CHAIN_ANNOUNCE,
    });
    expect(created).not.toBe(parentId);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("complete"); // untouched
  });
});

// The compaction marker is a VERDICT, not an announcement: the explicit-compaction
// flow posts `midturn` when the gateway starts summarizing and only learns at the
// gateway's `end` whether it succeeded. The part must be UPGRADED in place — a
// second, contradictory notice on the same turn would tell the user the context
// was optimized when it was not (the production symptom this closes).
describe("stream.addPart — compaction marker upsert", () => {
  test("a `failed` verdict REPLACES the `midturn` announcement (one part, not two)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "compaction" as const, phase: "midturn", at: 1000 },
    });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "compaction" as const, phase: "failed", at: 2000 },
    });
    const parts = await t.run(async (ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .collect(),
    );
    const compactions = parts.filter((p) => p.part.kind === "compaction");
    expect(compactions).toHaveLength(1);
    expect(
      (compactions[0]!.part as { phase: string }).phase,
    ).toBe("failed");
    expect(chatId).toBeDefined();
  });

  test("a NON-compaction part is never fused into the compaction marker", async () => {
    const t = convexTest(schema, modules);
    const { parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "compaction" as const, phase: "midturn", at: 1000 },
    });
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: { kind: "tool" as const, name: "exec", phase: "completed" as const },
    });
    const parts = await t.run(async (ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .collect(),
    );
    expect(parts).toHaveLength(2);
  });
});

// WHAT THE DIAGNOSIS SEES AFTER A MERGE.
//
// 0.96.0's merge ROTATED the parent turn's runId to the announce run and never
// restored it. A diagnosis that reads the run alone therefore stops seeing the
// user's own turn — the newest bubble in a healthy delegated conversation. Such
// bubbles stay in the data (no delivery merges since 0.102.0): the cases below
// build them as 0.96.0 left them (`seedLegacyMerge`) and diagnose them.
describe("a merged report does not blind the diagnosis", () => {
  const AVAIL: DiagAvailability = {
    known: true,
    available: true,
    degraded: false,
    reason: null,
  };

  async function diagnose(t: ReturnType<typeof convexTest>, chatId: Id<"chats">) {
    const state = await t.query(internal.messages.chatStateInternal, {
      chatId,
    });
    return assessChat(state, AVAIL);
  }

  test("a successful merge leaves the chat readable as healthy", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedDelegatedTurn(t);
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: reopened as Id<"messages">,
      status: "complete",
      text: "Document créé.",
    });
    const a = await diagnose(t, chatId);
    expect(
      a.class,
      "the rotated runId hides the user's own turn from the diagnosis",
    ).toBe("healthy");
  });

  test("a merge that FAILS is a lost report, never a failed turn", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\n",
    });
    // Settled just now, as the failed finalize stamped it.
    await t.run((ctx) =>
      ctx.db.patch(parentId, { error: "delivery lost", finalizedAt: Date.now(), updatedAt: Date.now() }),
    );
    // The pre-merge reply is still parked on the bubble: the user HAS an
    // answer, so this is not the chat's reply failing.
    const a = await diagnose(t, chatId);
    // The EXACT class, not merely "not dispatch_error": skipping the bubble
    // altogether also clears that bar, while leaving the user's own reply
    // invisible to the diagnosis.
    // The turn is NOT the failure — and the lost report is not nothing either.
    expect(
      a.class,
      "the reply the user already has is blamed for the report's failure",
    ).not.toBe("dispatch_error");
    expect(a.class, "the lost report is reported as nothing at all").toBe(
      "subagent_failure",
    );
  });

  test("an OLDER failed turn is not resurrected by a failed merge", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await seedDelegatedTurn(t);
    // A turn that genuinely failed EARLIER, before the delegated one.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        runId: "webchat-older-run",
        errorCode: "timeout",
        orderTime: 500,
        updatedAt: 500,
      });
    });
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: reopened as Id<"messages">,
      status: "error",
      error: "delivery lost",
    });
    const a = await diagnose(t, chatId);
    // The OLD timeout must not become the verdict: what is wrong right now is
    // the report, and it is a warning, not the conversation being broken.
    expect(
      a.class,
      "an old failure is promoted to 'the current state' by a lost report",
    ).toBe("subagent_failure");
    expect(a.errorCode, "the old turn's code is presented as current").not.toBe(
      "timeout",
    );
  });
});

// THE SECOND DELIVERY FAMILY.
//
// A background task (image/video generation, any durable gateway work) returns
// on a `<tool>:<taskId>:<ok|error>` run and merges into its parent exactly like
// a sub-agent report. Reading only the `announce:` family left every failed
// generation classified as this conversation's reply failing.
describe("a failed background-task delivery is not a failed reply", () => {
  const TASK_ID = "c3e21208-1b7f-4a2e-9d55-0f1a2b3c4d5e";
  const TASK_RUN = `image_generate:${TASK_ID}:error`;

  const AVAIL2: DiagAvailability = {
    known: true,
    available: true,
    degraded: false,
    reason: null,
  };

  test("merged into the turn it belongs to, it leaves the chat healthy", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedDelegatedTurn(t, { withSubAgentRow: false });
    await t.run(async (ctx) => {
      const parent = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .first();
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: parent!._id,
        anchorExact: true,
        childSessionKey: `task:${TASK_ID}`,
        kind: "task" as const,
        taskName: "image_generate",
        status: "running" as const,
        createdAt: 1500,
        updatedAt: 2500,
      });
    });
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: TASK_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: reopened as Id<"messages">,
      status: "error",
      error: "generation failed",
    });
    const state = await t.query(internal.messages.chatStateInternal, {
      chatId,
    });
    // The EXACT class: the failure is attributed to the TASK that failed —
    // which is true and actionable — and no longer to the conversation's reply,
    // which arrived and is still there.
    expect(
      assessChat(state, AVAIL2).class,
      "a failed image generation condemns the whole conversation",
    ).toBe("subagent_failure");
  });
});

// A CHAIN OF DELIVERIES IS STILL NOT A TURN.
//
// Under 0.96.0 a task delivery that resolved no engagement row got its OWN bubble,
// and the next same-tool delivery of the chain merged into THAT bubble — which then
// carried a reopen history without ever having been a user turn. Inferring "this is
// a turn" from that history let a pure delivery chain stand in for the
// conversation's reply.
describe("a standalone delivery chain never stands in for a turn", () => {
  const T2 = "bbbbbbbb-2222-4a2e-9d55-0f1a2b3c4d5e";
  const AVAIL3: DiagAvailability = {
    known: true,
    available: true,
    degraded: false,
    reason: null,
  };

  test("it does not hide a turn that really failed", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await seedDelegatedTurn(t, {
      withSubAgentRow: false,
      parentStatus: "error",
    });
    await t.run(async (ctx) => {
      const parent = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .first();
      await ctx.db.patch(parent!._id, { errorCode: "timeout" });
      // The chain as 0.96.0 left it: the FIRST delivery got a bubble of its own (no
      // engagement to merge into), and the SECOND same-tool delivery merged into THAT
      // bubble — a reopen history on a bubble that was never a turn.
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Image 1.\n\nImage 2.",
        runId: `image_generate:${T2}:ok`,
        mergedAnnounceRuns: [`image_generate:${T2}:ok`],
        mergedIntoTurn: false,
        finalizedAt: 4000,
        updatedAt: 4000,
      });
    });

    const state = await t.query(internal.messages.chatStateInternal, {
      chatId,
    });
    const a = assessChat(state, AVAIL3);
    expect(
      a.class,
      "a chain of deliveries stands in for the reply that actually failed",
    ).toBe("dispatch_error");
    expect(a.errorCode).toBe("timeout");
  });
});

// A BUBBLE THAT PREDATES THE STAMP MUST NOT BE BRANDED BY IT.
describe("a turn merged before the stamp existed keeps its identity", () => {
  test("resuming a merge it already carried does not durably record it as a delivery", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    // Exactly what production holds: a REAL turn merged before the stamp existed —
    // rotated runId, reopen history, no stamp — whose last merge (ANNOUNCE_RUN) died
    // in error, its prefix parked.
    await t.run(async (ctx) => {
      await ctx.db.patch(parentId, {
        status: "error" as const,
        text: "La tâche est lancée.\n\n",
        runId: ANNOUNCE_RUN,
        announcePrefix: "La tâche est lancée.",
        mergedAnnounceRuns: ["announce:v1:agent:old:subagent:c0:r0", ANNOUNCE_RUN],
      });
    });
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(reopened).toBe(parentId);
    await t.mutation(internal.stream.finalize, {
      messageId: reopened as Id<"messages">,
      status: "complete",
      text: "Rapport.",
    });
    const doc = await t.run(async (ctx) =>
      ctx.db.get(reopened as Id<"messages">),
    );
    expect(
      doc?.mergedIntoTurn,
      "the user's real reply is branded a delivery, permanently",
    ).toBe(true);
    const state = await t.query(internal.messages.chatStateInternal, {
      chatId,
    });
    expect(
      assessChat(state, {
        known: true,
        available: true,
        degraded: false,
        reason: null,
      }).class,
    ).toBe("healthy");
  });
});

describe("a reopened bubble does not keep the previous generation's verdict", () => {
  // `finalizeCause` is written only when a cause is SENT, so a value left behind
  // by the first generation survives a second one that legitimately reports none —
  // an older bridge, Hermes, a Stop settled directly, a cause refused at the
  // ingest. The diagnostic plane would then attribute the old run's ending to the
  // new one, durably, long after the traces that could contradict it expired.
  test("the old cause is cleared on a resume, not inherited by the new generation", async () => {
    const t = convexTest(schema, modules);
    // Generation 1 (the merge, 0.96.0) ended in error on a named deadline. Stamped
    // directly — what is under test here is the generation boundary.
    const { chatId, parentId } = await seedLegacyMerge(t, {
      status: "error",
      text: "La tâche est lancée.\n\n",
    });
    await t.run((ctx) =>
      ctx.db.patch(parentId, { finalizeCause: "lifecycle_finishing_timeout" }),
    );

    // The replayed announce resumes the SAME bubble…
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    if (reopened === null) throw new Error("startAssistant refused the delivery");
    expect(reopened).toBe(parentId);
    const afterReopen = await t.run((ctx) => ctx.db.get(parentId));
    expect(
      afterReopen?.finalizeCause ?? null,
      "the previous generation's verdict does not cross the boundary",
    ).toBeNull();
    // …but it is PARKED, not destroyed: a merged bubble is several turns in one
    // row, and the first one's ending is what a triage reading it a day later
    // needs. Attributed to the run that earned it.
    expect(afterReopen?.priorFinalizeCauses).toEqual([
      { runId: ANNOUNCE_RUN, cause: "lifecycle_finishing_timeout" },
    ]);

    // …and generation 2 ends WITHOUT a cause (an older bridge, say).
    await t.mutation(internal.stream.finalize, {
      messageId: reopened,
      status: "complete",
      text: "Document créé et vérifié.",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(parentId)))?.finalizeCause ?? null,
      "absent means nobody named one — never the last run's answer",
    ).toBeNull();
  });
});
