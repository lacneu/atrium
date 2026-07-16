// The per-instance config validator/resolver/signature. Each test FAILS if its
// target regresses: a loosened allowlist, a dropped bound, a wrong default, or a
// non-discriminating signature.

import { describe, expect, test } from "vitest";
import {
  DEFAULT_INSTANCE_CONFIG,
  configSignature,
  isValidAgentMountPath,
  parseInstanceConfig,
  resolveInstanceConfig,
} from "./instanceConfig";

describe("isValidAgentMountPath", () => {
  test("accepts an absolute container path", () => {
    expect(isValidAgentMountPath("/home/node/.openclaw/media/inbound")).toBe(true);
    expect(isValidAgentMountPath("  /a/b  ")).toBe(true); // trimmed
  });
  test("rejects relative, empty, traversal, and over-long paths", () => {
    expect(isValidAgentMountPath("relative/x")).toBe(false);
    expect(isValidAgentMountPath("")).toBe(false);
    expect(isValidAgentMountPath("/a/../b")).toBe(false); // traversal
    expect(isValidAgentMountPath("/" + "a".repeat(600))).toBe(false); // too long
  });
});

describe("parseInstanceConfig", () => {
  test("undefined / null is a valid 'no override' (returns {})", () => {
    expect(parseInstanceConfig(undefined)).toEqual({});
    expect(parseInstanceConfig(null)).toEqual({});
  });

  test("a complete valid config passes through unchanged", () => {
    const cfg = {
      mediaMode: "shared-fs",
      inboundMediaMode: "shared-fs",
      rehydration: false,
      mediaMaxMb: 200,
    };
    expect(parseInstanceConfig(cfg)).toEqual(cfg);
  });

  test("an UNKNOWN key rejects the WHOLE config (never a silent drop)", () => {
    expect(parseInstanceConfig({ mediaMode: "off", bogus: 1 })).toBe("invalid");
  });

  test("converterAgentId round-trips (the 0.45 ConverterCard save bug: the key was missing from the parse allowlist)", () => {
    expect(parseInstanceConfig({ converterAgentId: "files" })).toEqual({
      converterAgentId: "files",
    });
    expect(parseInstanceConfig({ converterAgentId: "  files  " })).toEqual({
      converterAgentId: "files",
    });
    // "none" is expressed by DELETING the key — an empty string is a caller bug.
    expect(parseInstanceConfig({ converterAgentId: "" })).toBe("invalid");
    expect(parseInstanceConfig({ converterAgentId: 7 })).toBe("invalid");
    expect(
      parseInstanceConfig({ converterAgentId: "x".repeat(129) }),
    ).toBe("invalid");
  });

  test("a bad enum is invalid (mediaMode / inboundMediaMode)", () => {
    expect(parseInstanceConfig({ mediaMode: "ftp" })).toBe("invalid");
    expect(parseInstanceConfig({ inboundMediaMode: "stream" })).toBe("invalid");
  });

  test("rehydration must be boolean", () => {
    expect(parseInstanceConfig({ rehydration: "yes" })).toBe("invalid");
  });

  test("mediaMaxMb must be an integer within bounds", () => {
    expect(parseInstanceConfig({ mediaMaxMb: 0 })).toBe("invalid"); // below min
    expect(parseInstanceConfig({ mediaMaxMb: 4097 })).toBe("invalid"); // above max
    expect(parseInstanceConfig({ mediaMaxMb: 1.5 })).toBe("invalid"); // non-integer
    expect(parseInstanceConfig({ mediaMaxMb: 1 })).toEqual({ mediaMaxMb: 1 });
    expect(parseInstanceConfig({ mediaMaxMb: 4096 })).toEqual({ mediaMaxMb: 4096 });
  });

  test("a non-object (array / string) is invalid", () => {
    expect(parseInstanceConfig(["x"])).toBe("invalid");
    expect(parseInstanceConfig("x")).toBe("invalid");
  });

  test("agent-mount paths: absolute accepted, relative/traversal rejected", () => {
    expect(
      parseInstanceConfig({ outboundAgentMount: "/home/node/.openclaw/media/outbound" }),
    ).toEqual({ outboundAgentMount: "/home/node/.openclaw/media/outbound" });
    expect(parseInstanceConfig({ inboundAgentMount: "relative/x" })).toBe("invalid");
    expect(parseInstanceConfig({ outboundAgentMount: "/a/../b" })).toBe("invalid");
  });
});

describe("resolveInstanceConfig", () => {
  test("fills EVERY field from defaults when empty", () => {
    expect(resolveInstanceConfig({})).toEqual(DEFAULT_INSTANCE_CONFIG);
    expect(resolveInstanceConfig(undefined)).toEqual(DEFAULT_INSTANCE_CONFIG);
  });

  test("overrides win, untouched fields keep defaults", () => {
    expect(resolveInstanceConfig({ mediaMode: "shared-fs" })).toEqual({
      ...DEFAULT_INSTANCE_CONFIG,
      mediaMode: "shared-fs",
    });
  });

  test("the default IS the legacy env behaviour (gateway-http / inline / rehydrate on / 1024)", () => {
    expect(DEFAULT_INSTANCE_CONFIG).toEqual({
      mediaMode: "gateway-http",
      inboundMediaMode: "inline",
      rehydration: true,
      mediaMaxMb: 1024,
      inboundAgentMount: "/home/node/.openclaw/media/inbound",
      outboundAgentMount: "/home/node/.openclaw/media/outbound",
    });
  });
});

describe("configSignature", () => {
  test("equal configs share a signature; any field change diverges it", () => {
    const a = resolveInstanceConfig({ mediaMode: "shared-fs" });
    const b = resolveInstanceConfig({ mediaMode: "shared-fs" });
    expect(configSignature(a)).toBe(configSignature(b));
    expect(configSignature(a)).not.toBe(
      configSignature(resolveInstanceConfig({ mediaMode: "off" })),
    );
    expect(configSignature(a)).not.toBe(
      configSignature(resolveInstanceConfig({ mediaMode: "shared-fs", mediaMaxMb: 5 })),
    );
  });
});

describe("parseInstanceConfig — talkEnabled (per-instance realtime voice gate)", () => {
  test("accepts a boolean, rejects anything else (the checkbox regression guard)", () => {
    // The exact shape the Voice > Talk card writes (spread of existing config
    // + the flag) — this was rejected as "Invalid instance config" before the
    // allowlist knew the key (live repro 2026-07-16).
    expect(parseInstanceConfig({ talkEnabled: true })).toMatchObject({
      talkEnabled: true,
    });
    expect(parseInstanceConfig({ voiceEnabled: true, talkEnabled: false })).toMatchObject(
      { talkEnabled: false },
    );
    expect(parseInstanceConfig({ talkEnabled: "yes" })).toBe("invalid");
    expect(parseInstanceConfig({ talkEnabled: 1 })).toBe("invalid");
  });
});
