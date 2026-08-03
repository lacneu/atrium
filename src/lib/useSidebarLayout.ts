import { useCallback, useEffect, useRef, useState } from "react";

// Layout primitives shared by the resizable columns (left sidebar + right Sources
// panel) so there is ONE drag/clamp/persist implementation and ONE mobile
// breakpoint — the charte-consistency the design asks for.

const WIDTH_KEY = "oc.sidebar.width";
const COLLAPSED_KEY = "oc.sidebar.collapsed";
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 260;
// Single source of truth for the mobile breakpoint (CSS keys off classes toggled
// from this — see AuthenticatedChrome — so JS and CSS never disagree at 1px).
const MOBILE_QUERY = "(max-width: 767px)";

/** Reactive `(max-width: 767px)` — the one mobile breakpoint, shared. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(
    () =>
      typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export interface ResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Which edge carries the drag handle. "left" column → handle on its RIGHT
   *  edge (drag right = wider); "right" column → handle on its LEFT edge (drag
   *  left = wider). Determines the delta sign. */
  edge: "left" | "right";
  /** Optional viewport-relative ceiling: the effective max becomes
   *  min(max, viewportWidth × fraction), re-read at every clamp — a large
   *  screen can open the column wide while a remembered width still fits
   *  after the window shrinks. */
  maxViewportFraction?: number;
  /** Room-aware ceiling for what gets DRAWN, never for what gets stored. The
   *  persistent panel yields when the conversation beside it would be crushed,
   *  but the width the reader set must survive a narrow moment — widening the
   *  window has to give it back. Applied to the drag's start value and to every
   *  imperative paint; the persisted value stays whatever the reader chose. */
  fit?: (w: number) => number;
}

/** SAME KEY, SAME WIDTH — across every live instance of the hook.
 *
 *  `localStorage` persists a width but does not tell the other instances in this
 *  tab that it changed: each one reads the key once, at mount. Two surfaces
 *  sharing a key therefore drifted apart — the persistent panel, mounted with
 *  the chrome long before anything is pinned, kept showing the width the column
 *  had when the app started, while the reader had since resized it. A width the
 *  user set is not "remembered" if only one of the two places knows about it. */
const widthListeners = new Map<string, Set<(w: number) => void>>();
function publishWidth(storageKey: string, width: number, self: (w: number) => void) {
  const set = widthListeners.get(storageKey);
  if (set === undefined) return;
  for (const fn of [...set]) if (fn !== self) fn(width);
}

/** A localStorage-persisted, pointer-resizable column width.
 *
 *  Perf contract: when the consumer binds `columnRef` to its column element,
 *  the DRAG paints the width straight onto that element inside
 *  requestAnimationFrame (no React state per pointermove — a per-pixel
 *  setState re-renders the whole chrome and stutters); React state + the
 *  localStorage persist commit ONCE on pointerup. Without the ref it falls
 *  back to reactive per-move updates. */
export function useResizableWidth(opts: ResizableWidthOptions) {
  const { storageKey, defaultWidth, min, max, edge, maxViewportFraction } = opts;
  const fit = opts.fit ?? ((w: number) => w);
  // Read through a ref: the drag closes over it once, and a room change during
  // the drag must be honoured without restarting the gesture.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // WHAT THE READER CHOSE, bounded only by this column's own limits. A viewport
  // ceiling is a fact about the window, not a preference, and it used to be
  // written back: a 1200px document column became 720px in a small window and
  // STAYED 720px once the window grew again. The preference is stored; the
  // window only decides what is drawn.
  const clampStored = useCallback(
    (w: number) => Math.min(max, Math.max(min, w)),
    [min, max],
  );
  const [wanted, setWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(storageKey));
    return clampStored(raw || defaultWidth);
  });
  // Re-derives the drawn width when the window changes, WITHOUT touching what is
  // stored.
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const clamp = useCallback(
    (w: number) => {
      const vpMax =
        maxViewportFraction !== undefined
          ? Math.round(viewportW * maxViewportFraction)
          : Infinity;
      const effMax = Math.max(min, Math.min(max, vpMax));
      return Math.min(effMax, Math.max(min, w));
    },
    [min, max, maxViewportFraction, viewportW],
  );
  // Same reason as `fitRef`: the drag closes over the clamp once, and a window
  // resize mid-gesture must be honoured without restarting it.
  const clampRef = useRef(clamp);
  clampRef.current = clamp;
  // The live preference, readable from inside a gesture that closed over the
  // render it started in.
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  /** The width a gesture is currently proposing, for the case where no column
   *  element is bound and the paint has to go through React. Transient by
   *  construction: it never reaches `wanted`, so it never reaches storage — a
   *  drag that is still in progress has not asked for anything yet. */
  const [proposed, setProposed] = useState<number | null>(null);
  /** What actually gets painted: the preference (or the live proposal), brought
   *  inside the window's ceiling and the room the layout has left. */
  const width = fit(clamp(proposed ?? wanted));
  // The write and the broadcast are one act: whoever else is showing a column
  // under this key follows immediately, in this tab, without a remount.
  const selfRef = useRef<(w: number) => void>(() => {});
  useEffect(() => {
    localStorage.setItem(storageKey, String(wanted));
    publishWidth(storageKey, wanted, selfRef.current);
  }, [storageKey, wanted]);
  /** Settle a width NOW, without waiting for a render.
   *
   *  A gesture can end because the component is going away — a navigation, an
   *  identity swap, anything that unmounts mid-drag. `setWidth` on a component
   *  React will never render again never reaches the persist effect: the width
   *  the reader had just dragged to was silently dropped, the twin column kept
   *  the old one, and the panel snapped back at the next mount. Writing and
   *  publishing here makes the outcome independent of one more render. */
  const commitWidth = useCallback(
    (w: number) => {
      localStorage.setItem(storageKey, String(w));
      publishWidth(storageKey, w, selfRef.current);
      setWidth(w);
    },
    [storageKey],
  );
  useEffect(() => {
    const onOther = (w: number) => setWidth(w);
    selfRef.current = onOther;
    const set = widthListeners.get(storageKey) ?? new Set();
    set.add(onOther);
    widthListeners.set(storageKey, set);
    return () => {
      set.delete(onOther);
      if (set.size === 0) widthListeners.delete(storageKey);
    };
  }, [storageKey]);

  const draggingRef = useRef(false);
  const columnRef = useRef<HTMLElement | null>(null);
  /** The live drag's idempotent terminator, so unmounting mid-gesture cleans up
   *  after it rather than leaving listeners and a frozen cursor behind. */
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      // ONE POINTER AT A TIME. A second pointerdown used to install a second
      // gesture over the first: both fed on every move, each measuring from its
      // own origin, and whichever pointer came up first settled a width computed
      // from the other one — the column jumping, and a wrong width persisted and
      // broadcast. On a touch desktop that is one stray finger away.
      if (stopRef.current !== null) return;
      e.preventDefault();
      draggingRef.current = true;
      const pointerId = e.pointerId;
      // CAPTURE THE POINTER, so its events keep coming to this element wherever
      // it goes — including the `pointerup` that happens outside the viewport.
      // Without it a release out of the window is simply never heard: the
      // gesture stays live, the cursor and the text-selection lock stay forced,
      // and — since only one gesture may run at a time — every later resize of
      // this column is refused. Guarded: not every environment implements it.
      const grabber = e.currentTarget;
      try {
        grabber.setPointerCapture(pointerId);
      } catch {
        /* no capture available — the window listeners below still cover the
           ordinary case. */
      }
      const startX = e.clientX;
      // From what the reader SEES — `width` is already the drawn value. Starting
      // from the stored preference let a mere click repaint a size the room
      // could not honour, and since the state never changed React never
      // re-rendered to correct it.
      const startW = width;
      // The gesture tracks TWO values. What the reader is asking for, bounded
      // only by this column's own limits, is what gets persisted; what fits on
      // screen right now is what gets painted. Conflating them meant a one-pixel
      // move that changed nothing visible still replaced a 680px preference with
      // 481 — a preference destroyed by a gesture that did nothing.
      //
      // And the decision to persist rests on a move having VISIBLY changed the
      // column when it happened — not on comparing the two ends of the gesture:
      // the room can change on its own while the button is held (a window
      // resize, a panel appearing), and that is not the reader asking for
      // anything.
      let visiblyMoved = false;
      const sign = edge === "left" ? 1 : -1; // right column widens as the pointer moves LEFT
      let latest = startW;
      let raf = 0;
      const drawnFor = (w: number) => fitRef.current(clampRef.current(w));
      const paint = () => {
        raf = 0;
        const el = columnRef.current;
        if (el) {
          const drawn = drawnFor(latest);
          el.style.width = `${drawn}px`;
          el.style.flex = `0 0 ${drawn}px`;
        }
      };
      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current || ev.pointerId !== pointerId) return;
        // clampStored ONLY: the window's ceiling and the room belong to what is
        // painted, never to what the reader is asking for.
        const next = clampStored(startW + sign * (ev.clientX - startX));
        // DID THIS MOVE CHANGE ANYTHING THE READER CAN SEE? Asked here, with both
        // sides evaluated under the same constraints at the same instant. Asked
        // at the end instead, a ceiling that loosened mid-gesture turned a move
        // that had been invisible when it happened into an intention, and
        // overwrote the remembered width with it.
        if (drawnFor(next) !== drawnFor(latest)) visiblyMoved = true;
        latest = next;
        if (columnRef.current) {
          if (raf === 0) raf = requestAnimationFrame(paint);
        } else {
          // No bound column — paint through React, but through the TRANSIENT
          // value: writing `wanted` mid-gesture persisted a width the reader had
          // not settled on, and a column that vanishes mid-drag (the room
          // crossing the threshold, the panel becoming a sheet) lands here.
          setProposed(latest);
        }
      };
      const onUp = (ev?: Event) => {
        // A pointer that is not the one holding the gesture must not end it; a
        // blur or an unmount carries no pointer and always does.
        if (ev instanceof PointerEvent && ev.pointerId !== pointerId) return;
        draggingRef.current = false;
        if (raf !== 0) cancelAnimationFrame(raf);
        // Paint the FINAL width imperatively: a cancelled pending frame plus a
        // setWidth that equals the existing state (drag returned to the start
        // width) would re-render nothing and leave the last painted width on
        // the DOM.
        setProposed(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // A drag does not only end on pointerup: a gesture taken over by the OS,
        // a window blur, an unmount mid-drag each used to leave the move handler
        // on `window`, the text selection disabled and the cursor overridden.
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onUp);
        document.removeEventListener("lostpointercapture", onUp);
        try {
          if (grabber.hasPointerCapture(pointerId)) {
            grabber.releasePointerCapture(pointerId);
          }
        } catch {
          /* already released, or no capture support. */
        }
        stopRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // THE DOM IS PUT BACK IN AGREEMENT WITH REACT, always and imperatively.
        // A commit that equals the current state re-renders nothing, and a
        // pending frame was just cancelled: without this the element keeps the
        // last width the drag painted — 520px on screen while React and storage
        // both say 500 — until some unrelated render happens to fix it.
        //
        // Which width depends on what the gesture asked for, and it asked for
        // something only if it BOTH changed the column visibly at some point AND
        // ended somewhere else than it started. The flag alone is cumulative: a
        // separator dragged away and brought back to where it began had moved
        // visibly, yet asked for nothing — and committing its end position
        // destroyed a wider remembered width the room was merely hiding.
        const asked = visiblyMoved && latest !== startW;
        const settled = asked ? latest : wantedRef.current;
        const back = columnRef.current;
        if (back) {
          const drawn = drawnFor(settled);
          back.style.width = `${drawn}px`;
          back.style.flex = `0 0 ${drawn}px`;
        }
        if (!asked) return;
        // Single settle (state + storage + broadcast) for the whole drag, done
        // synchronously so an unmount cannot swallow it.
        commitWidth(latest);
      };
      stopRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onUp);
      // Losing the capture — the browser taking the pointer back, or the handle
      // itself being removed mid-gesture (collapsing the sidebar) — ends it like
      // any other ending. Listened for on `document`, NOT on the handle: the
      // spec fires it there when the capturing element has been detached, which
      // is exactly the case where the handle can no longer hear anything. While
      // it is still attached the event bubbles up here too, so one listener
      // covers both; `onUp` filters it by pointer.
      document.addEventListener("lostpointercapture", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [width, edge, clamp, clampStored, commitWidth],
  );

  return { width, startResize, setWidth, columnRef };
}

// Sidebar layout (width + collapsed) persisted per-device in localStorage. The
// width/resize now delegates to useResizableWidth (shared with the Sources
// panel); collapse + the mobile off-canvas behavior stay here.
export function useSidebarLayout() {
  const { width, startResize, columnRef } = useResizableWidth({
    storageKey: WIDTH_KEY,
    defaultWidth: DEFAULT_WIDTH,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    edge: "left",
  });
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  const isMobile = useIsMobile();

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);
  // Entering mobile closes the drawer so it never covers the conversation by
  // default; the user opens it deliberately via the top-bar toggle.
  useEffect(() => {
    if (isMobile) setCollapsed(true);
  }, [isMobile]);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const collapse = useCallback(() => setCollapsed(true), []);

  return {
    width,
    columnRef,
    collapsed,
    toggleCollapsed,
    collapse,
    startResize,
    isMobile,
    MIN_WIDTH,
    MAX_WIDTH,
  };
}
