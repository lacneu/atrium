import { m } from "@/paraglide/messages.js";

// Pure view logic for the subscription-usage gauge (the routed instance's
// provider rate-limit windows, captured by the bridge from the gateway's
// `usage.status`). The gauge shows the MOST CONSTRAINED window (lowest
// remaining %) — that is the one that will bite first — with every window in
// the tooltip. Mirrors the gateway CLI's own presentation ("5h 95% left ⏱2h").

export interface UsageWindowView {
  label: string;
  usedPercent: number;
  resetAt: number | null;
}
export interface ProviderUsageView {
  provider: string;
  windows: UsageWindowView[];
}

export interface UsageBadgeView {
  /** Remaining % of the most constrained window (0-100, rounded). */
  percentLeft: number;
  /** That window's label (e.g. "5h", "week") — gateway-provided, not translated. */
  label: string;
  /** Human delay until that window resets (e.g. "2h 15m"), null when unknown. */
  resetText: string | null;
  /** Meter severity class, aligned with the context meter's thresholds. */
  level: "is-ok" | "is-warn" | "is-critical";
  /** Every window across providers, for the tooltip/detail. */
  windows: { provider: string; label: string; percentLeft: number; resetText: string | null }[];
}

/** Compact reset-delay text (gateway-style: 42m / 3h 5m / 2d 4h). */
export function formatResetRemaining(resetAt: number | null, now: number): string | null {
  if (resetAt === null || resetAt <= now) return null;
  const mins = Math.floor((resetAt - now) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  // The day suffix is locale-dependent ("j" fr / "d" en) — the only unit here
  // that differs between our locales (m/h are shared).
  return `${days}${m.usage_day_suffix()} ${hours % 24}h`;
}

/** null when there is nothing to show (no snapshot / empty). */
export function usageBadgeView(
  usage: ProviderUsageView[] | null | undefined,
  now: number,
): UsageBadgeView | null {
  if (!usage || usage.length === 0) return null;
  const all: UsageBadgeView["windows"] = [];
  for (const p of usage) {
    for (const w of p.windows) {
      all.push({
        provider: p.provider,
        label: w.label,
        percentLeft: Math.round(Math.min(100, Math.max(0, 100 - w.usedPercent))),
        resetText: formatResetRemaining(w.resetAt, now),
      });
    }
  }
  if (all.length === 0) return null;
  const worst = all.reduce((a, b) => (b.percentLeft < a.percentLeft ? b : a));
  const level =
    worst.percentLeft <= 10
      ? "is-critical"
      : worst.percentLeft <= 25
        ? "is-warn"
        : "is-ok";
  return {
    percentLeft: worst.percentLeft,
    label: worst.label,
    resetText: worst.resetText,
    level,
    windows: all,
  };
}
