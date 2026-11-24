// MODEL FALLBACK — the run was answered by another model than the one selected.
//
// Three frames say it, all on the `agent` channel (v2026.8.2 to v2026.9.36):
//   - `lifecycle` `phase:"fallback"` — the gateway's own failover chain moved to another
//     model: `selectedProvider`, `selectedModel`, `activeProvider`, `activeModel`, plus
//     the reasons (src/auto-reply/reply/agent-runner-result-payloads.ts);
//   - `lifecycle` `phase:"fallback_cleared"` — the session is back on its selected model
//     (same file), with `previousActiveModel`;
//   - `stream:"fallback"` — the PROVIDER rerouted the request, on the Codex harness:
//     `fromModel`, `toModel`, `reason?`
//     (extensions/codex/src/app-server/event-projector-events.ts `handleModelRerouted`).
// The first two are emitted while the reply payloads are built, AFTER the run's work:
// captured arriving after the run's `lifecycle end` and `chat final`, with the run's
// seq back at 1. They are a fact about a RUN, not about whatever turn is live — which is
// why they are read here, apart from the turn's state machine.
//
// The reading is the Control UI's (ui/src/pages/chat/tool-stream-status.ts
// `handleLifecycleFallbackEvent`): a model is named `provider/model`; a frame naming no
// selected or no active model says nothing; a `fallback` whose two names are equal says
// nothing; `fallback_step` (one step of the chain) is not read.
//
// Only the model names leave this module. `reasonSummary`, `attemptSummaries`,
// `attempts[].error` and the Codex `reason` carry provider prose: never read.

/** The model named on the indicator: the ACTIVE one while a fallback holds, the SELECTED
 *  one once it is cleared — the names the Control UI prints. */
export interface ModelFallback {
  runId: string;
  state: "active" | "cleared";
  model: string;
  /** The model that was asked for, when the fallback is active. */
  selected?: string;
}

/** A model name is a config-class slug; anything longer is not one. */
const MAX_MODEL_LABEL_CHARS = 200;

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/** `provider/model`, as the Control UI's `resolveModelLabel` composes it. */
function modelLabel(provider: unknown, model: unknown): string | null {
  const m = trimmed(model);
  if (m === null) return null;
  const p = trimmed(provider);
  let label = m;
  if (p !== null) {
    const prefix = `${p}/`;
    const bare = m.toLowerCase().startsWith(prefix.toLowerCase())
      ? m.slice(prefix.length).trim()
      : m;
    label = `${p}/${bare || m}`;
  } else {
    const slash = m.indexOf("/");
    if (slash > 0) {
      const head = m.slice(0, slash).trim();
      const tail = m.slice(slash + 1).trim();
      if (head && tail) label = `${head}/${tail}`;
    }
  }
  return label.length > MAX_MODEL_LABEL_CHARS ? null : label;
}

/**
 * The fallback a gateway frame states for a run of `sessionKey`, or null.
 *
 * Null for every other frame, for another session's, and for a frame that names no run:
 * without the run there is no bubble to attach it to.
 */
export function modelFallbackFromFrame(frame: unknown, sessionKey: string): ModelFallback | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as { event?: unknown; payload?: unknown };
  if (f.event !== "agent" || typeof f.payload !== "object" || f.payload === null) return null;
  const p = f.payload as Record<string, unknown>;
  if (p.sessionKey !== sessionKey) return null;
  const runId = trimmed(p.runId);
  if (runId === null) return null;
  const data =
    typeof p.data === "object" && p.data !== null && !Array.isArray(p.data)
      ? (p.data as Record<string, unknown>)
      : {};
  let cleared: boolean;
  if (p.stream === "fallback") cleared = false;
  else if (p.stream === "lifecycle" && data.phase === "fallback") cleared = false;
  else if (p.stream === "lifecycle" && data.phase === "fallback_cleared") cleared = true;
  else return null;
  const selected =
    modelLabel(data.selectedProvider, data.selectedModel) ??
    modelLabel(data.fromProvider, data.fromModel);
  const active =
    modelLabel(data.activeProvider, data.activeModel) ??
    modelLabel(data.toProvider, data.toModel);
  if (selected === null || active === null) return null;
  if (cleared) return { runId, state: "cleared", model: selected };
  if (selected === active) return null;
  return { runId, state: "active", model: active, selected };
}
