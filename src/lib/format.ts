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

/** A short human duration for "how long the reply took": "< 1 s", "42 s",
 *  "2 min 05 s", "1 h 03 min". Unit symbols are locale-neutral (s/min/h).
 *  Returns null for a non-finite/negative input so callers can just hide it. */
export function formatDurationShort(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  // ANY sub-second duration reads "< 1 s" (rounding 500-999 ms up to "1 s"
  // would overstate it).
  if (ms < 1000) return "< 1 s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const rs = s % 60;
  if (min < 60) return rs === 0 ? `${min} min` : `${min} min ${String(rs).padStart(2, "0")} s`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  return rm === 0 ? `${h} h` : `${h} h ${String(rm).padStart(2, "0")} min`;
}
