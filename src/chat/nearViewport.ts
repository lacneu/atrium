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
// No clock and no polling: one IntersectionObserver per scroller, shared by its blocks.
// Where there is none (a server render, an old browser), a block is near: it reads at once.

import { useEffect, useState, type RefObject } from "react";

/** The transcript's scroller (ThreadPrimitive.Viewport, convexChat.css: `overflow-y: auto`). */
const SCROLLER = ".oc-thread__viewport";

/** One height of the scroller above and below its visible part. */
export const NEAR_MARGIN = "100% 0px";

type Tell = (near: boolean) => void;

/** What `watchNear` needs of the platform's observer, so the rule is tested without a DOM. */
export type NearObserver = { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void };
export type NearObserverMaker = (
  onChange: (changes: ReadonlyArray<{ target: Element; isIntersecting: boolean }>) => void,
  options: { root: Element | null; rootMargin: string },
) => NearObserver;

type Watch = { observer: NearObserver; told: Map<Element, Tell> };
const watchByScroller = new WeakMap<Element, Watch>();
/** Blocks outside any transcript scroller (a detached render) are watched against the page. */
let pageWatch: Watch | undefined;

const platformObserver = (): NearObserverMaker | undefined =>
  typeof IntersectionObserver === "undefined" ? undefined : (onChange, options) => new IntersectionObserver(onChange, options);

/** Tell `tell` whether `el` is near its scroller's visible part, now and on every change.
 *  Returns what stops it. Without an observer the block is near, told once. */
export function watchNear(el: Element, tell: Tell, make: NearObserverMaker | undefined = platformObserver()): () => void {
  if (make === undefined) {
    tell(true);
    return () => {};
  }
  const root = el.closest(SCROLLER);
  let watch = root === null ? pageWatch : watchByScroller.get(root);
  if (watch === undefined) {
    const told = new Map<Element, Tell>();
    watch = {
      told,
      observer: make(
        (changes) => {
          for (const c of changes) told.get(c.target)?.(c.isIntersecting);
        },
        { root, rootMargin: NEAR_MARGIN },
      ),
    };
    if (root === null) pageWatch = watch;
    else watchByScroller.set(root, watch);
  }
  const { observer, told } = watch;
  told.set(el, tell);
  observer.observe(el);
  return () => {
    told.delete(el);
    observer.unobserve(el);
    if (told.size > 0) return;
    observer.disconnect();
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

/** What the block shows: what the read returns, else — the read is skipped, or not back
 *  yet — the text last read. `undefined` only for a block never read. */
export function lastRead<T>(result: T | undefined, kept: T | undefined): T | undefined {
  return result !== undefined ? result : kept;
}
