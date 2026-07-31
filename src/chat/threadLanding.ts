// Where a conversation LANDS when it opens, and how it gets there.
//
// The symptom, reported by the user: opening a chat scrolls visibly from the first
// message all the way down to the last one. The cause is one CSS line —
// `.oc-thread__viewport { scroll-behavior: smooth }` — which exists for a good reason
// (queue drains and merges land in bursts, and an instant jump per event judders) but
// applies to the INITIAL positioning too, turning a jump into a guided tour of the whole
// history.
//
// So the rule is not "remove smooth", it is "smooth follows, instant landing":
//
//   * the landing is instant and INVISIBLE — the viewport is faded out while it happens,
//     so the user never sees the position being taken, only the result;
//   * smooth comes back for everything that follows, which is what it was added for;
//   * the fade is the "transition douce" that was asked for — an opacity change on an
//     already-positioned viewport, never a scroll animation.
//
// The landing is re-applied until the thread STOPS GROWING. A single positioning at mount
// is not enough: images, code blocks and markdown hydrate after first paint, each changing
// `scrollHeight`, and assistant-ui re-runs its own auto-scroll on every one of them. Pin
// once and the first image push the thread off the mark.

import type { BookmarkView } from "./bookmarkView";

/** Where the thread should sit when a conversation opens. */
export type LandingTarget =
  | { kind: "bookmark"; messageId: string; blockIndex: number | null }
  | { kind: "bottom" };

/**
 * Choose the landing point.
 *
 * A bookmark wins when there is one — a product decision (2026-07-31): a bookmark is
 * treated as "where I left off", so opening resumes there. `createdAt`, not thread order:
 * the most recently PLACED mark is the working position, and the one furthest down the
 * thread is usually near the bottom anyway, where the default already lands.
 *
 * Ties on `createdAt` fall back to the later entry, so two marks placed in the same
 * millisecond still resolve deterministically instead of depending on query order.
 */
export function chooseLanding(
  bookmarks: readonly BookmarkView[],
): LandingTarget {
  let best: BookmarkView | null = null;
  for (const b of bookmarks) {
    if (best === null || b.createdAt >= best.createdAt) best = b;
  }
  return best === null
    ? { kind: "bottom" }
    : { kind: "bookmark", messageId: best.messageId, blockIndex: best.blockIndex };
}

/** How long the landing keeps re-applying before giving up and revealing anyway.
 *
 *  A ceiling, not a duration: the landing normally ends when the thread stops growing,
 *  usually within a few frames. This exists so a conversation whose content never settles
 *  (a broken image retrying, a stream that started immediately) cannot leave the viewport
 *  faded out — an invisible thread is a worse failure than a visible jump. */
export const LANDING_DEADLINE_MS = 1200;

/** Consecutive stable measurements before the thread is considered settled. */
export const LANDING_STABLE_FRAMES = 3;

/**
 * Track whether the thread has stopped growing.
 *
 * Pure, so the decision is testable without a DOM: feed it the measured `scrollHeight` on
 * each frame and it says whether the landing may be released. Height going UP means new
 * content arrived and the count restarts; an unchanged height for `LANDING_STABLE_FRAMES`
 * frames means hydration is done.
 */
export class SettleDetector {
  private last = -1;
  private stable = 0;

  /** @returns true once the height has held steady long enough. */
  observe(scrollHeight: number): boolean {
    if (scrollHeight !== this.last) {
      this.last = scrollHeight;
      this.stable = 0;
      return false;
    }
    this.stable += 1;
    return this.stable >= LANDING_STABLE_FRAMES;
  }
}

/**
 * The scroll position that puts `target` where it belongs, or null to leave it alone.
 *
 * Extracted from the DOM work so the arithmetic is checkable. A bookmark sits 30% down the
 * viewport — the same placement `focusAnchor` uses when jumping to one, so landing on a
 * mark and clicking it in the rail put it in the same place. The bottom pin is the whole
 * remaining scroll, which is what "the last message" means when the last bubble is taller
 * than the viewport.
 */
export function landingScrollTop(input: {
  kind: "bookmark" | "bottom";
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Distance from the viewport top to the target's top, for a bookmark. */
  anchorDelta?: number;
}): number | null {
  if (input.kind === "bottom") {
    return Math.max(0, input.scrollHeight - input.clientHeight);
  }
  if (input.anchorDelta === undefined) return null;
  const offset = Math.max(24, input.clientHeight * 0.3);
  return Math.max(0, input.scrollTop + input.anchorDelta - offset);
}

/**
 * Take the landing position without the user seeing it happen.
 *
 * Returns a cancel function. Call on chat open; the caller marks the viewport with
 * `data-oc-landing` first, which is what turns the smooth scroll off and fades the thread
 * out (see `convexChat.css`). The mark is removed here — on settle, on deadline, or on
 * cancel — so no path can leave a thread invisible.
 *
 * The scroll is applied on the VIEWPORT only. `scrollIntoView` walks up the DOM and drags
 * every scrollable ancestor with it; that lesson cost a bug in the sub-agent panel and is
 * repeated in `focusAnchor` for the same reason.
 */
export function landThread(
  viewport: HTMLElement,
  target: LandingTarget,
  now: () => number = () => performance.now(),
): () => void {
  const started = now();
  const settle = new SettleDetector();
  let raf = 0;
  let done = false;

  const release = (): void => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    viewport.removeAttribute("data-oc-landing");
  };

  const anchorDelta = (): number | undefined => {
    if (target.kind !== "bookmark") return undefined;
    const bubble = viewport.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(target.messageId)}"]`,
    );
    if (!bubble) return undefined;
    const el =
      target.blockIndex === null
        ? bubble
        : (bubble.querySelector<HTMLElement>(
            `[data-block-index="${target.blockIndex}"]`,
          ) ?? bubble);
    return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  };

  const frame = (): void => {
    if (done) return;
    const top = landingScrollTop({
      kind: target.kind,
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      anchorDelta: anchorDelta(),
    });
    // `null` means a bookmark whose bubble has not mounted: keep waiting rather than
    // jumping to a guessed position, and let the deadline reveal the thread if it never
    // arrives (a bookmark on a message that was deleted upstream).
    if (top !== null) viewport.scrollTop = top;

    const settled = top !== null && settle.observe(viewport.scrollHeight);
    if (settled || now() - started >= LANDING_DEADLINE_MS) {
      release();
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);
  return release;
}
