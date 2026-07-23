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

/** The caller's chats with the agent CURRENTLY working — the sidebar's "busy"
 *  pulse. Mirrors what the chat PAGE shows as work in progress (prod report
 *  2026-07-22: a chat whose parent turn yielded to a sub-agent showed activity
 *  on the page but not in the list), so it unions every live-activity signal:
 *
 *   - a `streamingText` row — a turn in flight, from "thinking" through the
 *     last token (created at startAssistant, deleted at finalize);
 *   - a RUNNING `subAgents` row — a spawned child working after the parent
 *     turn finalized, OR a gateway background task (kind:"task"): the page
 *     renders BOTH as spinning activity cards, so both pulse here (unlike the
 *     send-hold isChatBusy, which deliberately lets tasks through);
 *   - a `pending`/`queued` outbox row — the dispatch→ack window and parked
 *     follow-ups, so the pulse has no gap between send and first token.
 *
 *  Each read is ONE bounded indexed range on the CALLER's userId (never a
 *  global scan, never a probe-per-owned-chat — the listChats saturation
 *  lesson): the rows read are exactly the caller's live turns / running
 *  children / in-flight sends (typically 0–3 each), so a token landing for
 *  user A costs user B's sidebar nothing. A running row is bounded in time by
 *  the stale-sub-agent reaper; a legacy subAgents row without userId doesn't
 *  pulse until its next observer frame backfills it (same accepted tradeoff
 *  as streamingText.userId). */
export const myBusyChats = query({
  args: {},
  handler: async (ctx): Promise<Id<"chats">[]> => {
    const { userId } = await requireActive(ctx);
    // Dedupe defensively (one row per turn normally implies one per chat).
    // The caps apply BEFORE the per-chat dedup (codex P2): one busy chat can
    // legitimately hold many rows (20 queued sends, a fan-out of parallel
    // tasks), and a tight cap would let it crowd every OTHER busy chat out of
    // the slice — a false idle on exactly the chats the pulse exists for.
    // 200 is far above any real per-user concurrency while keeping the read
    // bounded; the ranges are per-user and transient, so the common cost is
    // a handful of rows.
    const SIGNAL_CAP = 200;
    const busy = new Set<Id<"chats">>();
    const live = await ctx.db
      .query("streamingText")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SIGNAL_CAP);
    for (const r of live) busy.add(r.chatId);
    const running = await ctx.db
      .query("subAgents")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "running"),
      )
      .take(SIGNAL_CAP);
    for (const r of running) busy.add(r.chatId);
    for (const status of ["pending", "queued"] as const) {
      const sends = await ctx.db
        .query("outbox")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", userId).eq("status", status),
        )
        .take(SIGNAL_CAP);
      for (const r of sends) busy.add(r.chatId);
    }
    return [...busy];
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
