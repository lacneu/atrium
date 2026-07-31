/**
 * Where a conversation lands when it opens (user report: opening a chat scrolls visibly
 * from the first message down to the last).
 *
 * The DOM half is verified in the browser; what is tested here is every decision the
 * landing makes, because those are the parts that can be wrong in a way no screenshot
 * would reveal: which bookmark wins, when the thread counts as settled, and the
 * arithmetic that places the target.
 */

import { describe, expect, it } from "vitest";

import type { BookmarkView } from "./bookmarkView";
import {
  chooseLanding,
  landingScrollTop,
  LANDING_STABLE_FRAMES,
  SettleDetector,
} from "./threadLanding";

const bm = (over: Partial<BookmarkView>): BookmarkView => ({
  id: "b1",
  messageId: "m1",
  blockIndex: null,
  label: "",
  createdAt: 0,
  ...over,
});

describe("choosing where to land", () => {
  it("a conversation with no bookmark lands at the bottom", () => {
    expect(chooseLanding([])).toEqual({ kind: "bottom" });
  });

  it("the most recently PLACED bookmark wins, not the first in the list", () => {
    // Product decision: a bookmark is "where I left off", so `createdAt` decides — not
    // the order the query returned, and not the position in the thread.
    const got = chooseLanding([
      bm({ id: "old", messageId: "m-old", createdAt: 10 }),
      bm({ id: "new", messageId: "m-new", createdAt: 90 }),
      bm({ id: "mid", messageId: "m-mid", createdAt: 50 }),
    ]);
    expect(got).toEqual({ kind: "bookmark", messageId: "m-new", blockIndex: null });
  });

  it("a block-level bookmark keeps its block index", () => {
    expect(chooseLanding([bm({ messageId: "m7", blockIndex: 3, createdAt: 1 })])).toEqual({
      kind: "bookmark",
      messageId: "m7",
      blockIndex: 3,
    });
  });

  it("two marks placed in the same millisecond still resolve deterministically", () => {
    // Without the `>=` the answer would depend on query order, which is not stable.
    const got = chooseLanding([
      bm({ id: "a", messageId: "m-a", createdAt: 42 }),
      bm({ id: "b", messageId: "m-b", createdAt: 42 }),
    ]);
    expect(got).toEqual({ kind: "bookmark", messageId: "m-b", blockIndex: null });
  });
});

describe("knowing when the thread has stopped growing", () => {
  it("a steady height for N frames settles", () => {
    const d = new SettleDetector();
    expect(d.observe(1000)).toBe(false); // first measurement is a change
    for (let i = 0; i < LANDING_STABLE_FRAMES - 1; i += 1) {
      expect(d.observe(1000)).toBe(false);
    }
    expect(d.observe(1000)).toBe(true);
  });

  it("content arriving RESTARTS the count", () => {
    // The failure this prevents: pinning once at mount, then an image hydrating and
    // pushing the thread off the mark with nothing left to correct it.
    const d = new SettleDetector();
    d.observe(1000);
    d.observe(1000);
    expect(d.observe(1400), "a height change must not settle").toBe(false);
    expect(d.observe(1400)).toBe(false);
    expect(d.observe(1400)).toBe(false);
    expect(d.observe(1400)).toBe(true);
  });

  it("a thread that never stops growing never settles (the deadline releases it)", () => {
    const d = new SettleDetector();
    for (let i = 0; i < 50; i += 1) {
      expect(d.observe(1000 + i * 10)).toBe(false);
    }
  });
});

describe("placing the target", () => {
  it("the bottom pin is the whole remaining scroll", () => {
    expect(
      landingScrollTop({ kind: "bottom", scrollTop: 0, scrollHeight: 5000, clientHeight: 800 }),
    ).toBe(4200);
  });

  it("a thread shorter than its viewport pins at zero, never negative", () => {
    expect(
      landingScrollTop({ kind: "bottom", scrollTop: 0, scrollHeight: 300, clientHeight: 800 }),
    ).toBe(0);
  });

  it("a bookmark sits 30% down, the same place the rail puts it", () => {
    // Landing on a mark and clicking it in the rail must not differ, or the thread
    // appears to move for no reason the first time the user touches the rail.
    expect(
      landingScrollTop({
        kind: "bookmark",
        scrollTop: 1000,
        scrollHeight: 5000,
        clientHeight: 800,
        anchorDelta: 500,
      }),
    ).toBe(1000 + 500 - 240);
  });

  it("a bookmark near the very top does not scroll past zero", () => {
    expect(
      landingScrollTop({
        kind: "bookmark",
        scrollTop: 0,
        scrollHeight: 5000,
        clientHeight: 800,
        anchorDelta: 10,
      }),
    ).toBe(0);
  });

  it("a bookmark whose anchor has not mounted yet moves nothing", () => {
    // The retry keeps looking; moving to a guessed position in the meantime would be a
    // visible jump to the wrong place.
    expect(
      landingScrollTop({
        kind: "bookmark",
        scrollTop: 1000,
        scrollHeight: 5000,
        clientHeight: 800,
      }),
    ).toBeNull();
  });
});
