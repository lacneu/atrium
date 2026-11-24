import { naturalWidthOf, type FitInput } from "@/lib/useFitLevel";

// The chat header's collapse decision (ConvexChat `ChatHeader`). The title is a
// higher priority than the technical chips, so it gets a budget — its NATURAL
// width, capped — and the chips get the remainder. Reserving the natural width
// (not the width the title happens to have) is what keeps the threshold from
// drifting: measured on the squeezed title, the chips' own presence justified
// them (an 805 px title squeezed to 98 px left room for full labels at 360 px).

/** The most the title may reserve before the chips are judged. */
export const HEADER_TITLE_CAP = 360;
/** Space kept between the title block and the chips. */
export const HEADER_GAP = 16;

/** The title block as the header reads it: its lines (breadcrumb, title), each
 *  clipping its own overflow. An `HTMLElement` satisfies it. */
export interface TitleBlock {
  children: ArrayLike<{ scrollWidth: number }>;
}

/** Levels: 0 = full meta (labels, model/reasoning chips), 1 = compact. Null while
 *  the meta ghost is not laid out — the current mode then stays. */
export function headerFitInput(o: {
  headWidth: number;
  titleBlock: TitleBlock;
  metaWidth: number;
}): FitInput | null {
  if (o.metaWidth === 0) return null;
  const titleNatural = naturalWidthOf(Array.from(o.titleBlock.children));
  return {
    available: o.headWidth - Math.min(titleNatural, HEADER_TITLE_CAP) - HEADER_GAP,
    required: [o.metaWidth],
  };
}
