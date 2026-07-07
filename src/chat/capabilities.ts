// Frontend capability contract (VCOMPAT-C) — capability-driven UI gating.
//
// PURE module (no React, no i18n): the single place that decides whether a
// given UI affordance is supported by the gateway instance behind a chat. The
// data comes from the bridge's /capabilities manifest, polled into the
// `bridgeCompat` singleton and read through api.compat.forChat / forInstance /
// getBridgeCompat.
//
// CAPABILITY_KEYS is the frozen list of keys this UI consumes. It is a
// DELIBERATE duplicate of the bridge manifest's capability table
// (atrium-bridge src/compat.ts OPENCLAW_CAPABILITIES): the two repos
// ship on separate cycles, so neither can import the other — instead BOTH
// sides pin the list with tests (capabilities.test.ts here, the manifest test
// bridge-side) so any drift is a CONSCIOUS, reviewed change.
//
// LOCKSTEP: the `CapabilityKey` union CLOSES the list at compile time — a UI
// gate referencing a key outside CAPABILITY_KEYS does not typecheck (`tsc` is
// the real gate). `capabilityOf` additionally fails CLOSED at runtime (false)
// for any non-contract key smuggled through an `any` cast, and
// capabilities.test.ts pins the exact list contents.

export const CAPABILITY_KEYS = [
  "knobThinkingLevel",
  "knobModel",
  "knobFastMode",
  "knobUnset",
  "agentFiles",
  "sessionCompact",
  "configDefaults",
  "subagents",
  "inboundAttachments",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(CAPABILITY_KEYS);

/** Runtime membership check (the type union is the compile-time gate). */
export function isCapabilityKey(key: string): key is CapabilityKey {
  return CAPABILITY_KEY_SET.has(key);
}

/**
 * BACKWARD SKEW policy: when compat is null (an OLD bridge without the
 * /capabilities additive fields, an instance unknown to the snapshot, or the
 * query still loading) the UI assumes exactly the HISTORIC UI-3 surface:
 * model + thinking-level write-back, nothing newer. Everything else stays
 * hidden — never offer a control the gateway may not honor.
 */
export const LEGACY_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set([
  "knobThinkingLevel",
  "knobModel",
]);

/**
 * Is `key` supported, given an instance's capability record?
 *  - caps null/undefined → the LEGACY policy (old bridge / unknown / loading);
 *  - key absent from caps or not strictly true → false (CONSERVATIVE — an
 *    empty record means "nothing supported", unlike null);
 *  - caps carrying FUTURE keys this UI does not know → ignored without error
 *    (forward compat: a newer bridge must not break an older frontend).
 */
export function capabilityOf(
  caps: Record<string, boolean> | null | undefined,
  key: CapabilityKey,
): boolean {
  if (!CAPABILITY_KEY_SET.has(key)) return false; // belt for `any`-cast callers
  if (caps == null) return LEGACY_CAPABILITIES.has(key);
  return caps[key] === true;
}

// ---------------------------------------------------------------------------
// Pure gating projections — extracted from the components so the capability ×
// control matrix is table-testable without a DOM harness (GC-P5 lesson).
// ---------------------------------------------------------------------------

/** Which session-knob rows/affordances render (SessionKnobsGroup, CONF-4a). */
export type KnobVisibility = {
  model: boolean;
  thinking: boolean;
  speed: boolean;
  /** The per-row ↺ reset-to-inherited button (explicit gateway unset). */
  reset: boolean;
};

/** Capability gate ∧ data presence: a row needs BOTH the gateway capability
 *  and the sessionMeta data that feeds its options. */
export function knobRowVisibility(
  can: (key: CapabilityKey) => boolean,
  data: { hasModels: boolean; hasLevels: boolean },
): KnobVisibility {
  return {
    model: can("knobModel") && data.hasModels,
    thinking: can("knobThinkingLevel") && data.hasLevels,
    speed: can("knobFastMode"),
    reset: can("knobUnset"),
  };
}

/** The api.compat.forChat / forInstance projection consumed by the gates. */
export type InstanceCompat = {
  provider: string;
  gatewayVersion: string | null;
  capabilities: Record<string, boolean> | null;
  versionBeyondValidated: boolean;
} | null;

/**
 * Whole-tab gate verdict. Unlike the popover knobs (hidden — the popover stays
 * lean), a blocked TAB is disabled-and-explained: the user must understand WHY
 * the surface is unavailable, hence the gatewayVersion for the banner.
 */
export type TabGate =
  | "loading"
  | { blocked: boolean; gatewayVersion: string | null; provider: string | null };

/**
 * Gate a Settings tab on ONE instance's capability (AgentFilesTab — the
 * instance is the selected agent's). `undefined` = query in flight: the tab
 * shows its loading state rather than flashing content that may get blocked.
 * `null` = instance unknown to the compat snapshot → legacy policy.
 */
export function instanceTabGate(
  res: InstanceCompat | undefined,
  key: CapabilityKey,
): TabGate {
  if (res === undefined) return "loading";
  if (res === null) {
    return {
      blocked: !capabilityOf(null, key),
      gatewayVersion: null,
      provider: null,
    };
  }
  return {
    blocked: !capabilityOf(res.capabilities, key),
    gatewayVersion: res.gatewayVersion,
    // The provider drives the blocked-banner wording: a capability a PROVIDER
    // simply does not have ("Hermes n'a pas cette fonction") reads differently
    // from an OpenClaw gateway whose VERSION is unknown/too old.
    provider: res.provider,
  };
}

/** The slice of api.compat.getBridgeCompat the snapshot gate needs. */
export type CompatSnapshotSlice = {
  targets: Array<{
    instanceName: string;
    gatewayVersion: string | null;
    capabilities: Record<string, boolean>;
  }>;
  /** Every instance the deployment has CONFIGURED (instances table — the list
   *  convex/agentFiles.resolveInstanceClaim resolves the write target from),
   *  as opposed to `targets` which only carries instances with a LIVE session. */
  configuredInstances: string[];
} | null;

/**
 * Gate a Settings tab that targets the bridge's DEFAULT instance
 * (ChatDefaultsTab — its action mirrors convex/agentFiles.resolveInstanceClaim:
 * exactly one known instance → that one; otherwise the bridge routes to its own
 * default, which the frontend cannot name). Policy, mirroring that resolution:
 *  - snapshot null (never polled) or zero targets → legacy policy (blocked);
 *  - every CONFIGURED instance must be PRESENT in the live targets AND support
 *    the key — a configured instance absent from the snapshot fails CLOSED,
 *    because the bridge's default-instance resolution could land the write on
 *    it while the gate knows nothing about its version (Codex review P2);
 *  - the live targets must ALL support the key too (covers deployments whose
 *    instances table is empty while sessions exist — best available knowledge).
 */
export function snapshotTabGate(
  snapshot: CompatSnapshotSlice | undefined,
  key: CapabilityKey,
): TabGate {
  if (snapshot === undefined) return "loading";
  if (snapshot === null || snapshot.targets.length === 0) {
    return { blocked: !capabilityOf(null, key), gatewayVersion: null, provider: null };
  }
  const live = new Set(snapshot.targets.map((t) => t.instanceName));
  const missing = snapshot.configuredInstances.find((name) => !live.has(name));
  if (missing !== undefined) {
    return { blocked: true, gatewayVersion: null, provider: null };
  }
  const failing = snapshot.targets.find((t) => !capabilityOf(t.capabilities, key));
  if (failing === undefined) {
    return { blocked: false, gatewayVersion: null, provider: null };
  }
  return {
    blocked: true,
    gatewayVersion: failing.gatewayVersion,
    provider: (failing as { provider?: string }).provider ?? null,
  };
}
