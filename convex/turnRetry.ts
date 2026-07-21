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
import { writeTraceEvent } from "./observability";

/** The stable error code the bridge classifier mints for the gateway's
 *  session-init OCC conflict (normalizer SESSION_INIT_CONFLICT_RE). */
export const SESSION_INIT_CONFLICT_CODE = "session_init_conflict";
/** A run the gateway CLOSED CLEANLY with zero content and ZERO WORK (silent
 *  NO_REPLY on a top-level turn, or an end-of-run grace with nothing) — the
 *  bridge's empty-result guard classifies it (live prod 2026-07-19 ×3:
 *  7-8 min thinking runs settling empty; reproduced live 2026-07-20 via the
 *  NO_REPLY sentinel). Zero content AND zero work → re-dispatching bills
 *  nothing and is safe. The sibling `empty_response` (the turn WORKED but
 *  delivered nothing — e.g. a billed media generation whose delivery dropped)
 *  is deliberately NOT retryable: re-running would duplicate paid work
 *  (codex P1); its error card surfaces the delivery failure instead. */
export const EMPTY_RESPONSE_RETRY_CODE = "empty_response_silent";
/** TRANSIENT upstream failure (provider 5xx / overload / network cut — e.g.
 *  a VPN flip severing the gateway's provider connection): classified by the
 *  bridge normalizers from STRICT transient markers with never-transient
 *  exclusions (auth/quota/invalid/rate-limit never match). Zero-content gates
 *  below make the re-dispatch equivalent to the user's own re-send (live prod
 *  2026-07-20: OpenAI internal error, manual re-send succeeded). */
export const PROVIDER_INTERNAL_CODE = "provider_internal";

/** The errorKinds a finalize may auto-retry (all zero-content classes). */
export const RETRYABLE_KINDS: ReadonlySet<string> = new Set([
  SESSION_INIT_CONFLICT_CODE,
  EMPTY_RESPONSE_RETRY_CODE,
  PROVIDER_INTERNAL_CODE,
]);

/** Bounded chain: at most this many automatic re-dispatches per turn. */
export const MAX_TURN_RETRIES = 2;

/** Per-kind attempt bound. COST ARBITRATION (codex P1, decided): a silent
 *  close DID bill a model completion (the Fabien runs reasoned ~7 min before
 *  closing empty), so its automatic re-dispatch re-bills one — exactly what
 *  the user's own manual re-send would do (and did, successfully). ONE
 *  bounded attempt keeps that convenience while capping the degenerate case
 *  (an agent that always answers silence) at a single extra completion; the
 *  init-conflict class keeps 2 (it fails BEFORE any generation — retries are
 *  free). */
export function maxRetriesForKind(kind: string): number {
  // provider_internal keeps 2: the failure happens AT the provider call and
  // the zero-content gate proves nothing was generated — a retry bills
  // nothing extra (the 5s/15s curve rides out blips and VPN flips).
  return kind === EMPTY_RESPONSE_RETRY_CODE ? 1 : MAX_TURN_RETRIES;
}

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
  if (input.errorKind === null || !RETRYABLE_KINDS.has(input.errorKind)) return null;
  // ZERO-CONTENT only: anything visible means the turn did real work — deleting
  // it would lose user-facing content, so the honest error card stays.
  // Reviewed edge (codex, rejected): "a private ack could inflate finalTextLen
  // and kill the retry" cannot occur for THIS errorKind — the gateway throws at
  // session INITIALIZATION, before the model generates anything, and an ack is
  // model-generated text (pendingAckText is per-turn state reset at beginTurn).
  // Were it ever wrong, the failure mode is the honest error card (fail-safe).
  if (input.finalTextLen > 0 || input.partCount > 0) return null;
  if (input.chatBusy) return null;
  if (input.lastAttempt >= maxRetriesForKind(input.errorKind)) return null;
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
  if (errorKind === undefined || !RETRYABLE_KINDS.has(errorKind)) return;
  // REGULAR chats only: the utility kinds (documentary/summarizer/curator) have
  // their OWN failure handling, and finalize runs their correlation side effects
  // right after this hook — an auto-retry racing those (e.g. a documentary
  // correlate clearing pendingFetch on the errored turn) would lose the retried
  // result (codex P2). Their existing error paths stay authoritative.
  const chat = await ctx.db.get(message.chatId);
  if (chat === null || chat.kind != null) return;
  const partCount = await countBlockingParts(ctx, message._id);
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
  const lastAttempt = newest?.autoRetryAttempt ?? 0;
  const decision = retryDecision({
    status: message.status === "error" ? "error" : String(message.status),
    errorKind: errorKind ?? null,
    finalTextLen,
    partCount,
    chatBusy: queuedRow !== null,
    lastAttempt,
  });
  if (decision === null) {
    // EXHAUSTED is the chain's honest terminal ("the retry did NOT fix it"):
    // trace it so /traces tells the full story; the other null reasons
    // (content landed / chat busy) are the world moving on — silent.
    if (lastAttempt >= maxRetriesForKind(errorKind)) {
      try {
        await writeTraceEvent(ctx, {
        kind: "chat.auto_retry",
        direction: "internal",
        principalType: "system",
        principalId: "turn-retry",
        chatId: message.chatId,
        correlationId: `${message.chatId}:${message._id}`,
        meta: JSON.stringify({
          phase: "exhausted",
          errorKind,
          attempts: lastAttempt,
          messageId: message._id,
        }),
        });
      } catch (e) {
        console.error(
          "[turnRetry] trace failed (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    }
    return;
  }
  await ctx.scheduler.runAfter(
    decision.delayMs,
    internal.turnRetry.autoRetryTurn,
    {
      chatId: message.chatId,
      messageId: message._id,
      attempt: decision.attempt,
    },
  );
  // VISIBLE resilience (the Claude-Code-style countdown): the error card reads
  // this to show "retrying (N/M) in Xs…" instead of a dead-end error.
  const maxAttempts = maxRetriesForKind(errorKind);
  await ctx.db.patch(message._id, {
    autoRetry: {
      attempt: decision.attempt,
      maxAttempts,
      firesAt: Date.now() + decision.delayMs,
    },
  });
  // TRACE the whole chain (schedule -> fire outcome; the retried turn's own
  // dispatch/finalize traces follow) so /api/v1/traces tells BOTH the nature
  // of the failure (errorKind) and whether the retry resolved it. BEST-EFFORT
  // (codex P2): telemetry must never break the finalize it rides in.
  try {
    await writeTraceEvent(ctx, {
    kind: "chat.auto_retry",
    direction: "internal",
    principalType: "system",
    principalId: "turn-retry",
    chatId: message.chatId,
    correlationId: `${message.chatId}:${message._id}`,
    meta: JSON.stringify({
      phase: "scheduled",
      errorKind,
      attempt: decision.attempt,
      maxAttempts,
      delayMs: decision.delayMs,
      messageId: message._id,
    }),
    });
  } catch (e) {
    console.error("[turnRetry] trace failed (non-fatal):", (e as Error)?.message ?? e);
  }
  console.log(
    `[turnRetry] scheduled attempt ${decision.attempt}/${maxAttempts} (${errorKind}) in ${decision.delayMs}ms for chat ${message.chatId}`,
  );
}

/** Parts that BLOCK a retry = user-visible content or real (billed) work.
 *  `provenance` parts NEVER block: they report the prompt's injected context
 *  (knowledge/hindsight) and are attached to every turn on instrumented
 *  gateways — counting them would disable the retry exactly where it matters
 *  (live prod 2026-07-20: every errored ataraxis turn carried 2-3 provenance
 *  parts). The bridge-synthesized Hermes mixture-of-agents STRUCTURE marker is
 *  conditionally exempt — see countBlockingParts (codex P1: aggregation may
 *  have started real reference work). */
function isBlockingPart(part: { kind: string; name?: string }): boolean {
  if (part.kind === "provenance") return false;
  return true;
}

async function countBlockingParts(
  ctx: MutationCtx,
  messageId: Id<"messages">,
): Promise<number> {
  const parts = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  let blocking = 0;
  let moaMarkers = 0;
  for (const d of parts) {
    const part = d.part as { kind: string; name?: string };
    if (part.kind === "tool" && part.name === "mixture_of_agents") {
      moaMarkers++;
      continue; // judged below against the children's actual outcome
    }
    if (isBlockingPart(part)) blocking++;
  }
  if (moaMarkers > 0) {
    // The MoA marker is emitted when aggregation STARTS — reference agents
    // may have completed real (billed) work even though the parent errored
    // empty (codex P1). It stays non-blocking ONLY when every child row of
    // this message is terminal error/aborted with no delivered result (the
    // everything-failed-at-connect shape, live 2026-07-20); any running or
    // productive child blocks the retry.
    // TARGETED read (codex P2 — an unbounded by_chat walk on a long chat
    // could blow the finalize transaction): only THIS turn's children.
    const children = await ctx.db
      .query("subAgents")
      .withIndex("by_parent_message", (q) =>
        q.eq("parentMessageId", messageId),
      )
      .collect();
    // NO observed children = NO EVIDENCE (the observer's upsert is async and
    // may not have landed — codex P1): the marker blocks. Exemption requires
    // POSITIVE proof that every child died fruitless — terminal failure, no
    // result, AND no tool activity (a child that RAN a tool did real work
    // with possible external effects even if it then failed — codex P1).
    let allDeadFruitless = children.length > 0;
    for (const c of children) {
      if (!allDeadFruitless) break;
      const dead = c.status === "error" || c.status === "aborted";
      const fruitless = !(
        typeof c.resultText === "string" && c.resultText.trim() !== ""
      );
      const ranTool =
        (await ctx.db
          .query("subAgentToolParts")
          .withIndex("by_child", (q) =>
            q.eq("childSessionKey", c.childSessionKey),
          )
          .take(1)).length > 0;
      if (!dead || !fruitless || ranTool) allDeadFruitless = false;
    }
    if (!allDeadFruitless) blocking += moaMarkers;
  }
  return blocking;
}

/** Delete a zero-content assistant card WITH its dependent rows — bookmarks
 *  (placeable mid-stream via the message menu; these paths bypass
 *  messages.deleteMessage's cleanup), parts (provenance rows on instrumented
 *  gateways — deleting only the message orphaned them), and sub-agent rows +
 *  their detail (stale activity must not show against the replacement turn).
 *  Shared by the auto-retry (autoRetryTurn) and the preempt re-park
 *  (preemptRepark.ts) — both re-run the turn, so the dead card must go. */
export async function deleteTurnCardCascade(
  ctx: MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
  messageId: Id<"messages">,
): Promise<void> {
  await purgeBookmarksForMessages(ctx, userId, chatId, new Set([messageId]));
  const cardParts = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  for (const d of cardParts) {
    await ctx.db.delete(d._id);
  }
  const cardSubAgents = await ctx.db
    .query("subAgents")
    .withIndex("by_parent_message", (q) => q.eq("parentMessageId", messageId))
    .collect();
  for (const sa of cardSubAgents) {
    const saParts = await ctx.db
      .query("subAgentToolParts")
      .withIndex("by_child", (q) =>
        q.eq("childSessionKey", sa.childSessionKey),
      )
      .collect();
    for (const d of saParts) await ctx.db.delete(d._id);
    const saThreads = await ctx.db
      .query("subAgentInteractions")
      .withIndex("by_child", (q) =>
        q.eq("childSessionKey", sa.childSessionKey),
      )
      .collect();
    for (const d of saThreads) await ctx.db.delete(d._id);
    await ctx.db.delete(sa._id);
  }
  await ctx.db.delete(messageId);
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
    // OUTCOME trace (fire side of the schedule trace): stand-downs carry their
    // reason, so /traces explains a retry that did NOT run; the redispatch
    // trace closes the chain (the re-run's own dispatch/finalize follow).
    const traceOutcome = async (outcome: string, reason?: string) => {
      try {
        await writeTraceEvent(ctx, {
        kind: "chat.auto_retry",
        direction: "internal",
        principalType: "system",
        principalId: "turn-retry",
        chatId,
        correlationId: `${chatId}:${messageId}`,
        meta: JSON.stringify({
          phase: "fired",
          outcome,
          ...(reason ? { reason } : {}),
          attempt,
          messageId,
        }),
        });
      } catch (e) {
        console.error(
          "[turnRetry] trace failed (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    };
    // Stand-down helper: clear the visible countdown stamp (the card must not
    // keep promising a retry that will never come) + trace the reason.
    const standDown = async (reason: string, clearStamp = true) => {
      if (clearStamp) {
        const m = await ctx.db.get(messageId);
        if (m !== null && m.autoRetry !== undefined) {
          await ctx.db.patch(messageId, { autoRetry: undefined });
        }
      }
      await traceOutcome("stand_down", reason);
    };
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      await traceOutcome("stand_down", "chat_deleted");
      return;
    }
    // Regular chats only (mirrors the schedule-time gate — defense in depth).
    if (chat.kind != null) {
      await standDown("utility_chat");
      return;
    }
    const message = await ctx.db.get(messageId);
    // Gone (user deleted / manually regenerated) or repainted — stand down.
    if (
      message === null ||
      message.role !== "assistant" ||
      message.status !== "error" ||
      !RETRYABLE_KINDS.has(message.errorCode ?? "") ||
      (message.text ?? "") !== ""
    ) {
      await standDown("message_changed", message !== null);
      return;
    }
    if ((await countBlockingParts(ctx, messageId)) > 0) {
      await standDown("visible_parts_landed");
      return;
    }
    // The chat must still be idle: a pending/queued row means a newer send is in
    // flight (or held) — retrying the old turn would re-order the conversation.
    if (await hasActiveOutbox(ctx, chatId)) {
      await standDown("chat_busy");
      return;
    }
    // No OTHER turn streaming (defense in depth; the errored turn's own
    // streamingText row was deleted by its finalize).
    const streaming = await ctx.db
      .query("messages")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", "streaming"),
      )
      .first();
    if (streaming !== null) {
      await standDown("another_turn_streaming");
      return;
    }
    // The errored card must still be the LOGICALLY-LAST message, immediately
    // preceded by the user turn we are about to re-run (same ordering the
    // regenerate path uses — lib/messageOrder.compareOrder).
    const chatMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    const ordered = [...chatMessages].sort(compareOrder);
    const last = ordered[ordered.length - 1];
    if (!last || last._id !== messageId) {
      await standDown("not_last_message");
      return;
    }
    const lastUser = ordered[ordered.length - 2];
    if (!lastUser || lastUser.role !== "user") {
      await standDown("no_preceding_user_turn");
      return;
    }

    // --- All guards passed: this is a pure re-run. -------------------------
    // 1. Drop the empty error card (nothing visible is lost — guarded above).
    await deleteTurnCardCascade(ctx, last.userId, chatId, messageId);
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
      // Quote-reply: the auto-retried dispatch must re-carry the excerpt,
      // or the re-sent instruction loses its targeted passage.
      ...(lastUser.quotedExcerpt
        ? { quotedExcerpt: lastUser.quotedExcerpt }
        : {}),
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
    // Observability: the REDISPATCH outcome closes the schedule->fire chain
    // (same correlationId as the schedule trace); the re-run's own dispatch +
    // finalize traces then show whether the retry RESOLVED the failure.
    await traceOutcome("redispatch", message.errorCode ?? undefined);
  },
});
