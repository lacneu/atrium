// VENDORED VERBATIM from openclaw/openclaw @ v2026.10.33 — packages/gateway-protocol/src/schema/sessions-sharing-constants.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
export const SESSION_VISIBILITY_VALUES = ["shared", "read-only", "suggest", "draft"] as const;
