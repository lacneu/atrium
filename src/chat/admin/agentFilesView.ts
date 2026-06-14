// Pure view helpers for the Settings "agentFiles" tab (CONF-4c). No React, no
// Convex — every branch (gauges, size formatting, the confirm mini-diff) is
// unit-testable without a DOM harness (GC-P5 lesson).

/** Per-file bootstrap budget the gauges are scaled against (CONF_DESIGN §3). */
export const BOOTSTRAP_MAX_CHARS = 20_000;

/** Total bootstrap budget across all files (CONF_DESIGN §3 "Budget total"). */
export const TOTAL_BUDGET_CHARS = 60_000;

/** Gauge warn threshold: ⚠ when a file uses >= 80% of its budget. */
export const GAUGE_WARN_PCT = 80;

/** Percentage of the per-file budget used (rounded, never negative). */
export function gaugePct(size: number | undefined): number {
  if (typeof size !== "number" || size <= 0) return 0;
  return Math.round((size / BOOTSTRAP_MAX_CHARS) * 100);
}

/** Percentage of the TOTAL bootstrap budget used (rounded, never negative). */
export function budgetPct(total: number): number {
  if (total <= 0) return 0;
  return Math.round((total / TOTAL_BUDGET_CHARS) * 100);
}

/**
 * Human size in kB with ONE locale-formatted decimal ("9,2" fr / "9.2" en).
 * Returns only the NUMBER — the unit is an i18n message (m.afiles_size_kb).
 */
export function formatKb(size: number | undefined, locale: string): string {
  const kb = (typeof size === "number" && size > 0 ? size : 0) / 1000;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(kb);
}

/** Sum of the listed file sizes (missing/size-less entries count as 0). */
export function totalSize(files: Array<{ size?: number }>): number {
  return files.reduce(
    (acc, f) => acc + (typeof f.size === "number" && f.size > 0 ? f.size : 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Confirm mini-diff (amendment A4). Deliberately SIMPLE and honest: a line
// MULTISET comparison (no LCS) — added = lines whose occurrence count grew,
// removed = lines whose count shrank, plus a few sample lines of each. Enough
// for a "what am I about to write" sanity check; the full before/after pair is
// recorded server-side (agentFileRevisions) for real rollback.
// ---------------------------------------------------------------------------

export type MiniDiff = {
  added: number;
  removed: number;
  sampleAdded: string[];
  sampleRemoved: string[];
};

const DIFF_SAMPLE_MAX = 3;

export function computeMiniDiff(before: string, after: string): MiniDiff {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  for (const line of after.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) - 1);
  }
  let added = 0;
  let removed = 0;
  const sampleAdded: string[] = [];
  const sampleRemoved: string[] = [];
  for (const [line, delta] of counts) {
    if (delta < 0) {
      added += -delta;
      if (sampleAdded.length < DIFF_SAMPLE_MAX) sampleAdded.push(line);
    } else if (delta > 0) {
      removed += delta;
      if (sampleRemoved.length < DIFF_SAMPLE_MAX) sampleRemoved.push(line);
    }
  }
  return { added, removed, sampleAdded, sampleRemoved };
}

/** True when an action error is the stable setAgentFile CAS-conflict code. */
export function isConflictError(err: unknown): boolean {
  return err instanceof Error
    ? err.message.includes("conflict:")
    : String(err).includes("conflict:");
}
