// RBAC permission engine (increment 1 "spine").
//
// This is a NEW layer that sits ALONGSIDE lib/access.ts — it does NOT replace
// it (D5). lib/access keeps owning the user identity model (impersonation,
// first-admin bootstrap, last-admin guard, audit attribution) and the
// profiles.role validator. lib/rbac owns the role -> permission MATRIX used by:
//   - service-account API-key principals (the increment-1 principals), and
//   - (later increments) custom role assignment for users.
//
// Design:
//   - PERMISSIONS is a compile-time const object; `Permission` is its value
//     union, so every permission check is type-checked against the closed set.
//   - BUILTIN_ROLES is the seeded baseline; the `roles` table is the runtime
//     source of truth (custom roles + admin edits), with BUILTIN as fallback.
//   - The wildcard "*" in a role's permission list means "all permissions"
//     (the admin superset); roleHasPermission expands it.

import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Compile-time permission keys. Mirrors docs/OBSERVABILITY_PLATFORM_PLAN.md
 * "Permission keys". Keep this the single source: every `traces.read`-style
 * literal in the codebase should flow from here so a typo is a type error.
 */
export const PERMISSIONS = {
  TRACES_READ: "traces.read",
  TRACES_READ_CONTENT: "traces.read.content", // gates raw-content capture (D2)
  TRACES_WRITE: "traces.write",
  KPI_READ: "kpi.read",
  KPI_WRITE: "kpi.write",
  OPENCLAW_QUERY: "openclaw.query", // query OpenClaw via the bridge
  ANOMALIES_READ: "anomalies.read",
  ANOMALIES_REPORT: "anomalies.report",
  BRIDGE_READ: "bridge.read", // read bridge health (Settings → Bridge tab)
  // Edit per-instance NON-SECRET bridge config (mediaMode, rehydration, caps) via
  // Settings → Bridge. A sensitive WRITE — admin-only (reached through the admin
  // wildcard), DELIBERATELY excluded from GRANTABLE_USER_PERMISSIONS below.
  BRIDGE_CONFIG_WRITE: "bridge.config.write",
  // Trigger a BOUNDED self-correction (e.g. reconcile a chat's stuck stream). A
  // sensitive WRITE — admin / service-account only, never in GRANTABLE_USER below.
  SELF_HEAL: "selfheal",
  // Respond to / resolve user-submitted feedback reports via the key-authed API
  // (the meta/critic gateway agent's support loop). A WRITE that reaches the
  // report owner's notification bell — service-account (agent role) + admin.
  FEEDBACK_RESPOND: "feedback.respond",
  // Read agent workspace files via the bridge. A3v2 (grant-aligned): the holder
  // reads ALL files (MEMORY/USER included) but ONLY for agents in their OWN
  // effective grants — the same agents they can already chat with (and thus ask
  // to print any file anyway). Enforced in agentFiles.checkFilesReadAccess.
  AGENT_FILES_READ: "agents.files.read",
  CHATS_READ: "chats.read", // read conversational data
  GROUPS_MANAGE: "groups.manage", // create/manage groups + group agents (admin-only)
  CHARTS_MANAGE: "charts.manage", // manage chart defaults + group availability (admin-only)
  ADMIN_MANAGE: "admin.manage", // superset; UI/admin only
} as const;

/** The closed set of valid permission keys. */
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Permissions an admin may GRANT to a human (non-admin) user as `extraPermissions`
 * to open specific READ-ONLY Settings tabs. DELIBERATELY excludes admin.manage and
 * any write/sensitive permission: these are exactly the read perms already held by
 * the `observer`/`agent` service-account roles (data already classified
 * observer-readable — D2 metadata-only, non-PHI), so extending them to human users
 * is consistent with the existing sensitivity model, NOT a new exposure. The
 * grant mutation enforces this set SERVER-SIDE (UI hiding is not enforcement).
 *
 * agents.files.read (A3v2) gates the read-only Settings "agentFiles" tab AND is
 * server-scoped in agentFiles.ts to the holder's OWN effective agents (full
 * file depth there, incl. memory-class files — see checkFilesReadAccess).
 */
export const GRANTABLE_USER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.TRACES_READ,
  PERMISSIONS.KPI_READ,
  PERMISSIONS.ANOMALIES_READ,
  PERMISSIONS.BRIDGE_READ,
  PERMISSIONS.AGENT_FILES_READ,
  // Delegated GROUP management (the Groups tab): a holder administers ONLY the
  // groups they are a MANAGER of (groupMembers.manager); admins manage all.
  // Create/delete-group + promoting a manager stay admin-only (server gates split
  // accordingly) — granting this perm is necessary but not sufficient per group.
  PERMISSIONS.GROUPS_MANAGE,
] as const;

/**
 * Grantable permissions that gate a NON-TAB surface. Kept OUT of
 * GRANTABLE_USER_PERMISSIONS because that list is pinned 1:1 to the Settings
 * GRANTABLE_TABS by the frontend lockstep test (src/chat/admin/tabAccess.test.ts)
 * — a perm without a tab would break the nav/landing/grant-editor mirror. The
 * SERVER grant gate (isGrantableUserPermission, used by admin.setUserPermissions)
 * accepts the UNION, so these are just as grantable as the tab perms.
 * Currently EMPTY: agents.files.read moved to the tab list when the Settings
 * "agentFiles" tab shipped (CONF-4c) — the mechanism stays for future perms.
 */
export const GRANTABLE_NON_TAB_USER_PERMISSIONS: readonly Permission[] = [] as const;

/** True if `perm` is one an admin may grant to a non-admin user (server gate). */
export function isGrantableUserPermission(perm: string): perm is Permission {
  return (
    (GRANTABLE_USER_PERMISSIONS as readonly string[]).includes(perm) ||
    (GRANTABLE_NON_TAB_USER_PERMISSIONS as readonly string[]).includes(perm)
  );
}

/** Wildcard sentinel: a role carrying it grants every permission. */
export const WILDCARD = "*" as const;

/**
 * Built-in roles seeded into `roles`. `permissions` is either an explicit list
 * of Permission keys or the wildcard "*" (admin superset). Keys here are the
 * stable role keys referenced by serviceAccounts.roleKey and (later) profiles.
 *
 * Built-in role keys `pending|user|admin` deliberately map onto the existing
 * lib/access role model (D5); `observer|agent` are the service-account roles.
 */
export const BUILTIN_ROLES: Record<
  string,
  { name: string; description: string; permissions: Permission[] | typeof WILDCARD }
> = {
  pending: {
    name: "Pending",
    description:
      "Authenticated but not yet approved — access is blocked until an admin approves the account.",
    permissions: [],
  },
  user: {
    name: "User",
    description: "Approved person with chat access.",
    permissions: [PERMISSIONS.CHATS_READ],
  },
  admin: {
    name: "Admin",
    description:
      "Full access (superset): manages users, roles, agents, instances and observability.",
    permissions: WILDCARD,
  },
  observer: {
    name: "Observer",
    description:
      "READ-ONLY service account for monitoring: views traces, KPIs, anomalies and bridge/version status through the API. Cannot write or trigger anything.",
    permissions: [
      PERMISSIONS.TRACES_READ,
      PERMISSIONS.KPI_READ,
      PERMISSIONS.ANOMALIES_READ,
      // Bridge compat/version is observability too: without this the key-authed
      // GET /api/v1/compat (bridge.read) is unreachable by ANY service-account
      // role — the gap that 403'd the observer key. seedBuiltinRoles reconciles
      // this onto the existing `observer` row on the next listRoles/mintApiKey.
      PERMISSIONS.BRIDGE_READ,
    ],
  },
  agent: {
    name: "Agent",
    description:
      "Service account for an OpenClaw agent itself: the observer's read access PLUS querying OpenClaw and REPORTING anomalies (write — e.g. heartbeat / self-repair). Use it for an automated agent, not a human watching dashboards.",
    permissions: [
      PERMISSIONS.TRACES_READ,
      PERMISSIONS.KPI_READ,
      PERMISSIONS.OPENCLAW_QUERY,
      PERMISSIONS.ANOMALIES_READ,
      PERMISSIONS.ANOMALIES_REPORT,
      // Agent is a SUPERSET of observer's read access — it must also see the
      // bridge compat/version snapshot (the agent supervises its own runtime;
      // and an operator using an agent key to diagnose needs /api/v1/compat).
      // seedBuiltinRoles reconciles this onto an existing `agent` row on the
      // next listRoles / mintApiKey (same migration path as observer.bridge.read).
      PERMISSIONS.BRIDGE_READ,
      // The "self-repair" this role's description promises: a BOUNDED corrective
      // (reconcile a chat's stuck stream via POST /api/v1/reconcile-chat). Without
      // it the self-correction loop's diagnose_chat could only RECOMMEND a fix the
      // agent key was 403'd from applying. Reconciled onto existing rows by seed.
      PERMISSIONS.SELF_HEAL,
      // The support loop: read/reply/resolve user reports (meta/critic agent).
      PERMISSIONS.FEEDBACK_RESPOND,
    ],
  },
};

/**
 * Resolve the permission set for a role key. Reads the `roles` table first
 * (runtime source of truth: custom roles + admin edits), falling back to
 * BUILTIN_ROLES when the table has no matching row (e.g. before the seed runs).
 * A "*" entry expands to every known permission so callers can treat the result
 * as a plain membership set.
 *
 * Returns an EMPTY set for an unknown role key (least privilege).
 */
export async function permissionsForRoleKey(
  ctx: QueryCtx | MutationCtx,
  roleKey: string,
): Promise<Set<string>> {
  const row = await ctx.db
    .query("roles")
    .withIndex("by_key", (q) => q.eq("key", roleKey))
    .unique();

  const perms: string[] | typeof WILDCARD = row
    ? row.permissions
    : (BUILTIN_ROLES[roleKey]?.permissions ?? []);

  return expandPermissions(perms);
}

/** Expand a stored permission list (possibly the wildcard) into a flat Set. */
export function expandPermissions(
  permissions: string[] | typeof WILDCARD,
): Set<string> {
  if (permissions === WILDCARD || hasWildcard(permissions)) {
    return new Set<string>(Object.values(PERMISSIONS));
  }
  return new Set<string>(permissions);
}

function hasWildcard(permissions: string[]): boolean {
  return permissions.includes(WILDCARD);
}

/**
 * Membership check against a resolved permission set. A set produced by
 * permissionsForRoleKey/expandPermissions has already expanded "*", so this is
 * a plain `.has()`; we also honor a raw "*" defensively for sets built ad hoc.
 */
export function roleHasPermission(perms: Set<string>, p: Permission): boolean {
  return perms.has(WILDCARD) || perms.has(p);
}

/**
 * Idempotent upsert of the built-in roles into `roles`. Safe to call lazily on
 * hot paths (listRoles / mintApiKey) so built-ins always exist. Concurrency:
 * roles are admin-gated and low-write, so query-by-key then insert-or-patch is
 * sufficient (the contract's "OCC-safe" bar — there is no unique constraint to
 * lock against, and a rare double-insert would simply be reconciled on the next
 * call). We only patch when the stored built-in drifts from the definition, so
 * repeated calls do not churn writes.
 */
export async function seedBuiltinRoles(ctx: MutationCtx): Promise<void> {
  for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
    const permissions =
      def.permissions === WILDCARD ? [WILDCARD] : [...def.permissions];
    const existing = await ctx.db
      .query("roles")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();

    if (existing === null) {
      await ctx.db.insert("roles", {
        key,
        name: def.name,
        description: def.description,
        builtin: true,
        permissions,
      });
      continue;
    }

    // Reconcile drift only (avoid needless writes on the common no-op path).
    const drifted =
      existing.name !== def.name ||
      existing.description !== def.description ||
      existing.builtin !== true ||
      !sameStringSet(existing.permissions, permissions);
    if (drifted) {
      await ctx.db.patch(existing._id, {
        name: def.name,
        description: def.description,
        builtin: true,
        permissions,
      });
    }
  }
}

/** Order-insensitive equality of two permission-key lists. */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}
