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

/**
 * WHY the gateway compacted, bucketed (W2 / G-09).
 *
 * `session.operation {phase:"end"}` carries a `reason`. On the normal path it is a
 * structured code; on the FAILURE path it is `formatErrorMessage(err)` — arbitrary
 * error text. This event feeds a metadata-only trace and a user-facing marker, so
 * the value is allowlisted here: an unrecognized reason becomes "other", never raw
 * gateway text (same rule as `timeoutPhase`, SOC2).
 *
 * Enumerated from the deployed 2026.7.1 build.
 */
const COMPACTION_REASONS: ReadonlySet<string> = new Set([
  // The two the program names: the session did not fit vs the user asked.
  "overflow",
  "manual",
  // Threshold-driven (the gateway compacted on its own, pre-emptively).
  "heap_threshold",
  "rss_threshold",
  "pre_compaction",
  "non_manual_trigger",
  "compact",
  "compaction",
  // REFUSALS — the gateway declined to compact. These are the ones the pre-send
  // guard must be able to tell apart from a real failure.
  "already_active",
  "already_in_flight",
  "deferred_compaction_not_scheduled",
  "unsupported_harness_compaction",
  // The manual `sessions.compact` RPC's own refusal reasons, read off the deployed
  // gateway handler (`sessions.compact` responds `{ok, compacted:false, reason}`).
  "no transcript",
  "no sessionId",
]);

export function bucketCompactionReason(reason: unknown): string | null {
  if (typeof reason !== "string" || reason === "") return null;
  return COMPACTION_REASONS.has(reason) ? reason : "other";
}

/**
 * TRUE only when the refusal cannot change while the session is the same one.
 *
 * A single reason qualifies: the HARNESS cannot compact. That is a property of how
 * the agent runs, and asking again next turn buys nothing but a 60 s wait per send.
 *
 * Everything else is deliberately treated as transient, including the tempting ones:
 * "already active" plainly means "not right now", and "no transcript" / "no
 * sessionId" describe a session that has not written one YET — an ordinary send
 * creates it, so remembering those would leave a conversation permanently unable to
 * compact on evidence that had since expired. Anything unrecognized is transient
 * too: the cost of re-asking is a fast refusal, the cost of a wrong "permanent" is
 * a dead end the user cannot open.
 */
export function isPermanentCompactionRefusal(reason: string | null): boolean {
  return reason === "unsupported_harness_compaction";
}

/**
 * TRUE when the refusal says "not right now" — something was already RUNNING on the
 * session (a compaction, or a run). Narrower than `isCompactionRefusal`, and the
 * distinction is load-bearing: a busy session is about to stop being busy, and
 * possibly about to be smaller, so the pre-send guard must SEND rather than withhold
 * a turn on evidence that is expiring. An unsupported harness or a missing
 * transcript are refusals too, but they are not "not right now".
 */
export function isTransientCompactionRefusal(reason: string | null): boolean {
  return reason === "already_active" || reason === "already_in_flight";
}

/** TRUE when the reason says the gateway REFUSED rather than tried and failed:
 *  the pre-send guard treats a refusal as "cannot compact now", not as a defect. */
export function isCompactionRefusal(reason: string | null): boolean {
  return (
    reason === "already_active" ||
    reason === "already_in_flight" ||
    reason === "deferred_compaction_not_scheduled" ||
    reason === "unsupported_harness_compaction"
  );
}
