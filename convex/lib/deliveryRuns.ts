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
// 2026.8.x suffixes the delivery LANE (`…:ok:agent-loop`, see
// bridge/src/core/async-task.ts DELIVERY_RE for the upstream anchor); only that
// documented lane is accepted, the anchor stays.
const TASK_DELIVERY_RE = new RegExp(
  `^([a-z][a-z0-9_]*):(${UUID_RE}):(ok|error)(?::agent-loop)?$`,
);

/** The delivery LANES upstream appends to an ANNOUNCE identity. Both compose ON
 *  TOP of the v1 grammar, so the child run id stops being the last segment and a
 *  bare `slice(2, -1)` folds it into the child KEY — the row then never settles
 *  and the chat holds a finished child as `running` until the reaper.
 *    subagent-announce-delivery.ts:229        -> `…:agent-loop`
 *    subagent-announce-descendant-wake.ts:111 -> `…:wake`
 *  The task family above already tolerated `:agent-loop`; the announce family
 *  never got the same treatment. Listed and never guessed: an unknown suffix
 *  stays part of the key rather than being silently eaten, so a new upstream
 *  lane surfaces as a visible miss instead of a wrong correlation. */
const ANNOUNCE_DELIVERY_LANES: readonly string[] = ["agent-loop", "wake"];

/** The subAgents row key a delivery run correlates to, or null when the runId
 *  is not a delivery run (ordinary webchat-… turns). */
/** Gateway 2026.8.1+ wakes the REQUESTER session after a direct completion
 *  delivery with a synthetic turn, `announce:requester-settle:<agentId>:
 *  <requesterSessionKey>:<childRunIds>[:yield-N]` (upstream
 *  subagent-announce.requester-settle-wake.ts:389; absent from 2026.7.1). It is
 *  gateway-initiated but names NO child key — its 3rd+ segments are the parent's
 *  own session key — so it must never correlate to a subAgents row. Captured
 *  live on 2026.8.2 (2026-09-02): lifecycle + usage frames, no assistant text. */
export function isRequesterSettleRun(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith("announce:requester-settle:");
}
export function deliveryChildKey(runId: string): string | null {
  if (isRequesterSettleRun(runId)) return null;
  // BROADER THAN THE BRIDGE ON PURPOSE — `announce:` here, `announce:v1:` there
  // (run-families.ts `announcedChildKey`). An adversarial review called that a lockstep
  // break and it is not: the two readers answer different questions.
  //
  // This one runs on the INGEST AUTHORIZATION path. Narrowing it to `v1:` was tried on
  // 2026-09-12 and immediately opened a hole: `bridgeIngestIsolation.test.ts` forges
  // `announce:1:spy-child:done`, and with the narrow prefix the row stopped being
  // recognised as a delivery at all — the durable-stamp gate never ran and a FORGED
  // announce re-own returned 200 where it must return 403. Recognising an
  // announce-SHAPED identity is what lets it be refused; a parser that only knows the
  // generations it likes cannot police the ones it does not.
  //
  // The bridge's narrowness is equally deliberate: it only SETTLES rows it can name, so
  // refusing an unknown generation there costs a reaper wait, never a wrong write.
  if (runId.startsWith("announce:")) {
    const seg = runId.split(":");
    const last = seg[seg.length - 1];
    if (last !== undefined && ANNOUNCE_DELIVERY_LANES.includes(last)) seg.pop();
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

/** A task-delivery run's parsed identity ({toolName, taskId}), or null for
 *  non-task runs. The toolName is the CHAIN key: sequential generations keep
 *  starting the next task inside the previous delivery run, and the gateway
 *  emits no tool frames on those runs, so the tool family is the only stable
 *  correlation between the links. */
export function taskDeliveryIdentity(
  runId: string,
): { toolName: string; taskId: string } | null {
  const m = TASK_DELIVERY_RE.exec(runId);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { toolName: m[1], taskId: m[2] };
}

/** Is this run a post-turn DELIVERY — either family — rather than the user's
 *  own turn? The distinction decides which alarm a failure raises and whether a
 *  failed bubble means "the conversation's reply failed": both families deliver
 *  a result the parent turn already announced, and both merge into that turn's
 *  bubble, rotating its runId.
 *
 *  Fails CLOSED: an absent or unrecognised run reads as a user turn, so a shape
 *  we do not know is never quietly demoted out of the alarm that matters most. */
export function isDeliveryRun(runId: string | null | undefined): boolean {
  if (isRequesterSettleRun(runId)) return true;
  return typeof runId === "string" && deliveryChildKey(runId) !== null;
}
