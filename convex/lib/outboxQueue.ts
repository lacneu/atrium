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
 * How long a `running` sub-agent row may sit untouched before the REAPER
 * terminalizes it (subAgents.reapStaleSubAgents).
 *
 * The `subAgents` rows are BEST-EFFORT observer writes: the bridge observer
 * (bridge/src/providers/openclaw/sub-agent-observer.ts) writes the row on EVERY
 * child frame and terminalizes a true stall via its in-memory TTL watchdog
 * (DEFAULT_TTL_SECONDS = 15 min). But a dropped terminal upsert, a BRIDGE RESTART,
 * or a connection close (the watchdog dies with the process) can leave a row stuck
 * at "running" forever. Since a running row gates isChatBusy (and drainNextQueued
 * consults it), a forever-"running" row would queue EVERY future send for that chat
 * until the queue fills — a PERMANENT LOCK.
 *
 * We do NOT solve this passively (a freshness predicate in isChatBusy would stop
 * BLOCKING at the cutoff but never DRAIN the already-queued send → the held message
 * strands forever AND a later send could dispatch ahead of it = reorder). Instead an
 * ACTIVE reaper writes the stale row TERMINAL, which routes through the SAME drain a
 * real child-terminal takes (maybeDrainOnTerminal) — so the held queue dispatches
 * FIFO — and surfaces the dead child in the monitor as `error` (the user SEES it).
 *
 * The TTL is ≥ the observer watchdog TTL (15 min) PLUS a margin, so a legitimately
 * slow-but-LIVE sub-agent (infrequent frames, but the observer WOULD terminalize a
 * true stall at its TTL) is never reaped prematurely. Deliberately NOT imported from
 * the bridge (separate package) — this comment documents the coupling. Worst-case
 * hold for a dead-observer child = this TTL + the reaper cron interval.
 */
export const SUBAGENT_STALE_TTL_MS = 20 * 60 * 1000; // 20 min = 15-min observer TTL + margin

/**
 * Is the chat OCCUPIED — must a new send be queued instead of dispatched now?
 * True when any of three blockers holds:
 *  - an outbox row is `pending` (dispatch scheduled / HTTP in flight, before the
 *    bridge has acked), OR
 *  - an assistant message is `streaming` (the bridge acked and the turn is
 *    producing tokens — the window between markOutbox("sent") and finalize), OR
 *  - the chat has a LIVE sub-agent (a `subAgents` row with status "running").
 * The first two cover the whole dispatch→reply lifecycle with no gap.
 *
 * A `running` row is a best-effort observer write; a DEAD observer could leave one
 * stuck forever. We do NOT weaken THIS gate to guard against that (a passive time
 * check here would stop blocking but strand the already-queued send + allow a
 * reorder). The reaper (subAgents.reapStaleSubAgents, SUBAGENT_STALE_TTL_MS) instead
 * terminalizes a stale row out-of-band, which drains the held queue FIFO. So here a
 * running row ALWAYS holds — the reaper, not isChatBusy, bounds the dead-observer case.
 *
 * The third blocker is the sub-agent hold (A/B fix): when the chat's agent spawns
 * a sub-agent and YIELDS, OpenClaw mis-routes the user's NEXT message into the
 * still-running child — Atrium always dispatches on the parent session key and
 * cannot target the child, so the only safe lever is to NOT dispatch into a chat
 * with a live child. Treating "has a running sub-agent" as busy parks the send as
 * `queued`; the terminal-transition drain in subAgents.upsertSubAgent dispatches
 * it the moment the last sub-agent finishes/fails/aborts (or its TTL watchdog
 * writes a terminal status). This check ALSO guards `drainNextQueued` below, so a
 * parent turn that finalizes WHILE the child still runs does not drain the held
 * message — the drain only fires once every sub-agent is terminal.
 *
 * A chat that never spawns a sub-agent has no rows in the (chat) range here, so
 * this read is empty and behavior is byte-identical to the turn-only check. The
 * filter mirrors listSubAgents' existing `by_chat` collect (sub-agent cardinality
 * per chat is small); a `by_chat_status` index is deliberately NOT added.
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
  if (streaming !== null) return true;
  // A `running` sub-agent row holds the chat. Read ONLY the (chat, "running") slice
  // via the by_chat_status index — bounded regardless of how many TERMINATED sub-agents
  // the chat has accumulated (a by_chat scan + JS status filter would read the whole
  // per-chat history on the hot send/drain path). A dead-observer row that never goes
  // terminal is bounded by the reaper (subAgents.reapStaleSubAgents), NOT here.
  const liveSubAgent = await ctx.db
    .query("subAgents")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "running"),
    )
    .first();
  return liveSubAgent !== null;
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

