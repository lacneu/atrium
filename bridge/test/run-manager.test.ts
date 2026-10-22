/**
 * End-to-end run-manager tests.
 *
 * Replays REAL OpenClaw frame scenarios (the canonical fixtures shared with the
 * Python suite and the normalizer tests) through RunManager + a FAKE
 * ConvexWriter, asserting the exact internal stream mutations a correct bridge
 * must call, IN ORDER. This pins the run-manager -> convex-writer seam (the part
 * the offline gate actually exercises) without any live Convex or socket.
 *
 * The fixtures are read VERBATIM from backend/tests/fixtures/openclaw_frames.json
 * (the single source of truth), so these scenarios stay in lockstep with the
 * normalizer's behavior.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ProvenancePart,
  ToolPart,
} from "../src/convex-writer.js";
import { BASE_RECV_TIMEOUT } from "../src/providers/openclaw/normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES_PATH = resolve(
  __dirname,
  "./fixtures/openclaw_frames.json",
);
const FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8")) as {
  session_key: string;
  run_id: string;
  scenarios: Record<string, { description: string; frames: unknown[] }>;
};

const SESSION_KEY = FIXTURES.session_key;
const OWN_RUN = FIXTURES.run_id;
const CHAT_ID = "chat_test_1";
const MESSAGE_ID = "msg_test_1";

/** A recorded writer call: [method, ...args]. */
type Call =
  | ["startAssistant", string, string | null]
  | ["appendDelta", string, string]
  | ["setSnapshot", string, string]
  | ["addToolPart", string, ToolPart]
  | ["addProvenancePart", string, ProvenancePart]
  | ["addMedia", string, { filename: string; path: string }]
  | ["finalize", string, FinalizeStatus, string, string | null, string | null]
  | ["addCompactionPart", string, string]
  | ["setSessionOverfull", string, string]
  | [
      "recordGatewayPressure",
      string,
      string,
      {
        totalTokens: number | null;
        contextTokens: number | null;
        compaction: string | null;
        errorKind?: string | null;
      },
    ];

/**
 * Records every writer call in order. startAssistant returns a stub message id;
 * deltas are NOT coalesced (the live HttpConvexWriter coalesces; the seam under
 * test is the run-manager's call ordering, so the fake records each call).
 */
class FakeWriter implements ConvexWriter {
  readonly calls: Call[] = [];

  async startAssistant(chatId: string, runId: string | null): Promise<string> {
    this.calls.push(["startAssistant", chatId, runId]);
    return MESSAGE_ID;
  }
  async setSessionOverfull(
    chatId: string,
    overfull: boolean,
    observedAt?: number,
  ): Promise<void> {
    this.calls.push([
      "setSessionOverfull",
      chatId,
      `${overfull}:${observedAt !== undefined ? "stamped" : "unstamped"}`,
    ]);
  }
  async appendDelta(messageId: string, text: string): Promise<void> {
    this.calls.push(["appendDelta", messageId, text]);
  }
  async setSnapshot(messageId: string, text: string): Promise<boolean> {
    this.calls.push(["setSnapshot", messageId, text]);
    return true;
  }
  async addToolPart(messageId: string, part: ToolPart): Promise<void> {
    this.calls.push(["addToolPart", messageId, part]);
  }
  async addCompactionPart(
    messageId: string,
    part: { kind: "compaction"; phase: string; at: number },
  ): Promise<void> {
    this.calls.push(["addCompactionPart", messageId, part.phase]);
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
  async addProvenancePart(
    messageId: string,
    part: ProvenancePart,
  ): Promise<void> {
    this.calls.push(["addProvenancePart", messageId, part]);
  }
  async addMedia(
    messageId: string,
    media: { filename: string; path: string; mimeType?: string },
  ): Promise<boolean> {
    this.calls.push([
      "addMedia",
      messageId,
      { filename: media.filename, path: media.path },
    ]);
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {
    /* no-op for these tests */
  }
  async finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
    error: string | null,
    errorKind: string | null = null,
  ): Promise<void> {
    this.calls.push(["finalize", messageId, status, text, error, errorKind]);
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    // Read-only seam; the RunManager tests never re-hydrate.
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {
    // Fire-and-forget seam; the RunManager tests don't assert session meta.
  }
  async upsertSubAgent(): Promise<void> {
    // Inbound-only sub-agent observation seam; not exercised by RunManager tests
    // (the observer is driven from Session, not RunManager).
  }
  async upsertSubAgentToolPart(): Promise<void> {
    // Per-tool detail seam; not exercised by RunManager tests.
  }
  async recordInteractionReply(): Promise<void> {
    // 2c interaction-reply seam; not exercised by RunManager tests.
  }
  emitRehydrateTrace(): void {
    // Content-free rehydration-decision trace; not exercised by RunManager tests.
  }
}

class Clock {
  now = 1000.0;
  tick(seconds = 0.01): number {
    this.now += seconds;
    return this.now;
  }
}

function frames(scenario: string): unknown[] {
  const s = FIXTURES.scenarios[scenario];
  if (!s) {
    throw new Error(`unknown scenario: ${scenario}`);
  }
  return s.frames;
}

/** An own-session chat delta carrying `text` (visible content: it opens the bubble). */
function chatDelta(runId: string, text: string): unknown {
  return {
    type: "event",
    event: "chat",
    payload: {
      sessionKey: SESSION_KEY,
      runId,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

/**
 * Drive a scenario end-to-end through a fresh RunManager + FakeWriter, mirroring
 * the real session loop: beginTurn (with the ack runId), feed every frame, then
 * (optionally) advance the clock past every grace and tick once so a pending
 * turn finalizes.
 */
async function drive(
  scenario: string,
  opts: { seedRun?: string | null; advanceToFinalize?: boolean } = {},
): Promise<{ writer: FakeWriter; manager: RunManager }> {
  const seedRun = opts.seedRun === undefined ? OWN_RUN : opts.seedRun;
  const advanceToFinalize = opts.advanceToFinalize ?? false;
  const writer = new FakeWriter();
  const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
  const clock = new Clock();

  await manager.beginTurn(clock.now, seedRun);
  for (const frame of frames(scenario)) {
    await manager.feed(frame, clock.tick());
  }
  if (advanceToFinalize && !manager.isFinalized) {
    clock.tick(BASE_RECV_TIMEOUT + 1);
    await manager.tick(clock.now);
  }
  return { writer, manager };
}

describe("run-manager -> convex-writer mapping", () => {
  it("chat final content: startAssistant, snapshots, finalize(complete)", async () => {
    const { writer, manager } = await drive("chat-final-content");
    expect(manager.isFinalized).toBe(true);
    expect(writer.calls).toEqual([
      ["startAssistant", CHAT_ID, OWN_RUN],
      ["setSnapshot", MESSAGE_ID, "Bon"],
      ["setSnapshot", MESSAGE_ID, "Bonjour !"],
      ["finalize", MESSAGE_ID, "complete", "Bonjour !", null, null],
    ]);
  });

  it("chat final content string finalizes complete with the text", async () => {
    const { writer, manager } = await drive("chat-final-content-string");
    expect(manager.isFinalized).toBe(true);
    // First op is always the streaming-message creation.
    expect(writer.calls[0]).toEqual(["startAssistant", CHAT_ID, OWN_RUN]);
    const final = writer.calls[writer.calls.length - 1];
    expect(final).toEqual([
      "finalize",
      MESSAGE_ID,
      "complete",
      "Réponse en texte simple.",
      null,
      null,
    ]);
  });

  it("pre-ack race: ARMED frames arriving BEFORE beginTurn are buffered + replayed (P1)", async () => {
    // A streaming response can race ahead of the chat.send `res` ack. The send
    // path ARMS the buffer just before the request; feed EVERY frame while the
    // sink is still inactive (no beginTurn yet) — pre-fix these were dropped.
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    manager.armReplayBuffer(); // server.ts does this right before conn.request
    for (const frame of frames("chat-final-content")) {
      await manager.feed(frame, clock.tick());
    }
    expect(writer.calls).toEqual([]); // sink inactive -> nothing applied yet

    // The ack lands: beginTurn seeds ownRunIds + REPLAYS the buffered frames,
    // yielding the EXACT same writer stream as the normal (ack-first) path.
    await manager.beginTurn(clock.now, OWN_RUN);
    expect(manager.isFinalized).toBe(true);
    expect(writer.calls).toEqual([
      ["startAssistant", CHAT_ID, OWN_RUN],
      ["setSnapshot", MESSAGE_ID, "Bon"],
      ["setSnapshot", MESSAGE_ID, "Bonjour !"],
      ["finalize", MESSAGE_ID, "complete", "Bonjour !", null, null],
    ]);
  });

  it("a pre-ack buffer OVERFLOW marks the turn's stream as incomplete", async () => {
    // A writer-claim rebound is retried only when the turn saw no generation frame,
    // and a frame the cap refused could be exactly the one that proved it: an absence
    // read from a truncated stream proves nothing.
    const status = {
      event: "chat",
      payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, seq: 1, state: "status", phase: "preparing_workspace" },
    };
    const fill = async (count: number) => {
      const manager = new RunManager(CHAT_ID, SESSION_KEY, new FakeWriter());
      const clock = new Clock();
      manager.armReplayBuffer();
      for (let i = 0; i < count; i++) await manager.feed(status, clock.tick());
      await manager.beginTurn(clock.now, OWN_RUN);
      return manager.streamGapNoted;
    };
    expect(await fill(1000)).toBe(false); // exactly at the cap: nothing refused
    expect(await fill(1001)).toBe(true);
  });

  it("…including an overflow while an ANNOUNCE turn still drives the sink", async () => {
    // The second stash site: a user send armed during a live spontaneous turn buffers
    // the upcoming run's frames there, under the same cap.
    const manager = new RunManager(CHAT_ID, SESSION_KEY, new FakeWriter());
    const clock = new Clock();
    await manager.beginTurn(clock.now, "announce:child-9", { expectedSessionId: null, spontaneous: true });
    manager.armReplayBuffer();
    const status = {
      event: "chat",
      payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, seq: 1, state: "status", phase: "preparing_workspace" },
    };
    for (let i = 0; i < 1001; i++) await manager.feed(status, clock.tick());
    await manager.beginTurn(clock.tick(), OWN_RUN);
    expect(manager.streamGapNoted).toBe(true);
  });

  it("…and re-arming forgets an overflow from a send that never began its turn", async () => {
    const manager = new RunManager(CHAT_ID, SESSION_KEY, new FakeWriter());
    const clock = new Clock();
    const status = {
      event: "chat",
      payload: { runId: OWN_RUN, sessionKey: SESSION_KEY, seq: 1, state: "status", phase: "preparing_workspace" },
    };
    manager.armReplayBuffer();
    for (let i = 0; i < 1001; i++) await manager.feed(status, clock.tick());
    manager.armReplayBuffer(); // the failed send's retry arms a fresh window
    await manager.beginTurn(clock.now, OWN_RUN);
    expect(manager.streamGapNoted).toBe(false);
  });

  it("codex P1: a `chat.side_result` racing the ack is BUFFERED and replayed like any content frame", async () => {
    // The event carries visible reply text (G-18). If the pre-ack buffer does not
    // recognize its frame type it goes straight through to whatever turn is live —
    // an announce turn, where it is refused as a foreign run — and the user's
    // direct reply is simply lost.
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    // An ANNOUNCE turn is already driving the sink…
    await manager.beginTurn(clock.now, "announce:child-9", { expectedSessionId: null, spontaneous: true });
    // …when the user sends: the buffer is armed while that turn is still live.
    manager.armReplayBuffer();
    await manager.feed(
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          text: "By the way, the meeting moved.",
          isError: false,
          ts: 1,
        },
      },
      clock.tick(),
    );

    // The ack lands and the real turn opens: the buffered frame is replayed
    // INTO it. Unbuffered, it reached the announce turn's normalizer, which
    // refuses it as a foreign run — the reply vanishes with no trace.
    await manager.beginTurn(clock.tick(), OWN_RUN);
    expect(JSON.stringify(writer.calls)).toContain("the meeting moved");
  });

  it("disarmReplayBuffer (failed send) drops the armed window so a stray frame is NOT buffered/replayed", async () => {
    // performSend arms the buffer THEN calls chat.send; if chat.send THROWS,
    // beginTurn never runs (its normal drain+disarm never fires). disarmReplayBuffer
    // is the failure-path cleanup. DISCRIMINATING: a late/background frame from the
    // failed send, arriving AFTER disarm but before the next arm, must be DROPPED —
    // if disarm didn't clear `replayArmed`, the window would still capture it and
    // beginTurn would replay stale content into the NEXT turn.
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    manager.armReplayBuffer();
    manager.disarmReplayBuffer(clock.now); // chat.send rejected before beginTurn
    for (const frame of frames("chat-final-content")) {
      await manager.feed(frame, clock.tick()); // disarmed -> dropped, not buffered
    }
    // The NEXT (successful) turn arms fresh + begins: zero stale content from the
    // failed send leaks in (its bubble is born from its run's first content, so
    // nothing at all is written yet).
    manager.armReplayBuffer();
    await manager.beginTurn(clock.now, OWN_RUN);
    expect(writer.calls).toEqual([]);
    expect(manager.isFinalized).toBe(false);
  });

  it("between-turn frames (UNARMED) are dropped, never replayed into the next turn (P2)", async () => {
    // Codex P2: a late/background frame of the same sessionKey arriving while the
    // sink is inactive AND not armed (between turns) must NOT be buffered, so it
    // can never write/finalize the NEXT turn's message.
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    // Stray frames arrive UNARMED (no preceding armReplayBuffer).
    for (const frame of frames("chat-final-content")) {
      await manager.feed(frame, clock.tick());
    }
    // A fresh turn begins (armed, but the strays were dropped, not buffered).
    manager.armReplayBuffer();
    await manager.beginTurn(clock.now, OWN_RUN);
    // Zero stray content leaked (the new turn's bubble waits for its own content).
    expect(writer.calls).toEqual([]);
    expect(manager.isFinalized).toBe(false);
  });

  it("frames during the startAssistant window (bubble opening, pre-messageId) survive (P1 sink)", async () => {
    // Codex P1: frames arriving while the bubble's creation round-trip is in flight
    // must not hit a null messageId and be dropped. The bubble opens on the run's
    // first content; everything behind it waits in the ordered chain and lands once
    // the message exists.
    const writer = new FakeWriter();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realStart = writer.startAssistant.bind(writer);
    writer.startAssistant = async (chatId: string, runId: string | null) => {
      await gate; // simulate a slow message creation
      return realStart(chatId, runId);
    };
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    manager.armReplayBuffer();
    await manager.beginTurn(clock.now, OWN_RUN);
    // The whole response arrives while the message is still being created.
    const fed = frames("chat-final-content").map((frame) => manager.feed(frame, clock.tick()));
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.calls).toEqual([]); // creation in flight (no messageId) -> waiting

    release(); // message creation completes -> the waiting frames drain in order
    await Promise.all(fed);
    expect(manager.isFinalized).toBe(true);
    expect(writer.calls).toEqual([
      ["startAssistant", CHAT_ID, OWN_RUN],
      ["setSnapshot", MESSAGE_ID, "Bon"],
      ["setSnapshot", MESSAGE_ID, "Bonjour !"],
      ["finalize", MESSAGE_ID, "complete", "Bonjour !", null, null],
    ]);
  });

  it("legacy agent deltas accumulate as appendDelta; the silence asks, never ends the turn", async () => {
    const { writer, manager } = await drive("agent-assistant-delta-legacy", {
      advanceToFinalize: true,
    });
    expect(writer.calls[0]).toEqual(["startAssistant", CHAT_ID, OWN_RUN]);
    const deltas = writer.calls
      .filter((c) => c[0] === "appendDelta")
      .map((c) => (c as ["appendDelta", string, string])[2]);
    expect(deltas).toEqual(["Hello ", "world"]);
    // The capture ends on a lifecycle `end` and no chat terminal: no grace closes the
    // turn on a timer — the transcript's fact (or the run's terminal) does.
    expect(manager.isFinalized).toBe(false);
    expect(writer.calls.some((c) => c[0] === "finalize")).toBe(false);
  });

  it("tool message: addToolPart precedes the finalize", async () => {
    const { writer, manager } = await drive("tool-message-visible");
    expect(manager.isFinalized).toBe(true);
    const tool = writer.calls.find((c) => c[0] === "addToolPart") as
      | ["addToolPart", string, ToolPart]
      | undefined;
    expect(tool).toBeDefined();
    expect(tool![2]).toMatchObject({ kind: "tool", name: "message", phase: "start" });
    const final = writer.calls[writer.calls.length - 1] as [
      "finalize",
      string,
      FinalizeStatus,
      string,
      string | null,
      string | null,
    ];
    expect(final[0]).toBe("finalize");
    expect(final[2]).toBe("complete");
    // The run's final text is its text — no prose rule sets the acknowledgment aside;
    // the run's durable rows replace the live text when it settles.
    expect(final[3]).toBe("Envoyé.");
  });

  it("mediaUrls: no file is taken from the live side, and no path leaks in any write", async () => {
    const { writer } = await drive("mediaurls-list", {
      advanceToFinalize: true,
    });
    // A file reaches a bubble through the transcript row that carries it.
    expect(writer.calls.some((c) => c[0] === "addMedia")).toBe(false);
    expect(JSON.stringify(writer.calls)).not.toContain("/home/node");
  });

  it("lifecycle error: finalize(error) with partial text + error string", async () => {
    const { writer, manager } = await drive("lifecycle-error");
    expect(manager.isFinalized).toBe(true);
    // The fixture's error text is a REAL overflow phrasing, so the fallback
    // classifier now tags it context_length and ships the pressure trace AFTER
    // the finalize — find the finalize by kind, not by last position.
    const final = writer.calls.find((c) => c[0] === "finalize") as [
      "finalize",
      string,
      FinalizeStatus,
      string,
      string | null,
      string | null,
    ];
    expect(final[0]).toBe("finalize");
    expect(final[2]).toBe("error"); // status mapped from the terminal run.status
    expect(final[3]).toBe("moitié"); // partial content preserved
    expect(String(final[4] ?? "")).toContain("Context overflow");
    expect(final[5]).toBe("context_length"); // fallback classification fired
  });

  it("isolation: a foreign-session turn writes nothing", async () => {
    // No own frames are admitted, so the turn's bubble (born from its run) never opens.
    const { writer } = await drive("isolation-foreign-session", {
      advanceToFinalize: false,
    });
    expect(writer.calls).toEqual([]);
  });

  it("exactly one finalize is emitted per turn", async () => {
    const { writer } = await drive("duplicate-final");
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals.length).toBe(1);
  });
});

describe("gateway errorKind propagation (context_length hard overflow)", () => {
  it("chat error{context_length} -> finalize carries the kind + the pressure trace flags it", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    await manager.beginTurn(clock.now, OWN_RUN);
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage: "Context window exceeded",
          errorKind: "context_length",
        },
      },
      clock.tick(),
    );
    const fin = writer.calls.find((c) => c[0] === "finalize");
    expect(fin?.[2]).toBe("error");
    expect(fin?.[4]).toBe("Context window exceeded");
    expect(fin?.[5]).toBe("context_length");
    // The content-free pressure trace records the HARD overflow even without
    // pre-send counters (the observability chain distinguishes it from the
    // silently-handled compaction).
    const pressure = writer.calls.find((c) => c[0] === "recordGatewayPressure");
    expect(pressure?.[3]?.errorKind).toBe("context_length");
  });
});

describe("toolCalls + costUsd in the pressure trace (causal overflow reading)", () => {
  it("counts COALESCED real tools + the message tool once, and carries the pre-turn cost", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    await manager.beginTurn(clock.now, OWN_RUN, {
      expectedSessionId: null,
      pressure: { totalTokens: 100_000, contextTokens: 272_000, costUsd: 0.42 },
    });
    const agent = (data: Record<string, unknown>) => ({
      type: "event",
      event: "agent",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        stream: "tool",
        data,
      },
    });
    // Two REAL tools: start is coalesced (held), the result emits ONE completed.
    await manager.feed(agent({ name: "web_search", phase: "start", toolCallId: "t1", args: { q: "x" } }), clock.tick());
    await manager.feed(agent({ name: "web_search", phase: "result", toolCallId: "t1", result: "ok" }), clock.tick());
    await manager.feed(agent({ name: "exec", phase: "start", toolCallId: "t2", args: { command: "ls" } }), clock.tick());
    await manager.feed(agent({ name: "exec", phase: "result", toolCallId: "t2", result: "ok" }), clock.tick());
    // The message tool emits every phase — counted ONCE (its start).
    await manager.feed(agent({ name: "message", phase: "start", args: { message: "salut" } }), clock.tick());
    await manager.feed(agent({ name: "message", phase: "result", result: "sent" }), clock.tick());
    // Terminal.
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "fin" }] },
        },
      },
      clock.tick(),
    );
    const pressure = writer.calls.find((c) => c[0] === "recordGatewayPressure");
    expect(pressure?.[3]).toMatchObject({
      totalTokens: 100_000,
      contextTokens: 272_000,
      costUsd: 0.42,
      toolCalls: 3, // 2 coalesced real tools + message once
    });
  });
});

describe("compaction verdicts across the ack (G-28)", () => {
  it("codex P1: a compaction that fails BETWEEN turns reaches the sink (no active turn)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    // No turn is running: the gateway compacts on its own and fails.
    await manager.feed(
      {
        event: "agent",
        payload: {
          runId: "bg-run",
          sessionKey: SESSION_KEY,
          stream: "compaction",
          data: { phase: "end", completed: false, willRetry: false },
        },
      },
      clock.tick(),
    );
    // The verdict is chat-scoped: it needs no message, and losing it leaves the
    // NEXT turn walking into the context wall with no warning.
    expect(JSON.stringify(writer.calls)).toContain("setSessionOverfull");
  });

  it("codex P2: a compaction END racing the ack is BOTH recorded and replayed", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    manager.armReplayBuffer();
    const compactionEnd = {
      event: "agent",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        stream: "compaction",
        data: { phase: "end", completed: false, willRetry: false },
      },
    };
    await manager.feed(compactionEnd, clock.tick());
    // The chat-scoped verdict is recorded immediately…
    expect(JSON.stringify(writer.calls)).toContain("setSessionOverfull");

    // …and the frame still reaches the TURN when its ack lands: swallowed, the
    // turn would stay in compaction state and lose its thread marker. The marker
    // lands on the bubble, which opens on the run's first content.
    await manager.beginTurn(clock.tick(), OWN_RUN);
    await manager.feed(chatDelta(OWN_RUN, "Bonjour"), clock.tick());
    expect(JSON.stringify(writer.calls)).toContain("addCompactionPart");
  });

  it("codex P2: a BACKGROUND compaction verdict is captured even during an active turn", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    await manager.beginTurn(clock.now, OWN_RUN);
    // The compaction started between turns; its `end` lands after this turn
    // opened, on the gateway's own background run.
    await manager.feed(
      {
        event: "agent",
        payload: {
          runId: "bg-run",
          sessionKey: SESSION_KEY,
          stream: "compaction",
          data: { phase: "end", completed: false, willRetry: false },
        },
      },
      clock.tick(),
    );
    // The admission policy refuses that run for the REPLY — rightly — but the
    // chat-scoped verdict must not be lost with it.
    expect(JSON.stringify(writer.calls)).toContain("setSessionOverfull");
    // …and nothing of it entered the reply.
    expect(JSON.stringify(writer.calls)).not.toContain("addCompactionPart");
  });

  it("codex P2: a compaction END in the PRE-ACK window still reaches the upcoming turn", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    // An announce turn is driving the sink…
    await manager.beginTurn(clock.now, "announce:child-9", {
      expectedSessionId: null,
      spontaneous: true,
    });
    // …the user sends, and the UPCOMING run's compaction brackets the ack.
    manager.armReplayBuffer();
    const compaction = (data: Record<string, unknown>) => ({
      event: "agent",
      payload: {
        runId: OWN_RUN,
        sessionKey: SESSION_KEY,
        stream: "compaction",
        data,
      },
    });
    await manager.feed(compaction({ phase: "start" }), clock.tick());
    await manager.feed(
      compaction({ phase: "end", completed: false, willRetry: false }),
      clock.tick(),
    );
    await manager.beginTurn(clock.tick(), OWN_RUN);
    // The marker lands on the bubble, which opens on the run's first content.
    await manager.feed(chatDelta(OWN_RUN, "Bonjour"), clock.tick());

    // Swallowed, the turn would hold only the `start`: stuck in compaction until
    // the 900 s budget, and with the marker still reading "in progress" instead
    // of the FAILED verdict the `end` carries.
    expect(
      writer.calls.filter(
        (c) => c[0] === "addCompactionPart" && c[2] === "failed",
      ),
    ).toHaveLength(1);
  });

});

describe("single ordered application path (G-29)", () => {
  it("keeps STRICT arrival order when a live frame races the pre-ack replay", async () => {
    // The two producers do not share a call stack: the consume loop drives `feed`
    // while `beginTurn` — in the /send HTTP handler — replays the frames that raced
    // the ack. Both await inside `sink.apply`, so before the chain a live frame
    // could be applied BETWEEN a replayed frame's produce and its apply: the start
    // of a reply landing after its middle.
    const writer = new FakeWriter();
    // Slow the write so the interleaving window is wide and deterministic.
    const realSnapshot = writer.setSnapshot.bind(writer);
    writer.setSnapshot = (async (messageId: string, text: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return realSnapshot(messageId, text);
    }) as never;
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();

    const chatFrame = (text: string, seq: number) => ({
      event: "chat",
      payload: {
        sessionKey: SESSION_KEY,
        runId: OWN_RUN,
        seq,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    });

    // The send arms the pre-ack buffer (performSend does this right before
    // `chat.send`), so frames racing the ack are captured instead of dropped.
    manager.armReplayBuffer();
    // THREE frames arrive before the ack: they are buffered, not applied.
    for (const [i, text] of ["one", "two", "three"].entries()) {
      await manager.feed(chatFrame(text, i + 1), clock.tick());
    }
    // The ack lands and the replay starts. The live frame is injected once the sink
    // is OPEN and the replay is mid-flight — before, it would simply be buffered too
    // and there would be no race to speak of.
    const opening = manager.beginTurn(clock.tick(), OWN_RUN);
    await new Promise((r) => setTimeout(r, 7)); // startAssistant done, replay running
    const live = manager.feed(chatFrame("four", 4), clock.tick());
    await Promise.all([opening, live]);

    const snapshots = writer.calls
      .filter((c) => c[0] === "setSnapshot")
      .map((c) => String(c[2]));
    // Each frame carries a full message, so each one REPLACES the reply: the writer
    // must see them in exactly the order they arrived, replay first and the live
    // frame last. Any interleaving shows up here as a permutation.
    expect(snapshots).toEqual(["one", "two", "three", "four"]);
  });

  it("a failed replay does not keep writing the frames behind it", async () => {
    // The sequential loop stopped at the first failure; enqueueing the batch must not
    // turn that into "the rest keep writing into a turn /send is about to fail".
    const writer = new FakeWriter();
    let snapshots = 0;
    writer.setSnapshot = (async () => {
      snapshots += 1;
      if (snapshots === 1) throw new Error("convex hiccup");
    }) as never;
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    const chatFrame = (text: string, seq: number) => ({
      event: "chat",
      payload: {
        sessionKey: SESSION_KEY,
        runId: OWN_RUN,
        seq,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    });
    manager.armReplayBuffer();
    for (const [i, text] of ["one", "two", "three"].entries()) {
      await manager.feed(chatFrame(text, i + 1), clock.tick());
    }
    await expect(manager.beginTurn(clock.tick(), OWN_RUN)).rejects.toThrow(
      /convex hiccup/,
    );
    // Only the failing one was attempted — the queued remainder stood down.
    expect(snapshots).toBe(1);
  });

  it("a stashed announce replays with its ARRIVAL clock, not the flush clock", async () => {
    // A frame stashed minutes ago and replayed now would arm the normalizer's
    // deadlines from the wrong instant and read as freshly arrived (G-35).
    const writer = new FakeWriter();
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const seen: number[] = [];
    const realFeed = manager.feed.bind(manager);
    manager.feed = (async (frame: unknown, now: number) => {
      seen.push(now);
      return realFeed(frame, now);
    }) as never;
    const clock = new Clock();
    // A real turn is streaming, so an announce frame is stashed rather than fed.
    await manager.beginTurn(clock.now, OWN_RUN);
    const arrivalAt = clock.tick();
    await manager.feed(
      {
        event: "chat",
        payload: {
          sessionKey: SESSION_KEY,
          runId: "announce:v1:child:run",
          seq: 1,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "late" }] },
        },
      },
      arrivalAt,
    );
    // The turn ends much later; the flush replays the stash.
    await manager.endTurn(clock.tick(), "final");
    const flushAt = arrivalAt + 300;
    await manager.tick(flushAt);
    // The replay used the arrival time, not the (much later) flush time.
    const replayClocks = seen.slice(1);
    expect(replayClocks.length).toBeGreaterThan(0);
    for (const t of replayClocks) expect(t).toBeLessThanOrEqual(arrivalAt);
  });

  it("a close racing an in-flight frame cannot finalize before it lands", async () => {
    // `endTurn` comes from the SESSION (a socket close, a send error) while the
    // consume loop is mid-`feed`: two producers, two call stacks. Without one chain
    // the close produces and applies while the frame's apply is still awaiting, and
    // the turn finalizes BEFORE its last content — the reply loses its tail.
    const writer = new FakeWriter();
    const realSnapshot = writer.setSnapshot.bind(writer);
    writer.setSnapshot = (async (messageId: string, text: string) => {
      await new Promise((r) => setTimeout(r, 10));
      return realSnapshot(messageId, text);
    }) as never;
    const manager = new RunManager(CHAT_ID, SESSION_KEY, writer);
    const clock = new Clock();
    await manager.beginTurn(clock.now, OWN_RUN);

    const framed = manager.feed(
      {
        event: "chat",
        payload: {
          sessionKey: SESSION_KEY,
          runId: OWN_RUN,
          seq: 1,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "tail" }] },
        },
      },
      clock.tick(),
    );
    // The close lands while that apply is still in flight.
    const closing = manager.endTurn(clock.tick(), "error", "connection_lost");
    await Promise.all([framed, closing]);

    const order = writer.calls
      .filter((c) => c[0] === "setSnapshot" || c[0] === "finalize")
      .map((c) => c[0]);
    // The content must be written BEFORE the turn is closed.
    expect(order).toEqual(["setSnapshot", "finalize"]);
  });
});
