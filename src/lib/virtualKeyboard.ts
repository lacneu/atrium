// The virtual keyboard where the browser does not make room for it (lot 8, G15,
// 2026-11). Chrome on Android honours `interactive-widget=resizes-content`
// (index.html): the layout viewport shrinks with the keyboard and `100dvh` follows.
// iOS Safari does not: the keyboard covers the bottom of the page — the composer,
// a dialog's buttons — and only the VISUAL viewport shrinks. `--oc-kb` is the height
// it covers, read off `window.visualViewport`, for the layouts sized on the screen
// (the shell, the full-page prompt, dialogs) to subtract. 0 wherever there is
// nothing to subtract, so nothing changes there.

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

/** Keeps `--oc-kb` on <html> in step with the visual viewport. Returns its undo. */
export function installKeyboardInset(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const root = win.document.documentElement;
  let last = -1;
  const update = () => {
    const inset = keyboardInset(win.innerHeight, vv.height, vv.offsetTop, vv.scale);
    if (inset === last) return;
    last = inset;
    root.style.setProperty("--oc-kb", `${inset}px`);
  };
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    root.style.removeProperty("--oc-kb");
  };
}
