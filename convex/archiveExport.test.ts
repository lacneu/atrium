/// <reference types="vite/client" />
//
// Reading a conversation out as an archive.
//
// What is pinned here is mostly what must NOT come out: the provider session
// state (which would have a bridge present a key its gateway never issued), the
// owner's identifier, and the storage pointers — each of which looks like
// harmless metadata and is not. Plus the two properties an archive is worthless
// without: it covers everything exactly once, and it says what it left behind.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  EXPORT_PAGE_SIZE,
  FOLDER_PAGE_SIZE,
  MAX_FOLDER_DEPTH,
  MAX_FOLDERS,
} from "./lib/exportArchive";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Annotated because the generated query type otherwise infers through the cursor
 *  it is fed, which TypeScript reports as a circular initialiser. */
interface SectionPage {
  rows: Record<string, unknown>[];
  cursor: string | null;
}

/** Pin what the backend reports as its origin, the way a deployment does. */
function atOrigin(origin: string | null): void {
  if (origin === null) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = origin;
}

const savedOrigin = process.env.CONVEX_CLOUD_URL;
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = savedOrigin;
});

async function user(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    return userId;
  });
}

async function chatFor(
  t: TestConvex<typeof schema>,
  userId: Id<"users">,
  extra: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "primary",
      agentId: "alice",
      title: "Bilan",
      ...extra,
    }),
  );
}

describe("archive export", () => {
  test("the provider SESSION never travels", async () => {
    // The failure this prevents: a restored chat carrying `recoverableSession`
    // has the bridge hand a gateway a session key it never issued — and it is
    // forwarded whenever the instance NAME matches, with "primary" the default
    // everywhere, so the collision is likely rather than exotic.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId, { openclawChatId: "gw-session-42" });
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "ok",
        updatedAt: 1,
      });
      await ctx.db.patch(chatId, {
        providerResetCount: 3,
        recoverableSession: {
          session: "sk-live",
          messageId,
          at: 1,
          instanceName: "primary",
        },
      });
    });

    const exported = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChat, { chatId });

    expect(exported).not.toHaveProperty("recoverableSession");
    expect(exported).not.toHaveProperty("openclawChatId");
    expect(exported).not.toHaveProperty("providerResetCount");
    expect(JSON.stringify(exported)).not.toContain("sk-live");
    // What the conversation IS, on the other hand, is all there.
    expect(exported.title).toBe("Bilan");
  });

  test("the per-turn routing SEGMENT is a session handle too", async () => {
    // On a per-turn routed conversation this is exactly what the bridge sends as
    // `openclawChatId`. Dropping only the field literally called that left the
    // gateway session in the archive under another name.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId, {
      perTurnRouting: true,
      routingSegment: "seg-live-99",
    });

    const exported = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChat, { chatId });

    expect(exported).not.toHaveProperty("routingSegment");
    expect(JSON.stringify(exported)).not.toContain("seg-live-99");
  });

  test("the owner's identifier never travels", async () => {
    // An import gives every row to the importing user, so carrying the original
    // owner would only put a person's identifier in a file that leaves here.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "bonjour",
        updatedAt: 1,
      });
    });
    const asUser = t.withIdentity({ subject: userId });

    const chat = await asUser.query(api.archiveExport.exportChat, { chatId });
    const messages = await asUser.query(api.archiveExport.exportChatSection, {
      chatId,
      section: "messages",
    });

    expect(chat).not.toHaveProperty("userId");
    expect(JSON.stringify(messages.rows)).not.toContain(userId);
  });

  test("a storage pointer never travels; bytes are referenced by an archive key", async () => {
    // A storageId points into THIS deployment's storage. An import that trusted
    // one from a file would be reading whatever that id names in the TARGET —
    // someone else's bytes. The archive names bytes only by a key of its own.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["contenu"])),
    );
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "ok",
        updatedAt: 1,
      });
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId,
        filename: "note.txt",
        mimeType: "text/plain",
        kind: "file",
        direction: "outbound",
        createdAt: 1,
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, { chatId, section: "files" });

    expect(JSON.stringify(page.rows)).not.toContain(storageId);
    expect(page.rows[0]).toHaveProperty("archiveBlobKey");
    // ...and the bytes are still reachable, or the export would be useless.
    expect(page.blobs).toHaveLength(1);
    expect(page.blobs[0]!.key).toBe(page.rows[0]!.archiveBlobKey);
    expect(page.blobs[0]!.url).toBeTruthy();
  });

  test("a DELETED file is not exported", async () => {
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"])),
    );
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "ok",
        updatedAt: 1,
      });
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId,
        filename: "retire.txt",
        mimeType: "text/plain",
        kind: "file",
        direction: "outbound",
        createdAt: 1,
        deletedAt: 99,
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, { chatId, section: "files" });

    expect(page.rows).toHaveLength(0);
    expect(page.blobs).toHaveLength(0);
  });

  test("another user's conversation cannot be exported", async () => {
    const t = convexTest(schema, modules);
    const owner = await user(t);
    const stranger = await user(t);
    const chatId = await chatFor(t, owner);

    await expect(
      t
        .withIdentity({ subject: stranger })
        .query(api.archiveExport.exportChat, { chatId }),
    ).rejects.toThrow();
    await expect(
      t
        .withIdentity({ subject: stranger })
        .query(api.archiveExport.exportChatSection, {
          chatId,
          section: "messages",
        }),
    ).rejects.toThrow();
  });

  test("paging covers every message exactly once", async () => {
    // An export that quietly dropped or repeated rows would be worse than one
    // that refused: nothing about the file would show it.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    const total = EXPORT_PAGE_SIZE * 2 + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i += 1) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user",
          status: "complete",
          text: `m-${i}`,
          updatedAt: i,
        });
      }
    });
    const asUser = t.withIdentity({ subject: userId });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: SectionPage = await asUser.query(
        api.archiveExport.exportChatSection,
        { chatId, section: "messages", cursor },
      );
      for (const row of page.rows) seen.push(row.text as string);
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== null && pages < 20);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  test("a storage pointer NESTED in a message part does not travel either", async () => {
    // A part carries its attachment's pointer inside free-form JSON. A strip that
    // only looked at top-level keys let it through — the very pointer the `files`
    // section was carefully removing.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["octets"])),
    );
    const fileId = await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "voici",
        updatedAt: 1,
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "media",
          storageId,
          filename: "p.png",
          mimeType: "image/png",
        },
      });
      return ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId,
        filename: "p.png",
        mimeType: "image/png",
        kind: "media",
        direction: "outbound",
        createdAt: 1,
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId,
        section: "messageParts",
      });

    expect(JSON.stringify(page.rows)).not.toContain(storageId);
    // ...and the bytes are still named, by the archive's own key.
    expect(page.rows[0]!.archiveBlobKeys).toEqual([fileId]);
  });

  test("a message with more parts than a page still exports ALL of them", async () => {
    // Reading a fixed slice of each message's parts dropped everything past it:
    // the cursor moved on to other messages and those parts were never exported,
    // while the export still claimed to cover the conversation.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    const total = EXPORT_PAGE_SIZE + 17;
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "long",
        updatedAt: 1,
      });
      for (let i = 0; i < total; i += 1) {
        await ctx.db.insert("messageParts", {
          messageId,
          order: i,
          part: { kind: "tool", name: `p-${i}`, phase: "result" },
        });
      }
    });
    const asUser = t.withIdentity({ subject: userId });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: SectionPage = await asUser.query(
        api.archiveExport.exportChatSection,
        { chatId, section: "messageParts", cursor },
      );
      for (const row of page.rows) {
        seen.push((row.part as { name: string }).name);
      }
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== null && pages < 20);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  test("dispatch and session state on a MESSAGE does not travel", async () => {
    // Exactly the session and queue state the manifest promises to leave behind,
    // and a modern assistant reply carries both.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "reponse",
        updatedAt: 1,
        turnSessionKey: "turn-sk-live",
        boundInstance: "primary",
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId,
        section: "messages",
      });

    expect(JSON.stringify(page.rows)).not.toContain("turn-sk-live");
    expect(page.rows[0]).not.toHaveProperty("boundInstance");
  });

  test("a blob is resolved WITHIN the exported conversation, not globally", async () => {
    // A forked conversation has its own `files` row over the same bytes. Taking
    // the first row that matches the pointer named the SOURCE chat's row — an
    // archive key this export never publishes — and the attachment was lost with
    // nothing to show for it.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const source = await chatFor(t, userId, { title: "source" });
    const fork = await chatFor(t, userId, { title: "fork" });
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["partages"])),
    );
    const forkFileId = await t.run(async (ctx) => {
      // The source's row exists FIRST, so a global lookup finds it first.
      const sourceMessage = await ctx.db.insert("messages", {
        chatId: source,
        userId,
        role: "user",
        status: "complete",
        text: "src",
        updatedAt: 1,
      });
      await ctx.db.insert("files", {
        userId,
        chatId: source,
        messageId: sourceMessage,
        storageId,
        filename: "img.png",
        mimeType: "image/png",
        kind: "media",
        direction: "outbound",
        createdAt: 1,
      });
      const forkMessage = await ctx.db.insert("messages", {
        chatId: fork,
        userId,
        role: "user",
        status: "complete",
        text: "fork",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: forkMessage,
        order: 0,
        part: {
          kind: "media",
          storageId,
          filename: "img.png",
          mimeType: "image/png",
        },
      });
      return ctx.db.insert("files", {
        userId,
        chatId: fork,
        messageId: forkMessage,
        storageId,
        filename: "img.png",
        mimeType: "image/png",
        kind: "media",
        direction: "outbound",
        createdAt: 2,
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId: fork,
        section: "messageParts",
      });

    // The key the FORK's own files section publishes, not the source's.
    expect(page.rows[0]!.archiveBlobKeys).toEqual([forkFileId]);
  });

  test("a tool's own payload is passed through UNTOUCHED", async () => {
    // `input`/`output` are free-form business content. Removing anything inside
    // them that merely shares a name with one of Atrium's structural keys would
    // silently mangle what the conversation actually said.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "outil",
        updatedAt: 1,
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "tool",
          name: "lookup",
          phase: "result",
          output: { userId: "client-123", storageId: "cle-externe" },
        },
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId,
        section: "messageParts",
      });

    const part = page.rows[0]!.part as { output: Record<string, unknown> };
    expect(part.output.userId).toBe("client-123");
    expect(part.output.storageId).toBe("cle-externe");
  });

  test("feedback REPORTS are not a way around the permission that guards them", async () => {
    // A report's thread carries administrator replies, read elsewhere behind a
    // permission and an audit trail. Exporting a conversation must not hand them
    // to whoever merely owns the chat.
    const t = convexTest(schema, modules);
    const userId = await user(t);

    const manifest = await t
      .withIdentity({ subject: userId })
      .action(api.archiveExport.exportManifest, {});

    expect(manifest.sections).not.toContain("subAgentReports");
    // And the omission is STATED — an archive silent about it reads as complete.
    expect(
      manifest.notIncluded.some((entry) => /report/i.test(entry.what)),
    ).toBe(true);
  });

  test("a sub-agent's gateway session metadata does not travel", async () => {
    // The manifest promises resumable provider handles stay behind. What links
    // rows to each other is kept — it is what holds the archive together.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "child-key-1",
        kind: "task",
        status: "done",
        createdAt: 1,
        updatedAt: 1,
        sessionMeta: { sessionId: "gw-session-secret" },
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId,
        section: "subAgents",
      });

    expect(JSON.stringify(page.rows)).not.toContain("gw-session-secret");
    // ...while the join that makes the archive readable survives.
    expect(page.rows[0]!.childSessionKey).toBe("child-key-1");
  });

  test("an attachment with no bytes gets NO blob key", async () => {
    // A pending or failed attachment has no storage. Publishing a key with no
    // entry behind it is indistinguishable from a blob that went missing.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "doc",
        updatedAt: 1,
      });
      await ctx.db.insert("documentAttachments", {
        userId,
        sourceMessageId: messageId,
        entryKey: "e1",
        reference: "r1",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId,
        section: "documentAttachments",
      });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).not.toHaveProperty("archiveBlobKey");
    expect(page.blobs).toHaveLength(0);
  });

  test("messages carry the order the SOURCE displays, not their creation order", async () => {
    // A follow-up queued mid-turn is created BEFORE the reply to the turn it
    // interrupted, and still belongs after it. Emitting creation order would bake
    // that inversion into the archive — and no amount of sorting on the import
    // side could repair it, since the two can fall on different pages.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const chatId = await chatFor(t, userId);
    await t.run(async (ctx) => {
      const asked = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "question",
        updatedAt: 1,
      });
      // Created NEXT, yet it belongs LAST: queued mid-turn, then re-stamped on
      // drain to a time after the reply.
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: "relance",
        updatedAt: 2,
        orderTime: Date.now() + 60_000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "reponse",
        updatedAt: 3,
      });
      return asked;
    });

    const page = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportChatSection, {
        chatId,
        section: "messages",
      });

    expect(page.rows.map((row) => row.text)).toEqual([
      "question",
      "reponse",
      "relance",
    ]);
    // ...and each carries that order explicitly, so an import needs no page to
    // be complete to reproduce it.
    for (const row of page.rows) {
      expect(typeof row.archiveOrder).toBe("number");
    }
    const orders = page.rows.map((row) => row.archiveOrder as number);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  test("a folder CYCLE does not hang the walk", async () => {
    // `projects.parentId` is a plain reference and nothing in the schema forbids
    // a cycle. A walk that trusted it would not terminate.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const { a } = await t.run(async (ctx) => {
      const a = await ctx.db.insert("projects", { userId, name: "A" });
      const b = await ctx.db.insert("projects", {
        userId,
        name: "B",
        parentId: a,
      });
      await ctx.db.patch(a, { parentId: b });
      return { a };
    });

    const tree = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportFolderTree, { projectId: a });

    expect(tree.folders.map((f) => f.name).sort()).toEqual(["A", "B"]);
  });

  test("a subtree deeper than the bound REPORTS itself incomplete", async () => {
    // Silently shipping a subtree that is missing folders is the failure: the
    // file would look complete to whoever opens it.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const root = await t.run(async (ctx) => {
      let parentId: Id<"projects"> | undefined = undefined;
      let first: Id<"projects"> | undefined = undefined;
      for (let i = 0; i <= MAX_FOLDER_DEPTH + 2; i += 1) {
        const id: Id<"projects"> = await ctx.db.insert("projects", {
          userId,
          name: `n-${i}`,
          ...(parentId === undefined ? {} : { parentId }),
        });
        first ??= id;
        parentId = id;
      }
      return first!;
    });

    const tree = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportFolderTree, { projectId: root });

    expect(tree.complete).toBe(false);
  });

  test("another user's folder cannot be exported, nor reached through one", async () => {
    const t = convexTest(schema, modules);
    const owner = await user(t);
    const stranger = await user(t);
    const { mine } = await t.run(async (ctx) => {
      const mine = await ctx.db.insert("projects", { userId: owner, name: "M" });
      // A stray row naming an owned folder as its parent must not widen the walk.
      await ctx.db.insert("projects", {
        userId: stranger,
        name: "leur",
        parentId: mine,
      });
      return { mine };
    });

    await expect(
      t
        .withIdentity({ subject: stranger })
        .query(api.archiveExport.exportFolderTree, { projectId: mine }),
    ).rejects.toThrow();

    const tree = await t
      .withIdentity({ subject: owner })
      .query(api.archiveExport.exportFolderTree, { projectId: mine });
    expect(tree.folders.map((f) => f.name)).toEqual(["M"]);
  });

  test("the manifest never stamps an identity minted for ANOTHER deployment", async () => {
    // After a database is restored elsewhere, the stored row still names the
    // deployment it came from. Stamping that onto an archive would have the
    // archive read as LOCAL back at the original — reattaching agents that were
    // never its own. What this deployment gets instead is an identity of its own.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const foreign = "atr_" + "a".repeat(32);
    await t.run(async (ctx) => {
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: foreign,
        mintedForOrigin: "https://elsewhere.test",
        mintedAt: 1,
      });
    });
    const asUser = t.withIdentity({ subject: userId });

    atOrigin("https://here.test");
    const moved = await asUser.action(api.archiveExport.exportManifest, {});
    expect(moved.origin).not.toBe(foreign);
    expect(moved.origin).toMatch(/^atr_[0-9a-f]{32}$/);

    // ...and it is stable from then on: an identity that moved would make this
    // deployment's own earlier archives read as foreign.
    expect((await asUser.action(api.archiveExport.exportManifest, {})).origin).toBe(
      moved.origin,
    );
  });

  test("the manifest states NO origin when nothing speaks for this deployment", async () => {
    // A database that merged two deployments: neither identity can be shown to be
    // this one's. An archive with no origin is treated as foreign — readable,
    // never reattached — which is the safe reading, so silence is the answer.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    await t.run(async (ctx) => {
      for (const origin of ["https://one.test", "https://two.test"]) {
        await ctx.db.insert("deploymentIdentity", {
          deploymentId: `atr_${origin.length}`.padEnd(36, "0"),
          mintedForOrigin: origin,
          mintedAt: 1,
        });
      }
    });
    atOrigin(null);

    const manifest = await t
      .withIdentity({ subject: userId })
      .action(api.archiveExport.exportManifest, {});

    expect(manifest.origin).toBe(null);
  });

  test("a subtree WIDER than the budget reports itself incomplete", async () => {
    // The per-parent bound does not bound the walk: a tree that stays under it at
    // each step still reads tens of thousands of rows in one transaction, which
    // fails as a limit error rather than as an answer.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const root = await t.run(async (ctx) => {
      const root = await ctx.db.insert("projects", { userId, name: "r" });
      const level1: Id<"projects">[] = [];
      for (let i = 0; i < FOLDER_PAGE_SIZE; i += 1) {
        level1.push(
          await ctx.db.insert("projects", {
            userId,
            name: `a-${i}`,
            parentId: root,
          }),
        );
      }
      const perParent = Math.ceil(MAX_FOLDERS / FOLDER_PAGE_SIZE) + 1;
      for (let i = 0; i < perParent; i += 1) {
        for (let j = 0; j < FOLDER_PAGE_SIZE; j += 1) {
          await ctx.db.insert("projects", {
            userId,
            name: `b-${i}-${j}`,
            parentId: level1[i]!,
          });
        }
      }
      return root;
    });

    const tree = await t
      .withIdentity({ subject: userId })
      .query(api.archiveExport.exportFolderTree, { projectId: root });

    expect(tree.complete).toBe(false);
    expect(tree.folders.length).toBeLessThanOrEqual(MAX_FOLDERS + FOLDER_PAGE_SIZE);
  });

  test("the manifest states what the archive leaves behind", async () => {
    // An export silent about its omissions reads as complete. Whoever opens one
    // months later cannot otherwise tell a conversation that carried no
    // attachments from one whose attachments were dropped.
    const t = convexTest(schema, modules);
    const userId = await user(t);

    const manifest = await t
      .withIdentity({ subject: userId })
      .action(api.archiveExport.exportManifest, {});

    expect(manifest.formatVersion).toBeGreaterThan(0);
    expect(manifest.notIncluded.length).toBeGreaterThan(0);
    for (const entry of manifest.notIncluded) {
      expect(entry.why.length).toBeGreaterThan(0);
    }
    expect(manifest.chatFieldsDropped).toContain("recoverableSession");
    // MINTED HERE. Reading the table and hoping something else had filled it left
    // every archive stamped with no origin — foreign everywhere, including back
    // here, so nothing would ever have reattached.
    expect(manifest.origin).toMatch(/^atr_[0-9a-f]{32}$/);
  });
});
