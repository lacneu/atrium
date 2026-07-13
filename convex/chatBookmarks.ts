// PER-USER conversation bookmarks (IntelliJ-style): place a marker anywhere
// in a chat (whole message, or one top-level markdown block inside a long
// message), navigate between markers, and get placed back on the ACTIVE
// bookmark (last placed or jumped-to) when reopening the chat.
//
// Design mirrors chatReads: owner-scoped rows, personal writes are a NO-OP
// under admin impersonation, and everything stays OUT of listChats (the
// sidebar map is its own bounded query — prod listChats saturation lesson).
// The anchor triple (chatId, messageId, blockIndex) is a standalone concept
// shared with the upcoming cross-conversation references.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";

// Hard cap per (user, chat): far above real usage, keeps every read bounded.
const MAX_BOOKMARKS_PER_CHAT = 100;
// Sidebar map bound: DISTINCT chats (matches chatReads' MAX_READS philosophy).
const MAX_SIDEBAR_CHATS = 500;
const MAX_LABEL_LENGTH = 60;

export interface ChatBookmark {
  _id: Id<"chatBookmarks">;
  messageId: Id<"messages">;
  blockIndex: number | null;
  label: string | null;
  createdAt: number;
}

async function requireOwnedChat(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
): Promise<void> {
  const chat = await ctx.db.get(chatId);
  if (!chat || chat.userId !== userId) {
    throw new Error("Forbidden: chat not owned by user");
  }
}

/** All of THIS user's bookmarks in one chat + which one is active. One
 *  bounded indexed read; ordering by thread position happens client-side
 *  (the client already holds the visible message order). */
export const getBookmarks = query({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{
    bookmarks: ChatBookmark[];
    activeBookmarkId: Id<"chatBookmarks"> | null;
  }> => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, chatId, userId);
    const rows = await ctx.db
      .query("chatBookmarks")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", userId).eq("chatId", chatId),
      )
      .take(MAX_BOOKMARKS_PER_CHAT);
    const read = await ctx.db
      .query("chatReads")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", userId).eq("chatId", chatId),
      )
      .first();
    return {
      bookmarks: rows.map((r) => ({
        _id: r._id,
        messageId: r.messageId,
        blockIndex: r.blockIndex ?? null,
        label: r.label ?? null,
        createdAt: r.createdAt,
      })),
      activeBookmarkId: read?.activeBookmarkId ?? null,
    };
  },
});

/** Sidebar map: which of the caller's chats carry at least one bookmark.
 *  Deliberately separate from listChats (same reasoning as myBusyChats).
 *  DISTINCT-CHAT seek scan on (userId, chatId): one point-read per distinct
 *  chat, so a heavy account (100 rows in one chat) can never crowd other
 *  chats out of a row-count window (codex P2). Bounded by chats, not rows. */
export const myBookmarkedChats = query({
  args: {},
  handler: async (ctx): Promise<Id<"chats">[]> => {
    const { userId } = await requireActive(ctx);
    const chats: Id<"chats">[] = [];
    let cursor: Id<"chats"> | null = null;
    for (let i = 0; i < MAX_SIDEBAR_CHATS; i++) {
      const after: Id<"chats"> | null = cursor;
      const row = await ctx.db
        .query("chatBookmarks")
        .withIndex("by_user_chat", (q) =>
          after === null
            ? q.eq("userId", userId)
            : q.eq("userId", userId).gt("chatId", after),
        )
        .first();
      if (row === null) break;
      chats.push(row.chatId);
      cursor = row.chatId;
    }
    return chats;
  },
});

/** Place OR remove a bookmark on an anchor. Same anchor twice = remove
 *  (IntelliJ gutter toggle). Placing also makes it the chat's active
 *  bookmark (the position reopening the chat returns to). */
export const toggleBookmark = mutation({
  args: {
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    blockIndex: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { chatId, messageId, blockIndex },
  ): Promise<{ placed: boolean }> => {
    const { userId, impersonating } = await requireActive(ctx);
    // An admin looking at a user's chat must not edit their bookmarks (same
    // no-op-under-impersonation rule as the other personal writes).
    if (impersonating) return { placed: false };
    await requireOwnedChat(ctx, chatId, userId);
    const message = await ctx.db.get(messageId);
    if (!message || message.chatId !== chatId) {
      throw new Error("Forbidden: message not in chat");
    }
    if (
      blockIndex !== undefined &&
      (!Number.isInteger(blockIndex) || blockIndex < 0)
    ) {
      throw new Error("Invalid blockIndex");
    }
    const rows = await ctx.db
      .query("chatBookmarks")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", userId).eq("chatId", chatId),
      )
      .take(MAX_BOOKMARKS_PER_CHAT);
    const existing = rows.find(
      (r) =>
        r.messageId === messageId &&
        (r.blockIndex ?? null) === (blockIndex ?? null),
    );
    if (existing) {
      await removeRowAndUnlink(ctx, existing._id, userId, chatId);
      return { placed: false };
    }
    if (rows.length >= MAX_BOOKMARKS_PER_CHAT) {
      throw new Error("Too many bookmarks in this chat");
    }
    const bookmarkId = await ctx.db.insert("chatBookmarks", {
      userId,
      chatId,
      messageId,
      ...(blockIndex !== undefined ? { blockIndex } : {}),
      createdAt: Date.now(),
    });
    await setActive(ctx, userId, chatId, bookmarkId);
    return { placed: true };
  },
});

export const removeBookmark = mutation({
  args: { bookmarkId: v.id("chatBookmarks") },
  handler: async (ctx, { bookmarkId }): Promise<void> => {
    const { userId, impersonating } = await requireActive(ctx);
    if (impersonating) return;
    const row = await ctx.db.get(bookmarkId);
    if (!row || row.userId !== userId) return; // idempotent delete
    await removeRowAndUnlink(ctx, bookmarkId, userId, row.chatId);
  },
});

export const renameBookmark = mutation({
  args: { bookmarkId: v.id("chatBookmarks"), label: v.string() },
  handler: async (ctx, { bookmarkId, label }): Promise<void> => {
    const { userId, impersonating } = await requireActive(ctx);
    if (impersonating) return;
    const row = await ctx.db.get(bookmarkId);
    if (!row || row.userId !== userId) {
      throw new Error("Forbidden: bookmark not owned by user");
    }
    const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
    await ctx.db.patch(bookmarkId, {
      label: trimmed.length > 0 ? trimmed : undefined,
    });
  },
});

/** Record which bookmark the user is "on" (called on every nav jump), so
 *  reopening the chat returns there. Pass null to clear (back to bottom). */
export const setActiveBookmark = mutation({
  args: {
    chatId: v.id("chats"),
    bookmarkId: v.union(v.id("chatBookmarks"), v.null()),
  },
  handler: async (ctx, { chatId, bookmarkId }): Promise<void> => {
    const { userId, impersonating } = await requireActive(ctx);
    if (impersonating) return;
    await requireOwnedChat(ctx, chatId, userId);
    if (bookmarkId !== null) {
      const row = await ctx.db.get(bookmarkId);
      if (!row || row.userId !== userId || row.chatId !== chatId) {
        throw new Error("Forbidden: bookmark not owned by user");
      }
    }
    await setActive(ctx, userId, chatId, bookmarkId);
  },
});

/** Purge every bookmark of `userId` in `chatId` anchored to one of
 *  `messageIds`, clearing a now-dangling active pointer. Shared by the
 *  message-deletion paths (manual truncate + the auto-retry that drops an
 *  empty error card) so no deletion leaves orphaned rows. */
export async function purgeBookmarksForMessages(
  ctx: MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
  messageIds: ReadonlySet<string>,
): Promise<void> {
  const rows = await ctx.db
    .query("chatBookmarks")
    .withIndex("by_user_chat", (q) =>
      q.eq("userId", userId).eq("chatId", chatId),
    )
    .collect();
  const deleted = new Set<string>();
  for (const b of rows) {
    if (!messageIds.has(b.messageId)) continue;
    deleted.add(b._id);
    await ctx.db.delete(b._id);
  }
  if (deleted.size === 0) return;
  const read = await readRow(ctx, userId, chatId);
  if (
    read?.activeBookmarkId !== undefined &&
    deleted.has(read.activeBookmarkId)
  ) {
    await ctx.db.patch(read._id, { activeBookmarkId: undefined });
  }
}

// --- internals --------------------------------------------------------------

async function readRow(
  ctx: MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
) {
  return await ctx.db
    .query("chatReads")
    .withIndex("by_user_chat", (q) =>
      q.eq("userId", userId).eq("chatId", chatId),
    )
    .first();
}

/** Point chatReads.activeBookmarkId at a bookmark (or clear it). The
 *  chatReads row may not exist yet (chat never marked seen): create it. */
async function setActive(
  ctx: MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
  bookmarkId: Id<"chatBookmarks"> | null,
): Promise<void> {
  const read = await readRow(ctx, userId, chatId);
  if (read) {
    await ctx.db.patch(read._id, {
      activeBookmarkId: bookmarkId ?? undefined,
    });
    return;
  }
  if (bookmarkId === null) return;
  await ctx.db.insert("chatReads", {
    userId,
    chatId,
    lastSeenAt: Date.now(),
    activeBookmarkId: bookmarkId,
  });
}

/** Delete a bookmark row and, if it was the chat's active bookmark, clear
 *  the pointer (a dangling activeBookmarkId must never survive). */
async function removeRowAndUnlink(
  ctx: MutationCtx,
  bookmarkId: Id<"chatBookmarks">,
  userId: Id<"users">,
  chatId: Id<"chats">,
): Promise<void> {
  await ctx.db.delete(bookmarkId);
  const read = await readRow(ctx, userId, chatId);
  if (read && read.activeBookmarkId === bookmarkId) {
    await ctx.db.patch(read._id, { activeBookmarkId: undefined });
  }
}
