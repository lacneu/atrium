// OPENCLAW_MEDIA_MODE + the gateway HTTP base derivation. Pins the load-bearing
// product decision: the outbound-media mode DEFAULTS to "gateway-http" (no shared
// filesystem needed), and "shared-fs" is strictly OPT-IN.

import { describe, it, expect } from "vitest";
import {
  loadConfig,
  loadSharedConfig,
  buildInstanceConfig,
  findMediaDirCollision,
  deriveHttpBase,
  mediaInstanceSegment,
  ConfigError,
} from "../src/config.js";

const sharedEnv = {
  CONVEX_HTTP_ACTIONS_URL: "http://convex.invalid",
  BRIDGE_INGEST_SECRET: "i",
  BRIDGE_SHARED_SECRET: "s",
  BRIDGE_INSTANCE_SECRETS: "sec",
} as NodeJS.ProcessEnv;
const inst = {
  instanceName: "olivier",
  gatewayUrl: "ws://gw:18790",
  token: "t",
  deviceIdentity: { id: "d", publicKey: "p", privateKey: "k" },
  gatewayVersion: null,
  gatewayHttpUrl: null,
  kind: "openclaw" as const,
};

describe("buildInstanceConfig: media dir derivation + overrides", () => {
  it("derives per-instance dirs from the instance name (no override)", () => {
    const c = buildInstanceConfig(loadSharedConfig({ ...sharedEnv }), inst);
    expect(c.mediaOutboundDir).toBe("/home/node/.openclaw/media/olivier/outbound");
    expect(c.inboundMediaDir).toBe("/home/node/.openclaw/media/olivier/inbound");
  });

  it("an explicit OPENCLAW_MEDIA_OUTBOUND_DIR / OPENCLAW_INBOUND_DIR override WINS (Helm bridge.media.enabled)", () => {
    // Regression guard (codex P2): without honoring the override the bridge would
    // scan/write the derived path, NOT the mounted one -> shared-fs breaks.
    const shared = loadSharedConfig({
      ...sharedEnv,
      OPENCLAW_MEDIA_OUTBOUND_DIR: "/mnt/out",
      OPENCLAW_INBOUND_DIR: "/mnt/in",
    });
    const c = buildInstanceConfig(shared, inst);
    expect(c.mediaOutboundDir).toBe("/mnt/out");
    expect(c.inboundMediaDir).toBe("/mnt/in");
  });
});

describe("loadSharedConfig: fatal env boundary (the boot invariant) + retry knob", () => {
  const without = (key: string): NodeJS.ProcessEnv => {
    const e = { ...sharedEnv };
    delete e[key];
    return e;
  };

  it("THROWS when a bridge-wiring env is missing (these are env-only + cannot self-heal)", () => {
    // The deliberate FATAL boundary: CONVEX_HTTP_ACTIONS_URL / ingest+shared secrets are
    // read once from env and the bridge truly cannot function without them. A regression
    // making one optional would turn a loud crash into a silently-idle bridge that looks
    // healthy while serving nothing — strictly worse than the crash. Guard it.
    expect(() => loadSharedConfig(without("CONVEX_HTTP_ACTIONS_URL"))).toThrow(
      ConfigError,
    );
    expect(() => loadSharedConfig(without("BRIDGE_INGEST_SECRET"))).toThrow(
      ConfigError,
    );
    expect(() => loadSharedConfig(without("BRIDGE_SHARED_SECRET"))).toThrow(
      ConfigError,
    );
  });

  it("does NOT throw when BRIDGE_INSTANCE_SECRETS is empty (instances are NON-fatal — boot + self-heal)", () => {
    // The other side of the boundary: an unconfigured instance must NEVER block boot.
    const shared = loadSharedConfig(without("BRIDGE_INSTANCE_SECRETS"));
    expect(shared.bridgeInstanceSecrets).toEqual([]);
  });

  it("credentialRetryMs defaults to 30s and is floored at 5s", () => {
    expect(loadSharedConfig({ ...sharedEnv }).credentialRetryMs).toBe(30_000);
    // Floor: a too-small value would hammer a slow Convex.
    expect(
      loadSharedConfig({ ...sharedEnv, BRIDGE_CREDENTIAL_RETRY_MS: "1000" })
        .credentialRetryMs,
    ).toBe(5_000);
    expect(
      loadSharedConfig({ ...sharedEnv, BRIDGE_CREDENTIAL_RETRY_MS: "60000" })
        .credentialRetryMs,
    ).toBe(60_000);
  });
});

describe("findMediaDirCollision (boot guard, codex P2)", () => {
  const ic = (instanceName: string, out: string, inb: string) => ({
    instanceName,
    mediaOutboundDir: out,
    inboundMediaDir: inb,
  });

  it("distinct per-instance dirs -> no collision", () => {
    expect(
      findMediaDirCollision([
        ic("olivier", "/m/olivier/out", "/m/olivier/in"),
        ic("jerome", "/m/jerome/out", "/m/jerome/in"),
      ]),
    ).toBeNull();
  });

  it("a single dir override applied to MANY instances collides", () => {
    // Both instances got OPENCLAW_MEDIA_OUTBOUND_DIR=/mnt/out -> same outbound dir.
    const c = findMediaDirCollision([
      ic("olivier", "/mnt/out", "/m/olivier/in"),
      ic("jerome", "/mnt/out", "/m/jerome/in"),
    ]);
    expect(c?.dir).toBe("/mnt/out");
    expect([c?.a, c?.b]).toContain("olivier/outbound");
    expect([c?.a, c?.b]).toContain("jerome/outbound");
  });

  it("two instance names normalizing to the SAME segment collide", () => {
    // mediaInstanceSegment maps both "a/b" and "a_b" -> "a_b".
    const seg = mediaInstanceSegment("a/b");
    expect(seg).toBe(mediaInstanceSegment("a_b"));
    const dir = `/home/node/.openclaw/media/${seg}/outbound`;
    expect(
      findMediaDirCollision([
        ic("a/b", dir, "/x/in1"),
        ic("a_b", dir, "/x/in2"),
      ]),
    ).not.toBeNull();
  });
});

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

describe("mediaInstanceSegment", () => {
  it("keeps a safe name verbatim", () => {
    expect(mediaInstanceSegment("olivier")).toBe("olivier");
    expect(mediaInstanceSegment("agent-1.beta_2")).toBe("agent-1.beta_2");
  });

  it("returns null for empty/unset so the caller falls back to the flat path", () => {
    expect(mediaInstanceSegment(null)).toBeNull();
    expect(mediaInstanceSegment("")).toBeNull();
    expect(mediaInstanceSegment("   ")).toBeNull();
  });

  it("never widens beyond ONE segment (path-traversal defense)", () => {
    // A `/`, `\` or `..` must NOT become a deeper/parent dir in the mount path.
    expect(mediaInstanceSegment("a/b")).toBe("a_b");
    expect(mediaInstanceSegment("../etc")).toBe(".._etc");
    expect(mediaInstanceSegment("..")).toBeNull();
    expect(mediaInstanceSegment(".")).toBeNull();
    expect(mediaInstanceSegment("x/../y")).toBe("x_.._y");
  });
});

describe("loadConfig: per-instance media dirs (the bridge's own mount)", () => {
  it("DEFAULTS the bridge dirs to an instance-keyed subdir; agent-mounts stay FLAT", () => {
    const c = loadConfig({ ...baseEnv, OPENCLAW_INSTANCE_NAME: "olivier" });
    // The bridge reads/writes under the per-instance subdir (Model M isolation).
    expect(c.mediaOutboundDir).toBe("/home/node/.openclaw/media/olivier/outbound");
    expect(c.inboundMediaDir).toBe("/home/node/.openclaw/media/olivier/inbound");
    // The AGENT-visible mounts MUST stay flat (the gateway path the agent
    // writes/reads + the openclaw.json allowReadPaths whitelist).
    expect(c.mediaOutboundAgentMount).toBe("/home/node/.openclaw/media/outbound");
    expect(c.inboundAgentMount).toBe("/home/node/.openclaw/media/inbound");
  });

  it("falls back to the FLAT bridge dirs when no instance name (co-located dev)", () => {
    const c = loadConfig({ ...baseEnv });
    expect(c.instanceName).toBeNull();
    expect(c.mediaOutboundDir).toBe("/home/node/.openclaw/media/outbound");
    expect(c.inboundMediaDir).toBe("/home/node/.openclaw/media/inbound");
  });

  it("explicit OPENCLAW_MEDIA_OUTBOUND_DIR / OPENCLAW_INBOUND_DIR override the keyed default", () => {
    const c = loadConfig({
      ...baseEnv,
      OPENCLAW_INSTANCE_NAME: "olivier",
      OPENCLAW_MEDIA_OUTBOUND_DIR: "/srv/out",
      OPENCLAW_INBOUND_DIR: "/srv/in",
    });
    expect(c.mediaOutboundDir).toBe("/srv/out"); // not /media/olivier/outbound
    expect(c.inboundMediaDir).toBe("/srv/in");
  });

  it("sanitizes an unsafe instance name into ONE segment (no path traversal in the mount)", () => {
    const c = loadConfig({ ...baseEnv, OPENCLAW_INSTANCE_NAME: "a/b" });
    expect(c.mediaOutboundDir).toBe("/home/node/.openclaw/media/a_b/outbound");
  });
});
