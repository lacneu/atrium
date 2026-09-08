// Per-user identity presented to an OpenClaw Gateway running in trusted-proxy mode.
//
// WHY THIS EXISTS. In `token` mode every bridge socket authenticates with ONE shared
// credential, so the gateway attributes every session to the single "gateway owner"
// profile: `sessions.list` shows all of them to everyone holding the token, and
// `createdActor` names nobody in particular. In `trusted-proxy` mode the gateway
// derives the human from a request header on the WebSocket upgrade instead, so the
// SAME paired device yields a DIFFERENT gateway profile per identity we present —
// proven on the bench (one device, `x-forwarded-user: alice@…` then `bob@…`, two
// stable `users.self` profiles, each session carrying its own
// `createdActor.identity = {type:"profile", id}`).
//
// THREE headers, all load-bearing (each proven by a refusal on the bench):
//   - the user header (default `x-forwarded-user`, configurable gateway-side via
//     `gateway.auth.trustedProxy.userHeader`): absent ⇒ the gateway refuses the
//     connect with `authReason: "trusted_proxy_user_missing"`.
//   - `x-forwarded-for`: the gateway REQUIRES forwarded headers naming a
//     non-loopback client address before it will attribute an identity at all.
//     Absent ⇒ the HTTP upgrade itself is rejected 403 and the gateway logs
//     "observed unattributable proxy-shaped traffic". A loopback value is treated
//     the same way, which is why `assertForwardedClientIp` refuses one up front
//     rather than letting every connect fail with an opaque 403.
//   - `x-openclaw-scopes` (OPTIONAL): a per-connection CEILING. The gateway computes
//     `device scopes ∪ identityScopes[identity]` and then intersects with this
//     header, so it is the only way to hand one socket less authority than the
//     paired device carries. `identityScopes` alone can never subtract.
//
// The bridge NEVER forwards a header it received; it states what it knows about the
// connection it is opening itself. Values are therefore validated as data we
// produced, and refused loudly when they cannot be represented in a header.

import { networkInterfaces } from "node:os";

/** How this instance authenticates to its gateway. */
export type GatewayAuthMode = "token" | "trusted-proxy";

/** The identity one socket acts under, and the authority ceiling it accepts. */
export interface GatewayIdentity {
  /**
   * The person (or the bridge's own system actor) this socket acts as. Becomes a
   * durable gateway user profile keyed by this exact string, so it must be stable
   * for the life of the account: Atrium sends `profiles.canonical`, never an email
   * (which can change) and never a Convex id (which is not meaningful upstream).
   */
  user: string;
  /**
   * Client address the gateway attributes the connection to. The bridge IS the
   * client here, so this is the bridge's own routable address — not the end user's
   * browser, which the bridge never learns (Convex dispatches on its behalf).
   */
  forwardedFor: string;
  /** Scheme this connection reached the gateway over, for `requiredHeaders`.
   *  REQUIRED: a default here would advertise a host or scheme nobody chose, on
   *  the header a proxy-aware gateway reads — see the note in buildIdentityHeaders. */
  forwardedProto: string;
  /** Host this connection reached the gateway on, for `requiredHeaders`. REQUIRED
   *  for the same reason. */
  forwardedHost: string;
  /**
   * Per-connection scope ceiling. Omitted ⇒ no `x-openclaw-scopes` header and the
   * connection keeps everything the device and the identity grant. An EMPTY array
   * is not "no ceiling": the gateway reads an empty header as "no scopes at all",
   * so it is refused here rather than silently producing a powerless socket.
   */
  scopeCap?: readonly string[];
}

/**
 * Scopes a CONVERSATION's socket carries, under trusted proxy.
 *
 * "capped" keeps it below `operator.admin` (see HUMAN_SCOPE_CAP); "full" hands it
 * the device's whole grant, which is what an operator picks when the agent's
 * admin-scoped tools matter more than a ceiling that, without `gateway.roles`,
 * bounds nothing. Stated rather than discovered: the gateway announces no role
 * policy at connect, and the ceiling is an upgrade HEADER — decided before the
 * socket exists, so before anything could be learned from it.
 */
export type PersonScopes = "capped" | "full";

/** The header name the gateway is configured to read the identity from. */
export const DEFAULT_TRUSTED_PROXY_USER_HEADER = "x-forwarded-user";

/** The scope-ceiling header the gateway intersects the granted scopes with. */
export const SCOPE_CAP_HEADER = "x-openclaw-scopes";

/**
 * Scope ceiling for a socket that acts for a PERSON. Deliberately excludes
 * `operator.admin`: on the gateway that scope bypasses the whole session-visibility
 * boundary (an admin client lists, reads and patches every session regardless of the
 * role's `sessions.others`), so a per-user socket that kept it would present an
 * identity while retaining the authority that makes identity meaningless.
 *
 * WHAT THIS CAP COSTS, measured 2026-09-07 on gateway 2026.9.2. The gateway derives
 * the AGENT's tool list from the scopes of the connection that asked for the turn, so
 * capping the person's socket removes the tools that need `operator.admin` from the
 * MODEL — `automations` (create/manage a cron) and `computer` among them. Nothing is
 * refused and nothing is logged: the tool is simply never offered, and the model
 * silently falls back to whatever is left (it reached for the `openclaw automations`
 * CLI through `exec`). Proven as a matched triple, asking the agent to report its own
 * tool list: token mode ⇒ present; trusted proxy ⇒ absent; trusted proxy with this
 * cap removed ⇒ present again.
 *
 * The cap is kept because the alternative is worse — an identity that carries admin
 * is not an identity — but note it only BUYS something once `gateway.roles` defines a
 * boundary for admin to bypass. Without roles every profile already sees every
 * session, so on such a deployment the cap costs agent tools and protects nothing.
 * That trade-off belongs to the operator, not to this constant; see
 * docs/GATEWAY_IDENTITY.md.
 */
export const HUMAN_SCOPE_CAP = [
  "operator.read",
  "operator.write",
  "operator.approvals",
] as const;

/**
 * Header values are ASCII, single-line, and free of the separators a header parser
 * uses. Rejecting the rest is not decoration: a value carrying CR or LF would let a
 * caller inject a second header on the upgrade request, and the identity header is
 * precisely what the gateway trusts to name a person.
 */
const SAFE_HEADER_VALUE = /^[\x21-\x7e]+$/;

/** Longest identity the gateway keys a profile by. */
const MAX_IDENTITY_USER_CHARS = 200;

/** Characters that would split one header value into several fields. */
const HEADER_SEPARATORS = /[,;]/;

export class GatewayIdentityError extends Error {}

/**
 * Refuse an identity string that cannot be presented faithfully. Returns the value
 * so call sites can validate and assign in one expression.
 */
/**
 * Can this string BE a trusted-proxy identity — i.e. survive the header that
 * carries it? The rule lives here, once, because two places need it and they must
 * never disagree: `assertIdentityUser` below refuses what fails it, and the naming
 * site falls back to the routing key rather than letting a person be unable to
 * speak at all.
 *
 * `x-forwarded-user` carries printable ASCII with no field separator. An
 * INTERNATIONALIZED address (`josé@example.com`) is a perfectly valid address that
 * this header cannot carry — so an instance naming people by their address must be
 * able to ask the question without throwing.
 */
export function isHeaderSafeIdentity(user: string): boolean {
  return (
    user.length > 0 &&
    user.length <= MAX_IDENTITY_USER_CHARS &&
    SAFE_HEADER_VALUE.test(user) &&
    !HEADER_SEPARATORS.test(user)
  );
}

export function assertIdentityUser(user: string): string {
  if (user.length === 0) {
    throw new GatewayIdentityError(
      "trusted-proxy identity is empty: the gateway refuses a connect whose user header is missing or blank",
    );
  }
  if (user.length > MAX_IDENTITY_USER_CHARS) {
    throw new GatewayIdentityError(
      `trusted-proxy identity is too long (${user.length} chars): gateway user profiles are keyed by this value`,
    );
  }
  if (!SAFE_HEADER_VALUE.test(user) || HEADER_SEPARATORS.test(user)) {
    throw new GatewayIdentityError(
      `trusted-proxy identity ${JSON.stringify(user)} contains characters that cannot be sent in a header`,
    );
  }
  return user;
}

/**
 * Loopback and unspecified addresses are exactly what the gateway treats as
 * unattributable, so a bridge configured with one would fail EVERY connect with a
 * bare 403. Refuse at the point the value is chosen, where the message can name the
 * setting to fix.
 */
export function assertForwardedClientIp(ip: string): string {
  const value = ip.trim();
  if (value.length === 0) {
    throw new GatewayIdentityError(
      "trusted-proxy forwarded client address is empty: set BRIDGE_FORWARDED_CLIENT_IP to the address this bridge reaches its gateway from",
    );
  }
  if (!SAFE_HEADER_VALUE.test(value) || HEADER_SEPARATORS.test(value)) {
    throw new GatewayIdentityError(
      `trusted-proxy forwarded client address ${JSON.stringify(value)} contains characters that cannot be sent in a header`,
    );
  }
  if (isLoopbackOrUnspecified(value)) {
    throw new GatewayIdentityError(
      `trusted-proxy forwarded client address ${JSON.stringify(value)} is a loopback or unspecified address; ` +
        "the gateway rejects the upgrade (403) unless the forwarded headers name a routable client address",
    );
  }
  return value;
}

/** IPv4/IPv6 loopback, the unspecified addresses, and IPv4-mapped loopback. */
function isLoopbackOrUnspecified(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const withoutZone = bare.split("%")[0]!.toLowerCase();
  if (withoutZone === "::1" || withoutZone === "::" || withoutZone === "0.0.0.0") {
    return true;
  }
  const mapped = withoutZone.startsWith("::ffff:")
    ? withoutZone.slice("::ffff:".length)
    : withoutZone;
  return /^127\./.test(mapped) || mapped === "0.0.0.0";
}

/**
 * The system identity a bridge presents on sockets that serve no single person
 * (agent discovery, orphan-transcript recovery, config defaults, health probes).
 * Namespaced per instance so two bridges on one gateway stay distinguishable in the
 * gateway's own user list and audit trail.
 */
export function systemIdentityFor(instanceName: string | null): string {
  const suffix = (instanceName ?? "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `atrium-bridge:${suffix.length > 0 ? suffix : "default"}`;
}

/**
 * Build the upgrade headers for one identity. Returns an empty object for a
 * connection with no identity (token mode), so call sites can spread it
 * unconditionally.
 */
export function buildIdentityHeaders(
  identity: GatewayIdentity | undefined,
  userHeader: string = DEFAULT_TRUSTED_PROXY_USER_HEADER,
): Record<string, string> {
  if (identity === undefined) {
    return {};
  }
  const headers: Record<string, string> = {
    [userHeader]: assertIdentityUser(identity.user),
    "x-forwarded-for": assertForwardedClientIp(identity.forwardedFor),
    "x-forwarded-proto": identity.forwardedProto,
    "x-forwarded-host": identity.forwardedHost,
    // `gateway.auth.trustedProxy.requiredHeaders` names headers that must be
    // present, and the value an operator sets for a real reverse proxy is
    // ["x-forwarded-proto", "x-forwarded-host"]. A deployment that runs an
    // identity proxy for its people AND this bridge for Atrium configures that
    // list ONCE, for both.
    //
    // WHERE IT BITES, measured 2026-09-12 against gateway 2026.9.2 with that list
    // configured: the WebSocket connect is admitted WITHOUT them, but the HTTP
    // media route answers 401. So a bridge missing them would connect, run turns
    // normally, and silently lose every outbound file — the same shape of failure
    // as sending that route no identity at all. Sent on every connection because
    // the two surfaces share this builder and only one of them enforces the rule.
    //
    // Stated as what this connection actually is, never echoed from anywhere: the
    // bridge speaks to the gateway over its operator URL, and that URL's scheme
    // and host are the honest answer to "how did you reach me".
  };
  if (identity.scopeCap !== undefined) {
    if (identity.scopeCap.length === 0) {
      throw new GatewayIdentityError(
        "trusted-proxy scope ceiling is empty: the gateway reads an empty x-openclaw-scopes as 'no scopes', " +
          "which authenticates a socket that can do nothing; omit the ceiling instead",
      );
    }
    for (const scope of identity.scopeCap) {
      if (!SAFE_HEADER_VALUE.test(scope) || HEADER_SEPARATORS.test(scope)) {
        throw new GatewayIdentityError(
          `trusted-proxy scope ${JSON.stringify(scope)} contains characters that cannot be sent in a header`,
        );
      }
    }
    headers[SCOPE_CAP_HEADER] = identity.scopeCap.join(",");
  }
  return headers;
}

/**
 * Resolve the identity one socket should present, or `undefined` in token mode
 * (where the caller must open the socket exactly as before).
 *
 * Throws rather than degrading: a trusted-proxy instance with no usable forwarded
 * address would open sockets the gateway rejects with a bare 403, and a bridge that
 * silently fell back to token mode would attribute every session to the shared owner
 * again — the exact defect this mode exists to remove.
 */
export function identityFor(params: {
  authMode: GatewayAuthMode | undefined;
  forwardedClientIp: string | null | undefined;
  user: string;
  forwardedProto: string;
  forwardedHost: string;
  scopeCap?: readonly string[];
}): GatewayIdentity | undefined {
  if (params.authMode !== "trusted-proxy") {
    return undefined;
  }
  const forwardedFor = assertForwardedClientIp(params.forwardedClientIp ?? "");
  return {
    user: assertIdentityUser(params.user),
    forwardedFor,
    forwardedProto: params.forwardedProto,
    forwardedHost: params.forwardedHost,
    ...(params.scopeCap === undefined ? {} : { scopeCap: params.scopeCap }),
  };
}

/**
 * First routable IPv4 of this host, used when no address is configured. The value
 * is not a security boundary — the gateway only reads forwarded headers from a
 * source already inside `gateway.trustedProxies`, and checks this one solely for
 * "is the client loopback" — so discovering it beats making every deployment set it
 * by hand and get it wrong. Returns null when the host has no routable address,
 * which `identityFor` turns into a named refusal.
 */
export function detectForwardedClientIp(
  interfaces: Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>,
): string | null {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const isV4 = entry.family === "IPv4" || entry.family === 4;
      if (isV4 && !entry.internal && !isLoopbackOrUnspecified(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

/**
 * Memoized host address for trusted-proxy sockets. Resolved once: a bridge does not
 * change network position while it runs, and re-scanning the interfaces on every
 * connect would put a syscall on the turn path for a value that cannot move.
 */
let cachedHostIp: string | null | undefined;

export function hostForwardedClientIp(
  read: () => Record<
    string,
    Array<{ address: string; family: string | number; internal: boolean }> | undefined
  > = () => networkInterfaces(),
): string | null {
  if (cachedHostIp === undefined) {
    cachedHostIp = detectForwardedClientIp(read());
  }
  return cachedHostIp;
}

/** Test seam: forget the discovered address. */
export function resetHostForwardedClientIpCache(): void {
  cachedHostIp = undefined;
}
