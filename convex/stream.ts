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
    phase: "start" | "finalize";
    chatId: Id<"chats">;
    runId: string | undefined;
    messageId: Id<"messages">;
    streamStatus: "streaming" | "complete" | "error" | "aborted";
    textLen?: number;
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
  },
  handler: async (ctx, { chatId, runId, turnSessionKey }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      throw new Error("startAssistant: chat not found");
    }
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
      }
      const merge = await reopenParentForAnnounce(ctx, chatId, runId, now);
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
      role: "assistant",
      runId,
      status: "streaming",
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
  // RESUME reuses the ORIGINAL prefix preserved by the failed finalize —
  // parent.text at this point is `original + partial announce`, and
  // re-prefixing with THAT would duplicate the partial fragment.
  const prefix = resuming ? (parent.announcePrefix ?? "") : parent.text;
  await ctx.db.patch(parentId, {
    status: "streaming",
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
      text: seedText,
      updatedAt: now,
      ...(lastChunk !== null || seedText !== "" ? { chunkSeq: nextSeq } : {}),
    });
  } else {
    // A stray leftover row: re-own it for the announce generation, or the
    // merge's own deltas would fail the generation guard and drop.
    await ctx.db.patch(existing._id, {
      generation: announceRunId,
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
const TURN_PHASES = new Set([
  "processing_history",
  "compacting",
  "querying_gateway",
  "awaiting_subagents",
]);

export const setPhase = internalMutation({
  args: {
    messageId: v.id("messages"),
    phase: v.string(),
    // Generation guard (see appendDelta): a delayed phase write from a run
    // that no longer owns this message must not touch (nor heartbeat) the
    // reopened stream.
    expectedRunId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { messageId, phase, expectedRunId }) => {
    if (!TURN_PHASES.has(phase)) return; // unknown value: ignore, never throw
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
    // Heartbeat (updatedAt) ONLY for phases that prove REAL gateway activity.
    // querying_gateway is the bridge's own doubt about a silent turn — bumping
    // the watchdog there would let a bridge death during the recovery leave the
    // stream stuck ~12 extra minutes (codex P2).
    if (phase === "querying_gateway") {
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
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const row = await streamingRow(ctx, messageId);
    if (row === null) return;
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
    // Generation guard (see appendDelta): a snapshot from a run that no
    // longer owns this message drops silently.
    if (
      expectedRunId !== undefined &&
      (message.runId ?? null) !== expectedRunId
    ) {
      return;
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
      if (message.status !== "streaming") return;
      seq = 1; // 1-based: a fresh SSE cursor of 0 reads from the first chunk (seq > 0)
      streamRowId = await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
        userId: message.userId,
        generation: message.runId ?? null,
        text,
        updatedAt: now,
        chunkSeq: 2,
      });
      chatId = message.chatId;
    } else {
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
  },
  handler: async (ctx, { messageId, part, expectedRunId }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("addPart: message not found");
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
      return;
    }
    // Heartbeat: a turn streaming ONLY tool/media/reasoning parts (no text deltas)
    // must still refresh its live-text row, else the watchdog (which keys off that
    // row's updatedAt) would reap an actively-working turn as stuck. Bump if present;
    // create (preserving any legacy liveText) for a pre-deploy/race message with no
    // row yet. Does NOT touch the message doc — loadChatView re-runs on the part
    // INSERT below (the parts changed) regardless, so no extra per-text-delta churn.
    if (message.status === "streaming") {
      const liveRow = await streamingRow(ctx, messageId);
      if (liveRow !== null) {
        await ctx.db.patch(liveRow._id, { updatedAt: Date.now() });
      } else {
        await ctx.db.insert("streamingText", {
          messageId,
          chatId: message.chatId,
          userId: message.userId,
          generation: message.runId ?? null,
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
    const order = existing.length;
    const announceRun = replayArmed
      ? (message.announceReplayRun ?? message.runId)
      : message.runId !== undefined && deliveryChildKey(message.runId) !== null
        ? message.runId
        : undefined;
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
  },
  handler: async (
    ctx,
    { messageId, status, text, error, errorKind, expectedRunId },
  ) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("finalize: message not found");
    }
    if (
      expectedRunId !== undefined &&
      (message.runId ?? null) !== expectedRunId
    ) {
      console.log(
        "[stream] finalize skipped: message re-owned by another run (announce merge)",
      );
      return;
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
      return;
    }
    // A2: write the authoritative final text into the searchable/indexed `text`
    // ONCE here, and CLEAR `liveText` (so listByChat now reads `text`). Prefer the
    // normalizer's final text; fall back to whatever streamed into `liveText` (so
    // a final with no explicit text never wipes a streamed reply).
    // The live text now lives in the streamingText row; `message.liveText` is only
    // a fallback for a message that was mid-stream across a deploy to this version.
    const stRow = await streamingRow(ctx, messageId);
    const streamedText = stRow?.text ?? message.liveText ?? message.text;
    // Announce merge: the run's final frame carries ONLY the announce text —
    // recompose behind the parked parent reply (the streamed row is already
    // prefixed, so the fallback needs no recomposition).
    const finalText =
      text !== undefined && text !== ""
        ? message.announcePrefix !== undefined && message.announcePrefix !== ""
          ? message.announcePrefix + ANNOUNCE_SEP + text
          : text
        : streamedText;
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
    });
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
  },
});

// Mirror the gateway's `sessions.describe` onto the chat so the header strip can
// surface the model / reasoning level / context meter (CHAT_UX_DESIGN Part 2.1).
// The bridge calls this (via the ingest httpAction) when it learns a turn's
// session meta. INTERNAL (not browser-callable). All fields optional + stamped
// with `updatedAt` — never holds secrets (model/level names are non-sensitive).
export const setSessionMeta = internalMutation({
  args: {
    chatId: v.id("chats"),
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
    }),
  },
  handler: async (ctx, { chatId, meta }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return; // chat gone (e.g. deleted mid-turn) — nothing to do
    await ctx.db.patch(chatId, {
      sessionMeta: { ...meta, updatedAt: Date.now() },
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
  },
  handler: async (
    ctx,
    { chatId, excludeMessageId },
  ): Promise<{
    history: string | null;
    turnCount: number;
    // Additive (hybrid rehydration): content-free counters for the bridge's
    // `openclaw.rehydrate` trace. Older bridges ignore them.
    summaryUsed: boolean;
    summaryChars: number;
  }> => {
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
          (m.text.trim().length > 0 ||
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
          text: enrichedTurnText(m, childResults),
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
