// Anchored on the responsive audit (fr, 360×740): on Settings ▸ Trash the active
// "Corbeilles" tab sat at x=545–632 in a 360 px tab bar scrolled to 0.

import { describe, expect, test } from "vitest";

import { revealFocusIn, revealOffset } from "./revealInline";

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

// Lot 26: the arrow keys (Radix moves the focus along a tab list, its value
// following a route later) or Tab (the settings strip's links) land on a tab past
// the edge — 263-589 px in a 20-340 px list at 360 px under the largest text scale —:
// it was read unseen. The focused item is brought into view like the active one.
describe("revealFocusIn — the item a focus moved to", () => {
  function fakeStrip(itemLeft: number, itemWidth: number) {
    const item = { getBoundingClientRect: () => ({ left: itemLeft - strip.scrollLeft, width: itemWidth }) };
    const strip = {
      scrollLeft: 0,
      clientWidth: 320,
      clientLeft: 0,
      scrollWidth: 910,
      getBoundingClientRect: () => ({ left: 20 }),
      contains: (el: unknown) => el === item,
    };
    const target = { closest: (sel: string) => (sel === '[data-slot="tabs-trigger"]' ? item : null) };
    return { strip, item, target };
  }

  test("a trigger past the edge, wider than the list: its start is brought in", () => {
    const { strip, target } = fakeStrip(263, 326);
    revealFocusIn(strip as unknown as HTMLElement, target as unknown as EventTarget, '[data-slot="tabs-trigger"]');
    // 263 - 20 - 12 = 231: the trigger then starts 12 px into the list.
    expect(strip.scrollLeft).toBe(231);
  });

  test("a focus outside the bar's items, an item of another bar, or no element: nothing moves", () => {
    const { strip, target } = fakeStrip(263, 200);
    revealFocusIn(strip as unknown as HTMLElement, target as unknown as EventTarget, ".other");
    revealFocusIn(strip as unknown as HTMLElement, null, '[data-slot="tabs-trigger"]');
    // A trigger of ANOTHER list (a nested one): not this bar's to scroll.
    const foreign = { getBoundingClientRect: () => ({ left: 600, width: 100 }) };
    const elsewhere = { closest: () => foreign };
    revealFocusIn(strip as unknown as HTMLElement, elsewhere as unknown as EventTarget, '[data-slot="tabs-trigger"]');
    expect(strip.scrollLeft).toBe(0);
  });
});
