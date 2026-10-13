// OpenClaw 2026.9.9 REFUSES a `sessions.compact` on a session it has no record of
// (`INVALID_REQUEST`, `Session <key> not found. Run openclaw sessions list --json to
// choose a valid key.` — v2026.9.9 src/gateway/server-methods/sessions-compact.ts:138-147,
// upstream test server.sessions.compaction-read-errors.test.ts:176-196). 2026.9.8
// answered the same case `{ok:true, compacted:false, reason:"no sessionId"}`.
//
// Read as a failed RPC, the new answer turned "Compact the session" on a conversation
// that had not sent its first turn into a 502 AGENT_NOT_FOUND (the session key starts
// `agent:`), and the pre-send guard into `error`. The decision is 9.8 PARITY: the same
// fact, the same answer — but only for an ANSWERED refusal naming the key WE sent.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { compactRefusalFromAnswer } from "../src/core/compaction-verdict.js";
import { createBridgeServer, performCompact } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { HealthRegistry } from "../src/core/health.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
  OpenClawError,
} from "../src/providers/openclaw/openclaw-client.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const KEY = "agent:alice:webchat:chat:olivier:oc1";
/** The 2026.9.9 refusal exactly as the OpenClaw client reports it (`<code>: <message>`). */
const refusal99 = (key: string) =>
  `INVALID_REQUEST: Session ${key} not found. Run openclaw sessions list --json to choose a valid key.`;

describe("compactRefusalFromAnswer — the 2026.9.9 missing-session refusal", () => {
  it("is the 9.8 `no sessionId` refusal when it names the key we sent", () => {
    expect(compactRefusalFromAnswer(refusal99(KEY), KEY)).toBe("no sessionId");
    // Upstream trims the key before echoing it (requireSessionKey).
    expect(compactRefusalFromAnswer(refusal99(KEY), ` ${KEY} `)).toBe("no sessionId");
  });

  it("is NOTHING when the key is another session's", () => {
    expect(
      compactRefusalFromAnswer(refusal99("agent:bob:webchat:chat:olivier:oc1"), KEY),
    ).toBeNull();
    // A key that merely STARTS like ours is not ours.
    expect(compactRefusalFromAnswer(refusal99(`${KEY}x`), KEY)).toBeNull();
  });

  it("is NOTHING for the other `not found` spellings, nor the same words further in", () => {
    // The task registry's form (pinned elsewhere in the bridge).
    expect(compactRefusalFromAnswer(`INVALID_REQUEST: session not found: ${KEY}`, KEY)).toBeNull();
    // Another code.
    expect(
      compactRefusalFromAnswer(`UNAVAILABLE: Session ${KEY} not found.`, KEY),
    ).toBeNull();
    // The sentence quoted INSIDE some other refusal never decides.
    expect(
      compactRefusalFromAnswer(`INVALID_REQUEST: bad params (${refusal99(KEY)})`, KEY),
    ).toBeNull();
    expect(compactRefusalFromAnswer(refusal99(KEY), "")).toBeNull();
  });
});

describe("performCompact on a missing session (2026.9.9)", () => {
  function sessionAnswering(compact: () => never | Record<string, unknown>) {
    const calls: Record<string, unknown>[] = [];
    const conn = {
      isClosed: false,
      async request(method: string, params: Record<string, unknown>) {
        if (method === "sessions.compact") {
          calls.push(params);
          return { payload: compact() };
        }
        return { payload: {} };
      },
    };
    const session = { sessionKey: KEY, connection: conn } as never;
    return { session, calls };
  }

  it("answers the 9.8 refusal for the 9.9 GatewayAnsweredError", async () => {
    const { session, calls } = sessionAnswering(() => {
      throw new GatewayAnsweredError(refusal99(KEY), undefined, "INVALID_REQUEST");
    });
    await expect(performCompact(session)).resolves.toEqual({
      compacted: false,
      reasonClass: "no sessionId",
    });
    expect(calls).toEqual([{ key: KEY }]);
  });

  it("…exactly what 2026.9.8 answered with a 200", async () => {
    const { session } = sessionAnswering(() => ({
      ok: true,
      key: KEY,
      compacted: false,
      reason: "no sessionId",
    }));
    await expect(performCompact(session)).resolves.toEqual({
      compacted: false,
      reasonClass: "no sessionId",
    });
  });

  it("still THROWS when the text did not come from an answered refusal", async () => {
    // A timeout of the same request, and a plain Error carrying the same words: neither
    // is the gateway stating the session is absent.
    for (const err of [
      new OpenClawError("sessions.compact timed out"),
      new Error(refusal99(KEY)),
      new OpenClawError(refusal99(KEY)),
    ]) {
      const { session } = sessionAnswering(() => {
        throw err;
      });
      await expect(performCompact(session)).rejects.toBe(err);
    }
  });

  it("still THROWS for another session's key", async () => {
    const { session } = sessionAnswering(() => {
      throw new GatewayAnsweredError(
        refusal99("agent:bob:webchat:chat:olivier:oc1"),
        undefined,
        "INVALID_REQUEST",
      );
    });
    await expect(performCompact(session)).rejects.toBeInstanceOf(GatewayAnsweredError);
  });
});

// ── Through the real /compact route ─────────────────────────────────────────

const CONFIG = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  convexHttpActionsUrl: "http://convex.example.org",
  convexIngestSecret: "ingest-secret",
  deltaFlushMs: 150,
  bridgeSharedSecret: "shared-secret",
  port: 0,
  maxBodyBytes: 1_000_000,
} as unknown as BridgeConfig;

const writer = {
  reportSessionMeta: async () => {},
  clearSessionState: async () => {},
} as unknown as ConvexWriter;

describe("POST /compact on a never-sent conversation (2026.9.9)", () => {
  let server: Server;
  let baseUrl: string;
  /** What the fake gateway does with `sessions.compact`, per test. */
  let onCompact: (key: string) => Record<string, unknown> = () => ({});

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
      async request(method: string, params: Record<string, unknown>) {
        if (method === "sessions.compact") return { payload: onCompact(String(params.key)) };
        return { payload: {} };
      },
    };
    vi.spyOn(OpenClawConnection, "connect").mockResolvedValue(
      conn as unknown as OpenClawConnection,
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
    await sleep(1);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((res) => server.close(() => res()));
  });
  afterEach(() => {
    onCompact = () => ({});
  });

  const post = () =>
    fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "shared-secret" },
      body: JSON.stringify({
        chatId: "chat-never-sent",
        openclawChatId: "oc-never-sent",
        instanceName: "primary",
        agentId: "alice",
        canonical: "olivier",
      }),
    });

  it("answers 200 {compacted:false, reasonClass:'no sessionId'} — not 502 AGENT_NOT_FOUND", async () => {
    onCompact = (key) => {
      throw new GatewayAnsweredError(refusal99(key), undefined, "INVALID_REQUEST");
    };
    const r = await post();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      compacted: false,
      reasonClass: "no sessionId",
    });
  });

  it("a refusal naming ANOTHER key is still a failure, and never AGENT_NOT_FOUND", async () => {
    onCompact = () => {
      throw new GatewayAnsweredError(
        refusal99("agent:bob:webchat:chat:olivier:other"),
        undefined,
        "INVALID_REQUEST",
      );
    };
    const r = await post();
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
});
