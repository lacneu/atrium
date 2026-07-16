// Pure, testable logic for the Scheduled (crons) tab: the last-result badge
// mapping (SHARED by the table column and the run-history dialog), the
// client-side filter predicate, timezone search, and the calendar grid for the
// custom date-time picker. No React, no i18n — the components map these to
// badges/labels. (Repo convention: push decisions into pure units.)

/** The last run's OUTCOME class — distinct from the job's enabled/paused STATE.
 *  The gateway status is an open-ended string; we recognize the common ones and
 *  pass everything else through as "other" (rendered outline with the raw
 *  text). `null` = the job has never run -> "none". */
export type CronResultKind = "ok" | "error" | "running" | "other" | "none";

export function cronResultKind(status: string | null | undefined): CronResultKind {
  if (status === null || status === undefined || status === "") return "none";
  const s = status.trim().toLowerCase();
  if (s === "ok" || s === "success" || s === "completed") return "ok";
  if (s === "error" || s === "failed" || s === "failure") return "error";
  if (s === "running" || s === "in_progress" || s === "pending") return "running";
  return "other";
}

/** The job's ENABLED state, independent of the last result. */
export type CronStateKind = "active" | "paused" | "unknown";

export function cronStateKind(enabled: boolean | null | undefined): CronStateKind {
  if (enabled === true) return "active";
  if (enabled === false) return "paused";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Client-side filtering — the crons are already fully loaded (grouped by
// instance), so filtering is in-memory (no new query). Pure predicate.
// ---------------------------------------------------------------------------

export type CronFilter = {
  /** Case-insensitive substring over the job name + agent id. "" = no text. */
  q: string;
  /** "all" | a CronStateKind. */
  state: string;
  /** "all" | a CronResultKind. */
  result: string;
};

export const EMPTY_CRON_FILTER: CronFilter = { q: "", state: "all", result: "all" };

export function cronFilterActive(f: CronFilter): boolean {
  return f.q.trim() !== "" || f.state !== "all" || f.result !== "all";
}

/** Does a job pass the active filters? Total + pure. */
export function cronJobMatches(
  job: {
    name: string | null;
    agentId: string;
    enabled: boolean | null;
    lastRunStatus: string | null;
  },
  f: CronFilter,
): boolean {
  const q = f.q.trim().toLowerCase();
  if (q !== "") {
    const hay = `${job.name ?? ""} ${job.agentId}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (f.state !== "all" && cronStateKind(job.enabled) !== f.state) return false;
  if (f.result !== "all" && cronResultKind(job.lastRunStatus) !== f.result) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Timezone search — Intl.supportedValuesOf("timeZone") is ~450 entries; render
// only the filtered top-N. Pure (the list is injected).
// ---------------------------------------------------------------------------

/** The IANA timezone list, or [] when the runtime lacks supportedValuesOf. */
export function allTimezones(): string[] {
  try {
    const fn = (
      Intl as unknown as {
        supportedValuesOf?: (k: string) => string[];
      }
    ).supportedValuesOf;
    return typeof fn === "function" ? fn("timeZone") : [];
  } catch {
    return [];
  }
}

/** The browser's own zone (the sensible default), or "" if unavailable. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** Filter + cap the zone list for the combobox. A matching stored `pinned`
 *  value is kept at the top even when the query would exclude it. Case- and
 *  separator-insensitive ("new york" matches "America/New_York"). */
export function searchTimezones(
  all: string[],
  query: string,
  limit = 50,
  pinned?: string,
): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[_/]+/g, " ");
  const q = norm(query.trim());
  const matches = q === "" ? all : all.filter((z) => norm(z).includes(q));
  const out = matches.slice(0, limit);
  if (pinned && pinned !== "" && !out.includes(pinned)) {
    // Keep a stored (possibly non-listed) zone reachable at the top.
    return [pinned, ...out].slice(0, limit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calendar grid for the custom (chart-themed) date picker. Monday-first weeks
// covering `month`, padded with the trailing/leading days of the adjacent
// months. Pure — deterministic given (year, month).
// ---------------------------------------------------------------------------

export type CalendarCell = {
  /** Local Y-M-D of this cell. */
  year: number;
  month: number; // 0-based
  day: number;
  /** False for the padding days from the previous/next month. */
  inMonth: boolean;
};

/** 6 weeks x 7 days, Monday-first. */
export function monthGrid(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  // JS getDay: 0=Sun..6=Sat -> Monday-first offset.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
    });
  }
  return cells;
}

/** Serialize a local date+time to the `datetime-local` value the editor uses
 *  ("yyyy-MM-ddTHH:mm"). Pure. */
export function toDatetimeLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(year, 4)}-${p(month + 1)}-${p(day)}T${p(hour)}:${p(minute)}`;
}

/** Parse a `datetime-local` value into parts, or null. Pure. */
export function parseDatetimeLocal(
  value: string,
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi] = m;
  return {
    year: Number(y),
    month: Number(mo) - 1,
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
  };
}
