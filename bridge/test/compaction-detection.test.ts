// Gateway compaction detection (Inc 1/2 of the gateway-observability initiative).
//
// Frame shapes are PINNED ON LIVE CAPTURE (2026-07-03, OpenClaw 2026.6.11,
// scratchpad compaction-checkpoint-fixture.json): a PREFLIGHT compaction leaves
// NO marker in the frame stream — the only observable signal is the session id
// ROTATION (pre-send describe sessionId "9629dc55…" vs run frames' payload
// .sessionId "f2591abe…", confirmed by the checkpoint's pre/postCompaction ids).
// A MID-TURN compaction surfaces as lifecycle end with livenessState "abandoned"
// (the resetForCompaction path) — kept as the MULTI-VERSION FALLBACK heuristic.
//
// Since v2026.7.1 the gateway also emits EXPLICIT {stream:"compaction"} agent
// events ({phase:"start"} / {phase:"end", willRetry, completed} — upstream
// embedded-agent-subscribe.handlers.compaction.ts): the authoritative mid-turn
// signal, PREFERRED over the heuristic when present (upstream "abandoned" is
// any replayInvalid terminal without visible text, NOT compaction). The
// explicit overflow path never resets accumulated text (the run continues on
// the same runId with no lifecycle end).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Normalizer,
  BASE_RECV_TIMEOUT,
  COMPACTION_RECV_TIMEOUT,
  LIFECYCLE_END_GRACE,
} from "../src/providers/openclaw/normalizer.js";
import type { BridgeEvent } from "../src/core/events.js";
import { TurnSink } from "../src/core/turn-sink.js";
import { bucketCompactionReason } from "../src/core/compaction-verdict.js";
import type {
  CompactionPart,
  ConvexWriter,
  FinalizeStatus,
} from "../src/convex-writer.js";

const SESSION_KEY = "agent:alice:atrium:chat:olivier:chatcompaction001";
const RUN = "webchat-compaction-run-1";
// Real ids from the live capture's checkpoint (pre/postCompaction).
const PRE_SESSION_ID = "9629dc55-ae59-4753-9656-dd1475814866";
const POST_SESSION_ID = "f2591abe-bcf6-4eb7-a568-c6472ab58483";

/** A lifecycle frame as captured live (payload.sessionId TOP-LEVEL). */
function lifecycleFrame(
  sessionId: string,
  data: Record<string, unknown>,
): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN,
      sessionKey: SESSION_KEY,
      sessionId,
      agentId: "alice",
      stream: "lifecycle",
      data,
    },
  };
}

function assistantFrame(sessionId: string, text: string): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN,
      sessionKey: SESSION_KEY,
      sessionId,
      stream: "assistant",
      data: { text, delta: text },
    },
  };
}

function startTurn(expected: string | null): Normalizer {
  const n = new Normalizer(SESSION_KEY);
  n.beginTurn(0);
  n.noteExpectedSessionId(expected);
  n.noteRunStarted(RUN, 0);
  return n;
}

function compactionEvents(events: BridgeEvent[]): BridgeEvent[] {
  return events.filter((e) => e.type === "context.compaction");
}

describe("compaction-by-rotation (preflight)", () => {
  it("rotated session id on the first own frame -> ONE preflight signal", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(lifecycleFrame(POST_SESSION_ID, { phase: "start" }), 1),
      ...n.feed(assistantFrame(POST_SESSION_ID, "Bonjour"), 2),
    ];
    const comp = compactionEvents(ev);
    expect(comp).toHaveLength(1);
    expect(comp[0]?.phase).toBe("preflight");
  });

  it("same session id -> no signal", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(lifecycleFrame(PRE_SESSION_ID, { phase: "start" }), 1),
      ...n.feed(assistantFrame(PRE_SESSION_ID, "Bonjour"), 2),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
  });

  it("no expectation seeded (fresh session / no describe) -> adopt silently", () => {
    const n = startTurn(null);
    const ev = [
      ...n.feed(lifecycleFrame(POST_SESSION_ID, { phase: "start" }), 1),
      ...n.feed(assistantFrame(POST_SESSION_ID, "Bonjour"), 2),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
  });

  it("signal fires at most once per turn (id keeps flapping)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(assistantFrame(POST_SESSION_ID, "a"), 1),
      ...n.feed(assistantFrame(PRE_SESSION_ID, "b"), 2),
      ...n.feed(assistantFrame(POST_SESSION_ID, "c"), 3),
    ];
    expect(compactionEvents(ev)).toHaveLength(1);
  });

  it("frames without a sessionId never trigger (older gateways)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const bare = {
      type: "event",
      event: "agent",
      payload: {
        runId: RUN,
        sessionKey: SESSION_KEY,
        stream: "assistant",
        data: { text: "x", delta: "x" },
      },
    };
    expect(compactionEvents(n.feed(bare, 1))).toHaveLength(0);
  });
});

describe("mid-turn compaction (livenessState abandoned)", () => {
  it("abandoned end -> ONE midturn signal; the follow-up rotation is suppressed", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev: BridgeEvent[] = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "partial"), 1),
      // The gateway abandons the run to compact (real midturn shape).
      ...n.feed(
        lifecycleFrame(PRE_SESSION_ID, {
          phase: "end",
          livenessState: "abandoned",
          replayInvalid: true,
        }),
        2,
      ),
      // The replay run arrives on the ROTATED id — same compaction, no 2nd signal.
      ...n.feed(assistantFrame(POST_SESSION_ID, "resumed"), 3),
    ];
    const comp = compactionEvents(ev);
    expect(comp).toHaveLength(1);
    expect(comp[0]?.phase).toBe("midturn");
  });

  it("a normal lifecycle end (working) never signals", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "done"), 1),
      ...n.feed(
        lifecycleFrame(PRE_SESSION_ID, {
          phase: "end",
          stopReason: "stop",
          livenessState: "working",
        }),
        2,
      ),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
  });
});

// --- Explicit {stream:"compaction"} signals (gateway v2026.7.1+) -------------

/** An explicit compaction agent event as the gateway emits it. */
function compactionStreamFrame(
  sessionId: string,
  data: Record<string, unknown>,
): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN,
      sessionKey: SESSION_KEY,
      sessionId,
      stream: "compaction",
      data,
    },
  };
}

describe("explicit compaction stream (primary mid-turn signal)", () => {
  it("start -> ONE midturn marker, accumulated text NEVER reset", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev: BridgeEvent[] = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1),
      ...n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2),
      ...n.feed(
        compactionStreamFrame(PRE_SESSION_ID, {
          phase: "end",
          willRetry: true,
          completed: true,
        }),
        3,
      ),
    ];
    const comp = compactionEvents(ev);
    expect(comp).toHaveLength(1);
    expect(comp[0]?.phase).toBe("midturn");
    // Unlike the abandoned heuristic, the explicit path never blanks the
    // buffer: no empty snapshot is emitted, the streamed prefix stays valid.
    expect(
      ev.some((e) => e.type === "message.snapshot" && e.text === ""),
    ).toBe(false);
  });

  it("widened budget from start; willRetry:true keeps it; resumed content restores the normal one", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1);
    n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2);
    expect(n.compactionPending).toBe(true);
    expect(n.nextTimeout(2)).toBe(COMPACTION_RECV_TIMEOUT);
    // Overflow replay announced (no lifecycle end will ever come): the widened
    // budget survives the compaction end.
    n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        willRetry: true,
        completed: true,
      }),
      3,
    );
    expect(n.compactionPending).toBe(true);
    expect(n.nextTimeout(3)).toBe(COMPACTION_RECV_TIMEOUT);
    // Content resumes on the SAME run — compaction over, normal budget back.
    n.feed(assistantFrame(PRE_SESSION_ID, "part1 part2"), 4);
    expect(n.compactionPending).toBe(false);
    expect(n.nextTimeout(4)).toBe(BASE_RECV_TIMEOUT);
  });

  it("end without retry (threshold settled) restores the normal budget immediately", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1);
    n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2);
    n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        willRetry: false,
        completed: true,
      }),
      3,
    );
    expect(n.compactionPending).toBe(false);
    expect(n.nextTimeout(3)).toBe(BASE_RECV_TIMEOUT);
  });

  it("explicit signal present -> the abandoned heuristic stands down (no reset, no 900s wait)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev: BridgeEvent[] = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "the answer"), 1),
      ...n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2),
      ...n.feed(
        compactionStreamFrame(PRE_SESSION_ID, {
          phase: "end",
          willRetry: false,
          completed: true,
        }),
        3,
      ),
      ...n.feed(assistantFrame(PRE_SESSION_ID, "the answer, complete"), 4),
      // Upstream v2026.7.1: abandoned = ANY replayInvalid terminal without
      // visible text — NOT compaction. With explicit signals seen this turn,
      // it is a plain terminal end.
      ...n.feed(
        lifecycleFrame(PRE_SESSION_ID, {
          phase: "end",
          livenessState: "abandoned",
          replayInvalid: true,
        }),
        5,
      ),
    ];
    // No second marker, and CRUCIALLY no buffer reset (no empty snapshot).
    expect(compactionEvents(ev)).toHaveLength(1);
    expect(
      ev.some((e) => e.type === "message.snapshot" && e.text === ""),
    ).toBe(false);
    // Normal follow-on grace, not the 900s compaction wait.
    expect(n.nextTimeout(5)).toBe(LIFECYCLE_END_GRACE);
    // The grace elapses -> the turn closes FINAL with the streamed text intact.
    const done = n.tick(5 + LIFECYCLE_END_GRACE + 1);
    const final = done.find((e) => e.type === "message.final") as
      | { text?: string }
      | undefined;
    expect(final?.text).toBe("the answer, complete");
  });

  it("abandoned end DURING an active explicit compaction window is absorbed", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev: BridgeEvent[] = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1),
      ...n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2),
      ...n.feed(
        lifecycleFrame(PRE_SESSION_ID, {
          phase: "end",
          livenessState: "abandoned",
          replayInvalid: true,
        }),
        3,
      ),
    ];
    // The explicit signal governs: one marker, no reset, widened wait armed.
    expect(compactionEvents(ev)).toHaveLength(1);
    expect(
      ev.some((e) => e.type === "message.snapshot" && e.text === ""),
    ).toBe(false);
    expect(n.compactionPending).toBe(true);
    expect(n.finalized).toBe(false);
  });

  it("silence for the full widened budget after an explicit start -> compaction_timeout (deadlock parity)", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1);
    n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2);
    const ev = n.tick(2 + COMPACTION_RECV_TIMEOUT + 1);
    const final = ev.find((e) => e.type === "message.final") as
      | { errorKind?: string }
      | undefined;
    expect(final?.errorKind).toBe("compaction_timeout");
  });

  it("a rotation following an explicit compaction is the SAME compaction (no second signal)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev: BridgeEvent[] = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1),
      ...n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2),
      ...n.feed(
        compactionStreamFrame(PRE_SESSION_ID, {
          phase: "end",
          willRetry: true,
          completed: true,
        }),
        3,
      ),
      // The replay resumes on the ROTATED transcript id (truncateAfterCompaction).
      ...n.feed(assistantFrame(POST_SESSION_ID, "part1 part2"), 4),
    ];
    const comp = compactionEvents(ev);
    expect(comp).toHaveLength(1);
    expect(comp[0]?.phase).toBe("midturn");
  });

  it("a compaction between turns (already finalized) is ignored", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "done"), 1);
    n.endTurn(2);
    const ev = [
      ...n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 3),
      ...n.feed(
        compactionStreamFrame(PRE_SESSION_ID, {
          phase: "end",
          willRetry: false,
          completed: true,
        }),
        4,
      ),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
    expect(n.compactionPending).toBe(false);
  });

  it("a chat:aborted DURING an active explicit window is a REAL abort (terminalizes, not swallowed)", () => {
    // Upstream never aborts a run to compact mid-turn (overflow pauses,
    // threshold runs between requests, manual aborts BEFORE the compaction
    // events) — so an abort here is a user Stop/operator/timeout and must not
    // hold the turn on "compacting" until the 900s backstop.
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1);
    n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2);
    const ev = n.feed(chatAbortedFrame(3), 3);
    expect(
      ev.some((e) => e.type === "run.status" && e.status === "aborted"),
    ).toBe(true);
    expect(n.finalized).toBe(true);
  });

  it("a chat:aborted during the overflow REPLAY (end willRetry:true, content pending) also terminalizes", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1);
    n.feed(compactionStreamFrame(PRE_SESSION_ID, { phase: "start" }), 2);
    n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        willRetry: true,
        completed: true,
      }),
      3,
    );
    expect(n.compactionPending).toBe(true); // replay in flight, no content yet
    const ev = n.feed(chatAbortedFrame(4), 4);
    expect(
      ev.some((e) => e.type === "run.status" && e.status === "aborted"),
    ).toBe(true);
    expect(n.finalized).toBe(true);
  });

  it("HEURISTIC path unchanged: a chat:aborted while the abandoned-derived compaction is pending is still swallowed", () => {
    // The abandoned heuristic's abort IS the gateway abandoning the run to
    // compact (the replay follows) — live report 2026-07-04. No explicit
    // signals seen this turn ⇒ the swallow rationale still holds.
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "part1"), 1);
    n.feed(
      lifecycleFrame(PRE_SESSION_ID, {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      }),
      2,
    );
    expect(n.compactionPending).toBe(true);
    const ev = n.feed(chatAbortedFrame(3), 3);
    expect(ev.some((e) => e.type === "run.status")).toBe(false);
    expect(n.finalized).toBe(false);
  });
});

/** A chat state:aborted broadcast as the gateway emits it (chat-abort.ts). */
function chatAbortedFrame(seq: number): unknown {
  return {
    type: "event",
    event: "chat",
    payload: {
      runId: RUN,
      sessionKey: SESSION_KEY,
      seq,
      state: "aborted",
      stopReason: "rpc",
    },
  };
}

// --- TurnSink: the signal becomes ONE persisted part + the pressure trace ----

type SinkCall =
  | ["addCompactionPart", string, string]
  | ["setSessionOverfull", string, boolean]
  | [
      "recordGatewayPressure",
      string,
      string,
      {
        totalTokens: number | null;
        contextTokens: number | null;
        compaction: string | null;
      },
    ]
  | [
      "finalize",
      string,
      FinalizeStatus,
      string,
      string | null,
      string | null,
    ];

class SinkFakeWriter implements ConvexWriter {
  readonly calls: SinkCall[] = [];
  async startAssistant(): Promise<string> {
    return "msg_compact_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(): Promise<void> {}
  readonly overfullStamps: (number | undefined)[] = [];
  async setSessionOverfull(
    chatId: string,
    overfull: boolean,
    observedAt?: number,
  ): Promise<void> {
    this.calls.push(["setSessionOverfull", chatId, overfull]);
    this.overfullStamps.push(observedAt);
  }
  readonly compactionParts: CompactionPart[] = [];
  async addCompactionPart(
    messageId: string,
    part: CompactionPart,
  ): Promise<void> {
    this.calls.push(["addCompactionPart", messageId, part.phase]);
    this.compactionParts.push(part);
  }
  async recordGatewayPressure(
    chatId: string,
    messageId: string,
    data: {
      totalTokens: number | null;
      contextTokens: number | null;
      compaction: string | null;
    },
  ): Promise<void> {
    this.calls.push(["recordGatewayPressure", chatId, messageId, data]);
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    messageId: string,
    status: FinalizeStatus,
    text?: string,
    error?: string | null,
    // Recorded because a turn's CAUSE is a fact tests need to assert; without it a
    // test reading this slot silently compared undefined against undefined.
    errorKind?: string | null,
  ): Promise<void> {
    this.calls.push([
      "finalize",
      messageId,
      status,
      text ?? "",
      error ?? null,
      errorKind ?? null,
    ]);
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

async function settle(): Promise<void> {
  // recordGatewayPressure is fire-and-forget (void promise) — let it land.
  await new Promise((r) => setTimeout(r, 0));
}

// --- G-08: the compaction VERDICT outlives the turn -------------------------
// --- W2 / G-09: the gateway's OWN account of WHY it compacted ---------------
// Until now the cause was INFERRED (a session-id rotation ⇒ "preflight"), and the
// marker shown to the reader implied a pre-emptive threshold compaction even when
// the session had actually hit an OVERFLOW. `session.operation` carries the real
// reason — verified on the wire in the deployed 2026.7.1 build.
describe("W2 / G-09: session.operation names the compaction cause", () => {
  const sessionOperation = (data: Record<string, unknown>) => ({
    type: "event",
    event: "session.operation",
    payload: { sessionKey: SESSION_KEY, ...data },
  });

  it("a compaction END names its reason", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = n.feed(
      sessionOperation({
        operationId: "op-1",
        operation: "compact",
        phase: "end",
        completed: true,
        reason: "overflow",
      }),
      1,
    );
    expect(ev.find((e) => e.type === "compaction.cause")).toMatchObject({
      reason: "overflow",
      completed: true,
      refusal: false,
    });
  });

  it("a REFUSAL is flagged as such — not as a failure", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = n.feed(
      sessionOperation({
        operation: "compact",
        phase: "end",
        completed: false,
        reason: "already_in_flight",
      }),
      1,
    );
    expect(ev.find((e) => e.type === "compaction.cause")).toMatchObject({
      reason: "already_in_flight",
      refusal: true,
    });
  });

  it("SOC2: an unrecognized reason is BUCKETED, never forwarded verbatim", () => {
    // The upstream FAILURE path sends `formatErrorMessage(err)` — arbitrary text,
    // and this value reaches a metadata-only trace and a user-facing marker.
    const n = startTurn(PRE_SESSION_ID);
    const ev = n.feed(
      sessionOperation({
        operation: "compact",
        phase: "end",
        completed: false,
        reason: "Error writing /home/node/.openclaw/agents/alice/sessions/x.jsonl",
      }),
      1,
    );
    const cause = ev.find((e) => e.type === "compaction.cause");
    expect(cause).toMatchObject({ reason: "other" });
    expect(JSON.stringify(cause)).not.toContain("/home/node");
  });

  it("`start` says nothing about the cause, and a non-compact operation is ignored", () => {
    const n = startTurn(PRE_SESSION_ID);
    expect(
      n.feed(sessionOperation({ operation: "compact", phase: "start" }), 1).some(
        (e) => e.type === "compaction.cause",
      ),
    ).toBe(false);
    expect(
      n
        .feed(
          sessionOperation({ operation: "reset", phase: "end", reason: "manual" }),
          2,
        )
        .some((e) => e.type === "compaction.cause"),
    ).toBe(false);
  });

  it("another session's operation is dropped (isolation unchanged)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = n.feed(
      {
        type: "event",
        event: "session.operation",
        payload: {
          sessionKey: "agent:x:atrium:chat:u-y:someone-else",
          operation: "compact",
          phase: "end",
          reason: "overflow",
        },
      },
      1,
    );
    expect(ev).toEqual([]);
  });
});

describe("codex P2: terminal metadata rides the trace even with nothing else", () => {
  it("a spontaneous turn with ONLY terminal metadata still ships its pressure trace", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_meta", writer);
    // No pre-send pressure (a spontaneous turn has none), no usage, no error.
    await sink.beginTurn(RUN);
    await sink.apply([
      {
        type: "message.final",
        text: "partial",
        diagnosticTimeoutPhase: "provider",
        diagnosticProviderStarted: true,
        diagnosticAborted: true,
      },
      { type: "run.status", status: "final" },
    ]);
    await new Promise((r) => setTimeout(r, 0)); // the trace is fire-and-forget
    const trace = writer.calls.find((c) => c[0] === "recordGatewayPressure");
    // Computed and then never shipped would be the opposite of the fix.
    expect(trace).toBeDefined();
    expect(JSON.stringify(trace ?? null)).toContain("provider");
  });
});

describe("codex P2: the new timeout causes are OBSERVABLE", () => {
  it("a deferred-terminal timeout ships its pressure trace", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_ft", writer);
    await sink.beginTurn(RUN);
    await sink.apply([
      {
        type: "message.final",
        text: "",
        diagnosticFinalizeCause: "lifecycle_finishing_timeout",
      },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    // A named cause nobody can see is a cause nobody can act on.
    expect(JSON.stringify(writer.calls)).toContain("lifecycle_finishing_timeout");
  });

  it("an approval timeout ships its pressure trace", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_at", writer);
    await sink.beginTurn(RUN);
    await sink.apply([
      {
        type: "message.final",
        text: "",
        error: "approval",
        errorKind: "awaiting_approval",
        diagnosticFinalizeCause: "approval_timeout",
      },
      { type: "run.status", status: "error", message: "approval" },
    ]);
    await settle();
    expect(JSON.stringify(writer.calls)).toContain("approval_timeout");
  });
});

describe("W2 / G-09: the cause reaches the marker and the trace", () => {
  it("a KNOWN cause is stamped on the compaction part AND the pressure trace", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_cause", writer);
    await sink.beginTurn(RUN, { totalTokens: 250_000, contextTokens: 272_000 });
    await sink.apply([
      { type: "compaction.cause", reason: "overflow", completed: true, refusal: false },
      { type: "context.compaction", phase: "midturn" },
      { type: "message.final", text: "réponse" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    const dump = JSON.stringify(writer.calls);
    expect(dump).toContain("overflow");
    // …on BOTH surfaces: the reader's marker and the operator's trace.
    expect(writer.compactionParts.at(-1)?.reason).toBe("overflow");
  });

  it("NO cause event ⇒ the marker says NOTHING about the cause (unknown, not threshold)", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_nocause", writer);
    await sink.beginTurn(RUN, { totalTokens: 250_000, contextTokens: 272_000 });
    await sink.apply([
      // The event is broadcast `dropIfSlow`: a slow consumer simply never gets it.
      { type: "context.compaction", phase: "midturn" },
      { type: "message.final", text: "réponse" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    // Inventing "threshold" here is exactly what made the old marker mislead.
    expect(writer.compactionParts.at(-1)?.reason).toBeUndefined();
    expect(JSON.stringify(writer.calls)).not.toContain("compactionReason");
  });

  it("the cause does NOT leak into the next turn", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_leak", writer);
    await sink.beginTurn(RUN, { totalTokens: 1, contextTokens: 2 });
    await sink.apply([
      { type: "compaction.cause", reason: "overflow", completed: true, refusal: false },
      { type: "message.final", text: "a" },
      { type: "run.status", status: "final" },
    ]);
    await sink.beginTurn("run-2", { totalTokens: 1, contextTokens: 2 });
    await sink.apply([
      { type: "context.compaction", phase: "midturn" },
      { type: "message.final", text: "b" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    expect(writer.compactionParts.at(-1)?.reason).toBeUndefined();
  });
});

describe("normalizer emits the session-overfull verdict", () => {
  it("an explicit compaction that FAILED for good raises it", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        completed: false,
        willRetry: false,
      }),
      1,
    );
    expect(ev.find((e) => e.type === "session.overfull")).toMatchObject({
      overfull: true,
    });
  });

  it("codex P2: a compaction that fails BETWEEN turns is recorded too", () => {
    const n = startTurn(PRE_SESSION_ID);
    // The turn is over; the gateway compacts on its own and FAILS. A success
    // would be caught by the next turn's rotation detector — a failure has no
    // such fallback, and it is exactly the state the next turn inherits.
    n.feed(
      lifecycleFrame(PRE_SESSION_ID, {
        phase: "end",
        stopReason: "stop",
        livenessState: "working",
      }),
      1,
    );
    n.tick(1 + 11); // the follow-on grace elapses: the turn is finalized
    expect(n.finalized).toBe(true);
    const ev = n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        completed: false,
        willRetry: false,
      }),
      2,
    );
    expect(ev.find((e) => e.type === "session.overfull")).toMatchObject({
      overfull: true,
    });
  });

  it("codex P2: the verdict carries the FRAME's receipt time, not the write time", () => {
    const n = startTurn(PRE_SESSION_ID);
    // The normalizer clock is epoch SECONDS; the reset fence compares ms.
    const ev = n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        completed: false,
        willRetry: false,
      }),
      1_700_000_000,
    );
    expect(ev.find((e) => e.type === "session.overfull")).toMatchObject({
      overfull: true,
      observedAt: 1_700_000_000_000,
    });
  });

  it("an explicit compaction that COMPLETED clears it — with no second thread marker", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = n.feed(
      compactionStreamFrame(PRE_SESSION_ID, {
        phase: "end",
        completed: true,
        willRetry: false,
      }),
      1,
    );
    expect(ev.find((e) => e.type === "session.overfull")).toMatchObject({
      overfull: false,
    });
    // A success adds NO compaction part: the thread would otherwise grow a
    // marker for every healthy compaction.
    expect(ev.some((e) => e.type === "context.compaction")).toBe(false);
  });
});

describe("TurnSink records the session-overfull verdict", () => {
  it("a FAILED compaction marks the session overfull (it must PRE-ANNOUNCE the next turn)", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_of", writer);
    await sink.beginTurn(RUN, { totalTokens: 19698, contextTokens: 272000 });
    // The VERDICT rides its own event (it must be able to CLEAR the warning
    // without adding a second marker to the thread).
    await sink.apply([
      { type: "context.compaction", phase: "failed" },
      { type: "session.overfull", overfull: true },
    ]);
    expect(writer.calls).toContainEqual(["setSessionOverfull", "chat_of", true]);
  });

  it("a compaction that COMPLETED clears it (a healthy session must not stay flagged)", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_ok", writer);
    await sink.beginTurn(RUN, { totalTokens: 19698, contextTokens: 272000 });
    // `preflight` is emitted by the session-id ROTATION detector: proof a
    // compaction actually completed before the prompt.
    await sink.apply([
      { type: "context.compaction", phase: "preflight" },
      { type: "session.overfull", overfull: false },
    ]);
    expect(writer.calls).toContainEqual(["setSessionOverfull", "chat_ok", false]);
  });

  it("two verdicts in ONE turn are applied IN ORDER (a late `false` cannot mask a failure)", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_seq", writer);
    await sink.beginTurn(RUN, { totalTokens: 19698, contextTokens: 272000 });
    await sink.apply([
      { type: "session.overfull", overfull: false }, // a preflight succeeded…
      { type: "session.overfull", overfull: true }, // …then a mid-turn one failed
    ]);
    const verdicts = writer.calls.filter((c) => c[0] === "setSessionOverfull");
    expect(verdicts).toEqual([
      ["setSessionOverfull", "chat_seq", false],
      ["setSessionOverfull", "chat_seq", true],
    ]);
  });

  it("codex P2: a SILENT deferred turn still records its verdict (no message needed)", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_defer", writer);
    // A spontaneous announce turn: nothing visible, so no bubble is ever opened
    // and its buffered events are discarded at the terminal.
    await sink.beginTurn(RUN, undefined, true); // deferOpen
    await sink.apply([
      { type: "session.overfull", overfull: true },
      { type: "run.status", status: "final" },
    ]);
    // The verdict is CHAT-scoped: losing it would leave the next ordinary turn
    // un-warned about a compaction that really failed.
    expect(writer.calls).toContainEqual([
      "setSessionOverfull",
      "chat_defer",
      true,
    ]);
  });

  it("codex P2: the producer's OWN receipt time is forwarded, not the write time", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_stamp", writer);
    await sink.beginTurn(RUN, { totalTokens: 1, contextTokens: 2 });
    await sink.apply([
      { type: "session.overfull", overfull: true, observedAt: 1_234_567 },
    ]);
    // The reset fence compares against WHEN THE FRAME WAS SEEN. Re-stamping at
    // the write would let a verdict observed before a reset slip past it.
    expect(writer.overfullStamps).toEqual([1_234_567]);
  });

  it("a midturn ANNOUNCEMENT decides nothing yet (the verdict comes at the end)", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_mid", writer);
    await sink.beginTurn(RUN, { totalTokens: 19698, contextTokens: 272000 });
    await sink.apply([{ type: "context.compaction", phase: "midturn" }]);
    expect(
      writer.calls.filter((c) => c[0] === "setSessionOverfull"),
    ).toHaveLength(0);
  });
});

describe("TurnSink compaction part + pressure trace", () => {
  it("context.compaction -> ONE compaction part; finalize ships the pressure trace with the phase", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c1", writer);
    await sink.beginTurn(RUN, { totalTokens: 19698, contextTokens: 272000 });
    await sink.apply([
      { type: "context.compaction", phase: "preflight" },
      // A duplicate signal must not create a second part.
      { type: "context.compaction", phase: "preflight" },
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    const parts = writer.calls.filter((c) => c[0] === "addCompactionPart");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.[2]).toBe("preflight");
    const traces = writer.calls.filter(
      (c) => c[0] === "recordGatewayPressure",
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.[3]).toEqual({
      totalTokens: 19698,
      contextTokens: 272000,
      costUsd: null, // pressure seeded without a cost in this fixture
      toolCalls: 0, // no tools in this fixture turn
      compaction: "preflight",
      errorKind: null, // no hard overflow this turn (compaction handled it)
      stopReason: null,
      finalizeCause: null, // diagnosis field rides the trace (null on this path)
      postTotalTokens: null,
      postInputTokens: null,
      postOutputTokens: null,
      postCostUsd: null,
    });
  });

  it("a FAILED verdict upgrades the `midturn` announcement in place (one part, the truth)", async () => {
    // The explicit flow announces `midturn` when the gateway starts summarizing
    // and only learns at its `end` whether it worked. The verdict must replace
    // the announcement — a second part would leave two contradictory notices.
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c3", writer);
    await sink.beginTurn(RUN, { totalTokens: 260000, contextTokens: 272000 });
    await sink.apply([
      { type: "context.compaction", phase: "midturn" },
      { type: "context.compaction", phase: "failed" },
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    const parts = writer.calls.filter((c) => c[0] === "addCompactionPart");
    expect(parts.map((p) => p[2])).toEqual(["midturn", "failed"]);
    const traces = writer.calls.filter((c) => c[0] === "recordGatewayPressure");
    expect((traces[0]?.[3] as { compaction: string }).compaction).toBe("failed");
  });

  it("a FAILED verdict NEVER overwrites a `preflight` marker (a compaction that DID complete)", async () => {
    // `preflight` records a DIFFERENT compaction, detected by session-id
    // rotation, which actually completed before the prompt. A later explicit
    // compaction failing must not rewrite that marker into "the conversation
    // stayed at full size" — that would be a false statement to the user
    // (codex P2). The display keeps the truth it has.
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c4", writer);
    await sink.beginTurn(RUN, { totalTokens: 260000, contextTokens: 272000 });
    await sink.apply([
      { type: "context.compaction", phase: "preflight" },
      { type: "context.compaction", phase: "failed" },
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    const parts = writer.calls.filter((c) => c[0] === "addCompactionPart");
    expect(parts.map((p) => p[2])).toEqual(["preflight"]);
    const traces = writer.calls.filter((c) => c[0] === "recordGatewayPressure");
    expect((traces[0]?.[3] as { compaction: string }).compaction).toBe(
      "preflight",
    );
  });

  it("no compaction -> no part; the trace still records the fill counters", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c2", writer);
    await sink.beginTurn(RUN, { totalTokens: 1000, contextTokens: 272000 });
    await sink.apply([
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    expect(
      writer.calls.filter((c) => c[0] === "addCompactionPart"),
    ).toHaveLength(0);
    const traces = writer.calls.filter(
      (c) => c[0] === "recordGatewayPressure",
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.[3].compaction).toBeNull();
  });

  it("no pressure AND no compaction (legacy path) -> no trace at all", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c3", writer);
    await sink.beginTurn(RUN);
    await sink.apply([
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    expect(
      writer.calls.filter((c) => c[0] === "recordGatewayPressure"),
    ).toHaveLength(0);
  });
});


describe("compaction deadlock (#40295) -> actionable error, not empty complete", () => {
  it("recv silence for the FULL widened budget while compaction pending -> compaction_timeout error", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "partial"), 1);
    // Gateway abandons the run to compact (sets compactionPending, blanks buffer).
    n.feed(
      lifecycleFrame(PRE_SESSION_ID, {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      }),
      2,
    );
    // No replay ever arrives. Tick PAST the widened recv budget (deadlock).
    const ev = n.tick(2 + COMPACTION_RECV_TIMEOUT + 1);
    const final = ev.find((e) => e.type === "message.final") as
      | { errorKind?: string; error?: string }
      | undefined;
    const status = ev.find((e) => e.type === "run.status") as
      | { status?: string }
      | undefined;
    // Actionable ERROR, not the former silent empty COMPLETE bubble.
    expect(status?.status).toBe("error");
    expect(final?.errorKind).toBe("compaction_timeout");
  });
});

describe("lifecycle error carries a structured errorKind", () => {
  it("a lifecycle error whose only overflow signal is the CODE classifies to context_length", () => {
    const n = startTurn(PRE_SESSION_ID);
    n.feed(assistantFrame(PRE_SESSION_ID, "working"), 1);
    // A lifecycle error with a bare structured errorKind (no overflow phrasing
    // in the text) — extractLifecycleError would miss it; the structured read wins.
    const ev = n.feed(
      lifecycleFrame(PRE_SESSION_ID, {
        phase: "error",
        error: { message: "run stopped", errorKind: "context_length" },
      }),
      2,
    );
    const final = ev.find((e) => e.type === "message.final") as
      | { errorKind?: string }
      | undefined;
    expect(final?.errorKind).toBe("context_length");
  });
});

describe("a TRUNCATED child-key set never decides a turn is empty", () => {
  /** Feed a turn that spawns a child, sees it work, and ends SILENT. */
  async function silentParentWithChild(opts: {
    spawnResultKey: string | null;
    observedKey: string;
    truncated: boolean;
  }) {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_trunc", writer);
    await sink.beginTurn(RUN);
    await sink.apply([
      // The turn called sessions_spawn; its result may or may not name the child.
      {
        type: "tool.status",
        name: "sessions_spawn",
        phase: "completed",
        runId: RUN,
        output: opts.spawnResultKey === null ? {} : { sessionKey: opts.spawnResultKey },
      },
      // A child was observed working…
      {
        type: "agent.activity",
        childSessionKey: opts.observedKey,
        status: "running",
      },
      // …and the parent ends with nothing to say.
      {
        type: "message.final",
        text: "",
        observedChildKeys: [opts.observedKey],
        observedChildKeysTruncated: opts.truncated,
      },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    const finalize = writer.calls.find((c) => c[0] === "finalize");
    return String(finalize?.[5] ?? "");
  }

  it("an INCOMPLETE observed list makes the verdict inconclusive, not 'empty'", async () => {
    // Past the cap the active child's key is simply absent, so the strict
    // intersection fails and a parent that legitimately delegated a silent reply
    // was finalized as an error. A cap must bound memory, never decide a turn.
    const kind = await silentParentWithChild({
      spawnResultKey: "agent:main:subagent:other",
      observedKey: "agent:main:subagent:active",
      truncated: true,
    });
    expect(kind).not.toBe("empty_response");
  });

  it("a COMPLETE list with no matching child still reads as empty", async () => {
    // The exemption is for uncertainty only: with complete records and no child of
    // this turn working, "empty" remains the honest verdict.
    const kind = await silentParentWithChild({
      spawnResultKey: "agent:main:subagent:other",
      observedKey: "agent:main:subagent:active",
      truncated: false,
    });
    expect(kind).toBe("empty_response");
  });
});

// ── The compaction HISTORY is metadata-only too (found 2026-07-27) ──────────
//
// `/compaction-history` shapes the gateway's checkpoints for `/api/v1` and the obs
// MCP. Its `reason` was passed through VERBATIM while the coverage manifest claimed it
// was bucketed — the classification exercise of vendoring `sessions.ts` is what caught
// the discrepancy. A free-text gateway string on a metadata-only surface is the same
// defect already fixed twice this month (timeoutPhase, the pre-send guard's reason).

describe("compaction history: the checkpoint reason is BUCKETED", () => {
  it("a known reason survives; an unknown one collapses to `other`", () => {
    expect(bucketCompactionReason("overflow")).toBe("overflow");
    expect(bucketCompactionReason("manual")).toBe("manual");
    // The shape a leak would take: a sentence the gateway composed.
    expect(
      bucketCompactionReason("compacting after: virement de 4000 EUR à Jean"),
    ).toBe("other");
  });

  it("an absent reason stays absent (never a default that reads as measured)", () => {
    expect(bucketCompactionReason(undefined)).toBeNull();
    expect(bucketCompactionReason("")).toBeNull();
    expect(bucketCompactionReason(42)).toBeNull();
  });

  it("the /compaction-history shaper calls it (not a raw passthrough)", () => {
    // Reads the source: the shaper is a private function inside the HTTP handler and
    // is not exported. What must never come back is `reason: str(c.reason)`.
    const src = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf-8",
    );
    const shaper = src.slice(
      src.indexOf("async function fetchCompactionHistory"),
      src.indexOf("/** One normalized scheduled job"),
    );
    expect(shaper).toContain("reason: bucketCompactionReason(c.reason)");
    expect(shaper).not.toContain("reason: str(c.reason)");
  });
});
