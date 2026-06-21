/// <reference types="vite/client" />
//
// Phase 1 (INERT) admin curation: enable/disable a discovered agent + pick the
// per-instance default. These writes are stored but not yet enforced; the tests
// pin the WRITE logic (admin gate, default-consistency on disable, default must be
// enabled) so Phase 2/3 build on a correct base.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: TestConvex<typeof schema>, role: "admin" | "user") {
  const { userId, instanceId } = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role });
    const iid = await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://gw:18790",
    });
    const base = {
      instanceName: "primary",
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    await ctx.db.insert("agents", { ...base, agentId: "alice" });
    await ctx.db.insert("agents", { ...base, agentId: "bob" });
    return { userId: uid, instanceId: iid };
  });
  return { as: t.withIdentity({ subject: `${userId}|session` }), instanceId };
}

const agentEnabled = (t: TestConvex<typeof schema>, agentId: string) =>
  t.run(async (ctx) => {
    const a = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", "primary").eq("agentId", agentId),
      )
      .unique();
    return a?.enabled;
  });
const instDefault = (t: TestConvex<typeof schema>, instanceId: Id<"instances">) =>
  t.run(async (ctx) => (await ctx.db.get(instanceId))?.defaultAgentId);

describe("setAgentEnabled", () => {
  test("admin enables/disables a discovered agent", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "admin");
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: true,
    });
    expect(await agentEnabled(t, "alice")).toBe(true);
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: false,
    });
    expect(await agentEnabled(t, "alice")).toBe(false);
  });

  test("a non-admin is refused", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "user");
    await expect(
      as.mutation(api.agents.setAgentEnabled, {
        instanceName: "primary",
        agentId: "alice",
        enabled: true,
      }),
    ).rejects.toThrow();
    expect(await agentEnabled(t, "alice")).toBeNull(); // untouched
  });

  test("enabling the first/only selected agent auto-sets it as default", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: true,
    });
    expect(await instDefault(t, instanceId)).toBe("alice"); // auto — never "enabled, no default"
    // Enabling a SECOND agent keeps the existing default.
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "bob",
      enabled: true,
    });
    expect(await instDefault(t, instanceId)).toBe("alice");
  });

  test("disabling the default re-elects another enabled agent; the last one clears it", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: true,
    });
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "bob",
      enabled: true,
    });
    expect(await instDefault(t, instanceId)).toBe("alice"); // first enabled
    // Disable the default (alice) → re-elect the remaining enabled (bob).
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: false,
    });
    expect(await instDefault(t, instanceId)).toBe("bob");
    // Disable the LAST enabled (bob) → 0 selected → default cleared (allowed).
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "bob",
      enabled: false,
    });
    expect(await instDefault(t, instanceId)).toBeNull();
  });
});

describe("setInstanceDefaultAgent", () => {
  test("sets the default only for an ENABLED agent; rejects a disabled one", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    // bob is not enabled → refused.
    await expect(
      as.mutation(api.agents.setInstanceDefaultAgent, {
        instanceName: "primary",
        agentId: "bob",
      }),
    ).rejects.toThrow(/enabled/);
    expect(await instDefault(t, instanceId)).toBeNull();
    // enable then set.
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "bob",
      enabled: true,
    });
    await as.mutation(api.agents.setInstanceDefaultAgent, {
      instanceName: "primary",
      agentId: "bob",
    });
    expect(await instDefault(t, instanceId)).toBe("bob");
  });

  test("a non-admin is refused", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "user");
    await expect(
      as.mutation(api.agents.setInstanceDefaultAgent, {
        instanceName: "primary",
        agentId: "alice",
      }),
    ).rejects.toThrow();
    expect(await instDefault(t, instanceId)).toBeNull();
  });
});

describe("removeInstanceAgent (absent agent cleanup + cascade)", () => {
  test("removes an ABSENT agent and cascades to group/user selections", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "admin");
    // Make "ghost" an absent (gateway-removed) agent + give it to a user AND a group.
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "ghost",
        source: "discovered",
        presentInLastOk: false, // gateway no longer reports it
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "primary",
        agentId: "ghost",
        isDefault: true,
        source: "manual",
        createdAt: 1,
      });
      const gid = await ctx.db.insert("groups", {
        key: "g1",
        name: "G1",
        createdBy: uid,
        createdAt: 1,
      });
      await ctx.db.insert("groupAgents", {
        groupId: gid,
        instanceName: "primary",
        agentId: "ghost",
        createdAt: 1,
      });
    });

    await as.mutation(api.agents.removeInstanceAgent, {
      instanceName: "primary",
      agentId: "ghost",
    });

    const left = await t.run(async (ctx) => ({
      agent: await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", "primary").eq("agentId", "ghost"),
        )
        .unique(),
      userRefs: (
        await ctx.db
          .query("userAgents")
          .withIndex("by_instance_agent", (q) =>
            q.eq("instanceName", "primary").eq("agentId", "ghost"),
          )
          .collect()
      ).length,
      groupRefs: (
        await ctx.db
          .query("groupAgents")
          .withIndex("by_instance", (q) => q.eq("instanceName", "primary"))
          .collect()
      ).filter((r) => r.agentId === "ghost").length,
    }));
    expect(left.agent).toBeNull(); // agent row gone
    expect(left.userRefs).toBe(0); // user selection cascaded
    expect(left.groupRefs).toBe(0); // group selection cascaded
  });

  test("re-elects a user's DIRECT default when the purged agent was it (user keeps others)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "admin"); // instance primary + alice/bob
    const uid = await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "ghost",
        source: "discovered",
        presentInLastOk: false, // absent → removable
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      const uid = await ctx.db.insert("users", {});
      // ghost is the user's DEFAULT; alice is a second (non-default) grant.
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "primary",
        agentId: "ghost",
        isDefault: true,
        source: "manual",
        createdAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "primary",
        agentId: "alice",
        isDefault: false,
        source: "manual",
        createdAt: 2,
      });
      return uid;
    });

    await as.mutation(api.agents.removeInstanceAgent, {
      instanceName: "primary",
      agentId: "ghost",
    });

    // ghost gone AND the user's default re-elected to their remaining agent.
    // Regression guard: without the re-election the user has an agent but NO default.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("userAgents")
        .withIndex("by_user", (q) => q.eq("userId", uid))
        .collect(),
    );
    expect(rows.map((r) => r.agentId)).toEqual(["alice"]);
    expect(rows[0].isDefault).toBe(true);
  });

  test("REFUSES to remove a still-present agent (disable it instead)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "admin"); // alice/bob are presentInLastOk:true
    await expect(
      as.mutation(api.agents.removeInstanceAgent, {
        instanceName: "primary",
        agentId: "alice",
      }),
    ).rejects.toThrow(/still present/);
  });

  test("a non-admin is refused", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "user");
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "ghost",
        source: "discovered",
        presentInLastOk: false,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    });
    await expect(
      as.mutation(api.agents.removeInstanceAgent, {
        instanceName: "primary",
        agentId: "ghost",
      }),
    ).rejects.toThrow();
  });
});

describe("default election excludes ABSENT agents (#2)", () => {
  // An enabled agent GONE from the gateway (presentInLastOk:false) must never be the
  // instance default — the UI hides absent agents, so it would read as "no default".
  const addAbsentEnabled = (t: TestConvex<typeof schema>, agentId: string) =>
    t.run((ctx) =>
      ctx.db.insert("agents", {
        instanceName: "primary",
        agentId,
        source: "discovered" as const,
        presentInLastOk: false, // ABSENT
        firstSeenAt: 1,
        lastSeenAt: 1,
        enabled: true,
      }),
    );

  test("disabling the default re-elects a PRESENT agent, never an absent one", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin"); // alice, bob (present)
    // "aaa" is enabled+ABSENT and sorts FIRST — without the present-filter the
    // election (sorted ids[0]) would wrongly pick it.
    await addAbsentEnabled(t, "aaa");
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: true,
    });
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "bob",
      enabled: true,
    });
    // alice is the default; disable it → re-elect from PRESENT+enabled = [bob].
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: false,
    });
    expect(await instDefault(t, instanceId)).toBe("bob"); // never the absent "aaa"
  });

  test("an already-absent default is HEALED when toggling a different agent", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    // Malformed pre-state: the default points at an enabled+ABSENT agent.
    await addAbsentEnabled(t, "ghost");
    await t.run(async (ctx) => {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .unique();
      await ctx.db.patch(inst!._id, { defaultAgentId: "ghost" });
    });
    // Enable a PRESENT agent (alice) — a DIFFERENT agent than the absent default.
    await as.mutation(api.agents.setAgentEnabled, {
      instanceName: "primary",
      agentId: "alice",
      enabled: true,
    });
    // Regression guard: without the eligibility heal, the default stays "ghost"
    // (still enabled → looked valid) and the instance shows an agent with no default.
    expect(await instDefault(t, instanceId)).toBe("alice");
  });

  test("setInstanceDefaultAgent refuses an ABSENT (but enabled) agent", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seed(t, "admin");
    await addAbsentEnabled(t, "ghost");
    await expect(
      as.mutation(api.agents.setInstanceDefaultAgent, {
        instanceName: "primary",
        agentId: "ghost",
      }),
    ).rejects.toThrow(/absent from the gateway/);
  });
});
