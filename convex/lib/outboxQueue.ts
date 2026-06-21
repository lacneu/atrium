// Mid-turn send serialization (Phase 1: QUEUE) — the single-in-flight-turn
// invariant for a chat.
//
// WHY: a user may submit a follow-up while the assistant is still replying. The
// bridge is strictly one-turn-per-session (turn-sink holds a single streaming
// messageId), so two concurrent dispatches on the same chat would corrupt the
// in-flight turn. Instead we serialize HERE, in Convex: at most ONE turn per
// chat is dispatched at a time; extra sends are parked as `queued` outbox rows
// and auto-dispatched (FIFO) as soon as the chat goes idle.
//
// This is gateway-agnostic (plain sequential `chat.send`s — no concurrent send
// ever reaches the gateway), so it needs no capability and works on every
// provider/version. The capability-gated STEER variant (a message injected INTO
// the running turn) is a later phase.
//
// Correctness rests on Convex's serializable transactions: isChatBusy reads the
// (chat, "pending") outbox range and the (chat, "streaming") message range, and
// drainNextQueued promotes the oldest queued row inside the same transaction —
// concurrent sends/drains that race on those ranges conflict and retry, so the
// invariant holds without an explicit lock.

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { effectiveOrder, QUEUED_ORDER_SENTINEL } from "./messageOrder";

/** Most a single chat may hold queued behind the in-flight turn (anti-runaway). */
export const MAX_QUEUED_PER_CHAT = 20;

/**
 * Does the chat have a turn IN FLIGHT? True when either:
 *  - an outbox row is `pending` (dispatch scheduled / HTTP in flight, before the
 *    bridge has acked), OR
 *  - an assistant message is `streaming` (the bridge acked and the turn is
 *    producing tokens — the window between markOutbox("sent") and finalize).
 * Together these cover the whole dispatch→reply lifecycle with no gap.
 */
export async function isChatBusy(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<boolean> {
  const pending = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "pending"),
    )
    .first();
  if (pending !== null) return true;
  const streaming = await ctx.db
    .query("messages")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "streaming"),
    )
    .first();
  return streaming !== null;
}

/** How many sends are currently parked behind the in-flight turn for a chat. */
export async function countQueued(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<number> {
  const rows = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "queued"),
    )
    .collect();
  return rows.length;
}

/**
 * If the chat is idle, promote its OLDEST queued send to `pending` and schedule
 * its dispatch. No-op when the chat is still busy or the queue is empty —
 * idempotent and safe to call from EVERY turn-end path (finalize, a failed
 * dispatch, the stuck-stream reconcilers) so the queue can never stall.
 */
export async function drainNextQueued(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<void> {
  if (await isChatBusy(ctx, chatId)) return;
  const next = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "queued"),
    )
    // index order = _creationTime ascending within the (chat, "queued") range → FIFO.
    .first();
  if (next === null) return;
  await ctx.db.patch(next._id, { status: "pending" });
  // Stamp the now-dispatched follow-up's LOGICAL order time (see lib/messageOrder).
  // `next.messageId` is the optimistic user message from send.ts (currently SENTINEL).
  // Use a value STRICTLY GREATER than every already-DISPATCHED message's effectiveOrder
  // — not raw Date.now(): if the drain lands in the SAME millisecond the prior turn's
  // assistant was created (an instant turn), Date.now() would TIE that assistant and
  // compareOrder would fall back to this message's early pre-ack _creationTime, sorting
  // it BEFORE the assistant. The bump stays well below SENTINEL, so it still sorts
  // before any OTHER still-queued follow-up. (Still-queued SENTINEL rows are excluded
  // from the max — the promoted turn dispatches now, ahead of them.)
  if (next.messageId) {
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(50);
    let maxDispatched = 0;
    for (const m of recent) {
      if (m.orderTime === QUEUED_ORDER_SENTINEL) continue; // a still-queued peer
      const eo = effectiveOrder(m);
      if (eo > maxDispatched) maxDispatched = eo;
    }
    await ctx.db.patch(next.messageId, {
      orderTime: Math.max(Date.now(), maxDispatched + 1),
    });
  }
  await ctx.scheduler.runAfter(0, internal.bridge.dispatch, {
    outboxId: next._id,
  });
}

