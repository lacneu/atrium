// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.1 — packages/gateway-protocol/src/schema/closed-object.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type, type TProperties } from "typebox";

const identityKey = "~openclawClosedObjectIdentity";

export function closedObject<Properties extends TProperties>(properties: Properties) {
  const schema = Type.Object(properties, { additionalProperties: false });
  // TypeBox preserves hidden string-keyed properties when cloning optional schemas.
  // A symbol value keeps nominal identity out of JSON and distinguishes equal shapes.
  Object.defineProperty(schema, identityKey, { value: Symbol("closedObject") });
  return schema;
}
