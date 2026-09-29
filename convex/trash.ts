// THE CONVERSATION TRASH — list, restore, delete permanently, empty, and the daily
// purge (lib/trash holds the shared rules, chats.ts the trash/restore/purge writes).
//
// RIGHTS. The OWNER manages their own trash. An ADMIN sees every trash and may
// restore or purge any conversation in it — always audit-logged (their own act, not
// an impersonation). A participant has no trash: deleting stays owner-only, and a
// participant's view of a trashed conversation is simply gone until it is restored.
//
// These functions read the chat row directly: every other access path refuses a
// trashed conversation (lib/chatAccess.resolveChatAccess), which is the point.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireActive, requireAdmin } from "./lib/access";
import { auditImpersonated, recordAudit } from "./lib/audit";
import { cascadeDeleteChat, restoreFromTrash } from "./chats";
import { isTrashed, trashRetentionDays } from "./lib/trash";

/** Trashed conversations one listing PAGE returns at most, whatever is asked. */
export const TRASH_PAGE_MAX = 100;

function boundedPage(opts: { numItems: number; cursor: string | null }) {
  return { ...opts, numItems: Math.max(1, Math.min(opts.numItems, TRASH_PAGE_MAX)) };
}
/** Conversations one purge step starts (each schedules its own batched sweep). */
export const PURGE_START_BATCH = 25;
/** A purge whose progress stamp is older than this has lost its chain. */
export const PURGE_STALE_MS = 60 * 60 * 1000;
/** Stalled purges re-armed per cron run. */
const PURGE_REARM_BATCH = 50;

type TrashRow = {
  _id: Id<"chats">;
  title: string | null;
  trashedAt: number;
  purgeAfter: number | null;
};

function trashRow(chat: Doc<"chats">): TrashRow {
  return {
    _id: chat._id,
    title: chat.title ?? null,
    trashedAt: chat.trashedAt ?? 0,
    purgeAfter: chat.purgeAfter ?? null,
  };
}

/** How long a deleted conversation stays restorable — what the delete
 *  confirmations and the trash view announce (CHAT_TRASH_RETENTION_DAYS). */
export const retention = query({
  args: {},
  handler: async (ctx): Promise<{ days: number }> => {
    await requireActive(ctx);
    return { days: trashRetentionDays() };
  },
});

/** The caller's trash, most recently deleted first — paginated, so every item
 *  stays reachable however many there are. */
export const listMyTrash = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const { userId } = await requireActive(ctx);
    const page = await ctx.db
      .query("chats")
      .withIndex("by_user_trashed", (q) => q.eq("userId", userId).gte("trashedAt", 0))
      .order("desc")
      .paginate(boundedPage(paginationOpts));
    return { ...page, page: page.page.map(trashRow) };
  },
});

/** The trashed conversation `chatId` of its owner — or an error that says neither
 *  whether it exists nor whose it is. */
async function ownTrashedChat(
  ctx: MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
): Promise<Doc<"chats">> {
  const chat = await ctx.db.get(chatId);
  if (chat === null || chat.userId !== userId || !isTrashed(chat)) {
    throw new Error("Not found: chat not in your trash");
  }
  return chat;
}

/** Take one of my conversations out of the trash, as it was. */
export const restoreChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    const chat = await ownTrashedChat(ctx, userId, chatId);
    await restoreFromTrash(ctx, chat);
    await auditImpersonated(ctx, actor, "chat.restore", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

/** Delete one of my trashed conversations permanently, now. */
export const purgeChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    await ownTrashedChat(ctx, userId, chatId);
    await cascadeDeleteChat(ctx, chatId);
    await auditImpersonated(ctx, actor, "chat.purge", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

/**
 * Empty my trash: every conversation in it at the moment of the click is purged
 * permanently, in scheduled steps. `cutoff` is that moment — a conversation
 * trashed afterwards is not taken along.
 */
export const emptyTrash = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, actor } = await requireActive(ctx);
    await emptyTrashBatch(ctx, userId, Date.now());
    await auditImpersonated(ctx, actor, "chat.empty_trash", {
      resource: "user",
      resourceId: userId,
    });
  },
});

async function emptyTrashBatch(
  ctx: MutationCtx,
  userId: Id<"users">,
  cutoff: number,
): Promise<void> {
  const rows = await ctx.db
    .query("chats")
    .withIndex("by_user_trashed", (q) =>
      q.eq("userId", userId).gte("trashedAt", 0).lte("trashedAt", cutoff),
    )
    .take(PURGE_START_BATCH);
  for (const chat of rows) await cascadeDeleteChat(ctx, chat._id, { inline: false });
  if (rows.length === PURGE_START_BATCH) {
    await ctx.scheduler.runAfter(0, internal.trash.emptyTrashStep, { userId, cutoff });
  }
}

export const emptyTrashStep = internalMutation({
  args: { userId: v.id("users"), cutoff: v.number() },
  handler: async (ctx, { userId, cutoff }) => {
    await emptyTrashBatch(ctx, userId, cutoff);
  },
});

// ── Admin ──────────────────────────────────────────────────────────────────

/** Every trash, soonest purge first, with whose conversation each one is —
 *  paginated like the owner's. */
export const adminListTrash = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const page = await ctx.db
      .query("chats")
      .withIndex("by_purge_after", (q) => q.gte("purgeAfter", 0))
      .paginate(boundedPage(paginationOpts));
    const rows = page.page;
    const owners = new Map<string, string>();
    const out: Array<TrashRow & { ownerId: Id<"users">; owner: string }> = [];
    for (const chat of rows) {
      const key = String(chat.userId);
      if (!owners.has(key)) {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_user", (q) => q.eq("userId", chat.userId))
          .unique();
        owners.set(key, profile?.name ?? profile?.email ?? `#${key.slice(0, 6)}`);
      }
      out.push({ ...trashRow(chat), ownerId: chat.userId, owner: owners.get(key)! });
    }
    return { ...page, page: out };
  },
});

async function anyTrashedChat(ctx: MutationCtx, chatId: Id<"chats">): Promise<Doc<"chats">> {
  const chat = await ctx.db.get(chatId);
  if (chat === null || !isTrashed(chat)) throw new Error("Not found: chat not in a trash");
  return chat;
}

/** An admin restores any trashed conversation. Audit-logged. */
export const adminRestoreChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const adminId = await requireAdmin(ctx);
    const chat = await anyTrashedChat(ctx, chatId);
    await restoreFromTrash(ctx, chat);
    await recordAudit(
      ctx,
      { realUserId: adminId, effectiveUserId: adminId, impersonating: false },
      "chat.admin_restore",
      { resource: "chat", resourceId: chatId },
    );
  },
});

/** An admin purges any trashed conversation permanently, now. Audit-logged. */
export const adminPurgeChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const adminId = await requireAdmin(ctx);
    await anyTrashedChat(ctx, chatId);
    await cascadeDeleteChat(ctx, chatId);
    await recordAudit(
      ctx,
      { realUserId: adminId, effectiveUserId: adminId, impersonating: false },
      "chat.admin_purge",
      { resource: "chat", resourceId: chatId },
    );
  },
});

// ── The daily purge ────────────────────────────────────────────────────────

/**
 * The cron (crons.ts, daily): purge the conversations whose retention has ended,
 * and re-arm purges whose chain died.
 *
 * DUE: `purgeAfter` passed — a bounded batch per run, each purge started (the
 * chat row deleted, a `chatPurges` ledger row written, its batched sweep
 * scheduled); the run re-schedules itself while a full batch was taken.
 *
 * STALLED: a ledger row whose progress stamp is older than PURGE_STALE_MS — a
 * sweep batch threw and the chain stopped (the scheduler does not retry those).
 * Stamped before re-arming, so two overlapping runs do not both re-arm it. A purge
 * interrupted halfway is therefore finished by the next run at the latest.
 */
export const purgeTrash = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("chats")
      // A LOWER BOUND is not optional: an absent `purgeAfter` (every live chat)
      // sorts before every number.
      .withIndex("by_purge_after", (q) => q.gte("purgeAfter", 0).lte("purgeAfter", now))
      .take(PURGE_START_BATCH);
    for (const chat of due) {
      // Defensive: only a TRASHED row is ever purged by the clock.
      if (!isTrashed(chat)) continue;
      await cascadeDeleteChat(ctx, chat._id, { inline: false });
    }
    const stalled = await ctx.db
      .query("chatPurges")
      .withIndex("by_updated", (q) => q.gte("updatedAt", 0).lt("updatedAt", now - PURGE_STALE_MS))
      .take(PURGE_REARM_BATCH);
    for (const job of stalled) {
      await ctx.db.patch(job._id, { updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.chats.sweepDeletedChat, {
        chatId: job.chatId,
        ownerId: job.ownerId,
      });
    }
    if (due.length === PURGE_START_BATCH) {
      await ctx.scheduler.runAfter(0, internal.trash.purgeTrash, {});
    }
    return { started: due.length, rearmed: stalled.length };
  },
});
