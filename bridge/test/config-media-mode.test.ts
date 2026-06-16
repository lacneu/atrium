// OPENCLAW_MEDIA_MODE + the gateway HTTP base derivation. Pins the load-bearing
// product decision: the outbound-media mode DEFAULTS to "gateway-http" (no shared
// filesystem needed), and "shared-fs" is strictly OPT-IN.

import { describe, it, expect } from "vitest";
import { loadConfig, deriveHttpBase, ConfigError } from "../src/config.js";

const baseEnv = {
  OPENCLAW_GATEWAY_URL: "ws://gw.invalid:18790",
  OPENCLAW_TOKEN: "tkn",
  OPENCLAW_DEVICE_IDENTITY: JSON.stringify({
    id: "d",
    publicKey: "p",
    privateKey: "k",
  }),
  CONVEX_HTTP_ACTIONS_URL: "http://convex.invalid",
  BRIDGE_INGEST_SECRET: "i",
  BRIDGE_SHARED_SECRET: "s",
} as NodeJS.ProcessEnv;

describe("deriveHttpBase", () => {
  it("maps ws/wss/http/https/bare to an HTTP origin (same host:port), trims slash", () => {
    expect(deriveHttpBase("ws://h:18790")).toBe("http://h:18790"); // non-default port KEPT
    expect(deriveHttpBase("wss://h:443")).toBe("https://h"); // 443 is the https default -> dropped (equivalent)
    expect(deriveHttpBase("http://h:1/")).toBe("http://h:1");
    expect(deriveHttpBase("https://h")).toBe("https://h");
    expect(deriveHttpBase("h:18790")).toBe("http://h:18790"); // bare host:port
  });

  it("drops any path/query/fragment — the media route is served at the ROOT", () => {
    // A WS url carrying a path must NOT leak into the HTTP base, else the fetcher
    // would hit `…/openclaw/__openclaw__/assistant-media` and 404.
    expect(deriveHttpBase("wss://gw.example.com/openclaw")).toBe(
      "https://gw.example.com",
    );
    expect(deriveHttpBase("ws://h:18790/path/sub?q=1#frag")).toBe(
      "http://h:18790",
    );
    expect(deriveHttpBase("https://gw.example.com:8443/base/")).toBe(
      "https://gw.example.com:8443",
    );
  });
});

describe("loadConfig: outbound media mode", () => {
  it("DEFAULTS to gateway-http with the HTTP base derived from the WS url", () => {
    const c = loadConfig({ ...baseEnv });
    expect(c.mediaMode).toBe("gateway-http");
    expect(c.gatewayHttpBase).toBe("http://gw.invalid:18790");
  });

  it("shared-fs and off are OPT-IN via OPENCLAW_MEDIA_MODE (case-insensitive)", () => {
    expect(
      loadConfig({ ...baseEnv, OPENCLAW_MEDIA_MODE: "shared-fs" }).mediaMode,
    ).toBe("shared-fs");
    expect(loadConfig({ ...baseEnv, OPENCLAW_MEDIA_MODE: "off" }).mediaMode).toBe(
      "off",
    );
    expect(
      loadConfig({ ...baseEnv, OPENCLAW_MEDIA_MODE: "GATEWAY-HTTP" }).mediaMode,
    ).toBe("gateway-http");
  });

  it("REJECTS an unknown mode (fail-fast, not a silent default)", () => {
    expect(() =>
      loadConfig({ ...baseEnv, OPENCLAW_MEDIA_MODE: "ftp" }),
    ).toThrow(ConfigError);
  });

  it("OPENCLAW_GATEWAY_HTTP_URL overrides the derived base (HTTP elsewhere)", () => {
    const c = loadConfig({
      ...baseEnv,
      OPENCLAW_GATEWAY_HTTP_URL: "https://media.example:9443",
    });
    expect(c.gatewayHttpBase).toBe("https://media.example:9443");
  });
});
