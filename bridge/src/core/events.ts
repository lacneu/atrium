// The normalized event vocabulary — THE provider abstraction boundary.
//
// Every provider (OpenClaw, later Hermes) parses its own version/vendor-specific
// gateway frames and emits ONLY these events; provider-agnostic core (the
// TurnSink → ConvexWriter seam) consumes them. Moving the vocabulary here (out of
// the OpenClaw `normalizer.ts`) is what lets both providers import the SAME
// contract — see docs/BRIDGE_ARCHITECTURE.md §2.1–2.2.
//
// Event shapes (all carry a `type`; payload fields are read structurally):
//   { type: "message.delta",    text }
//   { type: "message.snapshot", text, replace? }
//   { type: "message.final",    text, error? }
//   { type: "run.status",       status, runId }
//   { type: "tool.status",      name, phase, runId, toolCallId?, input?, output? }
//   { type: "media",            items: [{ filename, path }], runId }
//   { type: "openclaw.frame",   frame }   // deprecated raw passthrough

export const EVENT_OPENCLAW_FRAME = "openclaw.frame"; // deprecated raw passthrough
export const EVENT_MESSAGE_DELTA = "message.delta"; // append `text` to the streaming reply
// replace the streaming reply with `text`. `replace: true` DECLARES that the new
// text may be SHORTER than what is persisted (a compaction reset, an upstream
// `replace` refresh, a sentinel purge); without it Convex refuses a shrink as a
// regression, so a stale snapshot can never truncate a reply already displayed.
export const EVENT_MESSAGE_SNAPSHOT = "message.snapshot";
export const EVENT_MESSAGE_FINAL = "message.final"; // the turn's authoritative final `text`
export const EVENT_RUN_STATUS = "run.status"; // {status, runId}
export const EVENT_TOOL_STATUS = "tool.status"; // {name, phase, runId, toolCallId?, input?, output?}
/** Assistant prose that is NOT the reply — a segment of the turn's own narrative.
 *
 *  Its home is the message BODY, not the activity row: the activity row is the analysis
 *  view and is hidden by default, so a segment routed there is stored and never seen
 *  (lot 34's unfinished half). `{text}` -> internal.stream.addPart(kind:"reasoning"). */
export const EVENT_REASONING = "reasoning"; // {text}
export const EVENT_MEDIA = "media"; // {items: [{filename, path}]}
// {plan} — the agent's work plan from the NATIVE `stream:"plan"` agent event
// (G-22), already normalized into the SAME PlanPart the `update_plan` tool path
// produces. Not a tool call: it must never touch the turn's tool counters.
export const EVENT_PLAN = "plan";
// {phase} — the turn's LIVE processing phase, when the provider normalizer is
// the only place that knows it (e.g. the gateway's deferred terminal,
// `post_processing`). The sink forwards it to setPhase; unknown values are
// dropped server-side, so a newer bridge never breaks an older backend.
export const EVENT_TURN_PHASE = "turn.phase";
// {overfull} — the COMPACTION VERDICT (G-08). Separate from the compaction PART
// on purpose: the part describes what happened during this turn, this verdict
// describes the state the NEXT turn inherits, and a successful compaction must
// be able to clear it without adding a second marker to the thread.
export const EVENT_SESSION_OVERFULL = "session.overfull";
// {reason, completed, refusal} — WHY the gateway compacted, from its own
// `session.operation` account (W2 / G-09). The PRIMARY cause signal; the
// session-id rotation heuristic stays the fallback because this event is
// broadcast `dropIfSlow` and its absence proves nothing. Reason is ALLOWLISTED
// (the failure path carries arbitrary error text upstream).
export const EVENT_COMPACTION_CAUSE = "compaction.cause";
// {runId} — the agent GENERATED media (e.g. a codex `imageGeneration` item) but the
// turn delivered NO media (no MEDIA:/mediaUrls/outbound path) → nothing for the bridge
// to fetch. A SOC2-safe diagnostic so the #7 self-correction loop can flag the agent's
// missing delivery directive; it carries no content, only the signal.
export const EVENT_MEDIA_UNDELIVERED = "media.undelivered";
// A SUB-AGENT (a child run spawned by THIS chat's agent via `sessions_spawn`) emitted
// observable activity. OBSERVATION-ONLY: this is NEVER part of the parent's message stream
// (the child's output stays on its own lane; the parent reply is unaffected). Carries a
// STRUCTURAL signal — the child session key, a STATUS (running/done/error/aborted), a lifecycle
// phase, the child's FINAL result text, and (on failure) the error message — admitted by
// `payload.spawnedBy === <this chat's sessionKey>`. `done:true` marks a terminal frame. Consumed
// by the SubAgentObserver (persisted) + a later capability-gated UI; the turn-sink ignores it.
//   { type: "agent.activity", childSessionKey, status?, phase?, text?, errorMessage?, done? }
export const EVENT_AGENT_ACTIVITY = "agent.activity";
// An item-derived update_plan on a DELIVERY run (announce / task delivery): those
// runs carry NO `tool` stream frames (measured live, 2026.7.1 bench capture
// 2026-07-14), so neither the plan array nor the current step reaches the wire
// (the item meta only names the plan's FIRST step — gateway progress-line
// builder). The event just proves "the plan moved"; the sink counts them per
// turn and Convex advances the last known plan one step per call, stamped
// `estimated`.
//   { type: "plan.advance", runId }
export const EVENT_PLAN_ADVANCE = "plan.advance";
// The GATEWAY compacted this session's context during the turn — older history was
// summarized to fit the model window. Provider-neutral (any gateway that manages
// context emits the same shape). Two detection paths, both pinned on live capture
// (2026-07-03): "preflight" = the session id ROTATED between the pre-send
// `sessions.describe` and the run's frames (compaction ran before the model call;
// no frame carries a compaction marker — rotation is the only signal). "midturn" =
// the run was abandoned mid-stream for a compaction restart (livenessState
// "abandoned", the pre-existing resetForCompaction path). Content-free: the signal
// only, never the summary text. Consumed by the turn-sink → a `compaction` message
// part (the user-facing "context was optimized" marker).
//   { type: "context.compaction", phase: "preflight" | "midturn" }
export const EVENT_CONTEXT_COMPACTION = "context.compaction";

// FRAME LOSS — the one thing that was structurally invisible. Two independent
// sources, both content-free (counters only, safe to trace):
//   - "gateway": the gateway's own per-run diagnostic (`stream:"error"`,
//     `data.reason:"seq gap"`) — it noticed a hole in the agent events it was
//     forwarding and told us. Pinned upstream (server-chat.agent-events.test.ts).
//   - "envelope": OUR detection on the per-connection envelope `seq`. The
//     gateway drops frames to a slow consumer while STILL advancing that counter
//     (server-broadcast.ts), so a hole is the only trace a dropped frame leaves.
//     TARGETED broadcasts carry NO seq — their absence must never read as a hole.
// Observe-only by construction: a lost frame must never fail a turn (the frames
// that did arrive stay valid), so the sink only records a diagnostic.
//   { type: "frame.gap", source: "gateway" | "envelope",
//     expected: number|null, received: number|null, missing: number|null }
export const EVENT_FRAME_GAP = "frame.gap";

/**
 * A normalized event. Intentionally permissive ({ type } + arbitrary fields):
 * the producer (a provider normalizer) builds well-formed literals and the
 * consumer (TurnSink) reads fields structurally per `type`. Kept loose so adding
 * a provider-specific field never breaks the shared contract.
 */
export type NormalizedEvent = Record<string, unknown> & { type: string };

/** Back-compat alias: the OpenClaw normalizer + driver historically used this name. */
export type BridgeEvent = NormalizedEvent;

/**
 * WHEN THE FRAME ARRIVED, carried on every event a normalizer produces from it.
 *
 * Anything the sink derives from a frame and writes as a PLAN is ordered by its
 * cause, not by the moment the write lands (src/chat/planView.ts). The cause is
 * this instant, and it must be the normalizer's `now`, not the sink's clock: an
 * announce frame can be STASHED while another run holds the pipeline and replayed
 * later with its ORIGINAL `now` (run-manager `pendingAnnounce`), so a stamp taken
 * where the sink applies it would date a frame by its replay.
 *
 * Applied by the OpenClaw normalizer on every path that produces events. Hermes
 * carries no plan stream and writes no plan part, so it stamps nothing — and an
 * unstamped event gets NO substitute clock (turn-sink `recvStamp`): the part is
 * written without a stamp and orders by arrival, the behavior that predates this.
 * Substituting `Date.now()` there would mix milliseconds into a field written in
 * SECONDS and pin that part ahead of every real one.
 */
export function stampReceived(
  events: BridgeEvent[],
  now: number,
): BridgeEvent[] {
  for (const event of events) {
    if (event.recvAt === undefined) event.recvAt = now;
  }
  return events;
}
