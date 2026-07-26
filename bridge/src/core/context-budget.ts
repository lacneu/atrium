// Context-budget arithmetic shared by the pre-send guard and rehydration (W2).
//
// The bridge is a separate npm package from `convex/`, so it cannot import
// `convex/lib/rehydration.ts`. The two thresholds below are therefore stated
// TWICE in the repo — and pinned by a test on each side that asserts the same
// numbers, so a drift fails a suite instead of silently changing when a turn is
// refused. If a third consumer appears, extract a shared package rather than a
// third copy.

/** Chars per token, PRUDENTLY (the gateway's own planner uses 2 + a 1.2 margin —
 *  `preemptive-compaction.ts`). An optimistic ratio makes a block look cheaper
 *  than it is, and this number decides whether a turn fits. */
export const CHARS_PER_TOKEN = 2;
export const TOKEN_ESTIMATE_MARGIN = 1.2;

/** Above this share of the window, rehydration is REFUSED: the gateway already
 *  holds the history, so injecting it into an almost-full session is the one
 *  action guaranteed to make things worse (G-10). */
export const REHYDRATION_MAX_FILL = 0.7;

/** Tokens a text is CONSERVATIVELY worth (over-estimates on purpose). */
export function estimateTokens(chars: number): number {
  return Math.ceil((chars / CHARS_PER_TOKEN) * TOKEN_ESTIMATE_MARGIN);
}

/**
 * LIVE fill of a session as a 0..1+ share, or null when nothing trustworthy is
 * available — in which case every guard built on it must fall open (P6).
 *
 * Mirrors the front-end gauge's priority (`sessionKnobs.effectiveContextUsed`):
 * the gateway's OWN pre-prompt estimate first — the only figure that accounts for
 * what the counters miss (tool schemas, injected context) — then the per-turn
 * counter. The DENOMINATOR is the usable prompt budget when the gateway reports
 * one, not the raw window: they differ by the output reserve, and that difference
 * is exactly what made a 96 %-of-window session read comfortable while being at
 * 117 % of the budget it actually had.
 */
export function sessionFill(m: SessionFillInputs): number | null {
  return sessionFillDetail(m).fill;
}

export interface SessionFillInputs {
  estimatedPromptTokens?: number | null;
  promptBudgetBeforeReserve?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  totalTokensFresh?: boolean | null;
}

/** Which figure the fill came from — reported alongside every guard decision so a
 *  block can be read back as "measured by the gateway" vs "inferred from a
 *  counter". Null source ⇔ null fill (UNKNOWN). */
export type SessionFillSource = "gateway_estimate" | "counter";

/** `sessionFill` plus its provenance. The single implementation: the wrapper above
 *  exists so the many call sites that only want the number stay unchanged, and the
 *  source can never disagree with the branch that produced the value. */
export function sessionFillDetail(m: SessionFillInputs): {
  fill: number | null;
  source: SessionFillSource | null;
} {
  const budget =
    m.promptBudgetBeforeReserve != null && m.promptBudgetBeforeReserve > 0
      ? m.promptBudgetBeforeReserve
      : m.contextTokens != null && m.contextTokens > 0
        ? m.contextTokens
        : null;
  const unknown = { fill: null, source: null } as const;
  if (budget === null) return unknown;
  if (m.estimatedPromptTokens != null && m.estimatedPromptTokens >= 0) {
    return {
      fill: m.estimatedPromptTokens / budget,
      source: "gateway_estimate",
    };
  }
  if (m.totalTokensFresh === false) return unknown; // stated stale: unknown, not 0
  if (m.totalTokens != null && m.totalTokens >= 0) {
    // A counter ABOVE the window is a cumulative total, not a fill (the 859 %
    // production report): unknown beats a figure known to be wrong.
    if (m.contextTokens != null && m.totalTokens > m.contextTokens) {
      return unknown;
    }
    return { fill: m.totalTokens / budget, source: "counter" };
  }
  return unknown;
}

/**
 * Does the COMPOSED prompt still fit? `windowTokens` must be the SMALLEST live
 * window in play: on an agent switch the turn may run on a narrower model than
 * the one that composed the history.
 */
export function composedPromptFits(params: {
  historyChars: number;
  userChars: number;
  separatorChars: number;
  windowTokens: number | null | undefined;
}): boolean {
  const w = params.windowTokens;
  if (w == null || !Number.isFinite(w) || w <= 0) return true; // unknown: never refuse
  const total = params.historyChars + params.userChars + params.separatorChars;
  return estimateTokens(total) <= Math.floor(w * 0.5);
}
