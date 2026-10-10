// THE FRONT'S MIRROR OF THE BRIDGE'S FAILURE CLASSIFIER (bridge/src/core/failure-classifier.ts).
//
// A message's failure class is minted by the bridge and stored as `errorCode`. Rows stored
// BEFORE a class existed — or written by an older bridge during a rolling deploy — carry only
// the gateway's sentence, and the card must render them the same way. The bridge package is
// not importable here (neither the frontend image nor the Convex bundle ships it), so its
// rules are MIRRORED: the same patterns, the same unwrapping of upstream's generic wrappers,
// the same per-attempt reading of a model-fallback summary and ONE precedence. Two guards keep
// the copy honest (convex/lib/failureText.test.ts): every pattern below is compared, source
// and flags, with the bridge's literal of the same name; and both classifiers must give the
// same verdict on the shared upstream corpus (bridge/test/fixtures/failure-text-corpus.json).
//
// The upstream citations live beside each rule in the bridge file and are not repeated here.
// NO imports, like chatRenderState: importable from the front and from Convex alike.

// --- Patterns: each one is the bridge's literal of the same name (lockstep-tested) ---------

const STATUS_401_RE =
  /(?:^|[\s:(\[])401(?=[:)\s,.{]|$)/;
const STATUS_403_RE =
  /(?:^|[\s:(\[])403(?=[:)\s,.{]|$)/;
const AUTH_PERMANENT_TEXT_RE =
  /api[_ ]?key[_ ]?(?:revoked|deactivated|deleted)|deactivated[_ ]workspace|key has been (?:disabled|revoked)|account has been deactivated|not allowed for this organization/i;
const PERMISSION_403_WORDS_RE =
  /forbidden|permission|not allowed|access denied|access to this|unsupported[_ ](?:country|region)|region|territory|deactivated|re-authenticate with:/i;
const CONTEXT_OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded|request_too_large|request too large|input (?:token count )?exceeds the maximum number of (?:input )?tokens|input is too long for the model|too many tokens|reduce the length|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context/i;
const CONTEXT_OVERFLOW_EXCLUDE_RE =
  /\btpm\b|tokens per (?:minute|day)|rate[_ -]?limit|too many requests|requests per (?:minute|hour|day)|throttl|please wait before trying again|\bquota\b|resource[_ -]?exhausted|usage limit|^(?:throttling error|service unavailable):|payment required|insufficient (?:credits|balance|funds)|insufficient[_ ]quota|credit balance|billing/i;
const TPM_SIZE_CEILING_RE =
  /(?:\btpm\b|tokens per minute)[^.\n]{0,120}?\blimit\s+([\d,]{1,12})[^.\n]{0,120}?\brequested\s+([\d,]{1,12})/i;
const SESSION_INIT_CONFLICT_RE =
  /reply session initialization conflicted/i;
const EMBEDDED_LOCK_CONFLICT_RE =
  /session file changed while embedded prompt lock/i;
const WRITER_CLAIM_REBOUND_RE =
  /session writer claim changed before transcript persistence/i;
const WRITER_FENCED_COPY_RE =
  /the transcript writer no longer owned this session/i;
const ACTIVE_TURN_CLAIM_RE =
  /session .* already has an active turn claim/i;
const SESSION_CHANGED_STARTING_RE =
  /session .* (?:changed|was deleted) while starting work/i;
const TRANSCRIPT_REBUILDING_RE =
  /session transcript is rebuilding;?\s*retry shortly/i;
const SESSION_INITIALIZING_RE =
  /is still initializing\.?\s*retry after initialization completes/i;
const GATEWAY_STORAGE_BUSY_RE =
  /database is locked|database table is locked|state database was (?:busy|locked)\b|sqlite transaction admission remained busy/i;
const GATEWAY_STORAGE_UNAVAILABLE_RE =
  /database or disk is full|attempt to write a readonly database|disk i\/o error|state database was (?:full|read-only)|state database had an i\/o error/i;
const GATEWAY_HOST_STORAGE_FULL_RE =
  /\benospc\b|\bedquot\b|no space left on device|disk quota exceeded|could not write local session data because the disk is full|free disk space\/quota or set xdg_cache_home to a writable filesystem/i;
const AGENT_DATABASE_CLOSED_RE =
  /agent database execution admission is closed|sessions remain unavailable|preserve and inspect this database before accepting a fresh agent/i;
const PENDING_INPUT_DROPPED_RE =
  /pending input is no longer active in its admitted transcript/i;
const FALLBACK_SUMMARY_RE =
  /^\s*all (?:[a-z][\w -]{0,60}? )?models failed \(\d+\):\s*/i;
const FALLBACK_ATTEMPT_PREFIX_RE =
  /^[^\s/|]+\/\S+?:\s+/;
const REMEDIATION_TAIL_RE =
  /\.\s+(?:re-authenticate with:\s|authenticate in gemini cli directly, or configure a supported google api key with:\s)[\s\S]*$/i;
const ATTEMPT_REASON_SUFFIX_RE =
  /\s\(([a-z_]+)\)\s*\.?\s*$/;
const PREFLIGHT_WRAPPER_HEAD_RE =
  /^[\s⚠️]*context is too large and auto-compaction could not recover this turn\.\s*/i;
const PREFLIGHT_TIMEOUT_HEAD_RE =
  /^[\s⚠️]*context is too large and auto-compaction timed out before it could finish\.\s*/i;
const WRAPPER_REASON_HEAD_RE =
  /^reason:\s*/i;
const PREFLIGHT_WRAPPER_TAIL_RE =
  /\.?\s*try again, use \/compact, or use \/new to start a fresh session\.?\s*$/i;
const POST_COMPACTION_HEAD_RE =
  /^[\s⚠️]*context compaction succeeded, but the later model request still failed\.\s*/i;
const AGENT_FAILED_HEAD_RE =
  /^[\s⚠️]*agent failed before reply:\s*/i;
const AGENT_FAILED_TAIL_RE =
  /\.?\s*please try again, or use \/new to start a fresh session\.?\s*$/i;
const TURN_ENDED_HEAD_RE =
  /^\s*this turn ended before a reply:\s*/i;
const SOMETHING_WENT_WRONG_RE =
  /^[\s⚠️]*something went wrong while processing your request\./i;
const LOG_TRUNCATION_MARK_RE =
  /\.\.\.\s*$/;
const PROVIDER_INTERNAL_TEXT_RE =
  /the ai service returned an (?:internal )?error|the ai service is temporarily (?:overloaded|unavailable)|returned an html error page|malformed_streaming_fragment|malformed fragment|an error occurred while processing your request|http\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)|internal server error|\bupstream (?:error|connect)|server_error|overloaded_error|fetch failed|socket hang ?up|network error|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|und_err|terminated unexpectedly/i;
const PROVIDER_INTERNAL_EXCLUDE_RE =
  /rate[- ]?limit|too many requests|http\s*4\d\d\b|unauthorized|forbidden|invalid[_ ](?:api[_ ]?key|request|model)|api[_ ]?key|authentication|billing|quota|insufficient|not[_ ]found|unsupported|refus|content[_ ]policy|context overflow|prompt too large/i;
const PROVIDER_REVIEW_PAUSED_RE =
  /is paused as a precaution\.?\s*review the provider findings|provider review changed\.?\s*refresh the findings/i;
const SESSION_ARCHIVED_RE =
  /is archived\.?\s*restore it before starting new work/i;
const COOLDOWN_SENTENCE_RE =
  /\bauth profile\s+"[\s\S]*?"\s+is temporarily unavailable\s+for\b/i;
const REAUTHENTICATE_HINT_RE =
  /\bre-authenticate with:\s/i;
const AUTH_401_TOKEN_REVOKED_RE =
  /(?:^|[\s:(\[])401[:)\s][^|\n]{0,120}?(?:\b(?:invalidated|expired|revoked)\b[^|\n]{0,60}?\btokens?\b|\btokens?\s+(?:has|have)\s+(?:been\s+)?(?:invalidated|expired|revoked)\b|\btokens?\s+(?:was|were|is|are)\s+(?:invalidated|expired|revoked)\b)/i;
const TOKEN_REVOKED_ASSERTED_RE =
  /\b(?:invalidated|revoked)\b[^|\n]{0,60}?\btokens?\b|\btokens?\s+(?:has|have)\s+been\s+(?:invalidated|expired|revoked)\b|\b(?:refresh|access|oauth)\s+tokens?\s+(?:is|was|has)\s+(?:been\s+)?(?:invalidated|expired|revoked)\b/i;
const MODEL_LOGIN_EXPIRED_RE =
  /\bmodel login expired on the gateway\b/i;
const BILLING_COPY_RE =
  /\breturned a billing error\b/i;
const MODEL_NOT_FOUND_COPY_RE =
  /\bthe selected model was not found by the provider\b|\bcan'?t find the model you'?re using right now\b/i;
const RATE_LIMIT_COPY_RE =
  /\bapi rate limit reached\b|\bthe model request was rate-limited\b/i;
const STATUS_BODY_OPEN_RE =
  /(?:^|[\s:(\[|])(?:http\s*)?[45]\d\d\b[^{"\n|]{0,40}?\{/gi;
const SESSION_GONE_REASON_RE =
  /(?:auto-compaction|preflight compaction)(?:[^\n.!?;,:—-]{0,200}?failed\s*:\s*|[^\n.!?;,:—-]{0,200}?[.!?]\s*reason\s*:\s*)(?:no conversation found|conversation (?:not found|does not exist|expired|invalid)|session (?:not found|does not exist|expired|invalid)|no such session|invalid session|(?:session|conversation) id not found)(?=[.,;:!)\]]|\s*$|\s+(?:for|on|in|with)\b|\s+[—-]\s)/;

/** Every mirrored pattern by its bridge name — read by the lockstep test only. */
export const MIRRORED_PATTERNS: Readonly<Record<string, RegExp>> = {
  STATUS_401_RE,
  STATUS_403_RE,
  AUTH_PERMANENT_TEXT_RE,
  PERMISSION_403_WORDS_RE,
  CONTEXT_OVERFLOW_TEXT_RE,
  CONTEXT_OVERFLOW_EXCLUDE_RE,
  TPM_SIZE_CEILING_RE,
  SESSION_INIT_CONFLICT_RE,
  EMBEDDED_LOCK_CONFLICT_RE,
  WRITER_CLAIM_REBOUND_RE,
  WRITER_FENCED_COPY_RE,
  ACTIVE_TURN_CLAIM_RE,
  SESSION_CHANGED_STARTING_RE,
  TRANSCRIPT_REBUILDING_RE,
  SESSION_INITIALIZING_RE,
  GATEWAY_STORAGE_BUSY_RE,
  GATEWAY_STORAGE_UNAVAILABLE_RE,
  GATEWAY_HOST_STORAGE_FULL_RE,
  AGENT_DATABASE_CLOSED_RE,
  PENDING_INPUT_DROPPED_RE,
  FALLBACK_SUMMARY_RE,
  FALLBACK_ATTEMPT_PREFIX_RE,
  REMEDIATION_TAIL_RE,
  ATTEMPT_REASON_SUFFIX_RE,
  PREFLIGHT_WRAPPER_HEAD_RE,
  PREFLIGHT_TIMEOUT_HEAD_RE,
  WRAPPER_REASON_HEAD_RE,
  PREFLIGHT_WRAPPER_TAIL_RE,
  POST_COMPACTION_HEAD_RE,
  AGENT_FAILED_HEAD_RE,
  AGENT_FAILED_TAIL_RE,
  TURN_ENDED_HEAD_RE,
  SOMETHING_WENT_WRONG_RE,
  LOG_TRUNCATION_MARK_RE,
  PROVIDER_INTERNAL_TEXT_RE,
  PROVIDER_INTERNAL_EXCLUDE_RE,
  PROVIDER_REVIEW_PAUSED_RE,
  SESSION_ARCHIVED_RE,
  COOLDOWN_SENTENCE_RE,
  REAUTHENTICATE_HINT_RE,
  AUTH_401_TOKEN_REVOKED_RE,
  TOKEN_REVOKED_ASSERTED_RE,
  MODEL_LOGIN_EXPIRED_RE,
  BILLING_COPY_RE,
  MODEL_NOT_FOUND_COPY_RE,
  RATE_LIMIT_COPY_RE,
  STATUS_BODY_OPEN_RE,
  SESSION_GONE_REASON_RE,
};

const PERMISSION_403_RE = new RegExp(
  `${STATUS_403_RE.source}[^|\\n]{0,200}?(?:${PERMISSION_403_WORDS_RE.source})`,
  "i",
);
const PROVIDER_BODY_KEYS = "message|type|code|status|reason|detail|error";
const BODY_STRING_FIELD_RE = new RegExp(
  `"(?:${PROVIDER_BODY_KEYS})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
  "gi",
);
const BODY_CUT_FIELD_RE = new RegExp(`"(?:${PROVIDER_BODY_KEYS})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`, "i");

/** `FailoverReason` (packages/gateway-protocol/src/failover-reasons.ts at v2026.9.6). */
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

/** The bridge's `FAILURE_CLASS_PRECEDENCE`, the graver class first (lockstep-tested). */
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

const PRE_EXECUTION_CLASSES: ReadonlySet<string> = new Set([
  "pending_input_dropped",
  "auth_profile_cooldown",
]);

// --- Operator values -----------------------------------------------------------------------

function namesACredential(text: string): boolean {
  return /\b(?:profile|api\s*key)\s+"/i.test(text);
}

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

function unescapeBodyString(value: string): string {
  return value.replace(/\\(.)/g, "$1").replace(/"/g, "");
}

function exposeProviderErrorBodies(raw: string): string {
  let out = "";
  let cursor = 0;
  const open = new RegExp(STATUS_BODY_OPEN_RE.source, STATUS_BODY_OPEN_RE.flags);
  for (let m = open.exec(raw); m !== null; m = open.exec(raw)) {
    const at = m.index + m[0].length - 1;
    if (at < cursor) continue;
    const close = matchingBrace(raw, at);
    const end = close === -1 ? raw.length - 1 : close;
    const body = raw.slice(at, end + 1);
    const words: string[] = [];
    const field = new RegExp(BODY_STRING_FIELD_RE.source, BODY_STRING_FIELD_RE.flags);
    for (let f = field.exec(body); f !== null; f = field.exec(body)) {
      words.push(unescapeBodyString(f[1] ?? ""));
    }
    if (close === -1) {
      const cut = BODY_CUT_FIELD_RE.exec(body);
      if (cut !== null) words.push(unescapeBodyString(cut[1] ?? ""));
    }
    out += `${raw.slice(cursor, at)}${words.join(" ")}`;
    cursor = end + 1;
    open.lastIndex = cursor;
  }
  return cursor === 0 ? raw : out + raw.slice(cursor);
}

function blankQuotedValues(raw: string): string {
  let out = raw;
  if (((out.match(/"/g) ?? []).length % 2) === 1) out = out.replace(/"[^"]*$/, '"…');
  return out.replace(/"[^"]*"/g, '"…"');
}

/** The bridge's `withoutOperatorData`: only what the GATEWAY wrote may decide. */
export function withoutOperatorData(raw: string): string {
  if (!namesACredential(raw)) return blankQuotedValues(exposeProviderErrorBodies(raw));
  const firstQuote = raw.indexOf('"');
  const before = firstQuote === -1 ? raw : raw.slice(0, firstQuote);
  if (/\bauth profile\s+$/i.test(before)) {
    const cooled = raw.replace(
      /(\bauth profile\s+")[\s\S]*?("\s+is temporarily unavailable\s+for\b)[\s\S]*$/i,
      "$1…$2 …",
    );
    if (cooled !== raw) return cooled;
  }
  return firstQuote === -1 ? raw : `${raw.slice(0, firstQuote + 1)}…`;
}

// --- Rules ---------------------------------------------------------------------------------

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

function isSessionInitConflictText(text: string): boolean {
  return (
    SESSION_INIT_CONFLICT_RE.test(text) ||
    EMBEDDED_LOCK_CONFLICT_RE.test(text) ||
    SESSION_CHANGED_STARTING_RE.test(text) ||
    ACTIVE_TURN_CLAIM_RE.test(text) ||
    TRANSCRIPT_REBUILDING_RE.test(text) ||
    SESSION_INITIALIZING_RE.test(withoutOperatorData(text))
  );
}

function isSessionGoneText(text: string): boolean {
  const t = withoutOperatorData(text).toLowerCase();
  if (!t.includes("auto-compaction") && !t.includes("preflight compaction")) return false;
  return SESSION_GONE_REASON_RE.test(t);
}

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

/** The credential class a failure TEXT carries (the bridge's `providerCredentialTextClass`). */
export function providerCredentialTextClass(text: string | null | undefined): string | null {
  if (!text) return null;
  return credentialTextClassOf(withoutOperatorData(text));
}

function credentialClass(reason: "auth" | "auth_permanent", text: string): string {
  if (reason === "auth_permanent") return "provider_permission_denied";
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

function classFromFailoverReason(reason: string, text: string): string | null {
  switch (reason) {
    case "auth":
    case "auth_permanent":
      return credentialClass(reason, text);
    case "billing":
      return "provider_billing";
    case "rate_limit":
      return "rate_limit";
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

function classifySingleFailureText(raw: string): string | null {
  const text = withoutOperatorData(raw);
  if (GATEWAY_STORAGE_UNAVAILABLE_RE.test(text) || GATEWAY_HOST_STORAGE_FULL_RE.test(text)) {
    return "gateway_storage_unavailable";
  }
  if (AGENT_DATABASE_CLOSED_RE.test(text)) return "gateway_agent_db_closed";
  if (GATEWAY_STORAGE_BUSY_RE.test(text)) return "gateway_storage_busy";
  if (PENDING_INPUT_DROPPED_RE.test(text)) return "pending_input_dropped";
  if (isSessionGoneText(text)) return "session_gone";
  const credential = credentialTextClassOf(text);
  if (credential === "provider_auth_revoked" || credential === "provider_permission_denied") {
    return credential;
  }
  if (BILLING_COPY_RE.test(text)) return "provider_billing";
  if (credential !== null) return credential;
  if (COOLDOWN_SENTENCE_RE.test(text)) return "auth_profile_cooldown";
  if (MODEL_NOT_FOUND_COPY_RE.test(text)) return "model_not_found";
  if (isContextOverflowText(text)) return "context_length";
  if (WRITER_CLAIM_REBOUND_RE.test(text) || WRITER_FENCED_COPY_RE.test(text)) {
    return "session_write_conflict";
  }
  if (isSessionInitConflictText(text)) return "session_init_conflict";
  if (SESSION_ARCHIVED_RE.test(withoutOperatorData(text))) return "session_archived";
  if (PROVIDER_REVIEW_PAUSED_RE.test(withoutOperatorData(text))) return "session_paused_review";
  if (RATE_LIMIT_COPY_RE.test(text)) return "rate_limit";
  if (PROVIDER_INTERNAL_TEXT_RE.test(text) && !PROVIDER_INTERNAL_EXCLUDE_RE.test(text)) {
    return "provider_internal";
  }
  return null;
}

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

interface FallbackAttempt {
  text: string;
  reason: string | null;
}

function parseFallbackSummary(
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

function classifyFallbackAttempt(attempt: FallbackAttempt): string | null {
  const prose = classifySingleFailureText(attempt.text);
  if (prose !== null && GATEWAY_OWN_CLASSES.has(prose)) return prose;
  const structured =
    attempt.reason === null
      ? null
      : classFromFailoverReason(attempt.reason, withoutOperatorData(attempt.text));
  return structured ?? prose;
}

function classifyFailureCause(text: string): string | null {
  const summary = parseFallbackSummary(text);
  if (summary === null) return classifySingleFailureText(text);
  const perAttempt = summary.attempts.map(classifyFallbackAttempt);
  const fromHint = summary.authHint ? "provider_auth_failed" : null;
  if (!perAttempt.includes("pending_input_dropped")) {
    return mostGrave([...perAttempt, fromHint]);
  }
  if (perAttempt.every((c) => c !== null && PRE_EXECUTION_CLASSES.has(c))) {
    return "pending_input_dropped";
  }
  return mostGrave([...perAttempt.filter((c) => c !== "pending_input_dropped"), fromHint]);
}

/** Which generic upstream wrapper a failure text came in (the bridge's `GatewayWrapper`). */
export type GatewayWrapper = "preflight_compaction" | "compaction_timeout" | "run_failure";

/** The bridge's `unwrapGatewayFailure`: the outermost generic wrapper and the cause inside. */
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
    const head = pre ?? timedOut;
    if (head !== null) {
      kind = pre !== null ? "preflight_compaction" : "compaction_timeout";
      const rest = text.slice(head[0].length);
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

/** The bridge's `classifyFailureText`, for a STORED failure text. */
export function classifyStoredFailureText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const { wrapper, inner } = unwrapGatewayFailure(raw);
  let cause = inner === null ? null : classifyFailureCause(inner);
  if (isSessionGoneText(raw)) cause = mostGrave([cause, "session_gone"]);
  if (cause !== null) return cause;
  if (wrapper === "compaction_timeout") return "compaction_timeout";
  if (wrapper === "preflight_compaction") return "compaction_failed_no_cause";
  if (wrapper === "run_failure") return "run_failed_no_cause";
  return null;
}
