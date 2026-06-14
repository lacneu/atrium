// Compatibility manifest tests: the EXHAUSTIVE matrix (each validated version
// x each capability), the conservative policy for unknown/malformed versions,
// the beyond-maxValidated escape hatch, and strict version parsing. The matrix
// is the executable copy of the bench-validation ledger — if the manifest data
// drifts, these tables fail loudly.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  BRIDGE_VERSION,
  COMPAT_MANIFEST,
  PROTOCOL_VERSION,
  compareVersions,
  parseVersion,
  resolveCapabilities,
} from "../src/compat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
) as { version: string };

/** Every capability key the openclaw provider declares (pinned). */
const ALL_CAPS = [
  "knobThinkingLevel",
  "knobModel",
  "knobFastMode",
  "knobUnset",
  "agentFiles",
  "sessionCompact",
  "configDefaults",
  "messageToolRecovery",
  "agentsDiscovery",
  "mediaOutbound",
  "inboundAttachments",
] as const;

/**
 * The FULL expected matrix: validated version -> capability -> boolean.
 * Mirrors the bench ledger (5.19 baseline; inbound vision reliable from 6.1;
 * fastMode/unset/agent-files/compact/config-defaults verified on 6.5).
 */
const MATRIX: Record<string, Record<(typeof ALL_CAPS)[number], boolean>> = {
  "2026.5.19": {
    knobThinkingLevel: true,
    knobModel: true,
    knobFastMode: false,
    knobUnset: false,
    agentFiles: false,
    sessionCompact: false,
    configDefaults: false,
    messageToolRecovery: true,
    agentsDiscovery: true,
    mediaOutbound: true,
    inboundAttachments: false,
  },
  "2026.6.1": {
    knobThinkingLevel: true,
    knobModel: true,
    knobFastMode: false,
    knobUnset: false,
    agentFiles: false,
    sessionCompact: false,
    configDefaults: false,
    messageToolRecovery: true,
    agentsDiscovery: true,
    mediaOutbound: true,
    inboundAttachments: true,
  },
  "2026.6.5": {
    knobThinkingLevel: true,
    knobModel: true,
    knobFastMode: true,
    knobUnset: true,
    agentFiles: true,
    sessionCompact: true,
    configDefaults: true,
    messageToolRecovery: true,
    agentsDiscovery: true,
    mediaOutbound: true,
    inboundAttachments: true,
  },
};

describe("COMPAT_MANIFEST shape", () => {
  test("bridgeVersion comes from package.json (no hardcode drift)", () => {
    expect(BRIDGE_VERSION).toBe(PKG.version);
    expect(COMPAT_MANIFEST.bridgeVersion).toBe(PKG.version);
  });

  test("protocolVersion is 2 (nested sessionSettings + clears contract)", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(COMPAT_MANIFEST.protocolVersion).toBe(2);
  });

  test("openclaw provider pins the validated range + versions", () => {
    const oc = COMPAT_MANIFEST.providers.openclaw!;
    expect(oc.supportedRange).toEqual({ min: "2026.5.19", maxValidated: "2026.6.5" });
    expect(oc.validatedVersions).toEqual(["2026.5.19", "2026.6.1", "2026.6.5"]);
    expect(Object.keys(oc.capabilities).sort()).toEqual([...ALL_CAPS].sort());
  });

  test("hermes is a structural placeholder (no range, no capabilities)", () => {
    expect(COMPAT_MANIFEST.providers.hermes).toEqual({
      supportedRange: null,
      validatedVersions: [],
      capabilities: {},
    });
  });
});

describe("parseVersion (strict three-part numeric)", () => {
  test.each([
    ["2026.5.19", [2026, 5, 19]],
    ["2026.6.1", [2026, 6, 1]],
    ["2026.6.5", [2026, 6, 5]],
    ["0.0.0", [0, 0, 0]],
  ] as const)("parses %s", (raw, expected) => {
    expect(parseVersion(raw)).toEqual(expected);
  });

  test.each([
    "",
    "2026",
    "2026.6",
    "2026.6.5.1",
    "v2026.6.5",
    "2026.6.5-rc1",
    "2026.6.x",
    "2026..5",
    " 2026.6.5",
    "garbage",
  ])("rejects malformed %j", (raw) => {
    expect(parseVersion(raw)).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders the validated versions", () => {
    const v519 = parseVersion("2026.5.19")!;
    const v61 = parseVersion("2026.6.1")!;
    const v65 = parseVersion("2026.6.5")!;
    expect(compareVersions(v519, v61)).toBeLessThan(0);
    expect(compareVersions(v61, v65)).toBeLessThan(0);
    expect(compareVersions(v65, v65)).toBe(0);
    expect(compareVersions(v65, v519)).toBeGreaterThan(0);
  });

  test("compares NUMERICALLY, not lexicographically (9 < 19)", () => {
    expect(
      compareVersions(parseVersion("2026.5.9")!, parseVersion("2026.5.19")!),
    ).toBeLessThan(0);
  });
});

describe("resolveCapabilities — full validated matrix", () => {
  for (const [version, expected] of Object.entries(MATRIX)) {
    test(`openclaw @ ${version} resolves the exact ledger row`, () => {
      const resolved = resolveCapabilities("openclaw", version);
      expect(resolved.capabilities).toEqual(expected);
      expect(resolved.versionBeyondValidated).toBe(false);
      // No capability is silently missing or invented.
      expect(Object.keys(resolved.capabilities).sort()).toEqual([...ALL_CAPS].sort());
    });
  }
});

describe("resolveCapabilities — conservative policy (unknown version)", () => {
  test("null gateway version enables ONLY the supportedRange.min capabilities", () => {
    const resolved = resolveCapabilities("openclaw", null);
    expect(resolved.capabilities).toEqual(MATRIX["2026.5.19"]);
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test.each(["", "garbage", "2026.6", "v2026.6.5", "2026.6.5-rc1"])(
    "malformed version %j falls back to the same conservative floor",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(MATRIX["2026.5.19"]);
      expect(resolved.versionBeyondValidated).toBe(false);
    },
  );
});

describe("resolveCapabilities — beyond maxValidated", () => {
  test.each(["2026.6.6", "2026.7.0", "2027.1.1"])(
    "%s enables all validated capabilities + flags versionBeyondValidated",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(MATRIX["2026.6.5"]);
      expect(resolved.versionBeyondValidated).toBe(true);
    },
  );

  test("exactly maxValidated is NOT beyond", () => {
    expect(resolveCapabilities("openclaw", "2026.6.5").versionBeyondValidated).toBe(
      false,
    );
  });
});

describe("resolveCapabilities — edges", () => {
  test.each(["2026.5.18", "2025.12.31"])(
    "a parseable version BELOW the floor (%s) enables nothing",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(Object.values(resolved.capabilities).every((v) => v === false)).toBe(true);
      expect(resolved.versionBeyondValidated).toBe(false);
    },
  );

  test("hermes (placeholder, no validated range) resolves to zero capabilities", () => {
    expect(resolveCapabilities("hermes", "1.0.0")).toEqual({
      capabilities: {},
      versionBeyondValidated: false,
    });
  });

  test("an unknown provider resolves to zero capabilities", () => {
    expect(resolveCapabilities("nope", "2026.6.5")).toEqual({
      capabilities: {},
      versionBeyondValidated: false,
    });
  });
});
