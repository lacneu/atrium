// THE COMPOSER'S "WHILE THE AGENT WORKS" CONTROL (transcript redesign phase 3, design §3).
//
// The Control UI lets a person choose what a message sent during a run does — `queue`
// (wait until the agent is free) or `steer` (inject into the turn in progress) — and
// otherwise follows the gateway's own mode (ui/src/app/settings.ts:123-130,
// ui/src/lib/chat/follow-up-mode.ts:51-56 at v2026.9.8). It also offers "interrupt and
// send" (`/redirect`, ui/src/pages/chat/chat-command-executor.ts:697-740) and, from
// 2026.9.7, the cancel of an input waiting in the gateway's queue
// (`chat.abort {runId, discardPendingInput}`). Only on a conversation whose instance runs
// the transcript projection `on`; elsewhere the historical queue applies and these
// controls are not shown.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { getProfile, requireActive, requireReachableChat } from "./lib/access";
import { projectionModeOfChat } from "./lib/followUp";

/** What the composer needs to label and offer the busy-send actions. */
export const followUpState = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const { chat } = await requireReachableChat(ctx, userId, chatId);
    const projection = (await projectionModeOfChat(ctx, chat)) === "on";
    if (!projection) return { projection: false as const };
    const profile = await getProfile(ctx, userId);
    // The session the conversation reads last (its cursor carries the gateway's own
    // mode from `sessionInfo`, transcriptProjection.applyTranscript).
    const cursor = await ctx.db
      .query("transcriptCursors")
      .withIndex("by_chat_updated", (q) => q.eq("chatId", chatId))
      .order("desc")
      .first();
    return {
      projection: true as const,
      preference: profile?.followUpMode ?? null,
      serverMode: cursor?.sessionQueueMode ?? cursor?.effectiveQueueMode ?? null,
    };
  },
});

/** The person's default for a message sent while the agent works (`null` = the
 *  gateway's own mode, the Control UI's "server" choice). */
export const setFollowUpMode = mutation({
  args: { mode: v.union(v.literal("queue"), v.literal("steer"), v.null()) },
  handler: async (ctx, { mode }) => {
    const { userId } = await requireActive(ctx);
    const profile = await getProfile(ctx, userId);
    if (profile === null) return;
    const next = mode ?? undefined;
    if (profile.followUpMode === next) return;
    await ctx.db.patch(profile._id, { followUpMode: next });
  },
});

/**
 * Cancel ONE input the gateway holds in its own queue (2026.9.7+, design §3.4): the
 * user bubble shows `queued`; its send identity is the `runId` the gateway indexes it by.
 * The gateway's answer comes back through the transcript reads (`cancelled`).
 */
export const cancelGatewayQueuedInput = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const { userId } = await requireActive(ctx);
    const message = await ctx.db.get(messageId);
    if (message === null || message.role !== "user") {
      return { ok: false as const, reason: "not_found" as const };
    }
    const { chat } = await requireReachableChat(ctx, userId, message.chatId);
    if ((await projectionModeOfChat(ctx, chat)) !== "on") {
      return { ok: false as const, reason: "not_projected" as const };
    }
    if (message.custody !== "queued" || message.sendId === undefined) {
      return { ok: false as const, reason: "not_queued" as const };
    }
    // Only the conversation's owner or the message's author may withdraw it.
    if (chat.userId !== userId && (message.authorUserId ?? message.userId) !== userId) {
      return { ok: false as const, reason: "forbidden" as const };
    }
    const row = await ctx.db
      .query("outbox")
      .withIndex("by_send_id", (q) => q.eq("sendId", message.sendId!))
      .first();
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchAbort, {
      chatId: message.chatId,
      userId: chat.userId,
      runId: message.sendId,
      discardPendingInput: true,
      ...(row?.routedAgent ? { routedAgent: row.routedAgent } : {}),
    });
    return { ok: true as const };
  },
});
