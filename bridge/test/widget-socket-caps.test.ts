// A conversation's socket declares `inline-widgets` — the client capability that makes
// the gateway OFFER `show_widget` to the agent (upstream src/canvas/widget-tool.ts
// SHOW_WIDGET_REQUIRED_CLIENT_CAPS; captured live on 2026.9.6: 56 tools without it, 57
// with it) — exactly when the conversation wants widgets AND the gateway version is one
// Atrium renders them for. The wish changes with two switches (instance, conversation),
// so a change must re-open the socket on the next turn — but never at the cost of a live
// voice call or of a turn still streaming on it.
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
} from "../src/providers/openclaw/openclaw-client.js";

function fakeConn(gatewayVersion: string | null) {
  let closed = false;
  let release: () => void = () => {};
  const closedListeners: Array<() => void> = [];
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    gatewayVersion,
    get isClosed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      release();
      for (const l of closedListeners) l();
    },
    async request() {
      return { payload: {} };
    },
    modelsByOwner: new Map(),
    rosterEpoch: 0,
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: (l: () => void) => {
      closedListeners.push(l);
      return () => {};
    },
    async *frames() {
      await gate;
    },
  };
}

const cfg = (instanceName: string): BridgeConfig =>
  ({
    openclawGatewayUrl: `ws://${instanceName}/ws`,
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName,
  }) as unknown as BridgeConfig;

function recordConnects(version: () => string | null) {
  const declared: string[][] = [];
  const sockets: Array<ReturnType<typeof fakeConn>> = [];
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async (...args: unknown[]) => {
    declared.push([...((args[7] as string[] | undefined) ?? [])].sort());
    const conn = fakeConn(version());
    sockets.push(conn);
    return conn as never;
  });
  return { declared, sockets };
}

const acquire = (
  reg: SessionRegistry,
  instanceName: string,
  chatId: string,
  inlineWidgets: boolean | undefined,
) =>
  reg.acquire({
    chatId,
    openclawChatId: `oc-${chatId}`,
    agentId: "main",
    canonical: "alice",
    instanceName,
    ...(inlineWidgets === undefined ? {} : { inlineWidgets }),
  });

const WITH = ["approvals", "inline-widgets"];

afterEach(() => vi.restoreAllMocks());

describe("the inline-widgets connect capability", () => {
  it("wanted on a 2026.9.6 gateway: declared after the handshake, and the normalizer emits widgets", async () => {
    const { declared, sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-a")));
    const s = await acquire(reg, "w-a", "c1", true);
    expect(declared).toEqual([[], WITH]);
    expect(sockets[0]!.isClosed).toBe(true);
    expect(s.runManager.widgetsEnabled).toBe(true);
    reg.closeAll();
  });

  it("not wanted: never declared, and the normalizer turns no carrier into a widget", async () => {
    const { declared } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-b")));
    const s = await acquire(reg, "w-b", "c1", false);
    expect(declared.at(-1)).toEqual(["approvals"]);
    expect(declared.flat()).not.toContain("inline-widgets");
    expect(s.runManager.widgetsEnabled).toBe(false);
    reg.closeAll();
  });

  it("wanted on a gateway below the floor: never declared (fail closed)", async () => {
    const { declared } = recordConnects(() => "2026.9.5");
    const reg = new SessionRegistry(servedMap(cfg("w-c")));
    const s = await acquire(reg, "w-c", "c1", true);
    expect(declared.flat()).not.toContain("inline-widgets");
    expect(s.runManager.widgetsEnabled).toBe(false);
    reg.closeAll();
  });

  it("a switch flipped between two turns re-opens the socket on the next turn", async () => {
    const { declared, sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-d")));
    const first = await acquire(reg, "w-d", "c1", true);
    const before = sockets.length;
    const second = await acquire(reg, "w-d", "c1", false);
    expect(second).not.toBe(first);
    expect(sockets[before - 1]!.isClosed).toBe(true);
    expect(declared.at(-1)).toEqual(["approvals"]);
    expect(second.runManager.widgetsEnabled).toBe(false);
    reg.closeAll();
  });

  it("a route that does not know the wish (patch, reset, …) never re-opens the socket", async () => {
    const { sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-e")));
    const first = await acquire(reg, "w-e", "c1", true);
    const opened = sockets.length;
    const again = await acquire(reg, "w-e", "c1", undefined);
    expect(again).toBe(first);
    expect(sockets.length).toBe(opened);
    expect(again.runManager.widgetsEnabled).toBe(true);
    reg.closeAll();
  });

  it("a live voice call DEFERS the switch: the socket (and the call on it) is kept", async () => {
    const { sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-f")));
    const first = await acquire(reg, "w-f", "c1", true);
    first.holdForVoiceCall("voice-1", 60);
    const opened = sockets.length;
    const again = await acquire(reg, "w-f", "c1", false);
    expect(again).toBe(first);
    expect(sockets.length).toBe(opened);
    expect(sockets.at(-1)!.isClosed).toBe(false);
    // Once the call is over, the next turn applies the switch.
    first.releaseVoiceCall("voice-1");
    const after = await acquire(reg, "w-f", "c1", false);
    expect(after).not.toBe(first);
    expect(after.runManager.widgetsEnabled).toBe(false);
    reg.closeAll();
  });
});

// PROD 0.91.0 (chat mh77m9e7, a GPT Live call): the socket a Talk mint OPENED never
// declared inline-widgets — the mint named no wish, and creation read "no wish" as
// "off". A typed turn during the call then found a socket without the capability,
// could not re-open it (the call lives on it), and ran without show_widget; the
// gateway steered the agent to a dashboard Atrium cannot show. Every route that can
// OPEN the conversation's socket now carries the conversation's wish, and creation
// never silently drops a wish the chat's previous socket had.
describe("a socket opened by any route declares what the conversation wants", () => {
  const routing = (chatId: string, extra: Record<string, unknown> = {}) => ({
    chatId,
    openclawChatId: `oc-${chatId}`,
    agentId: "main",
    canonical: "alice",
    instanceName: "w-g",
    ...extra,
  });

  it("a session operation that OPENS the socket uses the wish it carries (creation only)", async () => {
    const { declared } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-g")));
    const opened = await reg.acquire(routing("c1", { widgetsAtCreate: true }));
    expect(declared.at(-1)).toEqual(WITH);
    expect(opened.runManager.widgetsEnabled).toBe(true);
    const off = await reg.acquire(routing("c2", { widgetsAtCreate: false }));
    expect(declared.at(-1)).toEqual(["approvals"]);
    expect(off.runManager.widgetsEnabled).toBe(false);
    reg.closeAll();
  });

  it("…but never re-opens a socket that is already there for it", async () => {
    const { sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-g")));
    const first = await reg.acquire(routing("c1", { inlineWidgets: false }));
    const count = sockets.length;
    const again = await reg.acquire(routing("c1", { widgetsAtCreate: true }));
    expect(again).toBe(first);
    expect(sockets.length).toBe(count);
    reg.closeAll();
  });

  it("a route naming no wish inherits the chat's previous socket's, never off by default", async () => {
    const { declared, sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-g")));
    await reg.acquire(routing("c1", { inlineWidgets: true }));
    sockets.at(-1)!.close(); // the gateway dropped it
    const reborn = await reg.acquire(routing("c1"));
    expect(declared.at(-1)).toEqual(WITH);
    expect(reborn.runManager.widgetsEnabled).toBe(true);
    reg.closeAll();
  });

  it("a turn during a call on a socket opened WITH widgets takes no deferral, and keeps them", async () => {
    recordConnects(() => "2026.9.6");
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const reg = new SessionRegistry(servedMap(cfg("w-g")));
    const minted = await reg.acquire(routing("c1", { inlineWidgets: true }));
    minted.holdForVoiceCall("voice-1", 60);
    const turn = await reg.acquire(routing("c1", { inlineWidgets: true }));
    expect(turn).toBe(minted);
    expect(turn.runManager.widgetsEnabled).toBe(true);
    const said = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
    expect(said.filter((l) => /widget switch deferred|widgets unavailable/.test(l))).toEqual([]);
    reg.closeAll();
  });

  it("a wish turned ON mid-call is deferred, and NAMED as widgets unavailable for the turn", async () => {
    recordConnects(() => "2026.9.6");
    const warn = vi.spyOn(console, "warn");
    const reg = new SessionRegistry(servedMap(cfg("w-g")));
    const minted = await reg.acquire(routing("c1", { inlineWidgets: false }));
    minted.holdForVoiceCall("voice-1", 60);
    const turn = await reg.acquire(routing("c1", { inlineWidgets: true }));
    expect(turn).toBe(minted);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => /\[widgets\] chat c1: inline widgets unavailable/.test(l))).toBe(true);
    reg.closeAll();
  });
});

describe("over HTTP: every route that can open the conversation's socket carries the wish", () => {
  const httpCfg = {
    ...(cfg("primary") as unknown as Record<string, unknown>),
    bridgeSharedSecret: "test-shared-secret",
    mediaOutboundDir: "/tmp/media-outbound",
    mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  } as unknown as BridgeConfig;
  let server: import("node:http").Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function boot() {
    const { createBridgeServer } = await import("../src/server.js");
    const { HealthRegistry } = await import("../src/core/health.js");
    const { sharedFromConfig } = await import("./helpers/served.js");
    const registry = new SessionRegistry(servedMap(httpCfg));
    server = createBridgeServer({
      shared: sharedFromConfig(httpCfg),
      served: servedMap(httpCfg),
      registry,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify(body),
      });
    return { registry, post };
  }

  const owner = (chatId: string) => ({
    instanceName: "primary",
    chatId,
    openclawChatId: `oc-${chatId}`,
    agentId: "main",
    canonical: "alice",
  });

  const ROUTES: Array<[string, (chatId: string) => Record<string, unknown>]> = [
    ["/patch", (c) => ({ ...owner(c), sessionSettings: { thinkingLevel: "low", clears: [] } })],
    ["/compact", (c) => ({ ...owner(c) })],
    ["/reset", (c) => ({ ...owner(c) })],
    ["/permission-mode", (c) => ({ ...owner(c), choice: "default", fullAuthorized: false, managed: true })],
    ["/knowledge", (c) => ({ ...owner(c), op: "apply", choice: { kind: "default" }, revision: 1 })],
    [
      "/subagent-send",
      (c) => ({ ...owner(c), childSessionKey: "agent:main:subagent:ix", interactionId: "ix-1", message: "go on" }),
    ],
  ];

  for (const [path, body] of ROUTES) {
    it(`${path} opening the socket before any send: widgets on → declared; off → not`, async () => {
      const { declared } = recordConnects(() => "2026.9.6");
      const { registry, post } = await boot();
      await post(path, { ...body("on"), inlineWidgets: true });
      expect(registry.peekByChat("on")?.runManager.widgetsEnabled).toBe(true);
      expect(declared.at(-1)).toEqual(WITH);
      await post(path, { ...body("off"), inlineWidgets: false });
      expect(registry.peekByChat("off")?.runManager.widgetsEnabled).toBe(false);
      expect(declared.at(-1)).toEqual(["approvals"]);
      registry.closeAll();
    });
  }
});

// CODEX PASS 10, P2-1: a `chat.send` in its ACK window is not a turn yet
// (turnActive false) — but the gateway may already have accepted it. A widget switch
// (a Talk mint arriving with another wish) closed the socket under it: the ACK and
// every frame of the answer were lost. Anything the socket still carries now defers
// the switch, like a live call.
describe("a widget switch never closes a socket that still carries work", () => {
  const routing = (inlineWidgets: boolean) => ({
    chatId: "c1",
    openclawChatId: "oc-c1",
    agentId: "main",
    canonical: "alice",
    instanceName: "w-h",
    inlineWidgets,
  });

  it("a send awaiting its ACK: the socket is kept; once settled, the switch applies", async () => {
    const { sockets } = recordConnects(() => "2026.9.6");
    const log = vi.spyOn(console, "log");
    const reg = new SessionRegistry(servedMap(cfg("w-h")));
    const first = await reg.acquire(routing(true));
    first.runManager.armReplayBuffer(); // chat.send leaves: pre-ACK window
    expect(first.runManager.turnActive).toBe(false);
    const opened = sockets.length;
    const mint = await reg.acquire(routing(false)); // e.g. /talk-session, wish changed
    expect(mint).toBe(first);
    expect(sockets.length).toBe(opened);
    expect(sockets.at(-1)!.isClosed).toBe(false);
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => /deferred \(dispatch in flight\)/.test(l))).toBe(true);
    first.runManager.disarmReplayBuffer(Date.now());
    const after = await reg.acquire(routing(false));
    expect(after).not.toBe(first);
    reg.closeAll();
  });

  it("a sub-agent interaction awaiting its reply: the socket is kept", async () => {
    const { sockets } = recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-h")));
    const first = await reg.acquire(routing(true));
    first.armSubAgentInteraction("agent:main:subagent:ix", "ix-1");
    const opened = sockets.length;
    const again = await reg.acquire(routing(false));
    expect(again).toBe(first);
    expect(sockets.length).toBe(opened);
    reg.closeAll();
  });
});

// CODEX PASS 11 (P2-a): /subagent-send ARMED the interaction before its checks, and a
// refused send left it `running` until the TTL — the socket read "busy" and every
// widget switch was deferred for 15 minutes. It is now armed right before the send and
// undone when the send certainly never reached the child.
describe("a refused sub-agent interaction leaves nothing armed", () => {
  const httpCfg = {
    ...(cfg("primary") as unknown as Record<string, unknown>),
    bridgeSharedSecret: "test-shared-secret",
  } as unknown as BridgeConfig;
  let server: import("node:http").Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function post(
    chatSend: (params: Record<string, unknown>) => unknown,
    maxPayload: number | null,
    message: string,
    attachments?: unknown[],
  ) {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      const conn = fakeConn("2026.9.6");
      return {
        ...conn,
        get isClosed() {
          return conn.isClosed;
        },
        close: () => conn.close(),
        maxPayload,
        async request(method: string, params: Record<string, unknown>) {
          if (method === "chat.send") return chatSend(params);
          return { payload: {} };
        },
      } as never;
    });
    const { createBridgeServer } = await import("../src/server.js");
    const { HealthRegistry } = await import("../src/core/health.js");
    const { sharedFromConfig } = await import("./helpers/served.js");
    const registry = new SessionRegistry(servedMap(httpCfg));
    server = createBridgeServer({
      shared: sharedFromConfig(httpCfg),
      served: servedMap(httpCfg),
      registry,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/subagent-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
      body: JSON.stringify({
        instanceName: "primary",
        chatId: "c1",
        openclawChatId: "oc-c1",
        agentId: "main",
        canonical: "alice",
        inlineWidgets: true,
        childSessionKey: "agent:main:subagent:ix",
        interactionId: "ix-1",
        message,
        ...(attachments ? { attachments } : {}),
      }),
    });
    const session = registry.peekByChat("c1") as unknown as {
      busyReason(now: number): string | null;
      clock: () => number;
    };
    return { res, busy: session.busyReason(session.clock()), registry };
  }

  it("too large for the socket: refused by name, nothing armed", async () => {
    const { res, busy, registry } = await post(() => ({ payload: {} }), 4_096, "é".repeat(5_000));
    expect(res.status).toBe(502);
    expect(busy).toBeNull();
    registry.closeAll();
  });

  it("an attachment over the socket's limit: refused before arming", async () => {
    const big = [{ type: "image", mimeType: "image/png", fileName: "x.png", content: "A".repeat(8_000) }];
    const { res, busy, registry } = await post(() => ({ payload: {} }), 4_096, "go on", big);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: { code: "attachment_too_large" } });
    expect(busy).toBeNull();
    registry.closeAll();
  });

  it("refused by the gateway: nothing armed", async () => {
    const { res, busy, registry } = await post(() => {
      throw new GatewayAnsweredError("INVALID_REQUEST: no");
    }, null, "go on");
    expect(res.status).toBe(502);
    expect(busy).toBeNull();
    registry.closeAll();
  });

  it("UNANSWERED (the run may be live): stays armed, the socket stays busy", async () => {
    const { res, busy, registry } = await post(() => {
      throw new Error("request timed out");
    }, null, "go on");
    expect(res.status).toBe(502);
    expect(busy).toBe("sub-agent interaction pending");
    registry.closeAll();
  });

  it("sent: armed, the socket busy until the reply", async () => {
    const { res, busy, registry } = await post(() => ({ payload: { runId: "interaction-ix-1" } }), null, "go on");
    expect(res.status).toBe(200);
    expect(busy).toBe("sub-agent interaction pending");
    registry.closeAll();
  });

  it("arming and disarming wake the consume loop (a deadline moved)", async () => {
    recordConnects(() => "2026.9.6");
    const reg = new SessionRegistry(servedMap(cfg("w-i")));
    const session = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc-c1",
      agentId: "main",
      canonical: "alice",
      instanceName: "w-i",
    });
    const wake = vi.spyOn(session, "wake");
    session.armSubAgentInteraction("agent:main:subagent:ix", "ix-1");
    expect(wake).toHaveBeenCalledTimes(1);
    session.disarmSubAgentInteraction("agent:main:subagent:ix", "ix-1");
    expect(wake).toHaveBeenCalledTimes(2);
    reg.closeAll();
  });
});

// codex pass 13: an IDENTITY re-key (another agent, another key) used to close the
// socket even while a sub-agent's reply was still owed on it — losing the reply, also
// one the gateway was still recovering. It is now refused by TYPE, exactly like a live
// voice call (TalkCallActiveError): a re-key cannot be deferred half-way.
describe("an identity re-key never closes a socket a sub-agent reply is owed on", () => {
  const routing = (agentId: string) => ({
    chatId: "c1",
    openclawChatId: "oc-c1",
    agentId,
    canonical: "alice",
    instanceName: "w-j",
    inlineWidgets: true,
  });

  it("refused while the interaction is pending; allowed once it settles", async () => {
    const { sockets } = recordConnects(() => "2026.9.6");
    const { SubAgentReplyPendingError } = await import("../src/session.js");
    const reg = new SessionRegistry(servedMap(cfg("w-j")));
    const alice = await reg.acquire(routing("alice"));
    alice.armSubAgentInteraction("agent:alice:subagent:ix", "ix-1");
    const opened = sockets.length;
    await expect(reg.acquire(routing("bob"))).rejects.toBeInstanceOf(SubAgentReplyPendingError);
    expect(sockets.length).toBe(opened);
    expect(sockets.at(-1)!.isClosed).toBe(false);
    alice.disarmSubAgentInteraction("agent:alice:subagent:ix", "ix-1");
    const bob = await reg.acquire(routing("bob"));
    expect(bob).not.toBe(alice);
    reg.closeAll();
  });

  it("classified by type as the bridge's own refusal (the link is fine)", async () => {
    const { SubAgentReplyPendingError } = await import("../src/session.js");
    const { classifyGatewayError, faultDomain } = await import("../src/core/dispatch-errors.js");
    const code = classifyGatewayError(new SubAgentReplyPendingError("c1"));
    expect(code).toBe("subagent_reply_pending");
    expect(faultDomain(code)).toBe("local");
  });
});
