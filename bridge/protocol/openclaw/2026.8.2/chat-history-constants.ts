// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.2 — packages/gateway-protocol/src/schema/chat-history-constants.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
/** Largest history page accepted by the Gateway wire contract. */
export const CHAT_HISTORY_MAX_ENTRIES = 1000;
/** Display-only custody records; never transcript branch entry IDs. */
export const CHAT_PENDING_INPUT_MESSAGE_PREFIX = "pending:";
/** Browser send reconciliation stays bounded independently of transcript length. */
export const CHAT_INPUT_RECEIPT_MAX_RUN_IDS = 50;
export const CHAT_INPUT_RUN_ID_MAX_CHARS = 256;
