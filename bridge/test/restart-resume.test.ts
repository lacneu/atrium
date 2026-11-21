/**
 * A connection that ends DURING a turn, over a real socket — an announced restart, an
 * announced stop, a plain close: what the bridge asks Convex, and how a request that
 * needs a new socket is named while the announced restart is still awaited.
 *
 * Live, 2026-11-21 (gateway 2026.9.36): `shutdown {reason: "gateway restarting",
 * restartExpectedMs: 1500}`, the socket closed 1012, the turn left to the transcript; the
 * delay the gateway gave was read nowhere, and a send two seconds later failed as a plain
 * disconnect. (The questions Convex then asks, and when: convex/followUpProjection.test.ts.
 * The silent socket: inbound-silence-live.test.ts.)
 */

import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { classifyGatewayError, LOST_RESPONSE_CODES } from "../src/core/dispatch-errors.js";
import {
  GatewayConnectRefusedError,
  normalizeWsUrl,
  OpenClawConnection,
} from "../src/providers/openclaw/openclaw-client.js";
import { RestartWindows, restartWindows } from "../src/providers/openclaw/restart-window.js";
import { SessionRegistry } from "../src/session.js";
import { servedMap } from "./helpers/served.js";
import {
  CAPTURED_HELLO_POLICY,
  deviceIdentity,
  startWsFakeGateway,
  type WsFakeGateway,
} from "./helpers/ws-fake-gateway.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(5);
};

/** The notice VERBATIM from the capture (c-restart, 03:21Z). */
const RESTART_NOTICE = {
  type: "event",
  event: "shutdown",
  payload: { reason: "gateway restarting", restartExpectedMs: 1500 },
};
const STOP_NOTICE = { type: "event", event: "shutdown", payload: { reason: "gateway stopping" } };

let gateway: WsFakeGateway | null = null;

beforeEach(() => {
  restartWindows.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await gateway?.stop();
  gateway = null;
  restartWindows.clear();
  vi.restoreAllMocks();
});

async function turnInFlight() {
  gateway = startWsFakeGateway({ version: "2026.9.36", policy: { ...CAPTURED_HELLO_POLICY } });
  await gateway.ready;
  const finalized: unknown[][] = [];
  const asked: unknown[][] = [];
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    addProvenancePart: async () => {},
    finalize: async (...args: unknown[]) => {
      finalized.push(args);
    },
    reportSessionMeta: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    resumeStreams: async (...args: unknown[]) => {
      asked.push(args);
    },
  } as unknown as ConvexWriter;
  const config = {
    openclawGatewayUrl: gateway.url,
    openclawToken: "t",
    deviceIdentity: deviceIdentity(),
  } as unknown as BridgeConfig;
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire({ chatId: "c1", openclawChatId: "oc1", agentId: "a", canonical: "alice" });
  await sleep(20);
  await session.runManager.beginTurn(1000, "run-1");
  session.wake();
  await sleep(5);
  return { reg, session, finalized, asked, url: gateway.url };
}

describe("a connection that ends during a turn asks Convex, with what the gateway announced", () => {
  it("announced restart: the delay it gave travels with the question, and the bridge settles nothing", async () => {
    const { reg, session, finalized, asked } = await turnInFlight();
    try {
      gateway!.push(RESTART_NOTICE);
      await sleep(20);
      gateway!.socket!.close(1012, "service restart");
      await until(() => session.connection.isClosed);
      await sleep(20);
      expect((session.connection as OpenClawConnection).connectionEnd).toMatchObject({
        kind: "gateway_restarting",
        restartExpectedMs: 1500,
      });
      expect(asked).toEqual([["c1", 1500]]);
      expect(finalized).toEqual([]);
      expect(session.runManager.streamGapNoted).toBe(true);
    } finally {
      reg.closeAll();
    }
  });

  it("announced stop (no `restartExpectedMs`): asked, with no delay to wait for", async () => {
    const { reg, session, finalized, asked } = await turnInFlight();
    try {
      gateway!.push(STOP_NOTICE);
      await sleep(20);
      gateway!.socket!.close(1001, "going away");
      await until(() => session.connection.isClosed);
      await sleep(20);
      expect((session.connection as OpenClawConnection).connectionEnd?.kind).toBe("gateway_stopping");
      expect(asked).toEqual([["c1", null]]);
      expect(finalized).toEqual([]);
    } finally {
      reg.closeAll();
    }
  });

  it("plain close, nothing announced: asked at once", async () => {
    const { reg, session, finalized, asked } = await turnInFlight();
    try {
      gateway!.socket!.terminate();
      await until(() => session.connection.isClosed);
      await sleep(20);
      expect((session.connection as OpenClawConnection).connectionEnd?.kind).toBe("connection_closed");
      expect(asked).toEqual([["c1", null]]);
      expect(finalized).toEqual([]);
    } finally {
      reg.closeAll();
    }
  });
});

describe("a request that needs a new socket while an announced restart is awaited", () => {
  const announceOn = async (notice: unknown) => {
    gateway = startWsFakeGateway({ version: "2026.9.36" });
    await gateway.ready;
    const url = gateway.url;
    const conn = await OpenClawConnection.connect(url, "tok", deviceIdentity());
    gateway.push(notice);
    await sleep(20);
    conn.close();
    return url;
  };
  const down = async () => {
    for (const client of [gateway!.socket]) client?.terminate();
    await gateway!.stop();
    gateway = null;
  };
  const failure = async (url: string) =>
    OpenClawConnection.connect(url, "tok", deviceIdentity()).then(
      () => null,
      (err: unknown) => err,
    );

  it("the gateway is still down: the failure is the announced restart, a lost-response class", async () => {
    const url = await announceOn(RESTART_NOTICE);
    await down();
    const err = await failure(url);
    expect(err).toBeInstanceOf(Error);
    const code = classifyGatewayError(err);
    expect(code).toBe("GATEWAY_RESTARTING");
    expect(LOST_RESPONSE_CODES.has(code)).toBe(true);
  });

  it("past the window (15 s at least, three times the delay given): a plain disconnect again", async () => {
    const url = await announceOn(RESTART_NOTICE);
    await down();
    const announcedAt = Date.now();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(announcedAt + 14_000);
    expect(classifyGatewayError(await failure(url))).toBe("GATEWAY_RESTARTING");
    now.mockReturnValue(announcedAt + 16_000);
    expect(classifyGatewayError(await failure(url))).toBe("GATEWAY_DISCONNECTED");
  });

  it("the gateway came back and went away again unannounced: a plain disconnect", async () => {
    const url = await announceOn(RESTART_NOTICE);
    // Back: a connection completes its handshake on the same gateway.
    (await OpenClawConnection.connect(url, "tok", deviceIdentity())).close();
    await down();
    expect(classifyGatewayError(await failure(url))).toBe("GATEWAY_DISCONNECTED");
  });

  it("an announced STOP opens no window: the gateway did not say it would be back", async () => {
    const url = await announceOn(STOP_NOTICE);
    await down();
    expect(classifyGatewayError(await failure(url))).toBe("GATEWAY_DISCONNECTED");
  });

  it("a gateway that ANSWERS the handshake with a refusal is not away: its own text is kept", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n", ts: 1 } }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id: string };
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "INVALID_REQUEST", message: "unauthorized: gateway token mismatch" },
          }),
        );
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    try {
      const plain = await failure(url);
      expect(plain).toBeInstanceOf(GatewayConnectRefusedError);
      restartWindows.announce(normalizeWsUrl(url), 1_500, Date.now());
      const awaited = await failure(url);
      expect(awaited).toBeInstanceOf(GatewayConnectRefusedError);
      expect((awaited as Error).message).toBe((plain as Error).message);
    } finally {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("another gateway's restart names nothing here", async () => {
    await announceOn(RESTART_NOTICE);
    await down();
    gateway = startWsFakeGateway({ version: "2026.9.36" });
    await gateway.ready;
    const other = gateway.url;
    await down();
    expect(classifyGatewayError(await failure(other))).toBe("GATEWAY_DISCONNECTED");
  });

  it("the window: the Control UI's — max(15 s, 3 × the delay), dropped at the next connection", () => {
    const w = new RestartWindows();
    w.announce("ws://gw", 1_500, 1_000);
    expect(w.pending("ws://gw", 15_999)).toBe(true);
    expect(w.pending("ws://gw", 16_000)).toBe(false);
    w.announce("ws://gw", 20_000, 1_000);
    expect(w.pending("ws://gw", 60_999)).toBe(true);
    expect(w.pending("ws://gw", 61_000)).toBe(false);
    w.announce("ws://gw", null, 1_000);
    expect(w.pending("ws://gw", 15_999)).toBe(true);
    w.connected("ws://gw");
    expect(w.pending("ws://gw", 1_001)).toBe(false);
    expect(w.pending("ws://other", 1_001)).toBe(false);
  });
});
