// The chat header's compact decision, anchored on the responsive audit
// (fr, rich conversation whose title is 805 px wide at its natural width; the
// full meta ghost — "Exporter", "Avancé" — measures 216 px).

import { describe, expect, test } from "vitest";

import { pickFitLevel } from "@/lib/useFitLevel";
import { HEADER_GAP, HEADER_TITLE_CAP, headerFitInput } from "./chatHeaderFit";

/** A title block as the DOM gives it: the block's OWN scrollWidth is the width it
 *  is squeezed to, each line's scrollWidth is that line's natural width. */
function titleBlock(lineWidths: number[], squeezedTo: number) {
  return {
    scrollWidth: squeezedTo,
    children: lineWidths.map((scrollWidth) => ({ scrollWidth })),
  };
}

const META = 216;

function level(headWidth: number, block: ReturnType<typeof titleBlock>): number {
  const input = headerFitInput({ headWidth, titleBlock: block, metaWidth: META });
  if (input === null) throw new Error("expected a verdict");
  return pickFitLevel(input);
}

describe("chat header — the title keeps its budget", () => {
  test("360 px phone: an 805 px title squeezed to 98 px still claims its capped budget → compact", () => {
    // The defect (audit G5): reading the squeezed block (98 px) left 246 px for a
    // 216 px meta, so the labels stayed and the title shrank to 98 px.
    const block = titleBlock([805], 98);
    expect(headerFitInput({ headWidth: 360, titleBlock: block, metaWidth: META })).toEqual({
      available: 360 - HEADER_TITLE_CAP - HEADER_GAP,
      required: [META],
    });
    expect(level(360, block)).toBe(1);
  });

  test("768 px tablet with the sidebar open (508 px header): compact, the title no longer shrinks to 245 px", () => {
    expect(level(508, titleBlock([805], 245))).toBe(1);
  });

  test("1280 px desktop (1020 px header): full, exactly as before", () => {
    // The title was squeezed to 756 px, above the cap: the old reading reserved the
    // same 360 px, so nothing changes on a desktop header.
    expect(level(1020, titleBlock([805], 756))).toBe(0);
  });

  test("the widest line wins: a long breadcrumb over a short title", () => {
    expect(level(560, titleBlock([300, 120], 120))).toBe(0);
    expect(level(540, titleBlock([340, 120], 120))).toBe(1);
  });

  test("a short title leaves the chips their room", () => {
    expect(level(1020, titleBlock([150], 150))).toBe(0);
  });

  test("no verdict while the meta ghost is not laid out", () => {
    expect(headerFitInput({ headWidth: 360, titleBlock: titleBlock([805], 98), metaWidth: 0 })).toBeNull();
  });
});
