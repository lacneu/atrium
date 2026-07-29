import { m } from "@/paraglide/messages.js";

// CONF-4 session-knob helpers, shared by the composer "Advanced" popover, the
// chat-header chips and the session panel (Sheet).
//
// Provenance v1 is BINARY and INTENT-based (design amendment A1): a knob is
// "overridden here" exactly when its key is present in the chat's
// `sessionSettings` (the write-back intent persisted by chats.setSessionKnob);
// absence = inherited from the agent/admin cascade. This replaces the old
// header heuristic (`thinkingLevel === thinkingDefault`), which was WRONG when
// the user overrides TO the default's value — value equality says nothing
// about provenance.
//
// Pure module (no React) so every label branch — including the parameterized
// messages — is unit-tested without a DOM harness (GC-P5 lesson).

/** Shape of `chats.sessionMeta` consumed by the header + session panel. */
export type SessionMetaView = {
  model?: string;
  modelProvider?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  thinkingDefault?: string;
  thinkingLevels?: { id: string; label: string }[];
  availableModels?: { id: string; label: string }[];
  verboseLevel?: string;
  totalTokens?: number;
  /** Compaction verdict (G-08) — see ContextMeta. */
  sessionOverfull?: boolean;
  // REAL window usage of the last turn (bridge post-usage stamp). Primary
  // gauge source: totalTokens is CUMULATIVE under a context engine (LCM) and
  // dividing it by the window read 859% in prod.
  activeTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
  updatedAt?: number;
};

/** Shape of `chats.sessionSettings` (the user's per-chat override intent). */
export type SessionSettingsView = {
  thinkingLevel?: string;
  model?: string;
  fastMode?: boolean;
} | null;

export type KnobField = "thinkingLevel" | "model" | "fastMode";

/** Binary provenance (A1): the key is present in the intent = overridden. */
export function isOverridden(
  settings: SessionSettingsView | undefined,
  field: KnobField,
): boolean {
  return settings != null && settings[field] !== undefined;
}

// "Vitesse" segmented control (3 states): the selection is read from the
// INTENT (sessionMeta carries no fastMode echo) — absent key = inherited.
export type SpeedOption = "inherit" | "fast" | "standard";
export const SPEED_OPTIONS: readonly SpeedOption[] = [
  "inherit",
  "fast",
  "standard",
];

export function speedSelection(
  settings: SessionSettingsView | undefined,
): SpeedOption {
  if (settings == null || settings.fastMode === undefined) return "inherit";
  return settings.fastMode ? "fast" : "standard";
}

export function speedOptionLabel(option: SpeedOption): string {
  return option === "inherit"
    ? m.conf_speed_inherit()
    : option === "fast"
      ? m.conf_speed_fast()
      : m.conf_speed_standard();
}

/** setSessionKnob `fastMode` value for a segment choice (null = unset). */
export function speedKnobValue(option: SpeedOption): boolean | null {
  return option === "inherit" ? null : option === "fast";
}

/** Compact token count: 62226 -> "62.2k", 980 -> "980". */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Display abbreviations for the KNOWN gateway thinking-level ids. Long labels
// ("Minimal", "Medium") ellipsize inside 1/6-width segments; unknown ids fall
// back to the gateway label untouched (full label always goes in `title`).
const LEVEL_ABBREV: Record<string, string> = {
  off: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
};

/** Short segment label for a thinking level; full label belongs in `title`. */
export function shortLevelLabel(id: string, label: string): string {
  return LEVEL_ABBREV[id] ?? label;
}

/** Context-window usage percentage, or null when the meta is unusable. */
/** WHERE the gauge's number comes from — surfaced on hover so a reader can tell
 *  a gateway ESTIMATE of the assembled prompt from a post-hoc usage counter, and
 *  either from "we do not know". */
export type ContextSource = "budget_estimate" | "last_call_usage" | "unknown";

interface ContextMeta {
  activeTokens?: number;
  /** The gateway's usable prompt budget (window minus the output reserve) — the
   *  denominator it measures against itself. */
  promptBudgetBeforeReserve?: number;
  totalTokens?: number;
  contextTokens?: number;
  /** The gateway's OWN pre-prompt estimate of the assembled prompt — the number
   *  it uses for its own display. Present only when its pre-prompt check ran
   *  (absent under a context engine that owns compaction). */
  estimatedPromptTokens?: number;
  /** The gateway's freshness flag for its token counter: false = "this number is
   *  stale". Upstream uses it to leave the reading UNKNOWN rather than show a
   *  frozen percentage; so do we. */
  totalTokensFresh?: boolean;
  /** The last compaction FAILED and will not be retried (G-08): the session did
   *  not shrink. A VERDICT, not a number — the counters above can read
   *  comfortable while this is true, which is the production symptom. */
  sessionOverfull?: boolean;
  /** The HERMES gateway's OWN occupancy reading (`usage.context_percent`), recorded
   *  BESIDE the token counts rather than instead of them. Kept because when the two
   *  disagree the disagreement is the finding — and a finding nobody can see is not one. */
  contextPercent?: number;
}

/** The number the context gauge should treat as "used window tokens", or null
 *  when nothing trustworthy is available — in which case the gauge must say
 *  "unknown" instead of showing a figure.
 *
 *  Priority, most to least trustworthy:
 *   1. `estimatedPromptTokens` — the gateway's own estimate of the prompt it is
 *      about to assemble, and what it displays itself. It is the only source that
 *      accounts for what the counters below MISS (tool schemas, injected context).
 *   2/3. `activeTokens` then `totalTokens`. CAUTION, established by reading the
 *      gateway sources: these are the SAME upstream field read at two different
 *      moments, and its derivation can fall back to a RUN-CUMULATIVE accumulator.
 *      Neither is a reliable window fill — hence the guard below, which now
 *      applies to BOTH (it used to cover totalTokens only, so an absurd
 *      activeTokens sailed straight through and was displayed as a percentage:
 *      the production incident where a session showed a comfortable fill and hit
 *      the wall anyway).
 */
export function effectiveContextUsed(
  sm: ContextMeta | null | undefined,
): number | null {
  if (!sm) return null;
  const window = sm.contextTokens;
  // Absurd-value guard for the COUNTERS: a "used" larger than the window is not a
  // fill, it is a cumulative total. Report null (unknown) rather than a figure we
  // know to be wrong.
  const usable = (n: number | undefined): number | null =>
    n == null ? null : window && n > window ? null : n;
  // 1. The gateway's own prompt estimate wins whenever it exists — and it is NOT
  //    subject to the absurd-value guard (codex P2): an estimate ABOVE the window
  //    is not a broken counter, it is the single most important reading there is
  //    ("the next send does not fit"). Discarding it would hide an imminent
  //    overflow behind a comfortable post-hoc counter. Callers clamp the visual
  //    width; the NUMBER stays honest.
  if (sm.estimatedPromptTokens != null) return sm.estimatedPromptTokens;
  // 2. The per-turn stamp. NOT gated by `totalTokensFresh` (codex P2): that flag
  //    qualifies the `totalTokens` sample it arrived with, while this stamp can be
  //    observed LATER (end-of-turn usage merged into the same meta) — letting a
  //    stale pre-send snapshot suppress a fresher observation would blank the
  //    gauge for the rest of the session.
  const active = usable(sm.activeTokens);
  if (active != null) return active;
  // 3. The legacy counter, and only here does its own freshness flag apply.
  if (sm.totalTokensFresh === false) return null;
  return usable(sm.totalTokens);
}

/**
 * The DENOMINATOR the gauge must divide by: the gateway's usable PROMPT budget
 * when it reports one, else the raw context window.
 *
 * They are not the same number — the budget is the window minus the reserve kept
 * for the model's own output — and that difference is exactly what made the
 * 2026-07-20 session look safe: an assembled prompt of 358 960 tokens reads
 * 96% against a 372 000 window (comfortable) but 117% against the 308 000 budget
 * the gateway actually had (it does not fit, which is what happened). Dividing by
 * the window would keep the gauge wrong in the precise case it exists for.
 */
export function effectiveContextWindow(
  sm: ContextMeta | null | undefined,
): number | null {
  if (!sm) return null;
  if (sm.promptBudgetBeforeReserve != null && sm.promptBudgetBeforeReserve > 0) {
    return sm.promptBudgetBeforeReserve;
  }
  return sm.contextTokens != null && sm.contextTokens > 0
    ? sm.contextTokens
    : null;
}

/**
 * TRUE when the session is known not to fit any more: either the gateway's own
 * estimate exceeds the budget it measures against, or its last compaction failed
 * for good. Pre-announces the next turn's overflow instead of letting it arrive
 * as a raw error the reader cannot act on.
 */
export type OverfullReason = "compaction_failed" | "estimate_exceeds_budget";

/**
 * WHY the session no longer fits, or null when it does. The two causes are NOT
 * interchangeable in the message shown: claiming "the last compaction failed"
 * when the only evidence is an over-budget estimate states a fact that never
 * happened (codex P2).
 */
export function contextOverfullReason(
  sm: ContextMeta | null | undefined,
): OverfullReason | null {
  if (!sm) return null;
  // The VERDICT is the stronger, more specific statement: it wins the label.
  if (sm.sessionOverfull === true) return "compaction_failed";
  const used = effectiveContextUsed(sm);
  const budget = effectiveContextWindow(sm);
  return used != null && budget != null && used > budget
    ? "estimate_exceeds_budget"
    : null;
}

export function contextOverfull(sm: ContextMeta | null | undefined): boolean {
  return contextOverfullReason(sm) !== null;
}

/** Which source `effectiveContextUsed` actually used — for the hover text. */
export function contextSource(
  sm: ContextMeta | null | undefined,
): ContextSource {
  if (!sm) return "unknown";
  const window = sm.contextTokens;
  const usable = (n: number | undefined): number | null =>
    n == null ? null : window && n > window ? null : n;
  if (sm.estimatedPromptTokens != null) return "budget_estimate";
  if (usable(sm.activeTokens) != null) return "last_call_usage";
  if (sm.totalTokensFresh === false) return "unknown";
  return usable(sm.totalTokens) != null ? "last_call_usage" : "unknown";
}

export function contextPct(
  totalTokens?: number,
  contextTokens?: number,
): number | null {
  if (totalTokens == null || !contextTokens || contextTokens <= 0) return null;
  return Math.round((totalTokens / contextTokens) * 100);
}

/** "53 % · 145.1k / 272k jetons" — null when the meter cannot be computed. */
export function contextLine(
  totalTokens?: number,
  contextTokens?: number,
): string | null {
  const pct = contextPct(totalTokens, contextTokens);
  if (pct === null) return null;
  return m.spanel_context_value({
    pct,
    used: formatTokens(totalTokens as number),
    total: formatTokens(contextTokens as number),
  });
}

/** "full · pinned" — verbosity is pinned by the bridge (read-only row). */
export function verbosityLine(verboseLevel?: string): string {
  return m.spanel_verbosity_value({ level: verboseLevel ?? "full" });
}

/** Cost/usage line; every presence combination has its own message. */
export function costLine(
  estimatedCostUsd?: number,
  totalTokens?: number,
): string | null {
  const hasCost = typeof estimatedCostUsd === "number";
  const hasTokens = typeof totalTokens === "number";
  if (hasCost && hasTokens) {
    return m.spanel_cost_both({
      cost: (estimatedCostUsd as number).toFixed(2),
      tokens: formatTokens(totalTokens as number),
    });
  }
  if (hasCost) {
    return m.spanel_cost_only({ cost: (estimatedCostUsd as number).toFixed(2) });
  }
  if (hasTokens) {
    return m.spanel_tokens_only({ tokens: formatTokens(totalTokens as number) });
  }
  return null;
}

/** "Alice · codex · gpt-5.5" — skips missing parts; null when all missing. */
export function agentLine(
  parts: Array<string | null | undefined>,
): string | null {
  const kept = parts.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** How far the GATEWAY's own occupancy reading differs from the one Atrium derives.
 *
 *  Two instruments measure the same window: Hermes reports `context_percent`, and Atrium
 *  computes a percentage from the token counts. Recording both was deliberate — when they
 *  disagree, that IS the finding — but a value stored and never rendered is a finding
 *  nobody can act on, which is the same mistake as saving text no view shows.
 *
 *  Returns null when there is nothing to compare, or when the two agree within the
 *  tolerance. The tolerance is not cosmetic: both sides ROUND, and a gauge that cried
 *  divergence at one point of rounding would train the reader to ignore it. */
export function contextPercentDivergence(
  sm: ContextMeta | null | undefined,
  tolerancePoints = 5,
): { gateway: number; derived: number; delta: number } | null {
  const gateway = sm?.contextPercent;
  if (typeof gateway !== "number" || !Number.isFinite(gateway)) return null;
  const used = effectiveContextUsed(sm);
  const window = effectiveContextWindow(sm);
  if (used === null || window === null) return null;
  const derived = contextPct(used, window);
  if (derived === null) return null;
  const delta = Math.abs(gateway - derived);
  if (delta <= tolerancePoints) return null;
  return { gateway, derived, delta };
}
