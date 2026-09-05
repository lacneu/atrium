// Gateway BACKGROUND-TASK correlation (pure module).
//
// OpenClaw runs some tools asynchronously (image/video generation, and any
// future durable work): the tool RESULT acks immediately with structured
// details {async:true, status:"started", taskId} and the turn ends; the
// gateway's task registry keeps working, then DELIVERS by starting a
// spontaneous run on the chat's session whose runId embeds the task id:
// `<tool>:<taskId>:<ok|error>` (pinned live, 2026.7.1-beta.2 capture
// 2026-07-12: run `image_generate:c3e21208-…:ok` on the requesting session).
//
// These two shapes are the ENGAGEMENT contract Atrium tracks: the start
// creates a pending-work row anchored to the requesting turn's message; the
// delivery run is correlated back by taskId (same join pattern as the
// sub-agent announce runs).

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// Gateway 2026.8.x appends the delivery LANE to that id: the announce delivery
// keys its message/idempotency as `${announceId}:agent-loop` and the delivery
// run inherits it (upstream src/agents/subagents/announce/
// subagent-announce-delivery.ts:219,230 — absent from 2026.7.1). Pinned live on
// 2026.8.2 (2026-09-02): `image_generate:85dce36f-…:error:agent-loop`. Only that
// documented lane is accepted, still anchored: an unknown suffix stays a non-match.
const DELIVERY_RE = new RegExp(
  `^([a-z][a-z0-9_]*):(${UUID_RE}):(ok|error)(?::agent-loop)?$`,
);

export interface AsyncTaskStart {
  taskId: string;
  toolName: string;
  /** The bound the TOOL ITSELF declared for this task, in ms, when it states one.
   *
   *  We were already receiving it and throwing it away. A production task ran for
   *  47 HOURS while its own call carried `timeoutMs: 300000` — five minutes — and
   *  the only thing bounding the engagement row was a 24 h net keyed on
   *  `updatedAt`, which the liveness poll refreshed every 30 s and therefore
   *  never fired. A deadline the task published about itself is the most
   *  authoritative one there is; keeping it costs nothing. */
  timeoutMs?: number;
}

export interface TaskDeliveryRun {
  toolName: string;
  taskId: string;
  outcome: "ok" | "error";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Detect a tool result that STARTED a gateway background task. Contract:
 * `output.details.async === true` with a string `taskId` — structured, never
 * parsed from the human text. Errored calls yield null (nothing started).
 */
export function asyncTaskStartFromTool(
  name: string | null,
  phase: string | null,
  output: unknown,
): AsyncTaskStart | null {
  if (name === null || phase !== "completed") return null;
  if (!isRecord(output)) return null;
  const details = output.details;
  if (!isRecord(details)) return null;
  if (details.async !== true) return null;
  const taskId = details.taskId;
  if (typeof taskId !== "string" || taskId === "" || taskId.length > 128) {
    return null;
  }
  // Bounded and sane, or absent: an implausible figure must not become a
  // deadline. Upper bound at 24 h — the safety net's own horizon, so a declared
  // value can only ever TIGHTEN what already applies, never loosen it.
  const declared = details.timeoutMs;
  const timeoutMs =
    typeof declared === "number" &&
    Number.isFinite(declared) &&
    declared > 0 &&
    declared <= 24 * 60 * 60 * 1000
      ? Math.round(declared)
      : undefined;
  return {
    taskId,
    toolName: name.slice(0, 80),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** The stable row key for a background-task engagement (subAgents table). */
export function taskChildKey(taskId: string): string {
  return `task:${taskId}`;
}

/**
 * Parse a task-DELIVERY run id (`<tool>:<taskId>:<ok|error>`), or null. The
 * uuid requirement keeps this strict: ordinary runIds (webchat-…, announce:…,
 * cron:…) never match.
 */
export function taskDeliveryRunFromRunId(
  runId: string | null | undefined,
): TaskDeliveryRun | null {
  if (typeof runId !== "string") return null;
  const m = DELIVERY_RE.exec(runId);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return {
    toolName: m[1],
    taskId: m[2],
    outcome: m[3] as "ok" | "error",
  };
}

/**
 * True for ANY gateway-initiated DELIVERY run on a chat's own session: the
 * background-task family (`<tool>:<taskId>:ok|error`) or a sub-agent announce
 * (`announce:v1:<childSessionKey>:<childRunId>`). On BOTH families the gateway
 * emits no `tool` stream frames (measured live on 2026.7.1) — `item` frames
 * are the only tool telemetry, and a tool started inside one is invisible to
 * the exact spawn-result correlation.
 */
export function isDeliveryRunId(runId: string | null | undefined): boolean {
  if (typeof runId !== "string") return false;
  if (taskDeliveryRunFromRunId(runId) !== null) return true;
  // 2026.8.1+ requester-settle wake (see convex/lib/deliveryRuns.ts): a
  // gateway-initiated synthetic turn on the parent session, no child key.
  if (runId.startsWith("announce:requester-settle:")) return true;
  return runId.startsWith("announce:v1:") && runId.split(":").length >= 4;
}
