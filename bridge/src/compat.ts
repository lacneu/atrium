// COMPATIBILITY MANIFEST — the single source of truth for which bridge/protocol
// versions ship here and which provider capabilities each VALIDATED gateway
// version supports. Convex consumes this (via /capabilities), then the frontend
// adapts its UI per provider/version.
//
// The capability -> minVersion table is NOT aspirational: every entry mirrors
// the bench-validation ledger (each version below was exercised on the local
// harness). When a new gateway version is validated, extend
// `validatedVersions` + bump `maxValidated` here — nowhere else.
//
// Everything in this module is PURE data + pure functions (no I/O besides the
// one-time package.json read at module load), so the resolution policy is
// exhaustively unit-testable.

import { createRequire } from "node:module";

// bridgeVersion is read from package.json at boot — never hardcoded. The
// relative path resolves from BOTH dist/compat.js and src/compat.ts (vitest)
// to the repo-root package.json. `createRequire` (runtime resolution) is used
// instead of a static JSON import because tsconfig.build.json roots at src/
// and a static import of ../package.json would escape rootDir.
const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere("../package.json") as { version?: unknown };

/** The bridge's own release version (package.json), read once at boot. */
export const BRIDGE_VERSION: string =
  typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";

/**
 * The bridge <-> Convex contract version. 2 = the CURRENT shape: nested
 * `sessionSettings` (sets + `clears` allowlist) on /send + /patch. The
 * historical flat-knob body shape is 1.
 */
export const PROTOCOL_VERSION = 2;

/** Inclusive validated version range for a provider's gateway. */
export interface VersionRange {
  /** Oldest gateway version the bridge supports. */
  min: string;
  /** Newest gateway version that went through the validation bench. */
  maxValidated: string;
}

export interface ProviderCompat {
  /** null = structural placeholder, no adapter validated yet. */
  supportedRange: VersionRange | null;
  /** Every gateway version exercised on the validation bench. */
  validatedVersions: string[];
  /** capability key -> the FIRST validated gateway version that supports it. */
  capabilities: Record<string, string>;
}

export interface CompatManifest {
  bridgeVersion: string;
  protocolVersion: number;
  providers: Record<string, ProviderCompat>;
}

/**
 * Capability -> minVersion, straight from the bench-validation ledger:
 *  - knobThinkingLevel / knobModel: sessions.patch knobs work since 5.19.
 *  - knobFastMode / knobUnset (`{field: null}` removes the override): verified
 *    on 6.5 only.
 *  - agentFiles / sessionCompact / configDefaults: the CONF-4 surface, bench-
 *    verified on 6.5.
 *  - messageToolRecovery: the webchat sink recovers the message-tool reply
 *    from the transcript — works as soon as a transcript exists, so 5.19.
 *  - agentsDiscovery / mediaOutbound: present since 5.19.
 *  - inboundAttachments: inbound vision was only RELIABLE from 6.1 (5.19
 *    accepted attachments but vision results were inconsistent on the bench).
 *  - subagents: the bridge OBSERVES a chat's child (sub-agent) runs via the
 *    `sessions_spawn` tool, which is present since 5.19 (read-only — it never
 *    changes what Atrium sends), so the monitor UI is gated from the 5.19 floor.
 */
const OPENCLAW_CAPABILITIES: Record<string, string> = {
  knobThinkingLevel: "2026.5.19",
  knobModel: "2026.5.19",
  knobFastMode: "2026.6.5",
  knobUnset: "2026.6.5",
  agentFiles: "2026.6.5",
  sessionCompact: "2026.6.5",
  configDefaults: "2026.6.5",
  messageToolRecovery: "2026.5.19",
  agentsDiscovery: "2026.5.19",
  // chat.abort is core gateway RPC across the whole validated range; the
  // bridge wires it via POST /abort (the stop button's real kill).
  abort: "2026.5.19",
  mediaOutbound: "2026.5.19",
  inboundAttachments: "2026.6.1",
  subagents: "2026.5.19",
  // Read-only gateway scheduler listing (`cron.list`) — the Settings ▸
  // Personal ▸ Scheduled tab. Core gateway RPC across the validated range.
  cronList: "2026.5.19",
  // Scheduled-job MANAGEMENT (cron.get/update/remove/run/runs via
  // /cron-manage). The RPC surface was verified LIVE against the
  // 2026.7.1-beta.2 bench (param schemas extracted from that dist) — and a
  // pre-release sorts BELOW its release in the semver-lite comparator, so
  // the gate must name the beta or the very gateway it was proven on would
  // read as unsupported. Older gateways name the methods but their shapes
  // are unverified — conservative floor.
  cronManage: "2026.7.1-beta.2",
  // Realtime voice ("talk"): the gateway mints an EPHEMERAL provider session
  // (talk.client.create -> {clientSecret, offerUrl, model, voice, expiresAt})
  // for a browser-owned WebRTC session; discovery via talk.catalog. Verified
  // LIVE against the 2026.7.1 bench (probe-talk, 2026-07-16). Version says
  // "the surface exists" only — whether a realtime provider is CONFIGURED is
  // dynamic gateway state, checked at session-create time with a graceful
  // error (same split as inboundAttachments vs the dynamic maxPayload cap).
  talk: "2026.7.1",
};

// Hermes exposes a DELIBERATELY SMALL surface via its OpenAI-compatible API
// server (validated 0.18.0, bench 2026-07-06): a per-turn run with a real
// server-side stop, and single-agent discovery via /v1/models. It has NONE of
// the OpenClaw per-chat knobs (thinking/model/fastMode are server-side config,
// cosmetic in the API), NO admin config write (`admin_config_rw:false` → no
// chat-defaults), NO general attachments (images-only inline), NO exposed
// sub-agent/compaction RPCs. Listing ONLY what Hermes has makes every UI
// feature gate OFF automatically on a Hermes instance — the multi-provider
// design's payoff (capability-driven UI, zero per-provider UI code).
const HERMES_CAPABILITIES: Record<string, string> = {
  // Stop WORKS from the user's side on both transports: the turn stops, the bubble
  // finalizes, and a run the provider did not confirm stopping costs the chat its
  // provider session rather than leaking a phantom reply into the next turn.
  //
  // What is NOT true — and what this line used to assert as `run_stop: POST
  // /v1/runs/{id}/stop` — is that the server-side run always ends. On WS it does
  // (`session.interrupt` calls the agent's own interrupt). On REST it CANNOT: the run id
  // minted by `/api/sessions/{id}/chat/stream` is registered in neither map the stop
  // handler consults, so that POST is a structural 404 — and the sibling routes that CAN
  // interrupt (`/v1/chat/completions`, `/v1/responses`) do it through an `agent_ref` this
  // route does not pass. A migration to `POST /v1/runs` is the real fix and is its own
  // wave; declaring the capability here stays honest because the UI gates the Stop
  // BUTTON on it, and the button does stop the user's turn.
  abort: "0.18.0",
  agentsDiscovery: "0.18.0", // GET /v1/models (one agent)
  // Identity files are served by the gateway's MANAGED-FILES HTTP API
  // (`GET /api/files/download`), and `/agent-files` routes a Hermes instance there on
  // `config.kind` alone — explicitly "no operator socket". Declaring it WS-only hid a
  // working tab from every REST-transport instance (W11/G8).
  agentFiles: "0.18.0",
  // The outbound-media seam is wired for ANY Hermes instance (`HermesFilesFetcher`,
  // built on `kind === "hermes"`), so the capability was implemented and undeclared.
  // The UI gates nothing on it — it is bridge-side — but a manifest that omits what the
  // bridge does is a manifest nobody can trust for the things it does declare.
  mediaOutbound: "0.18.0",
};

// The WS transport (`hermes serve` JSON-RPC) additionally stages inline
// attachments via file.attach / image.attach_bytes — live-validated 0.18.0.
// Everything else stays deliberately absent (honest manifest: only what the
// bridge actually implements).
const HERMES_WS_CAPABILITIES: Record<string, string> = {
  ...HERMES_CAPABILITIES,
  inboundAttachments: "0.18.0",
  // `cron.manage {action:"list"}` on the WS RPC surface (single-agent scope).
  cronList: "0.18.0",
  // cron.manage remove/pause/resume (by job name) — the Hermes management
  // subset (no update/run-now/history). Verified against the 0.18.2 bench.
  cronManage: "0.18.0",
  // The WS event stream carries structured delegation + Mixture-of-Agents
  // activity (subagent.* / moa.*) which the bridge feeds into the sub-agent
  // monitor — so the monitor UI unlocks on this transport.
  subagents: "0.18.0",
};

/**
 * VERSION CLAIMS AND WHAT EARNS THEM (W11/G6).
 *
 * `validatedVersions` used to be a sentence somebody edited, with the bench run described
 * in a prose comment beside it. A claim nobody can check is a claim nobody maintains, and
 * `maxValidated` is not decoration: `withinSupport` returns true for every version at or
 * above it, so an unearned bump silently declares support the bench never gave.
 *
 * The rule, enforced by `compat.test.ts`:
 *
 *   * `maxValidated`, and every version added from now on, MUST have a
 *     `bridge/protocol/openclaw/<version>/BENCH.json` recording a GO run over the
 *     complete catalogue.
 *   * The six entries below `maxValidated` that predate this rule are GRANDFATHERED —
 *     listed here, explicitly and dated. Re-running those gateways today would not tell
 *     us whether the claim was true when it was made; it would manufacture evidence for a
 *     past we cannot re-enter. What matters is that the exemption is finite, visible, and
 *     cannot grow: the test asserts the grandfather set and the enforced set are
 *     DISJOINT, so no future failure can be silenced by adding a name here.
 *
 * BENCH.json is a CONSISTENCY record, not a signature. The same hand runs the bench,
 * writes the file and makes the commit, so it cannot prove authenticity — and saying it
 * "signs" anything would be the self-attested-hash trap this program has already paid
 * for. What it does prove is that the claim, the vendored surface and the repository
 * state agree: the test RE-HASHES the vendored directory rather than trusting a number
 * the file carries about itself.
 */
export const BENCH_GRANDFATHERED: Readonly<Record<string, readonly string[]>> = {
  // Validated on the standing bench before BENCH.json existed (dates are the runs
  // recorded in the release notes and the version-validation memory).
  openclaw: [
    "2026.5.19", // 2026-05 — first validated range floor
    "2026.6.1",
    "2026.6.5", // 2026-06-19 — full suite
    "2026.6.10", // 2026-06-28 — full suite
    "2026.6.11", // 2026-07-03 — full suite (announce fixtures captured here)
    "2026.7.1-beta.2", // 2026-07-09 — RC bench
    "2026.7.1-beta.5", // 2026-07-12 — GO 9/9
  ],
  // Hermes: these TWO stand on their 2026-07-11 WS-transport run, from before any
  // attestation existed. The note that used to sit here — "Hermes has no BENCH.json and
  // will not get one in this program" — rested on a premise that is now dead: the wave was
  // deferred because no Hermes instance served a client, and one does. Every Hermes
  // version from 0.19.0 on is EARNED like an OpenClaw one, against
  // `bridge/protocol/hermes/<version>/BENCH.json`.
  hermes: ["0.18.0", "0.18.2"],
};

/** Transport-aware resolution for Hermes: the WS surface is a superset. */
export function hermesCapabilitiesFor(
  transport: "ws" | "rest",
): Record<string, string> {
  return transport === "ws" ? HERMES_WS_CAPABILITIES : HERMES_CAPABILITIES;
}

/** Hermes' supported range, named ONCE.
 *
 *  The transport overlay resolves the WS superset against the very same range the manifest
 *  publishes: two copies of "which versions are supported" would drift, and the drift would
 *  surface as capabilities appearing or vanishing for reasons nobody could trace back. */
export const HERMES_RANGE: VersionRange = {
  min: "0.18.0",
  maxValidated: "0.19.0",
};

/**
 * Is this string a version in the scheme the Hermes manifest is written in?
 *
 * Hermes publishes TWO version schemes for the same build: the semver in `pyproject`
 * (`0.19.0`) and the git TAG (`v2026.7.20`). Both are real, and they are not comparable —
 * a calendar major parses as a perfectly good semver and compares as astronomically newer
 * than anything the manifest has validated. Left unchecked, an upstream change to whichever
 * field feeds the version would silently republish the gateway as "beyond validated": the
 * banner lights, the admin view reports a version the gateway is not running, and every
 * future ratchet decision is made against a number from another scheme (G-57).
 *
 * The rule, and it is deliberately narrow: it must parse as semver AND its major must be
 * one the manifest could plausibly be describing — the validated major, or the one after
 * it. A calendar major fails. A genuine next-major Hermes passes and is reported honestly
 * as beyond-validated, which is what the banner is for. A major further out fails CLOSED
 * and resolves at the range floor: refusing to guess about a scheme we have never seen is
 * the whole point of the ratchet.
 */
export function isHermesVersionScheme(version: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  const ceiling = parseVersion(HERMES_RANGE.maxValidated);
  if (ceiling === null) return false;
  return (parsed[0] as number) <= (ceiling[0] as number) + 1;
}

export const COMPAT_MANIFEST: CompatManifest = {
  bridgeVersion: BRIDGE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  providers: {
    openclaw: {
      // 2026.7.1 (RELEASE) validated DIRECTLY: full live suite GO 9/9 on the
      // shipped release (2026-07-13 — wire contracts, SSE, plan, media,
      // spawn/announce merge, async tasks, cron, Hermes co-run). Static drift
      // vs the beta.5 bench: NONE (plan/cron/tasks schemas, announce
      // idempotency and subagent-announce byte-identical modulo chunk
      // hashes). It had previously been declared through its beta.2 RC
      // (release-day upgrades stay in support with no banner) — that proxy
      // note is now history, the row stands on its own run.
      supportedRange: { min: "2026.5.19", maxValidated: "2026.7.1" },
      validatedVersions: [
        "2026.5.19",
        "2026.6.1",
        "2026.6.5",
        "2026.6.10",
        "2026.6.11",
        "2026.7.1-beta.2",
        // beta.5: full live suite GO 2026-07-12 (9/9 — wire contracts, SSE,
        // plan, media, spawn/announce, async tasks, cron, Hermes co-run).
        // Upgrade notes: startup migrations refuse to boot on codex binding
        // sidecars with an unresolvable session owner (move them aside), and
        // containerized gateways now REQUIRE auth for non-loopback binds.
        "2026.7.1-beta.5",
        // Shipped release, re-validated directly (GO 9/9, 2026-07-13) after
        // the beta.2-proxy declaration. Standing bench.
        "2026.7.1",
      ],
      capabilities: OPENCLAW_CAPABILITIES,
    },
    // Structural placeholder: the Hermes adapter is pending. Declaring it here
    // pins the manifest shape consumers (Convex/front) must handle: a provider
    // with NO validated range exposes zero capabilities.
    hermes: {
      // 0.18.2 live-validated 2026-07-11 (WS transport: send/continuity/tools/
      // delegation/file delivery on the upgraded bench). 0.19.0 is the first Hermes
      // version to EARN its claim: GO 11/11 on the local bench, 2026-07-29, attested at
      // `bridge/protocol/hermes/0.19.0/BENCH.json`.
      supportedRange: HERMES_RANGE,
      validatedVersions: ["0.18.0", "0.18.2", "0.19.0"],
      capabilities: HERMES_CAPABILITIES,
    },
  },
};

/** A parsed "YYYY.M.P"-style version: three numeric parts + an optional
 *  pre-release tag ("beta.2" in "2026.7.1-beta.2"). */
export type ParsedVersion = [number, number, number, string?];

/**
 * Strict parse of a gateway version like "2026.6.5" or a pre-release like
 * "2026.7.1-beta.2": EXACTLY three dot-separated non-negative integers, with
 * an optional semver-style `-<tag>` suffix. Anything else (prefixes, missing
 * parts, non-numeric) returns null — a malformed version must fall into the
 * CONSERVATIVE policy, never crash or accidentally unlock capabilities.
 */
export function parseVersion(version: string): ParsedVersion | null {
  // Pre-release tag = dot-separated NON-EMPTY alphanumeric identifiers
  // (semver): "beta." or "beta..1" must fail closed, not resolve capabilities.
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!m) return null;
  const parsed: ParsedVersion = [
    Number.parseInt(m[1] as string, 10),
    Number.parseInt(m[2] as string, 10),
    Number.parseInt(m[3] as string, 10),
  ];
  if (m[4] !== undefined) parsed[3] = m[4];
  return parsed;
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
 *  orders BEFORE its release (2026.7.1-beta.2 < 2026.7.1), semver-style. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  const pa = a[3];
  const pb = b[3];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return comparePrerelease(pa, pb);
}

/** The result of resolving the capability table against a live gateway. */
export interface ResolvedCapabilities {
  /** capability key -> usable on THIS gateway version. */
  capabilities: Record<string, boolean>;
  /**
   * The gateway runs a version NEWER than anything bench-validated: every
   * validated capability is assumed true, but consumers should surface the
   * "running ahead of validation" state to operators.
   */
  versionBeyondValidated: boolean;
}

/**
 * Resolve the manifest's capability table for one provider against the LIVE
 * gateway version. PURE — exhaustively unit-tested.
 *
 * Policy:
 *  - unknown provider, or a provider with no validated range (hermes
 *    placeholder): zero capabilities;
 *  - null/malformed gateway version: CONSERVATIVE — only the capabilities
 *    whose minVersion IS the supported floor (`supportedRange.min`) are true
 *    (the floor is the weakest gateway we ever talk to);
 *  - version within range: capability true iff version >= its minVersion;
 *  - version beyond `maxValidated`: FROZEN at the maxValidated profile — the
 *    capabilities we have actually exercised, and no more — plus the
 *    `versionBeyondValidated` flag (which drives a user-visible banner).
 *
 * WHY frozen rather than fail-open (Olivier's decision, 2026-07-26). The old rule
 * granted every capability unconditionally beyond `maxValidated`. On today's table
 * that is indistinguishable from the normal rule — every `minVersion` is at or below
 * `maxValidated`, so the version already clears them all — which is precisely why the
 * fail-open went unnoticed. It bites the day a capability is DECLARED for a version we
 * have not benched: the old rule handed it out on a gateway nobody had exercised.
 * Freezing says the honest thing instead: you get what we tested, and the banner says
 * the rest is unverified.
 *
 * The rejected alternative was withholding WRITE capabilities beyond the validated
 * range. It was measured and refused: no production instance is beyond it today, the
 * version number is a poor proxy for a known contract (a fully validated 2026.7.1
 * emits `agent.lastTo`, a field upstream's own schema does not declare), and these
 * flags gate UI affordances, not safety — so the effect would have been features
 * vanishing from a client who upgraded. Restricting on OBSERVED drift is defensible;
 * restricting on a version number is not.
 */
export function resolveCapabilities(
  provider: string,
  gatewayVersion: string | null,
): ResolvedCapabilities {
  const compat = COMPAT_MANIFEST.providers[provider];
  if (!compat) return { capabilities: {}, versionBeyondValidated: false };
  return resolveCapabilitiesFor(
    compat.supportedRange,
    compat.capabilities,
    gatewayVersion,
  );
}

/**
 * The policy itself, over an EXPLICIT range + capability table.
 *
 * Split out so a test can exercise the case the shipped manifest cannot express: a
 * capability whose `minVersion` is ABOVE `maxValidated`. That is the only input on
 * which freezing and failing open differ, so it is the only input that can prove the
 * change — everything else passes either way.
 */
export function resolveCapabilitiesFor(
  range: VersionRange | null,
  table: Record<string, string>,
  gatewayVersion: string | null,
): ResolvedCapabilities {
  if (range === null) return { capabilities: {}, versionBeyondValidated: false };
  const capabilities: Record<string, boolean> = {};
  const parsed = gatewayVersion === null ? null : parseVersion(gatewayVersion);
  if (parsed === null) {
    // Unknown gateway version -> conservative floor.
    for (const [cap, minVersion] of Object.entries(table)) {
      capabilities[cap] = minVersion === range.min;
    }
    return { capabilities, versionBeyondValidated: false };
  }
  const maxValidated = parseVersion(range.maxValidated);
  const beyond = maxValidated !== null && compareVersions(parsed, maxValidated) > 0;
  // FROZEN: judged as the last version we exercised, never as itself.
  const effective = beyond && maxValidated !== null ? maxValidated : parsed;
  for (const [cap, minVersion] of Object.entries(table)) {
    const min = parseVersion(minVersion);
    capabilities[cap] = min !== null && compareVersions(effective, min) >= 0;
  }
  return { capabilities, versionBeyondValidated: beyond };
}
