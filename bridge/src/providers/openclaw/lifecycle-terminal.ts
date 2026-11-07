// IS A LIFECYCLE `error` THE RUN'S END? Upstream's own rule, transcribed.
//
// The gateway does not treat every `stream:"lifecycle" phase:"error"` as a terminal. It
// forwards the raw frame at once, and then:
//   - a DEFINITIVE error finalizes the run immediately (the `chat` error terminal);
//   - any other one is held `AGENT_RUN_TERMINAL_RETRY_GRACE_MS` (15 s) for a retry, and a
//     later lifecycle phase of the same run (`start`, `fallback`, `end`…) cancels it
//     (src/gateway/server-chat.ts:1720-1738, the cancel at :1398-1400, the timer at
//     :751-766; src/agents/agent-run-terminal-outcome.ts:408 at v2026.9.36).
// Upstream pins the sequence in its own test: `lifecycle error` (no settlement) →
// `lifecycle fallback` → `lifecycle end` ends in a `chat` FINAL and never a `chat` error
// (src/gateway/server-chat.agent-events.test.ts:4285-4360).
//
// The Control UI ends a run on the gateway's `chat` terminal only
// (ui/src/pages/chat/chat-gateway.ts:117-200); the agent lifecycle frame is activity to it
// (ui/src/pages/chat/tool-stream.ts:238-244). So Atrium does the same: a non-definitive
// error ends nothing — the gateway's own terminal (its `chat` error once the grace is
// spent, or the retried run's end) decides. This file only says which errors are
// definitive, exactly as upstream decides it; it owns no clock.
//
// Transcribed from packages/normalization-core/src/agent-run-terminal-outcome.ts at
// v2026.9.36: `isDefinitiveRunLifecycle` (:225-241), `resolveAgentRunLifecycleTerminalFacts`
// (:152-199), `resolveAgentRunTerminalFacts` (:102-149), `hasExecutionSettlement`
// (:220-222). String reads follow upstream's `readNonBlankString`
// (packages/normalization-core/src/string-coerce.ts:33-35): a non-blank string is kept AS
// IS, whitespace included, so " timeout" is not "timeout" there either.

type Data = Record<string, unknown>;

const TIMEOUT_PHASES = new Set([
  "queue",
  "preflight",
  "provider",
  "tool_execution",
  "post_turn",
  "gateway_draining",
]);
const HARD_TIMEOUT_PHASES = new Set(["preflight", "provider", "tool_execution", "post_turn"]);

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timeoutPhaseOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return TIMEOUT_PHASES.has(trimmed) ? trimmed : undefined;
}

const isAbortedStopReason = (v: string | undefined): boolean => v === "aborted" || v === "restart";
const isCancellationStopReason = (v: string | undefined): boolean => v === "rpc" || v === "stop";

/** `resolveAgentRunTerminalFacts(...).reason`, for the inputs a lifecycle error yields. */
function terminalReason(input: {
  status: "error" | "timeout";
  stopReason: string | undefined;
  livenessState: unknown;
  timeoutPhase: string | undefined;
  providerStarted: unknown;
}): string {
  const stopReason = nonBlank(input.stopReason);
  const livenessState = nonBlank(input.livenessState);
  const providerStarted =
    typeof input.providerStarted === "boolean" ? input.providerStarted : undefined;
  const restartCancelled = stopReason === "restart";
  const hardTimeout =
    (input.timeoutPhase !== undefined && HARD_TIMEOUT_PHASES.has(input.timeoutPhase)) ||
    (!restartCancelled && input.status === "timeout" && providerStarted === true);
  // `input.status !== "ok"` always holds here: a lifecycle error is never `ok`.
  const cancelled = restartCancelled || isCancellationStopReason(stopReason);
  const liveness = livenessState?.trim().toLowerCase();
  if (hardTimeout) return "hard_timeout";
  if (stopReason === "superseded") return "superseded";
  if (liveness === "blocked") return "blocked";
  if (isAbortedStopReason(stopReason) && !restartCancelled) return "aborted";
  if (cancelled) return "cancelled";
  if (liveness === "abandoned") return "abandoned";
  if (input.status === "timeout") return "timed_out";
  return "failed";
}

/**
 * Upstream's `isDefinitiveRunLifecycle({ phase: "error", data })`: the run published its
 * settlement (`executionSettled`), its fallback chain is exhausted
 * (`fallbackExhaustedFailure`), or the error's terminal reason is anything but a plain
 * `failed` (a timeout, a cancellation, an abort, a blocked or abandoned run). Everything
 * else may still be followed by a retry of the same run.
 */
export function isDefinitiveLifecycleError(data: Data | null | undefined): boolean {
  const d: Data = data ?? {};
  if (d.executionSettled === true) return true;
  if (d.fallbackExhaustedFailure === true) return true;
  const stopReason = nonBlank(d.stopReason);
  const timeoutPhase = timeoutPhaseOf(d.timeoutPhase);
  const status = nonBlank(d.status)?.toLowerCase();
  const timedOut =
    stopReason === "timeout" ||
    timeoutPhase !== undefined ||
    status === "timeout" ||
    status === "timed_out";
  const aborted = d.aborted === true || status === "aborted";
  const cancellationStatus =
    status === "cancelled" ||
    status === "canceled" ||
    status === "aborted" ||
    status === "superseded";
  const cancelled = cancellationStatus || aborted;
  const normalizedStopReason =
    !timedOut &&
    cancelled &&
    !isAbortedStopReason(stopReason) &&
    !isCancellationStopReason(stopReason) &&
    stopReason !== "superseded" &&
    (stopReason === undefined || cancellationStatus)
      ? aborted
        ? "aborted"
        : "stop"
      : stopReason;
  return (
    terminalReason({
      status: timedOut ? "timeout" : "error",
      stopReason: normalizedStopReason,
      livenessState: d.livenessState,
      timeoutPhase,
      providerStarted: d.providerStarted,
    }) !== "failed"
  );
}
