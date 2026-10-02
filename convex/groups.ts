import {
  adminNarrowingOf,
  agentEnablementStrict,
  agentRef,
  grantKey,
  liveGroupShares,
  memberShareOfGroup,
  shrinkLiftsAdminNarrowing,
  usersLiftedByUnshare,
  usersNarrowedByShare,
} from "./agents";
// Groups (P2). Regroup users + share agents by group. See
// docs/GROUPS_CHARTS_P2_SPEC.md. NO secrets (non-secret instance/agent NAMES
// only). The user↔agent union driven by group membership is computed at READ
// time in convex/agents.ts (getEffectiveGrants / enrichUserAgents); this module
// owns the CRUD, the per-group delegation surface and the owner-scoped membership
// read (listMyGroups).
//
// Authorization split (mirrors the rest of the surface):
//   - structural ops (create / rename / delete a group, promote a manager, ADD a
//     person to a group) are ADMIN-only (requireAdmin on the REAL identity);
//   - the per-group CONTENT surface (remove a non-manager member, the group's
//     agents within its own scope, claiming a new agent, per-member restrictions,
//     the group default, invitation REQUESTS) is delegated to a group MANAGER via
//     authorizeGroupManage — scoped so a manager can never widen what their group
//     reaches: they only re-add agents RESERVED for their group, claim agents
//     nobody has decided on yet, and narrow members within the group's own share;
//   - every mutation here is audited UNCONDITIONALLY (recordAudit, real actor);
//   - listMyGroups is owner-scoped on the EFFECTIVE user (requireUserId), like the
//     other user-data reads.

import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  getActor,
  requireAdmin,
  requirePermission,
  requireUserId,
  roleOf,
  type Actor,
} from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { resolveAgentTypes } from "./lib/agentTypes";
import { recordAudit, type AuditDetails } from "./lib/audit";
import { authorizeGroupManage, isRealAdmin } from "./lib/groupAccess";
import { agentClaimEpoch, claimRefusal, claimRefusalOfRow } from "./lib/agentClaim";
import { assertNoPendingPurge, liveAccessRows } from "./lib/agentPurge";
import { chartDisplayName } from "./charts";
import {
  ADMIN_RESTRICTION_WOULD_APPLY,
  ADMIN_RESTRICTION_WOULD_LIFT,
  assertNoPendingMemberCleanup,
  newCleanupBudget,
  unshareAgentFromMembers,
} from "./lib/groupMembers";

// How many member/agent/chart names to PREVIEW inline in the groups list (the rest
// are summarized as "+N"). Bounds the listGroups payload + reads (a group can have
// many members) so the list stays cheap — never an unbounded fan-out.
const GROUP_PREVIEW_CAP = 6;

// ===========================================================================
// Helpers
// ===========================================================================

/** Derive a filesystem-safe slug from a group name (mirrors canonicalFromEmail's
 *  allowlist). Empty/symbol-only names fall back to "group". */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "group";
}

/** A `key` not yet used by any group. Probes `base`, then `base-2`, `base-3`, …
 *  via by_key so the slug is unique even on a name collision. Bounded. */
async function uniqueGroupKey(
  ctx: MutationCtx,
  base: string,
): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const clash = await ctx.db
      .query("groups")
      .withIndex("by_key", (q) => q.eq("key", candidate))
      .unique();
    if (clash === null) return candidate;
  }
}

/** A short, non-PHI display label for a user (email local-part / name / id tail),
 *  for the admin members list. Same idiom as admin.listAudit's labelOf. */
export async function userLabel(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return profile?.email ?? profile?.name ?? userId.slice(0, 8);
}

/** Resolution health of a (instance, agent) for the admin group-agents list —
 *  same classification as agents.enrichUserAgents (deleted > unknown > stale). */
async function agentState(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<{
  state: "ok" | "deleted" | "stale" | "unknown";
  displayName: string | null;
  agent: Doc<"agents"> | null;
}> {
  const agent = await agentDoc(ctx, instanceName, agentId);
  const discovery = await ctx.db
    .query("instanceDiscovery")
    .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
    .first();
  let state: "ok" | "deleted" | "stale" | "unknown" = "ok";
  if (agent && agent.presentInLastOk === false) state = "deleted";
  else if (!discovery) state = "unknown";
  else if (!discovery.lastPollOk) state = "stale";
  else if (!agent) state = "deleted";
  return { state, displayName: agent?.displayName ?? null, agent };
}

async function agentDoc(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<Doc<"agents"> | null> {
  return await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

/** Read a group or throw a clean error (admin paths). */
async function getGroupOrThrow(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
): Promise<Doc<"groups">> {
  const group = await ctx.db.get(groupId);
  if (group === null) throw new Error("Not found: group");
  return group;
}

async function membershipOf(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
  userId: Id<"users">,
): Promise<Doc<"groupMembers"> | null> {
  return await ctx.db
    .query("groupMembers")
    .withIndex("by_user_group", (q) =>
      q.eq("userId", userId).eq("groupId", groupId),
    )
    .unique();
}

async function groupAgentRow(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string,
): Promise<Doc<"groupAgents"> | null> {
  return await ctx.db
    .query("groupAgents")
    .withIndex("by_group_instance_agent", (q) =>
      q
        .eq("groupId", groupId)
        .eq("instanceName", instanceName)
        .eq("agentId", agentId),
    )
    .unique();
}

/** Mirror agents.assignAgent EXACTLY: only DISCOVERED + currently-present +
 *  enabled (under the current enforcement mode) agents are shareable, so a group
 *  can never share a manual/deleted/disabled agent. */
function agentShareable(agent: Doc<"agents"> | null, strict: boolean): boolean {
  return (
    agent !== null &&
    agent.source === "discovered" &&
    agent.presentInLastOk &&
    (strict ? agent.enabled === true : agent.enabled !== false)
  );
}

// Audit resource ids. The resource KIND names what was touched; the id carries
// the group so a manager's actions are attributable to the group they manage.
const memberRef = (groupId: Id<"groups">, userId: Id<"users">) =>
  `${groupId}:${userId}`;
const groupAgentRef = (
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string,
) => `${groupId}:${agentRef(instanceName, agentId)}`;

async function auditGroup(
  ctx: MutationCtx,
  actor: Actor,
  action: string,
  resource: "group" | "groupMember" | "groupAgent",
  resourceId: string,
  details?: AuditDetails,
): Promise<void> {
  for (const part of splitAuditDetails(details)) {
    await recordAudit(ctx, actor, action, {
      resource,
      resourceId,
      ...(part !== undefined ? { details: part } : {}),
    });
  }
}

/** Agent references one audit row carries at most. A group may share thousands of
 *  agents, and lifting a restriction names every one of them: an array past the
 *  document limit (8192 items) would fail the audit insert — and roll back the
 *  change it records (codex pass 6). */
export const AUDIT_REFS_PER_ROW = 500;

/** `details` as one row, or — when it names more agents than AUDIT_REFS_PER_ROW —
 *  as several bounded rows, each tagged `chunk {index, of}`; the defaults ride the
 *  first. Every reference is kept: nothing is sampled away. */
export function splitAuditDetails(details: AuditDetails | undefined): Array<AuditDetails | undefined> {
  const added = details?.agentsAdded ?? [];
  const removed = details?.agentsRemoved ?? [];
  if (details === undefined || added.length + removed.length <= AUDIT_REFS_PER_ROW) return [details];
  const refs: Array<{ added: boolean; ref: { instanceName: string; agentId: string } }> = [
    ...added.map((ref) => ({ added: true, ref })),
    ...removed.map((ref) => ({ added: false, ref })),
  ];
  const of = Math.ceil(refs.length / AUDIT_REFS_PER_ROW);
  const rows: AuditDetails[] = [];
  for (let i = 0; i < of; i++) {
    const slice = refs.slice(i * AUDIT_REFS_PER_ROW, (i + 1) * AUDIT_REFS_PER_ROW);
    const { agentsAdded: _a, agentsRemoved: _r, ...rest } = details;
    rows.push({
      ...(i === 0 ? rest : {}),
      agentsAdded: slice.filter((x) => x.added).map((x) => x.ref),
      agentsRemoved: slice.filter((x) => !x.added).map((x) => x.ref),
      chunk: { index: i + 1, of },
    });
  }
  return rows;
}

/** An agent reference as the audit stores it (refs only). */
function agentRefOf(a: { instanceName: string; agentId: string }) {
  return { instanceName: a.instanceName, agentId: a.agentId };
}

/** Drop a member's per-group allowances (removal from the group). */
async function purgeMemberAllowances(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  userId: Id<"users">,
): Promise<void> {
  const rows = await ctx.db
    .query("groupMemberAgents")
    .withIndex("by_group_user", (q) =>
      q.eq("groupId", groupId).eq("userId", userId),
    )
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/** Does `userId` belong to at least one EXISTING group other than `groupId`? A
 *  user in no group falls to the no-group regime — the instance-wide rules (their
 *  direct grants, else every non-reserved agent) instead of a group's limits — so
 *  taking someone out of their last group is a widening only an admin decides. */
async function inAnotherGroup(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  groupId: Id<"groups">,
): Promise<boolean> {
  const memberships = await ctx.db
    .query("groupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const m of memberships) {
    if (m.groupId === groupId) continue;
    if ((await ctx.db.get(m.groupId)) !== null) return true;
  }
  return false;
}

/** The typed refusal for a manager's share/unshare that would flip an admin's
 *  narrowing, naming the BLOCKING AGENT — the first changed agent the affected
 *  member holds a direct grant on — so the manager knows which one to leave out.
 *  Never names the member. Member removals throw the bare code (no agent). */
async function restrictionRefusal(
  ctx: QueryCtx | MutationCtx,
  code: typeof ADMIN_RESTRICTION_WOULD_LIFT | typeof ADMIN_RESTRICTION_WOULD_APPLY,
  userId: Id<"users">,
  changed: ReadonlyArray<{ instanceName: string; agentId: string }>,
): Promise<ConvexError<{ code: string; agent: string }>> {
  let blocking = changed[0] ?? null;
  for (const r of changed) {
    const held = await ctx.db
      .query("userAgents")
      .withIndex("by_user_instance_agent", (q) =>
        q.eq("userId", userId).eq("instanceName", r.instanceName).eq("agentId", r.agentId),
      )
      .first();
    if (held !== null) {
      blocking = r;
      break;
    }
  }
  const label =
    blocking === null
      ? "?"
      : ((await agentDoc(ctx, blocking.instanceName, blocking.agentId))?.displayName ??
        blocking.agentId);
  return new ConvexError({ code, agent: label });
}

const LAST_GROUP_REFUSAL =
  "Refused: only an admin can remove a person from their last group (without a group they would fall back to the instance-wide access rules instead of the group's limits)";

/** A non-admin manager may not change the per-member settings of THEMSELVES or of a
 *  co-manager (mirrors removeMember's co-manager rule). */
function assertMemberSettable(
  admin: boolean,
  actor: Actor,
  membership: Doc<"groupMembers">,
): void {
  if (admin) return;
  if (membership.userId === actor.realUserId) {
    throw new Error("Refused: a manager cannot change their own agents");
  }
  if (membership.manager === true) {
    throw new Error("Refused: only an admin can change a group manager's agents");
  }
}

/** The instances a group already uses (its FOOTPRINT): where its manager may
 *  claim new agents. Deliberately the GROUP's footprint, never the manager's own
 *  grants — those may come from other groups or admin direct grants that have
 *  nothing to do with this group (or, for a groupless manager, the whole catalogue). */
async function groupFootprint(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
): Promise<Set<string>> {
  const rows = await liveGroupShares(ctx, groupId);
  return new Set(rows.map((r) => r.instanceName));
}

// ===========================================================================
// MUTATIONS — structural (admin-only)
// ===========================================================================

export const createGroup = mutation({
  args: { name: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, { name, description }): Promise<Id<"groups">> => {
    await requireAdmin(ctx); // create a group = admin-only (structural)
    const actor = await getActor(ctx);
    const key = await uniqueGroupKey(ctx, slugify(name));
    const groupId = await ctx.db.insert("groups", {
      key,
      name,
      description,
      createdBy: actor.realUserId,
      createdAt: Date.now(),
    });
    await auditGroup(ctx, actor, "group.create", "group", groupId);
    return groupId;
  },
});

export const updateGroup = mutation({
  args: {
    groupId: v.id("groups"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { groupId, name, description }) => {
    // Rename / description = group metadata. Admin-only (not in the delegated
    // manager set). Managers manage content, not the group's identity.
    await requireAdmin(ctx);
    const actor = await getActor(ctx);
    await getGroupOrThrow(ctx, groupId);
    // Patch only the provided fields; the `key` is immutable (provenance token).
    // `description: undefined` (arg absent) = don't touch; `description: ""` =
    // CLEAR it — patch the optional field to undefined so it is removed (the
    // established clear-an-optional pattern, cf. promoteChartToCommon clearing
    // ownerUserId). The edit form sends the RAW string so an emptied field clears.
    const patch: { name?: string; description?: string | undefined } = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description || undefined;
    if (Object.keys(patch).length > 0) await ctx.db.patch(groupId, patch);
    await auditGroup(ctx, actor, "group.update", "group", groupId);
  },
});

export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await requireAdmin(ctx); // delete a group (cascade) = admin-only (structural)
    const actor = await getActor(ctx);
    const group = await ctx.db.get(groupId);
    if (group === null) return; // idempotent
    // CASCADE: purge memberships + shared agents (both bounded by_group reads),
    // THEN the group itself. Group sizes are admin-scale; collect is acceptable.
    const members = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const m of members) await ctx.db.delete(m._id);
    const memberAgents = await ctx.db
      .query("groupMemberAgents")
      .withIndex("by_group_user", (q) => q.eq("groupId", groupId))
      .collect();
    for (const r of memberAgents) await ctx.db.delete(r._id);
    const ga = await ctx.db
      .query("groupAgents")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const a of ga) await ctx.db.delete(a._id);
    const gc = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const c of gc) await ctx.db.delete(c._id);
    // Tier-1 admin chart POOL rows for this group (3-tier charts model).
    const gcp = await ctx.db
      .query("groupChartPool")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const p of gcp) await ctx.db.delete(p._id);
    const invites = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_group_status", (q) => q.eq("groupId", groupId))
      .collect();
    for (const r of invites) await ctx.db.delete(r._id);
    // Agents RESERVED for this group keep their reservation (fail-closed): with the
    // group gone they reach nobody until an admin lifts or moves it.
    await ctx.db.delete(groupId);
    await auditGroup(ctx, actor, "group.delete", "group", groupId);
  },
});

/** Add a person to a group. ADMIN-only: a manager never adds anyone directly — they
 *  REQUEST an invitation by email (groupInvites.requestGroupInvite) that an admin
 *  approves. */
export const addMember = mutation({
  args: { groupId: v.id("groups"), userId: v.id("users") },
  handler: async (ctx, { groupId, userId }) => {
    await requireAdmin(ctx);
    const actor = await getActor(ctx);
    await getGroupOrThrow(ctx, groupId);
    // Dedup via by_user_group (membership check + idempotency in one read).
    if ((await membershipOf(ctx, groupId, userId)) !== null) return; // idempotent
    await ctx.db.insert("groupMembers", {
      groupId,
      userId,
      joinedAt: Date.now(),
    });
    await auditGroup(ctx, actor, "group.addMember", "groupMember", memberRef(groupId, userId));
  },
});

export const removeMember = mutation({
  args: { groupId: v.id("groups"), userId: v.id("users") },
  handler: async (ctx, { groupId, userId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    const existing = await membershipOf(ctx, groupId, userId);
    if (existing === null) return; // idempotent
    // A MANAGER membership may only be removed by an ADMIN: deleting the row also
    // strips the `manager` flag, which would let a delegated manager demote a
    // co-manager and bypass the admin-only setGroupManager. (Also blocks a manager
    // self-demoting via removal — safe; an admin does it.)
    const admin = await isRealAdmin(ctx);
    if (existing.manager === true && !admin) {
      throw new Error("Refused: only an admin can remove a group manager");
    }
    if (!admin && !(await inAnotherGroup(ctx, userId, groupId))) {
      throw new Error(LAST_GROUP_REFUSAL);
    }
    if (
      !admin &&
      (await shrinkLiftsAdminNarrowing(ctx, userId, { leftGroupId: groupId }))
    ) {
      throw new ConvexError({ code: ADMIN_RESTRICTION_WOULD_LIFT });
    }
    await ctx.db.delete(existing._id);
    await purgeMemberAllowances(ctx, groupId, userId);
    await auditGroup(ctx, actor, "group.removeMember", "groupMember", memberRef(groupId, userId));
  },
});

// Promote/demote a MEMBER as a MANAGER of this group. ADMIN-ONLY (delegation is
// the admin's call). The target must already be a member; managing requires the
// grantable `groups.manage` permission too (this flag scopes WHICH groups).
export const setGroupManager = mutation({
  args: {
    groupId: v.id("groups"),
    userId: v.id("users"),
    manager: v.boolean(),
  },
  handler: async (ctx, { groupId, userId, manager }) => {
    await requireAdmin(ctx);
    const actor = await getActor(ctx);
    const membership = await membershipOf(ctx, groupId, userId);
    if (membership === null) {
      throw new Error("Refused: user is not a member of this group");
    }
    await ctx.db.patch(membership._id, { manager });
    await auditGroup(
      ctx,
      actor,
      manager ? "group.promoteManager" : "group.demoteManager",
      "groupMember",
      memberRef(groupId, userId),
    );
  },
});

// ===========================================================================
// MUTATIONS — the group's agents (admin, or this group's manager within scope)
// ===========================================================================

/** Share an agent with a group. An ADMIN may share any discovered, present,
 *  enabled agent. A MANAGER may only (re-)add an agent RESERVED for this group —
 *  one they claimed, or an admin reserved for them; everything else (another
 *  group's agent, the open catalogue) stays an admin decision. New agents come in
 *  through claimAgentForGroup. */
export const assignAgentToGroup = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { groupId, instanceName, agentId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    const agent = await agentDoc(ctx, instanceName, agentId);
    const strict = await agentEnablementStrict(ctx);
    if (!agentShareable(agent, strict)) {
      throw new Error(
        `Agent not assignable: ${instanceName}/${agentId} is not a discovered, present, enabled agent`,
      );
    }
    // Before the idempotent check: an old share the purge sweep is about to delete
    // is not "already shared" (lib/agentPurge, codex pass 7).
    await assertNoPendingPurge(ctx, instanceName, agentId);
    if ((await groupAgentRow(ctx, groupId, instanceName, agentId)) !== null) {
      return; // idempotent
    }
    const admin = await isRealAdmin(ctx);
    if (!admin && agent!.reservedForGroupId !== groupId) {
      throw new Error(
        "Refused: a group manager may only add an agent reserved for this group",
      );
    }
    if (!admin) {
      const refs = [{ groupId, instanceName, agentId }];
      const hit = await usersNarrowedByShare(ctx, refs);
      if (hit.length > 0) {
        throw await restrictionRefusal(ctx, ADMIN_RESTRICTION_WOULD_APPLY, hit[0]!, refs);
      }
    }
    await assertNoPendingMemberCleanup(ctx, groupId, instanceName, agentId);
    await ctx.db.insert("groupAgents", {
      groupId,
      instanceName,
      agentId,
      createdAt: Date.now(),
    });
    await auditGroup(
      ctx,
      actor,
      "group.assignAgent",
      "groupAgent",
      groupAgentRef(groupId, instanceName, agentId),
    );
  },
});

export const removeAgentFromGroup = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { groupId, instanceName, agentId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    const existing = await groupAgentRow(ctx, groupId, instanceName, agentId);
    if (existing === null) return; // idempotent
    if (!(await isRealAdmin(ctx))) {
      const refs = [{ groupId, instanceName, agentId }];
      const hit = await usersLiftedByUnshare(ctx, refs);
      if (hit.length > 0) {
        throw await restrictionRefusal(ctx, ADMIN_RESTRICTION_WOULD_LIFT, hit[0]!, refs);
      }
    }
    await ctx.db.delete(existing._id);
    await unshareAgentFromMembers(ctx, groupId, instanceName, agentId);
    await auditGroup(
      ctx,
      actor,
      "group.removeAgent",
      "groupAgent",
      groupAgentRef(groupId, instanceName, agentId),
    );
  },
});

// Upper bound on a single bulk call. listUsers/listInstances are bounded at 500,
// so a real "select all" never approaches this — it is purely an abuse guard.
const BULK_CAP = 1000;

// "Select all" / "deselect all" for members: add or remove a whole set in ONE
// round-trip (the per-user mutations would be N requests). Adding is ADMIN-only
// (a manager requests invitations instead); removing is delegated with the same
// co-manager guard as removeMember. One audit row per actual change.
export const bulkSetMembers = mutation({
  args: {
    groupId: v.id("groups"),
    userIds: v.array(v.id("users")),
    member: v.boolean(),
  },
  handler: async (ctx, { groupId, userIds, member }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    if (userIds.length > BULK_CAP) {
      throw new Error(
        `Refused: bulk membership change exceeds ${BULK_CAP} users`,
      );
    }
    const admin = await isRealAdmin(ctx);
    if (member && !admin) {
      throw new Error(
        "Refused: only an admin adds members (request an invitation instead)",
      );
    }
    // Same invariant as removeMember: a non-admin manager may not remove a
    // co-manager (it would strip the manager flag). The whole batch aborts on a
    // violation (Convex mutations are atomic → no partial removal persists).
    for (const userId of userIds) {
      const existing = await membershipOf(ctx, groupId, userId);
      if (member && existing === null) {
        await ctx.db.insert("groupMembers", {
          groupId,
          userId,
          joinedAt: Date.now(),
        });
        await auditGroup(ctx, actor, "group.addMember", "groupMember", memberRef(groupId, userId));
      } else if (!member && existing !== null) {
        if (existing.manager === true && !admin) {
          throw new Error("Refused: only an admin can remove a group manager");
        }
        if (!admin && !(await inAnotherGroup(ctx, userId, groupId))) {
          throw new Error(LAST_GROUP_REFUSAL);
        }
        // Judged per user (leaving THIS group only moves their own share); a
        // refusal aborts the whole batch atomically.
        if (
          !admin &&
          (await shrinkLiftsAdminNarrowing(ctx, userId, { leftGroupId: groupId }))
        ) {
          throw new ConvexError({ code: ADMIN_RESTRICTION_WOULD_LIFT });
        }
        await ctx.db.delete(existing._id);
        await purgeMemberAllowances(ctx, groupId, userId);
        await auditGroup(ctx, actor, "group.removeMember", "groupMember", memberRef(groupId, userId));
      }
    }
  },
});

// "Select all" / "deselect all" for the agents of ONE instance. On assign, each
// agent is re-validated exactly like assignAgentToGroup (discovered + present +
// enabled, and — for a manager — reserved for this group); anything not
// assignable is silently skipped so a partial set still applies.
export const bulkSetGroupAgents = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentIds: v.array(v.string()),
    assigned: v.boolean(),
  },
  handler: async (ctx, { groupId, instanceName, agentIds, assigned }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    if (agentIds.length > BULK_CAP) {
      throw new Error(
        `Refused: bulk agent change exceeds ${BULK_CAP} agents`,
      );
    }
    const strict = await agentEnablementStrict(ctx);
    const admin = await isRealAdmin(ctx);
    if (!assigned && !admin) {
      // The WHOLE batch is judged at once (removing A and B together may lift a
      // narrowing that neither alone would) and refused atomically.
      const unshared = [];
      for (const agentId of agentIds) {
        if ((await groupAgentRow(ctx, groupId, instanceName, agentId)) !== null) {
          unshared.push({ groupId, instanceName, agentId });
        }
      }
      const hit = await usersLiftedByUnshare(ctx, unshared);
      if (hit.length > 0) {
        throw await restrictionRefusal(ctx, ADMIN_RESTRICTION_WOULD_LIFT, hit[0]!, unshared);
      }
    }
    if (assigned && !admin) {
      // The mirror, judged on exactly what this batch would insert, refused
      // atomically: a manager's share never switches a member into an admin's
      // narrowing.
      const shared = [];
      for (const agentId of agentIds) {
        if ((await groupAgentRow(ctx, groupId, instanceName, agentId)) !== null) continue;
        const agent = await agentDoc(ctx, instanceName, agentId);
        if (!agentShareable(agent, strict)) continue;
        if (agent!.reservedForGroupId !== groupId) continue;
        shared.push({ groupId, instanceName, agentId });
      }
      const hit = await usersNarrowedByShare(ctx, shared);
      if (hit.length > 0) {
        throw await restrictionRefusal(ctx, ADMIN_RESTRICTION_WOULD_APPLY, hit[0]!, shared);
      }
    }
    // ONE cleanup budget for the whole bulk change (see newCleanupBudget).
    const cleanupBudget = newCleanupBudget();
    for (const agentId of agentIds) {
      // An agent still being purged is refused, not skipped: its old share is not
      // "already shared", and a silent skip would read as success.
      if (assigned) await assertNoPendingPurge(ctx, instanceName, agentId);
      const existing = await groupAgentRow(ctx, groupId, instanceName, agentId);
      if (assigned) {
        if (existing !== null) continue; // idempotent
        const agent = await agentDoc(ctx, instanceName, agentId);
        if (!agentShareable(agent, strict)) continue; // not assignable — skip
        if (!admin && agent!.reservedForGroupId !== groupId) continue; // out of scope
        await assertNoPendingMemberCleanup(ctx, groupId, instanceName, agentId, cleanupBudget);
        await ctx.db.insert("groupAgents", {
          groupId,
          instanceName,
          agentId,
          createdAt: Date.now(),
        });
        await auditGroup(
          ctx,
          actor,
          "group.assignAgent",
          "groupAgent",
          groupAgentRef(groupId, instanceName, agentId),
        );
      } else {
        if (existing === null) continue; // idempotent
        await ctx.db.delete(existing._id);
        await unshareAgentFromMembers(ctx, groupId, instanceName, agentId);
        await auditGroup(
          ctx,
          actor,
          "group.removeAgent",
          "groupAgent",
          groupAgentRef(groupId, instanceName, agentId),
        );
      }
    }
  },
});

/** CLAIM a newly discovered agent for a group, in ONE transaction: share it with
 *  the group, RESERVE it for that group (never in the no-group all-pool, never the
 *  instance default — lib/agentClaim), and enable it. Only an agent nobody has made
 *  a decision about is claimable (lib/agentClaim.claimRefusal), and — for a manager
 *  — only on an instance the group already uses (groupFootprint). The instance
 *  default is left strictly untouched. */
export const claimAgentForGroup = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { groupId, instanceName, agentId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    await assertNoPendingPurge(ctx, instanceName, agentId);
    const agent = await agentDoc(ctx, instanceName, agentId);
    const refusal = await claimRefusal(ctx, agent, await agentClaimEpoch(ctx));
    if (refusal !== null) {
      throw new Error(`Refused: agent not claimable (${refusal})`);
    }
    if (
      !(await isRealAdmin(ctx)) &&
      !(await groupFootprint(ctx, groupId)).has(instanceName)
    ) {
      throw new Error(
        "Refused: this group has no agent on that instance",
      );
    }
    const now = Date.now();
    await ctx.db.patch(agent!._id, {
      enabled: true,
      enablementDecidedAt: now,
      reservedForGroupId: groupId,
      reservedAt: now,
    });
    await assertNoPendingMemberCleanup(ctx, groupId, instanceName, agentId);
    await ctx.db.insert("groupAgents", {
      groupId,
      instanceName,
      agentId,
      createdAt: now,
    });
    await auditGroup(
      ctx,
      actor,
      "group.claimAgent",
      "groupAgent",
      groupAgentRef(groupId, instanceName, agentId),
    );
  },
});

/** The group's DEFAULT agent (or none). The agent must be shared with the group.
 *  Exactly one row carries isDefault afterwards (or none on clear). */
export const setGroupDefaultAgent = mutation({
  args: {
    groupId: v.id("groups"),
    agent: v.union(
      v.null(),
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { groupId, agent }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    if (agent !== null) await assertNoPendingPurge(ctx, agent.instanceName, agent.agentId);
    if (
      agent !== null &&
      (await groupAgentRow(ctx, groupId, agent.instanceName, agent.agentId)) === null
    ) {
      throw new Error("Refused: the default agent must be shared with this group");
    }
    const rows = await ctx.db
      .query("groupAgents")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const r of rows) {
      const shouldBe =
        agent !== null &&
        r.instanceName === agent.instanceName &&
        r.agentId === agent.agentId;
      if ((r.isDefault === true) !== shouldBe) {
        await ctx.db.patch(r._id, { isDefault: shouldBe ? true : undefined });
      }
    }
    await auditGroup(
      ctx,
      actor,
      agent === null ? "group.clearDefaultAgent" : "group.setDefaultAgent",
      agent === null ? "group" : "groupAgent",
      agent === null ? groupId : groupAgentRef(groupId, agent.instanceName, agent.agentId),
    );
  },
});

// ===========================================================================
// MUTATIONS — per-member settings WITHIN one group
// ===========================================================================

const agentRefValidator = v.object({
  instanceName: v.string(),
  agentId: v.string(),
});

/** Restrict ONE member to a subset of THIS group's agents (`agents`), or lift the
 *  restriction (`agents: null` → the member receives the whole group again). Every
 *  listed agent must be shared with the group — a manager can never grant anything
 *  outside it — and nothing outside this group is touched: the member's other
 *  groups and any admin-made direct grant stay exactly as they were. */
export const setMemberAgents = mutation({
  args: {
    groupId: v.id("groups"),
    userId: v.id("users"),
    agents: v.union(v.null(), v.array(agentRefValidator)),
  },
  handler: async (ctx, { groupId, userId, agents }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    const membership = await membershipOf(ctx, groupId, userId);
    if (membership === null) {
      throw new Error("Refused: user is not a member of this group");
    }
    const admin = await isRealAdmin(ctx);
    assertMemberSettable(admin, actor, membership);
    if (agents !== null && agents.length > BULK_CAP) {
      throw new Error(`Refused: restriction exceeds ${BULK_CAP} agents`);
    }
    const wanted = new Map<string, { instanceName: string; agentId: string }>();
    for (const a of agents ?? []) {
      // A fresh allowance must not ride an old share the purge sweep will delete.
      await assertNoPendingPurge(ctx, a.instanceName, a.agentId);
      if ((await groupAgentRow(ctx, groupId, a.instanceName, a.agentId)) === null) {
        throw new Error(
          `Refused: ${a.instanceName}/${a.agentId} is not shared with this group`,
        );
      }
      wanted.set(grantKey(a.instanceName, a.agentId), a);
    }
    // An ADMIN-set restriction: a manager may only narrow it further — never lift
    // it, never add an agent the admin left out.
    const adminSet =
      membership.agentsRestricted === true &&
      membership.agentsRestrictedByAdmin === true;
    if (!admin && adminSet) {
      if (agents === null) {
        throw new Error(
          "Refused: only an admin can lift a restriction an admin set",
        );
      }
      const current = new Set(
        (await memberShareOfGroup(ctx, membership)).map((ga) =>
          grantKey(ga.instanceName, ga.agentId),
        ),
      );
      for (const key of wanted.keys()) {
        if (!current.has(key)) {
          throw new Error(
            "Refused: only an admin can widen a restriction an admin set",
          );
        }
      }
    }
    // The member's share BEFORE the change, for the audit's added/removed refs.
    const shareBefore = await memberShareOfGroup(ctx, membership);
    await purgeMemberAllowances(ctx, groupId, userId);
    if (agents === null) {
      await ctx.db.patch(membership._id, {
        agentsRestricted: undefined,
        agentsRestrictedByAdmin: undefined,
      });
    } else {
      const now = Date.now();
      for (const a of wanted.values()) {
        await ctx.db.insert("groupMemberAgents", {
          groupId,
          userId,
          instanceName: a.instanceName,
          agentId: a.agentId,
          createdAt: now,
        });
      }
      const d = membership.defaultAgent;
      const keepDefault =
        d !== undefined && wanted.has(grantKey(d.instanceName, d.agentId));
      await ctx.db.patch(membership._id, {
        agentsRestricted: true,
        // Stays admin-set once an admin set it (a manager's narrowing keeps it so).
        agentsRestrictedByAdmin: admin || adminSet ? true : undefined,
        ...(keepDefault ? {} : { defaultAgent: undefined }),
      });
    }
    const after = await ctx.db.get(membership._id);
    const shareAfter = after === null ? [] : await memberShareOfGroup(ctx, after);
    const keysBefore = new Set(shareBefore.map((ga) => grantKey(ga.instanceName, ga.agentId)));
    const keysAfter = new Set(shareAfter.map((ga) => grantKey(ga.instanceName, ga.agentId)));
    const defaultBefore = membership.defaultAgent ?? null;
    const defaultAfter = after?.defaultAgent ?? null;
    await auditGroup(
      ctx,
      actor,
      agents === null ? "group.unrestrictMember" : "group.restrictMember",
      "groupMember",
      memberRef(groupId, userId),
      {
        agentsAdded: shareAfter
          .filter((ga) => !keysBefore.has(grantKey(ga.instanceName, ga.agentId)))
          .map(agentRefOf),
        agentsRemoved: shareBefore
          .filter((ga) => !keysAfter.has(grantKey(ga.instanceName, ga.agentId)))
          .map(agentRefOf),
        // A restriction can drop the member's default: said when it does.
        ...(defaultBefore !== null && defaultAfter === null
          ? { previousDefaultAgent: agentRefOf(defaultBefore), defaultAgent: null }
          : {}),
      },
    );
  },
});

/** Set (or clear) ONE member's default agent among their share of THIS group. */
export const setMemberDefaultAgent = mutation({
  args: {
    groupId: v.id("groups"),
    userId: v.id("users"),
    agent: v.union(v.null(), agentRefValidator),
  },
  handler: async (ctx, { groupId, userId, agent }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    const membership = await membershipOf(ctx, groupId, userId);
    if (membership === null) {
      throw new Error("Refused: user is not a member of this group");
    }
    assertMemberSettable(await isRealAdmin(ctx), actor, membership);
    if (agent !== null) {
      await assertNoPendingPurge(ctx, agent.instanceName, agent.agentId);
      const share = await memberShareOfGroup(ctx, membership);
      if (
        !share.some(
          (ga) =>
            ga.instanceName === agent.instanceName && ga.agentId === agent.agentId,
        )
      ) {
        throw new Error(
          "Refused: the default agent must be one this member receives from the group",
        );
      }
    }
    const previous = membership.defaultAgent ?? null;
    await ctx.db.patch(membership._id, { defaultAgent: agent ?? undefined });
    await auditGroup(
      ctx,
      actor,
      agent === null ? "group.clearMemberDefault" : "group.setMemberDefault",
      "groupMember",
      memberRef(groupId, userId),
      {
        defaultAgent: agent === null ? null : agentRefOf(agent),
        previousDefaultAgent: previous === null ? null : agentRefOf(previous),
      },
    );
  },
});

// ===========================================================================
// QUERIES
// ===========================================================================

/** Admin: all groups with member/agent counts (the Groups tab list). Counts are
 *  bounded by_group reads (admin-scale group sizes). */
export const listGroups = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    // Admins see EVERY group; a delegated (non-admin) manager sees ONLY the groups
    // they manage (groupMembers.manager) — never others.
    let groups: Doc<"groups">[];
    if (await isRealAdmin(ctx)) {
      groups = await ctx.db.query("groups").order("desc").take(500);
    } else {
      const memberships = await ctx.db
        .query("groupMembers")
        .withIndex("by_user", (q) => q.eq("userId", actor.realUserId))
        .collect();
      const managed = memberships.filter((m) => m.manager === true);
      const rows: Doc<"groups">[] = [];
      for (const m of managed) {
        const g = await ctx.db.get(m.groupId);
        if (g !== null) rows.push(g);
      }
      groups = rows.sort((a, b) => b.createdAt - a.createdAt);
    }
    const out = [];
    for (const g of groups) {
      const memberRows = await ctx.db
        .query("groupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();
      const agentRows = await liveGroupShares(ctx, g._id);
      // Charts SELECTED by the group (Tier 2 — groupCharts); the pool (Tier 1) is
      // admin-internal and not surfaced in the list.
      const chartRows = await ctx.db
        .query("groupCharts")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();

      // Inline DETAIL previews (names), bounded by GROUP_PREVIEW_CAP. Managers /
      // default chart are sorted FIRST so they always appear in the preview; the
      // count reveals how many more are hidden ("+N").
      const memberPreview = [...memberRows]
        .sort((a, b) => Number(b.manager === true) - Number(a.manager === true))
        .slice(0, GROUP_PREVIEW_CAP);
      const members = [];
      for (const m of memberPreview) {
        members.push({
          label: await userLabel(ctx, m.userId),
          manager: m.manager === true,
        });
      }
      const agents = [];
      for (const a of agentRows.slice(0, GROUP_PREVIEW_CAP)) {
        const { displayName } = await agentState(ctx, a.instanceName, a.agentId);
        agents.push(displayName ?? a.agentId);
      }
      const chartPreview = [...chartRows]
        .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
        .slice(0, GROUP_PREVIEW_CAP);
      const charts = [];
      for (const c of chartPreview) {
        charts.push({
          name: await chartDisplayName(ctx, c.chartKey),
          isDefault: c.isDefault === true,
        });
      }
      const pendingInvites = await ctx.db
        .query("groupInviteRequests")
        .withIndex("by_group_status", (q) =>
          q.eq("groupId", g._id).eq("status", "pending"),
        )
        .take(100);

      out.push({
        _id: g._id,
        key: g.key,
        name: g.name,
        description: g.description ?? null,
        memberCount: memberRows.length,
        agentCount: agentRows.length,
        chartCount: chartRows.length,
        pendingInviteCount: pendingInvites.length,
        // Bounded name previews for the list "detail" columns (rest = "+N").
        members,
        agents,
        charts,
        createdAt: g.createdAt,
      });
    }
    return out;
  },
});

/** One group's members + shared agents (the Groups tab detail), for an admin or
 *  this group's manager. */
export const getGroup = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or this group's manager
    const group = await ctx.db.get(groupId);
    if (group === null) throw new Error("Not found: group");
    const admin = await isRealAdmin(ctx);
    const memberRows = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const members = [];
    for (const m of memberRows) {
      members.push({
        userId: m.userId,
        label: await userLabel(ctx, m.userId),
        manager: m.manager === true, // promote/demote is admin-only (UI gates it)
        // Per-member settings within THIS group (the restriction sheet).
        restricted: m.agentsRestricted === true,
        defaultAgent: m.defaultAgent ?? null,
        // Only an admin takes someone out of their LAST group (removeMember).
        lastGroup: !(await inAnotherGroup(ctx, m.userId, groupId)),
        // A manager never edits their own or a co-manager's agents.
        settable:
          admin || (m.userId !== actor.realUserId && m.manager !== true),
      });
    }
    // A share a pending purge revoked is not shown (lib/agentPurge).
    const agentRows = await liveGroupShares(ctx, groupId);
    const agents = [];
    for (const a of agentRows) {
      const { state, displayName, agent } = await agentState(
        ctx,
        a.instanceName,
        a.agentId,
      );
      agents.push({
        instanceName: a.instanceName,
        agentId: a.agentId,
        displayName,
        isDefault: a.isDefault ?? false,
        state,
        // Reserved for THIS group (claimed here, or reserved by an admin for it).
        reservedHere: agent?.reservedForGroupId === groupId,
      });
    }
    // Count of charts the group has SELECTED (Tier 2) — feeds the Charts tab badge.
    const chartRows = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    return {
      group: {
        _id: group._id,
        key: group.key,
        name: group.name,
        description: group.description ?? null,
      },
      members,
      agents,
      chartCount: chartRows.length,
      // Promote/demote a manager, adding people and sharing any agent are
      // ADMIN-ONLY: the dialog shows those controls only when this is true.
      viewerIsAdmin: await isRealAdmin(ctx),
    };
  },
});

/** One member's settings within one group: the group's agents, which of them the
 *  member receives, and their default among them (the per-member sheet). */
export const getMemberAgentSettings = query({
  args: { groupId: v.id("groups"), userId: v.id("users") },
  handler: async (ctx, { groupId, userId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or this group's manager
    const membership = await membershipOf(ctx, groupId, userId);
    if (membership === null) return null;
    const admin = await isRealAdmin(ctx);
    // An admin's direct grants may narrow this person below what the group gives
    // (directGrantsNarrow) — shown read-only so the manager sees the real outcome.
    const narrowing = await adminNarrowingOf(ctx, userId);
    const groupRows = await liveGroupShares(ctx, groupId);
    const share = await memberShareOfGroup(ctx, membership);
    const inShare = new Set(share.map((ga) => grantKey(ga.instanceName, ga.agentId)));
    const d = membership.defaultAgent;
    const agents = [];
    for (const a of groupRows) {
      const { displayName, state } = await agentState(ctx, a.instanceName, a.agentId);
      agents.push({
        instanceName: a.instanceName,
        agentId: a.agentId,
        displayName,
        state,
        allowed: inShare.has(grantKey(a.instanceName, a.agentId)),
        // Withheld by an administrator's own narrowing, whatever the group allows.
        limitedByAdmin:
          narrowing.narrowed &&
          !narrowing.directKeys.has(grantKey(a.instanceName, a.agentId)),
        isMemberDefault:
          d !== undefined &&
          d.instanceName === a.instanceName &&
          d.agentId === a.agentId,
        isGroupDefault: a.isDefault === true,
      });
    }
    return {
      label: await userLabel(ctx, userId),
      restricted: membership.agentsRestricted === true,
      // Set by an admin: a manager may only narrow it further.
      restrictedByAdmin:
        membership.agentsRestricted === true &&
        membership.agentsRestrictedByAdmin === true,
      adminNarrowed: narrowing.narrowed,
      // False for a manager viewing themselves or a co-manager (read-only).
      settable:
        admin ||
        (membership.userId !== actor.realUserId && membership.manager !== true),
      viewerIsAdmin: admin,
      agents,
    };
  },
});

/** Admin: every group as {id, name} only (bounded) — for pickers that need a group
 *  label and nothing of listGroups' per-group member/agent/chart reads. */
export const listGroupLabels = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const groups = await ctx.db.query("groups").order("desc").take(500);
    return groups.map((g) => ({ _id: g._id, name: g.name }));
  },
});

/** The EFFECTIVE user's group memberships (impersonation-aware). Feeds the agents
 *  union + the P5 introspection screen. Owner-scoped — NOT admin-gated. */
export const listMyGroups = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const memberships = await ctx.db
      .query("groupMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const m of memberships) {
      const group = await ctx.db.get(m.groupId);
      if (group === null) continue; // tolerate a transient dangling membership
      out.push({ groupId: group._id, key: group.key, name: group.name });
    }
    return out;
  },
});

// ===========================================================================
// DIRECTORY QUERIES for the Manage dialog
// The admin equivalents (api.admin.listUsers / listInstances /
// agents.listAgentsForInstance) over-disclose (roles + extraPermissions, full
// instance rows incl. URLs, agent curation state). These return ONLY the LABELS the
// dialog renders. The USER directory is admin-only: a manager never browses people
// (they request an invitation by exact email). Instances and agents are scoped for
// a manager to what THEIR group reaches or may claim — never other groups' agents,
// never the full catalogue.

/** Users an ADMIN may add as members: id + label fields only (NO extraPermissions). */
export const listAssignableUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const profiles = await ctx.db.query("profiles").order("desc").take(500);
    return profiles.map((p) => ({
      _id: p._id,
      userId: p.userId,
      role: roleOf(p),
      email: p.email ?? null,
      name: p.name ?? null,
      canonical: p.canonical ?? null,
    }));
  },
});

/** Instances the dialog lists agents from: id + names only (NO URLs/config/secrets).
 *  Admin: every instance. Manager (groupId required): the instances their group
 *  uses, plus those holding an agent reserved for it. */
export const listAssignableInstances = query({
  args: { groupId: v.optional(v.id("groups")) },
  handler: async (ctx, { groupId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const instances = await ctx.db.query("instances").order("desc").take(200);
    let visible = instances;
    if (!(await isRealAdmin(ctx))) {
      if (groupId === undefined) throw new Error("Refused: groupId required");
      await authorizeGroupManage(ctx, groupId);
      const names = await groupFootprint(ctx, groupId);
      const reserved = await ctx.db
        .query("agents")
        .withIndex("by_reserved_group", (q) => q.eq("reservedForGroupId", groupId))
        .take(500);
      for (const a of reserved) names.add(a.instanceName);
      visible = instances.filter((i) => names.has(i.name));
    }
    return visible.map((i) => ({
      _id: i._id,
      name: i.name,
      displayName: i.displayName ?? null,
      kind: i.kind ?? "openclaw",
    }));
  },
});

type AssignableAgent = {
  agentId: string;
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  isDefaultOnInstance: boolean;
  types: string[];
  source: "discovered" | "manual";
  presentInLastOk: boolean;
  enabled: boolean;
  // A new agent nobody decided on yet, which this group's manager may CLAIM.
  claimable: boolean;
  // Reserved for the group in the request (re-addable by its manager).
  reservedForGroup: boolean;
  // Reserved for SOME group (admin view: which one), or null.
  reservedGroupName: string | null;
  reserved: boolean;
};

function assignableView(
  a: Doc<"agents">,
  flags: { claimable: boolean; groupId: Id<"groups"> | undefined; reservedGroupName: string | null },
): AssignableAgent {
  return {
    agentId: a.agentId,
    displayName: a.displayName ?? null,
    emoji: a.emoji ?? null,
    model: a.model ?? null,
    isDefaultOnInstance: a.isDefaultOnInstance ?? false,
    types: resolveAgentTypes(a.types),
    source: a.source,
    presentInLastOk: a.presentInLastOk,
    // Opt-IN: an agent must be explicitly enabled to be assignable. An
    // un-curated (unset) or disabled agent reads as not-enabled → greyed.
    enabled: a.enabled === true,
    claimable: flags.claimable,
    reservedForGroup:
      flags.groupId !== undefined && a.reservedForGroupId === flags.groupId,
    reservedGroupName: flags.reservedGroupName,
    reserved: a.reservedForGroupId !== undefined,
  };
}

/** Discovered agents of ONE instance for the dialog: render labels only (NO
 *  admin-curation detail beyond enabled / reserved).
 *  Admin: every agent of the instance (claimable flags when `groupId` is given).
 *  Manager (groupId required): EXACTLY the agents shared with the group, the ones
 *  reserved for it, and — on an instance the group already uses — the agents it
 *  may claim. Never another group's agents, never the open catalogue. */
export const listAssignableAgents = query({
  args: { instanceName: v.string(), groupId: v.optional(v.id("groups")) },
  handler: async (ctx, { instanceName, groupId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const admin = await isRealAdmin(ctx);
    if (!admin) {
      if (groupId === undefined) throw new Error("Refused: groupId required");
      await authorizeGroupManage(ctx, groupId);
    }
    const all = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    const epoch = await agentClaimEpoch(ctx);
    const footprint =
      groupId !== undefined ? await groupFootprint(ctx, groupId) : new Set<string>();
    const shared =
      groupId !== undefined
        ? new Set(
            (
              await liveAccessRows(
                ctx,
                "shares",
                await ctx.db
                  .query("groupAgents")
                  .withIndex("by_group_instance_agent", (q) =>
                    q.eq("groupId", groupId).eq("instanceName", instanceName),
                  )
                  .collect(),
              )
            ).map((r) => r.agentId),
          )
        : new Set<string>();
    // A manager learns nothing about an instance outside their group's reach (its
    // footprint, or an agent reserved for the group there) — not even its poll state.
    if (
      !admin &&
      !footprint.has(instanceName) &&
      !all.some((a) => a.reservedForGroupId === groupId)
    ) {
      return { agents: [], discovery: null };
    }
    const groupNames = new Map<Id<"groups">, string | null>();
    const out: AssignableAgent[] = [];
    for (const a of all) {
      // Claimable only where the group already has a footprint (managers and the
      // admin's view of the same group alike — one rule, one list).
      const claimable =
        groupId !== undefined &&
        footprint.has(instanceName) &&
        claimRefusalOfRow(a, epoch) === null &&
        (await claimRefusal(ctx, a, epoch)) === null;
      if (!admin) {
        const inScope =
          shared.has(a.agentId) || a.reservedForGroupId === groupId || claimable;
        if (!inScope) continue;
      }
      let reservedGroupName: string | null = null;
      if (admin && a.reservedForGroupId !== undefined) {
        const gid = a.reservedForGroupId;
        if (!groupNames.has(gid)) groupNames.set(gid, (await ctx.db.get(gid))?.name ?? null);
        reservedGroupName = groupNames.get(gid) ?? null;
      }
      out.push(assignableView(a, { claimable, groupId, reservedGroupName }));
    }
    const discovery = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    return {
      agents: out,
      discovery: discovery
        ? {
            lastPollAt: discovery.lastPollAt,
            lastPollOk: discovery.lastPollOk,
            lastOkAt: discovery.lastOkAt ?? null,
            error: discovery.error ?? null,
          }
        : null,
    };
  },
});
