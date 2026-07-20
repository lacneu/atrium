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
//   { type: "message.snapshot", text }
//   { type: "message.final",    text, error? }
//   { type: "run.status",       status, runId }
//   { type: "tool.status",      name, phase, runId, toolCallId?, input?, output? }
//   { type: "media",            items: [{ filename, path }], runId }
//   { type: "openclaw.frame",   frame }   // deprecated raw passthrough

export const EVENT_OPENCLAW_FRAME = "openclaw.frame"; // deprecated raw passthrough
export const EVENT_MESSAGE_DELTA = "message.delta"; // append `text` to the streaming reply
export const EVENT_MESSAGE_SNAPSHOT = "message.snapshot"; // replace the streaming reply with `text`
export const EVENT_MESSAGE_FINAL = "message.final"; // the turn's authoritative final `text`
export const EVENT_RUN_STATUS = "run.status"; // {status, runId}
export const EVENT_TOOL_STATUS = "tool.status"; // {name, phase, runId, toolCallId?, input?, output?}
export const EVENT_MEDIA = "media"; // {items: [{filename, path}]}
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

/**
 * A normalized event. Intentionally permissive ({ type } + arbitrary fields):
 * the producer (a provider normalizer) builds well-formed literals and the
 * consumer (TurnSink) reads fields structurally per `type`. Kept loose so adding
 * a provider-specific field never breaks the shared contract.
 */
export type NormalizedEvent = Record<string, unknown> & { type: string };

/** Back-compat alias: the OpenClaw normalizer + driver historically used this name. */
export type BridgeEvent = NormalizedEvent;
