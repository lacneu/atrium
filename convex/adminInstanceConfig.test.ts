/// <reference types="vite/client" />
//
// upsertInstanceConfig: admin-only (BRIDGE_CONFIG_WRITE via the admin wildcard,
// never grantable to a non-admin), persists a valid config, and rejects an
// out-of-range value the closed validator alone can't catch (parseInstanceConfig).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>, role: "admin" | "user") {
  const { userId, instanceId } = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role });
    const iid = await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://gw:18790",
    });
    return { userId: uid, instanceId: iid };
  });
  return { as: t.withIdentity({ subject: `${userId}|session` }), instanceId };
}

describe("admin.upsertInstanceConfig", () => {
  test("an admin persists a valid config onto the instance row", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.mutation(api.admin.upsertInstanceConfig, {
      instanceId,
      config: { mediaMode: "shared-fs", rehydration: false },
    });
    const inst = await t.run((ctx) => ctx.db.get(instanceId));
    expect(inst?.config).toEqual({ mediaMode: "shared-fs", rehydration: false });
  });

  test("a NON-admin is refused (missing bridge.config.write) and the row is untouched", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "user");
    await expect(
      as.mutation(api.admin.upsertInstanceConfig, {
        instanceId,
        config: { mediaMode: "off" },
      }),
    ).rejects.toThrow(/bridge\.config\.write/);
    const inst = await t.run((ctx) => ctx.db.get(instanceId));
    expect(inst?.config).toBeUndefined(); // never written
  });

  test("an out-of-range mediaMaxMb is rejected (validator passes the number, parse bounds it)", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await expect(
      as.mutation(api.admin.upsertInstanceConfig, {
        instanceId,
        config: { mediaMaxMb: 99999 },
      }),
    ).rejects.toThrow(/Invalid instance config/);
    const inst = await t.run((ctx) => ctx.db.get(instanceId));
    expect(inst?.config).toBeUndefined();
  });

  test("an empty config clears overrides (stores {})", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.mutation(api.admin.upsertInstanceConfig, {
      instanceId,
      config: { mediaMode: "off" },
    });
    await as.mutation(api.admin.upsertInstanceConfig, {
      instanceId,
      config: {},
    });
    const inst = await t.run((ctx) => ctx.db.get(instanceId));
    expect(inst?.config).toEqual({});
  });
});

describe("admin.upsertInstance rename guard", () => {
  test("editing an instance with a CHANGED name is rejected (the name is the routing key)", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await expect(
      as.mutation(api.admin.upsertInstance, {
        instanceId, // edit mode + a different name = a rename attempt
        name: "renamed",
        gatewayUrl: "ws://gw:18790",
      }),
    ).rejects.toThrow(/instance_rename_not_supported/);
    // Regression guard: drop the guard and the row is renamed while agents/
    // userAgents/chats/discovery still reference "primary" -> orphaned routing.
    const inst = await t.run((ctx) => ctx.db.get(instanceId));
    expect(inst?.name).toBe("primary");
  });

  test("editing with the SAME name updates the other fields normally", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.mutation(api.admin.upsertInstance, {
      instanceId,
      name: "primary", // unchanged -> not a rename
      gatewayUrl: "ws://gw:NEW",
    });
    const inst = await t.run((ctx) => ctx.db.get(instanceId));
    expect(inst?.name).toBe("primary");
    expect(inst?.gatewayUrl).toBe("ws://gw:NEW");
  });
});
