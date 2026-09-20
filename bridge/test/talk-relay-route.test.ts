// WHO OWNS A GPT LIVE CALL, end to end.
//
// On OpenClaw >= 2026.9.5 the default realtime model is GPT Live. Its browser
// session is GATEWAY-OWNED: the gateway binds the call to the WebSocket connection
// that called `talk.client.create`, runs the agent consult under that connection's
// identity, and CLOSES the call when that connection closes (upstream
// `talk/handlers/client-create.ts:229-250`, `talk/client-gateway-control.ts:612-625`).
// Its offer is a path ON THE GATEWAY (`/plugins/openai/realtime/calls`), which the
// browser cannot reach in Atrium's deployment.
//
// So three things must be true at once, and this file drives the REAL server against
// a fake gateway to read them off what the gateway received:
//   1. the create rides the CONVERSATION's own long-lived socket (one upgrade, not
//      a throwaway operator socket that would take the call down with it);
//   2. the browser's SDP offer reaches the gateway's route with the secret the
//      bridge kept — the secret never appears in any response;
//   3. the hangup closes the call on the SAME socket, and only then does the idle
//      sweeper get the socket back.
// The classic https mint (a pinned `talk.realtime.model`) keeps its verbatim lane.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { HealthRegistry } from "../src/core/health.js";
import { IDLE_SESSION_TTL_SECONDS, SessionRegistry } from "../src/session.js";
import { createBridgeServer } from "../src/server.js";
import { buildSessionKey } from "../src/providers/openclaw/session-keys.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";
import {
  deviceIdentity,
  startWsFakeGateway,
  type WsFakeGateway,
} from "./helpers/ws-fake-gateway.js";

const OWNER = {
  instanceName: "primary",
  chatId: "c1",
  openclawChatId: "oc-bound",
  canonical: "olivier",
  agentId: "alice",
};
const OWNER_KEY = buildSessionKey("oc-bound", "alice", "olivier");
/** What Convex sends with an offer: the session the row proved the caller on. */
const OFFER_OWNER = {
  instanceName: "primary",
  chatId: "c1",
  openclawChatId: "oc-bound",
  canonical: "olivier",
  agentId: "alice",
};

/** Mint + offer, returning the relay handle: the call is ALLOCATED only once the
 *  offer is spent, which is when the 30-minute hold starts. */
async function mintAndOffer(post: (p: string, b: unknown) => Promise<{ status: number; body: Record<string, unknown> }>) {
  const minted = await post("/talk-session", OWNER);
  const relayId = (
    (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
  ).relayId;
  const offer = await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0\r\noffer" });
  return { minted, relayId, offer };
}

/** The GPT Live mint, shape as the 2026.9.5 gateway answers it (bench capture
 *  2026-09-19: `offerUrl` relative, `offerResponseMaxBytes`, `voiceSessionId`). */
const GPT_LIVE_MINT = {
  provider: "openai",
  transport: "webrtc",
  clientSecret: "tok_live_secret",
  offerUrl: "/plugins/openai/realtime/calls",
  offerResponseMaxBytes: 262144,
  model: "gpt-live-1",
  voice: "marin",
  expiresAt: Date.now() + 60_000,
  voiceSessionId: "vs-1",
};

/** The classic mint (a pinned realtime model): the browser goes to the provider. */
const CLASSIC_MINT = {
  provider: "openai",
  transport: "webrtc",
  clientSecret: "ek_classic",
  offerUrl: "https://api.openai.com/v1/realtime/calls",
  offerHeaders: { "OpenAI-Beta": "realtime=v1" },
  model: "gpt-realtime-2.1",
  voice: "cedar",
  expiresAt: Date.now() + 60_000,
  voiceSessionId: "vs-2",
};

/** The gateway's offer route, as an HTTP server: records what it was sent. A test
 *  may HOLD the answer (`gate`) to race something against the offer's round trip. */
function startOfferRoute() {
  const seen: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  let gate: Promise<void> = Promise.resolve();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${GPT_LIVE_MINT.clientSecret}`) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Invalid or expired realtime session token");
        return;
      }
      void gate.then(() => {
        res.writeHead(201, { "content-type": "application/sdp" });
        res.end("v=0\r\nanswer");
      });
    });
  });
  return {
    seen,
    holdAnswer(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
    ready: new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r())),
    get url() {
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const CONFIG = (gatewayUrl: string, gatewayHttpBase: string): BridgeConfig =>
  ({
    openclawGatewayUrl: gatewayUrl,
    gatewayHttpBase,
    openclawToken: "test-token",
    deviceIdentity: deviceIdentity(),
    bridgeInstanceSecret: null,
    instanceName: "primary",
    bridgeSharedSecret: "test-shared-secret",
    mediaOutboundDir: "/tmp/media-outbound",
    mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
  }) as unknown as BridgeConfig;

describe("GPT Live: the call rides the conversation's socket and the offer is relayed", () => {
  let gateway: WsFakeGateway | null = null;
  let offerRoute: ReturnType<typeof startOfferRoute> | null = null;
  let server: Server | null = null;
  let registry: SessionRegistry | null = null;

  afterEach(async () => {
    registry?.closeAll();
    registry = null;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await gateway?.stop();
    gateway = null;
    await offerRoute?.stop();
    offerRoute = null;
    vi.restoreAllMocks();
  });

  async function boot(
    mint:
      | Record<string, unknown>
      | ((nth: number) => Record<string, unknown>) = GPT_LIVE_MINT,
    clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    let mints = 0;
    const gw = startWsFakeGateway({
      onMethod: (method) => {
        if (method === "talk.client.create") {
          mints += 1;
          return typeof mint === "function" ? mint(mints) : mint;
        }
        if (method === "talk.client.close") return { ok: true };
        return {};
      },
    });
    const route = startOfferRoute();
    await Promise.all([gw.ready, route.ready]);
    gateway = gw;
    offerRoute = route;
    const config = CONFIG(gw.url, route.url);
    const shared = sharedFromConfig(config);
    registry = new SessionRegistry(servedMap(config), clock);
    const srv = createBridgeServer({
      shared,
      served: servedMap(config),
      registry,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => srv.listen(0, r));
    server = srv;
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: shared.bridgeSharedSecret,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { gw, route, post, registry: registry! };
  }

  test("a scoped create rides ONE long-lived socket, and the secret stays here", async () => {
    const { gw, post } = await boot();
    const res = await post("/talk-session", OWNER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.relayed).toBe(true);
    expect(res.body.ownerScoped).toBe(true);
    const session = res.body.session as Record<string, unknown>;
    // The browser gets an OPAQUE handle and the descriptive rest — never the secret,
    // never a path it could not use anyway.
    expect(session.offerRelay).toEqual({
      relayId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      expiresAt: GPT_LIVE_MINT.expiresAt,
    });
    expect(session).not.toHaveProperty("clientSecret");
    expect(session).not.toHaveProperty("offerUrl");
    expect(session.voiceSessionId).toBe("vs-1");
    expect(session.model).toBe("gpt-live-1");
    expect(JSON.stringify(res.body)).not.toContain(GPT_LIVE_MINT.clientSecret);
    // ONE socket: the conversation's. A throwaway operator socket would be a second
    // upgrade — and the call would die with it.
    expect(gw.upgradeCount).toBe(1);
    const create = gw.requests.find((r) => r.method === "talk.client.create");
    expect((create?.params as Record<string, unknown>).sessionKey).toBe(OWNER_KEY);
  });

  test("the offer reaches the gateway's route with the Bearer secret, once", async () => {
    const { route, post } = await boot();
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    const offer = await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0\r\noffer" });
    expect(offer).toEqual({
      status: 200,
      body: { ok: true, answerSdp: "v=0\r\nanswer", status: 201 },
    });
    expect(route.seen).toHaveLength(1);
    // Exactly the gateway's path — no query, the model is bound to the token.
    expect(route.seen[0]!.url).toBe("/plugins/openai/realtime/calls");
    expect(route.seen[0]!.headers.authorization).toBe(`Bearer ${GPT_LIVE_MINT.clientSecret}`);
    expect(route.seen[0]!.headers["content-type"]).toBe("application/sdp");
    expect(route.seen[0]!.body).toBe("v=0\r\noffer");
    // The handle is spent: a replay finds nothing, and the gateway is not asked again.
    const replay = await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" });
    expect(replay).toEqual({
      status: 404,
      body: { ok: false, error: { code: "talk_relay_unknown" } },
    });
    expect(route.seen).toHaveLength(1);
  });

  test("a gateway 401 on the offer surfaces as the retry-able code", async () => {
    const { route, post } = await boot({ ...GPT_LIVE_MINT, clientSecret: "tok_stale" });
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    const offer = await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" });
    expect(offer.status).toBe(502);
    expect(offer.body).toEqual({
      ok: false,
      error: { code: "talk_secret_expired", status: 401 },
    });
    expect(route.seen).toHaveLength(1);
  });

  test("the hangup closes the call on the SAME socket, by the same key", async () => {
    const { gw, post } = await boot();
    await post("/talk-session", OWNER);
    const hang = await post("/talk-hangup", { ...OWNER, voiceSessionId: "vs-1" });
    expect(hang).toEqual({ status: 200, body: { ok: true, closed: "closed" } });
    const close = gw.requests.find((r) => r.method === "talk.client.close");
    expect(close?.params).toEqual({ sessionKey: OWNER_KEY, voiceSessionId: "vs-1" });
    // Still one upgrade: create and close travelled on one connection, which is the
    // ownership the gateway checks ("not owned by this client" otherwise).
    expect(gw.upgradeCount).toBe(1);
  });

  test("a hangup with no live socket is already closed — nothing is sent", async () => {
    // The gateway ends the call with the socket, so there is nothing to close and
    // no reason to open a socket in order to say so.
    const { gw, post } = await boot();
    const hang = await post("/talk-hangup", { ...OWNER, voiceSessionId: "vs-1" });
    expect(hang).toEqual({ status: 200, body: { ok: true, closed: "gone" } });
    expect(gw.requests.some((r) => r.method === "talk.client.close")).toBe(false);
    expect(gw.upgradeCount).toBe(0);
  });

  test("a hangup naming ANOTHER conversation's key does not touch this socket", async () => {
    const { gw, post } = await boot();
    await post("/talk-session", OWNER);
    const hang = await post("/talk-hangup", {
      ...OWNER,
      agentId: "bob",
      voiceSessionId: "vs-1",
    });
    expect(hang.body).toEqual({ ok: true, closed: "gone" });
    expect(gw.requests.some((r) => r.method === "talk.client.close")).toBe(false);
  });

  test("the idle sweeper keeps the socket while the call may be live", async () => {
    let now = 1_000;
    const { post, registry: reg } = await boot(GPT_LIVE_MINT, () => now);
    await mintAndOffer(post);
    // Long past the idle TTL: an ordinary session would be reaped here.
    now += IDLE_SESSION_TTL_SECONDS + 60;
    expect(reg.reapStaleSessions(now)).toBe(0);
    // The hangup releases the hold; the ordinary rule applies again.
    await post("/talk-hangup", { ...OWNER, voiceSessionId: "vs-1" });
    expect(reg.reapStaleSessions(now)).toBe(1);
  });

  test("the 30-minute hold starts when the offer is SPENT, not at the mint", async () => {
    // The gateway arms its call TTL at allocation, i.e. when the offer arrives — up
    // to 60 s after the mint. A hold armed at the mint would reap the socket under a
    // live call for its last minute (codex P2, pass 2).
    let now = 1_000;
    const { post, registry: reg } = await boot(GPT_LIVE_MINT, () => now);
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    now += 59;
    await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" });
    // 30 min + 1 s after the MINT: still inside the call's own TTL, counted from the offer.
    now = 1_000 + 30 * 60 + 1;
    expect(reg.reapStaleSessions(now)).toBe(0);
    // …and past it: bounded.
    now = 1_000 + 59 + 30 * 60 + 1;
    expect(reg.reapStaleSessions(now)).toBe(1);
  });

  test("an offer answered AFTER a hangup does not re-arm the hold", async () => {
    // The offer's HTTP round trip to the gateway can take up to 30 s; a hangup that
    // lands meanwhile releases the pending hold and the gateway closes the call.
    // When the answer finally arrives, re-creating a 30-minute hold would pin the
    // socket for a call that no longer exists (codex P2, pass 3).
    let now = 1_000;
    const { route, post, registry: reg } = await boot(GPT_LIVE_MINT, () => now);
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    const release = route.holdAnswer();
    const offer = post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" });
    // Wait until the gateway route has the request in hand, then hang up.
    while (route.seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    await post("/talk-hangup", { ...OWNER, voiceSessionId: "vs-1" });
    release();
    expect((await offer).status).toBe(200);
    now += IDLE_SESSION_TTL_SECONDS + 60;
    expect(reg.reapStaleSessions(now)).toBe(1);
  });

  test("a mint nobody follows up holds the socket for the OFFER window only", async () => {
    let now = 1_000;
    const { post, registry: reg } = await boot(GPT_LIVE_MINT, () => now);
    await post("/talk-session", OWNER);
    // Past the idle TTL and past the pending-offer hold: no call was ever allocated,
    // so nothing justifies keeping the socket for 30 minutes.
    now += IDLE_SESSION_TTL_SECONDS + 60;
    expect(reg.reapStaleSessions(now)).toBe(1);
  });

  test("a relayed mint with no voiceSessionId is refused — it could never be hung up", async () => {
    const { voiceSessionId: _v, ...noVoice } = GPT_LIVE_MINT;
    const { post } = await boot(noVoice);
    const res = await post("/talk-session", OWNER);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: { code: "talk_malformed" } });
  });

  test("a handle is not spendable through ANOTHER session of the same chat", async () => {
    // A row for agent bob on the same chat passes Convex's own check; it must not
    // reach the secret minted for alice's session.
    const { route, post } = await boot();
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    const other = await post("/talk-offer", { ...OFFER_OWNER, agentId: "bob", relayId, sdp: "v=0" });
    expect(other.status).toBe(404);
    expect(route.seen).toHaveLength(0);
  });

  test("the classic https mint keeps its verbatim lane, headers included", async () => {
    const { gw, post } = await boot(CLASSIC_MINT);
    const res = await post("/talk-session", OWNER);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("relayed");
    expect(res.body.ownerScoped).toBe(true);
    // The browser posts to the provider itself, so it needs the secret, the URL and
    // any headers the provider wants beside them.
    expect(res.body.session).toEqual(CLASSIC_MINT);
    // …and it STILL rides the conversation's socket (one upgrade): a classic
    // session is client-owned, but nothing is lost by minting it where the person is.
    expect(gw.upgradeCount).toBe(1);
  });

  test("an UNSCOPED create that mints a gateway-owned call is refused by name", async () => {
    // An older Convex names no owner. The gateway would still mint GPT Live — on a
    // throwaway socket that closes before the browser can send its offer. Minting a
    // dead call and handing back a handle would be a lie; the code says why.
    const { post } = await boot();
    const res = await post("/talk-session", { instanceName: "primary" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: { code: "talk_owner_required" } });
  });

  test("a handle minted for one chat is not spendable for another chat", async () => {
    // Bob's session on the same gateway does not buy him Alice's call.
    const { route, post } = await boot();
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    const foreign = await post("/talk-offer", {
      ...OFFER_OWNER,
      chatId: "bobs-chat",
      relayId,
      sdp: "v=0",
    });
    expect(foreign).toEqual({
      status: 404,
      body: { ok: false, error: { code: "talk_relay_unknown" } },
    });
    expect(route.seen).toHaveLength(0);
    // Not spent by the refused attempt: the rightful chat can still present it.
    expect(
      (await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" }))
        .status,
    ).toBe(200);
  });

  test("two calls on one socket: hanging up one keeps the other's hold", async () => {
    // The gateway allows two calls per owning socket. One timestamp for both would
    // let the first hangup release the second call's hold and the sweeper reap the
    // socket under a live call (codex P1).
    let now = 1_000;
    const { post, registry: reg } = await boot(
      (nth) => ({ ...GPT_LIVE_MINT, voiceSessionId: `vs-${nth}` }),
      () => now,
    );
    await mintAndOffer(post);
    await mintAndOffer(post);
    await post("/talk-hangup", { ...OWNER, voiceSessionId: "vs-1" });
    now += IDLE_SESSION_TTL_SECONDS + 60;
    expect(reg.reapStaleSessions(now)).toBe(0);
    await post("/talk-hangup", { ...OWNER, voiceSessionId: "vs-2" });
    expect(reg.reapStaleSessions(now)).toBe(1);
  });

  test("switching the chat's agent mid-call ends the call — by name, not silently", async () => {
    // One live socket per chat is the registry's invariant; the gateway binds a GPT
    // Live call to the socket that minted it. The two together mean a re-key ends the
    // call. This test pins that the consequence is STATED in the log, so an operator
    // reading a dropped call finds the cause rather than a mute `rtc_lost`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gw, post, registry: reg } = await boot();
    await post("/talk-session", OWNER);
    expect(gw.upgradeCount).toBe(1);
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc-bound",
      agentId: "bob",
      canonical: "olivier",
      instanceName: "primary",
    });
    expect(gw.upgradeCount).toBe(2);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("gateway-owned voice call was live")),
    ).toBe(true);
  });

  test("a body that parses to null or an array is a 400 on both routes, not a 500", async () => {
    // `JSON.parse("null")` succeeds and the first property read would throw into the
    // global handler's 500 — the announced 400 is the contract (codex P3, pass 4).
    const { post } = await boot();
    const postRaw = async (path: string, raw: string) => {
      const res = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: raw,
      });
      return res.status;
    };
    for (const raw of ["null", "[]", "\"x\""]) {
      expect(await postRaw("/talk-offer", raw), `offer ${raw}`).toBe(400);
      expect(await postRaw("/talk-hangup", raw), `hangup ${raw}`).toBe(400);
    }
    void post;
  });

  test("an over-cap MULTIBYTE offer is refused before the handle is spent", async () => {
    // 200 000 characters pass a UTF-16 bound; 400 000 bytes do not pass the gateway's
    // byte cap. Spending the handle first would turn the corrected retry into a 404.
    const { route, post } = await boot();
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    const big = await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "é".repeat(200_000) });
    expect(big.status).toBe(413);
    expect(route.seen).toHaveLength(0);
    expect((await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" })).status).toBe(200);
  });

  test("an offer for an unknown or foreign instance is refused before any lookup", async () => {
    const { route, post } = await boot();
    const minted = await post("/talk-session", OWNER);
    const relayId = (
      (minted.body.session as Record<string, unknown>).offerRelay as { relayId: string }
    ).relayId;
    expect(
      (await post("/talk-offer", { ...OFFER_OWNER, instanceName: "other", relayId, sdp: "v=0" })).body,
    ).toEqual({ ok: false, error: { code: "instance_not_served" } });
    expect((await post("/talk-offer", { ...OFFER_OWNER, sdp: "v=0" })).status).toBe(
      400,
    );
    expect(route.seen).toHaveLength(0);
    // The failed attempts did not spend the handle.
    expect(
      (await post("/talk-offer", { ...OFFER_OWNER, relayId, sdp: "v=0" })).status,
    ).toBe(200);
  });
});
