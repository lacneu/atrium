/// <reference types="vite/client" />
//
// Custom chart import (P4). The SECURITY core per docs/GROUPS_CHARTS_P4_SPEC.md
// section 6, ordered RBAC/IDOR FIRST then the typed-token validator:
//
//  - IDOR on PERSONAL charts (the new surface). A user A can NEVER reach user B's
//    personal chart by id: it is OMITTED from A's listMyCharts; setMyChart(B's
//    REAL key) rejects /not available/ (apply path); update/delete with B's REAL
//    chartId reject /not your chart/ (the OWNERSHIP gate, NOT the Not-found path —
//    we feed the real id so the discriminating branch fires); assignChartToGroup of
//    B's chart, or of A's own chart to a group A is NOT in, both reject; a non-admin
//    can NEVER promoteChartToCommon; setDefaultChart REJECTS a personal chart.
//  - ALLOW (not co-true with a reject-everything impl): owner edits/deletes own
//    personal; admin manages a common + any personal; valid import succeeds + is
//    readable; owner+member assign succeeds.
//  - Impersonation (reads effective, admin-mutations real): an admin impersonating
//    B imports -> ownerUserId === B (EFFECTIVE); promoteChartToCommon/setDefaultChart
//    still succeed while the admin's effective id is a permission-less user (gate =
//    REAL identity).
//  - Validator attack corpus (hammered against the PURE function — fast, no DB):
//    every breakout/url/@import/expression/unknown-key/bad-type/oversized/
//    non-allowlisted-font payload REJECTED; a valid oklch ACCEPTED and
//    RE-SERIALIZED (odd spacing -> canonical rebuild, so input != output proves the
//    rebuild). One end-to-end importChart proves the validator is WIRED (the stored
//    doc holds the rebuild, never the raw string).
//  - Availability: a personal chart is visible to its owner + members of its groups
//    only; a common chart to all; admin sees all.
//  - Cascade: deleteChart purges groupCharts AND a user whose themeName == the key
//    falls back; deleting a common-custom that was the admin global default clears
//    appMeta.defaultThemeName (the extra cascade shipped beyond the literal spec).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  ALLOWED_FONT_STACKS,
  validateChartImport,
} from "./lib/chartValidation";

const modules = import.meta.glob("./**/*.ts");

// A font stack guaranteed to be in the closed allowlist (membership, no free text).
const FONT_SANS = [...ALLOWED_FONT_STACKS][0]!;

// ---------------------------------------------------------------------------
// Seed helpers (mirror charts.test.ts / groups.test.ts idioms).
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

// An admin whose EFFECTIVE identity is `target` (impersonation). The gate
// discriminator: reads scope to the effective (target) user, admin mutations key
// off the REAL (admin) identity.
async function seedImpersonatingAdmin(
  t: ReturnType<typeof convexTest>,
  target: string,
) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: "admin" as const,
      impersonatingUserId: target as never,
    });
    return uid;
  });
}

// JS-side table read -- a `t: ReturnType<typeof convexTest>` PARAMETER loses the
// inferred data model, so `withIndex(...)` would fail typecheck (the same
// workaround groups/charts tests call out). Collect in memory instead (tiny tables).
const allCharts = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("charts").collect());
const allGroupCharts = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("groupCharts").collect());

// A minimal VALID import payload (one color per mode). Used by the wiring/RBAC
// tests that don't care about the exact token set, only the security gate.
function validImport(name = "My Chart") {
  return {
    name,
    tokens: {
      colors: {
        light: { background: "oklch(0.98 0.01 230)" },
        dark: { background: "oklch(0.2 0.03 245)" },
      },
    },
  };
}

// Import a chart as the given identity and return BOTH its key and its real
// chartId (read back from the doc — importChart returns only { key }).
async function importAs(
  t: ReturnType<typeof convexTest>,
  asIdentity: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  payload: ReturnType<typeof validImport> = validImport(),
): Promise<{ key: string; chartId: string }> {
  const { key } = await asIdentity.mutation(api.charts.importChart, payload);
  const doc = (await allCharts(t)).find((c) => c.key === key)!;
  return { key, chartId: doc._id };
}

// Flip a user's profile role (e.g. set an active owner back to "pending" to prove
// the deactivated-owner write gate). Tiny tables -> a JS-side scan is fine.
async function setRole(
  t: ReturnType<typeof convexTest>,
  userId: string,
  role: "admin" | "user" | "pending",
) {
  await t.run(async (ctx) => {
    const profile = (await ctx.db.query("profiles").collect()).find(
      (p) => p.userId === (userId as never),
    )!;
    await ctx.db.patch(profile._id, { role });
  });
}

// Grant a user the (grantable) groups.manage permission. A group MANAGER also needs
// the per-group manager flag (setGroupManager) to manage a SPECIFIC group's content.
async function grantGroupsManage(
  t: ReturnType<typeof convexTest>,
  userId: string,
) {
  await t.run(async (ctx) => {
    const profile = (await ctx.db.query("profiles").collect()).find(
      (p) => p.userId === (userId as never),
    )!;
    await ctx.db.patch(profile._id, { extraPermissions: ["groups.manage"] });
  });
}

// ===========================================================================
// IDOR -- cross-user PERSONAL charts (the new P4 surface). RBAC FIRST.
// ===========================================================================

describe("IDOR: a user cannot reach another user's PERSONAL chart", () => {
  test("B's personal chart is OMITTED from A's listMyCharts and setMyChart(B's REAL key) rejects /not available/", async () => {
    const t = convexTest(schema, modules);
    const userA = await seedUser(t, "a");
    const userB = await seedUser(t, "b");
    const asA = t.withIdentity({ subject: `${userA}|session` });
    const asB = t.withIdentity({ subject: `${userB}|session` });

    // B imports a personal chart (scope=personal, ownerUserId=B).
    const { key: bKey } = await importAs(t, asB, validImport("B chart"));

    // GET/apply IDOR (no by-id getter exists; the surface is list + setMyChart):
    // A's available list NEVER contains B's personal chart.
    const aCharts = await asA.query(api.charts.listMyCharts, {});
    expect(aCharts.some((c) => c.key === bKey)).toBe(false);

    // setMyChart with B's REAL key (not a guess) -> the AVAILABILITY scope rejects
    // it. Using B's real key proves it is the SCOPING, not an "unknown key" path.
    await expect(
      asA.mutation(api.charts.setMyChart, { name: bKey }),
    ).rejects.toThrow(/not available/);

    // Control: B (the owner) CAN see + select it (proves it is a real, valid key
    // that the scoping — not nonexistence — keeps from A).
    const bCharts = await asB.query(api.charts.listMyCharts, {});
    expect(bCharts.some((c) => c.key === bKey)).toBe(true);
    await asB.mutation(api.charts.setMyChart, { name: bKey });
    const meB = await asB.query(api.me.getMe, {});
    expect(meB.resolvedChartKey).toBe(bKey);
  });

  test("A cannot update or delete B's personal chart by its REAL id (/not your chart/, NOT the Not-found path)", async () => {
    const t = convexTest(schema, modules);
    const userA = await seedUser(t, "a");
    const userB = await seedUser(t, "b");
    const asA = t.withIdentity({ subject: `${userA}|session` });
    const asB = t.withIdentity({ subject: `${userB}|session` });

    // B's REAL chartId — feed THIS to A's update/delete so the OWNERSHIP branch
    // fires (a random id would throw "Not found", a co-true different path).
    const { chartId: bChartId } = await importAs(t, asB, validImport("B chart"));

    await expect(
      asA.mutation(api.charts.updateChart, {
        chartId: bChartId as never,
        name: "hijacked",
      }),
    ).rejects.toThrow(/not your chart/);
    await expect(
      asA.mutation(api.charts.deleteChart, { chartId: bChartId as never }),
    ).rejects.toThrow(/not your chart/);

    // The chart is untouched: still present, still named "B chart", still owned by B.
    const doc = (await allCharts(t)).find((c) => c._id === bChartId)!;
    expect(doc.name).toBe("B chart");
    expect(doc.ownerUserId).toBe(userB);
  });

  test("a non-admin cannot promoteChartToCommon (even their OWN chart) nor setDefaultChart a personal chart", async () => {
    const t = convexTest(schema, modules);
    const userA = await seedUser(t, "a");
    const asA = t.withIdentity({ subject: `${userA}|session` });

    const { chartId, key } = await importAs(t, asA, validImport("A chart"));

    // A user CANNOT make their own chart common (admin-only; gate = real identity).
    await expect(
      asA.mutation(api.charts.promoteChartToCommon, {
        chartId: chartId as never,
      }),
    ).rejects.toThrow(/missing permission charts\.manage/);

    // setDefaultChart is admin-only AND rejects a personal chart even for an admin
    // (here the user is rejected by the permission gate first).
    await expect(
      asA.mutation(api.charts.setDefaultChart, { name: key }),
    ).rejects.toThrow(/missing permission charts\.manage/);
  });

  test("an ADMIN setDefaultChart REJECTS a personal chart (global default must never be one user's private chart)", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const userA = await seedUser(t, "a");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asA = t.withIdentity({ subject: `${userA}|session` });

    // A's personal chart. The admin PASSES the permission gate but must STILL be
    // blocked by the scope check (personal -> cannot be the global default).
    const { key } = await importAs(t, asA, validImport("A private"));
    await expect(
      asAdmin.mutation(api.charts.setDefaultChart, { name: key }),
    ).rejects.toThrow(/personal chart cannot be the default/);
  });
});

// ===========================================================================
// IDOR -- group association (admin OR owner+member; never a non-member)
// ===========================================================================

describe("Tier-2 chart selection: manager + pool gated (owner self-share removed)", () => {
  test("an owner can no longer self-share; a MANAGER selects only POOLED charts of THEIR own group", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const manager = await seedUser(t, "manager");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asOwner = t.withIdentity({ subject: `${owner}|session` });
    const asManager = t.withIdentity({ subject: `${manager}|session` });

    // gMine: `manager` is its MANAGER. gOther: `manager` is NOT a manager.
    const gMine = await asAdmin.mutation(api.groups.createGroup, { name: "Mine" });
    const gOther = await asAdmin.mutation(api.groups.createGroup, {
      name: "Other",
    });
    await asAdmin.mutation(api.groups.addMember, {
      groupId: gMine,
      userId: manager,
    });
    await grantGroupsManage(t, manager);
    await asAdmin.mutation(api.groups.setGroupManager, {
      groupId: gMine,
      userId: manager,
      manager: true,
    });

    const { key } = await importAs(t, asOwner, validImport("Owned"));

    // (1) The OWNER (no groups.manage) can NO LONGER self-share their own chart —
    // the gate is groups.manage now, not the removed owner+member path. No row lands.
    await expect(
      asOwner.mutation(api.charts.assignChartToGroup, {
        groupId: gMine,
        chartKey: key,
      }),
    ).rejects.toThrow(/missing permission groups\.manage/);
    expect((await allGroupCharts(t)).length).toBe(0);

    // (2) The manager of gMine cannot select a chart that is NOT in gMine's pool —
    // the Tier-2 ⊆ Tier-1 constraint. Still no row.
    await expect(
      asManager.mutation(api.charts.assignChartToGroup, {
        groupId: gMine,
        chartKey: key,
      }),
    ).rejects.toThrow(/not in this group's pool/);
    expect((await allGroupCharts(t)).length).toBe(0);

    // (3) Admin POOLS the chart for gMine -> the manager CAN now select it (the
    // positive path; not co-true with a reject-everything gate).
    await asAdmin.mutation(api.charts.addChartToGroupPool, {
      groupId: gMine,
      chartKey: key,
    });
    await asManager.mutation(api.charts.assignChartToGroup, {
      groupId: gMine,
      chartKey: key,
    });
    const rows = await allGroupCharts(t);
    expect(rows.length).toBe(1);
    expect(rows[0].chartKey).toBe(key);
    expect(rows[0].groupId).toBe(gMine);

    // (4) Even with the chart pooled for gOther, the manager cannot select into a
    // group they do NOT manage (authorizeGroupManage rejects before the pool check).
    await asAdmin.mutation(api.charts.addChartToGroupPool, {
      groupId: gOther,
      chartKey: key,
    });
    await expect(
      asManager.mutation(api.charts.assignChartToGroup, {
        groupId: gOther,
        chartKey: key,
      }),
    ).rejects.toThrow(/not a manager of this group/);
  });
});

// ===========================================================================
// ALLOW -- owner edits/deletes own; admin manages common + any personal
// ===========================================================================

describe("ALLOW: owner + admin write paths (not a reject-everything gate)", () => {
  test("the OWNER can update and delete their own personal chart", async () => {
    const t = convexTest(schema, modules);
    const userA = await seedUser(t, "a");
    const asA = t.withIdentity({ subject: `${userA}|session` });

    const { chartId } = await importAs(t, asA, validImport("Original"));

    // Owner update (name + tokens) -> succeeds; the doc reflects it.
    await asA.mutation(api.charts.updateChart, {
      chartId: chartId as never,
      name: "Renamed",
      tokens: {
        colors: {
          light: { primary: "oklch(0.55 0.13 235)" },
          dark: {},
        },
      },
    });
    let doc = (await allCharts(t)).find((c) => c._id === chartId)!;
    expect(doc.name).toBe("Renamed");
    expect(doc.tokens.colors.light.primary).toBe("oklch(0.55 0.13 235)");

    // Owner delete -> the row is gone.
    await asA.mutation(api.charts.deleteChart, { chartId: chartId as never });
    doc = (await allCharts(t)).find((c) => c._id === chartId);
    expect(doc).toBeUndefined();
  });

  test("updateChart RE-VALIDATES tokens on the UPDATE path (rejects a breakout; re-serializes odd spacing)", async () => {
    // The validator must guard the UPDATE mutation too, not just import — the
    // injection surface is symmetric. A breakout in a NEW color value rejects; an
    // odd-but-valid value is re-serialized into the stored doc (input != output).
    const t = convexTest(schema, modules);
    const userA = await seedUser(t, "a");
    const asA = t.withIdentity({ subject: `${userA}|session` });
    const { chartId } = await importAs(t, asA, validImport("Mutable"));

    // (a) A breakout color value on update is REJECTED (the wired update guard).
    await expect(
      asA.mutation(api.charts.updateChart, {
        chartId: chartId as never,
        tokens: {
          colors: { light: { background: "oklch(1 0 0); background:url(//x)" } },
        },
      }),
    ).rejects.toThrow(/Invalid chart tokens/);
    // The doc keeps its original (valid) value -- the rejected write never landed.
    expect(
      (await allCharts(t)).find((c) => c._id === chartId)!.tokens.colors.light
        .background,
    ).toBe("oklch(0.98 0.01 230)");

    // (b) An odd-but-valid value is RE-SERIALIZED into the stored doc on update.
    await asA.mutation(api.charts.updateChart, {
      chartId: chartId as never,
      tokens: { colors: { light: { primary: "oklch( 0.55  0.13   235 )" } } },
    });
    expect(
      (await allCharts(t)).find((c) => c._id === chartId)!.tokens.colors.light
        .primary,
    ).toBe("oklch(0.55 0.13 235)"); // canonical rebuild, not the odd input
  });

  test("an ADMIN can update + delete ANY personal chart, and manage a COMMON chart (which a NON-admin cannot)", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const userA = await seedUser(t, "a");
    const userB = await seedUser(t, "b");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asA = t.withIdentity({ subject: `${userA}|session` });
    const asB = t.withIdentity({ subject: `${userB}|session` });

    // A's personal chart -> admin can rename it (admin overrides ownership).
    const { chartId: aChartId } = await importAs(t, asA, validImport("A chart"));
    await asAdmin.mutation(api.charts.updateChart, {
      chartId: aChartId as never,
      name: "Admin Renamed",
    });
    expect(
      (await allCharts(t)).find((c) => c._id === aChartId)!.name,
    ).toBe("Admin Renamed");

    // Promote A's chart to COMMON (admin-only) -> ownerUserId cleared, scope flips.
    await asAdmin.mutation(api.charts.promoteChartToCommon, {
      chartId: aChartId as never,
    });
    const promoted = (await allCharts(t)).find((c) => c._id === aChartId)!;
    expect(promoted.scope).toBe("common");
    expect(promoted.ownerUserId).toBeUndefined();

    // A common chart is now available to EVERYONE (B sees it though never a member).
    const bCharts = await asB.query(api.charts.listMyCharts, {});
    expect(bCharts.some((c) => c.key === promoted.key)).toBe(true);

    // A NON-admin (B) cannot update or delete the COMMON chart (admin-only path).
    await expect(
      asB.mutation(api.charts.updateChart, {
        chartId: aChartId as never,
        name: "nope",
      }),
    ).rejects.toThrow(/admin role required/);
    await expect(
      asB.mutation(api.charts.deleteChart, { chartId: aChartId as never }),
    ).rejects.toThrow(/admin role required/);

    // The admin CAN delete the common chart.
    await asAdmin.mutation(api.charts.deleteChart, {
      chartId: aChartId as never,
    });
    expect((await allCharts(t)).find((c) => c._id === aChartId)).toBeUndefined();
  });
});

// ===========================================================================
// ACTIVE gate: a DEACTIVATED (pending) owner can no longer WRITE its chart.
// Codex review P1: importChart gates requireActive, but update/delete/assign
// reached the owner branch after a plain getActor(), so an owner set back to
// `pending` kept full write power over a chart it may have shared to groups.
// ===========================================================================

describe("ACTIVE gate: a deactivated owner cannot mutate its chart", () => {
  test("an owner set to `pending` after import can no longer update or delete; an admin still can", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const userA = await seedUser(t, "a");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asA = t.withIdentity({ subject: `${userA}|session` });

    // A imports while ACTIVE (the import path itself gates requireActive).
    const { chartId } = await importAs(t, asA, validImport("A chart"));

    // A is set back to pending (e.g. an admin revokes approval).
    await setRole(t, userA, "pending");

    // The owner write paths now REJECT with the pending-account error -- NOT the
    // ownership error (proving the gate is the ACTIVE check, not authz).
    await expect(
      asA.mutation(api.charts.updateChart, {
        chartId: chartId as never,
        name: "nope",
      }),
    ).rejects.toThrow(/pending approval/);
    await expect(
      asA.mutation(api.charts.deleteChart, { chartId: chartId as never }),
    ).rejects.toThrow(/pending approval/);

    // Admin (always active) is unaffected: it can still delete the chart.
    await asAdmin.mutation(api.charts.deleteChart, {
      chartId: chartId as never,
    });
    expect((await allCharts(t)).find((c) => c._id === chartId)).toBeUndefined();
  });

  // NOTE: the former "a deactivated owner+member can no longer assign its chart to a
  // group" test was REMOVED with the owner self-share path (3-tier: a chart reaches a
  // group only via the admin pool + manager selection). The deactivated-owner write
  // gate stays covered by the updateChart/deleteChart cases above.
});

// ===========================================================================
// Availability branch (c): a PERSONAL custom SHARED to a group is offered to
// MEMBERS via {group}, and NEVER to non-members. This is the new indexed read
// path (Codex review P2: replaced the global `charts` scan with by_scope /
// by_owner / by_group reads); the negative case is BOTH the IDOR guarantee AND
// the proof the scan removal did not widen access.
// ===========================================================================

describe("availability: a group-shared personal custom reaches members only", () => {
  test("a non-owner MEMBER sees it via {group}; a non-owner NON-member does not", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const member = await seedUser(t, "member");
    const outsider = await seedUser(t, "outsider");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asOwner = t.withIdentity({ subject: `${owner}|session` });
    const asMember = t.withIdentity({ subject: `${member}|session` });
    const asOutsider = t.withIdentity({ subject: `${outsider}|session` });

    // Owner imports a PERSONAL custom; admin shares it to a group `member` joins.
    const { key } = await importAs(t, asOwner, validImport("Shared"));
    const groupId = await asAdmin.mutation(api.groups.createGroup, {
      name: "Clinique A",
    });
    await asAdmin.mutation(api.groups.addMember, { groupId, userId: member });
    // 3-tier: admin POOLS the owner's personal custom for the group, then SELECTS it.
    await asAdmin.mutation(api.charts.addChartToGroupPool, { groupId, chartKey: key });
    await asAdmin.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: key,
    });
    const group = (await asAdmin.query(api.groups.listGroups, {})).find(
      (g) => g._id === groupId,
    )!;

    // MEMBER (non-owner): offered via {group: <slug>} -- branch (c).
    const memberCharts = await asMember.query(api.charts.listMyCharts, {});
    const memberEntry = memberCharts.find((c) => c.key === key);
    expect(memberEntry?.via).toEqual({ group: group.key });

    // OWNER: still offered, but via "owner" (owner > group precedence).
    const ownerCharts = await asOwner.query(api.charts.listMyCharts, {});
    expect(ownerCharts.find((c) => c.key === key)?.via).toBe("owner");

    // NON-member (the negative case): NEVER offered the shared personal custom.
    const outsiderCharts = await asOutsider.query(api.charts.listMyCharts, {});
    expect(outsiderCharts.some((c) => c.key === key)).toBe(false);
    // And selecting it is rejected by the availability scope, not "unknown key".
    await expect(
      asOutsider.mutation(api.charts.setMyChart, { name: key }),
    ).rejects.toThrow(/not available/);
  });
});

// ===========================================================================
// Impersonation: reads scope to EFFECTIVE; admin mutations key off REAL identity
// ===========================================================================

describe("impersonation: effective reads, real-identity admin mutations", () => {
  test("an admin IMPERSONATING B imports a chart OWNED BY B (effective id), not the admin", async () => {
    const t = convexTest(schema, modules);
    const userB = await seedUser(t, "b");
    const adminId = await seedImpersonatingAdmin(t, userB);
    const asImpersonating = t.withIdentity({ subject: `${adminId}|session` });

    // importChart uses the EFFECTIVE identity for ownerUserId (mirrors setMyChart).
    const { key } = await asImpersonating.mutation(
      api.charts.importChart,
      validImport("Imported as B"),
    );
    const doc = (await allCharts(t)).find((c) => c.key === key)!;
    expect(doc.ownerUserId).toBe(userB); // EFFECTIVE, not the admin's real id
    expect(doc.createdBy).toBe(userB);
    expect(doc.scope).toBe("personal");
  });

  test("an admin IMPERSONATING a permission-less user STILL promotes/sets-default (gate = REAL identity)", async () => {
    const t = convexTest(schema, modules);
    const victimId = await seedUser(t, "victim");
    const adminId = await seedImpersonatingAdmin(t, victimId);
    const asImpersonating = t.withIdentity({ subject: `${adminId}|session` });

    // Import a chart as the victim (effective), then promote it to common as the
    // admin — both reach through the same impersonating identity. promote +
    // setDefault are admin-only; if the gate had dropped to the (effective)
    // permission-less victim these would throw.
    const { key } = await asImpersonating.mutation(
      api.charts.importChart,
      validImport("Victim chart"),
    );
    const chartId = (await allCharts(t)).find((c) => c.key === key)!._id;
    await asImpersonating.mutation(api.charts.promoteChartToCommon, {
      chartId,
    });
    expect((await allCharts(t)).find((c) => c._id === chartId)!.scope).toBe(
      "common",
    );
    // Now a COMMON chart -> the admin can set it as the global default.
    await asImpersonating.mutation(api.charts.setDefaultChart, { name: key });
    const meta = await t.run((ctx) =>
      ctx.db
        .query("appMeta")
        .filter((q) => q.eq(q.field("key"), "singleton"))
        .unique(),
    );
    expect(meta!.defaultThemeName).toBe(key);
  });
});

// ===========================================================================
// VALIDATOR -- attack corpus (PURE function; fast, no DB) + one WIRED end-to-end
// ===========================================================================

describe("validator: attack corpus all REJECTED, valid RE-SERIALIZED", () => {
  // A breakout payload in COLOR-VALUE position (the slot reserializeColor guards).
  function withColor(value: unknown) {
    return { name: "x", tokens: { colors: { light: { background: value } } } };
  }

  test("breakout / url / @import / expression payloads in a color VALUE are all rejected", () => {
    const attacks: unknown[] = [
      "oklch(1 0 0); background:url(//x)", // breakout `;` + url
      "}html{color:red", // breakout `}{`
      "@import url(//evil)", // @import
      "expression(alert(1))", // legacy IE expression
      "url(//evil.example/x.png)", // bare url()
      "var(--secret)", // var() redirection
      "image-set('//x')", // image-set
      "oklch(1 0 0)/**/", // comment breakout
      "oklch(1 0 0)\\", // trailing backslash (CSS escape)
      "#fff", // hex (not oklch)
      "rgb(1,2,3)", // rgb (not oklch)
      "red", // named color
      "hsl(1 2% 3%)", // hsl (not oklch)
      // A stray `(` that is NOT a well-formed anchored oklch. `(` is the ONE char
      // deliberately omitted from FORBIDDEN_SUBSTRINGS (the oklch grammar needs
      // it), so its safety rests ENTIRELY on OKLCH_RE staying fully anchored.
      // These guard that invariant: any future loosening of OKLCH_RE that re-
      // permits a stray `(` would fail here.
      "oklch(1 0 0) calc(1px", // trailing content after a valid oklch
      "foo(", // a bare unrelated `(`
      "oklch(1 0 0)(", // a `(` immediately after the close paren
      // Hue takes no `%` (CSS Color 4: <hue> = <number>|<angle>); a `%` hue is a
      // CSS-invalid color we narrow out at the grammar (NUM_PLAIN for the hue slot).
      "oklch(0.5 0.1 200%)", // percent on the HUE component
    ];
    for (const a of attacks) {
      const res = validateChartImport(withColor(a));
      expect(res.ok, `should reject color value: ${String(a)}`).toBe(false);
    }
    // Discriminating control: `%` on L and chroma IS CSS-valid (each slot accepts
    // a <percentage>), so those must still be ACCEPTED -- the tightening above is
    // narrow (hue only), not a blanket `%` ban.
    expect(validateChartImport(withColor("oklch(50% 0.1 200)")).ok).toBe(true);
    expect(validateChartImport(withColor("oklch(0.5 50% 200)")).ok).toBe(true);
  });

  test("unknown token key, unknown top-level field, non-allowlisted font, oversized + wrong-type values are rejected", () => {
    // Unknown COLOR token key.
    expect(
      validateChartImport({
        name: "x",
        tokens: { colors: { light: { "not-a-token": "oklch(0.5 0.1 200)" } } },
      }).ok,
    ).toBe(false);

    // Unknown TOP-LEVEL field (a different guard path than a bad color value).
    expect(
      validateChartImport({ name: "x", tokens: { colors: { light: {} } }, evil: 1 })
        .ok,
    ).toBe(false);

    // Unknown TOKEN field.
    expect(
      validateChartImport({
        name: "x",
        tokens: { colors: { light: {} }, bogus: "y" },
      }).ok,
    ).toBe(false);

    // Non-allowlisted font (free text -> not in the closed stack set).
    expect(
      validateChartImport({
        name: "x",
        tokens: {
          colors: { light: {} },
          fontSans: "Comic Sans, cursive",
        },
      }).ok,
    ).toBe(false);

    // Oversized color value (> MAX_VALUE_LEN) -> rejected before grammar.
    expect(
      validateChartImport(withColor(`oklch(0.5 0.1 ${"9".repeat(80)})`)).ok,
    ).toBe(false);

    // Wrong TYPE for radius (a number, not a bounded string).
    expect(
      validateChartImport({
        name: "x",
        tokens: { colors: { light: {} }, radius: 5 },
      }).ok,
    ).toBe(false);

    // Bad radius unit.
    expect(
      validateChartImport({
        name: "x",
        tokens: { colors: { light: {} }, radius: "5vw" },
      }).ok,
    ).toBe(false);

    // Empty / oversized name.
    expect(validateChartImport({ name: "", tokens: { colors: { light: {} } } }).ok).toBe(
      false,
    );
    expect(
      validateChartImport({
        name: "n".repeat(80),
        tokens: { colors: { light: {} } },
      }).ok,
    ).toBe(false);
  });

  test("a VALID oklch (odd internal spacing) is ACCEPTED and RE-SERIALIZED to canonical (input != output)", () => {
    // Odd-but-valid spacing -> the stored value MUST be the normalized rebuild, so
    // input != output proves the re-serialization (pass-through would leave it odd).
    const oddInput = "oklch( 0.5  0.1   200 )";
    const res = validateChartImport(withColor(oddInput));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const stored = res.tokens.colors.light.background;
    expect(stored).toBe("oklch(0.5 0.1 200)"); // canonical rebuild
    expect(stored).not.toBe(oddInput); // discriminating: NOT a pass-through

    // Alpha form re-serializes too.
    const alpha = validateChartImport(withColor("oklch( 0.5 0.1 200 / 0.8 )"));
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) throw new Error("unreachable");
    expect(alpha.tokens.colors.light.background).toBe("oklch(0.5 0.1 200 / 0.8)");

    // A valid font + radius pass through the allowlist.
    const full = validateChartImport({
      name: "Full",
      tokens: {
        colors: { light: { background: "oklch(0.98 0.01 230)" }, dark: {} },
        radius: "0.75rem",
        fontSans: FONT_SANS,
      },
    });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error("unreachable");
    expect(full.tokens.radius).toBe("0.75rem");
    expect(full.tokens.fontSans).toBe(FONT_SANS);
  });

  test("WIRED: importChart stores the RE-SERIALIZED tokens (the doc holds the rebuild, never the raw odd string)", async () => {
    const t = convexTest(schema, modules);
    const userA = await seedUser(t, "a");
    const asA = t.withIdentity({ subject: `${userA}|session` });

    // Import with odd-but-valid spacing -> the STORED doc must hold the canonical
    // rebuild (proves the validator is actually wired into the mutation).
    const { key } = await asA.mutation(api.charts.importChart, {
      name: "Wired",
      tokens: {
        colors: {
          light: { background: "oklch( 0.98  0.01  230 )" },
          dark: { background: "oklch(0.2 0.03 245 / 1)" },
        },
      },
    });
    const doc = (await allCharts(t)).find((c) => c.key === key)!;
    expect(doc.tokens.colors.light.background).toBe("oklch(0.98 0.01 230)");
    expect(doc.tokens.colors.dark.background).toBe("oklch(0.2 0.03 245 / 1)");

    // A malicious import is REJECTED with a clean error (the wired reject path).
    await expect(
      asA.mutation(api.charts.importChart, {
        name: "Evil",
        tokens: {
          colors: { light: { background: "oklch(1 0 0); background:url(//x)" } },
        },
      }),
    ).rejects.toThrow(/Invalid chart/);
  });
});

// ===========================================================================
// AVAILABILITY -- personal: owner + group members only; common: all; admin: all
// ===========================================================================

describe("availability: personal vs common vs admin", () => {
  test("a personal chart is visible to its OWNER and to MEMBERS of its groups only; a non-member never sees it", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const member = await seedUser(t, "member");
    const outsider = await seedUser(t, "outsider");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asOwner = t.withIdentity({ subject: `${owner}|session` });

    const groupId = await asAdmin.mutation(api.groups.createGroup, { name: "G" });
    await asAdmin.mutation(api.groups.addMember, { groupId, userId: member });

    // Owner imports a personal chart; the ADMIN makes it available to G (pool +
    // select). The owner is also a member of G, so precedence still gives them "owner".
    await asAdmin.mutation(api.groups.addMember, { groupId, userId: owner });
    const { key } = await importAs(t, asOwner, validImport("Shared personal"));
    await asAdmin.mutation(api.charts.addChartToGroupPool, { groupId, chartKey: key });
    await asAdmin.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: key,
    });
    const groupKey = (await asAdmin.query(api.groups.listGroups, {})).find(
      (g) => g._id === groupId,
    )!.key;

    // Owner sees it via "owner".
    const ownerCharts = await asOwner.query(api.charts.listMyCharts, {});
    const ownerRow = ownerCharts.find((c) => c.key === key)!;
    expect(ownerRow.via).toBe("owner");

    // Member (not owner) sees it via the GROUP provenance.
    const memberCharts = await t
      .withIdentity({ subject: `${member}|session` })
      .query(api.charts.listMyCharts, {});
    const memberRow = memberCharts.find((c) => c.key === key)!;
    expect(memberRow.via).toEqual({ group: groupKey });

    // Outsider (no membership, not owner) NEVER sees it.
    const outsiderCharts = await t
      .withIdentity({ subject: `${outsider}|session` })
      .query(api.charts.listMyCharts, {});
    expect(outsiderCharts.some((c) => c.key === key)).toBe(false);

    // Admin sees ALL (listChartsAdmin includes the custom row with its owner label).
    const adminRows = await asAdmin.query(api.charts.listChartsAdmin, {});
    const adminRow = adminRows.find((r) => r.key === key)!;
    expect(adminRow.kind).toBe("custom");
    expect(adminRow.scope).toBe("personal");
  });

  test("a COMMON chart is offered to every user (owner-independent)", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const stranger = await seedUser(t, "stranger");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asOwner = t.withIdentity({ subject: `${owner}|session` });

    const { chartId, key } = await importAs(t, asOwner, validImport("To promote"));
    await asAdmin.mutation(api.charts.promoteChartToCommon, {
      chartId: chartId as never,
    });

    // A wholly unrelated user (never a member, not the owner) is offered it.
    const strangerCharts = await t
      .withIdentity({ subject: `${stranger}|session` })
      .query(api.charts.listMyCharts, {});
    const row = strangerCharts.find((c) => c.key === key)!;
    expect(row.via).toBe("common");
  });
});

// ===========================================================================
// CASCADE -- deleteChart purges groupCharts + themeName fallback + default clear
// ===========================================================================

describe("cascade: deleteChart purge + fallback + global-default clear", () => {
  test("deleteChart purges groupCharts AND a user whose themeName == the key resolves to default afterwards", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asOwner = t.withIdentity({ subject: `${owner}|session` });

    // Owner imports + selects their own personal chart (own personal => available).
    const { chartId, key } = await importAs(t, asOwner, validImport("Mine"));
    await asOwner.mutation(api.charts.setMyChart, { name: key });

    // Admin makes it available to a group the owner is a member of (pool + select),
    // so groupCharts has a row to prove the deleteChart cascade purges it.
    const groupId = await asAdmin.mutation(api.groups.createGroup, { name: "G" });
    await asAdmin.mutation(api.groups.addMember, { groupId, userId: owner });
    await asAdmin.mutation(api.charts.addChartToGroupPool, { groupId, chartKey: key });
    await asAdmin.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: key,
    });
    expect((await allGroupCharts(t)).length).toBe(1);

    // Before delete: getMe resolves to the user's own pick.
    let me = await asOwner.query(api.me.getMe, {});
    expect(me.resolvedChartKey).toBe(key);

    // Delete the chart (owner path) -> groupCharts purged.
    await asOwner.mutation(api.charts.deleteChart, { chartId: chartId as never });
    expect((await allGroupCharts(t)).length).toBe(0);

    // The owner's themeName still HOLDS the dead key (no profile write), but getMe
    // drops it (it left availableChartsForUser) -> falls back to null/"code".
    me = await asOwner.query(api.me.getMe, {});
    expect(me.chartKey).toBe(key); // raw pref unchanged
    expect(me.resolvedChartKey).toBeNull(); // resolved -> native look
    expect(me.chartSource).toBe("code");
  });

  test("deleting a COMMON-custom that was the admin GLOBAL default clears appMeta.defaultThemeName", async () => {
    // The admin default bypasses the availability check in resolveChart, so a
    // dangling default would point every user at a dead key. deleteChart clears it.
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const owner = await seedUser(t, "owner");
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const asOwner = t.withIdentity({ subject: `${owner}|session` });

    const { chartId, key } = await importAs(t, asOwner, validImport("Default-bound"));
    await asAdmin.mutation(api.charts.promoteChartToCommon, {
      chartId: chartId as never,
    });
    await asAdmin.mutation(api.charts.setDefaultChart, { name: key });

    // The default is set.
    let meta = await t.run((ctx) =>
      ctx.db
        .query("appMeta")
        .filter((q) => q.eq(q.field("key"), "singleton"))
        .unique(),
    );
    expect(meta!.defaultThemeName).toBe(key);

    // Delete it -> the dangling global default is cleared (the extra cascade).
    await asAdmin.mutation(api.charts.deleteChart, { chartId: chartId as never });
    meta = await t.run((ctx) =>
      ctx.db
        .query("appMeta")
        .filter((q) => q.eq(q.field("key"), "singleton"))
        .unique(),
    );
    expect(meta!.defaultThemeName).toBeUndefined();
  });
});
