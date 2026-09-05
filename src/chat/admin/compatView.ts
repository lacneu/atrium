import { m } from "@/paraglide/messages.js";
import {
  compareVersions,
  brokenVersionReason,
  providerSupport,
  withinSupport,
  type ProviderSupport,
} from "../../../convex/lib/compat";

// Pure view helpers for the bridge-compatibility surfaces (VCOMPAT-C):
// the Settings > Bridge "Compatibilite" section and the unsupported-tab
// banners. Manifest parsing (providerSupport / withinSupport) is REUSED from
// convex/lib/compat — ctx-free pure helpers, the same single-source idiom as
// convex/lib/charts — so frontend and backend can never disagree on what
// "within support" means. Extracted from the components so every branch —
// including the PARAMETERIZED banner message — is unit-tested without a DOM
// harness (GC-P5 lesson).

export { providerSupport, type ProviderSupport };

/** Per-connection verdict badge: in support / beyond validated / unknown. */
export type TargetBadgeState =
  | "supported"
  | "beyond"
  /** Inside the support range, but a version the manifest marks DEFECTIVE
   *  (`knownBrokenVersions`): raising the ceiling over a broken release must not
   *  re-badge it "within support" (codex P1). */
  | "defective"
  | "unknown";

/**
 * Classify one compat target against the manifest:
 *  - no detected gateway version → "unknown";
 *  - beyond the validated ceiling (still in range) → "beyond" (⚠ first: the
 *    nuance the operator must see);
 *  - within the provider's support window → "supported";
 *  - anything else (below min, provider without a published range, legacy
 *    manifest) → "unknown" — never a ✓ the manifest does not back.
 */
export function targetBadgeState(
  target: {
    provider: string;
    gatewayVersion: string | null;
    versionBeyondValidated: boolean;
  },
  compat: unknown,
): TargetBadgeState {
  if (target.gatewayVersion === null) return "unknown";
  if (target.versionBeyondValidated) return "beyond";
  const support = providerSupport(compat, target.provider);
  const { range } = support;
  // The same predicate the bridge and the API use — named releases OR the continuous
  // window. Reading only the named list showed "supported" for a pre-release the bridge
  // was quarantining (codex).
  if (brokenVersionReason(support, target.gatewayVersion) !== null) return "defective";
  return withinSupport(range, target.gatewayVersion) ? "supported" : "unknown";
}

/**
 * Same verdict as `targetBadgeState` but from a RAW gateway version (not a compat
 * target). Lets the per-instance compatibility list be driven by the PER-INSTANCE
 * health targets — which carry every instance's version — instead of the singleton
 * compat poller (which only knows the env-BRIDGE_URL instance). `beyond` (newer than
 * the validated ceiling) is computed here from the range, since there is no
 * precomputed flag on a health target.
 */
export function badgeStateFromVersion(
  version: string | null,
  provider: string,
  compat: unknown,
): TargetBadgeState {
  if (version === null) return "unknown";
  const support = providerSupport(compat, provider);
  const { range } = support;
  // The SAME predicate as targetBadgeState — and this is the entry point the provider
  // card actually calls. Fixing only the other one left the card badging a pre-release
  // "supported" while the API refused it and the bridge quarantined it: one rule, two
  // doors, and the second one silently open (codex).
  if (brokenVersionReason(support, version) !== null) return "defective";
  if (!withinSupport(range, version)) return "unknown";
  const beyond =
    range !== null && (compareVersions(version, range.maxValidated) ?? 0) > 0;
  return beyond ? "beyond" : "supported";
}

/** The provider card's HEADER verdict, from its instance rows.
 *
 *  Ordered by urgency, not by convenience: `defective` first (a version the
 *  manifest says breaks sessions), then `beyond`. The card's connections are
 *  collapsed by default, so a header that ignored `defective` hid the most urgent
 *  state behind a disclosure (codex P2). `supported` only when EVERY row is; an
 *  unknown row yields no badge rather than a ✓ the manifest does not back. */
export function aggregateBadgeState(
  states: readonly TargetBadgeState[],
): TargetBadgeState | null {
  if (states.includes("defective")) return "defective";
  if (states.includes("beyond")) return "beyond";
  if (states.length > 0 && states.every((s) => s === "supported")) return "supported";
  return null;
}

export function targetBadgeLabel(state: TargetBadgeState): string {
  return state === "supported"
    ? m.compat_badge_supported()
    : state === "beyond"
      ? m.compat_badge_beyond()
      : state === "defective"
        ? m.compat_badge_defective()
        : m.compat_badge_unknown();
}

/** A version for display — null degrades to the localized "unknown". */
export function versionLabel(version: string | null): string {
  return version ?? m.compat_unknown();
}

/** Tab-blocked banner. A capability the PROVIDER simply does not offer (e.g.
 *  Hermes has no agent-files RPC) is stated as such — blaming an "unknown
 *  gateway version" there is wrong and confusing. The version wording is kept
 *  for OpenClaw, where the block really is version-driven. */
export function unsupportedInstanceLabel(
  gatewayVersion: string | null,
  provider?: string | null,
): string {
  if (provider && provider !== "openclaw") {
    return m.compat_unsupported_provider({ provider });
  }
  return gatewayVersion !== null
    ? m.compat_unsupported_instance({ version: gatewayVersion })
    : m.compat_unsupported_instance_unknown();
}

/** Is a provider PRESENT in the manifest (even with an empty/null range)?
 *  Drives "adapter coming" lines — rendered ONLY when the manifest actually
 *  announces the provider, never as dead UI. */
export function hasProvider(compat: unknown, provider: string): boolean {
  if (typeof compat !== "object" || compat === null) return false;
  const providers = (compat as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return false;
  return provider in (providers as Record<string, unknown>);
}
