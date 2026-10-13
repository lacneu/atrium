// What a dispatch trace may keep of a refusal the gateway ANSWERED: its error code and the
// NAMES of its `details` keys — each from a CLOSED vocabulary, never "anything that looks
// like an identifier" (codex: `SYNTHETIC_SECRET_VALUE` passed a syntax filter and was
// persisted). The bridge applies the same lists (bridge/src/core/dispatch-errors.ts
// `answeredRefusalShape`); Convex applies them AGAIN, independently, because this is network
// input bound for a trace store administrators read and the bridge may be older, newer or
// wrong. The lists are the bridge's, held equal by convex/lib/gatewayAnswer.test.ts; the
// bridge's are confronted with upstream (bridge/test/answered-refusal-vocabulary.test.ts).

/** Upstream `ErrorCodes` (packages/gateway-protocol/src/gateway-error-details.ts, v2026.9.9). */
export const GATEWAY_ANSWER_CODES: readonly string[] = [
  "AGENT_TIMEOUT",
  "APPROVAL_NOT_FOUND",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "NOT_LINKED",
  "NOT_PAIRED",
  "UNAVAILABLE",
];

/** The `details` field names upstream documents for its refusals (same sources). */
export const GATEWAY_ANSWER_DETAIL_KEYS: readonly string[] = [
  "agentId",
  "cause",
  "code",
  "currentCount",
  "currentRevisionHash",
  "cwd",
  "embeddedOwnerId",
  "expectedRevisionHash",
  "idempotencyKey",
  "jobId",
  "limit",
  "missingScope",
  "paths",
  "reason",
  "recoveryAction",
  "repairHint",
  "requiredScopes",
  "sessionId",
  "source",
];

/** The fixed value of a code outside the vocabulary — never the string received. */
export const OTHER_GATEWAY_ANSWER_CODE = "other";
/** Bound on `unknownDetailKeyCount` ("this many or more"). */
export const MAX_UNKNOWN_DETAIL_KEYS = 16;

export interface GatewayAnswerShape {
  code?: string;
  detailKeys?: string[];
  unknownDetailKeyCount?: number;
}

const CODES: ReadonlySet<string> = new Set(GATEWAY_ANSWER_CODES);
const KEYS: ReadonlySet<string> = new Set(GATEWAY_ANSWER_DETAIL_KEYS);

/** The bridge's `error.answered`, re-validated: a code outside the vocabulary becomes `other`,
 *  a key outside it is never kept, only counted (with the bridge's own count, bounded).
 *  Undefined when nothing usable is left. */
export function gatewayAnswerShape(raw: unknown): GatewayAnswerShape | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { gatewayCode, detailKeys, unknownDetailKeyCount } = raw as {
    gatewayCode?: unknown;
    detailKeys?: unknown;
    unknownDetailKeyCount?: unknown;
  };
  const shape: GatewayAnswerShape = {};
  if (typeof gatewayCode === "string") {
    shape.code = CODES.has(gatewayCode) ? gatewayCode : OTHER_GATEWAY_ANSWER_CODE;
  }
  let unknown =
    typeof unknownDetailKeyCount === "number" &&
    Number.isInteger(unknownDetailKeyCount) &&
    unknownDetailKeyCount > 0
      ? unknownDetailKeyCount
      : 0;
  if (Array.isArray(detailKeys)) {
    const known = [
      ...new Set(detailKeys.filter((k): k is string => typeof k === "string" && KEYS.has(k))),
    ].sort();
    unknown += detailKeys.length - detailKeys.filter((k) => typeof k === "string" && KEYS.has(k)).length;
    shape.detailKeys = known;
  }
  if (unknown > 0) shape.unknownDetailKeyCount = Math.min(unknown, MAX_UNKNOWN_DETAIL_KEYS);
  return Object.keys(shape).length === 0 ? undefined : shape;
}
