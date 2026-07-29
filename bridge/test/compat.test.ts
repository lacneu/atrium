// Compatibility manifest tests: the EXHAUSTIVE matrix (each validated version
// x each capability), the conservative policy for unknown/malformed versions,
// the beyond-maxValidated escape hatch, and strict version parsing. The matrix
// is the executable copy of the bench-validation ledger — if the manifest data
// drifts, these tables fail loudly.

import { readFileSync, readdirSync } from "node:fs";
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
  resolveCapabilitiesFor,
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
  "talk",
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
    talk: false,
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
    talk: false,
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
    talk: false,
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
    talk: false,
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
    // Realtime voice surface (talk.catalog / talk.client.create) — live-probed
    // on the 2026.7.1 bench (2026-07-16).
    talk: true,
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
      "2026.7.1-beta.5",
      "2026.7.1",
    ]);
    expect(Object.keys(oc.capabilities).sort()).toEqual([...ALL_CAPS].sort());
  });

  test("hermes is a validated provider (0.18.x) with its small real surface", () => {
    expect(COMPAT_MANIFEST.providers.hermes).toEqual({
      supportedRange: { min: "0.18.0", maxValidated: "0.19.0" },
      validatedVersions: ["0.18.0", "0.18.2", "0.19.0"],
      // ONLY what a Hermes instance actually offers WHATEVER its transport —
      // everything transport-specific (attachments, cron, subagents) lives in the WS
      // overlay, and everything absent (thinking/model knobs, config-defaults) is
      // deliberately absent so the UI gates it OFF automatically.
      //
      // `agentFiles` and `mediaOutbound` moved here from the WS overlay / from nowhere
      // (W11/G8): both are served over the managed-files HTTP API and are wired on
      // `config.kind === "hermes"`, not on the transport. The manifest was hiding a
      // working tab from every REST instance and omitting a capability the bridge has.
      capabilities: {
        abort: "0.18.0",
        agentsDiscovery: "0.18.0",
        agentFiles: "0.18.0",
        mediaOutbound: "0.18.0",
      },
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
  // The assertion below was already the frozen profile; only the NAME claimed
  // otherwise ("enables all validated capabilities" read as a grant). On the shipped
  // table the two rules coincide — see the shared-table suite for the input where
  // they do not.
  test.each(["2026.7.2", "2026.8.0", "2027.1.1"])(
    "%s is FROZEN at the maxValidated profile + flags versionBeyondValidated",
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
    // bench it was validated on) → the 7.1 capability row EXCEPT talk (its
    // floor is the 2026.7.1 RELEASE, and a pre-release sorts below it).
    expect(resolved.capabilities).toEqual({ ...MATRIX["2026.7.1"], talk: false });
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("the VALIDATED pre-release bench (2026.7.1-beta.5) is within range, no flag", () => {
    // Live suite GO 2026-07-12 (9/9). Same capability row as the release:
    // beta.5 sorts above the cronManage floor (beta.2) and below 2026.7.1.
    const resolved = resolveCapabilities("openclaw", "2026.7.1-beta.5");
    // Same talk exception as beta.2: the talk floor is the 7.1 RELEASE.
    expect(resolved.capabilities).toEqual({ ...MATRIX["2026.7.1"], talk: false });
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

  test("hermes resolves its TRANSPORT-INDEPENDENT surface at a validated version", () => {
    // The WS overlay is applied later, per target, by the server — this is the floor a
    // REST instance gets, and it now includes the two HTTP-served capabilities.
    expect(resolveCapabilities("hermes", "0.18.0")).toEqual({
      capabilities: {
        abort: true,
        agentsDiscovery: true,
        agentFiles: true,
        mediaOutbound: true,
      },
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

// ── The vendored-schema ratchet must actually cover what we claim (W10 / Q21) ──
//
// `maxValidated` is the bridge's public promise: "this version's wire contract has
// been examined". The examination artifact is the VENDORED schema directory plus its
// coverage manifest — the ratchet that stays red until a human classifies every new
// field. A `maxValidated` with no vendored directory is a promise with nothing behind
// it: the version was bench-run, but no machine ever presented its contract changes
// to anyone. That is precisely the hole the program's five unreviewed 7.1 additions
// went through.
//
// This test is EXPECTED to be red until the target version is vendored. That is the
// point: it converts "we forgot to vendor" from an invisible omission into a failing
// gate.

describe("every claimed version has an examined contract (W10)", () => {
  const PROTOCOL_DIR = resolve(__dirname, "../protocol/openclaw");

  /** Vendored directories present on disk, newest-first is irrelevant here. */
  function vendoredVersions(): string[] {
    return readdirSync(PROTOCOL_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "coverage")
      .map((e) => e.name);
  }

  test("the OpenClaw `maxValidated` has a vendored schema directory", () => {
    // `supportedRange` is nullable in the type (a provider row can be a structural
    // placeholder, as the Hermes row was). A missing range here would silently skip
    // the check, so it fails instead.
    const range = COMPAT_MANIFEST.providers.openclaw?.supportedRange;
    if (!range) throw new Error("the openclaw provider declares no supported range");
    const max = range.maxValidated;
    expect(
      vendoredVersions(),
      `maxValidated ${max} has no protocol/openclaw/${max}/ — its wire contract was ` +
        `never enumerated, so no ratchet can have reviewed it. Run the vendoring ` +
        `script for ${max} and classify what it surfaces.`,
    ).toContain(max);
  });

  test("vendored directories and coverage manifests are a BIJECTION", () => {
    // A manifest naming a version with no directory means the ratchet walks nothing
    // while looking busy; a directory with no manifest means schemas nobody
    // classified. Both are the same hole from opposite sides.
    const manifests = readdirSync(resolve(PROTOCOL_DIR, "coverage"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(manifests).toEqual(vendoredVersions().sort());
    // And each manifest must NAME the version it is filed under — a copied file
    // with a stale `version` would classify one contract while claiming another.
    for (const v of manifests) {
      const m = JSON.parse(
        readFileSync(resolve(PROTOCOL_DIR, "coverage", `${v}.json`), "utf-8"),
      ) as { version: string };
      expect(m.version, `coverage/${v}.json`).toBe(v);
    }
  });
});

// ── The capability policy, asserted from a SHARED table (W10 / G7) ──────────
//
// `test/fixtures/capability-policy.json` is read by this suite AND by
// convex/compat.test.ts. The two implementations live in different npm packages and
// cannot import each other; the Convex one calls itself an "EXACT MIRROR" and nothing
// checked it. One table, two readers: a divergence reddens one side.
//
// The synthetic manifest exists for one case the shipped one cannot express — a
// capability declared ABOVE `maxValidated`. Freezing and failing open agree on every
// other input, so that case is the only proof this policy changed at all.

interface PolicyCase {
  name: string;
  provider: string;
  version: string | null;
  beyond: boolean;
  capabilities: Record<string, boolean>;
}
interface PolicyFixture {
  manifest: {
    providers: Record<
      string,
      { supportedRange: { min: string; maxValidated: string } | null; capabilities: Record<string, string> }
    >;
  };
  cases: PolicyCase[];
}

const POLICY = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/capability-policy.json"), "utf-8"),
) as PolicyFixture;

describe("capability policy — frozen at the validated profile", () => {
  test("the shared table is not empty (a vacuous fixture proves nothing)", () => {
    expect(POLICY.cases.length).toBeGreaterThan(5);
    // And it MUST contain the discriminating case, or the whole exercise is theatre.
    const beyondCase = POLICY.cases.find((c) => c.beyond);
    expect(beyondCase, "no beyond-maxValidated case in the table").toBeDefined();
    expect(beyondCase!.capabilities.unbenchedCap).toBe(false);
  });

  for (const c of POLICY.cases) {
    test(c.name, () => {
      const p = POLICY.manifest.providers[c.provider]!;
      const resolved = resolveCapabilitiesFor(
        p.supportedRange,
        p.capabilities,
        c.version,
      );
      expect(resolved.capabilities).toEqual(c.capabilities);
      expect(resolved.versionBeyondValidated).toBe(c.beyond);
    });
  }
});
