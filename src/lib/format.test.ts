import { describe, expect, test } from "vitest";
import { formatDurationShort } from "./format";

describe("formatDurationShort (reply generation time)", () => {
  test("sub-second floors to '< 1 s' (including 500-999 ms — never rounded up)", () => {
    expect(formatDurationShort(0)).toBe("< 1 s");
    expect(formatDurationShort(420)).toBe("< 1 s");
    expect(formatDurationShort(750)).toBe("< 1 s");
    expect(formatDurationShort(999)).toBe("< 1 s");
  });
  test("seconds", () => {
    expect(formatDurationShort(1_000)).toBe("1 s");
    expect(formatDurationShort(42_400)).toBe("42 s");
    expect(formatDurationShort(59_400)).toBe("59 s");
  });
  test("minutes (+ zero-padded seconds, exact minutes stay bare)", () => {
    expect(formatDurationShort(60_000)).toBe("1 min");
    expect(formatDurationShort(125_000)).toBe("2 min 05 s");
  });
  test("hours (+ zero-padded minutes, exact hours stay bare)", () => {
    expect(formatDurationShort(3_600_000)).toBe("1 h");
    expect(formatDurationShort(3_780_000)).toBe("1 h 03 min");
  });
  test("invalid input hides (null): negative / NaN / Infinity", () => {
    expect(formatDurationShort(-5)).toBeNull();
    expect(formatDurationShort(Number.NaN)).toBeNull();
    expect(formatDurationShort(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
