// Convex re-validates the bridge's answered-refusal shape with its OWN copy of the closed
// vocabularies (it must not trust the bridge). The copy is held to the bridge's lists here;
// the bridge's lists are confronted with upstream in
// bridge/test/answered-refusal-vocabulary.test.ts.
import { describe, expect, test } from "vitest";
import {
  GATEWAY_DETAIL_KEYS,
  GATEWAY_ERROR_CODES,
  MAX_UNKNOWN_DETAIL_KEYS as BRIDGE_MAX_UNKNOWN,
  OTHER_GATEWAY_CODE,
} from "../../bridge/src/core/gateway-answer-vocabulary";
import {
  GATEWAY_ANSWER_CODES,
  GATEWAY_ANSWER_DETAIL_KEYS,
  MAX_UNKNOWN_DETAIL_KEYS,
  OTHER_GATEWAY_ANSWER_CODE,
} from "./gatewayAnswer";

describe("the answered-refusal vocabularies are the bridge's, in lockstep", () => {
  test("same codes, same key names, same fixed value and bound", () => {
    expect([...GATEWAY_ANSWER_CODES].sort()).toEqual([...GATEWAY_ERROR_CODES].sort());
    expect([...GATEWAY_ANSWER_DETAIL_KEYS].sort()).toEqual([...GATEWAY_DETAIL_KEYS].sort());
    expect(OTHER_GATEWAY_ANSWER_CODE).toBe(OTHER_GATEWAY_CODE);
    expect(MAX_UNKNOWN_DETAIL_KEYS).toBe(BRIDGE_MAX_UNKNOWN);
  });
});
