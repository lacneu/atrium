// The pressure trace's CAUSE, through the REAL send path (codex phase 6 pass 1).
//
// The send always hands the turn a reading — even when the pre-send `sessions.describe`
// threw — so "no reading" could not tell a describe outage from a session with no usage
// yet: the trace said `describe_without_counters` for an outage. The describe's outcome now
// rides with the reading; a failed describe names `presend_describe_unavailable`, and a
// complete reading's body is untouched (the v0.97.0 baseline, test/pressure-telemetry.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./helpers/sleep.js";

import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = { chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "olivier", instanceName: "primary" };
const RUN = "run-own-1";

function recordingWriter() {
  const pressures: Record<string, unknown>[] = [];
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => true,
    finalize: async () => {},
    reportSessionMeta: async () => {},
    recordGatewayPressure: async (_c: string, _m: string, data: Record<string, unknown>) => {
      pressures.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
    },
    clearSessionState: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    emitRehydrateTrace: () => {},
  } as unknown as ConvexWriter;
  return { writer, pressures };
}

const body = {
  ...ROUTING,
  text: "bonjour",
  clientMessageId: "cm-1",
  messageId: "um-1",
  providerResetCount: null,
  outboxId: "ob-1",
  dispatchAgeMs: 0,
  switchedFromAgentId: null,
  switchedFromInstanceName: null,
  sessionSettings: null,
  referenceAttachments: [],
  config: null,
} as unknown as Parameters<typeof performSend>[1];

async function sendAndFinish(script: NonNullable<Parameters<typeof fakeGateway>[0]>): Promise<Record<string, unknown>[]> {
  const gw = fakeGateway({
    ...script,
    answers: { ...(script.answers ?? {}), "chat.send": { payload: { runId: RUN, status: "started" } } },
  });
  // The conversation's socket first; every later connection (the instance's
  // session-events socket, which the reconciler attaches on the first send) is a
  // socket of its own — sharing this fake would hand it the turn's frames.
  vi.spyOn(OpenClawConnection, "connect")
    .mockImplementationOnce(async () => gw as never)
    .mockImplementation(async () => fakeGateway() as never);
  const { writer, pressures } = recordingWriter();
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  await performSend(session, body, writer, null, null);
  (session.connection as unknown as FakeGateway).emit({
    type: "event",
    event: "chat",
    payload: {
      runId: RUN,
      sessionKey: session.sessionKey,
      state: "final",
      stopReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "Here is the report you asked for." }] },
    },
  });
  for (let i = 0; i < 60 && pressures.length === 0; i++) await sleep(5);
  return pressures;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pressure trace cause through performSend", () => {
  it("the describe THREW, the send went out: the cause is the outage, not the session", async () => {
    const pressures = await sendAndFinish({ describeFailures: 99 });
    expect(pressures).toHaveLength(1);
    expect(pressures[0]).toMatchObject({
      pressureSource: "presend_describe",
      turnOrigin: "dispatch",
      telemetryStatus: "missing",
      telemetryCause: "presend_describe_unavailable",
    });
    expect("describe" in pressures[0]!, "the outcome names the cause; it is never sent as such").toBe(false);
  });

  it("the describe ANSWERED with a session that has no usage yet: describe_without_counters", async () => {
    const pressures = await sendAndFinish({ describe: [{ sessionId: "s-1", systemSent: true, contextTokens: 272_000 }] });
    expect(pressures[0]).toMatchObject({ telemetryStatus: "partial", telemetryCause: "describe_without_counters" });
  });

  it("a complete reading posts no telemetry field and no outcome (the 0.97.0 body)", async () => {
    const pressures = await sendAndFinish({
      describe: [
        {
          sessionId: "s-1",
          systemSent: true,
          totalTokens: 40_000,
          totalTokensFresh: true,
          contextTokens: 272_000,
          promptBudgetBeforeReserve: 200_000,
          estimatedPromptTokens: 40_000,
        },
      ],
    });
    expect(pressures).toHaveLength(1);
    for (const k of ["telemetryStatus", "telemetryCause", "telemetryMissing", "describe", "agentId", "gatewayVersion"]) {
      expect(k in pressures[0]!, k).toBe(false);
    }
    expect(pressures[0]).toMatchObject({ totalTokens: 40_000, contextTokens: 272_000, pressureSource: "presend_describe" });
  });
});
