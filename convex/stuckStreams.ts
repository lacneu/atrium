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
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { heldInputsOfRun, projectionModeOfChat, segmentPrefixOf } from "./lib/followUp";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { writeTraceEvent } from "./observability";
import { drainNextQueued } from "./lib/outboxQueue";
import { failDocumentaryFetchForChat } from "./documentAttachments";
import { failSummarizeForChat } from "./chatSummaries";
import { providerSessionClearPatch } from "./lib/providerSession";
import { clearLiveActivity } from "./lib/liveTurnDifficulty";
import { traceRegressionSummary } from "./lib/streamTrace";
import { isWatchdogOrphan, STUCK_STREAM_ERROR_CODE, SWEEP_ERROR_CODE } from "./lib/streamOrphan";
import { transcriptStoredText } from "./lib/transcriptProjection";
import { chatAllowsInstance } from "./lib/ingestAuthz";

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

/** Curator twin of releaseStuckSummarize: a stuck curation turn → mark the job
 *  failed (stuck_stream) + clear the lock, or sweep an orphan's rows. Best-effort. */
async function releaseStuckCurate(
  ctx: MutationCtx,
  chat: Doc<"chats"> | null,
): Promise<void> {
  if (chat?.kind !== "curator") return;
  try {
    if (chat.pendingCurate) {
      await ctx.runMutation(internal.agentFileCuration.failCurationForChat, {
        chatId: chat._id,
        reason: "stuck_stream",
      });
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.agentFileCuration.cleanupCuratorChat,
        { hiddenChatId: chat._id },
      );
    }
  } catch {
    /* never let a curation cleanup error break the stuck-stream watchdog */
  }
}

/** Converter twin: a stuck conversion turn → fail the rendition (stuck_stream) +
 *  clear the lock, so the viewer's spinner can't spin forever. Best-effort. */
async function releaseStuckConvert(
  ctx: MutationCtx,
  chat: Doc<"chats"> | null,
): Promise<void> {
  if (chat?.kind !== "converter" || !chat.pendingConvert) return;
  try {
    await ctx.runMutation(internal.fileRenditions.failRenditionForChat, {
      chatId: chat._id,
      reason: "stuck_stream",
    });
  } catch {
    /* never let a conversion cleanup error break the stuck-stream watchdog */
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
// their own text — this code is reserved for the watchdog (lib/streamOrphan, where
// the run's own terminal may still correct what it closed).
export { STUCK_STREAM_ERROR_CODE };
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
    let asked = 0;
    const chat = await ctx.db.get(id);
    for (const msg of recent) {
      if (msg.status !== "streaming") continue;
      const row = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", msg._id))
        .first();
      const heartbeat = Math.max(row?.updatedAt ?? 0, msg.updatedAt);
      if (heartbeat >= cutoff) continue; // recent activity = actively streaming
      // A projected OpenClaw bubble is not Atrium's to close (0.102.1): the deliberate
      // reconcile asks the gateway, as a reconnection does, and applies its answer.
      if (await projectedOpenClawBubble(ctx, msg, chat, false)) {
        const instanceName = row?.boundInstance ?? msg.boundInstance ?? chat?.instanceName;
        if (instanceName !== undefined) {
          await ctx.scheduler.runAfter(0, internal.stuckStreams.resumeOrClose, {
            messageId: msg._id,
            instanceName,
          });
          asked++;
        }
        continue;
      }
      // Preserve the partial text (row for current, legacy liveText for pre-split),
      // flip the lifecycle so isRunning releases, and delete the heartbeat row in the
      // SAME mutation (atomic → invariant preserved).
      const preserved = (row?.text ?? "") || (msg.liveText ?? "");
      await ctx.db.patch(msg._id, {
        status: "error",
        error: STUCK_STREAM_ERROR_CODE,
        ...(preserved ? { text: preserved } : {}),
      });
      if (row) {
        await traceRegressionSummary(ctx, row, {
          runId: msg.runId,
          streamStatus: "error",
          endedBy: "stuck_reconcile",
        });
        await ctx.db.delete(row._id);
      }
      await clearLiveActivity(ctx, msg._id);
      // SSE transport (Phase 1): GC this message's stream chunks too (finalize's GC
      // never ran for an orphaned turn). Bounded + self-scheduling; no-op if none.
      await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        // Generation cutoff (by SEQ): an announce resume may reopen this
        // message and stream fresh chunks (continuing above this bound)
        // before this deferred GC runs.
        beforeSeq: row?.chunkSeq ?? 1,
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
    if (chat?.kind === "curator") {
      if (chat.pendingCurate && chat.pendingCurate.createdAt < cutoff) {
        await releaseStuckCurate(ctx, chat);
        docReleased = true;
      } else if (!chat.pendingCurate) {
        await releaseStuckCurate(ctx, chat);
      }
    }
    // A stream released here also ended WITHOUT a terminal, so the provider session is
    // as unknown as after any other reap — and this path is reachable on demand through
    // the privileged reconcile-chat endpoint. Cleared BEFORE the drain, which is what
    // releases the next send.
    if (reconciled > 0) {
      const reconciledChat = await ctx.db.get(id);
      if (reconciledChat !== null) {
        await ctx.db.patch(
          id,
          providerSessionClearPatch(
            reconciledChat.openclawChatId,
            reconciledChat.providerResetCount,
          ),
        );
      }
    }
    // Releasing a stuck stream/fetch ends that turn → drain any send queued behind it.
    if (reconciled > 0 || docReleased) await drainNextQueued(ctx, id);
    return { ok: true as const, reconciled, ...(asked > 0 ? { asked } : {}) };
  },
});

/** Rows one watchdog pass reads at most: the projected ones it leaves stay in range, so a
 *  pass is bounded by what it READS, and continues past them (`after`). */
const SCAN = 4 * BATCH;

/** The bubble is a projected (`on`) OpenClaw turn: its end is the gateway's (0.102.1). A
 *  Hermes bubble is never projected — the watchdog stays its net, unchanged.
 *
 *  Decided by the run's OWNER (Codex pass 2): its bridge stamps the bubble at the opening
 *  (`messages.projectedTurn`), so a new conversation whose transcript reads all failed is
 *  covered from its first frame, on the message already read — no read for anyone. A bubble
 *  opened before 0.102.1 has no stamp: the conversation's transcript facts decide, as in the
 *  first pass. */
async function projectedOpenClawBubble(
  ctx: MutationCtx,
  msg: Doc<"messages">,
  chat?: Doc<"chats"> | null,
  /** Decide an unstamped bubble of a never-read conversation by its own instance (one
   *  read). The periodic watchdog does; the operator's deliberate reconcile does not —
   *  its Hermes cost is pinned (projectionInvariance), and it acts on a reported case. */
  byInstance = true,
): Promise<boolean> {
  if (msg.projectedTurn === true) return true;
  if (msg.runId === undefined || msg.turnSessionKey === undefined) return false;
  const chatDoc = chat === undefined ? await ctx.db.get(msg.chatId) : chat;
  if (transcriptStoredText(chatDoc)) return (await projectionModeOfChat(ctx, chatDoc)) === "on";
  // No transcript fact yet (a bubble opened before 0.102.1 in a conversation never read):
  // its OWN instance decides (Codex pass 9) — an OpenClaw one is projected.
  if (!byInstance || msg.boundInstance === undefined) return false;
  const boundInstance = msg.boundInstance;
  const inst = await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", boundInstance))
    .first();
  return inst !== null && inst.kind !== "hermes";
}

export const reconcileStuckStreams = internalMutation({
  args: {
    /** Continuation: the `updatedAt` of the last row the previous pass read. */
    after: v.optional(v.number()),
  },
  handler: async (ctx, { after }) => {
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
      .withIndex("by_updated", (q) =>
        after === undefined ? q.lt("updatedAt", cutoff) : q.gt("updatedAt", after).lt("updatedAt", cutoff),
      )
      .take(SCAN);
    let skipped = 0;
    let acted = 0;
    let lastRead: number | undefined;

    // Chats whose in-flight turn we ended this pass → drain their queues AFTER the
    // loop (a chat with >1 stale stream must be fully flipped before isChatBusy is
    // re-evaluated, else the drain would see a still-streaming sibling and skip).
    const touchedChats = new Set<Id<"chats">>();
    let reaped = 0;
    for (const row of staleRows) {
      if (acted >= BATCH) break;
      lastRead = row.updatedAt;
      const msg = await ctx.db.get(row.messageId);
      // Orphan row whose message is already terminal (a phantom from a late delta
      // racing finalize, or a pre-fix leak): no finalize will ever delete it. Clean it
      // up here so getStreamingText stops returning it forever; not a reap (there is
      // nothing to recover — the turn already ended cleanly).
      if (msg === null || msg.status !== "streaming") {
        await traceRegressionSummary(ctx, row, {
          runId: msg?.runId,
          streamStatus: msg?.status ?? "streaming",
          endedBy: "orphan_row",
        });
        await ctx.db.delete(row._id);
        await clearLiveActivity(ctx, row.messageId);
        await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        // Generation cutoff (by SEQ): an announce resume may reopen this
        // message and stream fresh chunks (continuing above this bound)
        // before this deferred GC runs.
        beforeSeq: row.chunkSeq ?? 1,
          messageId: row.messageId,
        });
        acted++;
        continue;
      }
      // A PROJECTED OpenClaw bubble (`on`) is never closed on Atrium's clock (0.102.1): the
      // Control UI ends a run only on the gateway's terminal or on a read that finds it over
      // (lib/streamOrphan), and so does the projection. A silence of any length is the
      // gateway's to end — prod 2026-10-25: 17 min without a frame, then the answer. What
      // this net covered for it (nobody can ask the gateway) is the reconnection sweep's
      // (`sweepInstanceStreams`, `resumeOrClose`): it asks, and applies the answer.
      if (await projectedOpenClawBubble(ctx, msg)) {
        skipped++;
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
      await traceRegressionSummary(ctx, row, {
        runId: msg.runId,
        streamStatus: "error",
        endedBy: "stuck_reap",
      });
      await ctx.db.delete(row._id);
      await clearLiveActivity(ctx, row.messageId);
      // A REAP means nobody settled this turn — no terminal, ever — so nothing is known
      // about the provider's run. That is the same ignorance a silence timeout reports,
      // and it is the case the timeout's own clear cannot cover: it rides the finalize,
      // and here there IS no finalize. Without this, a bridge that crashed mid-turn left
      // the stored session behind and the next send resumed a run nobody had stopped.
      //
      // Blast radius is bounded by the SHAPE guard, not by this call site: the slot is
      // shared, and only a Hermes session id is dropped. An OpenClaw routing segment or a
      // rotation nonce is left exactly where it is — clearing those would break routing to
      // fix a session that was never stored there.
      const reapedChat = await ctx.db.get(msg.chatId);
      if (reapedChat !== null) {
        await ctx.db.patch(
          msg.chatId,
          providerSessionClearPatch(
            reapedChat.openclawChatId,
            reapedChat.providerResetCount,
          ),
        );
      }
      // SSE transport (Phase 1): GC the reaped message's stream chunks (no finalize ran).
      await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        // Generation cutoff (by SEQ): an announce resume may reopen this
        // message and stream fresh chunks (continuing above this bound)
        // before this deferred GC runs.
        beforeSeq: row.chunkSeq ?? 1,
        messageId: msg._id,
      });
      touchedChats.add(msg.chatId);
      reaped++;
      acted++;
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
      await releaseStuckCurate(ctx, stuckChat);
      await releaseStuckConvert(ctx, stuckChat);
    }

    // Each chat whose turn we just released is now idle → drain its queue.
    for (const chatId of touchedChats) {
      await drainNextQueued(ctx, chatId);
    }

    // Reschedule while rows remain in range: a full batch acted on (the rows handled are
    // deleted, the next read cannot loop on them), or a full scan. A projected row is left
    // in range, so the continuation reads PAST the last row read (`after`) — never the
    // same page again; the next cron pass starts over from the oldest.
    if (acted >= BATCH || staleRows.length === SCAN) {
      await ctx.scheduler.runAfter(0, internal.stuckStreams.reconcileStuckStreams, {
        ...(skipped > 0 && lastRead !== undefined ? { after: lastRead } : {}),
      });
    }
    return { reconciled: reaped, skipped };
  },
});

// Boot-time sweep (per-bridge): when a bridge (re)starts, NO run of its
// instances is in flight by definition — every live-text row bound to one of
// its instances is an orphan of a previous bridge life (the restart killed the
// WS subscriptions). Sweeping them at boot closes those turns in ~1-2 minutes
// instead of parking the user on a fake "En cours depuis X" chrono until the
// 12-minute watchdog. The age gate must EXCEED the longest legitimate silence
// of a LIVE turn served by an overlapping sibling bridge (rolling restart):
// a Hermes turn's reasoning heartbeats are throttled to one per minute, and an
// OpenClaw turn can be legitimately event-silent for up to ~240s (the recv
// silence-recovery budget) — anything shorter could terminalize a valid
// in-flight reply and discard its eventual output (codex P1 ×2). 300s covers
// the worst case with margin, and still closes an orphan ~2.4× sooner than
// the 12-minute watchdog.
export const SWEEP_MIN_AGE_MS = 300 * 1000;
export { SWEEP_ERROR_CODE };


/** Close ONE orphaned live bubble at bridge boot (the sweep's own close). */
async function closeSweptStream(
  ctx: MutationCtx,
  row: Doc<"streamingText">,
  msg: Doc<"messages">,
  instanceName: string,
  now: number,
): Promise<void> {
  const preserved = (row.text ?? "") || (msg.liveText ?? "");
  await ctx.db.patch(msg._id, {
    status: "error",
    error: SWEEP_ERROR_CODE,
    ...(preserved ? { text: preserved } : {}),
  });
  await traceRegressionSummary(ctx, row, {
    runId: msg.runId,
    streamStatus: "error",
    endedBy: "boot_sweep",
  });
  await ctx.db.delete(row._id);
  await clearLiveActivity(ctx, row.messageId);
  await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
    beforeSeq: row.chunkSeq ?? 1,
    messageId: msg._id,
  });
  await writeTraceEvent(ctx, {
    kind: "assistant.reconcile",
    direction: "internal",
    principalType: "service",
    principalId: "bridge-boot-sweep",
    chatId: msg.chatId,
    runId: msg.runId ?? undefined,
    correlationId: msg.runId ? `${msg.chatId}:${msg.runId}` : msg.chatId,
    meta: JSON.stringify({
      reason: "bridge_boot_sweep",
      messageId: msg._id,
      instanceName,
      ageSeconds: Math.round((now - row.updatedAt) / 1000),
      hadText: preserved.length > 0,
    }),
  });
  // SPECIALIZED service chats (documentary/summarizer/curator/converter)
  // hold job locks tied to the in-flight turn: releasing the stream here
  // deletes the very row the watchdog would later act on, so the locks
  // must be released NOW, exactly like the watchdog path (codex P1 —
  // a boot sweep otherwise left pendingFetch/-Summarize/-Curate/-Convert
  // stuck forever).
  const sweptChat = await ctx.db.get(msg.chatId);
  // SAME reasoning as the periodic reap: no finalize ever ran, so nothing is known
  // about the provider's run. This path is the restart case specifically — the
  // bridge's in-memory session cache is gone, so the next send reads the PERSISTED id
  // and would resume an orphaned run outright (raised in review).
  if (sweptChat !== null) {
    await ctx.db.patch(
      msg.chatId,
      providerSessionClearPatch(
        sweptChat.openclawChatId,
        sweptChat.providerResetCount,
      ),
    );
  }
  await releaseStuckDocumentaryFetch(ctx, sweptChat);
  await releaseStuckSummarize(ctx, sweptChat);
  await releaseStuckCurate(ctx, sweptChat);
  await releaseStuckConvert(ctx, sweptChat);
  // A finished turn may have queued follow-ups parked behind it: the
  // stream we just closed was the queue's blocker, so drain — every other
  // terminal path (finalize, watchdog) does the same (codex P1: without
  // this the first queued message sat forever).
  await drainNextQueued(ctx, msg.chatId);
}

export const sweepInstanceStreams = internalMutation({
  args: {
    instanceName: v.string(),
    // TRUE on the single deferred re-run (see below) — never re-schedules.
    rerun: v.optional(v.boolean()),
    // 0.102.1 — a RECONNECTION, not a bridge boot (the instance answers again, or a
    // chat's socket closed under a turn): the bridge process lives on, so only the
    // projected bubbles are asked about; nothing else is closed.
    projectedOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { instanceName, rerun, projectedOnly }) => {
    const now = Date.now();
    const cutoff = now - SWEEP_MIN_AGE_MS;
    // Bounded per-instance reads (codex P2 — a full collect scales with every
    // instance's in-flight turns): the stamped rows via the dedicated index,
    // plus the legacy un-stamped rows (pre-R2) whose ownership resolves via
    // the chat binding.
    // BOUNDED page (codex P2): an unbounded collect across many in-flight/
    // legacy rows could blow the transaction (per-row reads+writes+traces+
    // drains) and roll back the WHOLE sweep. 128 is ~10x any real instance's
    // in-flight set; anything beyond falls back to the 12-min watchdog — the
    // pre-sweep safety net — or, for a projected bubble the watchdog no longer
    // closes (0.102.1), to the next reconnection's sweep; it is logged (no silent cap).
    const SWEEP_PAGE = 128;
    const stamped = await ctx.db
      .query("streamingText")
      .withIndex("by_bound_instance", (q) =>
        q.eq("boundInstance", instanceName),
      )
      .take(SWEEP_PAGE);
    const legacy = await ctx.db
      .query("streamingText")
      .withIndex("by_bound_instance", (q) => q.eq("boundInstance", undefined))
      .take(SWEEP_PAGE);
    if (stamped.length === SWEEP_PAGE || legacy.length === SWEEP_PAGE) {
      console.warn(
        `[sweep] page cap hit (${SWEEP_PAGE}) for ${instanceName} — remaining orphans wait for the next sweep (projected) or the 12-min watchdog (unprojected)`,
      );
    }
    let swept = 0;
    let skippedFresh = 0;
    for (const row of [...stamped, ...legacy]) {
      // Ownership: the R2 per-turn stamp when present, else the chat binding.
      let owner = row.boundInstance ?? null;
      if (owner === null) {
        const chat = await ctx.db.get(row.chatId);
        owner = chat?.instanceName ?? null;
      }
      if (owner !== instanceName) continue;
      if (row.updatedAt >= cutoff) {
        // Too fresh: either a rolling-restart overlap (a live sibling bridge
        // still heartbeats it — must survive) or an orphan whose last frame
        // landed just before the restart. The deferred RE-RUN below separates
        // the two: a live turn keeps heartbeating past the grace, an orphan
        // does not (codex P2 — without it this row waited for the 12-min
        // watchdog, the exact window this sweep exists to close).
        skippedFresh++;
        continue;
      }
      const msg = await ctx.db.get(row.messageId);
      if (msg === null || msg.status !== "streaming") {
        await traceRegressionSummary(ctx, row, {
          runId: msg?.runId,
          streamStatus: msg?.status ?? "streaming",
          endedBy: "orphan_row",
        });
        await ctx.db.delete(row._id); // stale row without a live turn
        await clearLiveActivity(ctx, row.messageId);
        continue;
      }
      // TRANSCRIPT PROJECTION `on` (phase 3, design §8.2, CU-22): the restart lost the
      // TURN, not necessarily the RUN. The bridge is asked what the gateway says of it —
      // the Control UI's reconnect hydration (chat.history `inFlightRun` + `sessionInfo`,
      // ui/src/pages/chat/chat-history-hydration.ts:195-243 at v2026.9.33) — and the
      // answer is applied: resumed, settled from the transcript, or closed because the
      // gateway no longer runs it. No answer leaves it streaming (0.102.1).
      if (
        msg.runId !== undefined &&
        msg.turnSessionKey !== undefined &&
        (await projectionModeOfChat(ctx, await ctx.db.get(msg.chatId))) === "on"
      ) {
        await ctx.scheduler.runAfter(0, internal.stuckStreams.resumeOrClose, {
          messageId: msg._id,
          instanceName,
        });
        continue;
      }
      if (projectedOnly === true) continue;
      await closeSweptStream(ctx, row, msg, instanceName, now);
      swept++;
    }
    // ONE deferred pass of the BOOT sweep once the grace has elapsed for the freshest
    // skips. A projected-only pass plans none (Codex pass 5): it IS the reconciliation
    // cycle, and the next cycle looks at a bubble too fresh to ask today.
    if (skippedFresh > 0 && rerun !== true && projectedOnly !== true) {
      await ctx.scheduler.runAfter(
        SWEEP_MIN_AGE_MS + 5_000,
        internal.stuckStreams.sweepInstanceStreams,
        { instanceName, rerun: true },
      );
    }
    return { swept };
  },
});

/**
 * A conversation's socket CLOSED (0.102.1, Codex pass 4): the bridge asks at every close,
 * deciding nothing from its own memory, and Convex decides from its state — each projected
 * bubble of this chat still streaming on this instance is asked of the gateway at once
 * (`resumeOrClose`: the socket is gone, the Control UI re-reads the gateway's state at its
 * reconnection), and its answer applied. None: nothing is written, nothing scheduled.
 * Idempotent: a second request asks the same question again, whose answer is the same.
 */
export const resumeChatStreams = internalMutation({
  args: { instanceName: v.string(), chatId: v.string() },
  handler: async (ctx, { instanceName, chatId }) => {
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return { asked: 0 };
    // The atomic barrier: only the instance this chat routes to may ask about it.
    if (!(await chatAllowsInstance(ctx, id, instanceName))) return { asked: 0 };
    const streaming = await ctx.db
      .query("messages")
      .withIndex("by_chat_status", (q) => q.eq("chatId", id).eq("status", "streaming"))
      .take(RESUME_CHAT_PAGE);
    let asked = 0;
    for (const msg of streaming) {
      if (msg.role !== "assistant") continue;
      if (msg.boundInstance !== undefined && msg.boundInstance !== instanceName) continue;
      // Projected: the owner's stamp, else (a bubble opened before 0.102.1) the
      // conversation's mode, as the boot sweep reads it.
      if (
        msg.projectedTurn !== true &&
        !(
          msg.runId !== undefined &&
          msg.turnSessionKey !== undefined &&
          (await projectionModeOfChat(ctx, await ctx.db.get(msg.chatId))) === "on"
        )
      ) {
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.stuckStreams.resumeOrClose, {
        messageId: msg._id,
        instanceName,
      });
      asked++;
    }
    return { asked };
  },
});

/** Bubbles one close may ask about: a chat streams one turn (a few with steer segments). */
const RESUME_CHAT_PAGE = 8;

// ── CU-22: resume before closing (transcript projection `on`, phase 3) ─────────────────

/** How long Convex waits for the bridge's resume answer (none: asked again later). */
const RESUME_POST_TIMEOUT_MS = 30_000;

/**
 * What the resume request needs about one bubble left streaming:
 *   - `done`: it is no longer streaming (or gone) — nothing to ask, nothing to close;
 *   - `cannot`: it cannot be asked about here (no run or session named, the conversation
 *     no longer projected) — NOT a proof of its end (Codex pass 9): left open;
 *   - `ask`: the request — including the bubble's OWN route: the agent and instance that
 *     produced it, as the bubble names them (a chained reply) or as the send it answers
 *     was routed (its outbox row: an ordinary reply to a turn addressed to another
 *     instance carries no route of its own, Codex pass 9).
 */
export const resumeTarget = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.db.get(messageId);
    if (msg === null || msg.status !== "streaming") return { kind: "done" as const };
    if (msg.runId === undefined || msg.turnSessionKey === undefined) {
      return { kind: "cannot" as const, why: "no run or session named" };
    }
    const chat = await ctx.db.get(msg.chatId);
    if (chat === null) return { kind: "done" as const };
    // Re-read at action time: the sweep's decision may be stale (codex pass 4).
    if ((await projectionModeOfChat(ctx, chat)) !== "on") {
      return { kind: "cannot" as const, why: "the conversation is not projected" };
    }
    let routedAgent =
      msg.routedInstanceName !== undefined && msg.routedAgentId !== undefined
        ? { instanceName: msg.routedInstanceName, agentId: msg.routedAgentId }
        : undefined;
    if (routedAgent === undefined && msg.dispatchOutboxId !== undefined) {
      const rowId = ctx.db.normalizeId("outbox", msg.dispatchOutboxId);
      const row = rowId === null ? null : await ctx.db.get(rowId);
      if (row !== null && row.chatId === msg.chatId && row.routedAgent !== undefined) {
        routedAgent = row.routedAgent;
      }
    }
    const held = await heldInputsOfRun(ctx, msg);
    const segmentPrefix = await segmentPrefixOf(ctx, msg);
    // Where the store's reads of the bubble's OWN session stopped (Codex pass 10): the
    // bridge resumes from it by a delta, as the Control UI's hydration resumes at its cursor
    // (a `reset` there is answered by the newest page, as upstream — Codex pass 11).
    const cursors = await ctx.db
      .query("transcriptCursors")
      .withIndex("by_chat_session", (q) => q.eq("chatId", msg.chatId).eq("sessionKey", msg.turnSessionKey!))
      .take(4);
    const sessionCursors = cursors.flatMap((c) =>
      c.deltaCursor === undefined
        ? []
        : [{ instanceName: c.instanceName, sessionId: c.sessionId, deltaCursor: c.deltaCursor }],
    );
    return {
      kind: "ask" as const,
      sessionCursors,
      segmentPrefix,
      chatId: msg.chatId,
      ownerId: chat.userId,
      runId: msg.runId,
      heldInputs: held,
      sessionKey: msg.turnSessionKey,
      routedAgent,
    };
  },
});

/** The store's cursor of the bubble's session on the instance asked, as the `/resume`
 *  body carries it: none when the store never read that session there (the bridge then
 *  starts from the newest page, as the Control UI's first read). */
export function resumeCursorFor(
  cursors: ReadonlyArray<{ instanceName: string; sessionId: string; deltaCursor: string }>,
  instanceName: string,
): { sessionId: string; deltaCursor: string } | undefined {
  const c = cursors.find((x) => x.instanceName === instanceName);
  return c === undefined ? undefined : { sessionId: c.sessionId, deltaCursor: c.deltaCursor };
}

/** The bubble was resumed by the bridge: it is live again (the sweep's age gate and the
 *  watchdog read the live row's stamp). */
export const markResumed = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const row = await ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first();
    if (row !== null) await ctx.db.patch(row._id, { updatedAt: Date.now() });
  },
});

/** The gateway no longer runs the bubble's run, proven and read (`not_running`): close
 *  what that read left streaming exactly as the boot sweep would have — unless anything was written to it
 *  since the question was asked (the resumed run, a sibling bridge, the transcript's
 *  settle that came with the answer). */
export const closeAfterResumeRefused = internalMutation({
  args: { messageId: v.id("messages"), instanceName: v.string(), askedAt: v.optional(v.number()) },
  handler: async (ctx, { messageId, instanceName, askedAt }) => {
    const msg = await ctx.db.get(messageId);
    if (msg === null || msg.status !== "streaming") return;
    const row = await ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first();
    if (row === null) return;
    if (askedAt !== undefined ? row.updatedAt > askedAt : row.updatedAt >= Date.now() - SWEEP_MIN_AGE_MS) return;
    await closeSweptStream(ctx, row, msg, instanceName, Date.now());
  },
});

/**
 * What the bridge's `/resume` answer says, and what Convex does with it (0.102.1):
 *   - `resumed` — the gateway still runs the run; the bubble streams on;
 *   - `not_running` — it no longer does; the bridge read the transcript first (its settle
 *     is already applied), and what is still streaming is closed;
 *   - `followed` — a live socket of the bridge already listens to the bubble's session:
 *     nothing to do (Codex pass 5);
 *   - `busy` — the chat's socket or its send gate is taken right now: temporary;
 *   - `stale` — the request no longer matches (another session key, another instance);
 *   - `unknown` — no answer (no route, bridge or gateway unreachable, unreadable state):
 *     left STREAMING — the Control UI keeps a run it cannot ask about;
 *   none of these is terminal: the reconciliation cycle (every successful discovery of the
 *   instance, agents.applyDiscovery) looks at the bubble again. A bridge before 0.102.1
 *   refuses without a reason (`resumed:false`) for a stale session as for a busy chat:
 *   that is no proof of an end either, so it is `unknown` too (Codex pass 10) — no
 *   projected bubble is closed without the gateway's proof applied, whatever the bridge.
 */
export type ResumeVerdict =
  | "resumed"
  | "not_running"
  | "followed"
  | "busy"
  | "stale"
  | "unknown";

export function resumeVerdict(httpOk: boolean, body: unknown): ResumeVerdict {
  if (!httpOk || typeof body !== "object" || body === null) return "unknown";
  const b = body as { resumed?: unknown; reason?: unknown };
  if (b.resumed === true) return "resumed";
  if (b.resumed !== false) return "unknown";
  if (b.reason === "not_running") return "not_running";
  if (b.reason === "stale") return "stale";
  if (b.reason === "busy") return "busy";
  if (b.reason === "followed") return "followed";
  return "unknown";
}

/**
 * Ask the instance's bridge what the gateway says of a bubble left streaming (POST
 * /resume) and apply it — the Control UI's reconnect hydration: it adopts `inFlightRun`
 * and ends a run only on a terminal or a read that finds it over. Since 0.102.1, no
 * answer is never taken for "over": the bubble stays streaming (the chat shows the
 * instance unavailable; Stop stays offered) and the reconciliation cycle asks again.
 */
export const resumeOrClose = internalAction({
  args: {
    messageId: v.id("messages"),
    instanceName: v.string(),
  },
  handler: async (ctx, { messageId, instanceName }) => {
    const askedAt = Date.now();
    let verdict: ResumeVerdict = "unknown";
    let why = "";
    try {
      const target = await ctx.runQuery(internal.stuckStreams.resumeTarget, { messageId });
      const secret = process.env.BRIDGE_SHARED_SECRET;
      // PRINCIPLE (Codex pass 9): only the gateway's proof, applied, ends a projected bubble.
      // Anything that keeps us from asking the RIGHT gateway — no run or session named, the
      // conversation not projected, a route that resolves elsewhere or not at all, no
      // bridge, no secret — is `unknown`: the bubble stays open for the next cycle.
      if (target.kind === "done") return;
      if (target.kind === "cannot") {
        why = target.why;
      } else if (secret) {
        const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
          chatId: target.chatId,
          userId: target.ownerId,
          ...(target.routedAgent ? { routedAgent: target.routedAgent } : {}),
        });
        if (!routing?.target || !routing.bridgeUrl) {
          why = "no route to the bubble's gateway";
        } else if (routing.target.instanceName !== instanceName) {
          // The route resolves to ANOTHER instance than the one that produced the bubble:
          // that gateway cannot answer for it.
          why = "the route resolves to another instance";
        } else {
          const res = await fetch(`${routing.bridgeUrl.replace(/\/$/, "")}/resume`, {
            method: "POST",
            signal: AbortSignal.timeout(RESUME_POST_TIMEOUT_MS),
            headers: { "Content-Type": "application/json", Authorization: secret },
            body: JSON.stringify({
              chatId: target.chatId,
              openclawChatId: routing.openclawChatId,
              instanceName: routing.target.instanceName,
              agentId: routing.target.agentId,
              canonical: routing.target.canonical,
              ...(routing.gatewayUser === undefined ? {} : { gatewayUser: routing.gatewayUser }),
              sessionKey: target.sessionKey,
              ...((c) => (c === undefined ? {} : { resumeCursor: c }))(
                resumeCursorFor(target.sessionCursors, instanceName),
              ),
              liveBubble: {
                messageId,
                runId: target.runId,
                ...(target.heldInputs.length > 0 ? { heldInputs: target.heldInputs } : {}),
                ...(target.segmentPrefix !== undefined
                  ? { segmentPrefix: target.segmentPrefix }
                  : {}),
              },
            }),
          });
          verdict = resumeVerdict(res.ok, res.ok ? await res.json() : null);
        }
      } else {
        why = "no bridge secret";
      }
    } catch (err) {
      console.error("stuckStreams.resumeOrClose: resume request failed:", err);
      verdict = "unknown";
    }
    if (why !== "") console.log(`stuckStreams.resumeOrClose: not asked (${why})`);
    console.log(`stuckStreams.resumeOrClose: ${verdict}`);
    if (verdict === "resumed") {
      await ctx.runMutation(internal.stuckStreams.markResumed, { messageId });
    } else if (verdict === "not_running") {
      await ctx.runMutation(internal.stuckStreams.closeAfterResumeRefused, {
        messageId,
        instanceName,
        askedAt,
      });
    }
    // Every other answer leaves the bubble as it is: the next cycle looks again.
  },
});

// ── 0.102.1: a bubble the watchdog closed while its run still ran ──────────────────────

/**
 * Re-project ONE bubble the watchdog closed (`stream_orphaned`) whose run the transcript
 * since proved over — the repair for a bubble closed BEFORE 0.102.1, whose run's live
 * terminal already came and went (prod, 2026-10-25). Since 0.102.1 the run's own terminal
 * and the projection of its rows correct such a bubble as they arrive
 * (stream.finalizeMessageCore, lib/bubbleProjection `orphaned`); this asks the projection
 * once more for the run, through the same continuation every bounded projection uses.
 * Operator-only (internal), idempotent, and a no-op unless the bubble is a watchdog
 * orphan of a run its session's transcript holds as settled.
 */
export const reprojectOrphanedBubble = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.db.get(messageId);
    if (msg === null || !isWatchdogOrphan(msg)) return { scheduled: false as const, reason: "not_an_orphan" };
    if (msg.runId === undefined || msg.turnSessionKey === undefined) {
      return { scheduled: false as const, reason: "no_run" };
    }
    const runId = msg.runId;
    const sessionKey = msg.turnSessionKey;
    const runs = await ctx.db
      .query("transcriptRuns")
      .withIndex("by_chat_run", (q) => q.eq("chatId", msg.chatId).eq("runId", runId))
      .take(4);
    if (!runs.some((r) => r.sessionKey === sessionKey && r.settledAt !== undefined)) {
      return { scheduled: false as const, reason: "run_not_settled" };
    }
    const cursor = await ctx.db
      .query("transcriptCursors")
      .withIndex("by_chat_session", (q) => q.eq("chatId", msg.chatId).eq("sessionKey", sessionKey))
      .first();
    if (cursor === null) return { scheduled: false as const, reason: "no_cursor" };
    await ctx.scheduler.runAfter(0, internal.transcriptProjection.continueProjection, {
      chatId: msg.chatId,
      sessionKey,
      sessionId: cursor.sessionId,
      instanceName: cursor.instanceName,
      runIds: [runId],
    });
    return { scheduled: true as const };
  },
});
