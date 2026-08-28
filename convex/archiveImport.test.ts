/// <reference types="vite/client" />
//
// Reading an archive back in.
//
// The archive is a FILE — it may have been edited, truncated, or written by
// hand. What is pinned here is that nothing in it is believed: not who owns it,
// not the bytes it names, not the identifiers it uses, and not the agents it
// claims. Plus the property that makes a multi-call import safe to run at all:
// an import that stops halfway can be undone precisely.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ARCHIVE_FORMAT_VERSION } from "./lib/exportArchive";
import {
  MAX_FILENAME_LENGTH,
  SUPPORTED_FORMAT_VERSIONS,
  sanitizeFilename,
} from "./lib/importArchive";
import { QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";
import {
  QUOTE_EXCERPT_CAP,
  QUOTE_MAX_PER_TURN,
  QUOTE_TOTAL_EXCERPT_CAP,
} from "./lib/quoteReply";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const MANIFEST = { formatVersion: ARCHIVE_FORMAT_VERSION, origin: null };

async function user(t: TestConvex<typeof schema>, withAgent = false) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    if (withAgent) {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "alice",
        source: "discovered" as const,
        presentInLastOk: true,
        enabled: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    }
    return userId;
  });
}

/** An archive row, with the archive's own identifier. */
const archived = (id: string, row: Record<string, unknown>) => ({
  _id: id,
  ...row,
});

describe("export then import, round trip", () => {
  test("a conversation carrying every shape survives the round trip", async () => {
    // The two halves were built separately, and separately is how they drifted:
    // sections with no owner column, a media part whose bytes the import dropped,
    // a live status with nothing behind it, a tool payload the import refused.
    // Exercising chats and messages alone never touched any of it.
    const t = convexTest(schema, modules);
    const owner = await user(t, true);
    const as = t.withIdentity({ subject: owner });

    const sourceStorage = await t.run((ctx) =>
      ctx.storage.store(new Blob(["image"])),
    );
    const chatId = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId: owner,
        title: "tout",
        updatedAt: 1,
        instanceName: "primary",
        agentId: "alice",
      });
      const asked = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "user",
        status: "complete",
        text: "regarde",
        updatedAt: 1,
      });
      await ctx.db.insert("messageParts", {
        messageId: asked,
        order: 0,
        part: {
          kind: "media",
          storageId: sourceStorage,
          filename: "vue.png",
          mimeType: "image/png",
        },
      });
      await ctx.db.insert("files", {
        userId: owner,
        chatId,
        messageId: asked,
        storageId: sourceStorage,
        filename: "vue.png",
        mimeType: "image/png",
        kind: "media",
        direction: "outbound",
        createdAt: 1,
      });
      const answered = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant",
        // LIVE when the archive was written.
        status: "streaming",
        text: "je regarde",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: answered,
        order: 0,
        part: {
          kind: "tool",
          name: "lookup",
          phase: "result",
          output: { userId: "client-7", storageId: "cle-metier" },
        },
      });
      return chatId;
    });

    // ── export ──────────────────────────────────────────────────────────────
    const manifest = await as.action(api.archiveExport.exportManifest, {});
    const chatRow = await as.query(api.archiveExport.exportChat, { chatId });
    const sections: Record<string, Record<string, unknown>[]> = {};
    const blobKeys: string[] = [];
    for (const section of manifest.sections) {
      const page = await as.query(api.archiveExport.exportChatSection, {
        chatId,
        section: section as "messages",
      });
      sections[section] = page.rows;
      for (const blob of page.blobs) blobKeys.push(blob.key);
    }

    // The caller uploads the bytes it fetched, and has them registered — the
    // same gate any attachment goes through.
    const blobs: { key: string; storageId: Id<"_storage"> }[] = [];
    for (const key of blobKeys) {
      const storageId = await t.run(async (ctx) => {
        const id = await ctx.storage.store(new Blob(["image"]));
        await ctx.db.insert("uploads", { storageId: id, userId: owner });
        return id;
      });
      blobs.push({ key, storageId });
    }

    // ── import ──────────────────────────────────────────────────────────────
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: { formatVersion: manifest.formatVersion, origin: manifest.origin },
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [chatRow],
    });
    for (const section of manifest.sections) {
      const rows = sections[section] ?? [];
      if (rows.length === 0) continue;
      await as.mutation(api.archiveImport.importBatch, {
        importId,
        section: section as "messages",
        rows,
        blobs,
      });
    }
    await as.mutation(api.archiveImport.finishImport, { importId });

    // ── what came back ──────────────────────────────────────────────────────
    const chats = await t.run((ctx) => ctx.db.query("chats").collect());
    const imported = chats.find((c) => c._id !== chatId)!;
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", imported._id))
        .collect(),
    );
    expect(messages).toHaveLength(2);
    // A turn that was live is not imported as live: its streaming row is
    // deliberately absent from the archive.
    expect(messages.map((m) => m.status).sort()).toEqual([
      "aborted",
      "complete",
    ]);

    const parts = await t.run(async (ctx) => {
      const out = [];
      for (const message of messages) {
        out.push(
          ...(await ctx.db
            .query("messageParts")
            .withIndex("by_message", (q) => q.eq("messageId", message._id))
            .collect()),
        );
      }
      return out;
    });
    expect(parts).toHaveLength(2);
    const media = parts.find((p) => p.part.kind === "media")!;
    // Bytes the IMPORTER uploaded, never the archive's pointer.
    const mediaPart = media.part as { storageId: string };
    expect(mediaPart.storageId).not.toBe(sourceStorage);
    expect(mediaPart.storageId).toBeTruthy();
    const tool = parts.find((p) => p.part.kind === "tool")!;
    // The user's own payload, untouched — including fields that merely share a
    // name with our structural keys.
    expect((tool.part as { output: Record<string, unknown> }).output).toEqual({
      userId: "client-7",
      storageId: "cle-metier",
    });

    const files = await t.run((ctx) =>
      ctx.db
        .query("files")
        .withIndex("by_user_chat", (q) =>
          q.eq("userId", owner).eq("chatId", imported._id),
        )
        .collect(),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.storageId).not.toBe(sourceStorage);
  });
});

describe("archive import", () => {
  test("the OWNER in the archive is never honoured", async () => {
    // Honouring it would let anyone hand someone else's history to a third
    // party — or claim a row as theirs.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const someoneElse = await user(t);
    const as = t.withIdentity({ subject: importer });

    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("a1", { title: "volee", userId: someoneElse, updatedAt: 1 })],
    });

    const chats = await t.run((ctx) => ctx.db.query("chats").collect());
    expect(chats).toHaveLength(1);
    expect(chats[0]!.userId).toBe(importer);
  });

  test("a storage pointer IN the archive is refused outright", async () => {
    // A row carrying one is either from a version that should not have written
    // it, or hand-edited to make this import read bytes it does not own.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });

    await expect(
      as.mutation(api.archiveImport.importBatch, {
        importId,
        section: "chats",
        rows: [archived("a1", { title: "x", updatedAt: 1, storageId: "kg2-x" })],
      }),
    ).rejects.toThrow(/storage_pointer_present/);

    expect(await t.run((ctx) => ctx.db.query("chats").collect())).toHaveLength(0);
  });

  test("bytes must have been uploaded BY the importer", async () => {
    // The existing upload registry is the gate. Without it an import could name
    // any blob in the deployment — someone else's attachment.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const stranger = await user(t);
    const strangersBlob = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["prive"]));
      await ctx.db.insert("uploads", { storageId, userId: stranger });
      return storageId;
    });
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "x",
          updatedAt: 1,
        }),
      ],
    });

    await expect(
      as.mutation(api.archiveImport.importBatch, {
        importId,
        section: "files",
        rows: [
          archived("f1", {
            chatId: "c1",
            messageId: "m1",
            archiveBlobKey: "f1",
            filename: "p.png",
            mimeType: "image/png",
            kind: "media",
            direction: "outbound",
            createdAt: 1,
          }),
        ],
        blobs: [{ key: "f1", storageId: strangersBlob }],
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("an unreadable FORMAT is refused before anything is written", async () => {
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });

    await expect(
      as.mutation(api.archiveImport.beginImport, {
        manifest: { formatVersion: ARCHIVE_FORMAT_VERSION + 99, origin: null },
      }),
    ).rejects.toThrow(/unsupported_format/);
    expect(
      await t.run((ctx) => ctx.db.query("archiveImports").collect()),
    ).toHaveLength(0);
  });

  test("a FOREIGN archive attaches no agent, and says which one answered", async () => {
    // Absence of `routedAgentId` already means "inherit the turn's agent, else
    // the chat's". Leaving an imported message unrouted would attribute it to
    // whichever agent the reader later binds — the archive would appear to say
    // something it does not.
    const t = convexTest(schema, modules);
    const importer = await user(t, true);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: { formatVersion: ARCHIVE_FORMAT_VERSION, origin: "atr_" + "f".repeat(32) },
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [
        archived("c1", {
          title: "venue d ailleurs",
          updatedAt: 1,
          instanceName: "primary",
          agentId: "alice",
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "assistant",
          status: "complete",
          text: "reponse",
          updatedAt: 1,
          routedInstanceName: "primary",
          routedAgentId: "alice",
        }),
      ],
    });

    const chat = (await t.run((ctx) => ctx.db.query("chats").collect()))[0]!;
    const message = (await t.run((ctx) => ctx.db.query("messages").collect()))[0]!;
    expect(chat.agentId).toBeUndefined();
    expect(chat.instanceName).toBeUndefined();
    expect(message.routedAgentId).toBeUndefined();
    expect(message.importedAgentLabel).toBe("alice");
  });

  test("a SINGLE-AGENT conversation keeps its attribution when imported foreign", async () => {
    // The common case: the messages carry no agent at all — it exists only on the
    // conversation. Detaching it on a foreign import and stopping there loses the
    // attribution of every message, and they then read as coming from whichever
    // agent the reader later binds.
    const t = convexTest(schema, modules);
    const importer = await user(t, true);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: {
        formatVersion: ARCHIVE_FORMAT_VERSION,
        origin: "atr_" + "f".repeat(32),
      },
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [
        archived("c1", {
          title: "ordinaire",
          updatedAt: 1,
          instanceName: "primary",
          agentId: "alice",
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "assistant",
          status: "complete",
          text: "reponse sans routage",
          updatedAt: 1,
        }),
      ],
    });

    // ON THE CONVERSATION, not copied onto its messages: a per-message copy
    // would override the real routed agent of every turn in a multi-agent one.
    const chat = (await t.run((ctx) => ctx.db.query("chats").collect()))[0]!;
    expect(chat.importedAgentLabel).toBe("alice");
    const message = (await t.run((ctx) => ctx.db.query("messages").collect()))[0]!;
    expect(message.importedAgentLabel).toBeUndefined();
  });

  test("an archive from HERE reattaches, but only an agent this user may use", async () => {
    const t = convexTest(schema, modules);
    const importer = await user(t, true);
    const as = t.withIdentity({ subject: importer });
    const here = await t.run(async (ctx) => {
      const id = "atr_" + "1".repeat(32);
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: id,
        mintedForOrigin: null,
        mintedAt: 1,
      });
      return id;
    });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: { formatVersion: ARCHIVE_FORMAT_VERSION, origin: here },
    });

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [
        archived("c1", {
          title: "locale",
          updatedAt: 1,
          instanceName: "primary",
          agentId: "alice",
        }),
        // An agent this deployment does not have: the origin matching does NOT
        // make it usable, because the origin is a value in a file.
        archived("c2", {
          title: "agent inconnu",
          updatedAt: 1,
          instanceName: "primary",
          agentId: "fantome",
        }),
      ],
    });

    const chats = await t.run((ctx) => ctx.db.query("chats").collect());
    const bound = chats.find((c) => c.title === "locale")!;
    const unbound = chats.find((c) => c.title === "agent inconnu")!;
    expect(bound.agentId).toBe("alice");
    expect(unbound.agentId).toBeUndefined();
  });

  test("placement is the IMPORTER'S choice, never the archive's", async () => {
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const stranger = await user(t);
    const { mine, theirs } = await t.run(async (ctx) => ({
      mine: await ctx.db.insert("projects", { userId: importer, name: "mien" }),
      theirs: await ctx.db.insert("projects", { userId: stranger, name: "leur" }),
    }));
    const as = t.withIdentity({ subject: importer });

    // A folder identifier from the caller is checked like any other.
    await expect(
      as.mutation(api.archiveImport.beginImport, {
        manifest: MANIFEST,
        targetProjectId: theirs,
      }),
    ).rejects.toThrow(/Not found/);

    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
      targetProjectId: mine,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1, projectId: theirs })],
    });

    const chat = (await t.run((ctx) => ctx.db.query("chats").collect()))[0]!;
    expect(chat.projectId).toBe(mine);
  });

  test("importing at the ROOT ignores the folder the archive names", async () => {
    // Otherwise an archive decides where its conversations land — including in
    // someone else's folder, since its projectId is just a value in a file.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const stranger = await user(t);
    const theirs = await t.run((ctx) =>
      ctx.db.insert("projects", { userId: stranger, name: "leur" }),
    );
    const as = t.withIdentity({ subject: importer });

    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1, projectId: theirs })],
    });

    const chat = (await t.run((ctx) => ctx.db.query("chats").collect()))[0]!;
    expect(chat.projectId).toBeUndefined();
  });

  test("a REQUIRED reference that was never imported skips the row", async () => {
    // Writing it anyway would leave a message pointing at whatever that
    // identifier happens to name here.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });

    const result = await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "jamais-importee",
          role: "user",
          status: "complete",
          text: "orpheline",
          updatedAt: 1,
        }),
      ],
    });

    expect(result.written).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
  });

  test("a quote anchor INSIDE an array is remapped, or dropped — never left as-is", async () => {
    // `messages.quotedRefs[].messageId` names another message. Left unmapped it
    // would name whatever that identifier happens to name HERE — a passage of
    // someone else's conversation, presented as the one the user replied to.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "assistant",
          status: "complete",
          text: "la réponse citée",
          updatedAt: 1,
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige ces deux points",
          quotedRefs: [
            { messageId: "m1", blockIndex: 0, excerpt: "le premier" },
            // NEVER part of this archive.
            { messageId: "jamais-importee", blockIndex: 1, excerpt: "l'orphelin" },
          ],
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const quoting = rows.find((r) => r.text === "corrige ces deux points")!;
    const quoted = rows.find((r) => r.text === "la réponse citée")!;
    const refs = quoting.quotedRefs!;
    expect(refs.map((r) => r.excerpt)).toEqual(["le premier", "l'orphelin"]);
    // Remapped to the COPY that came along...
    expect(refs[0]!.messageId).toBe(quoted._id);
    // ...and the unmappable one keeps its passage while losing only the link.
    expect(refs[1]!.messageId).toBeUndefined();
  });

  test("an archive cannot persist MORE quotes than a send may carry", async () => {
    // The bounds were on the send path only. An archive is a value in a FILE:
    // left unbounded it could persist thousands of passages, which the
    // rehydration and the summaries then concatenate into every outgoing
    // prompt — a context_length failure delivered by an import.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige",
          // Under the archive's own MAX_FIELDS_PER_ROW (which already refuses
          // an absurd row), and far over the quote bounds — so it is THESE
          // bounds the test exercises, not the format's.
          quotedRefs: Array.from({ length: 60 }, (_, i) => ({
            messageId: "m1",
            blockIndex: i,
            excerpt: "y".repeat(900),
          })),
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const refs = rows.find((r) => r.text === "corrige")!.quotedRefs!;
    expect(refs.length).toBeLessThanOrEqual(QUOTE_MAX_PER_TURN);
    expect(refs.reduce((n, r) => n + r.excerpt.length, 0)).toBeLessThanOrEqual(
      QUOTE_TOTAL_EXCERPT_CAP,
    );
    for (const r of refs) {
      expect(r.excerpt.length).toBeLessThanOrEqual(QUOTE_EXCERPT_CAP);
    }
  });

  test("the OLD single-quote shape gets the SAME bounds and the SAME checks", async () => {
    // The singular fields are still accepted, so they are still a way in. An
    // archive carrying them was skipping every bound and every check: a
    // 200 000-character excerpt, and an anchor pointing at a user message.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("u1", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "une question",
          updatedAt: 1,
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige",
          quotedMessageId: "u1",
          quotedBlockIndex: 0,
          quotedExcerpt: "z".repeat(200_000),
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const written = rows.find((r) => r.text === "corrige")!;
    const refs = written.quotedRefs!;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.excerpt.length).toBe(QUOTE_EXCERPT_CAP);
    // The anchor named a USER message: the passage stands, the link does not.
    expect(refs[0]!.messageId).toBeUndefined();
    // The singular MIRROR is written too (rollback safety) — and it is the
    // CAPPED value, not the 200 000 characters the archive asked for.
    expect(written.quotedExcerpt!.length).toBe(QUOTE_EXCERPT_CAP);
    expect(written.quotedMessageId).toBeUndefined();
  });

  test("an imported quote ALSO survives a rollback", async () => {
    // Storing only the array is fine until the deploy is rolled back: the
    // previous revision reads only the singular fields, and the imported
    // conversation would then look as if nobody had quoted anything.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "assistant",
          status: "complete",
          text: "la réponse citée",
          updatedAt: 1,
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige",
          quotedRefs: [
            { messageId: "m1", blockIndex: 0, excerpt: "le premier" },
            { messageId: "m1", blockIndex: 1, excerpt: "le second" },
          ],
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const written = rows.find((r) => r.text === "corrige")!;
    const quoted = rows.find((r) => r.text === "la réponse citée")!;
    expect(written.quotedRefs).toHaveLength(2);
    // The mirror an older revision reads: the FIRST passage, anchor included.
    expect(written.quotedExcerpt).toBe("le premier");
    expect(written.quotedMessageId).toBe(quoted._id);
    expect(written.quotedBlockIndex).toBe(0);
  });

  test("an EMPTY array wipes the stale singular mirror it came with", async () => {
    // `quotedRefs: []` beside an old `quotedExcerpt` says "quotes nothing".
    // Today's derivation masks the mirror; storing it anyway means an older
    // reader resurrects the passage after a rollback.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige",
          quotedRefs: [],
          quotedExcerpt: "un fantôme",
          quotedBlockIndex: 0,
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const written = rows.find((r) => r.text === "corrige")!;
    expect(written.quotedExcerpt).toBeUndefined();
    expect(written.quotedBlockIndex).toBeUndefined();
    expect(written.quotedRefs).toBeUndefined();
  });

  test("a NEWER archive format is refused at the manifest, not mid-import", async () => {
    // A reader that accepts a shape it cannot remap inserts an unknown field
    // into its own schema and fails partway — half a conversation written.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    await expect(
      t.withIdentity({ subject: importer }).mutation(
        api.archiveImport.beginImport,
        {
          manifest: {
            formatVersion: ARCHIVE_FORMAT_VERSION + 1,
            origin: null,
          },
        },
      ),
    ).rejects.toThrow();
  });

  test("EVERY older format this version claims to read is still accepted", () => {
    // Reading older archives costs nothing; what the number buys is the refusal
    // above. Losing an old version by accident would strand real archives.
    expect([...SUPPORTED_FORMAT_VERSIONS].sort()).toEqual([1, 2, 3]);
  });

  test("two anchor-less passages of the SAME block stay two passages", async () => {
    // De-duplicating on `(messageId, blockIndex)` collapses them to one
    // `undefined:0` — a different excerpt lost for good, after import.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige",
          quotedRefs: [
            { messageId: "jamais-a", blockIndex: 0, excerpt: "le premier" },
            { messageId: "jamais-b", blockIndex: 0, excerpt: "le second" },
          ],
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const refs = rows.find((r) => r.text === "corrige")!.quotedRefs!;
    expect(refs.map((r) => r.excerpt)).toEqual(["le premier", "le second"]);
  });

  test("an anchor that survives the remap must still be an assistant reply HERE", async () => {
    // The remap makes the identifier valid; it does not make it right. Pointed
    // at a USER message, the interface would offer a jump to a passage nobody
    // ever answered with.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("u1", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "une question",
          updatedAt: 1,
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m2", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "corrige",
          quotedRefs: [{ messageId: "u1", blockIndex: 0, excerpt: "citation" }],
          updatedAt: 2,
        }),
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("messages").collect());
    const refs = rows.find((r) => r.text === "corrige")!.quotedRefs!;
    // The passage stands; only the link is gone.
    expect(refs).toEqual([{ blockIndex: 0, excerpt: "citation" }]);
  });

  test("a RETRIED batch does not duplicate what it already wrote", async () => {
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    const rows = [archived("c1", { title: "une fois", updatedAt: 1 })];

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows,
    });
    const again = await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows,
    });

    expect(again.written).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("chats").collect())).toHaveLength(1);
  });

  test("an import stopped halfway can be undone PRECISELY", async () => {
    // Otherwise a failed import leaves a folder of conversations nobody can
    // name, let alone remove.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const untouched = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: importer, title: "la mienne", updatedAt: 1 }),
    );
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "importee", updatedAt: 1 })],
    });

    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      done = (await as.mutation(api.archiveImport.abandonImport, { importId }))
        .done;
    }

    expect(done).toBe(true);
    const chats = await t.run((ctx) => ctx.db.query("chats").collect());
    // Exactly what the import created is gone; what was already here is not.
    expect(chats.map((c) => c._id)).toEqual([untouched]);
    expect(
      await t.run((ctx) => ctx.db.query("archiveImportIds").collect()),
    ).toHaveLength(0);
  });

  test("an imported sub-agent can no longer be DRIVEN on the source gateway", async () => {
    // The export keeps `childSessionKey` because it links a sub-agent to its tool
    // calls. But it is also what "Interact" sends to the gateway — so importing it
    // unchanged, from an archive of this very deployment, would let the copy drive
    // the ORIGINAL conversation's sub-agent.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "subAgents",
      rows: [
        archived("s1", {
          chatId: "c1",
          childSessionKey: "gw-child-42",
          kind: "task",
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "subAgentToolParts",
      rows: [
        archived("p1", {
          chatId: "c1",
          childSessionKey: "gw-child-42",
          toolCallId: "tc1",
          name: "grep",
          status: "running",
          updatedAt: 1,
        }),
      ],
    });

    const agents = await t.run((ctx) => ctx.db.query("subAgents").collect());
    const parts = await t.run((ctx) =>
      ctx.db.query("subAgentToolParts").collect(),
    );
    expect(agents[0]!.childSessionKey).not.toBe("gw-child-42");
    // ...and the join that makes the archive readable still holds.
    expect(parts[0]!.childSessionKey).toBe(agents[0]!.childSessionKey);
    // Nothing resumes a delegation after an import; left running it would make
    // the conversation look busy and block new sends.
    expect(agents[0]!.status).toBe("aborted");
    expect(parts[0]!.status).toBe("error");
  });

  test("an imported conversation is on ONE clock, in the archive's order", async () => {
    // Deleting the source order left the conversation on TWO clocks: a message
    // that had carried one fell back to the creation time minted here while its
    // neighbours did not, so an answer could be shown before the question it
    // answers. Every imported message takes a position from the same sequence.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    // The archive's own order: a question, its reply, then a follow-up that had
    // been QUEUED mid-turn at the source (its order there was re-stamped on
    // drain, so it belongs last).
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        // The order the SOURCE displayed — the export emits them already sorted
        // by it, including a follow-up created BEFORE the reply it belongs after.
        // The import takes that as the rank and puts it on its own clock.
        archived("m1", { chatId: "c1", role: "user", status: "complete", text: "question", updatedAt: 1, archiveOrder: 100 }),
        archived("m2", { chatId: "c1", role: "assistant", status: "complete", text: "reponse", updatedAt: 2, archiveOrder: 200 }),
        archived("m3", { chatId: "c1", role: "user", status: "complete", text: "relance", updatedAt: 3, archiveOrder: 8.64e15 }),
      ],
    });

    const messages = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_chat").collect(),
    );
    // Every one carries a position on THIS deployment's clock — none falls back
    // to another, and none lands in the future.
    for (const message of messages) {
      expect(typeof message.orderTime).toBe("number");
      expect(message.orderTime!).toBeLessThan(Date.now() + 60_000);
    }
    const ordered = [...messages].sort(
      (a, b) => (a.orderTime ?? 0) - (b.orderTime ?? 0),
    );
    expect(ordered.map((m) => m.text)).toEqual([
      "question",
      "reponse",
      "relance",
    ]);
  });

  test("a media part whose bytes are missing is SKIPPED, not fatal", async () => {
    // The export says so itself when it could not resolve them. Writing the part
    // anyway fails the whole batch on a row the schema refuses.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "x",
          updatedAt: 1,
        }),
      ],
    });

    const result = await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messageParts",
      rows: [
        archived("p1", {
          messageId: "m1",
          order: 0,
          part: { kind: "media", filename: "perdu.png", mimeType: "image/png" },
          unresolvedBlobs: 1,
        }),
      ],
    });

    expect(result.written).toBe(0);
    expect(
      await t.run((ctx) => ctx.db.query("messageParts").collect()),
    ).toHaveLength(0);
  });

  test("closing an import clears the mapping it needed", async () => {
    // It exists only so batches can resolve each other's references. Left behind,
    // every import would durably double the rows it wrote.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "gardee", updatedAt: 1 })],
    });

    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      done = (await as.mutation(api.archiveImport.finishImport, { importId }))
        .done;
    }

    expect(done).toBe(true);
    expect(
      await t.run((ctx) => ctx.db.query("archiveImportIds").collect()),
    ).toHaveLength(0);
    // What was imported stays: this clears bookkeeping, not history.
    expect(await t.run((ctx) => ctx.db.query("chats").collect())).toHaveLength(1);
  });

  test("a filename is truncated by CODE POINT, never mid-character", async () => {
    // Convex refuses a string that is not valid Unicode, so a name with an emoji
    // at the boundary would fail the whole batch.
    const name = "a".repeat(MAX_FILENAME_LENGTH - 1) + "😀" + "b";

    const safe = sanitizeFilename(name);

    expect(Array.from(safe)).toHaveLength(MAX_FILENAME_LENGTH);
    expect(safe.endsWith("😀")).toBe(true);
  });

  test("operational state in a HAND-EDITED archive is stripped anyway", async () => {
    // The export removes these. But an archive is a file, so trusting their
    // absence means a hand-edited one decides: a future `stoppedAt` alone would
    // have this deployment refuse the conversation's sub-agent deliveries.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [
        archived("c1", {
          title: "trafiquee",
          updatedAt: 1,
          stoppedAt: 4_000_000_000_000,
          pendingFetch: true,
          forkPendingRehydration: true,
          lastRoutedAgentId: "alice",
        }),
      ],
    });

    const chat = (await t.run((ctx) => ctx.db.query("chats").collect()))[0]!;
    expect(chat.stoppedAt).toBeUndefined();
    expect(chat.pendingFetch).toBeUndefined();
    expect(chat.forkPendingRehydration).toBeUndefined();
    expect(chat.lastRoutedAgentId).toBeUndefined();
    // ...and the owner the import must SET is not swept away with them.
    expect(chat.userId).toBe(importer);
  });

  test("an imported chat is a CONVERSATION, never a hidden utility one", async () => {
    // A chat with a `kind` is excluded from the listings, the search and the
    // folder views. Importing one creates a conversation nobody can see — and one
    // this deployment might then reuse as its own documentary or summarizer chat.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [
        archived("c1", { title: "deguisee", updatedAt: 1, kind: "documentary" }),
      ],
    });

    const chat = (await t.run((ctx) => ctx.db.query("chats").collect()))[0]!;
    expect(chat.kind).toBeUndefined();
  });

  test("an attachment promising a file it does not have says so", async () => {
    // `ready` offers a download. Without bytes the reader gets one that resolves
    // to nothing, while the message's own count still announces it.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "assistant",
          status: "complete",
          text: "voici",
          updatedAt: 1,
        }),
      ],
    });

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "documentAttachments",
      rows: [
        archived("d1", {
          sourceMessageId: "m1",
          entryKey: "e1",
          reference: "r1",
          status: "ready",
          filename: "rapport.pdf",
          mimeType: "application/pdf",
          archiveBlobKey: "d1",
          createdAt: 1,
          updatedAt: 1,
        }),
      ],
      // No blob supplied: the bytes never made it into the archive.
      blobs: [],
    });

    const attachment = (
      await t.run((ctx) => ctx.db.query("documentAttachments").collect())
    )[0]!;
    expect(attachment.status).toBe("not_found");
    expect(attachment.storageId).toBeUndefined();
  });

  test("bytes are discarded only when THIS import uploaded them and nothing names them", async () => {
    // Without the import to scope it, a caller could name any storage id of their
    // own — including an attachment of a conversation they still have — and have
    // the bytes deleted underneath it.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });

    const { free, usedByFile, usedByDoc, unregistered } = await t.run(
      async (ctx) => {
        const make = async () => {
          const id = await ctx.storage.store(new Blob(["x"]));
          await ctx.db.insert("uploads", { storageId: id, userId: importer });
          return id;
        };
        const free = await make();
        const usedByFile = await make();
        const usedByDoc = await make();
        const unregistered = await make();
        const chatId = await ctx.db.insert("chats", {
          userId: importer,
          title: "t",
          updatedAt: 1,
        });
        const messageId = await ctx.db.insert("messages", {
          chatId,
          userId: importer,
          role: "user",
          status: "complete",
          text: "x",
          updatedAt: 1,
        });
        await ctx.db.insert("files", {
          userId: importer,
          chatId,
          messageId,
          storageId: usedByFile,
          filename: "a.png",
          mimeType: "image/png",
          kind: "media",
          direction: "outbound",
          createdAt: 1,
        });
        await ctx.db.insert("documentAttachments", {
          userId: importer,
          sourceMessageId: messageId,
          entryKey: "e",
          reference: "r",
          status: "ready",
          storageId: usedByDoc,
          createdAt: 1,
          updatedAt: 1,
        });
        return { free, usedByFile, usedByDoc, unregistered };
      },
    );
    for (const storageId of [free, usedByFile, usedByDoc]) {
      await as.mutation(api.archiveImport.registerImportBlob, {
        importId,
        storageId,
      });
    }

    expect(
      await as.mutation(api.archiveImport.discardUpload, {
        importId,
        storageId: free,
      }),
    ).toEqual({ discarded: true });
    expect(
      await as.mutation(api.archiveImport.discardUpload, {
        importId,
        storageId: usedByFile,
      }),
    ).toEqual({ discarded: false });
    // An attachment can point at storage with NO files row beside it.
    expect(
      await as.mutation(api.archiveImport.discardUpload, {
        importId,
        storageId: usedByDoc,
      }),
    ).toEqual({ discarded: false });
    // Never uploaded by this import: not this call's to delete.
    expect(
      await as.mutation(api.archiveImport.discardUpload, {
        importId,
        storageId: unregistered,
      }),
    ).toEqual({ discarded: false });

    const remaining = await t.run((ctx) => ctx.db.query("uploads").collect());
    expect(remaining.map((r) => r.storageId).sort()).toEqual(
      [usedByFile, usedByDoc, unregistered].sort(),
    );
  });

  test("a SAME-DEPLOYMENT import never touches the conversation it copies", async () => {
    // Here the archive's identifiers ARE valid identifiers of this deployment.
    // A single path that used one as it stands would write into — or link to —
    // the original conversation instead of the copy.
    const t = convexTest(schema, modules);
    const importer = await user(t, true);
    const as = t.withIdentity({ subject: importer });
    const here = await t.run(async (ctx) => {
      const id = "atr_" + "1".repeat(32);
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: id,
        mintedForOrigin: null,
        mintedAt: 1,
      });
      return id;
    });

    // A REAL conversation, whose real identifiers the archive will carry.
    const { originalChat, originalMessage } = await t.run(async (ctx) => {
      const originalChat = await ctx.db.insert("chats", {
        userId: importer,
        title: "originale",
        updatedAt: 7,
        instanceName: "primary",
        agentId: "alice",
        pinned: true,
      });
      const originalMessage = await ctx.db.insert("messages", {
        chatId: originalChat,
        userId: importer,
        role: "user",
        status: "complete",
        text: "texte d origine",
        updatedAt: 7,
      });
      return { originalChat, originalMessage };
    });

    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: { formatVersion: ARCHIVE_FORMAT_VERSION, origin: here },
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [
        {
          _id: originalChat,
          title: "originale",
          updatedAt: 7,
          instanceName: "primary",
          agentId: "alice",
          pinned: true,
        },
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        {
          _id: originalMessage,
          chatId: originalChat,
          role: "user",
          status: "complete",
          text: "texte d origine",
          updatedAt: 7,
        },
      ],
    });

    const chats = await t.run((ctx) => ctx.db.query("chats").collect());
    expect(chats).toHaveLength(2);
    const copy = chats.find((c) => c._id !== originalChat)!;
    const original = chats.find((c) => c._id === originalChat)!;

    // The original is untouched, down to its pin and its timestamp.
    expect(original.pinned).toBe(true);
    expect(original.updatedAt).toBe(7);
    // The copy is a copy: reattached (it IS this deployment), but not pinned —
    // an import must not rearrange the sidebar — and stamped so the two can be
    // told apart at all, having the same title, content and agent.
    expect(copy.agentId).toBe("alice");
    expect(copy.pinned).toBeUndefined();
    expect(copy.importedFromOrigin).toBe(here);
    expect(copy.importedAt).toBeGreaterThan(0);

    // And the copied message belongs to the COPY, never to the original.
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(2);
    const copied = messages.find((m) => m._id !== originalMessage)!;
    expect(copied.chatId).toBe(copy._id);
  });

  test("an archive cannot CHOOSE the agent name shown on its history", async () => {
    // The label is what the interface shows in place of an agent. Accepting one
    // from the archive would let it name whoever it likes on history it did not
    // answer — and at any length.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "assistant",
          status: "complete",
          text: "x",
          updatedAt: 1,
          importedAgentLabel: "Direction".padEnd(5000, "!"),
        }),
      ],
    });

    const message = (await t.run((ctx) => ctx.db.query("messages").collect()))[0]!;
    expect(message.importedAgentLabel).toBeUndefined();
  });

  test("a filename inside a PART is sanitised like every other", async () => {
    // It is the name the conversation renders and a download uses — the very
    // reason the guard exists. Applying it everywhere except there applied it
    // everywhere except where it is read.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const storageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["x"]));
      await ctx.db.insert("uploads", { storageId: id, userId: importer });
      return id;
    });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", { chatId: "c1", role: "user", status: "complete", text: "x", updatedAt: 1 }),
      ],
    });

    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messageParts",
      rows: [
        archived("p1", {
          messageId: "m1",
          order: 0,
          part: {
            kind: "media",
            filename: "../../etc/passwd",
            mimeType: "image/png",
          },
          archiveBlobKeys: ["k1"],
        }),
      ],
      blobs: [{ key: "k1", storageId }],
    });

    const part = (await t.run((ctx) => ctx.db.query("messageParts").collect()))[0]!;
    expect((part.part as { filename: string }).filename).not.toContain("/");
  });

  test("abandoning an import with an ATTACHMENT leaves no bytes behind", async () => {
    // The blobs are registered before any row, so they come first in the index —
    // and one the import's own file row still references cannot be discarded
    // yet. Removing its mapping anyway left nothing able to name those bytes
    // once the row was gone.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const storageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["octets"]));
      await ctx.db.insert("uploads", { storageId: id, userId: importer });
      return id;
    });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.registerImportBlob, {
      importId,
      storageId,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", { chatId: "c1", role: "user", status: "complete", text: "x", updatedAt: 1 }),
      ],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "files",
      rows: [
        archived("f1", {
          chatId: "c1",
          messageId: "m1",
          archiveBlobKey: "k1",
          filename: "a.png",
          mimeType: "image/png",
          kind: "media",
          direction: "outbound",
          createdAt: 1,
        }),
      ],
      blobs: [{ key: "k1", storageId }],
    });

    let done = false;
    for (let i = 0; i < 10 && !done; i += 1) {
      done = (await as.mutation(api.archiveImport.abandonImport, { importId }))
        .done;
    }

    expect(done).toBe(true);
    // Nothing imported remains — and neither do its bytes.
    expect(await t.run((ctx) => ctx.db.query("chats").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("files").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("archiveImportIds").collect()),
    ).toHaveLength(0);
  });

  test("a follow-up still PARKED at the source does not sort last for ever", async () => {
    // Its exported order is the value that means "after everything". Copied
    // verbatim, every message this deployment writes from now on would sort
    // before it — and the import terminalises that message anyway.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "chats",
      rows: [archived("c1", { title: "t", updatedAt: 1 })],
    });
    await as.mutation(api.archiveImport.importBatch, {
      importId,
      section: "messages",
      rows: [
        archived("m1", {
          chatId: "c1",
          role: "user",
          status: "complete",
          text: "garee",
          updatedAt: 1,
          archiveOrder: QUEUED_ORDER_SENTINEL,
        }),
      ],
    });

    const message = (await t.run((ctx) => ctx.db.query("messages").collect()))[0]!;
    expect(message.orderTime).toBeLessThan(QUEUED_ORDER_SENTINEL);
  });

  test("uploading attachments keeps the import ALIVE", async () => {
    // Every blob goes up before the first batch, so a large archive spends its
    // longest stretch here. Without a heartbeat, another tab sees a session
    // untouched since it began, takes it for one a closed tab left behind, and
    // undoes it mid-transfer.
    const t = convexTest(schema, modules);
    const importer = await user(t);
    const as = t.withIdentity({ subject: importer });
    const importId = await as.mutation(api.archiveImport.beginImport, {
      manifest: MANIFEST,
    });
    const storageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["x"]));
      await ctx.db.insert("uploads", { storageId: id, userId: importer });
      // Backdated well past any staleness window.
      await ctx.db.patch(importId, { updatedAt: 1 });
      return id;
    });

    await as.mutation(api.archiveImport.registerImportBlob, {
      importId,
      storageId,
    });

    const session = (await t.run((ctx) => ctx.db.get(importId)))!;
    expect(session.updatedAt).toBeGreaterThan(1);
  });

  test("another user's import cannot be written to", async () => {
    const t = convexTest(schema, modules);
    const owner = await user(t);
    const stranger = await user(t);
    const importId = await t
      .withIdentity({ subject: owner })
      .mutation(api.archiveImport.beginImport, { manifest: MANIFEST });

    await expect(
      t.withIdentity({ subject: stranger }).mutation(
        api.archiveImport.importBatch,
        { importId, section: "chats", rows: [archived("c1", { updatedAt: 1 })] },
      ),
    ).rejects.toThrow(/Not found/);
  });
});
