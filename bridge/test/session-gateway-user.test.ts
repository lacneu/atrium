/**
 * Per-instance gateway naming: an instance may tell Atrium to NAME a person to
 * the gateway the way its identity provider does (their address), while Atrium
 * keeps routing the conversation by its own stable key.
 *
 * The two must not be the same string in the same place. `canonical` is a SEGMENT
 * of the gateway session key, so naming the connection and keying the session are
 * one decision only by accident — and an operator flipping the naming would then
 * silently re-key every live conversation, orphaning its gateway history with
 * nothing logged. These tests pin the two apart at the site that decides both.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import { HealthRegistry } from "../src/core/health.js";
import { createBridgeServer } from "../src/server.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { buildIdentityHeaders } from "../src/providers/openclaw/gateway-identity.js";

/** Minimal fake connection (mirrors session-rekey.test.ts). */
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
    modelsByOwner: new Map(),
    rosterEpoch: 0,
    onConfigChanged: () => () => {},
    onClosed: () => () => {},
    async *frames() {
      await gate;
    },
  };
}

const config = {
  instanceName: "primary",
  openclawGatewayUrl: "wss://gw.example.org",
  openclawToken: "",
  openclawAuthMode: "trusted-proxy",
  openclawForwardedClientIp: "203.0.113.7",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
} as unknown as BridgeConfig;

afterEach(() => vi.restoreAllMocks());

type ConnectSpy = { mock: { calls: unknown[][] } };

/** The identity argument the registry handed to `connect` on the Nth call. */
function identityOf(connect: ConnectSpy, call = 0) {
  return connect.mock.calls[call]?.[5] as Parameters<
    typeof buildIdentityHeaders
  >[0];
}

describe("SessionRegistry — the gateway name and the routing key are separate", () => {
  it("names the person the way the instance asked, on the socket", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "u-olivier",
      gatewayUser: "olivier@example.org",
    });
    const headers = buildIdentityHeaders(identityOf(connect));
    expect(headers["x-forwarded-user"]).toBe("olivier@example.org");
    reg.closeAll();
  });

  it("keys the SESSION by the canonical even so — the history does not move", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const s = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "u-olivier",
      gatewayUser: "olivier@example.org",
    });
    // Byte-for-byte the key the same conversation had before the setting existed.
    expect(s.sessionKey).toBe("agent:main:atrium:chat:u-olivier:oc1");
    expect(connect).toHaveBeenCalledTimes(1);
    reg.closeAll();
  });

  it("falls back to the canonical when the instance names nothing", async () => {
    // Every deployment that predates the setting, and every instance left on the
    // default: the handshake must be the one that shipped.
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "u-olivier",
    });
    const headers = buildIdentityHeaders(identityOf(connect));
    expect(headers["x-forwarded-user"]).toBe("u-olivier");
    reg.closeAll();
  });

  it("does NOT re-key a live conversation when only the name changes", async () => {
    // The failure this whole separation exists to prevent: an operator switching
    // an instance from canonical naming to address naming mid-flight must not give
    // every open conversation a brand-new gateway session.
    //
    // The COST of that choice, pinned here so nobody reads this test as the good
    // half only: a live conversation keeps the old name until its socket closes,
    // and the gateway session it already created keeps the profile it was created
    // under for good — `createdActor` is stamped at creation and carried across
    // every later write (upstream `preserveCreationStamp`, v2026.9.2). Re-keying
    // would not fix that either; it would abandon the history instead. So this
    // setting converges NEW conversations, and the docs say so.
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const base = {
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "u-olivier",
    };
    const first = await reg.acquire(base);
    const second = await reg.acquire({
      ...base,
      gatewayUser: "olivier@example.org",
    });
    expect(second).toBe(first);
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(connect).toHaveBeenCalledTimes(1);
    reg.closeAll();
  });
});

describe("/subagent-send — the same door, over HTTP", () => {
  // Interacting with a sub-agent acquires the PARENT's socket, so it is a door
  // onto the same gateway profile as /send. It used to rebuild the routing as a
  // literal of its own; this pins that it reads the shared one.
  const cfg = {
    ...(config as unknown as Record<string, unknown>),
    bridgeSharedSecret: "test-shared-secret",
  } as unknown as BridgeConfig;
  let server: Server;
  let baseUrl = "";

  async function boot() {
    server = createBridgeServer({
      shared: sharedFromConfig(cfg),
      served: servedMap(cfg),
      registry: new SessionRegistry(servedMap(cfg)),
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (body: unknown) =>
    fetch(`${baseUrl}/subagent-send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "test-shared-secret",
      },
      body: JSON.stringify(body),
    });

  it("names the owner on the socket it opens", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    await boot();
    await post({
      instanceName: "primary",
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "u-olivier",
      gatewayUser: "olivier@example.org",
      childSessionKey: "agent:main:subagent:ix",
      interactionId: "ix-1",
      message: "keep going",
    });
    const headers = buildIdentityHeaders(identityOf(connect));
    expect(headers["x-forwarded-user"]).toBe("olivier@example.org");
  });

  it("REFUSES a body with no routing key instead of connecting as nobody", async () => {
    // It used to substitute empty strings, which builds a session key whose
    // person segment is the literal "unknown" — a session belonging to no one,
    // on a gateway that attributes by exactly that string.
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    await boot();
    const res = await post({
      instanceName: "primary",
      chatId: "c1",
      openclawChatId: "oc1",
      childSessionKey: "agent:main:subagent:ix",
      interactionId: "ix-1",
      message: "keep going",
    });
    expect(res.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("/send — the main door, over HTTP", () => {
  // The seam a unit test cannot see: the value crosses a JSON body and a parser
  // that REBUILDS the routing field by field. A test that stops at the registry
  // would stay green while the field never left Convex's vocabulary — which is
  // how `mentions` was lost for every turn.
  const cfg = {
    ...(config as unknown as Record<string, unknown>),
    bridgeSharedSecret: "test-shared-secret",
  } as unknown as BridgeConfig;
  let server: Server;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function send(body: Record<string, unknown>) {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    server = createBridgeServer({
      shared: sharedFromConfig(cfg),
      served: servedMap(cfg),
      registry: new SessionRegistry(servedMap(cfg)),
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "test-shared-secret",
      },
      body: JSON.stringify({
        instanceName: "primary",
        chatId: "c1",
        openclawChatId: "oc1",
        agentId: "main",
        canonical: "u-olivier",
        text: "hello",
        clientMessageId: "cm-1",
        ...body,
      }),
    });
    // The send itself fails against a fake connection (nothing answers the turn),
    // and that is fine: the property under test is the identity of the socket the
    // route OPENED, which happens before anything is dispatched on it.
    void res;
    expect(connect, "the route never opened a socket").toHaveBeenCalled();
    return connect;
  }

  it("carries the name from the body onto the socket", async () => {
    const connect = await send({ gatewayUser: "olivier@example.org" });
    const headers = buildIdentityHeaders(identityOf(connect));
    expect(headers["x-forwarded-user"]).toBe("olivier@example.org");
  });

  it("names the routing key when the body carries none", async () => {
    const connect = await send({});
    const headers = buildIdentityHeaders(identityOf(connect));
    expect(headers["x-forwarded-user"]).toBe("u-olivier");
  });
});

describe("an address the header cannot carry must not silence the person", () => {
  // `x-forwarded-user` carries printable ASCII with no field separator. An
  // INTERNATIONALIZED address is valid everywhere else, and the sign-in accepts it.
  // Handing it straight to the identity builder throws at connect — so every turn
  // that person sends fails 502, from a setting somebody flipped on a screen far
  // away, with the error surfacing nowhere near the cause.
  async function nameFor(gatewayUser: string) {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "main",
      canonical: "u-olivier",
      gatewayUser,
    });
    reg.closeAll();
    return buildIdentityHeaders(identityOf(connect))["x-forwarded-user"];
  }

  it("an internationalized address falls back to the routing key", async () => {
    expect(await nameFor("josé@example.org")).toBe("u-olivier");
  });

  it("so does one too long for a gateway profile key", async () => {
    expect(await nameFor(`${"a".repeat(201)}@example.org`)).toBe("u-olivier");
  });

  it("so does one carrying a header field separator", async () => {
    expect(await nameFor('"a,b"@example.org')).toBe("u-olivier");
  });

  it("and a perfectly ordinary address is still used", async () => {
    // The guard must not quietly swallow the feature it protects.
    expect(await nameFor("olivier@example.org")).toBe("olivier@example.org");
  });
});
