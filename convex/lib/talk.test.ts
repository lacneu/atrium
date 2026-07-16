import { describe, expect, it } from "vitest";
import {
  normalizeTalkTransport,
  parseTalkSessionResponse,
} from "./talk";

// The VERBATIM mint shape probed live on OpenClaw 2026.7.1 (2026-07-16),
// secret value swapped for an obvious fake.
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

describe("parseTalkSessionResponse (bridge /talk-session projection)", () => {
  it("accepts the live-probed 2026.7.1 mint shape verbatim", () => {
    expect(parseTalkSessionResponse(LIVE_MINT)).toEqual({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "ek_test_0000000000000000000000000000",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
      model: "gpt-realtime-2.1",
      voice: "alloy",
      expiresAt: 1784221612000,
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
      model: null,
      voice: null,
      expiresAt: null,
    });
  });

  it("rejects non-object bodies outright", () => {
    expect(parseTalkSessionResponse(null)).toBeNull();
    expect(parseTalkSessionResponse({})).toBeNull();
    expect(parseTalkSessionResponse({ session: "nope" })).toBeNull();
    expect(parseTalkSessionResponse({ session: null })).toBeNull();
  });
});

describe("normalizeTalkTransport", () => {
  it("passes known transports through and defaults everything else to webrtc", () => {
    expect(normalizeTalkTransport("webrtc")).toBe("webrtc");
    expect(normalizeTalkTransport("provider-websocket")).toBe("provider-websocket");
    expect(normalizeTalkTransport("gateway-relay")).toBe("gateway-relay");
    expect(normalizeTalkTransport("managed-room")).toBe("webrtc"); // catalog-only, unverified
    expect(normalizeTalkTransport("")).toBe("webrtc");
    expect(normalizeTalkTransport(null)).toBe("webrtc");
    expect(normalizeTalkTransport(undefined)).toBe("webrtc");
  });
});
