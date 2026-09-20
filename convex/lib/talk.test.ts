import { describe, expect, it } from "vitest";
import { parseTalkSessionResponse } from "./talk";

// The VERBATIM mint shape probed live on OpenClaw 2026.7.1 (2026-07-16),
// secret value swapped for an obvious fake. The DIRECT lane: a classic realtime
// model, the browser posts its offer to the provider itself.
const LIVE_MINT = {
  session: {
    provider: "openai",
    transport: "webrtc",
    clientSecret: "ek_test_0000000000000000000000000000",
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    model: "gpt-realtime-2.1",
    voice: "alloy",
    expiresAt: 1784221612000,
  },
};

// The RELAYED lane, as the bridge answers a GPT Live mint on OpenClaw 2026.9.5
// (bench 2026-09-19): the gateway's offer path is kept on the bridge, the browser
// gets an opaque handle, and NO secret.
const RELAYED_MINT = {
  session: {
    provider: "openai",
    transport: "webrtc",
    offerRelay: { relayId: "r_0123456789abcdef0123456789abcdef", expiresAt: 1789837061821 },
    offerResponseMaxBytes: 262144,
    model: "gpt-live-1",
    voice: "marin",
    expiresAt: 1789837061821,
    voiceSessionId: "58482d37-7cdb-4fd0-bb8d-78b1e3ce28da",
  },
  ownerScoped: true,
  relayed: true,
};

describe("parseTalkSessionResponse — the direct lane", () => {
  it("accepts the live-probed 2026.7.1 mint shape verbatim", () => {
    expect(parseTalkSessionResponse(LIVE_MINT)).toEqual({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "ek_test_0000000000000000000000000000",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
      offerHeaders: {},
      offerRelay: null,
      model: "gpt-realtime-2.1",
      voice: "alloy",
      expiresAt: 1784221612000,
      voiceSessionId: null,
    });
  });

  it("rejects a missing/empty clientSecret (the load-bearing credential)", () => {
    const noSecret = { session: { ...LIVE_MINT.session, clientSecret: "" } };
    expect(parseTalkSessionResponse(noSecret)).toBeNull();
    const { clientSecret: _cs, ...rest } = LIVE_MINT.session;
    expect(parseTalkSessionResponse({ session: rest })).toBeNull();
  });

  it("rejects a non-https offerUrl (the browser would POST its SDP there)", () => {
    const http = {
      session: { ...LIVE_MINT.session, offerUrl: "http://evil.example/calls" },
    };
    expect(parseTalkSessionResponse(http)).toBeNull();
    const missing = { session: { ...LIVE_MINT.session, offerUrl: undefined } };
    expect(parseTalkSessionResponse(missing)).toBeNull();
    // A gateway-relative path on the DIRECT lane is the 2026.9.5 GPT Live shape
    // reaching a bridge that does not relay: refused, never handed to a browser.
    const relative = {
      session: { ...LIVE_MINT.session, offerUrl: "/plugins/openai/realtime/calls" },
    };
    expect(parseTalkSessionResponse(relative)).toBeNull();
  });

  it("carries the provider's extra offer headers, strings only", () => {
    const withHeaders = {
      session: {
        ...LIVE_MINT.session,
        offerHeaders: { "OpenAI-Beta": "realtime=v1", junk: 42 },
        voiceSessionId: "vs-9",
      },
    };
    expect(parseTalkSessionResponse(withHeaders)).toMatchObject({
      offerHeaders: { "OpenAI-Beta": "realtime=v1" },
      voiceSessionId: "vs-9",
    });
  });

  it("tolerates absent descriptive fields (nulls, not rejection)", () => {
    const minimal = {
      session: {
        clientSecret: "ek_x",
        offerUrl: "https://api.openai.com/v1/realtime/calls",
      },
    };
    expect(parseTalkSessionResponse(minimal)).toEqual({
      provider: "",
      transport: "",
      clientSecret: "ek_x",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
      offerHeaders: {},
      offerRelay: null,
      model: null,
      voice: null,
      expiresAt: null,
      voiceSessionId: null,
    });
  });

  it("rejects non-object bodies outright", () => {
    expect(parseTalkSessionResponse(null)).toBeNull();
    expect(parseTalkSessionResponse({})).toBeNull();
    expect(parseTalkSessionResponse({ session: "nope" })).toBeNull();
    expect(parseTalkSessionResponse({ session: null })).toBeNull();
  });
});

describe("parseTalkSessionResponse — the relayed lane (GPT Live)", () => {
  it("accepts the bridge's relayed shape: a handle, no secret, no URL", () => {
    expect(parseTalkSessionResponse(RELAYED_MINT)).toEqual({
      provider: "openai",
      transport: "webrtc",
      clientSecret: null,
      offerUrl: null,
      offerHeaders: {},
      offerRelay: {
        relayId: "r_0123456789abcdef0123456789abcdef",
        expiresAt: 1789837061821,
      },
      model: "gpt-live-1",
      voice: "marin",
      expiresAt: 1789837061821,
      voiceSessionId: "58482d37-7cdb-4fd0-bb8d-78b1e3ce28da",
    });
  });

  it("refuses a relayed session that STILL carries a secret or a URL", () => {
    // The lane's whole guarantee is that the secret stayed on the bridge. A body
    // that has both is a bridge that relayed AND leaked; refuse rather than pick.
    expect(
      parseTalkSessionResponse({
        session: { ...RELAYED_MINT.session, clientSecret: "tok_leaked" },
      }),
    ).toBeNull();
    expect(
      parseTalkSessionResponse({
        session: { ...RELAYED_MINT.session, offerUrl: "/plugins/openai/realtime/calls" },
      }),
    ).toBeNull();
  });

  it("refuses an empty or malformed handle", () => {
    for (const offerRelay of [null, "r_x", {}, { relayId: "" }, { relayId: 7 }]) {
      expect(
        parseTalkSessionResponse({ session: { ...RELAYED_MINT.session, offerRelay } }),
        JSON.stringify(offerRelay),
      ).toBeNull();
    }
  });

  it("a relayed session without a voiceSessionId is refused", () => {
    // It is what the hangup closes by; the vendored WebRTC mint requires it.
    const { voiceSessionId: _v, ...session } = RELAYED_MINT.session;
    expect(parseTalkSessionResponse({ session })).toBeNull();
  });

  it("a handle without an expiry is still a handle", () => {
    expect(
      parseTalkSessionResponse({
        session: { ...RELAYED_MINT.session, offerRelay: { relayId: "r_only" } },
      }),
    ).toMatchObject({ offerRelay: { relayId: "r_only", expiresAt: null } });
  });
});
