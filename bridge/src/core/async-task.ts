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
const DELIVERY_RE = new RegExp(`^([a-z][a-z0-9_]*):(${UUID_RE}):(ok|error)$`);

export interface AsyncTaskStart {
  taskId: string;
  toolName: string;
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
  return { taskId, toolName: name.slice(0, 80) };
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
