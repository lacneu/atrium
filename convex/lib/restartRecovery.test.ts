// WHICH RUN A RECOVERY ENTRY RESUMES, by the row right before it — every kind of row
// that can sit there. A wrong attribution is worse than none: in doubt, nothing.

import { describe, expect, test } from "vitest";
import { resumedRunFromRow } from "./restartRecovery";

const R = "webchat-" + "a".repeat(64);
const S = "webchat-" + "b".repeat(64);
const base = { hidden: false, visible: true };

describe("resumedRunFromRow", () => {
  const cases: Array<[what: string, row: Parameters<typeof resumedRunFromRow>[0] & Record<string, unknown>, expected: ReturnType<typeof resumedRunFromRow>]> = [
    // A row a run produced names that run — and the recovery resumes it only when the row
    // is the tail of a turn that was CUT (upstream `isInterruptedTurnEntry`).
    ["an assistant row that stopped on a tool call (the turn was waiting on the tool)", { ...base, role: "assistant", runId: R, stopReason: "toolUse" }, { runId: R, proven: true }],
    ["an assistant row the shutdown aborted (the restart-abort tail)", { ...base, role: "assistant", runId: R, stopReason: "aborted" }, { runId: R, proven: true }],
    ["a tool result of the run", { ...base, role: "toolResult", runId: R }, { runId: R, proven: true }],
    ["a tool result, as the bridge lower-cases the role", { ...base, role: "toolresult", runId: R }, { runId: R, proven: true }],
    ["a nested-tool row of the run", { ...base, role: "custom", runId: R }, { runId: R, proven: true }],
    // The recovery is sent seconds after the gateway is back (or with no restart at all):
    // another run may have ANSWERED in between, and its last row sits right before the entry.
    ["an assistant row that ENDED its reply: maybe another run's (a delivery that ran in between) — nothing", { ...base, role: "assistant", runId: R, stopReason: "stop" }, null],
    ["a hidden reply that ended (a heartbeat's HEARTBEAT_OK, a NO_REPLY) — nothing", { hidden: true, visible: false, role: "assistant", runId: R, stopReason: "stop" }, null],
    ["an assistant row that states no stop reason — nothing", { ...base, role: "assistant", runId: R }, null],
    ["an assistant row that ended in an error (the run is over, not cut) — nothing", { ...base, role: "assistant", runId: R, stopReason: "error" }, null],
    // Upstream keeps the run a steered input went INTO as the executed source: the input's
    // own id (its send) never ran.
    ["a STEERED input: the run it was steered into, never its own send", { ...base, role: "user", runId: S, sendId: S, steerTargetRunId: R }, { runId: R, proven: true }],
    // A plain input row names its SEND. The gateway ran a run under that id only for the
    // send that started a turn; a queued or held input was taken by another run. The
    // caller must find that run known before believing it.
    ["the turn's own input (cut before its first row): its send, to be proven a run", { ...base, role: "user", runId: R, sendId: R }, { runId: R, proven: false }],
    ["a sub-agent announce / a channel input (inter-session): its delivery id, to be proven a run", { ...base, role: "user", runId: "announce:v1:agent:x:subagent:c:run-1", provenanceKind: "inter_session" }, { runId: "announce:v1:agent:x:subagent:c:run-1", proven: false }],
    ["ANOTHER recovery entry (two restarts in a row): that recovery run, to be proven a run", { ...base, role: "user", runId: S, sendId: S, provenanceKind: "internal_system", provenanceSourceTool: "main_session_restart_recovery" }, { runId: S, proven: false }],
    ["an input row that names nothing", { ...base, role: "user" }, null],
    ["a row that named no run, shown with a presentation owner Convex chose (a compaction marker, a system notice)", { ...base, role: "custom", runId: R, presentationOwner: true }, null],
    ["a row with no run at all", { ...base, role: "system" }, null],
  ];
  for (const [what, row, expected] of cases) {
    test(what, () => {
      expect(resumedRunFromRow(row)).toEqual(expected);
    });
  }
});
