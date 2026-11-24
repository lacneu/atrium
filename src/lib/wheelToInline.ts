// A vertical mouse wheel over a horizontal tab row that overflows (lot 10,
// decided 2026-11). The row hides its scrollbar: where scrollbars always show
// (Windows, or macOS set so) the bar took its height inside the row's 32 px and
// squashed the tabs. A mouse WITHOUT a trackpad then lost its only way to reach
// the hidden tabs, so its wheel now scrolls the row sideways — only while the row
// can still move that way: at either end the wheel goes back to the page, whose
// scroll is never trapped. A trackpad's sideways swipe and Shift+wheel arrive
// horizontal and stay native; ctrl+wheel (a pinch) is the reader zooming.

export type WheelInput = {
  deltaX: number;
  deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  ctrlKey: boolean;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

/** One line of wheel in pixels (Firefox counts a mouse wheel in lines). */
export const WHEEL_LINE_PX = 16;

/** The row's new `scrollLeft` for this wheel, or null to leave the event alone. */
export function wheelToInline(w: WheelInput): number | null {
  if (w.ctrlKey) return null;
  if (Math.abs(w.deltaY) <= Math.abs(w.deltaX)) return null;
  const max = w.scrollWidth - w.clientWidth;
  if (max < 1) return null;
  const step =
    w.deltaMode === 1
      ? w.deltaY * WHEEL_LINE_PX
      : w.deltaMode === 2
        ? w.deltaY * w.clientWidth
        : w.deltaY;
  if (step < 0 && w.scrollLeft < 0.5) return null;
  if (step > 0 && w.scrollLeft > max - 0.5) return null;
  return Math.max(0, Math.min(max, w.scrollLeft + step));
}
