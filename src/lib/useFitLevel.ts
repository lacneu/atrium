import { useLayoutEffect, useRef, useState, type DependencyList } from "react";

// MEASURED, NOT GUESSED. A bar that has to shed detail (labels → icons → …)
// decides on the width its content ACTUALLY needs — read from hidden "ghost"
// renders at natural width — against the width the bar ACTUALLY has, never on a
// fixed breakpoint: translated labels change width (German is far wider than
// French) and a user-resizable column changes the space. The chat header and the
// sidebar's new-chat bar each carried a hand-written copy of this; both now share
// this one decision and this one observer.

/** What a measure reports: the width available, and the width each presentation
 *  needs, most detailed first. */
export interface FitInput {
  available: number;
  required: readonly number[];
}

/** A hysteresis band wider than any classic scrollbar (15 to 17 px: Windows, or
 *  macOS set to always show them), for presentations whose levels differ in HEIGHT
 *  inside a scroller — see `pickFitLevel` (lot 11). */
export const SCROLLBAR_HYSTERESIS = 24;

/** The most detailed presentation that fits: the index of the first `required`
 *  width the available width covers (a tie fits), or `required.length` — the
 *  most compact presentation, which needs no measurement — when none does.
 *
 *  A most-detailed width of 0 means its ghost is not laid out yet (first frame,
 *  hidden ancestor): nothing can be concluded from it, so the most detailed
 *  presentation stays — collapsing on a 0 would flash the compact layout.
 *
 *  `hysteresis` (px): climbing back from `current` to a MORE detailed level takes
 *  that much more than the level needs. For a presentation whose own height moves
 *  the width it gets: a taller level that brings its scroller's scrollbar loses the
 *  scrollbar's width, falls back, the scrollbar goes, the width returns — without
 *  a band at least one scrollbar wide, that repeats every frame (lot 11). */
export function pickFitLevel(
  { available, required }: FitInput,
  current = 0,
  hysteresis = 0,
): number {
  if (required.length === 0 || !(required[0] > 0)) return 0;
  for (let level = 0; level < required.length; level++) {
    const need = level < current ? required[level] + hysteresis : required[level];
    if (available >= need) return level;
  }
  return required.length;
}

/** The natural width of a block whose LINES clip their own overflow (ellipsis):
 *  its widest line's `scrollWidth`. The block's own `scrollWidth` cannot give it —
 *  each line clips what it does not show, so the block only ever reports its
 *  current, already-squeezed width (98 px for an 805 px title at 360 px). */
export function naturalWidthOf(lines: Iterable<{ scrollWidth: number }>): number {
  let width = 0;
  for (const line of lines) width = Math.max(width, line.scrollWidth);
  return width;
}

/** What `createTargetWatch` needs of a ResizeObserver and of a MutationObserver. */
export interface ResizeWatcher {
  observe(target: Element): void;
  disconnect(): void;
}
export interface MutationWatcher {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

/**
 * Keeps the observers on EXACTLY the elements `sync` was last given (lot 12). An
 * observed element that is unmounted and mounted again — the same role, a new
 * node, the hook's dependencies unchanged — is observed afresh and measured at
 * once; the node it replaced is dropped. Subscribing only when the dependencies
 * changed left the observers on a detached node: the composer recovered from a
 * detached draft kept the level of the window it had left.
 */
export function createTargetWatch(
  onChange: () => void,
  content: boolean,
  makeResize: (cb: () => void) => ResizeWatcher = (cb) => new ResizeObserver(cb),
  makeMutation: (cb: () => void) => MutationWatcher = (cb) => new MutationObserver(cb),
) {
  let targets: Element[] = [];
  let observers: Array<ResizeWatcher | MutationWatcher> = [];
  const stop = () => {
    for (const o of observers) o.disconnect();
    observers = [];
  };
  return {
    /** The elements to observe NOW; returns whether the subscription changed. */
    sync(next: ReadonlyArray<Element | null | undefined>): boolean {
      const els = next.filter((el): el is Element => el !== null && el !== undefined);
      if (els.length === targets.length && els.every((el, i) => el === targets[i])) {
        return false;
      }
      stop();
      targets = els;
      if (els.length > 0) {
        const ro = makeResize(onChange);
        for (const el of els) ro.observe(el);
        observers.push(ro);
        // Attributes are left out on purpose: the caller writes the chosen level
        // onto the observed element as attributes, and must not hear its own write.
        if (content) {
          const mo = makeMutation(onChange);
          for (const el of els) {
            mo.observe(el, { childList: true, characterData: true, subtree: true });
          }
          observers.push(mo);
        }
      }
      // A new node is measured at once, not at its first resize.
      onChange();
      return true;
    },
    dispose() {
      stop();
      targets = [];
    },
  };
}

/** The fitting level, re-decided whenever an observed element changes size or a
 *  `deps` value changes (a localized label, a badge…), and whenever an observed
 *  element is a NEW node — compared after every commit, not only when `deps`
 *  change (`createTargetWatch`). `measure` returns null when the DOM cannot be
 *  read yet: the current level then stays — no verdict on a half-mounted tree.
 *  Starts at the most detailed level (0).
 *
 *  The comparison runs after the commits of the component that calls the hook,
 *  so the observed elements are rendered by THAT component: a child remounting
 *  its own element would only be seen at the caller's next commit (held for
 *  every caller by fitTargetsWiring.test.ts).
 *
 *  `content: true` also re-decides when the observed elements' CONTENT changes
 *  (children added or removed, text edited): a bar whose controls render their own
 *  labels (a permission mode's name, a count) changes the width it needs without
 *  changing its own size, so a resize observer alone would never hear of it.
 *
 *  `hysteresis` (px): see `pickFitLevel` — for a presentation whose levels differ
 *  in HEIGHT inside a scroller, so that the level itself adds or removes the
 *  scroller's scrollbar and with it the width measured. */
export function useFitLevel(
  measure: () => FitInput | null,
  observed: () => ReadonlyArray<Element | null | undefined>,
  deps: DependencyList,
  options: { content?: boolean; hysteresis?: number } = {},
): number {
  const content = options.content === true;
  const hysteresis = options.hysteresis ?? 0;
  const [level, setLevel] = useState(0);
  // Read through refs: the observers live across renders, while the closures they
  // call always come from the latest render.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const observedRef = useRef(observed);
  observedRef.current = observed;
  const hysteresisRef = useRef(hysteresis);
  hysteresisRef.current = hysteresis;
  const runRef = useRef(() => {
    const input = measureRef.current();
    if (input === null) return;
    setLevel((prev) => {
      const next = pickFitLevel(input, prev, hysteresisRef.current);
      return prev === next ? prev : next;
    });
  });
  const watchRef = useRef<ReturnType<typeof createTargetWatch> | null>(null);
  // AFTER EVERY COMMIT: the observed elements as they are now. A remounted one
  // (unmounted, mounted again, `deps` unchanged) is observed and measured afresh.
  useLayoutEffect(() => {
    if (watchRef.current === null) {
      watchRef.current = createTargetWatch(() => runRef.current(), content);
    }
    watchRef.current.sync(observedRef.current());
  });
  // A dependency of the measure changed: decide again.
  useLayoutEffect(() => {
    runRef.current();
    // `deps` IS the contract: the caller lists what changes a measured width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, hysteresis]);
  // `content` changes which observers there are: a new watch, made by the next
  // commit; the last one goes on unmount.
  useLayoutEffect(
    () => () => {
      watchRef.current?.dispose();
      watchRef.current = null;
    },
    [content],
  );
  return level;
}
