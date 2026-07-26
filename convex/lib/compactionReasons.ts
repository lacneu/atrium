// The compaction-reason ALLOWLIST at the ingest trust boundary.
//
// `sessions.compact` and `session.operation` both carry a FREE-TEXT `reason`. The
// bridge buckets it (bridge/src/core/compaction-verdict.ts) before it ever leaves,
// and this module buckets it AGAIN on arrival. That is not redundancy: traces are
// contractually metadata-only, and a divergent, older, or forged bridge is not a
// trusted source of what may enter one.
//
// The list is stated twice in the repo (the bridge is a separate npm package) and
// pinned by presendAllowlistDrift.test.ts, which reads both sources — a reason the
// bridge starts bucketing but this side does not know would otherwise be DROPPED
// silently, taking the diagnostic value with it exactly when it was needed.

export const COMPACTION_REASON_CLASSES: ReadonlySet<string> = new Set([
  // The two that matter most: the session did not fit vs the user asked.
  "overflow",
  "manual",
  // Threshold-driven (the gateway compacted on its own, pre-emptively).
  "heap_threshold",
  "rss_threshold",
  "pre_compaction",
  "non_manual_trigger",
  "compact",
  "compaction",
  // REFUSALS — the gateway declined rather than tried and failed.
  "already_active",
  "already_in_flight",
  "deferred_compaction_not_scheduled",
  "unsupported_harness_compaction",
  "no transcript",
  "no sessionId",
  // The bridge's own fallback for anything it did not recognise.
  "other",
]);

/** The class, or null when the value is absent or off the allowlist. Null means the
 *  field is OMITTED from the trace — never coerced to a default, which would read as
 *  a real measurement. */
export function compactionReasonClass(value: unknown): string | null {
  return typeof value === "string" && COMPACTION_REASON_CLASSES.has(value)
    ? value
    : null;
}
