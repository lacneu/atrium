// VENDORED VERBATIM from openclaw/openclaw @ v2026.10.33 — packages/gateway-protocol/src/session-communication.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
/** Human-selected policy for initiating messages between sessions. */
export const SESSION_COMMUNICATION_MODES = ["always", "ask", "never"] as const;
export type SessionCommunicationMode = (typeof SESSION_COMMUNICATION_MODES)[number];

/** Omitted directions follow the configured default, not a saved copy of it. */
export type SessionCommunicationPolicy = {
  send?: SessionCommunicationMode;
  receive?: SessionCommunicationMode;
};

export type EffectiveSessionCommunicationPolicy = Required<SessionCommunicationPolicy>;
