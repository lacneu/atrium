// Pure helpers for the generic CALENDAR surface (month + year). The calendar
// is SOURCE-AGNOSTIC by design: events carry a `sourceId` so future sources
// (the user's own calendar, Twenty CRM) can join the crons without touching
// the view — today only the "crons" source exists (cronCalendarSource.ts).
// No React, no i18n.

/** One occurrence on the calendar — the unit every source produces. */
export type CalendarEvent = {
  /** Stable per occurrence (dedup/render key). */
  id: string;
  /** The producing source ("crons" today; "user-calendar", "twenty" later). */
  sourceId: string;
  /** The source item behind the occurrence (e.g. the cron job) — the host
   *  resolves clicks through it. */
  itemId: string;
  /** Occurrence instant (epoch ms). Views group it by the VIEWER's local day. */
  atMs: number;
  title: string;
  /** Tint hint (CSS color value); null = the surface default. */
  color?: string | null;
  /** Visually subdued (e.g. a paused cron). */
  muted?: boolean;
  /** true = source truth (gateway next-run / one-shot); false = estimation. */
  exact: boolean;
};

/** The viewer-local day key of an instant ("2026-07-17"). */
export function dayKeyLocal(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dayKeyOf(y: number, mo: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo + 1)}-${p(d)}`;
}

/** Events grouped by viewer-local day, each day's list sorted by time. */
export function groupByDay(
  events: CalendarEvent[],
): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = dayKeyLocal(ev.atMs);
    const list = map.get(key);
    if (list === undefined) map.set(key, [ev]);
    else list.push(ev);
  }
  for (const list of map.values()) list.sort((a, b) => a.atMs - b.atMs);
  return map;
}

/** Per-day event counts of one month (year heat cells). */
export function monthDensity(
  byDay: Map<string, CalendarEvent[]>,
  year: number,
  month: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const list = byDay.get(dayKeyOf(year, month, d));
    if (list !== undefined && list.length > 0) out.set(d, list.length);
  }
  return out;
}

/** Monday-first narrow weekday initials for a locale (2024-01-01 is a
 *  Monday). Shared by the month grid header. */
export function weekdayInitials(locale: string): string[] {
  try {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(2024, 0, 1 + i)),
    );
  } catch {
    return ["M", "T", "W", "T", "F", "S", "S"];
  }
}

/** The [start, end) epoch window a MONTH view must load: the exact 42-cell
 *  grid span (leading/trailing out-of-month days included). */
export function monthWindow(
  year: number,
  month: number,
): { startMs: number; endMs: number } {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(year, month, 1 - lead);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** The [start, end) epoch window a YEAR view must load. */
export function yearWindow(year: number): { startMs: number; endMs: number } {
  return {
    startMs: new Date(year, 0, 1).getTime(),
    endMs: new Date(year + 1, 0, 1).getTime(),
  };
}
