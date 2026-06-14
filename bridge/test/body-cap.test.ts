/**
 * POST /send body-size cap (the inbound-attachment regression). A user file is
 * carried to the gateway as base64 inside the JSON body, which inflates the raw
 * size by ~4/3. The old 1 MiB cap 413'd every non-trivial import; worse, the
 * overflow path used to `req.destroy()` the socket BEFORE the response flushed,
 * so the caller (Convex) saw an ECONNRESET — surfaced as a misleading
 * BRIDGE_UNREACHABLE rather than an honest "too large".
 *
 * These tests run the REAL HTTP server and assert: (1) an oversized body returns
 * a CLEAN 413 with a structured `{error:{code}}` (no connection reset — `fetch`
 * resolves), and (2) a body UNDER the cap passes the read gate (it reaches
 * routing/dispatch, so it is NOT a 413). The gateway socket then fails fast
 * against the unreachable test URL — irrelevant here; the gate is what we pin.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { HealthRegistry } from "../src/core/health.js";
import { SessionRegistry } from "../src/session.js";
import { createBridgeServer } from "../src/server.js";

const CAP = 4096;

const CONFIG: BridgeConfig = {
  openclawGatewayUrl: "ws://127.0.0.1:1/never", // unreachable on purpose
  openclawToken: "test-token",
  deviceIdentity: { id: "device-test", publicKey: "pk", privateKey: "sk" },
  instanceName: "primary",
  mediaOutboundDir: "/tmp/media-outbound",
  mediaMaxBytes: 1024,
  convexHttpActionsUrl: "http://convex.example.org",
  convexIngestSecret: "ingest-secret",
  bridgeSharedSecret: "shared-secret",
  port: 0,
  maxBodyBytes: CAP,
};

function sendBody(attachmentBytes: number): string {
  return JSON.stringify({
    chatId: "chat-cap-test",
    agentId: "main",
    canonical: "alice",
    instanceName: "primary",
    text: "cap test",
    clientMessageId: "cap-1",
    attachments: [
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "f.txt",
        content: "A".repeat(attachmentBytes),
      },
    ],
  });
}

describe("POST /send body cap", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = new SessionRegistry(CONFIG, {} as ConvexWriter);
    const health = new HealthRegistry(1000, () => 2000);
    server = createBridgeServer({ config: CONFIG, registry, health });
    await new Promise<void>((res) => server.listen(0, res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  test("an oversized body -> clean 413 {error:{code}}, NOT a connection reset", async () => {
    const body = sendBody(CAP * 2); // guaranteed past the cap
    expect(body.length).toBeGreaterThan(CAP);
    // `fetch` RESOLVING (not throwing ECONNRESET) is the core assertion.
    const res = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "shared-secret" },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: { code: "payload_too_large" } });
  });

  test("a body under the cap passes the read gate (reaches dispatch, so NOT 413)", async () => {
    const res = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "shared-secret" },
      body: sendBody(64),
    });
    // It will fail downstream on the unreachable gateway (502), but the point is
    // the body was ACCEPTED past readBody — never a 413.
    expect(res.status).not.toBe(413);
  });

  test("the wrong shared secret is rejected before the body is read (401)", async () => {
    const res = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "wrong" },
      body: sendBody(64),
    });
    expect(res.status).toBe(401);
  });
});
