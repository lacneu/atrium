// Which identity each kind of gateway socket presents.
//
// The bridge opens two kinds of socket, and they must NOT look alike to the gateway:
//
//   - a PERSON's socket (one per conversation, long-lived) acts as the human who
//     owns that conversation. Every session it creates is stamped with their gateway
//     profile, which is what the gateway's own visibility boundary reads. It is
//     capped below `operator.admin`, because that scope bypasses that boundary.
//
//   - a SYSTEM socket (short-lived, one per operator request) serves no single
//     person: agent discovery, orphan-transcript recovery, config defaults, health.
//     Several of these legitimately need to see sessions belonging to everyone
//     (recovering a transcript after a crash), so they keep the device's full grant
//     and are attributed to a named bridge actor rather than to whoever happened to
//     trigger them.
//
// In token mode BOTH resolve to `undefined` and the handshake is byte-for-byte the
// one that shipped before per-user identity existed.

import type { BridgeConfig } from "../../config.js";
import {
  HUMAN_SCOPE_CAP,
  hostForwardedClientIp,
  identityFor,
  systemIdentityFor,
  type GatewayIdentity,
} from "./gateway-identity.js";

/** The address this bridge presents, configured or discovered. */
function forwardedClientIp(config: BridgeConfig): string | null {
  return config.openclawForwardedClientIp ?? hostForwardedClientIp();
}

/**
 * Identity for the socket of ONE conversation, acting as its owner.
 *
 * The ceiling is the instance's stated posture, defaulting to "capped" — what every
 * instance did before the setting existed. "full" is the operator's answer to a real
 * trade-off, not a loosening for its own sake: the gateway derives the AGENT's tool
 * list from this connection's scopes, so the ceiling also takes `automations` and
 * `computer` away from the model, while it bounds nothing at all until
 * `gateway.roles` gives admin a boundary to bypass.
 */
export function humanConnectIdentity(
  config: BridgeConfig,
  canonical: string,
): GatewayIdentity | undefined {
  return identityFor({
    authMode: config.openclawAuthMode,
    forwardedClientIp: forwardedClientIp(config),
    user: canonical,
    ...(config.openclawPersonScopes === "full"
      ? {}
      : { scopeCap: HUMAN_SCOPE_CAP }),
  });
}

/** Identity for a socket that acts for the bridge itself, not for a person. */
export function systemConnectIdentity(
  config: BridgeConfig,
): GatewayIdentity | undefined {
  return identityFor({
    authMode: config.openclawAuthMode,
    forwardedClientIp: forwardedClientIp(config),
    user: config.openclawSystemIdentity ?? systemIdentityFor(config.instanceName),
    // No ceiling: recovery and discovery are exactly the paths that must be able to
    // read a session created by someone else.
  });
}

/** Gateway-side user header override, or `undefined` for the upstream default. */
export function connectUserHeader(config: BridgeConfig): string | undefined {
  return config.openclawTrustedProxyUserHeader ?? undefined;
}
