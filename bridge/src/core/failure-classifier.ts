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
const EMBEDDED_LOCK_CONFLICT_RE =
  /session file changed while embedded prompt lock/i;
// The gateway's OTHER way of saying the same thing, and the one production
// actually produced: `Session "<key>" changed while starting work. Retry.`
// (live prod 2026-08-04, a send lost on a 66-page report).
//
// It is the SAME transient OCC on the session, and the gateway even names the
// cure in the sentence — "Retry." — but the wording shares nothing with the two
// patterns above, so it fell through to the generic INVALID_REQUEST bucket and
// the turn died for good. An error the upstream declares retriable must never
// be classified as a malformed request.
const SESSION_CHANGED_STARTING_RE =
  /session .* changed while starting work/i;
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
export function classifyFailureText(text: string | null | undefined): string | null {
  if (!text) return null;
  if (CONTEXT_OVERFLOW_TEXT_RE.test(text)) return "context_length";
  if (
    SESSION_INIT_CONFLICT_RE.test(text) ||
    EMBEDDED_LOCK_CONFLICT_RE.test(text) ||
    SESSION_CHANGED_STARTING_RE.test(text)
  ) {
    return "session_init_conflict";
  }
  if (PROVIDER_INTERNAL_TEXT_RE.test(text) && !PROVIDER_INTERNAL_EXCLUDE_RE.test(text)) {
    return "provider_internal";
  }
  return null;
}
