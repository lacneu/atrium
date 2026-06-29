import { describe, expect, test } from "vitest";
import {
  assessChat,
  actionForErrorCode,
  type DiagAvailability,
  type DiagMessage,
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
  test("an unknown code -> a safe generic fallback", () => {
    expect(actionForErrorCode(null)).toMatch(/bridge logs/i);
    expect(actionForErrorCode("WEIRD")).toMatch(/escalate/i);
  });
});
