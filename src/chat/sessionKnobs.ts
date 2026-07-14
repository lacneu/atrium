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
/** The number the context gauge should treat as "used window tokens":
 *  the per-turn active stamp when present, else the legacy counter — but a
 *  legacy counter LARGER than the window is a session-cumulative value
 *  (context-engine sessions), not a fill: unusable, report null. */
export function effectiveContextUsed(
  sm:
    | { activeTokens?: number; totalTokens?: number; contextTokens?: number }
    | null
    | undefined,
): number | null {
  if (!sm) return null;
  if (sm.activeTokens != null) return sm.activeTokens;
  if (sm.totalTokens == null) return null;
  if (sm.contextTokens && sm.totalTokens > sm.contextTokens) return null;
  return sm.totalTokens;
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
