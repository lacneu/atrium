/// <reference types="vite/client" />
//
// RBAC delegation for groups (Phase A). `groups.manage` is grantable; a non-admin
// holder manages ONLY the groups they are a MANAGER of (groupMembers.manager).
// Structural ops (create/delete/rename) + promoting a manager stay ADMIN-ONLY.
// These tests pin each gate — the crux of the phase (admin can X; manager can X on
// THEIR group, not others; non-managers refused).

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const as = (t: TestConvex<typeof schema>, uid: Id<"users">) =>
  t.withIdentity({ subject: `${uid}|session` });

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    // mgr: non-admin WITH the grantable groups.manage permission.
    const mgr = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: mgr,
      role: "user",
      extraPermissions: ["groups.manage"],
    });
    // plain: non-admin WITHOUT groups.manage.
    const plain = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: plain, role: "user" });
    const target = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: target, role: "user" });

    const G = await ctx.db.insert("groups", {
      key: "g",
      name: "G",
      createdBy: admin,
      createdAt: 1,
    });
    const H = await ctx.db.insert("groups", {
      key: "h",
      name: "H",
      createdBy: admin,
      createdAt: 2,
    });
    // mgr MANAGES G; mgr is only a plain member of H.
    await ctx.db.insert("groupMembers", {
      groupId: G,
      userId: mgr,
      joinedAt: 1,
      manager: true,
    });
    await ctx.db.insert("groupMembers", { groupId: H, userId: mgr, joinedAt: 1 });

    await ctx.db.insert("instances", { name: "primary", gatewayUrl: "ws://gw" });
    await ctx.db.insert("agents", {
      instanceName: "primary",
      agentId: "alice",
      source: "discovered",
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    return { admin, mgr, plain, target, G, H };
  });
}

const memberCount = (t: TestConvex<typeof schema>, groupId: Id<"groups">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("groupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", groupId))
        .collect()
    ).length,
  );

describe("structural ops are admin-only (create/delete/rename/promote)", () => {
  test("a group MANAGER cannot create, delete, rename, or promote", async () => {
    const t = convexTest(schema, modules);
    const { mgr, target, G } = await seed(t);
    await expect(
      as(t, mgr).mutation(api.groups.createGroup, { name: "X" }),
    ).rejects.toThrow();
    await expect(
      as(t, mgr).mutation(api.groups.deleteGroup, { groupId: G }),
    ).rejects.toThrow();
    await expect(
      as(t, mgr).mutation(api.groups.updateGroup, { groupId: G, name: "G2" }),
    ).rejects.toThrow();
    await expect(
      as(t, mgr).mutation(api.groups.setGroupManager, {
        groupId: G,
        userId: target,
        manager: true,
      }),
    ).rejects.toThrow();
  });

  test("an admin can create + promote; promote requires membership", async () => {
    const t = convexTest(schema, modules);
    const { admin, plain, target, G } = await seed(t);
    await as(t, admin).mutation(api.groups.createGroup, { name: "X" }); // ok
    // target is NOT a member of G → promote refused.
    await expect(
      as(t, admin).mutation(api.groups.setGroupManager, {
        groupId: G,
        userId: target,
        manager: true,
      }),
    ).rejects.toThrow(/not a member/);
    // add then promote works.
    await as(t, admin).mutation(api.groups.addMember, {
      groupId: G,
      userId: plain,
    });
    await as(t, admin).mutation(api.groups.setGroupManager, {
      groupId: G,
      userId: plain,
      manager: true,
    });
  });
});

describe("delegated content ops are scoped to the manager's own groups", () => {
  test("manager of G manages G's membership, but NOT H's", async () => {
    const t = convexTest(schema, modules);
    const { mgr, target, G, H } = await seed(t);
    // manage own group G → ok.
    await as(t, mgr).mutation(api.groups.addMember, {
      groupId: G,
      userId: target,
    });
    expect(await memberCount(t, G)).toBe(2); // mgr + target
    // H (mgr is only a plain member, not manager) → refused.
    await expect(
      as(t, mgr).mutation(api.groups.addMember, { groupId: H, userId: target }),
    ).rejects.toThrow(/not a manager/);
  });

  test("manager of G manages G's agents, but NOT H's", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G, H } = await seed(t);
    await as(t, mgr).mutation(api.groups.assignAgentToGroup, {
      groupId: G,
      instanceName: "primary",
      agentId: "alice",
    });
    await expect(
      as(t, mgr).mutation(api.groups.assignAgentToGroup, {
        groupId: H,
        instanceName: "primary",
        agentId: "alice",
      }),
    ).rejects.toThrow(/not a manager/);
  });

  test("a non-admin WITHOUT groups.manage is refused entirely", async () => {
    const t = convexTest(schema, modules);
    const { plain, target, G } = await seed(t);
    await expect(
      as(t, plain).mutation(api.groups.addMember, { groupId: G, userId: target }),
    ).rejects.toThrow(/missing permission/);
  });
});

describe("listGroups + getGroup scoping", () => {
  test("admin sees all groups; a manager sees only the groups they manage", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr } = await seed(t);
    const adminList = await as(t, admin).query(api.groups.listGroups, {});
    expect(adminList.map((g) => g.name).sort()).toEqual(["G", "H"]);
    const mgrList = await as(t, mgr).query(api.groups.listGroups, {});
    expect(mgrList.map((g) => g.name)).toEqual(["G"]); // NOT H (only a member there)
  });

  test("getGroup: manager of G may open G, not H", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G, H } = await seed(t);
    const g = await as(t, mgr).query(api.groups.getGroup, { groupId: G });
    expect(g.group.name).toBe("G");
    await expect(
      as(t, mgr).query(api.groups.getGroup, { groupId: H }),
    ).rejects.toThrow(/not a manager/);
  });
});

const membership = (
  t: TestConvex<typeof schema>,
  groupId: Id<"groups">,
  userId: Id<"users">,
) =>
  t.run((ctx) =>
    ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) =>
        q.eq("userId", userId).eq("groupId", groupId),
      )
      .unique(),
  );

describe("a manager membership may only be removed by an ADMIN (#1)", () => {
  test("a delegated manager CANNOT remove a CO-MANAGER (would bypass admin-only promote)", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, target, G } = await seed(t);
    // Admin makes `target` a CO-MANAGER of G (member first, then promote).
    await as(t, admin).mutation(api.groups.addMember, { groupId: G, userId: target });
    await as(t, admin).mutation(api.groups.setGroupManager, {
      groupId: G,
      userId: target,
      manager: true,
    });
    // mgr (a manager of G) tries to remove the co-manager → refused.
    await expect(
      as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: target }),
    ).rejects.toThrow(/only an admin can remove a group manager/);
    // Regression guard: drop the check and the co-manager is silently demoted.
    expect((await membership(t, G, target))?.manager).toBe(true);
  });

  test("a manager CAN remove a NON-manager member; an admin CAN remove a manager", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, target, G } = await seed(t);
    await as(t, admin).mutation(api.groups.addMember, { groupId: G, userId: target });
    // mgr removes a plain (non-manager) member → allowed.
    await as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: target });
    expect(await membership(t, G, target)).toBeNull();
    // Re-add + promote → only the ADMIN can remove the manager.
    await as(t, admin).mutation(api.groups.addMember, { groupId: G, userId: target });
    await as(t, admin).mutation(api.groups.setGroupManager, {
      groupId: G,
      userId: target,
      manager: true,
    });
    await as(t, admin).mutation(api.groups.removeMember, { groupId: G, userId: target });
    expect(await membership(t, G, target)).toBeNull();
  });

  test("bulkSetMembers: a manager removing a set with a co-manager aborts the WHOLE batch", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, target, plain, G } = await seed(t);
    await as(t, admin).mutation(api.groups.addMember, { groupId: G, userId: target });
    await as(t, admin).mutation(api.groups.setGroupManager, {
      groupId: G,
      userId: target,
      manager: true,
    });
    await as(t, admin).mutation(api.groups.addMember, { groupId: G, userId: plain });
    await expect(
      as(t, mgr).mutation(api.groups.bulkSetMembers, {
        groupId: G,
        userIds: [plain, target],
        member: false,
      }),
    ).rejects.toThrow(/only an admin can remove a group manager/);
    // Atomic: the plain member was NOT removed either (whole batch rolled back).
    expect(await membership(t, G, plain)).not.toBeNull();
    expect((await membership(t, G, target))?.manager).toBe(true);
  });
});

describe("delegation-safe directory queries (#2)", () => {
  test("a manager lists assignable users/instances/agents; a plain user is refused", async () => {
    const t = convexTest(schema, modules);
    const { mgr, plain } = await seed(t);
    const users = await as(t, mgr).query(api.groups.listAssignableUsers, {});
    expect(users.length).toBeGreaterThan(0);
    // BOUNDED: the sensitive grant list is NEVER exposed to a delegated manager.
    expect(users.every((u) => !("extraPermissions" in u))).toBe(true);
    const instances = await as(t, mgr).query(
      api.groups.listAssignableInstances,
      {},
    );
    expect(instances.some((i) => i.name === "primary")).toBe(true);
    expect(instances.every((i) => !("gatewayUrl" in i))).toBe(true);
    const agents = await as(t, mgr).query(api.groups.listAssignableAgents, {
      instanceName: "primary",
    });
    expect(agents.agents.some((a) => a.agentId === "alice")).toBe(true);
    // A plain user (no groups.manage, not admin) is refused on each.
    await expect(
      as(t, plain).query(api.groups.listAssignableUsers, {}),
    ).rejects.toThrow();
    await expect(
      as(t, plain).query(api.groups.listAssignableInstances, {}),
    ).rejects.toThrow();
    await expect(
      as(t, plain).query(api.groups.listAssignableAgents, {
        instanceName: "primary",
      }),
    ).rejects.toThrow();
  });
});
