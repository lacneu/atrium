// A mouse without a trackpad reaches the tabs a row hides (lot 10): its vertical
// wheel scrolls the row sideways while the row overflows, and gives the page its
// scroll back at either end.
import { describe, expect, test } from "vitest";
import { WHEEL_LINE_PX, wheelToInline, type WheelInput } from "./wheelToInline";

// A 300 px row holding 600 px of tabs: 300 px to scroll.
const ROW = { scrollWidth: 600, clientWidth: 300 };
const wheel = (o: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  scrollLeft: 0,
  ...ROW,
  ...o,
});

describe("the vertical wheel scrolls an overflowing tab row sideways", () => {
  test("down moves it toward the end, up back toward the start", () => {
    expect(wheelToInline(wheel({ deltaY: 100 }))).toBe(100);
    expect(wheelToInline(wheel({ deltaY: -100, scrollLeft: 150 }))).toBe(50);
  });

  test("a step past either end stops at the end", () => {
    expect(wheelToInline(wheel({ deltaY: 100, scrollLeft: 250 }))).toBe(300);
    expect(wheelToInline(wheel({ deltaY: -100, scrollLeft: 40 }))).toBe(0);
  });

  test("a wheel counted in lines (Firefox) or pages moves as far", () => {
    expect(wheelToInline(wheel({ deltaY: 3, deltaMode: 1 }))).toBe(3 * WHEEL_LINE_PX);
    expect(wheelToInline(wheel({ deltaY: 1, deltaMode: 2 }))).toBe(300);
  });
});

describe("…and leaves every other wheel to the page", () => {
  test("at the start, scrolling up: the page scrolls", () => {
    expect(wheelToInline(wheel({ deltaY: -100, scrollLeft: 0 }))).toBeNull();
  });

  test("at the end, scrolling down: the page scrolls", () => {
    expect(wheelToInline(wheel({ deltaY: 100, scrollLeft: 300 }))).toBeNull();
    expect(wheelToInline(wheel({ deltaY: 100, scrollLeft: 299.6 }))).toBeNull();
  });

  test("a row that does not overflow never takes the wheel", () => {
    expect(wheelToInline(wheel({ deltaY: 100, scrollWidth: 300 }))).toBeNull();
    // A fraction of a pixel of "overflow" is the layout rounding, not a scroll.
    expect(wheelToInline(wheel({ deltaY: 100, scrollWidth: 300.6 }))).toBeNull();
  });

  test("a sideways swipe or Shift+wheel arrives horizontal: native", () => {
    expect(wheelToInline(wheel({ deltaX: 40, deltaY: 10 }))).toBeNull();
    expect(wheelToInline(wheel({ deltaX: 100, deltaY: 0 }))).toBeNull();
  });

  test("ctrl+wheel is a pinch to zoom, not a scroll", () => {
    expect(wheelToInline(wheel({ deltaY: 100, ctrlKey: true }))).toBeNull();
  });
});
