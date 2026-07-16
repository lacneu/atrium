import { describe, expect, test } from "vitest";
import {
  cronFilterActive,
  cronJobMatches,
  cronResultKind,
  cronStateKind,
  EMPTY_CRON_FILTER,
  monthGrid,
  parseDatetimeLocal,
  searchTimezones,
  toDatetimeLocal,
} from "./cronView";

describe("cronResultKind (last-result badge mapping)", () => {
  test("recognizes ok/error/running synonyms, passes the rest through, null = none", () => {
    expect(cronResultKind("ok")).toBe("ok");
    expect(cronResultKind("SUCCESS")).toBe("ok");
    expect(cronResultKind("error")).toBe("error");
    expect(cronResultKind("failed")).toBe("error");
    expect(cronResultKind("running")).toBe("running");
    expect(cronResultKind("skipped")).toBe("other"); // unknown -> outline+raw
    expect(cronResultKind(null)).toBe("none");
    expect(cronResultKind("")).toBe("none");
  });
});

describe("cronStateKind (enabled state, independent of the result)", () => {
  test("true=active, false=paused, null=unknown", () => {
    expect(cronStateKind(true)).toBe("active");
    expect(cronStateKind(false)).toBe("paused");
    expect(cronStateKind(null)).toBe("unknown");
  });
});

describe("cronJobMatches (client-side filter predicate)", () => {
  const job = {
    name: "OpenClaw Release Watch",
    agentId: "olivier",
    enabled: true,
    lastRunStatus: "ok",
  };
  test("empty filter matches everything", () => {
    expect(cronFilterActive(EMPTY_CRON_FILTER)).toBe(false);
    expect(cronJobMatches(job, EMPTY_CRON_FILTER)).toBe(true);
  });
  test("text matches name OR agent, case-insensitive", () => {
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, q: "release" })).toBe(true);
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, q: "OLIVIER" })).toBe(true);
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, q: "nope" })).toBe(false);
  });
  test("state + result filters gate independently", () => {
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, state: "active" })).toBe(true);
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, state: "paused" })).toBe(false);
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, result: "ok" })).toBe(true);
    expect(cronJobMatches(job, { ...EMPTY_CRON_FILTER, result: "error" })).toBe(false);
    // a never-run paused job
    const paused = { ...job, enabled: false, lastRunStatus: null };
    expect(cronJobMatches(paused, { ...EMPTY_CRON_FILTER, state: "paused", result: "none" })).toBe(true);
  });
  test("cronFilterActive is true when any dimension is set", () => {
    expect(cronFilterActive({ q: "x", state: "all", result: "all" })).toBe(true);
    expect(cronFilterActive({ q: "", state: "active", result: "all" })).toBe(true);
    expect(cronFilterActive({ q: "  ", state: "all", result: "all" })).toBe(false);
  });
});

describe("searchTimezones", () => {
  const all = ["America/New_York", "America/Toronto", "Europe/Paris", "Asia/Tokyo"];
  test("separator/case-insensitive substring, capped", () => {
    expect(searchTimezones(all, "new york", 50)).toEqual(["America/New_York"]);
    expect(searchTimezones(all, "PARIS", 50)).toEqual(["Europe/Paris"]);
    expect(searchTimezones(all, "america", 50)).toEqual([
      "America/New_York",
      "America/Toronto",
    ]);
    expect(searchTimezones(all, "", 2).length).toBe(2); // cap honored
  });
  test("a pinned stored value stays reachable at the top even if filtered out", () => {
    const out = searchTimezones(all, "tokyo", 50, "Pacific/Chatham");
    expect(out[0]).toBe("Pacific/Chatham");
    expect(out).toContain("Asia/Tokyo");
  });
});

describe("monthGrid + datetime-local round-trip", () => {
  test("6x7 Monday-first grid marks in-month days", () => {
    // July 2026: 1st is a Wednesday -> Monday-first lead of 2 padding days.
    const cells = monthGrid(2026, 6);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toMatchObject({ inMonth: false }); // Mon Jun 29
    const firstInMonth = cells.find((c) => c.inMonth);
    expect(firstInMonth).toMatchObject({ year: 2026, month: 6, day: 1 });
    expect(cells.filter((c) => c.inMonth)).toHaveLength(31);
  });
  test("toDatetimeLocal / parse round-trip", () => {
    const s = toDatetimeLocal(2026, 6, 17, 8, 5);
    expect(s).toBe("2026-07-17T08:05");
    expect(parseDatetimeLocal(s)).toEqual({
      year: 2026,
      month: 6,
      day: 17,
      hour: 8,
      minute: 5,
    });
    expect(parseDatetimeLocal("garbage")).toBeNull();
  });
});
