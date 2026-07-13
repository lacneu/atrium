// Correlation of gateway-initiated DELIVERY runs to the subAgents row that
// anchors them (pure, shared by stream.ts reopen + subAgents.turnActivity).
//
// Two run families deliver post-turn results on a chat's session:
//   - `announce:v1:<childSessionKey>:<childRunId>` — a spawned sub-agent's
//     result; the row key IS the embedded childSessionKey.
//   - `<tool>:<taskId>:<ok|error>` — a background TASK's delivery (async
//     tools: image/video generation, any durable gateway work; pinned live on
//     2026.7.1: `image_generate:c3e21208-…:ok`); the row key is the
//     engagement row `task:<taskId>` written when the task started.

const UUID_RE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const TASK_DELIVERY_RE = new RegExp(`^([a-z][a-z0-9_]*):(${UUID_RE}):(ok|error)$`);

/** The subAgents row key a delivery run correlates to, or null when the runId
 *  is not a delivery run (ordinary webchat-… turns). */
export function deliveryChildKey(runId: string): string | null {
  if (runId.startsWith("announce:")) {
    const seg = runId.split(":");
    if (seg.length < 4) return null;
    const key = seg.slice(2, -1).join(":");
    return key === "" ? null : key;
  }
  const m = TASK_DELIVERY_RE.exec(runId);
  if (m !== null && m[2] !== undefined) return `task:${m[2]}`;
  return null;
}

/** A task-delivery run's outcome (":ok" | ":error"), or null for non-task runs. */
export function taskDeliveryOutcome(runId: string): "ok" | "error" | null {
  const m = TASK_DELIVERY_RE.exec(runId);
  return m === null ? null : (m[3] as "ok" | "error");
}
