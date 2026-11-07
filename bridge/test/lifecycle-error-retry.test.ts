// A LIFECYCLE ERROR THE GATEWAY MAY RETRY ends nothing (F2, lot « trames 1 »).
//
// Upstream forwards every `lifecycle:error` at once, but makes a run's terminal of it only
// when it is DEFINITIVE; any other one is held 15 s for a retry, cancelled by the run's next
// lifecycle phase (src/gateway/server-chat.ts:1720-1738, :1398-1400, :751-766 at v2026.9.36).
// Atrium closed the turn in error on every one — an error card over an answer the retried
// run then delivered.
//
// The sequences are upstream's OWN, from its gateway tests, replayed as a client receives
// them (each `emitAgentEvent` of the harness is broadcast as an `agent` frame; the terminal
// is the `chat` frame `emitChatTerminal` builds, server-chat.ts:1030-1130):
//   - src/gateway/server-chat.agent-events.test.ts:4285-4360 "keeps chat-linked run
//     remapping alive across per-attempt lifecycle errors": error → fallback → end → FINAL;
//   - :4404-4440 "keeps deferred lifecycle-error cleanup across later non-terminal events":
//     start → error → tool result → (grace spent) the gateway's chat ERROR;
//   - :4362-4399 "finalizes %s immediately": the definitive errors.
import { describe, expect, it } from "vitest";

import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import type { BridgeEvent } from "../src/core/events.js";

const SESSION_KEY = "agent:alice:atrium:chat:u-1:c1";
const RUN = "webchat-run-1";

function startTurn() {
  const n = new Normalizer(SESSION_KEY);
  n.beginTurn(1000);
  n.noteRunStarted(RUN, 1000);
  return n;
}

const agent = (stream: string, data: Record<string, unknown>, seq: number) => ({
  type: "event",
  event: "agent",
  payload: { runId: RUN, sessionKey: SESSION_KEY, stream, data, seq, ts: 1_000_000 + seq },
});

/** The turn's terminal(s): the run status `finalize` publishes beside `message.final`. */
const finals = (events: BridgeEvent[]) =>
  events
    .filter(
      (e) =>
        e.type === "run.status" &&
        ["final", "error", "aborted"].includes(String((e as { status?: unknown }).status)),
    )
    .map((e) => ({ status: String((e as { status?: unknown }).status) }));

// The `data` of the harness's fallback lifecycle (server-chat.agent-events.test.ts:788-794).
const FALLBACK_LIFECYCLE_DATA = {
  phase: "fallback",
  selectedProvider: "fireworks",
  selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
  activeProvider: "deepinfra",
  activeModel: "moonshotai/Kimi-K2.5",
};

describe("a retryable lifecycle error is left to the gateway's terminal", () => {
  it("error → fallback → end → final: the turn completes with the retried answer, never in error", () => {
    const n = startTurn();
    const events: BridgeEvent[] = [];
    events.push(...n.feed(agent("assistant", { text: "draft" }, 1), 1001));
    const atError = n.feed(agent("lifecycle", { phase: "error", error: "provider failed" }, 2), 1002);
    expect(finals(atError), "a retryable error closes nothing").toEqual([]);
    expect(n.finalized).toBe(false);
    expect(n.lifecycleRetryPending).toBe(true);
    // The silence net stays armed: if neither terminal ever came, the transcript is asked.
    expect(n.recvDeadlineArmed).toBe(true);
    // The run's next lifecycle phase is the gateway going on with it (:1398-1400).
    n.feed(agent("lifecycle", FALLBACK_LIFECYCLE_DATA, 3), 1003);
    expect(n.lifecycleRetryPending).toBe(false);
    events.push(...n.feed(agent("lifecycle", { phase: "end" }, 4), 1004));
    events.push(
      ...n.feed(
        {
          type: "event",
          event: "chat",
          payload: {
            runId: RUN,
            sessionKey: SESSION_KEY,
            seq: 5,
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "Recovered reply" }], timestamp: 1 },
          },
        },
        1005,
      ),
    );
    const done = finals(events);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("final");
  });

  it("error → tool → (grace spent) chat error: the gateway's own terminal closes it, classified", () => {
    const n = startTurn();
    n.feed(agent("lifecycle", { phase: "start" }, 1), 1001);
    const atError = n.feed(agent("lifecycle", { phase: "error", error: "request timed out" }, 2), 1002);
    expect(finals(atError)).toEqual([]);
    // A TOOL frame is not a lifecycle phase: upstream keeps its pending terminal (:4404-4440).
    n.feed(agent("tool", { phase: "result", name: "exec", toolCallId: "call-1" }, 3), 1003);
    expect(n.lifecycleRetryPending).toBe(true);
    expect(n.finalized).toBe(false);
    // 15 s later the gateway emits the run's chat error — emitChatTerminal's payload
    // (server-chat.ts:1116-1130), carrying the lifecycle error as `errorMessage`.
    const closed = n.feed(
      {
        type: "event",
        event: "chat",
        payload: { runId: RUN, sessionKey: SESSION_KEY, seq: 4, state: "error", errorMessage: "request timed out" },
      },
      1017,
    );
    const done = finals(closed);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("error");
    expect(n.finalized).toBe(true);
  });

  it("a lifecycle frame without a phase does not count as the run going on (:1344-1345)", () => {
    const n = startTurn();
    n.feed(agent("lifecycle", { phase: "error", error: "provider failed" }, 1), 1001);
    n.feed(agent("lifecycle", { endedAt: 5 }, 2), 1002);
    expect(n.lifecycleRetryPending).toBe(true);
  });
});

describe("a definitive lifecycle error still ends the turn at once", () => {
  it.each([
    ["fallback exhaustion", { fallbackExhaustedFailure: true }],
    ["native cancellation", { aborted: true, stopReason: "aborted" }],
    ["provider timeout", { stopReason: "timeout", timeoutPhase: "provider" }],
    // The run's OWNING terminal, as 2026.9.36 publishes it (agent-lifecycle-terminal.ts:182).
    ["settled execution", { executionSettled: true }],
  ])("%s", (_name, data) => {
    const n = startTurn();
    n.feed(agent("lifecycle", { phase: "error", error: "retryable failure" }, 1), 1001);
    expect(n.finalized).toBe(false);
    const ev = n.feed(agent("lifecycle", { phase: "error", error: "Terminal failure", ...data }, 2), 1002);
    const done = finals(ev);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("error");
    expect(n.finalized).toBe(true);
  });
});
