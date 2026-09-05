// FAILURE-TEXT CLASSIFIER, shared (W2 / G-11).
//
// Real gateways often do NOT populate a structured `errorKind` (live-verified on
// 2026.6.11, same as `usage`), so a hard overflow or a transient provider blip
// arrives as bare TEXT. These patterns pin that text to the stable codes the UI
// localizes, the anomaly chain names, and the bounded auto-retry keys on.
//
// Extracted from the normalizer rather than copied: SUB-AGENT failures were the
// one place that never classified at all (`subAgents` had no `errorCode`), so a
// child that died of a context overflow showed raw prose and was invisible to the
// observability surface. One classifier, two consumers — a second copy would
// drift and only one side would be fixed.

const CONTEXT_OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded|request_too_large|request too large|input (?:token count )?exceeds the maximum number of (?:input )?tokens|input is too long for the model|too many tokens|reduce the length|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context/i;
const SESSION_INIT_CONFLICT_RE =
  /reply session initialization conflicted/i;
// <= 2026.7.x ONLY: the file-based embedded prompt lock and its message were
// removed at 2026.8.1 (attempt.session-lock.ts is gone; transcripts live in
// SQLite). Kept for the validated 7.x generation; the two patterns below are
// what replaced it.
const EMBEDDED_LOCK_CONFLICT_RE =
  /session file changed while embedded prompt lock/i;
// 2026.8.1+: the SQLite writer FENCE. Every transcript commit re-validates the
// session row's writer/lifecycle revision and refuses with
// `SessionTranscriptWriterClaimReboundError` — verbatim
// "session writer claim changed before transcript persistence"
// (upstream src/config/sessions/transcript-write-context.ts:239, identical
// 8.1→9.1). Coordination error upstream (failover-error.ts: no model fallback),
// always mid-turn; same transient session OCC as the init conflict.
const WRITER_CLAIM_REBOUND_RE =
  /session writer claim changed before transcript persistence/i;
// 2026.9.1: `ActiveTurnClaimError` — "Session <id> already has an active turn
// claim" (upstream src/gateway/worker-environments/placement-turn-claims.ts:57)
// joins RUNTIME_COORDINATION_ERROR_NAMES (failover-error.ts:46-52): the session
// is busy, not the request malformed.
const ACTIVE_TURN_CLAIM_RE =
  /session .* already has an active turn claim/i;
// The gateway's OTHER way of saying the same thing, and the one production
// actually produced: `Session "<key>" changed while starting work. Retry.`
// (live prod 2026-08-04, a send lost on a 66-page report).
//
// It is the SAME transient OCC on the session, and the gateway even names the
// cure in the sentence — "Retry." — but the wording shares nothing with the two
// patterns above, so it fell through to the generic INVALID_REQUEST bucket and
// the turn died for good. An error the upstream declares retriable must never
// be classified as a malformed request.
// 2026.9.1 types it (`SessionWorkStartChangedError`, wire prefix changes, the
// sentence does not) and adds the sibling
// `Session "<key>" was deleted while starting work. Retry.` under the same
// `transientSessionChange: true` (upstream src/config/sessions/lifecycle.ts:72,105,109).
const SESSION_CHANGED_STARTING_RE =
  /session .* (?:changed|was deleted) while starting work/i;
const PROVIDER_INTERNAL_TEXT_RE =
  /the ai service returned an (?:internal )?error|the ai service is temporarily (?:overloaded|unavailable)|returned an html error page|malformed_streaming_fragment|malformed fragment|an error occurred while processing your request|http\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)|internal server error|\bupstream (?:error|connect)|server_error|overloaded_error|fetch failed|socket hang ?up|network error|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|und_err|terminated unexpectedly/i;
const PROVIDER_INTERNAL_EXCLUDE_RE =
  /rate[- ]?limit|too many requests|http\s*4\d\d\b|unauthorized|forbidden|invalid[_ ](?:api[_ ]?key|request|model)|api[_ ]?key|authentication|billing|quota|insufficient|not[_ ]found|unsupported|refus|content[_ ]policy|context overflow|prompt too large/i;

/**
 * The stable failure class a raw error TEXT belongs to, or null when the text
 * says nothing recognizable.
 *
 * FAIL-SAFE by construction: ambiguous text yields null. A wrong class is worse
 * than none — `provider_internal` triggers an automatic retry, and retrying an
 * auth or entitlement failure burns quota and shows a misleading label. The
 * never-transient guard is therefore checked FIRST.
 */
/** The PRE-GENERATION session conflicts, as one predicate.
 *
 *  Exported because there are two doors into this decision: a terminal FRAME (below)
 *  and an exception thrown by `chat.send` (core/dispatch-errors.ts). They drifted —
 *  the second knew only one of the three forms — and the two it missed became terminal
 *  errors instead of a bounded retry (codex). */
export function isSessionInitConflictText(text: string): boolean {
  return (
    SESSION_INIT_CONFLICT_RE.test(text) ||
    EMBEDDED_LOCK_CONFLICT_RE.test(text) ||
    SESSION_CHANGED_STARTING_RE.test(text) ||
    ACTIVE_TURN_CLAIM_RE.test(text)
  );
}

export function classifyFailureText(text: string | null | undefined): string | null {
  if (!text) return null;
  if (CONTEXT_OVERFLOW_TEXT_RE.test(text)) return "context_length";
  // MID-TURN, and therefore its own class. Every other pattern below fires while the
  // session is being STARTED, before the model generates anything — which is exactly
  // what the automatic retry relies on when it re-dispatches a zero-content turn
  // (convex/turnRetry.ts). The writer claim rebounds "before transcript persistence",
  // i.e. after the model ran and tools may already have had external effects, so
  // filing it under the same code let a completed turn be replayed (codex).
  if (WRITER_CLAIM_REBOUND_RE.test(text)) return "session_write_conflict";
  if (isSessionInitConflictText(text)) return "session_init_conflict";
  if (PROVIDER_INTERNAL_TEXT_RE.test(text) && !PROVIDER_INTERNAL_EXCLUDE_RE.test(text)) {
    return "provider_internal";
  }
  return null;
}
