// Mutations called BY THE BRIDGE to stream normalized OpenClaw events into the
// reactive DB. These map 1:1 onto the normalizer's stable bridge events
// (see backend/app/normalizer.py and docs/BRIDGE_PROTOCOL.md):
//
//   run.status (begin)  -> startAssistant  (creates the streaming message)
//   message.delta       -> appendDelta     (append text)
//   message.snapshot    -> setSnapshot     (replace text)
//   tool.status / media -> addPart         (structured parts)
//   message.final       -> finalize        (complete | error | aborted)
//
// SECURITY: these are `internalMutation`s — NOT callable from the browser.
// The bridge authenticates to Convex with a deploy/service key (bridge env
// only) and invokes them via `internal.stream.*`. They therefore carry no
// user identity; access scoping for these writes is structural (the bridge is
// trusted and only writes to the chat it was told to). Public read access is
// still gated per-user in messages.ts, so a user can never read another user's
// streamed message.

import { v } from "convex/values";
import { contentLocaleForInstance } from "./lib/serverLocale";
import { KNOWN_ERROR_CODES } from "./lib/chatRenderState";
import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { MESSAGE_WINDOW } from "./messages";
import {
  deliveryChildKey,
  taskDeliveryIdentity,
  taskDeliveryOutcome,
} from "./lib/deliveryRuns";
import { Doc, Id } from "./_generated/dataModel";
import { messagePart } from "./schema";
import { writeTraceEvent } from "./observability";
import { isFilePart, recordFileForPart } from "./lib/files";
import { drainNextQueued } from "./lib/outboxQueue";
import { maybeScheduleTurnRetry } from "./turnRetry";
import { maybeReparkPreemptedTurn } from "./preemptRepark";
import { chatAllowsInstance } from "./lib/ingestAuthz";

// ── ATOMIC ingest authorization (cross-gateway barrier) ──────────────────────
// Runs INSIDE the write transaction (no authorize→write TOCTOU): when the
// ingest passes the caller's proven instance (per-bridge auth), the write's
// target chat must allow it — else throw; the ingest httpAction maps the
// throw to 403. `bound === undefined` = a trusted INTERNAL caller (watchdog,
// dispatch failure path, tests) — no enforcement.
const CROSS_INSTANCE = "forbidden: cross-instance stream target";

async function assertChatBound(
  ctx: MutationCtx | Parameters<typeof chatAllowsInstance>[0],
  chatId: Id<"chats">,
  bound: string | undefined,
): Promise<void> {
  if (bound === undefined) return;
  if (!(await chatAllowsInstance(ctx, chatId, bound))) {
    throw new Error(CROSS_INSTANCE);
  }
}

/** Hot-path variant: authorize against the streamingText row ALREADY READ.
 *  The `boundInstance` stamp (validated atomically at startAssistant) is the
 *  zero-extra-reads compare; a legacy row without the stamp falls back to the
 *  chat check. */
async function assertRowBound(
  ctx: MutationCtx,
  row: { boundInstance?: string; chatId: Id<"chats"> },
  bound: string | undefined,
): Promise<void> {
  if (bound === undefined) return;
  if (row.boundInstance !== undefined) {
    if (row.boundInstance !== bound) throw new Error(CROSS_INSTANCE);
    return;
  }
  await assertChatBound(ctx, row.chatId, bound);
}

/** Message-scoped variant: the DURABLE owner stamp on the message doc wins
 *  (survives finalize — the live row is deleted then); an unstamped legacy
 *  message falls back to the chat check. */
async function assertMessageBound(
  ctx: MutationCtx,
  message: { boundInstance?: string; chatId: Id<"chats"> },
  bound: string | undefined,
): Promise<void> {
  if (bound === undefined) return;
  if (message.boundInstance !== undefined) {
    if (message.boundInstance !== bound) throw new Error(CROSS_INSTANCE);
    return;
  }
  await assertChatBound(ctx, message.chatId, bound);
}

/** The optional proven-instance arg every ingest-reachable mutation takes. */
const boundArg = { boundInstanceName: v.optional(v.string()) };
import { requireActive, requireOwnedChat } from "./lib/access";
import { activeRecording, recordDelta } from "./deliveryTiming";
import { correlateDocumentaryFetch } from "./documentAttachments";
import { correlateCuration } from "./agentFileCuration";
import { correlateConversion } from "./fileRenditions";
import {
  correlateSummarize,
  enrichedTurnText,
  loadChildResults,
} from "./chatSummaries";
import { compareOrder, effectiveOrder } from "./lib/messageOrder";
import {
  composeRehydration,
  rehydrationBudgetChars,
} from "./lib/rehydration";
import { composeQuotedText, quotePreamble } from "./lib/quoteReply";
import { providerSessionClearPatch } from "./lib/providerSession";

// Optional delivery-recorder fields the bridge attaches to a stream write while a
// turn is being recorded (see convex/deliveryTiming.ts). `recSessionId` is the
// session the turn was started under — Convex records only when it still matches the
// ACTIVE session (so a late delta from an old turn can't be mis-filed into a newer
// session). `bridgeRecvAt` (t0, when the bridge received this flush's first delta) +
// `bridgeSentAt` (t1) bound the single-clock bridge-internal segment; `bridgeSentAt`
// + `bridgeSkew` feed segment A; `sizeBytes` is the flush size (UTF-8). All absent
// (and ignored) when not recording.
const recArgs = {
  recSessionId: v.optional(v.string()),
  bridgeRecvAt: v.optional(v.number()),
  bridgeSentAt: v.optional(v.number()),
  bridgeSkew: v.optional(v.number()),
  sizeBytes: v.optional(v.number()),
};

/**
 * Build the stable per-turn correlationId for an assistant message. Prefers
 * `chatId:runId` (the whole conversational turn); falls back to chatId, then to
 * the messageId, so a trace is always correlatable even mid-run.
 *
 * TODO(M8): the user half (send.ts traceSend) keys on `${chatId}:${outboxId}`,
 * which is never associated with this `${chatId}:${runId}`. Linking the two
 * halves end-to-end needs the bridge to carry a single correlationId across the
 * turn (write the runId back onto the outbox row, or echo a shared id through
 * startAssistant). Bridge wiring — deferred.
 */
function streamCorrelationId(
  chatId: Id<"chats">,
  runId: string | undefined,
  messageId: Id<"messages">,
): string {
  if (runId) return `${chatId}:${runId}`;
  if (chatId) return `${chatId}`;
  return `${messageId}`;
}

/**
 * Emit an `assistant.stream` trace (D2 metadata only — never message text).
 * Wrapped so a trace failure can NEVER abort the bridge's streaming mutation.
 */
async function traceStream(
  ctx: MutationCtx,
  args: {
    phase: "start" | "finalize" | "snapshot_regression";
    chatId: Id<"chats">;
    runId: string | undefined;
    messageId: Id<"messages">;
    streamStatus: "streaming" | "complete" | "error" | "aborted";
    textLen?: number;
    /** Snapshot regression only: the LENGTHS of the kept and refused texts.
     *  Lengths only — the texts themselves are conversational content (SOC2). */
    oldLen?: number;
    newLen?: number;
    /** The CURATED failure class (`errorCode`) — a stable non-PHI code, never the
     *  gateway's text. Without it the anomaly detector could only count errors:
     *  a context overflow and two unrelated blips looked identical, so the signal
     *  named a number instead of a cause (C-01). */
    errorCode?: string;
  },
): Promise<void> {
  try {
    await writeTraceEvent(ctx, {
      kind: "assistant.stream",
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      chatId: args.chatId,
      runId: args.runId,
      correlationId: streamCorrelationId(args.chatId, args.runId, args.messageId),
      meta: JSON.stringify({
        phase: args.phase,
        messageId: args.messageId,
        // String lifecycle status lives in meta (the `status` column is numeric).
        streamStatus: args.streamStatus,
        ...(args.textLen !== undefined ? { textLen: args.textLen } : {}),
        ...(args.oldLen !== undefined ? { oldLen: args.oldLen } : {}),
        ...(args.newLen !== undefined ? { newLen: args.newLen } : {}),
        ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      }),
    });
  } catch {
    // Best-effort: never break the primary stream write on a trace error.
  }
}

// Create the streaming assistant message for a run. Returns the message id the
// bridge then threads through the rest of the stream calls.
//
// We derive the owning user from the chat so the new message carries the same
// `userId` (needed for the per-user read scoping in messages.ts).
export const startAssistant = internalMutation({
  args: {
    chatId: v.id("chats"),
    runId: v.optional(v.string()),
    // The gateway session key the turn runs under (additive; old bridges omit it).
    // The DETERMINISTIC reply-to-send join: the hybrid-rehydration correlate
    // matches the summarize job's openclawChatId nonce inside it instead of
    // racing on message creation times.
    turnSessionKey: v.optional(v.string()),
    // The outbox row this turn was dispatched from (see schema note): the
    // correlation outboxReconcile needs to tell "this send never ran" from
    // "its ack was lost". Absent on gateway-initiated turns.
    dispatchOutboxId: v.optional(v.string()),
    ...boundArg,
  },
  handler: async (
    ctx,
    { chatId, runId, turnSessionKey, dispatchOutboxId, boundInstanceName },
  ) => {
    // REFUSE a turn whose dispatch was already SETTLED. Aborting the Convex-side POST
    // does not cancel the bridge's `/send` handler: a handler blocked past the
    // reconciliation window (an unbounded internal fetch, a paused process) could
    // reach this point long after `outboxReconcile` failed the row, told the user so,
    // and drained the next queued send — starting the old turn then would overlap two
    // turns on one session and produce a reply under an error card (codex P1). The
    // row's terminal state is the authority, and this is the last place to read it.
    // Throwing is a supported path: the bridge disarms its replay buffer and reports
    // the failed turn (server.ts "beginTurn threw AFTER the ack").
    if (dispatchOutboxId !== undefined) {
      const rowId = ctx.db.normalizeId("outbox", dispatchOutboxId);
      if (rowId !== null) {
        const row = await ctx.db.get(rowId);
        if (row !== null && row.status === "failed") {
          throw new Error(
            "dispatch already reconciled — refusing to open a turn for a settled send",
          );
        }
      }
    }
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      throw new Error("startAssistant: chat not found");
    }
    // ATOMIC cross-gateway barrier: the STARTING instance must be allowed to
    // write this chat — checked in THIS transaction, before any write, and
    // stamped onto the live row below so every subsequent hot-path write
    // compares at zero extra reads.
    await assertChatBound(ctx, chatId, boundInstanceName);
    const now = Date.now();
    // SUB-AGENT ANNOUNCE MERGE: a gateway announce-run delivers the result of
    // a sub-agent whose PARENT turn already finished — as a separate run. The
    // user asked ONE question; the answer must land in ONE bubble. When the
    // announce correlates to a finished parent message that is still the
    // chat's last message, REOPEN it and stream the announce into it instead
    // of creating a second assistant message.
    if (runId !== undefined && deliveryChildKey(runId) !== null) {
      // A task-delivery run arriving means the background task IS finished:
      // settle its engagement row (turns the thread indicator off) whatever
      // the merge decision below. The silent (NO_REPLY) path settles from the
      // bridge sink instead — this covers the visible path.
      const outcome = taskDeliveryOutcome(runId);
      if (outcome !== null) {
        const engagement = await ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) =>
            q.eq("childSessionKey", deliveryChildKey(runId) as string),
          )
          .filter((q) => q.eq(q.field("chatId"), chatId))
          .first();
        if (engagement !== null && engagement.status === "running") {
          await ctx.db.patch(engagement._id, {
            status: outcome === "ok" ? ("done" as const) : ("error" as const),
            updatedAt: now,
          });
        }
      } else if (runId.startsWith("announce:")) {
        // SUB-AGENT family: the announce itself proves the child FINISHED.
        // Normally the observer settles the row off the child's terminal
        // frame — but a child killed by the gateway (run timeout) can die
        // without one, and its stuck `running` row keeps the activity
        // spinner and the composer's stop affordance armed forever (live
        // report 2026-07-14). The announce is the authoritative settle;
        // `done` here means "no longer running" — the announce text carries
        // the real outcome (the observer's error path, when it DID see a
        // terminal, already recorded it and this patch never runs).
        const row = await ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) =>
            q.eq("childSessionKey", deliveryChildKey(runId) as string),
          )
          .filter((q) => q.eq(q.field("chatId"), chatId))
          .first();
        if (row !== null && row.status === "running") {
          await ctx.db.patch(row._id, {
            status: "done" as const,
            updatedAt: now,
          });
        }
      }
      const merge = await reopenParentForAnnounce(
        ctx,
        chatId,
        runId,
        now,
        boundInstanceName,
      );
      if (merge !== null) {
        if (merge.reopened) {
          await ctx.db.patch(chatId, { updatedAt: now });
          await traceStream(ctx, {
            phase: "start",
            chatId,
            runId,
            messageId: merge.messageId,
            streamStatus: "streaming",
          });
        }
        // Terminal rebroadcast: hand the settled message back SILENTLY — no
        // sidebar reorder (chat.updatedAt), no bogus streaming trace.
        return merge.messageId;
      }
    }
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: chat.userId,
      ...(turnSessionKey !== undefined ? { turnSessionKey } : {}),
      ...(dispatchOutboxId !== undefined ? { dispatchOutboxId } : {}),
      role: "assistant",
      runId,
      status: "streaming",
      // Durable owner stamp (message-scoped writes compare against it, and it
      // SURVIVES finalize — see the schema note).
      ...(boundInstanceName !== undefined
        ? { boundInstance: boundInstanceName }
        : {}),
      text: "",
      updatedAt: now,
    });
    // Create the live-text row WITH the message (one atomic mutation), so the
    // INVARIANT "streaming message <=> streamingText row exists" holds from t0 —
    // the watchdog (which ranges streamingText by heartbeat) can see a turn that
    // gets stuck BEFORE its first delta, and per-delta writes only touch this row,
    // never the messages doc (so loadChatView stops re-running per delta).
    await ctx.db.insert("streamingText", {
      messageId,
      chatId,
      userId: chat.userId,
      generation: runId ?? null,
      // The proven starting instance (see the barrier above): the hot-path
      // writes' zero-read authorization compare. Absent for internal callers.
      ...(boundInstanceName !== undefined
        ? { boundInstance: boundInstanceName }
        : {}),
      text: "",
      updatedAt: now,
    });
    await ctx.db.patch(chatId, { updatedAt: now });
    await traceStream(ctx, {
      phase: "start",
      chatId,
      runId,
      messageId,
      streamStatus: "streaming",
    });
    return messageId;
  },
});

// The streamingText row for a message (the live-text home). `.first()` (not
// `.unique()`): the by_message invariant is one row, but the STREAMING write path
// must never throw on a stray duplicate — it updates the first and keeps flowing.
async function streamingRow(ctx: MutationCtx, messageId: Id<"messages">) {
  return await ctx.db
    .query("streamingText")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
}

// Separator between the parent's own reply and the announced sub-agent result
// when the two merge into one bubble.
const ANNOUNCE_SEP = "\n\n";

// How long the filename-keyed media dedup stays armed after an announce
// rebroadcast — long enough for the replayed frames to drain, short enough
// that a later legitimate same-named file is never mistaken for a replay.
const ANNOUNCE_REPLAY_WINDOW_MS = 120_000;

/** Timer-scheduled FIELD CLEANUP for an expired replay window. The window
 *  itself is the stored DEADLINE (addPart compares against now), so an older
 *  armer's timer firing during a NEWER window is a no-op — the deadline it
 *  sees has not passed yet. */
export const disarmAnnounceReplay = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (
      message === null ||
      message.announceReplayArmed === undefined ||
      message.announceReplayArmed > Date.now()
    ) {
      return;
    }
    await ctx.db.patch(messageId, {
      announceReplayArmed: undefined,
      announceReplayRun: undefined,
    });
  },
});

/** Resolve an announce run to the finished PARENT message it belongs to and
 *  reopen it for streaming. Returns the parent messageId, or null when the
 *  merge must not happen (then the caller creates a fresh message — the
 *  pre-merge behaviour).
 *
 *  Join: `announce:<version>:<childSessionKey>:<childRunId>` — the
 *  childSessionKey (which itself contains ':') is everything between the
 *  version segment and the last segment; the subAgents table maps it to the
 *  spawning parent message. Merge conditions (all fail CLOSED to the old
 *  two-bubble behaviour):
 *    - the subAgents row exists for THIS chat and carries parentMessageId;
 *    - the parent is a COMPLETED assistant message (never error/aborted);
 *    - the parent is still the chat's LAST message (the conversation has not
 *      moved on — merging into an older bubble would hide the result). */
/** The chat's LOGICALLY last message (effectiveOrder — see the windowing
 *  invariant note in reopenParentForAnnounce), or null on an empty chat. */
async function latestChatMessage(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"messages"> | null> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(30);
  if (recent.length === 0) return null;
  return recent.reduce((a, b) => (effectiveOrder(b) > effectiveOrder(a) ? b : a));
}

async function reopenParentForAnnounce(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  announceRunId: string,
  now: number,
  // The PROVEN starting instance (per-bridge ingest) — stamped onto the
  // recreated/re-owned live row so the merge generation keeps the same
  // zero-read hot-path authorization as a normal turn (codex P1: the reopen
  // path previously produced an UNSTAMPED row that fell back to the weaker
  // chat-membership check).
  boundInstanceName?: string,
): Promise<{ messageId: Id<"messages">; reopened: boolean } | null> {
  const childSessionKey = deliveryChildKey(announceRunId);
  if (childSessionKey === null) return null;
  const sub = await ctx.db
    .query("subAgents")
    .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
    .filter((q) => q.eq(q.field("chatId"), chatId))
    .first();
  let parentId = sub?.parentMessageId;
  // TRUE when the anchor is CORRELATED (spawn result / task engagement /
  // chain adoption — not the bridge's last-known-message fallback, flagged
  // anchorHeuristic): the join is exact, so the merge may return to a bubble
  // the conversation has moved PAST — the reply belongs to ITS turn, not to
  // the bottom of the thread (user report: deliveries landing after an
  // interleaved follow-up read as out-of-order). Heuristic anchors and the
  // CHAIN fallback below stay position-gated (a stale plausible anchor must
  // fail-close to two bubbles, never merge into a wrong one).
  let anchoredResolution =
    parentId !== undefined && sub?.anchorExact === true;
  if (parentId === undefined && sub?.bornOfRun !== undefined) {
    // The child was spawned INSIDE a task-delivery run that never opened a
    // message of its own (NO_REPLY): resolve the anchor through the
    // ENGAGEMENT row of that run — the bubble of the turn that STARTED the
    // background task is where the user expects the result.
    const engagementKey = deliveryChildKey(sub.bornOfRun);
    if (engagementKey !== null) {
      const engagement = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", engagementKey))
        .filter((q) => q.eq(q.field("chatId"), chatId))
        .first();
      parentId = engagement?.parentMessageId ?? undefined;
      anchoredResolution =
        parentId !== undefined && engagement?.anchorExact === true;
    }
  }
  // Set by the CHAIN fallback below; consumed just before the successful
  // reopen return — the synthetic engagement row must only be anchored to a
  // VALIDATED target (an anchor written before the status/last-message gates
  // would leave a pointer to a rejected bubble).
  let chainTaskKeyToAnchor: string | null = null;
  if (parentId === undefined) {
    // CHAIN fallback — measured live (OpenClaw 2026.7.1-beta.5, 2026-07-13):
    // the gateway emits NO tool frames on delivery runs, so a task started
    // INSIDE one (sequential generation: deliver item N, start N+1 in that
    // run) is invisible to the bridge — no acked engagement row exists and
    // nothing above can resolve. The chain itself is the remaining join:
    // (1) the newest ANCHORED same-tool engagement whose anchor is still the
    // conversation's last bubble, or (2) a last bubble already carrying the
    // tool's delivery family. Anything else keeps failing CLOSED to the
    // fresh-bubble behaviour.
    const identity = taskDeliveryIdentity(announceRunId);
    if (identity !== null) {
      const last = await latestChatMessage(ctx, chatId);
      const carriesSameTool = (m: Doc<"messages">): boolean => {
        const own = m.runId !== undefined ? taskDeliveryIdentity(m.runId) : null;
        if (own !== null && own.toolName === identity.toolName) return true;
        return (m.mergedAnnounceRuns ?? []).some(
          (r) => taskDeliveryIdentity(r)?.toolName === identity.toolName,
        );
      };
      // Newest-first BOUNDED window (an old chat accumulates task rows; an
      // unbounded collect could blow the mutation's read limits and kill the
      // delivery). A live chain's rows are always among the newest.
      const recentRows = await ctx.db
        .query("subAgents")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .order("desc")
        .take(64);
      const sameTool = recentRows.filter(
        (r) => r.kind === "task" && r.taskName === identity.toolName,
      );
      const anchored = sameTool
        .filter((r) => r.parentMessageId !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const newestAnchor = anchored[0]?.parentMessageId ?? null;
      // TWO concurrent chains of the same tool (a running row anchored to a
      // DIFFERENT bubble) make the join ambiguous — fail closed rather than
      // merge a result into the wrong chain.
      const ambiguous =
        newestAnchor !== null &&
        anchored.some(
          (r) => r.status === "running" && r.parentMessageId !== newestAnchor,
        );
      if (last !== null && last.role === "assistant" && !ambiguous) {
        if (newestAnchor === last._id || carriesSameTool(last)) {
          parentId = last._id;
          chainTaskKeyToAnchor = `task:${identity.taskId}`;
        }
      }
    }
  }
  if (parentId === undefined) return null;
  const parent = await ctx.db.get(parentId);
  if (parent === null || parent.chatId !== chatId || parent.role !== "assistant") {
    return null;
  }
  const alreadyMerged =
    parent.runId === announceRunId ||
    (parent.mergedAnnounceRuns ?? []).includes(announceRunId);
  if (
    alreadyMerged &&
    (parent.status === "complete" || parent.status === "aborted")
  ) {
    // Terminal REBROADCAST of an announce already merged (a bridge restart
    // loses its in-memory announce dedupe) — including an OLDER announce
    // replayed after a newer one overwrote runId: hand back the settled
    // parent — every follow-up write no-ops on its terminal status, so the
    // result is never appended twice. An ABORTED merge is the user's explicit
    // stop: same silent sink, never a reopen. On a COMPLETE parent, ARM the
    // replay window so re-uploaded media parts dedupe by filename during the
    // replay only.
    if (parent.status === "complete") {
      await ctx.db.patch(parentId, {
        announceReplayArmed: now + ANNOUNCE_REPLAY_WINDOW_MS,
        announceReplayRun: announceRunId,
      });
      await ctx.scheduler.runAfter(
        ANNOUNCE_REPLAY_WINDOW_MS,
        internal.stream.disarmAnnounceReplay,
        { messageId: parentId },
      );
    }
    return { messageId: parentId, reopened: false };
  }
  if (parent.status === "streaming") {
    // Idempotent join ONLY for the SAME run (ingest retry). An announce
    // ALREADY consumed stays a silent sink even while a newer one is merging
    // (its writes then fail the generation guard — nothing lands twice). Any
    // OTHER announce falls back to its own fresh bubble (no interleaving).
    if (parent.runId === announceRunId && parent.announcePrefix !== undefined) {
      return { messageId: parentId, reopened: false };
    }
    if ((parent.mergedAnnounceRuns ?? []).includes(announceRunId)) {
      return { messageId: parentId, reopened: false };
    }
    return null;
  }
  // Never repaint an error/abort — EXCEPT to RESUME this very announce whose
  // merge died on an ERROR (bridge lost mid-delivery, watchdog settled the
  // parent): blocking its rebroadcast would lose the result forever. Aborts
  // never resume (handled above).
  const resuming = parent.status === "error" && alreadyMerged;
  if (parent.status !== "complete" && !resuming) return null;
  // Position gate — CHAIN-resolved anchors only. An anchor inherited from
  // the conversation's shape (no engagement row) is only trustworthy while
  // the parent is still the LOGICALLY last message (effectiveOrder: a
  // follow-up queued in the pre-ack window has an EARLIER _creationTime but
  // logically comes after — messageOrder WINDOWING INVARIANT). An ACKED /
  // engagement-resolved anchor is exact, so its delivery merges back into
  // its own turn even after the conversation moved on.
  if (!anchoredResolution) {
    const last = await latestChatMessage(ctx, chatId);
    if (last === null || last._id !== parentId) return null;
  } else {
    // An anchored merge may return to a NON-last bubble, but never to one the
    // client no longer loads: loadChatView ships only the newest
    // MESSAGE_WINDOW rows, so merging past it would make the delivery
    // invisible. Fall back to the fresh bottom bubble instead (codex P2).
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(MESSAGE_WINDOW);
    if (!recent.some((m2) => m2._id === parentId)) return null;
  }
  // The durable ownership stamp GATES the re-own: an instance that is merely
  // another valid per-turn route of the chat must not seize a parent finalized
  // by a DIFFERENT instance via a forged sub-agent anchor + announce (codex
  // P1) — announces come, by construction, from the gateway that spawned the
  // child, i.e. the parent's owner. A pre-R2 parent has no stamp — the re-own
  // below stamps it.
  if (
    boundInstanceName !== undefined &&
    parent.boundInstance !== undefined &&
    parent.boundInstance !== boundInstanceName
  ) {
    throw new Error(CROSS_INSTANCE);
  }
  // RESUME reuses the ORIGINAL prefix preserved by the failed finalize —
  // parent.text at this point is `original + partial announce`, and
  // re-prefixing with THAT would duplicate the partial fragment.
  const prefix = resuming ? (parent.announcePrefix ?? "") : parent.text;
  await ctx.db.patch(parentId, {
    status: "streaming",
    // Re-own the message for the announce generation (durable stamp).
    ...(boundInstanceName !== undefined
      ? { boundInstance: boundInstanceName }
      : {}),
    // A resume must not carry the failed attempt's error metadata into the
    // (hopefully) successful generation — convertMessage would keep exposing
    // it on a completed message otherwise.
    error: undefined,
    errorCode: undefined,
    // Re-stamped by the merge's own finalize: the reply-duration UI must
    // reflect the merged result's arrival, not the first generation's end.
    finalizedAt: undefined,
    // The message now belongs to the ANNOUNCE run: an abort clicked during
    // the merge must target this run (and a LATE terminal write from the old
    // parent run must miss the generation check in finalize).
    runId: announceRunId,
    // ALWAYS parked (even empty, e.g. a media-only parent): its presence is
    // the "reopened by the merge" marker the idempotent-retry path checks.
    announcePrefix: prefix,
    // Consumed-announce history (bounded) — recognizes an OLD announce's
    // rebroadcast even after further merges rotate `runId`.
    mergedAnnounceRuns: [
      ...(parent.mergedAnnounceRuns ?? []),
      announceRunId,
    ].slice(-50),
    // A resume re-delivers parts the failed attempt already attached — arm
    // the filename-keyed dedup for its duration. A NORMAL merge explicitly
    // DISARMS any leftover window from a prior rebroadcast: announce B's
    // legitimate parts must never dedupe against A's replay rules.
    announceReplayArmed: resuming
      ? now + ANNOUNCE_REPLAY_WINDOW_MS
      : undefined,
    announceReplayRun: resuming ? announceRunId : undefined,
    updatedAt: now,
  });
  if (resuming) {
    await ctx.scheduler.runAfter(
      ANNOUNCE_REPLAY_WINDOW_MS,
      internal.stream.disarmAnnounceReplay,
      { messageId: parentId },
    );
  }
  // Live row seeded with the parent text so the reopened bubble never blanks
  // (deltas append after it). Guard a stray existing row (duplicate insert).
  const existing = await streamingRow(ctx, parentId);
  if (existing === null) {
    // SSE cursor MONOTONY across generations: the closed generation's chunks
    // may still exist (their GC is async) — restarting at seq 1 would collide
    // with them and break Last-Event-ID resume. Continue after the max.
    const lastChunk = await ctx.db
      .query("streamChunks")
      .withIndex("by_message_seq", (q) => q.eq("messageId", parentId))
      .order("desc")
      .first();
    const seedText = prefix !== "" ? prefix + ANNOUNCE_SEP : "";
    let nextSeq = lastChunk !== null ? lastChunk.seq + 1 : 1;
    if (seedText !== "") {
      // Publish the seeded prefix as a REPLACE chunk: an SSE consumer opening
      // on the reopened turn must start from the parent's text — an empty
      // chunk stream would clobber the reactive prefix with "" until the
      // first delta (or forever, for a media-only announce).
      await ctx.db.insert("streamChunks", {
        messageId: parentId,
        chatId,
        seq: nextSeq,
        kind: "replace",
        text: seedText,
      });
      nextSeq += 1;
    }
    await ctx.db.insert("streamingText", {
      messageId: parentId,
      chatId,
      userId: parent.userId,
      generation: announceRunId,
      ...(boundInstanceName !== undefined
        ? { boundInstance: boundInstanceName }
        : {}),
      text: seedText,
      updatedAt: now,
      ...(lastChunk !== null || seedText !== "" ? { chunkSeq: nextSeq } : {}),
    });
  } else {
    // A stray leftover row: re-own it for the announce generation, or the
    // merge's own deltas would fail the generation guard and drop. The stamp
    // re-owns with it (same generational semantics).
    await ctx.db.patch(existing._id, {
      generation: announceRunId,
      ...(boundInstanceName !== undefined
        ? { boundInstance: boundInstanceName }
        : {}),
      updatedAt: now,
    });
  }
  if (chainTaskKeyToAnchor !== null) {
    // The chain fallback resolved AND the target passed every gate: anchor
    // the engagement row now (create-or-patch) so the settle at the end of
    // this run finds an anchored row and the NEXT link resolves through it.
    const row = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", chainTaskKeyToAnchor))
      .filter((q) => q.eq(q.field("chatId"), chatId))
      .first();
    if (row === null) {
      await ctx.db.insert("subAgents", {
        chatId,
        userId: parent.userId,
        parentMessageId: parentId,
        anchorExact: true, // validated by the chain gates just above
        childSessionKey: chainTaskKeyToAnchor,
        kind: "task",
        taskName: taskDeliveryIdentity(announceRunId)?.toolName,
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
    } else if (row.parentMessageId === undefined) {
      await ctx.db.patch(row._id, {
        parentMessageId: parentId,
        anchorExact: true, // validated by the chain gates just above
        updatedAt: now,
      });
    }
  }
  return { messageId: parentId, reopened: true };
}

// Append incremental text (message.delta). Writes the LIVE-TEXT ROW, not the
// `messages` doc — so the heavy loadChatView (which reads `messages`) does NOT
// re-run on every delta; only the cheap getStreamingText query does. `updatedAt`
// here is the streaming heartbeat. `messages.text` is written once at finalize.
// Live processing-phase of an in-flight turn (Tools-ON placeholder detail).
// Values are allowlisted here — the bridge is trusted but the wire is not the
// schema. Sets ONLY the phase (+updatedAt, which doubles as a watchdog
// heartbeat while the agent legitimately works in silence).
/**
 * How long the session-RESET fence stays armed.
 *
 * The fence compares a BRIDGE timestamp (`observedAt`) against a CONVEX one
 * (`sessionResetAt`), and the two clocks are not the same machine's. Left armed
 * forever, a bridge running behind would have every valid post-reset write
 * rejected until its drift caught up — the fresh session would sit with no meta
 * and no gauge (codex P2). In-flight writes of the old session land within
 * seconds, so the fence only has to cover that; past this window it disarms and
 * the deployment self-heals whatever its skew.
 */
const RESET_FENCE_WINDOW_MS = 2 * 60 * 1000;

/** True when `observedAt` describes the session a reset just replaced. */
function beforeSessionReset(
  observedAt: number | undefined,
  resetAt: number | undefined,
): boolean {
  if (observedAt === undefined || resetAt === undefined) return false;
  if (Date.now() - resetAt > RESET_FENCE_WINDOW_MS) return false; // disarmed
  // `<=`, not `<` (codex P2): the two timestamps come from different machines,
  // so a verdict of the OLD session observed in the SAME millisecond as the
  // reset is ambiguous — and admitting it leaves a false warning the meta
  // refreshes then preserve. A clock genuinely ahead still slips through; that
  // one self-heals on the next send, which finds the session fresh.
  return observedAt <= resetAt;
}

const TURN_PHASES = new Set([
  "processing_history",
  "compacting",
  "querying_gateway",
  "awaiting_subagents",
  // The gateway emitted its DEFERRED terminal (`lifecycle phase:"finishing"`):
  // the answer is complete and it is finishing its post-turn work. Before this
  // the turn simply went silent until the 240 s recv timeout (G-20).
  "post_processing",
  // A tool asked for a human approval this app cannot grant (G-21): the turn is
  // deliberately waiting, and saying so beats a silent spinner.
  "awaiting_approval",
]);

export const setPhase = internalMutation({
  args: {
    messageId: v.id("messages"),
    phase: v.string(),
    // Generation guard (see appendDelta): a delayed phase write from a run
    // that no longer owns this message must not touch (nor heartbeat) the
    // reopened stream.
    expectedRunId: v.optional(v.union(v.string(), v.null())),
    ...boundArg,
  },
  handler: async (ctx, { messageId, phase, expectedRunId, boundInstanceName }) => {
    // "generating" is Hermes' RESUME signal (sub-agents settled, the model is
    // producing again) — it is not a phase but the END of one: CLEAR the stored
    // phase, else "awaiting_subagents" sticks on the chip after the children
    // return (it was silently dropped before, leaving the stale label).
    const clearing = phase === "generating";
    if (!clearing && !TURN_PHASES.has(phase)) return; // unknown: ignore, never throw
    const row = await streamingRow(ctx, messageId);
    // No live row (turn not open yet, or already finished): drop — the phase is
    // a live-only hint, never worth resurrecting a row the finalize GC'd.
    if (row === null) return;
    if (
      expectedRunId !== undefined &&
      row.generation !== undefined &&
      row.generation !== expectedRunId
    ) {
      return;
    }
    // ATOMIC cross-gateway barrier (row stamp — zero extra reads).
    await assertRowBound(ctx, row, boundInstanceName);
    // Heartbeat (updatedAt) ONLY for phases that prove REAL gateway activity.
    // querying_gateway is the bridge's own doubt about a silent turn — bumping
    // the watchdog there would let a bridge death during the recovery leave the
    // stream stuck ~12 extra minutes (codex P2).
    if (clearing) {
      // Resume signal: real gateway activity — clear the phase AND heartbeat.
      await ctx.db.patch(row._id, { phase: undefined, updatedAt: Date.now() });
    } else if (phase === "querying_gateway") {
      await ctx.db.patch(row._id, { phase });
    } else {
      await ctx.db.patch(row._id, { phase, updatedAt: Date.now() });
    }
  },
});

/** Watchdog heartbeat driven by a REAL gateway frame (Hermes reasoning stream):
 *  refresh streamingText.updatedAt so a turn that is genuinely thinking for a
 *  long time — emitting reasoning frames but no reply text yet — is not orphaned
 *  by the 12-min stuck-stream watchdog. Safe by construction: only a LIVE
 *  gateway emits these frames, so a dead bridge (the case the watchdog guards)
 *  produces no heartbeat and still times out. No phase change — purely liveness. */
export const heartbeatStream = internalMutation({
  args: { messageId: v.id("messages"), ...boundArg },
  handler: async (ctx, { messageId, boundInstanceName }) => {
    const row = await streamingRow(ctx, messageId);
    if (row === null) return;
    // ATOMIC cross-gateway barrier (row stamp — zero extra reads).
    await assertRowBound(ctx, row, boundInstanceName);
    await ctx.db.patch(row._id, { updatedAt: Date.now() });
  },
});

export const appendDelta = internalMutation({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
    ...recArgs,
    // Generation guard (see finalize): a late/retried delta from a run that
    // no longer owns this message drops silently.
    expectedRunId: v.optional(v.union(v.string(), v.null())),
    ...boundArg,
  },
  handler: async (
    ctx,
    {
      messageId,
      text,
      recSessionId,
      bridgeRecvAt,
      bridgeSentAt,
      bridgeSkew,
      sizeBytes,
      expectedRunId,
      boundInstanceName,
    },
  ) => {
    const now = Date.now(); // t2: Convex received
    // Only pay the recorder point-read when the bridge actually tagged this delta.
    const rec = recSessionId !== undefined ? await activeRecording(ctx) : null;
    const row = await streamingRow(ctx, messageId);
    // GENERATION guard on the hot path — via the live row (no extra read):
    // a write from a run that no longer owns this message (it was reopened by
    // an announce merge for a NEWER run) must drop, not corrupt the stream.
    if (
      expectedRunId !== undefined &&
      row !== null &&
      row.generation !== undefined &&
      row.generation !== expectedRunId
    ) {
      return;
    }
    // ATOMIC cross-gateway barrier (hot path): compare against the live row's
    // startAssistant-validated stamp — zero extra reads (legacy rows without a
    // stamp fall back to the chat check inside assertRowBound).
    if (row !== null) await assertRowBound(ctx, row, boundInstanceName);
    let streamRowId: Id<"streamingText">;
    let chatId: Id<"chats">;
    let seq: number;
    // The SSE chunk: usually an "append" of this delta, but the FIRST chunk for a row that
    // already carried text (a pre-split `liveText` prefix, or a stream active across the
    // deploy to chunkSeq) must "replace" with the FULL text so a fresh SSE client gets the
    // prefix, not just this delta (Codex review).
    let chunkKind: "append" | "replace";
    let chunkText: string;
    if (row === null) {
      // Defensive: startAssistant creates the row, but a delta arriving without
      // one (a race / a message MID-STREAM across the deploy to this version) still
      // streams — create it, deriving chatId from the message. PRESERVE any legacy
      // `liveText` prefix already streamed pre-deploy, else this delta would orphan
      // it and a no-text finalize would lose everything streamed before the deploy.
      const message = await ctx.db.get(messageId);
      if (message === null) throw new Error("appendDelta: message not found");
      // ATOMIC barrier on the defensive re-create path (durable message stamp).
      await assertMessageBound(ctx, message, boundInstanceName);
      // A late delta for an ALREADY-FINISHED turn (finalize/watchdog deleted the row
      // and set a terminal status) must NOT recreate a row: no finalize will run
      // again to delete it, so it would leak a phantom live row that getStreamingText
      // returns forever. Drop it — the turn is over (mirrors addPart's status guard).
      if (message.status !== "streaming") return;
      // Generation guard (fallback path — the message read is already paid).
      if (
        expectedRunId !== undefined &&
        (message.runId ?? null) !== expectedRunId
      ) {
        return;
      }
      seq = 1; // 1-based: a fresh SSE cursor of 0 reads from the first chunk (seq > 0)
      const prefix =
        message.liveText ??
        (message.announcePrefix !== undefined && message.announcePrefix !== ""
          ? message.announcePrefix + ANNOUNCE_SEP
          : "");
      const full = prefix + text;
      streamRowId = await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
        userId: message.userId,
        generation: message.runId ?? null,
        ...(boundInstanceName !== undefined
          ? { boundInstance: boundInstanceName }
          : {}),
        text: full,
        updatedAt: now,
        chunkSeq: 2,
      });
      chatId = message.chatId;
      chunkKind = prefix === "" ? "append" : "replace";
      chunkText = prefix === "" ? text : full;
    } else {
      seq = row.chunkSeq ?? 1;
      const full = row.text + text;
      await ctx.db.patch(row._id, {
        text: full,
        updatedAt: now,
        chunkSeq: seq + 1,
      });
      streamRowId = row._id;
      chatId = row.chatId;
      const firstWithPrefix = row.chunkSeq === undefined && row.text !== "";
      chunkKind = firstWithPrefix ? "replace" : "append";
      chunkText = firstWithPrefix ? full : text;
    }
    // Recorder: mint the correlator FIRST (when recording) so the SSE chunk below can carry
    // it — the SSE leg then closes segment C at the displayed receipt (Phase 5). Still
    // stamps streamingText.recTimingId for the reactive leg, as before.
    let chunkRecTimingId: string | undefined;
    if (rec !== null && recSessionId === rec.sessionId) {
      // Session match: this delta belongs to the CURRENTLY active recording.
      chunkRecTimingId = await recordDelta(ctx, {
        sessionId: rec.sessionId,
        streamRowId,
        chatId,
        t0: bridgeRecvAt,
        t1: bridgeSentAt ?? now,
        t2: now,
        bridgeSkew,
        sizeBytes,
      });
    } else if (row !== null && row.recTimingId !== undefined) {
      // Not recording for THIS session anymore (stopped / auto-stopped / a late delta
      // from an old turn whose session is no longer active / an untagged delta): drop
      // the stale in-band markers so getStreamingText stops exposing an old sample.
      // Self-heals on the first such write; no cost in the steady OFF case (a normal
      // row has no recTimingId, so this branch never patches).
      await ctx.db.patch(streamRowId, {
        recTimingId: undefined,
        recCommittedAt: undefined,
      });
    }
    // SSE transport (Phase 1): one chunk per stream write. Carries recTimingId ONLY during
    // an active recording (Phase 5: closes segment C on the SSE leg).
    await ctx.db.insert("streamChunks", {
      messageId,
      chatId,
      seq,
      kind: chunkKind,
      text: chunkText,
      ...(chunkRecTimingId !== undefined
        ? { recTimingId: chunkRecTimingId }
        : {}),
    });
  },
});

// Replace the full streaming text (message.snapshot). Same live-text-row target.
export const setSnapshot = internalMutation({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
    ...recArgs,
    // Generation guard (see appendDelta).
    expectedRunId: v.optional(v.union(v.string(), v.null())),
    // An AUTHORIZED shrink. A snapshot normally only ever grows: it is the
    // gateway's full view of the same reply. Two producers legitimately shorten
    // it, and only these two set this flag — the compaction reset (an empty
    // snapshot clearing an invalidated prefix) and an upstream
    // `ChatDeltaEventSchema.replace` refresh. Everything else that shrinks the
    // text is a REGRESSION (an out-of-order or stale snapshot) and is refused
    // here: this is the durable lock that makes the displayed reply insensitive
    // to any residual disorder upstream of Convex.
    replace: v.optional(v.boolean()),
    ...boundArg,
  },
  handler: async (
    ctx,
    {
      messageId,
      text: rawText,
      recSessionId,
      bridgeRecvAt,
      bridgeSentAt,
      bridgeSkew,
      sizeBytes,
      expectedRunId,
      replace,
      boundInstanceName,
    },
  ) => {
    const now = Date.now(); // t2: Convex received
    const rec = recSessionId !== undefined ? await activeRecording(ctx) : null;
    const row = await streamingRow(ctx, messageId);
    // A snapshot REPLACES the live text — on a reopened (announce-merged)
    // message that would wipe the parent's own reply from the live view, so
    // re-prefix it. One point-read per snapshot (never per delta).
    const message = await ctx.db.get(messageId);
    if (message === null) throw new Error("setSnapshot: message not found");
    // ATOMIC cross-gateway barrier: the row's stamp when present (zero extra
    // reads), else the message's chat (the point-read above is already paid).
    if (row !== null) await assertRowBound(ctx, row, boundInstanceName);
    else await assertMessageBound(ctx, message, boundInstanceName);
    // Generation guard (see appendDelta): a snapshot from a run that no
    // longer owns this message drops silently.
    if (
      expectedRunId !== undefined &&
      (message.runId ?? null) !== expectedRunId
    ) {
      return { applied: false as const };
    }
    const text =
      message.announcePrefix !== undefined && message.announcePrefix !== ""
        ? message.announcePrefix + ANNOUNCE_SEP + rawText
        : rawText;
    let streamRowId: Id<"streamingText">;
    let chatId: Id<"chats">;
    let seq: number;
    if (row === null) {
      // See appendDelta: never recreate a row for a finished turn (no finalize will
      // delete it again) — a late snapshot for a terminal message is dropped.
      if (message.status !== "streaming") return { applied: false as const };
      seq = 1; // 1-based: a fresh SSE cursor of 0 reads from the first chunk (seq > 0)
      streamRowId = await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
        userId: message.userId,
        generation: message.runId ?? null,
        ...(boundInstanceName !== undefined
          ? { boundInstance: boundInstanceName }
          : {}),
        text,
        updatedAt: now,
        chunkSeq: 2,
      });
      chatId = message.chatId;
    } else {
      // ANTI-REGRESSION (G-14): refuse a snapshot that would SHORTEN the text
      // already displayed, unless the shrink is declared. Without this, any
      // stale/out-of-order snapshot silently truncated a reply the user had
      // already read, and nothing recorded it.
      if (replace !== true && text.length < (row.text ?? "").length) {
        await traceStream(ctx, {
          phase: "snapshot_regression",
          chatId: row.chatId,
          runId: message.runId,
          messageId,
          streamStatus: "streaming",
          oldLen: (row.text ?? "").length,
          newLen: text.length,
        });
        // REMEMBER the refusal: this exact text usually comes back as the turn's
        // final, and finalize is where the kept reply is decided (codex P1).
        await ctx.db.patch(row._id, { refusedText: text });
        // The caller MUST know: the bridge mirrors `liveText` locally to send
        // suffix-only deltas, and a refused write it believed applied would
        // make the next suffix append onto text that never shrank (codex-class
        // divergence — same lesson as addPart's `accepted:false`).
        return { applied: false as const };
      }
      seq = row.chunkSeq ?? 1;
      await ctx.db.patch(row._id, { text, updatedAt: now, chunkSeq: seq + 1 });
      streamRowId = row._id;
      chatId = row.chatId;
    }
    // Recorder: mint the correlator FIRST (when recording) so the snapshot chunk can carry
    // it — the SSE leg closes segment C at the displayed receipt (Phase 5).
    let chunkRecTimingId: string | undefined;
    if (rec !== null && recSessionId === rec.sessionId) {
      // Session match: this delta belongs to the CURRENTLY active recording.
      chunkRecTimingId = await recordDelta(ctx, {
        sessionId: rec.sessionId,
        streamRowId,
        chatId,
        t0: bridgeRecvAt,
        t1: bridgeSentAt ?? now,
        t2: now,
        bridgeSkew,
        sizeBytes,
      });
    } else if (row !== null && row.recTimingId !== undefined) {
      // Not recording for THIS session anymore (stopped / auto-stopped / a late delta
      // from an old turn whose session is no longer active / an untagged delta): drop
      // the stale in-band markers so getStreamingText stops exposing an old sample.
      // Self-heals on the first such write; no cost in the steady OFF case (a normal
      // row has no recTimingId, so this branch never patches).
      await ctx.db.patch(streamRowId, {
        recTimingId: undefined,
        recCommittedAt: undefined,
      });
    }
    // SSE transport (Phase 1): a snapshot is a "replace" chunk (the consumer resets its
    // accumulated text to it). Carries recTimingId ONLY during an active recording (Phase 5).
    await ctx.db.insert("streamChunks", {
      messageId,
      chatId,
      seq,
      kind: "replace",
      text,
      ...(chunkRecTimingId !== undefined
        ? { recTimingId: chunkRecTimingId }
        : {}),
    });
    return { applied: true as const };
  },
});

// Add a structured part (tool.status / media / file / reasoning). Order is
// assigned monotonically per message based on existing parts so rendering is
// stable. For media/file the bridge must have already stored the blob via
// `ctx.storage.store(blob)` (in an action) and pass the resulting `_storage`
// id inside `part`.
export const addPart = internalMutation({
  args: {
    messageId: v.id("messages"),
    part: messagePart,
    // Generation guard (see appendDelta): a part from a run that no longer
    // owns this message (an announce merge reopened it) drops silently —
    // it would otherwise pollute the merged result and its provenance.
    expectedRunId: v.optional(v.union(v.string(), v.null())),
    ...boundArg,
  },
  handler: async (ctx, { messageId, part, expectedRunId, boundInstanceName }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("addPart: message not found");
    }
    // ATOMIC cross-gateway barrier: the message's DURABLE owner stamp (it
    // survives finalize — the chat check alone would reopen terminal messages
    // to any routed instance).
    await assertMessageBound(ctx, message, boundInstanceName);
    // A SEGMENT belongs to an assistant turn, and to nothing else. This op is generic —
    // the bridge posts any part shape through it — so a mis-correlated `messageId` could
    // otherwise attach assistant prose to a USER message, where it renders inside the
    // user's own bubble as if they had written it (raised in review). Dropped rather than
    // thrown: a badly addressed part must not fail the ingest, only fail to land.
    if (part.kind === "reasoning" && message.role !== "assistant") {
      console.log(
        `[stream] addPart dropped: reasoning part addressed to a ${message.role} message`,
      );
      return;
    }
    if (
      expectedRunId !== undefined &&
      (message.runId ?? null) !== expectedRunId
    ) {
      // The bridge uploaded a media part's bytes BEFORE this call — reclaim
      // the blob or every stale-generation retransmit leaks a billable,
      // unreachable storage object (mirrors the dedup path below).
      if (part.kind === "media" || part.kind === "file") {
        try {
          await ctx.storage.delete(part.storageId);
        } catch {
          // best-effort: an already-gone blob must not fail the ingest
        }
      }
      // REPORTED, not silent (codex P2): the bridge's `addMedia` returns a boolean
      // that means "an attachment landed", and it uses it to claim the filename as
      // hosted and to emit a `stored` trace. A drop that reads as success makes the
      // dedup set and the diagnostics both wrong.
      return { accepted: false as const };
    }
    // Heartbeat: a turn streaming ONLY tool/media/reasoning parts (no text deltas)
    // must still refresh its live-text row, else the watchdog (which keys off that
    // row's updatedAt) would reap an actively-working turn as stuck. Bump if present;
    // create (preserving any legacy liveText) for a pre-deploy/race message with no
    // row yet. Does NOT touch the message doc — loadChatView re-runs on the part
    // INSERT below (the parts changed) regardless, so no extra per-text-delta churn.
    if (message.status === "streaming") {
      const liveRow = await streamingRow(ctx, messageId);
      // Row stamp is stricter than chat membership (per-TURN owner) — an
      // instance routed in the chat but not owning THIS stream must not
      // inject parts into it (codex P1).
      if (liveRow !== null) {
        await assertRowBound(ctx, liveRow, boundInstanceName);
        await ctx.db.patch(liveRow._id, { updatedAt: Date.now() });
      } else {
        await ctx.db.insert("streamingText", {
          messageId,
          chatId: message.chatId,
          userId: message.userId,
          generation: message.runId ?? null,
          ...(boundInstanceName !== undefined
            ? { boundInstance: boundInstanceName }
            : {}),
          text: message.liveText ?? "",
          updatedAt: Date.now(),
        });
      }
    }
    const existing = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    // TERMINAL-message idempotence: a replayed announce run (bridge restarted,
    // its in-memory dedupe lost) re-delivers the same tool/media parts to the
    // settled parent. A LATE part on a terminal message is legitimate (tool
    // results landing after the final) — but an exact duplicate of a part the
    // message already carries is a replay: drop it, or every rebroadcast would
    // stack visible duplicates (and re-mint files rows for media).
    const replayArmed =
      message.runId !== undefined &&
      deliveryChildKey(message.runId) !== null &&
      message.announceReplayArmed !== undefined &&
      message.announceReplayArmed > Date.now();
    if (replayArmed) {
      // Replay dedup — ONLY inside an ARMED window (rebroadcast/error-resume,
      // the identifiable replay scenarios) and ONLY against parts born in the
      // SAME announce run (provenance stamp below): the parent reply's own
      // same-named attachment must survive a replay. Media/file parts key on
      // filename+mimeType (a replay re-uploads the bytes, so the storageId
      // always differs); everything else on exact content. OUTSIDE a window
      // no message ever dedupes — late parts on ordinary terminal messages
      // (even identical ones) keep landing, the historic contract.
      const replayRun = message.announceReplayRun ?? message.runId;
      const sameRun = existing.filter((e) => e.announceRun === replayRun);
      const replayKey = (pt: typeof part): string => {
        if (pt.kind === "media" || pt.kind === "file") {
          return JSON.stringify({
            kind: pt.kind,
            filename: pt.filename,
            mimeType: pt.mimeType,
          });
        }
        return JSON.stringify(pt);
      };
      const incoming = replayKey(part);
      if (sameRun.some((e) => replayKey(e.part) === incoming)) {
        // The bridge already uploaded the replayed bytes — reclaim the blob,
        // or every rebroadcast leaks an orphaned (billable) storage object.
        if (
          (part.kind === "media" || part.kind === "file") &&
          !sameRun.some(
            (e) =>
              (e.part.kind === "media" || e.part.kind === "file") &&
              e.part.storageId === part.storageId,
          )
        ) {
          try {
            await ctx.storage.delete(part.storageId);
          } catch {
            // best-effort: an already-gone blob must not fail the ingest
          }
        }
        return;
      }
    }
    const announceRun = replayArmed
      ? (message.announceReplayRun ?? message.runId)
      : message.runId !== undefined && deliveryChildKey(message.runId) !== null
        ? message.runId
        : undefined;
    // TOOL-PART UPSERT: a start and its completed/error share the provider's
    // toolCallId — patch the existing row (fusing phase/input/output) instead
    // of stacking a second card. The ORIGINAL textOffset is preserved: the
    // start's position anchors the card in the narrative flow; the completed
    // (arriving after more text streamed) must not move it. Provenance-scoped
    // (same announceRun stamp) so an announce replay can never fuse into a
    // prior generation's part. Parts without a toolCallId (legacy bridges,
    // the `message` pseudo-tool) keep the append-only path.
    if (part.kind === "tool" && part.toolCallId !== undefined) {
      const row = existing.find(
        (e) =>
          e.part.kind === "tool" &&
          e.part.toolCallId === part.toolCallId &&
          (e.announceRun ?? null) === (announceRun ?? null),
      );
      if (row !== undefined && row.part.kind === "tool") {
        await ctx.db.patch(row._id, {
          part: {
            ...row.part,
            ...part,
            textOffset: row.part.textOffset ?? part.textOffset,
          },
        });
        await ctx.db.patch(messageId, { updatedAt: Date.now() });
        return;
      }
    }
    // COMPACTION-PART UPSERT (same shape as the tool upsert above): a turn
    // carries at most ONE compaction marker by design, but its phase is only
    // FINAL at the gateway's `end` verdict — the explicit-compaction flow
    // announces `midturn` when it starts and only then learns whether the
    // gateway actually compacted (`completed:false` = it did not). Patch in
    // place so the verdict REPLACES the announcement; appending would stack a
    // second, contradictory notice on the same turn. Provenance-scoped like
    // tools. No effect on the historic flow: the bridge writes a single
    // compaction part per turn, so this path only ever fires for the verdict.
    if (part.kind === "compaction") {
      const row = existing.find(
        (e) =>
          e.part.kind === "compaction" &&
          (e.announceRun ?? null) === (announceRun ?? null),
      );
      if (row !== undefined) {
        await ctx.db.patch(row._id, { part });
        await ctx.db.patch(messageId, { updatedAt: Date.now() });
        return;
      }
    }
    const order = existing.length;
    await ctx.db.insert("messageParts", {
      messageId,
      order,
      part,
      ...(announceRun !== undefined ? { announceRun } : {}),
    });
    // Paired files-row write (invariant): a file/media part gets an owner-scoped
    // `files` row. addPart is append-only (no per-flush re-insert), so this never
    // duplicates. Direction from the message role; instanceName = the chat's
    // bound bridge snapshot.
    if (isFilePart(part)) {
      const chat = await ctx.db.get(message.chatId);
      await recordFileForPart(ctx, {
        messageId,
        chatId: message.chatId,
        userId: message.userId,
        direction: message.role === "user" ? "inbound" : "outbound",
        instanceName: chat?.instanceName,
        part,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(messageId, { updatedAt: Date.now() });
  },
});

// Advance the message's LAST plan part from item-derived update_plan calls.
// DELIVERY runs (sub-agent announce / task delivery) carry no tool frames —
// an update_plan there surfaces as a bare item whose meta only names the
// plan's FIRST step (gateway progress-line builder, verified in the 2026.7.1
// dist), so the actual step content never reaches the wire. The bridge
// forwards "the plan moved N times this turn" + whether the turn left the
// pipeline idle; this mutation advances the last known plan accordingly and
// stamps the new part `estimated` (the UI labels the inferred progression).
export const advancePlanPart = internalMutation({
  args: {
    messageId: v.id("messages"),
    // update_plan calls observed on the delivery turn (one step each).
    count: v.number(),
    // TRUE when the turn spawned no further child: if NO child of the chat is
    // still running, the pipeline settled — the final update_plan call is the
    // model closing its plan, so mark every step completed.
    settleIfIdle: v.optional(v.boolean()),
    // Generation guard (see addPart): a stale run must not advance a plan on
    // a message another run has since re-owned.
    expectedRunId: v.optional(v.union(v.string(), v.null())),
    ...boundArg,
  },
  handler: async (
    ctx,
    { messageId, count, settleIfIdle, expectedRunId, boundInstanceName },
  ) => {
    if (count <= 0) return;
    const message = await ctx.db.get(messageId);
    if (message === null) return;
    // ATOMIC cross-gateway barrier (durable message stamp — see addPart).
    await assertMessageBound(ctx, message, boundInstanceName);
    if (
      expectedRunId !== undefined &&
      (message.runId ?? null) !== expectedRunId &&
      // Back-to-back deliveries: the NEXT announce can reopen the bubble
      // (rotating runId) before THIS turn's advance lands. An advance from a
      // run that MERGED into this very message belongs to the same pipeline
      // and is still true — only a run foreign to the bubble stays rejected.
      !(
        typeof expectedRunId === "string" &&
        (message.mergedAnnounceRuns ?? []).includes(expectedRunId)
      )
    ) {
      return;
    }
    const existing = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    const planRows = existing
      .filter((e) => e.part.kind === "plan")
      .sort((a, b) => a.order - b.order);
    // Replay dedup (same policy as addPart's armed window): a rebroadcast
    // announce re-delivers its frames after a bridge restart — the estimated
    // advance for THAT run already landed, re-applying it would skip an
    // extra step per rebroadcast (codex P2).
    const replayArmed =
      message.announceReplayArmed !== undefined &&
      message.announceReplayArmed > Date.now();
    if (replayArmed) {
      const replayRun = message.announceReplayRun ?? message.runId;
      if (
        planRows.some(
          (e) =>
            e.announceRun === replayRun &&
            e.part.kind === "plan" &&
            e.part.estimated === true,
        )
      ) {
        return;
      }
    }
    const lastPlan = planRows[planRows.length - 1];
    if (lastPlan === undefined || lastPlan.part.kind !== "plan") return;
    const prevSteps = lastPlan.part.steps;
    const steps = prevSteps.map((st) => ({ ...st }));
    let settled = false;
    if (settleIfIdle === true) {
      // DIRECT existence probe on (chatId, running): a bounded newest-window
      // could miss an old still-running child behind 64 later terminal rows
      // and settle a live pipeline's plan (codex P2).
      const running = await ctx.db
        .query("subAgents")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", message.chatId).eq("status", "running"),
        )
        .first();
      if (running === null) {
        for (const st of steps) st.status = "completed";
        settled = true;
      }
    }
    if (!settled) {
      const bounded = Math.min(count, steps.length);
      for (let n = 0; n < bounded; n++) {
        const cur = steps.findIndex((st) => st.status === "in_progress");
        if (cur >= 0) {
          const step = steps[cur];
          if (step !== undefined) step.status = "completed";
          const next = steps.findIndex(
            (st, i) => i > cur && st.status !== "completed",
          );
          const nextStep = next >= 0 ? steps[next] : undefined;
          if (nextStep !== undefined) nextStep.status = "in_progress";
        } else {
          // Nothing in flight: promote the first pending step instead.
          const first = steps.find((st) => st.status === "pending");
          if (first === undefined) break;
          first.status = "in_progress";
        }
      }
    }
    if (steps.every((st, i) => st.status === prevSteps[i]?.status)) {
      return;
    }
    const announceRun =
      message.runId !== undefined && deliveryChildKey(message.runId) !== null
        ? message.runId
        : undefined;
    await ctx.db.insert("messageParts", {
      messageId,
      order: existing.length,
      part: { kind: "plan", steps, estimated: true },
      ...(announceRun !== undefined ? { announceRun } : {}),
    });
    await ctx.db.patch(messageId, { updatedAt: Date.now() });
  },
});

// SSE transport (Phase 1): bounded, self-scheduling GC of a finished message's stream
// chunks. A long turn can accumulate hundreds, so delete in batches and reschedule to
// stay within Convex transaction limits (same idiom as the recorder's purge).
const CHUNK_GC_BATCH = 2000;
export const deleteStreamChunksStep = internalMutation({
  args: {
    messageId: v.id("messages"),
    // Only delete chunks with seq BELOW this bound (the closed generation) —
    // an announce merge can reopen the message and stream fresh chunks (whose
    // seq continues ABOVE the closed generation's max) while this GC
    // (scheduled by the previous finalize) is still draining. Absent = delete
    // everything (message-deletion flows, where no reopen can follow).
    beforeSeq: v.optional(v.number()),
  },
  handler: async (ctx, { messageId, beforeSeq }) => {
    const rows = await ctx.db
      .query("streamChunks")
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .take(CHUNK_GC_BATCH);
    const batch =
      beforeSeq !== undefined
        ? rows.filter((c) => c.seq < beforeSeq)
        : rows;
    for (const c of batch) await ctx.db.delete(c._id);
    // Reschedule ONLY if eligible rows remain under the bound RIGHT NOW —
    // never on the page arithmetic alone: after an exactly-full final page,
    // a reopen landing between the two passes restarts seq at 1 (no old
    // chunks left to continue after), and a blind extra pass would then eat
    // the NEW generation's chunks.
    if (rows.length === CHUNK_GC_BATCH && batch.length > 0) {
      const remaining = await ctx.db
        .query("streamChunks")
        .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
        .first();
      if (
        remaining !== null &&
        (beforeSeq === undefined || remaining.seq < beforeSeq)
      ) {
        await ctx.scheduler.runAfter(
          0,
          internal.stream.deleteStreamChunksStep,
          { messageId, ...(beforeSeq !== undefined ? { beforeSeq } : {}) },
        );
      }
    }
  },
});

// SSE transport (Phase 2): the poll the streaming httpAction runs each tick. Returns the
// message's chunks AFTER `afterSeq` (the cursor), its lifecycle status, and — once the turn
// is terminal — the AUTHORITATIVE final text (so the client ends correct even if the chunk
// GC already raced ahead). Auth: requires an active user that OWNS the chat (IDOR); the
// httpAction propagates ctx.auth into this runQuery. See openclaw-notes/docs/atrium/convex-http-streaming-transport.md.
const POLL_CHUNK_CAP = 500;
export const streamPoll = internalQuery({
  args: { messageId: v.id("messages"), afterSeq: v.number() },
  handler: async (ctx, { messageId, afterSeq }) => {
    const { userId } = await requireActive(ctx);
    const message = await ctx.db.get(messageId);
    if (message === null) throw new Error("streamPoll: message not found");
    await requireOwnedChat(ctx, userId, message.chatId); // IDOR
    const rows = await ctx.db
      .query("streamChunks")
      .withIndex("by_message_seq", (q) =>
        q.eq("messageId", messageId).gt("seq", afterSeq),
      )
      .take(POLL_CHUNK_CAP);
    const terminal = message.status !== "streaming";
    return {
      chunks: rows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        text: r.text,
        // recTimingId present only on a chunk written during a recording (Phase 5: the SSE
        // leg closes segment C). OMIT when absent (Convex rejects an undefined property).
        ...(r.recTimingId !== undefined ? { recTimingId: r.recTimingId } : {}),
      })),
      status: message.status,
      // OMIT finalText (not `undefined`) while streaming: Convex rejects an `undefined`
      // property in a returned object, which would fail the query for the MAIN active-
      // stream case — and convex-test does NOT enforce this, so only a real backend (or
      // the live browser path) catches it (Codex review).
      ...(terminal ? { finalText: message.text } : {}),
    };
  },
});

/**
 * A compaction Atrium learned from the COUNTER, not from a live marker.
 *
 *  Hermes reports how many times it has compacted this session, on every terminal. The
 *  live signal Atrium normally uses — a `status.update` of kind "compacting" — is broadcast
 *  `dropIfSlow` upstream, so a slow consumer never receives it and the thread never
 *  mentions that the session forgot half its history. When the count RISES past what the
 *  chat had recorded, the compaction happened whether or not its marker arrived.
 *
 *  Attached to the chat's LAST assistant message, and only to a SETTLED one: a marker on a
 *  still-streaming bubble would race that turn's own live marker and show one event twice.
 *  The `phase` says where the knowledge came from — "we counted this" is a weaker claim
 *  than "we watched it happen", and the reader deserves the difference.
 */
async function noteCountedCompactions(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  missed: number,
): Promise<void> {
  const last = await latestChatMessage(ctx, chatId);
  if (last === null || last.role !== "assistant") return;
  if (last.status === "streaming") return;
  // ALREADY MARKED? The count POST travels off the ordered chain, so it can land AFTER the
  // finalize — by which time the turn's own live marker may already sit on this very
  // message. Inserting anyway wrote a second part for one event, and the renderer shows
  // only the first, so the duplicate hid in the data rather than on screen (raised in
  // review).
  const existing = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", last._id))
    .collect();
  if (existing.some((p) => (p.part as { kind?: string }).kind === "compaction")) return;
  // Bounded: a counter that jumps by a thousand (a fresh session, a gateway that reset its
  // own tally) must not write a thousand parts. ONE marker, whatever the jump.
  const order = Date.now();
  await ctx.db.insert("messageParts", {
    messageId: last._id,
    order,
    part: {
      kind: "compaction" as const,
      phase: missed > 1 ? "counted-multiple" : "counted",
      at: order,
    },
  });
}

/**
 * Apply a finalize's `clearProviderSession` directive to the chat, if any.
 *
 * Shared by the two exits of `finalize` that must honor it: the normal terminal write,
 * and the "already terminal" no-op — a turn that gave up on silence still has to drop the
 * session it cannot vouch for, even when a user Stop finalized the bubble first and this
 * finalize therefore transitions nothing. Missing that second exit left the drop tied to
 * winning a race it does not need to win.
 */
async function dropUntrustedProviderSession(
  ctx: { db: MutationCtx["db"] },
  chatId: Id<"chats">,
  directive: boolean | string | undefined,
  /** TRUE when this finalize transitioned NOTHING (a retry, or a terminal that lost the
   *  race to a user Stop). Such a writer is late and may only remove a binding it can
   *  name — see `providerSessionClearPatch`. */
  late = false,
): Promise<void> {
  if (directive === undefined || directive === false) return;
  if (directive === true) {
    // Legacy wire form (pre-id bridge, rolling deploy). Honored on the OWNING path, where
    // it does exactly what it always did; inert on the late path, which needs an id to
    // match. Logged so the window is visible rather than silently permanent.
    console.log("[stream] clearProviderSession: legacy flag with no session id");
  }
  const chat = await ctx.db.get(chatId);
  if (chat === null) return;
  const patch = providerSessionClearPatch(
    chat.openclawChatId,
    chat.providerResetCount,
    {
      ...(typeof directive === "string" ? { expected: directive } : {}),
      onlyExactMatch: late,
    },
  );
  // An empty patch means this writer has no claim on the slot: a newer turn owns it, or
  // a late writer cannot name what is there. Neither the binding nor the epoch moves.
  if (Object.keys(patch).length === 0) {
    console.log("[stream] clearProviderSession skipped: chat bound to a newer session");
    return;
  }
  await ctx.db.patch(chatId, patch);
}

// Mark the assistant turn done (message.final). `status` is "complete" on a
// clean finish, "error" when the normalizer surfaced an error, or "aborted".
// Optional `text` lets the bridge set the final authoritative text (the
// normalizer's final event carries the accumulated text). On an error turn the
// bridge passes BOTH partial text and error (mirrors the lifecycle-error
// fixture: final text "moitié" + error containing "Context overflow").
export const finalize = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(
      v.literal("complete"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    text: v.optional(v.string()),
    error: v.optional(v.string()),
    // Stable gateway failure class (ChatErrorEventSchema.errorKind: refusal|
    // timeout|rate_limit|context_length) — persisted into the message's existing
    // `errorCode` field so the UI maps it to an actionable localized label.
    errorKind: v.optional(v.string()),
    // Generation guard for LATE terminal writers (dispatchAbort's guaranteed
    // settle): when set and the message meanwhile belongs to ANOTHER run (an
    // announce merge reopened it), this finalize targets a run that no longer
    // owns the bubble — skip instead of killing the newer stream. `null`
    // means "the targeted turn had NO runId" (legacy) — still enforced.
    expectedRunId: v.optional(v.union(v.string(), v.null())),
    // The streamed text is protocol NOISE (a NO_REPLY sentinel reached the
    // live row): never fall back to it. Atomic with the finalize by design.
    discardStreamText: v.optional(v.boolean()),
    // The gateway killed this REAL zero-content turn to run a delivery on the
    // same session (announce×queue race, inverse direction — never a user
    // Stop; the bridge sink mints the flag). The turn's send was consumed but
    // never processed: re-park its outbox row for ONE automatic re-dispatch
    // once the delivery settles (preemptRepark.ts).
    gatewayPreempted: v.optional(v.boolean()),
    // This turn ended without knowing whether the provider's run stopped (silence, not a
    // delivered error), so its stored provider session must not be resumed.
    //
    // ATOMIC WITH THE FINALIZE, and that is the whole design: a separate clear could fail
    // on its own while the turn settled anyway, handing the suspect session back to the
    // next send — the bridge had to carry an in-memory quarantine to paper over exactly
    // that, and the quarantine died with the process. Here the two outcomes are the only
    // two possible: the finalize lands and the session is cleared, or it does not land
    // and the turn is not settled, so the chat is never released and nothing can resume.
    /** The provider session id this turn was watching, when the turn ended without
     *  knowing whether its run stopped. A STRING, not a flag: this value crosses five
     *  hops (turn → sink → writer → `/bridge/ingest` → here), and a hop that drops it
     *  must fail CLOSED — no id means no clear, costing one rehydration. A boolean that
     *  went missing would instead have to pick a default, and "clear unconditionally"
     *  fails OPEN onto a binding that may no longer be ours.
     *
     *  `v.boolean()` is accepted for ONE release: during a rolling deploy an older
     *  bridge still posts `true`, and rejecting it would fail the finalize and wedge the
     *  turn in `streaming` — the very class of bug this field exists to close. */
    clearProviderSession: v.optional(v.union(v.boolean(), v.string())),
    ...boundArg,
  },
  handler: async (
    ctx,
    {
      messageId,
      status,
      text,
      error,
      errorKind,
      expectedRunId,
      boundInstanceName,
      discardStreamText,
      gatewayPreempted,
      clearProviderSession,
    },
  ) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("finalize: message not found");
    }
    // ATOMIC cross-gateway barrier (durable message stamp — see addPart).
    await assertMessageBound(ctx, message, boundInstanceName);
    if (
      expectedRunId !== undefined &&
      (message.runId ?? null) !== expectedRunId
    ) {
      console.log(
        "[stream] finalize skipped: message re-owned by another run (announce merge)",
      );
      // …and `clearProviderSession` is skipped with it, deliberately, for a reason the
      // id match does NOT cover: the announce run works on that VERY session, so the id
      // would match and the clear would fire. Dropping it here would break a turn that is
      // working, to protect against one that already lost its claim. The chat is not
      // released by this path either, so nothing resumes in the meantime.
      return { transitioned: false as const };
    }
    // FIRST TERMINAL WRITE WINS (symmetric): a user-aborted message stays
    // aborted when the gateway's late chat:final loses the race — and a reply
    // that COMPLETED before the abort RPC landed stays complete (the kill's
    // guaranteed-settle finalize must not repaint a finished answer as
    // interrupted). A SAME-status redelivery is a full no-op too: the first
    // finalize already wrote the text (possibly recomposed from a consumed
    // announcePrefix — re-running would wipe the merged parent reply), drained
    // the queue and scheduled the GC.
    if (message.status !== "streaming") {
      console.log(
        `[stream] finalize skipped: already terminal (${message.status} vs ${status})`,
      );
      // …but the SESSION DROP still applies. A user Stop finalizes the bubble `aborted`
      // in Convex while the bridge's own silence terminal is in flight; the bridge writes
      // no terminal of its own on a Stop (`forceSettle(false)`), so if the drop rode only
      // the transition it would vanish with the race — and the chat is released, so the
      // next send reads the very slot this turn declared untrusted. The id match is what
      // makes this late write safe (see `providerSessionClearPatch`).
      await dropUntrustedProviderSession(
        ctx,
        message.chatId,
        clearProviderSession,
        true,
      );
      // NOT a transition. The bridge now RETRIES a finalize whose response was lost,
      // so this no-op is expected — and the ingest route must not write a second
      // `openclaw.ingest` trace for it, or every recovered network blip inflates the
      // finalize counters the anomaly detector and the audits read (codex P2).
      return { transitioned: false as const };
    }
    // A2: write the authoritative final text into the searchable/indexed `text`
    // ONCE here, and CLEAR `liveText` (so listByChat now reads `text`). Prefer the
    // normalizer's final text; fall back to whatever streamed into `liveText` (so
    // a final with no explicit text never wipes a streamed reply).
    // The live text now lives in the streamingText row; `message.liveText` is only
    // a fallback for a message that was mid-stream across a deploy to this version.
    const stRow = await streamingRow(ctx, messageId);
    // The live row's stamp is STRICTER than chat membership (per-TURN owner):
    // an instance routed in this chat but not owning THIS stream must not
    // terminate it (codex P1 — a bound C finalizing B's active stream).
    if (stRow !== null) await assertRowBound(ctx, stRow, boundInstanceName);
    const streamedText = discardStreamText
      ? "" // sentinel noise — never resurrect it as the reply (codex P2)
      : (stRow?.text ?? message.liveText ?? message.text);
    const prefix = message.announcePrefix ?? "";
    // Announce merge: the run's final frame carries ONLY the announce text —
    // recompose behind the parked parent reply. The FALLBACK path (no final
    // text: a preempted or swept merge) must honor the parked prefix too: the
    // reopen seeds the stream row with it, but a SNAPSHOT frame replaces the
    // row text — closing with the bare snapshot would overwrite the already
    // delivered reply (live 2026-07-19: a replayed announce, preempted
    // mid-stream, shrank a full report to its replayed head).
    let finalText =
      text !== undefined && text !== ""
        ? prefix !== ""
          ? prefix + ANNOUNCE_SEP + text
          : text
        : prefix === "" || streamedText.startsWith(prefix)
          ? streamedText // no merge, or the row still carries the seeded prefix
          : streamedText === "" || prefix.startsWith(streamedText)
            ? prefix // replayed head of the parked reply (nothing new): keep the reply
            : prefix + ANNOUNCE_SEP + streamedText; // genuinely new partial content
    // ANTI-REGRESSION AT THE TERMINAL WRITE (G-14, codex P1). The guard on
    // setSnapshot protects the LIVE row, but the reply the user keeps is this
    // `text` — a stale or truncated final would defeat the guard one write later.
    //
    // The test is PREFIX, not length. A final that merely differs is the
    // gateway's authoritative re-render (directives stripped, whitespace
    // collapsed) and may legitimately be shorter — an existing abort test proves
    // that case is real. A final that is a strict PREFIX of what the user has
    // already read is not a re-render: it is the same text, cut. Only for a
    // COMPLETE turn (an error/aborted finalize legitimately carries a partial or
    // an error string), and never for declared stream noise.
    // Two independent reasons to keep the streamed text. The remembered refusal
    // is EXACT and stands on its own: gating it behind the length comparison let
    // an authorized `replace` shorten the row and, once the displayed text was no
    // longer longer, the very same stale final walked back in (codex P2).
    const finalRepeatsRefused =
      stRow?.refusedText !== undefined && finalText === stRow.refusedText;
    // A strict PREFIX of what is displayed is the same text, cut. A final that
    // merely DIFFERS is the gateway's authoritative re-render and may
    // legitimately be shorter — an existing abort test proves that case is real.
    const finalCutsDisplayed =
      finalText.length < streamedText.length &&
      streamedText.startsWith(finalText);
    if (
      status === "complete" &&
      !discardStreamText &&
      streamedText !== "" &&
      (finalRepeatsRefused || finalCutsDisplayed)
    ) {
      await traceStream(ctx, {
        phase: "snapshot_regression",
        chatId: message.chatId,
        runId: message.runId,
        messageId,
        streamStatus: status,
        oldLen: streamedText.length,
        newLen: finalText.length,
      });
      finalText = streamedText;
    }
    await ctx.db.patch(messageId, {
      status,
      text: finalText,
      // Consumed on success/abort; PRESERVED on error — a rebroadcast may
      // RESUME the merge and needs the pre-merge prefix (parent.text is by
      // then `original + partial`, unusable as a prefix).
      ...(status !== "error"
        ? {
            announcePrefix: undefined,
            announceReplayArmed: undefined,
            announceReplayRun: undefined,
          }
        : {}),
      liveText: undefined, // clear the legacy live field (optional → field removed)
      ...(error !== undefined ? { error } : {}),
      // Reuses the existing stable-code field (failDispatch codes live there
      // too) — the UI maps context_length/rate_limit/... to actionable labels.
      ...(errorKind !== undefined ? { errorCode: errorKind } : {}),
      updatedAt: Date.now(),
      // The FIRST terminal transition stamps the generation end. A same-status
      // re-finalize (redelivered final) or a late addPart may bump updatedAt
      // again, so the reply-duration UI reads THIS stable stamp, never
      // updatedAt (codex: duration must not grow with redeliveries).
      ...(message.finalizedAt === undefined ? { finalizedAt: Date.now() } : {}),
    });
    // Delete the live-text row WITH the lifecycle flip (same atomic mutation) so the
    // "streaming <=> row exists" invariant holds and the watchdog won't re-see it.
    if (stRow !== null) await ctx.db.delete(stRow._id);
    // A COMPLETED reply stamps the chat's `lastAssistantAt` — the single signal
    // the sidebar consumes for the arrival flash / unread dot / reply sound
    // (multi-chat UX). Deliberately NOT on error/aborted: a failed turn already
    // paints its own error card, and "ding + unread" on a failure would read as
    // "a reply arrived". `updatedAt` (bumped at turn START) keeps ordering.
    // ONLY on the INITIAL streaming→complete transition: a redelivered
    // finalize(complete) passes the idempotence guard above (same-status
    // re-finalize is supported) and must NOT re-stamp — it would resurrect the
    // unread dot / replay the cue for a reply the user already saw (codex P2).
    if (status === "complete" && message.status === "streaming") {
      await ctx.db.patch(message.chatId, { lastAssistantAt: Date.now() });
    }
    // SSE transport (Phase 1): GC the message's stream chunks (bounded + self-scheduling
    // — a long turn can accumulate hundreds). Off the lifecycle path; best-effort.
    await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
      messageId,
      // Generation isolation: an announce merge may REOPEN this message right
      // after — this GC then races the new stream and must only ever delete
      // the CLOSED generation's chunks. Bounded by SEQ (exact by
      // construction: the reopened generation continues AFTER the closed
      // one's max — see the reopen's cursor-monotony seed), never by wall
      // clock (same-millisecond writes made a time bound ambiguous).
      beforeSeq: stRow?.chunkSeq ?? 1,
    });
    // The finalized text length — never the text itself.
    const finalLen = finalText.length;
    await traceStream(ctx, {
      phase: "finalize",
      chatId: message.chatId,
      runId: message.runId,
      messageId,
      streamStatus: status,
      textLen: finalLen,
      // The class this turn failed with — filtered through the platform's non-PHI
      // ALLOWLIST. `error` can carry raw gateway text (the schema says so), and a
      // trace must never contain content: an unrecognized value is dropped, and the
      // generic class still surfaces the failure. `errorKind` is curated but goes
      // through the same gate, so one contract governs both.
      ...(() => {
        const code = errorKind ?? error ?? null;
        return code !== null &&
          (KNOWN_ERROR_CODES as readonly string[]).includes(code)
          ? { errorCode: code }
          : {};
      })(),
    });
    // GATEWAY-PREEMPTED turn (the delivery claimed the session and the gateway
    // killed this zero-content real turn): re-park the outbox row for one
    // automatic re-dispatch. BEFORE drainNextQueued so the (deleted) card and
    // the stamped row are settled when the drain reads the world; the row
    // itself stays `sent` until the delayed flip, out of this drain's reach.
    if (status === "aborted" && gatewayPreempted === true) {
      const fresh = await ctx.db.get(messageId);
      if (fresh !== null) {
        await maybeReparkPreemptedTurn(ctx, fresh, finalLen);
      }
    }
    // DROP the provider session BEFORE the drain, for the same reason the bridge clears
    // before it settles: the drain is what releases the next send, and a send that reads
    // the slot after this point must not find a session whose run may never have stopped.
    await dropUntrustedProviderSession(ctx, message.chatId, clearProviderSession);
    // The turn ended → the chat is now idle. Dispatch the next QUEUED send (if
    // any) — the engine of mid-turn message serialization (Phase 1).
    await drainNextQueued(ctx, message.chatId);

    // TRANSIENT gateway session-init conflict (errorKind minted by the bridge
    // classifier) on a ZERO-content turn → schedule the bounded auto-retry
    // (turnRetry.ts: the system does the delete+regenerate the user would do by
    // hand). AFTER drainNextQueued on purpose: if a queued follow-up just
    // drained, the chat is busy and the retry stands down (checked inside).
    if (status === "error") {
      const fresh = await ctx.db.get(messageId);
      if (fresh !== null) {
        await maybeScheduleTurnRetry(ctx, fresh, errorKind, finalLen);
      }
    }

    // L2: a finished DOCUMENTARY fetch turn → correlate the returned files back to
    // the source reply's references. Best-effort: a correlation failure must NEVER
    // break the turn lifecycle. GUARD: only correlate when THIS finalizing message is
    // the reply to the CURRENT fetch. If an earlier fetch was declared stuck + released
    // and a NEW one started, a LATE finalize of the OLD gateway run must not correlate
    // against the new fetch's rows / clear its lock. The old run's assistant message
    // was created when it streamed (before the new fetch's dispatch), so its
    // _creationTime is strictly BEFORE the current pendingFetch.createdAt.
    const chat = await ctx.db.get(message.chatId);
    // (chatFork's one-shot rehydration flag is NOT consumed here: finalize
    // over/under-approximates delivery — a Hermes WS submit-failure finalizes
    // an error row though nothing was delivered, and the stuck-stream watchdog
    // terminates rows without this mutation. The dispatch consumes it at the
    // gateway-ACK point instead: bridge.consumeForkRehydration.)
    if (
      chat?.kind === "documentary" &&
      chat.pendingFetch &&
      message._creationTime >= chat.pendingFetch.createdAt
    ) {
      try {
        await correlateDocumentaryFetch(ctx, chat, message);
      } catch (e) {
        console.error("[docfetch] correlate failed:", (e as Error)?.message ?? e);
      }
    }
    // Hybrid rehydration: a finished SUMMARIZE turn → store the reply as the target
    // chat's rolling summary. Same best-effort shape + late-finalize guard as the
    // documentary correlate above (an old released job's late reply must not
    // correlate against a NEWER job's lock).
    if (chat?.kind === "summarizer") {
      let settled = false;
      if (chat.pendingSummarize) {
        try {
          // `message` was read BEFORE this handler's finalize patch (status still
          // "streaming", text possibly stale) — re-read the FINALIZED doc, or every
          // successful summary would be misread as a failure (codex P2). The job
          // identity check (session-key nonce) lives INSIDE correlateSummarize.
          const finalized = await ctx.db.get(message._id);
          if (finalized) {
            settled = await correlateSummarize(ctx, chat, finalized);
          }
        } catch (e) {
          console.error("[chatsum] correlate failed:", (e as Error)?.message ?? e);
        }
      }
      if (!settled) {
        // A LATE/FOREIGN reply that settled nothing (released job, or an old
        // cancelled job's reply arriving under a NEWER lock): it may hold a summary
        // of deleted content and no correlate will ever sweep it — schedule the
        // settled-rows cleanup (its internal guard protects a live job's rows).
        await ctx.scheduler.runAfter(
          0,
          internal.chatSummaries.cleanupSummarizerChat,
          { hiddenChatId: chat._id },
        );
      }
    }
    // Agent-file curation: a finished CURATOR turn → extract+validate the reply
    // into a PROPOSED revision (never a live write). Same best-effort shape +
    // FINALIZED re-read + nonce identity guard as the summarizer correlate above.
    if (chat?.kind === "curator") {
      let settled = false;
      if (chat.pendingCurate) {
        try {
          const finalized = await ctx.db.get(message._id);
          if (finalized) {
            settled = await correlateCuration(ctx, chat, finalized);
          }
        } catch (e) {
          console.error("[curation] correlate failed:", (e as Error)?.message ?? e);
        }
      }
      if (!settled) {
        // A LATE/FOREIGN reply that settled nothing (released/stuck job, or a
        // stale nonce): it holds a COPY of the agent file — sweep the hidden
        // chat's rows or it lingers indefinitely (codex P2; summarizer twin).
        await ctx.scheduler.runAfter(
          0,
          internal.agentFileCuration.cleanupCuratorChat,
          { hiddenChatId: chat._id },
        );
      }
    }
    // Document conversion: a finished CONVERTER turn → the delivered PDF becomes
    // the source file's rendition (ready), else the rendition fails. Same
    // best-effort shape + FINALIZED re-read as the correlations above.
    if (chat?.kind === "converter") {
      if (chat.pendingConvert) {
        try {
          const finalized = await ctx.db.get(message._id);
          if (finalized) {
            await correlateConversion(ctx, chat, finalized);
          }
        } catch (e) {
          console.error("[convert] correlate failed:", (e as Error)?.message ?? e);
        }
      }
    }
    // Hybrid rehydration: a REGULAR chat's finished turn may have accumulated enough
    // new content for a summarize job — check OUTSIDE this transaction (scheduled,
    // fire-and-forget; every guard in maybeScheduleSummarize fails quiet).
    if (chat && chat.kind === undefined) {
      await ctx.scheduler.runAfter(
        0,
        internal.chatSummaries.maybeScheduleSummarize,
        { chatId: chat._id },
      );
    }
    // The terminal transition really happened on THIS call (see the no-op returns
    // above): the ingest route traces only this case.
    return { transitioned: true as const };
  },
});

// Mirror the gateway's `sessions.describe` onto the chat so the header strip can
// surface the model / reasoning level / context meter (CHAT_UX_DESIGN Part 2.1).
// The bridge calls this (via the ingest httpAction) when it learns a turn's
// session meta. INTERNAL (not browser-callable). All fields optional + stamped
// with `updatedAt` — never holds secrets (model/level names are non-sensitive).
/**
 * Record the compaction VERDICT on the chat (G-08).
 *
 * A compaction that failed for good means the session never shrank: the next
 * turn is very likely to hit the context wall, and the counters the gauge shows
 * can look perfectly comfortable meanwhile. Persisted on the chat because it has
 * to PRE-ANNOUNCE the next turn — it deliberately outlives the turn that
 * observed it, and only a compaction that actually completed clears it.
 */
/**
 * Drop the session-scoped context state after the gateway session was ACTUALLY
 * replaced (G-08). Called from the reset ACTION's success path, never from the
 * mutation that schedules it: the bridge refuses a reset when a turn went live
 * in the schedule→execute window, and clearing eagerly would show a fresh,
 * un-warned session while the gateway still held the old, overfull one.
 */
export const clearSessionStateAfterReset = internalMutation({
  args: {
    chatId: v.id("chats"),
    /** When the reset was DISPATCHED. Anything observed at or after it belongs
     *  to the session that came next, not the one being cleared (codex P2): the
     *  panel does not reserve the chat, so a user can send — and that turn can
     *  write fresh meta — between the reset POST and this cleanup. */
    resetStartedAt: v.number(),
    /** When the gateway CONFIRMED the reset. The two instants answer different
     *  questions and a single one cannot do both (codex P2): what to KEEP is
     *  decided by the dispatch time (protecting the new session's early writes),
     *  while the FENCE against later stragglers must sit at the completion —
     *  a background compaction of the OLD session can be received anywhere in
     *  between. Defaults to the dispatch time for an older caller. */
    resetCompletedAt: v.optional(v.number()),
    ...boundArg,
  },
  handler: async (
    ctx,
    { chatId, resetStartedAt, resetCompletedAt, boundInstanceName },
  ) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    await assertChatBound(ctx, chatId, boundInstanceName);
    const {
      // The compaction verdict…
      sessionOverfull,
      sessionOverfullAt,
      // …and every SESSION-DEPENDENT context measure with it: the warning also
      // fires when the gateway's own estimate exceeds its budget, and those
      // numbers describe the session that no longer exists. Kept, they would go
      // on saying "this no longer fits" about an empty session until the next
      // send refreshes them. Same set the fork drops.
      estimatedPromptTokens,
      promptBudgetBeforeReserve,
      overflowTokens,
      estimateAt,
      totalTokens,
      totalTokensFresh,
      activeTokens,
      activeTokensAt,
      estimatedCostUsd,
      // SESSION-SCOPED COUNTERS, and the reset is exactly where they must go. They are
      // floored by their own previous value in `setSessionMeta` — a deliberate guard
      // against out-of-order terminals — so leaving them here meant the NEW session's low
      // count stayed capped by the old session's maximum, and its compactions produced no
      // marker until it overtook a tally that no longer describes anything (raised in
      // review). The watermark goes with them: a fence that outlived its counters would
      // reject the new session's first reading as stale.
      compactionCount,
      apiCalls,
      contextPercent,
      activeSubagents,
      terminalFactsAt,
      ...rest
    } = chat.sessionMeta ?? {};
    void compactionCount;
    void apiCalls;
    void contextPercent;
    void activeSubagents;
    void terminalFactsAt;
    void sessionOverfull;
    void sessionOverfullAt;
    void estimatedPromptTokens;
    void promptBudgetBeforeReserve;
    void overflowTokens;
    void estimateAt;
    void totalTokens;
    void totalTokensFresh;
    void activeTokens;
    void activeTokensAt;
    // …but a value the NEXT session already wrote is kept: only what predates
    // the reset is dropped.
    const estimateIsNewer =
      estimateAt !== undefined && estimateAt >= resetStartedAt;
    const usageIsNewer =
      activeTokensAt !== undefined && activeTokensAt >= resetStartedAt;
    // The VERDICT is judged against the COMPLETION bound, the measures against
    // the DISPATCH one — deliberately different (codex P2). A verdict that
    // landed while the reset was in flight almost certainly belongs to the old
    // session, and a false "this no longer fits" is worse than a missing one:
    // the next compaction re-raises it. A missing GAUGE, by contrast, is worse
    // than a briefly stale one, and it self-heals on the next describe.
    const resetSettledAt = resetCompletedAt ?? resetStartedAt;
    const verdictIsNewer =
      sessionOverfullAt !== undefined && sessionOverfullAt > resetSettledAt;
    if (!estimateIsNewer) {
      void estimatedPromptTokens;
      void promptBudgetBeforeReserve;
      void overflowTokens;
      void estimateAt;
      void totalTokens;
      void totalTokensFresh;
      void estimatedCostUsd;
    }
    // The fence is stamped even when no verdict stood: a compaction event of the
    // OLD session may already be in flight, and it must not warn the new one.
    // Anchored at the reset's DISPATCH, the same instant the keeps compare to.
    await ctx.db.patch(chatId, {
      sessionMeta: {
        ...rest,
        ...(estimateIsNewer
          ? {
              ...(estimatedPromptTokens !== undefined
                ? { estimatedPromptTokens }
                : {}),
              ...(promptBudgetBeforeReserve !== undefined
                ? { promptBudgetBeforeReserve }
                : {}),
              ...(overflowTokens !== undefined ? { overflowTokens } : {}),
              estimateAt,
              // The COUNTERS come from the same describe as the estimate above
              // (codex P2): kept apart, the new session would show a fresh
              // estimate with no counter and no cost until the next refresh.
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              ...(totalTokensFresh !== undefined ? { totalTokensFresh } : {}),
              ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
            }
          : {}),
        ...(usageIsNewer ? { activeTokens, activeTokensAt } : {}),
        ...(verdictIsNewer
          ? { sessionOverfull, sessionOverfullAt }
          : {}),
        // The fence only ever MOVES FORWARD (codex P2): two resets can settle out
        // of order, and letting the older one overwrite the newer fence would
        // re-open the window for a verdict observed in between.
        sessionResetAt: Math.max(
          resetCompletedAt ?? resetStartedAt,
          chat.sessionMeta?.sessionResetAt ?? 0,
        ),
      },
    });
  },
});

export const setSessionOverfull = internalMutation({
  args: {
    chatId: v.id("chats"),
    overfull: v.boolean(),
    /** Bridge observation time — the fence against a verdict observed BEFORE a
     *  session reset (codex P2). Absent on an older bridge: unfenced, as before. */
    observedAt: v.optional(v.number()),
    ...boundArg,
  },
  handler: async (ctx, { chatId, overfull, observedAt, boundInstanceName }) => {
    // A chat deleted between the HTTP authorization and this late POST is a
    // NO-OP, exactly like setSessionMeta — never a 403 (codex P3):
    // `chatAllowsInstance` returns false for a missing chat, so asserting first
    // turned a benign late compaction event into an authorization failure.
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    await assertChatBound(ctx, chatId, boundInstanceName);
    const meta = chat.sessionMeta ?? {};
    // ORDERED BY OBSERVATION, in BOTH directions (codex P2). Verdicts travel as
    // independent fire-and-forget POSTs, so a stale one can land after a fresher
    // one — and a stale `false` erasing a real warning is exactly as wrong as a
    // stale `true` raising a false one. The watermark is the later of the last
    // applied verdict and the last session RESET (a verdict observed before the
    // reset describes the session the user threw away).
    if (beforeSessionReset(observedAt, meta.sessionResetAt)) return;
    const watermark = meta.sessionOverfullAt ?? 0;
    if (observedAt !== undefined && watermark > 0 && observedAt < watermark) {
      return;
    }
    if ((meta.sessionOverfull ?? false) === overfull) {
      // Same verdict: no display churn, but the WATERMARK still advances (codex
      // P2). Skipping it would leave the first all-clear unstamped, and an older
      // failure POST arriving afterwards — the exact reordering this guards
      // against — would then be accepted and re-raise the warning.
      if (observedAt !== undefined && observedAt > watermark) {
        await ctx.db.patch(chatId, {
          sessionMeta: { ...meta, sessionOverfullAt: observedAt },
        });
      }
      return;
    }
    await ctx.db.patch(chatId, {
      sessionMeta: {
        ...meta,
        sessionOverfull: overfull,
        // The watermark of the APPLIED verdict, whatever its value: recording it
        // only on a raise would leave a clear unordered.
        sessionOverfullAt: observedAt ?? Date.now(),
      },
    });
  },
});

export const setSessionMeta = internalMutation({
  args: {
    chatId: v.id("chats"),
    ...boundArg,
    meta: v.object({
      model: v.optional(v.string()),
      modelProvider: v.optional(v.string()),
      agentRuntime: v.optional(v.string()),
      thinkingLevel: v.optional(v.string()),
      thinkingDefault: v.optional(v.string()),
      thinkingLevels: v.optional(
        v.array(v.object({ id: v.string(), label: v.string() })),
      ),
      availableModels: v.optional(
        v.array(v.object({ id: v.string(), label: v.string() })),
      ),
      verboseLevel: v.optional(v.string()),
      totalTokens: v.optional(v.number()),
      contextTokens: v.optional(v.number()),
      estimatedCostUsd: v.optional(v.number()),
      // Honest-gauge inputs (see schema): the freshness flag for the counter
      // above, and the gateway's own pre-prompt budget assessment. All optional
      // and additive — an older bridge simply never sends them.
      totalTokensFresh: v.optional(v.boolean()),
      estimatedPromptTokens: v.optional(v.number()),
      promptBudgetBeforeReserve: v.optional(v.number()),
      overflowTokens: v.optional(v.number()),
      // Hermes reports these on its terminal and Atrium used to drop them. The gauge is
      // the user-visible consequence: a compaction the thread never mentions, and an
      // occupancy figure the gateway computed that nobody compared with ours.
      compactionCount: v.optional(v.number()),
      contextPercent: v.optional(v.number()),
      activeSubagents: v.optional(v.number()),
      apiCalls: v.optional(v.number()),
      observedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { chatId, meta, boundInstanceName }) => {
    // A chat deleted between the gateway event and this POST stays a NO-OP
    // (the pre-existing contract) — never a 403 (codex P2).
    if ((await ctx.db.get(chatId)) === null) return;
    // ATOMIC cross-gateway barrier.
    await assertChatBound(ctx, chatId, boundInstanceName);
    const chat = await ctx.db.get(chatId);
    if (chat === null) return; // chat gone (e.g. deleted mid-turn) — nothing to do
    // Preserve the bridge's per-turn activeTokens stamp across sessions.get
    // refreshes — UNLESS this refresh, OBSERVED AFTER the stamp, describes a
    // NEW session: its cumulative counter FELL below the previous values, or
    // it carries no counter at all (a fresh session's describe legitimately
    // omits usage). Snapshots and stamps travel as independent
    // fire-and-forget POSTs, so a PRE-turn snapshot landing late must never
    // outrank the newer stamp (codex P2 ×2): ordering comes from the
    // bridge-stamped observedAt; a legacy snapshot without one only drops
    // the stamp on the conservative counter-fell signal.
    const { observedAt: metaAt, ...metaRest } = meta;
    const prev = chat.sessionMeta;
    // RESET FENCE (codex P2): a describe snapshot OBSERVED BEFORE the user reset
    // this conversation describes the session they threw away. Landing after the
    // reset it would restore the old estimate and budget — and immediately
    // re-raise the "no longer fits" warning on a brand-new, empty session.
    if (beforeSessionReset(metaAt, prev?.sessionResetAt)) return;
    const stampAt = prev?.activeTokensAt;
    const metaIsNewer =
      metaAt !== undefined && (stampAt === undefined || metaAt > stampAt);
    const counterFell =
      meta.totalTokens != null &&
      ((prev?.totalTokens != null && meta.totalTokens < prev.totalTokens) ||
        (prev?.activeTokens != null && meta.totalTokens < prev.activeTokens));
    const dropStamp =
      metaAt !== undefined
        ? metaIsNewer && (counterFell || meta.totalTokens == null)
        : counterFell;
    const keepActive =
      prev?.activeTokens !== undefined && !dropStamp
        ? {
            activeTokens: prev.activeTokens,
            ...(prev.activeTokensAt !== undefined
              ? { activeTokensAt: prev.activeTokensAt }
              : {}),
          }
        : dropStamp && metaAt !== undefined
          ? // The stamp is CLEARED but its watermark survives at the
            // snapshot's observation time: a stale end-of-turn POST from the
            // DEAD session still in flight (observedAt < metaAt) must keep
            // losing the ordering check — without this it would resurrect
            // the old session's fill (codex P2).
            { activeTokensAt: metaAt }
          : prev?.activeTokensAt !== undefined
            ? // No active value to carry, but a watermark exists (a prior
              // drop, or a stampless refresh after one): it must survive
              // EVERY later snapshot until a fresh active observation
              // replaces it — dropping it here would re-admit the dead
              // session's in-flight POST one refresh later (codex P2).
              {
                activeTokensAt:
                  metaAt !== undefined && metaAt > prev.activeTokensAt
                    ? metaAt
                    : prev.activeTokensAt,
              }
            : {};
    // BUDGET-ESTIMATE ordering (codex P1). Both writers are fire-and-forget, so
    // an OLDER describe can land after a newer one: accept the incoming estimate
    // only when its observation time is at least as recent as the stored
    // watermark, otherwise keep what we have. With no timestamps on either side
    // the incoming snapshot wins (the historic behavior).
    const prevEstimateAt = prev?.estimateAt;
    const estimateIsStale =
      metaAt !== undefined &&
      prevEstimateAt !== undefined &&
      metaAt < prevEstimateAt;
    // The keys are ALWAYS present in this object (possibly as `undefined`, which
    // Convex stores as "absent") so they OVERRIDE whatever `metaRest` carries: a
    // stale snapshot brings its own estimate along, and re-adding the stored one
    // without overwriting the incoming one would let the stale figure through.
    const estimateFields = estimateIsStale
      ? {
          // Older snapshot: keep the stored assessment (and its watermark).
          estimatedPromptTokens: prev?.estimatedPromptTokens,
          promptBudgetBeforeReserve: prev?.promptBudgetBeforeReserve,
          overflowTokens: prev?.overflowTokens,
          estimateAt: prevEstimateAt,
          // The whole DESCRIBE-SOURCED block obeys this watermark as one unit
          // (codex P2): the freshness flag, and the counters it QUALIFIES. Keeping
          // the flag while letting `metaRest` write the stale snapshot's counter
          // would pair a recent "this is fresh" with an old number — a subtler
          // version of the very defect this lot removes.
          totalTokensFresh: prev?.totalTokensFresh,
          totalTokens: prev?.totalTokens,
          contextTokens: prev?.contextTokens,
        }
      : {
          // Current snapshot wins: its estimate fields (or their ABSENCE, which is
          // itself information — the gateway's pre-prompt check did not run, or a
          // compaction/model change cleared it) come from `metaRest`.
          // The watermark is kept even for an ABSENCE (codex P2): sessionMeta is
          // replaced wholesale, so dropping it would let an OLDER in-flight
          // snapshot that still carried an estimate be accepted afterwards and
          // resurrect a stale gauge. A recent "there is no estimate" must be able
          // to win the ordering too.
          ...(metaAt !== undefined ? { estimateAt: metaAt } : {}),
        };
    // TERMINAL FACTS, ordered and monotonic (G-50, raised in review).
    //
    // These four arrive on a turn's TERMINAL, off the ordered chain and un-awaited, so two
    // reports can land inverted. Without a guard that walks `compactionCount` BACKWARDS —
    // a session that compacted three times reported as having compacted twice — which is
    // worse than not recording it at all, because it reads as authoritative.
    //
    // Two different kinds of fact, so two different rules:
    //  * `compactionCount` / `apiCalls` are CUMULATIVE for the session: they can only
    //    grow, so the floor is the previous value and no clock is needed.
    //  * `contextPercent` / `activeSubagents` are POINT-IN-TIME: they legitimately fall,
    //    so they take the observation watermark instead.
    const prevFacts = prev ?? {};
    const monotonic = <K extends "compactionCount" | "apiCalls">(k: K) => {
      const incoming = (metaRest as Record<string, unknown>)[k];
      const before = (prevFacts as Record<string, unknown>)[k];
      if (typeof incoming !== "number") {
        return before !== undefined ? { [k]: before } : {};
      }
      return { [k]: typeof before === "number" ? Math.max(before, incoming) : incoming };
    };
    const factsAt = prevFacts.terminalFactsAt;
    const staleFacts =
      metaAt !== undefined && factsAt !== undefined && metaAt < factsAt;
    const pointInTime = <K extends "contextPercent" | "activeSubagents">(k: K) => {
      // An older report keeps whatever the fresher one established.
      const before = (prevFacts as Record<string, unknown>)[k];
      const incoming = (metaRest as Record<string, unknown>)[k];
      if (staleFacts) return before !== undefined ? { [k]: before } : {};
      if (incoming !== undefined) return { [k]: incoming };
      return before !== undefined ? { [k]: before } : {};
    };
    const terminalFacts = {
      ...monotonic("compactionCount"),
      ...monotonic("apiCalls"),
      ...pointInTime("contextPercent"),
      ...pointInTime("activeSubagents"),
      // Kept even when this report carried none, for the same reason the estimate
      // watermark is: a later ABSENCE must still be able to win the ordering.
      ...(metaAt !== undefined && !staleFacts
        ? { terminalFactsAt: metaAt }
        : factsAt !== undefined
          ? { terminalFactsAt: factsAt }
          : {}),
    };
    // A RISE in the compaction count is a compaction the thread must SHOW. This is the
    // whole reason the count is worth reading: Atrium's live marker rides a
    // `status.update` that upstream broadcasts `dropIfSlow`, so a slow consumer never
    // learns the session forgot half its history. Storing the number without acting on it
    // would have been the same mistake as saving text nobody renders.
    const before = (prevFacts as { compactionCount?: number }).compactionCount;
    const after = (terminalFacts as { compactionCount?: number }).compactionCount;
    if (
      typeof after === "number" &&
      typeof before === "number" &&
      after > before
    ) {
      await noteCountedCompactions(ctx, chatId, after - before);
    }
    await ctx.db.patch(chatId, {
      sessionMeta: {
        ...metaRest,
        ...keepActive,
        ...estimateFields,
        ...terminalFacts,
        // The compaction VERDICT belongs to setSessionOverfull and to nothing
        // else: this meta refresh rebuilds the object from scratch, so without
        // carrying it forward an ordinary describe (every send) would erase the
        // warning right before the turn it exists to pre-announce (codex P2).
        ...(prev?.sessionOverfull !== undefined
          ? { sessionOverfull: prev.sessionOverfull }
          : {}),
        // The WATERMARK travels independently of the verdict (codex P2): the
        // first all-clear stamps a watermark while leaving `sessionOverfull`
        // absent, and dropping it here would let an older `true` POST arrive
        // afterwards against a zero watermark and re-raise the warning the
        // fresher verdict had just cleared.
        ...(prev?.sessionOverfullAt !== undefined
          ? { sessionOverfullAt: prev.sessionOverfullAt }
          : {}),
        // …and the reset FENCE with it: dropped, a late verdict from the old
        // session would be admitted on the very next refresh.
        ...(prev?.sessionResetAt !== undefined
          ? { sessionResetAt: prev.sessionResetAt }
          : {}),
        updatedAt: Date.now(),
      },
    });
  },
});

/** Per-turn REAL window usage (the bridge's post-usage snapshot at turn end):
 *  merged into sessionMeta so the context gauge shows the window fill, not
 *  the session-cumulative counter (859% prod report). */
export const setSessionActiveTokens = internalMutation({
  args: {
    chatId: v.id("chats"),
    ...boundArg,
    activeTokens: v.number(),
    // Bridge observation time: fire-and-forget POSTs of two rapid turns can
    // land out of order — the stale one must lose (codex P2).
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, { chatId, activeTokens, observedAt, boundInstanceName }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    // ATOMIC cross-gateway barrier.
    await assertChatBound(ctx, chatId, boundInstanceName);
    const prevAt = chat.sessionMeta?.activeTokensAt;
    if (observedAt !== undefined && prevAt !== undefined && observedAt <= prevAt) {
      return; // an older observation arriving late must not overwrite
    }
    // RESET FENCE (codex P2), same rule as setSessionMeta: a measure of the
    // session the user just threw away must not describe the fresh one.
    if (beforeSessionReset(observedAt, chat.sessionMeta?.sessionResetAt)) return;
    // The pre-prompt ESTIMATE describes the turn that was about to run — this
    // write is the MEASURE of the turn that just finished, so it supersedes it.
    // Leaving the estimate in place would pin the gauge to a stale pre-turn figure
    // for the rest of the session, exactly after a big message or a long reply
    // (codex P1). The next `sessions.describe` re-supplies a current estimate.
    // The pre-prompt ESTIMATE describes the turn that was about to run; this write
    // is the MEASURE of the turn that just finished, so it supersedes it. Leaving
    // it in place would pin the gauge to a stale pre-turn figure for the rest of
    // the session, right after a big message or a long reply.
    // …but ONLY when this measure is the more recent of the two. The usage
    // watermark does not settle this on its own: a describe whose counter did not
    // fall CARRIES THE PREVIOUS stamp forward (see `keepActive` in
    // `setSessionMeta`) rather than advancing it to its own observation time, so
    // from the second turn on a late post-turn POST clears the ordering check and
    // would erase the estimate a NEWER describe had just written — pinning the
    // gauge to a pre-compaction figure exactly when an overflow is brewing (codex
    // P1). The estimate keeps its own clock, so compare against that clock.
    const estimateSurvives =
      observedAt !== undefined &&
      chat.sessionMeta?.estimateAt !== undefined &&
      chat.sessionMeta.estimateAt > observedAt;
    const {
      estimatedPromptTokens: _staleEstimate,
      promptBudgetBeforeReserve: _staleBudget,
      overflowTokens: _staleOverflow,
      estimateAt: _previousEstimateAt,
      ...metaWithoutEstimate
    } = chat.sessionMeta ?? {};
    // The clear ADVANCES the watermark instead of dropping it (codex P1): a
    // describe delayed past this write would otherwise look current and
    // resurrect the estimate we just superseded. Keep the later of the two.
    const clearedEstimateAt =
      observedAt !== undefined
        ? _previousEstimateAt !== undefined && _previousEstimateAt > observedAt
          ? _previousEstimateAt
          : observedAt
        : _previousEstimateAt;
    await ctx.db.patch(chatId, {
      sessionMeta: {
        ...metaWithoutEstimate,
        // A newer describe's assessment outlives this older measure; the measure
        // itself still lands (it is real, and the gauge prefers the estimate).
        ...(estimateSurvives
          ? {
              estimatedPromptTokens: _staleEstimate,
              promptBudgetBeforeReserve: _staleBudget,
              overflowTokens: _staleOverflow,
            }
          : {}),
        activeTokens,
        ...(observedAt !== undefined ? { activeTokensAt: observedAt } : {}),
        ...(clearedEstimateAt !== undefined
          ? { estimateAt: clearedEstimateAt }
          : {}),
        updatedAt: Date.now(),
      },
    });
  },
});

// SESSION RE-HYDRATION (see docs/SESSION_CONTINUITY_DESIGN.md + #61 follow-up).
// OpenClaw sessions are ephemeral (daily/idle reset, compaction); our webchat
// displays the FULL conversation. When the bridge detects a FRESH/rolled OpenClaw
// session (`sessions.describe.session.systemSent === false`) it asks for this
// bounded, display-of-prior-turns block and PREPENDS it to the new `chat.send`
// message — so the model's context matches what the user sees. We are the source
// of truth for the conversation; this re-grounds the gateway from it.
//
// V1 is TEXT-ONLY: earlier image/file turns survive only as their text trace
// (filenames/captions), not re-uploaded media — an accepted v1 cut.
//
// Budget: bounded by the chat's known context window (`sessionMeta.contextTokens`)
// minus a reserve, keeping the MOST RECENT turns (older turns dropped with a
// notice). Only `complete` user/assistant turns with text are included; the
// current turn (`excludeMessageId`) and streaming/empty rows are skipped.
export const rehydrationContext = internalQuery({
  args: {
    chatId: v.id("chats"),
    excludeMessageId: v.optional(v.id("messages")),
    ...boundArg,
  },
  handler: async (
    ctx,
    { chatId, excludeMessageId, boundInstanceName },
  ): Promise<{
    history: string | null;
    turnCount: number;
    // Additive (hybrid rehydration): content-free counters for the bridge's
    // `openclaw.rehydrate` trace. Older bridges ignore them.
    summaryUsed: boolean;
    summaryChars: number;
  }> => {
    // Cross-gateway READ barrier: the rebuilt history is chat CONTENT — only
    // an instance allowed to write this chat may read it for rehydration.
    if (boundInstanceName !== undefined) {
      if (!(await chatAllowsInstance(ctx, chatId, boundInstanceName))) {
        throw new Error(CROSS_INSTANCE);
      }
    }
    const empty = {
      history: null,
      turnCount: 0,
      summaryUsed: false,
      summaryChars: 0,
    };
    const chat = await ctx.db.get(chatId);
    if (chat === null) return empty;

    // History is everything LOGICALLY BEFORE the current turn (see lib/messageOrder).
    // Ordering by raw _creationTime is wrong here: a mid-turn QUEUE follow-up inserted
    // in the pending-pre-ack window has a _creationTime EARLIER than the in-flight
    // turn's assistant reply. compareOrder (orderTime, tie-broken by _creationTime)
    // sorts a queued follow-up correctly, and "strictly before the CURRENT turn" both
    // KEEPS the prior assistant and EXCLUDES still-queued later follow-ups.
    const current = excludeMessageId ? await ctx.db.get(excludeMessageId) : null;

    // Budget: the legacy window-derived formula (50% of the window, ~3 chars/token)
    // BOUNDED by the hard ceiling — a large-window model must not re-ingest hundreds
    // of kilochars of raw history on every cold start. The rolling summary (below)
    // carries the older conversation instead (docs/design/hybrid-rehydration.md).
    const windowTokens = chat.sessionMeta?.contextTokens ?? 32_000;
    const budgetChars = rehydrationBudgetChars(windowTokens);

    // Rolling summary (maintained asynchronously by chatSummaries.ts). An empty
    // summary string = reset/none. The verbatim tail starts AFTER its watermark so
    // summarized turns are never re-sent raw. NOTE: the history_summary INJECTION
    // toggle only shapes the summarizer PROMPT (dedicated agents carry their own
    // briefing) — it never gates using a stored summary here; the FEATURE switch is
    // the instance `rehydration` config, which gates this whole query's caller.
    const summaryRow = await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    const hasSummary = summaryRow !== null && summaryRow.summary.length > 0;
    const watermark = hasSummary ? summaryRow.watermarkOrderTime : 0;

    // Bounded tail read by _creationTime (valid: an orderTime-bearing row has a recent
    // _creationTime), then keep usable PRIOR turns in LOGICAL order within budget.
    const TAIL_READ = 80;
    // Read ONE extra row: a chat of exactly TAIL_READ messages must not be flagged
    // as clipped (a false "omitted" marker misinforms the agent — codex P3).
    const recentProbe = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(TAIL_READ + 1);
    // Drop the CURRENT turn's row BEFORE judging the clip: with exactly TAIL_READ
    // prior turns + the current send, the probe returns 81 rows of which only 80
    // are history — slicing first would evict the oldest prior turn AND render a
    // false gap marker (codex P3).
    const priorProbe = recentProbe.filter(
      (m) => !(excludeMessageId && m._id === excludeMessageId),
    );
    // Judge the clip on UNCOVERED rows only: a summary-covered bonus row is already
    // represented by the summary, not omitted — counting it would render a false
    // gap marker at exactly TAIL_READ uncovered turns (codex P3). The watermark is
    // a single boundary on a newest-first read, so once the probe reaches covered
    // territory everything older is covered too — no false negative.
    const uncoveredProbe = priorProbe.filter(
      (m) => effectiveOrder(m) > watermark,
    );
    const clippedByRead = uncoveredProbe.length > TAIL_READ;
    const recent = clippedByRead
      ? uncoveredProbe.slice(0, TAIL_READ)
      : uncoveredProbe;
    // Sub-agent results anchored to a turn ARE its content (a sessions_spawn
    // turn's parent text is often EMPTY — without this join, a session reset
    // loses the sub-agent-produced answers entirely). One bounded read.
    // Content locale (instance override -> admin default -> base): the language
    // of the framing strings AND the sub-agent digest labels — same locale as
    // the prompt injections. On a PER-TURN ROUTED chat the current message
    // carries the ROUTED instance (getChatRouting sends the injections for that
    // instance) — the history block must follow the SAME instance, not the
    // chat's primary (codex P2: a routed turn otherwise mixed languages).
    const rehydInstanceName =
      (current?.routedInstanceName ?? chat?.instanceName) || null;
    const rehydInstance = rehydInstanceName
      ? await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", rehydInstanceName))
          .first()
      : null;
    const contentLocale = await contentLocaleForInstance(
      ctx,
      rehydInstance?.config,
    );
    const childResults = await loadChildResults(ctx, chatId, contentLocale);
    const usableDesc = recent
      .filter((m) => current === null || compareOrder(m, current) < 0) // strictly before the current turn
      .filter(
        (m) =>
          m.status === "complete" &&
          (m.role === "user" || m.role === "assistant") &&
          // A quoted excerpt IS content: an attachment-only quoted turn has an
          // empty text but its dispatched prompt carried the quote (codex P2).
          (m.text.trim().length > 0 ||
            m.quotedExcerpt !== undefined ||
            (childResults.byMsg.get(m._id as string)?.length ?? 0) > 0),
      )
      .filter((m) => effectiveOrder(m) > watermark) // summary-covered turns stay summarized
      .sort((a, b) => compareOrder(b, a)); // newest logical first, for the budget walk

    // The bounded read may hide messages between the summary coverage (or the chat
    // start) and the oldest row read — surface that as an honest omission marker.
    const oldestRead = recent[recent.length - 1];
    const readWindowClipped =
      clippedByRead &&
      (oldestRead ? effectiveOrder(oldestRead) > watermark : false);

    const composed = composeRehydration({
      locale: contentLocale,
      turns: usableDesc
        .slice()
        .reverse()
        .map((m) => ({
          role: m.role as "user" | "assistant",
          // QUOTE-REPLY: a user turn that replied to a block re-carries the
          // same preamble the dispatch sent (resolved for the SAME instance/
          // locale as the injections above) — the rebuilt history reads like
          // the original prompt. NOTE: a template edited since the original
          // send recomposes with the NEW wording (accepted, documented).
          text:
            m.role === "user" && m.quotedExcerpt
              ? composeQuotedText(
                  quotePreamble(
                    m.quotedExcerpt,
                    rehydInstance?.config?.promptInjections,
                    contentLocale,
                  ),
                  enrichedTurnText(m, childResults),
                )
              : enrichedTurnText(m, childResults),
        })),
      summary: hasSummary
        ? { text: summaryRow.summary, coveredCount: summaryRow.coveredCount }
        : null,
      readWindowClipped,
      budgetChars,
    });
    return {
      history: composed.history,
      turnCount: composed.turnCount,
      summaryUsed: composed.summaryUsed,
      summaryChars: composed.summaryChars,
    };
  },
});
