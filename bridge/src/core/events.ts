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
//   { type: "tool.status",      name, phase, runId }
//   { type: "media",            items: [{ filename, path }], runId }
//   { type: "openclaw.frame",   frame }   // deprecated raw passthrough

export const EVENT_OPENCLAW_FRAME = "openclaw.frame"; // deprecated raw passthrough
export const EVENT_MESSAGE_DELTA = "message.delta"; // append `text` to the streaming reply
export const EVENT_MESSAGE_SNAPSHOT = "message.snapshot"; // replace the streaming reply with `text`
export const EVENT_MESSAGE_FINAL = "message.final"; // the turn's authoritative final `text`
export const EVENT_RUN_STATUS = "run.status"; // {status, runId}
export const EVENT_TOOL_STATUS = "tool.status"; // {name, phase, runId}
export const EVENT_MEDIA = "media"; // {items: [{filename, path}]}
// {runId} — the agent GENERATED media (e.g. a codex `imageGeneration` item) but the
// turn delivered NO media (no MEDIA:/mediaUrls/outbound path) → nothing for the bridge
// to fetch. A SOC2-safe diagnostic so the #7 self-correction loop can flag the agent's
// missing delivery directive; it carries no content, only the signal.
export const EVENT_MEDIA_UNDELIVERED = "media.undelivered";
// A SUB-AGENT (a child run spawned by THIS chat's agent via `sessions_spawn`) emitted
// observable activity. OBSERVATION-ONLY: this is NEVER part of the parent's message stream
// (the child's output stays on its own lane; the parent reply is unaffected). Carries a
// STRUCTURAL signal — the child session key, a lifecycle phase, and the child's FINAL result
// text — admitted by `payload.spawnedBy === <this chat's sessionKey>`. Consumed by a later,
// capability-gated UI; until then the bridge emits it and the turn-sink ignores it (dormant).
//   { type: "agent.activity", childSessionKey, phase?, text?, done? }
export const EVENT_AGENT_ACTIVITY = "agent.activity";

/**
 * A normalized event. Intentionally permissive ({ type } + arbitrary fields):
 * the producer (a provider normalizer) builds well-formed literals and the
 * consumer (TurnSink) reads fields structurally per `type`. Kept loose so adding
 * a provider-specific field never breaks the shared contract.
 */
export type NormalizedEvent = Record<string, unknown> & { type: string };

/** Back-compat alias: the OpenClaw normalizer + driver historically used this name. */
export type BridgeEvent = NormalizedEvent;
