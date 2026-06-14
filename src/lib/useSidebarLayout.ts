import { useCallback, useEffect, useRef, useState } from "react";

// Sidebar layout (width + collapsed) persisted per-device in localStorage.
// Pure UI preference, like the theme cache — no need to round-trip Convex.
const WIDTH_KEY = "oc.sidebar.width";
const COLLAPSED_KEY = "oc.sidebar.collapsed";
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 260;

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

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

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

  return { width, collapsed, toggleCollapsed, startResize, MIN_WIDTH, MAX_WIDTH };
}
