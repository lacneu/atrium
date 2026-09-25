// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.6 — packages/gateway-protocol/src/chat-work-context.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
/** Bounded, untrusted send-time reference data; never routing or authorization. */
export const CHAT_WORK_CONTEXT_LIMITS = {
  page: 64,
  title: 96,
  sessionKey: 192,
  sessionId: 64,
  agentId: 64,
  workspace: 224,
  file: 224,
  selection: 640,
} as const;

export type ChatWorkContext = { page: string } & Partial<
  Record<Exclude<keyof typeof CHAT_WORK_CONTEXT_LIMITS, "page">, string>
>;
