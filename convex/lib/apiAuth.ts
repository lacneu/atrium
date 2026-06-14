// API-key authentication for the /api/v1 HTTP surface (httpAction context).
//
// RUNTIME (load-bearing): httpActions run in the default Convex runtime and
// have NO `ctx.db`. So this layer:
//   - hashes the presented Bearer token here (crypto.subtle is available),
//   - resolves the key + service account + permission set via ONE internalQuery
//     (internal.apiKeys.findByHash) — the db work happens inside that query,
//   - carries the EXPANDED permission list on the principal so the permission
//     check is a pure in-memory test (no db) on the httpAction side.
//
// SECURITY: never logs or returns the plaintext key. Disabled/expired keys are
// rejected. Bumping lastUsedAt is best-effort via a fire-and-forget mutation.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { hashKey } from "./apikeys";
import { roleHasPermission, type Permission } from "./rbac";
import { unauthShardKey, UNAUTH_PER_SHARD_PER_WINDOW } from "../apiRateLimit";

/** A verified non-human principal (service account) behind an API key. */
export type ServicePrincipal = {
  type: "service";
  /** serviceAccount id as a string (for trace attribution). */
  id: string;
  roleKey: string;
  serviceAccountId: string;
  /** Expanded permission keys (the role's set, "*" already flattened). */
  permissions: string[];
};

export type AuthResult =
  | { ok: true; principal: ServicePrincipal; keyId: string }
  | { ok: false; status: 401 | 403 | 429; error: string };

/**
 * Authenticate an incoming /api/v1 request by its `Authorization: Bearer <key>`
 * header. Returns the resolved service principal on success, or a 401 result on
 * any failure (missing/garbage header, unknown/disabled/expired key, or a key
 * whose service account is disabled). Permission checks are a SEPARATE step
 * (principalHasPermission) so a route can return 403 vs 401 distinctly.
 */
export async function authenticateApiKey(
  ctx: ActionCtx,
  request: Request,
): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const presented = match[1]!.trim();
  if (!presented) {
    return { ok: false, status: 401, error: "empty bearer token" };
  }

  // Hash the presented key (cheap CPU) — never stored.
  const hash = await hashKey(presented);

  // Pre-resolution DoS guard (SOC2 CC6.6): throttle UNAUTHENTICATED load BEFORE
  // the findByHash DB read, sharded by the presented-key hash so the counter is
  // neither a hot row nor bloatable (see apiRateLimit.unauthShardKey). A flood of
  // bad keys trips this and never reaches the DB read. Valid keys also pass
  // through, but the per-shard cap is high enough that only a flood trips it.
  const unauth = await ctx.runMutation(internal.apiRateLimit.checkApiRateLimit, {
    principalId: unauthShardKey(hash),
    limit: UNAUTH_PER_SHARD_PER_WINDOW,
  });
  if (!unauth.allowed) {
    return { ok: false, status: 429, error: "rate limit exceeded" };
  }

  const resolved = await ctx.runQuery(internal.apiKeys.findByHash, { hash });
  if (resolved === null) {
    return { ok: false, status: 401, error: "invalid key" };
  }

  const { key, serviceAccount, roleKey, permissions } = resolved;
  if (key.disabled) {
    return { ok: false, status: 401, error: "key revoked" };
  }
  if (key.expiresAt !== undefined && key.expiresAt <= Date.now()) {
    return { ok: false, status: 401, error: "key expired" };
  }
  if (serviceAccount.disabled) {
    return { ok: false, status: 401, error: "service account disabled" };
  }

  // Per-key rate limit (SOC2 CC6.6): checked HERE so every authenticated route
  // is covered without per-route wiring (the unauthenticated /health probe never
  // reaches this, so it is exempt). Only AUTHENTICATED calls count toward the
  // window — a bad-key flood is an auth concern, out of this control's scope.
  const rate = await ctx.runMutation(internal.apiRateLimit.checkApiRateLimit, {
    principalId: serviceAccount._id,
  });
  if (!rate.allowed) {
    return { ok: false, status: 429, error: "rate limit exceeded" };
  }

  // Best-effort lastUsedAt bump (do not block the request on it).
  await ctx.runMutation(internal.apiKeys.touchLastUsed, { keyId: key._id });

  const principal: ServicePrincipal = {
    type: "service",
    id: serviceAccount._id,
    roleKey,
    serviceAccountId: serviceAccount._id,
    permissions,
  };
  return { ok: true, principal, keyId: key._id };
}

/**
 * Pure permission check against a principal's pre-resolved permission set. No
 * db access — the set was expanded at authentication time (see file header).
 */
export function principalHasPermission(
  principal: ServicePrincipal,
  perm: Permission,
): boolean {
  return roleHasPermission(new Set(principal.permissions), perm);
}
