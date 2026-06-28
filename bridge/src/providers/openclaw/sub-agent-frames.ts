// Shared classification of CHILD sub-agent frames — the single source of truth for
// both the live producer (normalizer.handleSubAgent -> EVENT_AGENT_ACTIVITY) and
// the persistent consumer (SubAgentObserver -> the Convex store). Keeping the
// state/phase -> status mapping in ONE place means the per-turn signal and the
// stored status can never diverge.
//
// Ground truth: the captured 2026.6.5 SUCCESS + FAILURE frames (test/fixtures/
// subagent_frames*.jsonl). The child lane (spawnedBy === parent sessionKey) carries
// the reliable, mode-independent outcome:
//   chat  payload.state:      delta=running | final=DONE | error=FAILED | aborted=stopped
//   agent lifecycle data.phase: start/startup=running | end=DONE | error=FAILED
// The timeout-vs-generic-error CATEGORY is NOT on the state (both surface as
// `error`); it lives only in the error STRING + the unreliable parent-lane announce,
// so NEVER gate logic on the string — `state === "error"` IS the failure signal.

export type SubAgentStatus = "running" | "done" | "error" | "aborted";

/**
 * Terminal status from a child `chat` frame's `payload.state` (the PRIMARY
 * discriminator). Returns null for non-terminal states (`delta`/unknown), which the
 * caller treats as a keep-alive — the child is already `running`.
 */
export function childChatTerminalStatus(
  state: unknown,
): "done" | "error" | "aborted" | null {
  switch (state) {
    case "final":
      return "done";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return null;
  }
}

/**
 * Status from a child `lifecycle` frame's `data.phase` (the redundant earlier
 * signal): `end`=done, `error`=error, any other non-empty phase (`start`/`startup`/
 * …)=running. Returns null for a missing/empty phase (nothing to surface).
 */
export function childLifecycleStatus(phase: unknown): SubAgentStatus | null {
  if (phase === "error") return "error";
  if (phase === "end") return "done";
  if (typeof phase === "string" && phase !== "") return "running";
  return null;
}
