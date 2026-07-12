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

  test("NO merge when the conversation moved on (a later user message) — falls back to a fresh bubble", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
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

  test("NO merge when a QUEUED follow-up logically follows the parent (orderTime beats creation order)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    // A mid-turn queued follow-up: _creationTime BEFORE the parent reply's,
    // but its orderTime sentinel places it logically AFTER — the conversation
    // has moved on, so the announce must open its own bubble.
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
    expect(created).not.toBe(parentId);
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

// Thread-level activity signal (subAgents.turnActivity) — powers the clean
// view's spinner while a delegated turn still works after the parent settled.
describe("subAgents.turnActivity", () => {
  test("running child → running; done child before re-settle → delivering; after re-settle → quiet", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, parentId } = await seedDelegatedTurn(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });

    // Child RUNNING → running:true.
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "running" as const });
      await ctx.db.patch(chatId, { lastAssistantAt: 1000 });
    });
    let a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(true);

    // Child DONE after the last settle → delivering (announce being composed).
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subAgents").first();
      await ctx.db.patch(sub!._id, { status: "done" as const, updatedAt: 5000 });
    });
    a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(false);
    expect(a.deliveringSince).toBe(5000);

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
