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
import {
  hasQuotes,
  outboxQuoteFieldsFor,
  quotedRefsOf,
} from "./lib/quoteReply";
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
/** The provider-side conversation can no longer be resumed (upstream's own words). */
export const SESSION_GONE_CODE = "session_gone";
/** The gateway ARCHIVED the conversation (upstream auto-archives an idle dashboard
 *  session after 7 days) and refuses new work on it. The bridge restores it before
 *  every send, so this class means the restore did not take — a failed patch, or the
 *  janitor winning the race. Retrying is a genuine second chance, because the retry
 *  runs the restore again; and it is SAFE by the same argument as the init conflict:
 *  upstream refuses at ADMISSION, before the model generates anything, so the
 *  zero-content gate below is met by construction and nothing is re-billed. */
export const SESSION_ARCHIVED_CODE = "session_archived";
/** A context overflow on a turn whose session the bridge's pre-send guard had JUST
 *  compacted successfully (W2). The prompt that overflowed was assembled around the
 *  shrink, so the same send composed again is a genuinely different one — unlike a
 *  plain `context_length`, which is a wall a retry would only hit harder. Bounded to
 *  ONE attempt: if a freshly compacted session still does not fit, the honest card
 *  and its two wired actions (compact / branch) are the right answer. */
export const CONTEXT_LENGTH_COMPACTED_CODE = "context_length_compacted";

/** The errorKinds a finalize may auto-retry (all zero-content classes). */
export const RETRYABLE_KINDS: ReadonlySet<string> = new Set([
  // The gateway says the conversation is gone for good. The finalize drops the stored
  // session before this runs (dropUntrustedProviderSession precedes the schedule) WHEN the
  // terminal named one — a chat with no stored session has nothing to name, and there the
  // epoch alone moves. The re-dispatch then opens a fresh conversation, and the rehydration
  // re-ships the history WHEN it applies: the bridge skips it when rehydration is disabled
  // and on any turn carrying an attachment (codex). What the class buys in every case is a
  // second attempt the reader does not have to ask for, instead of the gateway's `/new`.
  // Safe by the same argument as the init conflict: the gateway refuses at PREFLIGHT
  // COMPACTION, before the model generates anything, so the zero-content gate below is
  // met by construction and a retry repeats no work.
  SESSION_GONE_CODE,
  SESSION_ARCHIVED_CODE,
  SESSION_INIT_CONFLICT_CODE,
  EMPTY_RESPONSE_RETRY_CODE,
  PROVIDER_INTERNAL_CODE,
  CONTEXT_LENGTH_COMPACTED_CODE,
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
  // context_length_compacted keeps 1 for the same reason as the silent close: the
  // provider refused an oversized prompt, and a second identical refusal buys the
  // user nothing but another wait.
  // session_gone keeps ONE: the first attempt lands on a fresh session, and a second
  // failure means the fresh one is failing too — another wait buys the reader nothing.
  if (kind === SESSION_GONE_CODE) return 1;
  // session_archived keeps ONE: the retry's own pre-send restore is the second
  // chance. If THAT is refused too, the restore is failing for a reason more waiting
  // will not change — an operator fact, not a blip.
  if (kind === SESSION_ARCHIVED_CODE) return 1;
  return kind === EMPTY_RESPONSE_RETRY_CODE ||
    kind === CONTEXT_LENGTH_COMPACTED_CODE
    ? 1
    : MAX_TURN_RETRIES;
}

/** Backoff before attempt N+1 (indexed by the FAILED attempt number). Aligned
 *  with upstream's own retry curve (Telegram: base 5s ×2^n, cap 60s); the live
 *  incident's churn window (≥18s) is covered by the second delay. */
export const RETRY_DELAY_MS: readonly number[] = [5_000, 15_000];

/**
 * The attempt limit that governs a turn: the CHAIN's, when the turn is a retry.
 *
 * DECIDED (codex pass 2): when a retry fails with a different class than the one
 * that started the chain, the chain's limit — fixed by the FIRST failure — governs
 * both whether a further attempt runs and what the card reports. One turn of the
 * user's gets one retry budget, however its failures are labelled on the way; the
 * card's "N of M allowed" is then the rule that was actually applied, never a
 * figure from a class that did not decide anything. The per-class cost caps hold
 * under it: the costly class (a silent close re-bills a completion) allows ONE, and
 * a chain started by a free class (provider_internal, 2) whose first retry closes
 * silently spends at most that one re-billed completion on its second attempt.
 */
export function chainLimit(
  errorKind: string,
  chainMaxAttempts: number | undefined,
): number {
  return chainMaxAttempts ?? maxRetriesForKind(errorKind);
}

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
  /** The limit of the chain this turn is a retry in (see `chainLimit`). Absent =
   *  not a retry, or a chain recorded before the limit travelled: this failure's
   *  own class decides. */
  chainMaxAttempts?: number;
}): { attempt: number; delayMs: number } | null {
  if (input.status !== "error") return null;
  if (input.errorKind === null || !RETRYABLE_KINDS.has(input.errorKind)) return null;
  // ZERO-CONTENT only: anything visible means the turn did real work — deleting
  // it would lose user-facing content, so the honest error card stays.
  // Reviewed edge (codex, rejected): "a private ack could inflate finalTextLen
  // and kill the retry" cannot occur for THESE errorKinds — the gateway throws at
  // session INITIALIZATION, before the model generates anything, and an ack is
  // model-generated text (pendingAckText is per-turn state reset at beginTurn).
  // Were it ever wrong, the failure mode is the honest error card (fail-safe).
  //
  // That argument is why `session_write_conflict` is NOT in RETRYABLE_KINDS. Upstream
  // throws the writer-claim rebound at transcript commits AFTER the model ran, where
  // tools may have had external effects — and, with the same text, before generation.
  // The class cannot promise "nothing happened yet", and zero visible content does not
  // mean no work happened, so an automatic re-dispatch could repeat it (codex). A rebound
  // the bridge PROVES pre-generation (no generation frame on an unbroken stream) arrives
  // as `session_init_conflict` instead; see Normalizer.writeReboundBeforeGeneration.
  if (input.finalTextLen > 0 || input.partCount > 0) return null;
  if (input.chatBusy) return null;
  if (input.lastAttempt >= chainLimit(input.errorKind, input.chainMaxAttempts)) {
    return null;
  }
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
  /** The attempt count of the row that dispatched this turn, when the CALLER
   *  already knows it.
   *
   *  The scan below reads it off the newest `sent`/`pending` outbox row — which
   *  works from `finalize`, where that row is still in one of those states. It
   *  does NOT work from `failDispatch`, which flips the row to `failed` first:
   *  the chain's own row becomes invisible to the scan, `lastAttempt` falls
   *  back to 0, and a persistent failure re-arms attempt 1 for ever. Passing
   *  the known value keeps the bound real on that path. */
  knownAttempt?: number,
  /** …and the chain's limit from that same row (`autoRetryMaxAttempts`), for the
   *  same reason: the scan cannot see the row it was written on. */
  knownMaxAttempts?: number,
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
  const lastAttempt = knownAttempt ?? newest?.autoRetryAttempt ?? 0;
  // The limit of the chain this turn belongs to, when it is a retry: fixed by the
  // class that STARTED the chain, not by this failure's (a provider_internal chain
  // allows 2; its retry ending as a silent close allows 1 — "2/1" is nonsense).
  const chainMaxAttempts =
    lastAttempt > 0
      ? knownAttempt !== undefined
        ? knownMaxAttempts
        : newest?.autoRetryMaxAttempts
      : undefined;
  const limit = chainLimit(errorKind, chainMaxAttempts);
  const decision = retryDecision({
    status: message.status === "error" ? "error" : String(message.status),
    errorKind: errorKind ?? null,
    finalTextLen,
    partCount,
    chatBusy: queuedRow !== null,
    lastAttempt,
    chainMaxAttempts,
  });
  if (decision === null) {
    // EXHAUSTED is the chain's honest terminal ("the retry did NOT fix it"):
    // trace it so /traces tells the full story; the other null reasons
    // (content landed / chat busy) are the world moving on — silent.
    if (lastAttempt >= limit) {
      // …and on the card: this failure IS the retry's result. Its copy may say the
      // turn was retried — here, and only here, that is true.
      await ctx.db.patch(message._id, {
        autoRetryOutcome: {
          outcome: "exhausted",
          attempt: lastAttempt,
          maxAttempts: Math.max(limit, lastAttempt),
          at: Date.now(),
        },
      });
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
  // Delegated work on the card: no retry, and the card says why (see
  // delegationBlocksRetry). Recorded as a stand-down — the retry was due and did not run.
  if (await delegationBlocksRetry(ctx, message)) {
    await ctx.db.patch(message._id, {
      autoRetryOutcome: {
        outcome: "stood_down",
        reason: DELEGATED_WORK_REASON,
        attempt: decision.attempt,
        maxAttempts: limit,
        at: Date.now(),
      },
    });
    try {
      await writeTraceEvent(ctx, {
        kind: "chat.auto_retry",
        direction: "internal",
        principalType: "system",
        principalId: "turn-retry",
        chatId: message.chatId,
        correlationId: `${message.chatId}:${message._id}`,
        meta: JSON.stringify({
          phase: "not_scheduled",
          outcome: "stand_down",
          reason: DELEGATED_WORK_REASON,
          attempt: decision.attempt,
          messageId: message._id,
        }),
      });
    } catch (e) {
      console.error("[turnRetry] trace failed (non-fatal):", (e as Error)?.message ?? e);
    }
    return;
  }
  // The stamp doubles as the timer's IDENTITY: the fire proceeds only while the card
  // still carries this exact stamp (see autoRetryTurn).
  const firesAt = Date.now() + decision.delayMs;
  await ctx.scheduler.runAfter(
    decision.delayMs,
    internal.turnRetry.autoRetryTurn,
    {
      chatId: message.chatId,
      messageId: message._id,
      attempt: decision.attempt,
      firesAt,
    },
  );
  // VISIBLE resilience (the Claude-Code-style countdown): the error card reads
  // this to show "retrying (N/M) in Xs…" instead of a dead-end error.
  const maxAttempts = limit;
  await ctx.db.patch(message._id, {
    autoRetry: {
      attempt: decision.attempt,
      maxAttempts,
      firesAt,
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

/** The stand-down reason for a card whose turn had already delegated work. */
export const DELEGATED_WORK_REASON = "delegated_work";

/** Rows a delegation check reads at most, per query. Hitting the bound without a
 *  verdict counts as delegation: a bound must limit the transaction, never decide
 *  that a retry is safe. */
const DELEGATION_SCAN_BOUND = 16;

/**
 * Is there delegated work a re-run could repeat, race or erase?
 *
 * The part gate above sees only the message's own parts, and a silent close is only
 * "zero work" as far as the frames the bridge SAW (prod 2026-09-28: a card with zero
 * parts and `toolCalls 0` had three sub-agent rows, fallback-anchored to it, born
 * while its run was the one on the session). A child's row is written by the
 * observer asynchronously, so "no row anchored to the card" at fire time is not
 * proof there is none. Three DURABLE signals are read instead, each bounded:
 *
 *   1. A sub-agent row (background tasks excepted, see below) born in this chat
 *      since the card was created, anchored ANYWHERE — or nowhere. Its existence proves the session delegated during this
 *      turn, which the zero-work premise of the retryable classes denies; its
 *      siblings may simply not have registered yet. Dead or alive, it blocks. (That
 *      supersedes the earlier rule that let a failed, tool-less, run-id-less row go
 *      with the card: deleting such a row is harmless in itself, but what it proves
 *      — that frames were missing — makes the retry unsafe.)
 *   2. A row anchored to the card, whatever its age (an anchor can be set late).
 *   3. A sub-agent still RUNNING anywhere in the chat — the session is busy with
 *      delegated work, the same fact `isChatBusy` holds sends for. Background-task
 *      rows are excluded, as there — by index, so they cannot fill the window.
 *
 * The Hermes MoA marker keeps its own, older verdict (`countBlockingParts`): rows
 * anchored to a card that carries it are judged there, so an everything-failed-at-
 * connect aggregation is still retried.
 *
 * RESIDUAL, stated: a child whose first frame has not reached Convex by the time
 * the retry fires is invisible to all three. The retry fires ≥5 s after the
 * finalize, and a child's frames are relayed as they arrive (prod: rows written
 * 0.2 s after the child's first frame), so this needs a bridge that is itself not
 * relaying — the same condition that already makes the card unreliable.
 */
async function delegationBlocksRetry(
  ctx: MutationCtx,
  message: Doc<"messages">,
): Promise<boolean> {
  const moaCard = (
    await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(DELEGATION_SCAN_BOUND * 4)
  ).some((d) => {
    const part = d.part as { kind: string; name?: string };
    return part.kind === "tool" && part.name === "mixture_of_agents";
  });
  const judgedByMoaGate = (r: Doc<"subAgents">) =>
    moaCard && r.parentMessageId === message._id;

  // The CHAT-WIDE checks read sub-agent rows only — kind "subagent", or absent on
  // rows written before the field — through indexes that never return a
  // background-task row. A task (image generation, a long tool) belongs to whichever
  // turn started it and does not hold the session (`isChatBusy` exempts it too):
  // counted here, sixteen of them filled the window and a task from ANOTHER turn made
  // this card claim it had delegated (codex pass 2). Tasks anchored to THIS card are
  // still counted, below.
  const SUBAGENT_KINDS = [undefined, "subagent"] as const;
  for (const kind of SUBAGENT_KINDS) {
    const running = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_kind", (q) =>
        q.eq("chatId", message.chatId).eq("status", "running").eq("kind", kind),
      )
      .take(DELEGATION_SCAN_BOUND);
    // A full window of NON-exempt rows without a verdict stays conservative.
    if (running.length === DELEGATION_SCAN_BOUND) return true;
    if (running.some((r) => !judgedByMoaGate(r))) return true;

    const bornSince = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_kind", (q) =>
        q
          .eq("chatId", message.chatId)
          .eq("kind", kind)
          .gte("_creationTime", message._creationTime),
      )
      .take(DELEGATION_SCAN_BOUND);
    if (bornSince.length === DELEGATION_SCAN_BOUND) return true;
    if (bornSince.some((r) => !judgedByMoaGate(r))) return true;
  }

  const anchored = await ctx.db
    .query("subAgents")
    .withIndex("by_parent_message", (q) => q.eq("parentMessageId", message._id))
    .take(DELEGATION_SCAN_BOUND);
  if (anchored.length === DELEGATION_SCAN_BOUND) return true;
  return anchored.some((r) => !judgedByMoaGate(r));
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
  await purgeBookmarksForMessages(ctx, chatId, new Set([messageId]));
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

/**
 * Is a send still in flight (pending) or held (queued) in this chat — and whose?
 *
 * `own`: the only active row is the one that dispatched THIS card, still `pending`
 * because its confirmation had not landed (a gateway error can beat the dispatch's
 * sent-flip — turnRetry's own schedule-time note). No newer turn exists, so the card
 * must not say the conversation moved on. It still BLOCKS the retry: that dispatch
 * has not reported back, and if it later fails, `failDispatch` paints its own error
 * card for the same turn — a retry started meanwhile would leave the reader with two
 * answers to one question.
 * `other`: a row that is provably not this card's — a newer send, or a held one.
 * A card that does not know its dispatch row (an older bridge sends none) cannot
 * prove a row is another's, and reads as `own`: the neutral wording is true either way.
 */
async function activeOutbox(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  ownDispatchOutboxId: string | undefined,
): Promise<"none" | "own" | "other"> {
  let found: "none" | "own" = "none";
  for (const status of ["pending", "queued"] as const) {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", status),
      )
      .take(2);
    for (const row of rows) {
      if (
        ownDispatchOutboxId !== undefined &&
        String(row._id) !== ownDispatchOutboxId
      ) {
        return "other";
      }
      found = "own";
    }
  }
  return found;
}

/** The delayed re-run. EVERY precondition is re-verified against the live state
 *  (the 5–15s wait is an eternity of possible user actions) — any mismatch is a
 *  silent no-op: the world has moved on and the error card stands as-is. */
export const autoRetryTurn = internalMutation({
  args: {
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    attempt: v.number(),
    /** The countdown stamp the schedule wrote — this timer's identity. Optional only
     *  so a timer scheduled before it existed still runs (the pre-token behaviour). */
    firesAt: v.optional(v.number()),
  },
  handler: async (ctx, { chatId, messageId, attempt, firesAt }) => {
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
    // keep promising a retry that will never come), RECORD why on the card, and
    // trace the reason. Recorded because the card outlives the countdown: before
    // this, a retry that stood down left no fact behind, and the card's copy
    // claimed a retry that never ran (prod 2026-09-28, `another_turn_streaming`).
    const standDown = async (reason: string, clearStamp = true) => {
      if (clearStamp) {
        const m = await ctx.db.get(messageId);
        if (m !== null) {
          await ctx.db.patch(messageId, {
            autoRetry: undefined,
            autoRetryOutcome: {
              outcome: "stood_down",
              reason,
              attempt,
              maxAttempts:
                m.autoRetry?.maxAttempts ??
                maxRetriesForKind(m.errorCode ?? ""),
              at: Date.now(),
            },
          });
        }
      }
      await traceOutcome("stand_down", reason);
    };
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      await traceOutcome("stand_down", "chat_deleted");
      return;
    }
    // A STALE TIMER touches nothing. Every generation change clears the stamp (a
    // reopen, a recovery, a new finalize), and a new failure writes its own — so a
    // card that no longer carries THIS timer's stamp belongs to another generation.
    // Writing a stand-down there would describe the old failure on the new card and
    // could wipe the new retry's countdown (codex pass 4). Trace only.
    if (firesAt !== undefined) {
      const current = await ctx.db.get(messageId);
      if (
        current === null ||
        current.autoRetry?.firesAt !== firesAt ||
        current.autoRetry?.attempt !== attempt
      ) {
        await traceOutcome("stand_down", "superseded");
        return;
      }
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
    // Children can register AFTER the schedule (the observer's upserts are async):
    // re-checked here, before the cascade below would delete their rows.
    if (await delegationBlocksRetry(ctx, message)) {
      await standDown(DELEGATED_WORK_REASON);
      return;
    }
    // The chat must still be idle: a pending/queued row means a newer send is in
    // flight (or held) — retrying the old turn would re-order the conversation.
    const active = await activeOutbox(ctx, chatId, message.dispatchOutboxId);
    if (active === "other") {
      await standDown("chat_busy");
      return;
    }
    if (active === "own") {
      await standDown("own_dispatch_unsettled");
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
      // THE AUTHOR of the turn being retried, as send.ts records it: on a group
      // chat that is a participant, and the dispatch re-checks their rights and
      // sends under their name when the instance asks for it. The owner's id here
      // would hand a revoked participant's turn the owner's standing.
      userId: lastUser.authorUserId ?? chat.userId,
      // Unique key (Date.now() is deterministic in a mutation) so the send
      // idempotency guard never dedupes the retry against the original send.
      clientMessageId: `autoretry-${lastUser._id}-${attempt}-${Date.now()}`,
      messageId: lastUser._id,
      text: lastUser.text,
      attachmentIds: attachments.map((a) => a.storageId),
      attachments,
      status: "pending",
      // Dispatched immediately → the in-flight window opens now (see
      // schema.outbox.pendingSince: it is what lets the reconciler tell a live
      // dispatch from a chat lock nobody will release).
      pendingSince: Date.now(),
      ...(routedAgent ? { routedAgent } : {}),
      // Quote-reply: the auto-retried dispatch must re-carry the excerpt,
      // or the re-sent instruction loses its targeted passage.
      ...outboxQuoteFieldsFor(quotedRefsOf(lastUser).map((q) => q.excerpt)),
      autoRetryAttempt: attempt,
      // The chain's limit travels with it (see the schema note).
      autoRetryMaxAttempts:
        message.autoRetry?.maxAttempts ?? maxRetriesForKind(message.errorCode ?? ""),
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
