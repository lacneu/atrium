// Plain-language rendering of a 5-field cron expression ("30 9 * * 3" ->
// "chaque mercredi, 09:30") so a non-technical user understands WHEN the job
// fires without reading cron syntax. The syntax stays displayed next to it —
// this is an addition, never a replacement. Locale-aware via Intl (weekday /
// month names, time format, list joining) + parameterized i18n templates.
// FAIL-SOFT by design: any field shape outside the covered common cases
// returns null and the UI simply shows the raw expression alone.

import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

type Field =
  | { kind: "any" }
  | { kind: "step"; n: number }
  | { kind: "values"; values: number[] };

/** Parse one cron field into the small shape family we can verbalize. */
function parseField(raw: string, min: number, max: number): Field | null {
  if (raw === "*") return { kind: "any" };
  const step = /^\*\/(\d{1,3})$/.exec(raw);
  if (step !== null) {
    const n = Number(step[1]);
    return n >= 1 ? { kind: "step", n } : null;
  }
  // Lists of values and simple ranges ("1,3,5", "1-5", "1-5,0"), expanded.
  const values: number[] = [];
  for (const part of raw.split(",")) {
    const range = /^(\d{1,3})-(\d{1,3})$/.exec(part);
    if (range !== null) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b || a < min || b > max) return null;
      for (let v = a; v <= b; v++) values.push(v);
      continue;
    }
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v < min || v > max) return null;
    values.push(v);
  }
  return values.length > 0 && values.length <= 31
    ? { kind: "values", values }
    : null;
}

/** Localized "HH:MM" via Intl (12h/24h per locale). */
function timeLabel(hour: number, minute: number): string {
  const d = new Date(2024, 0, 1, hour, minute);
  return new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Localized weekday name for a cron dow value (0/7 = Sunday). */
function weekdayName(dow: number): string {
  // 2024-09-01 is a Sunday; day i of that week is Sunday + i.
  const d = new Date(2024, 8, 1 + (dow % 7));
  return new Intl.DateTimeFormat(getLocale(), { weekday: "long" }).format(d);
}

/** Localized month name for a cron month value (1-12). */
function monthName(mon: number): string {
  const d = new Date(2024, mon - 1, 1);
  return new Intl.DateTimeFormat(getLocale(), { month: "long" }).format(d);
}

function joinList(items: string[]): string {
  try {
    return new Intl.ListFormat(getLocale(), {
      style: "long",
      type: "conjunction",
    }).format(items);
  } catch {
    return items.join(", ");
  }
}

/**
 * Describe a 5-field cron expression in the active locale, or null when the
 * shape is beyond the covered common cases (the caller then shows only the
 * raw syntax). Covered: every minute, every N minutes/hours, hourly at a
 * minute, daily / weekly (weekday lists + ranges) / monthly / yearly times.
 */
export function describeCronExpr(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;

  // Cases without a fixed time-of-day first.
  if (hour.kind === "any" && dom.kind === "any" && month.kind === "any" && dow.kind === "any") {
    if (minute.kind === "any") return m.cron_desc_every_minute();
    // "Every N minutes" is only TRUE when N divides 60 — */40 actually fires
    // at :00 and :40 (alternating 40/20-minute gaps): fail soft there.
    if (minute.kind === "step") {
      return 60 % minute.n === 0
        ? m.cron_desc_every_n_minutes({ n: minute.n })
        : null;
    }
    if (minute.values.length === 1) {
      return m.cron_desc_hourly({ m: String(minute.values[0]).padStart(2, "0") });
    }
    return null;
  }
  // Every N hours (at a fixed minute).
  if (
    hour.kind === "step" &&
    minute.kind === "values" &&
    minute.values.length === 1 &&
    dom.kind === "any" &&
    month.kind === "any" &&
    dow.kind === "any"
  ) {
    return 24 % hour.n === 0 ? m.cron_desc_every_n_hours({ n: hour.n }) : null;
  }

  // Everything below needs ONE fixed time of day.
  if (
    minute.kind !== "values" ||
    minute.values.length !== 1 ||
    hour.kind !== "values" ||
    hour.values.length !== 1
  ) {
    return null;
  }
  const time = timeLabel(hour.values[0], minute.values[0]);

  // Weekly: fixed weekdays, any day-of-month/month. (When BOTH dom and dow
  // are constrained, cron ORs them — too ambiguous to verbalize: fail soft.)
  if (dow.kind === "values" && dom.kind === "any" && month.kind === "any") {
    const names = [...new Set(dow.values.map((v) => v % 7))]
      .sort((a, b) => a - b)
      .map(weekdayName);
    return m.cron_desc_weekly({ days: joinList(names), time });
  }
  if (dow.kind !== "any") return null;

  // Daily.
  if (dom.kind === "any" && month.kind === "any") {
    return m.cron_desc_daily({ time });
  }
  // Monthly / yearly: one fixed day of month.
  if (dom.kind === "values" && dom.values.length === 1) {
    if (month.kind === "any") {
      return m.cron_desc_monthly({ dom: dom.values[0], time });
    }
    if (month.kind === "values" && month.values.length === 1) {
      return m.cron_desc_yearly({
        dom: dom.values[0],
        month: monthName(month.values[0]),
        time,
      });
    }
  }
  return null;
}

/**
 * Extract the 5-field expression from the schedule strings this app renders:
 * the raw expr ("30 9 * * *"), the detail form ("cron 30 9 * * * (tz)"), or
 * null for non-cron schedules ("every 1h", "at 2026-...", already readable).
 */
export function cronExprFromSchedule(schedule: string | null): string | null {
  if (schedule === null) return null;
  const match = /^(?:cron\s+)?([\d*,/-]+(?:\s+[\d*,/-]+){4})(?:\s*\(|$)/.exec(
    schedule.trim(),
  );
  return match !== null ? match[1] : null;
}
