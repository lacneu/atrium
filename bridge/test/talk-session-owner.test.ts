// WHO OWNS A VOICE SESSION.
//
// The gateway reads a Talk session's owning agent off an AGENT-SCOPED session key
// (upstream src/talk/agent-target.ts `resolveTalkSessionAgentId`) and, without one,
// falls back to `config.talk.agentId` — refusing outright only when several agents
// exist and no such fallback is set: "Multiple agents are configured, but Talk
// session ownership has no explicit owner." Live prod 2026-09-17, six and seven
// agents: that refusal left the voice button dead on both instances. The fallback is
// no better — it answers as one arbitrary agent instead of the chat's.
//
// The route is driven END TO END against a socket-level fake gateway, and the
// assertion reads the params the GATEWAY received. A first version of this file
// built the key and the params itself: deleting the wiring in the real handler left
// it green, which is the one failure mode a wiring test exists to catch.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { HealthRegistry } from "../src/core/health.js";
import { SessionRegistry } from "../src/session.js";
import { createBridgeServer } from "../src/server.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";
import {
  buildSessionKey,
  talkSessionOwner,
} from "../src/providers/openclaw/session-keys.js";
import { talkClientCreateParams } from "../src/core/rpc-params.js";
import {
  deviceIdentity,
  startWsFakeGateway,
  type WsFakeGateway,
} from "./helpers/ws-fake-gateway.js";

const PARTS = {
  chatId: "c1",
  canonical: "olivier",
  agentId: "alice",
};

// ── The decision, pure ──────────────────────────────────────────────────────

describe("talkSessionOwner", () => {
  test("names the chat's own conversation — the key a typed turn uses", () => {
    expect(talkSessionOwner(PARTS)).toEqual({
      kind: "scoped",
      sessionKey: buildSessionKey("c1", "alice", "olivier"),
    });
  });

  test("prefers the gateway conversation id when Convex resolved one", () => {
    // A per-turn routed chat carries its segment; the voice session must land in
    // THAT conversation, not in one keyed by the Convex id.
    expect(talkSessionOwner({ ...PARTS, openclawChatId: "oc-42" })).toEqual({
      kind: "scoped",
      sessionKey: buildSessionKey("oc-42", "alice", "olivier"),
    });
  });

  test("NO owner named at all = the pre-contract caller, left unscoped", () => {
    // An older Convex deploy sends none of the three. Refusing here would take
    // voice away from a single-agent gateway where the unscoped create is valid.
    expect(
      talkSessionOwner({ chatId: null, canonical: null, agentId: null }),
    ).toEqual({ kind: "unscoped" });
  });

  test("openclawChatId ALONE is a partial owner, not a pre-contract caller", () => {
    // It is not one of the three required parts, but a body carrying it meant to
    // scope the session and failed — classing that `unscoped` would send the
    // create out unowned under the banner of backward compatibility.
    expect(
      talkSessionOwner({
        chatId: null,
        openclawChatId: "oc-42",
        canonical: null,
        agentId: null,
      }),
    ).toEqual({
      kind: "incomplete",
      missing: ["chatId", "canonical", "agentId"],
    });
  });

  test("a PARTIAL set is a refusal, naming what was missing", () => {
    // A key built from two ingredients out of three would address a different
    // session: the voice conversation would attach to the wrong agent or the wrong
    // chat. Refused under our own name — the gateway never arbitrates this.
    for (const missing of ["chatId", "canonical", "agentId"] as const) {
      expect(
        talkSessionOwner({ ...PARTS, [missing]: null }),
        `${missing} missing`,
      ).toEqual({ kind: "incomplete", missing: [missing] });
      expect(
        talkSessionOwner({ ...PARTS, [missing]: "" }),
        `${missing} empty`,
      ).toEqual({ kind: "incomplete", missing: [missing] });
    }
  });
});

describe("talk.client.create params", () => {
  test("the key rides the params verbatim when named", () => {
    const key = buildSessionKey("c1", "alice", "olivier");
    expect(talkClientCreateParams("webrtc", null, null, key)).toEqual({
      transport: "webrtc",
      sessionKey: key,
    });
  });

  test("and is OMITTED when there is none", () => {
    // `additionalProperties:false` upstream: a `sessionKey: null` would be a hard
    // refusal, and a single-agent gateway must keep working unscoped.
    const params = talkClientCreateParams("webrtc", "cedar", 0.6, null);
    expect(params).toEqual({
      transport: "webrtc",
      voice: "cedar",
      vadThreshold: 0.6,
    });
    expect("sessionKey" in params).toBe(false);
  });
});

// ── The wiring: POST /talk-session → what the GATEWAY received ──────────────

const CONFIG = (gatewayUrl: string): BridgeConfig =>
  ({
    openclawGatewayUrl: gatewayUrl,
    openclawToken: "test-token",
    deviceIdentity: deviceIdentity(),
    bridgeInstanceSecret: null,
    instanceName: "primary",
    bridgeSharedSecret: "test-shared-secret",
    mediaOutboundDir: "/tmp/media-outbound",
    mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  }) as unknown as BridgeConfig;

const MINTED = {
  clientSecret: "ek_ephemeral",
  offerUrl: "https://gw.example.org/offer",
  model: "gpt-realtime",
  voice: "cedar",
  expiresAt: 9_999_999_999,
};

describe("POST /talk-session scopes the create on the chat's agent", () => {
  let gateway: WsFakeGateway | null = null;
  let server: Server | null = null;
  let registry: SessionRegistry | null = null;

  afterEach(async () => {
    // A SCOPED create now rides the conversation's own long-lived socket (a
    // gateway-owned voice call is bound to the connection that minted it), so the
    // registry holds a live session after the request: close it, or the fake
    // gateway's close waits on that socket forever.
    registry?.closeAll();
    registry = null;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await gateway?.stop();
    gateway = null;
  });

  /** A live fake gateway + the REAL bridge server in front of it. */
  async function boot() {
    const gw = startWsFakeGateway({
      onMethod: (method) =>
        method === "talk.client.create" ? MINTED : {},
    });
    await gw.ready;
    gateway = gw;
    const config = CONFIG(gw.url);
    const shared = sharedFromConfig(config);
    registry = new SessionRegistry(servedMap(config));
    const srv = createBridgeServer({
      shared,
      served: servedMap(config),
      registry,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => srv.listen(0, r));
    server = srv;
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return {
      gw,
      post: (body: unknown) =>
        fetch(`${base}/talk-session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: shared.bridgeSharedSecret,
          },
          body: JSON.stringify(body),
        }),
    };
  }

  const createParams = (gw: WsFakeGateway) =>
    gw.requests.find((r) => r.method === "talk.client.create")?.params as
      | Record<string, unknown>
      | undefined;

  test("the gateway receives the key of the chat's OWN conversation", async () => {
    const { gw, post } = await boot();
    const res = await post({
      instanceName: "primary",
      chatId: "c1",
      openclawChatId: "oc-bound",
      canonical: "olivier",
      agentId: "alice",
    });
    expect(res.status).toBe(200);
    // The key the GATEWAY was handed — not one this test built for itself.
    expect(createParams(gw)?.sessionKey).toBe(
      buildSessionKey("oc-bound", "alice", "olivier"),
    );
  });

  test("a pre-contract caller still mints, unscoped", async () => {
    const { gw, post } = await boot();
    const res = await post({ instanceName: "primary" });
    expect(res.status).toBe(200);
    const params = createParams(gw);
    expect(params).toBeDefined();
    expect("sessionKey" in params!).toBe(false);
  });

  test("an owner field that is present but INVALID is refused too", async () => {
    // `{chatId: 123}` normalizes to null exactly like an absent field. Counting
    // nulls after normalization would class this "the caller named nothing" and
    // fail open — a malformed body must not buy backward compatibility.
    const { gw, post } = await boot();
    for (const chatId of [123, "", "   ", null]) {
      const res = await post({ instanceName: "primary", chatId });
      expect(res.status, `chatId=${JSON.stringify(chatId)}`).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "talk_owner_incomplete" },
      });
    }
    // An explicit `null` is a field the caller WROTE — presence of the key is the
    // signal, not its value, or a body spelling every owner field `null` would buy
    // the fail-open path.
    expect(createParams(gw)).toBeUndefined();
  });

  test("the pre-contract create is NAMED in the log, never silent", async () => {
    // It is fail-open on purpose (a bridge/Convex deploy skew), so the one thing
    // that must not happen is it passing unnoticed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { post } = await boot();
      expect((await post({ instanceName: "primary" })).status).toBe(200);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("no session owner")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a conversation that is named but UNUSABLE is refused too", async () => {
    // The three required parts are all valid; only the optional conversation is
    // junk. Falling back to the chat id would open a DIFFERENT session from the one
    // the caller named — the same class of mistake as a partial owner, and the one
    // the `missing` list did not cover.
    const { gw, post } = await boot();
    for (const openclawChatId of [123, "", "   "]) {
      const res = await post({
        instanceName: "primary",
        chatId: "c1",
        canonical: "olivier",
        agentId: "alice",
        openclawChatId,
      });
      expect(res.status, JSON.stringify(openclawChatId)).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "talk_owner_incomplete" },
      });
    }
    expect(createParams(gw)).toBeUndefined();
  });

  test("the response ACKNOWLEDGES whether the create was scoped", async () => {
    // A bridge predating this contract answers the same `{ok, session}` while
    // dropping the ownership fields, so the gateway opens the session under its own
    // fallback agent. Convex cannot tell the two apart without this flag.
    const { post } = await boot();
    const scoped = await post({
      instanceName: "primary",
      chatId: "c1",
      openclawChatId: "oc-bound",
      canonical: "olivier",
      agentId: "alice",
    });
    expect(await scoped.json()).toMatchObject({ ok: true, ownerScoped: true });
    const unscoped = await post({ instanceName: "primary" });
    expect(await unscoped.json()).toMatchObject({
      ok: true,
      ownerScoped: false,
    });
  });

  test("a PARTIALLY named owner is refused BEFORE the gateway is called", async () => {
    const { gw, post } = await boot();
    const res = await post({
      instanceName: "primary",
      chatId: "c1",
      canonical: "olivier",
      // agentId absent: the owner cannot be named, and a key built from the rest
      // would address another agent's session.
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "talk_owner_incomplete" },
    });
    expect(createParams(gw)).toBeUndefined();
  });
});
