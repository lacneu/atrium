import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

// SUB-AGENT ANNOUNCE MERGE — the user asks ONE question, the answer must land
// in ONE bubble. When a sub-agent finishes AFTER its parent turn ended, the
// gateway delivers the result as a separate `announce:v1:<childSessionKey>:
// <childRunId>` run; startAssistant must REOPEN the finished parent message
// (joined through subAgents.parentMessageId) instead of creating a second
// assistant message — and every merge condition must FAIL CLOSED to the old
// two-bubble behaviour, never lose text, and re-notify on the real result.

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

async function assistantMessages(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
) {
  return t.run(async (ctx) => {
    const all = await ctx.db.query("messages").collect();
    return all.filter((m) => m.chatId === chatId && m.role === "assistant");
  });
}

describe("announce merge (one bubble per delegated turn)", () => {
  test("announce run REOPENS the parent message — no second bubble; text recomposes; user is re-notified", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);

    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    // startAssistant returns null only when the interruption epoch refuses the
    // delivery; this turn is not one, so the id is the contract here.
    if (reopened === null) throw new Error("startAssistant refused an ordinary turn");
    expect(reopened).toBe(parentId);

    // Reopened: streaming again, owned by the announce run, prefix parked,
    // live row seeded with it.
    const reopenedDoc = await t.run((ctx) => ctx.db.get(parentId));
    expect(reopenedDoc?.status).toBe("streaming");
    expect(reopenedDoc?.runId).toBe(ANNOUNCE_RUN);
    expect(reopenedDoc?.announcePrefix).toBe("La tâche est lancée.");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", parentId))
        .first(),
    );
    expect(row?.text).toBe("La tâche est lancée.\n\n");

    await t.mutation(internal.stream.appendDelta, {
      messageId: reopened,
      text: "Document créé et vérifié.",
    });
    await t.mutation(internal.stream.finalize, {
      messageId: reopened,
      status: "complete",
      text: "Document créé et vérifié.",
    });

    const assts = await assistantMessages(t, chatId);
    expect(assts).toHaveLength(1); // THE invariant: one bubble
    const settled = assts[0]!;
    expect(settled.text).toBe("La tâche est lancée.\n\nDocument créé et vérifié.");
    expect(settled.status).toBe("complete");
    expect(settled.announcePrefix).toBeUndefined(); // consumed
    // The REAL result arrival re-notifies (unread dot / sound source).
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.lastAssistantAt).toBeTypeOf("number");
  });

  test("a REPLACE snapshot on the reopened message keeps the parent text", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
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

  test("PREEMPTED merge (finalize with no text): the parked reply is never lost to a bare replayed head", async () => {
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
      const { parentId } = await seedDelegatedTurn(t);
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

  test("an ANCHORED delivery merges into its parent even after the conversation moved on (order fix)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    // An interleaved follow-up + its reply: the parent is NOT the last
    // message any more. The engagement anchor is exact, so the delivery must
    // return to ITS turn — landing at the bottom made the thread read
    // out-of-order (user report, pptx iteration chain).
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Autre question entre-temps",
        updatedAt: 3000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Réponse au follow-up",
        runId: "webchat-followup-run",
        updatedAt: 3500,
      });
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(created).toBe(parentId);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("streaming"); // reopened by the merge
    expect(parent?.announcePrefix).toBe("La tâche est lancée.");
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

  test("an uncorrelated anchor STILL merges while its parent is the last message (historical behaviour)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      anchorExact: false,
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(created).toBe(parentId);
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

  test("an anchored delivery also merges past a QUEUED follow-up (orderTime sentinel)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    // A mid-turn queued follow-up: _creationTime BEFORE the parent reply's,
    // but its orderTime sentinel places it logically AFTER. The acked anchor
    // still wins — the delivery merges into its own turn.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Follow-up mis en file",
        orderTime: 8.64e15, // QUEUED_ORDER_SENTINEL (still parked)
        updatedAt: 1500,
      });
    });
    const created = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(created).toBe(parentId);
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

  test("ingest RETRY of the announce start is idempotent (same message, one live row)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
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
    const { chatId, parentId } = await seedDelegatedTurn(t);
    // First delivery: merge completes.
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Document créé.",
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

  test("reopen publishes the seeded prefix as an SSE replace chunk", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
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

  test("replayed parts on a settled parent dedupe (no visible duplicates)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
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
    await t.mutation(internal.stream.addPart, {
      messageId: parentId,
      part: mediaPart,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Document créé.",
    });
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

  test("SEQUENTIAL merges accumulate; replaying an OLDER announce never re-appends", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    const RUN_A = ANNOUNCE_RUN;
    const RUN_B = `announce:v1:${CHILD_KEY}:aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000`;
    // Merge A.
    await t.mutation(internal.stream.startAssistant, { chatId, runId: RUN_A });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat A.",
    });
    // Merge B (parent settled again, still last message).
    await t.mutation(internal.stream.startAssistant, { chatId, runId: RUN_B });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat B.",
    });
    const settled = (await t.run((ctx) => ctx.db.get(parentId)))!;
    expect(settled.text).toBe(
      "La tâche est lancée.\n\nRésultat A.\n\nRésultat B.",
    );
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
    const { chatId, parentId } = await seedDelegatedTurn(t);
    // First delivery: reopen, a PARTIAL streams, then the bridge dies — the
    // watchdog settles the parent as error (text is now `original + partial`).
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.appendDelta, {
      messageId: parentId,
      text: "Résultat par",
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "error",
      error: "bridge lost",
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
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "aborted",
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

  test("a LATE delta/finalize from the PREVIOUS generation drops after the reopen", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    }); // reopened — owned by the announce run now
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

  test("announce run that FAILS still keeps the parent's own reply", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
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

// Background-task delivery runs (`<tool>:<taskId>:ok`) reuse the announce
// merge machinery through the ENGAGEMENT row written when the task started.
describe("task-delivery merge (async tools)", () => {
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

  test("the delivery run MERGES into the requesting turn's bubble + settles the engagement", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedEngagement(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: DELIVERY_RUN,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    // Reopened for streaming: the delivery lands in the SAME bubble.
    expect(parent?.status).toBe("streaming");
    expect(parent?.runId).toBe(DELIVERY_RUN);
    expect(parent?.announcePrefix).toBe("La tâche est lancée.");
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

  test("an :error delivery settles the engagement as error (still merges)", async () => {
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

  test("a child spawned INSIDE the delivery run (bornOfRun, no own anchor) merges via the ENGAGEMENT anchor", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedEngagement(t);
    // The delivery run stayed invisible (NO_REPLY): the spawned child was
    // registered WITHOUT an anchor but stamped bornOfRun.
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: CHILD_KEY,
        bornOfRun: DELIVERY_RUN,
        status: "done" as const,
        createdAt: 2600,
        updatedAt: 2700,
      });
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    // The announce resolved its anchor THROUGH the engagement row.
    expect(parent?.status).toBe("streaming");
    expect(parent?.runId).toBe(ANNOUNCE_RUN);
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

  test("CHAIN: a next-link delivery without engagement merges into the last same-tool bubble + anchors its row", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      withSubAgentRow: false,
    });
    // The chat's last bubble IS link N's delivery (its runId carries the family).
    await t.run(async (ctx) => {
      await ctx.db.patch(parentId, { runId: DELIVERY_RUN });
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `image_generate:${NEXT_ID}:ok`,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("streaming"); // reopened: ONE bubble per chain
    expect(parent?.runId).toBe(`image_generate:${NEXT_ID}:ok`);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${NEXT_ID}`),
        )
        .first(),
    );
    expect(row?.parentMessageId).toBe(parentId);
    expect(row?.kind).toBe("task");
  });

  test("CHAIN: recognizes the family in mergedAnnounceRuns too (link N itself was merged)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t, {
      withSubAgentRow: false,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(parentId, { mergedAnnounceRuns: [DELIVERY_RUN] });
    });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `image_generate:${NEXT_ID}:ok`,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("streaming");
  });

  test("CHAIN: silent middle links — inherits through the newest ANCHORED same-tool row (measured live)", async () => {
    // The agent NO_REPLYed deliveries 1..N-1 while starting the next task in
    // each (no startAssistant ever ran, the turn bubble is still the chat's
    // last message and carries NO delivery family) — only task 1's row,
    // acked in the user turn, is anchored. Delivery N must land in that
    // anchor.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedEngagement(t); // task 1 anchored, done later
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: `image_generate:${NEXT_ID}:ok`,
    });
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("streaming"); // merged into the turn bubble
    expect(parent?.runId).toBe(`image_generate:${NEXT_ID}:ok`);
    // And link N's row was anchored at merge time.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", `task:${NEXT_ID}`),
        )
        .first(),
    );
    expect(row?.parentMessageId).toBe(parentId);
  });

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

  test("a merge whose parent scrolled beyond the recent-message window stays quiet", async () => {
    // The announce merged into the parent, then 11 newer messages pushed it
    // out of the 10-message mergedRuns scan, and the child's detached
    // terminal upsert landed AFTER the parent finalized (so the finalizedAt
    // test alone cannot filter it). The parent's own merge history must.
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "Résultat livré.",
    });
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

  test("a stopped block is never reopened by a late announce", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
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
    // NOT merely "it did not reopen the parent": refusing the merge used to
    // fall through to inserting a NEW assistant message, so the report the user
    // refused simply arrived in the next bubble — the same broken promise one
    // message lower. Counting is what catches that; an id comparison passes
    // precisely BECAUSE a new message was created.
    expect(await countMessages(), "no new bubble for a refused report").toBe(
      before,
    );
    expect(landed, "the delivery is sunk into the stopped block").toBe(parentId);
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

  test("the chained child's announce merges into the ROOT bubble (one bubble per pipeline)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHAIN_CHILD,
      bornOfRun: ANNOUNCE_RUN,
      status: "running",
    });
    const merged = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: CHAIN_ANNOUNCE,
    });
    expect(merged).toBe(parentId);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.status).toBe("streaming");
    expect(parent?.runId).toBe(CHAIN_ANNOUNCE);
    // No second bubble.
    const assistants = await assistantMessages(t, chatId);
    expect(assistants).toHaveLength(1);
  });

  test("a LEGACY unanchored row (no birth inheritance) still resolves through the carrier at announce time", async () => {
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await seedDelegatedTurn(t);
    // Row inserted raw (no upsert): bornOfRun present, anchor absent.
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
    const merged = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: CHAIN_ANNOUNCE,
    });
    expect(merged).toBe(parentId);
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
