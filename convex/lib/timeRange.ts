// Shared time-range parsing for filters + the /api/v1 routes.
//
// A `from`/`to` bound may be EITHER an epoch-ms numeric string ("1717336800000")
// OR a Grafana-style relative token: `now`, or `now-<N><unit>` where unit is one
// of s|m|h|d|w (seconds/minutes/hours/days/weeks), e.g. `now-24h`. The HTTP
// routes resolve tokens to ms at REQUEST time so a live dashboard re-resolves
// "now" on every poll.
//
// Discipline (mirrors the L3 limit-clamp): an unparseable token NEVER throws —
// resolveTimeToken returns undefined and parseRange simply drops that bound. The
// routes therefore degrade silently (omit the bound) and never 400/500 on a bad
// `from`/`to`, matching the rest of the /api/v1 surface.

/** Milliseconds per relative-token unit. */
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

// `now`, or `now-<N><unit>` (also tolerate `now+<N><unit>`). Whitespace-trimmed.
const RELATIVE_RE = /^now(?:\s*([+-])\s*(\d+)\s*([smhdw]))?$/i;

/**
 * Resolve a single time token to epoch ms, relative to `nowMs`.
 *
 * Accepts:
 *   - an epoch-ms numeric string ("1717336800000") -> that number,
 *   - `now` -> nowMs,
 *   - `now-<N><unit>` -> nowMs - N*unit (and `now+<N><unit>` -> nowMs + N*unit),
 *     unit in s|m|h|d|w.
 *
 * Returns undefined for anything unparseable (caller drops the bound). Pure.
 */
export function resolveTimeToken(
  token: string,
  nowMs: number,
): number | undefined {
  const raw = token.trim();
  if (raw === "") return undefined;

  // Relative token first (so a leading "now" is never mistaken for a number).
  const rel = RELATIVE_RE.exec(raw);
  if (rel) {
    const sign = rel[1];
    const amount = rel[2];
    const unit = rel[3];
    if (sign === undefined || amount === undefined || unit === undefined) {
      // Bare `now`.
      return nowMs;
    }
    const n = Number(amount);
    const unitMs = UNIT_MS[unit.toLowerCase()];
    if (!Number.isFinite(n) || unitMs === undefined) return undefined;
    const delta = n * unitMs;
    return sign === "-" ? nowMs - delta : nowMs + delta;
  }

  // Otherwise treat it as an epoch-ms numeric string.
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** A resolved, inclusive time range (either bound may be absent). */
export type ResolvedRange = { from?: number; to?: number };

/**
 * Resolve an optional `{from, to}` pair of tokens to an epoch-ms range relative
 * to `nowMs`. Each bound is resolved independently; an unparseable bound is
 * simply omitted (never throws). The range is treated as inclusive on both ends
 * by the filter layer.
 */
export function parseRange(
  range: { from?: string; to?: string },
  nowMs: number,
): ResolvedRange {
  const out: ResolvedRange = {};
  if (range.from !== undefined) {
    const from = resolveTimeToken(range.from, nowMs);
    if (from !== undefined) out.from = from;
  }
  if (range.to !== undefined) {
    const to = resolveTimeToken(range.to, nowMs);
    if (to !== undefined) out.to = to;
  }
  return out;
}
