import { useCallback, useEffect, useRef, useState } from "react";

// Sidebar layout (width + collapsed) persisted per-device in localStorage.
// Pure UI preference, like the theme cache — no need to round-trip Convex.
const WIDTH_KEY = "oc.sidebar.width";
const COLLAPSED_KEY = "oc.sidebar.collapsed";
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 260;
// Single source of truth for the mobile breakpoint: the CSS drawer styles key off
// the `oc-workspace--mobile` class we toggle from THIS query (not a separate CSS
// media query), so JS and CSS can never disagree at a 1px boundary.
const MOBILE_QUERY = "(max-width: 767px)";

function clampWidth(w: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
}

export function useSidebarLayout() {
  const [width, setWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return raw ? clampWidth(raw) : DEFAULT_WIDTH;
  });
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  // On mobile the sidebar is an OVERLAY drawer, not an in-flow column — so it must
  // start closed (otherwise it covers the chat) and the breakpoint also drives the
  // drawer CSS via a class on the workspace.
  const [isMobile, setIsMobile] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Entering mobile closes the drawer so it never covers the conversation by
  // default; the user opens it deliberately via the top-bar toggle.
  useEffect(() => {
    if (isMobile) setCollapsed(true);
  }, [isMobile]);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const collapse = useCallback(() => setCollapsed(true), []);

  // Pointer-driven resize from a drag handle on the sidebar's right edge.
  const draggingRef = useRef(false);
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      setWidth(clampWidth(startW + (ev.clientX - startX)));
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
  }, [width]);

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
