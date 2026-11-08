// "Reply to a block" without hovering (2026-11). The per-block quote lives in a
// gutter that follows the mouse — on a touch screen it never shows. The reply's
// "More actions" menu offers the same choice as a list of the reply's blocks; this
// is that list, from the blocks' rendered text.
//
// Lot 21: a delegation's answer is shown as ONE answer across consecutive bubbles,
// and only its last bubble has a ⋯. Its lists offer the blocks of EVERY bubble of
// the answer, in reading order, each naming its own bubble — what the gutter of each
// bubble offers a mouse, nothing more, nothing less (`blockOffer`, shared).
import { previewFromText, type BlockFace } from "./bookmarkView";
import { QUOTE_EXCERPT_CLIENT_MAX } from "./pendingQuote";

/** "quote": the pick goes on to the reply being written. "bookmark": the pick
 *  toggles the block's bookmark — a block already marked loses it. */
export type BlockListKind = "quote" | "bookmark";

/**
 * What the gutter offers on one block, and so what the lists offer: a quote when the
 * block has text (a quote IS its text — the gutter's own excerpt), a bookmark when it
 * shows anything — text, or media, named by its alt text ("" when it has none). A
 * rule or an empty block offers nothing.
 */
export function blockOffer(face: BlockFace): { quote: string; label: string } | null {
  const quote = previewFromText(face.text, QUOTE_EXCERPT_CLIENT_MAX);
  if (quote !== "") return { quote, label: quote };
  if (face.media) return { quote: "", label: previewFromText(face.alt, QUOTE_EXCERPT_CLIENT_MAX) };
  return null;
}

export type BlockChoice = {
  /** The bubble the block belongs to: in a grouped answer, each names its own. */
  messageId: string;
  /** The block's index among its bubble's anchor blocks (collectAnchorBlocks). */
  blockIndex: number;
  /** What a quote quotes: the gutter's own excerpt ("" for a block without text). */
  excerpt: string;
  /** What the row shows: the excerpt, or the media's alt text ("" when it has none). */
  label: string;
};

/**
 * One choice per block the gutter offers for that action, bubble after bubble, in
 * reading order. The index is the block's place among ALL its bubble's blocks (a
 * block offering nothing is skipped, not renumbered): it is the anchor the quote, the
 * bookmark and the jump back resolve.
 */
export function blockChoices(
  bubbles: ReadonlyArray<{ messageId: string; faces: readonly BlockFace[] }>,
  kind: BlockListKind,
): BlockChoice[] {
  const choices: BlockChoice[] = [];
  for (const { messageId, faces } of bubbles) {
    faces.forEach((face, blockIndex) => {
      const offer = blockOffer(face);
      if (offer === null || (kind === "quote" && offer.quote === "")) return;
      choices.push({ messageId, blockIndex, excerpt: offer.quote, label: offer.label });
    });
  }
  return choices;
}

/** A display group's member, in reading order, and whether it is still being written. */
export type GroupMember = { id: string; live: boolean };

/**
 * The bubbles a reply's lists read: the settled members of its display group when it
 * closes one — its ⋯ is the group's only one —, itself when alone and settled, none
 * while it is being written. A bubble still being written offers nothing: its gutter
 * is off while it streams, its blocks still move.
 */
export function listSources(
  messageId: string,
  live: boolean,
  members: readonly GroupMember[] | null,
): string[] {
  if (members === null) return live ? [] : [messageId];
  return members.filter((member) => !member.live).map((member) => member.id);
}

/** A block across bubbles: the key a list's bookmarked set holds. */
export const blockKey = (messageId: string, blockIndex: number) => `${messageId}#${blockIndex}`;

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
