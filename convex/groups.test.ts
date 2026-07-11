/// <reference types="vite/client" />
//
// Groups (P2). Pins the admin CRUD + cascades, and — the sensitive part — the
// user<->agent UNION computed at READ time (getEffectiveGrants / enrichUserAgents):
//  - a group member inherits the group's agents (via:{group}); DIRECT WINS on dedup;
//  - effective default precedence: direct default > group default > native > code;
//  - the HARD INVARIANT: with NO group the enriched output is identical to pre-P2
//    (same agents/order, same default, same states) — pinned with a discriminating
//    fixture (3 grants, mixed states, NON-first default), NOT a co-false stub.
//  - RBAC keys off the REAL identity: groups.manage is admin-only AND an admin who
//    is IMPERSONATING a regular user STILL manages groups (proves the gate never
//    drops to the effective id), while a real non-admin is rejected.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { getEffectiveGrants, effectiveAgentsForUsers } from "./agents";

const modules = import.meta.glob("./**/*.ts");

// ---------------------------------------------------------------------------
// Seed helpers (mirror agents.test.ts / files.test.ts idioms).
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

// A discovered + present agent on an instance whose discovery succeeded — the
// state combo that resolves to "ok" in enrichUserAgents. Reusable for every test
// that needs a live agent.
async function seedLiveAgent(
  t: ReturnType<typeof convexTest>,
  instanceName: string,
  agentId: string,
  opts: { displayName?: string; isDefaultOnInstance?: boolean } = {},
) {
  await t.run(async (ctx) => {
    // JS-filter the existence checks: a `t`-derived `ctx` loses the inferred data
    // model, so `withIndex(...)` would fail typecheck (same workaround as `uaOf`/
    // `agentsOf` in the existing tests). Tables are tiny in-test → collect is fine.
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
      // seedLiveAgent = a LIVE, usable agent → enabled (opt-in enforcement).
      enabled: true,
      displayName: opts.displayName ?? agentId.toUpperCase(),
      isDefaultOnInstance: opts.isDefaultOnInstance ?? false,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
  });
}

// JS-side table reads — a `t: ReturnType<typeof convexTest>` PARAMETER loses the
// inferred data model, so `withIndex(...)` fails typecheck (same workaround the
// existing agents/files tests call out). Filter in memory instead.
const rowsOf = (t: ReturnType<typeof convexTest>, table: "groupMembers" | "groupAgents") =>
  t.run((ctx) => ctx.db.query(table).collect());

// ===========================================================================
// CRUD + cascade
// ===========================================================================

describe("groups CRUD + cascade", () => {
  test("createGroup -> listGroups (counts), updateGroup patches name (key immutable)", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });

    const groupId = await as.mutation(api.groups.createGroup, {
      name: "Clinique A",
      description: "first",
    });
    let listed = await as.query(api.groups.listGroups, {});
    expect(listed.length).toBe(1);
    expect(listed[0]._id).toBe(groupId);
    expect(listed[0].name).toBe("Clinique A");
    expect(listed[0].description).toBe("first");
    expect(listed[0].memberCount).toBe(0);
    expect(listed[0].agentCount).toBe(0);
    const keyBefore = listed[0].key;
    expect(keyBefore).toBe("clinique-a"); // slugified

    await as.mutation(api.groups.updateGroup, {
      groupId,
      name: "Clinique B",
    });
    listed = await as.query(api.groups.listGroups, {});
    expect(listed[0].name).toBe("Clinique B");
    expect(listed[0].key).toBe(keyBefore); // key is the immutable provenance token
    expect(listed[0].description).toBe("first"); // untouched (not provided)

    // An EMPTY-STRING description on edit actually CLEARS it (the edit form sends
    // the raw "" to mean "remove"); `undefined` would mean "don't touch".
    await as.mutation(api.groups.updateGroup, { groupId, description: "" });
    listed = await as.query(api.groups.listGroups, {});
    expect(listed[0].description ?? null).toBeNull(); // field removed, not "first"

    // A non-empty description still SETS it.
    await as.mutation(api.groups.updateGroup, { groupId, description: "second" });
    listed = await as.query(api.groups.listGroups, {});
    expect(listed[0].description).toBe("second");
  });

  test("createGroup collision → unique key suffix (-2)", async () => {
    const t = convexTest(schema, modules);
    const as = t.withIdentity({ subject: `${await seedAdmin(t)}|session` });
    await as.mutation(api.groups.createGroup, { name: "Team" });
    await as.mutation(api.groups.createGroup, { name: "Team" });
    const keys = (await as.query(api.groups.listGroups, {})).map((g) => g.key).sort();
    expect(keys).toEqual(["team", "team-2"]);
  });

  test("deleteGroup CASCADE: members + agents purged, no orphans", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "alice");

    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "alice",
    });
    expect((await rowsOf(t, "groupMembers")).length).toBe(1);
    expect((await rowsOf(t, "groupAgents")).length).toBe(1);

    await as.mutation(api.groups.deleteGroup, { groupId });

    // The group + ALL its members + ALL its shared agents are gone (no orphan).
    expect(await t.run((ctx) => ctx.db.get(groupId))).toBeNull();
    expect((await rowsOf(t, "groupMembers")).length).toBe(0);
    expect((await rowsOf(t, "groupAgents")).length).toBe(0);
    expect((await as.query(api.groups.listGroups, {})).length).toBe(0);

    // Idempotent: a second delete is a no-op (does not throw).
    await as.mutation(api.groups.deleteGroup, { groupId });
  });
});

// ===========================================================================
// Membership + agent assignment (dedup + discovery precondition)
// ===========================================================================

describe("members + group agents", () => {
  test("addMember/removeMember are idempotent (no double row)", async () => {
    const t = convexTest(schema, modules);
    const as = t.withIdentity({ subject: `${await seedAdmin(t)}|session` });
    const userId = await seedUser(t, "member");
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });

    await as.mutation(api.groups.addMember, { groupId, userId });
    await as.mutation(api.groups.addMember, { groupId, userId }); // dedup
    expect((await rowsOf(t, "groupMembers")).length).toBe(1);

    await as.mutation(api.groups.removeMember, { groupId, userId });
    expect((await rowsOf(t, "groupMembers")).length).toBe(0);
    // Idempotent remove (no throw, no negative).
    await as.mutation(api.groups.removeMember, { groupId, userId });
    expect((await rowsOf(t, "groupMembers")).length).toBe(0);
  });

  test("assignAgentToGroup REJECTS a non-discovered / not-present agent; dedup on the valid one", async () => {
    const t = convexTest(schema, modules);
    const as = t.withIdentity({ subject: `${await seedAdmin(t)}|session` });
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });

    // (a) agent that was never discovered → rejected (mirrors assignAgent).
    await expect(
      as.mutation(api.groups.assignAgentToGroup, {
        groupId,
        instanceName: "prod",
        agentId: "ghost",
      }),
    ).rejects.toThrow(/not assignable/);

    // (b) a DISCOVERED but now-DELETED agent (presentInLastOk:false) → rejected too.
    await t.run((ctx) =>
      ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "gone",
        source: "discovered" as const,
        presentInLastOk: false, enabled: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      }),
    );
    await expect(
      as.mutation(api.groups.assignAgentToGroup, {
        groupId,
        instanceName: "prod",
        agentId: "gone",
      }),
    ).rejects.toThrow(/not assignable/);

    // (c) a discovered + present agent → accepted; second call dedups.
    await seedLiveAgent(t, "prod", "alice");
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "alice",
    });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "alice",
    });
    expect((await rowsOf(t, "groupAgents")).length).toBe(1);

    // (d) a discovered + present but admin-DISABLED agent (enabled:false) →
    // rejected: a disabled agent must not be shareable to a group.
    await t.run((ctx) =>
      ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "metis",
        source: "discovered" as const,
        presentInLastOk: true,
        enabled: false,
        firstSeenAt: 1,
        lastSeenAt: 1,
      }),
    );
    await expect(
      as.mutation(api.groups.assignAgentToGroup, {
        groupId,
        instanceName: "prod",
        agentId: "metis",
      }),
    ).rejects.toThrow(/not assignable/);
    // bulk assign skips it too (no throw, no row).
    await as.mutation(api.groups.bulkSetGroupAgents, {
      groupId,
      instanceName: "prod",
      agentIds: ["metis"],
      assigned: true,
    });
    expect((await rowsOf(t, "groupAgents")).length).toBe(1);
  });
});

// ===========================================================================
// UNION read (the sensitive edit) — via:{group}, precedence, regression guard
// ===========================================================================

describe("agents union via groups", () => {
  test("UNION: a MEMBER inherits the group's agent X (not held directly) with via={group:key}", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "shared", { displayName: "SHARED" });

    const groupId = await as.mutation(api.groups.createGroup, { name: "Shared Team" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "shared",
    });
    // Capture the real slug `key` from the created group (do NOT hardcode the
    // slugify output — `via` carries the slug, not the name).
    const key = (await as.query(api.groups.listGroups, {})).find(
      (g) => g._id === groupId,
    )!.key;

    const asMember = t.withIdentity({ subject: `${memberId}|session` });
    const agents = await asMember.query(api.agents.listMyAgents, {});
    expect(agents.length).toBe(1);
    const x = agents[0];
    expect(x.agentId).toBe("shared");
    expect(x.displayName).toBe("SHARED");
    expect(x.state).toBe("ok");
    expect(x.via).toEqual({ group: key }); // provenance = the slug
    // Group-only sole agent → elected the effective default via Tier 3 (code).
    expect(x.isDefault).toBe(true);

    // listMyGroups exposes the membership (introspection foundation).
    const myGroups = await asMember.query(api.groups.listMyGroups, {});
    expect(myGroups).toEqual([{ groupId, key, name: "Shared Team" }]);
  });

  test("EDITOR (listUserAgents): DIRECT grants ONLY — a group-inherited agent is EXCLUDED, the direct default star preserved", async () => {
    // The Users-Access editor MUTATES the userAgents table (assign/remove/
    // setDefaultAgent all key on a direct row). It must therefore show ONLY direct
    // grants: a group-INHERITED agent has no userAgents row, so removeAgent would
    // no-op and setDefaultAgent would throw (Codex review). The full union WITH
    // provenance is the read-only Accès tab, exercised via listMyAgents below.
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "direct", { displayName: "DIRECT" });
    await seedLiveAgent(t, "prod", "shared", { displayName: "SHARED" });

    // A DIRECT grant (mutable by the editor), marked default.
    await t.run((ctx) =>
      ctx.db.insert("userAgents", {
        userId: memberId,
        instanceName: "prod",
        agentId: "direct",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      }),
    );
    // A group-shared agent the member only INHERITS (no userAgents row).
    const groupId = await as.mutation(api.groups.createGroup, { name: "Team" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "shared",
    });
    const profileId = await t.run(async (ctx) => {
      const p = (await ctx.db.query("profiles").collect()).find(
        (r) => r.userId === memberId,
      );
      return p!._id;
    });

    // The EFFECTIVE read (listMyAgents) follows the CASCADE: the member is IN a
    // group, so their pool is the group's agents ("shared"); the direct grant
    // "direct" is OUTSIDE the group, so the in-group restriction drops it — the
    // member sees only "shared". (A direct grant WITHIN the group would narrow to
    // it; one outside the group has no effect.)
    const effective = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    expect(effective.map((a) => a.agentId).sort()).toEqual(["shared"]);

    // The EDITOR reads RAW direct rows (NOT the effective cascade), so the admin
    // can still MANAGE the out-of-group direct grant: it shows "direct" with
    // via="user" and its isDefault star, even though the cascade dropped it from
    // the member's effective set.
    const editor = await as.query(api.agents.listUserAgents, { profileId });
    expect(editor.length).toBe(1);
    expect(editor[0].agentId).toBe("direct");
    expect(editor[0].via).toBe("user");
    expect(editor[0].isDefault).toBe(true);
  });

  test("EDITOR (listUserAgents): a user whose ONLY agent is via a group gets an EMPTY editor list", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "shared", { displayName: "SHARED" });

    const groupId = await as.mutation(api.groups.createGroup, { name: "Team" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "shared",
    });
    const profileId = await t.run(async (ctx) => {
      const p = (await ctx.db.query("profiles").collect()).find(
        (r) => r.userId === memberId,
      );
      return p!._id;
    });

    // Union sees the inherited agent; the editor (direct-only) is EMPTY.
    const union = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    expect(union.length).toBe(1);
    const editor = await as.query(api.agents.listUserAgents, { profileId });
    expect(editor).toEqual([]);
  });

  test("NO group + NO direct grants → the member sees EVERY discovered agent (the unconstrained default)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "free");
    // Three discovered agents across instances; the user has no group, no grant.
    await seedLiveAgent(t, "prod", "alpha");
    await seedLiveAgent(t, "prod", "beta");
    await seedLiveAgent(t, "lab", "gamma");
    const agents = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agents.listMyAgents, {});
    // Unconstrained: all three, each via "all". (Pre-cascade a groupless user with
    // no direct grants got an EMPTY set — the discriminating new behavior.)
    expect(agents.map((a) => a.agentId).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(agents.every((a) => a.via === "all")).toBe(true);
  });

  test("CASCADE: a direct grant WITHIN the group narrows to it; the group's own default is moot", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "a-direct", { displayName: "A" });
    await seedLiveAgent(t, "prod", "b-group", { displayName: "B" });

    // Group GB shares BOTH agents; B is marked the GROUP default.
    const groupId = await as.mutation(api.groups.createGroup, { name: "GB" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    for (const agentId of ["a-direct", "b-group"]) {
      await as.mutation(api.groups.assignAgentToGroup, {
        groupId,
        instanceName: "prod",
        agentId,
      });
    }
    await t.run(async (ctx) => {
      const ga = (await ctx.db.query("groupAgents").collect()).find(
        (g) => g.agentId === "b-group",
      )!;
      await ctx.db.patch(ga._id, { isDefault: true }); // group default = B
    });

    // The member DIRECTLY selects A (which IS within the group pool), as default.
    await t.run((ctx) =>
      ctx.db.insert("userAgents", {
        userId: memberId,
        instanceName: "prod",
        agentId: "a-direct",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      }),
    );

    // CASCADE: the direct selection RESTRICTS within the group pool, so the member
    // sees ONLY A. B is dropped — once the user narrows, the group's own default is
    // moot (the discriminating fact: union semantics would still surface B).
    const agents = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    expect(agents.map((g) => g.agentId)).toEqual(["a-direct"]);
    expect(agents[0].isDefault).toBe(true);
    expect(agents[0].via).toBe("user");
  });

  test("ELECTION Tier 1: NO direct default + a group default B → B is the effective default (group default wins, no direct override)", async () => {
    // Exercises the otherwise-uncovered Tier 1 of getEffectiveGrants: with ZERO
    // direct grants the election runs, and a group whose shared agent carries
    // isDefault===true wins over the code/native tiers. Two group agents so the
    // choice is non-trivial (a co-false "first wins" would pick A, not B).
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "a-plain");
    await seedLiveAgent(t, "prod", "b-default");

    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "a-plain",
    });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "b-default",
    });
    // Mark B (NOT the agentId-sorted first) as the group default.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("groupAgents").collect();
      const b = rows.find((r) => r.agentId === "b-default")!;
      await ctx.db.patch(b._id, { isDefault: true });
    });
    const key = (await as.query(api.groups.listGroups, {})).find(
      (g) => g._id === groupId,
    )!.key;

    const agents = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    const a = agents.find((g) => g.agentId === "a-plain")!;
    const b = agents.find((g) => g.agentId === "b-default")!;
    expect(b.isDefault).toBe(true); // Tier 1: the group's own default
    expect(a.isDefault).toBe(false);
    expect(b.via).toEqual({ group: key });
  });

  test("DEDUP: an agent held BOTH directly and via a group reports via=user (DIRECT WINS), single row", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "dup");

    await t.run((ctx) =>
      ctx.db.insert("userAgents", {
        userId: memberId,
        instanceName: "prod",
        agentId: "dup",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      }),
    );
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "dup",
    });

    const agents = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    expect(agents.length).toBe(1); // deduped, not duplicated
    expect(agents[0].via).toBe("user"); // direct provenance wins on dedup
    expect(agents[0].source).toBe("manual"); // direct row's source preserved
    expect(agents[0].isDefault).toBe(true);
  });

  // CRITICAL regression guard. Discriminating fixture: 3 direct grants, the
  // default on the NON-first row, mixed resolution states (ok/stale/deleted),
  // and NO group at all. Expectations are HARDCODED literals (never derived from
  // the code under test), so the test cannot be co-false with the union code.
  test("REGRESSION: user with NO group → enrichUserAgents output identical to pre-P2", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    await t.run(async (ctx) => {
      // Instance "prod": discovery succeeded → present=ok, absent-after-ok=deleted.
      await ctx.db.insert("instances", {
        name: "prod",
        gatewayUrl: "ws://prod",
        kind: "openclaw" as const,
      });
      await ctx.db.insert("instanceDiscovery", {
        instanceName: "prod",
        lastPollAt: 1,
        lastPollOk: true,
        lastOkAt: 1,
      });
      // Instance "lab": discovery FAILED → a present agent reads "stale".
      await ctx.db.insert("instances", {
        name: "lab",
        gatewayUrl: "ws://lab",
        kind: "openclaw" as const,
      });
      await ctx.db.insert("instanceDiscovery", {
        instanceName: "lab",
        lastPollAt: 1,
        lastPollOk: false,
      });
      // a1: present on prod → ok.
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "a1",
        source: "discovered" as const,
        presentInLastOk: true, enabled: true,
        displayName: "A1",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // a2: present on lab, but lab's last poll FAILED → stale. (default → NON-first)
      await ctx.db.insert("agents", {
        instanceName: "lab",
        agentId: "a2",
        source: "discovered" as const,
        presentInLastOk: true, enabled: true,
        displayName: "A2",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // a3: known-deleted on prod (successful poll, absent) → deleted.
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "a3",
        source: "discovered" as const,
        presentInLastOk: false, enabled: true,
        displayName: "A3",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // Direct grants in insertion (by_user) order: a1, a2, a3. DEFAULT on a2
      // (the NON-first row) — catches a "first-is-default" regression.
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "prod",
        agentId: "a1",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "lab",
        agentId: "a2",
        isDefault: true,
        source: "auto" as const,
        createdAt: 2,
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "prod",
        agentId: "a3",
        isDefault: false,
        source: "manual" as const,
        createdAt: 3,
      });
    });

    const agents = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agents.listMyAgents, {});

    // Full-shape hardcoded expectation: order = by_user insertion, isDefault on a2,
    // states ok/stale/deleted, source preserved, and via="user" on EVERY row
    // (no group provenance must leak in when the user has no group).
    expect(agents).toEqual([
      {
        instanceName: "prod",
        agentId: "a1",
        isDefault: false,
        source: "manual",
        displayName: "A1",
        emoji: null,
        model: null,
        description: null,
        kind: "openclaw",
        enabled: true,
        state: "ok",
        via: "user",
      },
      {
        instanceName: "lab",
        agentId: "a2",
        isDefault: true,
        source: "auto",
        displayName: "A2",
        emoji: null,
        model: null,
        description: null,
        kind: "openclaw",
        enabled: true,
        state: "stale",
        via: "user",
      },
      {
        instanceName: "prod",
        agentId: "a3",
        isDefault: false,
        source: "manual",
        displayName: "A3",
        emoji: null,
        model: null,
        description: null,
        kind: "openclaw",
        enabled: true,
        state: "deleted",
        via: "user",
      },
    ]);
  });

  test("REGRESSION (routing): a NO-group user resolves a bound chat byte-identically (via getEffectiveGrants)", async () => {
    // resolveTargetForChat now consumes getEffectiveGrants; with no group its
    // candidate set must equal the pre-P2 direct rows, so a bound+present chat
    // still serves the binding with no rebind.
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    await seedLiveAgent(t, "prod", "alice");
    await t.run((ctx) =>
      ctx.db.insert("userAgents", {
        userId,
        instanceName: "prod",
        agentId: "alice",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      }),
    );
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "alice",
      }),
    );
    const r = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: userId as never,
    });
    expect(r?.target?.agentId).toBe("alice");
    expect(r?.target?.source).toBe("chat-binding");
    expect(r?.rebind).toBeNull();
  });

  test("ROUTING via group: a group-only user can dispatch (group agent is the candidate)", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "shared");

    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "shared",
    });

    // Unbound chat for the member → resolves to the group agent (effective default).
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: memberId, updatedAt: 1 }),
    );
    const r = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: memberId as never,
    });
    expect(r?.target?.agentId).toBe("shared");
    expect(r?.failReason ?? null).toBeNull();
  });
});

// ===========================================================================
// RBAC — REAL identity (admin-only; impersonation does NOT drop the gate)
// ===========================================================================

describe("groups RBAC keys off the REAL identity", () => {
  test("a plain NON-admin (no groups.manage) is rejected: create is admin-only, list needs the perm", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    // createGroup is structural → ADMIN-only now (groups.manage is grantable, but
    // granting it never lets a non-admin create/delete a group).
    await expect(
      asUser.mutation(api.groups.createGroup, { name: "G" }),
    ).rejects.toThrow(/admin role required/);
    // listGroups still gates on the (now grantable) groups.manage permission; a
    // plain user without the grant lacks it.
    await expect(asUser.query(api.groups.listGroups, {})).rejects.toThrow(
      /missing permission groups\.manage/,
    );
  });

  test("an admin IMPERSONATING a regular user STILL manages groups (gate uses REAL id, not effective)", async () => {
    // requirePermission keys off rawUserId (the REAL signed-in identity), never
    // the impersonated/effective one. So an admin who started impersonation —
    // whose EFFECTIVE id is a permission-less regular user — must STILL pass the
    // groups.manage gate. If the gate had dropped to the effective id this would
    // throw; success proves the real-identity contract. (The spec's "cannot
    // manage" prose is loose: the testable invariant is "gate = real identity".)
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
    // Succeeds despite the effective user being permission-less.
    const groupId = await asImpersonatingAdmin.mutation(api.groups.createGroup, {
      name: "G",
    });
    expect((await asImpersonatingAdmin.query(api.groups.listGroups, {})).length).toBe(1);
    expect(groupId).toBeTruthy();
  });
});

// ===========================================================================
// Cascade — deleteInstance purges groupAgents (with a survivor control)
// ===========================================================================

describe("deleteInstance purges groupAgents", () => {
  test("removes the deleted instance's groupAgents, keeps another instance's", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });

    // Exactly ONE instances row per name (so `stillServed` is null → cascade runs).
    const prodId = await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://p", kind: "openclaw" as const }),
    );
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://o", kind: "openclaw" as const }),
    );
    const groupId = await as.mutation(api.groups.createGroup, { name: "G" });
    // Direct-insert the group agents (assignAgentToGroup has discovery
    // preconditions we don't need to re-exercise here).
    await t.run(async (ctx) => {
      await ctx.db.insert("groupAgents", {
        groupId,
        instanceName: "prod",
        agentId: "alice",
        createdAt: 1,
      });
      // Survivor control: a row on a DIFFERENT instance that must remain.
      await ctx.db.insert("groupAgents", {
        groupId,
        instanceName: "other",
        agentId: "bob",
        createdAt: 1,
      });
    });
    expect((await rowsOf(t, "groupAgents")).length).toBe(2);

    await as.mutation(api.admin.deleteInstance, { instanceId: prodId });

    const remaining = await rowsOf(t, "groupAgents");
    expect(remaining.length).toBe(1); // prod's purged
    expect(remaining[0].instanceName).toBe("other"); // other's intact
    expect(remaining[0].agentId).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// CROSS-CHECK: effectiveAgentsForUsers (the batched helper feeding the admin
// users list's Agents column) re-implements the cascade SET in ONE pass. It must
// agree, SET-for-set and COUNT-for-count, with getEffectiveGrants (the routing
// source of truth) for EVERY user. A test asserting the two never drift is the
// discriminating one: an ISOLATED test of the helper would share the helper's own
// assumptions and pass even if both were wrong the same way (e.g. a slipped
// present-predicate or a regime mistake). Covers the 3 regimes + a restriction
// that empties to the pool + a dangling membership + the present-boundary.
// ---------------------------------------------------------------------------
describe("effectiveAgentsForUsers vs getEffectiveGrants (no drift)", () => {
  test("count + agent SET identical for every user across all regimes", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });

    // Agents — displayName OMITTED so the helper's label falls back to the agentId,
    // making its preview directly comparable to getEffectiveGrants' agentIds. a1 is
    // the instance native default; `dead` is present:false -> in NO all-pool.
    await t.run(async (ctx) => {
      const A = (
        instanceName: string,
        agentId: string,
        presentInLastOk: boolean,
        isDefaultOnInstance = false,
      ) =>
        ctx.db.insert("agents", {
          instanceName,
          agentId,
          source: "discovered" as const,
          presentInLastOk,
          enabled: true,
          isDefaultOnInstance,
          firstSeenAt: 1,
          lastSeenAt: 1,
        });
      await A("prod", "a1", true, true);
      await A("prod", "a2", true);
      await A("prod", "a3", true);
      await A("lab", "b1", true);
      await A("prod", "dead", false); // excluded from the all-pool by BOTH paths
    });

    const u1 = await seedUser(t, "u1-nogroup-nodirect"); // -> all-pool
    const u2 = await seedUser(t, "u2-nogroup-direct"); //   -> direct {a1,a2}
    const u3 = await seedUser(t, "u3-group-nodirect"); //   -> group pool {a1,a2}
    const u4 = await seedUser(t, "u4-group-restrict"); //   -> restricted {a1}
    const u5 = await seedUser(t, "u5-group-outofpool"); //  -> pool (direct out-of-pool)
    const u6 = await seedUser(t, "u6-dangling-direct"); //  -> direct {a3} (group gone)

    // Direct grants (raw inserts; the <=1-default invariant kept by hand).
    await t.run(async (ctx) => {
      const D = (
        userId: typeof u1,
        instanceName: string,
        agentId: string,
        isDefault: boolean,
        createdAt: number,
      ) =>
        ctx.db.insert("userAgents", {
          userId,
          instanceName,
          agentId,
          isDefault,
          source: "manual" as const,
          createdAt,
        });
      await D(u2, "prod", "a1", true, 1);
      await D(u2, "prod", "a2", false, 2);
      await D(u4, "prod", "a1", true, 1);
      await D(u5, "lab", "b1", true, 1); // OUT of G1's pool -> restriction empties
      await D(u6, "prod", "a3", true, 1);
    });

    // Group G1 shares a1 + a2; u3/u4/u5 are members.
    const g1 = await as.mutation(api.groups.createGroup, { name: "G1" });
    for (const u of [u3, u4, u5])
      await as.mutation(api.groups.addMember, { groupId: g1, userId: u });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId: g1,
      instanceName: "prod",
      agentId: "a1",
    });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId: g1,
      instanceName: "prod",
      agentId: "a2",
    });

    // u6: a DANGLING membership (group row deleted, the membership left behind) ->
    // BOTH paths must drop to the no-group regime (never strip the direct grant).
    const g2 = await as.mutation(api.groups.createGroup, { name: "G2" });
    await as.mutation(api.groups.addMember, { groupId: g2, userId: u6 });
    await t.run((ctx) => ctx.db.delete(g2));

    const users = [u1, u2, u3, u4, u5, u6];

    // Compute BOTH over the SAME seeded state, in one ctx.
    const { perGrant, batched } = await t.run(async (ctx) => {
      const perGrant: Record<string, string[]> = {};
      for (const u of users) {
        const grants = await getEffectiveGrants(ctx, u);
        perGrant[u] = grants.map((g) => g.agentId);
      }
      const map = await effectiveAgentsForUsers(ctx, users);
      const batched: Record<string, { count: number; preview: string[] }> = {};
      for (const u of users) batched[u] = map.get(u)!;
      return { perGrant, batched };
    });

    const setOf = (xs: string[]) => [...new Set(xs)].sort();

    for (const u of users) {
      const truth = setOf(perGrant[u]);
      const got = batched[u];
      // count == the cascade set size — the STRONG discriminator: any regime slip
      // (e.g. an over-counted all-pool, or a dropped restriction) changes COUNT.
      expect(got.count, `count for ${u}`).toBe(truth.length);
      // membership identical (labels == agentIds in this fixture).
      expect(setOf(got.preview), `set for ${u}`).toEqual(truth);
    }

    // ANCHOR each regime with HARDCODED expectations, so the cross-check cannot be
    // satisfied by BOTH implementations agreeing on a WRONG set.
    expect(setOf(perGrant[u1])).toEqual(["a1", "a2", "a3", "b1"]); // all-pool, no dead
    expect(setOf(perGrant[u2])).toEqual(["a1", "a2"]); // direct
    expect(setOf(perGrant[u3])).toEqual(["a1", "a2"]); // group pool
    expect(setOf(perGrant[u4])).toEqual(["a1"]); // restricted to the in-pool direct
    expect(setOf(perGrant[u5])).toEqual(["a1", "a2"]); // direct out-of-pool -> pool
    expect(setOf(perGrant[u6])).toEqual(["a3"]); // dangling -> no-group direct
  });

  test("no drift on MANUAL agents under strict: disabled dropped by BOTH, unset kept by BOTH (opt-out)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Strict mode ON (backfill done).
      await ctx.db.insert("appMeta", {
        key: "singleton", adminAssigned: false, agentEnabledBackfillDone: true,
      });
      // Two PRESENT manual agents (admin fallback, never in the discovered pool):
      // one explicitly disabled, one enabled UNSET.
      await ctx.db.insert("agents", {
        instanceName: "prod", agentId: "m_off", source: "manual" as const,
        presentInLastOk: true, enabled: false, firstSeenAt: 1, lastSeenAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "prod", agentId: "m_unset", source: "manual" as const,
        presentInLastOk: true, firstSeenAt: 1, lastSeenAt: 1,
      });
    });
    const u = await seedUser(t, "u-manual-grants");
    await t.run(async (ctx) => {
      for (const [agentId, isDefault] of [["m_off", true], ["m_unset", false]] as const) {
        await ctx.db.insert("userAgents", {
          userId: u, instanceName: "prod", agentId,
          isDefault, source: "manual" as const, createdAt: 1,
        });
      }
    });
    const { perGrant, batched } = await t.run(async (ctx) => {
      const grants = await getEffectiveGrants(ctx, u);
      const map = await effectiveAgentsForUsers(ctx, [u]);
      return { perGrant: grants.map((g) => g.agentId).sort(), batched: map.get(u)! };
    });
    // Point-read: disabled manual dropped, unset manual kept (opt-out floor).
    expect(perGrant).toEqual(["m_unset"]);
    // Batched must AGREE — set AND count (this is the drift guard for codex P3).
    expect([...new Set(batched.preview)].sort()).toEqual(["m_unset"]);
    expect(batched.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The Agents column is OPT-IN on the shared admin.listUsers query: only the users
// MANAGEMENT list requests it. Generic consumers (a user picker) must NOT pay the
// per-user pool reads nor be invalidated by agent changes they do not show -- so
// without withAgents the column data is left UNCOMPUTED (agentCount === null, a
// distinct signal from "0 agents").
// ---------------------------------------------------------------------------
describe("admin.listUsers — Agents column is opt-in (withAgents)", () => {
  test("off -> agentCount null (uncomputed); on -> the cascade-resolved count + preview", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const as = t.withIdentity({ subject: `${adminId}|session` });
    const alice = await seedUser(t, "alice");
    await seedLiveAgent(t, "prod", "a1"); // displayName -> "A1"
    await seedLiveAgent(t, "prod", "a2"); // displayName -> "A2"

    // OFF (default): the column is NOT computed -> null, never a misleading 0.
    const off = await as.query(api.admin.listUsers, {});
    expect(off.every((r) => r.agentCount === null)).toBe(true);
    expect(off.every((r) => r.agents.length === 0)).toBe(true);

    // ON: both the admin AND alice are groupless with no direct grant -> the WHOLE
    // all-pool (there is NO "admin sees everything" bypass; an admin resolves like
    // any user). Proves the flag actually drives the computation.
    const on = await as.query(api.admin.listUsers, { withAgents: true });
    const aliceRow = on.find((r) => r.canonical === "alice");
    expect(aliceRow?.agentCount).toBe(2);
    expect([...(aliceRow?.agents ?? [])].sort()).toEqual(["A1", "A2"]);
    expect(on.find((r) => r.userId === alice)?.agentCount).toBe(2);
    expect(on.find((r) => r.userId === adminId)?.agentCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// enrichUserAgents (the shared core of listMyAgents / listChats / getChatAgent)
// pre-loads present discovered agents in ONE collect (loadAgentContext.agentByKey)
// instead of a per-grant point read -- the fix for the prod "too many system
// operations" timeout on a groupless user whose effective set is the whole all-pool.
// This guards that the batched MAP path (present agents) and the point-read FALLBACK
// (a deleted/absent grant, NOT in the map) still derive IDENTICAL display + state.
// ---------------------------------------------------------------------------
describe("enrichUserAgents batched agent resolution (map path + point-read fallback)", () => {
  test("all-pool user resolves via the batched map; a direct deleted grant resolves via the point-read fallback — same display + state", async () => {
    const t = convexTest(schema, modules);
    // userAll: NO group, NO direct grant -> effective set = the all-pool (via:"all")
    // -> loadAgentContext PRELOADS present agents -> agentDisplay reads the MAP.
    const userAll = await seedUser(t, "all");
    // userDirect: NO group, direct grants -> via:"user" -> preload OFF -> agentDisplay
    // POINT-READS each (the bounded path, incl. the deleted-grant fallback).
    const userDirect = await seedUser(t, "direct");
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "prod",
        gatewayUrl: "ws://prod",
        kind: "openclaw" as const,
      });
      await ctx.db.insert("instanceDiscovery", {
        instanceName: "prod",
        lastPollAt: 1,
        lastPollOk: true,
        lastOkAt: 1,
      });
      // PRESENT -> in by_source_present -> the all-pool + the batched map.
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "alive",
        source: "discovered" as const,
        presentInLastOk: true, enabled: true,
        displayName: "Alive",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // GATEWAY-DELETED (presentInLastOk:false) -> NOT in the map / not in the all-pool.
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "gone",
        source: "discovered" as const,
        presentInLastOk: false, enabled: true,
        displayName: "Gone",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // userDirect grants both (a no-group direct set keeps even the deleted one).
      await ctx.db.insert("userAgents", {
        userId: userDirect,
        instanceName: "prod",
        agentId: "alive",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId: userDirect,
        instanceName: "prod",
        agentId: "gone",
        isDefault: false,
        source: "manual" as const,
        createdAt: 2,
      });
    });

    // MAP path: the all-pool user sees the present agent, resolved from the preload.
    const viaMap = await t
      .withIdentity({ subject: `${userAll}|session` })
      .query(api.agents.listMyAgents, {});
    expect(viaMap.map((a) => a.agentId)).toEqual(["alive"]); // gone is not present
    expect(viaMap[0].state).toBe("ok");
    expect(viaMap[0].displayName).toBe("Alive");

    // FALLBACK path: the direct-grant user point-reads — IDENTICAL result for the
    // present agent, plus the deleted grant correctly derives state "deleted".
    const viaPointRead = await t
      .withIdentity({ subject: `${userDirect}|session` })
      .query(api.agents.listMyAgents, {});
    const alive = viaPointRead.find((a) => a.agentId === "alive");
    const gone = viaPointRead.find((a) => a.agentId === "gone");
    expect(alive?.state).toBe("ok"); // same as the map path
    expect(alive?.displayName).toBe("Alive");
    expect(gone?.state).toBe("deleted"); // map miss / preload off -> fallback
    expect(gone?.displayName).toBe("Gone");
  });
});
