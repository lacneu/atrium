// Live turn clock derivation (ChatGPT-style "Working for 5 min 21 s").
// Pins the ANTI-SKEW contract: the server timestamp is compared to the local
// clock ONCE (baseline, clamped ≥ 0) and the clock then ticks purely locally.

import { describe, expect, it } from "vitest";
import {
  turnBaselineMs,
  turnClockActive,
  turnElapsedMs,
  turnClockLabel,
} from "./turnClockView";

describe("turnBaselineMs", () => {
  it("a turn already running at page load carries its honest age", () => {
    expect(turnBaselineMs(1000, 61_000)).toBe(60_000);
  });
  it("a server clock AHEAD of the client clamps to 0 (never a negative age)", () => {
    expect(turnBaselineMs(5000, 3000)).toBe(0);
  });
});

describe("turnElapsedMs", () => {
  it("baseline plus local ticking since first observation", () => {
    expect(turnElapsedMs(60_000, 100_000, 130_000)).toBe(90_000);
  });
  it("a local clock going BACKWARD (NTP step) never rewinds the clock", () => {
    expect(turnElapsedMs(60_000, 100_000, 90_000)).toBe(60_000);
  });
  it("zero baseline: pure local elapsed", () => {
    expect(turnElapsedMs(0, 100_000, 101_500)).toBe(1500);
  });
});

describe("turnClockLabel", () => {
  it("formats through the shared short-duration formatter", () => {
    expect(turnClockLabel(500)).toBe("< 1 s");
    expect(turnClockLabel(42_000)).toBe("42 s");
    expect(turnClockLabel(321_000)).toBe("5 min 21 s");
  });
  it("hides on a non-finite input", () => {
    expect(turnClockLabel(Number.NaN)).toBeNull();
  });
});

// WHEN the clock runs. The regressions this pins are all the same shape: the
// clock reached its own verdict about "is this turn still being treated" while
// the thread's activity pill reached another, and the user watched a block that
// was visibly working with no elapsed time on it.
describe("turnClockActive", () => {
  const M = "msg_1";

  it("a streaming message runs the clock", () => {
    expect(turnClockActive(true, null, M)).toBe(true);
  });

  it("a settled message with nothing anchored does NOT run the clock", () => {
    expect(turnClockActive(false, null, M)).toBe(false);
  });

  // The 2026-08-03 prod report: an agent that writes a sentence and THEN
  // delegates settles its bubble while the work goes on. Text on the block is
  // not the end of the turn.
  it("a settled message that OWNS the delegated work runs the clock", () => {
    expect(turnClockActive(false, M, M)).toBe(true);
  });

  it("work anchored on ANOTHER message leaves this block's clock off", () => {
    expect(turnClockActive(false, "msg_other", M)).toBe(false);
  });

  // A bubble with no identity yet (optimistic, not yet persisted) must never
  // claim the anchor. Asserted against BOTH shapes of "no anchor": the typed
  // `null`, and the `undefined` an upstream refactor could let through — the
  // second is the one that decides where the guard belongs, since `undefined
  // === undefined` would otherwise light every identity-less bubble at once.
  it("an identity-less bubble never claims the anchor", () => {
    expect(turnClockActive(false, null, undefined)).toBe(false);
    expect(
      turnClockActive(false, undefined as unknown as null, undefined),
    ).toBe(false);
  });

  it("streaming wins even when the anchor points elsewhere", () => {
    expect(turnClockActive(true, "msg_other", M)).toBe(true);
  });
});
