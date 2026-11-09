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
//
// A PAGE WIDER THAN THE SCREEN IS NO KEYBOARD (lot 26). Chrome lays such a page out
// in a LAYOUT viewport grown to it, the screen's proportions kept (442 x 909 for a
// 360 x 740 phone), while the initial containing block — `100vw`, `100dvh`,
// `documentElement.clientHeight` — stays the screen's. Read off the layout viewport,
// the keyboard was 169 px with none open, and the shell shrank by it. Two heights
// now: the KEYBOARD (`--oc-kb`), off the initial containing block — what the shell
// and the layers' room give up; and what lies BELOW what is shown in the layout
// viewport (`--oc-vv-bottom`) — where a fixed layer's bottom edge stands, the
// keyboard plus whatever a grown layout viewport adds. And nothing fires when that
// viewport grows or shrinks: every event that may come with it reads again, and a
// fixed sentinel that spans it is observed — never a value left from before.

/**
 * The height the keyboard covers, from the height of the initial containing block
 * (`documentElement.clientHeight`: the screen's, never a layout viewport grown by
 * a page wider than the screen). A zoomed visual viewport (pinch, scale > 1) is the
 * reader zooming, not a keyboard: 0. Android's resized layout leaves nothing
 * between the two heights: 0 as well.
 */
export function keyboardInset(
  screenHeight: number,
  visualHeight: number,
  visualOffsetTop: number,
  scale: number,
): number {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.round(screenHeight - visualHeight - visualOffsetTop));
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

/**
 * How far up from the bottom of the LAYOUT viewport what is on screen ends: where
 * a fixed layer's bottom edge stands (lot 26). The keyboard's height where the
 * layout viewport is the screen's; more where a page wider than the screen grew it
 * (a side sheet anchored at its bottom ran 169 px under the screen). Rounded up: a
 * bottom edge stands at the bottom of what is shown or above it, never a fraction of
 * a pixel below. A zoomed visual viewport is the reader zooming: 0.
 */
export function visibleBottomInset(
  layoutHeight: number,
  visualHeight: number,
  visualOffsetTop: number,
  scale: number,
): number {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.ceil(layoutHeight - visualHeight - visualOffsetTop - 0.01));
}

/** The sentinel's style: the layout viewport itself, invisible and inert. Set
 *  property by property: nothing outside the stylesheets writes `cssText`
 *  (touchType.test.ts). */
const SENTINEL_STYLE = {
  position: "fixed",
  inset: "0",
  visibility: "hidden",
  pointerEvents: "none",
  zIndex: "-1",
} as const;

/** Keeps `--oc-kb`, `--oc-vv-top`, `--oc-vv-left` and `--oc-vv-bottom` on <html> in
 *  step with the visual viewport and the layout viewport. Returns its undo. */
export function installKeyboardInset(win: Window & typeof globalThis = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const doc = win.document;
  const root = doc.documentElement;
  // The sentinel spans the layout viewport: observed, it says when that viewport
  // grows or shrinks, and its box gives its height to the fraction (`innerHeight` is
  // rounded: a bottom edge stood 0.7 px under the screen).
  let sentinel: HTMLElement | null = null;
  if (typeof win.ResizeObserver === "function" && doc.body !== null) {
    sentinel = doc.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.setAttribute("data-viewport-sentinel", "");
    Object.assign(sentinel.style, SENTINEL_STYLE);
    doc.body.appendChild(sentinel);
  }
  const layoutHeight = () => {
    const h = sentinel?.getBoundingClientRect?.().height;
    return h !== undefined && h > 0 ? h : win.innerHeight;
  };
  let last = "";
  const update = () => {
    const bottom = keyboardInset(root.clientHeight, vv.height, vv.offsetTop, vv.scale);
    const top = visibleTopInset(vv.offsetTop, vv.scale);
    const left = visibleLeftInset(vv.offsetLeft, vv.scale);
    const below = visibleBottomInset(layoutHeight(), vv.height, vv.offsetTop, vv.scale);
    const key = `${top}/${bottom}/${left}/${below}`;
    if (key === last) return;
    last = key;
    root.style.setProperty("--oc-kb", `${bottom}px`);
    root.style.setProperty("--oc-vv-top", `${top}px`);
    root.style.setProperty("--oc-vv-left", `${left}px`);
    root.style.setProperty("--oc-vv-bottom", `${below}px`);
  };
  update();
  // The text scale changed (the root's font size): the page widens or narrows
  // with it, and again once its measured bars have shed or regained detail — read
  // now, and once more after that has settled.
  const rescaled = () => {
    update();
    win.setTimeout(update, 0);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  win.addEventListener("resize", update);
  doc.addEventListener("focusin", update);
  doc.addEventListener("focusout", update);
  let fontSize = win.getComputedStyle(root).fontSize;
  const scaleWatch =
    typeof win.MutationObserver === "function"
      ? new win.MutationObserver(() => {
          // The inset's own writes land on the same `style` attribute: only a
          // change of the font size counts.
          const now = win.getComputedStyle(root).fontSize;
          if (now === fontSize) return;
          fontSize = now;
          rescaled();
        })
      : null;
  scaleWatch?.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  let sizeWatch: ResizeObserver | null = null;
  if (sentinel !== null) {
    sizeWatch = new win.ResizeObserver(update);
    sizeWatch.observe(sentinel);
  }
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    win.removeEventListener("resize", update);
    doc.removeEventListener("focusin", update);
    doc.removeEventListener("focusout", update);
    scaleWatch?.disconnect();
    sizeWatch?.disconnect();
    sentinel?.remove();
    root.style.removeProperty("--oc-kb");
    root.style.removeProperty("--oc-vv-top");
    root.style.removeProperty("--oc-vv-left");
    root.style.removeProperty("--oc-vv-bottom");
  };
}

/** What is on screen, in the layout viewport's coordinates (where a fixed box is
 *  placed): the visual viewport — the initial containing block when the reader
 *  zooms (then they pan, nothing chases them). */
export function visibleRect(win: Window = window): { x: number; y: number; w: number; h: number } {
  const vv = win.visualViewport;
  // No visual viewport (an old browser): the screen, as the initial containing
  // block reads it — or the window's own size.
  const root = win.document?.documentElement;
  if (!vv || vv.scale > 1.01) {
    return { x: 0, y: 0, w: root?.clientWidth || win.innerWidth, h: root?.clientHeight || win.innerHeight };
  }
  return {
    x: Math.max(0, Math.round(vv.offsetLeft)),
    y: Math.max(0, Math.round(vv.offsetTop)),
    w: Math.round(vv.width),
    h: Math.round(vv.height),
  };
}
