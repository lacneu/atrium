import { describe, expect, it } from "vitest";
import { relativeAge } from "./relativeAge";

const NOW = 1_000_000_000_000;
const ago = (ms: number) => relativeAge(NOW - ms, NOW);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

describe("relativeAge", () => {
  it("sub-minute (and clock-skew future) -> maintenant", () => {
    expect(ago(0)).toBe("maintenant");
    expect(ago(30_000)).toBe("maintenant");
    expect(relativeAge(NOW + 5_000, NOW)).toBe("maintenant"); // future skew
  });

  it("minutes / hours", () => {
    expect(ago(5 * MIN)).toBe("5min");
    expect(ago(59 * MIN)).toBe("59min");
    expect(ago(3 * HOUR)).toBe("3h");
    expect(ago(23 * HOUR)).toBe("23h");
  });

  it("days / weeks", () => {
    expect(ago(3 * DAY)).toBe("3j");
    expect(ago(6 * DAY)).toBe("6j");
    expect(ago(2 * WEEK)).toBe("2sem");
  });

  it("months / years (singular vs plural)", () => {
    expect(ago(2 * MONTH)).toBe("2mois");
    expect(ago(YEAR)).toBe("1an");
    expect(ago(3 * YEAR)).toBe("3ans");
  });
});
