// THE TOP BAR FITS THE SCREEN (lot 26). It held the sidebar toggle, the brand
// (logo and label), the search and the account (bell, then the person's name or
// e-mail, never shortened, in a button that never shrank): with a real name the
// page ran wider than a 360 px phone even at the default text size, and under the
// largest text scale with the fallback label too. Chrome then lays the page out
// wider than the screen — every fixed layer placed against that wider page —, lets
// it pan sideways, and may zoom it out whole. The bar now sheds detail, measured
// like the chat header and the composer (useFitLevel), never on a breakpoint: the
// label is a person's, of any length, in any locale.
//
//   full  the brand's label and the account's name;
//   logo  the brand's logo alone (its label goes, when there is a logo), the
//         account's name shortened down to a floor (7em: where the clone measures it);
//   icon  the account as its icon, named by the label (`aria-label`, `title`).
//
// The bar's own width is what it has (the header spans the shell: no feedback
// from the level it shows); the width each presentation needs is read on a DOM
// clone of the live bar, laid out off-screen at its natural width
// (measureCloneWidths): every control is rendered under every presentation, the
// CSS shows the one `data-fit` names.

/** The top bar's presentations, most detailed first (useFitLevel's order): its
 *  `data-fit`. Each bar measures the clone of itself under each but the last
 *  (measureCloneWidths, in the component: fitProbeIsolation.test.ts). */
export const TOP_BAR_FITS = ["full", "logo", "icon"] as const;
export type TopBarFit = (typeof TOP_BAR_FITS)[number];

/** The drawer's head: its brand only (the close button is an icon). */
export const DRAWER_HEAD_FITS = ["full", "logo"] as const;
export type DrawerHeadFit = (typeof DRAWER_HEAD_FITS)[number];
