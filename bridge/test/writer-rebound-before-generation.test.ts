// A WRITER-CLAIM REBOUND IS RETRYABLE ONLY WHEN THE STREAM PROVES NOTHING RAN.
//
// Upstream throws "session writer claim changed before transcript persistence" while
// an attempt is still being PREPARED (run/session-bootstrap.ts
// prepareInitialSessionWriter, run/pre-persisted-user-turn.ts
// preparePersistedCurrentUserTurn) and at transcript commits once the model has run
// (run/settled-turn-finalization.ts). The text is identical; the stream is not: a
// generating run emits `lifecycle start` before its provider loop
// (packages/agent-core/src/agent-loop.ts `agent_start`), and on every run of a full
// 2026.9.4 bench capture the only frames before it were `chat` status and `agent`
// run_status. The first version of this lot said "nothing on the wire tells them
// apart" and left the pre-generation case unretried (raised in review).
//
// The frame shapes below are the captured ones, identifiers anonymised.

import { describe, expect, it } from "vitest";
import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";

const SESSION_KEY = "agent:main:atrium:chat:u-testuser01:own-chat";
const RUN = "run-own";
const REBOUND =
  "SessionTranscriptWriterClaimReboundError: session writer claim changed before transcript persistence";

const chatStatus = (seq: number, phase: string) => ({
  type: "event",
  event: "chat",
  payload: { runId: RUN, sessionKey: SESSION_KEY, agentId: "main", seq, state: "status", phase },
});
const runStatus = (seq: number, phase: string) => ({
  type: "event",
  event: "agent",
  payload: {
    runId: RUN,
    stream: "run_status",
    data: { phase },
    sessionKey: SESSION_KEY,
    agentId: "main",
    seq,
    ts: 1_000 + seq,
    isHeartbeat: false,
  },
});
const agentFrame = (seq: number, stream: string, data: Record<string, unknown>, runId = RUN) => ({
  type: "event",
  event: "agent",
  payload: { runId, stream, data, sessionKey: SESSION_KEY, agentId: "main", seq, ts: 1_000 + seq, isHeartbeat: false },
});
const chatError = (seq: number) => ({
  type: "event",
  event: "chat",
  payload: { runId: RUN, sessionKey: SESSION_KEY, seq, state: "error", errorMessage: REBOUND },
});

/** What a run sends while it is prepared — nothing here proves generation. */
const PRELUDE = [
  chatStatus(1, "preparing_workspace"),
  runStatus(2, "preparing_workspace"),
  chatStatus(3, "preparing_context"),
  runStatus(4, "preparing_context"),
];

type Final = { errorKind?: string | null; diagnosticErrorKind?: string | null };

function turn(
  n: Normalizer,
  frames: unknown[],
  setup?: (n: Normalizer) => void,
  start = 1_000,
): Final | undefined {
  let now = start;
  n.beginTurn(now);
  n.noteRunStarted(RUN, now);
  setup?.(n);
  const events: BridgeEvent[] = [];
  for (const f of frames) events.push(...n.feed(f, (now += 0.01)));
  events.push(...n.tick(now + 120));
  return events.find((e) => e.type === "message.final") as Final | undefined;
}

const once = (frames: unknown[], setup?: (n: Normalizer) => void) =>
  turn(new Normalizer(SESSION_KEY), frames, setup);

describe("a writer-claim rebound is retried only when the stream proves nothing ran", () => {
  it("after the preparation prelude alone, it becomes the retryable init conflict", () => {
    const final = once([...PRELUDE, chatError(5)]);
    expect(final?.errorKind).toBe("session_init_conflict");
    // The true class is not erased: it rides the trace-only channel.
    expect(final?.diagnosticErrorKind).toBe("session_write_conflict");
  });

  it("once the run STARTED, it stays non-retryable even with zero content", () => {
    const final = once([...PRELUDE, agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 }), chatError(6)]);
    expect(final?.errorKind).toBe("session_write_conflict");
  });

  it("a LOST start is still covered by any other generation frame", () => {
    const final = once([
      ...PRELUDE,
      agentFrame(5, "tool", { phase: "start", name: "exec", toolCallId: "call-1" }),
      chatError(6),
    ]);
    expect(final?.errorKind).toBe("session_write_conflict");
  });

  it("the failure's OWN lifecycle terminal is not evidence of generation", () => {
    // A run that fails while being prepared ends like any run; counting its terminal
    // would make the upgrade unreachable for exactly the case it exists for.
    const final = once([...PRELUDE, agentFrame(5, "lifecycle", { phase: "error", error: REBOUND }), chatError(6)]);
    expect(final?.errorKind).toBe("session_init_conflict");
  });

  it("a known stream GAP keeps the conservative class", () => {
    const final = once([...PRELUDE, chatError(5)], (n) => n.noteStreamGap());
    expect(final?.errorKind).toBe("session_write_conflict");
  });

  it("a refused foreign-run frame keeps it — it could have been this run's start", () => {
    const final = once([
      ...PRELUDE,
      agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 }, "run-other"),
      chatError(6),
    ]);
    expect(final?.errorKind).toBe("session_write_conflict");
  });

  it("a transcript recovery standing in for frames keeps it", () => {
    const final = once([...PRELUDE, chatError(5)], (n) => n.markRecoveryAttempted());
    expect(final?.errorKind).toBe("session_write_conflict");
  });

  it("the gateway's USER-FACING copy of the rebound, on the wire, classifies like the raw text", () => {
    // 2026.9.3+ (read at v2026.9.4) renders the rebound as `transcript_writer_fenced` copy and ships THAT as
    // the lifecycle `error` and the chat error's `errorMessage` (upstream
    // embedded-agent-subscribe.handlers.lifecycle.ts:151-167,219; server-chat.ts:783,1239).
    const COPY =
      "⚠️ Agent run failed: the transcript writer no longer owned this session. Retry in the current session; if it repeats, check Gateway logs.";
    const started = [...PRELUDE, agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 })];
    const viaLifecycle = once([...started, agentFrame(6, "lifecycle", { phase: "error", error: COPY })]);
    expect(viaLifecycle?.errorKind).toBe("session_write_conflict");
    const viaChat = once([
      ...started,
      { type: "event", event: "chat", payload: { runId: RUN, sessionKey: SESSION_KEY, seq: 6, state: "error", errorMessage: COPY } },
    ]);
    expect(viaChat?.errorKind).toBe("session_write_conflict");
  });

  it("evidence and gaps belong to ONE turn", () => {
    const n = new Normalizer(SESSION_KEY);
    const first = turn(n, [...PRELUDE, agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 }), chatError(6)], (x) =>
      x.noteStreamGap(),
    );
    expect(first?.errorKind).toBe("session_write_conflict");
    const second = turn(n, [...PRELUDE, chatError(5)], undefined, 5_000);
    expect(second?.errorKind).toBe("session_init_conflict");
  });
});
