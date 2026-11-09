// THE RESERVE UNDER THE QUEUED CARDS FOLLOWS ITSELF (lot 29).
//
// The queued cards float over the end of the transcript, and the transcript keeps a
// reserve of their height below its last message (`--oc-dock-pad`, QueuedDock.tsx), so
// that the end of the reply is followed ABOVE them. Since lot 28 that reserve is the
// transcript's bottom spacer — content, not padding — and assistant-ui's follow no
// longer sees it grow: it listens to the viewport's own box (a ResizeObserver, which
// a spacer leaves unchanged) and to its DOM (a MutationObserver that ignores a `style`
// write — and the reserve is one). Before, the padding changed the viewport's content
// box on every frame of its transition, and the follow caught up frame by frame; with
// the spacer, when no text arrives afterwards (a tool running, the agent thinking), the
// end of the reply stayed under the frosted cards.
//
// So the reserve asks for the follow itself, through assistant-ui's own API (the
// thread's viewport store, the one its "latest messages" button uses), and only while
// the reader is at the end: at once — under reduced motion the spacer has no
// transition —, then on every frame of the spacer's transition, and once after it. It
// stops as soon as the reader takes the scroll (a pointer, a wheel, a touch).

/** What the follow needs of assistant-ui's thread viewport store. */
export type ViewportFollowStore = {
  getState(): { isAtBottom: boolean; scrollToBottom: (config?: { behavior?: ScrollBehavior }) => void };
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

/** Follows the end of the transcript while its reserve changes; returns the stop. */
export function followReserve(viewport: HTMLElement, store: ViewportFollowStore): () => void {
  if (!store.getState().isAtBottom) return () => {};
  const win = viewport.ownerDocument.defaultView ?? window;
  // The spacer's own transition, as the stylesheet sets it (none under reduced motion).
  const after = win.getComputedStyle(viewport, "::after");
  const until =
    win.performance.now() + longestTimeMs(after.transitionDuration) + longestTimeMs(after.transitionDelay) + 100;
  let frame = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    win.cancelAnimationFrame(frame);
    for (const type of ["pointerdown", "wheel", "touchstart"]) viewport.removeEventListener(type, stop);
  };
  const step = () => {
    if (stopped) return;
    if (!store.getState().isAtBottom) {
      stop();
      return;
    }
    store.getState().scrollToBottom();
    if (win.performance.now() < until) frame = win.requestAnimationFrame(step);
    else stop();
  };
  for (const type of ["pointerdown", "wheel", "touchstart"]) viewport.addEventListener(type, stop, { passive: true });
  step();
  return stop;
}
