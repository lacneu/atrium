// The virtual keyboard where the browser does not make room for it (lot 8, G15,
// 2026-11). Chrome on Android honours `interactive-widget=resizes-content`
// (index.html): the layout viewport shrinks with the keyboard and `100dvh` follows.
// iOS Safari does not: the keyboard covers the bottom of the page — the composer,
// a dialog's buttons — and only the VISUAL viewport shrinks. `--oc-kb` is the height
// it covers, read off `window.visualViewport`, for the layouts sized on the screen
// (the shell, the full-page prompt, dialogs) to subtract. 0 wherever there is
// nothing to subtract, so nothing changes there.
//
// THE VISIBLE PART IS A RECTANGLE (lot 19). To reveal a field the keyboard would
// hide, iOS also scrolls the visual viewport down the layout one (`offsetTop`):
// what is on screen then runs from `--oc-vv-top` to the keyboard. A layer that
// only stayed above the keyboard kept its top in the layout viewport — a 596 px
// dialog began at 16 px when the screen showed from 120 px on, its title and its
// close button out of sight. Both edges are written, and the layers fit between.
//
// ITS LEFT EDGE TOO (lot 25). A page wider than the screen can be panned sideways
// (`offsetLeft`): a dialog centred on the layout viewport then sits off what is
// shown. `--oc-vv-left` is how far right what is shown begins.

/**
 * The height the keyboard covers at the bottom of the layout viewport. A zoomed
 * visual viewport (pinch, scale > 1) is the reader zooming, not a keyboard: 0.
 * Android's resized layout leaves nothing between the two heights: 0 as well.
 */
export function keyboardInset(
  layoutHeight: number,
  visualHeight: number,
  visualOffsetTop: number,
  scale: number,
): number {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.round(layoutHeight - visualHeight - visualOffsetTop));
}

/**
 * How far down the layout viewport what is on screen begins: the visual viewport's
 * `offsetTop`, scrolled there by iOS to reveal a field. A zoomed visual viewport is
 * the reader zooming and panning, not a page to fit: 0, as for the keyboard.
 */
export function visibleTopInset(visualOffsetTop: number, scale: number): number {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.round(visualOffsetTop));
}

/**
 * How far right along the layout viewport what is on screen begins: the visual
 * viewport's `offsetLeft`, panned there on a page wider than the screen. A zoomed
 * visual viewport is the reader zooming and panning: 0, as for the top.
 */
export function visibleLeftInset(visualOffsetLeft: number, scale: number): number {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.round(visualOffsetLeft));
}

/** Keeps `--oc-kb`, `--oc-vv-top` and `--oc-vv-left` on <html> in step with the
 *  visual viewport. Returns its undo. */
export function installKeyboardInset(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const root = win.document.documentElement;
  let last = "";
  const update = () => {
    const bottom = keyboardInset(win.innerHeight, vv.height, vv.offsetTop, vv.scale);
    const top = visibleTopInset(vv.offsetTop, vv.scale);
    const left = visibleLeftInset(vv.offsetLeft, vv.scale);
    const key = `${top}/${bottom}/${left}`;
    if (key === last) return;
    last = key;
    root.style.setProperty("--oc-kb", `${bottom}px`);
    root.style.setProperty("--oc-vv-top", `${top}px`);
    root.style.setProperty("--oc-vv-left", `${left}px`);
  };
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    root.style.removeProperty("--oc-kb");
    root.style.removeProperty("--oc-vv-top");
    root.style.removeProperty("--oc-vv-left");
  };
}
