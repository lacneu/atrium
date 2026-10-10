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

/** The gateway's OWN failure classes on a chat error frame — `ChatErrorEventSchema.
 *  errorKind` (upstream packages/gateway-protocol/src/schema/logs-chat.ts:356-362 at
 *  v2026.9.6), minus `unknown`, which names nothing a reader can act on. The server
 *  mints `timeout` from the recorded terminal classification rather than from the
 *  text (src/gateway/server-chat.ts:725-730), so for a run that hit its time limit this
 *  field is the only structured signal: the sentence beside it is upstream's generic
 *  advice. Shared by the turn normalizer and the sub-agent observer — the second
 *  reader of the same frame must not keep its own copy of the vocabulary. */
export const GATEWAY_CHAT_ERROR_KINDS: ReadonlySet<string> = new Set([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
]);

/** Gateway `errorKind` values that name a fact Atrium already has its OWN class for.
 *
 *  `state_contention` is NEW at v2026.9.7 (logs-chat.ts:363-370): the `chat.send`
 *  setup/dispatch path emits it for a TYPED SQLite BUSY/LOCKED only
 *  (src/sessions/session-run-error-presentation.ts:10-17, `isSqliteLockError` in
 *  src/infra/sqlite-error-diagnostics.ts:158-165; frame built by
 *  src/gateway/server-methods/chat-broadcast.ts:142-154), and REPLACES the raw
 *  "database is locked" text the storage-busy pattern read on 9.6 with fixed copy that
 *  names no storage fact. It is the same fact — contention, the run may already have
 *  executed — so it is the same class, terminal and never auto-retried (upstream:
 *  "Execution may have occurred; check the recorded outcome before resending"). */
//
// A Map, not an object literal: the key is a WIRE string, and an object lookup answers
// `constructor`, `toString` or `__proto__` with an inherited function or prototype.
const GATEWAY_ERROR_KIND_CLASSES: ReadonlyMap<string, string> = new Map([
  ["state_contention", "gateway_storage_busy"],
]);

/** `FailoverReason` — the gateway's own vocabulary for WHY a provider attempt failed
 *  (packages/gateway-protocol/src/failover-reasons.ts at v2026.9.6, sixteen values). It
 *  rides three carriers Atrium reads: `ChatErrorEvent.errorDetail.failoverReason`
 *  (logs-chat.ts ChatErrorDetailSchema, bounded by `projectChatErrorDetail`), the lifecycle
 *  `data.errorObservation` it is projected from (src/agents/embedded-agent-subscribe.
 *  handlers.lifecycle.ts:168-174, server-chat.ts:738 → :1219), and the machine-written
 *  `(<reason>)` suffix of each attempt of a model-fallback summary
 *  (src/agents/model-fallback-runner.ts:698-701). */
const FAILOVER_REASONS: ReadonlySet<string> = new Set([
  "auth",
  "auth_permanent",
  "format",
  "rate_limit",
  "overloaded",
  "billing",
  "server_error",
  "timeout",
  "tls_certificate",
  "context_overflow",
  "model_not_found",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);

/** The OAuth refresh failure reasons (src/agents/auth-profiles/oauth-refresh-failure.ts:21-28).
 *  NOT FailoverReasons: the lifecycle backstop stores one in `failoverReason` beside
 *  `providerRuntimeFailureKind: "auth_refresh"` (src/auto-reply/reply/agent-lifecycle-terminal.ts:
 *  126-136), and every one of them is a stored login the provider no longer accepts — the reply
 *  for a classified reason is "Model login expired on the gateway…"
 *  (src/auto-reply/reply/agent-runner-failure-reply.ts:300-315). */
const OAUTH_REFRESH_REASONS: ReadonlySet<string> = new Set([
  "refresh_token_reused",
  "expired",
  "invalid_grant",
  "sign_in_again",
  "invalid_refresh_token",
  "token_invalidated",
  "revoked",
]);

/** A 401 or 403 standing as an HTTP STATUS (`401:`, `HTTP 403 `, `(401)`, `403 {…}`) —
 *  never inside an identifier such as `x-401-expired-token`. */
const STATUS_401_RE = /(?:^|[\s:(\[])401(?=[:)\s,.{]|$)/;
const STATUS_403_RE = /(?:^|[\s:(\[])403(?=[:)\s,.{]|$)/;

/** Upstream's HIGH-CONFIDENCE `auth_permanent` wording (src/agents/failover/message-patterns.ts:
 *  49-56): a key or an account the provider has switched off for good. */
const AUTH_PERMANENT_TEXT_RE =
  /api[_ ]?key[_ ]?(?:revoked|deactivated|deleted)|deactivated[_ ]workspace|key has been (?:disabled|revoked)|account has been deactivated|not allowed for this organization/i;
/** What a 403 says beside its status when it is a PERMISSION refusal rather than a credential
 *  that stopped working: rights, region, workspace. Read only next to a 403 status. */
const PERMISSION_403_WORDS_RE =
  /forbidden|permission|not allowed|access denied|access to this|unsupported[_ ](?:country|region)|region|territory|deactivated|re-authenticate with:/i;

/** The CREDENTIAL class an auth failure belongs to, from the facts the gateway gave.
 *
 *  Upstream's `auth` reason covers a 401 AND a plain 403 AND status-less auth text
 *  (src/agents/embedded-agent-helpers/provider-runtime-failure.ts:242-258, classification-rules.ts:
 *  220-233), and its `Re-authenticate with:` hint follows `auth` and `auth_permanent` alike
 *  (src/agents/failover-error.ts:486-502) — a 403 permission refusal, an unsupported region, a
 *  deactivated workspace, a CLI backend with no profile. Telling the reader "your access expired,
 *  reconnect" is true for only one of those, so three classes:
 *   - `provider_auth_revoked`: 401 evidence, or a token the provider says is expired/revoked;
 *   - `provider_permission_denied`: `auth_permanent`, a 403, an OAuth scope refusal;
 *   - `provider_auth_failed`: an auth refusal whose kind nothing names. */
function credentialClass(
  reason: "auth" | "auth_permanent",
  status: number | null,
  text: string,
): string {
  if (reason === "auth_permanent") return "provider_permission_denied";
  if (status === 403) return "provider_permission_denied";
  if (status === 401) return "provider_auth_revoked";
  const has401 = STATUS_401_RE.test(text);
  const has403 = STATUS_403_RE.test(text);
  if (has403 && !has401) return "provider_permission_denied";
  if (AUTH_PERMANENT_TEXT_RE.test(text)) return "provider_permission_denied";
  if (has401 && !has403) return "provider_auth_revoked";
  if (AUTH_401_TOKEN_REVOKED_RE.test(text) || TOKEN_REVOKED_ASSERTED_RE.test(text)) {
    return "provider_auth_revoked";
  }
  return "provider_auth_failed";
}

/** The Atrium class for ONE `FailoverReason`, with the attempt's own text as evidence for the
 *  credential split. Null for the reasons that name nothing a reader can act on (`format`,
 *  `tls_certificate`, `empty_response`, `no_error_details`, `unclassified`, `unknown`) and for
 *  `session_expired`, whose Atrium counterpart (`session_gone`) drops the stored session and is
 *  only granted on the narrow wrapper proof below. */
function classFromFailoverReason(
  reason: string,
  status: number | null,
  text: string,
): string | null {
  switch (reason) {
    case "auth":
    case "auth_permanent":
      return credentialClass(reason, status, text);
    case "billing":
      return "provider_billing";
    case "rate_limit":
      return "rate_limit";
    // Upstream folds `overloaded` into the `rate_limit` chat errorKind (server-chat.ts:189-206),
    // but its own copy for it is "temporarily overloaded" (user-copy.ts:53-54), and the reader's
    // remedy is the transient one; `timeout` is upstream's "retryable-transient bucket" that
    // "deliberately swallows generic 5xx" (server-chat.ts:235-236) — not a run time limit.
    case "overloaded":
    case "server_error":
    case "timeout":
      return "provider_internal";
    case "context_overflow":
      return "context_length";
    case "model_not_found":
      return "model_not_found";
    default:
      return null;
  }
}

/** The class a STRUCTURED provider observation names, or null — read BEFORE any prose.
 *
 *  `errorDetail` on a chat error and `errorObservation` on a lifecycle error are the same
 *  closed shape (packages/gateway-protocol/src/schema/logs-chat.ts:419-462
 *  `ChatErrorDetailSchema` / `projectChatErrorDetail`): {provider, model, failoverReason,
 *  providerRuntimeFailureKind, providerErrorType, httpStatus, providerErrorMessagePreview}.
 *  Upstream's protocol doc calls it the structured route "not from reparsing the user-facing
 *  message" (docs/gateway/protocol/rpc-bootstrap-and-events.md:68-79). Only enums and the
 *  status are read: `provider`/`model` are operator configuration and the preview is provider
 *  prose, so none of them may choose a class.
 *
 *  The runtime kind first where it is narrower than the reason
 *  (src/agents/embedded-agent-helpers/provider-runtime-failure.ts:16-39, `classifyProvider
 *  RuntimeFailureKind` :168-268), then the reason, then a bare status. */
export function classifyErrorDetail(detail: unknown): string | null {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const reason = typeof d.failoverReason === "string" ? d.failoverReason.trim() : "";
  const kind =
    typeof d.providerRuntimeFailureKind === "string" ? d.providerRuntimeFailureKind.trim() : "";
  const status =
    typeof d.httpStatus === "number" && Number.isInteger(d.httpStatus) ? d.httpStatus : null;
  switch (kind) {
    case "auth_refresh":
      // The OAuth refresh failed (agent-lifecycle-terminal.ts:126-136): a classified reason
      // is a login the provider no longer accepts. Without one, upstream itself says only
      // "Model login failed … Please try again" (agent-runner-failure-reply.ts:318-321) —
      // possibly transient, so no class rather than one that says resending cannot help.
      return OAUTH_REFRESH_REASONS.has(reason) ? "provider_auth_revoked" : null;
    case "auth_invalid_token":
      // "Plain provider HTTP 401 auth failure" (provider-runtime-failure.ts:25-26, :242-258:
      // requires positive 401 evidence and an invalid/expired-token hint).
      return "provider_auth_revoked";
    case "auth_scope":
      // The credential works but lacks a scope (provider-runtime-failure.ts:200-202).
      return "provider_permission_denied";
    case "auth_html":
      // An HTML page behind a 401/403 (provider-runtime-failure.ts:206-215).
      return status === 403 ? "provider_permission_denied" : "provider_auth_failed";
    case "rate_limit":
      return "rate_limit";
    case "model_not_found":
      return "model_not_found";
    default:
      break;
  }
  if (FAILOVER_REASONS.has(reason)) {
    const byReason = classFromFailoverReason(reason, status, "");
    if (byReason !== null) return byReason;
  }
  if (status === 429) return "rate_limit";
  if (status !== null && status >= 500 && status <= 599) return "provider_internal";
  return null;
}

/** The gateway's own TERMINAL classes that outrank a provider observation: `timeout` is
 *  minted from the run's recorded terminal classification (server-chat.ts:725-730) — the run
 *  hit its time limit, whatever the last provider error was — and `refusal` is a stop-reason
 *  fact (server-chat.ts:215-226). */
const TERMINAL_FACT_KINDS: ReadonlySet<string> = new Set(["timeout", "refusal"]);

/** The STRUCTURED class of a failure frame — chat `state:"error"` or lifecycle
 *  `phase:"error"` — or null when neither structured field names one; the caller then falls
 *  back to the text (`classifyFailureText`), which stays the LAST resort. One function for
 *  the turn normalizer and the sub-agent observer, so the two readers of one frame agree. */
export function classifyStructuredFailure(fields: {
  errorKind?: unknown;
  errorDetail?: unknown;
}): string | null {
  // A storage fact the gateway itself classified outranks a provider observation, as
  // `timeout` does: the failure is the gateway's state, not the model's.
  const mapped =
    typeof fields.errorKind === "string"
      ? GATEWAY_ERROR_KIND_CLASSES.get(fields.errorKind)
      : undefined;
  if (mapped !== undefined) return mapped;
  const kind =
    typeof fields.errorKind === "string" && GATEWAY_CHAT_ERROR_KINDS.has(fields.errorKind)
      ? fields.errorKind
      : null;
  if (kind !== null && TERMINAL_FACT_KINDS.has(kind)) return kind;
  return classifyErrorDetail(fields.errorDetail) ?? kind;
}

// Upstream's context-overflow vocabulary (packages/ai/src/utils/overflow.ts
// ASSISTANT_OVERFLOW_PATTERNS / FAILOVER_EXPLICIT_OVERFLOW_PATTERNS, abridged to the phrasings
// gateways were seen to send), read only after the exclusions below.
const CONTEXT_OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded|request_too_large|request too large|input (?:token count )?exceeds the maximum number of (?:input )?tokens|input is too long for the model|too many tokens|reduce the length|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context/i;
/** What upstream EXCLUDES from an overflow before reading it as one
 *  (src/agents/failover/context-overflow.ts:34-80 `isLikelyContextOverflowError`): a TPM limit
 *  (Groq answers 413 for "tokens per minute", :45-48; packages/ai/src/utils/overflow.ts:115), a
 *  rate limit or a quota (:64-69; message-patterns.ts rateLimit), billing (:54-59;
 *  message-patterns.ts:207-229), and the Bedrock throttling sentence "Too many tokens, please
 *  wait before trying again" (overflow.ts:133-145 NON_OVERFLOW_PATTERNS). Offering to compact
 *  a session that is only being rate-limited is the wrong remedy. */
const CONTEXT_OVERFLOW_EXCLUDE_RE =
  /\btpm\b|tokens per (?:minute|day)|rate[_ -]?limit|too many requests|requests per (?:minute|hour|day)|throttl|please wait before trying again|\bquota\b|resource[_ -]?exhausted|usage limit|^(?:throttling error|service unavailable):|payment required|insufficient (?:credits|balance|funds)|insufficient[_ ]quota|credit balance|billing/i;
/** Upstream's carve-out from the TPM exclusion: a request larger than the whole TPM bucket
 *  cannot succeed by waiting (src/agents/failover/message-patterns.ts:7-25
 *  `isProviderRequestSizeCeilingError`), so the overflow tables still decide it
 *  (context-overflow.ts:39-43). Upstream's pattern with its free spans BOUNDED: two unbounded
 *  lazy spans in a row backtrack quadratically on a long sentence. */
const TPM_SIZE_CEILING_RE =
  /(?:\btpm\b|tokens per minute)[^.\n]{0,120}?\blimit\s+([\d,]{1,12})[^.\n]{0,120}?\brequested\s+([\d,]{1,12})/i;

function isContextOverflowText(text: string): boolean {
  if (!CONTEXT_OVERFLOW_TEXT_RE.test(text)) return false;
  const ceiling = TPM_SIZE_CEILING_RE.exec(text);
  if (ceiling !== null) {
    const limit = Number(ceiling[1]?.replaceAll(",", ""));
    const requested = Number(ceiling[2]?.replaceAll(",", ""));
    if (limit > 0 && requested > limit) return true;
  }
  return !CONTEXT_OVERFLOW_EXCLUDE_RE.test(text);
}
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
// Two more admission refusals of the SAME family — refused before any work, nothing
// reserved, and the gateway itself says to retry:
//  - 2026.9.6: `session transcript is rebuilding; retry shortly` — `UNAVAILABLE`,
//    `retryable: true, retryAfterMs: 250`, and no `pending-chat` reservation left
//    behind (src/gateway/server-methods/chat-send-pre-admission.ts:99-110). It fell to
//    UPSTREAM_ERROR: blamed on the bridge and never retried.
//  - since 2026.9.5 at least: `Session "<key>" is still initializing. Retry after
//    initialization completes.` (src/config/sessions/lifecycle.ts:123), unclassified.
const TRANSCRIPT_REBUILDING_RE = /session transcript is rebuilding;?\s*retry shortly/i;
const SESSION_INITIALIZING_RE = /is still initializing\.?\s*retry after initialization completes/i;
// 2026.9.3+ (read at v2026.9.4): the gateway's own SQLite STORAGE failures, rendered for the
// reader by the same upstream file as the writer-fenced copy above
// (src/agents/failover/assistant-request-failure-copy.ts:13-26,52), from the classification in
// src/infra/sqlite-error-diagnostics.ts:4-11. They reach us as TEXT and nothing else: the chat
// error frame declares no errorCode field (packages/gateway-protocol/src/schema/logs-chat.ts:418-432)
// and its errorKind enum had no storage member up to v2026.9.6 (:313-319), so no structured
// fact survived. v2026.9.7 adds `state_contention` for the busy half on the chat.send path
// (GATEWAY_ERROR_KIND_CLASSES); the text below stays the reading for every other carrier.
// SPLIT IN TWO, by what the event asks of the reader — one label for both would be half wrong
// in each case. Busy/locked is contention: the same send can succeed. Full, read-only and I/O
// are the gateway's host: no resend helps until an operator acts. The raw sentence is still
// shown under the localized headline (errorDetailView), so the exact cause stays readable.
// NEITHER is retryable: the write failed with the run already working, exactly like the writer
// rebound, so an automatic re-dispatch could repeat work whose effects already happened.
// v2026.9.7 replaces the SQLite sentence with fixed copy on the chat.send path
// (src/sessions/session-run-error-presentation.ts:3-7,14) and on chat.abort
// (src/gateway/server-methods/chat-abort-handler.ts:691-692); both name the admission
// that stayed busy, which is the one storage fact left in the text.
const GATEWAY_STORAGE_BUSY_RE =
  /database is locked|database table is locked|state database was (?:busy|locked)\b|sqlite transaction admission remained busy/i;
const GATEWAY_STORAGE_UNAVAILABLE_RE =
  /database or disk is full|attempt to write a readonly database|disk i\/o error|state database was (?:full|read-only)|state database had an i\/o error/i;
// The SAME host fact when the full filesystem is not the SQLite file itself but the scratch
// space the gateway reads it through (v2026.9.6). Every read-only inspection of an agent
// database first copies it into a private snapshot directory under `$XDG_CACHE_HOME/openclaw`,
// else `~/.cache/openclaw` (src/infra/sqlite-private-directory.ts:20-33, named with
// `SQLITE_SNAPSHOT_PREFIX`, sqlite-snapshot-retirement.ts:9); when that copy hits a full disk
// the errno surfaces through three upstream wrappers, none of which says "database or disk is
// full":
//   `sqliteSnapshotStagingError` (sqlite-snapshot-staging.ts:163-184) appends
//     "; snapshot staging root <dir>: free disk space/quota or set XDG_CACHE_HOME to a writable filesystem"
//     for ENOSPC / EDQUOT / SQLite FULL;
//   `formatSqliteReadOnlyInspectionFailure` (sqlite-error-diagnostics.ts:96-132) adds
//     "failed while creating its private snapshot: " and the " (code=ENOSPC)" suffix;
//   `createSqliteReadOnlyWorkerError` (sqlite-readonly-worker-protocol.ts:76-82) prefixes
//     "SQLite read-only worker ".
// Prod 2026-09-23 (a 256 MiB tmpfs cache): `sessions_spawn` -> "child session patch failed:
// SQLite read-only worker … ENOSPC … (code=ENOSPC)" and an agent database left refused.
// The gateway's own reader-facing copy for a full disk is matched too
// (src/agents/failover/user-copy.ts:159-165 `formatDiskSpaceErrorCopy`, which itself keys on
// `\benospc\b` / "no space left on device"): "OpenClaw could not write local session data
// because the disk is full. Free some disk space and try again." — its "try again" does not
// make it retryable, for the reason given above.
// EDQUOT is Node's "disk quota exceeded", the quota half of the same staging rule.
const GATEWAY_HOST_STORAGE_FULL_RE =
  /\benospc\b|\bedquot\b|no space left on device|disk quota exceeded|could not write local session data because the disk is full|free disk space\/quota or set xdg_cache_home to a writable filesystem/i;

/** Is this the gateway's HOST storage refusing (full, read-only, failing), in either of the
 *  wordings above? Shared by the frame classifier below and the dispatch classifier
 *  (core/dispatch-errors.ts) — one rule, two doors. */
export function isGatewayStorageUnavailableText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = withoutOperatorData(text);
  return GATEWAY_STORAGE_UNAVAILABLE_RE.test(t) || GATEWAY_HOST_STORAGE_FULL_RE.test(t);
}

// The gateway CLOSED THIS AGENT'S DATABASE to new work (v2026.9.5+, read at v2026.9.6). Two
// producers, one fact for the reader — the agent cannot run here until the gateway reopens it:
//  - `Agent database execution admission is closed` — src/state/openclaw-agent-execution.ts:145,
//    the only producer (its `assertCurrent`). Thrown to work that holds a reference to an
//    execution owner that has been RETIRED: closed after a native failure (:249-250
//    `owner.close()`), revoked by the agent resource registry (:380-383), closed with the
//    shared state database (:386-392), or a scope still owned by maintenance / agent deletion
//    (:72-79). Prod 2026-09-28: delegated children that had started failed with it and were
//    recorded `unknown`.
//  - `AgentDatabaseAdmissionError` (src/state/agent-database-admission.ts:232-237): message
//    `${reason}\n${repairHint}`, thrown by `assertAgentDatabaseAdmitted` (:239-244) to work on
//    an agent the gateway REFUSED at startup. Its three repair hints are fixed gateway prose:
//      :56 "Sessions remain unavailable until background inspection and preparation finish. …"
//      :57 "Sessions remain unavailable. Stop the Gateway, run \"openclaw doctor --fix\" …"
//      src/infra/state-migrations.agent-owner-guidance.ts:21
//        "Preserve and inspect this database before accepting a fresh agent. …"
//    The REASON before them is not: an inspection failure carries the underlying error
//    verbatim (agent-database-startup.ts:152-168, :290-294), which is how the ENOSPC above
//    ends up inside one — and that is why the storage rule is tested FIRST.
// The same refusal on a `chat.send` / session RPC arrives with its structured code in
// `error.details` (session-request-agent.ts:29-38) — read there, by code, in dispatch-errors.ts.
// Not retryable: a hint that says to stop the gateway and run doctor is not a transient.
const AGENT_DATABASE_CLOSED_RE =
  /agent database execution admission is closed|sessions remain unavailable|preserve and inspect this database before accepting a fresh agent/i;

// The gateway DROPPED THE USER'S ADMITTED INPUT because another writer replaced the
// conversation's active branch under it (v2026.9.6). One producer:
// src/config/sessions/session-accessor.sqlite-transcript-message-append.ts:185, inside
// `existingAppendResult`, reached when the input's transcript entry already exists but is
// no longer on the active path — upstream's own words at :179-180, "it cannot revive a
// replaced transcript branch". Prod 2026-09-28 (chat mh72csw4…, report prod-ms7eytay…): a
// send dispatched at the same moment as a requester-settle wake.
//
// NOTHING WAS PROCESSED. The throw is inside the append's write transaction
// (session-accessor.sqlite-transcript-turn.ts:153 `runOpenClawAgentWriteTransaction`),
// BEFORE `consumeSessionPendingInput` (:187), while the attempt persists the user prompt —
// which precedes the provider call (run/attempt-prompt-submit.ts: `persistThenStream` is the
// provider boundary). The dead entry sits on a branch the model no longer reads, so a resend
// (a new idempotency key, a new pending input) neither duplicates work nor context.
//
// NOT auto-retried (convex/turnRetry.ts): Atrium's retry re-dispatches through a gateway
// session RESET, which would throw away the reply the concurrent run just wrote. The
// reader's own resend keeps it — and in the prod case it succeeded a minute later.
const PENDING_INPUT_DROPPED_RE = /pending input is no longer active in its admitted transcript/i;

/** The gateway's model-fallback SUMMARY: every candidate failed, and upstream joined their
 *  causes (src/agents/model-fallback-attempt.ts:626-628 `throwFallbackFailureSummary`, one
 *  segment per attempt formatted by model-fallback-runner.ts:698-701 as
 *  `<provider>/<model>: <error>[ (<reason>)]`, joined by " | "). The label varies by
 *  capability ("models", "image generation models", …), hence the free words before it. */
const FALLBACK_SUMMARY_RE = /^\s*all (?:[a-z][\w -]{0,60}? )?models failed \(\d+\):\s*/i;
/** One attempt's `<provider>/<model>: ` prefix. A model id may itself contain a colon
 *  (`ollama/llama3:8b`), so the prefix ends at the first colon FOLLOWED BY whitespace. */
const FALLBACK_ATTEMPT_PREFIX_RE = /^[^\s/|]+\/\S+?:\s+/;

/** The CAUSES inside a model-fallback summary, with every candidate's `<provider>/<model>`
 *  removed — or null when the text is not one.
 *
 *  The wrapper names nothing itself; what classifies the turn is what each candidate died
 *  of. The model ids are operator configuration, and like every other operator value they
 *  must not be able to choose a class (`withoutOperatorData`). Segments that are not an
 *  attempt — the `⚠️ Agent run failed (model: …)` trailer the runner appends — are dropped
 *  for the same reason: they carry a model id and no cause. */
export function fallbackSummaryCauses(raw: string): string[] | null {
  const head = FALLBACK_SUMMARY_RE.exec(raw);
  if (head === null) return null;
  const causes = raw
    .slice(head[0].length)
    .split(" | ")
    .map((segment) => segment.trim())
    .filter((segment) => FALLBACK_ATTEMPT_PREFIX_RE.test(segment))
    .map((segment) => segment.replace(FALLBACK_ATTEMPT_PREFIX_RE, ""));
  return causes.length > 0 ? causes : null;
}

/** One attempt of a model-fallback summary: its cause with the `<provider>/<model>: ` prefix
 *  removed, and the machine-written `(<reason>)` suffix split off when it names a
 *  `FailoverReason` (model-fallback-runner.ts:698-701: `${attempt.reason ? ` (${reason})` : ""}`). */
export interface FallbackAttempt {
  text: string;
  reason: string | null;
}

/** The remediation upstream appends after the summary for an `auth`/`auth_permanent` last
 *  error (src/agents/model-fallback-attempt.ts:626-628 → failover-error.ts:486-502): ". Re-
 *  authenticate with: <command>", or the Gemini CLI variant. Machine-written, so its presence
 *  is a structured fact — an auth refusal — and it is not part of the last attempt's cause. */
const REMEDIATION_TAIL_RE =
  /\.\s+(?:re-authenticate with:\s|authenticate in gemini cli directly, or configure a supported google api key with:\s)[\s\S]*$/i;
/** The `(<reason>)` suffix at the very end of one attempt. A trailing period is tolerated: the
 *  preflight wrapper writes ` Reason: ${reason}.` (agent-runner-failure-reply.ts:213). */
const ATTEMPT_REASON_SUFFIX_RE = /\s\(([a-z_]+)\)\s*\.?\s*$/;

/** A model-fallback summary read into its attempts — with each `(<reason>)` suffix — and
 *  whether upstream appended its re-authentication remediation; null when the text is not one.
 *  A summary cut by the 240-character cap simply has fewer, or shorter, attempts. */
export function parseFallbackSummary(
  raw: string,
): { attempts: FallbackAttempt[]; authHint: boolean } | null {
  const head = FALLBACK_SUMMARY_RE.exec(raw);
  if (head === null) return null;
  let body = raw.slice(head[0].length);
  const hint = REMEDIATION_TAIL_RE.exec(body);
  if (hint !== null) body = body.slice(0, hint.index);
  const attempts = body
    .split(" | ")
    .map((segment) => segment.trim())
    .filter((segment) => FALLBACK_ATTEMPT_PREFIX_RE.test(segment))
    .map((segment): FallbackAttempt => {
      const text = segment.replace(FALLBACK_ATTEMPT_PREFIX_RE, "");
      const suffix = ATTEMPT_REASON_SUFFIX_RE.exec(text);
      const reason = suffix?.[1];
      return suffix !== null && reason !== undefined && FAILOVER_REASONS.has(reason)
        ? { text: text.slice(0, suffix.index), reason }
        : { text, reason: null };
    });
  return attempts.length > 0 ? { attempts, authHint: hint !== null } : null;
}

/** Upstream's PREFLIGHT-COMPACTION wrapper (v2026.9.6,
 *  src/auto-reply/reply/agent-runner-failure-reply.ts:198-218
 *  `buildPreflightCompactionFailureText`): a fixed headline, ` Reason: <reason>.` only when
 *  verbose failure details are on (:213), then a fixed tail. The headline is upstream's copy
 *  for ANY compaction failure — a 401, a 429, a busy writer — whatever the context size. */
const PREFLIGHT_WRAPPER_HEAD_RE =
  /^[\s⚠️]*context is too large and auto-compaction could not recover this turn\.\s*/i;
/** Its timed-out variant (:212-216) never carries a reason: the timeout IS the cause. */
const PREFLIGHT_TIMEOUT_HEAD_RE =
  /^[\s⚠️]*context is too large and auto-compaction timed out before it could finish\.\s*/i;
const WRAPPER_REASON_HEAD_RE = /^reason:\s*/i;
const PREFLIGHT_WRAPPER_TAIL_RE =
  /\.?\s*try again, use \/compact, or use \/new to start a fresh session\.?\s*$/i;
/** The other generic wrappers, v2026.9.6:
 *   - agent-runner-failure-reply.ts:416-424 `renderPostCompactionModelFailurePayload`:
 *     "⚠️ Context compaction succeeded, but the later model request still failed. <reply>";
 *   - :243-248 `formatForwardedExternalRunFailureText` (verbose only): "⚠️ Agent failed before
 *     reply: <detail>. Please try again, or use /new to start a fresh session.";
 *   - src/sessions/session-run-error.ts:42: "This turn ended before a reply: <error>";
 *   - src/agents/failover/user-copy.ts:304-305 `GENERIC_EXTERNAL_RUN_FAILURE_TEXT`: "⚠️
 *     Something went wrong while processing your request. Please try again, or use /new to
 *     start a fresh session." — the copy upstream shows when it withholds the detail. */
const POST_COMPACTION_HEAD_RE =
  /^[\s⚠️]*context compaction succeeded, but the later model request still failed\.\s*/i;
const AGENT_FAILED_HEAD_RE = /^[\s⚠️]*agent failed before reply:\s*/i;
const AGENT_FAILED_TAIL_RE = /\.?\s*please try again, or use \/new to start a fresh session\.?\s*$/i;
const TURN_ENDED_HEAD_RE = /^\s*this turn ended before a reply:\s*/i;
const SOMETHING_WENT_WRONG_RE = /^[\s⚠️]*something went wrong while processing your request\./i;
/** `formatForLog` caps a chat error at 240 characters and appends "..."
 *  (src/gateway/ws-log.ts:18, :115-152). */
const LOG_TRUNCATION_MARK_RE = /\.\.\.\s*$/;

/** Which generic wrapper a failure text came in. */
export type GatewayWrapper = "preflight_compaction" | "compaction_timeout" | "run_failure";

/** The failure text with upstream's generic wrappers peeled off: the outermost wrapper, and
 *  the cause text inside it (null when the wrapper carried none — verbose details off, or
 *  upstream's generic copy). Text that is not wrapped comes back unchanged with
 *  `wrapper: null`. */
export function unwrapGatewayFailure(raw: string): {
  wrapper: GatewayWrapper | null;
  inner: string | null;
} {
  let wrapper: GatewayWrapper | null = null;
  let text: string | null = raw.replace(LOG_TRUNCATION_MARK_RE, "");
  for (let depth = 0; depth < 4 && text !== null; depth++) {
    let next: string | null | undefined;
    let kind: GatewayWrapper | undefined;
    const pre = PREFLIGHT_WRAPPER_HEAD_RE.exec(text);
    const timedOut = pre === null ? PREFLIGHT_TIMEOUT_HEAD_RE.exec(text) : null;
    if (pre !== null || timedOut !== null) {
      kind = pre !== null ? "preflight_compaction" : "compaction_timeout";
      const rest = text.slice((pre ?? timedOut)![0].length);
      const reason = WRAPPER_REASON_HEAD_RE.exec(rest);
      next =
        reason === null ? null : rest.slice(reason[0].length).replace(PREFLIGHT_WRAPPER_TAIL_RE, "");
    } else if (POST_COMPACTION_HEAD_RE.test(text)) {
      kind = "run_failure";
      next = text.replace(POST_COMPACTION_HEAD_RE, "");
    } else if (AGENT_FAILED_HEAD_RE.test(text)) {
      kind = "run_failure";
      next = text.replace(AGENT_FAILED_HEAD_RE, "").replace(AGENT_FAILED_TAIL_RE, "");
    } else if (TURN_ENDED_HEAD_RE.test(text)) {
      kind = "run_failure";
      next = text.replace(TURN_ENDED_HEAD_RE, "");
    } else if (SOMETHING_WENT_WRONG_RE.test(text)) {
      kind = "run_failure";
      next = null;
    }
    if (kind === undefined) break;
    wrapper ??= kind;
    text = next === null || next === undefined || next.trim() === "" ? null : next.trim();
  }
  return wrapper === null ? { wrapper: null, inner: raw } : { wrapper, inner: text };
}

/** The REASON inside the preflight-compaction wrapper, or null when the text is not one or
 *  carries none. Kept for its readers; `unwrapGatewayFailure` is the general form. */
export function preflightWrappedReason(raw: string): string | null {
  const { wrapper, inner } = unwrapGatewayFailure(raw);
  return wrapper === "preflight_compaction" || wrapper === "compaction_timeout" ? inner : null;
}

export function isAgentDatabaseClosedText(text: string | null | undefined): boolean {
  if (!text) return false;
  return AGENT_DATABASE_CLOSED_RE.test(withoutOperatorData(text));
}

/** The codes `AgentDatabaseAdmissionRefusal.code` may carry (packages/gateway-protocol/
 *  src/schema/agent-database-admission.ts:12-25 at v2026.9.6, a closed union). Anything
 *  else under `details.code` belongs to another refusal. */
const AGENT_DATABASE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "agent-database-ownership-mismatch",
  "agent-database-inspection-pending",
  "agent-database-inspection-failed",
]);

export type GatewayOwnRefusal = "gateway_agent_db_closed" | "gateway_storage_unavailable";

/** Did the GATEWAY refuse this request on its OWN state — the agent's database closed
 *  to new work, or its host storage unusable — whatever request it was?
 *
 *  The gateway answers ANY request resolving to a refused agent `UNAVAILABLE`, with the
 *  whole `AgentDatabaseAdmissionRefusal` as `details` (src/gateway/session-request-agent.ts:
 *  29-38, agent-request-preflight.ts:92-100) — `chat.send` (chat-send-setup.ts:73-80), but
 *  also the `sessions.patch` that applies a permission mode and the knowledge plugin's
 *  session actions that run BEFORE it. Those callers turn a refusal into their own
 *  "not applied" error, so this fact has to be asked of the raw error first: read there,
 *  the reader was told to check a permission mode or a knowledge setting for an agent the
 *  gateway had closed (codex, 0.88.2). ONE predicate for every door, dispatch included.
 *
 *  The code is read STRUCTURALLY (`details` on any error of the cause chain — the client's
 *  answered-refusal error is the one that carries it) and wins over prose; a refusal whose
 *  reason is a full disk names the disk, the operator's action. Without a code, the fixed
 *  gateway sentences above decide. Null for anything else. */
export function gatewayOwnRefusal(err: unknown): GatewayOwnRefusal | null {
  const texts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    texts.push(current.message);
    const details = (current as { details?: unknown }).details;
    if (details !== null && typeof details === "object") {
      const { code, reason } = details as { code?: unknown; reason?: unknown };
      if (typeof code === "string" && AGENT_DATABASE_REFUSAL_CODES.has(code)) {
        return typeof reason === "string" && isGatewayStorageUnavailableText(reason)
          ? "gateway_storage_unavailable"
          : "gateway_agent_db_closed";
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  const text = texts.join(" <- ");
  if (isGatewayStorageUnavailableText(text)) return "gateway_storage_unavailable";
  if (isAgentDatabaseClosedText(text)) return "gateway_agent_db_closed";
  return null;
}

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
    ACTIVE_TURN_CLAIM_RE.test(text) ||
    TRANSCRIPT_REBUILDING_RE.test(text) ||
    SESSION_INITIALIZING_RE.test(withoutOperatorData(text))
  );
}

/** The gateway PAUSED the session after a provider refusal it wants reviewed (2026.9.6).
 *
 *  A refusal of category `misalignment` (OpenAI) pauses the session "as a precaution"
 *  (src/agents/embedded-agent-runner/run/provider-review-run.ts:126-163), and from then
 *  on every start of work is refused through src/config/sessions/lifecycle.ts:129,137:
 *    `Session "<key>" is paused as a precaution. Review the provider findings in chat before continuing.`
 *    `Session "<key>" provider review changed. Refresh the findings before continuing.`
 *  until an operator calls `sessions.providerReview.continue`, which Atrium does not
 *  offer. NOT a malformed request, and NOT retryable: a second attempt is refused the
 *  same way. Read through `withoutOperatorData`, like the archived rule. */
const PROVIDER_REVIEW_PAUSED_RE =
  /is paused as a precaution\.?\s*review the provider findings|provider review changed\.?\s*refresh the findings/i;

export function isProviderReviewPausedText(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_REVIEW_PAUSED_RE.test(withoutOperatorData(text));
}

/** The gateway refused THIS CONNECTION's turn because of the session's VISIBILITY
 *  (2026.9.6): `authorizeSessionSharingTarget` (src/gateway/session-sharing-policy.ts)
 *  answers `INVALID_REQUEST` "session is <visibility> for this connection" with
 *  `details.code: SESSION_PARTICIPATION_REQUIRED` — read-only and suggest refuse a
 *  non-member, draft refuses everyone but the creator and an admin. A choice the
 *  session's owner made on the gateway, not a malformed request, and not retryable:
 *  the same connection is refused the same way until the visibility changes. */
const SESSION_VISIBILITY_REFUSED_RE =
  /\bsession is (?:read-only|suggest|draft) for this connection\b|SESSION_PARTICIPATION_REQUIRED/i;

export function isSessionVisibilityRefusedText(text: string | null | undefined): boolean {
  if (!text) return false;
  return SESSION_VISIBILITY_REFUSED_RE.test(withoutOperatorData(text));
}

/** The gateway refused the send because the session's permission mode is no longer
 *  the one the send expected (`expectedPermissionMode`, 2026.8.2+):
 *  `captureAdmittedChatSendSessionSettings` (chat-send-session-settings.ts) raises
 *  "session-settings-changed", answered as `INVALID_REQUEST` "Session settings changed
 *  before send. Retry." (chat-send-pre-admission.ts). Nothing started. NOT retried by
 *  Atrium: the reader saw one mode and the session now runs another — they confirm,
 *  then send again. */
const SESSION_SETTINGS_CHANGED_RE = /session settings changed before send/i;

export function isSessionSettingsChangedText(text: string | null | undefined): boolean {
  if (!text) return false;
  return SESSION_SETTINGS_CHANGED_RE.test(text);
}

/** The gateway refused NEW WORK on an ARCHIVED session (2026.9.5).
 *
 *  Upstream auto-archives a durable dashboard session after 7 days of inactivity
 *  (`session.maintenance.archiveDashboardAfter`, default
 *  `DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS`, src/config/sessions/store-maintenance.ts:25)
 *  — and every Atrium conversation is a dashboard session. From then on the session
 *  refuses everything that starts work: `chat.send` (agent-admission-controller.ts:172),
 *  `sessions.reset` (session-reset-service.ts:1048) and the voice consult
 *  (reply-turn-admission.ts:388), all through ONE sentence,
 *  src/config/sessions/lifecycle.ts:124-125:
 *    `Session "<key>" is archived. Restore it before starting new work.`
 *  `chat.send` ships it behind `INVALID_REQUEST:` (server-methods/chat.ts:140), so
 *  without this rule it fell to the generic bucket — or, on a turn carrying a file,
 *  to ATTACHMENT_REJECTED, blaming a file that had nothing to do with it.
 *
 *  Read through `withoutOperatorData`: the quoted key is blanked before the test, so
 *  the rule keys on the sentence alone and a key containing these words cannot
 *  match by itself. The bridge RESTORES the session before sending (core/
 *  session-archive.ts); this classifier is for the refusal that slips past that —
 *  a restore that failed, or a race with the janitor. */
const SESSION_ARCHIVED_RE = /is archived\.?\s*restore it before starting new work/i;

export function isSessionArchivedText(text: string | null | undefined): boolean {
  if (!text) return false;
  return SESSION_ARCHIVED_RE.test(withoutOperatorData(text));
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

/** The PROVIDER refused the agent's credential as revoked or expired (v2026.9.6).
 *
 *  Two fixed gateway phrases, either of which is enough:
 *   - `Re-authenticate with: <command>` — emitted ONLY for the failover reasons `auth` and
 *     `auth_permanent` (src/agents/failover-error.ts:486-502 `buildFailoverRemediationHint`,
 *     appended to the model-fallback summary by src/agents/model-fallback-attempt.ts:627-628;
 *     same words in src/agents/cli-runner/prepare.ts:484 for a CLI backend whose profile
 *     could not be resolved). The cooldown's own hint is spelled `Re-authenticate with \``
 *     — no colon — and that sentence is classified by the rule before this one.
 *   - a `401` status followed by `invalidated|expired|revoked` and then `token`, the
 *     provider's own refusal as the summary carries it — prod 2026-10-02, agent `jerome`:
 *     `401: Encountered invalidated oauth token for user (auth)`. The `401` must stand as a
 *     STATUS (`401:`, `401)` or `401 `), so a model id such as `x-401-expired-token` cannot carry it.
 *     The provider's own wording in the OTHER order is taken too when it ASSERTS the fact —
 *     `HTTP 401: Your authentication token has been invalidated.` (OpenAI/Codex) — but not
 *     a token that "may have expired", which is upstream's hedge (below).
 *
 *  Upstream's own hedged copy for a bare 401 — "Authentication failed (provider returned
 *  HTTP 401). Your provider token may have expired — try the request again in a moment."
 *  (src/agents/failover/user-copy.ts:40-43) — is deliberately NOT matched: it puts `token`
 *  before `expired` and says the failure may pass, so it stays unclassified.
 *
 *  Read through `withoutOperatorData` like every rule here, so a quoted value cannot carry
 *  either phrase; the provider id in the command is single-quoted shell, not operator
 *  prose, and is never read by the rule (only by Convex, to name it in the anomaly). */
const REAUTHENTICATE_HINT_RE = /\bre-authenticate with:\s/i;
const AUTH_401_TOKEN_REVOKED_RE =
  /(?:^|[\s:(\[])401[:)\s][^|\n]{0,120}?(?:\b(?:invalidated|expired|revoked)\b[^|\n]{0,60}?\btokens?\b|\btokens?\s+(?:has|have)\s+(?:been\s+)?(?:invalidated|expired|revoked)\b|\btokens?\s+(?:was|were|is|are)\s+(?:invalidated|expired|revoked)\b)/i;
/** A token the provider ASSERTS is gone, without a status beside it — read only inside an
 *  attempt the gateway already classed `auth` (credentialClass), never alone. */
const TOKEN_REVOKED_ASSERTED_RE =
  /\b(?:invalidated|revoked)\b[^|\n]{0,60}?\btokens?\b|\btokens?\s+(?:has|have)\s+been\s+(?:invalidated|expired|revoked)\b|\b(?:refresh|access|oauth)\s+tokens?\s+(?:is|was|has)\s+(?:been\s+)?(?:invalidated|expired|revoked)\b/i;
/** Upstream's reply for an OAuth refresh failure with a classified reason
 *  (src/auto-reply/reply/agent-runner-failure-reply.ts:300-315): "⚠️ Model login expired on the
 *  gateway[ for <provider>]. Re-auth with <command> in a terminal, then try again." */
const MODEL_LOGIN_EXPIRED_RE = /\bmodel login expired on the gateway\b/i;
/** A 403 named as a status and, beside it, the words of a permission refusal. */
const PERMISSION_403_RE = new RegExp(
  `${STATUS_403_RE.source}[^|\\n]{0,200}?(?:${PERMISSION_403_WORDS_RE.source})`,
  "i",
);

/** The credential class a failure TEXT carries, or null (see `credentialClass` for the three).
 *
 *  Fixed gateway phrases and provider statuses only:
 *   - REVOKED: a `401` status followed by `invalidated|expired|revoked … token` (prod
 *     2026-10-02, agent `jerome`: `401: Encountered invalidated oauth token for user (auth)`),
 *     or the provider's own assertion in the other order (`HTTP 401: Your authentication token
 *     has been invalidated.`), or upstream's "Model login expired on the gateway";
 *   - PERMISSION: upstream's high-confidence `auth_permanent` wording, or a `403` status with
 *     permission words beside it;
 *   - FAILED: the `Re-authenticate with:` hint alone. It follows `auth` AND `auth_permanent`
 *     (failover-error.ts:486-502; the CLI backend with no resolvable profile,
 *     src/agents/cli-runner/prepare.ts:484), so it proves an auth refusal and nothing about
 *     its kind. The cooldown's own hint has no colon and is classified before this.
 *
 *  Upstream's HEDGED copy for a bare 401 — "Authentication failed (provider returned HTTP
 *  401). Your provider token may have expired — try the request again in a moment."
 *  (src/agents/failover/user-copy.ts:40-43) — is deliberately NOT matched: it says the failure
 *  may pass. The structured `errorDetail` beside it, when present, decides instead.
 *
 *  Read through `withoutOperatorData` like every rule here, so a quoted value cannot carry
 *  any of these phrases. Exported: the dispatch door asks the same question. */
export function providerCredentialTextClass(
  text: string | null | undefined,
  opts: { requireProviderEvidence?: boolean } = {},
): string | null {
  if (!text) return null;
  const t = withoutOperatorData(text);
  // The DISPATCH door also sees the bridge's OWN link fail: a reverse proxy in front of the
  // gateway can answer the WebSocket upgrade "403 Forbidden", which is the bridge's fault
  // domain, not a provider's. There a 403 counts only beside the gateway's own
  // re-authentication hint — words no proxy writes.
  if (
    opts.requireProviderEvidence === true &&
    PERMISSION_403_RE.test(t) &&
    !REAUTHENTICATE_HINT_RE.test(t) &&
    !AUTH_PERMANENT_TEXT_RE.test(t)
  ) {
    return AUTH_401_TOKEN_REVOKED_RE.test(t) || MODEL_LOGIN_EXPIRED_RE.test(t)
      ? "provider_auth_revoked"
      : null;
  }
  return credentialTextClassOf(t);
}

export function isProviderAuthRevokedText(text: string | null | undefined): boolean {
  return providerCredentialTextClass(text) === "provider_auth_revoked";
}

/** Upstream's fixed copy for a billing refusal (src/agents/failover/user-copy.ts:66-84
 *  `formatBillingErrorMessage`): "… returned a billing error — …". */
const BILLING_COPY_RE = /\breturned a billing error\b/i;
/** Upstream's fixed copy for an unknown model (src/agents/failover/user-copy.ts:135-136 and
 *  :590): "The selected model was not found by the provider." / "<provider> can't find the
 *  model you're using right now." */
const MODEL_NOT_FOUND_COPY_RE =
  /\bthe selected model was not found by the provider\b|\bcan'?t find the model you'?re using right now\b/i;
/** Upstream's two fixed rate-limit copies (src/agents/failover/user-copy.ts:39 "⚠️ API rate
 *  limit reached. Please try again later." and :55-56 "⚠️ The model request was rate-limited.
 *  Please try again in a few minutes."). Fixed gateway words only: a provider's own wording
 *  ("HTTP 429: Too Many Requests") stays for the structured fields to decide. */
const RATE_LIMIT_COPY_RE = /\bapi rate limit reached\b|\bthe model request was rate-limited\b/i;

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
  if (!namesACredential(raw)) return blankQuotedValues(exposeProviderErrorBodies(raw));
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
/** The fields of a provider's JSON error body whose STRING value is the provider's own
 *  wording — `{"type":"error","error":{"type":"authentication_error","message":"…"}}`. */
const PROVIDER_BODY_KEYS = "message|type|code|status|reason|detail|error";
/** A JSON body opened right after an HTTP status — `401 {…}`, `HTTP 403: {…}` — which is how
 *  provider SDK errors reach an attempt (packages/ai/src/utils/overflow.ts:16 quotes one:
 *  `413 {"error":{"type":"request_too_large",…}}`). The status anchor is what keeps an operator
 *  value out: a session key, a profile id or a server name never follows a status. */
const STATUS_BODY_OPEN_RE = /(?:^|[\s:(\[|])(?:http\s*)?[45]\d\d\b[^{"\n|]{0,40}?\{/gi;
const BODY_STRING_FIELD_RE = new RegExp(
  `"(?:${PROVIDER_BODY_KEYS})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
  "gi",
);

/** Each status-anchored provider JSON body replaced by the plain words of its message/type/code
 *  fields, so `blankQuotedValues` — which exists to blank OPERATOR values — does not also erase
 *  the provider's own refusal: `401 {"error":{"message":"OAuth token has been revoked"}}` used to
 *  reach every rule as `401 {"…":{"…":"…"}}`. A body the scan cannot close is left as it is. */
function exposeProviderErrorBodies(raw: string): string {
  let out = "";
  let cursor = 0;
  STATUS_BODY_OPEN_RE.lastIndex = 0;
  for (let m = STATUS_BODY_OPEN_RE.exec(raw); m !== null; m = STATUS_BODY_OPEN_RE.exec(raw)) {
    const open = m.index + m[0].length - 1;
    if (open < cursor) continue;
    // A body the 240-character cap cut (src/gateway/ws-log.ts:115-152 `formatForLog`) never
    // closes: it runs to the end of the text, and its last field may be cut mid-string.
    const close = matchingBrace(raw, open);
    const end = close === -1 ? raw.length - 1 : close;
    const body = raw.slice(open, end + 1);
    const words: string[] = [];
    BODY_STRING_FIELD_RE.lastIndex = 0;
    for (let f = BODY_STRING_FIELD_RE.exec(body); f !== null; f = BODY_STRING_FIELD_RE.exec(body)) {
      words.push(unescapeBodyString(f[1] ?? ""));
    }
    if (close === -1) {
      const cut = BODY_CUT_FIELD_RE.exec(body);
      if (cut !== null) words.push(unescapeBodyString(cut[1] ?? ""));
    }
    out += `${raw.slice(cursor, open)}${words.join(" ")}`;
    cursor = end + 1;
    STATUS_BODY_OPEN_RE.lastIndex = cursor;
  }
  return cursor === 0 ? raw : out + raw.slice(cursor);
}

const BODY_CUT_FIELD_RE = new RegExp(`"(?:${PROVIDER_BODY_KEYS})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`, "i");

function unescapeBodyString(value: string): string {
  return value.replace(/\\(.)/g, "$1").replace(/"/g, "");
}

/** The index of the `}` closing the `{` at `open`, string-aware; -1 when it never closes
 *  (a body cut by the 240-character cap). */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

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

/** ONE precedence for every reading of a failure text — a single sentence, the attempts of a
 *  model-fallback summary, and the front's mirror of this file (convex/lib/failureText.ts,
 *  which a parity test holds to the same verdicts): the GRAVER, more actionable class first.
 *
 *  The gateway's own host comes first (a full disk is what the operator must act on, and read
 *  as anything else it would be retried into the same wall), then a dropped input and a gone
 *  conversation (each asks for something specific), then the provider ACCOUNT — a credential,
 *  a permission, billing: every turn of the agent fails the same way until an operator acts —
 *  then what a later attempt or the reader can route around, and last what is retried. */
export const FAILURE_CLASS_PRECEDENCE: readonly string[] = [
  "gateway_storage_unavailable",
  "gateway_agent_db_closed",
  "gateway_storage_busy",
  "pending_input_dropped",
  "session_gone",
  "provider_auth_revoked",
  "provider_permission_denied",
  "provider_billing",
  "provider_auth_failed",
  "auth_profile_cooldown",
  "model_not_found",
  "context_length",
  "session_write_conflict",
  "session_init_conflict",
  "session_archived",
  "session_paused_review",
  "rate_limit",
  "provider_internal",
];

function precedence(cls: string): number {
  const i = FAILURE_CLASS_PRECEDENCE.indexOf(cls);
  return i === -1 ? FAILURE_CLASS_PRECEDENCE.length : i;
}

function mostGrave(classes: ReadonlyArray<string | null>): string | null {
  let best: string | null = null;
  for (const c of classes) {
    if (c !== null && (best === null || precedence(c) < precedence(best))) best = c;
  }
  return best;
}

/** Classes decided by a FIXED GATEWAY SENTENCE about the gateway's own state. Inside a summary
 *  attempt they outrank the attempt's `(<reason>)` suffix, which describes the provider side:
 *  a candidate skipped for a paused profile, or refused by a full disk, is that — whatever
 *  failover reason the runner filed it under. */
const GATEWAY_OWN_CLASSES: ReadonlySet<string> = new Set([
  "gateway_storage_unavailable",
  "gateway_agent_db_closed",
  "gateway_storage_busy",
  "pending_input_dropped",
  "session_gone",
  "auth_profile_cooldown",
  "session_write_conflict",
  "session_init_conflict",
  "session_archived",
  "session_paused_review",
]);

/** The class of ONE fallback attempt: a gateway-own sentence first, then the machine-written
 *  `(<reason>)` suffix — with the attempt's own text as the evidence that splits an auth
 *  refusal — and the prose rules last. */
function classifyFallbackAttempt(attempt: FallbackAttempt): string | null {
  const prose = classifySingleFailureText(attempt.text);
  if (prose !== null && GATEWAY_OWN_CLASSES.has(prose)) return prose;
  const structured =
    attempt.reason === null
      ? null
      : classFromFailoverReason(attempt.reason, null, withoutOperatorData(attempt.text));
  return structured ?? prose;
}

/** The class of a failure text with no wrapper around it — or, in a summary, of its attempts. */
function classifyFailureCause(text: string): string | null {
  const summary = parseFallbackSummary(text);
  if (summary === null) return classifySingleFailureText(text);
  // Each attempt is read ON ITS OWN. Read joined, the operator-data cut of one attempt (a
  // cooldown sentence keeps nothing after its profile id) erased every attempt after it — a
  // later candidate's 401 included.
  const perAttempt = summary.attempts.map(classifyFallbackAttempt);
  const fromHint = summary.authHint ? "provider_auth_failed" : null;
  if (!perAttempt.includes("pending_input_dropped")) {
    return mostGrave([...perAttempt, fromHint]);
  }
  // `pending_input_dropped` PROMISES THE READER NOTHING RAN. One attempt losing its input
  // proves that only for that attempt: an earlier candidate may have streamed, or run a
  // tool, before failing some other way. So the class is given only when EVERY attempt
  // provably did no work; otherwise the turn is classified by the other attempts' causes,
  // without the promise.
  if (perAttempt.every((c) => c !== null && PRE_EXECUTION_CLASSES.has(c))) {
    return "pending_input_dropped";
  }
  return mostGrave([...perAttempt.filter((c) => c !== "pending_input_dropped"), fromHint]);
}

/** The stable class of a failure TEXT, or null when it names nothing recognizable.
 *
 *  STRUCTURED FACTS FIRST, prose last. The caller has already read `errorKind` and
 *  `errorDetail` (`classifyStructuredFailure`); inside the text, the machine-written parts —
 *  upstream's wrappers, the fallback summary's `(<reason>)` suffixes, its re-authentication
 *  remediation — decide before any phrasing rule.
 *
 *  A GENERIC WRAPPER NEVER NAMES THE CAUSE. Upstream wraps ANY preflight-compaction failure
 *  in "Context is too large and auto-compaction could not recover this turn"
 *  (agent-runner-failure-reply.ts:198-218) and drops the reason unless verbose details are
 *  on (:213); the structured cause is lost earlier still (src/auto-reply/reply/agent-runner-
 *  memory.ts:1096-1098 rethrows the string alone). So the cause inside is classified, and
 *  when there is none the class says exactly that — `compaction_failed_no_cause`,
 *  `run_failed_no_cause` — instead of letting the wrapper's first words become the label.
 *
 *  FAIL-SAFE by construction: ambiguous text yields null. A wrong class is worse than none —
 *  `provider_internal` triggers an automatic retry, and retrying an auth or entitlement
 *  failure burns quota and shows a misleading label. */
export function classifyFailureText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const { wrapper, inner } = unwrapGatewayFailure(raw);
  let cause = inner === null ? null : classifyFailureCause(inner);
  // The gone-conversation proof is read on the WHOLE text: it is bound to the compaction
  // wrapper's own clause (SESSION_GONE_REASON_RE), which unwrapping removes.
  if (isSessionGoneText(raw)) cause = mostGrave([cause, "session_gone"]);
  if (cause !== null) return cause;
  if (wrapper === "compaction_timeout") return "compaction_timeout";
  if (wrapper === "preflight_compaction") return "compaction_failed_no_cause";
  if (wrapper === "run_failure") return "run_failed_no_cause";
  return null;
}

/** The attempt failures upstream raises BEFORE the candidate executes anything, read at
 *  v2026.9.6 — the only ones that may stand beside a dropped input in a summary that still
 *  says "nothing was processed":
 *   - `pending_input_dropped`: thrown while the attempt persists the user prompt, inside the
 *     write transaction and before the provider is called (see PENDING_INPUT_DROPPED_RE);
 *   - `auth_profile_cooldown`: the candidate's credential is refused while its runtime plan
 *     is PREPARED — src/agents/runtime-plan/prepare-auth.ts:216,491,603 and
 *     src/agents/provider-model-route-auth.ts:166 — before any prompt is submitted.
 *  Nothing else qualifies: an overflow, a provider error or a storage failure can each
 *  strike after the model streamed or a tool ran, and an unrecognized cause proves nothing. */
const PRE_EXECUTION_CLASSES: ReadonlySet<string> = new Set([
  "pending_input_dropped",
  "auth_profile_cooldown",
]);

/** The provider-credential rules on text ALREADY stripped of operator values. */
function credentialTextClassOf(text: string): string | null {
  if (AUTH_401_TOKEN_REVOKED_RE.test(text) || MODEL_LOGIN_EXPIRED_RE.test(text)) {
    return "provider_auth_revoked";
  }
  if (AUTH_PERMANENT_TEXT_RE.test(text) || PERMISSION_403_RE.test(text)) {
    return "provider_permission_denied";
  }
  if (REAUTHENTICATE_HINT_RE.test(text)) return "provider_auth_failed";
  return null;
}

/** The rules, IN `FAILURE_CLASS_PRECEDENCE` ORDER, on one sentence. */
function classifySingleFailureText(raw: string): string | null {
  // A sentence that NAMES A CREDENTIAL gets exactly one possible class — the cooldown,
  // decided by fixed words — and otherwise none. Everything else in such a sentence is
  // operator data, and no pattern below may be applied to it (see `namesACredential`).
  const text = withoutOperatorData(raw);
  // The gateway's HOST first: a full disk read as a provider blip would be AUTO-RETRIED into
  // the same wall (pinned in failure-classifier.test.ts), and naming anything else beside it
  // would hide the only thing an operator can act on (codex).
  if (GATEWAY_STORAGE_UNAVAILABLE_RE.test(text) || GATEWAY_HOST_STORAGE_FULL_RE.test(text)) {
    return "gateway_storage_unavailable";
  }
  // AFTER the host-storage class (an admission refusal can carry a full disk as its reason,
  // and the disk is what the operator must act on) and BEFORE contention: a refused agent
  // whose reason happens to say "database is locked" is not a resend-and-it-works event.
  if (AGENT_DATABASE_CLOSED_RE.test(text)) return "gateway_agent_db_closed";
  if (GATEWAY_STORAGE_BUSY_RE.test(text)) return "gateway_storage_busy";
  // After the storage classes (the graver class wins), before everything that could be
  // retried: a dropped input is not a provider blip, and in a fallback summary it is the
  // cause every later candidate inherited.
  if (PENDING_INPUT_DROPPED_RE.test(text)) return "pending_input_dropped";
  // BEFORE the session-conflict rule below, which is about a session being STARTED:
  // this one says the conversation is gone for good, and the two ask for opposite
  // things — a bounded retry into the same session, versus dropping it first.
  if (isSessionGoneText(text)) return "session_gone";
  // The provider ACCOUNT: a credential, a permission, billing. Every attempt fails the same
  // way until an operator fixes it, so it is never `provider_internal` (auto-retried) nor a
  // session conflict, and it outranks the overflow vocabulary — "Context is too large" is
  // upstream's wrapper, not a context fact (agent-runner-failure-reply.ts:198-218).
  const credential = credentialTextClassOf(text);
  if (credential === "provider_auth_revoked" || credential === "provider_permission_denied") {
    return credential;
  }
  if (BILLING_COPY_RE.test(text)) return "provider_billing";
  if (credential !== null) return credential;
  // The cooldown AFTER the credential classes: inside one sentence its fixed words keep only
  // `Auth profile "…" is temporarily unavailable for …` (withoutOperatorData), so nothing
  // else can match there; across a summary's attempts the revoked credential is the root
  // cause the paused profile inherited.
  //
  // `provider_internal` is AUTO-RETRIED on a short backoff, and this class is not. Whether a
  // retry is even ATTEMPTED upstream depends on the reason that opened the window: a probe
  // is allowed for billing and for the transient ones — rate_limit, overloaded, unknown,
  // empty_response, no_error_details, unclassified, timeout — and refused for
  // model_not_found, format, auth, auth_permanent and session_expired (failover-policy.ts).
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
  if (COOLDOWN_SENTENCE_RE.test(text)) return "auth_profile_cooldown";
  if (MODEL_NOT_FOUND_COPY_RE.test(text)) return "model_not_found";
  if (isContextOverflowText(text)) return "context_length";
  // Its OWN class, kept out of the automatic retry. Every pattern below fires while the
  // session is being STARTED, before the model generates anything — which is exactly what
  // the retry relies on when it re-dispatches a zero-content turn (convex/turnRetry.ts).
  // This sentence carries no such guarantee: upstream throws the SAME error before
  // generation (run/session-bootstrap.ts prepareInitialSessionWriter, run/pre-persisted-
  // user-turn.ts preparePersistedCurrentUserTurn) AND at transcript commits once the model
  // has run (run/settled-turn-finalization.ts, the sqlite transcript writers), where tools
  // may already have had external effects. The TEXT names neither moment (a refusal cause,
  // when one is passed, follows ` <- ` as a JSON object of hashes), so this function
  // returns the class sized for the worse one: a replay could repeat work the zero-content
  // gate cannot see (codex). The STREAM does tell them apart — a generating run emits
  // `lifecycle start` first — and the OpenClaw normalizer, which sees the frames, upgrades
  // a rebound it can prove pre-generation to `session_init_conflict`
  // (Normalizer.writeReboundBeforeGeneration).
  if (WRITER_CLAIM_REBOUND_RE.test(text) || WRITER_FENCED_COPY_RE.test(text)) {
    return "session_write_conflict";
  }
  if (isSessionInitConflictText(text)) return "session_init_conflict";
  // THE SECOND DOOR. The same refusal reaches Atrium two ways: as a dispatch
  // rejection (classified in dispatch-errors.ts) and as the FAILURE TEXT of a
  // turn already streaming — a run.status reason, a lifecycle error, a sub-agent's
  // own failure. Only the first was named, so an archived refusal arriving on the
  // wire fell to the generic bucket: `unclassified_error`, no card the reader can
  // read, nothing for the per-cause anomaly plane, and — because the retry policy
  // keys on the class — no automatic second attempt, on the one failure that a
  // second attempt reliably fixes.
  //
  // Placed exactly where dispatch-errors places it, after the init-conflict rule:
  // two readers of one sentence must not disagree about which class wins.
  if (isSessionArchivedText(text)) return "session_archived";
  // Same place in both readers (dispatch-errors.ts), for the same reason.
  if (isProviderReviewPausedText(text)) return "session_paused_review";
  if (RATE_LIMIT_COPY_RE.test(text)) return "rate_limit";
  if (PROVIDER_INTERNAL_TEXT_RE.test(text) && !PROVIDER_INTERNAL_EXCLUDE_RE.test(text)) {
    return "provider_internal";
  }
  return null;
}
