// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.2 — packages/gateway-protocol/src/schema/since.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { TSchema } from "typebox";

/** Adds protocol-vintage metadata without changing the schema's validated value shape. */
export function withSince<T extends TSchema>(train: string, schema: T): T {
  Object.assign(schema, { "x-openclaw-since": train });
  return schema;
}
