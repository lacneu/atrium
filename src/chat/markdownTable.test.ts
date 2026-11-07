// A reply's markdown table never scrolls inside the thread on a short screen
// (markdownTable.ts) — a nested scroll in a 180 px thread was unusable.
import { describe, expect, test } from "vitest";
import { markdownTableMaxHeight } from "./markdownTable";

describe("a markdown table's height cap", () => {
  test("a short screen (a phone held sideways): no cap, the thread scrolls it", () => {
    expect(markdownTableMaxHeight(true)).toBe("none");
  });
  test("elsewhere: Streamdown's own default (300 px)", () => {
    expect(markdownTableMaxHeight(false)).toBeUndefined();
  });
});
