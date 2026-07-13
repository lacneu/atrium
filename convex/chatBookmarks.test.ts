import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

// Bare test handle (repo pattern): the generic handle erases the schema, so
// helpers avoid withIndex() and filter the tiny test tables in memory.
type T = ReturnType<typeof convexTest>;

// IntelliJ-style conversation bookmarks. Discriminating properties:
//   - toggle on the SAME anchor places then removes (gutter semantics);
//   - placing makes the bookmark the chat's ACTIVE one (reopen position);
//   - deleting the active bookmark clears the pointer (never dangling);
//   - ownership is enforced on every surface (IDOR: place/rename/remove);
//   - message-level (blockIndex absent) and block-level anchors coexist.

async function seedUserChat(t: T, canonical: string) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "a long delivered answer",
      updatedAt: 1000,
    });
    return { userId, chatId, messageId };
  });
}

async function readState(t: T, userId: Id<"users">, chatId: Id<"chats">) {
  return t.run(async (ctx) => {
    const allBookmarks = await ctx.db.query("chatBookmarks").collect();
    const bookmarks = allBookmarks.filter(
      (b) => b.userId === userId && b.chatId === chatId,
    );
    const reads = await ctx.db.query("chatReads").collect();
    const read = reads.find(
      (r) => r.userId === userId && r.chatId === chatId,
    );
    return { bookmarks, activeBookmarkId: read?.activeBookmarkId ?? null };
  });
}

describe("chatBookmarks", () => {
  test("toggle places (and activates), toggling the same anchor removes and clears active", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });

    const placed = await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 12,
    });
    expect(placed.placed).toBe(true);
    let state = await readState(t, userId, chatId);
    expect(state.bookmarks).toHaveLength(1);
    expect(state.bookmarks[0]!.blockIndex).toBe(12);
    // Placing = the user is "working here": it becomes the active bookmark.
    expect(state.activeBookmarkId).toBe(state.bookmarks[0]!._id);

    const removed = await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 12,
    });
    expect(removed.placed).toBe(false);
    state = await readState(t, userId, chatId);
    expect(state.bookmarks).toHaveLength(0);
    // The dangling pointer must be cleared with the row.
    expect(state.activeBookmarkId).toBeNull();
  });

  test("message-level and block-level anchors on the SAME message are distinct bookmarks", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });

    await as.mutation(api.chatBookmarks.toggleBookmark, { chatId, messageId });
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 3,
    });
    const state = await readState(t, userId, chatId);
    expect(state.bookmarks).toHaveLength(2);
    // Toggling the message-level anchor removes ONLY it.
    await as.mutation(api.chatBookmarks.toggleBookmark, { chatId, messageId });
    const after = await readState(t, userId, chatId);
    expect(after.bookmarks).toHaveLength(1);
    expect(after.bookmarks[0]!.blockIndex).toBe(3);
  });

  test("getBookmarks returns the caller's rows + active pointer", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 5,
    });
    const view = await as.query(api.chatBookmarks.getBookmarks, { chatId });
    expect(view.bookmarks).toHaveLength(1);
    expect(view.bookmarks[0]!.messageId).toBe(messageId);
    expect(view.bookmarks[0]!.blockIndex).toBe(5);
    expect(view.activeBookmarkId).toBe(view.bookmarks[0]!._id);
  });

  test("IDOR: an intruder can neither place on, rename, nor remove another user's bookmark", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUserChat(t, "alice");
    const intruder = await seedUserChat(t, "mallory");
    const asOwner = t.withIdentity({ subject: `${owner.userId}|session` });
    const asIntruder = t.withIdentity({
      subject: `${intruder.userId}|session`,
    });

    await asOwner.mutation(api.chatBookmarks.toggleBookmark, {
      chatId: owner.chatId,
      messageId: owner.messageId,
    });
    const { bookmarks } = await readState(t, owner.userId, owner.chatId);
    const bookmarkId = bookmarks[0]!._id;

    await expect(
      asIntruder.mutation(api.chatBookmarks.toggleBookmark, {
        chatId: owner.chatId,
        messageId: owner.messageId,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asIntruder.mutation(api.chatBookmarks.renameBookmark, {
        bookmarkId,
        label: "hijack",
      }),
    ).rejects.toThrow(/Forbidden/);
    // Remove is an idempotent no-op for a foreign row: it must SURVIVE.
    await asIntruder.mutation(api.chatBookmarks.removeBookmark, { bookmarkId });
    const after = await readState(t, owner.userId, owner.chatId);
    expect(after.bookmarks).toHaveLength(1);
    expect(after.bookmarks[0]!.label).toBeUndefined();
    // And the owner's chat is invisible to the intruder's queries.
    await expect(
      asIntruder.query(api.chatBookmarks.getBookmarks, {
        chatId: owner.chatId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a message from ANOTHER chat cannot anchor a bookmark in this chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t, "alice");
    const foreignMessageId = await t.run(async (ctx) => {
      const otherChat = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      return ctx.db.insert("messages", {
        chatId: otherChat,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "elsewhere",
        updatedAt: 1000,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.mutation(api.chatBookmarks.toggleBookmark, {
        chatId,
        messageId: foreignMessageId,
      }),
    ).rejects.toThrow(/message not in chat/);
  });

  test("rename trims + caps the label; an empty label clears it", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.chatBookmarks.toggleBookmark, { chatId, messageId });
    const { bookmarks } = await readState(t, userId, chatId);
    const bookmarkId = bookmarks[0]!._id;

    await as.mutation(api.chatBookmarks.renameBookmark, {
      bookmarkId,
      label: "  " + "x".repeat(80) + "  ",
    });
    let state = await readState(t, userId, chatId);
    expect(state.bookmarks[0]!.label).toBe("x".repeat(60));

    await as.mutation(api.chatBookmarks.renameBookmark, {
      bookmarkId,
      label: "   ",
    });
    state = await readState(t, userId, chatId);
    expect(state.bookmarks[0]!.label).toBeUndefined();
  });

  test("setActiveBookmark records the jump target; null clears; cross-chat rows are rejected", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.chatBookmarks.toggleBookmark, { chatId, messageId });
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 7,
    });
    const { bookmarks } = await readState(t, userId, chatId);
    const first = bookmarks.find((b) => b.blockIndex === undefined)!;

    await as.mutation(api.chatBookmarks.setActiveBookmark, {
      chatId,
      bookmarkId: first._id,
    });
    let state = await readState(t, userId, chatId);
    expect(state.activeBookmarkId).toBe(first._id);

    await as.mutation(api.chatBookmarks.setActiveBookmark, {
      chatId,
      bookmarkId: null,
    });
    state = await readState(t, userId, chatId);
    expect(state.activeBookmarkId).toBeNull();

    // A bookmark row of ANOTHER chat cannot become this chat's active one.
    const other = await t.run(async (ctx) => {
      const otherChat = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      const otherMsg = await ctx.db.insert("messages", {
        chatId: otherChat,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "x",
        updatedAt: 1,
      });
      return ctx.db.insert("chatBookmarks", {
        userId,
        chatId: otherChat,
        messageId: otherMsg,
        createdAt: 1,
      });
    });
    await expect(
      as.mutation(api.chatBookmarks.setActiveBookmark, {
        chatId,
        bookmarkId: other,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("removing the ACTIVE bookmark via removeBookmark clears the pointer", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.chatBookmarks.toggleBookmark, { chatId, messageId });
    const { bookmarks, activeBookmarkId } = await readState(t, userId, chatId);
    expect(activeBookmarkId).toBe(bookmarks[0]!._id);
    await as.mutation(api.chatBookmarks.removeBookmark, {
      bookmarkId: bookmarks[0]!._id,
    });
    const after = await readState(t, userId, chatId);
    expect(after.bookmarks).toHaveLength(0);
    expect(after.activeBookmarkId).toBeNull();
  });

  test("myBookmarkedChats maps exactly the chats holding at least one bookmark", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${a.userId}|session` });
    const second = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId: a.userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: a.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "y",
        updatedAt: 1,
      });
      return { chatId, messageId };
    });

    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId: a.chatId,
      messageId: a.messageId,
    });
    let map = await as.query(api.chatBookmarks.myBookmarkedChats, {});
    expect(map).toEqual([a.chatId]);

    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId: second.chatId,
      messageId: second.messageId,
    });
    map = await as.query(api.chatBookmarks.myBookmarkedChats, {});
    expect(new Set(map)).toEqual(new Set([a.chatId, second.chatId]));

    // Removing the only bookmark of a chat drops it from the map.
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId: a.chatId,
      messageId: a.messageId,
    });
    map = await as.query(api.chatBookmarks.myBookmarkedChats, {});
    expect(map).toEqual([second.chatId]);
  });

  test("deleting a chat cascades its bookmark rows", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 2,
    });
    await as.mutation(api.chats.deleteChat, { chatId });
    const orphans = await t.run(async (ctx) =>
      (await ctx.db.query("chatBookmarks").collect()).filter(
        (b) => b.chatId === chatId,
      ),
    );
    expect(orphans).toHaveLength(0);
  });

  test("truncating messages purges their bookmarks and clears a dangling active pointer", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seedUserChat(t, "alice");
    // An EARLIER user turn that survives the truncation, bookmarked too.
    const keptId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "earlier turn",
        // Inserted AFTER the seed reply, but logically EARLIER: effectiveOrder
        // prefers orderTime, so the truncation must keep this turn.
        orderTime: 100,
        updatedAt: 500,
      }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId: keptId,
    });
    await as.mutation(api.chatBookmarks.toggleBookmark, {
      chatId,
      messageId,
      blockIndex: 3,
    });
    // The block bookmark on the (later) assistant reply is ACTIVE (last placed).
    let state = await readState(t, userId, chatId);
    expect(state.bookmarks).toHaveLength(2);
    // Truncate-forward from the assistant reply: its bookmark must go, the
    // earlier turn's must survive, and the active pointer must not dangle.
    await as.mutation(api.messages.deleteMessage, { messageId });
    state = await readState(t, userId, chatId);
    expect(state.bookmarks).toHaveLength(1);
    expect(state.bookmarks[0]!.messageId).toBe(keptId);
    expect(state.activeBookmarkId).toBeNull();
  });

  test("bookmark writes are a NO-OP under admin impersonation", async () => {
    const t = convexTest(schema, modules);
    const target = await seedUserChat(t, "alice");
    const adminId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "admin" as const,
        canonical: "root",
        impersonatingUserId: target.userId,
      });
      return userId;
    });
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const res = await asAdmin.mutation(api.chatBookmarks.toggleBookmark, {
      chatId: target.chatId,
      messageId: target.messageId,
    });
    expect(res.placed).toBe(false);
    const state = await readState(t, target.userId, target.chatId);
    expect(state.bookmarks).toHaveLength(0);
  });
});
