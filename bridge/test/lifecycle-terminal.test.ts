// IS A LIFECYCLE `error` THE RUN'S END? — upstream's rule, transcribed (lifecycle-terminal.ts).
//
// The table below is upstream's OWN, verbatim: src/agents/agent-run-terminal-outcome.test.ts:
// 52-70 at v2026.9.36 ("recognizes whether $label is a definitive lifecycle error"), which pins
// `isDefinitiveRunLifecycle` (packages/normalization-core/src/agent-run-terminal-outcome.ts:
// 225-241). The rows after it exercise the branches of the transcribed reason resolution
// (:102-199) the upstream table does not reach, each named by the line it follows.
import { describe, expect, it } from "vitest";

import { isDefinitiveLifecycleError } from "../src/providers/openclaw/lifecycle-terminal.js";

describe("upstream's own table (agent-run-terminal-outcome.test.ts:52-70)", () => {
  it.each([
    { label: "retryable provider failure", data: { error: "provider failed" }, definitive: false },
    {
      label: "settled execution failure",
      data: { error: "preparation failed", executionSettled: true },
      definitive: true,
    },
    {
      label: "exhausted provider failure",
      data: { error: "provider failed", fallbackExhaustedFailure: true },
      definitive: true,
    },
    { label: "blocked run", data: { livenessState: "blocked" }, definitive: true },
    { label: "abandoned run", data: { livenessState: "abandoned" }, definitive: true },
    { label: "explicit cancellation", data: { aborted: true }, definitive: true },
    { label: "provider timeout", data: { timeoutPhase: "provider" }, definitive: true },
  ])("$label → definitive: $definitive", ({ data, definitive }) => {
    expect(isDefinitiveLifecycleError(data)).toBe(definitive);
  });
});

describe("the branches of the transcribed resolution", () => {
  it.each([
    // :112-114 — a timeout status with the provider reached is a hard timeout.
    { label: "status timeout, provider started", data: { status: "timeout", providerStarted: true }, definitive: true },
    // :131-132 — a timeout status alone is `timed_out`, still not `failed`.
    { label: "status timeout", data: { status: "timeout" }, definitive: true },
    // :163 — the stop reason `timeout` makes the status a timeout.
    { label: "stopReason timeout", data: { stopReason: "timeout" }, definitive: true },
    // :121 — superseded.
    { label: "stopReason superseded", data: { stopReason: "superseded" }, definitive: true },
    // :116-117 — rpc / stop on a non-ok status are cancellations.
    { label: "stopReason rpc", data: { stopReason: "rpc" }, definitive: true },
    { label: "stopReason stop", data: { stopReason: "stop" }, definitive: true },
    // :109 — a restart is a cancellation of its own.
    { label: "stopReason restart", data: { stopReason: "restart" }, definitive: true },
    // :125-126 — aborted.
    { label: "stopReason aborted", data: { stopReason: "aborted" }, definitive: true },
    // :169-174 — a cancellation status.
    { label: "status cancelled", data: { status: "cancelled" }, definitive: true },
    // A timeout phase upstream does not know is no timeout (normalizeAgentRunTimeoutPhase, :75-81).
    { label: "unknown timeoutPhase", data: { timeoutPhase: "elsewhere" }, definitive: false },
    // readNonBlankString keeps the string AS IS (string-coerce.ts:33-35): " timeout" is not "timeout".
    { label: "padded stopReason", data: { stopReason: " timeout" }, definitive: false },
    // …while the liveness is trimmed before it is read (:118).
    { label: "padded livenessState", data: { livenessState: " Blocked " }, definitive: true },
    // A `paused` liveness (a compaction holding the run) is no terminal reason.
    { label: "paused run", data: { livenessState: "paused", error: "x" }, definitive: false },
    // `executionSettled` counts only when it is exactly true (hasExecutionSettlement, :220-222).
    { label: "executionSettled not boolean", data: { executionSettled: "true" }, definitive: false },
    { label: "no data at all", data: undefined, definitive: false },
  ])("$label → definitive: $definitive", ({ data, definitive }) => {
    expect(isDefinitiveLifecycleError(data)).toBe(definitive);
  });
});
