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

  it("the gateway's USER-FACING copy of the rebound, on the wire, classifies like the raw text", () => {
    // 2026.9.3+ (read at v2026.9.4) renders the rebound as `transcript_writer_fenced` copy and ships THAT as
    // the lifecycle `error` and the chat error's `errorMessage` (upstream
    // embedded-agent-subscribe.handlers.lifecycle.ts:151-167,219; server-chat.ts:783,1239).
    const COPY =
      "⚠️ Agent run failed: the transcript writer no longer owned this session. Retry in the current session; if it repeats, check Gateway logs.";
    const started = [...PRELUDE, agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 })];
    // …with the liveness that subscriber stamps on an errored working run (`blocked`,
    // handlers.lifecycle.ts:149-157,243 at v2026.9.36): a definitive error, read at once.
    const viaLifecycle = once([
      ...started,
      agentFrame(6, "lifecycle", { phase: "error", error: COPY, livenessState: "blocked" }),
    ]);
    expect(viaLifecycle?.errorKind).toBe("session_write_conflict");
    const viaChat = once([
      ...started,
      { type: "event", event: "chat", payload: { runId: RUN, sessionKey: SESSION_KEY, seq: 6, state: "error", errorMessage: COPY } },
    ]);
    expect(viaChat?.errorKind).toBe("session_write_conflict");
  });

  it("2026.10.33 rewrote that copy: the same class, the same proof, the same upgrade", () => {
    // `STORAGE_FAILURE_COPY.transcript_writer_fenced` at v2026.10.33
    // (src/agents/failover/assistant-request-failure-copy.ts:57-58,107-109) no longer
    // names a writer. Unrecognized, the turn died without a class — and without the
    // bounded retry of a rebound the stream proves pre-generation.
    const COPY_1033 =
      "⚠️ This conversation changed while OpenClaw was working. Check its latest messages before continuing. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
    const chatErr = (seq: number) => ({
      type: "event",
      event: "chat",
      payload: { runId: RUN, sessionKey: SESSION_KEY, seq, state: "error", errorMessage: COPY_1033 },
    });
    // Before generation: the retryable init conflict, the true class on the trace channel.
    const before = once([...PRELUDE, chatErr(5)]);
    expect(before?.errorKind).toBe("session_init_conflict");
    expect(before?.diagnosticErrorKind).toBe("session_write_conflict");
    // Once the run started: non-retryable, on both carriers.
    const started = [...PRELUDE, agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 })];
    expect(once([...started, chatErr(6)])?.errorKind).toBe("session_write_conflict");
    expect(
      once([
        ...started,
        agentFrame(6, "lifecycle", { phase: "error", error: COPY_1033, livenessState: "blocked" }),
      ])?.errorKind,
    ).toBe("session_write_conflict");
  });

  it("2026.10.33: the Control UI copy carries no cause — the lifecycle error that precedes it does", () => {
    // `renderControlUiAgentFailureCopy()` takes no argument at v2026.10.33
    // (src/agents/failover/user-copy.ts:669-670); the cause of a run that throws rides the
    // lifecycle error, raw (src/auto-reply/reply/agent-lifecycle-terminal.ts:126-132), and
    // the chat error projected from it. The first terminal decides: a later chat error
    // with the cause-less copy must not replace the class nor the text.
    const CONTROL_UI_COPY =
      "⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
    const copyError = (seq: number) => ({
      type: "event",
      event: "chat",
      payload: { runId: RUN, sessionKey: SESSION_KEY, seq, state: "error", errorMessage: CONTROL_UI_COPY },
    });
    const n = new Normalizer(SESSION_KEY);
    let now = 1_000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    const events: BridgeEvent[] = [];
    for (const f of [
      ...PRELUDE,
      agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 }),
      agentFrame(6, "lifecycle", { phase: "error", error: "database or disk is full", executionSettled: true }),
      copyError(7),
    ]) {
      events.push(...n.feed(f, (now += 0.01)));
    }
    events.push(...n.tick(now + 120));
    const finals = events.filter((e) => e.type === "message.final") as Array<Final & { error?: string }>;
    expect(finals).toHaveLength(1);
    expect(finals[0]?.errorKind).toBe("gateway_storage_unavailable");
    expect(finals[0]?.error).toBe("database or disk is full");
    // Alone — no lifecycle terminal was observed — the copy is all there is: the class says
    // the gateway passed on no cause, and none is invented.
    const alone = once([...PRELUDE, agentFrame(5, "lifecycle", { phase: "start", startedAt: 2_000 }), copyError(6)]);
    expect(alone?.errorKind).toBe("run_failed_no_cause");
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
