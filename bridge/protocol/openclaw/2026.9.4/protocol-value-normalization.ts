// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.4 — packages/gateway-protocol/src/protocol-value-normalization.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (Only change vs upstream: @openclaw/<pkg>/<module> workspace specifiers collapsed to ./<module>.js.)
export {
  asNullableRecord as asProtocolRecord,
  isRecord as isProtocolRecord,
} from "./record-coerce.js";
export { normalizeOptionalString as normalizeOptionalProtocolString } from "./string-coerce.js";

/** Checks string presence without changing wire-significant whitespace. */
export function isNonEmptyProtocolString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
