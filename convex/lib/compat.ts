// Bridge version/compat helpers (pure, ctx-free).
//
// The bridge's unauthenticated GET /capabilities gained ADDITIVE fields
// (protocolVersion 2): `bridgeVersion`, `protocolVersion`, a CompatManifest
// (per-provider supportedRange / validatedVersions / capability->minVersion)
// and per-live-session capability `targets`. These helpers defensively
// normalize that NETWORK body (every field validated; an OLD bridge without
// the new fields normalizes to compat:null — the frontend has a legacy policy
// for that) and derive the /api/v1/compat summary. Pure + ctx-free so the
// poller, the queries, the HTTP route and the unit tests share one
// implementation (same idiom as bridgeHealth.normalizeTarget).

/** One stored capability target (per instance, deduped from the bridge's
 *  per-session entries). Non-secret: names, versions, capability booleans. */
export type CompatTarget = {
  instanceName: string;
  provider: string; // "openclaw" | "hermes" | future — free string (fwd-compat)
  gatewayVersion: string | null;
  capabilities: Record<string, boolean>;
  versionBeyondValidated: boolean;
  /** The serving bridge's env rehydration default (stamped by the poller). */
  rehydrationDefault?: boolean | null;
  turnSessionEcho?: boolean | null;
};

/** The normalized, storable projection of a /capabilities response body. */
export type NormalizedCapabilities = {
  bridgeVersion: string | null;
  /** Build-time truths (image env, frozen by CI): the stamped version + git sha.
   *  null on a pre-0.19.3 bridge. A buildVersion differing from bridgeVersion
   *  means the deployed container is not the build it claims. */
  buildVersion: string | null;
  buildRevision: string | null;
  /** The bridge's env-level rehydration default (OPENCLAW_REHYDRATION kill-switch;
   *  null on pre-feature bridges = assume enabled). */
  rehydrationDefault: boolean | null;
  /** The bridge echoes turn session keys (deterministic summarize correlation).
   *  null = pre-feature bridge. */
  turnSessionEcho: boolean | null;
  protocolVersion: number | null;
  /** CompatManifest verbatim (bounded), or null = legacy bridge / bad shape. */
  compat: unknown;
  /** Protocol-contract section (vendored schema version + coverage matrix +
   *  runtime drift), bounded; null = pre-0.23 bridge. */
  protocol: BridgeProtocolInfo | null;
  targets: CompatTarget[];
}

/** The bridge's protocol-contract self-description (see the bridge's
 *  protocol-drift.ts): all fields defensive-parsed + size-bounded here. */
export type BridgeProtocolInfo = {
  vendoredVersion: string;
  coverage: {
    handled: number;
    ignored: number;
    gaps: number;
    gapList: string[];
  } | null;
  drift: { shape: string; count: number }[];
};

/** A provider's support window as read from the CompatManifest. */
export type ProviderSupport = {
  range: { min: string; maxValidated: string } | null;
  validatedVersions: string[];
};

/** The /api/v1/compat response payload (minus the `ok` envelope). */
export type CompatSummary = {
  bridge: {
    version: string | null;
    protocolVersion: number | null;
    supported: { openclaw: ProviderSupport };
  };
  // Snapshot freshness/health — so a key-authed reader (the observer API) can
  // tell a FRESH poll from a stale last-good one, and a successful poll from a
  // preserved-on-failure one, WITHOUT UI access. `reachable:false` keeps the
  // last-good `instances`; `fetchedAt` is the timestamp of the LAST poll attempt
  // (success or failure). Null only when no poll has ever run.
  reachable: boolean | null;
  lastError: string | null;
  fetchedAt: number | null;
  instances: Array<{
    instanceName: string;
    provider: string;
    gatewayVersion: string | null;
    withinSupport: boolean;
    versionBeyondValidated: boolean;
  }>;
};

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

// The manifest is stored verbatim under v.any(); bound it so a drifted/bloated
// bridge response can never balloon the singleton doc toward the 1MB doc limit.
const COMPAT_MANIFEST_MAX_CHARS = 64 * 1024;

/** STRICT parse of a gateway version ("2026.6.5", or a pre-release like
 *  "2026.7.1-beta.2"): EXACTLY three dot-separated non-negative integers with
 *  an optional semver-style `-<tag>` suffix; null otherwise. Mirrors the
 *  bridge's parseVersion (src/compat.ts) so the BridgeTab support badge can
 *  never contradict the capabilities the bridge actually resolved — both sides
 *  fail CLOSED on the same inputs. */
export function parseVersion(
  version: string,
): { nums: number[]; pre: string | null } | null {
  // Pre-release tag = dot-separated NON-EMPTY alphanumeric identifiers
  // (semver); mirrors the bridge parser exactly.
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!m) return null;
  return {
    nums: [m[1], m[2], m[3]].map((p) => Number.parseInt(p as string, 10)),
    pre: m[4] ?? null,
  };
}

/** Semver-style pre-release tag comparison (dot-separated identifiers:
 *  numeric compare when both numeric, numeric < alphanumeric, shorter wins). */
function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : null;
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) {
      return -1;
    } else if (ny !== null) {
      return 1;
    } else {
      const c = x < y ? -1 : x > y ? 1 : 0;
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** Version comparison: numeric on the three parts; on a tie a PRE-RELEASE
 *  orders BEFORE its release (2026.7.1-beta.2 < 2026.7.1), semver-style.
 *  Returns null when either side is unparseable (fail closed). */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] as number) - (pb.nums[i] as number);
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

/** Is `gatewayVersion` within the provider's support window? Fail CLOSED: an
 *  unknown version, an unparseable version, or a provider with no published
 *  range (e.g. hermes today) is NOT "within support". Versions ABOVE
 *  maxValidated are still within support (supported-but-unvalidated — that
 *  nuance rides on the separate `versionBeyondValidated` flag). */
export function withinSupport(
  range: { min: string; maxValidated: string } | null,
  gatewayVersion: string | null,
): boolean {
  if (range === null || gatewayVersion === null) return false;
  const cmp = compareVersions(gatewayVersion, range.min);
  return cmp !== null && cmp >= 0;
}

/** A storable capability-record key (Convex record keys must be non-empty
 *  ASCII not starting with "$" or "_"). */
function storableKey(key: string): boolean {
  if (key.length === 0) return false;
  if (key.startsWith("$") || key.startsWith("_")) return false;
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]+$/.test(key);
}

/** Flatten ONE target from the bridge /capabilities JSON. Defensive: the body
 *  came over the network, so validate every field; null on a bad shape. Drops
 *  the per-session fields (key/agentId) we do not store. */
export function normalizeCompatTarget(raw: unknown): CompatTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const instanceName = str(o.instanceName);
  const provider = str(o.provider);
  if (instanceName === null || provider === null) return null;
  const capabilities: Record<string, boolean> = {};
  if (typeof o.capabilities === "object" && o.capabilities !== null) {
    for (const [k, val] of Object.entries(
      o.capabilities as Record<string, unknown>,
    )) {
      if (typeof val === "boolean" && storableKey(k)) capabilities[k] = val;
    }
  }
  return {
    instanceName,
    provider,
    gatewayVersion: str(o.gatewayVersion),
    capabilities,
    versionBeyondValidated: o.versionBeyondValidated === true,
  };
}

/** Dedupe per-session targets down to ONE per instance. The bridge emits one
 *  entry per live session (deduped by canonical), but gatewayVersion +
 *  capabilities are per-INSTANCE facts: keep the first entry, upgrading to a
 *  later one only when it carries a gatewayVersion the kept one lacks. */
export function dedupeTargetsByInstance(
  targets: CompatTarget[],
): CompatTarget[] {
  const byInstance = new Map<string, CompatTarget>();
  for (const t of targets) {
    const cur = byInstance.get(t.instanceName);
    if (cur === undefined || (cur.gatewayVersion === null && t.gatewayVersion !== null)) {
      byInstance.set(t.instanceName, t);
    }
  }
  return [...byInstance.values()];
}

/** Bound the CompatManifest for storage: must be a plain JSON object and small
 *  enough that the singleton doc stays far from the 1MB limit; null otherwise.
 *  The JSON round-trip also strips non-Convex values (undefined/functions). */
export function boundCompatManifest(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  try {
    const json = JSON.stringify(raw);
    if (typeof json !== "string" || json.length > COMPAT_MANIFEST_MAX_CHARS) {
      return null;
    }
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** Normalize a whole /capabilities response body. BACKWARD SKEW: an old bridge
 *  (no bridgeVersion/protocolVersion/compat/targets) normalizes to nulls + an
 *  empty target list — the reader treats compat:null as "legacy bridge".
 *
 *  `servedInstance` (= the deployment's BRIDGE_INSTANCE_NAME) makes Convex the
 *  AUTHORITY on instance identity: the bridge reports the raw `gatewayVersion`
 *  of the single gateway it serves at the TOP LEVEL, and when no per-session
 *  target already covers the served instance, we SYNTHESIZE its target here —
 *  resolving capabilities from the manifest ourselves. This removes the bridge's
 *  need to echo OPENCLAW_INSTANCE_NAME for the version-gated UI to resolve (an
 *  idle bridge with no live session still yields the served instance's caps). */
// Bounds for the protocol section (a hostile/buggy bridge must not bloat the
// singleton doc): short strings, capped lists.
const PROTOCOL_MAX_LIST = 100;
const PROTOCOL_MAX_STR = 120;

/** Defensive parse of the /capabilities `protocol` section. null on any
 *  missing/foreign shape (pre-0.23 bridge). */
export function boundProtocolInfo(raw: unknown): BridgeProtocolInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const vendored = str(o.vendoredVersion);
  if (vendored === null) return null;
  let coverage: BridgeProtocolInfo["coverage"] = null;
  if (typeof o.coverage === "object" && o.coverage !== null) {
    const c = o.coverage as Record<string, unknown>;
    const n = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    const handled = n(c.handled);
    const ignored = n(c.ignored);
    const gaps = n(c.gaps);
    if (handled !== null && ignored !== null && gaps !== null) {
      const gapList = (Array.isArray(c.gapList) ? c.gapList : [])
        .filter((g): g is string => typeof g === "string")
        .slice(0, PROTOCOL_MAX_LIST)
        .map((g) => g.slice(0, PROTOCOL_MAX_STR));
      coverage = { handled, ignored, gaps, gapList };
    }
  }
  const drift = (Array.isArray(o.drift) ? o.drift : [])
    .map((d): { shape: string; count: number } | null => {
      if (typeof d !== "object" || d === null) return null;
      const e = d as Record<string, unknown>;
      const shape = typeof e.shape === "string" ? e.shape : null;
      const count =
        typeof e.count === "number" && Number.isFinite(e.count) ? e.count : null;
      return shape !== null && count !== null
        ? { shape: shape.slice(0, PROTOCOL_MAX_STR), count }
        : null;
    })
    .filter((d): d is { shape: string; count: number } => d !== null)
    .slice(0, PROTOCOL_MAX_LIST);
  return { vendoredVersion: vendored.slice(0, PROTOCOL_MAX_STR), coverage, drift };
}

/**
 * Merge two bridges' protocol sections (multi-bridge deployments): drift is a
 * PER-BRIDGE runtime observation, so it must UNION across bridges (counts
 * summed per shape) — first-wins would hide a drifting instance behind an
 * aligned one. vendoredVersion/coverage keep the first bridge's values (one
 * image per deployment; a rolling-upgrade divergence is transient and does not
 * change the counts' meaning).
 */
export function mergeProtocolInfo(
  a: BridgeProtocolInfo | null,
  b: BridgeProtocolInfo | null,
): BridgeProtocolInfo | null {
  if (a === null) return b;
  if (b === null) return a;
  const merged = new Map(a.drift.map((d) => [d.shape, d.count]));
  for (const d of b.drift) {
    merged.set(d.shape, (merged.get(d.shape) ?? 0) + d.count);
  }
  return {
    ...a,
    drift: [...merged.entries()]
      .map(([shape, count]) => ({ shape, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, PROTOCOL_MAX_LIST),
  };
}

export function normalizeCapabilitiesBody(
  raw: unknown,
  servedInstance?: string | null,
): NormalizedCapabilities {
  const o = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Record<string, unknown>;
  const targetsRaw = Array.isArray(o.targets) ? o.targets : [];
  let targets = dedupeTargetsByInstance(
    targetsRaw
      .map(normalizeCompatTarget)
      .filter((t): t is CompatTarget => t !== null),
  );
  const compat = boundCompatManifest(o.compat);

  // Convex owns instance identity: attribute + resolve the served instance from
  // the bridge's top-level gateway version when no per-session target covers it.
  const topGatewayVersion = str(o.gatewayVersion);
  if (
    servedInstance &&
    topGatewayVersion !== null &&
    !targets.some((t) => t.instanceName === servedInstance)
  ) {
    // Provider is hardcoded "openclaw": the bridge is openclaw-only today (one
    // gateway per bridge). When Hermes lands (Phase 3), the bridge must report a
    // top-level provider alongside gatewayVersion and this reads it instead.
    const resolved = resolveCapabilitiesFromManifest(
      compat,
      "openclaw",
      topGatewayVersion,
    );
    // Only synthesize when the manifest actually resolved a capability table — a
    // legacy bridge (compat:null) yields none, so we leave it to the legacy policy
    // instead of inventing an all-false target.
    if (Object.keys(resolved.capabilities).length > 0) {
      targets = [
        ...targets,
        {
          instanceName: servedInstance,
          provider: "openclaw",
          gatewayVersion: topGatewayVersion,
          capabilities: resolved.capabilities,
          versionBeyondValidated: resolved.versionBeyondValidated,
        },
      ];
    }
  }

  return {
    bridgeVersion: str(o.bridgeVersion),
    buildVersion: str(o.buildVersion),
    buildRevision: str(o.buildRevision),
    rehydrationDefault:
      typeof o.rehydrationDefault === "boolean" ? o.rehydrationDefault : null,
    turnSessionEcho:
      typeof o.turnSessionEcho === "boolean" ? o.turnSessionEcho : null,
    protocolVersion:
      typeof o.protocolVersion === "number" ? o.protocolVersion : null,
    compat,
    protocol: boundProtocolInfo(o.protocol),
    targets,
  };
}

/** Read one provider's support window out of a stored CompatManifest.
 *  Defensive (the manifest is stored verbatim as v.any()): any missing/odd
 *  shape degrades to { range: null, validatedVersions: [] }. */
export function providerSupport(
  compat: unknown,
  provider: string,
): ProviderSupport {
  const none: ProviderSupport = { range: null, validatedVersions: [] };
  if (typeof compat !== "object" || compat === null) return none;
  const providers = (compat as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return none;
  const entry = (providers as Record<string, unknown>)[provider];
  if (typeof entry !== "object" || entry === null) return none;
  const e = entry as Record<string, unknown>;
  let range: ProviderSupport["range"] = null;
  if (typeof e.supportedRange === "object" && e.supportedRange !== null) {
    const r = e.supportedRange as Record<string, unknown>;
    const min = str(r.min);
    const maxValidated = str(r.maxValidated);
    if (min !== null && maxValidated !== null) range = { min, maxValidated };
  }
  const validatedVersions = Array.isArray(e.validatedVersions)
    ? e.validatedVersions.filter((x): x is string => typeof x === "string")
    : [];
  return { range, validatedVersions };
}

/** Read a provider's capability->minVersion table out of a stored CompatManifest.
 *  Defensive (manifest is v.any()): any odd shape degrades to {}. */
export function providerCapabilityTable(
  compat: unknown,
  provider: string,
): Record<string, string> {
  if (typeof compat !== "object" || compat === null) return {};
  const providers = (compat as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return {};
  const entry = (providers as Record<string, unknown>)[provider];
  if (typeof entry !== "object" || entry === null) return {};
  const caps = (entry as Record<string, unknown>).capabilities;
  if (typeof caps !== "object" || caps === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(caps as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Resolve a provider's capability table against a gateway version, from the
 *  stored CompatManifest. EXACT MIRROR of the bridge's resolveCapabilities
 *  (src/compat.ts) so Convex — which OWNS instance identity (BRIDGE_INSTANCE_NAME)
 *  — can attribute + resolve capabilities for the served instance itself, even
 *  when the bridge reports no per-session target. Policy (identical to the bridge):
 *   - provider with no published range: zero capabilities;
 *   - null/unparseable version: CONSERVATIVE floor — a capability is true only
 *     when its minVersion IS the supported floor (`range.min`);
 *   - version within range: true iff version >= its minVersion;
 *   - version beyond `maxValidated`: every capability true + `versionBeyondValidated`.
 *  Both sides fail CLOSED on the same inputs (the `parseVersion` mirror guarantees it). */
export function resolveCapabilitiesFromManifest(
  compat: unknown,
  provider: string,
  gatewayVersion: string | null,
): { capabilities: Record<string, boolean>; versionBeyondValidated: boolean } {
  const range = providerSupport(compat, provider).range;
  if (range === null) return { capabilities: {}, versionBeyondValidated: false };
  const table = providerCapabilityTable(compat, provider);
  const capabilities: Record<string, boolean> = {};
  const parsed = gatewayVersion === null ? null : parseVersion(gatewayVersion);
  if (parsed === null) {
    for (const [cap, minVersion] of Object.entries(table)) {
      capabilities[cap] = minVersion === range.min;
    }
    return { capabilities, versionBeyondValidated: false };
  }
  const beyondCmp = compareVersions(gatewayVersion as string, range.maxValidated);
  const beyond = beyondCmp !== null && beyondCmp > 0;
  for (const [cap, minVersion] of Object.entries(table)) {
    const cmp = compareVersions(gatewayVersion as string, minVersion);
    capabilities[cap] = beyond || (cmp !== null && cmp >= 0);
  }
  return { capabilities, versionBeyondValidated: beyond };
}

/** Build the /api/v1/compat summary from the stored snapshot (or null when no
 *  poll has landed yet): "what does the bridge support, what are my instances
 *  running". Pure so the answer is unit-testable without auth/HTTP. */
export function summarizeCompat(
  doc: {
    bridgeVersion: string | null;
    protocolVersion: number | null;
    compat: unknown;
    targets: CompatTarget[];
    reachable?: boolean;
    lastError?: string | null;
    fetchedAt?: number;
  } | null,
): CompatSummary {
  if (doc === null) {
    return {
      bridge: {
        version: null,
        protocolVersion: null,
        supported: { openclaw: { range: null, validatedVersions: [] } },
      },
      reachable: null,
      lastError: null,
      fetchedAt: null,
      instances: [],
    };
  }
  return {
    bridge: {
      version: doc.bridgeVersion,
      protocolVersion: doc.protocolVersion,
      supported: { openclaw: providerSupport(doc.compat, "openclaw") },
    },
    reachable: doc.reachable ?? null,
    lastError: doc.lastError ?? null,
    fetchedAt: doc.fetchedAt ?? null,
    instances: doc.targets.map((t) => ({
      instanceName: t.instanceName,
      provider: t.provider,
      gatewayVersion: t.gatewayVersion,
      withinSupport: withinSupport(
        providerSupport(doc.compat, t.provider).range,
        t.gatewayVersion,
      ),
      versionBeyondValidated: t.versionBeyondValidated,
    })),
  };
}

/** Per-instance capability projection ({ provider, gatewayVersion,
 *  capabilities }) or null when the instance is unknown to the compat snapshot
 *  (legacy bridge / never polled) — the frontend's legacy policy handles null. */
export function capabilitiesForInstance(
  targets: CompatTarget[],
  instanceName: string,
): {
  provider: string;
  gatewayVersion: string | null;
  capabilities: Record<string, boolean> | null;
  versionBeyondValidated: boolean;
} | null {
  const t = targets.find((x) => x.instanceName === instanceName);
  if (t === undefined) return null;
  return {
    provider: t.provider,
    gatewayVersion: t.gatewayVersion,
    capabilities: t.capabilities,
    versionBeyondValidated: t.versionBeyondValidated,
  };
}
