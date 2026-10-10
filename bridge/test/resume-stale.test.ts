// A STALE /resume (transcript projection `on`, CU-22, codex pass 4): Convex prepares
// the request for bubble A's run, and it can arrive after A ended and after a turn B
// started on ANOTHER agent or instance — one whose projection may be off. The route
// used to `acquire` first, and acquire re-keys: it closed B's socket, B's live turn
// with it. It now decides on identity BEFORE acquiring anything, and the acquire it
// makes can never displace a socket bound to another session.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { HealthRegistry } from "../src/core/health.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { chatTransitions, createBridgeServer, resumePreflight } from "../src/server.js";
import { SessionDisplaceRefusedError, SessionRegistry } from "../src/session.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

const CONFIG: BridgeConfig = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  bridgeSharedSecret: "test-shared-secret",
  mediaOutboundDir: "/tmp/media-outbound",
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
} as unknown as BridgeConfig;

/** A connection that never yields a frame and answers every RPC with an empty payload. */
function fakeConn() {
  let closed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      release();
    },
    async request() {
      return { payload: {} };
    },
    gatewayVersion: "2026.9.8",
    modelsByOwner: new Map(),
    rosterEpoch: 0,
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: () => () => {},
    async *frames() {
      await gate;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

const ROUTE_B = { chatId: "c1", openclawChatId: null, agentId: "agent-b", canonical: "alice" };
const KEY_B = "agent:agent-b:atrium:chat:alice:c1";
const KEY_A = "agent:agent-a:atrium:chat:alice:c1";

describe("SessionRegistry.acquire({ displace: false })", () => {
  it("refuses — and closes nothing — when the chat's socket is bound to another session", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(CONFIG, {} as never));
    const live = await reg.acquire({ ...ROUTE_B, instanceName: "primary" });
    await expect(
      reg.acquire({ ...ROUTE_B, agentId: "agent-a", instanceName: "primary" }, { displace: false }),
    ).rejects.toBeInstanceOf(SessionDisplaceRefusedError);
    expect(live.connection.isClosed).toBe(false);
    expect(reg.peekByChat("c1")).toBe(live);
    reg.closeAll();
  });

  it("still returns the very session when the identity matches", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(CONFIG, {} as never));
    const live = await reg.acquire({ ...ROUTE_B, instanceName: "primary" });
    expect(await reg.acquire({ ...ROUTE_B, instanceName: "primary" }, { displace: false })).toBe(
      live,
    );
    reg.closeAll();
  });
});

describe("resumePreflight", () => {
  const bubble = { messageId: "m-a", runId: "run-a" };
  const want = { sessionKey: KEY_A, instanceName: "primary", requestedSessionKey: KEY_A };
  const idle = {
    sessionKey: KEY_A,
    instanceName: "primary",
    turnActive: false,
    turnFinalizing: false,
    activeRunIds: [],
    currentMessageId: null,
    busy: false,
  };

  it("stale when Convex's session key is not the one the routing derives", () => {
    expect(resumePreflight(null, { ...want, requestedSessionKey: KEY_B }, bubble)).toBe("stale");
  });
  it("stale when the live socket is bound to another session or instance", () => {
    expect(resumePreflight({ ...idle, sessionKey: KEY_B }, want, bubble)).toBe("stale");
    expect(resumePreflight({ ...idle, instanceName: "other" }, want, bubble)).toBe("stale");
  });
  it("stale when the session drives ANOTHER run; resumed only for the bubble's own", () => {
    const busyB = { ...idle, turnActive: true, activeRunIds: ["run-b"], currentMessageId: "m-b" };
    expect(resumePreflight(busyB, want, bubble)).toBe("stale");
    expect(resumePreflight({ ...busyB, activeRunIds: ["run-a"] }, want, bubble)).toBe("resumed");
    expect(resumePreflight({ ...busyB, currentMessageId: "m-a" }, want, bubble)).toBe("resumed");
  });
  it("stale when the idle socket carries other work; proceed when idle or absent", () => {
    expect(resumePreflight({ ...idle, busy: true }, want, bubble)).toBe("stale");
    expect(resumePreflight(idle, want, bubble)).toBe("proceed");
    expect(resumePreflight(null, want, bubble)).toBe("proceed");
  });
});

describe("POST /resume never closes another session's live socket", () => {
  async function serve(reg: SessionRegistry): Promise<{ server: Server; url: string }> {
    const server = createBridgeServer({
      shared: sharedFromConfig(CONFIG),
      served: servedMap(CONFIG, {} as never),
      registry: reg,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((res) => server.listen(0, res));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const post = (url: string, body: unknown) =>
    fetch(`${url}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
      body: JSON.stringify(body),
    });

  it("a resume for agent A while agent B owns the chat's socket: not resumed, B untouched", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(CONFIG, {} as never));
    const liveB = await reg.acquire({ ...ROUTE_B, instanceName: "primary" });
    const { server, url } = await serve(reg);
    try {
      const res = await post(url, {
        ...ROUTE_B,
        agentId: "agent-a",
        instanceName: "primary",
        sessionKey: KEY_A,
        liveBubble: { messageId: "m-a", runId: "run-a" },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false);
      expect(liveB.connection.isClosed).toBe(false);
      expect(reg.peekByChat("c1")).toBe(liveB);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });

  it("a resume while a send to the chat is being prepared: refused, nothing opened (codex pass 5)", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(CONFIG, {} as never));
    const { server, url } = await serve(reg);
    const leaveSend = await chatTransitions.enterSend("c1");
    try {
      const res = await post(url, {
        ...ROUTE_B,
        agentId: "agent-a",
        instanceName: "primary",
        sessionKey: KEY_A,
        liveBubble: { messageId: "m-a", runId: "run-a" },
      });
      expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      leaveSend();
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });

  it("a resume whose session key the routing no longer derives: refused before any socket opens", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(CONFIG, {} as never));
    const { server, url } = await serve(reg);
    try {
      const res = await post(url, {
        ...ROUTE_B,
        instanceName: "primary",
        sessionKey: KEY_A,
        liveBubble: { messageId: "m-a", runId: "run-a" },
      });
      expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false);
      expect(connect).not.toHaveBeenCalled();
      expect(reg.peekByChat("c1")).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });
});
