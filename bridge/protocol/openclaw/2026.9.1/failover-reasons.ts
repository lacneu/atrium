// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.1 — packages/gateway-protocol/src/failover-reasons.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
export const FAILOVER_REASONS = [
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
] as const;

export type FailoverReason = (typeof FAILOVER_REASONS)[number];
