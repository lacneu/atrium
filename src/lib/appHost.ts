// The host Atrium is served from (charte par domaine). Constant per page load.
// Pass it to EVERY getMe call so they all share ONE subscription (and so the
// optimistic getQuery reads hit the same cache key), and to brandForHost for the
// pre-auth login. SSR-safe guard.
export const APP_HOST =
  typeof window !== "undefined" && window.location
    ? window.location.hostname
    : "";

export type CachedBrand = { tokens: unknown; brand: unknown };

const cacheKey = (host: string) => `oc.brand.${host}`;

/**
 * A cached brand is only APPLICABLE if its `tokens` are absent/null (native look)
 * or carry the `colors.light` + `colors.dark` shape that applyChartTokens reads. A
 * STALE (old app version) or tampered cache of any other shape — e.g. `{tokens:{}}`
 * — is treated as ABSENT so it can never crash the pre-auth paint (white screen).
 */
function isApplicableBrand(v: unknown): v is CachedBrand {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  if (!("tokens" in v)) return false; // not a brandForHost cache shape
  const tokens = (v as { tokens: unknown }).tokens;
  if (tokens === null) return true; // native look — valid
  if (typeof tokens !== "object") return false;
  const colors = (tokens as { colors?: unknown }).colors;
  return (
    typeof colors === "object" &&
    colors !== null &&
    "light" in colors &&
    "dark" in colors
  );
}

/**
 * Read the cached domain brand for `host` so the login can apply tenant tokens on
 * the first render (reducing the native→tenant color flash to a single paint,
 * same class as the app's existing chart paint), or null on a first-ever visit OR
 * when the stored value is malformed/stale (treated as absent — never applied).
 */
export function readCachedBrand(host: string): CachedBrand | null {
  try {
    const raw = localStorage.getItem(cacheKey(host));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isApplicableBrand(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the resolved domain brand for `host`. */
export function writeCachedBrand(host: string, value: CachedBrand): void {
  try {
    localStorage.setItem(cacheKey(host), JSON.stringify(value));
  } catch {
    /* storage quota / disabled — non-fatal */
  }
}
