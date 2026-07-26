// The compaction VERDICT (G-08), as one rule shared by its two producers.
//
// A compaction that failed and will NOT be retried leaves the session unshrunk:
// the NEXT turn is the one that pays, so the verdict is chat-scoped and outlives
// the turn that observed it. It has to be read in two places — the normalizer,
// for a compaction during a turn, and the run manager, for one BETWEEN turns
// (there the frame belongs to a gateway background run, which the normalizer's
// admission policy refuses by construction). Two copies of the rule would drift;
// this is the single one.

/** True when this `stream:"compaction"` data says the compaction failed for good. */
export function compactionFailedForGood(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.phase === "end" && d.completed === false && d.willRetry !== true
  );
}

/** True when it says the compaction COMPLETED (which clears a standing verdict). */
export function compactionCompleted(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.phase === "end" && d.completed === true;
}
