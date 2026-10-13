// SENTINEL: a provider's text never reaches the bridge's log.
//
// The OpenClaw client builds an answered refusal's message from what the gateway sent
// (`<CODE>: <message>`), and the gateway interpolates operator- and user-chosen values into
// it: arbitrary codes, paths, file names. Codex reproduced it through the real /send handler:
// the 502 carried `gatewayCode: "other"` while console.error printed the whole sentence. The
// rule: for an error carrying provider text (by TYPE — `GatewayTextError`, or the answered
// marker), the log gets the classified code and the closed-vocabulary shape, never the
// message, never `details`. The full text stays in the provider's own log.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createBridgeServer } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { HealthRegistry } from "../src/core/health.js";
import { errForLog, carriesGatewayText } from "../src/core/log-safe-error.js";
import {
  GatewayAnsweredError,
  GatewayConnectRefusedError,
  OpenClawConnection,
  OpenClawError,
  normalizeWsUrl,
} from "../src/providers/openclaw/openclaw-client.js";
import { HermesError } from "../src/providers/hermes/client.js";
import { HermesWsClient, HermesWsError, HermesWsRpcError } from "../src/providers/hermes/ws-client.js";
import { HermesFilesFetcher } from "../src/providers/hermes/files-fetcher.js";
import { GatewayHttpMediaFetcher } from "../src/core/gateway-http-media-fetcher.js";
import {
  ProviderBadResponseError,
  parseProviderJson,
  readProviderJson,
} from "../src/core/provider-body.js";
import { WebSocketServer } from "ws";
import { deviceIdentity } from "./helpers/ws-fake-gateway.js";
import { PermissionModeNotAppliedError } from "../src/providers/openclaw/permission-mode.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

/** Strings the trapped refusal carries; none may be logged. */
const TRAPS = ["SYNTHETIC_SECRET_VALUE", "/data/example/document.pdf", "private", "SyntheticSecretDocument", "secret-detail-value"];
const trapped = () =>
  new GatewayAnsweredError(
    "SYNTHETIC_SECRET_VALUE: private /data/example/document.pdf",
    { SyntheticSecretDocument: "secret-detail-value", reason: "secret-detail-value" },
    "SYNTHETIC_SECRET_VALUE",
  );

describe("errForLog decides on the TYPE", () => {
  it("an answered refusal: class and filtered shape only", () => {
    const line = errForLog(trapped());
    for (const t of TRAPS) expect(line, t).not.toContain(t);
    expect(line).toContain("GatewayAnsweredError");
    expect(line).toContain('"gatewayCode":"other"');
  });

  it("behind a wrapper that keeps it as its cause, still withheld", () => {
    const wrapped = new PermissionModeNotAppliedError("rejected", trapped().message, trapped());
    expect(carriesGatewayText(wrapped)).toBe(true);
    const line = errForLog(wrapped);
    for (const t of TRAPS) expect(line, t).not.toContain(t);
    expect(line).toContain("PermissionModeNotAppliedError");
  });

  it("an error of Atrium's own keeps its message", () => {
    expect(errForLog(new Error("convex write failed: 503"))).toBe("convex write failed: 503");
    expect(errForLog("plain")).toBe("plain");
  });
});

// ── Through the real handlers ───────────────────────────────────────────────

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
  finalize: async () => {},
  upsertSubAgent: async () => {},
  clearSessionState: async () => {},
} as unknown as ConvexWriter;

describe("the real /send and /compact handlers log no provider text", () => {
  let server: Server;
  let baseUrl: string;
  const logged: string[] = [];

  beforeAll(async () => {
    const conn = {
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
        if (method === "chat.send" || method === "sessions.compact") throw trapped();
        return { payload: {} };
      },
    };
    vi.spyOn(OpenClawConnection, "connect").mockResolvedValue(conn as unknown as OpenClawConnection);
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
    vi.restoreAllMocks();
    await new Promise<void>((res) => server.close(() => res()));
  });

  function capture() {
    logged.length = 0;
    const record = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    };
    return [
      vi.spyOn(console, "error").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
      vi.spyOn(console, "log").mockImplementation(record),
    ];
  }
  let spies: ReturnType<typeof capture> = [];
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  const post = (route: string, extra: Record<string, unknown>) =>
    fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "shared-secret" },
      body: JSON.stringify({
        chatId: "chat-trap",
        instanceName: "primary",
        agentId: "alice",
        canonical: "olivier",
        ...extra,
      }),
    });

  it("/send: the classified code is logged, the trapped text is not", async () => {
    spies = capture();
    const r = await post("/send", {
      text: "bonjour",
      clientMessageId: "c1",
      messageId: "m1",
      outboxId: "ob1",
    });
    expect(r.status).toBe(502);
    const all = logged.join("\n");
    expect(all).toContain("bridge /send failed [UPSTREAM_ERROR]");
    for (const t of TRAPS) expect(all, t).not.toContain(t);
  });

  it("/compact: same rule", async () => {
    spies = capture();
    const r = await post("/compact", {});
    expect(r.status).toBe(502);
    const all = logged.join("\n");
    expect(all).toContain("bridge /compact failed [UPSTREAM_ERROR]");
    for (const t of TRAPS) expect(all, t).not.toContain(t);
  });
});

// ── Received vs LOCAL: the type decides, both ways (codex pass 3) ─────────────

describe("an error Atrium builds ITSELF keeps its diagnosis; a received one is withheld", () => {
  it("a refused URL scheme (local, before any connection) keeps its words", () => {
    let thrown: unknown;
    try {
      normalizeWsUrl("ftp://gateway.example");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OpenClawError);
    expect(errForLog(thrown)).toBe("Unsupported OpenClaw Gateway URL scheme: ftp");
  });

  it("over a real socket: a local signing failure keeps its words, a connect REFUSAL is withheld", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n", ts: 1 } }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id: string; method?: string };
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "SYNTHETIC_SECRET_VALUE", message: "private /data/example/document.pdf" },
            }),
          );
        }
      });
    });
    try {
      // LOCAL: a private key that cannot sign. Nothing the gateway sent is in the message.
      const badKey = { ...deviceIdentity(), privateKey: "not a pem" };
      const signing = await OpenClawConnection.connect(url, "tok", badKey).then(
        () => null,
        (e: unknown) => e,
      );
      expect(signing).toBeInstanceOf(OpenClawError);
      expect(signing).not.toBeInstanceOf(GatewayConnectRefusedError);
      expect(errForLog(signing)).toMatch(/^device signing failed/);

      // RECEIVED: the gateway refused the connect with its own text.
      const refused = await OpenClawConnection.connect(url, "tok", deviceIdentity()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(GatewayConnectRefusedError);
      // Still an OpenClawError: what the dispatch classification and callers test.
      expect(refused).toBeInstanceOf(OpenClawError);
      const line = errForLog(refused);
      for (const t of TRAPS) expect(line, t).not.toContain(t);
      expect(line).toContain("GatewayConnectRefusedError");
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it("Hermes: a local transport error keeps its words, a JSON-RPC error the server SENT is withheld", () => {
    expect(errForLog(new HermesError("Hermes GET /x -> HTTP 503", "HTTP_ERROR", 503))).toBe(
      "Hermes GET /x -> HTTP 503 [HTTP_ERROR]",
    );
    expect(errForLog(new HermesWsError("Hermes WS connect timeout", "TIMEOUT"))).toBe(
      "Hermes WS connect timeout [TIMEOUT]",
    );
    const rpc = new HermesWsRpcError("private /data/example/document.pdf", "RPC_ERROR", -32000);
    expect(rpc).toBeInstanceOf(HermesWsError);
    expect(errForLog(rpc)).not.toContain("/data/example/document.pdf");
  });
});

// ── Undecodable provider bodies (codex pass 3) ────────────────────────────────

const BODY = "PRIVATE /data/example/document.pdf SYNTHETIC_SECRET_VALUE";
const textResponse = (status = 200, headers: Record<string, string> = {}) =>
  new Response(BODY, { status, headers });

describe("a body the provider sent never reaches a log through a decode error", () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];
  const logged: string[] = [];
  beforeAll(() => {
    const rec = (...a: unknown[]) => logged.push(a.map(String).join(" "));
    spies = [
      vi.spyOn(console, "error").mockImplementation(rec),
      vi.spyOn(console, "warn").mockImplementation(rec),
      vi.spyOn(console, "log").mockImplementation(rec),
    ];
  });
  afterAll(() => {
    for (const s of spies) s.mockRestore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const l of logged) for (const t of ["PRIVATE", "document.pdf", "SYNTHETIC"]) expect(l, t).not.toContain(t);
  });

  const assertWithheld = (err: unknown) => {
    expect(err).toBeInstanceOf(ProviderBadResponseError);
    const line = errForLog(err);
    for (const t of ["PRIVATE", "document.pdf", "SYNTHETIC"]) expect(line, t).not.toContain(t);
    expect((err as Error).message).not.toContain("PRIVATE");
    expect(line).toContain("[BAD_RESPONSE]");
  };

  it("the helper itself: a structural message and the received-text type", async () => {
    expect(() => parseProviderJson(BODY, "X")).toThrow(ProviderBadResponseError);
    assertWithheld(await readProviderJson(textResponse(), "X").then(() => null, (e: unknown) => e));
  });

  it("Hermes WS authentication: a non-JSON ws-ticket answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/auth/password-login")
          ? new Response("{}", { status: 200, headers: { "set-cookie": "s=1; Path=/" } })
          : textResponse(),
      ),
    );
    const client = new HermesWsClient({ baseUrl: "http://hermes.invalid", credential: "user:pass" } as never);
    const err = await (client as unknown as { authQuery(): Promise<string> })
      .authQuery()
      .then(() => null, (e: unknown) => e);
    assertWithheld(err);
  });

  it("Hermes file operations: agentFilesRoot and listFilesStrict on a non-JSON 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse()));
    const files = new HermesFilesFetcher({ baseUrl: "http://hermes.invalid", credential: "tok", maxBytes: 1024 } as never);
    assertWithheld(await files.agentFilesRoot().then(() => null, (e: unknown) => e));
    assertWithheld(await files.listFilesStrict("/opt/data").then(() => null, (e: unknown) => e));
  });

  it("OpenClaw gateway-http media: an undecodable meta answer is a plain fetch_error, nothing logged", async () => {
    const fetcher = new GatewayHttpMediaFetcher({
      httpBase: "http://gw.invalid",
      token: () => "t",
      maxBytes: 1024,
      fetchImpl: (async () => textResponse()) as unknown as typeof fetch,
    } as never);
    const r = await fetcher.open("/home/node/.openclaw/media/outbound/x.png");
    expect(r).toEqual({ ok: false, reason: "fetch_error" });
  });
});
