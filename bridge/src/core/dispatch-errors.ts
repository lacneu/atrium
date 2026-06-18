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
// Pure function over the thrown error's message -> unit-tested offline.

export type DispatchErrorCode =
  | "AGENT_NOT_FOUND" // configured agentId no longer exists on the gateway
  | "AUTH_TOKEN_MISMATCH" // operator token <-> device identity / pairing rejected
  | "DEVICE_SIGNING_FAILED" // device private key cannot sign (bad PEM / OpenSSL)
  | "SESSION_SCOPE_DENIED" // pairing scope insufficient (operator.pairing vs admin)
  | "GATEWAY_TIMEOUT" // request timed out waiting on the gateway
  | "GATEWAY_DISCONNECTED" // socket closed / unreachable mid-request
  | "ATTACHMENT_TOO_LARGE" // gateway refused an attachment over a size/staging cap
  | "ATTACHMENT_REJECTED" // gateway could not parse/stage the attachment (e.g. its base64 validator overflowed)
  | "INVALID_REQUEST" // gateway rejected the request shape
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
 * The taxonomy lives HERE (the bridge owns send classification). `/health` then
 * reports a per-target `state` the UI renders blindly, so Convex + the UI stay
 * taxonomy-agnostic.
 */
export type FaultDomain = "bridge" | "downstream";

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
]);

/** Fault domain of a classified dispatch error (pure → unit-tested offline). */
export function faultDomain(code: DispatchErrorCode): FaultDomain {
  return DOWNSTREAM_REJECTION_CODES.has(code) ? "downstream" : "bridge";
}

/**
 * Map a thrown gateway error to a stable, non-PHI code. Order matters: more
 * specific patterns are tested before the generic INVALID_REQUEST/fallback (the
 * canonical "Agent … no longer exists" arrives wrapped as
 * "INVALID_REQUEST: Agent \"main\" no longer exists in configuration", so the
 * agent rule must win over the invalid-request rule).
 */
export function classifyGatewayError(
  err: unknown,
  opts?: { hasAttachments?: boolean },
): DispatchErrorCode {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();

  if (/no longer exists|agent[^.]*not found|unknown agent|no such agent/.test(msg)) {
    return "AGENT_NOT_FOUND";
  }
  if (/auth_token_mismatch|token mismatch|not paired|unauthor|forbidden/.test(msg)) {
    return "AUTH_TOKEN_MISMATCH";
  }
  if (/decoder|1e08010c|sign(ing|ature)? failed|device signing/.test(msg)) {
    return "DEVICE_SIGNING_FAILED";
  }
  if (/\bscope\b|operator\.(admin|pairing)|insufficient permission|not permitted/.test(msg)) {
    return "SESSION_SCOPE_DENIED";
  }
  if (/timeout|timed out|etimedout/.test(msg)) {
    return "GATEWAY_TIMEOUT";
  }
  if (/closed|disconnect|econnrefused|socket hang up|not connected|connection reset/.test(msg)) {
    return "GATEWAY_DISCONNECTED";
  }
  // Attachment-specific failures (the gateway processes attachments in a dedicated
  // "attachment parse/stage" phase). A size/staging cap, or a parse blow-up such as
  // the gateway's base64 validator overflowing on a multi-MB attachment ("Maximum
  // call stack size exceeded", surfaced as INVALID_REQUEST), is an ATTACHMENT
  // problem, not a generic bad request — say so, so the user knows it's the file.
  if (
    // Explicitly attachment-named caps -> always an attachment problem.
    /exceed[^.]*staging limit|attachment[^.]*exceeds size limit|attachment[^.]*too large/.test(msg) ||
    // A GENERIC size cap ("… exceeds the maximum …") is the file ONLY when the turn
    // actually carried one — otherwise a text-only "prompt exceeds the maximum"
    // would wrongly tell the user to shrink a non-existent attachment.
    (opts?.hasAttachments === true && /exceeds the maximum|too large/.test(msg))
  ) {
    return "ATTACHMENT_TOO_LARGE";
  }
  if (
    /attachment parse\/stage|invalid base64|unsupported[^.]*attachment|attachment[^.]*content/.test(msg) ||
    (opts?.hasAttachments === true &&
      /maximum call stack|invalid_request|invalid request/.test(msg))
  ) {
    return "ATTACHMENT_REJECTED";
  }
  if (/invalid_request|invalid request|bad request|malformed/.test(msg)) {
    return "INVALID_REQUEST";
  }
  return "UPSTREAM_ERROR";
}
