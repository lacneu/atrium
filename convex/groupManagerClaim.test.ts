/// <reference types="vite/client" />
//
// Group-manager delegation, second phase: a manager CLAIMS a newly discovered agent
// for their group (it becomes RESERVED to that group), narrows members within the
// group's own share, sets the group/member defaults, and requests invitations by
// email that an admin decides. Pins:
//   - claimability (never-decided vs admin-disabled, epoch, already granted,
//     the group's footprint);
//   - the reservation in EVERY resolution path (a groupless all-pool user and
//     another group never reach it; the instance default never becomes it);
//   - the manager's scope (no other group's agent, no open catalogue, no direct add);
//   - invitations (request, approve, reject, refusals);
//   - per-member restriction scoped to ONE group (a multi-group member keeps the
//     rest; admin direct grants untouched), member + group defaults;
//   - unconditional audit rows with the real actor.

import { convexTest, type TestConvex } from "convex-test";
import { MEMBER_CLEANUP_BATCH, assertNoPendingMemberCleanup, memberCleanupBatch } from "./lib/groupMembers";
import { sweepInstanceNameBoundBatch } from "./lib/instanceCascade";
import { AGENT_ACCESS_BATCH } from "./agents";
import { AUDIT_REFS_PER_ROW, splitAuditDetails } from "./groups";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  effectiveAgentsForUsers,
  getAgentPool,
  getEffectiveGrants,
  userMayAccessInstance,
} from "./agents";
import { resolveTargetForTurn } from "./routing";
import { knowledgeAgentReachable } from "./knowledge";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
const as = (t: T, uid: Id<"users">) => t.withIdentity({ subject: `${uid}|session` });

async function user(
  t: T,
  opts: { role?: "admin" | "user" | "pending"; email?: string; perms?: string[] } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: opts.role ?? "user",
      ...(opts.email ? { email: opts.email, emailLower: opts.email.toLowerCase() } : {}),
      ...(opts.perms ? { extraPermissions: opts.perms } : {}),
    });
    return uid;
  });
}

async function agent(
  t: T,
  instanceName: string,
  agentId: string,
  fields: Partial<Doc<"agents">> = {},
): Promise<Id<"agents">> {
  return await t.run(async (ctx) => {
    if ((await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", instanceName)).first()) === null) {
      await ctx.db.insert("instances", { name: instanceName, gatewayUrl: `ws://${instanceName}` });
      await ctx.db.insert("instanceDiscovery", {
        instanceName,
        lastPollAt: 1,
        lastPollOk: true,
        lastOkAt: 1,
      });
    }
    return await ctx.db.insert("agents", {
      instanceName,
      agentId,
      source: "discovered",
      presentInLastOk: true,
      enabled: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
      ...fields,
    });
  });
}

/** A fresh discovery: arrives disabled, never decided on (applyDiscovery's stamp). */
const fresh = (t: T, instanceName: string, agentId: string) =>
  agent(t, instanceName, agentId, { enabled: false });

async function setEpoch(t: T, epoch: number | undefined) {
  await t.run(async (ctx) => {
    const meta = await ctx.db.query("appMeta").withIndex("by_key", (q) => q.eq("key", "singleton")).unique();
    await ctx.db.patch(meta!._id, { agentClaimEpoch: epoch });
  });
}

async function share(t: T, groupId: Id<"groups">, instanceName: string, agentId: string, isDefault?: boolean) {
  await t.run((ctx) =>
    ctx.db.insert("groupAgents", {
      groupId,
      instanceName,
      agentId,
      createdAt: 1,
      ...(isDefault ? { isDefault: true } : {}),
    }),
  );
}

async function join(t: T, groupId: Id<"groups">, userId: Id<"users">, manager = false) {
  await t.run((ctx) =>
    ctx.db.insert("groupMembers", { groupId, userId, joinedAt: 1, ...(manager ? { manager: true } : {}) }),
  );
}

// admin, a manager of G (with groups.manage), a plain member of G, a member of H,
// and a groupless user. Instance "prod": base (G, instance default), other (H),
// open (enabled, nobody), plus whatever a test adds. Strict opt-in mode; the
// claim epoch at 0 (every row created in the test postdates it).
async function seed(t: T) {
  const admin = await user(t, { role: "admin" });
  const mgr = await user(t, { perms: ["groups.manage"], email: "mgr@example.com" });
  const member = await user(t, { email: "member@example.com" });
  const hMember = await user(t);
  const loner = await user(t);
  const { G, H } = await t.run(async (ctx) => {
    await ctx.db.insert("appMeta", {
      key: "singleton",
      adminAssigned: true,
      agentEnabledBackfillDone: true,
      agentClaimEpoch: 0,
    });
    const G = await ctx.db.insert("groups", { key: "g", name: "G", createdBy: admin, createdAt: 1 });
    const H = await ctx.db.insert("groups", { key: "h", name: "H", createdBy: admin, createdAt: 2 });
    return { G, H };
  });
  await join(t, G, mgr, true);
  await join(t, G, member);
  await join(t, H, hMember);
  await agent(t, "prod", "base");
  await agent(t, "prod", "other");
  await agent(t, "prod", "open");
  await share(t, G, "prod", "base");
  await share(t, H, "prod", "other");
  await t.run(async (ctx) => {
    const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first();
    await ctx.db.patch(inst!._id, { defaultAgentId: "base" });
  });
  return { admin, mgr, member, hMember, loner, G, H };
}

const agentRow = (t: T, instanceName: string, agentId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) => q.eq("instanceName", instanceName).eq("agentId", agentId))
      .first(),
  );
const ids = async (t: T, uid: Id<"users">) =>
  (await t.run((ctx) => getEffectiveGrants(ctx, uid))).map((g) => `${g.instanceName}/${g.agentId}`).sort();
/** The batched admin summary's count per user (a Map cannot leave t.run). */
const counts = (t: T, users: Id<"users">[]) =>
  t.run(async (ctx) => {
    const map = await effectiveAgentsForUsers(ctx, users);
    const out: Record<string, number> = {};
    for (const u of users) out[u] = map.get(u)?.count ?? -1;
    return out;
  });
const audit = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect()).map((a) => ({
      action: a.action,
      resource: a.resource ?? null,
      resourceId: a.resourceId ?? null,
      realUserId: a.realUserId,
    })),
  );

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
describe("claim: only an agent nobody has decided on", () => {
  test("a manager claims a fresh agent: shared, reserved, enabled — instance default untouched", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    const row = await agentRow(t, "prod", "forged");
    expect(row?.enabled).toBe(true);
    expect(row?.reservedForGroupId).toBe(G);
    expect(row?.enablementDecidedAt).toBeTypeOf("number");
    const shared = await t.run((ctx) =>
      ctx.db.query("groupAgents").withIndex("by_group", (q) => q.eq("groupId", G)).collect(),
    );
    expect(shared.map((s) => s.agentId).sort()).toEqual(["base", "forged"]);
    const inst = await t.run((ctx) => ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first());
    expect(inst?.defaultAgentId).toBe("base");
  });

  test("the claim never elects the default, even on an instance whose default is invalid", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G } = await seed(t);
    await t.run(async (ctx) => {
      const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first();
      await ctx.db.patch(inst!._id, { defaultAgentId: undefined });
    });
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    const inst = await t.run((ctx) => ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first());
    expect(inst?.defaultAgentId).toBeUndefined();
  });

  test("an agent an admin DISABLED (even one never enabled) is not claimable", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "forged", enabled: false });
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" }),
    ).rejects.toThrow(/not claimable \(decided\)/);
  });

  test("an agent enabled once then disabled is not claimable", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "forged", enabled: true });
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "forged", enabled: false });
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" }),
    ).rejects.toThrow(/not claimable/);
  });

  test("a row that predates the claim epoch, or no epoch at all, is not claimable", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G } = await seed(t);
    const id = await fresh(t, "prod", "legacy");
    const created = (await t.run((ctx) => ctx.db.get(id)))!._creationTime;
    await setEpoch(t, created);
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "legacy" }),
    ).rejects.toThrow(/predates_epoch/);
    await setEpoch(t, undefined);
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "legacy" }),
    ).rejects.toThrow(/no_epoch/);
    await setEpoch(t, created - 1);
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "legacy" });
  });

  test("the epoch stamp is one-shot", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await setEpoch(t, undefined);
    expect(await t.mutation(internal.agents.stampAgentClaimEpoch, {})).toEqual({ stamped: true });
    const first = await t.run(async (ctx) =>
      (await ctx.db.query("appMeta").withIndex("by_key", (q) => q.eq("key", "singleton")).unique())!.agentClaimEpoch,
    );
    expect(await t.mutation(internal.agents.stampAgentClaimEpoch, {})).toEqual({ stamped: false });
    const second = await t.run(async (ctx) =>
      (await ctx.db.query("appMeta").withIndex("by_key", (q) => q.eq("key", "singleton")).unique())!.agentClaimEpoch,
    );
    expect(second).toBe(first);
  });

  test("an agent already granted (to a user or another group) is not claimable", async () => {
    const t = convexTest(schema, modules);
    const { mgr, loner, G, H } = await seed(t);
    await fresh(t, "prod", "viaUser");
    await fresh(t, "prod", "viaGroup");
    await t.run((ctx) =>
      ctx.db.insert("userAgents", {
        userId: loner,
        instanceName: "prod",
        agentId: "viaUser",
        isDefault: true,
        source: "manual",
        createdAt: 1,
      }),
    );
    await share(t, H, "prod", "viaGroup");
    for (const agentId of ["viaUser", "viaGroup"]) {
      await expect(
        as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId }),
      ).rejects.toThrow(/not claimable \(granted\)/);
    }
  });

  test("a manager claims only on an instance their group already uses", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G } = await seed(t);
    await fresh(t, "lab", "stray");
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "lab", agentId: "stray" }),
    ).rejects.toThrow(/no agent on that instance/);
  });

  test("a manager cannot claim for a group they do not manage", async () => {
    const t = convexTest(schema, modules);
    const { mgr, H } = await seed(t);
    await share(t, H, "prod", "base");
    await fresh(t, "prod", "forged");
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: H, instanceName: "prod", agentId: "forged" }),
    ).rejects.toThrow(/not a manager/);
  });
});

// ===========================================================================
describe("reservation: reaches only the groups it is assigned to", () => {
  async function claimed(t: T) {
    const s = await seed(t);
    // "solo": its ONLY usable agents end up reserved for G — anchor (reserved by an
    // admin) and forged (claimed by the manager).
    await agent(t, "solo", "anchor");
    await as(t, s.admin).mutation(api.agents.setAgentReservation, {
      instanceName: "solo",
      agentId: "anchor",
      groupId: s.G,
    });
    await fresh(t, "solo", "forged");
    await as(t, s.mgr).mutation(api.groups.claimAgentForGroup, {
      groupId: s.G,
      instanceName: "solo",
      agentId: "forged",
    });
    return s;
  }

  test("a groupless user never reaches it; the group's members do; another group does not", async () => {
    const t = convexTest(schema, modules);
    const { loner, member, hMember } = await claimed(t);
    expect(await ids(t, loner)).toEqual(["prod/base", "prod/open", "prod/other"]);
    expect(await ids(t, member)).toEqual(["prod/base", "solo/anchor", "solo/forged"]);
    expect(await ids(t, hMember)).toEqual(["prod/other"]);
  });

  test("every resolution path agrees: pool, batched summary, instance access, picker", async () => {
    const t = convexTest(schema, modules);
    const { loner, member, hMember } = await claimed(t);
    const pool = await t.run(async (ctx) => (await getAgentPool(ctx, loner)).pool.map((p) => p.agentId).sort());
    expect(pool).toEqual(["base", "open", "other"]);
    const batched = await counts(t, [loner, member, hMember]);
    expect(batched[loner]).toBe(3);
    expect(batched[member]).toBe(3);
    expect(batched[hMember]).toBe(1);
    expect(await t.run((ctx) => userMayAccessInstance(ctx, loner, "solo"))).toBe(false);
    expect(await t.run((ctx) => userMayAccessInstance(ctx, hMember, "solo"))).toBe(false);
    expect(await t.run((ctx) => userMayAccessInstance(ctx, member, "solo"))).toBe(true);
    const picker = await as(t, loner).query(api.agents.listMyAgents, {});
    expect(picker.some((a) => a.instanceName === "solo")).toBe(false);
  });

  test("a groupless user cannot bind a conversation to it", async () => {
    const t = convexTest(schema, modules);
    const { loner, member } = await claimed(t);
    await expect(
      as(t, loner).mutation(api.chats.createChat, { instanceName: "solo", agentId: "forged" }),
    ).rejects.toThrow(/not assigned/);
    await as(t, member).mutation(api.chats.createChat, { instanceName: "solo", agentId: "forged" });
  });

  test("an admin-made direct grant still reaches it", async () => {
    const t = convexTest(schema, modules);
    const { admin, loner } = await claimed(t);
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", loner)).unique())!._id,
    );
    await as(t, admin).mutation(api.agents.assignAgent, { profileId, instanceName: "solo", agentId: "forged" });
    expect(await ids(t, loner)).toEqual(["solo/forged"]);
  });

  test("never the instance default: refused by hand, skipped by the election", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await claimed(t);
    await expect(
      as(t, admin).mutation(api.agents.setInstanceDefaultAgent, { instanceName: "solo", agentId: "forged" }),
    ).rejects.toThrow(/reserved agent cannot be the instance default/);
    // A toggle on the instance heals the default — never onto a reserved agent.
    await agent(t, "solo", "plain", { enabled: false });
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "solo", agentId: "plain", enabled: true });
    const inst = await t.run((ctx) => ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "solo")).first());
    expect(inst?.defaultAgentId).toBe("plain");
  });

  test("an admin lifts the reservation: the agent joins the all-pool and may become the default", async () => {
    const t = convexTest(schema, modules);
    const { admin, loner, G } = await claimed(t);
    await as(t, admin).mutation(api.agents.setAgentReservation, {
      instanceName: "solo",
      agentId: "forged",
      groupId: null,
    });
    expect((await agentRow(t, "solo", "forged"))?.reservedForGroupId).toBeUndefined();
    expect(await ids(t, loner)).toContain("solo/forged");
    const inst = await t.run((ctx) => ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "solo")).first());
    expect(inst?.defaultAgentId).toBe("forged");
    // The group keeps it (the reservation only decided who ELSE reaches it).
    const shared = await t.run((ctx) =>
      ctx.db.query("groupAgents").withIndex("by_group", (q) => q.eq("groupId", G)).collect(),
    );
    expect(shared.some((s) => s.agentId === "forged")).toBe(true);
  });

  test("an admin moves the reservation to another group, which then reaches it", async () => {
    const t = convexTest(schema, modules);
    const { admin, member, hMember, H } = await claimed(t);
    await as(t, admin).mutation(api.agents.setAgentReservation, {
      instanceName: "solo",
      agentId: "forged",
      groupId: H,
    });
    expect((await agentRow(t, "solo", "forged"))?.reservedForGroupId).toBe(H);
    expect(await ids(t, hMember)).toContain("solo/forged");
    // …and G loses it: a move is not a second share.
    expect(await ids(t, member)).not.toContain("solo/forged");
  });

  test("a manager cannot lift or move a reservation", async () => {
    const t = convexTest(schema, modules);
    const { mgr } = await claimed(t);
    await expect(
      as(t, mgr).mutation(api.agents.setAgentReservation, { instanceName: "solo", agentId: "forged", groupId: null }),
    ).rejects.toThrow(/admin role required/);
  });

  test("the admin's agent list names the group it is reserved for", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await claimed(t);
    const list = await as(t, admin).query(api.agents.listAgentsForInstance, { instanceName: "solo" });
    expect(list.agents.find((a) => a.agentId === "forged")?.reserved).toEqual({ groupId: G, groupName: "G" });
    expect(list.agents.every((a) => a.reserved !== null)).toBe(true);
  });
});

// ===========================================================================
describe("a manager's scope over agents", () => {
  test("cannot add another group's agent, nor any open enabled agent", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G } = await seed(t);
    for (const agentId of ["other", "open"]) {
      await expect(
        as(t, mgr).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId }),
      ).rejects.toThrow(/only add an agent reserved for this group/);
    }
    await as(t, mgr).mutation(api.groups.bulkSetGroupAgents, {
      groupId: G,
      instanceName: "prod",
      agentIds: ["other", "open"],
      assigned: true,
    });
    const shared = await t.run((ctx) =>
      ctx.db.query("groupAgents").withIndex("by_group", (q) => q.eq("groupId", G)).collect(),
    );
    expect(shared.map((s) => s.agentId)).toEqual(["base"]);
  });

  test("an admin still shares any enabled agent", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "open" });
  });

  test("re-adds an agent reserved for their group after removing it", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    expect(await ids(t, member)).toEqual(["prod/base"]);
    await as(t, mgr).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    expect(await ids(t, member)).toEqual(["prod/base", "prod/forged"]);
  });

  test("the manager's agent list: the group's agents + reserved + claimable, never others or the catalogue", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G, H } = await seed(t);
    await fresh(t, "prod", "forged");
    await fresh(t, "prod", "decided");
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "decided", enabled: false });
    await agent(t, "prod", "theirs", { reservedForGroupId: H });
    const list = await as(t, mgr).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: G });
    const byId = Object.fromEntries(list.agents.map((a) => [a.agentId, a]));
    expect(Object.keys(byId).sort()).toEqual(["base", "forged"]);
    expect(byId.forged?.claimable).toBe(true);
    expect(byId.base?.claimable).toBe(false);
    await expect(
      as(t, mgr).query(api.groups.listAssignableAgents, { instanceName: "prod" }),
    ).rejects.toThrow(/groupId required/);
    // Instances: only where the group has a footprint.
    await agent(t, "lab", "x");
    const inst = await as(t, mgr).query(api.groups.listAssignableInstances, { groupId: G });
    expect(inst.map((i) => i.name)).toEqual(["prod"]);
  });
});

// ===========================================================================
describe("members: a manager requests, an admin decides", () => {
  test("a manager cannot add a member directly (single or bulk)", async () => {
    const t = convexTest(schema, modules);
    const { mgr, loner, G } = await seed(t);
    await expect(
      as(t, mgr).mutation(api.groups.addMember, { groupId: G, userId: loner }),
    ).rejects.toThrow(/admin role required/);
    await expect(
      as(t, mgr).mutation(api.groups.bulkSetMembers, { groupId: G, userIds: [loner], member: true }),
    ).rejects.toThrow(/only an admin adds members/);
  });

  test("request → admins notified → approve adds the account and tells the requester", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    const invitee = await user(t, { email: "Invitee@Example.com" });
    const requestId = await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, {
      groupId: G,
      email: "  invitee@example.COM ",
    });
    // Idempotent while pending.
    expect(
      await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "invitee@example.com" }),
    ).toBe(requestId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const adminBell = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.kind === "group_invite"),
    );
    expect(adminBell.map((n) => n.userId)).toEqual([admin]);
    expect(adminBell[0]?.messageKey).toBe("notif_group_invite_request");
    expect(JSON.stringify(adminBell[0])).not.toContain("invitee@");

    const pending = await as(t, admin).query(api.groupInvites.listPendingInviteRequests, {});
    expect(pending).toMatchObject([{ email: "invitee@example.com", groupName: "G", account: "ready" }]);
    await expect(
      as(t, mgr).mutation(api.groupInvites.decideGroupInvite, { requestId, approve: true }),
    ).rejects.toThrow(/admin role required/);

    await as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId, approve: true });
    const membership = await t.run((ctx) =>
      ctx.db.query("groupMembers").withIndex("by_user_group", (q) => q.eq("userId", invitee).eq("groupId", G)).unique(),
    );
    expect(membership).not.toBeNull();
    const told = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.userId === mgr),
    );
    expect(told.map((n) => n.messageKey)).toEqual(["notif_group_invite_approved"]);
    const mine = await as(t, mgr).query(api.groupInvites.listGroupInviteRequests, { groupId: G });
    expect(mine).toMatchObject([{ email: "invitee@example.com", status: "approved" }]);
    await expect(
      as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId, approve: false }),
    ).rejects.toThrow(/already decided/);
  });

  test("approval refuses an unknown or not-yet-approved account; reject closes the request", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    await user(t, { role: "pending", email: "waiting@example.com" });
    const ghost = await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "ghost@example.com" });
    const waiting = await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "waiting@example.com" });
    await expect(
      as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId: ghost, approve: true }),
    ).rejects.toThrow(/no account/);
    await expect(
      as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId: waiting, approve: true }),
    ).rejects.toThrow(/awaiting approval/);
    await as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId: ghost, approve: false });
    const row = await t.run((ctx) => ctx.db.get(ghost));
    expect(row?.status).toBe("rejected");
    expect(row?.decidedBy).toBe(admin);
  });

  test("request refusals: malformed address, already a member, another group", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G, H } = await seed(t);
    await expect(
      as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "not-an-email" }),
    ).rejects.toThrow(/Invalid email/);
    await expect(
      as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "member@example.com" }),
    ).rejects.toThrow(/already a member/);
    await expect(
      as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: H, email: "x@example.com" }),
    ).rejects.toThrow(/not a manager/);
  });
});

// ===========================================================================
describe("per-member restriction within ONE group", () => {
  async function twoGroups(t: T) {
    const s = await seed(t);
    await agent(t, "prod", "second");
    await share(t, s.G, "prod", "second");
    // `member` also belongs to H (which shares "other"), and holds nothing direct.
    await join(t, s.H, s.member);
    return s;
  }

  test("restricting a member in G narrows only G's share; H's agents stay", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await twoGroups(t);
    expect(await ids(t, member)).toEqual(["prod/base", "prod/other", "prod/second"]);
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "second" }],
    });
    expect(await ids(t, member)).toEqual(["prod/other", "prod/second"]);
    // The batched admin summary agrees (no drift).
    expect((await counts(t, [member]))[member]).toBe(2);
    expect(await t.run((ctx) => userMayAccessInstance(ctx, member, "prod"))).toBe(true);
    // Lift → the whole group again.
    await as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: null });
    expect(await ids(t, member)).toEqual(["prod/base", "prod/other", "prod/second"]);
  });

  test("the audit names WHICH agents a restriction added or removed, and the default before/after (refs only)", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await twoGroups(t);
    await as(t, mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: G,
      userId: member,
      agent: { instanceName: "prod", agentId: "base" },
    });
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "second" }],
    });
    await as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: null });
    const rows = await t.run((ctx) => ctx.db.query("auditLog").order("asc").collect());
    const lastOf = (a: string) => rows.filter((r) => r.action === a).slice(-1)[0];
    expect(lastOf("group.setMemberDefault")?.details).toEqual({
      defaultAgent: { instanceName: "prod", agentId: "base" },
      previousDefaultAgent: null,
    });
    expect(lastOf("group.restrictMember")?.details).toEqual({
      agentsAdded: [],
      agentsRemoved: [{ instanceName: "prod", agentId: "base" }],
      // The restriction dropped the member's default: said so.
      previousDefaultAgent: { instanceName: "prod", agentId: "base" },
      defaultAgent: null,
    });
    expect(lastOf("group.unrestrictMember")?.details).toEqual({
      agentsAdded: [{ instanceName: "prod", agentId: "base" }],
      agentsRemoved: [],
    });
    // Refs only: nothing but instance/agent names in what the audit carries.
    expect(JSON.stringify(rows.map((r) => r.details ?? null))).not.toMatch(/text|title|message/i);
  });

  test("an empty restriction gives nothing from G — and removing the last allowed agent never widens", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await twoGroups(t);
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "second" }],
    });
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "second" });
    expect(await ids(t, member)).toEqual(["prod/other"]);
    await as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: [] });
    expect(await ids(t, member)).toEqual(["prod/other"]);
  });

  test("never an agent outside the group; never another group's member; admin direct grants untouched", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, hMember, G } = await twoGroups(t);
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", member)).unique())!._id,
    );
    await as(t, admin).mutation(api.agents.assignAgent, { profileId, instanceName: "prod", agentId: "other" });
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, {
        groupId: G,
        userId: member,
        agents: [{ instanceName: "prod", agentId: "open" }],
      }),
    ).rejects.toThrow(/not shared with this group/);
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: hMember, agents: [] }),
    ).rejects.toThrow(/not a member/);
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "base" }],
    });
    const direct = await t.run((ctx) =>
      ctx.db.query("userAgents").withIndex("by_user", (q) => q.eq("userId", member)).collect(),
    );
    expect(direct.map((d) => d.agentId)).toEqual(["other"]);
  });

  test("member default: within their share only, and it wins over the group default", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await twoGroups(t);
    await as(t, mgr).mutation(api.groups.setGroupDefaultAgent, {
      groupId: G,
      agent: { instanceName: "prod", agentId: "base" },
    });
    const def = async () =>
      (await t.run((ctx) => getEffectiveGrants(ctx, member))).find((g) => g.isDefault)?.agentId;
    expect(await def()).toBe("base");
    await as(t, mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: G,
      userId: member,
      agent: { instanceName: "prod", agentId: "second" },
    });
    expect(await def()).toBe("second");
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "base" }],
    });
    await expect(
      as(t, mgr).mutation(api.groups.setMemberDefaultAgent, {
        groupId: G,
        userId: member,
        agent: { instanceName: "prod", agentId: "second" },
      }),
    ).rejects.toThrow(/receives from the group/);
    const settings = await as(t, mgr).query(api.groups.getMemberAgentSettings, { groupId: G, userId: member });
    expect(settings?.restricted).toBe(true);
    expect(settings?.agents.filter((a) => a.allowed).map((a) => a.agentId)).toEqual(["base"]);
  });

  test("removing the member from G drops their allowances", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await twoGroups(t);
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "base" }],
    });
    await as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: member });
    const left = await t.run((ctx) => ctx.db.query("groupMemberAgents").collect());
    expect(left).toEqual([]);
  });
});

// ===========================================================================
describe("group default agent", () => {
  test("exactly one default, only among the group's agents, managers of that group only", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G, H } = await seed(t);
    await agent(t, "prod", "second");
    await share(t, G, "prod", "second");
    await as(t, mgr).mutation(api.groups.setGroupDefaultAgent, {
      groupId: G,
      agent: { instanceName: "prod", agentId: "second" },
    });
    await as(t, mgr).mutation(api.groups.setGroupDefaultAgent, {
      groupId: G,
      agent: { instanceName: "prod", agentId: "base" },
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("groupAgents").withIndex("by_group", (q) => q.eq("groupId", G)).collect(),
    );
    expect(rows.filter((r) => r.isDefault === true).map((r) => r.agentId)).toEqual(["base"]);
    expect((await t.run((ctx) => getEffectiveGrants(ctx, member))).find((g) => g.isDefault)?.agentId).toBe("base");
    await expect(
      as(t, mgr).mutation(api.groups.setGroupDefaultAgent, {
        groupId: G,
        agent: { instanceName: "prod", agentId: "open" },
      }),
    ).rejects.toThrow(/must be shared with this group/);
    await expect(
      as(t, mgr).mutation(api.groups.setGroupDefaultAgent, { groupId: H, agent: null }),
    ).rejects.toThrow(/not a manager/);
  });
});

// ===========================================================================
describe("audit: every step, unconditionally, with the real actor", () => {
  test("claim, member settings, invitations, enablement, reservation, direct grants", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G, H } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "forged" }],
    });
    await as(t, mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: G,
      userId: member,
      agent: { instanceName: "prod", agentId: "forged" },
    });
    await as(t, mgr).mutation(api.groups.setGroupDefaultAgent, {
      groupId: G,
      agent: { instanceName: "prod", agentId: "base" },
    });
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, mgr).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    const req = await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "n@example.com" });
    await as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId: req, approve: false });
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "open", enabled: false });
    await as(t, admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "forged", groupId: null });
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", member)).unique())!._id,
    );
    // An admin grant on H's agent: leaving G neither empties their groups nor lifts it.
    await as(t, admin).mutation(api.agents.assignAgent, { profileId, instanceName: "prod", agentId: "other" });
    await join(t, H, member); // not their last group
    await as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: member });

    const rows = await audit(t);
    const byMgr = rows.filter((r) => r.realUserId === mgr).map((r) => r.action);
    expect(byMgr).toEqual([
      "group.claimAgent",
      "group.restrictMember",
      "group.setMemberDefault",
      "group.setDefaultAgent",
      "group.removeAgent",
      "group.assignAgent",
      "group.inviteRequest",
      "group.removeMember",
    ]);
    const byAdmin = rows.filter((r) => r.realUserId === admin).map((r) => r.action);
    expect(byAdmin).toEqual([
      "group.inviteReject",
      "agent.disable",
      "agent.reservation.lift",
      "userAgent.grant",
    ]);
    expect(rows.find((r) => r.action === "group.claimAgent")).toMatchObject({
      resource: "groupAgent",
      resourceId: `${G}:prod/forged`,
    });
    expect(rows.find((r) => r.action === "group.removeMember")).toMatchObject({
      resource: "groupMember",
      resourceId: `${G}:${member}`,
    });
  });
});

// ===========================================================================
describe("cascades never leave a per-member allowance behind", () => {
  async function restricted(t: T) {
    const s = await seed(t);
    await agent(t, "prod", "second");
    await share(t, s.G, "prod", "second");
    await as(t, s.mgr).mutation(api.groups.setMemberAgents, {
      groupId: s.G,
      userId: s.member,
      agents: [{ instanceName: "prod", agentId: "second" }],
    });
    await as(t, s.mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: s.G,
      userId: s.member,
      agent: { instanceName: "prod", agentId: "second" },
    });
    return s;
  }
  const allowances = (t: T) => t.run((ctx) => ctx.db.query("groupMemberAgents").collect());
  const memberDefaults = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query("groupMembers").collect())
        .map((m) => m.defaultAgent)
        .filter((d) => d !== undefined),
    );

  test("an agent leaving the group takes the allowance and the member default with it", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await restricted(t);
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "second" });
    // The cleanup is ENQUEUED (never run per agent inside the unshare)…
    expect(await t.run((ctx) => ctx.db.query("groupMemberCleanups").collect())).toHaveLength(1);
    // …and a re-share right away finishes it first (a small group fits one batch):
    // the member's old choice does NOT come back by itself.
    await as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "second" });
    expect(await allowances(t)).toEqual([]);
    const m = await t.run((ctx) =>
      ctx.db.query("groupMembers").withIndex("by_user_group", (q) => q.eq("userId", member).eq("groupId", G)).unique(),
    );
    expect(m?.defaultAgent).toBeUndefined();
    expect(await ids(t, member)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("groupMemberCleanups").collect())).toEqual([]);
  });

  test("deleting the group purges allowances and invitation requests; a reservation stays", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await restricted(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "n@example.com" });
    await as(t, admin).mutation(api.groups.deleteGroup, { groupId: G });
    expect(await allowances(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("groupInviteRequests").collect())).toEqual([]);
    expect((await agentRow(t, "prod", "forged"))?.reservedForGroupId).toBe(G);
  });

  test("purging an absent agent, deleting the member's account, deleting the instance", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { admin } = await restricted(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", "second"))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
    });
    await as(t, admin).mutation(api.agents.removeInstanceAgent, { instanceName: "prod", agentId: "second" });
    // The member defaults go through the durable member cleanup it enqueued.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await allowances(t)).toEqual([]);
    expect(await memberDefaults(t)).toEqual([]);

    const t2 = convexTest(schema, modules);
    const s2 = await restricted(t2);
    const profileId = await t2.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", s2.member)).unique())!._id,
    );
    await as(t2, s2.admin).mutation(api.admin.deleteUser, { profileId });
    expect(await allowances(t2)).toEqual([]);

    const t3 = convexTest(schema, modules);
    const s3 = await restricted(t3);
    const instanceId = await t3.run(async (ctx) =>
      (await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first())!._id,
    );
    await as(t3, s3.admin).mutation(api.admin.deleteInstance, { instanceId });
    await t3.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await allowances(t3)).toEqual([]);
    expect(await memberDefaults(t3)).toEqual([]);
  });
});

// ===========================================================================
describe("review fixes", () => {
  async function narrowedByAdmin(t: T) {
    const s = await seed(t);
    await agent(t, "prod", "second");
    await share(t, s.G, "prod", "second");
    // `member` is in G only; an ADMIN narrows them to `base` with a direct grant.
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", s.member)).unique())!._id,
    );
    await as(t, s.admin).mutation(api.agents.assignAgent, { profileId, instanceName: "prod", agentId: "base" });
    return s;
  }

  test("P2-1 a member restriction never undoes an admin's narrowing (all mirrors)", async () => {
    const t = convexTest(schema, modules);
    const { mgr, member, G } = await narrowedByAdmin(t);
    expect(await ids(t, member)).toEqual(["prod/base"]);
    await as(t, mgr).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "second" }],
    });
    expect(await ids(t, member)).toEqual([]);
    expect((await counts(t, [member]))[member]).toBe(0);
    expect(await t.run((ctx) => userMayAccessInstance(ctx, member, "prod"))).toBe(false);
    const view = await as(t, mgr).query(api.groups.getMemberAgentSettings, { groupId: G, userId: member });
    expect(view?.adminNarrowed).toBe(true);
    expect(view?.agents.find((a) => a.agentId === "second")?.limitedByAdmin).toBe(true);
    expect(view?.agents.find((a) => a.agentId === "base")?.limitedByAdmin).toBe(false);
  });

  test("P2-2 a manager never edits their own or a co-manager's agents", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: mgr, agents: null }),
    ).rejects.toThrow(/their own agents/);
    await expect(
      as(t, mgr).mutation(api.groups.setMemberDefaultAgent, { groupId: G, userId: mgr, agent: null }),
    ).rejects.toThrow(/their own agents/);
    await as(t, admin).mutation(api.groups.setGroupManager, { groupId: G, userId: member, manager: true });
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: [] }),
    ).rejects.toThrow(/group manager's agents/);
    const view = await as(t, mgr).query(api.groups.getMemberAgentSettings, { groupId: G, userId: member });
    expect(view?.settable).toBe(false);
  });

  test("P2-2 an admin-set restriction: a manager may narrow it, never lift or widen it", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await agent(t, "prod", "second");
    await share(t, G, "prod", "second");
    await as(t, admin).mutation(api.groups.setMemberAgents, {
      groupId: G,
      userId: member,
      agents: [{ instanceName: "prod", agentId: "base" }],
    });
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: null }),
    ).rejects.toThrow(/lift a restriction an admin set/);
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, {
        groupId: G,
        userId: member,
        agents: [
          { instanceName: "prod", agentId: "base" },
          { instanceName: "prod", agentId: "second" },
        ],
      }),
    ).rejects.toThrow(/widen a restriction an admin set/);
    await as(t, mgr).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: [] });
    // Still admin-set after the manager's narrowing: widening back is refused too.
    await expect(
      as(t, mgr).mutation(api.groups.setMemberAgents, {
        groupId: G,
        userId: member,
        agents: [{ instanceName: "prod", agentId: "base" }],
      }),
    ).rejects.toThrow(/widen a restriction an admin set/);
    await as(t, admin).mutation(api.groups.setMemberAgents, { groupId: G, userId: member, agents: null });
    expect(await ids(t, member)).toEqual(["prod/base", "prod/second"]);
  });

  test("P2-3 a manager never removes someone's last group (single or bulk); an admin does", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await expect(
      as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: member }),
    ).rejects.toThrow(/last group/);
    await expect(
      as(t, mgr).mutation(api.groups.bulkSetMembers, { groupId: G, userIds: [member], member: false }),
    ).rejects.toThrow(/last group/);
    const detail = await as(t, mgr).query(api.groups.getGroup, { groupId: G });
    expect(detail.members.find((m) => m.userId === member)?.lastGroup).toBe(true);
    await as(t, admin).mutation(api.groups.removeMember, { groupId: G, userId: member });
  });

  test("P3-2 a purged, decided agent comes back decided (not claimable); an undecided one stays claimable", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    await fresh(t, "prod", "burned");
    await fresh(t, "prod", "untouched");
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "burned", enabled: false });
    for (const agentId of ["burned", "untouched"]) {
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("agents")
          .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", agentId))
          .first();
        await ctx.db.patch(row!._id, { presentInLastOk: false });
      });
      await as(t, admin).mutation(api.agents.removeInstanceAgent, { instanceName: "prod", agentId });
    }
    const descriptor = (agentId: string) => ({
      agentId,
      displayName: null,
      emoji: null,
      model: null,
      isDefaultOnInstance: false,
    });
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: ["base", "other", "open", "burned", "untouched"].map(descriptor),
    });
    expect((await agentRow(t, "prod", "burned"))?.enablementDecidedAt).toBeTypeOf("number");
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "burned" }),
    ).rejects.toThrow(/\(decided\)/);
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "untouched" });
    expect(await t.run((ctx) => ctx.db.query("agentDecisionTombstones").collect())).toEqual([]);
  });

  test("P3-2 deleting the instance sweeps its purge decisions", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { admin } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("agentDecisionTombstones", { instanceName: "prod", agentId: "gone", enablementDecidedAt: 1 }),
    );
    const instanceId = await t.run(async (ctx) =>
      (await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first())!._id,
    );
    await as(t, admin).mutation(api.admin.deleteInstance, { instanceId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("agentDecisionTombstones").collect())).toEqual([]);
  });

  test("P3-5 a manager learns nothing about an instance outside the group's reach", async () => {
    const t = convexTest(schema, modules);
    const { mgr, G } = await seed(t);
    await fresh(t, "lab", "stray");
    const view = await as(t, mgr).query(api.groups.listAssignableAgents, { instanceName: "lab", groupId: G });
    expect(view).toEqual({ agents: [], discovery: null });
  });
});

// ===========================================================================
describe("review pass 2", () => {
  const directGrant = async (t: T, admin: Id<"users">, userId: Id<"users">, agentId: string) => {
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!._id,
    );
    await as(t, admin).mutation(api.agents.assignAgent, { profileId, instanceName: "prod", agentId });
  };
  const LIFT = /admin_restriction_would_lift/;

  test("P2-A a manager's unshare never lifts an admin's narrowing (single and bulk); an admin may", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await agent(t, "prod", "second");
    await share(t, G, "prod", "second");
    await directGrant(t, admin, member, "base"); // member narrowed to {base}
    expect(await ids(t, member)).toEqual(["prod/base"]);
    await expect(
      as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "base" }),
    ).rejects.toThrow(LIFT);
    await expect(
      as(t, mgr).mutation(api.groups.bulkSetGroupAgents, {
        groupId: G,
        instanceName: "prod",
        agentIds: ["second", "base"],
        assigned: false,
      }),
    ).rejects.toThrow(LIFT);
    // Atomic: `second` survived the refused batch; the member is still narrowed.
    expect(await ids(t, member)).toEqual(["prod/base"]);
    const shared = await t.run((ctx) =>
      ctx.db.query("groupAgents").withIndex("by_group", (q) => q.eq("groupId", G)).collect(),
    );
    expect(shared.map((r) => r.agentId).sort()).toEqual(["base", "second"]);
    // An unshare that lifts nothing still goes through.
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "second" });
    // The admin stays free to decide.
    await as(t, admin).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "base" });
  });

  test("P2-A variant: removing then re-adding a reserved agent cannot toggle an admin's narrowing", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await directGrant(t, admin, member, "forged"); // narrowed to {forged}
    expect(await ids(t, member)).toEqual(["prod/forged"]);
    await expect(
      as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "forged" }),
    ).rejects.toThrow(LIFT);
    expect(await ids(t, member)).toEqual(["prod/forged"]);
  });

  test("P2-B removing a member from one group never widens them in the others (single and bulk)", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G, H } = await seed(t);
    await join(t, H, member); // H shares `other`
    await directGrant(t, admin, member, "base"); // narrowed to {base} (G's agent)
    expect(await ids(t, member)).toEqual(["prod/base"]);
    await expect(
      as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: member }),
    ).rejects.toThrow(LIFT);
    await expect(
      as(t, mgr).mutation(api.groups.bulkSetMembers, { groupId: G, userIds: [member], member: false }),
    ).rejects.toThrow(LIFT);
    expect(await ids(t, member)).toEqual(["prod/base"]);
    await as(t, admin).mutation(api.groups.removeMember, { groupId: G, userId: member });
  });

  test("P2-B a removal that leaves the narrowing standing is allowed", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G, H } = await seed(t);
    await join(t, H, member);
    await directGrant(t, admin, member, "other"); // narrowed by H's agent
    await as(t, mgr).mutation(api.groups.removeMember, { groupId: G, userId: member });
    expect(await ids(t, member)).toEqual(["prod/other"]);
  });

  test("P3-2 purging an agent is audited", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seed(t);
    await agent(t, "prod", "ghost", { presentInLastOk: false });
    await as(t, admin).mutation(api.agents.removeInstanceAgent, { instanceName: "prod", agentId: "ghost" });
    expect((await audit(t)).filter((r) => r.action === "agent.purge")).toEqual([
      { action: "agent.purge", resource: "agent", resourceId: "prod/ghost", realUserId: admin },
    ]);
  });

  test("P3-3 reserving applies the share gate (discovered, present, enabled)", async () => {
    const t = convexTest(schema, modules);
    const { admin, G } = await seed(t);
    await agent(t, "prod", "off", { enabled: false });
    await expect(
      as(t, admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "off", groupId: G }),
    ).rejects.toThrow(/not assignable/);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("groupAgents")
          .withIndex("by_group_instance_agent", (q) => q.eq("groupId", G).eq("instanceName", "prod").eq("agentId", "off"))
          .unique(),
      ),
    ).toBeNull();
  });

  test("P3-5 deleting an account drops its invitation rows; a decision never rings a missing requester", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    await user(t, { email: "joiner@example.com" });
    const approved = await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "joiner@example.com" });
    await as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId: approved, approve: true });
    const pending = await as(t, mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: G, email: "later@example.com" });
    // A decision racing the requester's deletion: the profile is gone, the row not yet.
    await t.run(async (ctx) => {
      const p = await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", mgr)).unique();
      await ctx.db.delete(p!._id);
    });
    await as(t, admin).mutation(api.groupInvites.decideGroupInvite, { requestId: pending, approve: false });
    const rung = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.dedupeKey === `group_invite_decided:${pending}`),
    );
    expect(rung).toEqual([]);
    // Account deletion drops the rows naming the account (requester and approved).
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    await user(t2, { email: "joiner@example.com" });
    const req = await as(t2, s2.mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: s2.G, email: "joiner@example.com" });
    await as(t2, s2.admin).mutation(api.groupInvites.decideGroupInvite, { requestId: req, approve: true });
    const joinerProfile = await t2.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_email_lower", (q) => q.eq("emailLower", "joiner@example.com")).first())!._id,
    );
    await as(t2, s2.admin).mutation(api.admin.deleteUser, { profileId: joinerProfile });
    expect(await t2.run((ctx) => ctx.db.query("groupInviteRequests").collect())).toEqual([]);
    const mgrProfile = await t2.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", s2.mgr)).unique())!._id,
    );
    await as(t2, s2.mgr).mutation(api.groupInvites.requestGroupInvite, { groupId: s2.G, email: "x@example.com" });
    await as(t2, s2.admin).mutation(api.admin.deleteUser, { profileId: mgrProfile });
    expect(await t2.run((ctx) => ctx.db.query("groupInviteRequests").collect())).toEqual([]);
  });

  test("P3-7 the group labels query is admin-only and label-only", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr } = await seed(t);
    expect(await as(t, admin).query(api.groups.listGroupLabels, {})).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "G" }), expect.objectContaining({ name: "H" })]),
    );
    const labels = await as(t, admin).query(api.groups.listGroupLabels, {});
    expect(Object.keys(labels[0]!).sort()).toEqual(["_id", "name"]);
    await expect(as(t, mgr).query(api.groups.listGroupLabels, {})).rejects.toThrow(/admin role required/);
  });
});

// ===========================================================================
describe("review pass 3", () => {
  // `alsoPresent`: other test agents the same poll still reports (a poll that omits
  // an agent marks it absent).
  const purgeAndRediscover = async (
    t: T,
    admin: Id<"users">,
    agentId: string,
    alsoPresent: string[] = [],
  ) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", agentId))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
    });
    await as(t, admin).mutation(api.agents.removeInstanceAgent, { instanceName: "prod", agentId });
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: ["base", "other", "open", ...alsoPresent, agentId].map((id) => ({
        agentId: id,
        displayName: null,
        emoji: null,
        model: null,
        isDefaultOnInstance: false,
      })),
    });
  };

  test("P2 a purged PRE-EPOCH agent (disabled or global) comes back decided, never claimable", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    // Pre-deploy rows: no enablementDecidedAt, created before the epoch.
    const disabled = await agent(t, "prod", "oldOff", { enabled: false });
    await agent(t, "prod", "oldOn", { enabled: true });
    const created = (await t.run((ctx) => ctx.db.get(disabled)))!._creationTime;
    await setEpoch(t, created + 1_000_000);
    for (const [agentId, other] of [["oldOff", "oldOn"], ["oldOn", "oldOff"]] as const) {
      await purgeAndRediscover(t, admin, agentId, [other]);
      expect((await agentRow(t, "prod", agentId))?.enablementDecidedAt).toBeTypeOf("number");
    }
    // Stamp the epoch before the re-created rows so only the decision can refuse.
    await setEpoch(t, 0);
    for (const agentId of ["oldOff", "oldOn"]) {
      await expect(
        as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId }),
      ).rejects.toThrow(/\(decided\)/);
    }
  });

  test("P2 an ENABLED row keeps its decision past a purge even with no marker", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    // Post-epoch (epoch 0) yet enabled with no marker: enabled is itself a decision.
    await agent(t, "prod", "live", { enabled: true });
    await purgeAndRediscover(t, admin, "live");
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "live" }),
    ).rejects.toThrow(/\(decided\)/);
  });

  test("P2 without a stamped epoch, a purge keeps the decision too", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G } = await seed(t);
    await agent(t, "prod", "early", { enabled: false });
    await setEpoch(t, undefined);
    await purgeAndRediscover(t, admin, "early");
    await setEpoch(t, 0);
    await expect(
      as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "early" }),
    ).rejects.toThrow(/\(decided\)/);
  });

  test("P3-1 a manager's share never switches a member INTO an admin's narrowing (single and bulk)", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    // An admin grant on an agent none of the member's groups shares: ignored today.
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", member)).unique())!._id,
    );
    await as(t, admin).mutation(api.agents.assignAgent, { profileId, instanceName: "prod", agentId: "forged" });
    expect(await ids(t, member)).toEqual(["prod/base"]);
    const APPLY = /admin_restriction_would_apply/;
    await expect(
      as(t, mgr).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "forged" }),
    ).rejects.toThrow(APPLY);
    await expect(
      as(t, mgr).mutation(api.groups.bulkSetGroupAgents, {
        groupId: G,
        instanceName: "prod",
        agentIds: ["forged"],
        assigned: true,
      }),
    ).rejects.toThrow(APPLY);
    expect(await ids(t, member)).toEqual(["prod/base"]);
    // The admin decides.
    await as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    expect(await ids(t, member)).toEqual(["prod/forged"]);
  });

  test("P3-2 moving a reservation records the old group's loss", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G, H } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "forged", groupId: H });
    const rows = (await audit(t)).filter((r) => r.realUserId === admin);
    expect(rows).toEqual([
      { action: "group.removeAgent", resource: "groupAgent", resourceId: `${G}:prod/forged`, realUserId: admin },
      { action: "agent.reservation.set", resource: "agent", resourceId: `prod/forged@${H}`, realUserId: admin },
    ]);
  });
});

// ===========================================================================
describe("review pass 4", () => {
  const refusalData = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as { data?: unknown }).data;
    }
    throw new Error("expected a refusal");
  };
  const grant = async (t: T, admin: Id<"users">, userId: Id<"users">, agentId: string) => {
    const profileId = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!._id,
    );
    await as(t, admin).mutation(api.agents.assignAgent, { profileId, instanceName: "prod", agentId });
  };

  test("P3-4 a refused bulk unshare names the blocking agent (never the member)", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    await agent(t, "prod", "second", { displayName: "Second" });
    await share(t, G, "prod", "second");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", "base"))
        .first();
      await ctx.db.patch(row!._id, { displayName: "Base" });
    });
    await grant(t, admin, member, "base");
    const data = await refusalData(
      as(t, mgr).mutation(api.groups.bulkSetGroupAgents, {
        groupId: G,
        instanceName: "prod",
        agentIds: ["second", "base"],
        assigned: false,
      }),
    );
    expect(data).toEqual({ code: "admin_restriction_would_lift", agent: "Base" });
  });

  test("P3-4 a refused bulk share names the blocking agent", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, member, G } = await seed(t);
    for (const id of ["first", "forged"]) {
      await fresh(t, "prod", id);
      await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: id });
      await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: id });
    }
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", "forged"))
        .first();
      await ctx.db.patch(row!._id, { displayName: "Forge" });
    });
    await grant(t, admin, member, "forged");
    const data = await refusalData(
      as(t, mgr).mutation(api.groups.bulkSetGroupAgents, {
        groupId: G,
        instanceName: "prod",
        agentIds: ["first", "forged"],
        assigned: true,
      }),
    );
    expect(data).toEqual({ code: "admin_restriction_would_apply", agent: "Forge" });
  });

  test("P3-1 moving a reservation the old group already dropped writes no second removal", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, G, H } = await seed(t);
    await fresh(t, "prod", "forged");
    await as(t, mgr).mutation(api.groups.claimAgentForGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "forged" });
    await as(t, admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "forged", groupId: H });
    const removals = (await audit(t)).filter((r) => r.action === "group.removeAgent");
    expect(removals).toEqual([
      { action: "group.removeAgent", resource: "groupAgent", resourceId: `${G}:prod/forged`, realUserId: mgr },
    ]);
  });

  test("P3-3 an unshare ignores a direct-grant holder who is not in the group", async () => {
    const t = convexTest(schema, modules);
    const { admin, mgr, hMember, G, H } = await seed(t);
    await share(t, H, "prod", "base"); // hMember reaches base through H only
    await grant(t, admin, hMember, "base");
    // G unsharing base changes nothing for hMember (not a member of G).
    await as(t, mgr).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "base" });
    expect(await ids(t, hMember)).toEqual(["prod/base"]);
  });
});

// ===========================================================================
describe("an agent leaving a LARGE group: bounded batches, durable continuation", () => {
  const MEMBERS = 350; // > 3 batches of MEMBER_CLEANUP_BATCH (100)

  async function bigGroup(t: T) {
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MEMBERS; i++) {
        const uid = await ctx.db.insert("users", {});
        await ctx.db.insert("profiles", { userId: uid, role: "user" });
        await ctx.db.insert("groupMembers", {
          groupId: s.G,
          userId: uid,
          joinedAt: 1,
          defaultAgent: { instanceName: "prod", agentId: "base" },
          ...(i % 2 === 0 ? { agentsRestricted: true } : {}),
        });
        if (i % 2 === 0) {
          await ctx.db.insert("groupMemberAgents", {
            groupId: s.G,
            userId: uid,
            instanceName: "prod",
            agentId: "base",
            createdAt: 1,
          });
        }
      }
    });
    return s;
  }
  const leftovers = (t: T, G: Id<"groups">) =>
    t.run(async (ctx) => ({
      defaults: (await ctx.db.query("groupMembers").withIndex("by_group", (q) => q.eq("groupId", G)).collect()).filter(
        (m) => m.defaultAgent?.agentId === "base",
      ).length,
      allowances: (
        await ctx.db
          .query("groupMemberAgents")
          .withIndex("by_group_instance_agent", (q) => q.eq("groupId", G).eq("instanceName", "prod").eq("agentId", "base"))
          .collect()
      ).length,
      pending: (await ctx.db.query("groupMemberCleanups").collect()).length,
    }));

  test("the unshare only ENQUEUES the cleanup; it runs in bounded batches on its own; a re-share waits for it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { admin, G } = await bigGroup(t);
    await as(t, admin).mutation(api.groups.removeAgentFromGroup, { groupId: G, instanceName: "prod", agentId: "base" });
    // Nothing cleared inside the unshare: one durable job.
    expect(await leftovers(t, G)).toEqual({ defaults: MEMBERS, allowances: MEMBERS / 2, pending: 1 });
    // One worker run = one bounded batch.
    await t.run((ctx) => memberCleanupBatch(ctx, G, "prod", "base"));
    expect(await leftovers(t, G)).toEqual({ defaults: MEMBERS - 100, allowances: MEMBERS / 2 - 100, pending: 1 });
    // Sharing it back NOW would bring the old per-member choices back: refused.
    await expect(
      as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "base" }),
    ).rejects.toThrow(/member_cleanup_pending/);
    // The continuation finishes on its own, batch by batch, and releases the share.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await leftovers(t, G)).toEqual({ defaults: 0, allowances: 0, pending: 0 });
    await as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "base" });
  });

  test("a batch reads only the rows it changes: other members' defaults are never touched", async () => {
    const t = convexTest(schema, modules);
    const { G } = await bigGroup(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        const uid = await ctx.db.insert("users", {});
        await ctx.db.insert("groupMembers", {
          groupId: G,
          userId: uid,
          joinedAt: 1,
          defaultAgent: { instanceName: "prod", agentId: "second" },
        });
      }
    });
    expect(await t.run((ctx) => memberCleanupBatch(ctx, G, "prod", "base"))).toBe(false);
    const after = await t.run(async (ctx) =>
      (await ctx.db.query("groupMembers").withIndex("by_group", (q) => q.eq("groupId", G)).collect()).filter(
        (m) => m.defaultAgent?.agentId === "second",
      ).length,
    );
    expect(after).toBe(50);
    expect((await leftovers(t, G)).defaults).toBe(MEMBERS - MEMBER_CLEANUP_BATCH);
  });

  test("the instance purge clears a large group's defaults in cascade batches and completes", async () => {
    const t = convexTest(schema, modules);
    const { G } = await bigGroup(t);
    // The instance row is gone (deleteInstanceCascade removes it first; the sweep
    // stops on a live name).
    await t.run(async (ctx) => {
      const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first();
      await ctx.db.delete(inst!._id);
    });
    let passes = 0;
    for (;;) {
      const r = await t.run((ctx) => sweepInstanceNameBoundBatch(ctx, "prod"));
      passes += 1;
      if (r === "done") break;
      if (passes > 200) throw new Error("cascade never completed");
    }
    expect((await leftovers(t, G)).defaults).toBe(0);
    expect(passes).toBeGreaterThan(1);
  });

  test("a BULK unshare of 200 agents enqueues one job each — no cleanup batch inside the mutation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { admin, G } = await bigGroup(t);
    const AGENTS = 200;
    await t.run(async (ctx) => {
      for (let i = 0; i < AGENTS; i++) {
        await ctx.db.insert("agents", {
          instanceName: "prod",
          agentId: `bulk-${i}`,
          source: "discovered",
          presentInLastOk: true,
          enabled: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        });
        await ctx.db.insert("groupAgents", { groupId: G, instanceName: "prod", agentId: `bulk-${i}`, createdAt: 1 });
      }
      // 100 restricted members allowed EVERY bulk agent: 20,000 allowances.
      const restricted = (await ctx.db.query("groupMembers").withIndex("by_group", (q) => q.eq("groupId", G)).collect())
        .filter((m) => m.agentsRestricted === true)
        .slice(0, 100);
      for (const m of restricted) {
        for (let i = 0; i < AGENTS; i++) {
          await ctx.db.insert("groupMemberAgents", {
            groupId: G,
            userId: m.userId,
            instanceName: "prod",
            agentId: `bulk-${i}`,
            createdAt: 1,
          });
        }
      }
    });
    const countBulkAllowances = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("groupMemberAgents").collect()).filter((r) => r.agentId.startsWith("bulk-")).length,
      );
    expect(await countBulkAllowances()).toBe(20_000);
    await as(t, admin).mutation(api.groups.bulkSetGroupAgents, {
      groupId: G,
      instanceName: "prod",
      agentIds: Array.from({ length: AGENTS }, (_, i) => `bulk-${i}`),
      assigned: false,
    });
    // The mutation deleted NONE of them: it enqueued one job per agent.
    expect(await countBulkAllowances()).toBe(20_000);
    expect(await t.run((ctx) => ctx.db.query("groupMemberCleanups").collect())).toHaveLength(AGENTS);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await countBulkAllowances()).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("groupMemberCleanups").collect())).toEqual([]);
  }, 180_000);

  test("purging an agent granted and allowed far beyond one batch completes through its continuation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { admin, G } = await bigGroup(t);
    const USERS = AGENT_ACCESS_BATCH * 3 + 7;
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", "base"))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
      for (let i = 0; i < USERS; i++) {
        const uid = await ctx.db.insert("users", {});
        await ctx.db.insert("userAgents", {
          userId: uid,
          instanceName: "prod",
          agentId: "base",
          isDefault: true,
          source: "manual",
          createdAt: 1,
        } as never);
        await ctx.db.insert("userAgents", {
          userId: uid,
          instanceName: "prod",
          agentId: "other",
          isDefault: false,
          source: "manual",
          createdAt: 1,
        } as never);
      }
    });
    const left = () =>
      t.run(async (ctx) => ({
        grants: (
          await ctx.db
            .query("userAgents")
            .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", "base"))
            .collect()
        ).length,
        allowances: (
          await ctx.db
            .query("groupMemberAgents")
            .withIndex("by_instance_agent", (q) => q.eq("instanceName", "prod").eq("agentId", "base"))
            .collect()
        ).length,
      }));
    await as(t, admin).mutation(api.agents.removeInstanceAgent, { instanceName: "prod", agentId: "base" });
    // ONE bounded batch of each kind in the purge's own transaction.
    expect(await left()).toEqual({ grants: USERS - AGENT_ACCESS_BATCH, allowances: MEMBERS / 2 - AGENT_ACCESS_BATCH });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await left()).toEqual({ grants: 0, allowances: 0 });
    expect((await leftovers(t, G)).defaults).toBe(0);
    // Every user who lost their default got the one they had left.
    const defaults = await t.run(async (ctx) =>
      (await ctx.db.query("userAgents").collect()).filter((g) => g.agentId === "other" && g.isDefault).length,
    );
    expect(defaults).toBe(USERS);
  }, 60_000);
});

describe("audit references are bounded per row (a group may share thousands of agents)", () => {
  const ref = (i: number) => ({ instanceName: "prod", agentId: `a-${i}` });

  test("8,193 added + 8,193 removed: every reference kept, never more than AUDIT_REFS_PER_ROW per row", () => {
    const added = Array.from({ length: 8193 }, (_, i) => ref(i));
    const removed = Array.from({ length: 8193 }, (_, i) => ref(100_000 + i));
    const rows = splitAuditDetails({ agentsAdded: added, agentsRemoved: removed, previousDefaultAgent: ref(1), defaultAgent: null });
    expect(rows.length).toBe(Math.ceil(16386 / AUDIT_REFS_PER_ROW));
    for (const [i, r] of rows.entries()) {
      expect((r!.agentsAdded?.length ?? 0) + (r!.agentsRemoved?.length ?? 0)).toBeLessThanOrEqual(AUDIT_REFS_PER_ROW);
      expect(r!.chunk).toEqual({ index: i + 1, of: rows.length });
    }
    expect(rows.flatMap((r) => r!.agentsAdded ?? [])).toEqual(added);
    expect(rows.flatMap((r) => r!.agentsRemoved ?? [])).toEqual(removed);
    // The default change rides the first row only.
    expect(rows[0]!.previousDefaultAgent).toEqual(ref(1));
    expect(rows.slice(1).every((r) => r!.previousDefaultAgent === undefined)).toBe(true);
    // A small change stays one row, untouched.
    expect(splitAuditDetails({ agentsAdded: [ref(1)], agentsRemoved: [] })).toEqual([{ agentsAdded: [ref(1)], agentsRemoved: [] }]);
  });

  test("lifting a restriction in a group of 1,200 agents audits every one, in bounded rows", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 1200; i++) {
        await ctx.db.insert("agents", {
          instanceName: "prod",
          agentId: `many-${i}`,
          source: "discovered",
          presentInLastOk: true,
          enabled: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        });
        await ctx.db.insert("groupAgents", { groupId: s.G, instanceName: "prod", agentId: `many-${i}`, createdAt: 1 });
      }
    });
    await as(t, s.mgr).mutation(api.groups.setMemberAgents, { groupId: s.G, userId: s.member, agents: [] });
    await as(t, s.mgr).mutation(api.groups.setMemberAgents, { groupId: s.G, userId: s.member, agents: null });
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((r) => r.action === "group.unrestrictMember"),
    );
    expect(rows.length).toBe(Math.ceil(1201 / AUDIT_REFS_PER_ROW));
    expect(rows.flatMap((r) => r.details?.agentsAdded ?? []).length).toBe(1201); // 1,200 + base
    for (const r of rows) expect((r.details?.agentsAdded ?? []).length).toBeLessThanOrEqual(AUDIT_REFS_PER_ROW);
  }, 60_000);
});

describe("a share finishing pending cleanups spends ONE budget per mutation", () => {
  test("with the budget spent, a pending cleanup is refused WITHOUT running another batch", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("groupMembers", {
        groupId: s.G,
        userId: s.loner,
        joinedAt: 1,
        defaultAgent: { instanceName: "prod", agentId: "open" },
      });
      await ctx.db.insert("groupMemberCleanups", { groupId: s.G, instanceName: "prod", agentId: "open", createdAt: 1 });
    });
    const budget = { batches: 0 };
    await expect(
      t.run((ctx) => assertNoPendingMemberCleanup(ctx, s.G, "prod", "open", budget)),
    ).rejects.toThrow(/member_cleanup_pending/);
    // Untouched: no batch ran on a spent budget.
    const d = await t.run(async (ctx) =>
      (await ctx.db.query("groupMembers").withIndex("by_user_group", (q) => q.eq("userId", s.loner).eq("groupId", s.G)).unique())
        ?.defaultAgent,
    );
    expect(d).toEqual({ instanceName: "prod", agentId: "open" });
    // With budget left, the same small cleanup is finished and the share may go.
    const fresh = { batches: 2 };
    await t.run((ctx) => assertNoPendingMemberCleanup(ctx, s.G, "prod", "open", fresh));
    expect(fresh.batches).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("groupMemberCleanups").collect())).toEqual([]);
  });
});

// ===========================================================================
// codex pass 7 — a purge takes effect in its own transaction, not when the last
// sweep batch runs: no resolver lets an old row through, a re-discovered agent does
// not revive one, and no assignment lands on (or is mistaken for) a row the sweep
// is about to delete.
describe("an agent purge takes effect immediately, whatever is left to sweep", () => {
  const USERS = 250;
  const GROUPS = 150;
  const GHOST = { instanceName: "lab", agentId: "ghost" } as const;

  // 250 groupless users holding ghost (their default) + prod/base; 150 groups each
  // sharing ghost + base with one member who defaults to ghost, three in four of them
  // restricted to both. Every kind of access row is more than one sweep batch.
  async function purgeWorld(t: T) {
    const s = await seed(t);
    await agent(t, "lab", "ghost");
    const built = await t.run(async (ctx) => {
      const person = async () => {
        const uid = await ctx.db.insert("users", {});
        await ctx.db.insert("profiles", { userId: uid, role: "user", extraPermissions: ["agents.files.read"] });
        return uid;
      };
      const users: Id<"users">[] = [];
      for (let i = 0; i < USERS; i++) {
        const uid = await person();
        await ctx.db.insert("userAgents", { userId: uid, ...GHOST, isDefault: true, source: "manual", createdAt: 1 });
        await ctx.db.insert("userAgents", {
          userId: uid,
          instanceName: "prod",
          agentId: "base",
          isDefault: false,
          source: "manual",
          createdAt: 1,
        });
        users.push(uid);
      }
      const members: Id<"users">[] = [];
      const groups: Id<"groups">[] = [];
      for (let i = 0; i < GROUPS; i++) {
        const g = await ctx.db.insert("groups", { key: `pg-${i}`, name: `PG ${i}`, createdBy: s.admin, createdAt: 10 + i });
        await ctx.db.insert("groupAgents", { groupId: g, ...GHOST, createdAt: 1 });
        await ctx.db.insert("groupAgents", { groupId: g, instanceName: "prod", agentId: "base", createdAt: 1 });
        const uid = await person();
        const restricted = i % 4 !== 0;
        await ctx.db.insert("groupMembers", {
          groupId: g,
          userId: uid,
          joinedAt: 1,
          defaultAgent: { ...GHOST },
          ...(restricted ? { agentsRestricted: true } : {}),
        });
        if (restricted) {
          await ctx.db.insert("groupMemberAgents", { groupId: g, userId: uid, ...GHOST, createdAt: 1 });
          await ctx.db.insert("groupMemberAgents", { groupId: g, userId: uid, instanceName: "prod", agentId: "base", createdAt: 1 });
        }
        members.push(uid);
        groups.push(g);
      }
      return { users, members, groups };
    });
    return { ...s, ...built };
  }

  const purgeGhost = async (t: T, admin: Id<"users">) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "lab").eq("agentId", "ghost"))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
    });
    await as(t, admin).mutation(api.agents.removeInstanceAgent, { ...GHOST });
  };

  const rediscoverAndEnable = async (t: T, admin: Id<"users">) => {
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "lab",
      agents: [{ agentId: "ghost", displayName: null, emoji: null, model: null, isDefaultOnInstance: false }],
    });
    await as(t, admin).mutation(api.agents.setAgentEnabled, { ...GHOST, enabled: true });
  };

  const remaining = (t: T) =>
    t.run(async (ctx) => {
      const grants = await ctx.db
        .query("userAgents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "lab").eq("agentId", "ghost"))
        .collect();
      const shares = await ctx.db
        .query("groupAgents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "lab").eq("agentId", "ghost"))
        .collect();
      const allowances = await ctx.db
        .query("groupMemberAgents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "lab").eq("agentId", "ghost"))
        .collect();
      return {
        grantUsers: grants.map((r) => r.userId),
        shareGroups: shares.map((r) => r.groupId),
        allowanceUsers: allowances.map((r) => r.userId),
        marker: (await ctx.db.query("agentPurges").collect()).length,
      };
    });

  /** Who still reaches ghost, through ANY resolver: the effective set, the
   *  instance gate of the ingest path, routing a turn to it, knowledge. */
  const reachesGhost = (t: T, uids: Id<"users">[]) =>
    t.run(async (ctx) => {
      const out: Id<"users">[] = [];
      for (const uid of uids) {
        const chat = { userId: uid } as Doc<"chats">;
        const grants = await getEffectiveGrants(ctx, uid);
        const routed = await resolveTargetForTurn(ctx, chat, uid, { ...GHOST });
        if (
          grants.some((g) => g.instanceName === "lab" && g.agentId === "ghost") ||
          (await userMayAccessInstance(ctx, uid, "lab")) ||
          (await knowledgeAgentReachable(ctx, chat, GHOST)) ||
          routed.target !== null
        ) {
          out.push(uid);
        }
      }
      return out;
    });

  const filesOpen = async (t: T, uid: Id<"users">) => {
    try {
      await as(t, uid).query(internal.agentFiles.checkFilesReadAccess, { ...GHOST });
      return true;
    } catch (e) {
      expect(String(e)).toMatch(/forbidden/);
      return false;
    }
  };

  const profileOf = (t: T, uid: Id<"users">) =>
    t.run(async (ctx) =>
      (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", uid)).unique())!._id,
    );

  test("250 grants, 150 groups: nobody reaches it between batches — nor after a re-discovery and re-enable", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await purgeWorld(t);
    // The fixture means something: before the purge they all reach it.
    expect(await reachesGhost(t, [w.users[0]!, w.members[1]!, w.members[4]!])).toHaveLength(3);
    expect(await filesOpen(t, w.users[0]!)).toBe(true);

    await purgeGhost(t, w.admin);
    const mid = await remaining(t);
    // The window exists: rows of every kind are still there, and so is the marker.
    expect(mid.grantUsers).toHaveLength(USERS - AGENT_ACCESS_BATCH);
    expect(mid.shareGroups).toHaveLength(GROUPS - AGENT_ACCESS_BATCH);
    expect(mid.allowanceUsers.length).toBeGreaterThan(0);
    expect(mid.marker).toBe(1);
    const inShare = new Set(mid.shareGroups);
    const sharedMembers = w.members.filter((_, i) => inShare.has(w.groups[i]!));
    expect(sharedMembers).toHaveLength(GROUPS - AGENT_ACCESS_BATCH);
    const subjects = [...mid.grantUsers, ...sharedMembers];

    const assertNobody = async () => {
      expect(await reachesGhost(t, subjects)).toEqual([]);
      // The batched admin summary mirrors it: base only, for everyone.
      expect(new Set(Object.values(await counts(t, subjects)))).toEqual(new Set([1]));
      expect(await filesOpen(t, mid.grantUsers[0]!)).toBe(false);
      expect(await filesOpen(t, sharedMembers[0]!)).toBe(false);
    };
    await assertNobody();
    // Re-discovered and re-enabled before the sweep ends: still nobody.
    await rediscoverAndEnable(t, w.admin);
    await assertNobody();

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await remaining(t)).toEqual({ grantUsers: [], shareGroups: [], allowanceUsers: [], marker: 0 });
    await assertNobody();
    // The members' defaults naming it went with the shares (durable member cleanup).
    const namedDefaults = await t.run(async (ctx) =>
      (await ctx.db.query("groupMembers").collect()).filter((m) => m.defaultAgent?.agentId === "ghost").length,
    );
    expect(namedDefaults).toBe(0);
  }, 300_000);

  test("re-assigning a user mid-purge is refused (retryable), never a silent no-op; after the sweep it sticks", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await purgeWorld(t);
    await purgeGhost(t, w.admin);
    await rediscoverAndEnable(t, w.admin);
    const victim = (await remaining(t)).grantUsers[0]!;
    const profileId = await profileOf(t, victim);
    await expect(
      as(t, w.admin).mutation(api.agents.assignAgent, { profileId, ...GHOST }),
    ).rejects.toThrow(/agent_purge_pending/);
    await expect(
      as(t, w.admin).mutation(api.agents.setDefaultAgent, { profileId, ...GHOST }),
    ).rejects.toThrow(/agent_purge_pending/);
    // A row written mid-purge by any other door is the NEW generation: live at once,
    // and never swept.
    const newcomer = await user(t);
    await t.run((ctx) =>
      ctx.db.insert("userAgents", { userId: newcomer, ...GHOST, isDefault: true, source: "manual", createdAt: 2 }),
    );
    expect(await reachesGhost(t, [newcomer])).toEqual([newcomer]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await reachesGhost(t, [newcomer])).toEqual([newcomer]);
    // The retry once the purge is done: a real row, and it survives.
    await as(t, w.admin).mutation(api.agents.assignAgent, { profileId, ...GHOST });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await reachesGhost(t, [victim])).toEqual([victim]);
    expect((await remaining(t)).grantUsers.sort()).toEqual([newcomer, victim].sort());
  }, 300_000);

  test("every group path refuses mid-purge; a share and member default made after it survive", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await purgeWorld(t);
    await purgeGhost(t, w.admin);
    await rediscoverAndEnable(t, w.admin);
    const mid = await remaining(t);
    // An unrestricted member whose group's old share is still there.
    const idx = w.groups.findIndex((g, i) => mid.shareGroups.includes(g) && i % 4 === 0);
    const G = w.groups[idx]!;
    const m = w.members[idx]!;
    const pending = /agent_purge_pending/;
    const admin = as(t, w.admin);
    await expect(admin.mutation(api.groups.assignAgentToGroup, { groupId: G, ...GHOST })).rejects.toThrow(pending);
    await expect(
      admin.mutation(api.groups.bulkSetGroupAgents, { groupId: G, instanceName: "lab", agentIds: ["ghost"], assigned: true }),
    ).rejects.toThrow(pending);
    await expect(admin.mutation(api.groups.setGroupDefaultAgent, { groupId: G, agent: { ...GHOST } })).rejects.toThrow(pending);
    await expect(
      admin.mutation(api.groups.setMemberAgents, { groupId: G, userId: m, agents: [{ ...GHOST }] }),
    ).rejects.toThrow(pending);
    await expect(
      admin.mutation(api.groups.setMemberDefaultAgent, { groupId: G, userId: m, agent: { ...GHOST } }),
    ).rejects.toThrow(pending);
    await expect(admin.mutation(api.groups.claimAgentForGroup, { groupId: G, ...GHOST })).rejects.toThrow(pending);
    await expect(admin.mutation(api.agents.setAgentReservation, { ...GHOST, groupId: G })).rejects.toThrow(pending);
    // The group views no longer list the revoked share.
    const view = await admin.query(api.groups.getGroup, { groupId: G });
    expect(view!.agents.map((a) => a.agentId)).toEqual(["base"]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await admin.mutation(api.groups.assignAgentToGroup, { groupId: G, ...GHOST });
    await admin.mutation(api.groups.setMemberDefaultAgent, { groupId: G, userId: m, agent: { ...GHOST } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await remaining(t)).shareGroups).toEqual([G]);
    const d = await t.run(async (ctx) =>
      (await ctx.db.query("groupMembers").withIndex("by_user_group", (q) => q.eq("userId", m).eq("groupId", G)).unique())!
        .defaultAgent,
    );
    expect(d).toEqual({ ...GHOST });
    expect(await reachesGhost(t, [m])).toEqual([m]);
  }, 300_000);

  test("a purge swept in one batch leaves no marker; deleting the instance mid-purge sweeps it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await agent(t, "lab", "small");
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId: s.loner,
        instanceName: "lab",
        agentId: "small",
        isDefault: true,
        source: "manual",
        createdAt: 1,
      });
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "lab").eq("agentId", "small"))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
    });
    await as(t, s.admin).mutation(api.agents.removeInstanceAgent, { instanceName: "lab", agentId: "small" });
    expect(await t.run((ctx) => ctx.db.query("agentPurges").collect())).toEqual([]);

    const t2 = convexTest(schema, modules);
    const w = await purgeWorld(t2);
    await purgeGhost(t2, w.admin);
    expect((await remaining(t2)).marker).toBe(1);
    await t2.run(async (ctx) => {
      const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "lab")).first();
      await ctx.db.delete(inst!._id);
    });
    for (let passes = 0; ; passes++) {
      if ((await t2.run((ctx) => sweepInstanceNameBoundBatch(ctx, "lab"))) === "done") break;
      if (passes > 200) throw new Error("cascade never completed");
    }
    expect(await remaining(t2)).toEqual({ grantUsers: [], shareGroups: [], allowanceUsers: [], marker: 0 });
  }, 300_000);
});

// codex pass 8 — the purge filter's memo under CONCURRENT resolution: the batched
// admin list resolves a page of users in parallel, and every one of them asks for
// the same agents' markers.
describe("the purge marker is read once per agent, however many users share it", () => {
  test("300 users × the same 15 direct grants: 15 marker reads, and the admin list succeeds", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const AGENTS = 15;
    const USERS = 300;
    const users = await t.run(async (ctx) => {
      for (let a = 0; a < AGENTS; a++) {
        await ctx.db.insert("agents", {
          instanceName: "prod",
          agentId: `shared-${a}`,
          source: "discovered",
          presentInLastOk: true,
          enabled: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        });
      }
      const out: Id<"users">[] = [];
      for (let i = 0; i < USERS; i++) {
        const uid = await ctx.db.insert("users", {});
        await ctx.db.insert("profiles", { userId: uid, role: "user" });
        for (let a = 0; a < AGENTS; a++) {
          await ctx.db.insert("userAgents", {
            userId: uid,
            instanceName: "prod",
            agentId: `shared-${a}`,
            isDefault: a === 0,
            source: "manual",
            createdAt: 1,
          });
        }
        out.push(uid);
      }
      return out;
    });
    const measured = await t.run(async (ctx) => {
      let markerReads = 0;
      const db = new Proxy(ctx.db, {
        get(target, prop) {
          if (prop === "query") {
            return (table: string) => {
              if (table === "agentPurges") markerReads += 1;
              return target.query(table as never);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const map = await effectiveAgentsForUsers({ ...ctx, db } as typeof ctx, users);
      return { markerReads, counts: [...new Set(users.map((u) => map.get(u)?.count ?? -1))] };
    });
    // O(distinct agents), not O(users × grants) = 4,500.
    expect(measured.markerReads).toBe(AGENTS);
    expect(measured.counts).toEqual([AGENTS]);
    const list = await as(t, s.admin).query(api.admin.listUsers, { withAgents: true });
    const shown = list.filter((u: { userId: Id<"users"> }) => users.includes(u.userId));
    expect(shown).toHaveLength(USERS);
    expect(new Set(shown.map((u: { agentCount: number | null }) => u.agentCount))).toEqual(new Set([AGENTS]));
  }, 120_000);
});
