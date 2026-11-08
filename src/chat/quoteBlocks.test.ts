// "Reply to a block…" lists the reply's blocks (quoteBlocks.ts): what each row
// quotes, and which anchor it points back to.
import { describe, expect, test } from "vitest";
import { QUOTE_EXCERPT_CLIENT_MAX } from "./pendingQuote";
import { pickerCloseFocus, quoteBlockChoices } from "./quoteBlocks";

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

describe("where the focus goes when a block picker closes (lot 11)", () => {
  const all = { composer: true, trigger: true, message: true };

  test("a quote picked goes on to the reply being written", () => {
    expect(pickerCloseFocus({ ...all, quotePicked: true })).toBe("composer");
  });

  test("anything else goes back to the reply's ⋯", () => {
    expect(pickerCloseFocus({ ...all, quotePicked: false })).toBe("trigger");
  });

  test("an older reply's ⋯ gone with its action bar: the reply itself", () => {
    expect(pickerCloseFocus({ ...all, quotePicked: false, trigger: false })).toBe("message");
  });

  test("nothing of the reply left: the composer, never the page", () => {
    expect(
      pickerCloseFocus({ quotePicked: false, composer: true, trigger: false, message: false }),
    ).toBe("composer");
  });
});
