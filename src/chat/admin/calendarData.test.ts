import { describe, expect, test } from "vitest";
import {
  dayKeyLocal,
  dayKeyOf,
  groupByDay,
  monthDensity,
  monthWindow,
  yearWindow,
  type CalendarEvent,
} from "./calendarData";
import { cronEventsInWindow, cronItemId } from "./cronCalendarSource";

const ev = (id: string, atMs: number, exact = false): CalendarEvent => ({
  id,
  sourceId: "crons",
  itemId: "x",
  atMs,
  title: id,
  exact,
});

describe("day grouping (viewer-local)", () => {
  test("groups by local day, sorted by time within a day", () => {
    const a = ev("a", new Date(2026, 6, 17, 15, 0).getTime());
    const b = ev("b", new Date(2026, 6, 17, 8, 0).getTime());
    const c = ev("c", new Date(2026, 6, 18, 9, 0).getTime());
    const map = groupByDay([a, b, c]);
    expect(map.get(dayKeyOf(2026, 6, 17))!.map((e) => e.id)).toEqual(["b", "a"]);
    expect(map.get(dayKeyOf(2026, 6, 18))!.map((e) => e.id)).toEqual(["c"]);
    expect(dayKeyLocal(a.atMs)).toBe("2026-07-17");
  });
  test("monthDensity counts only days holding events", () => {
    const map = groupByDay([
      ev("a", new Date(2026, 6, 3, 8, 0).getTime()),
      ev("b", new Date(2026, 6, 3, 9, 0).getTime()),
      ev("c", new Date(2026, 6, 20, 9, 0).getTime()),
    ]);
    const density = monthDensity(map, 2026, 6);
    expect(density.get(3)).toBe(2);
    expect(density.get(20)).toBe(1);
    expect(density.has(4)).toBe(false);
  });
});

describe("view windows", () => {
  test("monthWindow spans exactly the 42-cell Monday-first grid", () => {
    // July 2026 starts Wednesday -> grid starts Monday June 29.
    const w = monthWindow(2026, 6);
    expect(new Date(w.startMs).getDate()).toBe(29);
    expect(new Date(w.startMs).getMonth()).toBe(5);
    expect((w.endMs - w.startMs) / 86_400_000).toBe(42);
  });
  test("yearWindow is Jan 1 to next Jan 1", () => {
    const w = yearWindow(2026);
    expect(new Date(w.startMs).toDateString()).toBe(new Date(2026, 0, 1).toDateString());
    expect(new Date(w.endMs).getFullYear()).toBe(2027);
  });
});

describe("cron calendar source", () => {
  const window = {
    startMs: Date.UTC(2026, 6, 1),
    endMs: Date.UTC(2026, 6, 8),
  };
  test("projects enabled jobs, flags the exact next run, maps items back", () => {
    const { events, byItemId } = cronEventsInWindow(
      [
        {
          instanceName: "prod",
          canEdit: true,
          job: {
            id: "j1",
            name: "Release Watch",
            enabled: true,
            schedule: "cron 0 8 * * * (UTC)",
            nextRunAtMs: Date.UTC(2026, 6, 3, 8),
            lastRunStatus: "ok",
            agentId: "olivier",
          },
        },
      ],
      window.startMs,
      window.endMs,
    );
    expect(events).toHaveLength(7);
    expect(events.filter((e) => e.exact)).toHaveLength(1);
    expect(events[0]!.title).toBe("Release Watch");
    expect(byItemId.get(cronItemId("prod", "j1"))!.canEdit).toBe(true);
  });
  test("a PAUSED job is never extrapolated (only its own nextRun, muted)", () => {
    const base = {
      instanceName: "prod",
      canEdit: true,
      job: {
        id: "j2",
        name: "Paused",
        enabled: false,
        schedule: "cron 0 8 * * * (UTC)",
        nextRunAtMs: null as number | null,
        lastRunStatus: null,
        agentId: "olivier",
      },
    };
    expect(cronEventsInWindow([base], window.startMs, window.endMs).events).toEqual([]);
    const withNext = {
      ...base,
      job: { ...base.job, nextRunAtMs: Date.UTC(2026, 6, 2, 8) },
    };
    const { events } = cronEventsInWindow([withNext], window.startMs, window.endMs);
    expect(events).toHaveLength(1);
    expect(events[0]!.muted).toBe(true);
    expect(events[0]!.exact).toBe(true);
  });
});
