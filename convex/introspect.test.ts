/// <reference types="vite/client" />
//
// Introspection (P5). Pins the READ-ONLY admin aggregation `introspectUser`:
//  - GATE: the ONE real surface. The aggregation exposes ANOTHER user's access
//    map, so it gates on admin against the REAL identity. A real non-admin is
//    rejected; an admin who is IMPERSONATING a regular user is STILL allowed
//    (requirePermission keys off rawUserId, never the effective id).
//  - AGGREGATION: provenance flows through verbatim from the reused helpers -- a
//    group member inherits the group's agent AND chart with via={group}; a direct
//    grant is via="user"; an owned custom chart is via="owner"; an unrestricted
//    builtin is via="common"; effective permissions = role matrix UNION
//    extraPermissions (admin's wildcard already expanded to the flat key set).
//  - EMPTY: a user with no groups/agents/charts yields empty sections, NOT an error.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { BUILTIN_CHARTS } from "./lib/charts";

const modules = import.meta.glob("./**/*.ts");

// ---------------------------------------------------------------------------
// Seed helpers (mirror groups.test.ts / agents.test.ts idioms).
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

// A discovered + present agent on an instance whose discovery succeeded -- the
// state combo that resolves to "ok" in enrichUserAgents (same helper as
// groups.test.ts). Idempotent on (instance, discovery) so two agents can share
// an instance without duplicate rows.
async function seedLiveAgent(
  t: ReturnType<typeof convexTest>,
  instanceName: string,
  agentId: string,
  opts: { displayName?: string } = {},
) {
  await t.run(async (ctx) => {
    const instances = await ctx.db.query("instances").collect();
    if (!instances.some((i) => i.name === instanceName)) {
      await ctx.db.insert("instances", {
        name: instanceName,
        gatewayUrl: `ws://${instanceName}`,
        kind: "openclaw" as const,
      });
    }
    const discovery = await ctx.db.query("instanceDiscovery").collect();
    if (!discovery.some((d) => d.instanceName === instanceName)) {
      await ctx.db.insert("instanceDiscovery", {
        instanceName,
        lastPollAt: 1,
        lastPollOk: true,
        lastOkAt: 1,
      });
    }
    await ctx.db.insert("agents", {
      instanceName,
      agentId,
      source: "discovered" as const,
      presentInLastOk: true,
      displayName: opts.displayName ?? agentId.toUpperCase(),
      isDefaultOnInstance: false,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
  });
}

// An unrestricted builtin (zero groupCharts rows) -> COMMON for everyone, and a
// builtin we'll RESTRICT to a group below -> reachable only via that membership.
const COMMON_KEY = BUILTIN_CHARTS[0]!.key; // e.g. "ocean"
const RESTRICTED_KEY = BUILTIN_CHARTS[1]!.key; // e.g. "forest"

// Insert a minimal valid custom PERSONAL chart owned by `ownerId` (via="owner"
// for the owner; the tokens shape mirrors the schema's colors.{light,dark}).
async function seedOwnedChart(
  t: ReturnType<typeof convexTest>,
  ownerId: string,
  key: string,
  name: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("charts", {
      key,
      name,
      scope: "personal" as const,
      ownerUserId: ownerId as never,
      tokens: { colors: { light: {}, dark: {} } },
      createdBy: ownerId as never,
      createdAt: 1,
    }),
  );
}

// ===========================================================================
// GATE -- the one real surface (admin on the REAL identity; impersonation OK)
// ===========================================================================

describe("introspectUser gate keys off the REAL identity", () => {
  test("a real NON-admin user is rejected (admin.manage not held)", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedUser(t, "target");
    const nonAdminId = await seedUser(t, "intruder");
    const asUser = t.withIdentity({ subject: `${nonAdminId}|session` });
    await expect(
      asUser.query(api.introspect.introspectUser, { userId: targetId }),
    ).rejects.toThrow(/missing permission admin\.manage/);
  });

  test("an admin IMPERSONATING a regular user is STILL allowed (gate = real id, not effective)", async () => {
    // requirePermission(ADMIN_MANAGE) keys off rawUserId (the REAL signed-in
    // identity), never the impersonated/effective one. So an admin whose
    // EFFECTIVE id is a permission-less regular user must STILL pass the gate. If
    // the gate had dropped to the effective id this would throw; success proves
    // the real-identity contract (mirrors groups.test.ts).
    const t = convexTest(schema, modules);
    const regularId = await seedUser(t, "victim");
    const adminId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin" as const,
        impersonatingUserId: regularId, // admin is acting AS the regular user
      });
      return uid;
    });
    const asImpersonatingAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const result = await asImpersonatingAdmin.query(
      api.introspect.introspectUser,
      { userId: regularId },
    );
    // Succeeds despite the effective user being permission-less; the introspected
    // map is the TARGET's (regularId), not the admin's.
    expect(result.user.userId).toBe(regularId);
    expect(result.role).toBe("user");
  });
});

// ===========================================================================
// AGGREGATION -- provenance flows through verbatim from the reused helpers
// ===========================================================================

describe("introspectUser aggregates provenance for an arbitrary user", () => {
  test("a MEMBER of a group holding an agent AND a chart shows BOTH with via={group}; permissions = role baseline", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "shared", { displayName: "SHARED" });

    // A group that shares ONE agent and RESTRICTS one builtin chart to itself.
    const groupId = await as.mutation(api.groups.createGroup, { name: "Clinique A" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "shared",
    });
    // 3-tier: admin POOLS the chart for the group, then SELECTS it (Tier 2).
    await as.mutation(api.charts.addChartToGroupPool, {
      groupId,
      chartKey: RESTRICTED_KEY,
    });
    await as.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: RESTRICTED_KEY,
    });
    // Capture the real slug `key` (via carries the slug, not the name).
    const group = (await as.query(api.groups.listGroups, {})).find(
      (g) => g._id === groupId,
    )!;
    const key = group.key;

    const result = await as.query(api.introspect.introspectUser, {
      userId: memberId,
    });

    // user label + role.
    expect(result.user.userId).toBe(memberId);
    expect(result.role).toBe("user");

    // groups section: the single membership, projected to {groupId, key, name}.
    expect(result.groups).toEqual([
      { groupId, key, name: "Clinique A" },
    ]);

    // agents section: the group agent, via={group} (NOT held directly).
    expect(result.agents.length).toBe(1);
    const agent = result.agents[0];
    expect(agent.agentId).toBe("shared");
    expect(agent.displayName).toBe("SHARED");
    expect(agent.state).toBe("ok");
    expect(agent.via).toEqual({ group: key });
    // Sole group agent with no direct default -> elected the effective default.
    expect(agent.isDefault).toBe(true);
    // Projection is a SUBSET of EnrichedUserAgent (no source/emoji/model/kind).
    expect(Object.keys(agent).sort()).toEqual(
      ["agentId", "displayName", "instanceName", "isDefault", "state", "via"].sort(),
    );

    // charts section: the COMMON builtin (via="common") AND the group-restricted
    // builtin (via={group}). The restricted builtin is reachable ONLY because the
    // user is a member -- the discriminating assertion.
    const common = result.charts.find((c) => c.key === COMMON_KEY)!;
    const restricted = result.charts.find((c) => c.key === RESTRICTED_KEY)!;
    expect(common.via).toBe("common");
    expect(restricted.via).toEqual({ group: key });
    // Projection is a SUBSET of OfferedChart (only key/name/via -- no tokens/kind).
    expect(Object.keys(common).sort()).toEqual(["key", "name", "via"].sort());

    // permissions = the "user" role baseline (chats.read) UNION no extra grants.
    expect(result.permissions).toEqual(["chats.read"]);
  });

  test("a DIRECT agent shows via='user'; an OWNED custom chart shows via='owner'", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    await seedLiveAgent(t, "prod", "direct", { displayName: "DIRECT" });
    // Direct userAgents grant (no group at all).
    await t.run((ctx) =>
      ctx.db.insert("userAgents", {
        userId,
        instanceName: "prod",
        agentId: "direct",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      }),
    );
    // A personal custom chart OWNED by the user -> via="owner".
    await seedOwnedChart(t, userId, "my-theme", "My Theme");

    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const result = await as.query(api.introspect.introspectUser, { userId });

    // agents: the direct grant, via="user".
    expect(result.agents.length).toBe(1);
    expect(result.agents[0].agentId).toBe("direct");
    expect(result.agents[0].via).toBe("user");
    expect(result.agents[0].isDefault).toBe(true);

    // charts: the owned custom (via="owner") plus the COMMON builtins (via="common").
    const owned = result.charts.find((c) => c.key === "my-theme")!;
    expect(owned.via).toBe("owner");
    expect(owned.name).toBe("My Theme");
    // Every builtin is unrestricted here -> all common; none carries a group via.
    const builtins = result.charts.filter((c) => c.key !== "my-theme");
    expect(builtins.length).toBe(BUILTIN_CHARTS.length);
    expect(builtins.every((c) => c.via === "common")).toBe(true);

    // No group membership.
    expect(result.groups).toEqual([]);
  });

  test("effective permissions reflect role + extraPermissions (granted read tab)", async () => {
    const t = convexTest(schema, modules);
    // A user with an admin-granted extra read permission (per-tab RBAC grant).
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "granted",
        extraPermissions: ["traces.read"],
      });
      return uid;
    });
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const result = await as.query(api.introspect.introspectUser, { userId });

    expect(result.role).toBe("user");
    // role baseline (chats.read) UNION the granted extra (traces.read), sorted.
    expect(result.permissions).toEqual(["chats.read", "traces.read"]);
  });

  test("an ADMIN target's wildcard is EXPANDED into the flat permission key set (not a literal '*')", async () => {
    const t = convexTest(schema, modules);
    const targetAdminId = await seedAdmin(t);
    const callerAdminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${callerAdminId}|session` });
    const result = await as.query(api.introspect.introspectUser, {
      userId: targetAdminId,
    });

    expect(result.role).toBe("admin");
    // The wildcard expands to concrete keys -> admin.manage is present, "*" is NOT.
    expect(result.permissions).toContain("admin.manage");
    expect(result.permissions).toContain("chats.read");
    expect(result.permissions).not.toContain("*");
  });
});

// ===========================================================================
// EMPTY -- no groups/agents/charts is a valid (empty) map, never an error
// ===========================================================================

describe("introspectUser tolerates a user with nothing", () => {
  test("no groups / no agents / no owned charts -> empty sections, not an error", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "lonely");
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const result = await as.query(api.introspect.introspectUser, { userId });

    expect(result.user.userId).toBe(userId);
    expect(result.role).toBe("user");
    expect(result.groups).toEqual([]);
    expect(result.agents).toEqual([]);
    // Charts is NOT empty -- every unrestricted builtin is common to all users --
    // but it carries zero group/owner provenance for a user with nothing.
    expect(result.charts.length).toBe(BUILTIN_CHARTS.length);
    expect(result.charts.every((c) => c.via === "common")).toBe(true);
    // permissions = the plain "user" role baseline.
    expect(result.permissions).toEqual(["chats.read"]);
  });
});
