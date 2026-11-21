// THE CAUSE OF A GUARD COMPACTION BELONGS TO THE TURN IT WAS SET FOR.
//
// The pre-send guard compacts a session before a send and names the cause of the rotation
// that follows (`pre_compaction` — "Atrium compacted this conversation before sending").
// That name was a free-floating field of the normalizer, set before the turn began and
// cleared only by the rotation that consumed it. A compaction that rotates nothing (the
// gateway kept the session id) left it standing, and the NEXT rotation — a compaction the
// gateway decided on its own, turns later — was shown to the reader with Atrium's cause.
//
// Real send path, real run manager and sink; the gateway is scripted.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = { chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "olivier", instanceName: "primary" };

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

/** A session at `pct`% of its usable budget, as the gateway reports it. */
const at = (pct: number, sessionId = "s-1") => ({
  sessionId,
  systemSent: true,
  contextTokens: 200_000,
  promptBudgetBeforeReserve: 100_000,
  estimatedPromptTokens: Math.round(1_000 * pct),
  totalTokensFresh: true,
});

type Marker = { messageId: string; part: { phase?: string; reason?: string } };

async function harness(script: Parameters<typeof fakeGateway>[0]) {
  const gw = fakeGateway({
    ...script,
    answers: { "chat.history": { payload: { sessionInfo: { hasActiveRun: false } } }, ...script?.answers },
  });
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
  const markers: Marker[] = [];
  let opened = 0;
  const writer = {
    startAssistant: async () => `msg-${++opened}`,
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    recordGatewayPressure: async () => {},
    clearSessionState: async () => {},
    setSessionOverfull: async () => {},
    addCompactionPart: async (messageId: string, part: Marker["part"]) => {
      markers.push({ messageId, part });
    },
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    emitRehydrateTrace: () => {},
  } as unknown as ConvexWriter;
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  return { gw: session.connection as unknown as FakeGateway, session, markers, writer };
}

type Session = Awaited<ReturnType<typeof harness>>["session"];

/** One whole answer of `runId`, every frame stamped with the session id the gateway is on. */
async function answer(session: Session, runId: string, sessionId: string, text: string, now: number) {
  const base = { sessionKey: session.sessionKey, runId, sessionId };
  const message = { role: "assistant", content: [{ type: "text", text }] };
  await session.runManager.feed({ type: "event", event: "agent", payload: { ...base, stream: "lifecycle", data: { phase: "start" } } }, now);
  await session.runManager.feed({ type: "event", event: "chat", payload: { ...base, seq: 1, state: "delta", message } }, now + 1);
  await session.runManager.feed({ type: "event", event: "agent", payload: { ...base, stream: "lifecycle", data: { phase: "end" } } }, now + 2);
  await session.runManager.feed({ type: "event", event: "chat", payload: { ...base, seq: 2, state: "final", message } }, now + 3);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the cause of a guard compaction is the cause of ITS turn's rotation only", () => {
  it("control: the rotation that follows the guard's compaction says `pre_compaction`", async () => {
    const { session, markers, writer } = await harness({
      describe: [at(97), at(30)],
      compact: { payload: { ok: true, compacted: true } },
      sequences: { "chat.send": [{ payload: { status: "started", runId: "run-1" } }] },
    });
    await performSend(session, body(1), writer, null, null);
    await answer(session, "run-1", "s-2", "First answer.", 2000);
    expect(markers.map((x) => x.part.reason)).toEqual(["pre_compaction"]);
  });

  it("a guard compaction that rotated NOTHING does not name the gateway's own compaction of a later turn", async () => {
    const { gw, session, markers, writer } = await harness({
      // Turn 1: 97 % → the guard compacts → 30 %. Turn 2 reads 30 %: no guard compaction.
      describe: [at(97), at(30)],
      compact: { payload: { ok: true, compacted: true } },
      sequences: {
        "chat.send": [
          { payload: { status: "started", runId: "run-1" } },
          { payload: { status: "started", runId: "run-2" } },
        ],
      },
    });
    await performSend(session, body(1), writer, null, null);
    expect(gw.countOf("sessions.compact")).toBe(1);
    // The gateway compacted in place: turn 1 answers on the SAME session id.
    await answer(session, "run-1", "s-1", "First answer.", 2000);
    expect(markers).toEqual([]);

    await performSend(session, body(2), writer, null, null);
    expect(gw.countOf("sessions.compact")).toBe(1);
    // Turn 2: the gateway compacted on its own and rotated the session.
    await answer(session, "run-2", "s-2", "Second answer.", 3000);
    // The compaction is shown — and its cause is unknown, not Atrium's.
    expect(markers).toHaveLength(1);
    expect(markers[0]!.part.reason).toBeUndefined();
  });

  it("a spontaneous turn that begins and ends between the guard's compaction and the send does not take the cause away", async () => {
    const { session, markers, writer } = await harness({
      describe: [at(97), at(30)],
      compact: { payload: { ok: true, compacted: true } },
      sequences: { "chat.send": [{ payload: { status: "started", runId: "run-1", delayMs: 0 } }] },
    });
    // The cause is carried by the send: a turn the gateway starts on its own, closed
    // before the send's turn begins, neither consumes it nor erases it.
    const rm = session.runManager;
    const begin = rm.beginTurn.bind(rm);
    let interleaved = false;
    rm.beginTurn = async (now, ackRunId, ctx) => {
      if (!interleaved && ctx?.spontaneous !== true) {
        interleaved = true;
        await begin(now, "announce-run", { expectedSessionId: null, spontaneous: true });
        await rm.endTurn(now);
      }
      return begin(now, ackRunId, ctx);
    };
    await performSend(session, body(1), writer, null, null);
    await answer(session, "run-1", "s-2", "First answer.", 2000);
    expect(markers.map((x) => x.part.reason)).toEqual(["pre_compaction"]);
  });
});
