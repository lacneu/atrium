import { useEffect } from "react";

export type ThemeMode = "light" | "dark" | "system";

const CACHE_KEY = "oc.theme";

// Resolve + apply a theme MODE by toggling the `.dark` class on <html>. MUST
// match the anti-flash script in index.html so first paint and React agree.
function applyMode(mode: ThemeMode) {
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Apply a theme mode whose SOURCE OF TRUTH is Convex (passed in via `mode`).
 * This hook does NOT own theme state — it only:
 *   1. applies the resolved mode to the DOM,
 *   2. refreshes the localStorage cache (read by the index.html anti-flash
 *      script on the next first paint),
 *   3. keeps "system" live by listening to the OS preference.
 * `mode` is undefined until getMe resolves; we fall back to the cached value so
 * there is no flash between first paint and the first Convex round-trip.
 */
export function useApplyTheme(mode: ThemeMode | undefined) {
  useEffect(() => {
    const effective: ThemeMode =
      mode ?? ((localStorage.getItem(CACHE_KEY) as ThemeMode | null) ?? "system");
    localStorage.setItem(CACHE_KEY, effective);
    applyMode(effective);
    if (effective === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => applyMode("system");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
  }, [mode]);
}
