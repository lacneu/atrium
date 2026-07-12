// describeCronExpr: the plain-language translation a non-technical user reads
// next to the raw cron syntax. Assertions run in the base locale (fr) — each
// test pins a distinct schedule family and would fail if its verbalization
// regressed or if an uncovered shape stopped failing soft.

import { describe, expect, test } from "vitest";
import { cronExprFromSchedule, describeCronExpr } from "./cronDescribe";

describe("describeCronExpr (base locale fr)", () => {
  test("weekly: '0 6 * * 3' -> chaque mercredi a 06:00", () => {
    const s = describeCronExpr("0 6 * * 3");
    expect(s).toContain("mercredi");
    expect(s).toContain("06:00");
  });

  test("weekly list + sunday alias 7: '30 9 * * 1,3,7'", () => {
    const s = describeCronExpr("30 9 * * 1,3,7");
    expect(s).toContain("lundi");
    expect(s).toContain("mercredi");
    expect(s).toContain("dimanche");
    expect(s).toContain("09:30");
  });

  test("weekday range: '0 18 * * 1-5' expands to the five days", () => {
    const s = describeCronExpr("0 18 * * 1-5");
    for (const day of ["lundi", "mardi", "mercredi", "jeudi", "vendredi"]) {
      expect(s).toContain(day);
    }
  });

  test("daily: '45 7 * * *' -> tous les jours a 07:45", () => {
    const s = describeCronExpr("45 7 * * *");
    expect(s).toContain("Tous les jours");
    expect(s).toContain("07:45");
  });

  test("monthly: '0 8 15 * *' names day 15", () => {
    const s = describeCronExpr("0 8 15 * *");
    expect(s).toContain("15");
    expect(s).toContain("chaque mois");
  });

  test("yearly: '0 9 1 7 *' names July", () => {
    const s = describeCronExpr("0 9 1 7 *");
    expect(s).toContain("juillet");
    expect(s).toContain("Chaque ann");
  });

  test("cadences without a time of day", () => {
    expect(describeCronExpr("* * * * *")).toBe("Chaque minute");
    expect(describeCronExpr("*/15 * * * *")).toContain("15 minutes");
    expect(describeCronExpr("30 * * * *")).toContain("minute 30");
    expect(describeCronExpr("0 */6 * * *")).toContain("6 heures");
  });

  test("non-dividing steps FAIL SOFT (*/40 is NOT 'every 40 minutes')", () => {
    expect(describeCronExpr("*/40 * * * *")).toBeNull();
    expect(describeCronExpr("0 */5 * * *")).toBeNull();
    expect(describeCronExpr("*/20 * * * *")).toContain("20 minutes");
  });

  test("uncovered shapes FAIL SOFT (null), never a wrong sentence", () => {
    // dom AND dow both constrained: cron ORs them — ambiguous.
    expect(describeCronExpr("0 6 1 * 3")).toBeNull();
    // multiple hours — outside the covered family.
    expect(describeCronExpr("0 6,18 * * *")).toBeNull();
    // malformed / out-of-range fields.
    expect(describeCronExpr("0 25 * * *")).toBeNull();
    expect(describeCronExpr("not a cron")).toBeNull();
    expect(describeCronExpr("0 6 * *")).toBeNull(); // 4 fields
  });
});

describe("cronExprFromSchedule (the app's schedule string forms)", () => {
  test("raw expr, detail form, and non-cron schedules", () => {
    expect(cronExprFromSchedule("30 9 * * *")).toBe("30 9 * * *");
    expect(cronExprFromSchedule("cron 30 9 * * 3 (America/Toronto)")).toBe(
      "30 9 * * 3",
    );
    expect(cronExprFromSchedule("every 1h")).toBeNull();
    expect(cronExprFromSchedule("at 2026-08-01T09:00:00Z")).toBeNull();
    expect(cronExprFromSchedule(null)).toBeNull();
  });
});
