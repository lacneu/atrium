// IS A BLOCK NEAR WHAT THE READER SEES — what decides whether a thought's text is read.
//
// The transcript mounts its whole window (up to 200 messages, no virtualisation) and every
// thought is on view by default: reading each one where it mounts opened thousands of
// subscriptions for rows far off screen, each re-run by every write to its message. So a
// row's reasoning is read only while its block is within one screen of the transcript's
// visible part, above or below.
//
// WHAT IS KEPT, WHAT IS RELEASED. Leaving that neighbourhood releases the SUBSCRIPTION and
// keeps the TEXT last read, still rendered: the block keeps its height, so scrolling back
// moves nothing (the transcript's follow and anchors see no change), and the text is read
// again — a corrected reasoning replaces it — before it can be seen. The cost, declared:
// the text of every thought the reader has scrolled past stays in memory until the
// conversation is left; a reader who walks the whole window holds what 0.104.2 held on
// opening it. The subscriptions, which are what the backend pays for, stay bounded by the
// screen.
//
// A block never read shows one quiet line (ReasoningBlocks.tsx) whatever the reason — not
// near yet, or being read — so nearing it changes nothing until its text is there. That
// growth happens off screen, a screen away; above the reader it is the browser's scroll
// anchoring that holds their place (Chrome, Firefox; not checked in Safari).
//
// No clock and no polling: one IntersectionObserver per scroller, shared by its blocks,
// its margin re-derived from the scroller's height when that changes (a ResizeObserver).
// Where there is none (a server render, an old browser), a block is near: it reads at once.

import { useEffect, useState, type RefObject } from "react";

/** The transcript's scroller (ThreadPrimitive.Viewport, convexChat.css: `overflow-y: auto`). */
const SCROLLER = ".oc-thread__viewport";

/** The observer's margin: one HEIGHT of the scroller above and below its visible part, in
 *  pixels. Never a percentage: a `rootMargin` percentage resolves against the root's WIDTH
 *  on every side (as a CSS margin does), so "100%" on a wide, short transcript reached far
 *  past a screen. */
export function nearMargin(scrollerHeight: number): string {
  return `${Math.max(0, Math.round(scrollerHeight))}px 0px`;
}

type Tell = (near: boolean) => void;

/** What `watchNear` needs of the platform, so the rule is tested without a DOM. */
export type NearObserver = { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void };
export type NearObserverMaker = (
  onChange: (changes: ReadonlyArray<{ target: Element; isIntersecting: boolean }>) => void,
  options: { root: Element | null; rootMargin: string },
) => NearObserver;
/** Calls back when the element's box changes; returns what stops it. */
export type ResizeWatch = (el: Element, onResize: () => void) => () => void;

/** `observer()`: the current one — it is rebuilt when the scroller is resized. */
type Watch = { told: Map<Element, Tell>; observer: () => NearObserver; stop: () => void };
const watchByScroller = new WeakMap<Element, Watch>();
/** Blocks outside any transcript scroller (a detached render) are watched against the page. */
let pageWatch: Watch | undefined;

const platformObserver = (): NearObserverMaker | undefined =>
  typeof IntersectionObserver === "undefined" ? undefined : (onChange, options) => new IntersectionObserver(onChange, options);

const platformResize: ResizeWatch = (el, onResize) => {
  if (typeof ResizeObserver === "undefined") return () => {};
  const ro = new ResizeObserver(onResize);
  ro.observe(el);
  return () => ro.disconnect();
};

/** The height the margin is derived from: the scroller's, or the page's for a block
 *  outside any transcript (read once: nothing there is resized with a transcript). */
function heightOf(root: Element | null): number {
  if (root !== null) return root.clientHeight;
  return typeof window === "undefined" ? 0 : window.innerHeight;
}

/** One observer for a scroller's blocks, rebuilt — same blocks, new margin — whenever the
 *  scroller's height changes (the keyboard, the composer growing, the window): an
 *  observer's margin cannot be changed. */
function openWatch(root: Element | null, make: NearObserverMaker, onResize: ResizeWatch): Watch {
  const told = new Map<Element, Tell>();
  let height = heightOf(root);
  const build = () =>
    make(
      (changes) => {
        for (const c of changes) told.get(c.target)?.(c.isIntersecting);
      },
      { root, rootMargin: nearMargin(height) },
    );
  let observer = build();
  const stopResize =
    root === null
      ? () => {}
      : onResize(root, () => {
          const now = heightOf(root);
          if (now === height) return;
          height = now;
          observer.disconnect();
          observer = build();
          for (const el of told.keys()) observer.observe(el);
        });
  return {
    told,
    stop: () => {
      stopResize();
      observer.disconnect();
    },
    observer: () => observer,
  };
}

/** Tell `tell` whether `el` is near its scroller's visible part, now and on every change.
 *  Returns what stops it. Without an observer the block is near, told once. */
export function watchNear(
  el: Element,
  tell: Tell,
  make: NearObserverMaker | undefined = platformObserver(),
  onResize: ResizeWatch = platformResize,
): () => void {
  if (make === undefined) {
    tell(true);
    return () => {};
  }
  const root = el.closest(SCROLLER);
  let watch = root === null ? pageWatch : watchByScroller.get(root);
  if (watch === undefined) {
    watch = openWatch(root, make, onResize);
    if (root === null) pageWatch = watch;
    else watchByScroller.set(root, watch);
  }
  const w = watch;
  w.told.set(el, tell);
  w.observer().observe(el);
  return () => {
    w.told.delete(el);
    w.observer().unobserve(el);
    if (w.told.size > 0) return;
    w.stop();
    if (root === null) pageWatch = undefined;
    else watchByScroller.delete(root);
  };
}

/** Is the block near what the reader sees. False until the observer says so — true from
 *  the first render where there is no observer. */
export function useNearViewport(block: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = block.current;
    if (el === null) return;
    return watchNear(el, setNear);
  }, [block]);
  return near;
}

/** The read of a row's reasoning: its arguments while the block is near, Convex's "skip"
 *  (no subscription) while it is not. */
export function readWhileNear<Args>(near: boolean, args: Args): Args | "skip" {
  return near ? args : "skip";
}

/** What the block shows, and of WHICH row: what the read returns, else — the read is
 *  skipped, or not back yet — the text last read FOR THAT ROW. A text kept for another row
 *  is never shown: the component of a block is reused when a thought arrives before it
 *  (parts are indexed by position), and would show the other thought's reasoning.
 *  `undefined` only for a row never read. */
export function lastRead<T>(
  row: string,
  result: T | undefined,
  kept: { row: string; value: T } | undefined,
): { row: string; value: T } | undefined {
  if (result !== undefined) return { row, value: result };
  return kept !== undefined && kept.row === row ? kept : undefined;
}
