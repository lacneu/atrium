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

/** The most detailed presentation that fits: the index of the first `required`
 *  width the available width covers (a tie fits), or `required.length` — the
 *  most compact presentation, which needs no measurement — when none does.
 *
 *  A most-detailed width of 0 means its ghost is not laid out yet (first frame,
 *  hidden ancestor): nothing can be concluded from it, so the most detailed
 *  presentation stays — collapsing on a 0 would flash the compact layout. */
export function pickFitLevel({ available, required }: FitInput): number {
  if (required.length === 0 || !(required[0] > 0)) return 0;
  for (let level = 0; level < required.length; level++) {
    if (available >= required[level]) return level;
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

/** The fitting level, re-decided whenever an observed element changes size or a
 *  `deps` value changes (a localized label, a badge…). `measure` returns null when
 *  the DOM cannot be read yet: the current level then stays — no verdict on a
 *  half-mounted tree. Starts at the most detailed level (0).
 *
 *  `content: true` also re-decides when the observed elements' CONTENT changes
 *  (children added or removed, text edited): a bar whose controls render their own
 *  labels (a permission mode's name, a count) changes the width it needs without
 *  changing its own size, so a resize observer alone would never hear of it. */
export function useFitLevel(
  measure: () => FitInput | null,
  observed: () => ReadonlyArray<Element | null | undefined>,
  deps: DependencyList,
  options: { content?: boolean } = {},
): number {
  const content = options.content === true;
  const [level, setLevel] = useState(0);
  // Read through refs: the effect subscribes once per `deps` change, while the
  // closures it calls always come from the latest render.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const observedRef = useRef(observed);
  observedRef.current = observed;
  useLayoutEffect(() => {
    const run = () => {
      const input = measureRef.current();
      if (input === null) return;
      const next = pickFitLevel(input);
      setLevel((prev) => (prev === next ? prev : next));
    };
    run();
    const targets = observedRef
      .current()
      .filter((el): el is Element => el !== null && el !== undefined);
    if (targets.length === 0) return;
    const ro = new ResizeObserver(run);
    for (const el of targets) ro.observe(el);
    // Attributes are left out on purpose: the caller writes the chosen level onto
    // the observed element as attributes, and must not hear its own write.
    const mo = content ? new MutationObserver(run) : null;
    if (mo !== null) {
      for (const el of targets) {
        mo.observe(el, { childList: true, characterData: true, subtree: true });
      }
    }
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
    // `deps` IS the contract: the caller lists what changes a measured width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, content]);
  return level;
}
