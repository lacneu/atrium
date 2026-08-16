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
import {
  declarationVerdict,
  provisionAccountName,
  PROVISION_KEYS_ENV,
} from "./provisionKeys";
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

  let resolved = await ctx.runQuery(internal.apiKeys.findByHash, { hash });
  if (resolved === null) {
    // A provisioning key DECLARED in the environment may not be persisted yet: the
    // platform writes the variable and calls the API immediately, faster than the
    // reconciliation interval. Honour it on this first call rather than making an
    // install wait out a cron. Checked against the declaration itself, so an
    // unknown key — a typo, a probe — costs one comparison and never a write.
    // Same PURE check as below — the reconciliation only runs when the declaration
    // actually vouches for this hash, so an unknown key costs a comparison and
    // never a write.
    const vouched = await declarationVerdict(
      hash,
      hashKey,
      process.env[PROVISION_KEYS_ENV],
    );
    if (vouched?.kind === "declared") {
      await ctx.runAction(internal.provisionKeys.reconcileProvisionKeys, {});
      resolved = await ctx.runQuery(internal.apiKeys.findByHash, { hash });
    }
  }
  if (resolved === null) {
    return { ok: false, status: 401, error: "invalid key" };
  }

  let { key, serviceAccount, roleKey, permissions } = resolved;
  // A DECLARED key must stop working the moment its declaration does. Resolving it
  // is not enough: after a rotation or a withdrawal the superseded row is still
  // active until the reconciliation runs, so a hit alone would keep honouring it —
  // for up to a whole interval, against a documented promise of immediate effect.
  // Only declaration-managed accounts pay this check, and it is a comparison
  // against the environment, not a database read.
  // Which declared host, if any, owns this hash. Computed HERE — a pure read of the
  // environment plus at most one SHA-256 per declared host — rather than through a
  // nested Convex action, which put a sub-call on the critical path of every
  // authenticated request. Nothing declared means no work at all.
  const verdict = await declarationVerdict(
    hash,
    hashKey,
    process.env[PROVISION_KEYS_ENV],
  );
  // An AMBIGUOUS entry never authorises, whichever account the hash resolves to —
  // and the collision must be retired DURABLY, exactly as the declared branch does
  // below. Refusing alone left the manual key intact, so withdrawing the faulty
  // declaration handed it back its original, wider role. Guarded by `disabled` so
  // the work happens once and later attempts are a plain refusal.
  if (verdict?.kind === "quarantined") {
    if (!key.disabled) {
      await ctx.runMutation(internal.provisionKeys.disableDeclaredKey, {
        keyId: key._id,
      });
    }
    return { ok: false, status: 401, error: "key revoked" };
  }
  const declaredLabel = verdict?.kind === "declared" ? verdict.label : null;

  // A COLLISION must fail closed, not wait for the cron. When the declaration
  // reuses a secret that is already a manual key, the hash resolves to that manual
  // account — which carries no `managedBy`, so the block below would skip the
  // declaration check entirely and let the host authenticate with the manual
  // account's role, possibly far wider than `provisioner`. The reconciliation
  // retires the colliding key, but only on its next pass; until then this is the
  // only thing standing in the way.
  if (serviceAccount.managedBy === undefined) {
    if (declaredLabel !== null) {
      // Reconcile ONCE. The retired key still resolves by hash and is still
      // declared, so re-running the pass on every attempt would let the holder of
      // a collided secret drive hashing and paginated mutations up to the
      // pre-authentication limit — the same amplification the revoked-key path
      // already closes. Once it is disabled there is nothing left to do.
      if (!key.disabled) {
        await ctx.runAction(internal.provisionKeys.reconcileProvisionKeys, {});
      }
      return { ok: false, status: 401, error: "key revoked" };
    }
  }
  if (serviceAccount.managedBy !== undefined) {
    const stillDeclared =
      declaredLabel !== null &&
      serviceAccount.name === provisionAccountName(declaredLabel);
    if (!stillDeclared) {
      // Disable THIS row, once — not a full reconciliation. A full pass does not
      // remove the key from the `by_hash` index (withdrawal disables the ACCOUNT),
      // so running one here let the holder of a revoked key drive hashing, sweeps
      // and mutations on EVERY request, up to the pre-authentication rate limit.
      // Patching the row makes every later attempt a plain lookup and a refusal.
      if (!key.disabled) {
        await ctx.runMutation(internal.provisionKeys.disableDeclaredKey, {
          keyId: key._id,
        });
      }
      return { ok: false, status: 401, error: "key revoked" };
    }
    // DECLARED, but the row or its account is still marked revoked — a label that
    // came back, or a declaration that returned to an earlier secret. Resolving it
    // skipped the miss path, so nothing had reconciled it yet and the checks below
    // would refuse a key the declaration currently vouches for, until the next
    // interval. Reconcile now and re-resolve.
    if (key.disabled || serviceAccount.disabled) {
      await ctx.runAction(internal.provisionKeys.reconcileProvisionKeys, {});
      const refreshed = await ctx.runQuery(internal.apiKeys.findByHash, { hash });
      if (refreshed === null) {
        return { ok: false, status: 401, error: "invalid key" };
      }
      resolved = refreshed;
      ({ key, serviceAccount, roleKey, permissions } = refreshed);
    }
  }
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
