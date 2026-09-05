// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.2 — packages/gateway-protocol/src/schema/failover-reason.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (Only change vs upstream: ../ imports rebased to ./ for the flat layout.)
import { Type, type TLiteral } from "typebox";
import { FAILOVER_REASONS } from "./failover-reasons.js";

type LiteralSchemas<Values extends readonly string[]> = {
  -readonly [Index in keyof Values]: Values[Index] extends string ? TLiteral<Values[Index]> : never;
};

// Array.map widens tuples, so retain the one-to-one literal schema types after
// deriving the runtime anyOf list from the canonical frozen vocabulary.
const failoverReasonLiteralSchemas = FAILOVER_REASONS.map((reason) =>
  Type.Literal(reason),
) as LiteralSchemas<typeof FAILOVER_REASONS>;

/** Closed failure reasons shared by model fallback producers and protocol consumers. */
export const FailoverReasonSchema = Type.Union(failoverReasonLiteralSchemas);
