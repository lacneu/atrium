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
