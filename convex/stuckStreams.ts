// Stuck-stream watchdog (the server-side fix the runtime comment asked for).
//
// ROOT CAUSE it heals: an assistant message is left `status: "streaming"` when
// the bridge loses the run's gateway WebSocket subscription mid-turn (a
// reconnect/restart) and never relays the `finalize` frame. The gateway still
// finishes the answer (it shows in the OpenClaw Control UI), but Convex never
// learns the turn ended — so the webchat shows "Réflexion…" forever AND hides
// every per-message action (a streaming message keeps the runtime `isRunning`,
// which is what gates the ActionBar + composer). The user is then stuck with no
// recovery path: they cannot even delete the orphaned message.
//
// This watchdog flips a streaming message untouched for STALE_STREAM_MS to
// `error` (preserving any partial text/parts already streamed). That single
// status change releases `isRunning`, so the per-message actions reappear and
// the composer unlocks — the user can delete or regenerate. A trace event is
// written so the action is visible in the trace center / API.

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { writeTraceEvent } from "./observability";
import { drainNextQueued } from "./lib/outboxQueue";
import { failDocumentaryFetchForChat } from "./documentAttachments";
import { failSummarizeForChat } from "./chatSummaries";

/**
 * When the watchdog flips a stale streaming message, also release a documentary
 * FETCH stuck on that same hidden chat: its `pendingFetch` is never cleared on a
 * dropped stream, so without this the owner stays locked out of all future fetches
 * (the `fetch_in_flight` guard) AND the stuck case stays SILENT. Failing it here
 * heals the lock and emits a `documentary.fail` trace (reason "stuck_stream"),
 * turning the silent stuck case into an observable one. Best-effort: an L2 error
 * must never break the core stuck-stream reconcile.
 */
async function releaseStuckDocumentaryFetch(
  ctx: MutationCtx,
  chat: Doc<"chats"> | null,
): Promise<void> {
  if (chat?.kind !== "documentary" || !chat.pendingFetch) return;
  try {
    await failDocumentaryFetchForChat(ctx, chat, "stuck_stream");
  } catch {
    /* never let an L2 cleanup error break the stuck-stream watchdog */
  }
}

/** Twin of the above for a stuck SUMMARIZE job (hybrid rehydration): release the
 *  `pendingSummarize` lock + apply the failure backoff. When NO lock remains (the
 *  job was already released mid-stream by an invalidation), still sweep the hidden
 *  chat — the watchdog just settled an ORPHAN reply that may hold a summary of
 *  deleted content, and no correlate will ever clean it (codex P2). Best-effort. */
async function releaseStuckSummarize(
  ctx: MutationCtx,
  chat: Doc<"chats"> | null,
): Promise<void> {
  if (chat?.kind !== "summarizer") return;
  try {
    if (chat.pendingSummarize) {
      await failSummarizeForChat(ctx, chat, "stuck_stream");
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.chatSummaries.cleanupSummarizerChat,
        { hiddenChatId: chat._id },
      );
    }
  } catch {
    /* never let a summarize cleanup error break the stuck-stream watchdog */
  }
}

// A streaming message with NO update for this long is treated as orphaned.
// Deliberately generous (12 min): a deep-reasoning, many-tool turn can have long
// silent gaps between frames, and killing a still-live stream would be far worse
// than a few extra minutes of "Réflexion…". Only a genuinely abandoned stream
// (bridge dropped the run) stays silent this long.
export const STALE_STREAM_MS = 12 * 60 * 1000;
// Stable, non-PHI error code; the frontend maps it to a localized, actionable
// message (RunStatus → m.runstatus_error_orphaned). Gateway-provided errors keep
// their own text — this code is reserved for the watchdog.
export const STUCK_STREAM_ERROR_CODE = "stream_orphaned";
const BATCH = 25;

// A DELIBERATE, chat-scoped reconcile for the self-correction loop (#7): an AI
// agent that diagnosed a stuck chat releases ITS hung stream NOW instead of waiting
// for the 12-min passive watchdog. Shorter cutoff (60s) because the caller is acting
// on a reported problem. Safe + bounded: only flips messages ALREADY streaming for
// >= the cutoff, in ONE chat, scanning only the 50 most-recent messages.
export const RECONCILE_MIN_AGE_MS = 60 * 1000;

export const reconcileChatStuckStreams = internalMutation({
  args: { chatId: v.string(), principalId: v.optional(v.string()) },
  handler: async (ctx, { chatId, principalId }) => {
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return { ok: false as const, error: "bad chatId", reconciled: 0 };
    const now = Date.now();
    const cutoff = now - RECONCILE_MIN_AGE_MS;
    // Most-recent messages only — a stuck stream is the in-flight (last) turn. The
    // staleness is decided by heartbeat = max(live-text row, message), so a legacy
    // pre-split stream (no row) is still covered and an actively-streaming one (recent
    // row) is left alone.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", id))
      .order("desc")
      .take(50);
    let reconciled = 0;
    for (const msg of recent) {
      if (msg.status !== "streaming") continue;
      const row = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", msg._id))
        .first();
      const heartbeat = Math.max(row?.updatedAt ?? 0, msg.updatedAt);
      if (heartbeat >= cutoff) continue; // recent activity = actively streaming
      // Preserve the partial text (row for current, legacy liveText for pre-split),
      // flip the lifecycle so isRunning releases, and delete the heartbeat row in the
      // SAME mutation (atomic → invariant preserved).
      const preserved = (row?.text ?? "") || (msg.liveText ?? "");
      await ctx.db.patch(msg._id, {
        status: "error",
        error: STUCK_STREAM_ERROR_CODE,
        ...(preserved ? { text: preserved } : {}),
      });
      if (row) await ctx.db.delete(row._id);
      // SSE transport (Phase 1): GC this message's stream chunks too (finalize's GC
      // never ran for an orphaned turn). Bounded + self-scheduling; no-op if none.
      await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        messageId: msg._id,
      });
      await writeTraceEvent(ctx, {
        kind: "assistant.reconcile",
        direction: "internal",
        principalType: "service",
        principalId: principalId ?? "selfheal",
        chatId: msg.chatId,
        runId: msg.runId ?? undefined,
        correlationId: msg.runId ? `${msg.chatId}:${msg.runId}` : msg.chatId,
        meta: JSON.stringify({
          reason: "deliberate_reconcile",
          messageId: msg._id,
          ageSeconds: Math.round((now - heartbeat) / 1000),
          hadText: preserved.length > 0,
        }),
      });
      reconciled++;
    }
    // A documentary FETCH chat the operator deliberately reconciles: release a
    // pendingFetch older than the cutoff EVEN IF no streaming message was flipped —
    // covers the rare "turn completed but the settle never cleared the lock" case
    // (the cron watchdog only catches stuck STREAMS). The age gate avoids killing a
    // legitimately in-progress fetch.
    const chat = await ctx.db.get(id);
    let docReleased = false;
    if (
      chat?.kind === "documentary" &&
      chat.pendingFetch &&
      chat.pendingFetch.createdAt < cutoff
    ) {
      await releaseStuckDocumentaryFetch(ctx, chat);
      docReleased = true;
    }
    if (chat?.kind === "summarizer") {
      if (chat.pendingSummarize && chat.pendingSummarize.createdAt < cutoff) {
        await releaseStuckSummarize(ctx, chat);
        docReleased = true;
      } else if (!chat.pendingSummarize) {
        // No live job: sweep settled orphans (released-then-flipped replies).
        await releaseStuckSummarize(ctx, chat);
      }
    }
    // Releasing a stuck stream/fetch ends that turn → drain any send queued behind it.
    if (reconciled > 0 || docReleased) await drainNextQueued(ctx, id);
    return { ok: true as const, reconciled };
  },
});

export const reconcileStuckStreams = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STALE_STREAM_MS;
    // The streaming HEARTBEAT lives on the streamingText row's `updatedAt` (the bridge
    // bumps it on every delta / part). Range THOSE rows: a row untouched for >cutoff
    // means its turn stopped being fed. Crucially, an actively-streaming turn has a
    // FRESH row → it falls outside this range → it is never read, so a long-but-live
    // turn cannot occupy a batch slot (no head-of-line blocking). Every row in range
    // is actionable. Index + .take → never a full scan.
    const staleRows = await ctx.db
      .query("streamingText")
      .withIndex("by_updated", (q) => q.lt("updatedAt", cutoff))
      .take(BATCH);

    // Chats whose in-flight turn we ended this pass → drain their queues AFTER the
    // loop (a chat with >1 stale stream must be fully flipped before isChatBusy is
    // re-evaluated, else the drain would see a still-streaming sibling and skip).
    const touchedChats = new Set<Id<"chats">>();
    let reaped = 0;
    for (const row of staleRows) {
      const msg = await ctx.db.get(row.messageId);
      // Orphan row whose message is already terminal (a phantom from a late delta
      // racing finalize, or a pre-fix leak): no finalize will ever delete it. Clean it
      // up here so getStreamingText stops returning it forever; not a reap (there is
      // nothing to recover — the turn already ended cleanly).
      if (msg === null || msg.status !== "streaming") {
        await ctx.db.delete(row._id);
        await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
          messageId: row.messageId,
        });
        continue;
      }
      // Flip the lifecycle so isRunning releases, preserve the partial streamed text
      // (row first, then a legacy pre-split `liveText`), and delete the heartbeat row
      // in the SAME mutation (atomic → the row-iff-streaming invariant holds).
      const preserved = row.text || (msg.liveText ?? "");
      await ctx.db.patch(msg._id, {
        status: "error",
        error: STUCK_STREAM_ERROR_CODE,
        ...(preserved ? { text: preserved } : {}),
      });
      await ctx.db.delete(row._id);
      // SSE transport (Phase 1): GC the reaped message's stream chunks (no finalize ran).
      await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        messageId: msg._id,
      });
      touchedChats.add(msg.chatId);
      reaped++;
      await writeTraceEvent(ctx, {
        kind: "assistant.reconcile",
        direction: "internal",
        principalType: "system",
        principalId: "watchdog",
        chatId: msg.chatId,
        runId: msg.runId ?? undefined,
        correlationId: msg.runId ? `${msg.chatId}:${msg.runId}` : msg.chatId,
        meta: JSON.stringify({
          reason: "missing_finalize",
          messageId: msg._id,
          ageSeconds: Math.round((now - row.updatedAt) / 1000),
          hadText: preserved.length > 0,
        }),
      });
      // If this stale stream is a documentary FETCH turn, release its stuck lock too.
      const stuckChat = await ctx.db.get(msg.chatId);
      await releaseStuckDocumentaryFetch(ctx, stuckChat);
      await releaseStuckSummarize(ctx, stuckChat);
    }

    // Each chat whose turn we just released is now idle → drain its queue.
    for (const chatId of touchedChats) {
      await drainNextQueued(ctx, chatId);
    }

    // Reschedule when we PROCESSED a full batch — every row in range is actionable
    // (reaped or cleaned), so a full batch means more stale rows likely remain; the
    // ones we handled are deleted, so the next read can't loop on them (converges).
    if (staleRows.length === BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.stuckStreams.reconcileStuckStreams,
        {},
      );
    }
    return { reconciled: reaped };
  },
});
