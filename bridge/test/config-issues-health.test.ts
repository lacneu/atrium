// The boot invariant in action: the bridge serves /health even with ZERO instances
// resolved (it must never crash on a misconfigured/unconfigured instance), and /health
// carries the additive, non-secret `configIssues` so an operator (or the admin UI) sees
// WHY an instance is not served without reading docker logs.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import type { InstanceBundle } from "../src/session.js";
import type { ConfigIssue } from "../src/core/credential-resolver.js";
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
  bridgeSharedSecret: "s",
  port: 0,
  maxBodyBytes: 4096,
};

async function startServer(getConfigIssues?: () => ConfigIssue[]): Promise<{
  server: Server;
  baseUrl: string;
}> {
  // EMPTY served map — the bridge booted with nothing resolved. It must still listen.
  const served = new Map<string, InstanceBundle>();
  const registry = new SessionRegistry(served);
  const server = createBridgeServer({
    shared: sharedFromConfig(CONFIG),
    served,
    registry,
    health: new HealthRegistry(1000, () => 2000),
    getConfigIssues,
  });
  await new Promise<void>((res) => server.listen(0, res));
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe("GET /health with zero instances + configIssues surface", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = null;
  });

  it("LISTENS and answers 200 with no served instances (boot is never fatal)", async () => {
    const started = await startServer();
    server = started.server;
    const res = await fetch(`${started.baseUrl}/health`);
    expect(res.status).toBe(200); // the bridge serves health even with 0 instances
    const body = (await res.json()) as { targets: unknown[]; configIssues: unknown[] };
    expect(body.targets).toEqual([]); // nothing resolved -> no targets
    expect(body.configIssues).toEqual([]); // no getter -> empty, not undefined
  });

  it("surfaces the per-instance config issues (so the operator sees WHY, no docker logs)", async () => {
    const issues: ConfigIssue[] = [
      { instanceName: "olivier", reason: "bad_device" },
      { reason: "no_secrets" },
    ];
    const started = await startServer(() => issues);
    server = started.server;
    const body = (await (await fetch(`${started.baseUrl}/health`)).json()) as {
      configIssues: ConfigIssue[];
    };
    expect(body.configIssues).toEqual(issues);
  });

  it("a /send to an unserved instance is rejected (409), never misrouted", async () => {
    const started = await startServer(() => [
      { instanceName: "olivier", reason: "bad_device" },
    ]);
    server = started.server;
    const res = await fetch(`${started.baseUrl}/send`, {
      method: "POST",
      headers: { Authorization: CONFIG.bridgeSharedSecret },
      body: JSON.stringify({
        instanceName: "olivier",
        chatId: "c1",
        agentId: "main",
        canonical: "alice",
        text: "hi",
        clientMessageId: "m1",
      }),
    });
    // olivier is not served (only a config ISSUE), so membership rejects with 409.
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("instance_not_served");
  });
});
