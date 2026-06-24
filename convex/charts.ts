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
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
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
import { authorizeGroupManage } from "./lib/groupAccess";
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
import { hostCandidates, normalizeDomain } from "./lib/domains";

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

/**
 * The user's GROUP default chart key (Tier-2 default), or null. Walks the user's
 * group memberships in a DETERMINISTIC order (group createdAt, then _id) and returns
 * the FIRST group's default chart (a groupCharts row with isDefault === true). A user
 * in several groups each with a default resolves to the OLDEST group's default — a
 * stable, explainable rule. Bounded reads (memberships + per-group groupCharts), used
 * on the getMe hot path: the key is a chart that group SELECTED, so it is available to
 * the member by construction (resolveChart applies it without a re-check).
 */
export async function groupDefaultChartForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string | null> {
  const memberships = await ctx.db
    .query("groupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const groups: Doc<"groups">[] = [];
  for (const m of memberships) {
    const g = await ctx.db.get(m.groupId);
    if (g !== null) groups.push(g);
  }
  groups.sort((a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : 1));
  for (const g of groups) {
    const rows = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", g._id))
      .collect();
    const def = rows.find((r) => r.isDefault === true);
    if (def !== undefined) return def.chartKey;
  }
  return null;
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

/**
 * The brand shown in the top bar. Two logo URLs (one per theme mode); the client
 * picks by the active mode. `isDefault` = the app's own identity (native / builtin
 * demo / dangling key) -> the client shows the bundled Atrium mark. For a CUSTOM
 * chart `isDefault` is false: the client shows the mode's uploaded logo IF one
 * exists (falling back to the other mode's), otherwise the LABEL ALONE -- never
 * the Atrium mark next to a custom name.
 */
export type ChartBrand = {
  label: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  // Whether each logo is an alpha silhouette (mask-able for the auto-contrast
  // avatar) vs an opaque image (plain <img> fallback). See schema `charts`.
  logoLightHasAlpha: boolean;
  logoDarkHasAlpha: boolean;
  isDefault: boolean;
};

/** The default (no chart / builtin demo palette / dangling key) brand. */
export const DEFAULT_BRAND: ChartBrand = {
  label: "Atrium",
  logoLightUrl: null,
  logoDarkUrl: null,
  logoLightHasAlpha: false,
  logoDarkHasAlpha: false,
  isDefault: true,
};

/**
 * Resolve BOTH the tokens and the brand for `chartKey` in a SINGLE custom-row
 * read (getMe is a hot path -- do not re-read with a second getCustomChartByKey).
 * - null / builtin (demo palettes are not brands) => native tokens + DEFAULT_BRAND
 * - custom => its tokens + { label: name, logoUrl: getUrl(logoStorageId) | null }
 * A null `logoUrl` (unset or dangling blob) tells the client to use the bundled
 * Atrium mark. Only the single ACTIVE chart row is read, so getMe subscribes to
 * just that chart (its logo change re-renders the top bar) -- never enumerate.
 */
export async function resolveChartView(
  ctx: QueryCtx | MutationCtx,
  chartKey: string | null,
): Promise<{ tokens: ChartTokens | null; brand: ChartBrand }> {
  if (chartKey === null) return { tokens: null, brand: DEFAULT_BRAND };
  const builtin = builtinChart(chartKey);
  if (builtin !== undefined) {
    return { tokens: builtin.tokens, brand: DEFAULT_BRAND };
  }
  const custom = await getCustomChartByKey(ctx, chartKey);
  if (custom === null) return { tokens: null, brand: DEFAULT_BRAND };
  const logoLightUrl = custom.logoLightStorageId
    ? await ctx.storage.getUrl(custom.logoLightStorageId)
    : null;
  const logoDarkUrl = custom.logoDarkStorageId
    ? await ctx.storage.getUrl(custom.logoDarkStorageId)
    : null;
  return {
    tokens: (custom.tokens as ChartTokens | undefined) ?? null,
    // Custom chart: its own label; per-mode logos ONLY if uploaded (else label
    // alone -- isDefault:false tells the client NOT to fall back to the Atrium mark).
    // hasAlpha drives the avatar's mask-vs-img choice; absent (pre-flag logo) =>
    // false => plain <img> (safe: re-upload sets the flag and enables the mask).
    brand: {
      label: custom.name,
      logoLightUrl,
      logoDarkUrl,
      logoLightHasAlpha: logoLightUrl ? (custom.logoLightHasAlpha ?? false) : false,
      logoDarkHasAlpha: logoDarkUrl ? (custom.logoDarkHasAlpha ?? false) : false,
      isDefault: false,
    },
  };
}

/**
 * Resolve the DOMAIN-default chart KEY for a request `host`, or null. Tries the
 * host's lookup keys MOST-SPECIFIC FIRST (exact, then wildcards) as bounded
 * point-reads on `by_domain` -- NEVER a scan, so this stays cheap on the getMe
 * hot path and subscribes only to the host's specific domain keys. (host is
 * client-asserted via location.hostname; safe because the group junction still
 * gates whether the resolved chart actually applies to the user.)
 */
export async function resolveDomainChartKey(
  ctx: QueryCtx | MutationCtx,
  host: string | undefined,
): Promise<string | null> {
  if (!host) return null;
  for (const candidate of hostCandidates(host)) {
    const row = await ctx.db
      .query("chartDomains")
      .withIndex("by_domain", (q) => q.eq("domain", candidate))
      .unique();
    if (row !== null) return row.chartKey;
  }
  return null;
}

/** True if a chart key has >= 1 groupCharts row (restricted to those groups). */
async function chartIsGroupRestricted(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("groupCharts")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .first();
  return row !== null;
}

/**
 * True if a chart may be shown to ANONYMOUS visitors (the pre-auth brandForHost
 * path). A chart is publicly exposable ONLY when it is a builtin OR a custom chart
 * promoted to scope "common" -- a "personal" chart is owner-private and must NEVER
 * leak its name/logo/tokens to anonymous visitors of its domain (getMe also refuses
 * it to non-owners post-auth, so exposing it pre-auth would both leak a private
 * brand and cause a login->app visual flip). Group-restricted charts are also
 * excluded (a group cannot be evaluated without a user).
 */
async function chartIsPubliclyExposable(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<boolean> {
  // Builtin: public IFF not group-restricted -- a builtin's groupCharts rows ARE
  // its restriction (zero rows = common, >=1 = members-only).
  if (builtinChart(chartKey) !== undefined) {
    return !(await chartIsGroupRestricted(ctx, chartKey));
  }
  // Custom: ONLY a "common"-scoped custom is public, and it STAYS public even when
  // it still carries STALE groupCharts rows from before it was promoted -- this
  // mirrors availableChartsForUser, which offers a common custom to ALL users
  // regardless of those rows. (Without this, a promoted-common chart would paint
  // the app for everyone via getMe but fall back to the Atrium mark pre-auth,
  // re-introducing a login->app flip.) A "personal" custom is owner/group-only and
  // can never be evaluated without a user, so it is never exposable pre-auth.
  const custom = await getCustomChartByKey(ctx, chartKey);
  return custom !== null && custom.scope === "common";
}

/**
 * PUBLIC, PRE-AUTH: the brand + tokens to paint the LOGIN at `host` (charte par
 * domaine). Returns the domain chart's view IF it is mapped AND not group-
 * restricted (a group can't be evaluated without a user, so a member-only chart
 * must NOT leak its brand to anonymous visitors). Otherwise the app default. A few
 * bounded point-reads + one by_chart probe -- no scan, no auth.
 */
export const brandForHost = query({
  args: { host: v.optional(v.string()) },
  handler: async (ctx, { host }) => {
    const key = await resolveDomainChartKey(ctx, host);
    // Only a TRULY PUBLIC chart (builtin / common) may paint an anonymous login;
    // a personal or group-restricted chart falls back to the app default so its
    // brand never leaks pre-auth (see chartIsPubliclyExposable).
    if (key === null || !(await chartIsPubliclyExposable(ctx, key))) {
      return { tokens: null, brand: DEFAULT_BRAND };
    }
    return await resolveChartView(ctx, key);
  },
});

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
    // Owner-management rows (the entries the caller OWNS) surface the chart EDITOR
    // affordances: per-mode brand-logo URLs + mapped domains. Group association is
    // NO LONGER an owner affordance — under the 3-tier model a chart reaches a group
    // ONLY via the admin pool + the group manager's selection, never owner self-share
    // (see assignChartToGroup). Rare, user-initiated call -> the extra reads are fine
    // (NOT the getMe hot path).
    const out = [];
    for (const c of offered) {
      let logoLightUrl: string | null = null;
      let logoDarkUrl: string | null = null;
      let domains: string[] = [];
      if (c.via === "owner" && c.chartId !== undefined) {
        const doc = await ctx.db.get(c.chartId);
        if (doc?.logoLightStorageId) {
          logoLightUrl = await ctx.storage.getUrl(doc.logoLightStorageId);
        }
        if (doc?.logoDarkStorageId) {
          logoDarkUrl = await ctx.storage.getUrl(doc.logoDarkStorageId);
        }
        domains = await domainsForChart(ctx, c.key);
      }
      out.push({ ...c, logoLightUrl, logoDarkUrl, domains });
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

/**
 * Resolve the groupChartPool rows for a chart key into a non-null list of the groups
 * whose admin POOL (Tier 1) contains this chart (or null = no pool rows). The admin
 * matrix EDITS this set (add/removeChartFromGroupPool); the manager then selects from
 * it. Mirrors restrictionGroupsForKey on the pool table.
 */
async function poolGroupsForKey(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<Array<{ groupId: Id<"groups">; key: string; name: string }> | null> {
  const rows = await ctx.db
    .query("groupChartPool")
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
  // Tier-1 POOL: groups whose admin pool offers this chart (the admin matrix EDITS
  // this). null = in no pool.
  poolGroups: Array<{
    groupId: Id<"groups">;
    key: string;
    name: string;
  }> | null;
  // Tier-2 SELECTION (read-only here): groups that actually SELECTED this chart.
  // null = selected by none. Informational for the admin (managed in GroupManageDialog).
  restrictedToGroups: Array<{
    groupId: Id<"groups">;
    key: string;
    name: string;
  }> | null;
  // Domains mapped to this chart (charte par domaine). The admin UI renders the
  // domain editor from this, so PUBLIC charts (builtins / common customs) are
  // configurable — not just the owner's personal charts.
  domains: string[];
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
        poolGroups: await poolGroupsForKey(ctx, chart.key),
        restrictedToGroups: await restrictionGroupsForKey(ctx, chart.key),
        domains: await domainsForChart(ctx, chart.key),
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
        poolGroups: await poolGroupsForKey(ctx, chart.key),
        restrictedToGroups: await restrictionGroupsForKey(ctx, chart.key),
        domains: await domainsForChart(ctx, chart.key),
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
 * Reconcile a group's default chart to the invariant ">=1 selection => EXACTLY one
 * default" (mirrors the userAgents exactly-one-default rule; the user asked for "une
 * charte par défaut"). No selection -> no-op. Otherwise: KEEP the manager's current
 * explicit default if one is set (and clear any duplicate flags); else ELECT the
 * DETERMINISTIC first (lowest createdAt, then _id). Self-healing + idempotent —
 * called after every select/unselect so the group always has exactly one default
 * while it offers >=1 chart, and none when it offers zero.
 */
async function electGroupDefaultChart(
  ctx: MutationCtx,
  groupId: Id<"groups">,
): Promise<void> {
  const rows = await ctx.db
    .query("groupCharts")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .collect();
  if (rows.length === 0) return;
  rows.sort((a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : 1));
  const current = rows.find((r) => r.isDefault === true);
  const chosen = current ?? rows[0]!;
  for (const r of rows) {
    const shouldBe = r._id === chosen._id;
    if ((r.isDefault === true) !== shouldBe) {
      await ctx.db.patch(r._id, { isDefault: shouldBe ? true : undefined });
    }
  }
}

/**
 * TIER 2 — SELECT a chart for a group (insert a groupCharts row). This is the GROUP
 * MANAGER's selection from the admin POOL: the chart MUST already be in the group's
 * groupChartPool (Tier 1) — that constraint is what makes the pool meaningful, and
 * it also rejects an unknown key (it cannot be pooled). Gate: admin OR the group's
 * MANAGER (authorizeGroupManage) — the former personal-chart OWNER self-share path
 * was REMOVED (pure 3-tier). Selecting >=1 chart flips a BUILTIN from common to
 * restricted-to-this-group (availableChartsForUser reads groupCharts, unchanged).
 * Dedup via by_group_chart; keeps the exactly-one-default invariant.
 */
export const assignChartToGroup = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    const actor = await authorizeGroupManage(ctx, groupId);
    if (!(await isChartInGroupPool(ctx, groupId, chartKey))) {
      throw new Error(`Forbidden: chart not in this group's pool: ${chartKey}`);
    }
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
    // First selection becomes the group default; later ones keep the existing one.
    await electGroupDefaultChart(ctx, groupId);
    await auditImpersonated(ctx, actor, "chart.selectForGroup", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

/**
 * TIER 2 — UNSELECT a chart from a group (delete the groupCharts row). For a builtin,
 * removing the last selection reverts it to common. Gate: admin OR the group's
 * MANAGER. If the removed chart was the group default, a new default is re-elected
 * among the remaining selections (cleared to none at zero). Idempotent.
 */
export const removeChartFromGroup = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    const actor = await authorizeGroupManage(ctx, groupId);
    const existing = await ctx.db
      .query("groupCharts")
      .withIndex("by_group_chart", (q) =>
        q.eq("groupId", groupId).eq("chartKey", chartKey),
      )
      .unique();
    if (existing === null) return; // idempotent
    await ctx.db.delete(existing._id);
    await electGroupDefaultChart(ctx, groupId);
    await auditImpersonated(ctx, actor, "chart.unselectForGroup", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

/**
 * TIER 2 — set a group's DEFAULT chart. The key MUST be a chart the group currently
 * SELECTS (a groupCharts row) — you cannot default a chart the group does not offer.
 * Sets isDefault on that row and CLEARS it on every other selection (exactly-one).
 * Gate: admin OR the group's MANAGER.
 */
export const setGroupDefaultChart = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    const actor = await authorizeGroupManage(ctx, groupId);
    const rows = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const target = rows.find((r) => r.chartKey === chartKey);
    if (target === undefined) {
      throw new Error(`Forbidden: chart not selected by this group: ${chartKey}`);
    }
    for (const r of rows) {
      const shouldBe = r._id === target._id;
      if ((r.isDefault === true) !== shouldBe) {
        await ctx.db.patch(r._id, { isDefault: shouldBe ? true : undefined });
      }
    }
    await auditImpersonated(ctx, actor, "chart.setGroupDefault", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

// ===========================================================================
// TIER 1 — admin chart POOL per group (groupChartPool). The admin defines WHICH
// charts a group MAY offer; a group manager then SELECTS a subset into
// groupCharts (Tier 2). Pool writes are admin-only (CHARTS_MANAGE = non-grantable
// -> admins only), so a manager can never widen their own pool. INERT in step 1:
// nothing reads the pool for availability yet (the manager-selection gate that
// consults it lands in step 2); these mutations only populate Tier 1.
// ===========================================================================

/** True if `chartKey` references a REAL chart (builtin OR an existing custom). */
async function chartKeyExists(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<boolean> {
  if (BUILTIN_CHART_KEYS.has(chartKey)) return true;
  return (await getCustomChartByKey(ctx, chartKey)) !== null;
}

/** The set of chart keys in a group's admin POOL (bounded by_group read). */
export async function chartPoolKeysForGroup(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query("groupChartPool")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .collect();
  return new Set(rows.map((r) => r.chartKey));
}

/** Is `chartKey` in a group's admin POOL? Bounded by_group_chart point-read. */
export async function isChartInGroupPool(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
  chartKey: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("groupChartPool")
    .withIndex("by_group_chart", (q) =>
      q.eq("groupId", groupId).eq("chartKey", chartKey),
    )
    .unique();
  return row !== null;
}

/**
 * Admin: add a chart to a group's POOL (Tier 1 — the charts the group MAY offer).
 * Admin ONLY (CHARTS_MANAGE; a manager can never widen the pool). Verifies the
 * group + the chart (builtin OR custom) exist. Dedup via by_group_chart. The
 * manager-selection step (Tier 2) is a SEPARATE mutation that requires the key to
 * already be in this pool.
 */
export const addChartToGroupPool = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const actor = await getActor(ctx);
    if ((await ctx.db.get(groupId)) === null) throw new Error("Not found: group");
    if (!(await chartKeyExists(ctx, chartKey))) {
      throw new Error(`Unknown chart: ${chartKey}`);
    }
    const existing = await ctx.db
      .query("groupChartPool")
      .withIndex("by_group_chart", (q) =>
        q.eq("groupId", groupId).eq("chartKey", chartKey),
      )
      .unique();
    if (existing !== null) return; // idempotent
    await ctx.db.insert("groupChartPool", {
      groupId,
      chartKey,
      createdAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "chart.addToPool", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

/**
 * Admin: remove a chart from a group's POOL. Admin ONLY. CASCADE (keeps the
 * invariant "selection ⊆ pool"): if the group had SELECTED this chart into
 * groupCharts (Tier 2), that selection row is removed too — taking its `isDefault`
 * with it (the manager re-elects a default in step 2; in step 1 `isDefault` is
 * inert/unread). Idempotent.
 */
export const removeChartFromGroupPool = mutation({
  args: { groupId: v.id("groups"), chartKey: v.string() },
  handler: async (ctx, { groupId, chartKey }) => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const actor = await getActor(ctx);
    const poolRow = await ctx.db
      .query("groupChartPool")
      .withIndex("by_group_chart", (q) =>
        q.eq("groupId", groupId).eq("chartKey", chartKey),
      )
      .unique();
    if (poolRow === null) return; // idempotent
    await ctx.db.delete(poolRow._id);
    // CASCADE: drop the group's selection of this chart (Tier 2), if any. Its
    // isDefault is carried on the row, so deleting it clears the default cleanly.
    const selection = await ctx.db
      .query("groupCharts")
      .withIndex("by_group_chart", (q) =>
        q.eq("groupId", groupId).eq("chartKey", chartKey),
      )
      .unique();
    if (selection !== null) {
      await ctx.db.delete(selection._id);
      // The cascaded row may have been the group default -> re-elect among survivors
      // (keeps the exactly-one-default invariant; clears to none at zero).
      await electGroupDefaultChart(ctx, groupId);
    }
    await auditImpersonated(ctx, actor, "chart.removeFromPool", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

/** Display name for a chart key (builtin from the registry, custom from the doc). */
export async function chartDisplayName(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<string> {
  const builtin = builtinChart(chartKey);
  if (builtin !== undefined) return builtin.name;
  const custom = await getCustomChartByKey(ctx, chartKey);
  return custom?.name ?? chartKey;
}

/**
 * The per-group chart view for the GroupManageDialog Charts tab: the group's admin
 * POOL (Tier 1), each entry flagged with whether the group has SELECTED it (Tier 2)
 * and whether it is the group DEFAULT. Gated authorizeGroupManage (admin OR the
 * group's manager) — the same gate as the selection mutations the tab calls. Sorted
 * by display name for a stable UI.
 */
export const listGroupChartSelection = query({
  args: { groupId: v.id("groups") },
  handler: async (
    ctx,
    { groupId },
  ): Promise<{
    pool: Array<{
      chartKey: string;
      name: string;
      selected: boolean;
      isDefault: boolean;
    }>;
    // ADMIN-only: charts NOT yet in the group's pool that the admin may ADD to it
    // (the Tier-1 pool editor in the dialog). Empty for a non-admin manager.
    addable: Array<{ chartKey: string; name: string }>;
    // True when the caller is a real admin -> the Charts tab shows the pool editor
    // (add/remove from pool); a delegated manager only selects from the existing pool.
    canManagePool: boolean;
  }> => {
    await authorizeGroupManage(ctx, groupId);
    const poolRows = await ctx.db
      .query("groupChartPool")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const selRows = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const selByKey = new Map(selRows.map((r) => [r.chartKey, r]));
    // Iterate the UNION of pool + selection keys. New invariant: selection ⊆ pool
    // (assignChartToGroup requires the pool), so the union == pool on a fresh system.
    // The union also surfaces a LEGACY selection that has no backing pool row (from
    // the pre-3-tier charts feature) so it stays visible + REMOVABLE in the tab,
    // never silently applying yet unmanageable.
    const poolKeys = new Set(poolRows.map((r) => r.chartKey));
    const keys = new Set<string>([
      ...poolRows.map((r) => r.chartKey),
      ...selRows.map((r) => r.chartKey),
    ]);
    const pool = [];
    for (const key of keys) {
      const sel = selByKey.get(key);
      pool.push({
        chartKey: key,
        name: await chartDisplayName(ctx, key),
        selected: sel !== undefined,
        isDefault: sel?.isDefault === true,
      });
    }
    pool.sort((a, b) => a.name.localeCompare(b.name));

    // ADMIN pool editor: the charts an admin may ADD to this group's pool = ALL
    // real charts (builtins + every custom, personal OR common) MINUS those already
    // pooled. A common custom is offered to everyone for AVAILABILITY, but pooling it
    // still lets the group pick it as its DEFAULT (the group-default tier), so it
    // belongs here. Computed only for an admin (a manager never widens the pool).
    let addable: Array<{ chartKey: string; name: string }> = [];
    const canManagePool = await realIsAdmin(ctx);
    if (canManagePool) {
      const candidates: Array<{ chartKey: string; name: string }> = BUILTIN_CHARTS.map(
        (b) => ({ chartKey: b.key, name: b.name }),
      );
      for (const c of await ctx.db.query("charts").collect()) {
        candidates.push({ chartKey: c.key, name: c.name });
      }
      addable = candidates
        .filter((c) => !poolKeys.has(c.chartKey))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return { pool, addable, canManagePool };
  },
});

/** Purge all groupChartPool rows that reference a chart key (delete cascade). */
async function purgeGroupChartPoolByKey(
  ctx: MutationCtx,
  chartKey: string,
): Promise<void> {
  const rows = await ctx.db
    .query("groupChartPool")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

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
  ctx: QueryCtx | MutationCtx,
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
  const affected = new Set<Id<"groups">>();
  for (const row of rows) {
    affected.add(row.groupId);
    await ctx.db.delete(row._id);
  }
  // A purged selection may have been a group's default -> re-elect each affected
  // group's default among its survivors (exactly-one-default invariant; deleteChart
  // can hit several groups at once).
  for (const groupId of affected) {
    await electGroupDefaultChart(ctx, groupId);
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
    // Cascade: this chart's presence in any group's admin POOL (Tier 1).
    await purgeGroupChartPoolByKey(ctx, chart.key);
    // Cascade: domain mappings for this chart.
    for (const row of await ctx.db
      .query("chartDomains")
      .withIndex("by_chart", (q) => q.eq("chartKey", chart.key))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    // Delete both brand-logo blobs too (cascade) so they cannot orphan in storage.
    if (chart.logoLightStorageId)
      await ctx.storage.delete(chart.logoLightStorageId);
    if (chart.logoDarkStorageId)
      await ctx.storage.delete(chart.logoDarkStorageId);
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

// Brand logos are small (client-normalized WebP); bound the upload anyway.
const MAX_LOGO_BYTES = 1024 * 1024; // 1 MiB
/** Theme mode a logo belongs to. */
const logoMode = v.union(v.literal("light"), v.literal("dark"));

/** Magic-byte sniff: accept ONLY what the client produces (WebP / PNG). */
/** The actual image MIME of a logo blob from its MAGIC BYTES — "image/png" |
 *  "image/webp" | null (anything else is rejected). The client's declared type is
 *  untrusted (and processLogoImage may emit PNG as a WebP-encode fallback), so the
 *  STORED Content-Type is derived HERE and not assumed. */
export function detectLogoMime(
  b: Uint8Array,
): "image/png" | "image/webp" | null {
  const isPng =
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
  if (isPng) return "image/png";
  const isWebp =
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // "WEBP"
  if (isWebp) return "image/webp";
  return null;
}

/**
 * Authorize a chart-logo edit. Pre-flight for the setChartLogo ACTION (which cannot
 * use ctx.db): runs with the caller's identity (runQuery propagates auth) and THROWS
 * (forbidden / chart not found) BEFORE the action stores any bytes, so an
 * unauthorized caller never mints an orphan blob.
 */
export const assertCanSetChartLogo = internalQuery({
  args: { chartId: v.id("charts") },
  handler: async (ctx, { chartId }) => {
    const actor = await getActor(ctx);
    await authorizeChartWrite(ctx, chartId, actor.effectiveUserId);
  },
});

/**
 * Persist a SERVER-STORED logo blob for one theme `mode`. INTERNAL: only reachable
 * from the setChartLogo action, which minted `storageId` itself via
 * ctx.storage.store. Because that id is server-minted and dedicated to THIS logo
 * (never client-provided, never shared with a message attachment or another chart),
 * deleting the PREVIOUS blob for this mode here is always safe — it can only ever be
 * another single-use logo blob. RBAC = authorizeChartWrite.
 */
export const persistChartLogo = internalMutation({
  args: {
    chartId: v.id("charts"),
    storageId: v.id("_storage"),
    mode: logoMode,
    hasAlpha: v.boolean(),
  },
  handler: async (ctx, { chartId, storageId, mode, hasAlpha }) => {
    const actor = await getActor(ctx);
    const chart = await authorizeChartWrite(ctx, chartId, actor.effectiveUserId);
    const prev =
      mode === "light" ? chart.logoLightStorageId : chart.logoDarkStorageId;
    if (prev && prev !== storageId) await ctx.storage.delete(prev);
    await ctx.db.patch(
      chart._id,
      mode === "light"
        ? { logoLightStorageId: storageId, logoLightHasAlpha: hasAlpha }
        : { logoDarkStorageId: storageId, logoDarkHasAlpha: hasAlpha },
    );
    await auditImpersonated(ctx, actor, "chart.setLogo", {
      resource: "chart",
      resourceId: `${chart.key}:${mode}`,
    });
  },
});

/**
 * Set a chart's brand logo for `mode` from the RAW WebP bytes the client produced
 * (processLogoImage normalizes any input to a small, bounded WebP). An ACTION so it
 * can ctx.storage.store the bytes SERVER-SIDE: the resulting storageId is minted by
 * the server and dedicated to THIS single logo — NEVER supplied by the client. That
 * is what makes the logo flow free of the IDOR / shared-blob data-loss class: there
 * is no client storageId to alias onto another chart, reuse from a message
 * attachment, or replay across users, so a later remove/replace/deleteChart can only
 * ever delete a blob this logo alone owns. The bytes are magic-byte validated (the
 * declared type is untrusted) and size-capped BEFORE storing. The logo is only ever
 * rendered via <img src>, so it can never execute script regardless.
 */
export const setChartLogo = action({
  args: {
    chartId: v.id("charts"),
    bytes: v.bytes(),
    mode: logoMode,
    // Computed client-side (processLogoImage): is the image an alpha silhouette?
    // Optional (default false) so an older client still uploads cleanly during a
    // rollout — the logo then renders as a plain <img> until re-uploaded.
    hasAlpha: v.optional(v.boolean()),
  },
  handler: async (ctx, { chartId, bytes, mode, hasAlpha }) => {
    // Authorize BEFORE storing so an unauthorized caller never mints an orphan blob.
    await ctx.runQuery(internal.charts.assertCanSetChartLogo, { chartId });
    if (bytes.byteLength > MAX_LOGO_BYTES) {
      throw new Error("Image trop volumineuse");
    }
    // Validate AND derive the real MIME from the magic bytes, so a PNG (the WebP-
    // encode fallback) is stored + served with the correct Content-Type, not webp.
    const contentType = detectLogoMime(new Uint8Array(bytes));
    if (contentType === null) {
      throw new Error("Format d'image non valide (WebP ou PNG attendu)");
    }
    // Server-minted, single-use storageId (see the function doc) — no client id.
    const storageId = await ctx.storage.store(new Blob([bytes], { type: contentType }));
    await ctx.runMutation(internal.charts.persistChartLogo, {
      chartId,
      storageId,
      mode,
      hasAlpha: hasAlpha ?? false,
    });
  },
});

/** Remove a chart's brand logo for one `mode` (deletes the blob + clears it). */
export const removeChartLogo = mutation({
  args: { chartId: v.id("charts"), mode: logoMode },
  handler: async (ctx, { chartId, mode }) => {
    const actor = await getActor(ctx);
    const chart = await authorizeChartWrite(ctx, chartId, actor.effectiveUserId);
    const prev =
      mode === "light" ? chart.logoLightStorageId : chart.logoDarkStorageId;
    if (prev) {
      await ctx.storage.delete(prev);
      await ctx.db.patch(
        chart._id,
        mode === "light"
          ? { logoLightStorageId: undefined, logoLightHasAlpha: undefined }
          : { logoDarkStorageId: undefined, logoDarkHasAlpha: undefined },
      );
      await auditImpersonated(ctx, actor, "chart.removeLogo", {
        resource: "chart",
        resourceId: `${chart.key}:${mode}`,
      });
    }
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

/** The domains mapped to a chart (admin display). Bounded by_chart read. */
async function domainsForChart(
  ctx: QueryCtx | MutationCtx,
  chartKey: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query("chartDomains")
    .withIndex("by_chart", (q) => q.eq("chartKey", chartKey))
    .collect();
  return rows.map((r) => r.domain);
}

/**
 * Map a domain to a chart (charte par domaine). Admin ONLY. Normalizes the domain
 * (convex/lib/domains) and REJECTS one already mapped to ANOTHER chart -- a
 * duplicate `by_domain` row would make resolution's `.unique()` throw for every
 * visitor of that host. Verifies the chart exists (builtin OR custom). Idempotent.
 */
export const addChartDomain = mutation({
  args: { chartKey: v.string(), domain: v.string() },
  handler: async (ctx, { chartKey, domain }) => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const actor = await getActor(ctx);
    if (
      !BUILTIN_CHART_KEYS.has(chartKey) &&
      (await getCustomChartByKey(ctx, chartKey)) === null
    ) {
      throw new Error("Not found: chart");
    }
    const norm = normalizeDomain(domain);
    if (norm === null) throw new Error("Domaine invalide");
    const existing = await ctx.db
      .query("chartDomains")
      .withIndex("by_domain", (q) => q.eq("domain", norm))
      .unique();
    if (existing !== null) {
      if (existing.chartKey === chartKey) return; // idempotent
      throw new Error("Ce domaine est déjà associé à une autre charte");
    }
    await ctx.db.insert("chartDomains", {
      chartKey,
      domain: norm,
      createdBy: actor.realUserId,
      createdAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "chart.addDomain", {
      resource: "chart",
      resourceId: `${chartKey}:${norm}`,
    });
  },
});

/** Unmap a domain from a chart. Admin ONLY. Idempotent. */
export const removeChartDomain = mutation({
  args: { chartKey: v.string(), domain: v.string() },
  handler: async (ctx, { chartKey, domain }) => {
    await requirePermission(ctx, PERMISSIONS.CHARTS_MANAGE);
    const actor = await getActor(ctx);
    const norm = normalizeDomain(domain) ?? domain;
    const row = await ctx.db
      .query("chartDomains")
      .withIndex("by_domain", (q) => q.eq("domain", norm))
      .unique();
    if (row !== null && row.chartKey === chartKey) {
      await ctx.db.delete(row._id);
      await auditImpersonated(ctx, actor, "chart.removeDomain", {
        resource: "chart",
        resourceId: `${chartKey}:${norm}`,
      });
    }
  },
});

// Re-export the resolution source type so callers (me.ts) get it from one place.
export type { ChartSource };
export { domainsForChart };
