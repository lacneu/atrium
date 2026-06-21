// Step 3b credential resolver: Convex-first per field, env FALLBACK, cache +
// invalidate, and a HARD failure only when a required field is missing from BOTH
// sources. A Convex failure (unreachable / 401 / bad value) is non-fatal — it logs
// a reason and falls back to env. Validates the fetched device identity via the same
// guard as env (no garbage connects).

import { describe, it, expect, vi } from "vitest";
import {
  CredentialResolver,
  type CredentialResolverDeps,
} from "../src/core/credential-resolver.js";
import type { DeviceIdentity } from "../src/config.js";

const DEV: DeviceIdentity = { id: "d1", publicKey: "pk", privateKey: "pem" };
const DEV_JSON = JSON.stringify(DEV);
const ENV_DEV: DeviceIdentity = { id: "env", publicKey: "epk", privateKey: "epem" };

/** A fake fetch returning the given credentials JSON (status 200). */
function okFetch(credentials: Record<string, string>): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ credentials }),
    }) as unknown as Response) as unknown as typeof fetch;
}
/** Like okFetch, but also returns the PROVEN instanceName (isolation guard). */
function okFetchInstance(
  instanceName: string,
  credentials: Record<string, string>,
): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ instanceName, credentials }),
    }) as unknown as Response) as unknown as typeof fetch;
}
function statusFetch(status: number): typeof fetch {
  return (async () =>
    ({ ok: false, status, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
}
const throwFetch: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

function deps(over: Partial<CredentialResolverDeps>): CredentialResolverDeps {
  return {
    convexHttpActionsUrl: "https://x.convex.site",
    bridgeInstanceSecret: "br-secret",
    expectedInstanceName: "primary",
    envToken: null,
    envDeviceIdentity: null,
    ...over,
  };
}

describe("CredentialResolver", () => {
  it("uses Convex values when present (Convex wins over env)", async () => {
    const r = new CredentialResolver(
      deps({
        fetchImpl: okFetch({ token: "convex-tok", deviceIdentity: DEV_JSON }),
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
      }),
    );
    const c = await r.resolve();
    expect(c.token).toBe("convex-tok");
    expect(c.deviceIdentity).toEqual(DEV);
  });

  it("treats an EMPTY Convex token as ABSENT → falls back to env (not an empty token)", async () => {
    // A corrupted / manually-emptied secret row returns "" — `??` would keep it and
    // the missing-field throw (=== undefined) wouldn't fire, caching an unusable token.
    const r = new CredentialResolver(
      deps({
        fetchImpl: okFetch({ token: "", deviceIdentity: DEV_JSON }),
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
      }),
    );
    const c = await r.resolve();
    expect(c.token).toBe("env-tok"); // empty Convex token ignored, env used
    expect(c.deviceIdentity).toEqual(DEV); // Convex device (non-empty) still wins
  });

  it("merges PER FIELD: Convex token + env device identity", async () => {
    const r = new CredentialResolver(
      deps({
        fetchImpl: okFetch({ token: "convex-tok" }), // no device from Convex
        envDeviceIdentity: ENV_DEV,
      }),
    );
    const c = await r.resolve();
    expect(c.token).toBe("convex-tok");
    expect(c.deviceIdentity).toEqual(ENV_DEV); // fell back to env for the device
  });

  it("falls back to env when Convex is UNREACHABLE (non-fatal + warns)", async () => {
    const onWarn = vi.fn();
    const r = new CredentialResolver(
      deps({
        fetchImpl: throwFetch,
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
        onWarn,
      }),
    );
    const c = await r.resolve();
    expect(c.token).toBe("env-tok");
    expect(c.deviceIdentity).toEqual(ENV_DEV);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
  });

  it("falls back to env on a 401 (wrong secret) and warns 'unauthorized'", async () => {
    const onWarn = vi.fn();
    const r = new CredentialResolver(
      deps({
        fetchImpl: statusFetch(401),
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
        onWarn,
      }),
    );
    await r.resolve();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("unauthorized"));
  });

  it("env-only when no per-bridge secret is configured (never calls fetch)", async () => {
    const fetchImpl = vi.fn();
    const r = new CredentialResolver(
      deps({
        bridgeInstanceSecret: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
      }),
    );
    const c = await r.resolve();
    expect(c.token).toBe("env-tok");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("THROWS clearly when a required field is missing from BOTH sources", async () => {
    const r = new CredentialResolver(
      deps({
        fetchImpl: okFetch({ token: "convex-tok" }), // device missing from both
        envDeviceIdentity: null,
      }),
    );
    await expect(r.resolve()).rejects.toThrow(/device identity/);
  });

  it("a malformed Convex device identity falls back to env PER FIELD — the valid Convex token still wins", async () => {
    // The exact partial-migration case: token in Convex, device still in env. A
    // malformed Convex deviceIdentity must NOT discard the already-fetched Convex
    // token (the per-field fallback). envToken is unset, so if the token were lost
    // resolve() would throw "missing operator token".
    const onWarn = vi.fn();
    const r = new CredentialResolver(
      deps({
        fetchImpl: okFetch({ token: "convex-tok", deviceIdentity: "{not json" }),
        envDeviceIdentity: ENV_DEV,
        onWarn,
      }),
    );
    const c = await r.resolve();
    expect(c.token).toBe("convex-tok"); // Convex token SURVIVES the device parse throw
    expect(c.deviceIdentity).toEqual(ENV_DEV); // garbage rejected, env used
  });

  it("refuses creds whose secret maps to ANOTHER instance (isolation) → env fallback + warn", async () => {
    const onWarn = vi.fn();
    const r = new CredentialResolver(
      deps({
        expectedInstanceName: "primary",
        // The secret authenticated, but to "beta" — its creds must NEVER be used here.
        fetchImpl: okFetchInstance("beta", {
          token: "beta-tok",
          deviceIdentity: DEV_JSON,
        }),
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
        onWarn,
      }),
    );
    const c = await r.resolve();
    // Regression guard: drop the instance check and c.token becomes "beta-tok".
    expect(c.token).toBe("env-tok");
    expect(c.deviceIdentity).toEqual(ENV_DEV);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("instance_mismatch"),
    );
  });

  it("accepts Convex creds when the returned instance MATCHES the served one", async () => {
    const r = new CredentialResolver(
      deps({
        expectedInstanceName: "primary",
        fetchImpl: okFetchInstance("primary", {
          token: "convex-tok",
          deviceIdentity: DEV_JSON,
        }),
        envToken: "env-tok",
        envDeviceIdentity: ENV_DEV,
      }),
    );
    expect((await r.resolve()).token).toBe("convex-tok"); // matched → Convex wins
  });

  it("caches after first resolve; invalidate() forces a re-fetch", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ credentials: { token: "t1", deviceIdentity: DEV_JSON } }) }) as unknown as Response,
      )
      .mockImplementationOnce(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ credentials: { token: "t2", deviceIdentity: DEV_JSON } }) }) as unknown as Response,
      );
    const r = new CredentialResolver(
      deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect((await r.resolve()).token).toBe("t1");
    expect((await r.resolve()).token).toBe("t1"); // cached — no 2nd fetch
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    r.invalidate();
    expect((await r.resolve()).token).toBe("t2"); // re-fetched
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
