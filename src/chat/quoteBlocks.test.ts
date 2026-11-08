// "Reply to a block…" lists the reply's blocks (quoteBlocks.ts): what each row
// quotes, and which anchor it points back to.
import { describe, expect, test } from "vitest";
import { QUOTE_EXCERPT_CLIENT_MAX } from "./pendingQuote";
import { pickerFocusOrder, quoteBlockChoices } from "./quoteBlocks";

describe("the blocks a reply offers to quote", () => {
  test("one choice per block with text, in reading order", () => {
    expect(quoteBlockChoices(["Premier.", "Deuxième.", "Troisième."])).toEqual([
      { blockIndex: 0, excerpt: "Premier." },
      { blockIndex: 1, excerpt: "Deuxième." },
      { blockIndex: 2, excerpt: "Troisième." },
    ]);
  });

  test("a block without text is skipped, NOT renumbered: the index is its anchor", () => {
    expect(quoteBlockChoices(["Avant.", "   \n ", "Après."])).toEqual([
      { blockIndex: 0, excerpt: "Avant." },
      { blockIndex: 2, excerpt: "Après." },
    ]);
  });

  test("the excerpt is the gutter's own: whitespace collapsed, cut at a word", () => {
    const long = Array.from({ length: 80 }, (_, i) => `mot${i}`).join("  \n ");
    const [choice] = quoteBlockChoices([long]);
    expect(choice.excerpt.endsWith("…")).toBe(true);
    expect(Array.from(choice.excerpt).length).toBeLessThanOrEqual(QUOTE_EXCERPT_CLIENT_MAX + 1);
    expect(choice.excerpt).not.toMatch(/\s{2,}/);
  });
});

describe("the one fallback both block pickers give the focus back by (lot 12)", () => {
  test("the reply's ⋯, the reply itself, then the composer", () => {
    expect(pickerFocusOrder(false)).toEqual(["trigger", "message", "composer"]);
  });

  test("a quote picked asks the composer first, then the same fallback", () => {
    expect(pickerFocusOrder(true)).toEqual(["composer", ...pickerFocusOrder(false)]);
  });

  test("the reply before the composer: a composer can be disabled, the reply cannot", () => {
    const order = pickerFocusOrder(false);
    expect(order.indexOf("message")).toBeLessThan(order.indexOf("composer"));
  });
});
