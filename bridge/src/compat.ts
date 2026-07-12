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
  abort: "0.18.0", // run_stop: POST /v1/runs/{id}/stop
  agentsDiscovery: "0.18.0", // GET /v1/models (one agent)
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
  // Identity files (SOUL.md, AGENTS.md, …) at the agent home root, served by
  // the gateway's managed-files API (list/read/upload; mtime is the CAS base).
  agentFiles: "0.18.0",
};

/** Transport-aware resolution for Hermes: the WS surface is a superset. */
export function hermesCapabilitiesFor(
  transport: "ws" | "rest",
): Record<string, string> {
  return transport === "ws" ? HERMES_WS_CAPABILITIES : HERMES_CAPABILITIES;
}

export const COMPAT_MANIFEST: CompatManifest = {
  bridgeVersion: BRIDGE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  providers: {
    openclaw: {
      // 2026.7.1 was validated through its 2026.7.1-beta.2 pre-release (the
      // published release candidate; full live suite 2026-07-11 — chat core,
      // tools, sub-agents, vision, media, explicit compaction, gpt-5.6 models).
      // DELIBERATE POLICY (operator ask): declaring the release validated via
      // its RC means instances upgrading on release day stay within support
      // with no "ahead of validation" banner. If the shipped 2026.7.1 differs
      // from beta.2, re-run the bench before trusting this row. The
      // pre-release orders BEFORE the release, so the beta bench stays within
      // range once 2026.7.1 ships.
      supportedRange: { min: "2026.5.19", maxValidated: "2026.7.1" },
      validatedVersions: [
        "2026.5.19",
        "2026.6.1",
        "2026.6.5",
        "2026.6.10",
        "2026.6.11",
        "2026.7.1-beta.2",
        "2026.7.1",
      ],
      capabilities: OPENCLAW_CAPABILITIES,
    },
    // Structural placeholder: the Hermes adapter is pending. Declaring it here
    // pins the manifest shape consumers (Convex/front) must handle: a provider
    // with NO validated range exposes zero capabilities.
    hermes: {
      // 0.18.2 live-validated 2026-07-11 (WS transport: send/continuity/tools/
      // delegation/file delivery on the upgraded bench).
      supportedRange: { min: "0.18.0", maxValidated: "0.18.2" },
      validatedVersions: ["0.18.0", "0.18.2"],
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
 *  - version beyond `maxValidated`: all validated capabilities true, plus the
 *    `versionBeyondValidated` flag.
 */
export function resolveCapabilities(
  provider: string,
  gatewayVersion: string | null,
): ResolvedCapabilities {
  const compat = COMPAT_MANIFEST.providers[provider];
  if (!compat || compat.supportedRange === null) {
    return { capabilities: {}, versionBeyondValidated: false };
  }
  const capabilities: Record<string, boolean> = {};
  const parsed = gatewayVersion === null ? null : parseVersion(gatewayVersion);
  if (parsed === null) {
    // Unknown gateway version -> conservative floor.
    for (const [cap, minVersion] of Object.entries(compat.capabilities)) {
      capabilities[cap] = minVersion === compat.supportedRange.min;
    }
    return { capabilities, versionBeyondValidated: false };
  }
  const maxValidated = parseVersion(compat.supportedRange.maxValidated);
  const beyond = maxValidated !== null && compareVersions(parsed, maxValidated) > 0;
  for (const [cap, minVersion] of Object.entries(compat.capabilities)) {
    const min = parseVersion(minVersion);
    capabilities[cap] =
      beyond || (min !== null && compareVersions(parsed, min) >= 0);
  }
  return { capabilities, versionBeyondValidated: beyond };
}
