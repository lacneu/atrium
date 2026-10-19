// A `chat.send` that got no answer in time (0.101.2, prod feedback prod-ms7c46hw…,
// 2026-10-19): the gateway is asked whether it received the send (the Control UI's receipt
// question, `chat.history` `inputRunIds`); absent ⇒ ONE resend with the same idempotency
// key and the same attachments; received ⇒ no resend; the question failing ⇒ the timeout
// stands. Never two executions.

import { afterEach, describe, expect, test, vi } from "vitest";
import { askGatewayForInput, performSend, sendRecoveringTimeout } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { issueChatSend } from "../src/providers/openclaw/chat-send.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
  OpenClawError,
} from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway, type FakeRpcAnswer } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const timeout = () => new OpenClawError("chat.send timed out");
const NO_WAIT = { delaysMs: [0, 0, 0], sleep: async () => {} };
const log = () => {};

/** A gateway: `chat.send` answers per `sendAnswers` (an Error = no answer in time), and
 *  `chat.history` answers what it holds for the asked ids per `receipts`. */
function gateway(opts: {
  sendAnswers: Array<"ack" | "timeout">;
  history: Array<"absent" | "received" | "fail" | "unknown">;
}) {
  const sends: Array<Record<string, unknown>> = [];
  const asks: string[] = [];
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<{ payload: Record<string, unknown> }> => {
    if (method === "chat.send") {
      sends.push(params);
      const a = opts.sendAnswers.shift() ?? "ack";
      if (a === "timeout") throw timeout();
      return { payload: { status: "started", runId: params.idempotencyKey } };
    }
    if (method === "chat.history") {
      const id = (params.inputRunIds as string[])[0]!;
      asks.push(id);
      const h = opts.history.shift() ?? "absent";
      if (h === "fail") throw new OpenClawError("chat.history timed out");
      if (h === "unknown") return { payload: { messages: [] } };
      return {
        payload: {
          messages: [],
          inputReceipts: h === "received" ? [{ runId: id, state: "pending" }] : [],
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  });
  const conn = { request, gatewayVersion: "2026.9.33", maxPayload: undefined };
  return { conn, sends, asks };
}

const PARAMS = () => ({
  sessionKey: "agent:fabien:atrium:chat:u:c1",
  message: "fait moi un topo précis",
  idempotencyKey: "send-1",
  attachments: [{ type: "file", mimeType: "application/pdf", fileName: "support.pdf", content: "JVBERi0=" }],
});

function recover(g: ReturnType<typeof gateway>, params: Record<string, unknown>) {
  return sendRecoveringTimeout({
    send: () => issueChatSend(g.conn as never, params, 20_000, { check: () => {} }),
    ask: () => askGatewayForInput(g.conn as never, String(params.sessionKey), String(params.idempotencyKey)),
    closed: () => false,
    log,
    ...NO_WAIT,
  });
}

describe("a send the gateway did not acknowledge in time", () => {
  test("not received: ONE resend, the same idempotency key and the same attachment", async () => {
    const g = gateway({ sendAnswers: ["timeout", "ack"], history: ["absent"] });
    const params = PARAMS();
    const out = await recover(g, params);
    expect(out).toMatchObject({ kind: "acked", resent: true });
    expect(g.sends).toHaveLength(2);
    expect(g.sends[1]).toEqual(g.sends[0]);
    expect(g.sends[1]!.idempotencyKey).toBe("send-1");
    expect(g.sends[1]!.attachments).toEqual(PARAMS().attachments);
    expect(g.asks).toEqual(["send-1"]);
  });

  test("received: no resend — its run is followed", async () => {
    const g = gateway({ sendAnswers: ["timeout"], history: ["received"] });
    expect(await recover(g, PARAMS())).toEqual({ kind: "received" });
    expect(g.sends).toHaveLength(1);
  });

  test("twice no answer: one resend only, then the timeout stands (unless the resend is received)", async () => {
    const g = gateway({ sendAnswers: ["timeout", "timeout", "ack"], history: ["absent", "absent"] });
    await expect(recover(g, PARAMS())).rejects.toThrow(/timed out/);
    expect(g.sends).toHaveLength(2);
    const r = gateway({ sendAnswers: ["timeout", "timeout"], history: ["absent", "received"] });
    expect(await recover(r, PARAMS())).toEqual({ kind: "received" });
    expect(r.sends).toHaveLength(2);
  });

  test("the question itself fails, or the gateway cannot say: no resend, the timeout stands", async () => {
    const failing = gateway({ sendAnswers: ["timeout"], history: ["fail", "fail", "fail"] });
    await expect(recover(failing, PARAMS())).rejects.toThrow(/chat.send timed out/);
    expect(failing.sends).toHaveLength(1);
    const blind = gateway({ sendAnswers: ["timeout"], history: ["unknown", "unknown", "unknown"] });
    await expect(recover(blind, PARAMS())).rejects.toThrow(/chat.send timed out/);
    expect(blind.sends).toHaveLength(1);
  });

  test("a cancelled input is never resent", async () => {
    const g = gateway({ sendAnswers: ["timeout"], history: [] });
    g.conn.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "chat.send") throw timeout();
      return { payload: { inputReceipts: [{ runId: params.inputRunIds && (params.inputRunIds as string[])[0], state: "pending", cancelled: true }] } };
    });
    await expect(recover(g, PARAMS())).rejects.toThrow(/timed out/);
    expect(g.conn.request.mock.calls.filter(([m]) => m === "chat.send")).toHaveLength(1);
  });

  test("the control request before the send timed out: nothing was written, resent once without asking", async () => {
    const g = gateway({ sendAnswers: ["ack"], history: [] });
    let refreshes = 0;
    const gate = {
      check: () => {},
      refresh: async () => {
        refreshes++;
        if (refreshes === 1) throw new OpenClawError("sessions.describe timed out");
      },
    };
    const params = PARAMS();
    const out = await sendRecoveringTimeout({
      send: () => issueChatSend(g.conn as never, params, 20_000, gate),
      ask: () => askGatewayForInput(g.conn as never, params.sessionKey, params.idempotencyKey),
      closed: () => false,
      log,
      ...NO_WAIT,
    });
    expect(out).toMatchObject({ kind: "acked", resent: true });
    expect(g.sends).toHaveLength(1);
    expect(g.asks).toEqual([]);
  });

  test("a REFUSAL that mentions a timeout is an answer: thrown as it came, nothing asked", async () => {
    const g = gateway({ sendAnswers: [], history: [] });
    g.conn.request.mockImplementation(async () => {
      throw new GatewayAnsweredError("provider request timed out", undefined, "UNAVAILABLE");
    });
    await expect(recover(g, PARAMS())).rejects.toBeInstanceOf(GatewayAnsweredError);
    expect(g.conn.request).toHaveBeenCalledTimes(1);
  });

  test("any other failure is not this function's", async () => {
    const g = gateway({ sendAnswers: [], history: [] });
    g.conn.request.mockImplementation(async () => {
      throw new OpenClawError("socket closed");
    });
    await expect(recover(g, PARAMS())).rejects.toThrow(/socket closed/);
    expect(g.conn.request).toHaveBeenCalledTimes(1);
  });
});

// THROUGH THE REAL SEND PATH (`performSend` against a scripted gateway): the turn ends
// acknowledged after one resend, or followed as received with none — and the turn opens
// either way, so the run the gateway holds is answered in its bubble.

afterEach(() => vi.restoreAllMocks());

const CFG = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;
const ROUTING = { chatId: "c1", openclawChatId: "turn:x", agentId: "alice", canonical: "olivier", instanceName: "primary" };

async function sendThrough(sequences: Record<string, FakeRpcAnswer[]>, receipt: "absent" | "received" | "fail") {
  const gw = fakeGateway({ describe: [{ sessionId: "s-1", systemSent: true }], sequences });
  // The receipt question names the send by its key: answered for whatever key is asked.
  const request = gw.request.bind(gw);
  (gw as { request: FakeGateway["request"] }).request = async (method, params, timeoutMs) => {
    if (method === "chat.history" && Array.isArray(params.inputRunIds)) {
      (gw.calls as [string, Record<string, unknown>][]).push([method, params]);
      if (receipt === "fail") throw new OpenClawError("chat.history timed out");
      const id = (params.inputRunIds as string[])[0];
      return { payload: { messages: [], inputReceipts: receipt === "received" ? [{ runId: id, state: "pending" }] : [] } };
    }
    return request(method, params, timeoutMs);
  };
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    recordGatewayPressure: async () => {},
    clearSessionState: async () => {},
    getRehydrationContext: async () => ({ history: "", turnCount: 0 }),
    emitRehydrateTrace: () => {},
  } as unknown as ConvexWriter;
  const reg = new SessionRegistry(servedMap(CFG, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  (session.connection as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.33";
  const body = {
    ...ROUTING,
    text: "fait moi un topo précis",
    clientMessageId: "cm-1",
    messageId: "um-1",
    providerResetCount: null,
    outboxId: "ob-1",
    dispatchAgeMs: 0,
    switchedFromAgentId: null,
    switchedFromInstanceName: null,
    sessionSettings: null,
    referenceAttachments: [],
    config: {},
  } as unknown as Parameters<typeof performSend>[1];
  const outcome = await performSend(session, body, writer, null, "/media/outbound").then(
    () => "ok" as const,
    (e: unknown) => e,
  );
  return { gw: session.connection as unknown as FakeGateway, outcome };
}

describe("the real send path after a chat.send timeout", () => {
  test("not received: resent once with the same key, and the send succeeds", async () => {
    const { gw, outcome } = await sendThrough({
      "chat.send": [{ throws: timeout() }, { payload: { status: "started", runId: "run-x" } }],
    }, "absent");
    expect(outcome).toBe("ok");
    const sends = gw.calls.filter(([m]) => m === "chat.send").map(([, p]) => p);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.idempotencyKey).toBe(sends[0]!.idempotencyKey);
    expect(sends[1]!.message).toBe(sends[0]!.message);
    const asked = gw.calls.filter(([m, p]) => m === "chat.history" && Array.isArray(p.inputRunIds));
    expect(asked.map(([, p]) => p.inputRunIds)).toEqual([[sends[0]!.idempotencyKey]]);
  }, 20_000);

  test("received: not resent, and the send succeeds on the run the gateway holds", async () => {
    const { gw, outcome } = await sendThrough({ "chat.send": [{ throws: timeout() }] }, "received");
    expect(outcome).toBe("ok");
    expect(gw.countOf("chat.send")).toBe(1);
  }, 20_000);

  test("the question fails: not resent, the timeout reaches the dispatch", async () => {
    const { gw, outcome } = await sendThrough({ "chat.send": [{ throws: timeout() }] }, "fail");
    expect(outcome).toBeInstanceOf(OpenClawError);
    expect(gw.countOf("chat.send")).toBe(1);
  }, 30_000);
});
