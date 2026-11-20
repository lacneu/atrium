// THE RESERVE UNDER THE QUEUED CARDS FOLLOWS ITSELF (lot 29), AND GIVES WAY TO THE
// READER (lot 30) — TO NO ONE ELSE (lot 31).
//
// The queued cards float over the end of the transcript, and the transcript keeps a
// reserve of their height below its last message (`--oc-dock-pad`, QueuedDock.tsx), so
// that the end of the reply is followed ABOVE them. Since lot 28 that reserve is the
// transcript's bottom spacer — content, not padding — and assistant-ui's follow no
// longer sees it grow: it listens to the viewport's own box (a ResizeObserver, which
// a spacer leaves unchanged) and to its DOM (a MutationObserver that ignores a `style`
// write — and the reserve is one). When no text arrives afterwards (a tool running, the
// agent thinking), the end of the reply stayed under the frosted cards.
//
// So the reserve follows itself, only while the reader is at the end (assistant-ui's
// `isAtBottom`): at once — under reduced motion the spacer has no transition —, then on
// every frame of the spacer's transition, and once after it. Each frame is an INSTANT
// scroll to the end, the spacer's own transition being the motion. Never a smooth one:
// a smooth scroll under way swallows the reader's wheel, touch and scrollbar (measured
// in Chrome), and outlives the follow's stop. And never through assistant-ui's
// `scrollToBottom` (lot 29): that plants assistant-ui's own bottom intent, which a scroll
// up clears only while the content's height holds still — never during the transition —
// so the next text brought the reader back to the end.
//
// The follow stops for good, and never scrolls again, as soon as the reader takes the
// scroll up (lot 30, pass 19) — up only: it holds them at the end, where nothing goes
// further down. Before each frame's scroll, at the first of:
//   - a pointer or a touch on the transcript (its scrollbar included), a wheel up on it;
//   - a key the browser answers by scrolling the transcript up — PageUp, ArrowUp (with
//     any modifier: Cmd+ArrowUp goes to the top on a Mac), Home, Shift+Space — with the
//     focus in the transcript (not in a field, Space not on a control it presses) or on
//     the page itself (the browser then scrolls the scroller last pressed in); a key
//     toward the end is the follow's own way;
//   - the focus landing in the transcript on an element not wholly in view (a screen
//     reader, Tab, a script): the browser scrolls it into view;
//   - any move up already made that neither the follow nor the layout made (a script,
//     an assistive technology, find in page): the transcript above where the follow
//     left it — further than what the content lost at its end pulled it, by more than a
//     pixel of rounding (lot 33) —, short of its end, with the layout as it was then — its
//     content's height, the reserve aside, and its box (lot 32);
//   - assistant-ui reading the reader away from the end;
//   - the app, before it scrolls the transcript itself (`stopReserveFollow`): a SMOOTH
//     scroll shows no move before the follow's next frame, whose instant scroll cancels
//     it (measured in Chrome). A smooth scroll from outside the app (an extension, a
//     smooth find in page) within the follow's window is taken back: nothing announces
//     it.
// What the layout moves is no one's move (lots 31-32, passes 20-21). The end shrinking (a
// widget reporting a smaller height, a block that folds, an image replaced), the
// transcript's box growing (the composer cleared by a send, the keyboard closing, a banner
// leaving, the header folding), the browser's scroll anchoring: each pulls the scroll up
// WITH the end, at the end — and before anyone looks, the reserve (whose transition Chrome
// advances at the start of a frame) or other content may have grown below. From where it
// all ends, that cannot be told from another's move: the same position, the same height.
// So a move up is another's only if the layout has not moved since the follow left the
// transcript at its end; once it has, the move is the layout's, and the follow takes it
// back to the end at once, in its listener on the document (the capture phase: ahead of
// assistant-ui's own listener on the transcript), so that assistant-ui too reads the
// reader at the end — else it reads them away from it, the follow stops on its word, and
// the next text no longer follows them. What this costs, declared: a move another makes
// in the same interval as a change of the layout is taken back, and so is one no further
// than a pixel past what the content lost at its end (lot 33: the scroll height is a
// whole number); and two changes that exactly cancel out within one interval (a block
// folding while another grows as much) are no change: the pull of the first is read as
// another's move, and the follow stops.
// Its window is the clock's (lots 32-33): the reserve's transition, its delay and 100 ms,
// from the follow's first frame — Chrome starts a transition on the frame after the change
// of style (measured), however late a long task makes that frame —, and never longer:
// once frames come, it lasts that long by the clock from the first of them. Past it, a
// late frame (a long task, a hidden tab) lands once at most, then stops — in the scroll
// event Chrome dispatches first on that frame, before the frame's callbacks, or in the
// frame's step: only short of the end, and only if no one has moved the transcript since
// the follow left it, or if the layout has moved since (its pull, taken back as within
// the window: else assistant-ui reads it as the reader's own move up). Another's move
// down, the layout held, keeps its position. What the clock costs, declared (lot 33),
// measured in Chrome with its scroll anchoring off: a late frame after a long task can run
// on a stale transition clock, and the reserve's last growth then lands after the window.
// Without scroll anchoring, the end of the reply stays under the cards until the next
// text, the reader still read at the end (Chrome's own anchoring keeps the end there). Not
// checked in Safari.
// The reader's position is the one they chose. assistant-ui, which holds no intent of
// the follow's, reads them away from the end on their own scroll (`isAtBottom` false),
// so the next text does not bring them back either. A reader who pressed without
// scrolling is still at the end for assistant-ui: the next text follows them there.

/** What the follow needs of assistant-ui's thread viewport store. */
export type ViewportFollowStore = {
  getState(): { isAtBottom: boolean };
};

/** The longest of a computed `transition-duration` / `transition-delay` list, in ms. */
export function longestTimeMs(list: string): number {
  let max = 0;
  for (const part of list.split(",")) {
    const t = part.trim();
    const v = parseFloat(t);
    if (!Number.isFinite(v)) continue;
    max = Math.max(max, t.endsWith("ms") ? v : v * 1000);
  }
  return max;
}

// Where a key edits rather than scrolls.
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
// What Space presses rather than scrolls.
const PRESSED_BY_SPACE =
  "button, summary, [role='button'], [role='checkbox'], [role='switch'], [role='radio'], [role='tab'], [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']";

/** Whether the browser answers this key by scrolling the transcript UP: PageUp, ArrowUp,
 *  Home or Shift+Space, with the focus in the transcript — not in a field, Space not on a
 *  control it presses — or on the page itself, where the browser scrolls the scroller
 *  the reader last pressed in. */
export function keyScrollsTranscriptUp(
  e: { key: string; shiftKey: boolean; target: EventTarget | null },
  viewport: HTMLElement,
): boolean {
  const space = e.key === " ";
  if (!(e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home" || (space && e.shiftKey))) return false;
  const node = e.target as Node | null;
  if (node === null || node.nodeType !== 1) return false;
  const el = node as Element;
  const doc = viewport.ownerDocument;
  if (el === doc.body || el === doc.documentElement) return true;
  if (!viewport.contains(el)) return false;
  if (el.closest(EDITABLE) !== null) return false;
  return !(space && el.closest(PRESSED_BY_SPACE) !== null);
}

/** Whether the browser scrolls the transcript to show what the focus lands on: an
 *  element not wholly inside its box. */
export function focusScrollsTranscript(target: EventTarget | null, viewport: HTMLElement): boolean {
  const node = target as Node | null;
  if (node === null || node.nodeType !== 1 || node === viewport) return false;
  const r = (node as Element).getBoundingClientRect();
  const v = viewport.getBoundingClientRect();
  return r.top < v.top - 0.5 || r.bottom > v.bottom + 0.5;
}

// The follow under way on each transcript, so that the app can end it before scrolling
// the transcript itself.
const running = new WeakMap<HTMLElement, () => void>();

/** Ends the follow under way on this transcript, if any: the app is about to scroll it
 *  (to a bookmark, a request, a sub-agent's message, a linked message). A smooth scroll
 *  shows no move before the follow's next frame (measured in Chrome), whose instant
 *  scroll to the end would cancel it: the follow can only be told. */
export function stopReserveFollow(viewport: HTMLElement | null): void {
  if (viewport !== null) running.get(viewport)?.();
}

/** Follows the end of the transcript while its reserve changes; returns the stop. */
export function followReserve(viewport: HTMLElement, store: ViewportFollowStore): () => void {
  running.get(viewport)?.();
  const doc = viewport.ownerDocument;
  const win = doc.defaultView ?? window;
  // The spacer's own transition, as the stylesheet sets it (none under reduced motion); a
  // live declaration, whose height is the spacer's at each read.
  const after = win.getComputedStyle(viewport, "::after");
  // The follow's window (lots 32-33): the spacer's transition, its delay and 100 ms, from
  // the follow's first frame — where Chrome starts the transition, however late a long task
  // makes that frame — and never longer: once frames come, it lasts that long by the clock
  // from the first of them, however late the next ones come (pass 21). Until that first
  // frame, it is open.
  const span = longestTimeMs(after.transitionDuration) + longestTimeMs(after.transitionDelay) + 100;
  let until = Infinity;
  const reserve = () => parseFloat(after.height) || 0;
  const short = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  // The content's height, the reserve aside.
  const content = () => viewport.scrollHeight - reserve();
  let frame = 0;
  let stopped = false;
  // Where the follow last left the transcript at its end — or its end, wherever the end
  // has gone since — and the layout then: the content's height, the reserve aside, and
  // the transcript's box.
  let left = 0;
  let contentThen = 0;
  let boxThen = 0;
  const mark = () => {
    left = viewport.scrollTop;
    contentThen = content();
    boxThen = viewport.clientHeight;
  };
  mark();
  // The layout as the follow left it: its content within a pixel (the scroll height is a
  // whole number, the reserve's height is not), and its box.
  const layoutHeld = () => Math.abs(content() - contentThen) <= 1 && viewport.clientHeight === boxThen;
  // Another's move up (lots 32-33): short of the end, the layout as the follow left it,
  // and further up than what the content lost at the end pulled the scroll, by more than a
  // pixel — the pull and the loss as it is read, each off a whole scroll height, differ by
  // less than one. From where it ends, a pull of the layout followed by content that grows
  // cannot be told from another's move — the same position, the same height: once the
  // layout has moved, the move is the layout's, and taken back.
  const movedUpByOther = () => {
    if (short() <= 1) {
      mark();
      return false;
    }
    return layoutHeld() && left - viewport.scrollTop > Math.max(0, contentThen - content()) + 1;
  };
  const toEnd = () => {
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    mark();
  };
  const onKey = (e: KeyboardEvent) => {
    if (keyScrollsTranscriptUp(e, viewport)) stop();
  };
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) stop();
  };
  const onFocus = (e: FocusEvent) => {
    if (focusScrollsTranscript(e.target, viewport)) stop();
  };
  // Past the window (lots 32-33), on a frame that comes late — a long task, a hidden tab —,
  // in the scroll event Chrome dispatches first on it or in the frame's step: one landing
  // at most, then the stop. Only short of the end, and unless another has moved the
  // transcript down, the layout held: that keeps its position. Anything else is the
  // layout's — another's move up was told apart before this is called —, and taken back
  // as within the window, else assistant-ui reads it as the reader's own move up: no one
  // having moved, the layout having moved, or (lot 35) a pull within what "held" allows,
  // a pixel of content lost at the end, which leaves the transcript above where the
  // follow left it with the layout read as held.
  const lastLanding = () => {
    if (short() > 1 && !(layoutHeld() && viewport.scrollTop > left)) toEnd();
    stop();
  };
  // A scroll of the transcript: another's move up stops the follow; within the window, any
  // other scroll that leaves it short of its end is taken back at once, before assistant-ui
  // reads it; past the window, the last landing.
  const onScroll = (e: Event) => {
    if (e.target !== viewport) return;
    if (movedUpByOther()) stop();
    else if (win.performance.now() >= until) lastLanding();
    else if (short() > 1) toEnd();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (running.get(viewport) === stop) running.delete(viewport);
    win.cancelAnimationFrame(frame);
    viewport.removeEventListener("pointerdown", stop);
    viewport.removeEventListener("touchstart", stop);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("focusin", onFocus);
    doc.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("keydown", onKey, true);
  };
  // The first step runs at once: a reader who is not at the end is asked nothing. The
  // window is the clock's, not the frames' (lots 32-33): past it, the last landing.
  const step = () => {
    if (stopped) return;
    if (!store.getState().isAtBottom || movedUpByOther()) {
      stop();
      return;
    }
    if (win.performance.now() >= until) {
      lastLanding();
      return;
    }
    toEnd();
    frame = win.requestAnimationFrame(onFrame);
  };
  // A frame of the follow's: the first opens its window.
  const onFrame = () => {
    if (until === Infinity) until = win.performance.now() + span;
    step();
  };
  viewport.addEventListener("pointerdown", stop, { passive: true });
  viewport.addEventListener("touchstart", stop, { passive: true });
  viewport.addEventListener("wheel", onWheel, { passive: true });
  viewport.addEventListener("focusin", onFocus);
  // Capture, on the document: before every listener on the transcript, assistant-ui's
  // included (a scroll of an element does not bubble; its capture phase runs all the same).
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  // Capture: before the key reaches what it is pressed on, whatever stops it there.
  doc.addEventListener("keydown", onKey, true);
  running.set(viewport, stop);
  step();
  return stop;
}
