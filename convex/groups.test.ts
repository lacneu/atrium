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
        presentInLastOk: false,
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

    // The UNION read (listMyAgents) sees BOTH — proving "shared" really IS
    // reachable and is being FILTERED, not just absent.
    const union = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    expect(union.map((a) => a.agentId).sort()).toEqual(["direct", "shared"]);

    // The EDITOR returns DIRECT ONLY: the inherited "shared" is excluded; the
    // direct grant keeps via="user" and its isDefault star.
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

  test("PRECEDENCE: direct default A + group default B → effective default = A; B stays via=group, isDefault=false", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedAdmin(t);
    const memberId = await seedUser(t, "member");
    const as = t.withIdentity({ subject: `${adminId}|session` });
    await seedLiveAgent(t, "prod", "a-direct", { displayName: "A" });
    await seedLiveAgent(t, "prod", "b-group", { displayName: "B" });

    // Direct grant A, marked default.
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
    // Group B with its OWN default flag set on the shared agent.
    const groupId = await as.mutation(api.groups.createGroup, { name: "GB" });
    await as.mutation(api.groups.addMember, { groupId, userId: memberId });
    await as.mutation(api.groups.assignAgentToGroup, {
      groupId,
      instanceName: "prod",
      agentId: "b-group",
    });
    await t.run(async (ctx) => {
      const ga = (await ctx.db.query("groupAgents").collect())[0];
      await ctx.db.patch(ga._id, { isDefault: true }); // group default = B
    });
    const key = (await as.query(api.groups.listGroups, {})).find(
      (g) => g._id === groupId,
    )!.key;

    const agents = await t
      .withIdentity({ subject: `${memberId}|session` })
      .query(api.agents.listMyAgents, {});
    const a = agents.find((g) => g.agentId === "a-direct")!;
    const b = agents.find((g) => g.agentId === "b-group")!;
    // Direct default wins (hasDirectDefault → election skipped entirely).
    expect(a.isDefault).toBe(true);
    expect(a.via).toBe("user");
    // B keeps its group provenance and is NOT the effective default — the
    // discriminating assertion (a precedence bug would flip B to default).
    expect(b.isDefault).toBe(false);
    expect(b.via).toEqual({ group: key });
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
        presentInLastOk: true,
        displayName: "A1",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // a2: present on lab, but lab's last poll FAILED → stale. (default → NON-first)
      await ctx.db.insert("agents", {
        instanceName: "lab",
        agentId: "a2",
        source: "discovered" as const,
        presentInLastOk: true,
        displayName: "A2",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      // a3: known-deleted on prod (successful poll, absent) → deleted.
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "a3",
        source: "discovered" as const,
        presentInLastOk: false,
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
        kind: "openclaw",
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
        kind: "openclaw",
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
        kind: "openclaw",
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
