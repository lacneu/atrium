// Per-user access control + RBAC, shared by the public function surface.
//
// Identity model (load-bearing):
//   - @convex-dev/auth owns the `users` table (spread via `...authTables`).
//     `getAuthUserId(ctx)` returns the stable Id<"users"> for the request.
//   - Our project fields (role, routing) live in `profiles` (1:1 with a users
//     row), keyed by that same userId, so ownership is a direct id comparison.
//
// Role model (Open WebUI style): pending -> user -> admin.
//   - The FIRST user ever to sign in becomes "admin" (bootstrap via the
//     `appMeta` singleton, which serializes concurrent first sign-ins).
//   - Every subsequent user starts "pending" (blocked) until an admin approves.
//
// ensureProfile() is the SINGLE writer of `role`: it creates the profile and
// assigns the bootstrap role exactly once. Every other function READS the role
// via requireActive/requireAdmin and never creates or mutates it.

import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { anonAuthEnabled, emailDomainAllowed } from "./authDomains";
import {
  permissionsForRoleKey,
  roleHasPermission,
  type Permission,
} from "./rbac";

export type Role = "pending" | "user" | "admin";
const APP_META_KEY = "singleton";

/**
 * The identity context for a request:
 *   - realUserId      = who is actually signed in (always the auth identity)
 *   - effectiveUserId = the identity the request operates AS. Equal to
 *     realUserId, EXCEPT when the real caller is an admin who started
 *     impersonation: then it is the impersonated target.
 *   - impersonating   = the two differ.
 *
 * This split is the whole impersonation model: user-data functions scope to
 * `effectiveUserId` (so the admin sees/acts exactly as the target), while
 * admin/control functions key off `realUserId` (so admin power — and the
 * ability to stop impersonation — is always tied to who you really are, and
 * impersonation can never escalate).
 */
export type Actor = {
  realUserId: Id<"users">;
  effectiveUserId: Id<"users">;
  impersonating: boolean;
};

/** Raw authenticated user id (NEVER impersonation-resolved) or throw. */
async function rawUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Unauthorized: authentication required");
  }
  return userId;
}

/** The REAL signed-in user id — bypasses impersonation. Used by control paths. */
export async function requireRealUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  return rawUserId(ctx);
}

/**
 * Resolve the request's Actor. Reads ONLY the real profile's
 * `impersonatingUserId` once — no recursion (a target's own field is ignored),
 * and only when the real profile is an admin and the target still exists.
 */
export async function getActor(ctx: QueryCtx | MutationCtx): Promise<Actor> {
  const realUserId = await rawUserId(ctx);
  const realProfile = await getProfile(ctx, realUserId);
  let effectiveUserId = realUserId;
  const target = realProfile?.impersonatingUserId;
  if (roleOf(realProfile) === "admin" && target) {
    const targetProfile = await getProfile(ctx, target);
    if (targetProfile !== null) effectiveUserId = target;
  }
  return {
    realUserId,
    effectiveUserId,
    impersonating: effectiveUserId !== realUserId,
  };
}

/**
 * Effective user id (impersonation-aware). This is the default identity for
 * user-data functions. Does NOT check role.
 */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  return (await getActor(ctx)).effectiveUserId;
}

/** Read the caller's profile (or null). Read-only; never creates. */
export async function getProfile(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** A missing role is treated as "pending" (least privilege). */
export function roleOf(profile: Doc<"profiles"> | null): Role {
  return (profile?.role as Role | undefined) ?? "pending";
}

/**
 * Ensure a profile exists for the authenticated user and assign its bootstrap
 * role. The SINGLE place a role is created. Bootstrap is serialized on the
 * `appMeta` singleton:
 *   - first ever sign-in (adminAssigned false) -> this user becomes "admin"
 *     AND the flag is flipped in the same transaction;
 *   - everyone else -> "pending".
 * Two concurrent first sign-ins both read adminAssigned=false, both try to flip
 * it; Convex OCC lets one commit, retries the other, which then sees the flag
 * set and lands on "pending". No double-admin.
 *
 * MUTATIONS only (it may insert). Returns the userId.
 */
export async function ensureProfile(ctx: MutationCtx): Promise<Id<"users">> {
  // Provisions the CALLER's OWN profile -> must be the REAL identity, never the
  // impersonated one (otherwise an impersonating admin would touch the target).
  const userId = await rawUserId(ctx);

  // AUTHORITATIVE email-domain gate (defense-in-depth behind auth.ts profile()).
  // Runs on BOTH the existing- and new-profile paths, so a profile that slipped
  // past profile() (the untestable provider layer) is still refused. Fail-closed:
  //   - email present  → MUST be in an allowed domain.
  //   - email ABSENT   → allowed ONLY when the dev Anonymous provider is on
  //     (no-email is its signature). In production (anon off) a no-email OAuth
  //     identity — e.g. a flaky Microsoft Entra token with no mapped email — is
  //     REFUSED, never silently provisioned.
  const identity = await ctx.auth.getUserIdentity();
  // @convex-dev/auth's JWT does NOT carry the `email` claim, so identity.email is
  // undefined on a real OAuth session. The verified email lives on the users row
  // (written by the provider profile()), which is the source of truth — resolve
  // from there, falling back to identity for any provider that does include it.
  const userDoc = await ctx.db.get(userId);
  const email =
    (identity?.email as string | undefined) ??
    (userDoc?.email as string | undefined) ??
    undefined;
  if (email === undefined) {
    if (!anonAuthEnabled()) {
      throw new Error("Forbidden: identity has no email");
    }
  } else if (!emailDomainAllowed(email)) {
    throw new Error("Forbidden: email domain not allowed");
  }

  // Display name resolved like email: the JWT may not carry `name`, so the users
  // row (written by the provider profile()) is the source of truth, with
  // identity as a fallback for any provider that does include it.
  const name =
    (identity?.name as string | undefined) ??
    (userDoc?.name as string | undefined) ??
    undefined;

  const existing = await getProfile(ctx, userId);
  if (existing !== null) {
    // Backfill a role-less legacy row to "pending" (least privilege) so the rest
    // of the code can assume a role is present after ensureProfile. ALSO BACKFILL
    // the DISPLAY fields (email/name) from the IdP source of truth — but ONLY
    // when MISSING, never overwriting an existing value. The display `name` is
    // USER-OWNED once set (a user can edit it — e.g. a new married name — via
    // me.setMyName, an admin via admin.setUserName), so a later sign-in must not
    // clobber it back to the IdP value; the IdP only SEEDS it. This heals legacy
    // / pre-persistence profiles without fighting user edits. Never touches
    // `role` (the claim flow above owns it) nor `canonical` (write-once routing
    // key — a change would fork the gateway session). Idempotent once filled.
    const patch: { role?: Role; email?: string; name?: string } = {};
    if (existing.role === undefined) patch.role = "pending";
    if (existing.email === undefined && email !== undefined) patch.email = email;
    if (existing.name === undefined && name !== undefined) patch.name = name;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, patch);
    }
    return userId;
  }

  // ACCOUNT LINKING (security). This identity (provider+subject -> a fresh
  // convex-auth userId) has NO profile yet. If a profile ALREADY exists with the
  // SAME email, it belongs to a DIFFERENT identity — e.g. the user authenticated
  // via Google before and is now coming in via Microsoft Entra. Cross-provider
  // linking MUST be EXPLICIT (a signed-in user adds a provider from settings),
  // never an implicit auto-merge nor a silent SECOND profile (the duplicate-
  // account bug). BLOCK the auto-provision here — placed BEFORE any appMeta /
  // admin-claim write so a blocked sign-in has ZERO side effects (it must never
  // flip `adminAssigned`). Org SSO emails are case-stable, so the exact-match
  // index lookup is reliable in practice.
  if (email !== undefined) {
    const emailOwner = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (emailOwner !== null) {
      throw new Error(
        "Un compte existe déjà pour cet email via une autre méthode de " +
          "connexion. Connectez-vous avec celle-ci, puis liez ce fournisseur " +
          "depuis vos paramètres.",
      );
    }
  }

  // Resolve the singleton, creating it on first ever call.
  let meta = await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
  if (meta === null) {
    const metaId = await ctx.db.insert("appMeta", {
      key: APP_META_KEY,
      adminAssigned: false,
    });
    meta = (await ctx.db.get(metaId))!;
  }

  let role: Role;
  if (!meta.adminAssigned) {
    // Claim admin. Flipping the flag here is the OCC serialization point.
    await ctx.db.patch(meta._id, { adminAssigned: true });
    role = "admin";
  } else if (anonAuthEnabled()) {
    // DEV ONLY (OPENCLAW_ENABLE_ANON_AUTH=1): auto-approve every non-bootstrap
    // sign-in as an ACTIVE "user" so multiple test identities are immediately
    // usable for live multi-user testing — no manual approval round-trip. In
    // PRODUCTION the anon flag is UNSET, so this branch never runs and
    // non-bootstrap users correctly land "pending" (admin approval required).
    role = "user";
  } else {
    role = "pending";
  }

  await ctx.db.insert("profiles", {
    userId,
    role,
    email,
    name,
    canonical: canonicalFromEmail(email, userId),
  });
  return userId;
}

/** Derive a stable, filesystem-safe canonical key for per-user routing. */
export function canonicalFromEmail(
  email: string | undefined,
  userId: Id<"users">,
): string {
  if (email && email.includes("@")) {
    const local = email.split("@")[0]!;
    const slug = local.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return `u-${userId.slice(0, 10)}`;
}

/**
 * Require the caller to be an ACTIVE user (role user|admin). This is the gate
 * every chat/data function must use — being merely authenticated (which a
 * "pending" user is) is NOT enough.
 */
export async function requireActive(ctx: QueryCtx | MutationCtx): Promise<{
  userId: Id<"users">; // EFFECTIVE id (impersonation-aware); existing callers use this
  realUserId: Id<"users">;
  impersonating: boolean;
  actor: Actor; // pass straight to the audit helper
  role: Role; // EFFECTIVE role (so impersonating a pending user is blocked, as it should be)
  profile: Doc<"profiles"> | null; // EFFECTIVE profile
}> {
  const actor = await getActor(ctx);
  const profile = await getProfile(ctx, actor.effectiveUserId);
  const role = roleOf(profile);
  if (role === "pending") {
    throw new Error("Forbidden: account pending approval");
  }
  return {
    userId: actor.effectiveUserId,
    realUserId: actor.realUserId,
    impersonating: actor.impersonating,
    actor,
    role,
    profile,
  };
}

/**
 * Require the caller to be an admin. Keys off the REAL identity, so admin power
 * is tied to who you actually are: impersonation never grants it, never removes
 * it, and an admin impersonating a regular user can still stop impersonating.
 * Returns the real admin's userId.
 */
export async function requireAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await rawUserId(ctx);
  const profile = await getProfile(ctx, userId);
  if (roleOf(profile) !== "admin") {
    throw new Error("Forbidden: admin role required");
  }
  return userId;
}

/**
 * The EFFECTIVE permission set of a user: their role's permissions (via the
 * roles matrix — admins carry the wildcard) UNION any per-user `extraPermissions`
 * an admin granted (the per-tab RBAC grants). Used by requirePermission + getMe.
 */
export async function effectiveUserPermissions(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Set<string>> {
  const profile = await getProfile(ctx, userId);
  const perms = await permissionsForRoleKey(ctx, roleOf(profile));
  for (const p of (profile?.extraPermissions as string[] | undefined) ?? []) {
    perms.add(p);
  }
  return perms;
}

/**
 * Require the REAL signed-in user (NEVER impersonation — tab/data access is about
 * who is actually logged in, same rule as requireAdmin) to hold `perm`. Admins
 * pass via the wildcard. Throws "Forbidden: missing permission ..." otherwise.
 * This is the AUTHORITATIVE server-side gate; frontend tab hiding is cosmetic.
 */
export async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  perm: Permission,
): Promise<Id<"users">> {
  const userId = await rawUserId(ctx);
  const perms = await effectiveUserPermissions(ctx, userId);
  if (!roleHasPermission(perms, perm)) {
    throw new Error(`Forbidden: missing permission ${perm}`);
  }
  return userId;
}

/** Load a chat and assert the given user owns it. Throws otherwise. */
export async function requireOwnedChat(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
) {
  const chat = await ctx.db.get(chatId);
  if (chat === null) {
    throw new Error("Not found: chat does not exist");
  }
  if (chat.userId !== userId) {
    throw new Error("Forbidden: chat not owned by user");
  }
  return chat;
}
