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
import { Id } from "./_generated/dataModel";
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
  args: { messageId: v.id("messages"), phase: v.string() },
  handler: async (ctx, { messageId, phase }) => {
    if (!TURN_PHASES.has(phase)) return; // unknown value: ignore, never throw
    const row = await streamingRow(ctx, messageId);
    // No live row (turn not open yet, or already finished): drop — the phase is
    // a live-only hint, never worth resurrecting a row the finalize GC'd.
    if (row === null) return;
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
  },
  handler: async (ctx, { messageId, text, recSessionId, bridgeRecvAt, bridgeSentAt, bridgeSkew, sizeBytes }) => {
    const now = Date.now(); // t2: Convex received
    // Only pay the recorder point-read when the bridge actually tagged this delta.
    const rec = recSessionId !== undefined ? await activeRecording(ctx) : null;
    const row = await streamingRow(ctx, messageId);
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
      seq = 1; // 1-based: a fresh SSE cursor of 0 reads from the first chunk (seq > 0)
      const prefix = message.liveText ?? "";
      const full = prefix + text;
      streamRowId = await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
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
  },
  handler: async (ctx, { messageId, text, recSessionId, bridgeRecvAt, bridgeSentAt, bridgeSkew, sizeBytes }) => {
    const now = Date.now(); // t2: Convex received
    const rec = recSessionId !== undefined ? await activeRecording(ctx) : null;
    const row = await streamingRow(ctx, messageId);
    let streamRowId: Id<"streamingText">;
    let chatId: Id<"chats">;
    let seq: number;
    if (row === null) {
      const message = await ctx.db.get(messageId);
      if (message === null) throw new Error("setSnapshot: message not found");
      // See appendDelta: never recreate a row for a finished turn (no finalize will
      // delete it again) — a late snapshot for a terminal message is dropped.
      if (message.status !== "streaming") return;
      seq = 1; // 1-based: a fresh SSE cursor of 0 reads from the first chunk (seq > 0)
      streamRowId = await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
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
  },
  handler: async (ctx, { messageId, part }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("addPart: message not found");
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
          text: message.liveText ?? "",
          updatedAt: Date.now(),
        });
      }
    }
    const existing = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    const order = existing.length;
    await ctx.db.insert("messageParts", { messageId, order, part });
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
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const batch = await ctx.db
      .query("streamChunks")
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .take(CHUNK_GC_BATCH);
    for (const c of batch) await ctx.db.delete(c._id);
    if (batch.length === CHUNK_GC_BATCH) {
      await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        messageId,
      });
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
  },
  handler: async (ctx, { messageId, status, text, error, errorKind }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("finalize: message not found");
    }
    // FIRST TERMINAL WRITE WINS (symmetric): a user-aborted message stays
    // aborted when the gateway's late chat:final loses the race — and a reply
    // that COMPLETED before the abort RPC landed stays complete (the kill's
    // guaranteed-settle finalize must not repaint a finished answer as
    // interrupted). Same-status re-finalize stays idempotent; the first
    // finalize already drained the queue and scheduled the GC.
    if (message.status !== "streaming" && message.status !== status) {
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
    const finalText =
      text !== undefined && text !== "" ? text : streamedText;
    await ctx.db.patch(messageId, {
      status,
      text: finalText,
      liveText: undefined, // clear the legacy live field (optional → field removed)
      ...(error !== undefined ? { error } : {}),
      // Reuses the existing stable-code field (failDispatch codes live there
      // too) — the UI maps context_length/rate_limit/... to actionable labels.
      ...(errorKind !== undefined ? { errorCode: errorKind } : {}),
      updatedAt: Date.now(),
    });
    // Delete the live-text row WITH the lifecycle flip (same atomic mutation) so the
    // "streaming <=> row exists" invariant holds and the watchdog won't re-see it.
    if (stRow !== null) await ctx.db.delete(stRow._id);
    // SSE transport (Phase 1): GC the message's stream chunks (bounded + self-scheduling
    // — a long turn can accumulate hundreds). Off the lifecycle path; best-effort.
    await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
      messageId,
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
