import { describe, expect, test } from "vitest";

import { DOCK_MAX_SCALE, DOCK_RANGE_PX, dockFocus, dockOffsets, dockScales } from "./presenceDock";

describe("dockScales — the macOS Dock bump", () => {
  const centers = [10, 30, 50, 70, 90];
  test("not hovering: every face at rest", () => {
    expect(dockScales(centers, null)).toEqual([1, 1, 1, 1, 1]);
  });
  test("the face under the pointer grows most, its neighbours less, far ones not at all", () => {
    const s = dockScales(centers, 50);
    expect(s[2]).toBeCloseTo(DOCK_MAX_SCALE);
    expect(s[1]).toBeLessThan(s[2]!);
    expect(s[1]).toBeGreaterThan(1);
    expect(s[1]).toBeCloseTo(s[3]!); // symmetric
    expect(s[0]).toBeLessThan(s[1]!);
    expect(dockScales([0, DOCK_RANGE_PX + 1], 0)[1]).toBe(1);
  });
  test("between two faces, both grow and neither reaches the maximum", () => {
    const s = dockScales([0, 20], 10);
    expect(s[0]).toBeCloseTo(s[1]!);
    expect(s[0]).toBeLessThan(DOCK_MAX_SCALE);
    expect(s[0]).toBeGreaterThan(1);
  });
  test("the label goes to the most magnified face, none at rest", () => {
    expect(dockFocus(dockScales(centers, 72))).toBe(3);
    expect(dockFocus([1, 1, 1])).toBeNull();
  });
});

describe("dockOffsets — room is made on BOTH sides", () => {
  test("the face under the pointer does not move; left ones go left, right ones go right", () => {
    const centers = [10, 30, 50, 70, 90];
    const scales = dockScales(centers, 50);
    const d = dockOffsets(centers, scales, 20);
    expect(d[2]).toBeCloseTo(0);
    expect(d[1]).toBeLessThan(0);
    expect(d[3]).toBeGreaterThan(0);
    expect(d[0]).toBeLessThan(d[1]!);
    expect(d[4]).toBeGreaterThan(d[3]!);
    expect(d[1]).toBeCloseTo(-d[3]!); // symmetric
  });
  test("at rest nothing moves", () => {
    expect(dockOffsets([0, 20, 40], [1, 1, 1], 20)).toEqual([0, 0, 0]);
  });
});
