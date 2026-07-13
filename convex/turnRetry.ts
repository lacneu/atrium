// AUTO-RETRY of a turn the gateway failed with a TRANSIENT session-init conflict.
//
// The OpenClaw gateway commits its reply-session initialization with optimistic
// concurrency: when a concurrent writer (e.g. the previous turn's post-run memory
// flush) keeps churning the session-store entry, it retries once then throws
// "reply session initialization conflicted for <sessionKey>" (live incident
// 2026-07-09: two consecutive turns rejected in ~200ms, zero text generated).
// Upstream treats the error as TRANSIENT — its Telegram channel spool-retries on
// this exact message with exponential backoff (base 5s, cap 60s). The Atrium
// channel surfaced it as a terminal error card instead, so the user's remedy was
// a MANUAL delete + regenerate.
//
// This module does that regenerate FOR the user, bounded and guarded:
//   finalize (stream.ts) → maybeScheduleTurnRetry (errorCode/zero-content gates,
//   attempt bound) → autoRetryTurn after backoff (re-checks EVERYTHING, then
//   deletes the empty error card, rebuilds the outbox row from the last user
//   turn, and rides the battle-tested dispatchReset → re-dispatch chain — the
//   exact machinery of a manual assistant-delete regenerate, including the
//   gateway session reset + re-hydration and multi-agent per-turn routing).
//
// SAFETY MODEL — the retry may only fire when it is provably a pure re-run:
//   - the errored turn produced NOTHING (no text, no parts): deleting its card
//     loses nothing; the init failure happened BEFORE any model call, so a
//     re-send can never duplicate agent work;
//   - the errored card is still the LAST message of the chat and the chat is
//     idle (no pending/queued outbox): if the user moved on (new send, delete,
//     manual regenerate), the retry silently stands down;
//   - the chain is bounded by MAX_TURN_RETRIES via the outbox row's
//     autoRetryAttempt stamp — a persistent conflict ends in the honest error
//     card (labeled session_init_conflict → actionable UI copy), never a loop.
import { v } from "convex/values";
import { purgeBookmarksForMessages } from "./chatBookmarks";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { compareOrder } from "./lib/messageOrder";

/** The stable error code the bridge classifier mints for the gateway's
 *  session-init OCC conflict (normalizer SESSION_INIT_CONFLICT_RE). */
export const SESSION_INIT_CONFLICT_CODE = "session_init_conflict";

/** Bounded chain: at most this many automatic re-dispatches per turn. */
export const MAX_TURN_RETRIES = 2;

/** Backoff before attempt N+1 (indexed by the FAILED attempt number). Aligned
 *  with upstream's own retry curve (Telegram: base 5s ×2^n, cap 60s); the live
 *  incident's churn window (≥18s) is covered by the second delay. */
export const RETRY_DELAY_MS: readonly number[] = [5_000, 15_000];

/** Pure decision: should a finalize schedule a retry, and with which attempt
 *  number + delay? Exported for direct unit-testing of the bound/gate logic. */
export function retryDecision(input: {
  status: string;
  errorKind: string | null;
  finalTextLen: number;
  partCount: number;
  // A QUEUED follow-up remains (the user moved on) — schedule-time only checks
  // queued, NOT pending: the current turn's OWN outbox row is typically still
  // `pending` when a fast gateway error finalizes (live trace 2026-07-09: the
  // error beat the dispatch's sent-flip by 190ms), and blocking on it would
  // kill the retry in exactly the incident it exists for (codex P2). A drained
  // pending follow-up is caught by the FIRE-time guards instead.
  chatBusy: boolean;
  lastAttempt: number; // newest sent/pending outbox row's autoRetryAttempt
}): { attempt: number; delayMs: number } | null {
  if (input.status !== "error") return null;
  if (input.errorKind !== SESSION_INIT_CONFLICT_CODE) return null;
  // ZERO-CONTENT only: anything visible means the turn did real work — deleting
  // it would lose user-facing content, so the honest error card stays.
  // Reviewed edge (codex, rejected): "a private ack could inflate finalTextLen
  // and kill the retry" cannot occur for THIS errorKind — the gateway throws at
  // session INITIALIZATION, before the model generates anything, and an ack is
  // model-generated text (pendingAckText is per-turn state reset at beginTurn).
  // Were it ever wrong, the failure mode is the honest error card (fail-safe).
  if (input.finalTextLen > 0 || input.partCount > 0) return null;
  if (input.chatBusy) return null;
  if (input.lastAttempt >= MAX_TURN_RETRIES) return null;
  return {
    attempt: input.lastAttempt + 1,
    delayMs: RETRY_DELAY_MS[input.lastAttempt] ?? RETRY_DELAY_MS[RETRY_DELAY_MS.length - 1]!,
  };
}

/** Called by stream.finalize on the error path (AFTER drainNextQueued). Reads the
 *  cheap gates and schedules autoRetryTurn — every gate is RE-CHECKED at fire
 *  time, so this only has to be safe, not race-proof. */
export async function maybeScheduleTurnRetry(
  ctx: MutationCtx,
  message: Doc<"messages">,
  errorKind: string | undefined,
  finalTextLen: number,
): Promise<void> {
  if (errorKind !== SESSION_INIT_CONFLICT_CODE) return;
  // REGULAR chats only: the utility kinds (documentary/summarizer/curator) have
  // their OWN failure handling, and finalize runs their correlation side effects
  // right after this hook — an auto-retry racing those (e.g. a documentary
  // correlate clearing pendingFetch on the errored turn) would lose the retried
  // result (codex P2). Their existing error paths stay authoritative.
  const chat = await ctx.db.get(message.chatId);
  if (chat === null || chat.kind != null) return;
  const partCount = (
    await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(1)
  ).length;
  // Schedule-time busy = a QUEUED follow-up only (see retryDecision.chatBusy for
  // why pending must NOT block here).
  const queuedRow = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", message.chatId).eq("status", "queued"),
    )
    .first();
  // The attempt count rides the outbox chain: the newest sent-or-pending row is
  // the row that dispatched THIS turn. `pending` is INCLUDED for the bound: a
  // retry that errors before its own sent-flip would otherwise re-read the
  // ORIGINAL row's attempt (0) and ping-pong past MAX (codex P2 follow-through).
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
  const newest = rows
    .filter((r) => r !== null)
    .sort((a, b) => b!._creationTime - a!._creationTime)[0];
  const decision = retryDecision({
    status: message.status === "error" ? "error" : String(message.status),
    errorKind: errorKind ?? null,
    finalTextLen,
    partCount,
    chatBusy: queuedRow !== null,
    lastAttempt: newest?.autoRetryAttempt ?? 0,
  });
  if (decision === null) return;
  await ctx.scheduler.runAfter(
    decision.delayMs,
    internal.turnRetry.autoRetryTurn,
    {
      chatId: message.chatId,
      messageId: message._id,
      attempt: decision.attempt,
    },
  );
  console.log(
    `[turnRetry] scheduled attempt ${decision.attempt}/${MAX_TURN_RETRIES} in ${decision.delayMs}ms for chat ${message.chatId}`,
  );
}

async function hasActiveOutbox(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<boolean> {
  for (const status of ["pending", "queued"] as const) {
    const row = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", status),
      )
      .first();
    if (row !== null) return true;
  }
  return false;
}

/** The delayed re-run. EVERY precondition is re-verified against the live state
 *  (the 5–15s wait is an eternity of possible user actions) — any mismatch is a
 *  silent no-op: the world has moved on and the error card stands as-is. */
export const autoRetryTurn = internalMutation({
  args: {
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    attempt: v.number(),
  },
  handler: async (ctx, { chatId, messageId, attempt }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return; // chat deleted meanwhile
    // Regular chats only (mirrors the schedule-time gate — defense in depth).
    if (chat.kind != null) return;
    const message = await ctx.db.get(messageId);
    // Gone (user deleted / manually regenerated) or repainted — stand down.
    if (
      message === null ||
      message.role !== "assistant" ||
      message.status !== "error" ||
      message.errorCode !== SESSION_INIT_CONFLICT_CODE ||
      (message.text ?? "") !== ""
    ) {
      return;
    }
    const parts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .take(1);
    if (parts.length > 0) return; // something visible landed after all
    // The chat must still be idle: a pending/queued row means a newer send is in
    // flight (or held) — retrying the old turn would re-order the conversation.
    if (await hasActiveOutbox(ctx, chatId)) return;
    // No OTHER turn streaming (defense in depth; the errored turn's own
    // streamingText row was deleted by its finalize).
    const streaming = await ctx.db
      .query("messages")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", "streaming"),
      )
      .first();
    if (streaming !== null) return;
    // The errored card must still be the LOGICALLY-LAST message, immediately
    // preceded by the user turn we are about to re-run (same ordering the
    // regenerate path uses — lib/messageOrder.compareOrder).
    const chatMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    const ordered = [...chatMessages].sort(compareOrder);
    const last = ordered[ordered.length - 1];
    if (!last || last._id !== messageId) return;
    const lastUser = ordered[ordered.length - 2];
    if (!lastUser || lastUser.role !== "user") return;

    // --- All guards passed: this is a pure re-run. -------------------------
    // 1. Drop the empty error card (nothing visible is lost — guarded above).
    //    Purge any bookmark anchored to it first (placeable mid-stream via the
    //    message menu) — this path bypasses messages.deleteMessage's cleanup.
    await purgeBookmarksForMessages(
      ctx,
      last.userId,
      chatId,
      new Set([messageId]),
    );
    await ctx.db.delete(messageId);
    // 2. Rebuild the outbox row from the user turn — same shape as the manual
    //    regenerate (messages.deleteMessage), incl. file attachments + per-turn
    //    routing, PLUS the attempt stamp that bounds the chain.
    const partDocs = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", lastUser._id))
      .collect();
    const attachments: {
      storageId: Id<"_storage">;
      filename: string;
      mimeType: string;
    }[] = [];
    for (const d of partDocs) {
      if (d.part.kind === "file") {
        attachments.push({
          storageId: d.part.storageId,
          filename: d.part.filename,
          mimeType: d.part.mimeType,
        });
      }
    }
    const routedAgent =
      lastUser.routedInstanceName && lastUser.routedAgentId
        ? {
            instanceName: lastUser.routedInstanceName,
            agentId: lastUser.routedAgentId,
          }
        : undefined;
    const outboxId = await ctx.db.insert("outbox", {
      chatId,
      userId: chat.userId,
      // Unique key (Date.now() is deterministic in a mutation) so the send
      // idempotency guard never dedupes the retry against the original send.
      clientMessageId: `autoretry-${lastUser._id}-${attempt}-${Date.now()}`,
      messageId: lastUser._id,
      text: lastUser.text,
      attachmentIds: attachments.map((a) => a.storageId),
      attachments,
      status: "pending",
      ...(routedAgent ? { routedAgent } : {}),
      autoRetryAttempt: attempt,
    });
    // 3. Ride the regenerate chain: gateway session reset (clears the conflicted
    //    init state + re-hydrates the truncated history), THEN the re-dispatch.
    //    dispatchReset is fully failure-safe: a failed reset/config marks the row
    //    failed with a surfaced reason — never silent, never pending-forever.
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchReset, {
      chatId,
      userId: chat.userId,
      regenerateOutboxId: outboxId,
      ...(routedAgent ? { routedAgent } : {}),
    });
    await ctx.db.patch(chatId, { updatedAt: Date.now() });
    // Observability: a content-free marker so the trace timeline shows the
    // automatic recovery (kind mirrors openclaw.reset's metadata discipline).
    try {
      await ctx.scheduler.runAfter(0, internal.observability.recordEvent, {
        kind: "chat.auto_retry",
        direction: "internal",
        principalType: "system",
        principalId: "convex",
        chatId,
        correlationId: `${chatId}:autoretry`,
        meta: JSON.stringify({ attempt, max: MAX_TURN_RETRIES }),
      });
    } catch (e) {
      console.error("[turnRetry] trace failed (non-fatal):", (e as Error)?.message ?? e);
    }
  },
});
