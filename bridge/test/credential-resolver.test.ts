// Multi-instance bootstrap resolver: each per-bridge secret resolves (via Convex) to
// ONE instance's gateway config + decrypted creds; resolveAll() builds the served map.
// Gateway config is Convex-only (no env fallback). A secret that fails to resolve is
// SKIPPED (logged reason), never blocking the healthy instances (D4). Isolation is at
// the secret level — each secret unlocks exactly its own instance.

import { describe, it, expect, vi } from "vitest";
import {
  CredentialResolver,
  type CredentialResolverDeps,
} from "../src/core/credential-resolver.js";
import type { DeviceIdentity, SharedConfig } from "../src/config.js";

const DEV: DeviceIdentity = { id: "d1", publicKey: "pk", privateKey: "pem" };
const DEV_JSON = JSON.stringify(DEV);

const SHARED: SharedConfig = {
  convexHttpActionsUrl: "https://x.convex.site",
  convexIngestSecret: "ingest",
  deltaFlushMs: 150,
  bridgeSharedSecret: "shared",
  port: 8787,
  maxBodyBytes: 1000,
  inboundTtlMs: 1000,
  mediaFetchTimeoutMs: 1000,
  mediaModeDefault: "gateway-http",
  mediaMaxBytesDefault: 1024,
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  inboundAgentMount: "/home/node/.openclaw/media/inbound",
  mediaOutboundDirOverride: null,
  inboundMediaDirOverride: null,
  bridgeInstanceSecrets: [],
  credentialRetryMs: 30_000,
};

/** One instance's /bridge/credentials response body. */
interface CredBody {
  instanceName?: string;
  gateway?: {
    url?: string;
    version?: string | null;
    httpUrl?: string | null;
    kind?: string;
  };
  credentials?: Record<string, string>;
}

/** A fake fetch that routes by the Bearer secret to a per-secret response. A secret
 *  mapped to a number returns that HTTP status; mapped to "throw" rejects. */
function routedFetch(
  bySecret: Record<string, CredBody | number | "throw">,
): typeof fetch {
  return (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization ?? "";
    const secret = auth.replace(/^Bearer /, "");
    const r = bySecret[secret];
    if (r === "throw") throw new Error("ECONNREFUSED");
    if (typeof r === "number") {
      return { ok: r < 400, status: r, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => r,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function deps(over: Partial<CredentialResolverDeps>): CredentialResolverDeps {
  return {
    convexHttpActionsUrl: SHARED.convexHttpActionsUrl,
    bridgeInstanceSecrets: [],
    shared: SHARED,
    ...over,
  };
}

describe("CredentialResolver.resolveAll (multi-instance)", () => {
  it("resolves N secrets into a served map keyed by the PROVEN instanceName", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["sec-olivier", "sec-jerome"],
        fetchImpl: routedFetch({
          "sec-olivier": {
            instanceName: "olivier",
            gateway: { url: "wss://olivier.gw/ws", version: "2026.6.5" },
            credentials: { token: "tok-o", deviceIdentity: DEV_JSON },
          },
          "sec-jerome": {
            instanceName: "jerome",
            gateway: { url: "wss://jerome.gw/ws" },
            credentials: { token: "tok-j", deviceIdentity: DEV_JSON },
          },
        }),
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect(failures).toEqual([]);
    expect([...served.keys()].sort()).toEqual(["jerome", "olivier"]);
    const o = served.get("olivier")!;
    expect(o.openclawGatewayUrl).toBe("wss://olivier.gw/ws");
    expect(o.openclawToken).toBe("tok-o");
    expect(o.deviceIdentity).toEqual(DEV);
    expect(o.instanceName).toBe("olivier");
    expect(o.gatewayVersionFallback).toBe("2026.6.5");
    // gatewayHttpBase derives from the WS url (ORIGIN, ws->wss->https scheme).
    expect(o.gatewayHttpBase).toBe("https://olivier.gw");
    // jerome's creds never leak into olivier's config.
    expect(o.openclawToken).not.toBe("tok-j");
  });

  it("a non-secret httpUrl override is used for gatewayHttpBase", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["s"],
        fetchImpl: routedFetch({
          s: {
            instanceName: "a",
            gateway: {
              url: "wss://a.gw/ws",
              httpUrl: "https://media.a.gw:9000",
            },
            credentials: { token: "t", deviceIdentity: DEV_JSON },
          },
        }),
      }),
    );
    const { served } = await r.resolveAll();
    expect(served.get("a")!.gatewayHttpBase).toBe("https://media.a.gw:9000");
  });

  it("SKIPS a secret that 401s but still serves the healthy one (partial failure, D4)", async () => {
    const onWarn = vi.fn();
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["good", "bad"],
        onWarn,
        fetchImpl: routedFetch({
          good: {
            instanceName: "good",
            gateway: { url: "wss://good/ws" },
            credentials: { token: "t", deviceIdentity: DEV_JSON },
          },
          bad: 401,
        }),
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect([...served.keys()]).toEqual(["good"]); // healthy one still served
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe("unauthorized");
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("unauthorized"));
  });

  it("SKIPS on a network error (reason unreachable) without throwing", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["x"],
        fetchImpl: routedFetch({ x: "throw" }),
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect(served.size).toBe(0);
    expect(failures[0]!.reason).toBe("unreachable");
  });

  it("SKIPS an instance with no gatewayUrl configured (no_gateway_url)", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["x"],
        fetchImpl: routedFetch({
          x: {
            instanceName: "x",
            gateway: {}, // url missing
            credentials: { token: "t", deviceIdentity: DEV_JSON },
          },
        }),
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect(served.size).toBe(0);
    expect(failures[0]!.reason).toBe("no_gateway_url");
  });

  it("treats an EMPTY token as ABSENT and skips (no_token) — never connects with '' ", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["x"],
        fetchImpl: routedFetch({
          x: {
            instanceName: "x",
            gateway: { url: "wss://x/ws" },
            credentials: { token: "   ", deviceIdentity: DEV_JSON },
          },
        }),
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect(served.size).toBe(0);
    expect(failures[0]!.reason).toBe("no_token");
  });

  it("SKIPS a malformed device identity (bad_device) — never connects with garbage", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["x"],
        fetchImpl: routedFetch({
          x: {
            instanceName: "x",
            gateway: { url: "wss://x/ws" },
            credentials: { token: "t", deviceIdentity: "{not json" },
          },
        }),
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect(served.size).toBe(0);
    expect(failures[0]!.reason).toBe("bad_device");
  });

  it("two secrets resolving to the SAME instance keep the first + warn", async () => {
    const onWarn = vi.fn();
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["s1", "s2"],
        onWarn,
        fetchImpl: routedFetch({
          s1: {
            instanceName: "dup",
            gateway: { url: "wss://first/ws" },
            credentials: { token: "first", deviceIdentity: DEV_JSON },
          },
          s2: {
            instanceName: "dup",
            gateway: { url: "wss://second/ws" },
            credentials: { token: "second", deviceIdentity: DEV_JSON },
          },
        }),
      }),
    );
    const { served } = await r.resolveAll();
    expect(served.size).toBe(1);
    expect(served.get("dup")!.openclawToken).toBe("first");
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("dup"));
  });

  it("resolves nothing when no secrets are configured (empty served, no fetch)", async () => {
    const fetchImpl = vi.fn();
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: [],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    const { served, failures } = await r.resolveAll();
    expect(served.size).toBe(0);
    expect(failures).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CredentialResolver.resolveOne + post-identity instanceName", () => {
  it("resolveOne returns ok+data for a valid secret", async () => {
    const r = new CredentialResolver(
      deps({
        fetchImpl: routedFetch({
          s: {
            instanceName: "olivier",
            gateway: { url: "wss://o/ws" },
            credentials: { token: "t", deviceIdentity: DEV_JSON },
          },
        }),
      }),
    );
    const res = await r.resolveOne("s");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.instanceName).toBe("olivier");
  });

  it("resolveOne carries the resolved instanceName on a POST-identity failure (bad_device)", async () => {
    // The whole point of the self-heal /health surface: the operator must see WHICH
    // instance is misconfigured. A pre-identity failure (401) cannot name it; a
    // post-identity one (token saved, device missing) MUST.
    const r = new CredentialResolver(
      deps({
        fetchImpl: routedFetch({
          s: {
            instanceName: "jerome",
            gateway: { url: "wss://j/ws" },
            credentials: { token: "t" }, // deviceIdentity missing -> bad_device
          },
        }),
      }),
    );
    const res = await r.resolveOne("s");
    expect(res).toEqual({
      ok: false,
      reason: "bad_device",
      instanceName: "jerome",
    });
  });

  it("resolveOne OMITS instanceName on a PRE-identity failure (401 unauthorized)", async () => {
    const r = new CredentialResolver(deps({ fetchImpl: routedFetch({ s: 401 }) }));
    const res = await r.resolveOne("s");
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
    if (!res.ok) expect(res.instanceName).toBeUndefined();
  });

  it("resolveAll failures carry instanceName for no_token (distinguishes the misconfigured instance)", async () => {
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecrets: ["s"],
        fetchImpl: routedFetch({
          s: {
            instanceName: "olivier",
            gateway: { url: "wss://o/ws" },
            credentials: { deviceIdentity: DEV_JSON }, // token missing
          },
        }),
      }),
    );
    const { failures } = await r.resolveAll();
    expect(failures).toEqual([{ reason: "no_token", instanceName: "olivier" }]);
  });
});
