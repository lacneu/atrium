// The measured-collapse decision shared by the chat header and the sidebar's
// new-chat bar. Anchored on widths measured in the browser (fr, 1280×800): the
// new-chat row needs 222 px with its shortcut badge, 173 px without it.

import { describe, expect, test } from "vitest";

import { naturalWidthOf, pickFitLevel } from "./useFitLevel";

const NEW_CHAT_ROW = [222, 173] as const;

describe("pickFitLevel — the most detailed presentation that fits", () => {
  test("stays full while the space covers the most detailed ghost, a tie included", () => {
    expect(pickFitLevel({ available: 242, required: NEW_CHAT_ROW })).toBe(0);
    expect(pickFitLevel({ available: 222, required: NEW_CHAT_ROW })).toBe(0);
  });

  test("steps down exactly where the measured width stops fitting", () => {
    expect(pickFitLevel({ available: 221, required: NEW_CHAT_ROW })).toBe(1);
    expect(pickFitLevel({ available: 173, required: NEW_CHAT_ROW })).toBe(1);
  });

  test("past every ghost, lands one past the last level: the most compact form", () => {
    expect(pickFitLevel({ available: 172, required: NEW_CHAT_ROW })).toBe(2);
    expect(pickFitLevel({ available: 0, required: NEW_CHAT_ROW })).toBe(2);
  });

  test("a ghost not laid out yet (0) gives no verdict: the detailed form stays", () => {
    // Collapsing on a 0 would flash the compact layout on the first frame — also
    // when a caller reserves part of the space and the remainder is negative.
    expect(pickFitLevel({ available: 10, required: [0, 173] })).toBe(0);
    expect(pickFitLevel({ available: -16, required: [0, 173] })).toBe(0);
    expect(pickFitLevel({ available: 10, required: [] })).toBe(0);
  });

  test("decides on the content's width, not on the space: a wider locale steps down sooner", () => {
    // The same 222 px that holds the French row drops the badge of a longer label.
    expect(pickFitLevel({ available: 222, required: [268, 214] })).toBe(1);
  });
});

describe("naturalWidthOf — a block whose lines ellipsize their own overflow", () => {
  test("is the widest line's scrollWidth", () => {
    expect(naturalWidthOf([{ scrollWidth: 412 }, { scrollWidth: 805 }])).toBe(805);
  });

  test("an empty block claims nothing", () => {
    expect(naturalWidthOf([])).toBe(0);
  });
});
