// The "crons" calendar source: projects the Scheduled tab's already-loaded
// jobs onto CalendarEvents for a window. Pure — the tab passes its (filtered)
// groups in; future sources (user calendar, Twenty) will sit beside this one.

import type { CalendarEvent } from "./calendarData";
import { cronJobStateKind } from "./cronView";
import { occurrencesInWindow, parseScheduleSpec } from "./cronCalendar";

export const CRON_SOURCE_ID = "crons";

export type CronCalendarJob = {
  instanceName: string;
  /** Whether the host may open the edit dialog for this job's instance. */
  canEdit: boolean;
  job: {
    id: string | null;
    name: string | null;
    enabled: boolean | null;
    /** Gateway 2026.8.1+: auto-disabled by the scheduler while `enabled` may
     *  still read `true` — no future occurrence exists (cronView.ts). */
    autoDisabledReason?: string | null;
    schedule: string | null;
    nextRunAtMs: number | null;
    lastRunStatus: string | null;
    agentId: string;
  };
};

/** itemId shared between the events and the host's lookup map. The \u0000
 *  separator cannot appear in an instance name (schema-validated slug). */
export function cronItemId(instanceName: string, jobId: string): string {
  return `${instanceName}\u0000${jobId}`;
}

export function cronEventsInWindow(
  jobs: CronCalendarJob[],
  startMs: number,
  endMs: number,
): { events: CalendarEvent[]; byItemId: Map<string, CronCalendarJob> } {
  const events: CalendarEvent[] = [];
  const byItemId = new Map<string, CronCalendarJob>();
  for (const entry of jobs) {
    const { job } = entry;
    if (job.id === null) continue;
    const itemId = cronItemId(entry.instanceName, job.id);
    byItemId.set(itemId, entry);
    // A PAUSED job will not fire: never extrapolate its schedule — only the
    // gateway's own nextRunAtMs (rare on paused jobs) is worth showing.
    // Only an ACTIVE job has future occurrences: paused OR auto-disabled jobs
    // are not run by the scheduler, so projecting them would draw runs that
    // will never happen (codex P2).
    const inactive = cronJobStateKind(job) !== "active";
    const spec = inactive ? null : parseScheduleSpec(job.schedule);
    const occurrences = occurrencesInWindow(
      spec,
      job.nextRunAtMs,
      startMs,
      endMs,
    );
    for (const occ of occurrences) {
      events.push({
        id: `${itemId}:${occ.atMs}`,
        sourceId: CRON_SOURCE_ID,
        itemId,
        atMs: occ.atMs,
        title: job.name ?? job.id,
        muted: inactive,
        exact: occ.exact,
      });
    }
  }
  return { events, byItemId };
}
