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

describe("Convex's fail-closed media envelope is folded into mediaMode (codex)", () => {
  // Convex cannot know which bridge generation — or which pod behind one Service —
  // will answer a POST it has not sent yet, so it sends `mediaMode: "off"` plus the
  // mode it wants. A bridge predating the field ignores it and stays disabled; this one
  // resolves it HERE, once, so every consumer of `mediaMode` agrees. Resolving it only
  // where the delivery instruction is composed left the rest of the outbound pipeline
  // reading "off", and the live bench caught it: the file was never delivered.
  it("the guarded mode WINS over the fail-closed one", () => {
    expect(
      parseInboundConfig({ mediaMode: "off", mediaModeIfGuarded: "gateway-http" })
        ?.mediaMode,
    ).toBe("gateway-http");
    expect(
      parseInboundConfig({ mediaMode: "off", mediaModeIfGuarded: "shared-fs" })?.mediaMode,
    ).toBe("shared-fs");
  });

  it("…and the parsed result never carries the wire-only field onward", () => {
    const out = parseInboundConfig({
      mediaMode: "off",
      mediaModeIfGuarded: "gateway-http",
    }) as Record<string, unknown>;
    expect("mediaModeIfGuarded" in out).toBe(false);
  });

  it('"inherit" DROPS the fail-closed mode: the bridge keeps its own env default', () => {
    // Convex stores no override for this instance, so it has no opinion to restore.
    // Keeping `off` here would switch an env-configured shared-fs or off bridge, which
    // is exactly the invariant `configOverrides` exists to protect (codex).
    const out = parseInboundConfig({
      mediaMode: "off",
      mediaModeIfGuarded: "inherit",
    }) as Record<string, unknown>;
    expect("mediaMode" in out).toBe(false);
    // …and the rest of the body still parses normally.
    const withOthers = parseInboundConfig({
      mediaMode: "off",
      mediaModeIfGuarded: "inherit",
      inboundMediaMode: "shared-fs",
    });
    expect(withOthers?.inboundMediaMode).toBe("shared-fs");
    expect(withOthers?.mediaMode).toBeUndefined();
  });

  it("no envelope -> the sent mode stands, junk in it is ignored", () => {
    expect(parseInboundConfig({ mediaMode: "off" })?.mediaMode).toBe("off");
    expect(
      parseInboundConfig({ mediaMode: "off", mediaModeIfGuarded: "nonsense" })?.mediaMode,
    ).toBe("off");
    expect(
      parseInboundConfig({ mediaMode: "off", mediaModeIfGuarded: null })?.mediaMode,
    ).toBe("off");
  });
});
