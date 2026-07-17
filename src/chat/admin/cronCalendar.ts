// Pure occurrence engine for the Scheduled CALENDAR view: projects a cron
// job's schedule onto a time window as epoch timestamps. No React, no i18n.
//
// TRUTH MODEL (honest by design): `nextRunAtMs` is the gateway's exact truth
// and is always surfaced as an EXACT occurrence. Recurring occurrences beyond
// it are ESTIMATIONS computed from the schedule string the gateway shipped:
//   - cron expressions are evaluated in the job's tz when the string carries
//     one ("cron 30 9 * * * (America/Toronto)"), else in the VIEWER's tz —
//     correct whenever viewer and gateway share a zone, documented estimation
//     otherwise (the day-grid granularity absorbs most drift);
//   - "every Nh/Nmin/Ns/Nms" cadences anchor on nextRunAtMs and extrapolate in
//     BOTH directions (a pause/resume in the past makes back-extrapolation
//     approximate — again an estimation, flagged as such);
//   - "at" one-shots parse the ISO timestamp;
//   - anything unparseable degrades to the single exact nextRunAtMs.

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------

export type ScheduleSpec =
  | { kind: "cron"; expr: string; tz: string | null }
  | { kind: "every"; everyMs: number }
  | { kind: "at"; atMs: number }
  | null;

const EVERY_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  min: 60_000,
  s: 1_000,
  ms: 1,
};

/** Parse the wire `schedule` string (see bridge fetchCronJobs) into a spec.
 *  null = unknown shape — the caller falls back to next-run-only. */
export function parseScheduleSpec(schedule: string | null): ScheduleSpec {
  if (schedule === null) return null;
  const s = schedule.trim();
  const every = /^every\s+(\d+(?:\.\d+)?)(h|min|s|ms)$/.exec(s);
  if (every !== null) {
    const ms = Number(every[1]) * EVERY_UNIT_MS[every[2]!]!;
    return Number.isFinite(ms) && ms > 0 ? { kind: "every", everyMs: ms } : null;
  }
  // Cron expression, bare or in the detail form "cron <expr> (tz)".
  const cron = /^(?:cron\s+)?([\d*,/-]+(?:\s+[\d*,/-]+){4})(?:\s*\(([^)]+)\))?$/.exec(
    s,
  );
  if (cron !== null) {
    return { kind: "cron", expr: cron[1]!, tz: cron[2] ?? null };
  }
  const atMs = Date.parse(s);
  if (Number.isFinite(atMs)) return { kind: "at", atMs };
  return null;
}

// ---------------------------------------------------------------------------
// Cron expression evaluation (standard 5 fields; vixie dom/dow OR rule)
// ---------------------------------------------------------------------------

type CronFields = {
  minutes: number[];
  hours: number[];
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

function parseCronField(
  raw: string,
  min: number,
  max: number,
): number[] | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    let body = part;
    let step = 1;
    const stepMatch = /^(.+)\/(\d{1,3})$/.exec(part);
    if (stepMatch !== null) {
      body = stepMatch[1]!;
      step = Number(stepMatch[2]);
      if (step < 1) return null;
    }
    let a: number;
    let b: number;
    if (body === "*") {
      a = min;
      b = max;
    } else {
      const range = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(body);
      if (range === null) return null;
      a = Number(range[1]);
      b = range[2] !== undefined ? Number(range[2]) : a;
      // A bare value with a step ("3/5") means "from 3 to max" in vixie cron.
      if (range[2] === undefined && stepMatch !== null) b = max;
      if (a < min || b > max || a > b) return null;
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out.size > 0 ? [...out].sort((x, y) => x - y) : null;
}

/** Parse a 5-field cron expression. null = unsupported/invalid (fail-soft:
 *  the caller degrades to next-run-only). dow 7 normalizes to 0 (Sunday). */
export function parseCronExpr(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const dom = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const dowRaw = parseCronField(fields[4]!, 0, 7);
  if (!minutes || !hours || !dom || !months || !dowRaw) return null;
  const dow = new Set(dowRaw.map((d) => d % 7));
  return {
    minutes,
    hours,
    dom: new Set(dom),
    months: new Set(months),
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

// ---------------------------------------------------------------------------
// Time-zone math (Intl-based, cached per zone; 2-pass DST fixup)
// ---------------------------------------------------------------------------

// Failures are cached too (null): an unknown zone label — the gateway ships
// e.g. "cron 30 9 * * * (exact)" where the parenthesis is NOT a tz — would
// otherwise rebuild a throwing Intl constructor on every day of every render.
const dtfCache = new Map<string, Intl.DateTimeFormat | null>();
function dtfFor(tz: string): Intl.DateTimeFormat | null {
  const cached = dtfCache.get(tz);
  if (cached !== undefined) return cached;
  let dtf: Intl.DateTimeFormat | null = null;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    dtf = null; // unknown zone -> caller falls back to viewer-local
  }
  dtfCache.set(tz, dtf);
  return dtf;
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number };

/** The wall-clock parts of `utcMs` in `tz` (null tz/invalid -> viewer local). */
export function zonedParts(utcMs: number, tz: string | null): Parts {
  if (tz !== null) {
    const dtf = dtfFor(tz);
    if (dtf !== null) {
      const map: Record<string, number> = {};
      for (const p of dtf.formatToParts(utcMs)) {
        if (p.type !== "literal") map[p.type] = Number(p.value);
      }
      return {
        y: map.year!,
        mo: map.month! - 1,
        d: map.day!,
        // Some engines format midnight as "24" with hour12:false.
        h: map.hour! === 24 ? 0 : map.hour!,
        mi: map.minute!,
      };
    }
  }
  const d = new Date(utcMs);
  return {
    y: d.getFullYear(),
    mo: d.getMonth(),
    d: d.getDate(),
    h: d.getHours(),
    mi: d.getMinutes(),
  };
}

/** Epoch of a wall-clock time in `tz` (null/invalid tz -> viewer local).
 *  Two-pass offset fixup handles DST transitions. */
export function epochFromZoned(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string | null,
): number {
  if (tz === null || dtfFor(tz) === null) {
    return new Date(y, mo, d, h, mi).getTime();
  }
  const asUtc = Date.UTC(y, mo, d, h, mi);
  const offsetAt = (guess: number): number => {
    const p = zonedParts(guess, tz);
    return Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - guess;
  };
  const off1 = offsetAt(asUtc);
  let ts = asUtc - off1;
  const off2 = offsetAt(ts);
  if (off2 !== off1) ts = asUtc - off2;
  return ts;
}

// ---------------------------------------------------------------------------
// Occurrence enumeration
// ---------------------------------------------------------------------------

export type Occurrence = { atMs: number; exact: boolean };

/** Hard cap on computed occurrences per job per window (a year view over an
 *  every-minute job would otherwise explode). Truncation is per-job and the
 *  UI shows day-level density anyway. */
export const MAX_OCCURRENCES_PER_JOB = 400;

/** All occurrences of `spec` within [startMs, endMs), plus the EXACT
 *  nextRunAtMs when it falls inside the window. Sorted, deduped, capped. */
export function occurrencesInWindow(
  spec: ScheduleSpec,
  nextRunAtMs: number | null,
  startMs: number,
  endMs: number,
): Occurrence[] {
  const out = new Map<number, boolean>(); // atMs -> exact
  const push = (atMs: number, exact: boolean) => {
    if (atMs < startMs || atMs >= endMs) return;
    // Exact beats estimated on the same timestamp.
    out.set(atMs, exact || (out.get(atMs) ?? false));
  };

  if (spec?.kind === "at") {
    push(spec.atMs, true);
  } else if (spec?.kind === "every") {
    // Anchor on the gateway's next run; without it there is nothing sound to
    // extrapolate from.
    if (nextRunAtMs !== null) {
      const step = spec.everyMs;
      // First tick at/after startMs on the anchor's lattice (both directions).
      const k = Math.ceil((startMs - nextRunAtMs) / step);
      for (
        let t = nextRunAtMs + k * step, n = 0;
        t < endMs && n < MAX_OCCURRENCES_PER_JOB;
        t += step, n++
      ) {
        push(t, t === nextRunAtMs);
      }
    }
  } else if (spec?.kind === "cron") {
    const fields = parseCronExpr(spec.expr);
    // A schedule denser than the whole per-job budget in a SINGLE day (e.g.
    // "* * * * *" = 1440/day) is not worth estimating — only the exact next
    // run below is surfaced. Checked once, not inside the day walk.
    if (
      fields !== null &&
      fields.hours.length * fields.minutes.length <= MAX_OCCURRENCES_PER_JOB
    ) {
      // Walk the window day by day in the job's zone; for matching days emit
      // every hour×minute combo (bounded by the global cap).
      let n = 0;
      // Start from the window's day in the job zone, minus one day of margin
      // (a zone ahead of the viewer can place its day boundary earlier).
      let cursor = startMs - 86_400_000;
      while (cursor < endMs + 86_400_000 && n < MAX_OCCURRENCES_PER_JOB) {
        const p = zonedParts(cursor, spec.tz);
        const monthOk = fields.months.has(p.mo + 1);
        if (monthOk) {
          const dowOfDay = new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay();
          const domOk = fields.dom.has(p.d);
          const dowOk = fields.dow.has(dowOfDay);
          // Vixie rule: both restricted -> OR; else AND (wildcard passes).
          const dayOk =
            fields.domRestricted && fields.dowRestricted
              ? domOk || dowOk
              : domOk && dowOk;
          if (dayOk) {
            for (const h of fields.hours) {
              for (const mi of fields.minutes) {
                if (n >= MAX_OCCURRENCES_PER_JOB) break;
                const at = epochFromZoned(p.y, p.mo, p.d, h, mi, spec.tz);
                if (at >= startMs && at < endMs) {
                  push(at, false);
                  n++;
                }
              }
            }
          }
        }
        // Advance to the next day in the job zone: jump to that day's noon to
        // dodge DST edges, then re-derive.
        cursor = epochFromZoned(p.y, p.mo, p.d, 12, 0, spec.tz) + 86_400_000;
      }
    }
  }

  // The gateway's next run is ALWAYS surfaced (and marked exact) — including
  // for unparseable schedules, where it is the only thing we know.
  if (nextRunAtMs !== null) push(nextRunAtMs, true);

  return [...out.entries()]
    .map(([atMs, exact]) => ({ atMs, exact }))
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, MAX_OCCURRENCES_PER_JOB);
}
