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
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";

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
