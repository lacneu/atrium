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
import {
  blockingCallForTurn,
  scheduleCallWindowDrain,
} from "./talkFreeze";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { effectiveOrder, QUEUED_ORDER_SENTINEL } from "./messageOrder";
import { yieldHandedOff } from "./toolOutcome";
import { isTrashed } from "./trash";

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
// READ-ONLY (QueryCtx): callable from queries too — bridge.chatBusyProbe
// re-validates idleness at dispatchReset execution time (mutations pass
// unchanged, MutationCtx is assignable to QueryCtx).
export async function isChatBusy(
  ctx: QueryCtx,
  chatId: Id<"chats">,
): Promise<boolean> {
  const pending = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "pending"),
    )
    .first();
  if (pending !== null) return true;
  return await chatHasActivityBlockers(ctx, chatId);
}

/**
 * The NON-outbox busy blockers: a streaming assistant message OR a live
 * sub-agent. Shared by `isChatBusy` and the paced-dispatch re-check
 * (bridge.reparkIfBusy) — the latter's OWN outbox row is `pending`, so it
 * must check exactly these two without the pending clause.
 */
export async function chatHasActivityBlockers(
  ctx: QueryCtx,
  chatId: Id<"chats">,
): Promise<boolean> {
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
  // BACKGROUND TASKS (kind:"task") do NOT hold: the parent turn is settled,
  // the session is free, and a delivery racing a new turn is stashed by the
  // bridge — blocking sends for a 2-minute image generation would be wrong.
  // Only real sub-agent sessions (one-turn-per-session constraint) hold.
  // Two POINT lookups on (chat, status, kind): real sub-agent rows are
  // kind:"subagent" or legacy kind:undefined — background tasks (kind:"task")
  // never hold, and long-running tasks must not degrade this hot send/drain
  // path into a slice scan.
  const legacyRunning = await ctx.db
    .query("subAgents")
    .withIndex("by_chat_status_kind", (q) =>
      q.eq("chatId", chatId).eq("status", "running").eq("kind", undefined),
    )
    .first();
  if (legacyRunning !== null) return true;
  const subagentRunning = await ctx.db
    .query("subAgents")
    .withIndex("by_chat_status_kind", (q) =>
      q.eq("chatId", chatId).eq("status", "running").eq("kind", "subagent"),
    )
    .first();
  return subagentRunning !== null;
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
/** Delay between a turn's finalize and the queued follow-up's dispatch —
 *  long enough for the embedded gateway to release its session prompt lock. */
export const QUEUE_DRAIN_DELAY_MS = 2_500;

export async function drainNextQueued(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<void> {
  if (await isChatBusy(ctx, chatId)) return;
  // A conversation in the TRASH dispatches nothing: its queued turns are HELD, not
  // dropped — they stay `queued`, and a restore drains them (chats.restoreFromTrash).
  const trashed = await ctx.db.get(chatId);
  if (trashed !== null && isTrashed(trashed)) return;
  const next = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "queued"),
    )
    // index order = _creationTime ascending within the (chat, "queued") range → FIFO.
    .first();
  if (next === null) return;
  // NOT WHILE SOMEONE IS SPEAKING. This row was ACCEPTED before the call started —
  // the send-time check cannot see a call that did not exist yet — so the rule is
  // re-applied at the moment the turn would actually dispatch. It is HELD, not
  // dropped: the message stays queued and drains when the call ends (or when the
  // freeze window expires), which is what the reader expects from a message they
  // already sent. Without this, a queued turn for another agent promoted mid-call
  // re-keyed the socket and cut the call (codex P1).
  const chat = await ctx.db.get(chatId);
  if (chat !== null) {
    const chosen =
      next.routedAgent === undefined
        ? null
        : {
            instanceName: next.routedAgent.instanceName,
            agentId: next.routedAgent.agentId,
          };
    const blocking = await blockingCallForTurn(ctx, chat, chosen);
    // Held, not dropped. The release comes from `markTalkSessionEnded` — the hangup's
    // own, or the one armed at the mint — and that mutation drains the queue. The
    // arming here covers the call that was already live when this shipped, which has
    // no marker of its own.
    if (blocking !== null) {
      await scheduleCallWindowDrain(ctx, blocking);
      return;
    }
  }
  // A CHAINED reply waits for the replies before it to be ANSWERS: a step whose agent
  // yielded to a sub-agent concludes in its continuation, after the child ends.
  const heldUntil = await chainStepHeldUntil(ctx, next);
  if (heldUntil !== null) {
    await ctx.scheduler.runAfter(
      Math.max(heldUntil - Date.now(), 0),
      internal.bridge.drainAfterCallRefusal,
      { chatId },
    );
    return;
  }
  // The dispatch window opens NOW — stamped so the reconciler measures the time
  // this row has actually been in flight, not how long it waited in the queue.
  // A FRESH dispatch window: a row re-queued after an earlier attempt (a call that
  // refused it, a re-park) has not left for anyone in this one — the last gate
  // stamps `sentToInstance` again when it does.
  await ctx.db.patch(next._id, {
    status: "pending",
    pendingSince: Date.now(),
    sentToInstance: undefined,
  });
  // Stamp the now-dispatched follow-up's LOGICAL order time (see lib/messageOrder).
  // `next.messageId` is the optimistic user message from send.ts (currently SENTINEL).
  // Use a value STRICTLY GREATER than every already-DISPATCHED message's effectiveOrder
  // — not raw Date.now(): if the drain lands in the SAME millisecond the prior turn's
  // assistant was created (an instant turn), Date.now() would TIE that assistant and
  // compareOrder would fall back to this message's early pre-ack _creationTime, sorting
  // it BEFORE the assistant. The bump stays well below SENTINEL, so it still sorts
  // before any OTHER still-queued follow-up. (Still-queued SENTINEL rows are excluded
  // from the max — the promoted turn dispatches now, ahead of them.)
  // A CHAINED reply shares its head's user message, which was placed when the head
  // dispatched: re-stamping it now would move the question below the answers it
  // already received.
  if (next.messageId && next.chainStep === undefined) {
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
  // PACED dispatch (not immediate): Convex finalizes on the reply's final
  // frame, but the embedded gateway runtime holds its per-session prompt lock
  // slightly longer (until its lifecycle end/cleanup). Dispatching the queued
  // follow-up in that window trips "session file changed while embedded
  // prompt lock was released" — the run crashes (observed live, 2026-07-19).
  // A short fixed delay lets the lock settle; the bounded auto-retry remains
  // the net for the residual race.
  await ctx.scheduler.runAfter(QUEUE_DRAIN_DELAY_MS, internal.bridge.dispatch, {
    outboxId: next._id,
  });
}

/** How many messages after a question are read for the replies its chain gave. */
export const CHAIN_REPLY_READ = 200;

/**
 * The replies the EARLIER steps of `row`'s chain gave — found from the REPLIES, never
 * from the question's rows. Every regenerate adds rows to the question and keeps the
 * old ones, so its oldest rows are no window onto the current chain: after a few
 * regenerations the current generation's first step is not among them at all. A reply
 * names the row it was dispatched from (`dispatchOutboxId`); the replies after the
 * question are read once (bounded, indexed), and each is kept when its row belongs to
 * the same question at an earlier step. The replies of earlier generations for those
 * steps were deleted with them (messages.deleteMessage truncates), so what is found is
 * the chain as the reader sees it. Any status: callers filter.
 */
export async function earlierChainReplies(
  ctx: QueryCtx,
  row: Doc<"outbox">,
): Promise<Array<{ reply: Doc<"messages">; row: Doc<"outbox"> }>> {
  if (row.chainStep === undefined || row.messageId === undefined) return [];
  const question = await ctx.db.get(row.messageId);
  if (question === null) return [];
  // `gte`: `_creationTime` is not unique, and a reply tied with its question counts.
  const after = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) =>
      q.eq("chatId", row.chatId).gte("_creationTime", question._creationTime),
    )
    .take(CHAIN_REPLY_READ);
  const rows = new Map<string, Doc<"outbox"> | null>();
  const out: Array<{ reply: Doc<"messages">; row: Doc<"outbox"> }> = [];
  for (const m of after) {
    if (m.role !== "assistant" || m.dispatchOutboxId === undefined) continue;
    let source = rows.get(m.dispatchOutboxId);
    if (source === undefined) {
      const id = ctx.db.normalizeId("outbox", m.dispatchOutboxId);
      source = id === null ? null : await ctx.db.get(id);
      rows.set(m.dispatchOutboxId, source);
    }
    if (
      source === null ||
      source._id === row._id ||
      source.messageId !== row.messageId ||
      (source.chainStep ?? 0) >= row.chainStep
    ) {
      continue;
    }
    out.push({ reply: m, row: source });
  }
  return out;
}

/**
 * How long a chained reply waits, once every sub-agent of the step before it has
 * ended, for that step's CONCLUSION when its agent yielded (OpenClaw `sessions_yield`:
 * the requester-settle continuation merges into the step's bubble after the child's
 * result — stream.settleContinuationAnchor). The continuation normally follows within
 * seconds; one that never comes (a failed wake, a merge that fell back to its own
 * bubble) must not hold the conversation, so past this the next agent is asked with
 * what the step did write.
 */
export const CHAIN_SETTLE_WAIT_MS = 2 * 60_000;

/**
 * Until when the chained row `next` must wait, or null to dispatch it now.
 *
 * A reply before it in the chain that HANDED OFF (a completed `sessions_yield`, read
 * like the delivery verdict reads it — lib/toolOutcome) more times than it has
 * received a continuation (`messages.continuations`, one entry per settled yielded
 * batch) has not concluded. It is waited for — bounded by CHAIN_SETTLE_WAIT_MS after
 * its last sub-agent ended (or the reply settled, when none is recorded). The
 * continuation's own finalize drains again, so the wait ends as soon as it lands.
 */
async function chainStepHeldUntil(
  ctx: MutationCtx,
  next: Doc<"outbox">,
): Promise<number | null> {
  if (next.chainStep === undefined || next.messageId === undefined) return null;
  let heldUntil: number | null = null;
  for (const { reply } of await earlierChainReplies(ctx, next)) {
    if (reply.status === "streaming") continue;
    const parts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", reply._id))
      .take(MAX_REPLY_PARTS);
    const handOffs = parts.filter(
      (p) =>
        p.part.kind === "tool" &&
        p.part.name === "sessions_yield" &&
        yieldHandedOff(p.part.phase, p.part.output),
    ).length;
    if (handOffs <= (reply.continuations?.length ?? 0)) continue;
    const children = await ctx.db
      .query("subAgents")
      .withIndex("by_parent_message", (q) => q.eq("parentMessageId", reply._id))
      .take(MAX_REPLY_PARTS);
    const lastEnded = children.reduce(
      (at, c) => Math.max(at, c.updatedAt ?? 0),
      reply.finalizedAt ?? reply.updatedAt,
    );
    const until = lastEnded + CHAIN_SETTLE_WAIT_MS;
    if (until > Date.now() && (heldUntil === null || until > heldUntil)) heldUntil = until;
  }
  return heldUntil;
}

/** Bound on the parts and sub-agents read per reply by the chain hold. */
const MAX_REPLY_PARTS = 256;
