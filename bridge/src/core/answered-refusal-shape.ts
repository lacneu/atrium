// The structural reading of a refusal the gateway ANSWERED, and the closed-vocabulary SHAPE
// a trace or a log line may carry of it. A module with no runtime dependency beyond the
// vocabulary, so the log helper (core/log-safe-error.ts) — imported almost everywhere — does
// not drag the classifier's provider imports into every graph that logs.

import {
  GATEWAY_DETAIL_KEYS,
  GATEWAY_ERROR_CODES,
  MAX_UNKNOWN_DETAIL_KEYS,
  OTHER_GATEWAY_CODE,
} from "./gateway-answer-vocabulary.js";

/** The structural `ErrorShape.code` of an ANSWERED gateway refusal on the cause chain
 *  (`GatewayAnsweredError.gatewayCode`, read by shape so this module stays free of the
 *  client), with the error that carries it. Null when nothing on the chain was answered. */
export function answeredRefusal(
  err: unknown,
): { error: Error; gatewayCode: string; details: unknown } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const gatewayCode = (current as { gatewayCode?: unknown }).gatewayCode;
    if (typeof gatewayCode === "string" && gatewayCode !== "") {
      return {
        error: current,
        gatewayCode,
        details: (current as { details?: unknown }).details,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** See `answeredRefusalShape`. */
export interface AnsweredRefusalShape {
  gatewayCode: string;
  detailKeys?: string[];
  unknownDetailKeyCount?: number;
}
const KNOWN_GATEWAY_CODES: ReadonlySet<string> = new Set(GATEWAY_ERROR_CODES);
const KNOWN_DETAIL_KEYS: ReadonlySet<string> = new Set(GATEWAY_DETAIL_KEYS);

/** What a trace may say about a refusal the gateway ANSWERED: its error code and the NAMES
 *  of the `details` keys — never the message, never a value (SOC2: metadata only). It is
 *  what remains of an unrecognized refusal once the bridge's log is gone (prod 2026-10-13:
 *  `UPSTREAM_ERROR` alone, the gateway's reason lost with the container).
 *
 *  Both halves are CLOSED vocabularies, not syntax checks (codex): a syntactically clean
 *  string can still be content. A code outside `GATEWAY_ERROR_CODES` is reported as
 *  `other`; a key outside `GATEWAY_DETAIL_KEYS` is never copied, only counted
 *  (`unknownDetailKeyCount`, capped at `MAX_UNKNOWN_DETAIL_KEYS`). Null when no error on the
 *  chain was answered by a gateway. */
export function answeredRefusalShape(err: unknown): AnsweredRefusalShape | null {
  const answered = answeredRefusal(err);
  if (answered === null) return null;
  const shape: AnsweredRefusalShape = {
    gatewayCode: KNOWN_GATEWAY_CODES.has(answered.gatewayCode)
      ? answered.gatewayCode
      : OTHER_GATEWAY_CODE,
  };
  const { details } = answered;
  if (details !== null && typeof details === "object" && !Array.isArray(details)) {
    const keys = Object.keys(details);
    shape.detailKeys = keys.filter((k) => KNOWN_DETAIL_KEYS.has(k)).sort();
    const unknown = keys.length - shape.detailKeys.length;
    if (unknown > 0) {
      shape.unknownDetailKeyCount = Math.min(unknown, MAX_UNKNOWN_DETAIL_KEYS);
    }
  }
  return shape;
}
