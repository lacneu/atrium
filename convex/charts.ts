// Charts (charte graphique) — selection + availability + admin management (P3).
//
// Scope is STRICT P3 per docs/GROUPS_CHARTS_P3_SPEC.md: select/apply a BUILTIN
// chart (registry in convex/lib/charts.ts — code constants, zero untrusted
// input) + availability (common vs restricted-to-groups via the groupCharts
// join). NO editor / import / custom `charts` table / token validator / CSP —
// those are P4.
//
// Authorization split (mirrors groups.ts):
//   - admin queries + management mutations gate requirePermission(CHARTS_MANAGE)
//     against the REAL identity (admin-only; impersonation never grants it),
//     then audit via auditImpersonated.
//   - listMyCharts / setMyChart are owner-scoped on the EFFECTIVE user
//     (requireUserId), like setThemeMode and listMyGroups — chart SELECTION is an
//     identity-level pref, not a privileged action.
//
// Availability convention (NO scope column on builtins): a builtin is COMMON
// (offered to ALL) UNLESS it has >=1 groupCharts row, in which case it is
// RESTRICTED to members of those groups.

import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  getActor,
  getProfile,
  requireActive,
  requirePermission,
  requireUserId,
  roleOf,
} from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { auditImpersonated } from "./lib/audit";
import {
  BUILTIN_CHARTS,
  BUILTIN_CHART_KEYS,
  builtinChart,
  type ChartSource,
  type ChartTokens,
} from "./lib/charts";
import {
  validateChartImport,
  validateChartTokens,
} from "./lib/chartValidation";

const APP_META_KEY = "singleton";

/** A short random slug suffix used to mint a collision-resistant chart key. */
function randomSuffix(): string {
  // Math.random base36 is sufficient: importChart loops on a collision (rare),
  // and the by_key index is the authoritative uniqueness guard.
  return Math.random().toString(36).slice(2, 10);
}

/** Slugify a display name into the key STEM (ascii-lowercase, dash-separated). */
function slugStem(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return stem.length > 0 ? stem : "chart";
}

/**
 * True if the REAL signed-in caller is an admin. NON-THROWING (unlike
 * requirePermission/requireAdmin): the owner+member paths need to FALL THROUGH to
 * their own check when the caller is not an admin, so we cannot gate on a throw.
 * Keys off the REAL identity (impersonation never grants admin).
 */
async function realIsAdmin(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const actor = await getActor(ctx);
  const realProfile = await getProfile(ctx, actor.realUserId);
  return roleOf(realProfile) === "admin";
}

/** Load a custom chart by id (or null). Pure DB read -- callers do the RBAC. */
async function getCustomChart(
  ctx: QueryCtx | MutationCtx,
  chartId: Id<"charts">,
): Promise<Doc<"charts"> | null> {
  return await ctx.db.get(chartId);
}

/** Load a custom chart by its (unique) key, or null. */
async function getCustomChartByKey(
  ctx: QueryCtx | MutationCtx,
  key: string,
): Promise<Doc<"charts"> | null> {
  return await ctx.db
    .query("charts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

// ===========================================================================
// Shared helpers
// ===========================================================================

/** The set of group ids the given user is a member of (via by_user). */
async function userGroupIds(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Set<string>> {
  const memberships = await ctx.db
    .query("groupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return new Set(memberships.map((m) => m.groupId));
}

/** Provenance of an OFFERED chart entry. */
export type ChartVia = "common" | "owner" | { group: string };

/**
 * One chart OFFERED to a user, with its TOKENS resolved server-side (builtin from
 * the code registry, custom from the doc) so the frontend renders swatches +
 * applies a selection WITHOUT a client-side key->tokens map or builtin/custom
 * branching. `chartId` is present ONLY for a custom chart (the owner-management
 * actions update/delete/assign key on it). `via:"owner"` marks a personal custom
 * the caller owns (the only entries the owner-management list shows).
 */
type OfferedChart = {
  key: string;
  name: string;
  via: ChartVia;
  // "builtin" => from the code registry (no chartId); "custom" => a `charts` row.
  kind: "builtin" | "custom";
  // Present ONLY for custom rows (owner manage actions key on it).
  chartId?: Id<"charts">;
  tokens: ChartTokens;
};

/**
 * Resolve the FIRST membership-matching group for a chart's groupCharts rows, as
 * a provenance token. Returns null when none of the rows' groups is in the user's
 * memberships (the chart is not reachable VIA a group for this user).
 */
async function firstMatchingGroupVia(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
  myGroupIds: ReadonlySet<string>,
): Promise<{ group: string } | null> {
  const rows = await ctx.db
    .query("groupCharts")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .collect();
  for (const row of rows) {
    if (myGroupIds.has(row.groupId)) {
      const group = await ctx.db.get(row.groupId);
      return { group: group?.key ?? row.groupId };
    }
  }
  return null;
}

/**
 * The charts AVAILABLE to a user, with provenance. The SINGLE source of the
 * availability rule (shared by listMyCharts AND getMe's resolution, so they can
 * never disagree). It branches PER SOURCE so a promoted custom is never wrongly
 * re-restricted by leftover groupCharts rows:
 *   - BUILTIN: zero groupCharts rows -> COMMON (via "common"); >=1 row ->
 *     RESTRICTED, offered iff a row's group is in the user's memberships.
 *   - CUSTOM scope "common": ALWAYS offered (via "common"), regardless of any
 *     stale groupCharts rows it may carry from before promotion.
 *   - CUSTOM scope "personal": offered to its OWNER (via "owner"); to NON-owners
 *     only when a groupCharts row's group is in their memberships (via {group}).
 * Returns the offered subset only (a chart the user can't reach is omitted).
 */
export async function availableChartsForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<OfferedChart[]> {
  const myGroupIds = await userGroupIds(ctx, userId);
  const out: OfferedChart[] = [];

  // Builtins: availability defined by groupCharts rows (no scope column). Tokens
  // come from the code registry; never a chartId (not a DB row).
  for (const chart of BUILTIN_CHARTS) {
    const rows = await ctx.db
      .query("groupCharts")
      .withIndex("by_chart", (q) => q.eq("chartKey", chart.key))
      .collect();
    if (rows.length === 0) {
      out.push({
        key: chart.key,
        name: chart.name,
        via: "common",
        kind: "builtin",
        tokens: chart.tokens,
      });
      continue;
    }
    const via = await firstMatchingGroupVia(ctx, chart.key, myGroupIds);
    if (via !== null) {
      out.push({
        key: chart.key,
        name: chart.name,
        via,
        kind: "builtin",
        tokens: chart.tokens,
      });
    }
  }

  // Customs: availability defined by `scope` (+ groupCharts for personal). Tokens
  // are the SERVER-RE-SERIALIZED tokens stored on the doc; chartId is the doc id.
  //
  // INDEXED reads only -- NEVER a full `charts` scan: this resolver runs on the
  // getMe hot path, so a global read would make every user read+subscribe to all
  // other users' personal charts (any import would invalidate everyone's session
  // and could hit Convex read limits). We read exactly the three reachable sets:
  //   (a) common customs (by_scope), offered to all;
  //   (b) the caller's OWN personal customs (by_owner), via "owner";
  //   (c) personal customs shared to a group the caller belongs to (by_group on
  //       the caller's memberships), via {group}.
  // `seen` enforces the precedence common/owner > group and de-dups a chart shared
  // to several of the caller's groups.
  const seen = new Set<string>();

  // (a) Common customs -- offered to all (stale groupCharts rows are inert).
  const commonCustoms = await ctx.db
    .query("charts")
    .withIndex("by_scope", (q) => q.eq("scope", "common"))
    .collect();
  for (const chart of commonCustoms) {
    out.push({
      key: chart.key,
      name: chart.name,
      via: "common",
      kind: "custom",
      chartId: chart._id,
      tokens: chart.tokens as ChartTokens,
    });
    seen.add(chart.key);
  }

  // (b) The caller's OWN personal customs (common rows have no owner, so by_owner
  // returns personals only -- the `scope` guard is belt-and-suspenders).
  const ownedCustoms = await ctx.db
    .query("charts")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
    .collect();
  for (const chart of ownedCustoms) {
    if (chart.scope !== "personal" || seen.has(chart.key)) continue;
    out.push({
      key: chart.key,
      name: chart.name,
      via: "owner",
      kind: "custom",
      chartId: chart._id,
      tokens: chart.tokens as ChartTokens,
    });
    seen.add(chart.key);
  }

  // (c) Personal customs shared to a group the caller is a member of. Walk the
  // caller's memberships (by_group), resolve each referenced key, and offer the
  // NON-owned personal customs. Builtins are handled by the loop above; commons
  // and owned customs are already in `seen`. `firstMatchingGroupVia` re-derives
  // the canonical (deterministic) group provenance, identical to prior behavior.
  for (const groupId of myGroupIds) {
    const rows = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId as Id<"groups">))
      .collect();
    for (const row of rows) {
      if (seen.has(row.chartKey) || BUILTIN_CHART_KEYS.has(row.chartKey)) {
        continue;
      }
      const chart = await getCustomChartByKey(ctx, row.chartKey);
      if (chart === null || chart.scope !== "personal") continue;
      const via = await firstMatchingGroupVia(ctx, chart.key, myGroupIds);
      if (via === null) continue; // defensive: membership guaranteed by the walk
      out.push({
        key: chart.key,
        name: chart.name,
        via,
        kind: "custom",
        chartId: chart._id,
        tokens: chart.tokens as ChartTokens,
      });
      seen.add(chart.key);
    }
  }

  return out;
}

/**
 * Is a SINGLE chart key available to the user? The BOUNDED reachability check for
 * the resolution hot path (getMe) + the selection gate (setMyChart): it reads
 * ONLY the one chart (+ its group rows + the user's memberships), NEVER the whole
 * `charts` table. This is what lets getMe avoid subscribing to every common
 * custom (editing an unrelated chart no longer invalidates every session). The
 * truth table MIRRORS availableChartsForUser exactly:
 *   - BUILTIN: zero groupCharts rows -> common (true); else reachable iff a row's
 *     group is in the user's memberships.
 *   - CUSTOM common -> true. CUSTOM personal owned by the user -> true.
 *   - CUSTOM personal NOT owned -> reachable iff a groupCharts row's group is in
 *     the user's memberships. Unknown key -> false.
 */
export async function isChartAvailableToUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  chartKey: string,
): Promise<boolean> {
  if (BUILTIN_CHART_KEYS.has(chartKey)) {
    const rows = await ctx.db
      .query("groupCharts")
      .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
      .collect();
    if (rows.length === 0) return true; // common builtin
    const myGroupIds = await userGroupIds(ctx, userId);
    return rows.some((r) => myGroupIds.has(r.groupId));
  }
  const chart = await getCustomChartByKey(ctx, chartKey);
  if (chart === null) return false; // unknown key
  if (chart.scope === "common") return true;
  if (chart.ownerUserId === userId) return true; // personal, owned
  // personal, NOT owned: reachable only via a shared group the user belongs to.
  const rows = await ctx.db
    .query("groupCharts")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .collect();
  if (rows.length === 0) return false;
  const myGroupIds = await userGroupIds(ctx, userId);
  return rows.some((r) => myGroupIds.has(r.groupId));
}

/**
 * Resolve a chart KEY to its TOKENS, SERVER-SIDE, from the single authoritative
 * place per source: a builtin from the code registry, a custom from the `charts`
 * table. Returns null for a null/unknown key (native index.css look -- and a key
 * that fell out of availability or was deleted resolves to null upstream, so the
 * user falls back to the default). Builtin-first is unambiguous because custom
 * keys are minted DISJOINT from BUILTIN_CHART_KEYS (importChart enforces it).
 */
export async function resolveChartTokens(
  ctx: QueryCtx | MutationCtx,
  chartKey: string | null,
): Promise<ChartTokens | null> {
  if (chartKey === null) return null;
  const builtin = builtinChart(chartKey);
  if (builtin !== undefined) return builtin.tokens;
  const custom = await getCustomChartByKey(ctx, chartKey);
  return (custom?.tokens as ChartTokens | undefined) ?? null;
}

async function readAppMeta(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
}

// ===========================================================================
// USER queries / mutations (owner-scoped on the EFFECTIVE user)
// ===========================================================================

/**
 * The charts OFFERED to the calling (effective) user — every common builtin plus
 * every restricted builtin whose groupCharts intersects the user's memberships.
 * Each entry carries `via` provenance ("common" | { group: <key> }) for the P5
 * introspection screen. Owner-scoped (requireUserId), NOT admin-gated.
 */
export const listMyCharts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const offered = await availableChartsForUser(ctx, userId);
    // For the owner-management list (entries the caller OWNS), attach the chart's
    // current group associations so the owner can see + manage them. Only an
    // owned personal custom needs this (the only entries that show manage actions);
    // builtins + non-owned customs get null (no per-row management for the user).
    const out = [];
    for (const c of offered) {
      const restrictedToGroups =
        c.via === "owner"
          ? await restrictionGroupsForKey(ctx, c.key)
          : null;
      out.push({ ...c, restrictedToGroups });
    }
    return out;
  },
});

/**
 * Set the calling (effective) user's chart selection. `name === null` clears the
 * pref (revert to the app default). A non-null key MUST be in the user's
 * AVAILABLE set — a user can never select a chart not offered to them (REJECT).
 * Mirrors setThemeMode: effective identity (acts on the target while
 * impersonating) + audited.
 */
export const setMyChart = mutation({
  args: { name: v.union(v.string(), v.null()) },
  handler: async (ctx, { name }) => {
    const actor = await getActor(ctx);
    const userId = actor.effectiveUserId;
    if (name !== null) {
      // Bounded single-key reachability (no full-table enumeration).
      if (!(await isChartAvailableToUser(ctx, userId, name))) {
        throw new Error(`Forbidden: chart not available: ${name}`);
      }
    }
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (profile === null) {
      // No profile yet (pre-bootstrap, real user only — a target always has one).
      // Mirror setThemeMode: create a minimal pending profile carrying the pick.
      await ctx.db.insert("profiles", {
        userId,
        role: "pending",
        themeName: name ?? undefined,
      });
      return;
    }
    await ctx.db.patch(profile._id, { themeName: name ?? undefined });
    await auditImpersonated(ctx, actor, "chart.set", {
      resource: "profile",
      resourceId: userId,
    });
  },
});

// ===========================================================================
// ADMIN queries / mutations (requirePermission CHARTS_MANAGE on REAL identity)
// ===========================================================================

/**
 * Resolve the groupCharts rows for a chart key into a non-null restriction list
 * (or null = no group rows). Tolerates a transient dangling row. Shared by the
 * builtin + custom branches of listChartsAdmin.
 */
async function restrictionGroupsForKey(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<Array<{ groupId: Id<"groups">; key: string; name: string }> | null> {
  const rows = await ctx.db
    .query("groupCharts")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .collect();
  if (rows.length === 0) return null;
  const out: Array<{ groupId: Id<"groups">; key: string; name: string }> = [];
  for (const row of rows) {
    const group = await ctx.db.get(row.groupId);
    if (group === null) continue; // tolerate a transient dangling row
    out.push({ groupId: group._id, key: group.key, name: group.name });
  }
  return out;
}

/** One row in the admin charts matrix (builtins + customs, single FLAT list). */
type AdminChartRow = {
  // "builtin" => from the code registry (no id); "custom" => a `charts` row.
  kind: "builtin" | "custom";
  // Present ONLY for custom rows (the admin manage actions key on it).
  chartId?: Id<"charts">;
  key: string;
  name: string;
  // "common" for every builtin (availability is via groupCharts, no scope
  // column); the row's own scope for customs.
  scope: "common" | "personal";
  // Non-PHI owner display for a PERSONAL custom; null for builtins/common.
  ownerLabel: string | null;
  restrictedToGroups: Array<{
    groupId: Id<"groups">;
    key: string;
    name: string;
  }> | null;
  isGlobalDefault: boolean;
};

/**
 * Admin: every chart -- builtins AND customs -- as a SINGLE FLAT list. Each row
 * carries `kind` ("builtin" | "custom"), `restrictedToGroups` (null = no group
 * rows), `isGlobalDefault`, and for customs `chartId` + `scope` + `ownerLabel`
 * (the admin manage actions: promote / delete / set-default). Admin sees ALL
 * (P4 spec: admin -> all). The flat shape preserves the P3 consumer contract
 * (`.find(r => r.key === ...)`); customs are simply appended.
 */
export const listChartsAdmin = query({
  args: {},
  handler: async (ctx): Promise<AdminChartRow[]> => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const meta = await readAppMeta(ctx);
    const globalDefault = meta?.defaultThemeName ?? null;

    const out: AdminChartRow[] = [];
    for (const chart of BUILTIN_CHARTS) {
      out.push({
        kind: "builtin",
        key: chart.key,
        name: chart.name,
        scope: "common",
        ownerLabel: null,
        restrictedToGroups: await restrictionGroupsForKey(ctx, chart.key),
        isGlobalDefault: globalDefault === chart.key,
      });
    }

    const customRows = await ctx.db.query("charts").collect();
    for (const chart of customRows) {
      let ownerLabel: string | null = null;
      if (chart.ownerUserId) {
        const ownerProfile = await getProfile(ctx, chart.ownerUserId);
        ownerLabel =
          ownerProfile?.email ??
          ownerProfile?.name ??
          ownerProfile?.canonical ??
          null;
      }
      out.push({
        kind: "custom",
        chartId: chart._id,
        key: chart.key,
        name: chart.name,
        scope: chart.scope,
        ownerLabel,
        restrictedToGroups: await restrictionGroupsForKey(ctx, chart.key),
        isGlobalDefault: globalDefault === chart.key,
      });
    }

    return out;
  },
});

/**
 * Admin: set the GLOBAL default chart (`appMeta.defaultThemeName`). `name ===
 * null` clears it (native look). A non-null key MUST be a builtin OR a COMMON
 * custom -- a PERSONAL custom is REJECTED (the global default is pushed to every
 * user, so it must never be one user's private chart). Unknown key => reject.
 */
export const setDefaultChart = mutation({
  args: { name: v.union(v.string(), v.null()) },
  handler: async (ctx, { name }) => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const actor = await getActor(ctx);
    if (name !== null && !BUILTIN_CHART_KEYS.has(name)) {
      // Not a builtin: the only other valid default is a COMMON custom chart.
      const custom = await getCustomChartByKey(ctx, name);
      if (custom === null) {
        throw new Error(`Unknown chart: ${name}`);
      }
      if (custom.scope !== "common") {
        throw new Error("Forbidden: a personal chart cannot be the default");
      }
    }
    const meta = await readAppMeta(ctx);
    if (meta === null) {
      // appMeta is created at first sign-in (ensureProfile); an admin calling
      // this always has a profile, so the singleton exists. Defensive insert.
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        defaultThemeName: name ?? undefined,
      });
    } else {
      await ctx.db.patch(meta._id, { defaultThemeName: name ?? undefined });
    }
    await auditImpersonated(ctx, actor, "chart.setDefault", {
      resource: "chart",
      resourceId: name ?? "none",
    });
  },
});

/**
 * Authorize an assign/remove of `chartKey` to `groupId` for the calling user.
 * The GATE (the IDOR core of P4):
 *   - ADMIN (real identity) -> any chart, any group.
 *   - NON-admin -> ONLY a PERSONAL custom chart they OWN, AND only to a group
 *     they are a MEMBER of. A builtin (no owner) or a common custom is therefore
 *     admin-only automatically (the owner path can never match them). A
 *     non-existent chart key, a chart owned by someone else, a group the user is
 *     not in -> REJECT.
 * Returns the validated group doc (existence guaranteed) so the caller can audit.
 */
async function authorizeGroupChartChange(
  ctx: MutationCtx,
  effectiveUserId: Id<"users">,
  groupId: Id<"groups">,
  chartKey: string,
): Promise<Doc<"groups">> {
  const group = await ctx.db.get(groupId);
  if (group === null) throw new Error("Not found: group");

  if (await realIsAdmin(ctx)) {
    // Admin still must reference a REAL chart (builtin or existing custom).
    if (
      !BUILTIN_CHART_KEYS.has(chartKey) &&
      (await getCustomChartByKey(ctx, chartKey)) === null
    ) {
      throw new Error(`Unknown chart: ${chartKey}`);
    }
    return group;
  }

  // NON-admin. The owner path applies ONLY to a PERSONAL custom the caller owns.
  // A BUILTIN (no owner) or a COMMON custom is admin-managed availability -- for a
  // non-admin those are governed by CHARTS_MANAGE, so we route through the
  // canonical permission gate (which always throws for a non-admin, since
  // charts.manage is non-grantable). This branches on KEY KIND first, so it never
  // short-circuits the owner path for a personal custom.
  const custom = await getCustomChartByKey(ctx, chartKey);
  if (custom === null || custom.scope !== "personal") {
    // builtin, common-custom, or unknown key -> admin-only operation.
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE); // throws for non-admin
    // (Unreachable for a non-admin; an admin already returned above.)
    return group;
  }

  // Personal custom: the caller MUST be the OWNER...
  if (custom.ownerUserId !== effectiveUserId) {
    throw new Error("Forbidden: not your chart");
  }
  // ...and a MEMBER of the target group.
  const membership = await ctx.db
    .query("groupMembers")
    .withIndex("by_user_group", (q) =>
      q.eq("userId", effectiveUserId).eq("groupId", groupId),
    )
    .unique();
  if (membership === null) {
    throw new Error("Forbidden: not a member of this group");
  }
  // ...and ACTIVE: a deactivated (pending) owner can no longer (un)share their
  // chart, mirroring authorizeChartWrite. The admin path returned above.
  await requireActive(ctx);
  return group;
}

/**
 * Assign a chart to a group (insert a groupCharts row). Assigning >=1 group flips
 * a BUILTIN from common to restricted; for a custom it adds group availability ON
 * TOP of its scope. Gate: admin (any chart/group) OR the personal chart's OWNER
 * who is a MEMBER of the target group (see authorizeGroupChartChange). Dedup via
 * by_group_chart. Effective identity (the owner path acts as the effective user).
 */
export const assignChartToGroup = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    const actor = await getActor(ctx);
    await authorizeGroupChartChange(
      ctx,
      actor.effectiveUserId,
      groupId,
      chartKey,
    );
    const existing = await ctx.db
      .query("groupCharts")
      .withIndex("by_group_chart", (q) =>
        q.eq("groupId", groupId).eq("chartKey", chartKey),
      )
      .unique();
    if (existing !== null) return; // idempotent
    await ctx.db.insert("groupCharts", {
      groupId,
      chartKey,
      createdAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "chart.assignGroup", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

/**
 * Remove a chart's availability to a group (delete the groupCharts row). For a
 * builtin, removing the last row reverts it to common. Same gate as assign
 * (admin OR owner+member). Idempotent.
 */
export const removeChartFromGroup = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    const actor = await getActor(ctx);
    await authorizeGroupChartChange(
      ctx,
      actor.effectiveUserId,
      groupId,
      chartKey,
    );
    const existing = await ctx.db
      .query("groupCharts")
      .withIndex("by_group_chart", (q) =>
        q.eq("groupId", groupId).eq("chartKey", chartKey),
      )
      .unique();
    if (existing === null) return; // idempotent
    await ctx.db.delete(existing._id);
    await auditImpersonated(ctx, actor, "chart.removeGroup", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

// ===========================================================================
// CUSTOM chart import / edit / delete / promote (P4). RBAC is the IDOR contract:
// a user can NEVER reach another user's PERSONAL chart by id.
// ===========================================================================

/**
 * Load a custom chart by id and AUTHORIZE a write (update/delete) on it for the
 * calling user, per scope:
 *   - PERSONAL -> the effective user OWNS it AND is ACTIVE, OR the real caller is
 *     admin.
 *   - COMMON   -> admin ONLY.
 * The owner branch RE-GATES active: a user who imported a chart while active and
 * was later set back to `pending` must not keep mutating (or deleting a chart
 * they may have shared to groups). The admin path is unaffected (a real admin is
 * always active). Throws "Not found" for a missing id (no existence oracle past
 * auth). Returns the chart doc.
 */
async function authorizeChartWrite(
  ctx: MutationCtx,
  chartId: Id<"charts">,
  effectiveUserId: Id<"users">,
): Promise<Doc<"charts">> {
  const chart = await getCustomChart(ctx, chartId);
  if (chart === null) throw new Error("Not found: chart");
  // Real admin: full access to personal + common (and always active).
  if (await realIsAdmin(ctx)) return chart;
  // Non-admin from here.
  if (chart.scope === "common") {
    throw new Error("Forbidden: admin role required");
  }
  // personal
  if (chart.ownerUserId !== effectiveUserId) {
    throw new Error("Forbidden: not your chart");
  }
  // A deactivated (pending) owner can no longer mutate the chart.
  await requireActive(ctx);
  return chart;
}

/** Purge all groupCharts rows that reference a chart key (delete cascade). */
async function purgeGroupChartsByKey(
  ctx: MutationCtx,
  chartKey: string,
): Promise<void> {
  const rows = await ctx.db
    .query("groupCharts")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

/**
 * Import a CUSTOM chart (the user's "Importer une charte"). Validates the raw
 * `{ name, tokens }` through the PURE typed-token allowlist (validateChartImport
 * -- re-serializes every color, rejects breakout/unknown-key/non-allowlisted-font)
 * and stores ONLY the rebuilt tokens (never the raw input). scope="personal";
 * ownerUserId = the EFFECTIVE user (mirrors setMyChart, audited). Requires an
 * ACTIVE identity (chats.read). Mints a key DISJOINT from BUILTIN_CHART_KEYS and
 * every existing custom key. Returns the new key.
 */
export const importChart = mutation({
  args: { name: v.string(), tokens: v.any() },
  handler: async (ctx, { name, tokens }) => {
    // chats.read = "is an active user"; also resolves the effective identity.
    const { userId, actor } = await requireActive(ctx);

    const result = validateChartImport({ name, tokens });
    if (!result.ok) {
      throw new Error(`Invalid chart: ${result.error}`);
    }

    // Mint a unique key, DISJOINT from builtins AND existing customs.
    const stem = slugStem(result.name);
    let key = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = `${stem}-${randomSuffix()}`;
      if (BUILTIN_CHART_KEYS.has(candidate)) continue;
      if ((await getCustomChartByKey(ctx, candidate)) !== null) continue;
      key = candidate;
      break;
    }
    if (key === "") {
      throw new Error("Could not allocate a unique chart key");
    }

    await ctx.db.insert("charts", {
      key,
      name: result.name,
      scope: "personal",
      ownerUserId: userId,
      tokens: result.tokens,
      createdBy: userId,
      createdAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "chart.import", {
      resource: "chart",
      resourceId: key,
    });
    return { key };
  },
});

/**
 * Update a custom chart's name and/or tokens. RBAC (authorizeChartWrite):
 * personal -> owner OR admin; common -> admin only. New `name`/`tokens` are
 * RE-VALIDATED through the allowlist before they are stored. Tokens, when
 * supplied, are re-serialized (never the raw input). A getMe re-push lets the
 * owner's live UI re-apply the edited chart.
 */
export const updateChart = mutation({
  args: {
    chartId: v.id("charts"),
    name: v.optional(v.string()),
    tokens: v.optional(v.any()),
  },
  handler: async (ctx, { chartId, name, tokens }) => {
    const actor = await getActor(ctx);
    const chart = await authorizeChartWrite(ctx, chartId, actor.effectiveUserId);

    const patch: { name?: string; tokens?: ChartTokens } = {};
    if (name !== undefined) {
      // Re-use the import validator's name+tokens shape to reuse the name guard.
      const res = validateChartImport({
        name,
        tokens: { colors: { light: {}, dark: {} } },
      });
      if (!res.ok) throw new Error(`Invalid chart name: ${res.error}`);
      patch.name = res.name;
    }
    if (tokens !== undefined) {
      const res = validateChartTokens(tokens);
      if (!res.ok) throw new Error(`Invalid chart tokens: ${res.error}`);
      patch.tokens = res.tokens;
    }
    if (Object.keys(patch).length === 0) return; // nothing to change

    await ctx.db.patch(chart._id, patch);
    await auditImpersonated(ctx, actor, "chart.update", {
      resource: "chart",
      resourceId: chart.key,
    });
  },
});

/**
 * Delete a custom chart. RBAC (authorizeChartWrite): personal -> owner OR admin;
 * common -> admin only. CASCADES:
 *   - purge every groupCharts row referencing its key (by_chart);
 *   - if it was the admin GLOBAL default (appMeta.defaultThemeName), CLEAR it.
 *     This is NOT redundant with availability: resolveChart applies the admin
 *     default WITHOUT an availability check (a deliberate global choice), so a
 *     dangling default key would make every user's resolvedChartKey point at a
 *     dead chart. (A user's OWN themeName pointing here needs no write -- it is
 *     dropped by resolveChart since the key leaves availableChartsForUser.)
 */
export const deleteChart = mutation({
  args: { chartId: v.id("charts") },
  handler: async (ctx, { chartId }) => {
    const actor = await getActor(ctx);
    const chart = await authorizeChartWrite(ctx, chartId, actor.effectiveUserId);
    await purgeGroupChartsByKey(ctx, chart.key);
    // Clear a dangling admin global default (bypasses the availability check).
    const meta = await readAppMeta(ctx);
    if (meta !== null && meta.defaultThemeName === chart.key) {
      await ctx.db.patch(meta._id, { defaultThemeName: undefined });
    }
    await ctx.db.delete(chart._id);
    await auditImpersonated(ctx, actor, "chart.delete", {
      resource: "chart",
      resourceId: chart.key,
    });
  },
});

/**
 * Promote a PERSONAL custom chart to COMMON (available to ALL). Admin ONLY -- a
 * user can NEVER make their own chart common. Clears `ownerUserId` (the schema's
 * "absent for common" contract) and sets scope="common". Idempotent on an already-
 * common chart. Leftover groupCharts rows are harmless: availableChartsForUser
 * treats a common custom as offered-to-all regardless of group rows.
 */
export const promoteChartToCommon = mutation({
  args: { chartId: v.id("charts") },
  handler: async (ctx, { chartId }) => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const actor = await getActor(ctx);
    const chart = await getCustomChart(ctx, chartId);
    if (chart === null) throw new Error("Not found: chart");
    if (chart.scope === "common") return; // idempotent
    await ctx.db.patch(chart._id, {
      scope: "common",
      ownerUserId: undefined,
    });
    await auditImpersonated(ctx, actor, "chart.promoteCommon", {
      resource: "chart",
      resourceId: chart.key,
    });
  },
});

// Re-export the resolution source type so callers (me.ts) get it from one place.
export type { ChartSource };
