// VENDORED VERBATIM from openclaw/openclaw @ v2026.7.2-beta.5 — packages/gateway-protocol/src/schema/closed-object.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (Only change vs upstream: ../ imports rebased to ./ for the flat layout.)
import { Type, type TProperties } from "typebox";

export function closedObject<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}
