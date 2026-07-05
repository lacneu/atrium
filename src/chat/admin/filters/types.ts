// Shared, pure client-side types + helpers for the admin filter UI. Mirrors the
// backend Filter shape in convex/lib/filters.ts (docs/FILTERS_SPEC.md): the UI
// builds the SAME `filter` arg every list query consumes. This module is pure
// (no React, no Convex) so it stays trivially testable and importable anywhere.

import { m } from "@/paraglide/messages.js";
import { formatDateTime } from "@/lib/format";

/** Comparison operator for an advanced predicate (matches the backend `Op`). */
export type Op = "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte";

/** One advanced predicate row (ANDed with the others). */
export type Predicate = { field: string; op: Op; value: string | number | boolean };

/**
 * A time range, Grafana-style. A RELATIVE range stores tokens (`now`,
 * `now-24h`) and RE-RESOLVES to the current instant on every `resolveRange`
 * call, so live data stays live. An ABSOLUTE range pins two epoch-ms instants.
 */
export type TimeRange =
  | { kind: "relative"; from: string; to: string }
  | { kind: "absolute"; from: number; to: number };

/** Relative-token time units (seconds … weeks). */
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve a single relative token (`now`, `now-<N><unit>`) to epoch ms against
 * `nowMs`. Returns `null` for an unparseable token (caller decides the
 * fallback). `nowMs` is injectable so the helper stays pure + testable.
 */
export function resolveToken(token: string, nowMs: number): number | null {
  const t = token.trim();
  if (t === "now") return nowMs;
  // now-<N><unit>  (only subtraction is meaningful for a recent window)
  const m = /^now-(\d+)([smhdw])$/.exec(t);
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2]];
  if (!Number.isFinite(n) || unit === undefined) return null;
  return nowMs - n * unit;
}

/**
 * Resolve a TimeRange to inclusive epoch-ms bounds. Relative tokens re-resolve
 * to `nowMs` (defaults to Date.now()) on EVERY call — that is what keeps a live
 * "last 24h" window tracking the present. `nowMs` is injectable for tests.
 */
export function resolveRange(
  r: TimeRange,
  nowMs: number = Date.now(),
): { from: number; to: number } {
  if (r.kind === "absolute") return { from: r.from, to: r.to };
  const from = resolveToken(r.from, nowMs) ?? nowMs - UNIT_MS.h;
  const to = resolveToken(r.to, nowMs) ?? nowMs;
  return { from, to };
}

/** A quick relative preset (the right-hand Grafana list). */
export type RelativePreset = { label: string; from: string };

/** The quick relative presets, newest-window first (Grafana ordering). */
export const RELATIVE_PRESETS: RelativePreset[] = [
  { label: m.filters_preset_last_5m(), from: "now-5m" },
  { label: m.filters_preset_last_15m(), from: "now-15m" },
  { label: m.filters_preset_last_30m(), from: "now-30m" },
  { label: m.filters_preset_last_1h(), from: "now-1h" },
  { label: m.filters_preset_last_3h(), from: "now-3h" },
  { label: m.filters_preset_last_6h(), from: "now-6h" },
  { label: m.filters_preset_last_12h(), from: "now-12h" },
  { label: m.filters_preset_last_24h(), from: "now-24h" },
  { label: m.filters_preset_last_2d(), from: "now-2d" },
  { label: m.filters_preset_last_7d(), from: "now-7d" },
  { label: m.filters_preset_last_30d(), from: "now-30d" },
  { label: m.filters_preset_last_90d(), from: "now-90d" },
  // Effectively "all time" (~10y window) — a non-hiding default for short, recent lists
  // (e.g. the delivery-record sessions) where any narrower default would hide older rows.
  { label: m.filters_preset_all(), from: "now-520w" },
];

/** Format an absolute instant for the trigger label (compact, locale-aware). */
function formatInstant(ms: number): string {
  return formatDateTime(ms, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Human label for the picker trigger. A relative range that matches a known
 * preset shows the preset label (e.g. "Last 24 hours"); any other relative
 * range falls back to its tokens; an absolute range shows both instants.
 */
export function rangeLabel(r: TimeRange): string {
  if (r.kind === "relative") {
    const preset = RELATIVE_PRESETS.find(
      (p) => p.from === r.from && r.to === "now",
    );
    if (preset) return preset.label;
    return `${r.from} → ${r.to}`;
  }
  return `${formatInstant(r.from)} → ${formatInstant(r.to)}`;
}

// --- datetime-local <-> epoch ms (no date lib) -----------------------------
// <input type="datetime-local"> works in LOCAL time with the format
// "YYYY-MM-DDTHH:mm". We convert through the Date constructor (which reads that
// string as local time) so the picker matches what the admin sees on the clock.

/** epoch ms -> "YYYY-MM-DDTHH:mm" in local time (for a datetime-local input). */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** "YYYY-MM-DDTHH:mm" (local) -> epoch ms, or null if unparseable. */
export function localInputToMs(value: string): number | null {
  if (value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Coerce a raw advanced-filter input string to the primitive the backend
 * compares correctly. The backend only compares numerically when BOTH sides are
 * numbers and only does boolean equality for real booleans, so a bare string
 * "100"/"true" would silently misbehave (e.g. lexical `"100" < "20"`). We map a
 * finite-number-looking value to a number and "true"/"false" to a boolean.
 */
export function coercePredicateValue(raw: string): string | number | boolean {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return raw;
}
