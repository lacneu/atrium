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

/** A child run id as upstream mints it: `crypto.randomUUID()` or
 *  `swarm_<32 hex>` (subagent-spawn-request.ts:268-274, acp-spawn.ts:413), or the
 *  gateway's own `agent` RPC run id. Neither ':' nor ',' can occur — both are
 *  separators of the settle grammar below, so admitting them would let one id
 *  masquerade as two. Shared with the ingest boundary (bridge_ingest.ts). */
export const CHILD_RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** More members than any yielded batch we can correlate in one mutation: a
 *  larger batch fails CLOSED to its own bubble instead of fanning out reads. */
const MAX_SETTLE_BATCH = 32;

/** The parsed identity of a requester-settle wake run.
 *
 *  Grammar (OpenClaw v2026.9.6), read from the RIGHT because the requester
 *  session key itself contains ':':
 *    `announce:` + `requester-settle:<requesterAgentId|unknown>:<requesterSessionKey>:
 *      <childRunId>[,<childRunId>…]` [`:yield-<rearmGeneration>`] [`:retry-<attempt>`]
 *  - prefix: announce-idempotency.ts:10,18-20 (`buildAnnounceIdempotencyKey`);
 *  - base + yield suffix: subagent-announce.requester-settle-wake.ts:433-440;
 *  - retry suffix, only on a re-attempt of a non-private batch: ibid. :501-505;
 *  - the ids are the settled CHILD run ids, sorted: ibid. :256 — the same
 *    `runId` the `sessions_spawn` result returns (subagent-spawn.ts:682-686,
 *    sessions-spawn-tool.ts:710-711) and the last segment of `announce:v1:`.
 *
 *  `yieldGeneration` is non-null EXACTLY when the requester turn yielded:
 *  `rearmGeneration` is only ever minted inside `settleRequesterTurnAfterSessionSpawns`
 *  under `params.requesterYielded` (subagent-registry-requester-yield.ts:255-290),
 *  and it is what makes the wake carry `requireVisibleReply` (requester-settle-
 *  wake.ts:362-364, 426-432, 623-625): the run IS the yielded turn's continuation.
 *
 *  Null on anything that does not parse. An unknown trailing lane is NOT
 *  rejected here — `…:yield-1:<lane>` reads as a no-yield wake whose "id" is the
 *  lane — and it does not need to be: it then carries no yield generation, which
 *  never merges (stream.ts `settleContinuationAnchor`), and a lane word never
 *  names a recorded child run. A future lane surfaces as a separate bubble, never
 *  as a guess. */
export function parseRequesterSettleRun(
  runId: string | null | undefined,
): { childRunIds: string[]; yieldGeneration: number | null } | null {
  if (!isRequesterSettleRun(runId)) return null;
  const seg = (runId as string).split(":");
  if (/^retry-\d+$/.test(seg[seg.length - 1] ?? "")) seg.pop();
  let yieldGeneration: number | null = null;
  const yieldMatch = /^yield-(\d+)$/.exec(seg[seg.length - 1] ?? "");
  if (yieldMatch !== null && yieldMatch[1] !== undefined) {
    yieldGeneration = Number(yieldMatch[1]);
    seg.pop();
  }
  const ids = (seg.pop() ?? "").split(",");
  // `announce`, `requester-settle`, agent id, and at least one session-key
  // segment must remain in front of the id list.
  if (seg.length < 4) return null;
  if (ids.length === 0 || ids.length > MAX_SETTLE_BATCH) return null;
  if (!ids.every((id) => CHILD_RUN_ID_RE.test(id))) return null;
  return { childRunIds: ids, yieldGeneration };
}

/** The provenance stamp a delivery GENERATION writes on the parts it inserts
 *  (`messageParts.announceRun`), or undefined for an ordinary turn.
 *
 *  Every post-turn delivery family stamps — announce, background task AND the
 *  requester-settle continuation. The settle family used to fall outside it only
 *  because the predicate was `deliveryChildKey(...) !== null`, which is null for
 *  it by design (it names no child key). Once a settle run can MERGE into the
 *  turn it continues, an unstamped part is indistinguishable from the parent's
 *  own: the hand-off exemption would match the parent's stale `sessions_yield`,
 *  and a replay could fuse into the parent's parts. */
export function deliveryPartStamp(
  runId: string | null | undefined,
): string | undefined {
  if (typeof runId !== "string") return undefined;
  return isRequesterSettleRun(runId) || deliveryChildKey(runId) !== null
    ? runId
    : undefined;
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

/** The child run ids of the merged continuations a bubble VISIBLY followed up.
 *
 *  A batch named by `continuations[i]` says the agent RECEIVED those children's
 *  results — not that it did anything with them: a continuation can end on no
 *  answer at all. A batch counts as followed up only when the reader can see
 *  something after it: text past its continuation point, or a delivered file
 *  stamped by a settle run of that batch or of a later one (files carry no text
 *  offset; the stamp is `messageParts.announceRun`, `deliveryPartStamp`). Pure,
 *  shared by the message projection and its tests. */
export function followedUpChildRunIds(
  text: string,
  continuations: ReadonlyArray<{ at: number; childRunIds: readonly string[] }>,
  fileStamps: ReadonlyArray<string | undefined>,
): string[] {
  const key = (ids: readonly string[]) => [...ids].sort().join(",");
  const fileBatches = new Set<string>();
  for (const stamp of fileStamps) {
    const settle = parseRequesterSettleRun(stamp);
    if (settle !== null) fileBatches.add(key(settle.childRunIds));
  }
  const out: string[] = [];
  continuations.forEach((c, i) => {
    const byText = text.slice(c.at).trim() !== "";
    const byFile = continuations
      .slice(i)
      .some((later) => fileBatches.has(key(later.childRunIds)));
    if (byText || byFile) out.push(...c.childRunIds);
  });
  return out;
}
