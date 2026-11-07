// The calendar opens on the month grid where its seven columns can show a time and
// a title start, on the agenda where they cannot (calendarFit.ts) — the decision
// read by CalendarView through useFitLevel/pickFitLevel.
import { describe, expect, test } from "vitest";
import { pickFitLevel } from "@/lib/useFitLevel";
import { agendaAnchorDay, monthGridFit, MONTH_COLUMN_TIMES } from "./calendarFit";

const GRID = 0;
const AGENDA = 1;
// A chip holding "23:59" in the grid's 11 px type: dot, gap, time, padding.
const CHIP = 46;

describe("month grid where it reads, agenda where it does not", () => {
  test("a desktop's content column (980 px) keeps the grid", () => {
    expect(pickFitLevel(monthGridFit(980, CHIP))).toBe(GRID);
  });

  test("a phone (296 px) opens on the agenda — its columns would be 42 px", () => {
    expect(pickFitLevel(monthGridFit(296, CHIP))).toBe(AGENDA);
  });

  test("the threshold is seven columns of a time and as much again", () => {
    const need = 7 * MONTH_COLUMN_TIMES * CHIP;
    expect(pickFitLevel(monthGridFit(need, CHIP))).toBe(GRID);
    expect(pickFitLevel(monthGridFit(need - 1, CHIP))).toBe(AGENDA);
  });

  test("a wider time (11:59 PM) needs a wider grid", () => {
    expect(pickFitLevel(monthGridFit(700, 46))).toBe(GRID);
    expect(pickFitLevel(monthGridFit(700, 60))).toBe(AGENDA);
  });

  test("the chip not laid out yet (0): no verdict, the grid stays", () => {
    expect(pickFitLevel(monthGridFit(296, 0))).toBe(GRID);
  });
});

describe("the agenda opens on today, not on the 1st (lot 9)", () => {
  const DAYS = [1, 2, 3, 7, 8, 30];

  test("today holds occurrences: the agenda opens on today", () => {
    expect(agendaAnchorDay(DAYS, 7)).toBe(7);
  });

  test("today holds none: on the next day that does", () => {
    expect(agendaAnchorDay(DAYS, 4)).toBe(7);
    expect(agendaAnchorDay(DAYS, 9)).toBe(30);
  });

  test("nothing left this month: on the last day that held something", () => {
    expect(agendaAnchorDay([1, 2, 3], 20)).toBe(3);
  });

  test("today before the first day listed: on the first day", () => {
    expect(agendaAnchorDay(DAYS, 1)).toBe(1);
    expect(agendaAnchorDay([5, 9], 2)).toBe(5);
  });

  test("another month opens on its first day; nothing loaded yet, nowhere", () => {
    expect(agendaAnchorDay(DAYS, null)).toBe(1);
    expect(agendaAnchorDay([], 7)).toBeNull();
  });
});
