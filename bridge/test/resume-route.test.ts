// POST /resume (transcript projection `on`, phase 3, CU-22): before the boot sweep
// closes a bubble left streaming by a previous bridge life, Convex asks the bridge
// whether the gateway still runs it. Pinned at the REAL http server: the route is
// ROUTED (a route missing from the POST allowlist answered 404 and the sweep closed the
// bubble anyway — found live on bs-denis), authenticated, and validates its body.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { HealthRegistry } from "../src/core/health.js";
import { SessionRegistry } from "../src/session.js";
import { createBridgeServer } from "../src/server.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

const CONFIG: BridgeConfig = {
  openclawGatewayUrl: "ws://gateway.example.org:18789",
  openclawToken: "test-token",
  deviceIdentity: { id: "device-test", publicKey: "pk", privateKey: "sk" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  bridgeSharedSecret: "test-shared-secret",
  mediaOutboundDir: "/tmp/media-outbound",
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
} as unknown as BridgeConfig;

describe("POST /resume (routing and error paths)", () => {
  let server: Server;
  let baseUrl = "";
  const shared = sharedFromConfig(CONFIG);

  beforeAll(async () => {
    server = createBridgeServer({
      shared,
      served: servedMap(CONFIG),
      registry: new SessionRegistry(servedMap(CONFIG)),
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((res) => server.listen(0, res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const post = (body: unknown, auth?: string) =>
    fetch(`${baseUrl}/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth !== undefined ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });

  test("401 without the shared secret", async () => {
    expect((await post({ chatId: "c1" })).status).toBe(401);
  });

  test("400 when the bubble to resume is missing (the route exists: never 404)", async () => {
    const res = await post(
      { chatId: "c1", openclawChatId: null, instanceName: "primary", agentId: "main", canonical: "u" },
      shared.bridgeSharedSecret,
    );
    expect(res.status).toBe(400);
  });

  test("409 when the instance is not served by this bridge", async () => {
    const res = await post(
      {
        chatId: "c1",
        openclawChatId: null,
        instanceName: "ghost-instance",
        agentId: "main",
        canonical: "u",
        liveBubble: { messageId: "m1", runId: "run-1" },
      },
      shared.bridgeSharedSecret,
    );
    expect(res.status).toBe(409);
  });
});
