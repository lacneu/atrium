/// <reference types="vite/client" />
//
// The shared plan-ordering rule (convex/lib/planOrder.ts), read by BOTH tiers:
// the browser through src/chat/planView.ts and the server through
// stream.advanceLastPlan / stream.addPart / bridge_ingest. Its two functions are
// pure, so they are pinned here directly — the behavioral tests that depend on
// them live in clearPlan.test.ts, advancePlan.test.ts and planView.test.ts.
import { describe, expect, test } from "vitest";
import { currentPlanIndex, usablePlanStamp } from "./lib/planOrder";

const DAY_S = 86_400;

describe("usablePlanStamp: the screen every write path shares", () => {
  const NOW_MS = 1_788_581_688_000;
  const NOW_S = NOW_MS / 1000;

  test.each([
    ["undefined", undefined],
    ["a string", "1788581688"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["zero", 0],
    ["negative", -1],
  ])("refuses %s", (_label, value) => {
    expect(usablePlanStamp(value, NOW_MS)).toBeUndefined();
  });

  test("accepts a stamp in seconds, past or present", () => {
    expect(usablePlanStamp(NOW_S, NOW_MS)).toBe(NOW_S);
    expect(usablePlanStamp(NOW_S - 10 * DAY_S, NOW_MS)).toBe(NOW_S - 10 * DAY_S);
  });

  test("the +24h boundary: on it accepted, past it refused", () => {
    // A bridge clock ahead of Convex's is normal drift and must not lose its
    // ordering claim; a thousandfold value is the unit regression this bars.
    expect(usablePlanStamp(NOW_S + DAY_S, NOW_MS)).toBe(NOW_S + DAY_S);
    expect(usablePlanStamp(NOW_S + DAY_S + 1, NOW_MS)).toBeUndefined();
  });

  test("refuses a stamp posted in MILLISECONDS — the unit regression", () => {
    expect(usablePlanStamp(NOW_MS, NOW_MS)).toBeUndefined();
  });
});

describe("currentPlanIndex: an empty list has no current plan", () => {
  test("returns -1", () => {
    expect(currentPlanIndex([])).toBe(-1);
  });
});
