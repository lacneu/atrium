// POST /abort route (the stop button's gateway-kill half): error paths pinned
// at the REAL http server level — auth (raw Authorization, no Bearer), body
// validation, and the instance-not-served guard. The success path needs a live
// gateway and is covered by the bench (chat.abort observed live 2026-07-03/04).

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

describe("POST /abort (error paths)", () => {
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
    fetch(`${baseUrl}/abort`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth !== undefined ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });

  test("401 without the shared secret (raw Authorization)", async () => {
    const res = await post({ chatId: "c1" });
    expect(res.status).toBe(401);
  });

  test("400 on an invalid body (missing routing fields)", async () => {
    const res = await post({ nope: true }, shared.bridgeSharedSecret);
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
      },
      shared.bridgeSharedSecret,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("instance_not_served");
  });
});
