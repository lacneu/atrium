import { useEffect } from "react";

export type FontScale = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

const CACHE_KEY = "oc.fontScale";

// Scale -> root font-size. Scaling the ROOT means every rem-based measure
// (Tailwind text/spacing, the chat CSS) follows proportionally — a coherent
// "text size" control, not a patchwork of per-component overrides. "md" clears
// the inline style (back to the stylesheet's 100%). MUST match the anti-flash
// script in index.html so first paint and React agree.
export const FONT_SCALE_CSS: Record<FontScale, string> = {
  sm: "87.5%", // 14px
  md: "", // 16px (browser/stylesheet default)
  lg: "112.5%", // 18px
  xl: "125%", // 20px
  "2xl": "137.5%", // 22px
  "3xl": "150%", // 24px
};

export const FONT_SCALES: FontScale[] = ["sm", "md", "lg", "xl", "2xl", "3xl"];

export function isFontScale(s: string | null): s is FontScale {
  return s !== null && (FONT_SCALES as string[]).includes(s);
}

function applyScale(scale: FontScale) {
  document.documentElement.style.fontSize = FONT_SCALE_CSS[scale];
}

/**
 * Apply a text-size scale whose SOURCE OF TRUTH is Convex (passed in via
 * `scale`). Mirror of useApplyTheme: this hook does not own state — it applies
 * the resolved scale to the root font-size and refreshes the localStorage cache
 * (read by the index.html anti-flash script on the next first paint). `scale`
 * is undefined until getMe resolves; fall back to the cached value so there is
 * no size jump between first paint and the first Convex round-trip.
 */
export function useApplyFontScale(scale: FontScale | undefined) {
  useEffect(() => {
    const cached = localStorage.getItem(CACHE_KEY);
    const effective: FontScale =
      scale ?? (isFontScale(cached) ? cached : "md");
    localStorage.setItem(CACHE_KEY, effective);
    applyScale(effective);
  }, [scale]);
}
