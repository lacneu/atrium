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
  /** Drift observations the BRIDGE could not name (its tracked-shape cap). 0 on a bridge
   *  that predates the field — absence is not zero drift, but it is all we can say. */
  driftOverflow: number;
  /** Named shapes THIS boundary refused to store (its own list cap). */
  driftTruncated: number;
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
  /** Protocol-contract section: the bridge's vendored schema surface + the LIVE
   *  drift (payload field names the gateway emits that this bridge build does
   *  not know, with occurrence counts). Field NAMES only — never values, never
   *  conversation content (SOC2). Null on a legacy bridge that reports none.
   *  Exposed so the observer API / MCP can diagnose "N unknown field(s)"
   *  without UI access. */
  protocol: BridgeProtocolInfo | null;
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
/** How many RAW drift entries this parse will even look at.
 *
 *  The stored list was capped, but the WORK was not: a bridge answering with a million
 *  entries had every one of them mapped, string-sliced and indexed into a Map before the
 *  cap applied, so the bound protected the document and not the poll that builds it.
 *  A bound that only applies after the expensive part is not a bound.
 *
 *  Larger than the stored cap on purpose: the fold hands this function the union of every
 *  polled bridge (up to PROTOCOL_MAX_LIST per bridge), and both the bridge's report and
 *  the fold arrive sorted by count, so the first entries are the loudest ones. The margin
 *  keeps deduplication from costing a stored slot in any realistic deployment. */
const PROTOCOL_MAX_RAW_DRIFT = 8 * PROTOCOL_MAX_LIST;

/** FNV-1a, 32 bits, hex. A DISAMBIGUATOR, not a security primitive: it only has to make
 *  two different names that share a long prefix land on different keys. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Bound a shape name to PROTOCOL_MAX_STR **without merging distinct names**.
 *
 *  A plain `slice` made two different field names sharing their first 120 characters into
 *  one key. That was accounted for as a collision INSIDE a single parse — but the fold
 *  across bridges only ever sees keys, never originals, so two bridges each reporting one
 *  of the pair produced a single summed entry and `driftTruncated: 0`: a distinct unknown
 *  shape lost, silently, in the exact multi-bridge case the fold exists to preserve
 *  (raised in review). A suffix derived from the WHOLE name keeps them apart everywhere.
 *  The suffix is derived from a field NAME, which is already what this surface displays —
 *  no value, no content (SOC2). */
function boundShapeName(shape: string): string {
  if (shape.length <= PROTOCOL_MAX_STR) return shape;
  return `${shape.slice(0, PROTOCOL_MAX_STR - 9)}…${shortHash(shape)}`;
}

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
    // INTEGER, not merely finite. These are observation counts; `1.5 handled` is a
    // malformed payload, and accepting it printed a fractional tally in the operator
    // badge. Same rule as the drift counts below.
    const n = (v: unknown): number | null =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
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
  const allRawDrift = Array.isArray(o.drift) ? o.drift : [];
  // BOUNDED BEFORE THE WALK (see PROTOCOL_MAX_RAW_DRIFT): the cap used to apply to the
  // stored list only, so a bridge could still make every poll map and index a million
  // entries. What is skipped here is counted as truncation like anything else.
  const rawDrift = allRawDrift.slice(0, PROTOCOL_MAX_RAW_DRIFT);
  const unread = allRawDrift.length - rawDrift.length;
  // The ORIGINAL name is kept alongside the truncated one. Truncating first and then
  // looking for duplicates made two IDENTICAL names look like a collision — the same
  // phantom loss as at the merge, one layer up. Only two DIFFERENT originals converging on
  // one key is a lost distinction.
  const drift = rawDrift
    .map((d): { shape: string; original: string; count: number } | null => {
      if (typeof d !== "object" || d === null) return null;
      const e = d as Record<string, unknown>;
      const shape = typeof e.shape === "string" ? e.shape : null;
      // A NEGATIVE count is malformed, not zero. Clamping it to 0 kept the shape with an
      // "× 0" that reads as "observed never" — a claim the payload never made — and it
      // escaped the rejected tally too.
      // A FRACTIONAL count is malformed for the same reason and used to fail the same way:
      // accepted here as finite, then floored by `clampCount`, so `0.5` became the very
      // "× 0" the negative branch above exists to prevent — and, being kept, it never
      // reached the rejected tally either. An observation count is an integer.
      const count =
        typeof e.count === "number" && Number.isInteger(e.count) && e.count >= 0
          ? e.count
          : null;
      return shape !== null && count !== null
        ? { shape: boundShapeName(shape), original: shape, count }
        : null;
    })
    .filter(
      (d): d is { shape: string; original: string; count: number } => d !== null,
    );
  // The SECOND half of a double silent loss. The bridge caps its tracked shapes and
  // reports how many it dropped; this side then sliced the list again and said nothing, so
  // an operator reading the badge saw a number that was short twice over for two different
  // reasons. Both are now named: `driftOverflow` is what the BRIDGE could not name,
  // `driftTruncated` is what THIS boundary refused to store.
  // The INCOMING count is carried, not recomputed from scratch. `boundProtocolInfo` runs
  // again on an already-merged document (summarizeCompat re-bounds it), and recomputing
  // from `drift.length` alone reset a merge's truncation to zero — the third loss became
  // silent again one function later, which is the whole defect this lot is about.
  // NO `isFinite` pre-filter. It ran BEFORE the clamp, so `Infinity` was rejected and
  // replaced by 0 — the clamp could never do the one thing it was added for (raised in
  // review, after I had already made this mistake once inside clampCount itself).
  const incomingTruncated =
    typeof o.driftTruncated === "number" ? clampCount(o.driftTruncated) : 0;
  // Re-clamped: a capped value plus the newly dropped entries can exceed the cap again.
  // A named shape DROPPED by this parse (malformed, or a non-finite count) is a loss like
  // any other: it counts, rather than disappearing between two green numbers.
  // Two DISTINCT shapes collapsing into one key is now prevented rather than accounted
  // for (`boundShapeName` disambiguates a truncated name by a suffix of the whole
  // original). The counter stays as the fail-safe for the residual case a 32-bit
  // disambiguator allows, and is counted here, at the only place the originals are still
  // visible — the fold downstream sees keys only.
  // …and their COUNTS are summed, not dropped with the duplicate. Keeping only the first
  // entry warned the operator of a collision and then under-reported the drift volume
  // behind it (raised in review): the distinction is what was lost, not the observations.
  const byShape = new Map<string, { count: number; originals: Set<string> }>();
  for (const d of drift) {
    const entry = byShape.get(d.shape) ?? { count: 0, originals: new Set<string>() };
    entry.count = clampCount(entry.count + d.count);
    entry.originals.add(d.original);
    byShape.set(d.shape, entry);
  }
  // A collision is a lost DISTINCTION: two different names now indistinguishable. The same
  // name twice is just the same shape twice, and reporting it as a loss would be the
  // phantom the merge layer was already corrected for.
  let collided = 0;
  for (const entry of byShape.values()) {
    collided += entry.originals.size - 1;
  }
  const deduped = [...byShape.entries()].map(([shape, e]) => ({
    shape,
    count: e.count,
  }));
  const rejected = Math.max(0, rawDrift.length - drift.length) + collided;
  const driftTruncated = clampCount(
    incomingTruncated +
      rejected +
      unread +
      Math.max(0, deduped.length - PROTOCOL_MAX_LIST),
  );
  const driftOverflow =
    typeof o.driftOverflow === "number" ? clampCount(o.driftOverflow) : 0;
  return {
    vendoredVersion: vendored.slice(0, PROTOCOL_MAX_STR),
    coverage,
    drift: deduped.slice(0, PROTOCOL_MAX_LIST),
    driftOverflow,
    driftTruncated,
  };
}

/**
 * Merge two bridges' protocol sections (multi-bridge deployments): drift is a
 * PER-BRIDGE runtime observation, so it must UNION across bridges (counts
 * summed per shape) — first-wins would hide a drifting instance behind an
 * aligned one. vendoredVersion/coverage keep the first bridge's values (one
 * image per deployment; a rolling-upgrade divergence is transient and does not
 * change the counts' meaning).
 *
 * The RESULT IS NOT BOUNDED (see `drift` below): pass the final value of the fold
 * through `boundProtocolInfo` before storing it.
 */
/** A loss counter, bounded and finite.
 *
 *  `Infinity` clamps UP to the cap, not down to zero. The first version returned 0 for any
 *  non-finite input — which reproduced the exact failure it was written to prevent: an
 *  overflowing sum became "nothing was dropped". Only NaN and negatives are meaningless,
 *  and those are the only inputs that yield 0. */
function clampCount(n: number): number {
  if (Number.isNaN(n) || n <= 0) return 0;
  if (!Number.isFinite(n)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function mergeProtocolInfo(
  a: BridgeProtocolInfo | null,
  b: BridgeProtocolInfo | null,
): BridgeProtocolInfo | null {
  if (a === null) return b;
  if (b === null) return a;
  // Counts are CLAMPED as they are summed. Two valid entries at `Number.MAX_VALUE` for the
  // same shape gave Infinity, which the next parse rejects as non-finite — so the SHAPE
  // itself vanished, with no counter naming the loss (raised in review). Same failure as
  // the two loss counters had, on the list they were meant to account for.
  const merged = new Map(a.drift.map((d) => [d.shape, clampCount(d.count)]));
  // A shape present on BOTH sides is the normal union — the same unknown field seen by two
  // bridges — and its counts are summed. It is NOT counted as a truncation collision.
  //
  // A correction of my own fix. A previous version counted every shared key as a
  // collision, which reported a loss for the most ordinary case there is: two bridges
  // seeing the same drift. A phantom loss on an operator badge is worse than a missed one
  // — it teaches people to ignore the number.
  //
  // This layer sees keys only, never the originals, so it could never distinguish "same
  // shape" from "two long names truncated alike" — which was a real, silent loss for
  // exactly the multi-bridge case this function exists to serve (raised in review). It is
  // fixed UPSTREAM, in `boundShapeName`: two different names can no longer produce one
  // key, so summing a shared key here is unambiguously a union.
  for (const d of b.drift) {
    merged.set(d.shape, clampCount((merged.get(d.shape) ?? 0) + d.count));
  }
  // TOTAL order, not just by count. Ties kept `Map` insertion order, i.e. the order the
  // bridges happened to be polled in — so with more distinct shapes than the cap, which
  // ones an operator sees changed with the poll order, and a given shape could stay
  // invisible run after run. The name breaks the tie: same input set, same 100 kept.
  const all = [...merged.entries()]
    .map(([shape, count]) => ({ shape, count }))
    .sort((x, y) => y.count - x.count || (x.shape < y.shape ? -1 : x.shape > y.shape ? 1 : 0));
  return {
    ...a,
    // NOT sliced here. Callers fold bridges SEQUENTIALLY (`acc = merge(acc, next)`), so
    // truncating at every step made the fold non-associative: a shape dropped from the
    // running accumulator because it was small at step 2 came back at step 3 with only the
    // LAST bridge's count, silently under-reported next to a badge that showed no loss for
    // it. The union is therefore carried whole and bounded ONCE, by `boundProtocolInfo`, on
    // the final value — which carries `driftTruncated` forward and adds what it drops.
    // Memory stays bounded: each operand is itself a bounded parse output, so the
    // accumulator holds at most PROTOCOL_MAX_LIST × (number of polled bridges) entries.
    drift: all,
    // The THIRD place the same loss happened. Two bridges' shapes union here and the
    // result was sliced silently, so merging could shorten a list nobody was told had
    // been shortened. Everything dropped — by either bridge's cap, by either side's
    // parse, or by the final bound — lands in one number an operator can read.
    // CLAMPED. Two payloads carrying `Number.MAX_VALUE` summed to Infinity, which the next
    // `boundProtocolInfo` rejects as non-finite and replaces with 0 — so a bridge could
    // make both counters DISAPPEAR by sending absurd ones. A cap keeps the number
    // meaningless-but-present rather than silently zero.
    driftOverflow: clampCount(a.driftOverflow + b.driftOverflow),
    driftTruncated: clampCount(a.driftTruncated + b.driftTruncated),
  };
}

/**
 * Fold every polled bridge's protocol section into the ONE value that gets stored.
 *
 * The cap lives here and nowhere else. `mergeProtocolInfo` deliberately returns an
 * unbounded union so the fold is associative, which leaves exactly one obligation —
 * bound the final value — and a poller that merged in a loop and stored the accumulator
 * could forget it. Making the whole fold a single call removes the chance: there is no
 * intermediate value for a caller to store.
 */
export function foldProtocolInfo(
  parts: Array<BridgeProtocolInfo | null>,
): BridgeProtocolInfo | null {
  let acc: BridgeProtocolInfo | null = null;
  for (const p of parts) acc = mergeProtocolInfo(acc, p);
  // `boundProtocolInfo` carries the incoming loss counters forward and adds whatever the
  // cap drops here, so nothing the fold accumulated is lost without a number naming it.
  return acc === null ? null : boundProtocolInfo(acc);
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
 *   - version beyond `maxValidated`: FROZEN at the maxValidated profile (the
 *     capabilities actually exercised, and no more) + `versionBeyondValidated`, which
 *     drives a user-visible banner.
 *  Both sides fail CLOSED on the same inputs (the `parseVersion` mirror guarantees it),
 *  and the agreement is now PINNED: bridge/test/fixtures/capability-policy.json is a
 *  single expectation table read by this suite and by the bridge's — the "EXACT MIRROR"
 *  claim above used to be a comment nothing checked. See bridge/src/compat.ts for why
 *  freezing replaced failing open (Olivier's decision, 2026-07-26). */
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
  // FROZEN: judged as the last version we exercised, never as itself.
  const effective = beyond ? range.maxValidated : (gatewayVersion as string);
  for (const [cap, minVersion] of Object.entries(table)) {
    const cmp = compareVersions(effective, minVersion);
    capabilities[cap] = cmp !== null && cmp >= 0;
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
    protocol?: unknown;
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
      protocol: null,
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
    // Re-bound on the way out (the doc field is v.any()): a hand-edited or
    // legacy doc can never leak an unbounded/foreign shape to the API.
    protocol: boundProtocolInfo(doc.protocol),
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
