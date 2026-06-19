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

// Up-to-2-char initials for a brand label, used as the avatar fallback when a
// custom chart has a name but no uploaded logo (the default brand shows the
// Atrium mark instead, so this is only ever seen for custom charts).
export function brandInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
