// Boot self-heal grows the served set at RUNTIME (registry.register). This pins the
// behavior the advisor flagged: the sole-instance `acquire` fallback (implicit routing
// when no instanceName is given) flips off the moment a SECOND instance registers — and
// crucially, an EXPLICIT-instanceName send to the ORIGINAL instance keeps routing
// correctly after growth (no silent misroute).

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import type { InstanceBundle } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";

/** Minimal fake connection: never yields a frame; completes only on close. */
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
    async *frames() {
      await gate;
    },
  };
}

const cfg = (instanceName: string, url: string): BridgeConfig =>
  ({
    openclawGatewayUrl: url,
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName,
  }) as unknown as BridgeConfig;

const bundle = (instanceName: string, url: string): InstanceBundle =>
  servedMap(cfg(instanceName, url)).get(instanceName)!;

afterEach(() => vi.restoreAllMocks());

describe("SessionRegistry — runtime growth (boot self-heal)", () => {
  it("routes explicitly to a newly-registered instance AND keeps routing the original", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);

    // Start serving ONLY olivier (size 1).
    const reg = new SessionRegistry(
      servedMap(cfg("olivier", "ws://olivier/ws")),
    );

    // Size 1: implicit routing (no instanceName) falls back to the sole instance.
    await reg.acquire({
      chatId: "c0",
      openclawChatId: "oc0",
      agentId: "main",
      canonical: "alice",
    });
    expect(connect).toHaveBeenLastCalledWith(
      "ws://olivier/ws",
      "t",
      expect.anything(),
    );

    // Self-heal registers jerome at runtime (size -> 2).
    reg.register("jerome", bundle("jerome", "ws://jerome/ws"));

    // Explicit route to the NEW instance hits jerome's gateway.
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "bob",
      instanceName: "jerome",
    });
    expect(connect).toHaveBeenLastCalledWith(
      "ws://jerome/ws",
      "t",
      expect.anything(),
    );

    // Explicit route to the ORIGINAL instance STILL hits olivier's gateway (no misroute
    // after growth — the property the advisor asked to guard).
    await reg.acquire({
      chatId: "c2",
      openclawChatId: "oc2",
      agentId: "main",
      canonical: "carol",
      instanceName: "olivier",
    });
    expect(connect).toHaveBeenLastCalledWith(
      "ws://olivier/ws",
      "t",
      expect.anything(),
    );

    reg.closeAll();
  });

  it("implicit routing (no instanceName) STOPS resolving once a second instance registers", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const reg = new SessionRegistry(
      servedMap(cfg("olivier", "ws://olivier/ws")),
    );
    reg.register("jerome", bundle("jerome", "ws://jerome/ws"));

    // With two instances served and NO instanceName, there is no sole fallback — the
    // dispatch MUST carry an instanceName. This documents the deliberate semantics shift
    // (multi-instance dispatch always sets instanceName via each instance's bridgeUrl).
    await expect(
      reg.acquire({
        chatId: "cX",
        openclawChatId: "ocX",
        agentId: "main",
        canonical: "dave",
      }),
    ).rejects.toThrow(/instance not served/);

    reg.closeAll();
  });
});
