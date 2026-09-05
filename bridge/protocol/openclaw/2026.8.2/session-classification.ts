// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.2 — packages/gateway-protocol/src/schema/session-classification.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Stable, non-sensitive classification for a session row.
 *
 * The taxonomy remains open so newer Gateways can add classifications without
 * making otherwise compatible older clients reject the row.
 */
export const SessionClassificationSchema = NonEmptyString;

/** Non-sensitive peer category derived from the session route, when known. */
export const SessionPeerKindSchema = NonEmptyString;

export type SessionClassification = Static<typeof SessionClassificationSchema>;
export type SessionPeerKind = Static<typeof SessionPeerKindSchema>;
