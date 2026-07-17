// The calendar occurrence engine: schedule parsing, cron evaluation (vixie
// dom/dow OR rule), tz math, every-anchoring and the exact-vs-estimated model.

import { describe, expect, test } from "vitest";
import {
  MAX_OCCURRENCES_PER_JOB,
  epochFromZoned,
  occurrencesInWindow,
  parseCronExpr,
  parseScheduleSpec,
  zonedParts,
} from "./cronCalendar";

describe("parseScheduleSpec", () => {
  test("bare and detail-form cron expressions, with optional tz", () => {
    expect(parseScheduleSpec("0 8 * * *")).toEqual({
      kind: "cron",
      expr: "0 8 * * *",
      tz: null,
    });
    expect(parseScheduleSpec("cron 30 9 * * 3 (America/Toronto)")).toEqual({
      kind: "cron",
      expr: "30 9 * * 3",
      tz: "America/Toronto",
    });
  });
  test("every cadences (bridge everyLabel forms)", () => {
    expect(parseScheduleSpec("every 1h")).toEqual({ kind: "every", everyMs: 3_600_000 });
    expect(parseScheduleSpec("every 30min")).toEqual({ kind: "every", everyMs: 1_800_000 });
    expect(parseScheduleSpec("every 45s")).toEqual({ kind: "every", everyMs: 45_000 });
    expect(parseScheduleSpec("every 1234ms")).toEqual({ kind: "every", everyMs: 1234 });
  });
  test("ISO one-shot; garbage -> null", () => {
    expect(parseScheduleSpec("2026-07-20T08:00:00.000Z")).toEqual({
      kind: "at",
      atMs: Date.parse("2026-07-20T08:00:00.000Z"),
    });
    expect(parseScheduleSpec("whenever")).toBeNull();
    expect(parseScheduleSpec(null)).toBeNull();
  });
});

describe("parseCronExpr", () => {
  test("wildcards, lists, ranges, steps", () => {
    const f = parseCronExpr("0,30 8-10 * * 1-5")!;
    expect(f.minutes).toEqual([0, 30]);
    expect(f.hours).toEqual([8, 9, 10]);
    expect([...f.dow].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(true);
    const steps = parseCronExpr("*/15 */6 * * *")!;
    expect(steps.minutes).toEqual([0, 15, 30, 45]);
    expect(steps.hours).toEqual([0, 6, 12, 18]);
  });
  test("dow 7 normalizes to Sunday(0); invalid shapes -> null", () => {
    const f = parseCronExpr("0 0 * * 7")!;
    expect(f.dow.has(0)).toBe(true);
    expect(parseCronExpr("0 0 * *")).toBeNull(); // 4 fields
    expect(parseCronExpr("61 0 * * *")).toBeNull(); // out of range
    expect(parseCronExpr("0 0 * * MON")).toBeNull(); // names unsupported (fail-soft)
  });
});

describe("tz math", () => {
  test("epochFromZoned/zonedParts round-trip in a named zone", () => {
    const ts = epochFromZoned(2026, 6, 17, 8, 0, "America/Toronto");
    const p = zonedParts(ts, "America/Toronto");
    expect([p.y, p.mo, p.d, p.h, p.mi]).toEqual([2026, 6, 17, 8, 0]);
    // Toronto is UTC-4 in July.
    expect(new Date(ts).toISOString()).toBe("2026-07-17T12:00:00.000Z");
  });
  test("unknown tz falls back to viewer-local (no throw)", () => {
    const ts = epochFromZoned(2026, 6, 17, 8, 0, "Not/AZone");
    expect(ts).toBe(new Date(2026, 6, 17, 8, 0).getTime());
  });
});

describe("occurrencesInWindow", () => {
  const day = (d: number, h = 0, mi = 0) => Date.UTC(2026, 6, d, h, mi);

  test("daily cron in UTC: one occurrence per day, estimated; nextRun exact", () => {
    const spec = parseScheduleSpec("cron 0 8 * * * (UTC)");
    const occ = occurrencesInWindow(spec, day(3, 8), day(1), day(8));
    expect(occ).toHaveLength(7);
    expect(occ.every((o) => zonedParts(o.atMs, "UTC").h === 8)).toBe(true);
    const exact = occ.filter((o) => o.exact);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.atMs).toBe(day(3, 8));
  });

  test("vixie OR rule: dom AND dow both restricted fire on either", () => {
    // July 2026: the 1st is a Wednesday; the 6th is a Monday.
    const spec = parseScheduleSpec("cron 0 12 6 * 3 (UTC)"); // dom=6 OR dow=Wed
    const occ = occurrencesInWindow(spec, null, day(1), day(9));
    const days = occ.map((o) => zonedParts(o.atMs, "UTC").d);
    expect(days).toContain(6); // dom match (Monday the 6th)
    expect(days).toContain(1); // dow match (Wednesday the 1st)
    expect(days).toContain(8); // dow match (Wednesday the 8th)
  });

  test("every-cadence anchors on nextRun and extrapolates BOTH ways", () => {
    const spec = parseScheduleSpec("every 1h");
    const anchor = day(5, 10);
    const occ = occurrencesInWindow(spec, anchor, day(5, 7), day(5, 13));
    expect(occ.map((o) => zonedParts(o.atMs, "UTC").h)).toEqual([
      7, 8, 9, 10, 11, 12,
    ]);
    expect(occ.find((o) => o.atMs === anchor)!.exact).toBe(true);
    expect(occ.filter((o) => o.exact)).toHaveLength(1);
  });

  test("every without an anchor yields nothing (no sound lattice)", () => {
    expect(occurrencesInWindow(parseScheduleSpec("every 1h"), null, day(1), day(2))).toEqual([]);
  });

  test("unparseable schedule degrades to the exact next run only", () => {
    const occ = occurrencesInWindow(null, day(4, 9), day(1), day(8));
    expect(occ).toEqual([{ atMs: day(4, 9), exact: true }]);
  });

  test("one-shot at: inside window once, outside window empty", () => {
    const spec = parseScheduleSpec("2026-07-05T10:00:00.000Z");
    expect(occurrencesInWindow(spec, null, day(1), day(8))).toEqual([
      { atMs: day(5, 10), exact: true },
    ]);
    expect(occurrencesInWindow(spec, null, day(6), day(8))).toEqual([]);
  });

  test("dense schedules are capped, sorted and deduped", () => {
    const spec = parseScheduleSpec("every 1min");
    const occ = occurrencesInWindow(spec, day(1, 0), day(1), day(31));
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES_PER_JOB);
    for (let i = 1; i < occ.length; i++) {
      expect(occ[i]!.atMs).toBeGreaterThan(occ[i - 1]!.atMs);
    }
  });

  test("a single-day-denser-than-budget cron (* * * * *) estimates NOTHING — only the exact next run", () => {
    const spec = parseScheduleSpec("* * * * *");
    const occ = occurrencesInWindow(spec, day(2, 12, 30), day(1), day(8));
    expect(occ).toEqual([{ atMs: day(2, 12, 30), exact: true }]);
  });

  test("an unknown tz label ('exact' is NOT a zone) falls back to viewer-local without throwing", () => {
    const spec = parseScheduleSpec("cron 0 8 * * * (exact)");
    expect(spec).toEqual({ kind: "cron", expr: "0 8 * * *", tz: "exact" });
    const start = new Date(2026, 6, 1).getTime();
    const end = new Date(2026, 6, 4).getTime();
    const occ = occurrencesInWindow(spec, null, start, end);
    expect(occ).toHaveLength(3);
    // Viewer-local 08:00 (the fallback), not UTC.
    expect(new Date(occ[0]!.atMs).getHours()).toBe(8);
  });

  test("cron day walk crosses a month boundary and respects month field", () => {
    const spec = parseScheduleSpec("cron 0 6 1 8 * (UTC)"); // Aug 1st, 06:00
    const occ = occurrencesInWindow(spec, null, day(20), Date.UTC(2026, 7, 10));
    expect(occ).toHaveLength(1);
    const p = zonedParts(occ[0]!.atMs, "UTC");
    expect([p.mo, p.d, p.h]).toEqual([7, 1, 6]);
  });
});
