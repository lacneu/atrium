/// <reference types="vite/client" />
//
// Per-tab RBAC — the SECURITY-critical core: the grant whitelist (a non-admin can
// never receive admin.manage or any non-observability perm, even via a direct
// mutation call) + effective permission resolution (role ∪ extraPermissions).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { effectiveUserPermissions } from "./lib/access";
import { isGrantableUserPermission } from "./lib/rbac";

const modules = import.meta.glob("./**/*.ts");

describe("isGrantableUserPermission (server-side grant whitelist)", () => {
  test("only the read-only observability perms are grantable", () => {
    expect(isGrantableUserPermission("traces.read")).toBe(true);
    expect(isGrantableUserPermission("kpi.read")).toBe(true);
    expect(isGrantableUserPermission("anomalies.read")).toBe(true);
    expect(isGrantableUserPermission("bridge.read")).toBe(true);
    // agents.files.read (CONF-4c): read-only, server-restricted to rule files.
    expect(isGrantableUserPermission("agents.files.read")).toBe(true);
  });
  test("admin.manage and any sensitive/unknown perm are NOT grantable", () => {
    expect(isGrantableUserPermission("admin.manage")).toBe(false);
    expect(isGrantableUserPermission("chats.read")).toBe(false);
    expect(isGrantableUserPermission("traces.write")).toBe(false);
    expect(isGrantableUserPermission("openclaw.query")).toBe(false);
    expect(isGrantableUserPermission("garbage")).toBe(false);
  });
});

describe("effectiveUserPermissions (role ∪ extraPermissions)", () => {
  test("a user role + granted extras = the union", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user",
        extraPermissions: ["traces.read", "bridge.read"],
      });
      return uid;
    });
    const perms = await t.run(async (ctx) => [
      ...(await effectiveUserPermissions(ctx, userId)),
    ]);
    expect(perms).toContain("chats.read"); // from the "user" role
    expect(perms).toContain("traces.read"); // granted extra
    expect(perms).toContain("bridge.read"); // granted extra
    expect(perms).not.toContain("admin.manage"); // never
  });

  test("admin resolves to the wildcard superset", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "admin" });
      return uid;
    });
    const perms = await t.run(async (ctx) => [
      ...(await effectiveUserPermissions(ctx, userId)),
    ]);
    expect(perms).toContain("admin.manage");
    expect(perms).toContain("traces.read");
  });
});

describe("admin.setUserPermissions (write path enforces the whitelist)", () => {
  async function seedAdminAndTarget(t: ReturnType<typeof convexTest>) {
    const adminId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "admin" });
      return uid;
    });
    const targetProfileId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      return ctx.db.insert("profiles", { userId: uid, role: "user" });
    });
    return { as: t.withIdentity({ subject: `${adminId}|session` }), targetProfileId };
  }

  test("grantable perms are written", async () => {
    const t = convexTest(schema, modules);
    const { as, targetProfileId } = await seedAdminAndTarget(t);
    await as.mutation(api.admin.setUserPermissions, {
      profileId: targetProfileId,
      permissions: ["traces.read", "bridge.read"],
    });
    const p = await t.run((ctx) => ctx.db.get(targetProfileId));
    expect([...(p!.extraPermissions ?? [])].sort()).toEqual([
      "bridge.read",
      "traces.read",
    ]);
  });

  test("admin.manage is REJECTED (no escalation to sensitive tabs)", async () => {
    const t = convexTest(schema, modules);
    const { as, targetProfileId } = await seedAdminAndTarget(t);
    await expect(
      as.mutation(api.admin.setUserPermissions, {
        profileId: targetProfileId,
        permissions: ["admin.manage"],
      }),
    ).rejects.toThrow(/not grantable/);
  });

  test("a non-grantable perm anywhere in the list rejects the whole call", async () => {
    const t = convexTest(schema, modules);
    const { as, targetProfileId } = await seedAdminAndTarget(t);
    await expect(
      as.mutation(api.admin.setUserPermissions, {
        profileId: targetProfileId,
        permissions: ["traces.read", "chats.read"],
      }),
    ).rejects.toThrow(/not grantable/);
    const p = await t.run((ctx) => ctx.db.get(targetProfileId));
    expect(p!.extraPermissions).toBeUndefined(); // nothing written
  });
});
