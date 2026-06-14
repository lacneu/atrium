/// <reference types="vite/client" />
//
// Deterministic unit tests for the review fix-pass (M1, L1, L2, D-2).
//
// Admin paths use t.withIdentity({ subject: `${userId}|session` }) (the same
// pattern as integrations.test.ts) so requireAdmin's REAL-identity gate resolves
// to a seeded admin profile. No @convex-dev/auth session simulation is needed.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedBuiltinRoles } from "./lib/rbac";
import { Id } from "./_generated/dataModel";

// Discover function modules for convex-test (required).
const modules = import.meta.glob("./**/*.ts");

/** Seed an admin user+profile and return an identity-bound test client. */
async function seedAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "admin" });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

describe("M1 — approveUser routes through the last-admin guard", () => {
  test("approveUser refuses to demote the sole admin", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedAdmin(t);

    // Find the admin's own profile id.
    const profileId = await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      return p!._id;
    });

    // Calling approveUser on the SOLE admin would demote it to "user" -> the
    // mirrored guard must reject (previously approveUser bypassed it -> lockout).
    await expect(
      as.mutation(api.admin.approveUser, { profileId }),
    ).rejects.toThrow(/last admin/i);

    // The role is unchanged.
    const role = await t.run(async (ctx) => {
      const p = await ctx.db.get(profileId);
      return p!.role;
    });
    expect(role).toBe("admin");
  });

  test("approveUser clears a stale impersonation target when demoting an admin", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);

    // A SECOND admin (so the guard allows demoting one of them), carrying a
    // stale impersonation target. approveUser -> "user" must clear it.
    const { secondProfileId } = await t.run(async (ctx) => {
      const target = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: target, role: "user" });
      const second = await ctx.db.insert("users", {});
      const secondProfileId = await ctx.db.insert("profiles", {
        userId: second,
        role: "admin",
        impersonatingUserId: target,
      });
      return { secondProfileId };
    });

    await as.mutation(api.admin.approveUser, { profileId: secondProfileId });

    const after = await t.run(async (ctx) => await ctx.db.get(secondProfileId));
    expect(after!.role).toBe("user");
    expect(after!.impersonatingUserId).toBeUndefined();
  });

  test("approveUser still approves a pending user normally", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);
    const pendingProfileId = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", {});
      return await ctx.db.insert("profiles", { userId: u, role: "pending" });
    });
    await as.mutation(api.admin.approveUser, { profileId: pendingProfileId });
    const after = await t.run(async (ctx) => await ctx.db.get(pendingProfileId));
    expect(after!.role).toBe("user");
  });
});

describe("L1 — updateRolePermissions guards the builtin admin wildcard", () => {
  test("rejects downgrading the builtin admin role out of ['*']", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);

    const adminRoleId = await t.run(async (ctx) => {
      await seedBuiltinRoles(ctx);
      const role = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", "admin"))
        .unique();
      return role!._id as Id<"roles">;
    });

    await expect(
      as.mutation(api.apiKeys.updateRolePermissions, {
        roleId: adminRoleId,
        permissions: ["traces.read"], // strips the wildcard
      }),
    ).rejects.toThrow(/wildcard/i);

    // The wildcard is intact.
    const perms = await t.run(async (ctx) => {
      const r = await ctx.db.get(adminRoleId);
      return r!.permissions;
    });
    expect(perms).toEqual(["*"]);
  });

  test("allows editing a NON-admin builtin role's permissions", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);
    const observerRoleId = await t.run(async (ctx) => {
      await seedBuiltinRoles(ctx);
      const role = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", "observer"))
        .unique();
      return role!._id as Id<"roles">;
    });
    await as.mutation(api.apiKeys.updateRolePermissions, {
      roleId: observerRoleId,
      permissions: ["traces.read", "kpi.read"],
    });
    const perms = await t.run(async (ctx) => {
      const r = await ctx.db.get(observerRoleId);
      return r!.permissions;
    });
    expect(perms.sort()).toEqual(["kpi.read", "traces.read"]);
  });
});

describe("L2 — createServiceAccount rejects human roleKeys", () => {
  test.each(["pending", "user", "admin"])(
    "rejects roleKey '%s' for a service account",
    async (roleKey) => {
      const t = convexTest(schema, modules);
      const { as } = await seedAdmin(t);
      await expect(
        as.mutation(api.apiKeys.createServiceAccount, {
          name: `sa-${roleKey}`,
          roleKey,
        }),
      ).rejects.toThrow(/human-only/i);
    },
  );

  test("allows observer/agent and a custom role", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);

    // Built-in service-account roles.
    const obs = await as.mutation(api.apiKeys.createServiceAccount, {
      name: "sa-observer",
      roleKey: "observer",
    });
    expect(obs).not.toBeNull();
    const agent = await as.mutation(api.apiKeys.createServiceAccount, {
      name: "sa-agent",
      roleKey: "agent",
    });
    expect(agent).not.toBeNull();

    // A custom role is allowed once it exists.
    await as.mutation(api.apiKeys.createRole, {
      key: "custom-reader",
      name: "Custom Reader",
      permissions: ["traces.read"],
    });
    const custom = await as.mutation(api.apiKeys.createServiceAccount, {
      name: "sa-custom",
      roleKey: "custom-reader",
    });
    expect(custom).not.toBeNull();
  });
});

describe("D-2 — ensureRolesSeeded seeds built-ins (admin-gated)", () => {
  test("admin can seed; the roles table is populated", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);

    // No roles before seeding.
    const before = await t.run(async (ctx) =>
      ctx.db.query("roles").collect(),
    );
    expect(before.length).toBe(0);

    await as.mutation(api.apiKeys.ensureRolesSeeded, {});

    const after = await t.run(async (ctx) => ctx.db.query("roles").collect());
    const keys = after.map((r) => r.key).sort();
    expect(keys).toEqual(["admin", "agent", "observer", "pending", "user"]);

    // Idempotent: a second call does not duplicate.
    await as.mutation(api.apiKeys.ensureRolesSeeded, {});
    const again = await t.run(async (ctx) => ctx.db.query("roles").collect());
    expect(again.length).toBe(after.length);
  });

  test("a non-admin is rejected", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" });
      return id;
    });
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      asUser.mutation(api.apiKeys.ensureRolesSeeded, {}),
    ).rejects.toThrow(/admin/i);
  });
});
