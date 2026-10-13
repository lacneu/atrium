// What the /send route answers Convex when the GATEWAY refused the turn.
//
// Prod 2026-10-13: every send with a file failed on one instance with `UNAVAILABLE`
// `MediaOffloadError: [Gateway Error] Failed to save intercepted media to disk: native
// fs-safe helper is unavailable`. The bridge reported `UPSTREAM_ERROR` (bridge-domain:
// the admin's Bridge tab went red), and the only copy of the gateway's reason was this
// process's stderr — gone with the next deploy. Two things are pinned here, through the
// real handler:
//   1. the refusal has its own class, downstream, and the link stays green;
//   2. the 502 carries the SHAPE of any answered refusal (its code, the NAMES of its
//      `details` keys) for the dispatch trace — never its text or a value.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createBridgeServer } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { HealthRegistry } from "../src/core/health.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
} from "../src/providers/openclaw/openclaw-client.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

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
  maxBodyBytes: 5_000_000,
} as unknown as BridgeConfig;

const writer = {
  getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  reportSessionMeta: async () => {},
  emitRehydrateTrace: () => {},
  startAssistant: async () => "m",
  appendDelta: async () => {},
  setSnapshot: async () => true,
  addToolPart: async () => {},
  addReasoningPart: async () => {},
  addMediaPart: async () => {},
  noteMediaUndelivered: async () => {},
  finalize: async () => {},
  upsertSubAgent: async () => {},
  clearSessionState: async () => {},
} as unknown as ConvexWriter;

/** The refusal `chat.send` answers, per test. */
let refuse: () => Error = () => new Error("unset");

function fakeConn() {
  return {
    verboseFullApplied: false,
    isClosed: false,
    close() {},
    modelsByOwner: new Map(),
    rosterEpoch: 0,
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: () => () => {},
    async *frames() {
      await new Promise<void>(() => {});
    },
    async request(method: string) {
      if (method === "sessions.describe") return { payload: { session: { systemSent: true } } };
      if (method === "models.list") return { payload: { models: [] } };
      if (method === "chat.send") throw refuse();
      return { payload: {} };
    },
  };
}

describe("/send: a refusal the gateway ANSWERED", () => {
  let server: Server;
  let baseUrl: string;
  const health = new HealthRegistry(1000, () => 2000);

  beforeAll(async () => {
    vi.spyOn(OpenClawConnection, "connect").mockResolvedValue(
      fakeConn() as unknown as OpenClawConnection,
    );
    const served = servedMap(CONFIG, writer);
    server = createBridgeServer({
      shared: sharedFromConfig(CONFIG),
      served,
      registry: new SessionRegistry(served),
      health,
    });
    await new Promise<void>((res) => server.listen(0, res));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((res) => server.close(() => res()));
  });

  const post = (cmid: string) =>
    fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "shared-secret" },
      body: JSON.stringify({
        chatId: "chat-media",
        instanceName: "primary",
        agentId: "alice",
        canonical: "olivier",
        text: "voici le fichier",
        clientMessageId: cmid,
        messageId: `m-${cmid}`,
        outboxId: `ob-${cmid}`,
      }),
    });

  it("the media-offload refusal: its own class, downstream, its shape and nothing else", async () => {
    refuse = () =>
      new GatewayAnsweredError(
        "UNAVAILABLE: MediaOffloadError: [Gateway Error] Failed to save intercepted media to disk: native fs-safe helper is unavailable",
        undefined,
        "UNAVAILABLE",
      );
    // Sent without a file on purpose: the class must not hang on `hasAttachments` (the
    // gateway's wrapper names the fact), and an inline file would meet the bridge's own
    // checks before the fake gateway is asked. The attachment case is pinned in
    // dispatch-errors.test.ts.
    const r = await post("c1");
    expect(r.status).toBe(502);
    const raw = await r.text();
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      error: { code: "gateway_media_unavailable", answered: { gatewayCode: "UNAVAILABLE" } },
    });
    // No gateway TEXT crosses to Convex.
    for (const leak of ["MediaOffloadError", "fs-safe", "Failed to save"]) {
      expect(raw, leak).not.toContain(leak);
    }
    // The gateway answered: the link is fine, the refusal is a downstream note.
    const t = health.snapshot().targets.find((x) => x.agentId === "alice");
    expect(t?.state).toBe("connected");
    expect(t?.lastDownstreamReject?.code).toBe("gateway_media_unavailable");
    expect(t?.lastError ?? null).toBeNull();
  });

  it("an UNRECOGNIZED refusal keeps its code and the names of its detail keys", async () => {
    refuse = () =>
      new GatewayAnsweredError(
        "UNAVAILABLE: something new the bridge has no rule for: /data/olivier/private.txt",
        {
          retryable: false,
          reason: "private reason text",
          path: "/data/olivier/private.txt",
          // Content that passes a syntax filter: only a closed vocabulary stops it.
          SyntheticSecretDocument: "x",
        },
        "UNAVAILABLE",
      );
    const r = await post("c2");
    expect(r.status).toBe(502);
    const raw = await r.text();
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      error: {
        code: "UPSTREAM_ERROR",
        answered: { gatewayCode: "UNAVAILABLE", detailKeys: ["reason"], unknownDetailKeyCount: 3 },
      },
    });
    for (const leak of ["olivier", "private", "something new", "Synthetic", "retryable", "path"]) {
      expect(raw, leak).not.toContain(leak);
    }
  });

  it("a code outside the gateway's vocabulary never crosses as itself", async () => {
    refuse = () =>
      new GatewayAnsweredError("SYNTHETIC_SECRET_VALUE: refused", undefined, "SYNTHETIC_SECRET_VALUE");
    const r = await post("c4");
    expect(r.status).toBe(502);
    const raw = await r.text();
    expect(JSON.parse(raw).error.answered).toEqual({ gatewayCode: "other" });
    expect(raw).not.toContain("SYNTHETIC");
  });

  it("a failure no gateway answered carries no shape", async () => {
    refuse = () => new Error("chat.send timed out");
    const r = await post("c3");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: { code: "GATEWAY_TIMEOUT" } });
  });
});
