// Locale-aware date/time/number formatting helpers. Every display-format call
// site goes through these instead of hardcoding a locale ("fr-FR") or silently
// using the BROWSER locale (`undefined`): the one source of truth is Paraglide's
// active locale, so formatted values always match the language of the UI text
// around them.
//
// Defaults mirror the bare Date.prototype.toLocale*String() output the call
// sites produced before the migration (e.g. formatDateTime => date + time with
// seconds); pass Intl options only where a site rendered a custom shape.

import { getLocale } from "@/paraglide/runtime.js";

/** Date + time. No options = same shape as `toLocaleString()` (with seconds). */
export function formatDateTime(
  ms: number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(ms).toLocaleString(getLocale(), options);
}

/** Date only — same shape as `toLocaleDateString()`. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(getLocale());
}

/** Time only — same shape as `toLocaleTimeString()` (with seconds). */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(getLocale());
}

/** Number with locale grouping — same shape as `Number#toLocaleString()`. */
export function formatNumber(n: number): string {
  return n.toLocaleString(getLocale());
}
