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
}

/** A localStorage-persisted, pointer-resizable column width. */
export function useResizableWidth(opts: ResizableWidthOptions) {
  const { storageKey, defaultWidth, min, max, edge } = opts;
  const clamp = useCallback(
    (w: number) => Math.min(max, Math.max(min, w)),
    [min, max],
  );
  const [width, setWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(storageKey));
    return raw ? Math.min(max, Math.max(min, raw)) : defaultWidth;
  });
  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const draggingRef = useRef(false);
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startW = width;
      const sign = edge === "left" ? 1 : -1; // right column widens as the pointer moves LEFT
      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        setWidth(clamp(startW + sign * (ev.clientX - startX)));
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [width, edge, clamp],
  );

  return { width, startResize, setWidth };
}

// Sidebar layout (width + collapsed) persisted per-device in localStorage. The
// width/resize now delegates to useResizableWidth (shared with the Sources
// panel); collapse + the mobile off-canvas behavior stay here.
export function useSidebarLayout() {
  const { width, startResize } = useResizableWidth({
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
    collapsed,
    toggleCollapsed,
    collapse,
    startResize,
    isMobile,
    MIN_WIDTH,
    MAX_WIDTH,
  };
}
