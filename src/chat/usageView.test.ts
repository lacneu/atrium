/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { usageBadgeView, formatResetRemaining } from "./usageView";

const NOW = 1_783_300_000_000;

describe("usageBadgeView", () => {
  it("null/empty snapshot -> no badge", () => {
    expect(usageBadgeView(null, NOW)).toBeNull();
    expect(usageBadgeView([], NOW)).toBeNull();
    expect(usageBadgeView([{ provider: "openai", windows: [] }], NOW)).toBeNull();
  });
  it("picks the MOST CONSTRAINED window across providers", () => {
    const v = usageBadgeView(
      [
        {
          provider: "openai",
          windows: [
            { label: "5h", usedPercent: 5, resetAt: NOW + 3_600_000 },
            { label: "week", usedPercent: 96, resetAt: NOW + 86_400_000 },
          ],
        },
      ],
      NOW,
    );
    expect(v?.percentLeft).toBe(4);
    expect(v?.label).toBe("week");
    expect(v?.level).toBe("is-critical");
    expect(v?.windows).toHaveLength(2);
  });
  it("severity thresholds: >25 ok, <=25 warn, <=10 critical", () => {
    const mk = (used: number) =>
      usageBadgeView([{ provider: "openai", windows: [{ label: "5h", usedPercent: used, resetAt: null }] }], NOW)!;
    expect(mk(50).level).toBe("is-ok");
    expect(mk(80).level).toBe("is-warn");
    expect(mk(95).level).toBe("is-critical");
  });
  it("clamps out-of-range percents from the wire", () => {
    const v = usageBadgeView(
      [{ provider: "openai", windows: [{ label: "5h", usedPercent: 140, resetAt: null }] }],
      NOW,
    );
    expect(v?.percentLeft).toBe(0);
  });
});

describe("formatResetRemaining", () => {
  it("null/past -> null", () => {
    expect(formatResetRemaining(null, NOW)).toBeNull();
    expect(formatResetRemaining(NOW - 1, NOW)).toBeNull();
  });
  it("minutes / hours / days shapes", () => {
    expect(formatResetRemaining(NOW + 42 * 60_000, NOW)).toBe("42m");
    expect(formatResetRemaining(NOW + (3 * 60 + 5) * 60_000, NOW)).toBe("3h 5m");
    expect(formatResetRemaining(NOW + 28 * 3_600_000, NOW)).toBe("1j 4h");
  });
});
