/// <reference types="vite/client" />
//
// A SEGMENT belongs to an assistant turn, and to nothing else (lot 35).
//
// `/bridge/ingest`'s `addPart` is generic: the bridge posts any part shape through it. A
// mis-correlated `messageId` could therefore attach assistant prose to a USER message,
// where it renders inside the user's own bubble as if they had written it. The renderer
// is guarded too, but a store that accepts the write is a store that will eventually
// show it.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>, role: "user" | "assistant") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role,
      status: role === "assistant" ? ("streaming" as const) : ("complete" as const),
      text: role === "user" ? "ma question" : "",
      updatedAt: 1,
    });
    return messageId;
  });
}

/** Count this message's parts. Collected and filtered in JS rather than through the
 *  index: the table holds two rows in this test, and the index's typed builder does not
 *  survive convex-test's generic `run` context. */
const partsOf = async (
  t: ReturnType<typeof convexTest>,
  messageId: Id<"messages">,
) =>
  await t.run(async (ctx) => {
    const all = await ctx.db.query("messageParts").collect();
    return all.filter((p) => p.messageId === messageId).length;
  });

describe("addPart(kind:reasoning) and the role boundary", () => {
  test("lands on an assistant message", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "reasoning", text: "un segment" },
    });
    expect(await partsOf(t, messageId)).toBe(1);
  });

  test("is DROPPED on a user message — never rendered as something they wrote", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "user");
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "reasoning", text: "un segment" },
    });
    expect(await partsOf(t, messageId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE OPERATOR REPAIR'S TWO GUARANTEES, held where they are ATOMIC.
//
// `deliver-media` promises a settled target and one copy per file. The action
// checks both before it calls the bridge, and the bridge keeps its own set —
// and neither survives a race: a delivery can reopen the message between the
// read and the write (an announce reopen keeps the SAME runId, so the
// generation guard does not notice), and two overlapping repairs can both pass
// every pre-check. Inside this mutation the read and the insert are one
// transaction, so this is the only place the promises can actually hold.
/** Whether a stored blob still exists (a reclaimed one must not). */
const blobExists = async (
  t: ReturnType<typeof convexTest>,
  storageId: Id<"_storage">,
) =>
  await t.run(async (ctx) => (await ctx.storage.getUrl(storageId)) !== null);

describe("addPart repair guarantees", () => {
  async function mediaPart(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => ({
      storageId: await ctx.storage.store(new Blob(["x"])),
    }));
  }

  test("a repair is REFUSED on a message that is streaming again", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant"); // seeded streaming
    const { storageId } = await mediaPart(t);
    const outcome = await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "media", storageId, filename: "v.pdf", mimeType: "application/pdf" },
      repair: true,
    });
    // NAMED, not just refused: "reopened" and "deleted" are different answers to
    // "why is my file not there", and the trace used to give one constant.
    expect(outcome).toEqual({ accepted: false, reason: "turn_reopened" });
    expect(await partsOf(t, messageId)).toBe(0);
    // The bridge uploaded the bytes BEFORE this call: a refusal that keeps them
    // leaks a billable, unreachable object on every attempt.
    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("the SAME file is never attached twice, however the calls interleave", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "complete" });
    });
    const a = await mediaPart(t);
    const b = await mediaPart(t);
    const call = (storageId: Id<"_storage">) =>
      t.mutation(internal.stream.addPart, {
        messageId,
        part: {
          kind: "media",
          storageId,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
        repair: true,
      });
    // This mutation says NOTHING on success (the ingest reads `accepted === false`).
    expect(await call(a.storageId)).toBeNull();
    // The second is accepted too — the desired state holds — and adds nothing.
    // Reporting a failure would send the operator chasing a file that is there.
    expect(await call(b.storageId)).toBeNull();
    expect(await partsOf(t, messageId)).toBe(1);
    // The first file's bytes stay (they ARE the part); the duplicate's are
    // reclaimed rather than orphaned.
    expect(await blobExists(t, a.storageId)).toBe(true);
    expect(await blobExists(t, b.storageId)).toBe(false);
  });

  test("a message DELETED mid-transfer does not leave its bytes behind", async () => {
    // A real window: the repair's transfer budget is 420 s, and the bridge
    // uploads BEFORE this call. Throwing on the missing message without
    // reclaiming left a billable, unreachable object on every attempt — and
    // nothing can ever carry this part now, so the bytes are unreachable by
    // construction.
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    const { storageId } = await mediaPart(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(messageId);
    });
    // REPORTED, not thrown: a mutation is a transaction, so throwing after the
    // delete would roll the delete back and keep the object anyway.
    const outcome = await t.mutation(internal.stream.addPart, {
      messageId,
      part: {
        kind: "media",
        storageId,
        filename: "v.pdf",
        mimeType: "application/pdf",
      },
      repair: true,
    });
    // ...and it NAMES itself. The trace downstream exists to tell the operator
    // why the file did not land, and it reported every refusal as a stale
    // generation — sending them to look at generations for a message that is
    // gone.
    expect(outcome).toEqual({ accepted: false, reason: "message_missing" });
    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("a `file` part of the same name already counts as attached", async () => {
    // The two blob-carrying kinds are ONE family. This op takes the WHOLE part
    // union, and `chatFork` copies `file` and `media` alike onto a forked reply,
    // so the bubble can already carry this document as a `file`. Matching only
    // `media` inserted a second part for the same name — `addPart` never upserts
    // — and the reply rendered the document twice.
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "complete" as const });
      const storageId = await ctx.storage.store(new Blob(["a"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "file" as const,
          storageId,
          filename: "v.pdf",
          mimeType: "application/pdf",
        },
      });
    });
    const { storageId } = await mediaPart(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: {
        kind: "media",
        storageId,
        filename: "v.pdf",
        mimeType: "application/pdf",
      },
      repair: true,
    });
    // Still ONE part, and this attempt's bytes are reclaimed rather than left
    // billable behind a part nothing points at.
    expect(await partsOf(t, messageId)).toBe(1);
    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("the dedup NEVER deletes a blob an existing part still points at", async () => {
    // Reclaiming a duplicate's bytes is right; reclaiming the bytes the ATTACHED
    // part references leaves the reader a file that is listed and downloads
    // nothing. The replay dedup below in the same mutation already states this
    // rule — this branch has to obey it too. No current caller replays one
    // storageId (`addMediaPart` is not among the writer's retried ops, and every
    // attempt uploads afresh), so this holds the SHAPE the op accepts.
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    const { storageId } = await mediaPart(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "complete" as const });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "media" as const,
          storageId, // THE SAME object the replay below carries
          filename: "v.pdf",
          mimeType: "application/pdf",
        },
      });
      // ...and its PAIRED `files` row, because production never writes one
      // without the other (lib/files: a files row exists IFF a file/media part
      // does). That mirror is what answers "is anyone still holding this blob?".
      const msg = (await ctx.db.get(messageId))!;
      await ctx.db.insert("files", {
        userId: msg.userId,
        chatId: msg.chatId,
        messageId,
        storageId,
        filename: "v.pdf",
        mimeType: "application/pdf",
        kind: "media" as const,
        direction: "outbound" as const,
        category: "pdf" as const,
        createdAt: Date.now(),
      });
    });
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: {
        kind: "media",
        storageId,
        filename: "v.pdf",
        mimeType: "application/pdf",
      },
      repair: true,
    });
    expect(await partsOf(t, messageId)).toBe(1);
    // The attached part still resolves.
    expect(await blobExists(t, storageId)).toBe(true);
  });

  test("a DANGLING part of the same name does not block the repair", async () => {
    // Same rule as `resolveTarget`, and it has to hold in BOTH places: if this
    // guard still counted the dangling row, the repair would upload, be told
    // "already attached", reclaim its bytes and report success — a silent no-op
    // on the bubble it was called to fix.
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "complete" as const });
      const dead = await ctx.storage.store(new Blob(["old"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "media" as const,
          storageId: dead,
          filename: "v.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.storage.delete(dead);
    });
    const { storageId } = await mediaPart(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: {
        kind: "media",
        storageId,
        filename: "v.pdf",
        mimeType: "application/pdf",
      },
      repair: true,
    });
    // The file LANDED, and its bytes were not reclaimed.
    expect(await partsOf(t, messageId)).toBe(2);
    expect(await blobExists(t, storageId)).toBe(true);
  });

  test("a REFUSED repair never destroys a blob a FORKED message still holds", async () => {
    // `chatFork` copies a file/media part storageId AND ALL, so one object is
    // legitimately shared by a message and its fork. This op is network input: a
    // caller naming a storageId it does not own used to have the refusal path
    // delete it, taking every message that references it down with it.
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    const { storageId } = await mediaPart(t);
    const survivor = await t.run(async (ctx) => {
      const msg = (await ctx.db.get(messageId))!;
      // The FORKED reply, holding the same object.
      const forked = await ctx.db.insert("messages", {
        chatId: msg.chatId,
        userId: msg.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 9,
      });
      await ctx.db.insert("messageParts", {
        messageId: forked,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "v.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.db.insert("files", {
        userId: msg.userId,
        chatId: msg.chatId,
        messageId: forked,
        storageId,
        filename: "v.pdf",
        mimeType: "application/pdf",
        kind: "media" as const,
        direction: "outbound" as const,
        category: "pdf" as const,
        createdAt: Date.now(),
      });
      // ...and the repair's target disappears mid-transfer.
      await ctx.db.delete(messageId);
      return forked;
    });
    expect(
      await t.mutation(internal.stream.addPart, {
        messageId,
        part: {
          kind: "media",
          storageId,
          filename: "v.pdf",
          mimeType: "application/pdf",
        },
        repair: true,
      }),
    ).toEqual({ accepted: false, reason: "message_missing" });
    // The fork's attachment still resolves.
    expect(await blobExists(t, storageId)).toBe(true);
    expect(await partsOf(t, survivor)).toBe(1);
  });

  test("the cross-instance barrier runs BEFORE any repair answer", async () => {
    // An ORACLE, and the reason the early returns had to move: a bridge
    // authenticated for instance A that knows a message id from instance B got
    // a 200 from the "streaming" and "already attached" branches where the
    // barrier answers 403 — the difference alone reveals the message's state
    // and whether a filename exists in a foreign conversation.
    const t = convexTest(schema, modules);
    const messageId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      // OWNED by instance B, and STREAMING — the state the oracle would leak.
      return ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        boundInstance: "instance-b",
        updatedAt: 1,
      });
    });
    const { storageId } = await mediaPart(t);
    await expect(
      t.mutation(internal.stream.addPart, {
        messageId,
        part: {
          kind: "media",
          storageId,
          filename: "v.pdf",
          mimeType: "application/pdf",
        },
        repair: true,
        // A bridge speaking for ANOTHER instance.
        boundInstanceName: "instance-a",
      }),
    ).rejects.toThrow();
  });

  test("the LIVE delivery path is untouched: it writes into a streaming turn", async () => {
    // The flag is off by default on purpose. The normal path attaches while the
    // reply streams, and it has its own per-turn dedup.
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant"); // streaming
    const { storageId } = await mediaPart(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "media", storageId, filename: "live.pdf", mimeType: "application/pdf" },
    });
    expect(await partsOf(t, messageId)).toBe(1);
  });
});
