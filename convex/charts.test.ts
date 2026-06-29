/// <reference types="vite/client" />
//
// Charts (P3). Pins the chart SELECTION + AVAILABILITY surface:
//  - listMyCharts: a COMMON builtin (no groupCharts rows) is offered to everyone;
//    a builtin RESTRICTED via a groupCharts row is offered ONLY to a member
//    (with via={group:key}), and is OMITTED for a non-member.
//  - listMyCharts is EFFECTIVE-user scoped: an admin (not a member) impersonating
//    a member sees the member's restricted chart (proves requireUserId-scoping,
//    not real-identity).
//  - setMyChart REJECTS a key not in the user's AVAILABLE set; accepts an
//    available key + null (read back via getMe to confirm the clear-via-undefined
//    idiom).
//  - assign/removeChartToGroup dedup + idempotency; deleteGroup cascade purges
//    groupCharts (verifies the P3 cascade fires).
//  - resolveChart precedence (pure): user pick > admin default > null, AND the
//    DISCRIMINATING "user pick no longer available -> falls back to default"; one
//    getMe integration pins the isChartAvailableToUser <-> resolveChart wiring.
//  - CHARTS_MANAGE gates the admin mutations on the REAL identity (a real
//    non-admin is rejected; an admin impersonating a regular user STILL manages).
//  - registry internal cohesion (single-source: BUILTIN_CHART_KEYS == the keys of
//    BUILTIN_CHARTS, builtinChart resolves each). NOTE: the spec's "if duplicated"
//    cohesion clause is N/A here -- the registry lives in ONE module
//    (convex/lib/charts.ts) imported by both backend and frontend, so there is no
//    second copy to compare against.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { isChartAvailableToUser } from "./charts";
import {
  BUILTIN_CHARTS,
  BUILTIN_CHART_KEYS,
  builtinChart,
  resolveChart,
} from "./lib/charts";
import { validateChartImport } from "./lib/chartValidation";

const modules = import.meta.glob("./**/*.ts");

// ---------------------------------------------------------------------------
// Seed helpers (mirror groups.test.ts idioms).
// ---------------------------------------------------------------------------

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" as const });
    return uid;
  });
}

async function seedUser(t: ReturnType<typeof convexTest>, canonical = "u") {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: "user" as const,
      canonical,
    });
    return uid;
  });
}

// JS-side table read -- a `t: ReturnType<typeof convexTest>` PARAMETER loses the
// inferred data model, so `withIndex(...)` fails typecheck (same workaround the
// groups/agents tests call out). Filter/collect in memory instead.
const groupChartRows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("groupCharts").collect());

// The slug `key` of the just-created group (via carries the slug, never the
// name; do NOT hardcode the slugify output).
async function groupKey(
  asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  groupId: string,
): Promise<string> {
  const listed = await asAdmin.query(api.groups.listGroups, {});
  return listed.find((g) => g._id === groupId)!.key;
}

// Make a chart AVAILABLE to a group the 3-tier way: admin adds it to the group's
// POOL (Tier 1) then SELECTS it into the group (Tier 2). Replaces the old direct
// assignChartToGroup-as-admin (which now requires the chart to be pooled first).
async function poolAndSelect(
  asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  groupId: Id<"groups">,
  chartKey: string,
): Promise<void> {
  await asAdmin.mutation(api.charts.addChartToGroupPool, { groupId, chartKey });
  await asAdmin.mutation(api.charts.assignChartToGroup, { groupId, chartKey });
}

// Pick a known builtin key and a second distinct one (the registry has 3, so
// these are stable; the test stays meaningful if names ever change).
const FIRST_KEY = BUILTIN_CHARTS[0]!.key;
const SECOND_KEY = BUILTIN_CHARTS[1]!.key;

// ===========================================================================
// listMyCharts -- availability (common vs restricted), provenance, scoping
// ===========================================================================

describe("listMyCharts availability", () => {
  test("a COMMON builtin is offered to everyone; a RESTRICTED one only to a member", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const member = await seedUser(t, "member");
    const outsider = await seedUser(t, "outsider");
    const as = t.withIdentity({ subject: `${adminId}|session` });

    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await as.mutation(api.groups.addMember, { groupId, userId: member });
    // Restrict FIRST_KEY to group G (>=1 groupCharts row flips it to restricted).
    await poolAndSelect(as, groupId, FIRST_KEY);
    const key = await groupKey(as, groupId);

    // Member: sees ALL builtins; FIRST_KEY carries via={group:key}, the rest common.
    const memberCharts = await t
      .withIdentity({ subject: `${member}|session` })
      .query(api.charts.listMyCharts, {});
    expect(memberCharts.length).toBe(BUILTIN_CHARTS.length);
    const restricted = memberCharts.find((c) => c.key === FIRST_KEY)!;
    expect(restricted.via).toEqual({ group: key });
    for (const c of memberCharts) {
      if (c.key !== FIRST_KEY) expect(c.via).toBe("common");
    }

    // Outsider (non-member): FIRST_KEY is OMITTED entirely; everything else common.
    const outsiderCharts = await t
      .withIdentity({ subject: `${outsider}|session` })
      .query(api.charts.listMyCharts, {});
    expect(outsiderCharts.length).toBe(BUILTIN_CHARTS.length - 1);
    expect(outsiderCharts.some((c) => c.key === FIRST_KEY)).toBe(false);
    expect(outsiderCharts.every((c) => c.via === "common")).toBe(true);
  });

  test("EFFECTIVE-user scoping: admin (non-member) IMPERSONATING a member sees the member's restricted chart", async () => {
    // listMyCharts is owner-scoped on the EFFECTIVE user (requireUserId). The
    // admin is NOT a member of G; the member IS. While impersonating the member
    // the admin must see G's restricted chart -- if the query keyed off the REAL
    // identity (the non-member admin) it would NOT. This is the discriminator.
    const t = convexTest(schema, modules);
    const member = await seedUser(t, "member");
    const adminId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin" as const,
        impersonatingUserId: member, // admin is acting AS the member
      });
      return uid;
    });
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    // Set up the membership + restriction as the (real) admin would.
    const groupId = await asAdmin.mutation(api.groups.createGroup, { name: "G" });
    await asAdmin.mutation(api.groups.addMember, { groupId, userId: member });
    await poolAndSelect(asAdmin, groupId, FIRST_KEY);
    const key = await groupKey(asAdmin, groupId);

    // The impersonating admin's listMyCharts resolves to the MEMBER's set.
    const charts = await asAdmin.query(api.charts.listMyCharts, {});
    const restricted = charts.find((c) => c.key === FIRST_KEY)!;
    expect(restricted.via).toEqual({ group: key }); // member can reach it
    expect(charts.length).toBe(BUILTIN_CHARTS.length);
  });
});

// ===========================================================================
// setMyChart -- reject unavailable, accept available + null
// ===========================================================================

describe("setMyChart availability gate", () => {
  test("REJECTS a key not available to the user", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const user = await seedUser(t, "u");
    const as = t.withIdentity({ subject: `${adminId}|session` });

    // Restrict FIRST_KEY to a group the user is NOT in -> unavailable to the user.
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await poolAndSelect(as, groupId, FIRST_KEY);

    await expect(
      t
        .withIdentity({ subject: `${user}|session` })
        .mutation(api.charts.setMyChart, { name: FIRST_KEY }),
    ).rejects.toThrow(/not available/);
  });

  test("accepts an AVAILABLE (common) key and null; getMe reflects then clears it", async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t, "u");
    const asUser = t.withIdentity({ subject: `${user}|session` });

    // SECOND_KEY is common (no groupCharts rows) -> available to all.
    await asUser.mutation(api.charts.setMyChart, { name: SECOND_KEY });
    let me = await asUser.query(api.me.getMe, {});
    expect(me.chartKey).toBe(SECOND_KEY);
    expect(me.resolvedChartKey).toBe(SECOND_KEY);
    expect(me.chartSource).toBe("user");

    // null clears the pref (themeName set to undefined -> field absent).
    await asUser.mutation(api.charts.setMyChart, { name: null });
    me = await asUser.query(api.me.getMe, {});
    expect(me.chartKey).toBeNull();
    expect(me.resolvedChartKey).toBeNull();
    expect(me.chartSource).toBe("code");
  });
});

// ===========================================================================
// assign / remove -- dedup + idempotency + deleteGroup cascade
// ===========================================================================

describe("assign/remove chart to group", () => {
  test("Tier-2 select is pool-constrained + dedups; unselect is idempotent; deleteGroup CASCADE purges groupCharts", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });

    // A chart NOT in the group's pool cannot be selected (Tier-2 ⊆ Tier-1). This
    // also rejects an unknown key (it can never be pooled). If the pool constraint
    // regressed, FIRST_KEY would get a groupCharts row here.
    await expect(
      as.mutation(api.charts.assignChartToGroup, {
        groupId,
        chartKey: FIRST_KEY,
      }),
    ).rejects.toThrow(/not in this group's pool/);
    expect((await groupChartRows(t)).length).toBe(0);

    // Pool it, then select twice -> exactly one row (by_group_chart .unique() dedup).
    await as.mutation(api.charts.addChartToGroupPool, { groupId, chartKey: FIRST_KEY });
    await as.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: FIRST_KEY,
    });
    await as.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: FIRST_KEY,
    });
    expect((await groupChartRows(t)).length).toBe(1);

    // Unselect is idempotent: an unknown / never-selected key is a silent no-op
    // (unselect no longer validates the key — you can always stop offering).
    await as.mutation(api.charts.removeChartFromGroup, {
      groupId,
      chartKey: "does-not-exist",
    });
    await as.mutation(api.charts.removeChartFromGroup, {
      groupId,
      chartKey: SECOND_KEY,
    });
    expect((await groupChartRows(t)).length).toBe(1);

    // Unselect the real row, then again -> idempotent, back to zero.
    await as.mutation(api.charts.removeChartFromGroup, {
      groupId,
      chartKey: FIRST_KEY,
    });
    await as.mutation(api.charts.removeChartFromGroup, {
      groupId,
      chartKey: FIRST_KEY,
    });
    expect((await groupChartRows(t)).length).toBe(0);

    // Re-select (still pooled), then delete the group -> the cascade purges groupCharts.
    await as.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: FIRST_KEY,
    });
    expect((await groupChartRows(t)).length).toBe(1);
    await as.mutation(api.groups.deleteGroup, { groupId });
    expect((await groupChartRows(t)).length).toBe(0);
  });
});

// ===========================================================================
// resolveChart -- precedence (pure) + the getMe wiring
// ===========================================================================

describe("resolveChart precedence", () => {
  // Signature: resolveChart(userKey, groupDefault, domainDefault, adminDefault,
  // availableKeys, domainAvailable). Precedence: user > group > domain > admin > code.
  test("PURE: user pick > admin default > null", async () => {
    const available = new Set([FIRST_KEY, SECOND_KEY]);

    // 1) User pick available -> source "user".
    expect(
      resolveChart(FIRST_KEY, null, null, SECOND_KEY, available, false),
    ).toEqual({ chartKey: FIRST_KEY, source: "user" });

    // 2) No user pick, admin default set -> source "common/admin".
    expect(
      resolveChart(null, null, null, SECOND_KEY, available, false),
    ).toEqual({ chartKey: SECOND_KEY, source: "common/admin" });

    // 3) Neither -> null/"code".
    expect(resolveChart(null, null, null, null, available, false)).toEqual({
      chartKey: null,
      source: "code",
    });
  });

  test("PURE (discriminating): user pick NO LONGER available -> falls back to admin default, NOT the user pick", async () => {
    // The user picked FIRST_KEY (e.g. a restricted chart) but it is no longer in
    // their AVAILABLE set; the admin default SECOND_KEY is. A precedence bug that
    // ignored availability would return {FIRST_KEY,"user"}.
    const availableWithoutUserPick = new Set([SECOND_KEY]);
    expect(
      resolveChart(
        FIRST_KEY,
        null,
        null,
        SECOND_KEY,
        availableWithoutUserPick,
        false,
      ),
    ).toEqual({ chartKey: SECOND_KEY, source: "common/admin" });
  });

  test("PURE (group tier): group default beats domain + admin, loses to a valid user pick", async () => {
    const available = new Set([FIRST_KEY]);
    const GROUP = "grp-key";
    const DOMAIN = "dom-key";
    const ADMIN = "adm-key";

    // group default applies (no user pick) and BEATS both the domain and admin defaults.
    expect(resolveChart(null, GROUP, DOMAIN, ADMIN, available, true)).toEqual({
      chartKey: GROUP,
      source: "group",
    });

    // a VALID user pick still beats the group default.
    expect(
      resolveChart(FIRST_KEY, GROUP, DOMAIN, ADMIN, available, true),
    ).toEqual({ chartKey: FIRST_KEY, source: "user" });

    // an UNavailable user pick falls through to the group default (not the stale pick,
    // not the domain) -- the discriminating case for the new tier's position.
    expect(
      resolveChart("stale", GROUP, DOMAIN, ADMIN, available, true),
    ).toEqual({ chartKey: GROUP, source: "group" });
  });

  test("PURE (domain tier): applies when available, skipped when group-gated, loses to user pick, beats admin", async () => {
    const available = new Set([FIRST_KEY]);
    const DOMAIN = "dom-key";
    const ADMIN = "adm-key";

    // domain default applies when available (no user/group pick) AND beats admin.
    expect(resolveChart(null, null, DOMAIN, ADMIN, available, true)).toEqual({
      chartKey: DOMAIN,
      source: "domain",
    });

    // domain SKIPPED when not available (group-gated, non-member) -> admin default.
    expect(resolveChart(null, null, DOMAIN, ADMIN, available, false)).toEqual({
      chartKey: ADMIN,
      source: "common/admin",
    });

    // a valid user pick beats the domain default.
    expect(
      resolveChart(FIRST_KEY, null, DOMAIN, ADMIN, available, true),
    ).toEqual({ chartKey: FIRST_KEY, source: "user" });

    // domain default, no admin default -> domain (not native).
    expect(resolveChart(null, null, DOMAIN, null, available, true)).toEqual({
      chartKey: DOMAIN,
      source: "domain",
    });
  });

  test("WIRING (getMe): a user whose restricted pick became unavailable resolves to the admin default", async () => {
    // Integration that pins isChartAvailableToUser <-> resolveChart in getMe.
    // The user once picked FIRST_KEY while a member; the chart is now restricted
    // to a group they are NOT in (themeName still holds FIRST_KEY), and the admin
    // global default is SECOND_KEY (common). getMe must resolve to SECOND_KEY.
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const user = await seedUser(t, "u");
    const as = t.withIdentity({ subject: `${adminId}|session` });

    // Stamp the user's stale pick directly (FIRST_KEY) on their profile.
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", user))
        .unique();
      await ctx.db.patch(p!._id, { themeName: FIRST_KEY });
    });
    // Admin restricts FIRST_KEY to a group the user is NOT in -> unavailable now.
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await poolAndSelect(as, groupId, FIRST_KEY);
    // Admin global default = SECOND_KEY (common).
    await as.mutation(api.charts.setDefaultChart, { name: SECOND_KEY });

    const me = await t
      .withIdentity({ subject: `${user}|session` })
      .query(api.me.getMe, {});
    expect(me.chartKey).toBe(FIRST_KEY); // raw user pref unchanged
    expect(me.resolvedChartKey).toBe(SECOND_KEY); // dropped -> admin default
    expect(me.chartSource).toBe("common/admin");
    expect(me.defaultChartKey).toBe(SECOND_KEY);
  });

  test("WIRING (getMe): a member with no pick resolves to their GROUP default (source 'group')", async () => {
    // The 3-tier group default tier: a member with no personal pick inherits the
    // default chart their group SELECTED (first selection auto-defaults). The group
    // default must WIN even when an admin global default also exists (user > group >
    // domain > admin) -- a precedence bug would resolve to the admin default instead.
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const member = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });

    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await as.mutation(api.groups.addMember, { groupId, userId: member });
    // Pool + select FIRST_KEY -> it becomes G's default (auto-elect first selection).
    await poolAndSelect(as, groupId, FIRST_KEY);
    // An admin global default is set to a DIFFERENT key -> the group default must win.
    await as.mutation(api.charts.setDefaultChart, { name: SECOND_KEY });

    const me = await t
      .withIdentity({ subject: `${member}|session` })
      .query(api.me.getMe, {});
    expect(me.chartKey).toBeNull(); // no personal pick
    expect(me.resolvedChartKey).toBe(FIRST_KEY); // the GROUP default, not SECOND_KEY
    expect(me.chartSource).toBe("group");
    expect(me.defaultChartKey).toBe(SECOND_KEY); // admin default still reported
  });
});

// ===========================================================================
// RBAC -- CHARTS_MANAGE keys off the REAL identity (impersonation never drops it)
// ===========================================================================

describe("CHARTS_MANAGE keys off the REAL identity", () => {
  test("a real NON-admin user is rejected on every admin chart mutation/query", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const user = await seedUser(t, "u");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });

    const asUser = t.withIdentity({ subject: `${user}|session` });
    await expect(
      asUser.query(api.charts.listChartsAdmin, {}),
    ).rejects.toThrow(/missing permission charts\.manage/);
    await expect(
      asUser.mutation(api.charts.setDefaultChart, { name: FIRST_KEY }),
    ).rejects.toThrow(/missing permission charts\.manage/);
    // Chart group SELECTION is now Tier-2 (gated authorizeGroupManage), so a plain
    // non-admin lacking groups.manage is rejected on the GROUPS permission — not
    // charts.manage (the gate moved with the 3-tier split).
    await expect(
      asUser.mutation(api.charts.assignChartToGroup, {
        groupId,
        chartKey: FIRST_KEY,
      }),
    ).rejects.toThrow(/missing permission groups\.manage/);
    await expect(
      asUser.mutation(api.charts.removeChartFromGroup, {
        groupId,
        chartKey: FIRST_KEY,
      }),
    ).rejects.toThrow(/missing permission groups\.manage/);
  });

  test("an admin IMPERSONATING a regular user STILL manages charts (gate uses REAL id)", async () => {
    // requirePermission keys off the REAL signed-in identity, never the
    // impersonated/effective one. An admin whose EFFECTIVE id is a permission-less
    // regular user must STILL pass the charts.manage gate; if the gate had dropped
    // to the effective id these would throw. (Mirrors groups RBAC.)
    const t = convexTest(schema, modules);
    const regularId = await seedUser(t, "victim");
    const adminId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin" as const,
        impersonatingUserId: regularId,
      });
      return uid;
    });
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });

    // setDefaultChart + (pool + select) both succeed despite impersonation.
    await as.mutation(api.charts.setDefaultChart, { name: FIRST_KEY });
    await poolAndSelect(as, groupId, FIRST_KEY);
    const admin = await as.query(api.charts.listChartsAdmin, {});
    const restricted = admin.find((c) => c.key === FIRST_KEY)!;
    expect(restricted.isGlobalDefault).toBe(true);
    expect(restricted.restrictedToGroups).not.toBeNull();
    expect(restricted.restrictedToGroups!.some((g) => g.groupId === groupId)).toBe(
      true,
    );
    // A common chart still reports null restriction.
    const common = admin.find((c) => c.key === SECOND_KEY)!;
    expect(common.restrictedToGroups).toBeNull();
  });
});

// ===========================================================================
// Registry internal cohesion (single-source; "if duplicated" clause N/A)
// ===========================================================================

describe("builtin chart registry cohesion", () => {
  test("BUILTIN_CHART_KEYS matches BUILTIN_CHARTS keys and builtinChart resolves each", () => {
    const keysFromArray = new Set(BUILTIN_CHARTS.map((c) => c.key));
    expect(BUILTIN_CHART_KEYS).toEqual(keysFromArray);
    expect(BUILTIN_CHART_KEYS.size).toBe(BUILTIN_CHARTS.length); // no dup keys
    for (const c of BUILTIN_CHARTS) {
      expect(builtinChart(c.key)).toBe(c);
      // Each builtin defines both mode color sets (sanity on the registry shape).
      expect(Object.keys(c.tokens.colors.light).length).toBeGreaterThan(0);
      expect(Object.keys(c.tokens.colors.dark).length).toBeGreaterThan(0);
    }
    expect(builtinChart("nope")).toBeUndefined();
  });
});

// ===========================================================================
// isChartAvailableToUser -- the BOUNDED single-key reachability check that
// replaced the full-table enumeration on the getMe hot path + the setMyChart
// gate. Its truth table MUST match availableChartsForUser exactly; the NEGATIVE
// reachability cases are the security guard (a too-permissive check = a user
// selecting a chart they should not be able to reach).
// ===========================================================================

describe("isChartAvailableToUser (bounded reachability truth table)", () => {
  test("builtin/custom × common/owner/group/none, with the negative cases", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const member = await seedUser(t, "member");
    const outsider = await seedUser(t, "outsider");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });

    // A group the MEMBER joins; the OUTSIDER never does.
    const groupId = await asAdmin.mutation(api.groups.createGroup, {
      name: "Clinique A",
    });
    await asAdmin.mutation(api.groups.addMember, { groupId, userId: member });

    // SECOND_KEY builtin restricted to the group; FIRST_KEY stays common.
    await poolAndSelect(asAdmin, groupId, SECOND_KEY);

    // Custom charts inserted directly (the helper reads them by key/scope/owner).
    const minimal = { colors: { light: {}, dark: {} } };
    const commonCustomKey = "cc-common";
    const ownedCustomKey = "cp-owned";
    const sharedCustomKey = "cp-shared";
    await t.run(async (ctx) => {
      await ctx.db.insert("charts", {
        key: commonCustomKey,
        name: "CC",
        scope: "common",
        tokens: minimal,
        createdBy: adminId,
        createdAt: 1,
      });
      await ctx.db.insert("charts", {
        key: ownedCustomKey,
        name: "Owned",
        scope: "personal",
        ownerUserId: owner,
        tokens: minimal,
        createdBy: owner,
        createdAt: 1,
      });
      await ctx.db.insert("charts", {
        key: sharedCustomKey,
        name: "Shared",
        scope: "personal",
        ownerUserId: owner,
        tokens: minimal,
        createdBy: owner,
        createdAt: 1,
      });
    });
    // Admin makes the OWNER's personal chart available to the group (pool + select).
    await poolAndSelect(asAdmin, groupId, sharedCustomKey);

    const avail = (userId: typeof owner, key: string) =>
      t.run((ctx) => isChartAvailableToUser(ctx, userId, key));

    // BUILTIN common -> everyone.
    expect(await avail(outsider, FIRST_KEY)).toBe(true);
    // BUILTIN restricted -> member yes, NON-member NO (negative).
    expect(await avail(member, SECOND_KEY)).toBe(true);
    expect(await avail(outsider, SECOND_KEY)).toBe(false);
    // CUSTOM common -> everyone.
    expect(await avail(outsider, commonCustomKey)).toBe(true);
    // CUSTOM personal owned -> owner yes, NON-owner NON-member NO (negative).
    expect(await avail(owner, ownedCustomKey)).toBe(true);
    expect(await avail(outsider, ownedCustomKey)).toBe(false);
    // CUSTOM personal shared to a group -> member yes, NON-member NO (negative),
    // owner still yes (owner > group).
    expect(await avail(member, sharedCustomKey)).toBe(true);
    expect(await avail(outsider, sharedCustomKey)).toBe(false);
    expect(await avail(owner, sharedCustomKey)).toBe(true);
    // Unknown key -> false (no oracle).
    expect(await avail(member, "does-not-exist")).toBe(false);
  });
});

// NOTE: setChartLogo's input guards (oversized / non-image) + authorization are
// covered in convex/chartsDomain.test.ts ("setChartLogo (server-side store)"),
// which exercises the current bytes-in / server-stores-the-blob flow.

// Export -> import round-trip: the export button downloads a chart's `tokens`;
// re-importing pastes those tokens + a name -> validateChartImport({name, tokens}).
// Guarantee: EVERY built-in's tokens pass that validation, so a chart can never be
// exported into a form the importer rejects.
describe("chart export round-trips through import", () => {
  test.each(BUILTIN_CHARTS.map((c) => [c.key, c.tokens] as const))(
    "builtin %s re-validates as an import",
    (_key, tokens) => {
      expect(validateChartImport({ name: "Imported chart", tokens }).ok).toBe(
        true,
      );
    },
  );

  test("bpm token: 0/50/90 accepted; out-of-range / non-integer rejected", () => {
    const base = BUILTIN_CHARTS[0]!.tokens;
    for (const bpm of [0, 50, 90]) {
      expect(
        validateChartImport({ name: "X", tokens: { ...base, bpm } }).ok,
      ).toBe(true);
    }
    for (const bad of [91, -1, 1.5, "50"]) {
      expect(
        validateChartImport({ name: "X", tokens: { ...base, bpm: bad } }).ok,
      ).toBe(false);
    }
  });
});
