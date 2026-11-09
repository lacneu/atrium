// Bring the ACTIVE item of a horizontally scrolling bar into view (a tab bar that
// is wider than the screen). Only the bar itself scrolls: `scrollIntoView` would
// also move the page or the thread around it, so the offset is computed here and
// written to the bar's own `scrollLeft`. Left-to-right layouts.

/** The scroll offset that brings an item fully into a scroller's view, moving as
 *  little as possible; null when it is already fully in view. `margin` keeps a
 *  sliver of the neighbour visible so the reader sees there is more to scroll. All
 *  positions are in the scroller's content coordinates. */
export function revealOffset(o: {
  scrollStart: number;
  viewSize: number;
  itemStart: number;
  itemSize: number;
  margin?: number;
  maxScroll?: number;
}): number | null {
  const margin = o.margin ?? 0;
  const itemEnd = o.itemStart + o.itemSize;
  if (o.itemStart >= o.scrollStart && itemEnd <= o.scrollStart + o.viewSize) return null;
  // An item wider than the view, or one hidden before the start, aligns its start.
  const next =
    o.itemStart < o.scrollStart || o.itemSize + 2 * margin >= o.viewSize
      ? o.itemStart - margin
      : itemEnd + margin - o.viewSize;
  return Math.max(0, Math.min(o.maxScroll ?? Number.POSITIVE_INFINITY, next));
}

/** Reveal, in `scroller`, the item a focus moved to (lot 26): the arrow keys or Tab
 *  walk a scrolling bar, and an item they landed on past its edge was read without
 *  being seen — the browser scrolls a focused element into view only when none of
 *  it shows, and a controlled list's active item follows the focus late, or never.
 *  `target` is the focus event's target; `itemSelector`, the bar's items. */
export function revealFocusIn(
  scroller: HTMLElement,
  target: EventTarget | null,
  itemSelector: string,
): void {
  const el = target as Element | null;
  if (el === null || typeof el.closest !== "function") return;
  const item = el.closest(itemSelector);
  if (item !== null && scroller.contains(item)) revealInline(scroller, item);
}

/** Scroll `scroller` horizontally so that `item` is fully visible. */
export function revealInline(
  scroller: HTMLElement,
  item: Element | null | undefined,
  margin = 12,
): void {
  if (!item) return;
  const s = scroller.getBoundingClientRect();
  const i = item.getBoundingClientRect();
  const next = revealOffset({
    scrollStart: scroller.scrollLeft,
    viewSize: scroller.clientWidth,
    itemStart: i.left - s.left - scroller.clientLeft + scroller.scrollLeft,
    itemSize: i.width,
    margin,
    maxScroll: scroller.scrollWidth - scroller.clientWidth,
  });
  if (next !== null) scroller.scrollLeft = next;
}
