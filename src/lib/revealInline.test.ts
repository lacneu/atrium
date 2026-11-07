// Anchored on the responsive audit (fr, 360×740): on Settings ▸ Trash the active
// "Corbeilles" tab sat at x=545–632 in a 360 px tab bar scrolled to 0.

import { describe, expect, test } from "vitest";

import { revealOffset } from "./revealInline";

describe("revealOffset — bring the active tab into a scrolling bar's view", () => {
  test("an off-screen tab to the right is scrolled in, with a sliver of margin", () => {
    // 632 + 12 - 360 = 284: the tab then sits at 261–348, fully visible.
    expect(
      revealOffset({ scrollStart: 0, viewSize: 360, itemStart: 545, itemSize: 87, margin: 12 }),
    ).toBe(284);
  });

  test("a tab already in view does not move the bar", () => {
    expect(
      revealOffset({ scrollStart: 0, viewSize: 360, itemStart: 20, itemSize: 87, margin: 12 }),
    ).toBeNull();
    expect(
      revealOffset({ scrollStart: 284, viewSize: 360, itemStart: 545, itemSize: 87, margin: 12 }),
    ).toBeNull();
  });

  test("a tab hidden before the start aligns its start, never below 0", () => {
    expect(
      revealOffset({ scrollStart: 300, viewSize: 360, itemStart: 120, itemSize: 80, margin: 12 }),
    ).toBe(108);
    expect(
      revealOffset({ scrollStart: 300, viewSize: 360, itemStart: 4, itemSize: 80, margin: 12 }),
    ).toBe(0);
  });

  test("a tab wider than the view shows its start", () => {
    expect(
      revealOffset({ scrollStart: 0, viewSize: 200, itemStart: 400, itemSize: 260, margin: 12 }),
    ).toBe(388);
  });

  test("never scrolls past the end of the bar", () => {
    expect(
      revealOffset({
        scrollStart: 0,
        viewSize: 360,
        itemStart: 676,
        itemSize: 48,
        margin: 12,
        maxScroll: 380,
      }),
    ).toBe(376);
    expect(
      revealOffset({
        scrollStart: 0,
        viewSize: 360,
        itemStart: 690,
        itemSize: 48,
        margin: 12,
        maxScroll: 380,
      }),
    ).toBe(380);
  });
});
