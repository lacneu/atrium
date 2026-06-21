/// <reference types="vite/client" />
//
// Tier-1 admin chart POOL (groupChartPool) — Phase B step 1 (INERT). Pins:
//  - addChartToGroupPool / removeChartFromGroupPool are ADMIN-ONLY: a non-admin
//    who is even a MANAGER of the group (groups.manage + groupMembers.manager) is
//    REFUSED, and no pool row is created (the pool is NOT delegated — that is the
//    whole point of the 3-tier split). Each gate test negates the side-effect.
//  - the pool validates the chart key (builtin OR custom) and is idempotent.
//  - removeChartFromGroupPool CASCADES: it drops the group's Tier-2 selection
//    (groupCharts) of that chart, taking its isDefault with it.
//  - deleteGroup purges the pool; deleteChart purges the pool by key.
//  - INERT: a chart in the POOL only (not selected into groupCharts) does NOT
//    change availability — a pooled builtin stays "common", a pooled custom is
//    NOT offered to a member. Availability still flows through groupCharts alone.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { availableChartsForUser } from "./charts";
import { BUILTIN_CHARTS } from "./lib/charts";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const as = (t: TestConvex<typeof schema>, uid: Id<"users">) =>
  t.withIdentity({ subject: `${uid}|session` });

const FIRST_KEY = BUILTIN_CHARTS[0]!.key;
const SECOND_KEY = BUILTIN_CHARTS[1]!.key;
const THIRD_KEY = BUILTIN_CHARTS[2]!.key;

// The chartKeys a group currently has flagged as its DEFAULT (should be 0 or 1).
const defaultKeys = (t: TestConvex<typeof schema>, groupId: Id<"groups">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("groupCharts").collect())
      .filter((r) => r.groupId === groupId && r.isDefault === true)
      .map((r) => r.chartKey),
  );

// Seed: an admin, a non-admin MANAGER of group G (groups.manage + manager flag),
// a plain member, plus group G. Mirrors groupDelegation.test.ts.
async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    const mgr = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: mgr,
      role: "user",
      extraPermissions: ["groups.manage"],
    });
    const member = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: member, role: "user" });
    const G = await ctx.db.insert("groups", {
      key: "g",
      name: "G",
      createdBy: admin,
      createdAt: 1,
    });
    await ctx.db.insert("groupMembers", {
      groupId: G,
      userId: mgr,
      joinedAt: 1,
      manager: true,
    });
    await ctx.db.insert("groupMembers", {
      groupId: G,
      userId: member,
      joinedAt: 1,
    });
    return { admin, mgr, member, G };
  });
}

// JS-side reads — a TestConvex param keeps the data model, but we filter in memory
// to dodge the index-typing friction the sibling tests call out.
const poolRows = (t: TestConvex<typeof schema>, groupId: Id<"groups">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("groupChartPool").collect()).filter(
      (r) => r.groupId === groupId,
    ),
  );
const selectionRows = (t: TestConvex<typeof schema>, groupId: Id<"groups">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("groupCharts").collect()).filter(
      (r) => r.groupId === groupId,
    ),
  );

// Insert a PERSONAL custom chart directly (no importChart dependency here).
async function seedCustomChart(
  t: TestConvex<typeof schema>,
  owner: Id<"users">,
  key: string,
): Promise<Id<"charts">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("charts", {
      key,
      name: key,
      scope: "personal",
      ownerUserId: owner,
      tokens: { colors: { light: {}, dark: {} } },
      createdBy: owner,
      createdAt: 1,
    }),
  );
}

describe("groupChartPool — admin-only writes (Tier 1 is NOT delegated)", () => {
  test("admin adds a builtin to the pool; a manager of the group is REFUSED", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);

    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    expect((await poolRows(t, G)).map((r) => r.chartKey)).toEqual([FIRST_KEY]);

    // A manager of THIS group (groups.manage + manager flag) still cannot touch the
    // pool — Tier 1 is admin-only. Refused AND no second row appears.
    await expect(
      as(t, mgr).mutation(api.charts.addChartToGroupPool, {
        groupId: G,
        chartKey: SECOND_KEY,
      }),
    ).rejects.toThrow();
    expect((await poolRows(t, G)).map((r) => r.chartKey)).toEqual([FIRST_KEY]);

    // The manager cannot remove from the pool either (and the row survives).
    await expect(
      as(t, mgr).mutation(api.charts.removeChartFromGroupPool, {
        groupId: G,
        chartKey: FIRST_KEY,
      }),
    ).rejects.toThrow();
    expect((await poolRows(t, G)).map((r) => r.chartKey)).toEqual([FIRST_KEY]);
  });

  test("pool rejects an unknown chart key and is idempotent on re-add", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await expect(
      as(t, admin).mutation(api.charts.addChartToGroupPool, {
        groupId: G,
        chartKey: "does-not-exist",
      }),
    ).rejects.toThrow(/Unknown chart/);
    expect(await poolRows(t, G)).toHaveLength(0);

    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    expect(await poolRows(t, G)).toHaveLength(1); // no duplicate
  });

  test("a CUSTOM chart key is accepted in the pool", async () => {
    const t = convexTest(schema, modules);
    const { admin, member, G } = await seed(t);
    await seedCustomChart(t, member, "mychart-abc");
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: "mychart-abc",
    });
    expect((await poolRows(t, G)).map((r) => r.chartKey)).toEqual([
      "mychart-abc",
    ]);
  });
});

describe("removeChartFromGroupPool cascades to the Tier-2 selection", () => {
  test("removing a pooled chart drops the group's selection + its default", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    // Simulate a Tier-2 selection that picked FIRST_KEY as the group default
    // (the manager-selection mutation lands in step 2; seed the row directly).
    await t.run((ctx) =>
      ctx.db.insert("groupCharts", {
        groupId: G,
        chartKey: FIRST_KEY,
        isDefault: true,
        createdAt: 2,
      }),
    );
    expect(await selectionRows(t, G)).toHaveLength(1);

    await as(t, admin).mutation(api.charts.removeChartFromGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    // BOTH the pool row AND the selection (with its default) are gone — if the
    // cascade regressed, the selection (and a dangling default) would survive.
    expect(await poolRows(t, G)).toHaveLength(0);
    expect(await selectionRows(t, G)).toHaveLength(0);
  });

  test("removeChartFromGroupPool is idempotent (no pool row -> no-op)", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await as(t, admin).mutation(api.charts.removeChartFromGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    expect(await poolRows(t, G)).toHaveLength(0);
  });
});

describe("pool cascades on delete", () => {
  test("deleteGroup purges the group's pool rows", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    await as(t, admin).mutation(api.groups.deleteGroup, { groupId: G });
    expect(await t.run((ctx) => ctx.db.query("groupChartPool").collect())).toHaveLength(0);
  });

  test("deleteChart purges the pool rows referencing that chart key", async () => {
    const t = convexTest(schema, modules);
    const { admin, member, G } = await seed(t);
    const chartId = await seedCustomChart(t, member, "mychart-del");
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: "mychart-del",
    });
    expect(await poolRows(t, G)).toHaveLength(1);
    await as(t, admin).mutation(api.charts.deleteChart, { chartId });
    expect(await poolRows(t, G)).toHaveLength(0);
  });
});

describe("Tier-2 default election (exactly-one default while >=1 selection)", () => {
  // Pool all three builtins for G so they are selectable.
  async function poolAll(t: TestConvex<typeof schema>, admin: Id<"users">, G: Id<"groups">) {
    for (const k of [FIRST_KEY, SECOND_KEY, THIRD_KEY]) {
      await as(t, admin).mutation(api.charts.addChartToGroupPool, {
        groupId: G,
        chartKey: k,
      });
    }
  }

  test("first selection becomes default; a later one keeps it (exactly one)", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await poolAll(t, admin, G);
    await as(t, admin).mutation(api.charts.assignChartToGroup, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    expect(await defaultKeys(t, G)).toEqual([FIRST_KEY]); // first => auto-default
    await as(t, admin).mutation(api.charts.assignChartToGroup, {
      groupId: G,
      chartKey: SECOND_KEY,
    });
    expect(await defaultKeys(t, G)).toEqual([FIRST_KEY]); // unchanged, still exactly one
  });

  test("setGroupDefaultChart switches the default; rejects a non-selected chart", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await poolAll(t, admin, G);
    for (const k of [FIRST_KEY, SECOND_KEY]) {
      await as(t, admin).mutation(api.charts.assignChartToGroup, {
        groupId: G,
        chartKey: k,
      });
    }
    await as(t, admin).mutation(api.charts.setGroupDefaultChart, {
      groupId: G,
      chartKey: SECOND_KEY,
    });
    expect(await defaultKeys(t, G)).toEqual([SECOND_KEY]); // switched, exactly one
    // THIRD_KEY is pooled but NOT selected -> cannot be the default.
    await expect(
      as(t, admin).mutation(api.charts.setGroupDefaultChart, {
        groupId: G,
        chartKey: THIRD_KEY,
      }),
    ).rejects.toThrow(/not selected by this group/);
    expect(await defaultKeys(t, G)).toEqual([SECOND_KEY]); // unchanged after the reject
  });

  test("unselecting the default re-elects another; unselecting the last clears it", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await poolAll(t, admin, G);
    for (const k of [FIRST_KEY, SECOND_KEY]) {
      await as(t, admin).mutation(api.charts.assignChartToGroup, {
        groupId: G,
        chartKey: k,
      });
    }
    expect(await defaultKeys(t, G)).toEqual([FIRST_KEY]);
    // Remove the default -> the remaining selection is re-elected as default.
    await as(t, admin).mutation(api.charts.removeChartFromGroup, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    expect(await defaultKeys(t, G)).toEqual([SECOND_KEY]);
    // Remove the last selection -> no default remains.
    await as(t, admin).mutation(api.charts.removeChartFromGroup, {
      groupId: G,
      chartKey: SECOND_KEY,
    });
    expect(await defaultKeys(t, G)).toEqual([]);
  });

  test("removeChartFromGroupPool re-elects the default among the survivors", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await poolAll(t, admin, G);
    for (const k of [FIRST_KEY, SECOND_KEY]) {
      await as(t, admin).mutation(api.charts.assignChartToGroup, {
        groupId: G,
        chartKey: k,
      });
    }
    expect(await defaultKeys(t, G)).toEqual([FIRST_KEY]); // first is the default
    // Remove the DEFAULT chart from the pool -> its selection cascades out AND a new
    // default must be re-elected among survivors. Without the cascade re-election the
    // group would be left with a selection but NO default (invariant broken).
    await as(t, admin).mutation(api.charts.removeChartFromGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    expect(await selectionRows(t, G)).toHaveLength(1);
    expect(await defaultKeys(t, G)).toEqual([SECOND_KEY]);
  });

  test("deleteChart re-elects the default among the survivors of each affected group", async () => {
    const t = convexTest(schema, modules);
    const { admin, member, G } = await seed(t);
    const chartId = await seedCustomChart(t, member, "cust-default");
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: "cust-default",
    });
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    for (const k of ["cust-default", FIRST_KEY]) {
      await as(t, admin).mutation(api.charts.assignChartToGroup, {
        groupId: G,
        chartKey: k,
      });
    }
    await as(t, admin).mutation(api.charts.setGroupDefaultChart, {
      groupId: G,
      chartKey: "cust-default",
    });
    expect(await defaultKeys(t, G)).toEqual(["cust-default"]);
    // Deleting the custom chart purges its selection across groups; each affected
    // group must re-elect a default (else G is left selected-but-default-less).
    await as(t, admin).mutation(api.charts.deleteChart, { chartId });
    expect(await selectionRows(t, G)).toHaveLength(1);
    expect(await defaultKeys(t, G)).toEqual([FIRST_KEY]);
  });

  test("a group MANAGER can select + set default; a plain member cannot", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await poolAll(t, admin, G);
    // The manager of G selects + sets a default (delegated Tier-2).
    await as(t, mgr).mutation(api.charts.assignChartToGroup, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    await as(t, mgr).mutation(api.charts.assignChartToGroup, {
      groupId: G,
      chartKey: SECOND_KEY,
    });
    await as(t, mgr).mutation(api.charts.setGroupDefaultChart, {
      groupId: G,
      chartKey: SECOND_KEY,
    });
    expect(await defaultKeys(t, G)).toEqual([SECOND_KEY]);
    // A plain member (no groups.manage) cannot select.
    await expect(
      as(t, member).mutation(api.charts.assignChartToGroup, {
        groupId: G,
        chartKey: THIRD_KEY,
      }),
    ).rejects.toThrow(/missing permission groups\.manage/);
  });
});

describe("INERT: the pool does not change availability in step 1", () => {
  test("a pooled-but-not-selected builtin stays common; a pooled custom is NOT offered", async () => {
    const t = convexTest(schema, modules);
    const { admin, member, G } = await seed(t);
    // Add a builtin AND a personal custom (owned by someone else) to G's pool only.
    const other = await t.run((ctx) => ctx.db.insert("users", {}));
    await t.run((ctx) =>
      ctx.db.insert("profiles", { userId: other, role: "user" }),
    );
    await seedCustomChart(t, other, "pooled-custom");
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: FIRST_KEY,
    });
    await as(t, admin).mutation(api.charts.addChartToGroupPool, {
      groupId: G,
      chartKey: "pooled-custom",
    });

    // The member sees the builtin as COMMON (the pool did NOT restrict it: that is
    // groupCharts' job), and the pooled custom is OMITTED (the pool grants no
    // availability — only a groupCharts selection would). No groupCharts row exists.
    expect(await selectionRows(t, G)).toHaveLength(0);
    const offered = await t.run((ctx) => availableChartsForUser(ctx, member));
    const builtin = offered.find((c) => c.key === FIRST_KEY)!;
    expect(builtin.via).toBe("common");
    expect(offered.some((c) => c.key === "pooled-custom")).toBe(false);
  });
});
