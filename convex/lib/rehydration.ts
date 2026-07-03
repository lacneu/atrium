// Hybrid rehydration — the PURE composition half (see docs/design/hybrid-rehydration.md).
//
// A fresh gateway session is re-grounded from Atrium's message store by prepending a
// bounded history block to the outgoing turn. This module owns HOW that block is
// composed: a rolling SUMMARY of the older conversation (maintained asynchronously by
// convex/chatSummaries.ts) + a VERBATIM tail of the most recent turns, all within a
// hard character budget. Pure + fully unit-tested; `internal.stream.rehydrationContext`
// feeds it data and `chatSummaries` reuses its sizing constants.
//
// Fallback ladder (the composer NEVER blocks and never degrades below the legacy
// verbatim behavior): no summary -> verbatim + honest omission marker; summary
// lagging -> summary + gap marker + verbatim; summary present + tail fits -> both.

/** Hard ceiling on the composed history, whatever the model window says. Without it a
 *  200k-token window re-ingests ~300k chars of raw history on EVERY cold start (daily
 *  session resets + every multi-agent switch) — the exact token-waste this feature
 *  removes. ~20k tokens at the 3-chars/token heuristic used across this module. */
export const HARD_MAX_HISTORY_CHARS = 60_000;

/** At most this share of the budget goes to the summary block — the verbatim tail
 *  (the agent's working context) always keeps the majority. */
export const SUMMARY_BUDGET_SHARE = 0.35;

/** Stored rolling-summary length cap (chars). Also sent to the summarizer prompt as
 *  {max_chars} so the model aims for it; clamped on store regardless. */
export const SUMMARY_MAX_CHARS = 6_000;

/** Minimum UNSUMMARIZED chars (beyond the kept-verbatim tail) before a summarize job
 *  dispatches — short chats never pay a summarization call. */
export const CHUNK_MIN_CHARS = 8_000;

/** Per-job chunk bound: one summarize turn ingests at most this many chars of new
 *  messages. A long backlog converges over several jobs (bounded work per job). */
export const CHUNK_MAX_CHARS = 24_000;

/** Fresh-tail bounds: the newest turns are NEVER summarized (they ride verbatim at
 *  rehydration — recent context is worth raw fidelity). SIZE-based with count
 *  guards: a conversation of FEW HUGE messages must still become summarizable
 *  (a fixed message count kept everything in the tail and starved the engine),
 *  while MANY tiny messages must not inflate the tail unboundedly. */
export const KEEP_RECENT_MIN_MESSAGES = 2;
export const KEEP_RECENT_MAX_MESSAGES = 12;
export const KEEP_RECENT_TARGET_CHARS = 12_000;

/** How many of the NEWEST usable turns (newest-first input) form the fresh tail:
 *  at least MIN, at most MAX, and a turn that would push the tail PAST the char
 *  target stays OUT (once MIN is met). The exclusion-before-add matters: a huge
 *  digest sitting among the newest turns must be summarizable, not locked into
 *  the tail by the message that crosses the budget (the gauge-stuck-at-0 report
 *  round 2: short conversations whose bulk is one giant message). */
export function freshTailCount(turnsDesc: readonly { text: string }[]): number {
  let chars = 0;
  let n = 0;
  for (const t of turnsDesc) {
    const len = t.text.trim().length;
    if (n >= KEEP_RECENT_MAX_MESSAGES) break;
    if (n >= KEEP_RECENT_MIN_MESSAGES && chars + len > KEEP_RECENT_TARGET_CHARS)
      break;
    chars += len;
    n++;
  }
  return n;
}

/** Summarize-failure backoff: base × 2^failures, capped. */
export const SUMMARY_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const SUMMARY_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export function summaryBackoffMs(failureCount: number): number {
  const exp = Math.min(Math.max(failureCount, 0), 20); // 2^20 already >> cap
  return Math.min(SUMMARY_BACKOFF_BASE_MS * 2 ** exp, SUMMARY_BACKOFF_CAP_MS);
}

/** Clamp a stored summary to its cap at a whitespace boundary (never mid-word when a
 *  boundary exists in the last 10%), with an explicit truncation mark. */
export function clampSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
  const hard = trimmed.slice(0, SUMMARY_MAX_CHARS);
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace > SUMMARY_MAX_CHARS * 0.9 ? hard.slice(0, lastSpace) : hard;
  return `${cut}…`;
}

/** The character budget for one rehydration block: the legacy window-derived budget
 *  (50% of the context window at ~3 chars/token) bounded by the hard ceiling. */
export function rehydrationBudgetChars(windowTokens: number): number {
  const windowBudget = Math.floor(windowTokens * 0.5) * 3;
  return Math.max(2_000, Math.min(windowBudget, HARD_MAX_HISTORY_CHARS));
}

export interface RehydrationTurn {
  role: "user" | "assistant";
  /** Already trimmed, non-empty. */
  text: string;
}

export interface RehydrationSummary {
  text: string;
  /** How many messages the summary covers (rendered in its intro line). */
  coveredCount: number;
}

export interface ComposeRehydrationInput {
  /** Chronological (oldest -> newest) verbatim candidates: complete user/assistant
   *  text turns strictly before the current turn and AFTER the summary watermark. */
  turns: RehydrationTurn[];
  summary: RehydrationSummary | null;
  /** True when the bounded tail read may have MISSED messages between the summary
   *  coverage (or the chat start) and the oldest turn in `turns` — the composer
   *  renders the omission marker even if the budget walk kept everything it saw. */
  readWindowClipped: boolean;
  budgetChars: number;
}

export interface ComposedRehydration {
  history: string | null;
  turnCount: number;
  summaryUsed: boolean;
  summaryChars: number;
  /** An omission marker was rendered (budget cut and/or clipped read window). */
  omitted: boolean;
}

const HEADER =
  "[Reprise d’une conversation antérieure de ce même fil. Pour continuité, " +
  "voici l’historique des messages précédents de cette conversation :]";
const FOOTER =
  "[Fin de l’historique. Le nouveau message de l’utilisateur suit ci-dessous.]";
const GAP_WITH_SUMMARY = "[…messages intermédiaires omis…]";
const GAP_NO_SUMMARY = "[…début de la conversation plus ancien, omis…]";

function summaryIntro(coveredCount: number): string {
  return `[Résumé de la partie antérieure de la conversation (${coveredCount} messages) :]`;
}

/**
 * Compose the history block. Layout:
 *
 *   HEADER
 *   [Résumé … (N messages) :]        (when a summary exists)
 *   <summary text>
 *   […omission marker…]              (when older/verbatim-cut content is missing)
 *   Utilisateur : … / Assistant : …  (verbatim tail, chronological)
 *   FOOTER
 *
 * The verbatim tail is budget-walked NEWEST-first (the most recent turns are the
 * most valuable), then rendered chronologically — the legacy behavior, unchanged.
 * The newest turn is always kept even if alone it exceeds the budget (legacy rule:
 * the walk only breaks once at least one line is kept).
 */
export function composeRehydration(
  input: ComposeRehydrationInput,
): ComposedRehydration {
  const summaryText = input.summary?.text.trim() ?? "";
  const hasSummary = summaryText.length > 0;

  // Summary block first (bounded share of the budget) — the remainder funds verbatim.
  const summaryCap = Math.floor(input.budgetChars * SUMMARY_BUDGET_SHARE);
  const summaryBlock = hasSummary
    ? summaryText.length > summaryCap
      ? `${summaryText.slice(0, Math.max(summaryCap - 1, 0))}…`
      : summaryText
    : "";
  const verbatimBudget = input.budgetChars - summaryBlock.length;

  const keptDesc: string[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = input.turns.length - 1; i >= 0; i--) {
    const t = input.turns[i]!;
    const label = t.role === "user" ? "Utilisateur" : "Assistant";
    let line = `${label} : ${t.text}`;
    if (keptDesc.length > 0 && chars + line.length > verbatimBudget) {
      truncated = true;
      break;
    }
    // The always-keep-newest rule must not blow the ceiling: ONE turn aggregating
    // several sub-agent results can exceed the whole budget — truncate ITS render
    // to the budget instead of shipping an unbounded block.
    if (keptDesc.length === 0 && line.length > verbatimBudget) {
      line = `${line.slice(0, Math.max(verbatimBudget - 1, 0))}…`;
      truncated = true;
    }
    keptDesc.push(line);
    chars += line.length + 1;
  }
  const lines = keptDesc.reverse();

  if (lines.length === 0 && !hasSummary) {
    return {
      history: null,
      turnCount: 0,
      summaryUsed: false,
      summaryChars: 0,
      omitted: false,
    };
  }

  const omitted = truncated || input.readWindowClipped;
  const parts: string[] = [HEADER];
  if (hasSummary) {
    parts.push(summaryIntro(input.summary!.coveredCount));
    parts.push(summaryBlock);
  }
  if (omitted) parts.push(hasSummary ? GAP_WITH_SUMMARY : GAP_NO_SUMMARY);
  if (lines.length > 0) parts.push(lines.join("\n"));
  parts.push(FOOTER);

  return {
    history: parts.join("\n"),
    turnCount: lines.length,
    summaryUsed: hasSummary,
    summaryChars: summaryBlock.length,
    omitted,
  };
}

// ---------------------------------------------------------------------------
// Gateway session-key nonce (job-identity correlation).
//
// The bridge builds session keys via safeSessionPart() (bridge/src/providers/
// openclaw/session-keys.ts) which SANITIZES each segment — `summarize:<id>:<ts>`
// becomes `summarize-<id>-<ts>` inside the echoed turnSessionKey. The correlate
// must therefore match the SANITIZED form. This is a pinned MIRROR of that
// function; its test carries shared vectors so any drift breaks loudly.

const GATEWAY_SAFE_PART_RE = /[^A-Za-z0-9_.-]+/g;

/** Mirror of the bridge's safeSessionPart (see header comment). */
export function gatewaySafeSessionPart(value: string): string {
  const collapsed = value.trim().replace(GATEWAY_SAFE_PART_RE, "-");
  const cleaned = collapsed.replace(/^[-._]+/, "").replace(/[-._]+$/, "");
  return cleaned || "unknown";
}

/** The summarize job's identity as it appears as the FINAL segment of the echoed
 *  turnSessionKey (the rotated openclawChatId, sanitized). */
export function summarizeSessionNonce(
  targetChatId: string,
  createdAt: number,
): string {
  return gatewaySafeSessionPart(`summarize:${targetChatId}:${createdAt}`);
}
