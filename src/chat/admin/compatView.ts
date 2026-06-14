import { m } from "@/paraglide/messages.js";
import {
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
export type TargetBadgeState = "supported" | "beyond" | "unknown";

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
  const { range } = providerSupport(compat, target.provider);
  return withinSupport(range, target.gatewayVersion) ? "supported" : "unknown";
}

export function targetBadgeLabel(state: TargetBadgeState): string {
  return state === "supported"
    ? m.compat_badge_supported()
    : state === "beyond"
      ? m.compat_badge_beyond()
      : m.compat_badge_unknown();
}

/** A version for display — null degrades to the localized "unknown". */
export function versionLabel(version: string | null): string {
  return version ?? m.compat_unknown();
}

/** Tab-blocked banner: the gateway version is named when known (parameterized
 *  message), with a distinct branch when it is not. */
export function unsupportedInstanceLabel(gatewayVersion: string | null): string {
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
