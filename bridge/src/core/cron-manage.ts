// Provider-neutral wire shapes + pure normalizers for the /cron-manage
// endpoint (Settings > Scheduled management + the thread's cron detail panel).
//
// Gateway param schemas pinned against OpenClaw 2026.7.1 dist (2026-07-12):
//   cron.get/remove {id|jobId} ; cron.run {id, mode?:"due"|"force"} ;
//   cron.runs {id, limit<=200,...} ; cron.update {id, patch:{name?, enabled?,
//   schedule?: {kind:"cron",expr,tz?}|{kind:"every",everyMs}|{kind:"at",at},
//   payload?: partial per-kind, ...}} — all additionalProperties:false.
// Hermes 0.18 cron.manage actions: list | add {name,schedule,prompt} |
//   remove | pause | resume (by job name) — no update/run/history.

export interface CronJobDetail {
  id: string | null;
  name: string | null;
  enabled: boolean | null;
  /** Printable schedule (same rendering as the list summaries). */
  schedule: string | null;
  scheduleKind: string | null; // "cron" | "every" | "at"
  scheduleExpr: string | null; // raw cron expr / ISO at / everyMs as string
  tz: string | null;
  /** The job's prompt (agentTurn.message or systemEvent.text), capped. */
  message: string | null;
  /** True when the stored prompt exceeds the cap: the editor must NOT offer
   *  in-place message editing (saving the capped copy would amputate it). */
  messageTruncated: boolean;
  payloadKind: string | null; // "agentTurn" | "systemEvent" | ...
  deliveryMode: string | null; // "none" | "announce" | "webhook"
  agentId: string | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

export interface CronRunEntry {
  ts: number | null;
  runAtMs: number | null;
  status: string | null; // "ok" | "error" | "skipped"
  summary: string | null; // the run's result text, capped
  error: string | null;
  durationMs: number | null;
  model: string | null;
}

/** The ONLY fields a client may change — a raw patch passthrough would let a
 *  caller rewrite agentId/sessionKey and re-attribute the job to another
 *  agent's users (the same fail-closed rule as the list filtering). */
export interface CronManagePatch {
  name?: string;
  enabled?: boolean;
  schedule?: { kind: "cron"; expr: string; tz?: string }
    | { kind: "every"; everyMs: number }
    | { kind: "at"; at: string };
  /** New prompt text — mapped onto the job's EXISTING payload kind. */
  message?: string;
}

const MESSAGE_CAP = 2000;
const SUMMARY_CAP = 600;
const ERROR_CAP = 300;
const FIELD_CAP = 200;
export const RUNS_LIMIT_MAX = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown, cap = FIELD_CAP): string | null =>
  typeof v === "string" && v ? v.slice(0, cap) : null;
// Date-representable bound (same as convex/lib/scheduled MAX_EPOCH_MS): a
// drifted gateway timestamp beyond it would make Intl.DateTimeFormat throw
// a RangeError and crash the panel.
const MAX_EPOCH_MS = 8.64e15;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_EPOCH_MS
    ? v
    : null;

function printableSchedule(sched: unknown): {
  schedule: string | null;
  scheduleKind: string | null;
  scheduleExpr: string | null;
  tz: string | null;
} {
  if (typeof sched === "string") {
    return { schedule: str(sched), scheduleKind: null, scheduleExpr: str(sched), tz: null };
  }
  if (!isRecord(sched)) {
    return { schedule: null, scheduleKind: null, scheduleExpr: null, tz: null };
  }
  const kind = str(sched.kind);
  const tz = str(sched.tz);
  const expr = str(sched.expr) ?? str(sched.cron);
  if (expr !== null) {
    return {
      schedule: `cron ${expr}${tz !== null ? ` (${tz})` : ""}`.slice(0, FIELD_CAP),
      scheduleKind: kind ?? "cron",
      scheduleExpr: expr,
      tz,
    };
  }
  const at = str(sched.at);
  if (at !== null) {
    return { schedule: `at ${at}`, scheduleKind: kind ?? "at", scheduleExpr: at, tz };
  }
  const everyMs = num(sched.everyMs) ?? num(sched.every);
  if (everyMs !== null) {
    const label =
      everyMs % 3_600_000 === 0
        ? `every ${everyMs / 3_600_000}h`
        : everyMs % 60_000 === 0
          ? `every ${everyMs / 60_000}min`
          : everyMs % 1_000 === 0
            ? `every ${everyMs / 1_000}s`
            : `every ${everyMs}ms`;
    return { schedule: label, scheduleKind: kind ?? "every", scheduleExpr: String(everyMs), tz };
  }
  return { schedule: kind, scheduleKind: kind, scheduleExpr: null, tz };
}

/** Full gateway job (cron.get / cron.add / cron.update response) → detail. */
export function normalizeCronJobDetail(raw: unknown): CronJobDetail {
  const job = isRecord(raw) ? raw : {};
  const payload = isRecord(job.payload) ? job.payload : {};
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const state = isRecord(job.state) ? job.state : {};
  const sched = printableSchedule(job.schedule);
  const rawMessage =
    typeof payload.message === "string" && payload.message !== ""
      ? payload.message
      : typeof payload.text === "string" && payload.text !== ""
        ? payload.text
        : null;
  return {
    id: str(job.id) ?? str(job.jobId),
    name: str(job.name),
    enabled: typeof job.enabled === "boolean" ? job.enabled : null,
    ...sched,
    message: rawMessage !== null ? rawMessage.slice(0, MESSAGE_CAP) : null,
    messageTruncated: rawMessage !== null && rawMessage.length > MESSAGE_CAP,
    payloadKind: str(payload.kind),
    deliveryMode: str(delivery.mode),
    // Fail closed like the list path: a malformed agent pin must NOT read as
    // "default agent" (null) — surface a sentinel the Convex side rejects.
    // TRUNCATING an over-long id could collide with a legitimate agent id
    // and pass the ownership check, so any oversize is invalid too. And an
    // ABSENT field is drift, not a default pin: only an EXPLICIT null means
    // "the gateway default agent" on this management path (the live 2026.7.1
    // cron.get always carries the field).
    agentId:
      job.agentId === null
        ? null
        : typeof job.agentId === "string" &&
            job.agentId !== "" &&
            job.agentId.length <= FIELD_CAP
          ? job.agentId
          : "__invalid__",
    nextRunAtMs: num(state.nextRunAtMs) ?? num(job.nextRunAtMs),
    lastRunStatus: str(state.lastRunStatus) ?? str(job.lastRunStatus),
    createdAtMs: num(job.createdAtMs),
    updatedAtMs: num(job.updatedAtMs),
  };
}

/** cron.runs response → bounded, capped entries (newest first as returned). */
export function normalizeCronRunEntries(raw: unknown): CronRunEntry[] {
  const list = isRecord(raw) && Array.isArray(raw.entries)
    ? raw.entries
    : Array.isArray(raw)
      ? raw
      : [];
  const out: CronRunEntry[] = [];
  for (const e of list) {
    if (!isRecord(e)) continue;
    out.push({
      ts: num(e.ts),
      runAtMs: num(e.runAtMs),
      status: str(e.status),
      summary: str(e.summary, SUMMARY_CAP),
      error: str(e.error, ERROR_CAP),
      durationMs: num(e.durationMs),
      model: str(e.model),
    });
    if (out.length >= RUNS_LIMIT_MAX) break;
  }
  return out;
}

/** Parse + validate the client patch (fail closed on anything unexpected). */
export function parseCronManagePatch(raw: unknown): CronManagePatch | null {
  if (!isRecord(raw)) return null;
  const out: CronManagePatch = {};
  if (raw.name !== undefined) {
    // Same rule as the message: reject oversize, never silently shorten.
    if (
      typeof raw.name !== "string" ||
      raw.name.trim() === "" ||
      raw.name.length > FIELD_CAP
    ) {
      return null;
    }
    out.name = raw.name;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return null;
    out.enabled = raw.enabled;
  }
  if (raw.message !== undefined) {
    // REJECT an oversized prompt instead of slicing it: a silent cut while
    // reporting success would amputate the job's instructions for good.
    if (
      typeof raw.message !== "string" ||
      raw.message.trim() === "" ||
      raw.message.length > MESSAGE_CAP
    ) {
      return null;
    }
    out.message = raw.message;
  }
  if (raw.schedule !== undefined) {
    const s = raw.schedule;
    if (!isRecord(s)) return null;
    if (s.kind === "cron" && typeof s.expr === "string" && s.expr.trim() !== "") {
      out.schedule = {
        kind: "cron",
        expr: s.expr.slice(0, FIELD_CAP),
        ...(typeof s.tz === "string" && s.tz !== "" ? { tz: s.tz.slice(0, FIELD_CAP) } : {}),
      };
    } else if (
      s.kind === "every" &&
      typeof s.everyMs === "number" &&
      Number.isInteger(s.everyMs) &&
      s.everyMs >= 1
    ) {
      out.schedule = { kind: "every", everyMs: s.everyMs };
    } else if (s.kind === "at" && typeof s.at === "string" && s.at.trim() !== "") {
      out.schedule = { kind: "at", at: s.at.slice(0, FIELD_CAP) };
    } else {
      return null;
    }
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Build the gateway cron.update patch from the validated client patch. The
 *  message maps onto the job's CURRENT payload kind (read via cron.get first)
 *  — agentTurn carries `message`, systemEvent carries `text`. Any OTHER kind
 *  (absent, malformed, or a future payload family) returns null: silently
 *  rewriting an unknown payload as agentTurn would change the job's
 *  semantics on a protocol drift. */
export function buildGatewayCronPatch(
  patch: CronManagePatch,
  currentPayloadKind: string | null,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.schedule !== undefined) out.schedule = patch.schedule;
  if (patch.message !== undefined) {
    if (currentPayloadKind === "systemEvent") {
      out.payload = { kind: "systemEvent", text: patch.message };
    } else if (currentPayloadKind === "agentTurn") {
      out.payload = { kind: "agentTurn", message: patch.message };
    } else {
      return null; // unknown payload family — fail closed
    }
  }
  return out;
}
