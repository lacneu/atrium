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

/** What a fit remembers from one measure to the next (lots 13, 14). */
export interface FitMemory {
  /** How many levels the measure had: another number, and the indices below
   *  name other presentations — everything is forgotten. */
  readonly levels: number;
  /** For each level MORE detailed than the current one: the width it needed when
   *  the fit left it, read in the wider presentation then on screen. */
  readonly locked: ReadonlyArray<number | undefined>;
  /** For each locked level: the current presentation's own reading of its width,
   *  the last time it was compared. Forgotten at every change of level — another
   *  presentation reads another number. */
  readonly seen: ReadonlyArray<number | undefined>;
  /** The locks were read for the content now on screen: true only when they come
   *  from a climb the wider presentation refused at once, and as long as this
   *  presentation's readings do not move. */
  readonly verified: boolean;
  /** The last move was a climb: if the next decision — taken in the wider
   *  presentation — leaves it again, the width it reads is the content's own. */
  readonly climbed: boolean;
}

/** A fit that has measured nothing yet. */
export const FRESH_FIT: FitMemory = { levels: 0, locked: [], seen: [], verified: false, climbed: false };

/** Less than this between two readings of the same presentation is layout noise
 *  (sub-pixel rounding), not a content change. */
const READING_NOISE = 0.5;

/**
 * The level to show, with a LOCKED hysteresis (lots 13, 14). A measure taken in a
 * compact presentation may depend on that presentation — a clone that inherits
 * the stacked layout reads narrower than the table it measures, and the table
 * and the stacked rows then called each other for ever. So a level, once left
 * because it no longer fit, keeps the width it needed THEN, read in the wider
 * presentation it was leaving; the fit climbs back to it only when the space
 * covers that width plus `hysteresis` — the compact presentation's own reading
 * counts too (the larger of the two is taken).
 *
 * A lock is only TRUSTED once verified for the content on screen (lot 14): the
 * need can drop between the decision and the compact render — a smaller text
 * size applied by a passive effect — or later, while the compact presentation is
 * shown. An unverified lock never refuses a climb the readings allow: the fit
 * climbs, and the wider presentation's own reading — taken at once, in the same
 * task, before anything is painted (`createFitController`) — either keeps the
 * climb or sends it straight back with a lock now verified. A verified lock stays
 * verified until the compact presentation's readings move, i.e. the content
 * changes. A loop is impossible: at a given width and content there is at most
 * one such probe, and it ends verified.
 */
export function decideFitLevel(
  input: FitInput,
  current: number,
  hysteresis: number,
  memory: FitMemory,
): { level: number; memory: FitMemory } {
  const { available, required } = input;
  // Nothing laid out yet (pickFitLevel): the most detailed level, nothing kept.
  if (required.length === 0 || !(required[0] > 0)) return { level: 0, memory: FRESH_FIT };
  const same = memory.levels === required.length;
  const locked = same ? [...memory.locked] : [];
  const seen = same ? [...memory.seen] : [];
  let verified = same && memory.verified;
  // The content moved under this presentation: its readings of the locked levels
  // changed, and the locks — read for the content as it was — are verified no more.
  for (let l = 0; l < Math.min(current, required.length); l++) {
    if (locked[l] === undefined) continue;
    const before = seen[l];
    if (before === undefined) {
      seen[l] = required[l];
    } else if (Math.abs(required[l] - before) > READING_NOISE) {
      seen[l] = required[l];
      verified = false;
    }
  }
  let level = required.length;
  for (let l = 0; l < required.length; l++) {
    const need =
      l < current ? Math.max(required[l], locked[l] ?? required[l]) + hysteresis : required[l];
    if (available >= need) {
      level = l;
      break;
    }
  }
  // A climb the readings allow but an unverified lock refuses: climb, and let the
  // wider presentation's reading decide (it is taken before anything is painted).
  if (level >= current && !verified) {
    for (let l = 0; l < current; l++) {
      if (available >= required[l] + hysteresis) {
        level = l;
        break;
      }
    }
  }
  if (level > current) {
    // Leaving the levels [current, level): each keeps what it needs, read NOW —
    // in the widest presentation of the move, the one still on screen. Right
    // after a climb, that reading is the content's own: verified.
    for (let l = current; l < level; l++) locked[l] = required[l];
    verified = same && memory.climbed;
  } else if (level < current) {
    // Back on `level`: it and the levels below it hold no lock any more.
    locked.length = level;
    verified = false;
  }
  if (level !== current) seen.length = 0;
  return {
    level,
    memory: { levels: required.length, locked, seen, verified, climbed: level < current },
  };
}

/**
 * The fit's decisions, separated from React (lot 13). A decision is taken only
 * on a reading of the presentation actually on screen: between a change of level
 * and its render, every reading would still be of the previous one, so measures
 * wait for `shown` — which measures at once, so that a move is checked in the
 * presentation it chose and that presentation's readings start from there. The
 * hook calls `shown` from a layout effect: a move decided there (a climb the
 * wider presentation refuses) is rendered before the browser paints — the
 * refused climb is never seen.
 */
export function createFitController(onLevel: (level: number) => void) {
  let decided = 0;
  let onScreen = 0;
  let memory: FitMemory = FRESH_FIT;
  const measure = (read: () => FitInput | null, hysteresis: number) => {
    if (decided !== onScreen) return;
    const input = read();
    if (input === null) return;
    const next = decideFitLevel(input, decided, hysteresis, memory);
    memory = next.memory;
    if (next.level !== decided) {
      decided = next.level;
      onLevel(decided);
    }
  };
  return {
    measure,
    /** The DOM now shows `level`: measure in it. */
    shown(level: number, read: () => FitInput | null, hysteresis: number) {
      onScreen = level;
      measure(read, hysteresis);
    },
  };
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
  takeRecords(): unknown[];
}

/** What changes a measured content without changing its box (lot 14): nodes added
 *  or removed, text edited, a class or `hidden` switched (a button turning into a
 *  spinner, an action appearing). Other attributes are left out on purpose: the
 *  callers write the chosen level as `data-*` attributes and must not hear their
 *  own write, and inline styles animate (a live audio meter) without changing what
 *  is measured. */
export const CONTENT_CHANGES: MutationObserverInit = {
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "hidden"],
};

/**
 * Keeps the observers on EXACTLY the elements `sync` was last given (lot 12). An
 * observed element that is unmounted and mounted again — the same role, a new
 * node, the hook's dependencies unchanged — is observed afresh and measured at
 * once; the node it replaced is dropped. Subscribing only when the dependencies
 * changed left the observers on a detached node: the composer recovered from a
 * detached draft kept the level of the window it had left.
 *
 * It listens to their CONTENT as well as their size, for every fit (lot 14): an
 * action appearing in a row (an agent file's "Review the proposal") changes the
 * width the row needs, not the list's box, and neither an observer of sizes nor
 * the caller's dependencies heard of it. `drain` drops what was recorded so far:
 * the measure's own clone, inserted and removed inside an observed element, is
 * not a change of the content.
 */
export function createTargetWatch(
  onChange: () => void,
  makeResize: (cb: () => void) => ResizeWatcher = (cb) => new ResizeObserver(cb),
  makeMutation: (cb: () => void) => MutationWatcher = (cb) => new MutationObserver(cb),
) {
  let targets: Element[] = [];
  let resize: ResizeWatcher | null = null;
  let mutation: MutationWatcher | null = null;
  const stop = () => {
    resize?.disconnect();
    mutation?.disconnect();
    resize = null;
    mutation = null;
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
        resize = ro;
        const mo = makeMutation(onChange);
        for (const el of els) mo.observe(el, CONTENT_CHANGES);
        mutation = mo;
      }
      // A new node is measured at once, not at its first resize.
      onChange();
      return true;
    },
    /** Forgets the content changes recorded so far (the measure's own clone). */
    drain() {
      mutation?.takeRecords();
    },
    dispose() {
      stop();
      targets = [];
    },
  };
}

/** What the restyle hub reads of the page (the browser's, or a test's). */
export interface RestyleEnv {
  /** Calls back with the names of the root element's attributes that changed. */
  watchRoot(cb: (attributes: ReadonlyArray<string | null>) => void): () => void;
  /** The root element's computed font size. */
  fontSize(): string;
  /** Calls back when web fonts have finished loading. */
  watchFonts(cb: () => void): () => void;
}

/**
 * Every fit measures again when the page restyles what it measures without
 * touching it (lot 14): the root's font size (the text-size preference — 14 px
 * where it was 16), its classes and language (a theme, a locale), web fonts
 * finishing to load. A width then changes inside boxes that keep their size: no
 * observer of the measured elements hears of it. The root's inline style also
 * carries the keyboard's height: only a change of the font size counts there.
 */
export function createRestyleHub(env: () => RestyleEnv | null) {
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const fire = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (stop === null) {
        const page = env();
        if (page !== null) {
          let size = page.fontSize();
          const offRoot = page.watchRoot((attributes) => {
            const now = page.fontSize();
            const resized = now !== size;
            size = now;
            if (resized || attributes.some((a) => a !== "style")) fire();
          });
          const offFonts = page.watchFonts(fire);
          stop = () => {
            offRoot();
            offFonts();
          };
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop !== null) {
          stop();
          stop = null;
        }
      };
    },
  };
}

const browserRestyle = (): RestyleEnv | null =>
  typeof document === "undefined"
    ? null
    : {
        watchRoot(cb) {
          const mo = new MutationObserver((records) => cb(records.map((r) => r.attributeName)));
          mo.observe(document.documentElement, { attributes: true });
          return () => mo.disconnect();
        },
        fontSize: () => getComputedStyle(document.documentElement).fontSize,
        watchFonts(cb) {
          const fonts = document.fonts;
          if (fonts === undefined || typeof fonts.addEventListener !== "function") return () => {};
          fonts.addEventListener("loadingdone", cb);
          return () => fonts.removeEventListener("loadingdone", cb);
        },
      };

/** The page's restyles, shared by every fit. */
const RESTYLE = createRestyleHub(browserRestyle);

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
 *  It also re-decides, for every caller, when the observed elements' CONTENT
 *  changes (children added or removed, text edited, a class switched) and when the
 *  page restyles them (text size, theme, locale, web fonts): a width changes
 *  inside boxes that keep their size, and neither a resize observer nor `deps`
 *  hear of it (lot 14; the composer alone did, before). What is measured must
 *  therefore sit inside what is observed (held by fitTargetsWiring.test.ts).
 *
 *  A level left because it no longer fit is climbed back to only when the space
 *  covers the width it needed when left, read in that wider presentation
 *  (`decideFitLevel`, the locked hysteresis): a reading taken in the compact
 *  presentation can never call the wider one back by itself.
 *
 *  `hysteresis` (px): the band added to that climb — for a presentation whose
 *  levels differ in HEIGHT inside a scroller, so that the level itself adds or
 *  removes the scroller's scrollbar and with it the width AVAILABLE. */
export function useFitLevel(
  measure: () => FitInput | null,
  observed: () => ReadonlyArray<Element | null | undefined>,
  deps: DependencyList,
  options: { hysteresis?: number } = {},
): number {
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
  // The decisions and what they remember (the locked hysteresis): one controller
  // for the hook's whole life.
  const controllerRef = useRef<ReturnType<typeof createFitController> | null>(null);
  if (controllerRef.current === null) controllerRef.current = createFitController(setLevel);
  const controller = controllerRef.current;
  const watchRef = useRef<ReturnType<typeof createTargetWatch> | null>(null);
  // A measure, then the content changes it recorded itself (its clone) dropped.
  const readRef = useRef(() => {
    const input = measureRef.current();
    watchRef.current?.drain();
    return input;
  });
  const runRef = useRef(() => controller.measure(readRef.current, hysteresisRef.current));
  // The level on screen: the controller measures in it before anything else does.
  useLayoutEffect(() => {
    controller.shown(level, readRef.current, hysteresisRef.current);
  }, [controller, level]);
  // AFTER EVERY COMMIT: the observed elements as they are now. A remounted one
  // (unmounted, mounted again, `deps` unchanged) is observed and measured afresh.
  useLayoutEffect(() => {
    if (watchRef.current === null) {
      watchRef.current = createTargetWatch(() => runRef.current());
    }
    watchRef.current.sync(observedRef.current());
  });
  // The page restyled what is measured (text size, theme, web fonts): again.
  useLayoutEffect(() => RESTYLE.subscribe(() => runRef.current()), []);
  // A dependency of the measure changed: decide again.
  useLayoutEffect(() => {
    runRef.current();
    // `deps` IS the contract: the caller lists what changes a measured width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, hysteresis]);
  // The watch goes on unmount (a new one is made by the next commit, if any).
  useLayoutEffect(
    () => () => {
      watchRef.current?.dispose();
      watchRef.current = null;
    },
    [],
  );
  return level;
}
