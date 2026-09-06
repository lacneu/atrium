/**
 * Per-user gateway identity: what a socket STATES about who it acts for.
 *
 * Everything here is a wire-level fact proven against a real 2026.9.2 gateway on
 * the bench before it was encoded: the gateway refuses a connect whose user header
 * is missing (`trusted_proxy_user_missing`), rejects the HTTP upgrade outright when
 * the forwarded headers name no routable client, and intersects the granted scopes
 * with `x-openclaw-scopes`. The tests below pin the bridge's half of each of those.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TRUSTED_PROXY_USER_HEADER,
  GatewayIdentityError,
  HUMAN_SCOPE_CAP,
  SCOPE_CAP_HEADER,
  buildIdentityHeaders,
  detectForwardedClientIp,
  hostForwardedClientIp,
  identityFor,
  resetHostForwardedClientIpCache,
  systemIdentityFor,
} from "../src/providers/openclaw/gateway-identity.js";
import {
  connectUserHeader,
  humanConnectIdentity,
  systemConnectIdentity,
} from "../src/providers/openclaw/connect-identity.js";
import type { BridgeConfig } from "../src/config.js";
import { GatewayHttpMediaFetcher } from "../src/core/gateway-http-media-fetcher.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { applySessionSettings } from "../src/server.js";
import { deviceIdentity, startWsFakeGateway } from "./helpers/ws-fake-gateway.js";

const cfg = (over: Partial<BridgeConfig> = {}): BridgeConfig =>
  ({
    openclawGatewayUrl: "ws://gw/ws",
    openclawToken: "t",
    deviceIdentity: null,
    bridgeInstanceSecret: null,
    instanceName: "alpha",
    openclawForwardedClientIp: "10.1.2.3",
    ...over,
  }) as unknown as BridgeConfig;

afterEach(() => resetHostForwardedClientIpCache());

describe("token mode is left exactly as it was", () => {
  it("resolves NO identity, so the handshake carries no headers at all", () => {
    // The regression this guards: a bridge that always sent a user header would
    // present one to a token-mode gateway, which is not configured to read it.
    expect(identityFor({ authMode: "token", forwardedClientIp: "10.0.0.1", user: "alice" })).toBeUndefined();
    expect(identityFor({ authMode: undefined, forwardedClientIp: "10.0.0.1", user: "alice" })).toBeUndefined();
    expect(buildIdentityHeaders(undefined)).toEqual({});
  });

  it("never consults the forwarded address, so a loopback host cannot break token mode", () => {
    // An unconditional assert on the address would fail a token-mode bridge whose
    // only interface is loopback — a bench, a laptop, a single-host compose file.
    expect(() =>
      identityFor({ authMode: "token", forwardedClientIp: "127.0.0.1", user: "alice" }),
    ).not.toThrow();
  });
});

describe("trusted-proxy mode states who the socket acts for", () => {
  it("sends the identity, the forwarded client, and the scope ceiling", () => {
    const headers = buildIdentityHeaders(
      identityFor({
        authMode: "trusted-proxy",
        forwardedClientIp: "10.1.2.3",
        user: "u-alice",
        scopeCap: ["operator.read", "operator.write"],
      }),
    );
    expect(headers[DEFAULT_TRUSTED_PROXY_USER_HEADER]).toBe("u-alice");
    expect(headers["x-forwarded-for"]).toBe("10.1.2.3");
    expect(headers[SCOPE_CAP_HEADER]).toBe("operator.read,operator.write");
  });

  it("honours a gateway configured to read a different header name", () => {
    const headers = buildIdentityHeaders(
      { user: "u-alice", forwardedFor: "10.1.2.3" },
      "x-atrium-user",
    );
    expect(headers["x-atrium-user"]).toBe("u-alice");
    expect(headers[DEFAULT_TRUSTED_PROXY_USER_HEADER]).toBeUndefined();
  });

  it("omits the ceiling header entirely when no ceiling is asked for", () => {
    // Not the same as an empty one: the gateway reads an empty value as "no scopes".
    const headers = buildIdentityHeaders({ user: "u-alice", forwardedFor: "10.1.2.3" });
    expect(SCOPE_CAP_HEADER in headers).toBe(false);
  });
});

describe("a value that cannot be presented faithfully is refused, never sent", () => {
  it("refuses a newline in the identity — the header-injection case", () => {
    // The identity header is precisely what the gateway trusts to name a person, so
    // a value that can open a second header line is the one value never to forward.
    expect(() =>
      buildIdentityHeaders({ user: "alice\r\nx-openclaw-scopes: operator.admin", forwardedFor: "10.1.2.3" }),
    ).toThrow(GatewayIdentityError);
  });

  it("refuses a comma in the identity, which would read as two header values", () => {
    expect(() => buildIdentityHeaders({ user: "alice,bob", forwardedFor: "10.1.2.3" })).toThrow(
      GatewayIdentityError,
    );
  });

  it("refuses an empty identity", () => {
    expect(() => buildIdentityHeaders({ user: "", forwardedFor: "10.1.2.3" })).toThrow(
      GatewayIdentityError,
    );
  });

  it("refuses a loopback forwarded client, naming the setting to fix", () => {
    // Proven on the bench: with a loopback client the gateway rejects the upgrade
    // with a bare 403 and no reason header. Failing here names the cause instead.
    for (const ip of ["127.0.0.1", "127.13.9.2", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(() => buildIdentityHeaders({ user: "u-alice", forwardedFor: ip }), ip).toThrow(
        /loopback or unspecified/,
      );
    }
    expect(() => buildIdentityHeaders({ user: "u-alice", forwardedFor: "" })).toThrow(
      /BRIDGE_FORWARDED_CLIENT_IP/,
    );
  });

  it("accepts a routable address, loopback-looking prefixes included", () => {
    // 127.x is loopback; 12.7.x and 172.16.x are not. A prefix test that merely
    // searched for "127" would refuse perfectly routable addresses.
    for (const ip of ["10.1.2.3", "172.16.0.9", "192.168.1.5", "12.7.0.1", "2001:db8::1"]) {
      expect(buildIdentityHeaders({ user: "u", forwardedFor: ip })["x-forwarded-for"], ip).toBe(ip);
    }
  });

  it("refuses an EMPTY ceiling instead of authenticating a powerless socket", () => {
    expect(() =>
      buildIdentityHeaders({ user: "u-alice", forwardedFor: "10.1.2.3", scopeCap: [] }),
    ).toThrow(/no scopes/);
  });

  it("refuses a scope carrying a separator", () => {
    expect(() =>
      buildIdentityHeaders({
        user: "u-alice",
        forwardedFor: "10.1.2.3",
        scopeCap: ["operator.read,operator.admin"],
      }),
    ).toThrow(GatewayIdentityError);
  });

  it("refuses a trusted-proxy instance with no usable address rather than falling back to token mode", () => {
    // Falling back would silently re-attribute every session to the shared owner —
    // the exact defect the mode exists to remove — and nothing would say so.
    expect(() =>
      identityFor({ authMode: "trusted-proxy", forwardedClientIp: null, user: "u-alice" }),
    ).toThrow(GatewayIdentityError);
  });
});

describe("a person's socket is not an admin socket", () => {
  it("the human ceiling excludes operator.admin", () => {
    // Load-bearing: on the gateway, operator.admin bypasses the session-visibility
    // boundary outright (proven on the bench — an admin client listed, read and
    // renamed another profile's session under a role with sessions.others="none").
    // A ceiling that kept it would make the identity decorative.
    expect(HUMAN_SCOPE_CAP).not.toContain("operator.admin");
    expect(HUMAN_SCOPE_CAP).toContain("operator.read");
    expect(HUMAN_SCOPE_CAP).toContain("operator.write");
  });

  it("the conversation socket is capped and the system socket is not", () => {
    const human = humanConnectIdentity(cfg({ openclawAuthMode: "trusted-proxy" }), "u-alice");
    const system = systemConnectIdentity(cfg({ openclawAuthMode: "trusted-proxy" }));
    expect(human?.user).toBe("u-alice");
    expect(human?.scopeCap).toEqual([...HUMAN_SCOPE_CAP]);
    // Recovery and discovery must be able to read a session created by someone
    // else, so the system socket deliberately keeps the device's full grant.
    expect(system?.scopeCap).toBeUndefined();
    expect(system?.user).toBe("atrium-bridge:alpha");
  });

  it("both resolve to undefined in token mode", () => {
    expect(humanConnectIdentity(cfg(), "u-alice")).toBeUndefined();
    expect(systemConnectIdentity(cfg())).toBeUndefined();
  });

  it("an explicit system identity overrides the derived one", () => {
    const system = systemConnectIdentity(
      cfg({ openclawAuthMode: "trusted-proxy", openclawSystemIdentity: "atrium-prod" }),
    );
    expect(system?.user).toBe("atrium-prod");
  });

  it("passes the configured user header through, and undefined when unset", () => {
    expect(connectUserHeader(cfg({ openclawTrustedProxyUserHeader: "x-atrium-user" }))).toBe(
      "x-atrium-user",
    );
    expect(connectUserHeader(cfg())).toBeUndefined();
  });
});

describe("the system identity names the bridge, per instance", () => {
  it("slugs the instance name and stays distinguishable between bridges", () => {
    expect(systemIdentityFor("alpha")).toBe("atrium-bridge:alpha");
    expect(systemIdentityFor("Prod Gateway 1")).toBe("atrium-bridge:prod-gateway-1");
    expect(systemIdentityFor("alpha")).not.toBe(systemIdentityFor("beta"));
  });

  it("never yields an empty identity, which the gateway would refuse", () => {
    for (const name of [null, "", "***", "---"]) {
      expect(systemIdentityFor(name)).toBe("atrium-bridge:default");
    }
  });

  it("produces an identity the header builder accepts", () => {
    // The two halves are written apart; a slug the validator rejects would only
    // surface on a live connect.
    expect(() =>
      buildIdentityHeaders({ user: systemIdentityFor("Prod Gateway 1"), forwardedFor: "10.1.2.3" }),
    ).not.toThrow();
  });
});

describe("discovering this host's address", () => {
  const iface = (address: string, internal: boolean, family: string | number = "IPv4") => ({
    address,
    family,
    internal,
  });

  it("skips internal and loopback entries and takes the first routable IPv4", () => {
    expect(
      detectForwardedClientIp({
        lo0: [iface("127.0.0.1", true)],
        en0: [iface("10.4.5.6", false)],
      }),
    ).toBe("10.4.5.6");
  });

  it("refuses a loopback address even when the OS did not mark it internal", () => {
    // Belt and braces: `internal` is the OS's opinion; the address is the fact the
    // gateway acts on.
    expect(detectForwardedClientIp({ lo0: [iface("127.0.0.1", false)] })).toBeNull();
  });

  it("ignores IPv6 entries rather than presenting one the gateway may not parse", () => {
    expect(detectForwardedClientIp({ en0: [iface("fe80::1", false, "IPv6")] })).toBeNull();
  });

  it("returns null on a host with nothing routable, which identityFor turns into a refusal", () => {
    expect(detectForwardedClientIp({})).toBeNull();
    expect(() =>
      identityFor({
        authMode: "trusted-proxy",
        forwardedClientIp: detectForwardedClientIp({}),
        user: "u-alice",
      }),
    ).toThrow(GatewayIdentityError);
  });

  it("reads the interfaces ONCE — the value cannot move while the process runs", () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      return { en0: [iface("10.9.9.9", false)] };
    };
    expect(hostForwardedClientIp(read)).toBe("10.9.9.9");
    expect(hostForwardedClientIp(read)).toBe("10.9.9.9");
    expect(reads).toBe(1);
  });
});

describe("outbound media proves who it is, in whichever mode", () => {
  it("token mode sends the Bearer and no identity", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      return { ok: false, status: 500 } as unknown as Response;
    }) as unknown as typeof fetch;
    const f = new GatewayHttpMediaFetcher({
      httpBase: "http://gw",
      token: () => "tok",
      identityHeaders: () => ({}),
      maxBytes: 1024,
      fetchImpl,
    });
    await f.open("f.png");
    expect(seen[0]?.Authorization).toBe("Bearer tok");
    expect(seen[0]?.[DEFAULT_TRUSTED_PROXY_USER_HEADER]).toBeUndefined();
  });

  it("trusted-proxy sends the identity and NO Bearer", async () => {
    // A gateway in this mode holds no token, so an `Authorization: Bearer ` would
    // authenticate nothing while looking like it might. The regression this
    // catches: outbound media silently failing with fetch_error on a healthy
    // gateway — the exact shape of the device-token-promotion defect this file
    // already carries a thunk to avoid.
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      return { ok: false, status: 500 } as unknown as Response;
    }) as unknown as typeof fetch;
    const f = new GatewayHttpMediaFetcher({
      httpBase: "http://gw",
      token: () => "",
      identityHeaders: () =>
        buildIdentityHeaders({ user: "atrium-bridge:alpha", forwardedFor: "10.1.2.3" }),
      maxBytes: 1024,
      fetchImpl,
    });
    await f.open("f.png");
    expect(seen[0]?.[DEFAULT_TRUSTED_PROXY_USER_HEADER]).toBe("atrium-bridge:alpha");
    expect(seen[0]?.["x-forwarded-for"]).toBe("10.1.2.3");
    expect("Authorization" in (seen[0] ?? {})).toBe(false);
  });

  it("the provider wires the SYSTEM identity, not a person's", async () => {
    // Media is fetched off the consume loop for whatever session produced it, so a
    // per-person identity here would be capped below what reading it requires.
    const headers = buildIdentityHeaders(
      systemConnectIdentity(cfg({ openclawAuthMode: "trusted-proxy" })),
      connectUserHeader(cfg({ openclawAuthMode: "trusted-proxy" })),
    );
    expect(headers[DEFAULT_TRUSTED_PROXY_USER_HEADER]).toBe("atrium-bridge:alpha");
    expect(SCOPE_CAP_HEADER in headers).toBe(false);
  });
});

describe("an administrative socket costs a handshake, so it is opened once", () => {
  it("several admin-scoped knobs share ONE administrative connection", async () => {
    // The knob re-apply runs on EVERY send. Patching one field at a time made a
    // chat with a reasoning level AND a speed setting pay two complete WebSocket +
    // Ed25519 handshakes per turn, serialized inside the pre-send deadline.
    const gw = startWsFakeGateway({ version: "2026.9.2", onMethod: () => ({ ok: true }) });
    await gw.ready;
    try {
      const device = deviceIdentity();
      const config = cfg({
        openclawAuthMode: "trusted-proxy",
        openclawGatewayUrl: gw.url,
        openclawToken: "",
        deviceIdentity: device,
      });
      const conn = await OpenClawConnection.connect(gw.url, "", device);
      const before = gw.upgradeCount;
      await applySessionSettings(
        conn,
        "agent:a:atrium:chat:u-x:c1",
        // Three admin-scoped fields (a clear, a reasoning level, a speed) plus one
        // write-scoped (the model, which stays on the person's own socket).
        {
          clears: ["thinkingLevel"],
          thinkingLevel: "high",
          model: "openai/gpt-5.5",
          fastMode: false,
        },
        config,
      );
      expect(gw.upgradeCount - before, "one administrative socket, not one per field").toBe(1);
      conn.close();
    } finally {
      await gw.stop();
    }
  });

  it("a batch with no admin-scoped patch opens NO extra socket", async () => {
    // Token mode, and the trusted-proxy model-only case, must both stay free.
    const gw = startWsFakeGateway({ version: "2026.9.2", onMethod: () => ({ ok: true }) });
    await gw.ready;
    try {
      const device = deviceIdentity();
      const config = cfg({
        openclawAuthMode: "trusted-proxy",
        openclawGatewayUrl: gw.url,
        openclawToken: "",
        deviceIdentity: device,
      });
      const conn = await OpenClawConnection.connect(gw.url, "", device);
      const before = gw.upgradeCount;
      await applySessionSettings(
        conn,
        "agent:a:atrium:chat:u-x:c1",
        { model: "openai/gpt-5.5" },
        config,
      );
      expect(gw.upgradeCount - before).toBe(0);
      conn.close();
    } finally {
      await gw.stop();
    }
  });
});
