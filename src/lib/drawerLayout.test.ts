import { describe, expect, test } from "vitest";
import {
  DRAWER_MAX_WIDTH,
  DRAWER_QUERY,
  SHORT_MAX_HEIGHT,
  SHORT_SCREEN_QUERY,
  isDrawerLayout,
  isShortScreen,
} from "./drawerLayout";

// Olivier's arbitration: width < 768 px OR (height < 500 px AND a coarse pointer).
describe("when the sidebar is a drawer", () => {
  test("phones, portrait: always (360 x 740 … 430 x 932)", () => {
    for (const [width, height] of [
      [360, 740],
      [375, 812],
      [390, 844],
      [430, 932],
    ]) {
      expect(isDrawerLayout({ width, height, coarse: true })).toBe(true);
    }
  });

  test("phones, landscape: the height clause catches what width alone sent to the desktop layout", () => {
    for (const [width, height] of [
      [740, 360],
      [812, 375],
      [844, 390],
      [932, 430],
    ]) {
      expect(isDrawerLayout({ width, height, coarse: true })).toBe(true);
    }
  });

  test("tablets keep the column, in both orientations", () => {
    for (const [width, height] of [
      [768, 1024],
      [820, 1180],
      [1024, 1366],
      [1024, 768],
      [1180, 820],
      [1366, 1024],
    ]) {
      expect(isDrawerLayout({ width, height, coarse: true })).toBe(false);
    }
  });

  test("a desktop window that is merely short keeps the column (fine pointer)", () => {
    expect(isDrawerLayout({ width: 1280, height: 450, coarse: false })).toBe(false);
    expect(isDrawerLayout({ width: 1280, height: 800, coarse: false })).toBe(false);
  });

  test("the edges: 767 / 768 wide, 499 / 500 high", () => {
    expect(isDrawerLayout({ width: 767, height: 900, coarse: false })).toBe(true);
    expect(isDrawerLayout({ width: 768, height: 900, coarse: false })).toBe(false);
    expect(isDrawerLayout({ width: 900, height: 499, coarse: true })).toBe(true);
    expect(isDrawerLayout({ width: 900, height: 500, coarse: true })).toBe(false);
  });
});

describe("the short layout (the top bar as a rail)", () => {
  test("a phone in landscape only", () => {
    expect(isShortScreen({ height: 390, coarse: true })).toBe(true);
    expect(isShortScreen({ height: 390, coarse: false })).toBe(false);
    expect(isShortScreen({ height: 740, coarse: true })).toBe(false);
  });
});

describe("the media queries say the same thing as the functions", () => {
  test("built from the same constants", () => {
    expect(DRAWER_MAX_WIDTH).toBe(767);
    expect(SHORT_MAX_HEIGHT).toBe(499);
    expect(SHORT_SCREEN_QUERY).toBe("(max-height: 499px) and (pointer: coarse)");
    expect(DRAWER_QUERY).toBe("(max-width: 767px), (max-height: 499px) and (pointer: coarse)");
  });
});
