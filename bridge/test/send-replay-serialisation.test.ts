// A SECOND SEND NEVER BEGINS ITS TURN INSIDE THE FIRST ONE'S PRE-ACK REPLAY.
//
// `RunManager.beginTurn` called from outside does not itself wait for a replay in
// progress. It does not have to: the only outside caller on a session's manager is the
// send path, and `performSend` runs ONE send at a time per session (`SEND_LOCKS`,
// server.ts) — from the arming of the pre-ACK buffer to the end of `beginTurn`, replay
// included. A `/resume` is refused while a send is being prepared and a send waits for a
// resume (`ChatTransitionGate`, pinned in resume-transition.test.ts), and `resumeTurn`
// waits behind a replay; a spontaneous turn is stashed during one
// (settled-completion.test.ts). This file pins the first of the three.

import { afterEach, describe, expect, it, vi } from "vitest";
import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "turn:x",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};

const body = (n: number) =>
  ({
    ...ROUTING,
    text: `message ${n}`,
    clientMessageId: `cm-${n}`,
    messageId: `um-${n}`,
    providerResetCount: null,
    outboxId: `ob-${n}`,
    dispatchAgeMs: 0,
    switchedFromAgentId: null,
    switchedFromInstanceName: null,
    sessionSettings: null,
    referenceAttachments: [],
    config: null,
  }) as unknown as Parameters<typeof performSend>[1];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one send at a time per session", () => {
  it("a second send does nothing — no read, no chat.send, no turn — until the first one's replay is over", async () => {
    const gw = fakeGateway({
      describe: [{ sessionId: "s-1", systemSent: true }],
      // The gateway's own view stays "idle": the second send learns of the first one's
      // turn from this bridge (a run in the foreground here).
      answers: {
        "chat.history": { payload: { sessionInfo: { hasActiveRun: false, effectiveQueueMode: "steer" } } },
      },
      sequences: {
        // The first ACK is slow: the run's first frame races it.
        "chat.send": [
          { payload: { status: "started", runId: "ack-1" }, delayMs: 30 },
          { payload: { status: "started", runId: "ack-2" } },
        ],
      },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    // The bubble's creation is held: the replay of the raced frame stands inside it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const started: Array<string | null> = [];
    const writer = {
      startAssistant: async (_c: string, runId: string | null) => {
        started.push(runId);
        await held;
        return `msg-${started.length}`;
      },
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async () => {},
      recordGatewayPressure: async () => {},
      clearSessionState: async () => {},
      applyTranscript: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      emitRehydrateTrace: () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    (session.connection as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.8";
    const conn = session.connection as unknown as FakeGateway;
    const rm = session.runManager;

    const first = performSend(session, body(1), writer, null, null);
    // Wait for the first send to be on the wire, then let its run's text race the ACK.
    for (let i = 0; i < 200 && conn.countOf("chat.send") === 0; i++) await sleep(1);
    expect(conn.countOf("chat.send")).toBe(1);
    await rm.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: session.sessionKey,
          runId: "ack-1",
          seq: 1,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
      },
      1001,
    );
    // The ACK arrives; `beginTurn` replays the raced frame and stops on the held write.
    for (let i = 0; i < 200 && started.length === 0; i++) await sleep(1);
    expect(started).toEqual(["ack-1"]);
    expect(rm.dispatchInFlight).toBe(true);

    const historyBefore = conn.countOf("chat.history");
    const second = performSend(session, body(2), writer, null, null);
    await sleep(40);
    // Nothing of the second send has happened: it would otherwise read the session,
    // arm the buffer the replay is draining, and begin a turn between two replayed frames.
    expect(conn.countOf("chat.history")).toBe(historyBefore);
    expect(conn.countOf("chat.send")).toBe(1);
    expect(rm.dispatchInFlight).toBe(true);

    release();
    await Promise.all([first, second]);
    // The first turn is the foreground one; the second send found it and is a held input.
    expect(conn.countOf("chat.send")).toBe(2);
    expect(rm.activeRunIds).toEqual(["ack-1"]);
    expect(rm.outstandingInputs).toHaveLength(1);
    expect(started).toEqual(["ack-1"]);
  });
});
