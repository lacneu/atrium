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
import { sessionSegmentOf } from "../src/providers/openclaw/session-keys.js";
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
    listening: false,
  };

  it("stale when Convex's session key is not the one the routing derives", () => {
    expect(resumePreflight(null, { ...want, requestedSessionKey: KEY_B }, bubble)).toBe("stale");
  });
  it("FOREIGN when the live socket serves another session or instance: the bubble's session is read apart (Codex pass 7)", () => {
    expect(resumePreflight({ ...idle, sessionKey: KEY_B }, want, bubble)).toBe("foreign");
    expect(resumePreflight({ ...idle, instanceName: "other" }, want, bubble)).toBe("foreign");
  });
  it("busy when the session drives ANOTHER run (temporary, asked again); resumed only for the bubble's own", () => {
    const busyB = { ...idle, turnActive: true, activeRunIds: ["run-b"], currentMessageId: "m-b" };
    expect(resumePreflight(busyB, want, bubble)).toBe("busy");
    expect(resumePreflight({ ...busyB, activeRunIds: ["run-a"] }, want, bubble)).toBe("resumed");
    expect(resumePreflight({ ...busyB, currentMessageId: "m-a" }, want, bubble)).toBe("resumed");
  });
  it("busy when the idle socket carries other work; proceed when idle or absent", () => {
    expect(resumePreflight({ ...idle, busy: true }, want, bubble)).toBe("busy");
    expect(resumePreflight(idle, want, bubble)).toBe("proceed");
    expect(resumePreflight(null, want, bubble)).toBe("proceed");
  });
  it("Codex pass 5 — FOLLOWED when the socket on the bubble's session listens: nothing to read again", () => {
    expect(resumePreflight({ ...idle, listening: true }, want, bubble)).toBe("followed");
    expect(resumePreflight({ ...idle, listening: true, busy: true }, want, bubble)).toBe("followed");
    const otherRun = { ...idle, turnActive: true, activeRunIds: ["run-b"], currentMessageId: "m-b", listening: true };
    expect(resumePreflight(otherRun, want, bubble)).toBe("followed");
    // …but a socket on ANOTHER session never follows this bubble.
    expect(resumePreflight({ ...idle, listening: true, sessionKey: KEY_B }, want, bubble)).toBe("foreign");
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
      // A's session is read APART (Codex pass 7): one more connection, its own — B's socket
      // is neither closed nor moved. This double answers no session facts: `unknown`.
      expect(await res.json()).toEqual({ ok: true, resumed: false, reason: "unknown" });
      expect(liveB.connection.isClosed).toBe(false);
      expect(reg.peekByChat("c1")).toBe(liveB);
      expect(connect).toHaveBeenCalledTimes(2);
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
      // BUSY, not stale (Codex pass 5): a temporary refusal the next cycle asks again.
      expect(await res.json()).toEqual({ ok: true, resumed: false, reason: "busy" });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      leaveSend();
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });

  it("Codex passes 5-6 — a FOLLOWED bubble (listening, no turn driving it): ONE coalesced read per cycle, nothing else", async () => {
    let requests = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      const c = fakeConn();
      return {
        ...c,
        get isClosed() {
          return c.isClosed;
        },
        async request(method: string) {
          if (method !== "chat.history") return { payload: {} };
          requests++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return { payload: {} };
        },
      } as never;
    });
    const reg = new SessionRegistry(servedMap(CONFIG, {} as never));
    const live = await reg.acquire({ ...ROUTE_B, instanceName: "primary" });
    live.transcriptShadow!.configure({});
    await live.transcriptShadow!.idle();
    const { server, url } = await serve(reg);
    try {
      const before = requests;
      const res = await post(url, {
        ...ROUTE_B,
        instanceName: "primary",
        sessionKey: KEY_B,
        liveBubble: { messageId: "m-b", runId: "run-b" },
      });
      expect(await res.json()).toEqual({ ok: true, resumed: false, reason: "followed" });
      await live.transcriptShadow!.idle();
      // The reconciler read the gateway's state — on the same socket, no turn opened.
      expect(requests).toBeGreaterThan(before);
      expect(live.runManager.turnActive).toBe(false);
      expect(live.connection.isClosed).toBe(false);
      expect(reg.peekByChat("c1")).toBe(live);
      // Three cycles at once: never two reads of this chat in flight together, and a read in
      // flight absorbs the requests made meanwhile (one more after it at most).
      const burst = requests;
      await Promise.all(
        [0, 1, 2].map(() =>
          post(url, {
            ...ROUTE_B,
            instanceName: "primary",
            sessionKey: KEY_B,
            liveBubble: { messageId: "m-b", runId: "run-b" },
          }),
        ),
      );
      await live.transcriptShadow!.idle();
      expect(requests - burst).toBeLessThanOrEqual(2);
      expect(maxInFlight).toBe(1);
    } finally {
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


describe("sessionSegmentOf — the bubble's own segment, only from a key of THIS agent and person (Codex pass 8)", () => {
  it("reads the segment of a key built for the agent and person; refuses any other key", () => {
    expect(sessionSegmentOf("agent:agent-a:atrium:chat:alice:turn-first", "agent-a", "alice")).toBe("turn-first");
    expect(sessionSegmentOf("agent:agent-b:atrium:chat:alice:turn-first", "agent-a", "alice")).toBeNull();
    expect(sessionSegmentOf("agent:agent-a:atrium:chat:bob:turn-first", "agent-a", "alice")).toBeNull();
    expect(sessionSegmentOf("agent:agent-a:atrium:chat:alice:", "agent-a", "alice")).toBeNull();
    expect(sessionSegmentOf("agent:agent-a:atrium:chat:alice:a b", "agent-a", "alice")).toBeNull();
  });
});
