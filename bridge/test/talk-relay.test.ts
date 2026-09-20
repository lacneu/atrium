// THE SDP OFFER RELAY, pure.
//
// On OpenClaw >= 2026.9.5 the default realtime voice model is GPT Live, whose mint
// carries a GATEWAY-RELATIVE offer path (`/plugins/openai/realtime/calls`) instead
// of an https URL at the provider. The browser cannot reach the gateway in Atrium's
// deployment, so the bridge presents the offer for it — with the secret the bridge
// kept. These tests pin what the relay promises: the secret never leaves this
// process, a handle is spent exactly once, and the gateway's own limits are honoured
// by value (the same numbers the upstream tag declares).
import { describe, expect, test, vi } from "vitest";
import {
  TALK_DIRECT_HOLD_MS,
  TALK_OFFER_MAX_SDP_BYTES,
  TALK_PENDING_HOLD_MS,
  TALK_RELAY_TTL_MS,
  TalkRelayRegistry,
  isGatewayRelativeOffer,
  relayTalkOffer,
} from "../src/core/talk-relay.js";

const ENTRY = {
  instanceName: "primary",
  chatId: "c1",
  sessionKey: "agent:alice:atrium:chat:olivier:c1",
  voiceSessionId: "vs-1",
  clientSecret: "tok_secret",
  offerPath: "/plugins/openai/realtime/calls",
  gatewayHttpBase: "http://gw.test:18789",
};

describe("the two mint holds are each sized to their OWN hazard", () => {
  test("the pending hold outlives the relay handle it waits for", () => {
    // It covers the gap between a mint and its offer, and that gap cannot outlast the
    // handle: once the relay id expires the browser has lost the call anyway. A hold
    // shorter than the handle would cut calls whose offer was still legitimately
    // coming.
    expect(TALK_PENDING_HOLD_MS).toBeGreaterThan(TALK_RELAY_TTL_MS);
  });

  test("the DIRECT hold is the longer one — nothing bounds its gap but the send", () => {
    // The direct lane has no offer step, so there is no handle expiry to lean on:
    // only the send's own deadline bounds how late a dispatch can arrive (asserted
    // against `SEND_POST_TIMEOUT_MS` in the routing-wiring suite). Pinned as an
    // ORDER so a future reader "harmonising" the two cannot quietly shorten it.
    expect(TALK_DIRECT_HOLD_MS).toBeGreaterThan(TALK_PENDING_HOLD_MS);
  });
});

describe("isGatewayRelativeOffer", () => {
  test("an absolute path is the gateway's own route", () => {
    expect(isGatewayRelativeOffer("/plugins/openai/realtime/calls")).toBe(true);
  });
  test("an https URL is the provider's endpoint — the browser goes direct", () => {
    expect(isGatewayRelativeOffer("https://api.openai.com/v1/realtime/calls")).toBe(false);
  });
  test("a scheme-relative URL is NOT a path on the gateway", () => {
    // `//evil.example/calls` would resolve to another host: refused as relative.
    expect(isGatewayRelativeOffer("//evil.example/calls")).toBe(false);
  });
  test("anything that is not a string is not an offer", () => {
    expect(isGatewayRelativeOffer(undefined)).toBe(false);
    expect(isGatewayRelativeOffer(42)).toBe(false);
    expect(isGatewayRelativeOffer("")).toBe(false);
  });
});

describe("TalkRelayRegistry — one handle, one offer", () => {
  test("a handle is spent on first use; the second use finds nothing", () => {
    const registry = new TalkRelayRegistry(() => 1_000);
    const issued = registry.issue(ENTRY);
    expect(issued.relayId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(registry.take(issued.relayId, "primary", "c1", ENTRY.sessionKey)?.clientSecret).toBe("tok_secret");
    expect(registry.take(issued.relayId, "primary", "c1", ENTRY.sessionKey)).toBeNull();
  });

  test("the handle expires with the gateway's 60 s pending-offer window", () => {
    let now = 1_000;
    const registry = new TalkRelayRegistry(() => now);
    const issued = registry.issue(ENTRY);
    expect(issued.expiresAtMs).toBe(1_000 + TALK_RELAY_TTL_MS);
    now = issued.expiresAtMs; // exactly at expiry: gone
    expect(registry.take(issued.relayId, "primary", "c1", ENTRY.sessionKey)).toBeNull();
  });

  test("the mint's own expiresAt wins when the gateway states one", () => {
    const registry = new TalkRelayRegistry(() => 1_000);
    const issued = registry.issue({ ...ENTRY, expiresAtMs: 5_000 });
    expect(issued.expiresAtMs).toBe(5_000);
  });

  test("a handle issued for one instance cannot be spent through another", () => {
    // The instance selects the gateway the offer goes to. A handle minted on
    // gateway A presented under instance B would post A's secret to B.
    const registry = new TalkRelayRegistry(() => 1_000);
    const issued = registry.issue(ENTRY);
    expect(registry.take(issued.relayId, "other", "c1", ENTRY.sessionKey)).toBeNull();
    // …and the failed attempt did NOT spend it.
    expect(registry.take(issued.relayId, "primary", "c1", ENTRY.sessionKey)).not.toBeNull();
  });

  test("a handle issued for one chat cannot be spent for another chat's session", () => {
    // Convex proves the caller owns a session on ONE chat. Two people on the same
    // gateway share the instance, not each other's calls: a handle that leaked from
    // Alice's browser, presented by Bob with his own (valid) session, must not reach
    // Alice's secret (codex P1, 2026-09-19).
    const registry = new TalkRelayRegistry(() => 1_000);
    const issued = registry.issue(ENTRY);
    expect(registry.take(issued.relayId, "primary", "bobs-chat", ENTRY.sessionKey)).toBeNull();
    // …and the failed attempt did NOT spend it.
    expect(registry.take(issued.relayId, "primary", "c1", ENTRY.sessionKey)).not.toBeNull();
  });

  test("a handle is bound to its SESSION, not just its chat", () => {
    // Same chat, another agent's session (an older row of the same person): the
    // handle minted for a since-revoked agent must not be spendable through it
    // (codex P1, pass 2).
    const registry = new TalkRelayRegistry(() => 1_000);
    const issued = registry.issue(ENTRY);
    expect(
      registry.take(issued.relayId, "primary", "c1", "agent:bob:atrium:chat:olivier:c1"),
    ).toBeNull();
    expect(registry.take(issued.relayId, "primary", "c1", ENTRY.sessionKey)).not.toBeNull();
  });

  test("expired handles do not accumulate", () => {
    let now = 0;
    const registry = new TalkRelayRegistry(() => now);
    for (let i = 0; i < 5; i += 1) registry.issue(ENTRY);
    expect(registry.size).toBe(5);
    now = TALK_RELAY_TTL_MS + 1;
    expect(registry.size).toBe(0);
  });
});

describe("relayTalkOffer — the browser's offer, presented by the bridge", () => {
  test("POSTs the SDP to the gateway's route with the Bearer secret, no query", async () => {
    const fetchImpl = vi.fn(async () => new Response("v=0\r\nanswer", { status: 201 }));
    const res = await relayTalkOffer(ENTRY, "v=0\r\noffer", fetchImpl as typeof fetch);
    expect(res).toEqual({ ok: true, status: 201, answerSdp: "v=0\r\nanswer" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The gateway's route matcher compares the PATHNAME and its handler binds the
    // model to the token: a `?model=` here would be noise at best.
    expect(url).toBe("http://gw.test:18789/plugins/openai/realtime/calls");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer tok_secret",
      "Content-Type": "application/sdp",
    });
    expect(init.body).toBe("v=0\r\noffer");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a 401 is the spent/expired token — the code the browser retries on", async () => {
    const fetchImpl = vi.fn(async () => new Response("Invalid or expired", { status: 401 }));
    expect(await relayTalkOffer(ENTRY, "v=0", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "talk_secret_expired",
      status: 401,
    });
  });

  test("any other refusal keeps its status in the code", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 415 }));
    expect(await relayTalkOffer(ENTRY, "v=0", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_415",
      status: 415,
    });
  });

  test("an empty answer is a failure, not a silent success", async () => {
    const fetchImpl = vi.fn(async () => new Response("   ", { status: 200 }));
    expect(await relayTalkOffer(ENTRY, "v=0", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_empty",
      status: 200,
    });
  });

  test("a gateway that cannot be reached is named, never thrown", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await relayTalkOffer(ENTRY, "v=0", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_unreachable",
    });
  });

  test("an offer over the gateway's 256 KiB cap is refused BEFORE it is sent", async () => {
    // The gateway would reject it too (readRequestBodyWithLimit) — but only after
    // spending the single-use token. Refusing here keeps the token usable.
    const fetchImpl = vi.fn();
    const big = "a".repeat(TALK_OFFER_MAX_SDP_BYTES + 1);
    expect(await relayTalkOffer(ENTRY, big, fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a blank offer is refused before it is sent, for the same reason", async () => {
    const fetchImpl = vi.fn();
    expect(await relayTalkOffer(ENTRY, "  \n", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_empty_offer",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
