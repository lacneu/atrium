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
  "abort",
  "mediaOutbound",
  "inboundAttachments",
  "subagents",
  "cronList",
  "cronManage",
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
    abort: true,
    mediaOutbound: true,
    inboundAttachments: false,
    subagents: true,
    cronList: true,
    cronManage: false,
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
    abort: true,
    mediaOutbound: true,
    inboundAttachments: true,
    subagents: true,
    cronList: true,
    cronManage: false,
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
    abort: true,
    mediaOutbound: true,
    inboundAttachments: true,
    subagents: true,
    cronList: true,
    cronManage: false,
  },
  // 2026.6.10 — live-validated 2026-06-28 (chat round-trip/stream/tool, multi-agent
  // alice+bob, subagent spawn→CHILD_OK). All existing capabilities resolve; 6.10
  // adds NO new capability (its only behavioral change is SCOPED device pairing,
  // handled by the bridge already requesting operator.read/write — not a feature gate).
  "2026.6.10": {
    knobThinkingLevel: true,
    knobModel: true,
    knobFastMode: true,
    knobUnset: true,
    agentFiles: true,
    sessionCompact: true,
    configDefaults: true,
    messageToolRecovery: true,
    agentsDiscovery: true,
    abort: true,
    mediaOutbound: true,
    inboundAttachments: true,
    subagents: true,
    cronList: true,
    cronManage: false,
  },
  // 2026.7.1 (incl. the validated -beta.2 bench) — adds the cron MANAGEMENT
  // surface (cron.get/update/remove/run/runs), live-verified 2026-07-12.
  "2026.7.1": {
    knobThinkingLevel: true,
    knobModel: true,
    knobFastMode: true,
    knobUnset: true,
    agentFiles: true,
    sessionCompact: true,
    configDefaults: true,
    messageToolRecovery: true,
    agentsDiscovery: true,
    abort: true,
    mediaOutbound: true,
    inboundAttachments: true,
    subagents: true,
    cronList: true,
    cronManage: true,
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
    expect(oc.supportedRange).toEqual({ min: "2026.5.19", maxValidated: "2026.7.1" });
    expect(oc.validatedVersions).toEqual([
      "2026.5.19",
      "2026.6.1",
      "2026.6.5",
      "2026.6.10",
      "2026.6.11",
      "2026.7.1-beta.2",
      "2026.7.1",
    ]);
    expect(Object.keys(oc.capabilities).sort()).toEqual([...ALL_CAPS].sort());
  });

  test("hermes is a validated provider (0.18.x) with its small real surface", () => {
    expect(COMPAT_MANIFEST.providers.hermes).toEqual({
      supportedRange: { min: "0.18.0", maxValidated: "0.18.2" },
      validatedVersions: ["0.18.0", "0.18.2"],
      // ONLY what the OpenAI-compatible API server actually offers — everything
      // else (thinking/model knobs, config-defaults, subagents, attachments)
      // is deliberately absent so the UI gates it OFF automatically.
      capabilities: { abort: "0.18.0", agentsDiscovery: "0.18.0" },
    });
  });
});

describe("parseVersion (strict three-part numeric + optional pre-release)", () => {
  test.each([
    ["2026.5.19", [2026, 5, 19]],
    ["2026.6.1", [2026, 6, 1]],
    ["2026.6.5", [2026, 6, 5]],
    ["0.0.0", [0, 0, 0]],
    ["2026.7.1-beta.2", [2026, 7, 1, "beta.2"]],
    ["2026.6.5-rc1", [2026, 6, 5, "rc1"]],
  ] as const)("parses %s", (raw, expected) => {
    expect(parseVersion(raw)).toEqual(expected);
  });

  test.each([
    "",
    "2026",
    "2026.6",
    "2026.6.5.1",
    "v2026.6.5",
    "2026.6.x",
    "2026..5",
    " 2026.6.5",
    "2026.6.5-",
    "2026.6.5-béta",
    "2026.8.0-beta.",
    "2026.8.0-beta..1",
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

  test("a pre-release orders BEFORE its release, semver-style", () => {
    const beta = parseVersion("2026.7.1-beta.2")!;
    const release = parseVersion("2026.7.1")!;
    expect(compareVersions(beta, release)).toBeLessThan(0);
    expect(compareVersions(release, beta)).toBeGreaterThan(0);
    // …but AFTER every older release.
    expect(compareVersions(beta, parseVersion("2026.6.11")!)).toBeGreaterThan(0);
  });

  test("pre-release identifiers compare numerically then alphabetically", () => {
    const cmp = (a: string, b: string) =>
      compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("2026.7.1-beta.2", "2026.7.1-beta.10")).toBeLessThan(0);
    expect(cmp("2026.7.1-beta.2", "2026.7.1-rc.1")).toBeLessThan(0);
    expect(cmp("2026.7.1-beta.2", "2026.7.1-beta.2")).toBe(0);
    // Numeric identifiers order below alphanumeric ones (semver rule).
    expect(cmp("2026.7.1-1", "2026.7.1-beta")).toBeLessThan(0);
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

  test.each(["", "garbage", "2026.6", "v2026.6.5", "2026.6.5-"])(
    "malformed version %j falls back to the same conservative floor",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(MATRIX["2026.5.19"]);
      expect(resolved.versionBeyondValidated).toBe(false);
    },
  );

  test("a PRE-RELEASE resolves as ordered BELOW its release (2026.6.5-rc1 lacks the 6.5 capabilities)", () => {
    const resolved = resolveCapabilities("openclaw", "2026.6.5-rc1");
    // 2026.6.5-rc1 >= 2026.6.1 but < 2026.6.5 → the 6.1 row, not the 6.5 one.
    expect(resolved.capabilities).toEqual(MATRIX["2026.6.1"]);
    expect(resolved.versionBeyondValidated).toBe(false);
  });
});

describe("resolveCapabilities — beyond maxValidated", () => {
  // All STRICTLY above maxValidated (2026.7.1) now that 7.1 is validated.
  test.each(["2026.7.2", "2026.8.0", "2027.1.1"])(
    "%s enables all validated capabilities + flags versionBeyondValidated",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(MATRIX["2026.7.1"]);
      expect(resolved.versionBeyondValidated).toBe(true);
    },
  );

  test("exactly maxValidated is NOT beyond", () => {
    expect(resolveCapabilities("openclaw", "2026.6.5").versionBeyondValidated).toBe(
      false,
    );
  });

  test("the VALIDATED pre-release bench (2026.7.1-beta.2) is within range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.7.1-beta.2");
    // beta.2 > every 2026.6.x minVersion AND >= the cronManage floor (the
    // bench it was validated on) → the full 7.1 capability row.
    expect(resolved.capabilities).toEqual(MATRIX["2026.7.1"]);
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("the 2026.7.1 RELEASE resolves within range, no flag (prepared support)", () => {
    const resolved = resolveCapabilities("openclaw", "2026.7.1");
    expect(resolved.capabilities).toEqual(MATRIX["2026.7.1"]);
    expect(resolved.versionBeyondValidated).toBe(false);
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

  test("hermes resolves to abort + discovery at a validated version, nothing else", () => {
    expect(resolveCapabilities("hermes", "0.18.0")).toEqual({
      capabilities: { abort: true, agentsDiscovery: true },
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
