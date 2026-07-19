// Live turn clock derivation (ChatGPT-style "Working for 5 min 21 s").
// Pins the ANTI-SKEW contract: the server timestamp is compared to the local
// clock ONCE (baseline, clamped ≥ 0) and the clock then ticks purely locally.

import { describe, expect, it } from "vitest";
import {
  turnBaselineMs,
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
