// Month grid or agenda (CalendarView) — measured, never guessed (2026-11).
//
// On a phone the month grid's seven columns came down to 42 px: chips of 20 px,
// times of 11 px, 99 targets, every one under 44 px. Where the grid does not fit,
// the calendar opens on the AGENDA: the month's days as a list, one full-width
// row per occurrence.
import type { FitInput } from "@/lib/useFitLevel";

/** A day column holds its occurrence's time and as much again of its title. */
export const MONTH_COLUMN_TIMES = 2;

/**
 * The fit input for the month grid: level 0 is the grid, which needs seven columns
 * of `MONTH_COLUMN_TIMES` time chips (`timeChip`: a hidden chip holding the
 * locale's widest time, measured); level 1 is the agenda, which needs nothing.
 */
export function monthGridFit(available: number, timeChip: number): FitInput {
  return { available, required: [7 * MONTH_COLUMN_TIMES * timeChip] };
}

/**
 * Where the agenda opens (lot 9). The month's days that hold occurrences, in order;
 * `today` the day of the month when the shown month is the current one, else null.
 * Returns the day to bring under the calendar's head: today, or the next day that
 * holds something, or — the month's remaining days all empty — its last day that
 * held something; another month opens on its first day. Null: nothing to show.
 */
export function agendaAnchorDay(days: readonly number[], today: number | null): number | null {
  if (days.length === 0) return null;
  if (today === null) return days[0];
  return days.find((d) => d >= today) ?? days[days.length - 1];
}
