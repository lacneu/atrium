// "Reply to a block" without hovering (2026-11). The per-block quote lives in a
// gutter that follows the mouse — on a touch screen it never shows. The reply's
// "More actions" menu offers the same choice as a list of the reply's blocks; this
// is that list, from the blocks' rendered text.
import { previewFromText } from "./bookmarkView";
import { QUOTE_EXCERPT_CLIENT_MAX } from "./pendingQuote";

export type QuoteBlockChoice = {
  /** The block's index among the reply's anchor blocks (collectAnchorBlocks). */
  blockIndex: number;
  /** What the chip shows and the prompt quotes — the gutter's own excerpt. */
  excerpt: string;
};

/**
 * One choice per block that has text, in reading order. The index is the block's
 * place among ALL blocks (an image-only block is skipped, not renumbered): it is
 * the anchor the quote — and the jump back to it — resolves.
 */
export function quoteBlockChoices(texts: readonly string[]): QuoteBlockChoice[] {
  const choices: QuoteBlockChoice[] = [];
  texts.forEach((text, blockIndex) => {
    const excerpt = previewFromText(text, QUOTE_EXCERPT_CLIENT_MAX);
    if (excerpt !== "") choices.push({ blockIndex, excerpt });
  });
  return choices;
}

/** Where the focus goes when a block picker closes (BlockPicker). */
export type PickerFocus = "composer" | "trigger" | "message" | null;

/**
 * A quote goes on to the reply being written: the composer. Anything else goes
 * back where it came from: the reply's ⋯. On a computer, though, an older reply's
 * action bar unmounts as soon as the pointer leaves the message — the ⋯ is gone by
 * the time the list closes, and Radix then drops the focus on the page (lot 11):
 * the reply itself takes it, and failing that the composer.
 */
export function pickerCloseFocus(o: {
  quotePicked: boolean;
  composer: boolean;
  trigger: boolean;
  message: boolean;
}): PickerFocus {
  if (o.quotePicked && o.composer) return "composer";
  if (o.trigger) return "trigger";
  if (o.message) return "message";
  return o.composer ? "composer" : null;
}
