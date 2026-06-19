// The bridge's defensive parse of the in-band per-instance `config` (D-B). It is
// a robustness backstop (Convex already validated), so it is LENIENT: a bad field
// is dropped, a non-object yields null — it must NEVER throw and NEVER fail a send.

import { describe, it, expect } from "vitest";
import { parseInboundConfig } from "../src/core/instance-config.js";

describe("parseInboundConfig", () => {
  it("returns null for absent / non-object input (→ caller uses env defaults)", () => {
    expect(parseInboundConfig(undefined)).toBeNull();
    expect(parseInboundConfig(null)).toBeNull();
    expect(parseInboundConfig("x")).toBeNull();
    expect(parseInboundConfig(42)).toBeNull();
    expect(parseInboundConfig(["a"])).toBeNull();
  });

  it("passes a complete valid config through, converting mediaMaxMb → bytes", () => {
    expect(
      parseInboundConfig({
        mediaMode: "shared-fs",
        inboundMediaMode: "shared-fs",
        rehydration: false,
        mediaMaxMb: 50,
      }),
    ).toEqual({
      mediaMode: "shared-fs",
      inboundMediaMode: "shared-fs",
      rehydration: false,
      mediaMaxBytes: 50 * 1024 * 1024,
    });
  });

  it("accepts each media mode and inbound mode", () => {
    expect(parseInboundConfig({ mediaMode: "gateway-http" })).toEqual({
      mediaMode: "gateway-http",
    });
    expect(parseInboundConfig({ mediaMode: "off" })).toEqual({
      mediaMode: "off",
    });
    expect(parseInboundConfig({ inboundMediaMode: "inline" })).toEqual({
      inboundMediaMode: "inline",
    });
  });

  it("DROPS a bad field instead of throwing or rejecting the whole config", () => {
    expect(parseInboundConfig({ mediaMode: "ftp" })).toEqual({});
    expect(parseInboundConfig({ inboundMediaMode: "nope" })).toEqual({});
    expect(parseInboundConfig({ rehydration: "yes" })).toEqual({});
    expect(parseInboundConfig({ mediaMaxMb: -1 })).toEqual({});
    expect(parseInboundConfig({ mediaMaxMb: 0 })).toEqual({});
    expect(parseInboundConfig({ mediaMaxMb: "big" })).toEqual({});
  });

  it("IGNORES unknown keys (forward-compat: a new field must not break an old bridge)", () => {
    expect(parseInboundConfig({ futureField: 1, rehydration: true })).toEqual({
      rehydration: true,
    });
  });

  it("keeps valid fields while dropping bad ones in the same object", () => {
    expect(
      parseInboundConfig({ mediaMode: "off", mediaMaxMb: "nope" }),
    ).toEqual({ mediaMode: "off" });
  });
});
