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
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { writeTraceEvent } from "./observability";

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
    // Most-recent messages only — a stuck stream is the in-flight (last) turn.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", id))
      .order("desc")
      .take(50);
    let reconciled = 0;
    for (const msg of recent) {
      if (msg.status !== "streaming" || msg.updatedAt >= cutoff) continue;
      // Preserve text/parts; flip ONLY the lifecycle so isRunning releases.
      await ctx.db.patch(msg._id, {
        status: "error",
        error: STUCK_STREAM_ERROR_CODE,
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
          ageSeconds: Math.round((now - msg.updatedAt) / 1000),
          hadText: (msg.text?.length ?? 0) > 0,
        }),
      });
      reconciled++;
    }
    return { ok: true as const, reconciled };
  },
});

export const reconcileStuckStreams = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STALE_STREAM_MS;
    // Range EXACTLY the streaming set ordered by updatedAt, stopping at the
    // cutoff — never a full-table scan (bounded by the index + .take).
    const stale = await ctx.db
      .query("messages")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "streaming").lt("updatedAt", cutoff),
      )
      .take(BATCH);

    for (const msg of stale) {
      // Preserve text/parts; flip ONLY the lifecycle so isRunning releases.
      await ctx.db.patch(msg._id, {
        status: "error",
        error: STUCK_STREAM_ERROR_CODE,
      });
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
          ageSeconds: Math.round((now - msg.updatedAt) / 1000),
          hadText: (msg.text?.length ?? 0) > 0,
        }),
      });
    }

    // Drain a backlog without exceeding mutation limits (mirrors purgeOldTraces):
    // a full batch means more stale rows may remain.
    if (stale.length === BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.stuckStreams.reconcileStuckStreams,
        {},
      );
    }
    return { reconciled: stale.length };
  },
});
