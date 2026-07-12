// Cron-mutation extraction from a coalesced tool.status event (pure module).
//
// When the agent manages gateway cron jobs during a turn (the OpenClaw `cron`
// tool: action add/update/remove), the thread should surface a dedicated
// "Crons" section — distinct from the generic tool cards — so the user SEES
// that their prompt produced or changed scheduled jobs. This module turns the
// tool call's (input, output) pair into a compact, bounded CronPart; read-only
// actions (list/get/status/runs/wake) and failed calls yield null.
//
// Shapes pinned LIVE against OpenClaw 2026.7.1 (capture 2026-07-12):
//   input  = { action: "add",    job:   { name, schedule, payload, delivery, enabled } }
//          | { action: "update", jobId, patch: { schedule?, payload?, ... } }
//          | { action: "remove", jobId }
//   output = { content: [{type:"text", text:"<job JSON>"}], details: <job> }
//     where <job> = { id, agentId, name, enabled, schedule:{kind,expr|at|everyMs,tz?},
//                     payload:{kind,message?}, delivery:{mode}, state:{nextRunAtMs?} }
//   remove's output carries { removed: true } (no job body).

export interface CronPart {
  kind: "cron";
  op: "created" | "updated" | "removed";
  jobId?: string;
  name?: string;
  enabled?: boolean;
  /** Printable schedule ("cron 30 9 * * * (America/Toronto)", "every 1h", an ISO --at). */
  schedule?: string;
  /** The job's prompt/message (payload.message), truncated — enough for the
   *  user to recognize the job, never the full stored payload. */
  message?: string;
  deliveryMode?: string;
  agentId?: string;
  nextRunAtMs?: number;
}

const MESSAGE_CAP = 300;
const FIELD_CAP = 200;

const MUTATING_ACTIONS: Record<string, CronPart["op"]> = {
  add: "created",
  update: "updated",
  remove: "removed",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, cap = FIELD_CAP): string | undefined {
  return typeof v === "string" && v !== "" ? v.slice(0, cap) : undefined;
}

// Date-representable bound (Intl/toISOString throw beyond it — a drifted
// gateway timestamp must not crash the turn or the detail panel).
const MAX_EPOCH_MS = 8.64e15;
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_EPOCH_MS
    ? v
    : undefined;
}

/** Printable form of a schedule (string shorthand or the structured object). */
export function printableCronSchedule(sched: unknown): string | undefined {
  if (typeof sched === "string") return str(sched);
  if (!isRecord(sched)) return undefined;
  const tz = str(sched.tz);
  const suffix = tz !== undefined ? ` (${tz})` : "";
  const expr = str(sched.expr) ?? str(sched.cron);
  if (expr !== undefined) return `cron ${expr}${suffix}`.slice(0, FIELD_CAP);
  const at = str(sched.at) ?? (num(sched.atMs) !== undefined ? new Date(num(sched.atMs)!).toISOString() : undefined);
  if (at !== undefined) return `at ${at}${suffix}`.slice(0, FIELD_CAP);
  const everyMs = num(sched.everyMs) ?? num(sched.every);
  if (everyMs !== undefined) {
    if (everyMs % 3_600_000 === 0) return `every ${everyMs / 3_600_000}h`;
    if (everyMs % 60_000 === 0) return `every ${everyMs / 60_000}min`;
    if (everyMs % 1_000 === 0) return `every ${everyMs / 1_000}s`;
    return `every ${everyMs}ms`;
  }
  return str(sched.kind);
}

/** The job object carried by the tool RESULT: `details` when present, else the
 *  JSON re-parsed from the first text content block (the gateway emits both). */
function jobFromOutput(output: unknown): Record<string, unknown> | null {
  if (!isRecord(output)) return null;
  const details = output.details;
  if (isRecord(details) && (details.id !== undefined || details.name !== undefined)) {
    return details;
  }
  const content = output.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || typeof block.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (isRecord(parsed) && (parsed.id !== undefined || parsed.name !== undefined)) {
          return parsed;
        }
      } catch {
        /* not JSON — keep scanning */
      }
    }
  }
  return null;
}

/**
 * Extract a CronPart from a coalesced tool.status event, or null when the
 * call is not a successful cron mutation. `phase` must be the coalesced
 * "completed" (an errored call changed nothing worth surfacing).
 */
export function cronPartFromTool(
  name: string | null,
  phase: string | null,
  input: unknown,
  output: unknown,
): CronPart | null {
  if (name !== "cron" || phase !== "completed") return null;
  if (!isRecord(input)) return null;
  const action = typeof input.action === "string" ? input.action : null;
  const op = action !== null ? MUTATING_ACTIONS[action] : undefined;
  if (op === undefined) return null;

  // Field precedence: the RESULT job is authoritative (server-assigned id,
  // normalized schedule, effective enabled); the input job/patch is the
  // fallback when the result omits a field (remove carries no job body).
  const job = jobFromOutput(output);
  const inputJob = isRecord(input.job)
    ? input.job
    : isRecord(input.patch)
      ? input.patch
      : {};
  const payload = isRecord(job?.payload)
    ? job.payload
    : isRecord(inputJob.payload)
      ? inputJob.payload
      : {};
  const delivery = isRecord(job?.delivery)
    ? job.delivery
    : isRecord(inputJob.delivery)
      ? inputJob.delivery
      : {};
  const state = isRecord(job?.state) ? job.state : {};

  const jobId =
    str(job?.id) ?? str(input.jobId) ?? str(input.id) ?? str(inputJob.id);
  const jobName = str(job?.name) ?? str(inputJob.name);
  const enabledRaw = job?.enabled ?? inputJob.enabled;
  const schedule =
    printableCronSchedule(job?.schedule) ?? printableCronSchedule(inputJob.schedule);
  // agentTurn carries `message`; systemEvent carries `text` — read both so a
  // system-event cron's snapshot is not silently empty.
  const message =
    str(payload.message, MESSAGE_CAP) ?? str(payload.text, MESSAGE_CAP);
  const deliveryMode = str(delivery.mode);
  const agentId = str(job?.agentId);
  const nextRunAtMs = num(state.nextRunAtMs);

  return {
    kind: "cron",
    op,
    ...(jobId !== undefined ? { jobId } : {}),
    ...(jobName !== undefined ? { name: jobName } : {}),
    ...(typeof enabledRaw === "boolean" ? { enabled: enabledRaw } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(deliveryMode !== undefined ? { deliveryMode } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
  };
}
