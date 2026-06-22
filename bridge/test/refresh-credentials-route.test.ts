// POST /refresh-credentials — the on-demand uptake endpoint Convex pokes right after an
// admin sets/generates a credential, so the bridge resolves the instance + connects NOW
// (triggering pairing) instead of waiting for the self-heal poll. Authenticated like
// /send. These tests pin the contract (auth gate + it runs a refresh pass); the actual
// "pairing fires in seconds" is a timing behavior verified live against the bench.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import type { InstanceBundle } from "../src/session.js";
import { HealthRegistry } from "../src/core/health.js";
import { SessionRegistry } from "../src/session.js";
import { createBridgeServer } from "../src/server.js";
import { sharedFromConfig } from "./helpers/served.js";

const CONFIG: BridgeConfig = {
  openclawGatewayUrl: "ws://gateway.example.org:18789",
  openclawToken: "t",
  deviceIdentity: { id: "d", publicKey: "p", privateKey: "k" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  mediaOutboundDir: "/tmp/out",
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  mediaMaxBytes: 1024,
  mediaMode: "gateway-http",
  gatewayHttpBase: "http://gw.invalid:18790",
  mediaFetchTimeoutMs: 60_000,
  inboundMediaDir: "/tmp/in",
  inboundAgentMount: "/tmp/in",
  inboundTtlMs: 1000,
  convexHttpActionsUrl: "http://convex.invalid",
  convexIngestSecret: "i",
  bridgeSharedSecret: "shared-secret",
  port: 0,
  maxBodyBytes: 4096,
};

describe("POST /refresh-credentials", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function start(triggerRefresh?: () => Promise<void>): Promise<string> {
    const served = new Map<string, InstanceBundle>(); // nothing served yet
    const registry = new SessionRegistry(served);
    server = createBridgeServer({
      shared: sharedFromConfig(CONFIG),
      served,
      registry,
      health: new HealthRegistry(1000, () => 2000),
      triggerRefresh,
    });
    await new Promise<void>((r) => server!.listen(0, r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it("rejects a wrong/absent shared secret with 401 and does NOT run a refresh", async () => {
    const trigger = vi.fn(async () => {});
    const base = await start(trigger);
    const res = await fetch(`${base}/refresh-credentials`, {
      method: "POST",
      headers: { Authorization: "nope" },
    });
    expect(res.status).toBe(401);
    expect(trigger).not.toHaveBeenCalled(); // auth gate runs BEFORE any resolve work
  });

  it("with the shared secret, runs an immediate refresh pass and reports served=false for an unknown instance", async () => {
    const trigger = vi.fn(async () => {});
    const base = await start(trigger);
    const res = await fetch(`${base}/refresh-credentials?instance=olivier`, {
      method: "POST",
      headers: { Authorization: CONFIG.bridgeSharedSecret },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, served: false }); // empty served map
    expect(trigger).toHaveBeenCalledTimes(1); // the poke triggered a resolution pass
  });
});
