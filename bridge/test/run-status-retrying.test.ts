/**
 * A provider retry the `chat` stream does not say: read from the agent stream.
 *
 * Upstream emits `stream:"run_status"` `phase:"retrying"` on every transient retry
 * (v2026.9.5 to v2026.9.36):
 *   - the embedded runner's `onRetry` (src/agents/embedded-agent-runner/run/
 *     attempt-recovery.ts): `{phase, message, retryAttempt, maxRetries, delayMs, attempt,
 *     maxAttempts, reason}`;
 *   - the Codex harness's `handleRetry`
 *     (extensions/codex/src/app-server/event-projector-events.ts): `{phase, message}` —
 *     no counters, no reason.
 * The gateway projects it onto `chat` as a `status` frame, rewritten to `starting_model`,
 * and adds `retry` ONLY when the reason is `rate_limit` (src/gateway/server-chat.ts). So
 * an overloaded provider, a server error, a timeout, and every retry of the Codex
 * harness reached Atrium as a bare status, and the turn showed nothing while it waited.
 *
 * No `retrying` frame was ever captured (the bench provokes no provider retry): the
 * frames below are built from the two writers. The startup frame is verbatim (bench run
 * 2026-11-08T17-17-24-387Z).
 */

import { describe, expect, it } from "vitest";

import { Normalizer } from "../src/providers/openclaw/normalizer.js";

const SK = "agent:alice:atrium:chat:u-repro:turn-nx7cex5wra1yec9v1h926pndj98ht523";
const RUN = "webchat-a599dd8b38ca381650649d0345460c97d6c4d6377e9d69274f3feeff7c7d91f8";

const runStatus = (data: Record<string, unknown>, runId = RUN) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, stream: "run_status", data, sessionKey: SK, agentId: "alice", isHeartbeat: false },
});

/** The embedded runner's `onRetry` payload for a non-rate-limit reason. */
const EMBEDDED = {
  phase: "retrying",
  message: "Provider temporarily unavailable. Retrying in 5s (1/3).",
  retryAttempt: 1,
  maxRetries: 3,
  delayMs: 5_000,
  attempt: 2,
  maxAttempts: 4,
  reason: "overloaded",
};
/** The Codex harness's `handleRetry` payload. */
const CODEX = { phase: "retrying", message: "Connection interrupted. The provider is retrying." };

function open(): Normalizer {
  const n = new Normalizer(SK);
  n.beginTurn(1_000);
  n.noteRunStarted(RUN, 1_001);
  return n;
}
type Phase = { type: string; phase?: string; retry?: unknown; onlyIfRetrying?: boolean };
const phases = (events: { type: string }[]): Phase[] =>
  (events as Phase[]).filter((e) => e.type === "turn.phase");

describe("run_status `retrying` publishes the existing back-off phase", () => {
  it("the embedded shape carries its counter", () => {
    const got = phases(open().feed(runStatus(EMBEDDED), 1_002));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ phase: "retrying", retry: { attempt: 2, maxAttempts: 4 } });
  });

  it("the Codex-harness shape, which counts nothing, says retrying without a counter", () => {
    const got = phases(open().feed(runStatus(CODEX), 1_002));
    expect(got).toHaveLength(1);
    expect(got[0]?.phase).toBe("retrying");
    expect(got[0]?.retry).toBeUndefined();
  });

  it("the gateway's sentence never leaves the bridge", () => {
    for (const data of [EMBEDDED, CODEX]) {
      // (The raw-frame passthrough event aside: it is the frame itself, not a reading.)
      const read = open()
        .feed(runStatus(data), 1_002)
        .filter((e) => e.type !== "openclaw.frame");
      expect(read.length).toBeGreaterThan(0);
      expect(JSON.stringify(read)).not.toContain("Retrying in");
      expect(JSON.stringify(read)).not.toContain("provider is retrying");
    }
  });

  it.each([
    { attempt: 11, maxAttempts: 11 },
    { attempt: 0, maxAttempts: 3 },
    { attempt: 3, maxAttempts: 2 },
    { attempt: 2.5, maxAttempts: 4 },
    { attempt: "2", maxAttempts: 4 },
  ])("counters outside the label's contract are dropped, the wait is still said: %o", (counters) => {
    const got = phases(open().feed(runStatus({ ...EMBEDDED, ...counters }), 1_002));
    expect(got).toHaveLength(1);
    expect(got[0]?.phase).toBe("retrying");
    expect(got[0]?.retry).toBeUndefined();
  });

  it("a continuation after an output limit is not a provider wait: nothing is said", () => {
    expect(phases(open().feed(runStatus({ ...EMBEDDED, reason: "output_limit" }), 1_002))).toStrictEqual([]);
  });
});

describe("what ends it, and what does not", () => {
  it("the bare `chat` status the gateway projects for the same retry does not clear it", () => {
    const n = open();
    n.feed(runStatus(EMBEDDED), 1_002);
    const projected = {
      type: "event",
      event: "chat",
      payload: { runId: RUN, sessionKey: SK, agentId: "alice", seq: 3, state: "status", phase: "starting_model" },
    };
    expect(phases(n.feed(projected as never, 1_003))).toStrictEqual([]);
  });

  it("the run speaking again clears it — and only it", () => {
    const n = open();
    n.feed(runStatus(CODEX), 1_002);
    const got = phases(
      n.feed(
        {
          type: "event",
          event: "agent",
          payload: { runId: RUN, sessionKey: SK, stream: "assistant", data: { text: "Bonjour", delta: "Bonjour" } },
        } as never,
        1_003,
      ),
    );
    expect(got).toContainEqual(expect.objectContaining({ phase: "generating", onlyIfRetrying: true }));
  });

  it("a second retry republishes with its own counter", () => {
    const n = open();
    n.feed(runStatus(EMBEDDED), 1_002);
    const got = phases(n.feed(runStatus({ ...EMBEDDED, retryAttempt: 2, attempt: 3 }), 1_003));
    expect(got[0]).toMatchObject({ phase: "retrying", retry: { attempt: 3, maxAttempts: 4 } });
  });
});

describe("what is not read", () => {
  it("a startup phase publishes nothing (captured frame)", () => {
    // Verbatim, envelope seq 4.
    const captured = {
      type: "event",
      event: "agent",
      payload: {
        runId: RUN,
        stream: "run_status",
        data: { phase: "preparing_workspace" },
        sessionKey: SK,
        agentId: "alice",
        seq: 1,
        ts: 1794158268968,
        isHeartbeat: false,
      },
      seq: 4,
    };
    const n = open();
    expect(phases(n.feed(captured as never, 1_002))).toStrictEqual([]);
    for (const phase of ["preparing_context", "starting_model", "memory_flushing", "waiting_for_state"]) {
      expect(phases(n.feed(runStatus({ phase }), 1_003)), phase).toStrictEqual([]);
    }
  });

  it("a startup phase after a retry does not clear the label either", () => {
    // Upstream re-emits a startup phase only when it CHANGES, so none follows a retry
    // that resumes on the same phase; one that does arrive says nothing about the wait.
    const n = open();
    n.feed(runStatus(EMBEDDED), 1_002);
    expect(phases(n.feed(runStatus({ phase: "starting_model" }), 1_003))).toStrictEqual([]);
  });

  it("a retry frame after the turn's terminal publishes nothing", () => {
    const n = open();
    n.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: SK,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      } as never,
      1_002,
    );
    expect(n.finalized).toBe(true);
    expect(phases(n.feed(runStatus(EMBEDDED), 1_003))).toStrictEqual([]);
  });
});
