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
  | "INVALID_REQUEST" // gateway rejected the request shape
  | "UPSTREAM_ERROR"; // anything else (fallback)

/**
 * Map a thrown gateway error to a stable, non-PHI code. Order matters: more
 * specific patterns are tested before the generic INVALID_REQUEST/fallback (the
 * canonical "Agent … no longer exists" arrives wrapped as
 * "INVALID_REQUEST: Agent \"main\" no longer exists in configuration", so the
 * agent rule must win over the invalid-request rule).
 */
export function classifyGatewayError(err: unknown): DispatchErrorCode {
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
  if (/invalid_request|invalid request|bad request|malformed/.test(msg)) {
    return "INVALID_REQUEST";
  }
  return "UPSTREAM_ERROR";
}
