// Codex P2.A: `firstSendPending` must be consumed only AFTER the gateway ACCEPTS the
// first send of a freshly-routed session — NOT at the rehydration decision point. If
// the first chat.send FAILS (oversized attachment / reject / timeout), the SAME
// in-memory Session persists; a RETRY must still see firstSendPending=true and
// re-hydrate. Otherwise the freshly-routed agent gets empty context on the retry (the
// exact multi-agent bug, surviving into the retry).
//
// This drives the real `/send` HTTP handler (createBridgeServer) with a mocked gateway
// connection whose chat.send ALWAYS throws, so the same Session is reused across two
// POSTs. The discriminating assertion: the SECOND chat.send still carries the prepended
// history. With the bug (consume-before-send), the retry would ship the bare message.

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createBridgeServer } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { HealthRegistry } from "../src/core/health.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

const HISTORY = "[PRIOR-CONVERSATION-HISTORY]";

const CONFIG = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  mediaOutboundDir: "/tmp/mo",
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  mediaMaxBytes: 1024,
  mediaMode: "gateway-http",
  gatewayHttpBase: "http://gw.invalid:18790",
  mediaFetchTimeoutMs: 60_000,
  inboundMediaDir: "/tmp/mi",
  inboundAgentMount: "/tmp/mi",
  inboundTtlMs: 1000,
  convexHttpActionsUrl: "http://convex.example.org",
  convexIngestSecret: "ingest-secret",
  deltaFlushMs: 150,
  bridgeSharedSecret: "shared-secret",
  port: 0,
  maxBodyBytes: 1_000_000,
} as unknown as BridgeConfig;

/** A writer that yields prior history for re-hydration; everything else is a no-op. */
const writer = {
  getRehydrationContext: async () => ({ history: HISTORY, turnCount: 2 }),
  reportSessionMeta: async () => {},
  emitRehydrateTrace: () => {},
  startAssistant: async () => "m",
  appendDelta: async () => {},
  setSnapshot: async () => {},
  addToolPart: async () => {},
  addReasoningPart: async () => {},
  addMediaPart: async () => {},
  noteMediaUndelivered: async () => {},
  finalize: async () => {},
  upsertSubAgent: async () => {},
} as unknown as ConvexWriter;

/** Fake gateway connection: describe → a WARM session (systemSent:true, so ONLY
 *  firstSendPending&&routedSwitch can make it fresh); chat.send ALWAYS throws and
 *  RECORDS the message it was asked to send. */
function fakeConn(sent: string[]) {
  let closed = false;
  return {
    verboseFullApplied: false,
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
    },
    async *frames() {
      await new Promise<void>(() => {}); // never yields; the test never awaits it
    },
    async request(method: string, params: Record<string, unknown>) {
      if (method === "sessions.describe")
        return { payload: { session: { systemSent: true } } };
      if (method === "models.list") return { payload: { models: [] } };
      if (method === "sessions.patch") return { payload: {} };
      if (method === "chat.send") {
        sent.push(String(params.message ?? ""));
        throw new Error("gateway refused (test)");
      }
      return { payload: {} };
    },
  };
}

const body = (clientMessageId: string) =>
  JSON.stringify({
    chatId: "chat-retry",
    instanceName: "primary",
    agentId: "bob",
    canonical: "alice",
    text: "oui",
    clientMessageId,
    messageId: "m-oui",
    outboxId: "ob-1",
    // Convex marks this an ACTUAL routed switch → the bridge force-rehydrates a fresh
    // session. systemSent is truthy, so freshness rides ENTIRELY on firstSendPending.
    config: { rehydration: true, routedSwitch: true },
  });

describe("P2.A — a failed first send preserves firstSendPending → the retry re-hydrates", () => {
  let server: Server;
  let baseUrl: string;
  const sent: string[] = [];

  beforeAll(async () => {
    vi.spyOn(OpenClawConnection, "connect").mockResolvedValue(
      fakeConn(sent) as unknown as OpenClawConnection,
    );
    const served = servedMap(CONFIG, writer);
    server = createBridgeServer({
      shared: sharedFromConfig(CONFIG),
      served,
      registry: new SessionRegistry(served),
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((res) => server.listen(0, res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });
  afterEach(() => vi.restoreAllMocks());

  it("re-hydrates on BOTH the failed first send AND the retry (same Session reused)", async () => {
    const post = (cmid: string) =>
      fetch(`${baseUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "shared-secret" },
        body: body(cmid),
      });

    const r1 = await post("c1"); // first send: chat.send throws → 502
    expect(r1.status).toBe(502);
    const r2 = await post("c2"); // RETRY on the SAME (reused) session
    expect(r2.status).toBe(502);

    // Two chat.send attempts were made…
    expect(sent).toHaveLength(2);
    // …and the RETRY (sent[1]) STILL prepended the history. If firstSendPending had
    // been consumed before the failed first send, the retry would be the bare "oui".
    expect(sent[0]).toContain(HISTORY);
    expect(sent[1]).toContain(HISTORY); // <- the P2.A guard
    expect(sent[1]!.startsWith(HISTORY)).toBe(true); // history is PREPENDED, not buried
  });
});
