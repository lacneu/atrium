/// <reference types="vite/client" />
//
// Pure unit tests for lib/timeRange (epoch-ms strings + Grafana relative tokens).

import { describe, expect, test } from "vitest";
import { resolveTimeToken, parseRange } from "./lib/timeRange";

// A fixed anchor so relative tokens resolve deterministically.
const NOW = 1_717_336_800_000; // 2024-06-02T14:00:00Z

describe("resolveTimeToken", () => {
  test("parses an epoch-ms numeric string", () => {
    expect(resolveTimeToken("1717336800000", NOW)).toBe(1_717_336_800_000);
    expect(resolveTimeToken("0", NOW)).toBe(0);
  });

  test("resolves bare `now` to nowMs", () => {
    expect(resolveTimeToken("now", NOW)).toBe(NOW);
    expect(resolveTimeToken("NOW", NOW)).toBe(NOW); // case-insensitive
    expect(resolveTimeToken("  now  ", NOW)).toBe(NOW); // trimmed
  });

  test("resolves now-<N><unit> for each unit (s|m|h|d|w)", () => {
    expect(resolveTimeToken("now-30s", NOW)).toBe(NOW - 30 * 1000);
    expect(resolveTimeToken("now-15m", NOW)).toBe(NOW - 15 * 60 * 1000);
    expect(resolveTimeToken("now-1h", NOW)).toBe(NOW - 60 * 60 * 1000);
    expect(resolveTimeToken("now-24h", NOW)).toBe(NOW - 24 * 60 * 60 * 1000);
    expect(resolveTimeToken("now-7d", NOW)).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
    expect(resolveTimeToken("now-2w", NOW)).toBe(
      NOW - 2 * 7 * 24 * 60 * 60 * 1000,
    );
  });

  test("supports the forward `now+<N><unit>` form too", () => {
    expect(resolveTimeToken("now+1h", NOW)).toBe(NOW + 60 * 60 * 1000);
  });

  test("tolerates whitespace and case in relative tokens", () => {
    expect(resolveTimeToken("now - 1h", NOW)).toBe(NOW - 60 * 60 * 1000);
    expect(resolveTimeToken("NOW-2D", NOW)).toBe(NOW - 2 * 24 * 60 * 60 * 1000);
  });

  test("returns undefined for unparseable tokens (never throws)", () => {
    expect(resolveTimeToken("", NOW)).toBeUndefined();
    expect(resolveTimeToken("yesterday", NOW)).toBeUndefined();
    expect(resolveTimeToken("now-1y", NOW)).toBeUndefined(); // unknown unit
    expect(resolveTimeToken("now-h", NOW)).toBeUndefined(); // missing amount
    expect(resolveTimeToken("notanumber", NOW)).toBeUndefined();
  });
});

describe("parseRange", () => {
  test("resolves both bounds (epoch + relative mix)", () => {
    expect(parseRange({ from: "now-1h", to: "now" }, NOW)).toEqual({
      from: NOW - 60 * 60 * 1000,
      to: NOW,
    });
    expect(parseRange({ from: "1717336800000" }, NOW)).toEqual({
      from: 1_717_336_800_000,
    });
  });

  test("drops an unparseable bound but keeps the valid one", () => {
    expect(parseRange({ from: "bogus", to: "now" }, NOW)).toEqual({ to: NOW });
    expect(parseRange({ from: "now-24h", to: "garbage" }, NOW)).toEqual({
      from: NOW - 24 * 60 * 60 * 1000,
    });
  });

  test("returns an empty range when no bounds are given", () => {
    expect(parseRange({}, NOW)).toEqual({});
  });
});
