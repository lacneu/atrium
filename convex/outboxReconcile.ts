/**
 * NO CHAT STAYS LOCKED — reconciliation of stalled `outbox` dispatches.
 *
 * A `pending` outbox row makes its chat BUSY (`lib/outboxQueue.isChatBusy`): the
 * composer parks new sends behind it and the sidebar shows the chat working. That
 * is correct while a dispatch is in flight, and it is the whole serialization
 * model (one turn per chat, because the bridge is one-turn-per-session).
 *
 * The problem this file fixes: nothing ever reconciled that state. Every OTHER
 * holder has a watchdog — a `streaming` message has `stuckStreams`, a `running`
 * sub-agent has its reaper, a `pending` rendition has its timeout — but a
 * `pending` outbox row had none. If the dispatch action dies before it can mark
 * the row (an uncaught error, an evicted schedule, a `preemptRepark` flip that
 * never fires), the row stays `pending` FOREVER and the conversation is locked
 * for good: every later send queues behind a dispatch that will never complete,
 * and the user has no way out. A permanent lock is the worst failure mode we can
 * hand someone — worse than an error they can act on.
 *
 * DESIGN — conservative by construction, because the cost of acting too early is
 * failing a LIVE turn:
 *
 *  - Age is measured from `pendingSince` (schema.outbox), stamped at every
 *    transition INTO `pending`. `_creationTime` is not usable: a mid-turn send can
 *    sit `queued` for hours, so its creation time would read as hours-stuck the
 *    instant it is dispatched.
 *  - A row with NO stamp (written before that field existed, or by a future path
 *    that forgets it) is not skipped — that would leave the lock — but it must
 *    clear a deliberately HUGE age instead, far beyond any dispatch that could
 *    still be running. A missed stamp then degrades to "reconciled later", never
 *    to a false failure.
 *  - The settle reuses the ordinary failure path (`bridge.failDispatch`), so the
 *    chat gets exactly what it gets on any failed dispatch: a terminal row, an
 *    honest error card, released feature locks, and the queue drained — the last
 *    of which is what actually unlocks the conversation.
 *
 * The user-facing message says what is TRUE: the dispatch never reported back, so
 * whether the agent received the turn is UNKNOWN. It must not promise that
 * nothing ran (the bridge can accept a send and lose its response on the way
 * back) — the same discipline as the named connection ends.
 */

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { drainNextQueued } from "./lib/outboxQueue";

/**
 * How long a STAMPED row may stay `pending` before it is considered stalled.
 *
 * Must exceed the longest legitimate dispatch. A `/send` POST is answered only
 * once the bridge has acquired its session, re-applied settings, re-hydrated
 * history and received the gateway's `chat.send` ack (30 s connect + 30 s request
 * timeouts, plus retries), and the POST itself is now capped
 * (`bridge.SEND_POST_TIMEOUT_MS`). Fifteen minutes leaves a wide margin over that
 * cap while staying well inside "the user has not given up yet".
 *
 * It must ALSO stay above `stuckStreams.STALE_STREAM_MS` (12 min), and that
 * ordering is load-bearing rather than incidental. The correlation below proves a
 * turn OPENED, not that the provider accepted the prompt: the Hermes WS transport
 * deliberately opens the streaming row BEFORE its `prompt.submit` ack (the chat
 * must read busy before `/send` returns). So a bridge that dies in that window
 * leaves a correlated row for a prompt the agent never saw. The stuck-stream
 * watchdog reaches that row FIRST and terminates it with a visible error, then
 * drains the queue — so the user gets an honest card and an unlocked chat, and this
 * reconciler's later `sent` is a harmless bookkeeping correction on an already
 * terminal turn. Lower this bound under the watchdog's and that stops being true.
 */
export const STALLED_PENDING_MS = 15 * 60_000;

/**
 * The same bound for a row with NO `pendingSince`. Deliberately far larger: with
 * no stamp we cannot distinguish a fresh dispatch from an old lock, so we wait
 * long enough that no dispatch could still be alive. One hour also exceeds the
 * `queued` waits that make `_creationTime` unusable as a proxy.
 */
export const STALLED_UNSTAMPED_MS = 60 * 60_000;

/** Rows examined per run — a bound, not a cap on eventual coverage: the oldest
 *  are read first (index order) and the cron runs every few minutes, so a large
 *  backlog drains over consecutive runs instead of in one long mutation. */
const SCAN_LIMIT = 100;

/** Curated, non-PHI cause. Uppercase like the other dispatch-domain codes. */
export const DISPATCH_STALLED_CODE = "DISPATCH_STALLED";

/**
 * Settle every `pending` outbox row whose dispatch provably went away.
 * Idempotent, bounded, and safe to run on an empty table (the normal case).
 */
export const reconcileStalledOutbox = internalMutation({
  args: {
    // Injected by tests; the cron passes nothing and uses the wall clock.
    now: v.optional(v.number()),
  },
  handler: async (ctx, { now: injectedNow }) => {
    const now = injectedNow ?? Date.now();
    // TWO RANGES, deliberately. Absent `pendingSince` sorts BEFORE every number, so
    // a crowd of unstamped rows younger than their own (longer) bound would refill
    // the bounded scan every run and starve the stamped rows behind them — the
    // guarantee would hold on paper and fail in a migration window (codex P2).
    // Reading the stamped range FIRST makes the promise independent of that crowd.
    const stamped = await ctx.db
      .query("outbox")
      .withIndex("by_status_pending_since", (q) =>
        q.eq("status", "pending").gte("pendingSince", 0),
      )
      // Ordered by the DISPATCH START: the oldest dispatches are examined first.
      .take(SCAN_LIMIT);
    // …then a bounded look at the unstamped tail, so legacy rows are still covered
    // (each pass settles the ones past their bound, draining the range over time).
    const unstamped = await ctx.db
      .query("outbox")
      .withIndex("by_status_pending_since", (q) =>
        q.eq("status", "pending").lt("pendingSince", 0),
      )
      .take(SCAN_LIMIT);
    const rows = [...stamped, ...unstamped];
    let settled = 0;
    for (const row of rows) {
      const stampedAt = row.pendingSince;
      const age = now - (stampedAt ?? row._creationTime);
      // DEPLOYMENT ORDERING GUARD. Convex and the bridge ship separately, so Convex
      // can run this reconciler while an OLDER bridge still serves — one that takes
      // `outboxId` for traces but never echoes it into `startAssistant`. Every turn it
      // opens is UNCORRELATED, so the lookup below would find nothing and a real,
      // answered turn would be settled as a failure.
      //
      // Proof is one indexed read, scoped to the INSTANCE this row is dispatched to.
      // Not global and not per-chat (codex P1 ×2): the per-turn router can send
      // consecutive turns of one chat to different instances, so only the instance
      // that will actually serve THIS row can vouch for it. Unknown instance, or no
      // correlation from it yet ⇒ the destructive decision waits for the far longer
      // bound: the lock is still broken, just later, and by then the stuck-stream
      // watchdog has already given the user a card.
      const chat = await ctx.db.get(row.chatId);
      const servingInstance =
        row.routedAgent?.instanceName ?? chat?.instanceName ?? null;
      const instanceEverCorrelated =
        servingInstance !== null &&
        (await ctx.db
          .query("messages")
          .withIndex("by_bound_instance_dispatch", (q) =>
            q.eq("boundInstance", servingInstance).gt("dispatchOutboxId", ""),
          )
          .first()) !== null;
      const limit =
        stampedAt === undefined || !instanceEverCorrelated
          ? STALLED_UNSTAMPED_MS
          : STALLED_PENDING_MS;
      if (age < limit) continue;
      // DID THIS DISPATCH EVER RUN? Now a FACT, not a guess: the assistant row a
      // turn opens carries the outbox id it was dispatched from
      // (`stream.startAssistant`, fed from the `/send` body on both providers). A
      // point lookup answers it exactly.
      //
      // The correlation is what makes this safe. "Something is streaming in this
      // chat" would NOT do: a gateway-initiated delivery (announce, background
      // task) or a spontaneous `talk-…` turn is indistinguishable from this row's
      // own reply, so accepting one as proof would mark the row `sent` while the
      // user's message never ran — no reply, no card, never reconciled again.
      const producedTurn = await ctx.db
        .query("messages")
        .withIndex("by_dispatch_outbox", (q) =>
          q.eq("dispatchOutboxId", row._id as string),
        )
        .first();
      if (producedTurn !== null) {
        // The dispatch DID run; only its `markOutbox` was lost (a dead action, a
        // POST whose response never came back). The row's true state is `sent`, and
        // an error card here would sit beside a real reply. The turn itself is owned
        // by its own watchdogs (stuckStreams if still streaming).
        await ctx.db.patch(row._id, { status: "sent", preemptHold: undefined });
        // …and DRAIN, exactly as `markOutbox` does on `sent` (codex P1). This is the
        // race order that markOutbox documents, arriving very late: the turn already
        // finalized, and its own drain no-opped because THIS row was still `pending`.
        // Nothing else will retry, so a follow-up the user queued during the turn
        // would sit there forever — the very lock this file exists to prevent, just
        // one row further down. Idempotent and isChatBusy-guarded: a no-op while the
        // correlated turn is still streaming.
        await drainNextQueued(ctx, row.chatId);
        // …and CONFIRM the routing this dispatch used, which the normal ack path does
        // right after the gateway accepts (codex P1). Skipping it leaves the chat's
        // routing tuple at the PREVIOUS agent, so a later return to that agent reads
        // as same-agent and reuses its session WITHOUT rehydrating the reply this
        // turn produced — the conversation silently loses a branch of its context.
        // Only possible because the segment was remembered on the row at dispatch
        // (`beginTurnRouting`); it is a no-op when the tuple is already current.
        // ACCEPTANCE, not mere existence. The Hermes WS transport opens its
        // streaming row BEFORE staging and `prompt.submit`, so a correlated row can
        // belong to a prompt the provider never took (the stuck-stream watchdog
        // later marks it error). Confirming from that would persist a FAILED switch
        // as the chat's confirmed route, and a later return to the previous agent
        // would reuse its session instead of rehydrating (codex P2). Frames prove
        // acceptance: a completed turn, or any text written. The asymmetry is
        // deliberate — NOT confirming leaves the tuple at the prior confirmed agent,
        // which is exactly what the design does for a failed switch.
        const acceptanceProven =
          producedTurn.status === "complete" ||
          (producedTurn.text ?? "").length > 0;
        if (row.routedAgent && row.dispatchSegment !== undefined && acceptanceProven) {
          await ctx.runMutation(internal.bridge.confirmTurnRouting, {
            chatId: row.chatId,
            routedAgent: row.routedAgent,
            segment: row.dispatchSegment,
          });
        }
        console.error(
          `[outbox] stalled row DID produce a turn — marked sent, not failed (ageMs=${age})`,
        );
        continue;
      }
      // A PREEMPT HOLD is a pending window owned by a scheduled flip
      // (`preemptRepark.reparkAfterPreempt`, 10 s later). Past this age that job
      // is provably gone — and `failDispatch` deliberately refuses to touch a
      // held row, so the marker has to be cleared here or the lock survives the
      // very reconciler meant to remove it.
      if (row.preemptHold === true) {
        await ctx.db.patch(row._id, { preemptHold: undefined });
        console.error(
          `[outbox] stalled preempt hold — its re-dispatch never fired (ageMs=${age})`,
        );
      }
      // Reuse the ORDINARY failure path: same terminal row, same error card, same
      // feature-lock releases, same queue drain. The drain is what unlocks the
      // conversation, and duplicating it here would be a second, divergent copy of
      // the turn-end contract.
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId: row._id,
        reason: "send_failed",
        errorCode: DISPATCH_STALLED_CODE,
      });
      settled += 1;
      console.error(
        `[outbox] settled a stalled dispatch (ageMs=${age}, stamped=${stampedAt !== undefined})`,
      );
    }
    if (settled > 0) {
      console.error(
        `[outbox] reconciliation settled ${settled} stalled dispatch(es) of ${rows.length} pending row(s)`,
      );
    }
    return { scanned: rows.length, settled };
  },
});
