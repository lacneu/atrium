import { describe, expect, test } from "vitest";
import {
  CAPABILITY_KEYS,
  LEGACY_CAPABILITIES,
  capabilityOf,
  instanceTabGate,
  isCapabilityKey,
  knobRowVisibility,
  snapshotTabGate,
  type CapabilityKey,
} from "./capabilities";
import { LIVE_CAPABILITIES_BODY } from "./bridgeCapabilitiesFixture";

// VCOMPAT-C capability contract tests. The capability x control matrix is
// table-driven so every (capability set, UI gate) pair has a pinned verdict —
// version skews (old bridge, future bridge) are explicit rows, not accidents.

// --- Fixtures: capability sets as the bridge manifest resolves them ---------

/** A 2026.6.5 gateway: the full CONF-4 surface. */
const FULL: Record<string, boolean> = {
  knobThinkingLevel: true,
  knobModel: true,
  knobFastMode: true,
  knobUnset: true,
  agentFiles: true,
  sessionCompact: true,
  configDefaults: true,
  subagents: true, inboundAttachments: true,
};

/** A 2026.5.19 gateway: only the UI-3 WRITEBACK knobs are validated, but the
 *  read-only `subagents` capability is available from the 5.19 floor. */
const OLD_GATEWAY: Record<string, boolean> = {
  knobThinkingLevel: true,
  knobModel: true,
  knobFastMode: false,
  knobUnset: false,
  agentFiles: false,
  sessionCompact: false,
  configDefaults: false,
  subagents: true, inboundAttachments: true,
};

/** FORWARD SKEW: a future bridge advertising keys this UI does not know. */
const FUTURE: Record<string, boolean> = {
  ...FULL,
  voiceTalkMode: true,
  holographicUi: false,
};

describe("CAPABILITY_KEYS contract (lockstep with the bridge manifest)", () => {
  test("the frozen list matches the bridge manifest capability table EXACTLY", () => {
    // DELIBERATE duplicate of atrium-bridge src/compat.ts
    // OPENCLAW_CAPABILITIES (separate repos, separate release cycles). If this
    // fails, the contract changed on ONE side: align both repos consciously.
    expect([...CAPABILITY_KEYS]).toEqual([
      "knobThinkingLevel",
      "knobModel",
      "knobFastMode",
      "knobUnset",
      "agentFiles",
      "sessionCompact",
      "configDefaults",
      "subagents",
      // The UI now CONSUMES inboundAttachments (gates the composer attach button)
      // — already present in the bridge OPENCLAW_CAPABILITIES table.
      "inboundAttachments",
      // Realtime voice (gateway-minted ephemeral browser session) — floor =
      // the 2026.7.1 release.
      "talk",
    ]);
  });

  test("every UI key exists in the LIVE bridge manifest (cross-repo anchor, P2-1)", () => {
    // The two repo-local pins above are self-referential: they force a
    // CONSCIOUS change per side but cannot see a rename on the OTHER side.
    // This anchors the UI list against a body captured VERBATIM from a live
    // bridge — a bridge-side key rename only reaches the app by refreshing the
    // fixture, which makes this fail loudly instead of silently hiding a knob.
    const manifestKeys = Object.keys(
      LIVE_CAPABILITIES_BODY.compat.providers.openclaw.capabilities,
    );
    for (const key of CAPABILITY_KEYS) {
      expect(manifestKeys).toContain(key);
    }
    // The resolved per-target record covers the SAME table (no partial records
    // out of the bridge — absent-key-means-false stays a UI-side policy only).
    expect(
      Object.keys(LIVE_CAPABILITIES_BODY.targets[0].capabilities).sort(),
    ).toEqual(manifestKeys.sort());
  });

  test("LOCKSTEP: a key outside CAPABILITY_KEYS cannot unlock anything", () => {
    // The CapabilityKey union already makes this a COMPILE error at every UI
    // gate (`can("notAKey")` does not typecheck) — tsc is the primary gate.
    // This pins the runtime belt for `any`-cast escape hatches: an unknown key
    // is NEVER granted, even when the record claims true.
    const smuggled = "notAContractKey" as CapabilityKey;
    expect(isCapabilityKey(smuggled)).toBe(false);
    expect(capabilityOf({ notAContractKey: true }, smuggled)).toBe(false);
  });

  test("the legacy set is a subset of the contract", () => {
    for (const key of LEGACY_CAPABILITIES) {
      expect(CAPABILITY_KEYS).toContain(key);
    }
  });
});

describe("capabilityOf — capability x set matrix", () => {
  // [set name, caps record, expected verdict per contract key]
  const matrix: Array<
    [string, Record<string, boolean> | null, Record<CapabilityKey, boolean>]
  > = [
    [
      "legacy bridge (caps null) -> historic UI-3 set only",
      null,
      {
        knobThinkingLevel: true,
        knobModel: true,
        knobFastMode: false,
        knobUnset: false,
        agentFiles: false,
        sessionCompact: false,
        configDefaults: false,
        // subagents is NOT in the legacy fallback set (LEGACY_CAPABILITIES) — an
        // old/unknown bridge does not unlock the monitor.
        subagents: false, inboundAttachments: false,
        // talk is absent from every one of these sets -> false.
        talk: false,
      },
    ],
    [
      "2026.6.5 gateway -> everything",
      FULL,
      {
        knobThinkingLevel: true,
        knobModel: true,
        knobFastMode: true,
        knobUnset: true,
        agentFiles: true,
        sessionCompact: true,
        configDefaults: true,
        subagents: true, inboundAttachments: true,
        // talk is absent from every one of these sets -> false.
        talk: false,
      },
    ],
    [
      "2026.5.19 gateway -> writeback knobs only, plus read-only subagents",
      OLD_GATEWAY,
      {
        knobThinkingLevel: true,
        knobModel: true,
        knobFastMode: false,
        knobUnset: false,
        agentFiles: false,
        sessionCompact: false,
        configDefaults: false,
        // subagents is available from the 5.19 floor.
        subagents: true, inboundAttachments: true,
        // talk is absent from every one of these sets -> false.
        talk: false,
      },
    ],
    [
      "EMPTY record (explicit, unlike null) -> nothing (conservative)",
      {},
      {
        knobThinkingLevel: false,
        knobModel: false,
        knobFastMode: false,
        knobUnset: false,
        agentFiles: false,
        sessionCompact: false,
        configDefaults: false,
        subagents: false, inboundAttachments: false,
        // talk is absent from every one of these sets -> false.
        talk: false,
      },
    ],
    [
      "FORWARD skew: unknown future keys ignored, contract keys honored",
      FUTURE,
      {
        knobThinkingLevel: true,
        knobModel: true,
        knobFastMode: true,
        knobUnset: true,
        agentFiles: true,
        sessionCompact: true,
        configDefaults: true,
        subagents: true, inboundAttachments: true,
        // talk is absent from every one of these sets -> false.
        talk: false,
      },
    ],
  ];

  test.each(matrix)("%s", (_name, caps, expected) => {
    for (const key of CAPABILITY_KEYS) {
      expect(capabilityOf(caps, key), `capabilityOf(${_name}, ${key})`).toBe(
        expected[key],
      );
    }
  });

  test("undefined (loading) behaves exactly like the legacy policy", () => {
    for (const key of CAPABILITY_KEYS) {
      expect(capabilityOf(undefined, key)).toBe(capabilityOf(null, key));
    }
  });
});

describe("knobRowVisibility — capability x control matrix (SessionKnobsGroup)", () => {
  const data = { hasModels: true, hasLevels: true };
  const canOf =
    (caps: Record<string, boolean> | null) => (key: CapabilityKey) =>
      capabilityOf(caps, key);

  // [set name, caps, model, thinking, speed, reset]
  const matrix: Array<
    [string, Record<string, boolean> | null, boolean, boolean, boolean, boolean]
  > = [
    ["legacy/loading -> model+thinking only, no speed, no reset", null, true, true, false, false],
    ["full 2026.6.5 -> every control", FULL, true, true, true, true],
    ["2026.5.19 -> model+thinking, no speed, no reset", OLD_GATEWAY, true, true, false, false],
    ["empty record -> nothing", {}, false, false, false, false],
    ["future skew -> like full", FUTURE, true, true, true, true],
  ];

  test.each(matrix)("%s", (_name, caps, model, thinking, speed, reset) => {
    expect(knobRowVisibility(canOf(caps), data)).toEqual({
      model,
      thinking,
      speed,
      reset,
    });
  });

  test("capability without DATA never shows a row (model/thinking need options)", () => {
    const vis = knobRowVisibility(canOf(FULL), {
      hasModels: false,
      hasLevels: false,
    });
    expect(vis.model).toBe(false);
    expect(vis.thinking).toBe(false);
    // speed/reset depend on the capability only (the segmented set is static).
    expect(vis.speed).toBe(true);
    expect(vis.reset).toBe(true);
  });
});

describe("instanceTabGate (AgentFilesTab)", () => {
  test("query in flight -> loading (the tab shows its loading state, no flash)", () => {
    expect(instanceTabGate(undefined, "agentFiles")).toBe("loading");
  });

  test("BACKWARD skew: instance unknown / legacy bridge -> blocked, no version", () => {
    expect(instanceTabGate(null, "agentFiles")).toEqual({
      blocked: true,
      gatewayVersion: null,
      provider: null,
    });
  });

  test("backward skew does NOT block a legacy-set capability", () => {
    // The same null verdict keeps the historic knobs alive.
    expect(instanceTabGate(null, "knobModel")).toEqual({
      blocked: false,
      gatewayVersion: null,
      provider: null,
    });
  });

  test("a supporting instance is open", () => {
    expect(
      instanceTabGate(
        {
          provider: "openclaw",
          gatewayVersion: "2026.6.5",
          capabilities: FULL,
          versionBeyondValidated: false,
        },
        "agentFiles",
      ),
    ).toEqual({ blocked: false, gatewayVersion: "2026.6.5", provider: "openclaw" });
  });

  test("a non-supporting instance is blocked WITH its gateway version (banner)", () => {
    expect(
      instanceTabGate(
        {
          provider: "openclaw",
          gatewayVersion: "2026.5.19",
          capabilities: OLD_GATEWAY,
          versionBeyondValidated: false,
        },
        "agentFiles",
      ),
    ).toEqual({ blocked: true, gatewayVersion: "2026.5.19", provider: "openclaw" });
  });

  test("an instance with capabilities:null falls back to the legacy policy", () => {
    expect(
      instanceTabGate(
        {
          provider: "openclaw",
          gatewayVersion: "2026.4.1",
          capabilities: null,
          versionBeyondValidated: false,
        },
        "sessionCompact",
      ),
    ).toEqual({ blocked: true, gatewayVersion: "2026.4.1", provider: "openclaw" });
  });
});

describe("snapshotTabGate (ChatDefaultsTab — default-instance resolution)", () => {
  const target = (
    instanceName: string,
    gatewayVersion: string | null,
    capabilities: Record<string, boolean>,
  ) => ({ instanceName, gatewayVersion, capabilities });

  test("query in flight -> loading", () => {
    expect(snapshotTabGate(undefined, "configDefaults")).toBe("loading");
  });

  test("never polled (snapshot null) -> legacy policy: blocked, no version", () => {
    expect(snapshotTabGate(null, "configDefaults")).toEqual({
      blocked: true,
      gatewayVersion: null,
      provider: null,
    });
  });

  test("zero targets (legacy bridge) -> blocked, no version", () => {
    expect(
      snapshotTabGate(
        { targets: [], configuredInstances: [] },
        "configDefaults",
      ),
    ).toEqual({
      blocked: true,
      gatewayVersion: null,
      provider: null,
    });
  });

  test("single supporting instance -> open", () => {
    expect(
      snapshotTabGate(
        {
          targets: [target("main", "2026.6.5", FULL)],
          configuredInstances: ["main"],
        },
        "configDefaults",
      ),
    ).toEqual({ blocked: false, gatewayVersion: null, provider: null });
  });

  test("single non-supporting instance -> blocked with ITS version", () => {
    expect(
      snapshotTabGate(
        {
          targets: [target("main", "2026.5.19", OLD_GATEWAY)],
          configuredInstances: ["main"],
        },
        "configDefaults",
      ),
    ).toEqual({ blocked: true, gatewayVersion: "2026.5.19", provider: null });
  });

  test("several instances all supporting -> open (the write is safe anywhere)", () => {
    expect(
      snapshotTabGate(
        {
          targets: [
            target("alpha", "2026.6.5", FULL),
            target("beta", "2026.6.5", FULL),
          ],
          configuredInstances: ["alpha", "beta"],
        },
        "configDefaults",
      ),
    ).toEqual({ blocked: false, gatewayVersion: null, provider: null });
  });

  test("several instances, one lagging -> blocked, names the offender's version", () => {
    expect(
      snapshotTabGate(
        {
          targets: [
            target("alpha", "2026.6.5", FULL),
            target("beta", "2026.5.19", OLD_GATEWAY),
          ],
          configuredInstances: ["alpha", "beta"],
        },
        "configDefaults",
      ),
    ).toEqual({ blocked: true, gatewayVersion: "2026.5.19", provider: null });
  });

  test("a CONFIGURED instance absent from the live targets -> fail CLOSED (Codex P2)", () => {
    // Two instances configured, only one has a live session: the bridge's
    // default-instance resolution could land the write on the absent one,
    // whose version the gate knows nothing about — blocked, unknown version.
    expect(
      snapshotTabGate(
        {
          targets: [target("alpha", "2026.6.5", FULL)],
          configuredInstances: ["alpha", "beta"],
        },
        "configDefaults",
      ),
    ).toEqual({ blocked: true, gatewayVersion: null, provider: null });
  });

  test("no configured instances on record -> live targets are the best knowledge", () => {
    expect(
      snapshotTabGate(
        {
          targets: [target("main", "2026.6.5", FULL)],
          configuredInstances: [],
        },
        "configDefaults",
      ),
    ).toEqual({ blocked: false, gatewayVersion: null, provider: null });
  });
});
