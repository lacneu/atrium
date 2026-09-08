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
 * Scheme and host this connection reaches the gateway on, read from the operator
 * URL it is about to dial. Stated rather than assumed: a gateway whose
 * `requiredHeaders` lists them compares presence, and an operator debugging a
 * refusal reads them — a placeholder would be a lie that costs an afternoon.
 */
function forwardedOrigin(config: BridgeConfig): {
  forwardedProto: string;
  forwardedHost: string;
} {
  return originOf(config.openclawGatewayUrl);
}

/**
 * Scheme + host of one URL, as forwarded headers.
 *
 * `new URL` does NOT throw on a schemeless `host:port` — it reads `host:` as the
 * PROTOCOL and leaves `host` empty — so the catch block is not the guard it looks
 * like. An empty `x-forwarded-host` is worse than a placeholder: a gateway whose
 * `requiredHeaders` lists it reads blank as absent and answers 401 on the media
 * route, which is the exact failure these headers exist to prevent.
 *
 * Both TLS spellings map to https: `wss:` is how an operator URL says it, and
 * `https:` is accepted by `deriveHttpBase` for the media base.
 */
function originOf(url: string): {
  forwardedProto: string;
  forwardedHost: string;
} {
  const fallback = { forwardedProto: "http", forwardedHost: "atrium-bridge" };
  // A SCHEMELESS `host:port` is a supported configuration — `normalizeWsUrl`
  // prefixes ws:// on the connect path and `deriveHttpBase` prefixes http:// for
  // the media base — but `new URL` does not throw on it: it reads `host:` as the
  // PROTOCOL and leaves `host` empty. Falling back to a placeholder there would
  // name a host that does not exist, on the very header a gateway with
  // `requiredHeaders` reads. Apply the same normalization the connect path does,
  // so the header states the host actually dialled.
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim())
    ? url.trim()
    : `ws://${url.trim()}`;
  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    return fallback;
  }
  if (u.host.length === 0) return fallback;
  return {
    forwardedProto: u.protocol === "wss:" || u.protocol === "https:" ? "https" : "http",
    forwardedHost: u.host,
  };
}

/**
 * The origin the MEDIA route is reached on, which is not always the socket's:
 * `gatewayHttpBase` derives from `instances.gatewayHttpUrl` when it is set, and
 * the headers must describe the request being authorized, not a sibling one.
 *
 * No fallback: `gatewayHttpBase` is `deriveHttpBase(gatewayHttpUrl || gatewayUrl)`
 * on every path that builds a config, so it is non-empty whenever the socket URL
 * is — and an `|| gatewayUrl` here would be a branch no loader can reach, which a
 * test could only "cover" by inventing a config that does not occur.
 */
export function mediaForwardedOrigin(config: BridgeConfig): {
  forwardedProto: string;
  forwardedHost: string;
} {
  return originOf(config.gatewayHttpBase);
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
    ...forwardedOrigin(config),
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
    ...forwardedOrigin(config),
    user: config.openclawSystemIdentity ?? systemIdentityFor(config.instanceName),
    // No ceiling: recovery and discovery are exactly the paths that must be able to
    // read a session created by someone else.
  });
}

/** Gateway-side user header override, or `undefined` for the upstream default. */
export function connectUserHeader(config: BridgeConfig): string | undefined {
  return config.openclawTrustedProxyUserHeader ?? undefined;
}
