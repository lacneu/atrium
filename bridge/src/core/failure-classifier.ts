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
// 2026.8.1+: the SQLite writer FENCE. The session row's writer claim and lifecycle
// revision are re-validated before a transcript write, and a mismatch refuses with
// `SessionTranscriptWriterClaimReboundError` — verbatim
// "session writer claim changed before transcript persistence"
// (upstream src/config/sessions/transcript-write-context.ts:240, identical
// 8.1→9.4). Coordination error upstream (failover-error.ts: no model fallback).
// NOT always mid-turn — see classifyFailureText for why it keeps its own class anyway.
const WRITER_CLAIM_REBOUND_RE =
  /session writer claim changed before transcript persistence/i;
// The SAME failure after the user-facing rewrite introduced in 2026.9.3 (absent from the
// v2026.9.1 and v2026.9.2 sources; read at v2026.9.4), which is what actually reaches the
// wire when it ends a generating run. The gateway maps the rebound message above to
// the storage failure `transcript_writer_fenced` (upstream
// src/infra/sqlite-error-diagnostics.ts:10), renders it as
// "⚠️ Agent run failed: the transcript writer no longer owned this session. Retry in the
// current session; if it repeats, check Gateway logs."
// (src/agents/failover/assistant-request-failure-copy.ts:24-25,52;
// embedded-agent-helpers/error-text.ts:103,128), and ships THAT as the lifecycle
// `error` (embedded-agent-subscribe.handlers.lifecycle.ts:151-167,219, a ≤400-char
// preview) and the chat error's `errorMessage` (server-chat.ts:783,1239, ≤240 chars).
// None of the patterns here matched it, so the turn died unclassified (v2026.9.4).
// The prose's own "Retry" does not make it retryable: see classifyFailureText.
const WRITER_FENCED_COPY_RE =
  /the transcript writer no longer owned this session/i;
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
// 2026.9.3+ (read at v2026.9.4): the gateway's own SQLite STORAGE failures, rendered for the
// reader by the same upstream file as the writer-fenced copy above
// (src/agents/failover/assistant-request-failure-copy.ts:13-26,52), from the classification in
// src/infra/sqlite-error-diagnostics.ts:4-11. They reach us as TEXT and nothing else: the chat
// error frame declares no errorCode field (packages/gateway-protocol/src/schema/logs-chat.ts:418-432)
// and its errorKind enum has no storage member (:313-319), so no structured fact survives.
// SPLIT IN TWO, by what the event asks of the reader — one label for both would be half wrong
// in each case. Busy/locked is contention: the same send can succeed. Full, read-only and I/O
// are the gateway's host: no resend helps until an operator acts. The raw sentence is still
// shown under the localized headline (errorDetailView), so the exact cause stays readable.
// NEITHER is retryable: the write failed with the run already working, exactly like the writer
// rebound, so an automatic re-dispatch could repeat work whose effects already happened.
const GATEWAY_STORAGE_BUSY_RE =
  /database is locked|database table is locked|state database was (?:busy|locked)\b/i;
const GATEWAY_STORAGE_UNAVAILABLE_RE =
  /database or disk is full|attempt to write a readonly database|disk i\/o error|state database was (?:full|read-only)|state database had an i\/o error/i;
// The gateway put the AUTH PROFILE in cooldown and then refused to use it.
//
// Upstream (v2026.9.4, `src/agents/runtime-plan/prepare-auth.ts` and
// `src/agents/provider-model-route-auth.ts`) throws this exact sentence when
// `isProfileInCooldown` says the credential is inside an unusable window —
// `src/agents/auth-profiles/usage-state.ts`, fed by a failure reason from
// `AuthProfileFailureReason` (rate_limit, overloaded, billing, auth, timeout, …).
// KNOWN GAP, deliberate: the gateway caps a chat error's `errorMessage` at 240
// characters (server-chat.ts) while upstream allows a 256-character profile id, so a
// long enough id cuts the sentence before `is temporarily unavailable` and this rule
// does not fire. It stays fail-closed — a truncated `Auth profile "…` is
// indistinguishable from the sibling `type mismatch` sentence, and a wrong class is
// worse than none (codex). The masker does NOT share this gap: it keys on the opening
// quote alone, so a truncated sentence is still redacted.
//
// WHAT OPENS THE WINDOW is not one vocabulary either: a cooldown from an
// `AuthProfileFailureReason`, but also the profile-wide `blockedUntil` and
// `disabledUntil` windows `isProfileInCooldown` honours, whose reasons are typed apart
// (`AuthProfileBlockedReason`, e.g. subscription_limit). This class does not
// distinguish them, and nothing downstream claims it does (codex).
//
// It is NOT a provider outage: this candidate was refused BEFORE the provider was
// called. (Only this candidate — a fallback chain may have tried others in the same
// turn, so nothing here licenses a claim about the whole turn.)
//
// Two facts from that source decide what the reader is told, and both are narrower
// than they first look. The window is TIME-BOUNDED — but a paused profile is not
// simply closed until it expires: `src/agents/failover-policy.ts` lets a cooldowned
// candidate be PROBED, at most once per provider per fallback run, for a transient
// reason or billing — the full lists are at the call site below, and an earlier version
// of this comment gave a shorter one (codex). So "retrying cannot work" is false;
// "retrying may hit the same pause" is what holds. And a MODEL-SCOPED cooldown
// is bypassed for a different model (`shouldBypassModelScopedCooldown`), while a
// profile-wide blocked/disabled window is not — so another model MAY route around it,
// with no promise that it does.
// Greedy between the quotes: upstream only requires a non-empty string for a profile
// id, so one may CONTAIN a quote, and `"[^"]*"` then failed to recognize the sentence
// at all — no class, the exact failure this rule exists to end (codex).
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

/** Does this sentence NAME A CREDENTIAL?
 *
 *  Upstream composes about thirty sentences around a quoted profile id, and each of
 *  them also interpolates operator-chosen values OUTSIDE the quotes — the provider, the
 *  model, an MCP server name. Five review passes narrowed a redaction and each time a
 *  different segment was still choosing a class: a profile name, a model id, a server
 *  name, an unquoted provider, and finally a quote injected INTO the id to shift the
 *  pairwise pass (codex).
 *
 *  The conclusion is structural, not a better pattern: a sentence built around operator
 *  data cannot be pattern-classified at all. So one is recognized, and then the only
 *  class it may receive is the one decided by its FIXED words before any quote. */
export function namesACredential(text: string): boolean {
  // `api key` with a space too: upstream writes `No API key found for provider "…"`
  // and `apikey` missed it entirely (codex).
  return /\b(?:profile|api\s*key)\s+"/i.test(text);
}

/** The ONE credential sentence this build classifies, by its fixed words only.
 *
 *  `Auth profile "<id>" is temporarily unavailable for …` — the words before the
 *  opening quote and the tail after the closing one, anchored on `for`, which upstream
 *  always emits next.
 *
 *  IRREDUCIBLE REMAINDER, stated: an id that reproduces that whole fixed phrase yields
 *  a sentence no reader could tell from a real one either. Its consequence is bounded —
 *  a cooldown card shown for another credential failure — and it is the only way in
 *  left. */
const COOLDOWN_SENTENCE_RE =
  /\bauth profile\s+"[\s\S]*?"\s+is temporarily unavailable\s+for\b/i;

/** The text with every operator-chosen segment removed, leaving only what the GATEWAY
 *  itself wrote — which is the only thing any rule below may read.
 *
 *  A credential sentence is CUT at its opening quote: everything after it is the id and
 *  then values upstream interpolated around it (the provider, the model, a server
 *  name), and each of those in turn was found choosing a class. What precedes it is
 *  still the gateway's own — so a full disk that reports both facts in one text keeps
 *  its graver class, which is the precedence this file promises.
 *
 *  The cooldown sentence is the exception, and only because its FIXED words continue
 *  after the id: it keeps `Auth profile "…" is temporarily unavailable for …`, anchored
 *  on `for`, the word upstream always emits next. */
export function withoutOperatorData(raw: string): string {
  if (!namesACredential(raw)) return blankQuotedValues(raw);
  // The cooldown exception applies ONLY when the first quote in the text is the
  // cooldown's OWN — i.e. the prose before it ends with `auth profile `. Testing the
  // raw text let an EARLIER operator segment carry the phrase: an MCP server named
  // `Auth profile "x" is temporarily unavailable for y` won the exception for a
  // sentence that is not one (codex).
  const firstQuote = raw.indexOf('"');
  const before = firstQuote === -1 ? raw : raw.slice(0, firstQuote);
  if (/\bauth profile\s+$/i.test(before)) {
    const cooled = raw.replace(
      /(\bauth profile\s+")[\s\S]*?("\s+is temporarily unavailable\s+for\b)[\s\S]*$/i,
      "$1…$2 …",
    );
    if (cooled !== raw) return cooled;
  }
  // Otherwise the cut is at that same FIRST quote — not at the credential word: in
  // `MCP server "<name>" references auth profile "<id>"` the operator's first value
  // comes BEFORE that word, so cutting there kept it (codex). What precedes the first
  // quote is the gateway's own prose, and nothing else survives.
  return firstQuote === -1 ? raw : `${raw.slice(0, firstQuote + 1)}…`;
}

/** Everything INSIDE quotes blanked, for a sentence that does not name a credential.
 *
 *  Cutting at the first quote is right where no class but the cooldown is legitimate.
 *  It is wrong everywhere else: real gateway sentences put an operator value first and
 *  their own classifying words after it — `Session "agent:alice:…" changed while
 *  starting work.` — and cutting would throw the class away. Blanking keeps the shape
 *  and removes the value.
 *
 *  The unterminated quote goes FIRST, so the pairwise pass cannot mistake it for an
 *  opening and swallow the fixed words behind it. (An injected quote can still shift
 *  the pairing, which is why a CREDENTIAL sentence is cut rather than blanked: there,
 *  the whole tail is operator data anyway.) */
function blankQuotedValues(raw: string): string {
  let out = raw;
  if (((out.match(/"/g) ?? []).length % 2) === 1) out = out.replace(/"[^"]*$/, '"…');
  return out.replace(/"[^"]*"/g, '"…"');
}

/** The gateway says the conversation it was asked to continue NO LONGER EXISTS.
 *
 *  Upstream composes this when preflight compaction is required and cannot run:
 *  `Preflight compaction required but failed: … no conversation found for session`
 *  (auto-reply/reply/agent-runner-failure-reply.ts). It classifies the same family as
 *  `session_expired` — `agents/failover/classify.ts` — and its own
 *  `isCliSessionInvalidatingFailoverReason` states what that means:
 *  "a failover PROVES the provider-side conversation can no longer be resumed".
 *
 *  Atrium kept its stored session and re-sent into it, so every retry met the same dead
 *  conversation and the only way out was the gateway's own advice — `/new` — shown raw
 *  to a reader who has no idea what that is. Recognising it is what lets the session be
 *  dropped, WHEN one is stored, and the turn re-dispatched — with the history rehydrated
 *  where rehydration applies (the bridge skips it when disabled, and on a turn carrying an
 *  attachment). None of those is unconditional; the second attempt is (codex).
 *
 *  Reported in production on three turns of one chat (prod-ms717cxh…, prod-ms7ctxqf…,
 *  prod-ms760bt1…), where an operator had to reset the session by hand for the user. */
/** The reasons upstream gives INSIDE the wrapper for a conversation it cannot find.
 *
 *  The whole shape is read at once: the compaction wrapper, then the clause opener bound to
 *  it — `failed:` inside the SAME clause, or `Reason:` opening the very next sentence, the
 *  two forms upstream's wrappers use — then the reason, which must END that clause.
 *
 *  The traversal stops at every mark that can open a new proposition — sentence end,
 *  semicolon, comma, colon, and both dashes. Each was earned: "Preflight compaction succeeded;
 *  session cleanup failed: session not found." crossed the semicolon, and ", but session
 *  cleanup failed:" / " - session cleanup failed:" crossed the comma and the ASCII dash, all
 *  reaching a SECOND clause's opener that belongs to an unrelated diagnostic — as did
 *  "Preflight compaction succeeded: session cleanup failed: ..." across the colon (codex).
 *
 *  Binding the opener to the wrapper is what a bare "an opener somewhere after the wrapper"
 *  did not do: "Preflight compaction required but failed: invalid session settings. Session
 *  cleanup failed: session not found." reached the SECOND opener, which belongs to an
 *  unrelated diagnostic (codex).
 *
 *  Both halves were earned. Matching the bare alternative anywhere let "Preflight
 *  compaction required but failed: invalid session settings for compaction" — a compaction
 *  problem on a LIVE conversation — read as a gone session; and matching it anywhere in a
 *  bounded window let a composite diagnostic pair two unrelated sentences into the class
 *  ("...failed: invalid session settings. Diagnostic: no conversation found..."). This
 *  class drops the session and re-runs the turn, so it fails closed on both (codex).
 *
 *  Mirrored by `SESSION_GONE_TEXT_RE` in src/chat/runStatusView.ts, which recognizes the
 *  same sentence on rows stored before this class existed. The two must stay in step. */
const SESSION_GONE_REASON_RE =
  /(?:auto-compaction|preflight compaction)(?:[^\n.!?;,:—-]{0,200}?failed\s*:\s*|[^\n.!?;,:—-]{0,200}?[.!?]\s*reason\s*:\s*)(?:no conversation found|conversation (?:not found|does not exist|expired|invalid)|session (?:not found|does not exist|expired|invalid)|no such session|invalid session|(?:session|conversation) id not found)(?=[.,;:!)\]]|\s*$|\s+(?:for|on|in|with)\b|\s+[—-]\s)/;

export function isSessionGoneText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = withoutOperatorData(text).toLowerCase();
  // NARROW, on purpose: the PREFLIGHT-COMPACTION wrapper, and a reason from the
  // session-gone family inside it.
  //
  // The upstream family is wider than this — `session_expired` is raised in places
  // where a run HAS produced something, and upstream itself refuses to invalidate the
  // session there (`hasNewGeneratedMediaTask`). Claiming the whole family would let a
  // turn with a detached media task reset a session that task still needs, and re-run
  // work already billed (codex, P1). The wrapper is the one shape that proves nothing
  // was generated: it is raised BEFORE the run, when compaction could not even start.
  if (!t.includes("auto-compaction") && !t.includes("preflight compaction")) {
    return false;
  }
  return SESSION_GONE_REASON_RE.test(t);
}

export function classifyFailureText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // A sentence that NAMES A CREDENTIAL gets exactly one possible class — the cooldown,
  // decided by fixed words — and otherwise none. Everything else in such a sentence is
  // operator data, and no pattern below may be applied to it (see `namesACredential`).
  const text = withoutOperatorData(raw);
  if (CONTEXT_OVERFLOW_TEXT_RE.test(text)) return "context_length";
  // Its OWN class, kept out of the automatic retry. Every other pattern below fires
  // while the session is being STARTED, before the model generates anything — which
  // is exactly what the retry relies on when it re-dispatches a zero-content turn
  // (convex/turnRetry.ts). This sentence carries no such guarantee: upstream throws
  // the SAME error before generation (run/session-bootstrap.ts
  // prepareInitialSessionWriter, run/pre-persisted-user-turn.ts
  // preparePersistedCurrentUserTurn) AND at transcript commits once the model has run
  // (run/settled-turn-finalization.ts, the sqlite transcript writers), where tools may
  // already have had external effects. The TEXT names neither moment (a refusal cause,
  // when one is passed, follows ` <- ` as a JSON object of hashes), so this function
  // returns the class sized for the worse one: a replay could repeat work the
  // zero-content gate cannot see (codex). The STREAM does tell them apart — a
  // generating run emits `lifecycle start` first — and the OpenClaw normalizer, which
  // sees the frames, upgrades a rebound it can prove pre-generation to
  // `session_init_conflict` (Normalizer.writeReboundBeforeGeneration).
  if (WRITER_CLAIM_REBOUND_RE.test(text) || WRITER_FENCED_COPY_RE.test(text)) {
    return "session_write_conflict";
  }
  // BEFORE the provider rule on purpose: its markers ("internal server error", a 5xx) can ride
  // the same sentence, and a full disk read as a provider blip would be AUTO-RETRIED into the
  // same wall (pinned in failure-classifier.test.ts). The graver class is tested first.
  // AFTER the two storage classes and BEFORE the provider rule.
  //
  // After, because the contract above is that the graver class wins: a gateway whose
  // disk is full can emit that sentence and this one in the same text, and naming the
  // cooldown would hide the only thing an operator can act on (codex). Before, because
  // this
  // `provider_internal` is AUTO-RETRIED on a short backoff. Whether a retry is even
  // ATTEMPTED upstream depends on the reason that opened the window: a probe is allowed
  // for billing and for the transient ones — rate_limit, overloaded, unknown,
  // empty_response, no_error_details, unclassified, timeout — and refused for
  // model_not_found, format, auth, auth_permanent and session_expired
  // (failover-policy.ts).
  //
  // TWO VOCABULARIES, and they are not the same one: the window is opened by an
  // `AuthProfileFailureReason` (auth-profiles/types.ts, thirteen values), while the
  // probe predicates take a `FailoverReason` (gateway-protocol/failover-reasons.ts,
  // sixteen). `tls_certificate`, `server_error` and `context_overflow` exist only in
  // the second, so they are refusals a probe can meet but never reasons a cooldown
  // started from. An earlier version of this list conflated them (codex). The class does not
  // say which of those it is, so a countdown promising recovery would be a guess shown
  // as a schedule. The reader decides instead: this class is deliberately absent from
  // RETRYABLE_KINDS.
  if (GATEWAY_STORAGE_UNAVAILABLE_RE.test(text)) return "gateway_storage_unavailable";
  if (GATEWAY_STORAGE_BUSY_RE.test(text)) return "gateway_storage_busy";
  // BEFORE the session-conflict rule below, which is about a session being STARTED:
  // this one says the conversation is gone for good, and the two ask for opposite
  // things — a bounded retry into the same session, versus dropping it first.
  if (isSessionGoneText(text)) return "session_gone";
  // AFTER the storage classes, like every other rule: the precedence above is that the
  // graver class wins, and a gateway whose disk is full can report both facts in one
  // text (codex).
  if (COOLDOWN_SENTENCE_RE.test(text)) return "auth_profile_cooldown";
  if (isSessionInitConflictText(text)) return "session_init_conflict";
  if (PROVIDER_INTERNAL_TEXT_RE.test(text) && !PROVIDER_INTERNAL_EXCLUDE_RE.test(text)) {
    return "provider_internal";
  }
  return null;
}
