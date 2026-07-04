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
  async appendDelta(messageId: string, text: string): Promise<void> {
    this.calls.push(["appendDelta", messageId, text]);
  }
  async setSnapshot(messageId: string, text: string): Promise<void> {
    this.calls.push(["setSnapshot", messageId, text]);
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
    // The NEXT (successful) turn arms fresh + begins: only its own (empty) message,
    // zero stale content from the failed send leaks in.
    manager.armReplayBuffer();
    await manager.beginTurn(clock.now, OWN_RUN);
    expect(writer.calls).toEqual([["startAssistant", CHAT_ID, OWN_RUN]]);
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
    // Only the new (empty) assistant message exists — zero stray content leaked.
    expect(writer.calls).toEqual([["startAssistant", CHAT_ID, OWN_RUN]]);
    expect(manager.isFinalized).toBe(false);
  });

  it("frames during the startAssistant window (post-ack, pre-messageId) survive (P1 sink)", async () => {
    // Codex P1: if the sink went active BEFORE startAssistant resolved, frames
    // arriving during that network round-trip would hit an active sink with a
    // null messageId and be dropped. With the fix the sink stays inactive across
    // the await, so RunManager.feed (still armed) BUFFERS them and the replay
    // loop drains them once the message exists.
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
    const begin = manager.beginTurn(clock.now, OWN_RUN); // suspends on the gate
    // The whole response arrives AFTER the ack but BEFORE the message exists.
    for (const frame of frames("chat-final-content")) {
      await manager.feed(frame, clock.tick());
    }
    expect(writer.calls).toEqual([]); // sink inactive (no messageId) -> buffered

    release(); // message creation completes -> sink active -> replay drains buffer
    await begin;
    expect(manager.isFinalized).toBe(true);
    expect(writer.calls).toEqual([
      ["startAssistant", CHAT_ID, OWN_RUN],
      ["setSnapshot", MESSAGE_ID, "Bon"],
      ["setSnapshot", MESSAGE_ID, "Bonjour !"],
      ["finalize", MESSAGE_ID, "complete", "Bonjour !", null, null],
    ]);
  });

  it("legacy agent deltas accumulate as appendDelta then finalize", async () => {
    const { writer, manager } = await drive("agent-assistant-delta-legacy", {
      advanceToFinalize: true,
    });
    expect(manager.isFinalized).toBe(true);
    expect(writer.calls[0]).toEqual(["startAssistant", CHAT_ID, OWN_RUN]);
    const deltas = writer.calls
      .filter((c) => c[0] === "appendDelta")
      .map((c) => (c as ["appendDelta", string, string])[2]);
    expect(deltas).toEqual(["Hello ", "world"]);
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
    expect(final[3]).toBe("Hello world");
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
    expect(final[3]).toBe("Réponse visible complète.");
  });

  it("mediaUrls: addMedia for each filtered item, no path leak in finalize", async () => {
    const { writer, manager } = await drive("mediaurls-list", {
      advanceToFinalize: true,
    });
    expect(manager.isFinalized).toBe(true);
    const media = writer.calls.filter((c) => c[0] === "addMedia") as Array<
      ["addMedia", string, { filename: string; path: string }]
    >;
    // Same filtering as the normalizer: dup collapsed; empty/int/https/../inbound
    // rejected. Only a.pdf + c.pdf survive.
    expect(media.map((c) => c[2].filename)).toEqual(["a.pdf", "c.pdf"]);
    expect(media.map((c) => c[2].path)).toEqual([
      "/home/node/.openclaw/media/outbound/a.pdf",
      "/home/node/.openclaw/media/outbound/c.pdf",
    ]);
    const final = writer.calls[writer.calls.length - 1] as [
      "finalize",
      string,
      FinalizeStatus,
      string,
      string | null,
      string | null,
    ];
    expect(final[0]).toBe("finalize");
  });

  it("lifecycle error: finalize(error) with partial text + error string", async () => {
    const { writer, manager } = await drive("lifecycle-error");
    expect(manager.isFinalized).toBe(true);
    const final = writer.calls[writer.calls.length - 1] as [
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
  });

  it("isolation: a foreign-session turn writes nothing but the streaming message", async () => {
    // No own frames are admitted, so only startAssistant fired; nothing else.
    const { writer } = await drive("isolation-foreign-session", {
      advanceToFinalize: false,
    });
    expect(writer.calls).toEqual([["startAssistant", CHAT_ID, OWN_RUN]]);
  });

  it("exactly one finalize is emitted per turn", async () => {
    const { writer } = await drive("duplicate-final");
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals.length).toBe(1);
  });
});

describe("history recovery arming (6.5 message-tool item frame)", () => {
  it("a message-tool ITEM frame holding a private-ack arms wantsHistoryRecovery", async () => {
    // 6.5: the gateway-run message-tool surfaces as an item frame with NO visible
    // text; the turn then holds a bare private-ack. The delivered reply lives in
    // the transcript, so the session loop must run sessions.get recovery (reviews
    // #11/#14 P1) — takeRecoveryRequest is true while the turn is NOT yet finalized.
    const { manager } = await drive("message-tool-item-then-private-ack", {
      advanceToFinalize: false,
    });
    expect(manager.isFinalized).toBe(false); // private-ack grace holds it open
    expect(manager.takeRecoveryRequest()).toBe(true);
  });

  it("a private-ack WITHOUT a message-tool item does NOT arm recovery (discriminant)", async () => {
    const { manager } = await drive("private-ack-only", { advanceToFinalize: false });
    expect(manager.takeRecoveryRequest()).toBe(false);
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
