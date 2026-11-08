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

/** Who may take the focus back when a block picker closes (BlockPicker). */
export type PickerFocusCandidate = "composer" | "trigger" | "message";

/**
 * The ONE fallback both pickers ("Bookmark a block…", "Reply to a block…") give
 * the focus back by, in this order: the reply's ⋯ — where the list came from —,
 * the reply itself, then the composer. On a computer an older reply's action bar
 * unmounts as soon as the pointer leaves the message, so the ⋯ is often gone by
 * the time the list closes (lot 11). The reply is the resort that is always
 * safe: it is on the page whatever the chat's state, and takes the focus for this
 * one time. The composer comes after it, asked only when the reply cannot take
 * the focus: a read-only chat or an unavailable bridge disables the field, and a
 * disabled field never takes it (lot 12).
 */
const PICKER_FOCUS_FALLBACK: readonly PickerFocusCandidate[] = [
  "trigger",
  "message",
  "composer",
];

/**
 * The candidates in the order they are offered the focus (`focusFirst`). A quote
 * picked goes on to the reply being written: the composer is asked first — and
 * when it cannot take the focus, the same fallback as any other close follows.
 */
export function pickerFocusOrder(quotePicked: boolean): PickerFocusCandidate[] {
  return quotePicked
    ? ["composer", ...PICKER_FOCUS_FALLBACK]
    : [...PICKER_FOCUS_FALLBACK];
}
