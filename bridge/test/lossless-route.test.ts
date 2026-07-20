// POST /lossless — the sanctioned lossless-claw doctor dispatch (watcher-agent
// self-repair channel). Pins the SECURITY surface: shared-secret auth, the
// STRICT action allowlist (arbitrary command dispatch must be impossible),
// unserved-instance and hermes rejections. The happy path (chat.send + reply
// collection) is proven live against a real gateway (2026-07-20).

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

describe("POST /lossless (security surface)", () => {
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
    fetch(`${baseUrl}/lossless`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth !== undefined ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });

  test("401 without the shared secret", async () => {
    const res = await post({ instanceName: "primary", action: "status" });
    expect(res.status).toBe(401);
  });

  test("409 for an instance this bridge does not serve", async () => {
    const res = await post(
      { instanceName: "ghost", action: "status" },
      shared.bridgeSharedSecret,
    );
    expect(res.status).toBe(409);
  });

  test("400 on a valid-JSON non-object body (null) — never a 500", async () => {
    const res = await fetch(`${baseUrl}/lossless`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: shared.bridgeSharedSecret,
      },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  test("400 on any action OUTSIDE the allowlist (no arbitrary command dispatch)", async () => {
    for (const action of [
      "/lossless status",              // raw command injection attempt
      "doctor apply rollover-splits",  // free-form
      "help",
      "",
      undefined,
      // Inherited object-property names must NOT resolve through the
      // allowlist map's prototype chain (codex).
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
    ]) {
      const res = await post(
        { instanceName: "primary", action },
        shared.bridgeSharedSecret,
      );
      expect(res.status, String(action)).toBe(400);
    }
  });
});
