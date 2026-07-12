// Scheduled-jobs (gateway cron) policy helpers — PURE, unit-tested.
//
// The bridge's /cron-list returns an INSTANCE's jobs with their raw agentId
// (null = the gateway's default agent on OpenClaw; Hermes is single-agent so
// every job is null). Convex owns the user policy: a user sees the jobs of the
// agents they are entitled to (their effective grants), with a null agentId
// resolving to the instance's default agent.

export interface CronJobSummary {
  id: string | null;
  name: string | null;
  enabled: boolean | null;
  schedule: string | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  agentId: string | null;
}

/** Which of an instance's jobs belong to the user's agents on that instance.
 *  `userAgentIds` = the user's entitled agentIds on the instance;
 *  `defaultAgentId` = the instance's default (a job with agentId null runs
 *  there). Unknown default (null) + null-agent job => NOT shown (fail closed:
 *  never show another user's default-agent automation by guessing). */
export function filterJobsForAgents(
  jobs: CronJobSummary[],
  userAgentIds: readonly string[],
  defaultAgentId: string | null,
): (CronJobSummary & { effectiveAgentId: string })[] {
  const mine = new Set(userAgentIds);
  const out: (CronJobSummary & { effectiveAgentId: string })[] = [];
  for (const j of jobs) {
    const effective = j.agentId ?? defaultAgentId;
    if (effective !== null && mine.has(effective)) {
      out.push({ ...j, effectiveAgentId: effective });
    }
  }
  return out;
}

// Untrusted-response bounds: a misbehaving gateway must not be able to blow
// the action's return-size budget through the tab. Overlong DISPLAY strings
// truncate; identity fields (agentId) reject instead — see below. The parse
// cap is a PATHOLOGY guard only (the JSON body is already in memory; each
// normalized job is <=~1KB, so 20k ≈ 10MB), set far beyond any real tenant so
// the ownership filter — which runs on the FULL parsed set — can never have
// the caller's jobs crowded out by foreign ones. The human-scale cap
// (MAX_JOBS_SHOWN) applies AFTER that filter.
const MAX_JOBS_PARSED = 20_000;
export const MAX_JOBS_SHOWN = 200;
const MAX_FIELD_CHARS = 200;
// Date's representable range (|ms| <= 8.64e15) — an out-of-range epoch would
// make Intl.DateTimeFormat.format throw and crash the whole tab.
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** Defensive parse of the bridge /cron-list response body. */
export function parseCronListResponse(data: unknown): CronJobSummary[] | null {
  if (typeof data !== "object" || data === null) return null;
  const jobs = (data as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_EPOCH_MS
      ? v
      : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v.slice(0, MAX_FIELD_CHARS) : null;
  const out: CronJobSummary[] = [];
  for (const j of jobs.slice(0, MAX_JOBS_PARSED)) {
    if (typeof j !== "object" || j === null) continue;
    const job = j as Record<string, unknown>;
    // Fail CLOSED on the agent pin (this response crossed the network — a
    // stale/divergent bridge is possible): null downstream means "the gateway
    // default agent", so a present-but-malformed value must DROP the job, not
    // silently re-attribute it to the default agent's users.
    const rawAgent = job.agentId;
    let agentId: string | null;
    if (rawAgent === undefined || rawAgent === null) {
      agentId = null;
    } else if (
      typeof rawAgent === "string" &&
      rawAgent !== "" &&
      rawAgent.length <= MAX_FIELD_CHARS
    ) {
      // Identity field: never truncate (a cut id could collide with another
      // agent's legitimate id and mis-attribute the job) — overlong rejects.
      agentId = rawAgent;
    } else {
      continue;
    }
    out.push({
      id: str(job.id),
      name: str(job.name),
      enabled: typeof job.enabled === "boolean" ? job.enabled : null,
      schedule: str(job.schedule),
      nextRunAtMs: num(job.nextRunAtMs),
      lastRunStatus: str(job.lastRunStatus),
      agentId,
    });
  }
  return out;
}
