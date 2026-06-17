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
