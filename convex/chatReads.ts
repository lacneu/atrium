// Per-user per-chat read state (multi-chat UX). Two tiny surfaces:
//
//   - `myChatReads` (query)  — the user's {chatId -> lastSeenAt} map, ONE
//     bounded indexed read. Deliberately a SEPARATE query from listChats: the
//     sidebar's hottest query gains zero extra reads (the prod listChats
//     saturation lesson), and this one only re-pushes when a read-state row
//     changes (opening a chat), not on every message.
//   - `markChatSeen` (mutation) — owner-scoped upsert, called when the user
//     opens a chat and again when a reply lands while they are ON it.
//
// The unread derivation (chat.lastAssistantAt > lastSeenAt) happens CLIENT-side
// in the sidebar, crossing this map with listChats rows.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";

// Matches listChats' bounded-window philosophy: more rows than any sidebar
// shows, small enough to never threaten the per-function read budget.
const MAX_READS = 500;

export const myChatReads = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ chatId: Id<"chats">; lastSeenAt: number }[]> => {
    const { userId } = await requireActive(ctx);
    // DESC on lastSeenAt: the bounded window keeps the MOST RECENTLY seen
    // chats — the set the visible sidebar actually needs. A chat evicted past
    // 500 falls back to "no row" (= no dot), never to a stale-wrong dot.
    const rows = await ctx.db
      .query("chatReads")
      .withIndex("by_user_seen", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_READS);
    return rows.map((r) => ({ chatId: r.chatId, lastSeenAt: r.lastSeenAt }));
  },
});

/** The caller's chats with a turn CURRENTLY in flight. Powered by the
 *  streamingText table — one row per active turn, created at startAssistant
 *  (t0) and deleted at finalize, so this is reactive from "thinking" through
 *  the last token. Feeds the sidebar's per-row and per-folder "busy" pulse.
 *
 *  ONE indexed range on the CALLER's userId (never a global scan, never a
 *  probe-per-owned-chat): the rows read are exactly the caller's live turns
 *  (typically 0–3), so a token landing for user A costs user B's sidebar
 *  nothing, and a user with hundreds of chats doesn't fan out hundreds of
 *  index probes on every one of their own tokens. */
export const myBusyChats = query({
  args: {},
  handler: async (ctx): Promise<Id<"chats">[]> => {
    const { userId } = await requireActive(ctx);
    const live = await ctx.db
      .query("streamingText")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    // Dedupe defensively (one row per turn normally implies one per chat).
    return [...new Set(live.map((r) => r.chatId))];
  },
});

export const markChatSeen = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<void> => {
    const { userId, impersonating } = await requireActive(ctx);
    // An admin LOOKING at a user's sidebar/chat must not silently consume the
    // user's unread markers (same no-op-under-impersonation rule as the other
    // personal writes, e.g. notification reads).
    if (impersonating) return;
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    const existing = await ctx.db
      .query("chatReads")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", userId).eq("chatId", chatId),
      )
      .first();
    const now = Date.now();
    if (existing) {
      // Monotonic: a late/racing call can never move the watermark backwards.
      if (existing.lastSeenAt < now) {
        await ctx.db.patch(existing._id, { lastSeenAt: now });
      }
      return;
    }
    await ctx.db.insert("chatReads", { userId, chatId, lastSeenAt: now });
  },
});
