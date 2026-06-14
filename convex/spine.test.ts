/// <reference types="vite/client" />
//
// Deterministic unit test for the observability/RBAC spine (increment 1).
//
// This test exercises the DETERMINISTIC core only — it does NOT depend on
// @convex-dev/auth session simulation. The key-authed HTTP path (curl) is
// live-verified separately by the lead. Here we:
//   1. seed the built-in roles,
//   2. insert a service account + an apiKey whose hashedKey is the SHA-256 of a
//      known plaintext,
//   3. assert internal.apiKeys.findByHash resolves it (and carries the expanded
//      permission set), and
//   4. assert the pure RBAC engine grants/denies the right permissions.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { hashKey } from "./lib/apikeys";
import {
  permissionsForRoleKey,
  roleHasPermission,
  seedBuiltinRoles,
  PERMISSIONS,
} from "./lib/rbac";

// Discover function modules for convex-test (required).
const modules = import.meta.glob("./**/*.ts");

describe("observability spine", () => {
  test("findByHash resolves a seeded key with its permission set", async () => {
    const t = convexTest(schema, modules);

    const plaintext = "oc_live_test";
    const hashedKey = await hashKey(plaintext);

    // Seed roles + a service account + an API key entirely in db context.
    const { keyId, serviceAccountId } = await t.run(async (ctx) => {
      await seedBuiltinRoles(ctx);

      // A user row to satisfy createdByUserId (no auth needed for the insert).
      const userId = await ctx.db.insert("users", {});

      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: "obs-test",
        roleKey: "observer",
        disabled: false,
        createdByUserId: userId,
      });

      const keyId = await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey,
        prefix: "oc_live_test",
        lastFour: "test",
        disabled: false,
        createdAt: Date.now(),
      });

      return { keyId, serviceAccountId };
    });

    // The internal verification query resolves the key by hash and enriches it
    // with the service account + expanded permission set.
    const resolved = await t.query(internal.apiKeys.findByHash, {
      hash: hashedKey,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.key._id).toEqual(keyId);
    expect(resolved!.serviceAccount._id).toEqual(serviceAccountId);
    expect(resolved!.roleKey).toEqual("observer");
    // observer carries traces.read but NOT admin.manage.
    expect(resolved!.permissions).toContain(PERMISSIONS.TRACES_READ);
    expect(resolved!.permissions).not.toContain(PERMISSIONS.ADMIN_MANAGE);

    // A non-existent hash resolves to null.
    const missing = await t.query(internal.apiKeys.findByHash, {
      hash: "deadbeef".repeat(8),
    });
    expect(missing).toBeNull();
  });

  test("rbac engine grants/denies per role", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await seedBuiltinRoles(ctx);

      const observerPerms = await permissionsForRoleKey(ctx, "observer");
      expect(roleHasPermission(observerPerms, PERMISSIONS.TRACES_READ)).toBe(
        true,
      );
      // Observer is the read-only OBSERVABILITY role: bridge compat/version
      // (GET /api/v1/compat) is observability, so it MUST be granted — without
      // it the key-authed compat route is unreachable by any service account.
      expect(roleHasPermission(observerPerms, PERMISSIONS.BRIDGE_READ)).toBe(
        true,
      );
      // ...but it stays READ-ONLY: no write perms (agent's anomalies.report) and
      // no admin.
      expect(
        roleHasPermission(observerPerms, PERMISSIONS.ANOMALIES_REPORT),
      ).toBe(false);
      expect(roleHasPermission(observerPerms, PERMISSIONS.ADMIN_MANAGE)).toBe(
        false,
      );

      // agent is a SUPERSET of observer's read access: it carries bridge.read
      // (compat) too, PLUS its write perm (anomalies.report). So an agent key
      // can reach /api/v1/compat (the observer-vs-agent gap that 403'd compat).
      const agentPerms = await permissionsForRoleKey(ctx, "agent");
      expect(roleHasPermission(agentPerms, PERMISSIONS.BRIDGE_READ)).toBe(true);
      expect(roleHasPermission(agentPerms, PERMISSIONS.TRACES_READ)).toBe(true);
      expect(roleHasPermission(agentPerms, PERMISSIONS.ANOMALIES_REPORT)).toBe(
        true,
      );
      expect(roleHasPermission(agentPerms, PERMISSIONS.ADMIN_MANAGE)).toBe(false);

      // admin is the wildcard superset -> every permission.
      const adminPerms = await permissionsForRoleKey(ctx, "admin");
      expect(roleHasPermission(adminPerms, PERMISSIONS.ADMIN_MANAGE)).toBe(true);
      expect(roleHasPermission(adminPerms, PERMISSIONS.TRACES_READ)).toBe(true);

      // unknown role -> empty set -> no permissions (least privilege).
      const unknownPerms = await permissionsForRoleKey(ctx, "nope");
      expect(roleHasPermission(unknownPerms, PERMISSIONS.TRACES_READ)).toBe(
        false,
      );
    });
  });

  // Load-bearing for the prod fix: a deployment seeded BEFORE bridge.read was
  // added to the observer definition holds a stale `roles` row. The next
  // re-seed (lazy on listRoles/mintApiKey, or at deploy) MUST reconcile the
  // drift and grant bridge.read — otherwise the observer key keeps getting 403
  // on /api/v1/compat even after the code ships. This pins that migration.
  test("re-seed reconciles a pre-existing observer role missing bridge.read", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Simulate the deployed-prod state (observer row WITHOUT bridge.read).
      await ctx.db.insert("roles", {
        key: "observer",
        name: "Observer",
        description: "Read-only observability service account.",
        builtin: true,
        permissions: [
          PERMISSIONS.TRACES_READ,
          PERMISSIONS.KPI_READ,
          PERMISSIONS.ANOMALIES_READ,
        ],
      });

      const before = await permissionsForRoleKey(ctx, "observer");
      expect(roleHasPermission(before, PERMISSIONS.BRIDGE_READ)).toBe(false);

      // Deploy-time / hot-path re-seed reconciles the drift.
      await seedBuiltinRoles(ctx);

      const after = await permissionsForRoleKey(ctx, "observer");
      expect(roleHasPermission(after, PERMISSIONS.BRIDGE_READ)).toBe(true);
      // Existing grants survive the reconcile (no clobber).
      expect(roleHasPermission(after, PERMISSIONS.TRACES_READ)).toBe(true);
      expect(roleHasPermission(after, PERMISSIONS.KPI_READ)).toBe(true);
    });
  });

  // Built-in roles carry a non-empty, DISTINCT description (the user couldn't
  // tell observer from agent). seedBuiltinRoles also reconciles a stale stored
  // description onto the canonical one — same drift path as the perms above.
  test("seedBuiltinRoles writes distinct descriptions + reconciles a stale one", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", {
        key: "observer",
        name: "Observer",
        description: "old terse desc",
        builtin: true,
        permissions: [PERMISSIONS.TRACES_READ],
      });
      await seedBuiltinRoles(ctx);
      const observer = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", "observer"))
        .unique();
      const agent = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", "agent"))
        .unique();
      expect(observer?.description).toBeTruthy();
      expect(observer?.description).not.toBe("old terse desc"); // reconciled
      expect(agent?.description).toBeTruthy();
      expect(observer?.description).not.toBe(agent?.description); // distinct
    });
  });
});
