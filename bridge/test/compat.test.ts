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
  CAPABILITIES_REQUIRING_AUTH_MODE,
  OPENCLAW_MIN_SUPPORTED,
  openClawAgentRequestsEnabled,
  openClawBelowFloor,
  unvalidatedWindowFor,
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
  "permissionModes",
  "knowledgePolicy",
  "inlineWidgets",
  "transcriptProjection",
  "followUpModes",
  "discardPendingInput",
] as const;

/**
 * The FULL expected matrix: supported version -> capability -> boolean.
 * Mirrors the bench ledger from the 2026.8.2 floor (0.92.0); the rows for the retired
 * generations (2026.5.19 → 2026.7.1) left with them — below the floor nothing resolves.
 */
const MATRIX: Record<string, Record<(typeof ALL_CAPS)[number], boolean>> = {
  // 2026.8.2 — the supported FLOOR (never validated on a stock image: it is a known
  // broken release, badged "defective"). Its profile is what an unknown version gets.
  "2026.8.2": {
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
    talk: true,
    permissionModes: true,
    knowledgePolicy: false,
    inlineWidgets: false,
    // The shadow transcript projection floors at the supported floor itself.
    transcriptProjection: true,
    // Send like the Control UI (phase 3): `chat.send.queueMode` exists at the floor.
    followUpModes: true,
    // `chat.abort.discardPendingInput` exists from 2026.9.7.
    discardPendingInput: false,
  },
  // 2026.9.1 — live GO 11/11 (2026-09-03). It adds NO capability gate: the new
  // surface (gateway suspension, user profiles, errorDetail) is vendored and
  // classified, not adopted. Same profile as the previous ceiling, pinned here so a
  // future capability lands as a visible diff.
  "2026.9.1": {
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
    // The owner's execution-permission choice: its guard exists from 2026.8.2.
    permissionModes: true,
    // The knowledge plugin's policy control floors at 2026.9.6.
    knowledgePolicy: false,
    // Inline widgets floor at 2026.9.6 (the version the chain was proven live on).
    inlineWidgets: false,
    transcriptProjection: true,
    followUpModes: true,
    discardPendingInput: false,
  },
  // 2026.9.2 — live GO 11/11 (2026-09-06). Adds NO capability gate either: the
  // new surface (multi-user mentions/participants, per-person model accounts,
  // wizard, update runs, Control UI plugin catalogue) is vendored and
  // classified, not adopted; the content-bound idempotency key is a
  // classification change (dispatch-errors.ts), not a capability.
  "2026.9.2": {
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
    talk: true,
    // The owner's execution-permission choice: its guard exists from 2026.8.2.
    permissionModes: true,
    // The knowledge plugin's policy control floors at 2026.9.6.
    knowledgePolicy: false,
    // Inline widgets floor at 2026.9.6 (the version the chain was proven live on).
    inlineWidgets: false,
    transcriptProjection: true,
    followUpModes: true,
    discardPendingInput: false,
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
    expect(oc.supportedRange).toEqual({ min: "2026.8.2", maxValidated: "2026.10.33" });
    // The floor is the operator-facing constant, not a second copy of a string.
    expect(oc.supportedRange?.min).toBe(OPENCLAW_MIN_SUPPORTED);
    expect(oc.validatedVersions).toEqual([
      "2026.9.1",
      "2026.9.2",
      "2026.9.4",
      "2026.9.5",
      "2026.9.6",
      "2026.9.7",
      "2026.9.8",
      "2026.9.9",
      "2026.9.33",
      "2026.9.36",
      "2026.10.33",
    ]);
    // The ceiling moved from one extended-stable release to the next; what lies between
    // them was never benched, and the manifest SAYS so rather than letting the interval
    // claim it.
    expect(
      (oc.unvalidatedWindows ?? []).map((w) => [w.after, w.before]),
    ).toEqual([["2026.9.36", "2026.10.33"]]);
    expect(Object.keys(oc.capabilities).sort()).toEqual([...ALL_CAPS].sort());
    // The two releases inside the range that a STOCK gateway cannot be trusted on:
    // a delivered file poisons the session (upstream #135747). Raising the ceiling
    // to 2026.9.1 put them back inside the interval, so the manifest must name them
    // (codex P1) — the bench could only exercise them because the custom image
    // carries a build-time guard.
    expect(Object.keys(oc.knownBrokenVersions ?? {}).sort()).toEqual([
      "2026.8.1",
      "2026.8.2",
    ]);
    for (const why of Object.values(oc.knownBrokenVersions ?? {})) {
      expect(why).toMatch(/poisons the session/);
    }
    // …and they are NOT claimed as validated.
    expect(oc.validatedVersions).not.toContain("2026.8.1");
    expect(oc.validatedVersions).not.toContain("2026.8.2");
  });

  test("hermes is a validated provider (0.18.0 → 0.21.7) with its small real surface", () => {
    expect(COMPAT_MANIFEST.providers.hermes).toEqual({
      supportedRange: { min: "0.18.0", maxValidated: "0.21.7" },
      validatedVersions: ["0.18.0", "0.18.2", "0.19.0", "0.21.5", "0.21.7"],
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

  test("the extended-stable 2026.9.33 orders ABOVE 2026.9.9 and BELOW the 2026.10 line", () => {
    // Upstream cut its extended-stable release from v2026.9.9 and numbered it 2026.9.33.
    // As strings it sorts BELOW 2026.9.4 ("3" < "4") and below 2026.9.9: a lexical
    // comparator would leave 2026.9.9 as the ceiling and read 2026.9.33 as an OLD version.
    const cmp = (a: string, b: string) =>
      compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("2026.9.33", "2026.9.9")).toBeGreaterThan(0);
    expect(cmp("2026.9.33", "2026.9.4")).toBeGreaterThan(0);
    expect(cmp("2026.9.9", "2026.9.33")).toBeLessThan(0);
    // The mainline continued as 2026.10.x (v2026.10.1, v2026.10.2 upstream): newer.
    expect(cmp("2026.9.33", "2026.10.1")).toBeLessThan(0);
    expect(cmp("2026.10.1-beta.1", "2026.9.33")).toBeGreaterThan(0);
  });

  test("the extended-stable maintenance 2026.9.36 orders above 2026.9.33 and below 2026.10", () => {
    // Same line, same numbering: v2026.9.34–v2026.9.36 continue the extended-stable
    // releases on top of v2026.9.33, while the mainline stays at 2026.10.x.
    const cmp = (a: string, b: string) =>
      compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("2026.9.36", "2026.9.33")).toBeGreaterThan(0);
    expect(cmp("2026.9.36", "2026.9.9")).toBeGreaterThan(0);
    expect(cmp("2026.9.36", "2026.10.1")).toBeLessThan(0);
  });

  test("the next extended-stable 2026.10.33 orders above the whole 2026.9 line and the 2026.10 mainline, below 2026.11", () => {
    // Upstream numbers its extended-stable releases .33 and up on the minor they are cut
    // from: v2026.10.33 follows the mainline v2026.10.1 … v2026.10.10, and the mainline
    // has since moved to 2026.11.x (v2026.11.1 … v2026.11.9).
    const cmp = (a: string, b: string) =>
      compareVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("2026.10.33", "2026.9.36")).toBeGreaterThan(0);
    expect(cmp("2026.10.33", "2026.9.37")).toBeGreaterThan(0);
    expect(cmp("2026.10.33", "2026.10.10")).toBeGreaterThan(0);
    // As strings "2026.10.33" sorts BELOW "2026.9.36" ("1" < "9"): a lexical comparator
    // would read the new ceiling as older than the one it replaces.
    expect("2026.10.33" < "2026.9.36").toBe(true);
    expect(cmp("2026.10.33", "2026.11.1")).toBeLessThan(0);
    expect(cmp("2026.10.33", "2026.11.5-beta.1")).toBeLessThan(0);
    expect(cmp("2026.10.33", "2026.11.8")).toBeLessThan(0);
    // A pre-release of the ceiling is NOT the ceiling.
    expect(cmp("2026.10.33-beta.1", "2026.10.33")).toBeLessThan(0);
  });

  test("a pre-release orders BEFORE its release, semver-style", () => {
    const beta = parseVersion("2026.7.1-beta.2")!;
    const release = parseVersion("2026.7.1")!;
    expect(compareVersions(beta, release)).toBeLessThan(0);
    expect(compareVersions(release, beta)).toBeGreaterThan(0);
    // …but AFTER every older release.
    expect(compareVersions(beta, parseVersion("2026.6.11")!)).toBeGreaterThan(
      0,
    );
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
      expect(Object.keys(resolved.capabilities).sort()).toEqual(
        [...ALL_CAPS].sort(),
      );
    });
  }
});

describe("resolveCapabilities — conservative policy (unknown version)", () => {
  test("null gateway version enables the FLOOR profile (every capability at or below supportedRange.min)", () => {
    const resolved = resolveCapabilities("openclaw", null);
    expect(resolved.capabilities).toEqual(MATRIX["2026.8.2"]);
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test.each(["", "garbage", "2026.6", "v2026.6.5", "2026.6.5-"])(
    "malformed version %j falls back to the same conservative floor",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(MATRIX["2026.8.2"]);
      expect(resolved.versionBeyondValidated).toBe(false);
    },
  );

  test("a PRE-RELEASE resolves as ordered BELOW its release (2026.9.6-rc1 lacks the 9.6 capabilities)", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.6-rc1");
    // 2026.9.6-rc1 >= 2026.9.5 but < 2026.9.6 → the 9.5 profile, not the 9.6 one.
    expect(resolved.capabilities).toEqual(resolveCapabilities("openclaw", "2026.9.5").capabilities);
    expect(resolved.capabilities.knowledgePolicy).toBe(false);
    expect(resolved.versionBeyondValidated).toBe(false);
  });
});

describe("resolveCapabilities — beyond maxValidated", () => {
  // All STRICTLY above maxValidated, which is 2026.10.33 since 2026-11-24: the 2026.11
  // mainline (v2026.11.1 … v2026.11.9 and their betas are REAL upstream releases, never
  // benched) and anything later. The probes that used to sit here — 2026.9.37 and the
  // 2026.10 mainline — are now UNDER the ceiling without having earned a GO: they did not
  // "stop being beyond" the way 2026.9.5 … 2026.9.36 did, and the never-benched-interval
  // suite below holds them to the same verdict they had on this list.
  // The assertion below was already the frozen profile; only the NAME claimed
  // otherwise ("enables all validated capabilities" read as a grant). On the shipped
  // table the two rules coincide — see the shared-table suite for the input where
  // they do not.
  test.each([
    "2026.10.34",
    "2026.11.1",
    "2026.11.5-beta.1",
    "2026.11.5",
    "2026.11.6",
    "2026.11.7",
    "2026.11.8",
    "2027.1.1",
  ])(
    "%s is FROZEN at the maxValidated profile + flags versionBeyondValidated",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      // The 2026.10.33 profile (= 2026.9.8's): the 2026.9.2 row plus the knowledge control and the
      // inline widgets (floored at 2026.9.6) and the queued-input cancel (2026.9.7).
      expect(resolved.capabilities).toEqual({
        ...MATRIX["2026.9.2"],
        knowledgePolicy: true,
        inlineWidgets: true,
        discardPendingInput: true,
      });
      expect(resolved.capabilities).toEqual(
        resolveCapabilities("openclaw", "2026.10.33").capabilities,
      );
      expect(resolved.versionBeyondValidated).toBe(true);
    },
  );

  // The version this release adds: NOT beyond any more, and no banner. Pinned as its
  // own case because the list above is what a reader scans for "is 9.5 still beyond?",
  // and a name simply removed from a list leaves no trace of the decision.
  test("2026.9.5 is the new ceiling: inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.5");
    // Identical to 2026.9.4's profile: no capability carries a 2026.9.5 floor, so the
    // GO changes the CLAIM, not the surface. Said here so a future capability gated on
    // 2026.9.5 has to change this line deliberately.
    expect(resolved.capabilities).toEqual(
      resolveCapabilities("openclaw", "2026.9.4").capabilities,
    );
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("2026.9.6 is the new ceiling: inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.6");
    // 2026.9.5's profile plus ONE capability floored at 2026.9.6: the knowledge plugin's
    // policy control (its contract was verified against 2026.9.6 and exercised on that
    // bench). The compaction-history refusal stays a raw-version fact
    // (COMPACTION_CHECKPOINTS_RETIRED_IN), not a capability.
    expect(resolved.capabilities).toEqual({
      ...resolveCapabilities("openclaw", "2026.9.5").capabilities,
      knowledgePolicy: true,
      // Inline widgets floor at 2026.9.6 (the version the chain was proven live on).
      inlineWidgets: true,
    });
    expect(resolveCapabilities("openclaw", "2026.9.5").capabilities.knowledgePolicy).toBe(false);
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("2026.9.7 stays inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.7");
    // 2026.9.6's profile plus ONE capability floored at 2026.9.7: the cancel of an
    // input waiting in the gateway's queue (`chat.abort.discardPendingInput`, phase 3).
    // The 9.7 adaptations (append-only live text, the retired task registry) are
    // raw-version or wire facts, not capabilities.
    expect(resolved.capabilities).toEqual({
      ...resolveCapabilities("openclaw", "2026.9.6").capabilities,
      discardPendingInput: true,
    });
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("2026.9.8 stays inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.8");
    // A reliability hotfix of 2026.9.7 with a byte-identical vendored contract: same
    // profile, no capability carries a 2026.9.8 floor.
    expect(resolved.capabilities).toEqual(
      resolveCapabilities("openclaw", "2026.9.7").capabilities,
    );
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("2026.9.9 stays inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.9");
    // A maintenance release with a byte-identical vendored contract: 2026.9.8's profile,
    // no capability carries a 2026.9.9 floor. Its one adaptation (the missing-session
    // compaction refusal) is a wire reading, not a capability.
    expect(resolved.capabilities).toEqual(
      resolveCapabilities("openclaw", "2026.9.8").capabilities,
    );
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("2026.9.33 stays inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.33");
    // The extended-stable line, cut from 2026.9.9 with backports only and a
    // byte-identical vendored contract: 2026.9.9's profile, no capability carries a
    // 2026.9.33 floor.
    expect(resolved.capabilities).toEqual(
      resolveCapabilities("openclaw", "2026.9.9").capabilities,
    );
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("2026.9.36 stays inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.9.36");
    // A maintenance release of the extended-stable line whose two vendored-module
    // changes are additive and unread by the bridge (a Control UI client cap, one more
    // `timeoutPhase` literal): 2026.9.33's profile, no capability carries a 2026.9.36 floor.
    expect(resolved.capabilities).toEqual(
      resolveCapabilities("openclaw", "2026.9.33").capabilities,
    );
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test.each(["2026.9.34", "2026.9.35"])(
    "%s, the never-benched releases between 2026.9.33 and 2026.9.36, is inside the range (no flag)",
    (raw) => {
      // Real upstream tags (v2026.9.34, v2026.9.35), never benched: raising the ceiling to
      // 2026.9.36 puts them under it, and they resolve by the floors like any in-range
      // version. Their changes are contained in the 2026.9.33 → 2026.9.36 diff examined
      // for this release; they are not in `validatedVersions`.
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(
        resolveCapabilities("openclaw", "2026.9.33").capabilities,
      );
      expect(resolved.versionBeyondValidated).toBe(false);
    },
  );

  test.each(["2026.9.10", "2026.9.32"])(
    "%s, between 2026.9.9 and the extended-stable ceiling, is inside the range (no flag)",
    (raw) => {
      // Stated, not stumbled on: numbering the extended-stable release 2026.9.33 puts
      // the interval 2026.9.10–2026.9.32 under the ceiling. No upstream release lives
      // there (the tags go v2026.9.9 → v2026.9.33, the mainline moved to 2026.10.x), so
      // a gateway can only report one by a build nobody published. It resolves like any
      // in-range version — by the floors — and carries no banner.
      const resolved = resolveCapabilities("openclaw", raw);
      expect(resolved.capabilities).toEqual(
        resolveCapabilities("openclaw", "2026.9.9").capabilities,
      );
      expect(resolved.versionBeyondValidated).toBe(false);
    },
  );

  test("2026.10.33 is the new ceiling: inside the range, no flag", () => {
    const resolved = resolveCapabilities("openclaw", "2026.10.33");
    // The next extended-stable release. Its adaptations (the `accepted` ack, one run under
    // two names, the rewritten failure copies, wider questions) are wire readings, not
    // capabilities: 2026.9.36's profile, no capability carries a 2026.10.33 floor.
    expect(resolved.capabilities).toEqual(
      resolveCapabilities("openclaw", "2026.9.36").capabilities,
    );
    expect(resolved.versionBeyondValidated).toBe(false);
  });

  test("exactly maxValidated is NOT beyond", () => {
    expect(COMPAT_MANIFEST.providers.openclaw!.supportedRange!.maxValidated).toBe("2026.10.33");
    expect(
      resolveCapabilities("openclaw", "2026.10.33").versionBeyondValidated,
    ).toBe(false);
  });

  test.each(["2026.7.1-beta.2", "2026.7.1-beta.5", "2026.7.1", "2026.6.5", "2026.5.19"])(
    "the RETIRED validated generation %s resolves NOTHING (below the 2026.8.2 floor)",
    (raw) => {
      // These versions passed the bench in their day, which is exactly why this is a
      // decision and not an accident: the redesigned turn model places a reply by
      // transcript identity, and these gateways do not carry it.
      const resolved = resolveCapabilities("openclaw", raw);
      expect(Object.values(resolved.capabilities).every((v) => v === false)).toBe(true);
      expect(resolved.versionBeyondValidated).toBe(false);
      expect(openClawBelowFloor(raw)).toBe(true);
    },
  );
});

// ── Under the ceiling is not the same as validated ───────────────────────────
//
// `maxValidated` went from 2026.9.36 to 2026.10.33: from one extended-stable release to
// the next. The range is an interval, so the arithmetic alone would have declared
// validated everything in between — ten mainline releases (v2026.10.1 … v2026.10.10),
// their betas, and v2026.9.37, none of which ever met the bench. The 2026.9.34/2026.9.35
// precedent (inside the range, no banner) does not carry over: those are backport-only
// steps on one line, wholly inside a diff that was read. Here only the two ends were.
describe("resolveCapabilities — the never-benched interval under the ceiling", () => {
  const frozenAt936 = resolveCapabilities("openclaw", "2026.9.36").capabilities;

  test.each([
    // The 2026.9 line's own later maintenance release, published after 2026.9.36 was
    // validated: it was "beyond" before the ceiling moved, and nothing has examined it.
    "2026.9.37",
    // The 2026.10 mainline, betas included (real upstream tags).
    "2026.10.1-beta.1",
    "2026.10.1",
    "2026.10.2",
    "2026.10.5",
    "2026.10.10-beta.5",
    "2026.10.10",
    // No upstream release lives in 2026.10.11–2026.10.32; a build reporting one is not
    // validated either.
    "2026.10.11",
    "2026.10.32",
    // A pre-release of the ceiling sorts below it: the exact version validated is the
    // release.
    "2026.10.33-beta.1",
  ])("%s keeps the not-validated flag and is frozen at the 2026.9.36 profile", (raw) => {
    const resolved = resolveCapabilities("openclaw", raw);
    expect(resolved.versionBeyondValidated).toBe(true);
    expect(resolved.capabilities).toEqual(frozenAt936);
    expect(COMPAT_MANIFEST.providers.openclaw!.validatedVersions).not.toContain(raw);
  });

  test("both ends of the interval are validated versions and resolve as themselves", () => {
    for (const end of ["2026.9.36", "2026.10.33"]) {
      expect(COMPAT_MANIFEST.providers.openclaw!.validatedVersions).toContain(end);
      expect(resolveCapabilities("openclaw", end).versionBeyondValidated).toBe(false);
    }
  });

  test("the 2026.9 line below the interval is untouched", () => {
    // Production runs this line. Nothing about it moves with the ceiling.
    for (const v of ["2026.9.1", "2026.9.9", "2026.9.33", "2026.9.34", "2026.9.35", "2026.9.36"]) {
      expect(resolveCapabilities("openclaw", v).versionBeyondValidated, v).toBe(false);
    }
  });

  test("every shipped interval is bounded by two validated versions, in order, under the ceiling", () => {
    // A window is a claim about what was NOT benched; its bounds are claims about what
    // was. An interval hanging off an unvalidated or unparseable bound would freeze a
    // gateway at a profile nobody exercised.
    for (const [name, provider] of Object.entries(COMPAT_MANIFEST.providers)) {
      for (const w of provider.unvalidatedWindows ?? []) {
        const after = parseVersion(w.after);
        const before = parseVersion(w.before);
        const max = parseVersion(provider.supportedRange!.maxValidated);
        const min = parseVersion(provider.supportedRange!.min);
        expect(after, `${name}: ${w.after}`).not.toBeNull();
        expect(before, `${name}: ${w.before}`).not.toBeNull();
        expect(provider.validatedVersions, name).toContain(w.after);
        expect(provider.validatedVersions, name).toContain(w.before);
        expect(compareVersions(after!, before!)).toBeLessThan(0);
        expect(compareVersions(before!, max!)).toBeLessThanOrEqual(0);
        expect(compareVersions(after!, min!)).toBeGreaterThanOrEqual(0);
        expect(w.why.length).toBeGreaterThan(0);
        // No validated version may sit INSIDE an interval that says nothing in it was.
        for (const v of provider.validatedVersions) {
          expect(unvalidatedWindowFor(provider.unvalidatedWindows, parseVersion(v)!), v).toBeNull();
        }
      }
    }
  });

  test("the agent-request gate follows the same rule (frozen, still on above its floor)", () => {
    expect(openClawAgentRequestsEnabled("2026.10.5")).toBe(true);
    expect(openClawAgentRequestsEnabled("2026.10.33")).toBe(true);
  });
});

describe("resolveCapabilities — edges", () => {
  test.each(["2026.5.18", "2025.12.31", "2026.8.1", "2026.8.2-beta.1"])(
    "a parseable version BELOW the floor (%s) enables nothing",
    (raw) => {
      const resolved = resolveCapabilities("openclaw", raw);
      expect(
        Object.values(resolved.capabilities).every((v) => v === false),
      ).toBe(true);
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

  test("openClawBelowFloor answers only for a version KNOWN to be below 2026.8.2", () => {
    expect(openClawBelowFloor("2026.8.1")).toBe(true);
    expect(openClawBelowFloor("2026.8.2-beta.3")).toBe(true);
    // The floor itself and everything above it are supported.
    expect(openClawBelowFloor("2026.8.2")).toBe(false);
    expect(openClawBelowFloor("2026.9.6")).toBe(false);
    expect(openClawBelowFloor("2027.1.1")).toBe(false);
    // An absent or unreadable version is not evidence of an old gateway: a degraded
    // handshake must not refuse every turn of a supported one.
    expect(openClawBelowFloor(null)).toBe(false);
    expect(openClawBelowFloor(undefined)).toBe(false);
    expect(openClawBelowFloor("garbage")).toBe(false);
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

  /** Vendored directories present on disk, newest-first is irrelevant here.
   *
   *  Selected by "the name parses as a version", not by excluding the sibling directories
   *  someone remembered. The exclusion list was `!== "coverage"`, and adding a second
   *  sibling (`events/`, lot G-70) made this read it as a vendored version — the bijection
   *  then demanded a coverage manifest for a directory that is not a contract. */
  function vendoredVersions(): string[] {
    return readdirSync(PROTOCOL_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && parseVersion(e.name) !== null)
      .map((e) => e.name);
  }

  test("the OpenClaw `maxValidated` has a vendored schema directory", () => {
    // `supportedRange` is nullable in the type (a provider row can be a structural
    // placeholder, as the Hermes row was). A missing range here would silently skip
    // the check, so it fails instead.
    const range = COMPAT_MANIFEST.providers.openclaw?.supportedRange;
    if (!range)
      throw new Error("the openclaw provider declares no supported range");
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
      {
        supportedRange: { min: string; maxValidated: string } | null;
        unvalidatedWindows?: Array<{ after: string; before: string; why: string }>;
        capabilities: Record<string, string>;
      }
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
    expect(
      beyondCase,
      "no beyond-maxValidated case in the table",
    ).toBeDefined();
    expect(beyondCase!.capabilities.unbenchedCap).toBe(false);
  });

  for (const c of POLICY.cases) {
    test(c.name, () => {
      const p = POLICY.manifest.providers[c.provider]!;
      const resolved = resolveCapabilitiesFor(
        p.supportedRange,
        p.capabilities,
        c.version,
        "token",
        {},
        p.unvalidatedWindows,
      );
      expect(resolved.capabilities).toEqual(c.capabilities);
      expect(resolved.versionBeyondValidated).toBe(c.beyond);
    });
  }

  test("the table carries the never-benched-interval case, and it discriminates", () => {
    const inside = POLICY.cases.find((c) => c.provider === "gapped" && c.version === "2.5.0");
    expect(inside, "no inside-the-interval case in the shared table").toBeDefined();
    expect(inside!.beyond).toBe(true);
    expect(inside!.capabilities.gapCap).toBe(false);
    // Without the interval the same input resolves as itself: `gapCap` on, no flag. If
    // these two ever agree, the cases above prove nothing about the rule.
    const p = POLICY.manifest.providers.gapped!;
    const ignored = resolveCapabilitiesFor(p.supportedRange, p.capabilities, "2.5.0");
    expect(ignored.capabilities.gapCap).toBe(true);
    expect(ignored.versionBeyondValidated).toBe(false);
  });
});

// A CAPABILITY CAN NEED MORE THAN A VERSION.
//
// Human mentions name a gateway user PROFILE. A shared-token gateway has exactly
// one profile for everybody, so the newest gateway in the world still cannot
// honour a mention there. Offering the affordance would produce a refusal for a
// reason nobody can act on, which is why the mode subtracts from what the version
// granted — and only ever subtracts.
describe("capabilities gated on the authentication mode, not just the version", () => {
  test("no capability is mode-gated today, and that is a MEASUREMENT", () => {
    // `gatewayMentions` was gated here until 2026-09-12. A live send in
    // trusted-proxy mode, with a real gateway profile on both sides, proved the
    // gateway refuses mentions from any client that is not a signed-in Control UI
    // chat — and refuses the WHOLE turn, not the mention. No authentication mode
    // reaches that condition, so there was nothing to gate: the capability is
    // withdrawn rather than gated. Pinned so re-adding one is a deliberate edit.
    expect(Object.keys(CAPABILITIES_REQUIRING_AUTH_MODE)).toEqual([]);
    expect(
      resolveCapabilities("openclaw", "2026.9.2", "trusted-proxy").capabilities
        .gatewayMentions,
    ).toBeUndefined();
  });

  test("switching an instance's mode changes NOTHING it may do", () => {
    // The direct consequence of the line above, stated as behaviour: an operator
    // who flips the posture must not discover a different feature set.
    const tok = resolveCapabilities(
      "openclaw",
      "2026.9.2",
      "token",
    ).capabilities;
    const proxy = resolveCapabilities(
      "openclaw",
      "2026.9.2",
      "trusted-proxy",
    ).capabilities;
    expect(Object.keys(tok).filter((k) => tok[k] !== proxy[k])).toEqual([]);
  });

  test("the gate itself still works, on both return paths", () => {
    // The MECHANISM outlives its first user: the next capability that needs more
    // than a version number will use it, and a gate applied to only one of the two
    // return paths is a gate a null version walks past. Proven on an explicit table
    // where the gated capability sits exactly AT the floor — the only input on
    // which freezing and failing open differ.
    const range = { min: "1.0.0", maxValidated: "2.0.0" } as const;
    const table = { probe: "1.0.0" };
    const gate = { probe: "trusted-proxy" } as const;
    expect(
      resolveCapabilitiesFor(range, table, null, "token", gate).capabilities
        .probe,
      "a null version must not walk past the mode gate",
    ).toBe(false);
    expect(
      resolveCapabilitiesFor(range, table, null, "trusted-proxy", gate)
        .capabilities.probe,
      "and the floor still grants it to the mode that supports it",
    ).toBe(true);
  });
});
