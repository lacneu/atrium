// Collaborative documents v1: the user edits a delivered text file directly
// in the right-panel viewer (auto-saved DRAFT), then feeds the edited version
// back to the agent in the next prompt. The agent's reply delivers a NEW file
// version; the panel tracks (chat, filename) so the loop continues — the
// ChatGPT-canvas pattern adapted to Atrium's message-centric architecture.
//
// FULL-COMPLIANCE by design: the draft is plain text in Convex, and the
// "use in prompt" surface sends it through the EXISTING attachment pipeline
// when the instance supports attachments, or as inline fenced text when it
// does not (Hermes) — no gateway coupling, works on every provider.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";
import { stripGatewayMediaId } from "./lib/mediaName";

// Text-kind documents only. UTF-8 BYTES (what Convex stores — a UTF-16
// character count would let CJK/emoji text blow the ~1MiB document cap
// while "passing" the check), with headroom for the row's other fields.
export const DRAFT_TEXT_CAP_BYTES = 600_000;

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

/** The caller's draft for one document of one chat (null = none). */
export const getDraft = query({
  args: { chatId: v.id("chats"), filename: v.string() },
  handler: async (
    ctx,
    { chatId, filename },
  ): Promise<{
    text: string;
    sourceStorageId: string | null;
    updatedAt: number;
  } | null> => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, chatId, userId);
    const row = await ctx.db
      .query("documentDrafts")
      .withIndex("by_user_chat_filename", (q) =>
        q.eq("userId", userId).eq("chatId", chatId).eq("filename", filename),
      )
      .first();
    if (row === null) return null;
    return {
      text: row.text,
      sourceStorageId: row.sourceStorageId ?? null,
      updatedAt: row.updatedAt,
    };
  },
});

/** Auto-save upsert (debounced client-side). Owner-scoped; no-op under admin
 *  impersonation (same personal-write rule as bookmarks/read state). */
export const saveDraft = mutation({
  args: {
    chatId: v.id("chats"),
    filename: v.string(),
    text: v.string(),
    sourceStorageId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { chatId, filename, text, sourceStorageId },
  ): Promise<{ applied: boolean }> => {
    const { userId, impersonating } = await requireActive(ctx);
    // Personal-write no-op under impersonation — but tell the CLIENT so the
    // editor never shows a fictional "saved" (codex P2).
    if (impersonating) return { applied: false };
    await requireOwnedChat(ctx, chatId, userId);
    if (new TextEncoder().encode(text).length > DRAFT_TEXT_CAP_BYTES) {
      throw new Error("Draft too large");
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("documentDrafts")
      .withIndex("by_user_chat_filename", (q) =>
        q.eq("userId", userId).eq("chatId", chatId).eq("filename", filename),
      )
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        text,
        updatedAt: now,
        // The source anchor is set at draft CREATION (first edit of a given
        // delivered version) and refreshed when the caller re-bases onto a
        // newer delivery (it passes the new sourceStorageId).
        ...(sourceStorageId !== undefined ? { sourceStorageId } : {}),
      });
      return { applied: true };
    }
    await ctx.db.insert("documentDrafts", {
      userId,
      chatId,
      filename,
      text,
      sourceStorageId,
      createdAt: now,
      updatedAt: now,
    });
    return { applied: true };
  },
});

/** Discard the draft (back to the delivered version). Idempotent. */
export const deleteDraft = mutation({
  args: { chatId: v.id("chats"), filename: v.string() },
  handler: async (
    ctx,
    { chatId, filename },
  ): Promise<{ applied: boolean }> => {
    const { userId, impersonating } = await requireActive(ctx);
    if (impersonating) return { applied: false };
    const row = await ctx.db
      .query("documentDrafts")
      .withIndex("by_user_chat_filename", (q) =>
        q.eq("userId", userId).eq("chatId", chatId).eq("filename", filename),
      )
      .first();
    if (row !== null) await ctx.db.delete(row._id);
    return { applied: true };
  },
});

/**
 * The NEWEST delivered (outbound) version of a document in this chat, by
 * NORMALIZED name — OpenClaw deliveries carry a `---<uuid>` media-store
 * suffix in files.filename while the viewer sees the stripped display name,
 * and two versions of the same document carry DIFFERENT uuids: exact-name
 * matching would never link them (codex P1). Bounded newest-first scan with
 * the SHARED normalization (lib/mediaName).
 */
export const latestDeliveredFile = query({
  args: {
    chatId: v.id("chats"),
    filename: v.string(),
    // Stable id of the version the viewer currently displays: the banner
    // must only fire for a STRICTLY NEWER delivery — an inbound copy or a
    // hidden version displayed in the viewer could otherwise be "upgraded"
    // BACKWARD to an older outbound row (codex P2).
    currentStorageId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { chatId, filename, currentStorageId },
  ): Promise<{
    url: string;
    storageId: string;
    // Metadata of the NEW version: a redelivery can change type/format, and
    // the switching viewer must classify + re-attach with the new identity,
    // not the old one (codex P2).
    mimeType: string;
    createdAt: number;
  } | null> => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, chatId, userId);
    const wanted = stripGatewayMediaId(filename);
    // ONE bounded read of the chat's files, soft-deleted INCLUDED: hiding a
    // file from Settings › Files keeps its chip in the chat, so it stays a
    // real delivered version (codex P2). Partial index prefix (user, chat)
    // then an in-memory chronological sort — paging on createdAt would skip
    // ties, and forkChat stamps EVERY copied file with the same `now`
    // (codex P2). files rows are small metadata; 400 is far beyond any real
    // chat and degrades to silence, never to a wrong version.
    // TWO bounded reads, each on a well-ordered range — a partial-prefix
    // read defaults to ASC and take(400) would then keep the OLDEST rows
    // (codex P2): (a) live files, newest-first on createdAt; (b) the chat's
    // soft-HIDDEN files (still real chat deliveries), newest-hidden-first.
    const live = await ctx.db
      .query("files")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", userId).eq("chatId", chatId).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(300);
    // Hidden window caveat: this range orders by deletedAt (hide time), not
    // delivery time — with 200+ hidden files in ONE chat (pathological) a
    // long-hidden recent delivery could fall outside it. Degradation is
    // SILENCE (no banner), never a backward switch: the chronology gate
    // below refuses any hit not strictly newer than the resolved current.
    const hidden = await ctx.db
      .query("files")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", userId).eq("chatId", chatId).gt("deletedAt", 0),
      )
      .order("desc")
      .take(200);
    const rows = [...live, ...hidden];
    // (createdAt, _creationTime) DESC: _creationTime breaks fork ties in
    // copy order, which follows the source chronology.
    const chrono = [...rows].sort((a, b) =>
      b.createdAt !== a.createdAt
        ? b.createdAt - a.createdAt
        : b._creationTime - a._creationTime,
    );
    const hit =
      chrono.find(
        (r) =>
          r.direction === "outbound" &&
          stripGatewayMediaId(r.filename) === wanted,
      ) ?? null;
    if (hit === null) return null;
    if (currentStorageId !== undefined) {
      if (hit.storageId === currentStorageId) return null;
      // The CURRENT version resolved inside THIS chat (forkChat reuses
      // storageIds across chats — codex P2), from the same bounded window.
      const current =
        chrono.find((r) => r.storageId === currentStorageId) ?? null;
      // UNRESOLVABLE current (its files row was deleted with a truncated
      // message, or fell out of the window): the chronological order cannot
      // be established — announce NOTHING rather than risk a backward
      // switch (codex P2).
      if (current === null) return null;
      // Strictly newer only; fork copies share createdAt, so ties break on
      // _creationTime like the sort above (codex P2).
      if (
        hit.createdAt < current.createdAt ||
        (hit.createdAt === current.createdAt &&
          hit._creationTime <= current._creationTime)
      ) {
        return null;
      }
    }
    const url = await ctx.storage.getUrl(hit.storageId as never);
    if (url === null) return null;
    return {
      url,
      storageId: hit.storageId,
      mimeType: hit.mimeType,
      createdAt: hit.createdAt,
    };
  },
});
