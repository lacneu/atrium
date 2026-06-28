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
  mediaOutbound: "2026.5.19",
  inboundAttachments: "2026.6.1",
  subagents: "2026.5.19",
};

export const COMPAT_MANIFEST: CompatManifest = {
  bridgeVersion: BRIDGE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  providers: {
    openclaw: {
      supportedRange: { min: "2026.5.19", maxValidated: "2026.6.5" },
      validatedVersions: ["2026.5.19", "2026.6.1", "2026.6.5"],
      capabilities: OPENCLAW_CAPABILITIES,
    },
    // Structural placeholder: the Hermes adapter is pending. Declaring it here
    // pins the manifest shape consumers (Convex/front) must handle: a provider
    // with NO validated range exposes zero capabilities.
    hermes: {
      supportedRange: null,
      validatedVersions: [],
      capabilities: {},
    },
  },
};

/** A parsed "YYYY.M.P"-style version (three numeric parts). */
export type ParsedVersion = [number, number, number];

/**
 * Strict parse of a gateway version like "2026.6.5": EXACTLY three dot-
 * separated non-negative integers. Anything else (prefixes, suffixes, missing
 * parts, non-numeric) returns null — a malformed version must fall into the
 * CONSERVATIVE policy, never crash or accidentally unlock capabilities.
 */
export function parseVersion(version: string): ParsedVersion | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const [a, b, c] = version.split(".").map((p) => Number.parseInt(p, 10));
  if (a === undefined || b === undefined || c === undefined) return null;
  return [a, b, c];
}

/** Numeric three-part comparison: negative a<b, 0 equal, positive a>b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
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
