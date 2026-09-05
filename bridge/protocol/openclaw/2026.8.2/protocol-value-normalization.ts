// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.2 — packages/gateway-protocol/src/protocol-value-normalization.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (Only change vs upstream: @openclaw/<pkg>/<module> workspace specifiers collapsed to ./<module>.js.)
export {
  asNullableRecord as asProtocolRecord,
  isRecord as isProtocolRecord,
} from "./record-coerce.js";

/** Checks string presence without changing wire-significant whitespace. */
export function isNonEmptyProtocolString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Trims an optional untrusted string and rejects empty results. */
export function normalizeOptionalProtocolString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
