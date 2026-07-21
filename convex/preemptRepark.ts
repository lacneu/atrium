// AUTOMATIC RE-DISPATCH of a turn the GATEWAY killed to run a delivery.
//
// The inverse direction of bridge.reparkIfBusy (0.68): there, a paced dispatch
// that wakes into an announce-reopened bubble is re-parked BEFORE it reaches
// the gateway. Here the dispatch WON the race — the follow-up was already
// running gateway-side when the sub-agent's delivery (announce) claimed the
// session, and the gateway aborted the REAL turn (live prod 2026-07-21, report
// ms746b01…: chat.send 09:03:46, gateway_abort 09:04:05, announce 09:04:09 —
// the user's message was silently consumed and had to be re-sent by hand after
// three session resets). Queueing a message mid-turn is a SUPPORTED feature:
// the system, not the user, owns the recovery.
//
// MECHANISM — ride the battle-tested queue, never a bespoke dispatch:
//   finalize (stream.ts, gatewayPreempted flag minted by the bridge sink for a
//   zero-content, non-user-abort, real-turn gateway kill)
//     → maybeReparkPreemptedTurn (same-transaction: guards, delete the empty
//       aborted card, stamp the outbox row, HOLD it as `pending`, schedule the
//       delayed flip)
//     → reparkAfterPreempt (after PREEMPT_REPARK_DELAY_MS: re-check the world,
//       flip the row pending→queued, drainNextQueued)
//     → the normal drain machinery (FIFO, QUEUE_DRAIN_DELAY_MS pacing,
//       reparkIfBusy re-check) dispatches once the delivery settles.
//
// WHY the DELAY before the flip: the kill precedes the announce by a few
// seconds (4s live). Flipping straight to `queued` would let finalize's own
// drain promote the row while the chat is still idle — the re-dispatch would
// then land mid-announce and the gateway would kill THE ANNOUNCE (the exact
// ping-pong reparkIfBusy exists to prevent). By the time the flip fires the
// announce is streaming (drain no-ops; its finalize re-drains) or the world
// is idle (drain dispatches, paced + re-checked).
//
// WHY the hold is `pending`, not `sent` (codex P1): a `sent` row is INERT to
// isChatBusy — a user send landing inside the delay window would dispatch
// immediately, run AHEAD of the held turn (order inversion) and collide with
// the incoming delivery all over again. `pending` is the queue's own
// serialization blocker: window sends park as `queued` behind the hold and
// drain FIFO after it (the held row's earlier _creationTime sorts it first).
// No dispatch job targets the held row, so bridge.dispatch's status guard
// can never double-fire it; every stand-down path MUST restore `sent` (the
// inert terminal) + drain, or the hold would block the chat forever.
//
// SAFETY MODEL — one automatic re-dispatch, provably a pure re-run:
//   - the bridge flag only fires for a ZERO-content aborted turn without a
//     user Stop (sink gates) — nothing visible is lost by deleting the card;
//   - the row is stamped `preemptRedispatched` BEFORE the flip: a second kill
//     of the same row stands down to the honest aborted card (bounded chain);
//   - the fire-time flip re-checks the world (row untouched, user message
//     still present, no newer re-dispatch of the same message) — any mismatch
//     is a silent stand-down: the user moved on.
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { compareOrder, QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";
import { drainNextQueued } from "./lib/outboxQueue";
import { deleteTurnCardCascade } from "./turnRetry";
import { writeTraceEvent } from "./observability";

/** Kill→announce gap headroom: the flip must fire AFTER the delivery opened
 *  its stream (live gap 4s), so the drain defers to the delivery instead of
 *  racing it. A delivery that never comes only delays the re-dispatch by this
 *  much. */
export const PREEMPT_REPARK_DELAY_MS = 10_000;

/** How recently a child/task of the chat must have gone terminal for the kill
 *  to read as "the delivery claimed the session" (live gap: child done
 *  09:03:30 → kill 09:04:05 = 35s). Generous but bounded — outside it the
 *  abort has no delivery to blame and reads as an operator stop. */
export const PREEMPT_PROOF_WINDOW_MS = 120_000;

const traceRepark = async (
  ctx: MutationCtx,
  chatId: Id<"chats">,
  messageId: Id<"messages">,
  phase: string,
  detail?: Record<string, unknown>,
): Promise<void> => {
  try {
    await writeTraceEvent(ctx, {
      kind: "chat.preempt_redispatch",
      direction: "internal",
      principalType: "system",
      principalId: "preempt-repark",
      chatId,
      correlationId: `${chatId}:${messageId}`,
      meta: JSON.stringify({ phase, messageId, ...(detail ?? {}) }),
    });
  } catch (e) {
    console.error(
      "[preemptRepark] trace failed (non-fatal):",
      (e as Error)?.message ?? e,
    );
  }
};

/** Called by stream.finalize when the bridge flagged the finalize
 *  gatewayPreempted. Same transaction as the finalize: the guards read the
 *  state the finalize just wrote. Any failed guard leaves the aborted card
 *  as-is (silent stand-down — the honest fallback). */
export async function maybeReparkPreemptedTurn(
  ctx: MutationCtx,
  message: Doc<"messages">,
  finalTextLen: number,
): Promise<void> {
  // REGULAR chats only (mirrors turnRetry): utility kinds own their failures.
  const chat = await ctx.db.get(message.chatId);
  if (chat === null || chat.kind != null) return;
  // Zero-content only — defense in depth behind the sink's own gates.
  if (finalTextLen > 0) return;
  const parts = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .collect();
  if (parts.some((d) => (d.part as { kind: string }).kind !== "provenance")) {
    return;
  }
  // PREEMPTION PROOF (codex P1, pass 15): the bridge flag means "gateway
  // chat:aborted, zero content, no user Stop through THIS bridge" — but an
  // operator-side stop (gateway CLI abort) has the exact same wire shape, and
  // auto-re-running an explicitly stopped turn would bypass the stop and can
  // replay side effects. Require the race's own signature: a child/task of
  // THIS chat that just went terminal (its queued delivery is what claims the
  // session and kills the turn) or is still running (delivery imminent).
  // Recency-bounded read; without the proof the honest aborted card stays.
  const recentChildren = await ctx.db
    .query("subAgents")
    .withIndex("by_chat", (q) => q.eq("chatId", message.chatId))
    .order("desc")
    .take(20);
  const now = Date.now();
  const deliveryImminent = recentChildren.some(
    (c) =>
      c.status === "running" || now - c.updatedAt <= PREEMPT_PROOF_WINDOW_MS,
  );
  if (!deliveryImminent) return;
  // The killed turn's outbox row = the newest sent-OR-pending row whose user
  // message is the turn immediately preceding this card (the exact pairing the
  // dispatch created). `pending` is INCLUDED (codex P1): a fast gateway kill
  // can be ingested before bridge.dispatch's markOutbox("sent") lands (the
  // 2026-07-09 incident had the error beat the sent-flip by 190ms) — the run
  // existed at the gateway, so the POST necessarily happened; only the flip is
  // late. Any mismatch means the world moved on — stand down.
  const rows = await Promise.all(
    (["sent", "pending"] as const).map((status) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", message.chatId).eq("status", status),
        )
        .order("desc")
        .first(),
    ),
  );
  const row = rows
    .filter((r) => r !== null)
    .sort((a, b) => b!._creationTime - a!._creationTime)[0];
  if (row === undefined || row === null || row.messageId === undefined) return;
  if (row.preemptRedispatched === true) {
    // Second kill of the same row: the chain is bounded at ONE automatic
    // re-dispatch — keep the honest aborted card and say so in the trace.
    await traceRepark(ctx, message.chatId, message._id, "exhausted");
    return;
  }
  // BOUNDED tail read (codex P2): this runs inside stream.finalize's
  // transaction — an unbounded by_chat collect on a long chat could blow the
  // mutation's read limits and fail the finalize itself. The guard only needs
  // the chat's LAST two turns; a 50-row recency window is the same bound
  // drainNextQueued uses for its order scan and always contains them.
  // STILL-QUEUED user messages are EXCLUDED (codex P1): a second follow-up
  // parked during the killed turn carries QUEUED_ORDER_SENTINEL, which sorts
  // AFTER the aborted card — it is not yet part of the established order, and
  // counting it would veto the recovery of the very turn it queued behind.
  const ordered = (
    await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", message.chatId))
      .order("desc")
      .take(50)
  )
    .filter((m) => m.orderTime !== QUEUED_ORDER_SENTINEL)
    .sort(compareOrder);
  const last = ordered[ordered.length - 1];
  const lastUser = ordered[ordered.length - 2];
  if (!last || last._id !== message._id) return;
  if (!lastUser || lastUser.role !== "user" || lastUser._id !== row.messageId) {
    return;
  }
  // Pure re-run established: drop the empty aborted card, stamp the row, and
  // HOLD it as `pending` until the delayed flip — pending is isChatBusy's own
  // blocker, so a user send inside the window parks `queued` behind it (FIFO
  // preserved) instead of racing the incoming delivery (codex P1). No dispatch
  // job targets the row, so the hold cannot double-fire.
  await deleteTurnCardCascade(ctx, lastUser.userId, message.chatId, message._id);
  await ctx.db.patch(row._id, {
    preemptRedispatched: true, // permanent bound stamp
    preemptHold: true, // transient hold marker (cleared by flip/stand-down)
    status: "pending",
  });
  await ctx.scheduler.runAfter(
    PREEMPT_REPARK_DELAY_MS,
    internal.preemptRepark.reparkAfterPreempt,
    { outboxId: row._id },
  );
  await traceRepark(ctx, message.chatId, message._id, "scheduled", {
    outboxId: row._id,
    delayMs: PREEMPT_REPARK_DELAY_MS,
  });
  console.log(
    `[preemptRepark] gateway-preempted turn re-parked (chat ${message.chatId}) — flip in ${PREEMPT_REPARK_DELAY_MS}ms`,
  );
}

/** The delayed flip. The world may have moved during the delay — every
 *  precondition is re-verified. A stand-down MUST release the `pending` hold
 *  (restore the inert `sent` + drain) or the chat would be blocked forever. */
export const reparkAfterPreempt = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    // Only OUR live hold may be acted on: `pending` + the transient hold
    // marker. Anything else (cascade-deleted, externally re-statused, a hold
    // already released) is not ours to touch. The late markOutbox("sent") ack
    // cannot have released it — bridge.markOutbox drops the sent-flip on a
    // held row (the dispatch it reports was consumed by the kill).
    if (row === null || row.status !== "pending") return;
    if (row.preemptRedispatched !== true || row.preemptHold !== true) return;
    if (row.messageId === undefined) return;
    const standDown = async (reason: string) => {
      // Release the hold: `sent` is the inert terminal the row came from; the
      // drain lets anything parked behind the hold move (FIFO).
      await ctx.db.patch(outboxId, { status: "sent", preemptHold: undefined });
      await traceRepark(ctx, row.chatId, row.messageId!, "stand_down", {
        reason,
      });
      await drainNextQueued(ctx, row.chatId);
    };
    // The user message must still exist — a deleted turn must not resurrect.
    const userMessage = await ctx.db.get(row.messageId);
    if (userMessage === null) {
      await standDown("user_message_deleted");
      return;
    }
    // A newer re-dispatch of the SAME message (manual regenerate / auto-retry
    // rebuilt an outbox row for it) already owns the re-run — standing down
    // prevents a duplicate turn. Excludes THIS row (it is `pending` itself).
    // Bounded: `queued` is capped (MAX_QUEUED_PER_CHAT), `pending` is ~1.
    for (const status of ["pending", "queued"] as const) {
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", row.chatId).eq("status", status),
        )
        .collect();
      if (rows.some((r) => r._id !== row._id && r.messageId === row.messageId)) {
        await standDown("superseded");
        return;
      }
    }
    // A replacement DISPATCHED during the hold is already `sent` (codex P2:
    // its dispatch job does not re-check the pending hold) — requeuing ours
    // would run the same user turn twice. `sent` rows span the chat's whole
    // history, so the scan is RECENCY-BOUNDED: a replacement is necessarily
    // newer than the held row, and desc order puts it in the first few rows.
    const recentSent = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", row.chatId).eq("status", "sent"),
      )
      .order("desc")
      .take(10);
    if (
      recentSent.some(
        (r) =>
          r._id !== row._id &&
          r.messageId === row.messageId &&
          r._creationTime > row._creationTime,
      )
    ) {
      await standDown("superseded");
      return;
    }
    await ctx.db.patch(outboxId, {
      status: "queued",
      preemptHold: undefined, // the re-dispatch's own ack must land normally
      // FRESH gateway idempotency key (codex P1): the bridge derives the
      // chat.send idempotencyKey from the dispatched key — the killed
      // dispatch already consumed the original, so a re-POST under it would
      // be deduplicated gateway-side into the aborted run (no new turn, no
      // reply). Minted as a SEPARATE alias: `clientMessageId` itself is the
      // browser-retry dedup key in send.sendMessage and must stay untouched
      // (codex P1, pass 10). Date.now() is deterministic in a mutation.
      dispatchKey: `preempt-${row.messageId}-${Date.now()}`,
    });
    await traceRepark(ctx, row.chatId, row.messageId, "requeued");
    // Busy (the delivery is streaming) → no-op; its finalize re-drains FIFO.
    // Idle → the paced dispatch (QUEUE_DRAIN_DELAY_MS + reparkIfBusy) takes it.
    await drainNextQueued(ctx, row.chatId);
  },
});
