// WHEN THE SIDEBAR IS A DRAWER — the one global layout breakpoint of the app, and
// the only fixed one: it decides whether there is room for a column at all, which a
// toolbar's measured fit cannot (Olivier's arbitration, 2026-11):
//
//   width < 768 px  OR  (height < 500 px AND a coarse primary pointer)
//
// Width alone sent a phone held in landscape (844 × 390, 932 × 430) to the desktop
// layout: a 260 px column in the flow, and 187 to 227 px of conversation. The height
// clause catches it; the pointer clause keeps a desktop window that is merely short
// in the desktop layout.
//
// The same short-and-coarse screen also gets the SHORT layout: the top bar becomes a
// vertical rail, because on a phone in landscape every pixel of height went to bars
// (the thread was 157 px tall at 740 × 360) while width was left over.

export const DRAWER_MAX_WIDTH = 767;
export const SHORT_MAX_HEIGHT = 499;

/** A phone in landscape: short, and driven by a finger. */
export const SHORT_SCREEN_QUERY = `(max-height: ${SHORT_MAX_HEIGHT}px) and (pointer: coarse)`;

/** The drawer layout, as one media query list (a comma is an OR). */
export const DRAWER_QUERY = `(max-width: ${DRAWER_MAX_WIDTH}px), ${SHORT_SCREEN_QUERY}`;

export interface ScreenFacts {
  width: number;
  height: number;
  /** The primary pointer is coarse (`(pointer: coarse)`). */
  coarse: boolean;
}

/** The short layout: what SHORT_SCREEN_QUERY matches. */
export function isShortScreen({ height, coarse }: Pick<ScreenFacts, "height" | "coarse">): boolean {
  return coarse && height <= SHORT_MAX_HEIGHT;
}

/** The drawer layout: what DRAWER_QUERY matches. */
export function isDrawerLayout(facts: ScreenFacts): boolean {
  return facts.width <= DRAWER_MAX_WIDTH || isShortScreen(facts);
}
