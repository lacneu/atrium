// Service accounts, API keys, and RBAC roles — admin-only Convex functions.
//
// D4: this whole module is Convex-only. There is NO /api/v1 HTTP route that
// manages roles/keys/service accounts; the API surface can only *check*
// permissions. Every admin-facing function here goes through requireAdmin
// (REAL identity, impersonation never grants it) and is audited via
// lib/audit.recordAudit.
//
// D3 (crypto runtime): minting a key needs a CSPRNG secret + async hash, which
// are non-deterministic and therefore ILLEGAL in a mutation. So `mintApiKey` is
// an ACTION: it generates+hashes in the V8 runtime, then ctx.runMutation into
// `createKeyRecord` (an internalMutation) which performs requireAdmin + insert +
// audit in a single transaction. Auth identity propagates through runMutation,
// so the inner mutation sees the same admin caller.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getActor, requireAdmin } from "./lib/access";
import { recordAudit } from "./lib/audit";
import { generateApiKey, hashKey } from "./lib/apikeys";
import {
  expandPermissions,
  permissionsForRoleKey,
  PERMISSIONS,
  seedBuiltinRoles,
} from "./lib/rbac";
import {
  applyFilter,
  filterValidator,
  type FilterConfig,
} from "./lib/filters";

// Filter config for service accounts (docs/FILTERS_SPEC.md). Applied over the
// VIEW objects listServiceAccounts returns. The shared `role` key maps onto the
// view's `roleKey` field (a service account's role is its roleKey).
const SERVICE_ACCOUNTS_FILTER_CFG: FilterConfig = {
  searchFields: ["name"],
  structured: {
    role: { field: "roleKey", kind: "string" },
    disabled: { field: "disabled", kind: "bool" },
  },
  advanced: false,
};

// Bounded cascade-delete batch for deleteServiceAccount (mutation limits).
const KEY_DELETE_BATCH = 200;

// Human-only built-in role keys (L2): a service account must never carry these.
// `admin` is the wildcard superset (UI/admin only); pending/user are user-facing
// identities. observer/agent + custom roles are the service-account roles.
const HUMAN_ONLY_ROLE_KEYS = new Set<string>(["pending", "user", "admin"]);

// The built-in admin role key (L1): its permissions must stay the wildcard so an
// `admin`-roled principal can never be silently stripped of access.
const ADMIN_ROLE_KEY = "admin";

// ===========================================================================
// Internal: API-key verification + bookkeeping (called by the httpAction auth
// layer — NOT exposed publicly).
// ===========================================================================

/**
 * Resolve an API key by its SHA-256 hash. Runs in a query (db) context so it
 * can ALSO resolve the owning serviceAccount and pre-compute the role's
 * permission set — the verifying httpAction has no `ctx.db`, so doing the role
 * lookup here is the only way to hand it a ready-to-check permission list in a
 * single round-trip.
 *
 * NOTE (deviation from the contract's "findByHash -> key doc"): we enrich the
 * result with `serviceAccount` + `permissions` precisely because of the
 * action/httpAction no-db boundary. Returns null when no key matches.
 */
export const findByHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hashedKey", hash))
      .unique();
    if (key === null) return null;

    const account = await ctx.db.get(key.serviceAccountId);
    if (account === null) return null;

    const permissions = [
      ...(await permissionsForRoleKey(ctx, account.roleKey)),
    ];

    return {
      key,
      serviceAccount: account,
      roleKey: account.roleKey,
      permissions, // expanded permission keys ("*" already flattened)
    };
  },
});

/** Bump an API key's lastUsedAt. Best-effort bookkeeping (idempotent patch). */
export const touchLastUsed = internalMutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => {
    const key = await ctx.db.get(keyId);
    if (key === null) return;
    await ctx.db.patch(keyId, { lastUsedAt: Date.now() });
  },
});

// ===========================================================================
// Admin: service accounts
// ===========================================================================

export const createServiceAccount = mutation({
  args: {
    name: v.string(),
    roleKey: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { name, roleKey, description }) => {
    const adminId = await requireAdmin(ctx);
    // L2: a service account is a non-human principal — reject the human roleKeys
    // (pending|user|admin). `admin` would grant an API-key principal the wildcard
    // set; pending/user are UI identities. observer/agent + any custom role are
    // allowed. (Role-hygiene / defense-in-depth, not an exploitable bypass.)
    if (HUMAN_ONLY_ROLE_KEYS.has(roleKey)) {
      throw new Error(
        `Refused: roleKey '${roleKey}' is human-only; use observer/agent or a custom role`,
      );
    }
    // Built-ins must exist so a roleKey can resolve at auth time.
    await seedBuiltinRoles(ctx);
    const role = await ctx.db
      .query("roles")
      .withIndex("by_key", (q) => q.eq("key", roleKey))
      .unique();
    if (role === null) {
      throw new Error(`Unknown roleKey: ${roleKey}`);
    }
    const id = await ctx.db.insert("serviceAccounts", {
      name,
      roleKey,
      disabled: false,
      description,
      createdByUserId: adminId,
    });
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "serviceAccount.create", {
      resource: "serviceAccount",
      resourceId: id,
    });
    return id;
  },
});

// Admin: rename a service account and/or change its role. Both fields optional
// (patch only what's provided). roleKey runs the SAME validation as create — the
// human-only guard (reject pending|user|admin) + must resolve to a real role —
// so an API-key principal can never be escalated to a human/wildcard role. A
// role change takes effect immediately for EXISTING keys (auth resolves
// account.roleKey -> permissions per request; no re-mint needed). Audited.
export const updateServiceAccount = mutation({
  args: {
    serviceAccountId: v.id("serviceAccounts"),
    name: v.optional(v.string()),
    roleKey: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { serviceAccountId, name, roleKey, description }) => {
    await requireAdmin(ctx);
    const account = await ctx.db.get(serviceAccountId);
    if (account === null) throw new Error("Not found: serviceAccount");
    const patch: { name?: string; roleKey?: string; description?: string } = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error("Refused: name cannot be empty");
      }
      patch.name = trimmed;
    }
    if (description !== undefined) {
      const trimmed = description.trim();
      patch.description = trimmed.length > 0 ? trimmed : undefined;
    }
    if (roleKey !== undefined) {
      if (HUMAN_ONLY_ROLE_KEYS.has(roleKey)) {
        throw new Error(
          `Refused: roleKey '${roleKey}' is human-only; use observer/agent or a custom role`,
        );
      }
      await seedBuiltinRoles(ctx);
      const role = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", roleKey))
        .unique();
      if (role === null) throw new Error(`Unknown roleKey: ${roleKey}`);
      patch.roleKey = roleKey;
    }
    if (Object.keys(patch).length === 0) return; // no-op (nothing provided)
    await ctx.db.patch(serviceAccountId, patch);
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "serviceAccount.update", {
      resource: "serviceAccount",
      resourceId: serviceAccountId,
    });
  },
});

export const listServiceAccounts = query({
  args: { filter: v.optional(filterValidator) },
  handler: async (ctx, { filter }) => {
    await requireAdmin(ctx);
    const accounts = await ctx.db.query("serviceAccounts").order("desc").take(200);
    const views = accounts.map((a) => ({
      _id: a._id,
      name: a.name,
      roleKey: a.roleKey,
      disabled: a.disabled,
      description: a.description ?? null,
      createdByUserId: a.createdByUserId,
      createdAt: a._creationTime,
    }));
    return applyFilter(views, filter, SERVICE_ACCOUNTS_FILTER_CFG);
  },
});

/**
 * Admin: delete a service account entirely, cascade-deleting its API keys first.
 *
 * Distinct from `revokeApiKey` (which only DISABLES a key so its id stays
 * referenceable for audit): this removes the whole account + every key it owns.
 * The keys are deleted in bounded batches via the `by_account` index (mutation
 * limits), then the account row is deleted. requireAdmin (REAL identity,
 * impersonation never grants it) gates it; the action is audited. Throws
 * "Not found" if the account does not exist.
 */
export const deleteServiceAccount = mutation({
  args: { serviceAccountId: v.id("serviceAccounts") },
  handler: async (ctx, { serviceAccountId }) => {
    await requireAdmin(ctx);
    const account = await ctx.db.get(serviceAccountId);
    if (account === null) throw new Error("Not found: service account");
    // Cascade-delete this account's API keys (bounded batches via by_account).
    let deletedKeys = 0;
    for (;;) {
      const batch = await ctx.db
        .query("apiKeys")
        .withIndex("by_account", (q) =>
          q.eq("serviceAccountId", serviceAccountId),
        )
        .take(KEY_DELETE_BATCH);
      if (batch.length === 0) break;
      for (const key of batch) {
        await ctx.db.delete(key._id);
        deletedKeys += 1;
      }
      if (batch.length < KEY_DELETE_BATCH) break;
    }
    await ctx.db.delete(serviceAccountId);
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "serviceAccount.delete", {
      resource: "serviceAccount",
      resourceId: serviceAccountId,
    });
    return { ok: true, deletedKeys };
  },
});

// ===========================================================================
// Admin: API keys (mint is an ACTION — see file header / D3)
// ===========================================================================

/**
 * Internal mutation that persists a minted key. Separated from the action so
 * requireAdmin + insert + audit all run in ONE transaction (the action holds no
 * db). Receives the already-hashed key and display affordances; the plaintext
 * NEVER reaches the db.
 */
export const createKeyRecord = internalMutation({
  args: {
    serviceAccountId: v.id("serviceAccounts"),
    hashedKey: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const account = await ctx.db.get(args.serviceAccountId);
    if (account === null) throw new Error("Not found: service account");
    const keyId = await ctx.db.insert("apiKeys", {
      serviceAccountId: args.serviceAccountId,
      hashedKey: args.hashedKey,
      prefix: args.prefix,
      lastFour: args.lastFour,
      disabled: false,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
    const actor = await getActor(ctx);
    // Audit attribution: record WHO (admin) and WHICH key — never the plaintext.
    await recordAudit(ctx, actor, "apiKey.mint", {
      resource: "apiKey",
      resourceId: keyId,
    });
    void adminId; // admin id is captured via actor; keep requireAdmin's gate
    return keyId;
  },
});

/**
 * Mint a new API key for a service account. ACTION (D3: CSPRNG + async hash are
 * non-deterministic). Returns the plaintext exactly ONCE — the caller must
 * surface it to the admin immediately; it is never persisted or retrievable
 * again. Admin gating + audit happen inside createKeyRecord.
 */
export const mintApiKey = action({
  args: {
    serviceAccountId: v.id("serviceAccounts"),
    expiresAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { serviceAccountId, expiresAt },
  ): Promise<{ keyId: Id<"apiKeys">; plaintext: string; prefix: string; lastFour: string }> => {
    const generated = generateApiKey();
    const hashedKey = await hashKey(generated.plaintext);
    const keyId: Id<"apiKeys"> = await ctx.runMutation(
      internal.apiKeys.createKeyRecord,
      {
        serviceAccountId,
        hashedKey,
        prefix: generated.prefix,
        lastFour: generated.lastFour,
        expiresAt,
      },
    );
    // The ONLY time plaintext leaves this server. Never logged.
    return {
      keyId,
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    };
  },
});

export const revokeApiKey = mutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => {
    await requireAdmin(ctx);
    const key = await ctx.db.get(keyId);
    if (key === null) throw new Error("Not found: api key");
    // Disable (not delete) so the key id stays referenceable for audit.
    await ctx.db.patch(keyId, { disabled: true });
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "apiKey.revoke", {
      resource: "apiKey",
      resourceId: keyId,
    });
  },
});

export const listKeys = query({
  args: { serviceAccountId: v.optional(v.id("serviceAccounts")) },
  handler: async (ctx, { serviceAccountId }) => {
    await requireAdmin(ctx);
    const keys: Doc<"apiKeys">[] = serviceAccountId
      ? await ctx.db
          .query("apiKeys")
          .withIndex("by_account", (q) =>
            q.eq("serviceAccountId", serviceAccountId),
          )
          .order("desc")
          .take(200)
      : await ctx.db.query("apiKeys").order("desc").take(200);
    // NEVER return hashedKey — only the non-secret display affordances.
    return keys.map((k) => ({
      _id: k._id,
      serviceAccountId: k.serviceAccountId,
      prefix: k.prefix,
      lastFour: k.lastFour,
      disabled: k.disabled,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
      expiresAt: k.expiresAt ?? null,
    }));
  },
});

// ===========================================================================
// Admin: roles (the future RBAC matrix; seeded built-ins always available)
// ===========================================================================

export const listRoles = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // Read-only context: cannot seed here. Merge stored rows over the built-in
    // baseline so the matrix shows built-ins even before the first mutation
    // seeds them; a later createRole/mint call persists them.
    const stored = await ctx.db.query("roles").order("asc").take(500);
    return stored.map((r) => ({
      _id: r._id,
      key: r.key,
      name: r.name,
      description: r.description ?? null,
      builtin: r.builtin,
      permissions: r.permissions,
    }));
  },
});

/**
 * D-2: idempotently seed the built-in roles. The matrix UI calls this on first
 * admin load so built-ins exist in the `roles` table (listRoles is read-only and
 * cannot seed), removing the client-side BUILTIN_BASELINE overlay + its drift
 * risk. requireAdmin (REAL identity) gates it; safe to call repeatedly.
 */
export const ensureRolesSeeded = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    await seedBuiltinRoles(ctx);
  },
});

export const createRole = mutation({
  args: {
    key: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    permissions: v.array(v.string()),
  },
  handler: async (ctx, { key, name, description, permissions }) => {
    await requireAdmin(ctx);
    await seedBuiltinRoles(ctx);
    const existing = await ctx.db
      .query("roles")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing !== null) {
      throw new Error(`Role already exists: ${key}`);
    }
    assertValidPermissions(permissions);
    const id = await ctx.db.insert("roles", {
      key,
      name,
      description,
      builtin: false,
      permissions,
    });
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "role.create", {
      resource: "role",
      resourceId: id,
    });
    return id;
  },
});

export const updateRolePermissions = mutation({
  args: {
    roleId: v.id("roles"),
    permissions: v.array(v.string()),
  },
  handler: async (ctx, { roleId, permissions }) => {
    await requireAdmin(ctx);
    const role = await ctx.db.get(roleId);
    if (role === null) throw new Error("Not found: role");
    assertValidPermissions(permissions);
    // L1: the builtin admin role must stay the wildcard set. Reject downgrading
    // it out of ["*"] so the lockout is authoritative server-side (the client
    // matrix guard alone is not enough — any service account on roleKey 'admin'
    // would otherwise lose all permissions). seedBuiltinRoles self-heals, but a
    // hard reject is the defense-in-depth bar.
    if (
      role.key === ADMIN_ROLE_KEY &&
      role.builtin &&
      !permissions.includes("*")
    ) {
      throw new Error("Refused: the builtin admin role must keep the '*' wildcard");
    }
    await ctx.db.patch(roleId, { permissions });
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "role.updatePermissions", {
      resource: "role",
      resourceId: roleId,
    });
  },
});

/**
 * Reject any permission key outside the closed PERMISSIONS set (the wildcard
 * "*" is allowed for an admin-equivalent role). Keeps the matrix from storing
 * typo'd permissions that would silently never match.
 */
function assertValidPermissions(permissions: string[]): void {
  const valid = expandPermissions(Object.values(PERMISSIONS)); // all known keys
  for (const p of permissions) {
    if (p === "*") continue;
    if (!valid.has(p)) {
      throw new Error(`Unknown permission key: ${p}`);
    }
  }
}
