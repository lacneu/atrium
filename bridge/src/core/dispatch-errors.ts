// Curated, non-PHI taxonomy of OpenClaw send failures.
//
// WHY: when a `chat.send` is refused, the gateway's raw Error message is the only
// thing that explains WHY (e.g. `Agent "main" no longer exists in configuration`).
// That raw text is logged by the bridge, but it must NOT be shipped to Convex —
// the platform's trace discipline is "metadata only, never message text" and a
// raw gateway string could in principle carry content. So we classify the error
// into a STABLE CODE here and ship only the code. The code is what the admin UI
// groups on (Sentry-style fingerprint) and maps to a human hint.
//
// Pure function over the thrown error's message AND the messages of the causes behind
// it (`errorChainText`) -> unit-tested offline.

import { ContextBlockedError } from "./presend-guard.js";
import {
  INBOUND_CLEANUP_FAILED,
  INBOUND_NAME_TOO_LONG,
  INBOUND_COLLISION,
  INBOUND_FETCH_FAILED,
  INBOUND_PATH_REFUSED,
  INBOUND_STAGE_FAILED,
  INBOUND_TOO_LARGE,
  InboundMediaRefusal,
} from "./inbound-media.js";
import { HermesDashboardAbsentError } from "../providers/hermes/files-fetcher.js";
import { TalkCallActiveError } from "../session.js";
import {
  isSessionArchivedText,
  isSessionInitConflictText,
  withoutOperatorData,
} from "./failure-classifier.js";

export type DispatchErrorCode =
  | "AGENT_NOT_FOUND" // configured agentId no longer exists on the gateway
  | "AUTH_TOKEN_MISMATCH" // operator token <-> device identity / pairing rejected
  | "DEVICE_SIGNING_FAILED" // device private key cannot sign (bad PEM / OpenSSL)
  | "SESSION_SCOPE_DENIED" // pairing scope insufficient (operator.pairing vs admin)
  | "GATEWAY_TIMEOUT" // request timed out waiting on the gateway
  | "GATEWAY_DISCONNECTED" // socket closed / unreachable mid-request
  | "GATEWAY_RESTARTING" // the gateway ANNOUNCED its restart, then closed (event:"shutdown")
  | "CONNECTION_SATURATED" // closed with 1008 "slow consumer": frames were being dropped
  | "ATTACHMENT_TOO_LARGE" // gateway refused an attachment over a size/staging cap
  | "ATTACHMENT_REJECTED" // gateway could not parse/stage the attachment (e.g. its base64 validator overflowed)
  | "INVALID_REQUEST" // gateway rejected the request shape
  // The session changed under a run that was STARTING — a transient OCC the
  // gateway itself asks us to retry. Lower-case like `context_length_presend`
  // because it is a SHARED code: Convex's RETRYABLE_KINDS keys the bounded
  // auto-retry on this exact string, so minting a bridge-only spelling would
  // classify it correctly and still let the turn die.
  | "session_init_conflict"
  | "session_write_conflict"
  // 2026.9.2 ties a `chat.send` idempotency key to the CONTENT it was first used with
  // (a hash of message + mentions): the same key re-sent with different input is
  // refused — `INVALID_REQUEST` with `details.reason: "chat-request-conflict"` —
  // while the ORIGINAL run goes on. Lower-case like the conflicts above because
  // Convex reads it, and DISTINCT from INVALID_REQUEST because it states a
  // different fact: nothing is malformed, the key was reused for other input.
  // Deliberately NOT retryable: a retry under a fresh key would start a second
  // turn beside the one still running.
  | "chat_request_conflict"
  // The gateway refuses NEW WORK because it ARCHIVED the session. Upstream
  // auto-archives an idle dashboard session after 7 days and every Atrium
  // conversation is one, so this is a conversation the person is reopening — not a
  // broken request. The bridge restores the session before every send, reset and
  // voice mint (core/session-archive.ts); this class exists for the refusal that
  // gets past that — a restore that failed, or the janitor archiving between our
  // patch and the send.
  //
  // Lower-case like the other codes Convex reads, and RETRYABLE there: upstream
  // refuses at ADMISSION, before the model generates anything, so the retry's own
  // pre-send restore is a real second chance that repeats no work and bills nothing.
  | "session_archived"
  // A Hermes surface that is NOT DEPLOYED on this instance, as opposed to one that failed.
  // The managed-files API lives only in the dashboard web server, which upstream starts
  // when HERMES_DASHBOARD is set; `hermes serve` alone answers every turn and 404s every
  // agent-files call. A DISTINCT code because it states a different fact — nothing is
  // broken, and retrying will never help.
  | "DASHBOARD_NOT_DEPLOYED"
  // The bridge's OWN pre-send guard withheld the send: the session was measured not
  // to fit and the mandatory compaction did not shrink it. A DISTINCT code from the
  // gateway's `context_length`, because it states a different fact — nothing ran and
  // nothing was billed. It gets the same two wired actions (see ContextBlockedError).
  | "context_length_presend"
  // THE BRIDGE ITSELF refused to stage an inbound file onto this instance's shared
  // media volume. THE TURN WAS NEVER SENT — the staging runs after the session is
  // acquired and patched (so the gateway may well have been spoken to) but BEFORE
  // `chat.send`, which is the precise, defensible claim (codex: "the gateway was
  // never called" was an overstatement). No gateway code above can describe a
  // refusal we took ourselves, and the catch-all actively lied: it is
  // bridge-domain, so one attachment declared a healthy link dead (live prod
  // 2026-09-17, both instances, every attachment send).
  //
  // THREE codes, not one, because the operator acts differently on each: a path
  // outside the allowed root is a CONFIGURATION fact, a failed write is a HOST
  // fact (permissions, space, mount), and an unconfirmed rollback additionally
  // means files may be left behind. The reader's sentence is nearly the same for
  // all three; the per-cause anomaly plane is what has to tell them apart.
  // Lower-case like the other codes Convex reads: it keys the retry policy on
  // these exact strings, and none of them may ever be auto-retried — a volume
  // does not fix itself between two attempts.
  | "attachment_path_refused"
  // The composed on-disk name does not fit a filesystem leaf: the user's filename
  // is too long. The ONLY member of this family the reader can act on.
  | "attachment_name_too_long"
  | "attachment_staging_failed"
  | "attachment_cleanup_unconfirmed"
  // THE BRIDGE ITSELF refused to re-key the chat's socket, because a gateway-owned
  // voice call is live on it. ONE live socket per chat is this registry's invariant,
  // and the GATEWAY binds a GPT Live call to the socket that minted it — so re-keying
  // ends the call. Until 2026-09-19 the registry logged that and did it anyway; the
  // decision is now that a call in progress is not something a typed turn may cut.
  // THE TURN WAS NEVER SENT: `acquire` throws before any gateway RPC.
  //
  // A DISTINCT code because Convex acts on it differently from every other refusal:
  // the turn is not failed, it is put BACK in the queue and dispatched when the call
  // ends. Lower-case like the other codes Convex reads.
  | "talk_call_active"
  | "UPSTREAM_ERROR"; // anything else (fallback)

/**
 * Fault domain of a classified dispatch failure — consumed ONLY by the bridge
 * HEALTH view, to decide whether a failure means "the BRIDGE is unhealthy" or
 * "the bridge did its job and the gateway/agent/payload rejected this request".
 *
 *  - "bridge": the bridge could not REACH or AUTHENTICATE to its gateway — its own
 *    link or credentials are the fault (socket loss, timeout, token/signing/scope).
 *    These degrade bridge health (the Settings "Bridge" tab goes red).
 *  - "downstream": the bridge reached the gateway, which RECEIVED the request and
 *    refused it (a missing agent, an unparseable/oversized attachment, a request
 *    shape the gateway rejected, or any other upstream/agent error). The bridge
 *    worked, so this must NOT make the bridge look down. It is still surfaced — per
 *    chat by the failDispatch bubble, and in detail/alerting by Traces + Anomalies —
 *    but in the HEALTH view it is a neutral "rejected downstream" note, never a
 *    bridge error. The health module's job is bridge health; the detail/alert job
 *    already belongs to the other two modules.
 *
 *  - "local": the bridge refused the request ITSELF — the turn was never sent (an
 *    inbound file it could not stage). It proves NOTHING about connectivity in
 *    either direction, so the health view leaves the target's state exactly as it
 *    found it. Two values forced a lie in both directions: as "bridge" it marked a
 *    healthy link dead (the defect this class was minted for), and as "downstream"
 *    it would have claimed the gateway answered — clearing a real, unrelated
 *    network incident and reporting the instance green (codex).
 *
 * The taxonomy lives HERE (the bridge owns send classification). `/health` then
 * reports a per-target `state` the UI renders blindly, so Convex + the UI stay
 * taxonomy-agnostic.
 */
export type FaultDomain = "bridge" | "downstream" | "local";

/** Codes the BRIDGE raises about ITSELF: the turn is never sent. (Session RPCs
 *  may already have gone out — only `chat.send` is what never happens.) */
const LOCAL_REFUSAL_CODES: ReadonlySet<DispatchErrorCode> = new Set([
  "attachment_path_refused",
  "attachment_name_too_long",
  "attachment_staging_failed",
  "attachment_cleanup_unconfirmed",
  // We refused to cut a live call. The link and the credentials are fine — painting
  // the bridge red for honouring its own invariant is the exact lie this class exists
  // to prevent.
  "talk_call_active",
]);

// Codes where the gateway DEMONSTRABLY responded and refused this specific request
// (a missing agent, an oversized/unparseable attachment, a refused request shape):
// the failure is downstream, not a bridge-health problem. Anything NOT listed is
// treated as bridge-domain — FAIL-CLOSED. This deliberately EXCLUDES the
// `UPSTREAM_ERROR` catch-all: classifyGatewayError returns it for any UNRECOGNIZED
// throw, including an unexpected registry.acquire/performSend failure where we
// CANNOT prove the gateway ever answered. An unknown failure must stay VISIBLE as a
// bridge error, never be silently painted green as a benign downstream reject.
const DOWNSTREAM_REJECTION_CODES: ReadonlySet<DispatchErrorCode> = new Set([
  "AGENT_NOT_FOUND",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_REJECTED",
  "INVALID_REQUEST",
  // The gateway RECEIVED the send and refused the key for other input — its link
  // and credentials worked; the bridge is not the fault.
  "chat_request_conflict",
  // Not literally "the gateway refused it" — the BRIDGE refused it, on a figure the
  // gateway reported. Listed here because this set's job is bridge HEALTH: the link
  // and the credentials worked perfectly, and a full session must never paint the
  // bridge red. The failure is still fully surfaced (card, trace, anomaly).
  "context_length_presend",
  // The gateway RECEIVED the send and refused it on a session that moved: its
  // link and credentials worked, so this must not paint the bridge red. It is
  // surfaced as every rejection is — card, trace, anomaly — and retried.
  "session_init_conflict",
  // The gateway RECEIVED the send and refused it on a session it had archived: its
  // link and credentials worked. A seven-day-old conversation must never paint the
  // bridge red.
  "session_archived",
]);

/**
 * Codes meaning "the socket went away mid-request", i.e. the write may have
 * APPLIED and only its response was lost. Callers that can READ BACK the effect
 * (config-defaults confirms the patch after the restart it triggered) must treat
 * them alike: naming the end must not silently narrow that recovery to the
 * unnamed case, which is exactly the one a config-triggered restart is NOT.
 */
export const LOST_RESPONSE_CODES: ReadonlySet<DispatchErrorCode> = new Set([
  "GATEWAY_DISCONNECTED",
  "GATEWAY_RESTARTING",
  "CONNECTION_SATURATED",
]);

/**
 * OUR OWN inbound-media refusals → their dispatch code, one for one.
 *
 * Only the BATCH failures actually reach the classifier: a size, collision or
 * fetch failure drops that one file and the send goes on
 * (`RECOVERABLE_DROP_FAILURES`). The three are mapped anyway — the day one is
 * thrown, "your file is too large" must not regress into an unrecognised
 * upstream error, which is exactly the regression this table exists to end. An
 * inbound code with no row here falls to the staging class rather than to the
 * catch-all: whatever it turns out to be, WE refused it and the turn never went.
 */
const INBOUND_REFUSAL_CODES: Readonly<Record<string, DispatchErrorCode>> = {
  [INBOUND_PATH_REFUSED]: "attachment_path_refused",
  [INBOUND_NAME_TOO_LONG]: "attachment_name_too_long",
  [INBOUND_STAGE_FAILED]: "attachment_staging_failed",
  [INBOUND_CLEANUP_FAILED]: "attachment_cleanup_unconfirmed",
  [INBOUND_TOO_LARGE]: "ATTACHMENT_TOO_LARGE",
  [INBOUND_COLLISION]: "attachment_staging_failed",
  [INBOUND_FETCH_FAILED]: "attachment_staging_failed",
};

/** Fault domain of a classified dispatch error (pure → unit-tested offline). */
export function faultDomain(code: DispatchErrorCode): FaultDomain {
  if (LOCAL_REFUSAL_CODES.has(code)) return "local";
  return DOWNSTREAM_REJECTION_CODES.has(code) ? "downstream" : "bridge";
}

/**
 * Map a thrown gateway error to a stable, non-PHI code. Order matters: more
 * specific patterns are tested before the generic INVALID_REQUEST/fallback (the
 * canonical "Agent … no longer exists" arrives wrapped as
 * "INVALID_REQUEST: Agent \"main\" no longer exists in configuration", so the
 * agent rule must win over the invalid-request rule).
 */
/** An error's own message AND the messages of the causes behind it.
 *
 *  Node's fetch reports a network cut as `TypeError: fetch failed` and puts what
 *  actually happened — often an errno such as `read ECONNRESET` or
 *  `getaddrinfo ENOTFOUND`, but sometimes a TLS or URL failure — in `cause`. The
 *  wrapper says nothing on its own, which is why it is not a pattern below. Reading
 *  only `message`
 *  therefore saw a sentence no rule below recognises, and the send fell to the
 *  `UPSTREAM_ERROR` catch-all: an operator was told "something upstream" for a socket
 *  that was reset, with nothing to act on. That is the shape of the open production
 *  anomaly this fixes.
 *
 *  Bounded depth, because a cause chain can be circular. */
export function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.join(" <- ");
}

export function classifyGatewayError(
  err: unknown,
  opts?: { hasAttachments?: boolean },
): DispatchErrorCode {
  // The bridge's own withheld send, recognised by TYPE before any text rule: a
  // decision we made cannot be left to depend on how we phrased it.
  if (err instanceof ContextBlockedError) return "context_length_presend";
  // Same rule, same reason: a surface the fetcher PROVED absent is recognised by type, so
  // the class survives any rewording of the message.
  if (err instanceof HermesDashboardAbsentError) return "DASHBOARD_NOT_DEPLOYED";
  // Our own refusal to cut a live voice call, by TYPE for the same reason.
  if (err instanceof TalkCallActiveError) return "talk_call_active";
  // OUR OWN inbound-media refusal, by TYPE for the same reason. Only the BATCH
  // failures reach here — a size/collision/fetch failure drops that one file and
  // the send continues (`RECOVERABLE_DROP_FAILURES`) — but the size class is
  // mapped anyway: the day it is thrown, "your file is too large" must not
  // regress into an unrecognised upstream error.
  if (err instanceof InboundMediaRefusal) {
    return INBOUND_REFUSAL_CODES[err.code] ?? "attachment_staging_failed";
  }
  // Through the SAME normalization the frame classifier uses, not a special case of
  // it: an early return for credential sentences left every OTHER quoted value free
  // here, so `Session "agent:timeout:…" changed while starting work` became
  // GATEWAY_TIMEOUT before it could reach `session_init_conflict` — losing the bounded
  // retry and blaming the bridge (codex).
  const msg = withoutOperatorData(errorChainText(err)).toLowerCase();

  if (
    /no longer exists|agent[^.]*not found|unknown agent|no such agent/.test(msg)
  ) {
    return "AGENT_NOT_FOUND";
  }
  if (
    /auth_token_mismatch|token mismatch|not paired|unauthor|forbidden/.test(msg)
  ) {
    // `[unauthorized]` (the client's own classification of a `1008` close) matches
    // `unauthor` above, so a handshake refusal lands here rather than on the
    // generic disconnect rule — no extra pattern needed.
    return "AUTH_TOKEN_MISMATCH";
  }
  if (/decoder|1e08010c|sign(ing|ature)? failed|device signing/.test(msg)) {
    return "DEVICE_SIGNING_FAILED";
  }
  if (
    /\bscope\b|operator\.(admin|pairing)|insufficient permission|not permitted/.test(
      msg,
    )
  ) {
    return "SESSION_SCOPE_DENIED";
  }
  if (/timeout|timed out|etimedout/.test(msg)) {
    return "GATEWAY_TIMEOUT";
  }
  // NAMED connection ends, tested BEFORE the generic disconnect rule (whose
  // pattern they also match): the bracketed marker comes from the client's own
  // classification of the close (`connection-end.ts`), so a send interrupted by an
  // announced restart or by saturation keeps its name instead of collapsing into
  // "socket closed".
  if (/\[gateway_restarting\]/.test(msg)) {
    return "GATEWAY_RESTARTING";
  }
  if (/\[slow_consumer\]|\[inbound_overflow\]/.test(msg)) {
    // Both directions of the same fact: one end could not keep up and the link was
    // cut. `slow_consumer` is the gateway hanging up on us; `inbound_overflow` is us
    // closing rather than grow without bound. The reader's message is identical, so
    // a send interrupted by either must not report a generic upstream error.
    return "CONNECTION_SATURATED";
  }
  if (
    // The ERRNO spellings beside the prose ones. `connection reset` was listed but
    // `econnreset` — what Node actually emits — was not, so a reset socket was
    // reported as a generic upstream error (the open production anomaly).
    //
    // KNOWN GAP, recorded rather than implied: this class sits in LOST_RESPONSE_CODES,
    // so it says a write MAY have been applied — and some members cannot support that.
    // A refused connection or a DNS failure happens before anything is written; a
    // restart announced during connect, or a Hermes socket closed before
    // `gateway.ready`, likewise (codex). Text cannot carry the PHASE, and a first
    // attempt to split them by errno was WRONG in the dangerous direction: after the
    // gateway ACKs, `startAssistant` fetches Convex, so a Convex outage surfaces the
    // very same `ECONNREFUSED` — and calling it "nothing was sent" would invite
    // re-running a turn the agent may already be executing. Being pessimistic about
    // delivery is the safe error; closing the gap means threading the phase from the
    // call sites, which is its own change.
    //
    // `fetch failed`, `und_err` and `terminated` are NOT here, deliberately. Node emits
    // the first for an unknown scheme, a bad port or a TLS failure as readily as for a
    // cut socket, and this class sits in LOST_RESPONSE_CODES — it asserts the write may
    // have been applied (codex). What proves a cut is the ERRNO, which `errorChainText`
    // brings up from the cause; a bare wrapper stays the catch-all, which is the honest
    // answer for a failure we cannot name.
    /closed|disconnect|econnrefused|econnreset|enotfound|eai_again|epipe|socket hang ?up|not connected|connection reset/.test(
      msg,
    )
  ) {
    return "GATEWAY_DISCONNECTED";
  }
  // Attachment-specific failures (the gateway processes attachments in a dedicated
  // "attachment parse/stage" phase). A size/staging cap, or a parse blow-up such as
  // the gateway's base64 validator overflowing on a multi-MB attachment ("Maximum
  // call stack size exceeded", surfaced as INVALID_REQUEST), is an ATTACHMENT
  // problem, not a generic bad request — say so, so the user knows it's the file.
  if (
    // Explicitly attachment-named caps -> always an attachment problem.
    /exceed[^.]*staging limit|attachment[^.]*exceeds size limit|attachment[^.]*too large/.test(
      msg,
    ) ||
    // A GENERIC size cap ("… exceeds the maximum …") is the file ONLY when the turn
    // actually carried one — otherwise a text-only "prompt exceeds the maximum"
    // would wrongly tell the user to shrink a non-existent attachment.
    (opts?.hasAttachments === true && /exceeds the maximum|too large/.test(msg))
  ) {
    return "ATTACHMENT_TOO_LARGE";
  }
  // EXPLICIT attachment markers: the gateway names the file as the problem.
  // These win over everything below, including the session conflict — a message
  // carrying both states a real staging failure, and retrying it would loop on
  // a payload that can never be staged.
  if (
    /attachment parse\/stage|invalid base64|unsupported[^.]*attachment|attachment[^.]*content/.test(
      msg,
    )
  ) {
    return "ATTACHMENT_REJECTED";
  }
  // TRANSIENT SESSION CONFLICT — after the EXPLICIT attachment markers, before
  // both generic buckets.
  // The gateway wraps it in an `INVALID_REQUEST:` prefix, so the generic test
  // below matches it and the send died as a shape error — a dead end, with the
  // user's message lost. It is not a shape problem: the session moved under a
  // starting run, and the gateway itself says "Retry." Classified here as the
  // session conflict it is, it rides the existing bounded auto-retry.
  //
  // Placed here on purpose, between the two: the attachment rule's GENERIC arm
  // (`hasAttachments && /invalid request/`) used to swallow this conflict and
  // call it ATTACHMENT_REJECTED — terminal, and blaming a file that had nothing
  // to do with it. But an EXPLICIT attachment marker in the same message
  // (`invalid base64`, `attachment parse/stage`) states a real file failure and
  // must still win: retrying it would loop on a payload that cannot be staged.
  // All THREE 2026.8.1+ coordination forms, not just the one production happened to
  // show us: an exception thrown by `chat.send` lands here rather than on the frame
  // classifier, and the two forms missing from this door became INVALID_REQUEST — an
  // error upstream itself declares transient, made terminal, with no bounded retry
  // (codex). One rule, and it had two doors again.
  if (isSessionInitConflictText(msg)) {
    return "session_init_conflict";
  }
  // ARCHIVED SESSION — beside the conflict above and for the same reason: it
  // arrives behind the same `INVALID_REQUEST:` prefix, so the generic bucket would
  // swallow it and call a reopened conversation a malformed request. Placed AFTER
  // the explicit attachment markers so a genuine staging failure still wins, and
  // BEFORE the generic attachment fallback: a file on the turn has nothing to do
  // with the session being archived, and blaming it would make this terminal.
  if (isSessionArchivedText(msg)) {
    return "session_archived";
  }
  // IDEMPOTENCY-KEY CONFLICT (2026.9.2): the key was already used for different
  // input. Arrives behind the same `INVALID_REQUEST:` prefix as the conflict
  // above, so it must be recognised BEFORE the generic bucket; the wording is the
  // gateway's own (chat-send-pre-admission.ts). Not a shape error, not retryable.
  if (/already used for different input/i.test(msg)) {
    return "chat_request_conflict";
  }
  // GENERIC attachment fallback: no marker named the file, we only know the
  // send carried one and the gateway said "invalid request". It sits AFTER the
  // session conflict on purpose — that conflict has nothing to do with the
  // file, and blaming the attachment made it terminal (live prod 2026-08-04).
  if (
    opts?.hasAttachments === true &&
    /maximum call stack|invalid_request|invalid request/.test(msg)
  ) {
    return "ATTACHMENT_REJECTED";
  }
  if (/invalid_request|invalid request|bad request|malformed/.test(msg)) {
    return "INVALID_REQUEST";
  }
  return "UPSTREAM_ERROR";
}
