// Pure logo-URL selection for a chart brand: pick the uploaded logo for the
// RESOLVED display mode (light/dark), falling back to the OTHER mode's logo when
// only one was uploaded, else null (no logo applies). Extracted from the otherwise
// DOM-coupled top-bar/login brand rendering so the mode→logo selection is
// unit-testable, and shared so BrandMark and the login brand never diverge.
export type BrandLogos = {
  logoLightUrl?: string | null;
  logoDarkUrl?: string | null;
};

export function pickLogoUrl(
  brand: BrandLogos | undefined,
  mode: "light" | "dark",
): string | null {
  return (
    (mode === "dark" ? brand?.logoDarkUrl : brand?.logoLightUrl) ??
    (mode === "dark" ? brand?.logoLightUrl : brand?.logoDarkUrl) ??
    null
  );
}

// Extract the L (lightness, 0..1) from an `oklch(L C H[/A])` color string.
// Accepts L as a 0..1 number (the chart validator's re-serialized form) or a
// percentage. Returns null for a missing / non-oklch / unparseable value so the
// caller can fall back rather than guess.
export function oklchLightness(value: string | undefined): number | null {
  if (!value) return null;
  const match = /oklch\(\s*([0-9]*\.?[0-9]+)(%?)/i.exec(value);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n)) return null;
  return match[2] === "%" ? n / 100 : n;
}

// Which logo variant the chat AVATAR tile should use. The tile paints the brand
// on `--primary` (NOT the page background), with `--primary-foreground` as its
// contrast color — so its polarity is independent of the page light/dark mode: a
// dark `--primary` (e.g. terracotta) needs the DARK-mode logo (the one designed
// for dark backgrounds) even while the PAGE is light. We read "is --primary dark"
// from the chart's OWN contrast decision — primary-foreground LIGHTER than primary
// means primary is the darker color — which is threshold-free and more robust than
// testing primary's lightness against a magic number. Falls back to `pageMode`
// when either token is missing/unparseable (the default brand uses the Atrium mark,
// not an uploaded logo, so this only affects custom charts, which carry tokens).
export function avatarLogoMode(
  primary: string | undefined,
  primaryForeground: string | undefined,
  pageMode: "light" | "dark",
): "light" | "dark" {
  const lp = oklchLightness(primary);
  const lf = oklchLightness(primaryForeground);
  if (lp === null || lf === null) return pageMode;
  return lf > lp ? "dark" : "light";
}

// Up-to-2-char initials for a brand label, used as the avatar fallback when a
// custom chart has a name but no uploaded logo (the default brand shows the
// Atrium mark instead, so this is only ever seen for custom charts).
export function brandInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
