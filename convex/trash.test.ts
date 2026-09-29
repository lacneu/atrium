/// <reference types="vite/client" />
//
// THE CONVERSATION TRASH, from the outside: what deleting a conversation hides, who
// may bring it back, and what its permanent purge removes — every table it touched
// and every storage blob nothing else still references.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolveChatAccess } from "./lib/chatAccess";
import { blobReference, endQuarantine, releaseBlob } from "./lib/blobs";
import { purgeDateFor, trashRetentionDays } from "./lib/trash";
import { classifyBlob, sweepCutoff } from "./lib/blobSweep";
import { ARCHIVE_FORMAT_VERSION } from "./lib/exportArchive";
import { notifyUser } from "./notifications";
import { PART_STORAGE_BACKFILL } from "./blobQuarantine";
import { CHAT_SWEEP_BUDGET, cascadeDeleteChat } from "./chats";
import { failDocumentaryFetchForChat } from "./documentAttachments";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const DAY = 24 * 60 * 60 * 1000;
const PAGE = { numItems: 50, cursor: null };

async function seedUser(
  t: T,
  name: string,
  role: "user" | "admin" = "user",
): Promise<Id<"users">> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role,
      canonical: name,
      name,
      email: `${name}@example.com`,
    });
    return userId;
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: userId });

async function seedChat(
  t: T,
  userId: Id<"users">,
  title = "Budget trimestriel",
  extra: { projectId?: Id<"projects"> } = {},
): Promise<Id<"chats">> {
  return t.run(async (ctx) =>
    ctx.db.insert("chats", { userId, updatedAt: 1, title, ...extra }),
  );
}

async function storeBlob(t: T, body = "bytes"): Promise<Id<"_storage">> {
  return t.run(async (ctx) => ctx.storage.store(new Blob([body])));
}

/** Is the blob HELD: in storage and not released into the quarantine? A released
 *  blob (lib/blobs.releaseBlob) reads false at once — its deletion comes a week
 *  later, from the quarantine purge, and is tested there. */
async function blobExists(t: T, id: Id<"_storage">): Promise<boolean> {
  return t.run(async (ctx) => {
    if ((await ctx.db.system.get("_storage", id)) === null) return false;
    const released = (await ctx.db.query("blobReleases").collect()).some(
      (r) => r.storageId === id,
    );
    return !released;
  });
}

async function seat(t: T, chatId: Id<"chats">, userId: Id<"users">, addedBy: Id<"users">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("chatParticipants", { chatId, userId, addedBy, addedAt: 1 });
  });
}

/** An assistant reply holding one file part (and its files mirror) on `blob`. */
async function replyWithFile(
  t: T,
  chatId: Id<"chats">,
  owner: Id<"users">,
  blob: Id<"_storage">,
): Promise<Id<"messages">> {
  return t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: owner,
      role: "assistant" as const,
      status: "complete" as const,
      text: "voici le fichier",
      updatedAt: 1,
    });
    const part = { kind: "file" as const, storageId: blob, filename: "a.pdf", mimeType: "application/pdf" };
    await ctx.db.insert("messageParts", { messageId, order: 0, part });
    await ctx.db.insert("files", {
      userId: owner,
      chatId,
      messageId,
      storageId: blob,
      filename: "a.pdf",
      mimeType: "application/pdf",
      kind: "file" as const,
      direction: "outbound" as const,
      category: "pdf",
      createdAt: 1,
    });
    return messageId;
  });
}

async function settle(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Let every quarantine end: the part index is complete, a week and a day pass,
 *  and the purge runs to the end. */
async function endQuarantines(t: T) {
  await t.run(async (ctx) => {
    if ((await ctx.db.query("migrationMarkers").collect()).length === 0) {
      await ctx.db.insert("migrationMarkers", {
        key: PART_STORAGE_BACKFILL,
        cursor: null,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
    }
  });
  vi.setSystemTime(Date.now() + 8 * DAY);
  await t.mutation(internal.blobQuarantine.purgeQuarantine, {});
  await settle(t);
}

/** Is the blob gone from storage altogether (its quarantine ended)? */
async function blobDeleted(t: T, id: Id<"_storage">): Promise<boolean> {
  return t.run(async (ctx) => (await ctx.db.system.get("_storage", id)) === null);
}

async function trashAndPurge(t: T, owner: Id<"users">, chatId: Id<"chats">) {
  await as(t, owner).mutation(api.chats.deleteChat, { chatId });
  await as(t, owner).mutation(api.trash.purgeChat, { chatId });
  await settle(t);
}

describe("deleting a conversation moves it to the trash", () => {
  test("nothing is deleted: it is set aside with its purge date, and the owner sees it in the trash", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t);
    const replyId = await replyWithFile(t, chatId, owner, blob);

    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    await settle(t);

    const row = await t.run((ctx) => ctx.db.get(chatId));
    expect(row).not.toBeNull();
    expect(row!.trashedAt).toBeTypeOf("number");
    expect(row!.purgeAfter).toBe(purgeDateFor(row!.trashedAt!));
    expect(row!.purgeAfter! - row!.trashedAt!).toBe(30 * DAY);
    expect(row!.trashedBy).toBe(owner);
    expect(await t.run((ctx) => ctx.db.get(replyId))).not.toBeNull();
    expect(await blobExists(t, blob)).toBe(true);
    const trash = (await as(t, owner).query(api.trash.listMyTrash, { paginationOpts: PAGE })).page;
    expect(trash.map((r) => r._id)).toEqual([chatId]);
    expect(trash[0]!.title).toBe("Budget trimestriel");
    // The operator's chat-state inspector still reads it, and says it is trashed.
    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok && state.trash).toEqual({
      trashedAt: row!.trashedAt,
      purgeAfter: row!.purgeAfter,
    });
  });

  test("a PINNED conversation leaves the sidebar too (the pinned set is read apart)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chats.pinChat, { chatId, pinned: true });
    // Older than the recency window's reach, so only the pinned read can list it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 1001; i += 1) {
        await ctx.db.insert("chats", { userId: owner, updatedAt: 10 + i, archived: true });
      }
    });
    expect((await as(t, owner).query(api.messages.listChats, {})).map((c) => c._id)).toEqual([chatId]);
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    expect(await as(t, owner).query(api.messages.listChats, {})).toEqual([]);
  }, 30_000);

  test("a new conversation is placed above the live ones, not above what sits in the trash", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    await t.run(async (ctx) => {
      await ctx.db.insert("chats", { userId: owner, updatedAt: 1, sortKey: 0 });
      await ctx.db.insert("chats", {
        userId: owner,
        updatedAt: 1,
        sortKey: -100,
        trashedAt: 1,
        purgeAfter: 1 + 30 * DAY,
      });
    });
    const created = await as(t, owner).mutation(api.chats.createChat, {});
    expect((await t.run((ctx) => ctx.db.get(created)))!.sortKey).toBe(-1);
  });

  test("it is hidden everywhere: sidebar, search, folder page, files, badges, references, fork", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const folder = await as(t, owner).mutation(api.projects.createProject, { name: "Finances" });
    const chatId = await seedChat(t, owner, "Budget trimestriel", { projectId: folder });
    const blob = await storeBlob(t);
    const replyId = await replyWithFile(t, chatId, owner, blob);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRequests", {
        chatId,
        userId: owner,
        instanceName: "primary",
        source: "openclaw.ask_user" as const,
        kind: "question" as const,
        providerRequestId: "q1",
        status: "pending" as const,
        createdAt: Date.now(),
        expiresAt: Date.now() + DAY,
        updatedAt: Date.now(),
      });
    });
    const me = as(t, owner);
    // Visible before.
    expect((await me.query(api.messages.listChats, {})).map((c) => c._id)).toContain(chatId);
    expect((await me.query(api.search.searchConversations, { query: "Budget" })).length).toBe(1);
    expect((await me.query(api.projects.projectPage, { projectId: folder }))!.chats).toHaveLength(1);
    expect((await me.query(api.projects.projectTreeList, { projectId: folder }))!.chats).toHaveLength(1);
    expect((await me.query(api.projects.folderColumns, { projectId: folder })).columns[1]!.chats).toHaveLength(1);
    expect(await me.query(api.projects.projectChatCount, { projectId: folder })).toBe(1);
    expect((await me.query(api.files.listMine, {})).files).toHaveLength(1);
    expect(await me.query(api.agentRequests.pendingByChat, {})).toHaveLength(1);

    await me.mutation(api.chats.deleteChat, { chatId });

    expect((await me.query(api.messages.listChats, {})).map((c) => c._id)).not.toContain(chatId);
    expect(await me.query(api.search.searchConversations, { query: "Budget" })).toEqual([]);
    expect(await me.query(api.search.searchConversations, { query: "fichier" })).toEqual([]);
    expect((await me.query(api.projects.projectPage, { projectId: folder }))!.chats).toEqual([]);
    expect((await me.query(api.projects.projectTreeList, { projectId: folder }))!.chats).toEqual([]);
    expect((await me.query(api.projects.folderColumns, { projectId: folder })).columns[1]!.chats).toEqual([]);
    expect(await me.query(api.projects.projectChatCount, { projectId: folder })).toBe(0);
    expect(await me.query(api.projects.projectTreeCount, { projectId: folder })).toEqual({
      folders: 0,
      chats: 0,
    });
    const files = await me.query(api.files.listMine, {});
    expect(files.files).toEqual([]);
    expect(files.facets.chats).toEqual([]);
    expect(await me.query(api.agentRequests.pendingByChat, {})).toEqual([]);
    // The conversation page reads as "not found", never as a permission error.
    expect(await me.query(api.messages.listByChat, { chatId })).toEqual([]);
    expect(await me.query(api.messages.getSessionMeta, { chatId })).toBeNull();
    // A pasted reference to it resolves to nothing; it cannot be branched.
    const reference = String(chatId);
    expect(await me.query(api.chatExport.exportByReference, { reference })).toBeNull();
    await expect(me.mutation(api.chatFork.forkChat, { branchMessageId: replyId })).rejects.toThrow(
      /forbidden/,
    );
    // Nothing is posted to it.
    await expect(
      me.mutation(api.send.sendMessage, { chatId, text: "encore", clientMessageId: "c-1" }),
    ).rejects.toThrow(/Not found/);
  });

  test("its bell entries are withdrawn for everyone, and nothing new rings while it is there", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const guest = await seedUser(t, "denis");
    const chatId = await seedChat(t, owner);
    await seat(t, chatId, guest, owner);
    await t.run(async (ctx) => {
      await notifyUser(ctx, {
        userId: guest,
        kind: "mention",
        title: "t",
        body: "b",
        dedupeKey: "mention:m1",
        chatId,
      });
      await notifyUser(ctx, {
        userId: owner,
        kind: "agent_request",
        title: "t",
        body: "b",
        dedupeKey: "agent_request:r1",
        chatId,
      });
      // Not about this conversation: untouched.
      await notifyUser(ctx, { userId: owner, kind: "feedback_reply", title: "t", body: "b" });
    });
    expect(await as(t, guest).query(api.notifications.myUnreadCount, {})).toBe(1);

    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    await settle(t);

    expect(await as(t, guest).query(api.notifications.myUnreadCount, {})).toBe(0);
    const ownerFeed = await as(t, owner).query(api.notifications.myNotifications, {});
    expect(ownerFeed.map((n) => n.kind)).toEqual(["feedback_reply"]);
    const rung = await t.run(async (ctx) =>
      notifyUser(ctx, { userId: guest, kind: "mention", title: "t", body: "b", chatId }),
    );
    expect(rung).toBeNull();
  });
});

describe("rights", () => {
  test("a participant loses access at once and gets it back with a restore (the seat is kept)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const guest = await seedUser(t, "denis");
    const chatId = await seedChat(t, owner);
    await seat(t, chatId, guest, owner);
    expect((await as(t, guest).query(api.messages.listChats, {})).map((c) => c._id)).toContain(
      chatId,
    );

    await as(t, owner).mutation(api.chats.deleteChat, { chatId });

    expect(await t.run((ctx) => resolveChatAccess(ctx, chatId, guest))).toBeNull();
    expect(await t.run((ctx) => resolveChatAccess(ctx, chatId, owner))).toBeNull();
    expect((await as(t, guest).query(api.messages.listChats, {}))).toEqual([]);
    await expect(
      as(t, guest).mutation(api.send.sendMessage, { chatId, text: "?", clientMessageId: "g-1" }),
    ).rejects.toThrow(/Not found/);
    const seats = await t.run((ctx) =>
      ctx.db
        .query("chatParticipants")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    expect(seats).toHaveLength(1);

    await as(t, owner).mutation(api.trash.restoreChat, { chatId });

    const back = await t.run((ctx) => resolveChatAccess(ctx, chatId, guest));
    expect(back?.role).toBe("participant");
    expect((await as(t, guest).query(api.messages.listChats, {})).map((c) => c._id)).toContain(
      chatId,
    );
    expect((await t.run((ctx) => ctx.db.get(chatId)))!.trashedAt).toBeUndefined();
    expect((await as(t, owner).query(api.trash.listMyTrash, { paginationOpts: PAGE })).page).toEqual([]);
  });

  test("only the owner trashes; a participant or a stranger can neither restore nor purge", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const guest = await seedUser(t, "denis");
    const stranger = await seedUser(t, "mallory");
    const chatId = await seedChat(t, owner);
    await seat(t, chatId, guest, owner);

    await expect(as(t, guest).mutation(api.chats.deleteChat, { chatId })).rejects.toThrow(
      /Forbidden/,
    );
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    for (const who of [guest, stranger]) {
      await expect(as(t, who).mutation(api.trash.restoreChat, { chatId })).rejects.toThrow(
        /Not found/,
      );
      await expect(as(t, who).mutation(api.trash.purgeChat, { chatId })).rejects.toThrow(
        /Not found/,
      );
      expect((await as(t, who).query(api.trash.listMyTrash, { paginationOpts: PAGE })).page).toEqual([]);
      await expect(as(t, who).query(api.trash.adminListTrash, { paginationOpts: PAGE })).rejects.toThrow(/admin/);
    }
    // A live conversation is not "in the trash": restore/purge refuse it too.
    const live = await seedChat(t, owner, "Autre");
    await expect(as(t, owner).mutation(api.trash.purgeChat, { chatId: live })).rejects.toThrow(
      /Not found/,
    );
    expect(await t.run((ctx) => ctx.db.get(chatId))).not.toBeNull();
  });

  test("an admin sees every trash and restores or purges any conversation, audit-logged", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "root", "admin");
    const alice = await seedUser(t, "alice");
    const bob = await seedUser(t, "bob");
    const a = await seedChat(t, alice, "A");
    const b = await seedChat(t, bob, "B");
    await as(t, alice).mutation(api.chats.deleteChat, { chatId: a });
    await as(t, bob).mutation(api.chats.deleteChat, { chatId: b });

    const all = (await as(t, admin).query(api.trash.adminListTrash, { paginationOpts: PAGE })).page;
    expect(all.map((r) => [r._id, r.owner]).sort()).toEqual(
      [
        [a, "alice"],
        [b, "bob"],
      ].sort(),
    );

    await as(t, admin).mutation(api.trash.adminRestoreChat, { chatId: a });
    await as(t, admin).mutation(api.trash.adminPurgeChat, { chatId: b });
    await settle(t);

    expect((await t.run((ctx) => ctx.db.get(a)))!.trashedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(b))).toBeNull();
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((r) => [r.action, r.resourceId, r.realUserId])).toEqual(
      expect.arrayContaining([
        ["chat.admin_restore", a, admin],
        ["chat.admin_purge", b, admin],
      ]),
    );
  });
});

describe("the permanent purge", () => {
  test("removes every chat-bound table and every blob nothing else references; keeps forensic reports and a live call", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const guest = await seedUser(t, "denis");
    const chatId = await seedChat(t, owner);
    await seat(t, chatId, guest, owner);
    const upload = await storeBlob(t, "upload");
    const delivered = await storeBlob(t, "delivered");
    const fetched = await storeBlob(t, "fetched");
    const pdf = await storeBlob(t, "pdf");
    const outboxOnly = await storeBlob(t, "outbox-only");
    const heldElsewhere = await storeBlob(t, "logo");
    const now = Date.now();
    const ids = await t.run(async (ctx) => {
      const userMsg = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "user" as const,
        status: "complete" as const,
        text: "voici",
        updatedAt: 1,
      });
      const part = { kind: "file" as const, storageId: upload, filename: "a.docx", mimeType: "application/msword" };
      await ctx.db.insert("messageParts", { messageId: userMsg, order: 0, part });
      await ctx.db.insert("files", {
        userId: owner,
        chatId,
        messageId: userMsg,
        storageId: upload,
        filename: "a.docx",
        mimeType: "application/msword",
        kind: "file" as const,
        direction: "inbound" as const,
        createdAt: 1,
      });
      await ctx.db.insert("uploads", { storageId: upload, userId: owner });
      await ctx.db.insert("uploads", { storageId: outboxOnly, userId: owner });
      const sentRow = await ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "c1",
        messageId: userMsg,
        text: "voici",
        attachmentIds: [upload, heldElsewhere],
        status: "sent" as const,
      });
      // A blob this send attached that something OUTSIDE the conversation still
      // holds (a chart's logo): the purge releases it, and it stays.
      await ctx.db.insert("charts", {
        key: "brand",
        name: "Brand",
        scope: "common" as const,
        tokens: { colors: { light: { primary: "x" }, dark: { primary: "y" } } },
        logoLightStorageId: heldElsewhere,
        createdBy: owner,
        createdAt: 1,
      });
      // A turn whose message is gone: its blob is named by nothing but this row.
      await ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "c0",
        text: "old",
        attachmentIds: [],
        attachments: [{ storageId: outboxOnly, filename: "o.txt", mimeType: "text/plain" }],
        status: "failed" as const,
      });
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: upload,
        chatId,
        userId: owner,
        sourceFilename: "a.docx",
        sourceMimeType: "application/msword",
        status: "ready" as const,
        pdfStorageId: pdf,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
      const reply = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
      const media = { kind: "media" as const, storageId: delivered, filename: "b.png", mimeType: "image/png" };
      await ctx.db.insert("messageParts", { messageId: reply, order: 0, part: media });
      await ctx.db.insert("files", {
        userId: owner,
        chatId,
        messageId: reply,
        storageId: delivered,
        filename: "b.png",
        mimeType: "image/png",
        kind: "media" as const,
        direction: "outbound" as const,
        createdAt: 1,
      });
      await ctx.db.insert("documentAttachments", {
        userId: owner,
        sourceMessageId: reply,
        reference: "doc.pdf",
        status: "ready" as const,
        storageId: fetched,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("streamingText", { messageId: reply, chatId, text: "…", updatedAt: 1 });
      await ctx.db.insert("liveTurnActivity", { messageId: reply, at: 1 });
      await ctx.db.insert("streamChunks", { messageId: reply, chatId, seq: 1, kind: "append" as const, text: "…" });
      await ctx.db.insert("chatReads", { userId: guest, chatId, lastSeenAt: 1 });
      await ctx.db.insert("chatBookmarks", { userId: owner, chatId, messageId: reply, createdAt: 1 });
      await ctx.db.insert("documentDrafts", {
        userId: guest,
        chatId,
        filename: "b.md",
        text: "brouillon",
        updatedAt: 1,
        createdAt: 1,
      });
      const subAgentId = await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:a:subagent:1",
        status: "done" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("subAgentToolParts", {
        chatId,
        childSessionKey: "agent:a:subagent:1",
        toolCallId: "t1",
        name: "read",
        status: "done" as const,
        updatedAt: 1,
      });
      await ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "agent:a:subagent:1",
        userText: "et alors ?",
        status: "done" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("chatAgents", {
        chatId,
        instanceName: "primary",
        agentId: "bob",
        addedBy: owner,
        addedAt: 1,
      });
      await ctx.db.insert("deliveryTimings", { sessionId: "s", chatId, t1: 1, t2: 1, t3: 1 });
      const talk = {
        userId: owner,
        chatId,
        instanceName: "primary",
        agentId: "a",
        canonical: "olivier",
        conversation: String(chatId),
        createdAt: now,
        expiresAt: now + 2 * 60 * 60 * 1000,
      };
      const endedCall = await ctx.db.insert("talkSessions", { ...talk, endedAt: now });
      const liveCall = await ctx.db.insert("talkSessions", talk);
      const feedbackId = await ctx.db.insert("feedback", {
        userId: owner,
        realUserId: owner,
        impersonated: false,
        chatId,
        messageId: reply,
        at: 1,
        category: "other",
        snapshot: { messageRole: "assistant", messageText: "x" },
      });
      return { userMsg, reply, subAgentId, endedCall, liveCall, feedbackId };
    });

    // The bell entry is written AFTER the trash withdrew the others: a purge must
    // still find what was rung by any path (a legacy producer, a race).
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    await t.run(async (ctx) => {
      await ctx.db.insert("notifications", {
        userId: guest,
        kind: "mention" as const,
        title: "t",
        body: "b",
        chatId,
        createdAt: 1,
      });
    });
    // In the trash, nothing is released yet.
    for (const blob of [upload, delivered, fetched, pdf, outboxOnly]) {
      expect(await blobExists(t, blob)).toBe(true);
    }

    // Past the week, the upload registrations no longer hold their blobs (a usable
    // one would: its owner may still attach it — see the upload tests below).
    vi.setSystemTime(Date.now() + 8 * DAY);
    await as(t, owner).mutation(api.trash.purgeChat, { chatId });
    await settle(t);

    const left = await t.run(async (ctx) => {
      const byChat = async (table: "outbox" | "subAgents" | "subAgentToolParts" | "subAgentInteractions" | "chatAgents" | "streamingText" | "streamChunks" | "files" | "documentDrafts" | "chatReads" | "chatBookmarks" | "chatParticipants" | "notifications" | "deliveryTimings" | "fileRenditions") =>
        (await ctx.db.query(table).collect()).filter((r) => (r as { chatId?: string }).chatId === chatId).length;
      return {
        chat: await ctx.db.get(chatId),
        messages: (await ctx.db.query("messages").collect()).length,
        parts: (await ctx.db.query("messageParts").collect()).length,
        docs: (await ctx.db.query("documentAttachments").collect()).length,
        live: (await ctx.db.query("liveTurnActivity").collect()).length,
        uploads: (await ctx.db.query("uploads").collect()).length,
        ledger: (await ctx.db.query("chatPurges").collect()).length,
        outbox: await byChat("outbox"),
        subAgents: await byChat("subAgents"),
        toolParts: await byChat("subAgentToolParts"),
        interactions: await byChat("subAgentInteractions"),
        chatAgents: await byChat("chatAgents"),
        streamingText: await byChat("streamingText"),
        streamChunks: await byChat("streamChunks"),
        files: await byChat("files"),
        drafts: await byChat("documentDrafts"),
        reads: await byChat("chatReads"),
        bookmarks: await byChat("chatBookmarks"),
        seats: await byChat("chatParticipants"),
        notifications: await byChat("notifications"),
        timings: await byChat("deliveryTimings"),
        renditions: await byChat("fileRenditions"),
        endedCall: await ctx.db.get(ids.endedCall),
        liveCall: await ctx.db.get(ids.liveCall),
        feedback: await ctx.db.get(ids.feedbackId),
      };
    });
    expect(left).toMatchObject({
      chat: null,
      messages: 0,
      parts: 0,
      docs: 0,
      live: 0,
      ledger: 0,
      outbox: 0,
      subAgents: 0,
      toolParts: 0,
      interactions: 0,
      chatAgents: 0,
      streamingText: 0,
      streamChunks: 0,
      files: 0,
      drafts: 0,
      reads: 0,
      bookmarks: 0,
      seats: 0,
      notifications: 0,
      timings: 0,
      endedCall: null,
    });
    // KEPT by decision: forensic support records, and a call not ended yet (its
    // hangup authorizes on the row; the talk janitor's TTL removes it).
    expect(left.feedback).not.toBeNull();
    expect(left.liveCall).not.toBeNull();
    expect(await blobExists(t, heldElsewhere)).toBe(true);
    for (const blob of [upload, delivered, fetched, outboxOnly]) {
      expect(await blobExists(t, blob)).toBe(false);
    }
    // The rendered PDF is still held by its rendition, which goes only with its
    // source's deletion.
    expect(await blobExists(t, pdf)).toBe(true);
    // A week later the quarantine ends: the blobs are deleted, with what existed only
    // because of them — the renditions of a deleted source (whose PDF is released in
    // turn), the upload registrations.
    await endQuarantines(t);
    expect(await blobExists(t, pdf)).toBe(false);
    await endQuarantines(t);
    for (const blob of [upload, delivered, fetched, pdf, outboxOnly]) {
      expect(await blobDeleted(t, blob)).toBe(true);
    }
    const derived = await t.run(async (ctx) => ({
      uploads: (await ctx.db.query("uploads").collect()).length,
      renditions: (await ctx.db.query("fileRenditions").collect()).length,
      quarantine: (await ctx.db.query("blobReleases").collect()).length,
    }));
    expect(derived).toEqual({ uploads: 0, renditions: 0, quarantine: 0 });
    expect(await blobDeleted(t, heldElsewhere)).toBe(false);
  }, 30_000);

  test("a blob shared by a fork and its source survives the purge of one and goes with the last", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const source = await seedChat(t, owner, "Source");
    const blob = await storeBlob(t);
    const replyId = await replyWithFile(t, source, owner, blob);
    const { chatId: fork } = await as(t, owner).mutation(api.chatFork.forkChat, {
      branchMessageId: replyId,
    });
    // The fork carries the SAME storage id (no copy of the bytes).
    const forkFiles = await t.run((ctx) =>
      ctx.db
        .query("files")
        .withIndex("by_chat_storage", (q) => q.eq("chatId", fork).eq("storageId", blob))
        .collect(),
    );
    expect(forkFiles).toHaveLength(1);

    await trashAndPurge(t, owner, source);
    expect(await t.run((ctx) => ctx.db.get(source))).toBeNull();
    expect(await blobExists(t, blob)).toBe(true);

    await trashAndPurge(t, owner, fork);
    expect(await blobExists(t, blob)).toBe(false);
  });

  test("a purge whose chain died halfway is finished by the next cron run", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const count = CHAT_SWEEP_BUDGET + 200;
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await ctx.db.insert("messages", {
          chatId,
          userId: owner,
          role: "user" as const,
          status: "complete" as const,
          text: `m${i}`,
          updatedAt: 1,
        });
      }
    });
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    await as(t, owner).mutation(api.trash.purgeChat, { chatId });
    // The first batch ran inline; the rest was scheduled — and that chain dies.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await settle(t);
    const midway = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      ledger: await ctx.db.query("chatPurges").collect(),
    }));
    expect(midway.messages).toBeGreaterThan(0);
    expect(midway.messages).toBeLessThan(count);
    expect(midway.ledger).toHaveLength(1);

    // Too early: a chain that may still be alive is left alone.
    expect(await t.mutation(internal.trash.purgeTrash, {})).toEqual({ started: 0, rearmed: 0 });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect(await t.mutation(internal.trash.purgeTrash, {})).toEqual({ started: 0, rearmed: 1 });
    await settle(t);
    const after = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      ledger: (await ctx.db.query("chatPurges").collect()).length,
    }));
    expect(after).toEqual({ messages: 0, ledger: 0 });
  }, 60_000);

  test("the cron purges only the conversations whose retention has ended", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const due = await seedChat(t, owner, "due");
    const notYet = await seedChat(t, owner, "not yet");
    const live = await seedChat(t, owner, "live");
    await as(t, owner).mutation(api.chats.deleteChat, { chatId: due });
    vi.setSystemTime(Date.now() + 10 * DAY);
    await as(t, owner).mutation(api.chats.deleteChat, { chatId: notYet });
    vi.setSystemTime(Date.now() + 25 * DAY); // due: 35 days in; notYet: 25 days in

    expect(await t.mutation(internal.trash.purgeTrash, {})).toEqual({ started: 1, rearmed: 0 });
    await settle(t);
    expect(await t.run((ctx) => ctx.db.get(due))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(notYet))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(live))).not.toBeNull();
  });

  test("emptying the trash purges what was in it at the click, and only the caller's", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const other = await seedUser(t, "denis");
    const mine = await seedChat(t, owner, "mine");
    const theirs = await seedChat(t, other, "theirs");
    await as(t, owner).mutation(api.chats.deleteChat, { chatId: mine });
    await as(t, other).mutation(api.chats.deleteChat, { chatId: theirs });
    await as(t, owner).mutation(api.trash.emptyTrash, {});
    await settle(t);
    expect(await t.run((ctx) => ctx.db.get(mine))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(theirs))).not.toBeNull();
  }, 30_000);
});

describe("a turn in flight when the conversation is trashed", () => {
  test("the stream lands and settles; a queued follow-up is held, then drains on restore", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const { head, followUp } = await t.run(async (ctx) => {
      const question = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "user" as const,
        status: "complete" as const,
        text: "q1",
        updatedAt: 1,
      });
      const head = await ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "c1",
        messageId: question,
        text: "q1",
        attachmentIds: [],
        // Acknowledged by the gateway: the turn is running, its reply streaming.
        status: "sent" as const,
        sentToInstance: "primary",
      });
      const next = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "user" as const,
        status: "complete" as const,
        text: "q2",
        updatedAt: 1,
      });
      const followUp = await ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "c2",
        messageId: next,
        text: "q2",
        attachmentIds: [],
        status: "queued" as const,
      });
      return { head, followUp };
    });
    const replyId = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r1",
      dispatchOutboxId: head,
    });
    await t.mutation(internal.stream.appendDelta, { messageId: replyId!, text: "Bon" });

    await as(t, owner).mutation(api.chats.deleteChat, { chatId });

    // The bridge keeps writing: nothing refuses it, nothing breaks.
    await t.mutation(internal.stream.appendDelta, { messageId: replyId!, text: "jour" });
    await t.mutation(internal.stream.finalize, { messageId: replyId!, status: "complete" });
    // The turn-end drain (inside finalize) does not promote into the trash…
    expect((await t.run((ctx) => ctx.db.get(followUp)))?.status).toBe("queued");
    await settle(t);
    const reply = await t.run((ctx) => ctx.db.get(replyId!));
    expect(reply?.status).toBe("complete");
    expect(reply?.text).toBe("Bonjour");
    // …and nothing scheduled afterwards does either: the follow-up is held.
    expect((await t.run((ctx) => ctx.db.get(followUp)))?.status).toBe("queued");

    await as(t, owner).mutation(api.trash.restoreChat, { chatId });
    expect((await t.run((ctx) => ctx.db.get(followUp)))?.status).toBe("pending");
  });

  test("a turn accepted but not yet sent is re-parked by the dispatch, not failed", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const outboxId = await t.run(async (ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "c1",
        text: "q",
        attachmentIds: [],
        status: "pending" as const,
      }),
    );
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    expect(await t.mutation(internal.bridge.reparkIfBusy, { outboxId })).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(outboxId)))?.status).toBe("queued");
  });
});

describe("deleting a message releases its blobs", () => {
  test("a blob only it named goes; one a fork still shows stays", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const own = await storeBlob(t, "own");
    const shared = await storeBlob(t, "shared");
    const first = await replyWithFile(t, chatId, owner, shared);
    const { chatId: fork } = await as(t, owner).mutation(api.chatFork.forkChat, {
      branchMessageId: first,
    });
    const second = await replyWithFile(t, chatId, owner, own);
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: own, userId: owner });
    });

    // Past the week its upload registration no longer holds it.
    vi.setSystemTime(Date.now() + 8 * DAY);
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: second });
    expect(await blobExists(t, own)).toBe(false);
    await endQuarantines(t);
    expect(await blobDeleted(t, own)).toBe(true);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("uploads")
          .withIndex("by_storage", (q) => q.eq("storageId", own))
          .collect(),
      ),
    ).toEqual([]);

    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: first });
    expect(await blobExists(t, shared)).toBe(true);
    expect(fork).toBeDefined();
  });
});

describe("lib/blobs — the reference count", () => {
  test("answers for an arbitrary blob, and keeps every referenced one", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const orphan = await storeBlob(t, "orphan");
    const uploaded = await storeBlob(t, "uploaded");
    const logo = await storeBlob(t, "logo");
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: uploaded, userId: owner });
      await ctx.db.insert("charts", {
        key: "c",
        name: "C",
        scope: "common" as const,
        tokens: { colors: { light: { primary: "x" }, dark: { primary: "y" } } },
        logoLightStorageId: logo,
        createdBy: owner,
        createdAt: 1,
      });
    });
    await t.run(async (ctx) => {
      expect(await blobReference(ctx, orphan)).toBeNull();
      // A fresh upload registration holds its blob: its owner may still attach it.
      expect(await blobReference(ctx, uploaded)).toBe("upload");
      expect(await blobReference(ctx, logo)).toBe("chartLogo");
      expect(await releaseBlob(ctx, logo)).toBe("kept");
      expect(await releaseBlob(ctx, orphan)).toBe("quarantined");
      // Idempotent: one entry per blob, the first release's date kept.
      expect(await releaseBlob(ctx, orphan)).toBe("quarantined");
      expect(
        (await ctx.db.query("blobReleases").collect()).filter((r) => r.storageId === orphan),
      ).toHaveLength(1);
    });
    // Past the week it no longer does — unless the caller counts every registration.
    vi.setSystemTime(Date.now() + 8 * DAY);
    await t.run(async (ctx) => {
      expect(await blobReference(ctx, uploaded)).toBeNull();
      expect(await blobReference(ctx, uploaded, { countUploads: true })).toBe("upload");
    });
    expect(await blobExists(t, logo)).toBe(true);
    expect(await blobExists(t, orphan)).toBe(false);
  });
});

describe("lib/trash — retention", () => {
  test("30 days by default; CHAT_TRASH_RETENTION_DAYS overrides it when it is a positive number", () => {
    expect(trashRetentionDays(undefined)).toBe(30);
    expect(trashRetentionDays("7")).toBe(7);
    expect(trashRetentionDays("0")).toBe(30);
    expect(trashRetentionDays("-3")).toBe(30);
    expect(trashRetentionDays("soon")).toBe(30);
    expect(purgeDateFor(1_000, 2)).toBe(1_000 + 2 * DAY);
  });
});

describe("the conversation's own surfaces read as a deleted conversation's", () => {
  test("page queries answer 'not found', owner actions refuse, per-chat content is withheld", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const folder = await as(t, owner).mutation(api.projects.createProject, { name: "Finances" });
    const chatId = await seedChat(t, owner, "Budget", { projectId: folder });
    const blob = await storeBlob(t, "deck");
    const pdf = await storeBlob(t, "deck-pdf");
    const replyId = await replyWithFile(t, chatId, owner, blob);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "ce qui a été dit",
        watermarkOrderTime: 1,
        coveredCount: 1,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
      await ctx.db.insert("documentAttachments", {
        userId: owner,
        sourceMessageId: replyId,
        entryKey: "k1",
        reference: "doc.pdf",
        status: "ready" as const,
        storageId: blob,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: blob,
        chatId,
        userId: owner,
        sourceFilename: "a.pdf",
        sourceMimeType: "application/pdf",
        status: "ready" as const,
        pdfStorageId: pdf,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const me = as(t, owner);
    // Live: each surface answers.
    expect(await me.query(api.chatSummaries.getChatSummary, { chatId })).not.toBeNull();
    expect(await me.query(api.documentAttachments.getDocumentAttachments, { sourceMessageId: replyId })).toHaveLength(1);
    expect((await me.query(api.fileRenditions.getRendition, { sourceStorageId: blob })).status).toBe("ready");
    expect((await me.query(api.archiveExport.exportFolderChats, { projectId: folder })).chatIds).toEqual([chatId]);
    await me.query(api.chatExport.getChatReference, { chatId });

    await me.mutation(api.chats.deleteChat, { chatId });

    expect(await me.query(api.messages.getStreamingText, { chatId })).toEqual([]);
    expect(await me.query(api.agents.getChatAgent, { chatId })).toBeNull();
    expect(await me.query(api.chatSummaries.getChatSummary, { chatId })).toBeNull();
    await expect(me.mutation(api.chatSummaries.updateSummary, { chatId, summary: "x" })).rejects.toThrow(/Forbidden/);
    await expect(me.mutation(api.chatSummaries.requestSummarize, { chatId })).rejects.toThrow(/Forbidden/);
    expect(await me.query(api.documentAttachments.getDocumentAttachments, { sourceMessageId: replyId })).toEqual([]);
    await expect(
      me.mutation(api.documentAttachments.attachDocuments, {
        sourceMessageId: replyId,
        items: [{ entryKey: "k2", reference: "autre.pdf" }],
      }),
    ).rejects.toThrow(/forbidden/);
    expect((await me.query(api.fileRenditions.getRendition, { sourceStorageId: blob })).status).toBe("unconfigured");
    expect((await me.query(api.archiveExport.exportFolderChats, { projectId: folder })).chatIds).toEqual([]);
    await expect(me.query(api.chatExport.getChatReference, { chatId })).rejects.toThrow(/Forbidden/);
    // Owner-only actions refuse it as a conversation that does not exist.
    await expect(me.mutation(api.chats.renameChat, { chatId, title: "x" })).rejects.toThrow(/Not found/);
    await expect(me.mutation(api.chats.deleteChat, { chatId })).rejects.toThrow(/Not found/);
  });
});

describe("account deletion", () => {
  test("a file the deleted person sent into someone else's conversation stays with it", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "root", "admin");
    const owner = await seedUser(t, "olivier");
    const guest = await seedUser(t, "denis");
    const room = await seedChat(t, owner, "Salle");
    const own = await seedChat(t, guest, "Perso");
    const blob = await storeBlob(t, "guest-upload");
    const ownBlob = await storeBlob(t, "guest-own");
    const sentRow = await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId: room,
        userId: owner,
        authorUserId: guest,
        role: "user" as const,
        status: "complete" as const,
        text: "pièce jointe",
        updatedAt: 1,
      });
      const part = { kind: "file" as const, storageId: blob, filename: "g.txt", mimeType: "text/plain" };
      await ctx.db.insert("messageParts", { messageId, order: 0, part });
      return await ctx.db.insert("files", {
        userId: guest,
        chatId: room,
        messageId,
        storageId: blob,
        filename: "g.txt",
        mimeType: "text/plain",
        kind: "file" as const,
        direction: "inbound" as const,
        createdAt: 1,
      });
    });
    await replyWithFile(t, own, guest, ownBlob);
    const profileId = await t.run(async (ctx) =>
      (await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", guest))
        .unique())!._id,
    );

    await as(t, admin).mutation(api.admin.deleteUser, { profileId });
    await settle(t);

    // Their own conversation is purged, its blob with it; the room keeps its file.
    expect(await t.run((ctx) => ctx.db.get(own))).toBeNull();
    expect(await blobExists(t, ownBlob)).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(sentRow))).not.toBeNull();
    expect(await t.run((ctx) => blobReference(ctx, blob))).toBe("file");
  });
});

describe("storageInventory.listLiveBlobs", () => {
  test("pages through the LIVE blobs with digest and size; a released blob is not listed", async () => {
    const t = convexTest(schema, modules);
    const a = await storeBlob(t, "a");
    const b = await storeBlob(t, "bb");
    const c = await storeBlob(t, "ccc");
    await t.run(async (ctx) => {
      await releaseBlob(ctx, b);
      // Quarantined blobs are LIVE (restorable); once its quarantine ends, it goes.
      const entry = (await ctx.db.query("blobReleases").collect())[0]!;
      expect(await endQuarantine(ctx, entry)).toBe("deleted");
    });
    const first = await t.query(internal.storageInventory.listLiveBlobs, {
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.blobs).toHaveLength(1);
    expect(first.isDone).toBe(false);
    const rest = await t.query(internal.storageInventory.listLiveBlobs, {
      paginationOpts: { numItems: 10, cursor: first.continueCursor },
    });
    expect(rest.isDone).toBe(true);
    const all = [...first.blobs, ...rest.blobs];
    expect(all.map((x) => x.storageId).sort()).toEqual([a, c].sort());
    const blobC = all.find((x) => x.storageId === c)!;
    expect(blobC.size).toBe(3);
    expect(typeof blobC.sha256).toBe("string");
    expect(blobC.createdAt).toBeTypeOf("number");
  });
});

describe("the trash listings are paginated", () => {
  test("an owner with more trashed conversations than one page reaches and restores the oldest", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const ids = await t.run(async (ctx) => {
      const out: Id<"chats">[] = [];
      for (let i = 0; i < 205; i += 1) {
        out.push(
          await ctx.db.insert("chats", {
            userId: owner,
            updatedAt: 1,
            title: `c${i}`,
            trashedAt: 1_000 + i,
            purgeAfter: 1_000 + i + 30 * DAY,
          }),
        );
      }
      return out;
    });
    const seen: Id<"chats">[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { page: { _id: Id<"chats"> }[]; isDone: boolean; continueCursor: string } =
        await as(t, owner).query(api.trash.listMyTrash, {
          // Asking for more than a page's bound is bounded, not refused.
          paginationOpts: { numItems: 1000, cursor },
        });
      expect(page.page.length).toBeLessThanOrEqual(100);
      seen.push(...page.page.map((r) => r._id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(205);
    const oldest = ids[0]!;
    expect(seen[seen.length - 1]).toBe(oldest); // newest first
    await as(t, owner).mutation(api.trash.restoreChat, { chatId: oldest });
    expect((await t.run((ctx) => ctx.db.get(oldest)))!.trashedAt).toBeUndefined();
  }, 30_000);

  test("the admin listing pages too", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "root", "admin");
    const owner = await seedUser(t, "olivier");
    for (const title of ["a", "b", "c"]) {
      const chatId = await seedChat(t, owner, title);
      await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    }
    const first = await as(t, admin).query(api.trash.adminListTrash, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const rest = await as(t, admin).query(api.trash.adminListTrash, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect([...first.page, ...rest.page].map((r) => r.title).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("a purge interrupted after the chat row went", () => {
  test("its leftover files, renditions and attachments are exposed nowhere", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t, "deck");
    const pdf = await storeBlob(t, "deck-pdf");
    const replyId = await replyWithFile(t, chatId, owner, blob);
    await t.run(async (ctx) => {
      await ctx.db.insert("documentAttachments", {
        userId: owner,
        sourceMessageId: replyId,
        entryKey: "k1",
        reference: "doc.pdf",
        status: "ready" as const,
        storageId: blob,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: blob,
        chatId,
        userId: owner,
        sourceFilename: "a.pdf",
        sourceMimeType: "application/pdf",
        status: "ready" as const,
        pdfStorageId: pdf,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRequests", {
        chatId,
        userId: owner,
        instanceName: "primary",
        source: "openclaw.ask_user" as const,
        kind: "question" as const,
        providerRequestId: "q-gone",
        status: "pending" as const,
        createdAt: Date.now(),
        expiresAt: Date.now() + DAY,
        updatedAt: Date.now(),
      });
    });
    const me = as(t, owner);
    expect((await me.query(api.files.listMine, {})).files).toHaveLength(1);
    expect(await me.query(api.agentRequests.pendingByChat, {})).toHaveLength(1);
    await me.mutation(api.chatReads.markChatSeen, { chatId });
    expect((await me.query(api.chatReads.myChatReads, {})).map((r) => r.chatId)).toEqual([chatId]);
    // The purge starts (chat row first) and its chain dies before any batch ran.
    await t.run(async (ctx) => {
      await cascadeDeleteChat(ctx, chatId, { inline: false });
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    const left = await t.run(async (ctx) => ({
      chat: await ctx.db.get(chatId),
      files: (await ctx.db.query("files").collect()).length,
    }));
    expect(left).toEqual({ chat: null, files: 1 });

    const listed = await me.query(api.files.listMine, {});
    expect(listed.files).toEqual([]);
    expect(listed.facets.chats).toEqual([]);
    expect((await me.query(api.fileRenditions.getRendition, { sourceStorageId: blob })).status).toBe(
      "unconfigured",
    );
    expect(
      await me.query(api.documentAttachments.getDocumentAttachments, { sourceMessageId: replyId }),
    ).toEqual([]);
    expect(await me.query(api.chatReads.myChatReads, {})).toEqual([]);
    expect(await me.query(api.agentRequests.pendingByChat, {})).toEqual([]);
  });
});

describe("what a send waiting to leave needs is held — exactly, not within a window", () => {
  test("20 settled sends of a blob and one OLD pending conversion: held; the conversion settles: released", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t, "deck");
    const renditionId = await t.run(async (ctx) => {
      // The OLD one: a conversion requested first, still waiting.
      const id = await ctx.db.insert("fileRenditions", {
        sourceStorageId: blob,
        chatId,
        userId: owner,
        sourceFilename: "deck.pptx",
        sourceMimeType: "application/vnd.ms-powerpoint",
        status: "pending" as const,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
      // …then twenty sends of the same blob, all settled, their messages gone.
      for (let i = 0; i < 20; i += 1) {
        await ctx.db.insert("outbox", {
          chatId,
          userId: owner,
          clientMessageId: `c${i}`,
          text: "x",
          attachmentIds: [blob],
          status: "sent" as const,
        });
      }
      return id;
    });
    await t.run(async (ctx) => {
      expect(await blobReference(ctx, blob)).toBe("renditionSource");
      expect(await releaseBlob(ctx, blob)).toBe("kept");
    });
    expect(await blobExists(t, blob)).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.patch(renditionId, { status: "failed" as const, failureReason: "timeout" });
      expect(await releaseBlob(ctx, blob)).toBe("quarantined");
    });
    expect(await blobExists(t, blob)).toBe(false);
  });

  test("a chat send's attachment is held by its message's files row while the send can leave", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t, "upload");
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: blob, userId: owner });
    });
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "voici",
      clientMessageId: "c-1",
      attachments: [{ storageId: blob, filename: "a.txt", mimeType: "text/plain" }],
    });
    // Held by the part itself (and by its files mirror).
    expect(await t.run((ctx) => blobReference(ctx, blob))).toBe("part");
  });
});

describe("the rendition viewer finds the caller's accessible copy of a blob", () => {
  test("20 copies in trashed conversations and one in a live one: the live one answers", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const blob = await storeBlob(t, "deck");
    const pdf = await storeBlob(t, "deck-pdf");
    for (let i = 0; i < 20; i += 1) {
      const chatId = await seedChat(t, owner, `old ${i}`);
      await replyWithFile(t, chatId, owner, blob);
      await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    }
    const live = await seedChat(t, owner, "live");
    await replyWithFile(t, live, owner, blob);
    await t.run(async (ctx) => {
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: blob,
        chatId: live,
        userId: owner,
        sourceFilename: "a.pdf",
        sourceMimeType: "application/pdf",
        status: "ready" as const,
        pdfStorageId: pdf,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    expect(
      (await as(t, owner).query(api.fileRenditions.getRendition, { sourceStorageId: blob })).status,
    ).toBe("ready");
  });
});

describe("deleting a big folder", () => {
  test("every one of 505 conversations goes to the trash; the folder goes only when none is left in it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const folder = await as(t, owner).mutation(api.projects.createProject, { name: "Archive" });
    const sub = await as(t, owner).mutation(api.projects.createProject, {
      name: "Sous-dossier",
      parentId: folder,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i += 1) {
        await ctx.db.insert("chats", { userId: owner, updatedAt: i, projectId: folder });
      }
      for (let i = 0; i < 5; i += 1) {
        await ctx.db.insert("chats", { userId: owner, updatedAt: i, projectId: sub });
      }
    });
    await as(t, owner).mutation(api.projects.deleteProject, { projectId: folder });
    await settle(t);
    const after = await t.run(async (ctx) => ({
      folders: await ctx.db.query("projects").collect(),
      chats: await ctx.db.query("chats").collect(),
    }));
    expect(after.folders).toEqual([]);
    expect(after.chats).toHaveLength(505);
    expect(after.chats.every((c) => c.trashedAt !== undefined)).toBe(true);
    expect(after.chats.every((c) => c.projectId === undefined)).toBe(true);
  }, 60_000);
});

describe("an upload its owner may still attach is held", () => {
  const WEEK = 7 * DAY;

  async function upload(t: T, owner: Id<"users">, body: string) {
    const blob = await storeBlob(t, body);
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: blob, userId: owner });
    });
    return blob;
  }

  test("purging the chat it was sent in keeps a usable upload; the owner re-sends it; past the week the last purge releases it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const a = await seedChat(t, owner, "A");
    const b = await seedChat(t, owner, "B");
    const blob = await upload(t, owner, "rapport");
    const attach = [{ storageId: blob, filename: "r.txt", mimeType: "text/plain" }];
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId: a,
      text: "voici",
      clientMessageId: "a-1",
      attachments: attach,
    });
    await trashAndPurge(t, owner, a);
    expect(await blobExists(t, blob)).toBe(true);
    // Reused a moment later, in another conversation: accepted, and it works.
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId: b,
      text: "encore",
      clientMessageId: "b-1",
      attachments: attach,
    });
    vi.setSystemTime(Date.now() + WEEK + DAY);
    await trashAndPurge(t, owner, b);
    expect(await blobExists(t, blob)).toBe(false);
    await endQuarantines(t);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("uploads").collect()).filter((u) => u.storageId === blob),
      ),
    ).toEqual([]);
  });

  test("the send gate: a fresh registration passes; an expired one passes only while a message of the owner shows the blob, and is refused cleanly otherwise", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const shown = await upload(t, owner, "shown");
    const abandoned = await upload(t, owner, "abandoned");
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "pièce",
      clientMessageId: "c-1",
      attachments: [{ storageId: shown, filename: "s.txt", mimeType: "text/plain" }],
    });
    vi.setSystemTime(Date.now() + WEEK + DAY);
    const other = await seedChat(t, owner, "Autre");
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId: other,
      text: "encore",
      clientMessageId: "c-2",
      attachments: [{ storageId: shown, filename: "s.txt", mimeType: "text/plain" }],
    });
    const before = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).length);
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId: other,
        text: "trop tard",
        clientMessageId: "c-3",
        attachments: [{ storageId: abandoned, filename: "a.txt", mimeType: "text/plain" }],
      }),
    ).rejects.toThrow(/expired/);
    // Refused before any write.
    expect(await t.run(async (ctx) => (await ctx.db.query("messages").collect()).length)).toBe(before);
  });

  test("the orphan sweep spares a usable upload whatever its minimum age, and finds an abandoned one", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const start = Date.now();
    const old = await upload(t, owner, "old");
    vi.setSystemTime(start + 5 * DAY);
    const recent = await upload(t, owner, "recent");
    vi.setSystemTime(start + 8 * DAY);
    const cutoff = sweepCutoff(Date.now(), 1);
    const verdicts = await t.run(async (ctx) => {
      const blobs = await ctx.db.system.query("_storage").collect();
      const byId = new Map(blobs.map((b) => [b._id, b]));
      return {
        old: await classifyBlob(ctx, byId.get(old)!, cutoff),
        recent: await classifyBlob(ctx, byId.get(recent)!, cutoff),
      };
    });
    expect(verdicts.recent).toEqual({ kind: "referenced" });
    expect(verdicts.old).toEqual({ kind: "orphan", origin: "upload" });
  });
});

describe("what still named a trashed conversation", () => {
  test("the bell hides its entries at once, even those past the first withdrawal batch", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i += 1) {
        await ctx.db.insert("notifications", {
          userId: owner,
          kind: "mention" as const,
          title: "t",
          body: `b${i}`,
          chatId,
          createdAt: i,
        });
      }
    });
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    // The first batch withdrew 200; 50 remain until the continuation runs.
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("notifications").collect()).filter((n) => n.chatId === chatId).length,
      ),
    ).toBe(50);
    expect(await as(t, owner).query(api.notifications.myNotifications, {})).toEqual([]);
    expect(await as(t, owner).query(api.notifications.myUnreadCount, {})).toBe(0);
  });

  test("read markers, bookmarks and the busy pulse stop naming it — for the owner and a participant", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const guest = await seedUser(t, "denis");
    const chatId = await seedChat(t, owner);
    await seat(t, chatId, guest, owner);
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
      await ctx.db.insert("streamingText", { messageId, chatId, userId: owner, text: "…", updatedAt: 1 });
      for (const who of [owner, guest]) {
        await ctx.db.insert("chatReads", { userId: who, chatId, lastSeenAt: 1 });
        await ctx.db.insert("chatBookmarks", { userId: who, chatId, messageId, createdAt: 1 });
      }
    });
    for (const who of [owner, guest]) {
      expect((await as(t, who).query(api.chatReads.myChatReads, {})).map((r) => r.chatId)).toEqual([chatId]);
      expect(await as(t, who).query(api.chatBookmarks.myBookmarkedChats, {})).toEqual([chatId]);
      expect(await as(t, who).query(api.chatReads.myBusyChats, {})).toEqual([chatId]);
    }

    await as(t, owner).mutation(api.chats.deleteChat, { chatId });

    for (const who of [owner, guest]) {
      expect(await as(t, who).query(api.chatReads.myChatReads, {})).toEqual([]);
      expect(await as(t, who).query(api.chatBookmarks.myBookmarkedChats, {})).toEqual([]);
      expect(await as(t, who).query(api.chatReads.myBusyChats, {})).toEqual([]);
    }
    // The bookmarks themselves wait for a restore.
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("chatBookmarks").collect()).filter((b) => b.chatId === chatId).length,
      ),
    ).toBe(2);
  });
});

describe("deleting a folder of busy conversations", () => {
  test("each step is budgeted by what trashing actually costs; the folder goes only once empty", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const folder = await as(t, owner).mutation(api.projects.createProject, { name: "Bruyant" });
    const chatIds = await t.run(async (ctx) => {
      const out: Id<"chats">[] = [];
      for (let i = 0; i < 30; i += 1) {
        const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: i, projectId: folder });
        out.push(chatId);
        // A full bell: every entry is withdrawn inline when the chat is trashed.
        for (let n = 0; n < 150; n += 1) {
          await ctx.db.insert("notifications", {
            userId: owner,
            kind: "mention" as const,
            title: "t",
            body: "b",
            chatId,
            createdAt: n,
          });
        }
      }
      return out;
    });
    await as(t, owner).mutation(api.projects.deleteProject, { projectId: folder });
    const midway = await t.run(async (ctx) => ({
      folder: await ctx.db.get(folder),
      trashed: (await ctx.db.query("chats").collect()).filter((c) => c.trashedAt !== undefined).length,
    }));
    // Thirty chats cost ~9000 documents: one step cannot take them all.
    expect(midway.trashed).toBeGreaterThan(0);
    expect(midway.trashed).toBeLessThan(30);
    expect(midway.folder).not.toBeNull();

    await settle(t);
    const after = await t.run(async (ctx) => ({
      folder: await ctx.db.get(folder),
      chats: await ctx.db.query("chats").collect(),
      notifications: (await ctx.db.query("notifications").collect()).length,
    }));
    expect(after.folder).toBeNull();
    expect(after.chats.map((c) => c._id).sort()).toEqual([...chatIds].sort());
    expect(after.chats.every((c) => c.trashedAt !== undefined && c.projectId === undefined)).toBe(true);
    expect(after.notifications).toBe(0);
  }, 60_000);
});

describe("a hidden job that FAILED leaves nothing behind", () => {
  async function hiddenChatWithDelivery(
    t: T,
    owner: Id<"users">,
    kind: "converter" | "documentary",
    blobs: Id<"_storage">[],
  ) {
    return t.run(async (ctx) => {
      const hidden = await ctx.db.insert("chats", { userId: owner, updatedAt: 1, kind });
      // A stuck turn that DID deliver files before the job was failed.
      const reply = await ctx.db.insert("messages", {
        chatId: hidden,
        userId: owner,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      let order = 0;
      for (const storageId of blobs) {
        const part = { kind: "file" as const, storageId, filename: `f${order}.pdf`, mimeType: "application/pdf" };
        await ctx.db.insert("messageParts", { messageId: reply, order: order++, part });
        await ctx.db.insert("files", {
          userId: owner,
          chatId: hidden,
          messageId: reply,
          storageId,
          filename: part.filename,
          mimeType: "application/pdf",
          kind: "file" as const,
          direction: "outbound" as const,
          createdAt: 1,
        });
      }
      return hidden;
    });
  }

  test("a failed conversion: its stray delivery is released, an earlier rendition's PDF stays", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const stray = await storeBlob(t, "stray-pdf");
    const kept = await storeBlob(t, "earlier-pdf");
    const source = await storeBlob(t, "source");
    const hidden = await hiddenChatWithDelivery(t, owner, "converter", [stray, kept]);
    await t.run(async (ctx) => {
      // An EARLIER job succeeded: its PDF is the rendition, held by that row.
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: await ctx.storage.store(new Blob(["other-source"])),
        chatId: hidden,
        userId: owner,
        sourceFilename: "old.pptx",
        sourceMimeType: "application/vnd.ms-powerpoint",
        status: "ready" as const,
        pdfStorageId: kept,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
      const failing = await ctx.db.insert("fileRenditions", {
        sourceStorageId: source,
        chatId: hidden,
        userId: owner,
        sourceFilename: "deck.pptx",
        sourceMimeType: "application/vnd.ms-powerpoint",
        status: "pending" as const,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(hidden, { pendingConvert: { renditionId: failing, createdAt: 1 } });
    });

    await t.mutation(internal.fileRenditions.failRenditionForChat, {
      chatId: hidden,
      reason: "stuck_stream",
    });
    await settle(t);

    expect(await blobExists(t, stray)).toBe(false);
    expect(await blobExists(t, kept)).toBe(true);
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("files").collect()).filter((f) => f.chatId === hidden),
    );
    expect(rows).toEqual([]);
  });

  test("a TIMED-OUT conversion: its stray delivery is released too", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const stray = await storeBlob(t, "stray-pdf");
    const source = await storeBlob(t, "source");
    const hidden = await hiddenChatWithDelivery(t, owner, "converter", [stray]);
    await t.run(async (ctx) => {
      const pending = await ctx.db.insert("fileRenditions", {
        sourceStorageId: source,
        chatId: hidden,
        userId: owner,
        sourceFilename: "deck.pptx",
        sourceMimeType: "application/vnd.ms-powerpoint",
        status: "pending" as const,
        converterInstance: "primary",
        converterAgentId: "conv",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(hidden, { pendingConvert: { renditionId: pending, createdAt: Date.now() } });
    });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await t.mutation(internal.fileRenditions.timeoutStaleRenditions, {});
    await settle(t);
    expect(await blobExists(t, stray)).toBe(false);
  });

  test("a failed documentary fetch: its stray delivery is released, a captured document stays", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const captured = await storeBlob(t, "captured");
    const stray = await storeBlob(t, "stray");
    const hidden = await hiddenChatWithDelivery(t, owner, "documentary", [captured, stray]);
    const source = await t.run(async (ctx) => {
      const sourceMessageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "complete" as const,
        text: "sources",
        updatedAt: 1,
      });
      await ctx.db.insert("documentAttachments", {
        userId: owner,
        sourceMessageId,
        entryKey: "k1",
        reference: "doc.pdf",
        status: "ready" as const,
        storageId: captured,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(hidden, { pendingFetch: { sourceMessageId, createdAt: 1 } });
      return sourceMessageId;
    });

    await t.run(async (ctx) => {
      const chat = (await ctx.db.get(hidden))!;
      await failDocumentaryFetchForChat(ctx, chat, "stuck_stream");
    });
    await settle(t);

    expect(await blobExists(t, stray)).toBe(false);
    expect(await blobExists(t, captured)).toBe(true);
    expect(source).toBeDefined();
  });
});

describe("registering an upload", () => {
  test("a blob that exists registers; one already collected is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const live = await storeBlob(t, "live");
    const gone = await storeBlob(t, "gone");
    await t.run(async (ctx) => {
      await ctx.storage.delete(gone);
    });
    await as(t, owner).mutation(api.uploads.registerUpload, { storageId: live });
    await expect(
      as(t, owner).mutation(api.uploads.registerUpload, { storageId: gone }),
    ).rejects.toThrow(/not found/);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("uploads").collect()).map((u) => u.storageId),
      ),
    ).toEqual([live]);
  });
});

describe("an archive import in progress holds the blobs it registered", () => {
  const MANIFEST = { formatVersion: ARCHIVE_FORMAT_VERSION, origin: null };

  test("the last message showing the blob is deleted mid-import: kept; the import is undone: released", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t, "piece");
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: blob, userId: owner });
    });
    const me = as(t, owner);
    const { messageId } = await me.mutation(api.send.sendMessage, {
      chatId,
      text: "voici",
      clientMessageId: "c-1",
      attachments: [{ storageId: blob, filename: "p.txt", mimeType: "text/plain" }],
    });
    // The registration expires; a message still shows the blob, so it stays usable.
    vi.setSystemTime(Date.now() + 8 * DAY);
    const importId = await me.mutation(api.archiveImport.beginImport, { manifest: MANIFEST });
    await me.mutation(api.archiveImport.registerImportBlob, { importId, storageId: blob });

    // The only message showing it goes while the import still has to attach it.
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId!, { status: "complete" as const });
    });
    await me.mutation(api.messages.deleteMessage, { messageId: messageId! });
    expect(await t.run((ctx) => blobReference(ctx, blob))).toBe("importing");
    expect(await blobExists(t, blob)).toBe(true);

    // Undone: its own mapping and registration no longer hold it.
    for (let i = 0; i < 10; i += 1) {
      if ((await me.mutation(api.archiveImport.abandonImport, { importId })).done) break;
    }
    expect(await blobExists(t, blob)).toBe(false);
  });

  test("the undo closes the import at its FIRST call: another tab's batch and blob registration are refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const me = as(t, owner);
    const importId = await me.mutation(api.archiveImport.beginImport, { manifest: MANIFEST });
    const first = await storeBlob(t, "first");
    const late = await storeBlob(t, "late");
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: first, userId: owner });
      await ctx.db.insert("uploads", { storageId: late, userId: owner });
    });
    await me.mutation(api.archiveImport.registerImportBlob, { importId, storageId: first });

    expect((await me.mutation(api.archiveImport.abandonImport, { importId })).done).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(importId)))!.status).toBe("abandoning");

    await expect(
      me.mutation(api.archiveImport.registerImportBlob, { importId, storageId: late }),
    ).rejects.toThrow(/no longer open/);
    await expect(
      me.mutation(api.archiveImport.importBatch, { importId, section: "chats", rows: [] }),
    ).rejects.toThrow(/no longer open/);
    await expect(me.mutation(api.archiveImport.finishImport, { importId })).rejects.toThrow(
      /abandoned/,
    );
    // An undo interrupted here is still listed, so the stale-import sweep finishes it.
    expect((await me.query(api.archiveImport.listOpenImports, {})).map((r) => r.importId)).toEqual([
      importId,
    ]);

    for (let i = 0; i < 10; i += 1) {
      if ((await me.mutation(api.archiveImport.abandonImport, { importId })).done) break;
    }
    expect((await t.run((ctx) => ctx.db.get(importId)))!.status).toBe("abandoned");
    // The import's claims are gone; the owner's own registrations are not the
    // import's to discard: still usable, they keep both blobs.
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("archiveImportIds").collect()).filter((m) => m.importId === importId),
      ),
    ).toEqual([]);
    expect(await blobExists(t, first)).toBe(true);
    expect(await blobExists(t, late)).toBe(true);
  });
});

describe("the blob quarantine", () => {
  const markIndexComplete = async (t: T) =>
    t.run(async (ctx) => {
      await ctx.db.insert("migrationMarkers", {
        key: PART_STORAGE_BACKFILL,
        cursor: null,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
    });
  const purge = (t: T) => t.mutation(internal.blobQuarantine.purgeQuarantine, {});

  test("every part writer stamps the part's storage id: a part is held by itself, files row or not", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const sent = await storeBlob(t, "sent");
    const delivered = await storeBlob(t, "delivered");
    await t.run(async (ctx) => {
      await ctx.db.insert("uploads", { storageId: sent, userId: owner });
    });
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "voici",
      clientMessageId: "c-1",
      attachments: [{ storageId: sent, filename: "s.txt", mimeType: "text/plain" }],
    });
    const replyId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      }),
    );
    await t.mutation(internal.stream.addPart, {
      messageId: replyId,
      part: { kind: "media", storageId: delivered, filename: "d.png", mimeType: "image/png" },
    });
    await t.run(async (ctx) => ctx.db.patch(replyId, { status: "complete" as const }));
    const { chatId: fork } = await as(t, owner).mutation(api.chatFork.forkChat, {
      branchMessageId: replyId,
    });
    const stamped = await t.run(async (ctx) =>
      (await ctx.db.query("messageParts").collect()).map((p) => p.storageId),
    );
    // send, addPart, and the fork's copies of both.
    expect(stamped.filter((id) => id === sent)).toHaveLength(2);
    expect(stamped.filter((id) => id === delivered)).toHaveLength(2);
    expect(fork).toBeDefined();
    // With every files row gone, the parts still hold their blobs.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.query("files").collect()) await ctx.db.delete(f._id);
      expect(await blobReference(ctx, delivered)).toBe("part");
      expect(await releaseBlob(ctx, delivered)).toBe("kept");
    });
  });

  test("a LEGACY part (no storage id stamped, no files row) is never deleted: the purge waits for the backfill, which then spares it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t, "legacy");
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      // Written before the field existed: no `storageId`, and no files mirror.
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: { kind: "file" as const, storageId: blob, filename: "l.pdf", mimeType: "application/pdf" },
      });
    });
    // A direct release cannot see it yet: the blob enters the quarantine…
    expect(await t.run((ctx) => releaseBlob(ctx, blob, { reason: "test" }))).toBe("quarantined");
    // …and stays whole, whatever the time, while the backfill has not completed.
    vi.setSystemTime(Date.now() + 30 * DAY);
    expect(await purge(t)).toMatchObject({ gated: true, ended: 0 });
    expect(await blobDeleted(t, blob)).toBe(false);

    await t.mutation(internal.blobQuarantine.ensurePartStorageBackfill, {});
    await settle(t);
    expect(await purge(t)).toMatchObject({ gated: false, ended: 1, spared: 1, deleted: 0 });
    expect(await blobDeleted(t, blob)).toBe(false);
    expect(await t.run((ctx) => blobReference(ctx, blob))).toBe("part");
  });

  test("a released blob is deleted only once its quarantine is over, and a re-referenced one is spared", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    await markIndexComplete(t);
    const lost = await storeBlob(t, "lost");
    const found = await storeBlob(t, "found");
    await t.run(async (ctx) => {
      expect(await releaseBlob(ctx, lost, { reason: "test" })).toBe("quarantined");
      expect(await releaseBlob(ctx, found, { reason: "test" })).toBe("quarantined");
    });
    vi.setSystemTime(Date.now() + 6 * DAY);
    expect(await purge(t)).toMatchObject({ ended: 0 });
    expect(await blobDeleted(t, lost)).toBe(false);
    // Referenced again during its quarantine.
    await replyWithFile(t, chatId, owner, found);
    vi.setSystemTime(Date.now() + 2 * DAY);
    expect(await purge(t)).toMatchObject({ ended: 2, deleted: 1, spared: 1 });
    expect(await blobDeleted(t, lost)).toBe(true);
    expect(await blobDeleted(t, found)).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("blobReleases").collect())).toEqual([]);
  });

  test("the purge is bounded and resumable: a chain that died is finished by the next run", async () => {
    const t = convexTest(schema, modules);
    await markIndexComplete(t);
    const blobs: Id<"_storage">[] = [];
    for (let i = 0; i < 120; i += 1) blobs.push(await storeBlob(t, `b${i}`));
    await t.run(async (ctx) => {
      for (const blob of blobs) await releaseBlob(ctx, blob, { reason: "test" });
    });
    vi.setSystemTime(Date.now() + 8 * DAY);
    expect(await purge(t)).toMatchObject({ ended: 50, deleted: 50 });
    // The continuation dies.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    expect((await t.run((ctx) => ctx.db.query("blobReleases").collect())).length).toBe(70);
    await purge(t);
    await settle(t);
    expect(await t.run((ctx) => ctx.db.query("blobReleases").collect())).toEqual([]);
    for (const blob of blobs) expect(await blobDeleted(t, blob)).toBe(true);
  }, 60_000);

  test("the part backfill is resumable and marks itself complete", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const blob = await storeBlob(t, "x");
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      for (let i = 0; i < 300; i += 1) {
        await ctx.db.insert("messageParts", {
          messageId,
          order: i,
          part: { kind: "file" as const, storageId: blob, filename: `${i}.pdf`, mimeType: "application/pdf" },
        });
      }
    });
    expect(await t.mutation(internal.blobQuarantine.backfillPartStorage, {})).toMatchObject({ done: false });
    // Its chain dies after one page.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    // A live stamp is left alone; a stale one is resumed from its cursor.
    expect(await t.mutation(internal.blobQuarantine.ensurePartStorageBackfill, {})).toBe("running");
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await t.mutation(internal.blobQuarantine.ensurePartStorageBackfill, {})).toBe("started");
    await settle(t);
    const after = await t.run(async (ctx) => ({
      unstamped: (await ctx.db.query("messageParts").collect()).filter((p) => p.storageId !== blob).length,
      marker: (await ctx.db.query("migrationMarkers").collect())[0],
    }));
    expect(after.unstamped).toBe(0);
    expect(after.marker?.completedAt).toBeTypeOf("number");
    expect(await t.mutation(internal.blobQuarantine.ensurePartStorageBackfill, {})).toBe("complete");
  }, 60_000);
});

describe("an import discarding a blob its owner registered for a draft", () => {
  test("drops only the import's claim: the draft's usable registration keeps the blob, and the draft sends it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const chatId = await seedChat(t, owner);
    const draft = await storeBlob(t, "draft");
    const me = as(t, owner);
    await me.mutation(api.uploads.registerUpload, { storageId: draft });
    const importId = await me.mutation(api.archiveImport.beginImport, {
      manifest: { formatVersion: ARCHIVE_FORMAT_VERSION, origin: null },
    });
    await me.mutation(api.archiveImport.registerImportBlob, { importId, storageId: draft });
    expect(await me.mutation(api.archiveImport.discardUpload, { importId, storageId: draft })).toEqual({
      discarded: false,
    });
    expect(await blobExists(t, draft)).toBe(true);
    // The import's claim is gone (the import no longer holds it): the draft's own
    // registration is what holds it now.
    expect(await t.run((ctx) => blobReference(ctx, draft))).toBe("upload");
    await me.mutation(api.send.sendMessage, {
      chatId,
      text: "le brouillon part",
      clientMessageId: "d-1",
      attachments: [{ storageId: draft, filename: "d.txt", mimeType: "text/plain" }],
    });
    expect(await t.run((ctx) => blobReference(ctx, draft))).toBe("part");
  });
});
