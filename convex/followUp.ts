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
import { projectedGatewayHoldUntil, SESSION_ACTIVE_FRESH_MS } from "./lib/outboxQueue";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { currentCustody } from "./lib/transcriptProjection";

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
      // Phase 4: until when a gateway fact says the agent works (a run active at the last
      // read, or a send's run admitted with no bubble yet) — the SAME bounded rule the busy
      // check applies (lib/outboxQueue `projectedGatewayHoldUntil`). A deadline, not a
      // boolean: a query is not re-run when time passes, so the client stops showing it
      // at that instant on its own (`useConvexChatRuntime`). Null: nothing says so.
      workingUntil: await projectedGatewayHoldUntil(ctx, chatId),
      // Phase 6: the gateway's OWN queue, PER SESSION (2026.9.7+ `pendingInputs.queuedCount`,
      // chat-pending-inputs.ts:72-99 at v2026.9.8). The composer shows a queued input there,
      // never in the thread — the Control UI's split (ui/src/pages/chat/history-merge.ts:
      // 402-441). Each session's fact governs ONLY the messages that session holds (codex
      // phase 6 pass 4: one session's read used to move another session's messages), with
      // its own deadline like `workingUntil`.
      gatewayQueue: { sessions: await gatewayQueueSessions(ctx, chatId) },
    };
  },
});

/** The gateway's queue as the last read stated it, bounded by that read's freshness. */
export function gatewayQueueOf(
  cursor: Pick<Doc<"transcriptCursors">, "pendingQueuedCount" | "pendingQueuedAt"> | null,
): { count: number; until: number } | null {
  // The bound runs from the read that STATED the count (`pendingQueuedAt`), never from the
  // cursor's `updatedAt`: a reset or a read without the counter rewrites the cursor and
  // would renew an hour-old queue (codex phase 6 pass 1). No stamp ⇒ no claim.
  if (
    cursor === null ||
    typeof cursor.pendingQueuedCount !== "number" ||
    typeof cursor.pendingQueuedAt !== "number"
  ) {
    return null;
  }
  return {
    count: Math.max(0, Math.floor(cursor.pendingQueuedCount)),
    until: cursor.pendingQueuedAt + SESSION_ACTIVE_FRESH_MS,
  };
}

/** Sessions of a conversation whose queue the composer shows (the most recently read). */
export const MAX_QUEUE_SESSIONS = 8;
/** Queued inputs read per session (the gateway's pending page holds at most 20). */
export const MAX_QUEUED_INPUTS_PER_SESSION = 20;

export type GatewayQueueSession = { count: number; until: number; sendIds: string[] };

/**
 * The gateway's queue of each recently read session that is still FRESH: its count and
 * deadline (the read that stated it, on Convex's clock), and the send identities that
 * session holds queued (its `transcriptInputs` facts, `currentCustody === "queued"`). A
 * message is shown in the dock only through its own session's fact (codex phase 6 pass 4).
 *
 * LIGHTWEIGHT BY CONSTRUCTION (codex phase 6 pass 5): an expired session is dropped before
 * anything else is read, and no message document is ever loaded here — the client matches
 * a queued bubble by the send identity `messages.listByChat` already gives it — so a
 * conversation of huge messages cannot push this query past the read limit. Bounded:
 * MAX_QUEUE_SESSIONS cursors, then two index ranges of MAX_QUEUED_INPUTS_PER_SESSION input
 * rows (identities only, never text) per fresh, non-empty session. `on` only.
 */
export async function gatewayQueueSessions(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  now: number = Date.now(),
): Promise<GatewayQueueSession[]> {
  const cursors = await ctx.db
    .query("transcriptCursors")
    .withIndex("by_chat_updated", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(MAX_QUEUE_SESSIONS);
  const out: GatewayQueueSession[] = [];
  for (const c of cursors) {
    const fact = gatewayQueueOf(c);
    if (fact === null || fact.count === 0 || fact.until <= now) continue;
    const byPending = await ctx.db
      .query("transcriptInputs")
      .withIndex("by_chat_session_pending", (q) =>
        q.eq("chatId", chatId).eq("sessionKey", c.sessionKey).eq("pendingState", "queued"),
      )
      .take(MAX_QUEUED_INPUTS_PER_SESSION);
    const byReceipt = await ctx.db
      .query("transcriptInputs")
      .withIndex("by_chat_session_receipt_queued", (q) =>
        q.eq("chatId", chatId).eq("sessionKey", c.sessionKey).eq("receiptQueued", true),
      )
      .take(MAX_QUEUED_INPUTS_PER_SESSION);
    const sendIds = new Set<string>();
    for (const f of [...byPending, ...byReceipt]) {
      if (currentCustody(f) === "queued") sendIds.add(f.sendId);
    }
    out.push({ ...fact, sendIds: [...sendIds] });
  }
  return out;
}

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
