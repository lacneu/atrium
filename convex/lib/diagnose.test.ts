import { describe, expect, test } from "vitest";
import {
  assessChat,
  actionForErrorCode,
  type DiagAvailability,
  type DiagMessage,
  RECENT_SUBAGENT_FAILURE_SECONDS,
} from "./diagnose";

const AVAIL_OK: DiagAvailability = {
  known: true,
  available: true,
  degraded: false,
  reason: null,
};
const msg = (o: Partial<DiagMessage> = {}) => ({
  role: "assistant",
  status: "complete",
  stuckStreaming: false,
  errorCode: null,
  ...o,
});

describe("assessChat — priority + suggested action", () => {
  test("a bad/unknown chat -> unknown_chat (ok severity, no tool)", () => {
    const a = assessChat({ ok: false }, AVAIL_OK);
    expect(a.class).toBe("unknown_chat");
    expect(a.suggestedTool).toBeNull();
  });

  test("a stuck stream WINS and suggests the reconcile_chat tool", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "streaming", stuckStreaming: true })] },
      AVAIL_OK,
    );
    expect(a.class).toBe("stuck_stream");
    expect(a.severity).toBe("high");
    expect(a.suggestedTool).toBe("reconcile_chat");
  });

  test("priority: a stuck stream beats an EARLIER failed turn", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "error", errorCode: "GATEWAY_TIMEOUT" }),
          msg({ status: "streaming", stuckStreaming: true }),
        ],
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("stuck_stream");
  });

  test("last assistant errored -> dispatch_error with the code + a concrete action", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "error", errorCode: "AGENT_NOT_FOUND" })] },
      AVAIL_OK,
    );
    expect(a.class).toBe("dispatch_error");
    expect(a.errorCode).toBe("AGENT_NOT_FOUND");
    expect(a.suggestedAction).toMatch(/OPENCLAW_AGENT_ID/);
  });

  test("an ATTACHMENT_* error -> attachment_problem class", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "error", errorCode: "ATTACHMENT_TOO_LARGE" })] },
      AVAIL_OK,
    );
    expect(a.class).toBe("attachment_problem");
    expect(a.suggestedAction).toMatch(/smaller file/i);
  });

  test("only the LAST assistant message decides (an earlier error is ignored if the last completed)", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "error", errorCode: "GATEWAY_TIMEOUT" }),
          msg({ status: "complete" }),
        ],
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("healthy");
  });

  test("bridge globally unavailable -> critical (blocks all chats)", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "complete" })] },
      { known: true, available: false, degraded: false, reason: "http_502" },
    );
    expect(a.class).toBe("bridge_unavailable");
    expect(a.severity).toBe("critical");
    expect(a.reason).toBe("http_502");
  });

  test("a degraded target (bridge up) -> warn, non-blocking", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "complete" })] },
      { known: true, available: true, degraded: true, reason: null },
    );
    expect(a.class).toBe("bridge_degraded");
    expect(a.severity).toBe("warn");
  });

  test("no problem -> healthy, no action", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "complete" }), msg({ role: "user", status: "complete" })] },
      AVAIL_OK,
    );
    expect(a.class).toBe("healthy");
    expect(a.severity).toBe("ok");
    expect(a.suggestedTool).toBeNull();
  });
});

describe("assessChat — L2 stuck document fetch", () => {
  test("a STALE pendingDocFetch -> attachment_problem + reconcile_chat", () => {
    const a = assessChat(
      { ok: true, messages: [], pendingDocFetch: { ageSeconds: 13 * 60 } },
      AVAIL_OK,
    );
    expect(a.class).toBe("attachment_problem");
    expect(a.severity).toBe("high");
    expect(a.suggestedTool).toBe("reconcile_chat");
    expect(a.summary).toMatch(/fetch/i);
  });

  test("a FRESH pendingDocFetch (still in progress) is NOT flagged", () => {
    const a = assessChat(
      { ok: true, messages: [], pendingDocFetch: { ageSeconds: 20 } },
      AVAIL_OK,
    );
    expect(a.class).toBe("healthy");
  });

  test("priority: a stuck STREAM still wins over a stale doc fetch", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [{ role: "assistant", status: "streaming", stuckStreaming: true, errorCode: null }],
        pendingDocFetch: { ageSeconds: 13 * 60 },
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("stuck_stream");
  });
});

describe("assessChat — sub-agent failures (G3 + bug-C)", () => {
  const subAgents = (o: {
    byStatus?: Partial<{ running: number; done: number; error: number; aborted: number }>;
    failedSample?: { status: string; errorCategory: string; ageSeconds: number }[];
    runningSample?: { status: string; errorCategory: string; ageSeconds: number }[];
  }) => ({
    byStatus: { running: 0, done: 0, error: 0, aborted: 0, ...o.byStatus },
    failedSample: o.failedSample ?? [],
    runningSample: o.runningSample ?? [],
  });

  test("a long-running sub-agent -> subagent_stuck (high, no tool; reaper handles it)", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [msg({ status: "complete" })],
        subAgents: subAgents({
          byStatus: { running: 1 },
          runningSample: [{ status: "running", errorCategory: "unknown", ageSeconds: 25 * 60 }],
        }),
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("subagent_stuck");
    expect(a.severity).toBe("high");
    expect(a.suggestedTool).toBeNull();
  });

  test("a FRESH running sub-agent is NOT flagged (still working)", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [msg({ status: "complete" })],
        subAgents: subAgents({
          byStatus: { running: 1 },
          runningSample: [{ status: "running", errorCategory: "unknown", ageSeconds: 30 }],
        }),
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("healthy");
  });

  test("priority: a stuck STREAM still beats a stuck sub-agent", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [msg({ status: "streaming", stuckStreaming: true })],
        subAgents: subAgents({
          byStatus: { running: 1 },
          runningSample: [{ status: "running", errorCategory: "unknown", ageSeconds: 25 * 60 }],
        }),
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("stuck_stream");
  });

  test("a RECENT failed sub-agent on an otherwise-OK chat -> subagent_failure (warn)", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [msg({ status: "complete" })],
        subAgents: subAgents({
          byStatus: { error: 1 },
          failedSample: [{ status: "error", errorCategory: "tool_failed", ageSeconds: 60 }],
        }),
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("subagent_failure");
    expect(a.severity).toBe("warn");
    expect(a.suggestedTool).toBeNull();
    expect(a.reason).toMatch(/tool_failed/);
  });

  test("an OLD sub-agent failure does NOT flag an otherwise-healthy chat", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [msg({ status: "complete" })],
        subAgents: subAgents({
          byStatus: { error: 1 },
          failedSample: [{ status: "error", errorCategory: "tool_failed", ageSeconds: 60 * 60 }],
        }),
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("healthy");
  });

  test("priority: a failed MAIN turn beats a recent sub-agent failure", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [msg({ status: "error", errorCode: "GATEWAY_TIMEOUT" })],
        subAgents: subAgents({
          byStatus: { error: 1 },
          failedSample: [{ status: "error", errorCategory: "tool_failed", ageSeconds: 60 }],
        }),
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("dispatch_error");
  });
});

describe("actionForErrorCode", () => {
  test("known codes map to specific, non-generic remediations", () => {
    expect(actionForErrorCode("ATTACHMENT_REJECTED")).toMatch(/gateway/i);
    expect(actionForErrorCode("BRIDGE_UNREACHABLE")).toMatch(/BRIDGE_URL/);
    expect(actionForErrorCode("GATEWAY_TIMEOUT")).toMatch(/OPENCLAW_GATEWAY_URL/);
  });
  test("the two NAMED connection ends point at DIFFERENT investigations", () => {
    // The whole point of naming them: waiting out an announced restart and chasing
    // read pressure on the bridge have nothing in common. A shared generic
    // remediation would erase the distinction for every API consumer.
    const restarting = actionForErrorCode("GATEWAY_RESTARTING");
    const saturated = actionForErrorCode("CONNECTION_SATURATED");
    const generic = actionForErrorCode("GATEWAY_DISCONNECTED");
    expect(restarting).not.toBe(generic);
    expect(saturated).not.toBe(generic);
    expect(restarting).not.toBe(saturated);
    expect(restarting).toMatch(/announced|restart/i);
    expect(saturated).toMatch(/slowly|buffer|dropped/i);
    // The two spellings mark two MOMENTS with different delivery states, so they
    // must NOT share a text: before the ack nothing reached the agent, after it the
    // agent had the turn and may resume it. Telling a streaming interruption that
    // "nothing reached the agent" would invite resending work already in flight.
    const midStream = actionForErrorCode("gateway_restarting");
    expect(midStream).not.toBe(restarting);
    // NEITHER may claim the request was refused: a response frame can race ahead of
    // the `chat.send` ack, so a pre-ack close leaves delivery UNPROVEN (codex P1).
    expect(restarting).toMatch(/unproven/i);
    expect(midStream).toMatch(/resume/i);
    for (const a of [restarting, midStream]) {
      expect(a).not.toMatch(/nothing reached the agent/i);
    }
    // …and the mid-stream text must not promise a recovery that a long announced
    // absence skips (the turn is then closed with no poll left).
    expect(midStream).toMatch(/budget|no poll/i);
    const midStreamSat = actionForErrorCode("connection_saturated");
    expect(midStreamSat).not.toBe(saturated);
    expect(midStreamSat).toMatch(/incomplete|dropped/i);
    // Both spellings still stay clear of the generic fallback.
    for (const a of [midStream, midStreamSat]) {
      expect(a).not.toBe(actionForErrorCode("WEIRD"));
    }
  });

  test("an unknown code -> a safe generic fallback", () => {
    expect(actionForErrorCode(null)).toMatch(/bridge logs/i);
    expect(actionForErrorCode("WEIRD")).toMatch(/escalate/i);
  });
});

// A SUB-AGENT'S REPORT IS NOT THIS CHAT'S REPLY.
//
// Live prod 2026-08-04: five `jerome` announces failed in 54 s on a chat whose
// parent turn had answered perfectly. Taking the newest assistant row blindly
// classified that healthy conversation `dispatch_error`, pointing whoever read
// it at a turn that was fine.
describe("failed sub-agent reports do not condemn a healthy chat", () => {
  const ANNOUNCE = "announce:v1:agent:jerome:subagent:x:y";

  test("a failed ANNOUNCE after a good reply is a lost REPORT, not a broken chat", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "complete", runId: "webchat-abc" }),
          msg({ status: "error", runId: ANNOUNCE }),
        ],
      },
      AVAIL_OK,
    );
    // BOTH halves matter. The reply arrived, so this is not the conversation
    // failing (severity high, "the last turn failed") — and a report was lost,
    // so it is not nothing either: calling it healthy hides real work the user
    // asked for and will never see.
    expect(a.class, "the user's reply arrived — the chat is not broken").not.toBe(
      "dispatch_error",
    );
    expect(a.class, "a lost report is reported as nothing at all").toBe(
      "subagent_failure",
    );
    expect(a.severity).toBe("warn");
  });

  test("a real failed TURN is still caught, announces or not", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "error", errorCode: "GATEWAY_TIMEOUT", runId: "webchat-abc" }),
          msg({ status: "complete", runId: ANNOUNCE }),
        ],
      },
      AVAIL_OK,
    );
    expect(a.class).toBe("dispatch_error");
    expect(a.errorCode).toBe("GATEWAY_TIMEOUT");
  });

  test("a message with no runId reads as a TURN (fails closed)", () => {
    const a = assessChat(
      { ok: true, messages: [msg({ status: "error" })] },
      AVAIL_OK,
    );
    expect(a.class, "an unknown shape must never be quietly excluded").toBe(
      "dispatch_error",
    );
  });
});

// NO TURN IN VIEW = NO VERDICT.
describe("a window holding only reports yields no health verdict", () => {
  test("announces only -> inconclusive, never 'healthy'", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "error", runId: "announce:v1:agent:j:subagent:x:y" }),
          msg({ status: "error", runId: "announce:v1:agent:j:subagent:x:z" }),
        ],
      },
      AVAIL_OK,
    );
    expect(
      a.class,
      "a failed turn just outside the window would read as good health",
    ).not.toBe("healthy");
    // The deliveries FAILED, and that is knowable: `unknown_chat` is the verdict
    // when nothing can be concluded, not when the only thing in view went wrong.
    expect(a.class).toBe("subagent_failure");
  });

  test("announces that all SUCCEEDED, and no turn, remain inconclusive", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "complete", runId: "announce:v1:agent:j:subagent:x:y" }),
          msg({ status: "complete", runId: "announce:v1:agent:j:subagent:x:z" }),
        ],
      },
      AVAIL_OK,
    );
    expect(
      a.class,
      "a failed turn just outside the window would read as good health",
    ).toBe("unknown_chat");
  });

  test("an OLD lost delivery does not condemn a chat that recovered", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({
            status: "error",
            runId: "announce:v1:agent:j:subagent:x:y",
            ageSeconds: RECENT_SUBAGENT_FAILURE_SECONDS + 60,
          }),
          msg({ status: "complete", runId: "webchat-later" }),
        ],
      },
      AVAIL_OK,
    );
    expect(
      a.class,
      "one old lost report pins the verdict until it scrolls out of the window",
    ).toBe("healthy");
  });

  test("an OLD lost delivery does not bury a degraded bridge either", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({
            status: "error",
            runId: "announce:v1:agent:j:subagent:x:y",
            ageSeconds: RECENT_SUBAGENT_FAILURE_SECONDS + 60,
          }),
          msg({ status: "complete", runId: "webchat-later" }),
        ],
      },
      { known: true, available: true, degraded: true, reason: "target down" },
    );
    expect(a.class).toBe("bridge_degraded");
  });

  test("a degraded target does not hide a lost delivery", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "complete", runId: "webchat-abc" }),
          msg({ status: "error", runId: "announce:v1:agent:j:subagent:x:y" }),
        ],
      },
      { known: true, available: true, degraded: true, reason: "target down" },
    );
    // A generic note about the bridge's targets must not outrank direct,
    // chat-specific evidence that a result was lost HERE.
    expect(
      a.class,
      "a bridge-wide note buries the lost result in this chat",
    ).toBe("subagent_failure");
  });

  test("a window with no turn does not hide a bridge outage", () => {
    const a = assessChat(
      {
        ok: true,
        messages: [
          msg({ status: "complete", runId: "announce:v1:agent:j:subagent:x:y" }),
        ],
      },
      { known: true, available: false, degraded: false, reason: "unreachable" },
    );
    // "Nothing can be concluded about THIS chat" must never outrank a fact that
    // holds for EVERY chat.
    expect(
      a.class,
      "an inconclusive per-chat verdict outranks a global outage",
    ).toBe("bridge_unavailable");
    expect(a.severity).toBe("critical");
  });

  test("an empty chat is still healthy (nothing has failed)", () => {
    const a = assessChat({ ok: true, messages: [] }, AVAIL_OK);
    expect(a.class).toBe("healthy");
  });
});
