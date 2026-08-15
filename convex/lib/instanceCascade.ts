import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Deleting an instance touches two very different kinds of row, and they cannot
 * share a policy.
 *
 * ID-BOUND CREDENTIALS — the encrypted gateway secrets and the per-bridge auth
 * secret — are keyed by the instance's own row id and are FEW by construction
 * (one per credential field, one active bridge secret). They are deleted in the
 * SAME transaction as the instance row, always, with no batching and no
 * scheduling: an instance reported deleted while a hash that still resolves to
 * it, or an envelope that still decrypts, survives in the database is a security
 * failure, not a throughput problem. Deferring them would put a window around
 * exactly the thing deletion exists to remove.
 *
 * NAME-BOUND ROWS — discovery, usage, agents, and the user/group grants — are
 * UNBOUNDED: a busy instance can carry thousands. Collecting them all, and then
 * re-reading every affected user's remaining grants, is what pushed the single
 * transaction past Convex's read/write limits, so removing a LARGE instance
 * failed durably while a small one succeeded. They are swept in bounded batches
 * that reschedule themselves.
 *
 * The instance row is deleted FIRST either way, so routing stops immediately and
 * the sweep only ever cleans up behind something already unreachable.
 */

/** Rows per sweep pass. Small on purpose: a pass must fit a transaction with room
 *  to spare, and the sweep re-arms itself rather than trying to finish early. */
const CASCADE_BATCH = 100;
/** Distinct users whose default grant is re-elected in one pass. Lower than the
 *  batch above because each one costs a further read of that user's own grants. */
const REELECT_BATCH = 25;
/**
 * Rows per pass for the tables that hold FILE BODIES.
 *
 * Far smaller, because these are not counted in rows but in megabytes: one
 * curation can legitimately carry a couple of hundred thousand characters of
 * source plus its proposal, and a revision holds the file before AND after. A
 * hundred of them exceed Convex's 16 MiB transaction ceiling before a single
 * delete lands — and the failure mode is not a slow sweep, it is a PERMANENT one:
 * every pass throws, the reaper re-arms it for ever, the name stays locked for
 * reuse and the deletion never finishes.
 */
const CONTENT_BATCH = 5;

/**
 * Delete the instance and everything keyed by its ID, then say whether a
 * name-bound sweep is still owed. Bounded, synchronous, and safe to call twice.
 */
export async function deleteInstanceCascade(
  ctx: MutationCtx,
  instanceId: Id<"instances">,
): Promise<{ outcome: "deleted" | "absent"; sweepName: string | null }> {
  const instance = await ctx.db.get(instanceId);
  if (instance === null) return { outcome: "absent", sweepName: null };
  const name = instance.name;
  await ctx.db.delete(instanceId);

  // ID-bound credentials always belong to this exact row, even when a legacy
  // duplicate name remains in the database. Never batched — see the header.
  const secretRows = await ctx.db
    .query("instanceSecrets")
    .withIndex("by_instance", (query) => query.eq("instanceId", instanceId))
    .collect();
  for (const secret of secretRows) await ctx.db.delete(secret._id);

  const bridgeAuthRows = await ctx.db
    .query("bridgeAuth")
    .withIndex("by_instance", (query) => query.eq("instanceId", instanceId))
    .collect();
  for (const bridgeAuth of bridgeAuthRows) await ctx.db.delete(bridgeAuth._id);

  // Name-bound rows must remain while another legacy duplicate still serves the
  // routing key. Automated deletion refuses duplicates before reaching here;
  // this guard preserves the admin recovery behavior.
  const stillServed = await ctx.db
    .query("instances")
    .withIndex("by_name", (query) => query.eq("name", name))
    .first();
  if (stillServed !== null) return { outcome: "deleted", sweepName: null };

  return { outcome: "deleted", sweepName: name };
}

/**
 * Record that a name still owes a sweep, so a dropped scheduler run cannot orphan
 * grants forever. Idempotent: a second deletion of the same name reuses the row.
 */
export async function openCascadeJob(
  ctx: MutationCtx,
  instanceName: string,
): Promise<void> {
  const existing = await ctx.db
    .query("instanceCascades")
    .withIndex("by_name", (query) => query.eq("instanceName", instanceName))
    .unique();
  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("instanceCascades", {
      instanceName,
      startedAt: now,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(existing._id, { updatedAt: now });
}

/**
 * Refuse to CREATE an instance under a name whose sweep is still owed.
 *
 * Shared by EVERY creation path — the provisioner endpoint and the admin form —
 * because the danger is not who is asking. The sweep matches rows by name with
 * nothing to distinguish the deleted instance's from a new one's, so recreating
 * the name mid-sweep either has the chain delete the new instance's data, or has
 * the new instance inherit the old one's agents and grants. The second is the
 * worse of the two: people authorised on the gateway that was removed silently
 * gain access to its replacement, which is exactly the isolation this feature
 * exists to provide. Guarding one caller and not the other left that open.
 */
export async function assertNameNotSweeping(
  ctx: MutationCtx,
  name: string,
): Promise<void> {
  const sweeping = await ctx.db
    .query("instanceCascades")
    .withIndex("by_name", (query) => query.eq("instanceName", name))
    .unique();
  if (sweeping !== null) throw new Error("instance_name_sweeping");
}

/**
 * May a NAME-BOUND row be written for this instance name right now?
 *
 * A poll or a file write started before a deletion can land after it — after the
 * sweep has already passed, even after it has finished. Those writers address the
 * instance by NAME alone, so they would happily recreate discovery, agent or file
 * rows for an instance that no longer exists; a gateway later recreated under the
 * same name then inherits them, and a late revision or curation carries the
 * departing tenant's file content across.
 *
 * The test is the deletion TOMBSTONE, not the absence of an instance row.
 * Refusing whenever no instance serves the name would also block paths that
 * legitimately write before one exists, which is not the hazard; the tombstone
 * marks precisely the interval this is about — from the instance disappearing to
 * the sweep finishing — and it composes with the reuse lock, since no new
 * instance can claim the name while it stands.
 *
 * DECLARED LIMIT: a write that outlives the ENTIRE sweep AND a subsequent
 * recreation of the same name would be accepted, since by then the tombstone is
 * gone and nothing here distinguishes generations. Closing that needs a
 * generation id threaded through every writer; it is not closed, and the window
 * is narrow because deprovisioning stops the gateway and bridge services first —
 * and the bridge's own credential is destroyed in the deletion's first
 * transaction, so it cannot authenticate to write anything afterwards.
 */
export async function nameBoundWriteAllowed(
  ctx: MutationCtx,
  instanceName: string,
): Promise<boolean> {
  const sweeping = await ctx.db
    .query("instanceCascades")
    .withIndex("by_name", (query) => query.eq("instanceName", instanceName))
    .unique();
  return sweeping === null;
}

/** Close the job once the sweep finds nothing left to remove. */
export async function closeCascadeJob(
  ctx: MutationCtx,
  instanceName: string,
): Promise<void> {
  const existing = await ctx.db
    .query("instanceCascades")
    .withIndex("by_name", (query) => query.eq("instanceName", instanceName))
    .unique();
  if (existing !== null) await ctx.db.delete(existing._id);
}

/**
 * One bounded pass of the name-bound sweep.
 *
 * Deliberately ONE table per pass, in a fixed order: it keeps every transaction
 * small and makes the stopping condition trivially true — a pass returns "more"
 * only when it actually deleted something, so the chain cannot spin on an empty
 * table, and "done" only when every table is empty for this name.
 */
export async function sweepInstanceNameBoundBatch(
  ctx: MutationCtx,
  name: string,
): Promise<"more" | "done"> {
  // SECOND LOCK. `applyProvision` refuses a name while its sweep is owed, so this
  // should be unreachable — but the rows here are matched by NAME ALONE and carry
  // nothing that distinguishes the deleted instance's from a new one's. If the
  // name ever became live again while this chain was mid-flight, continuing would
  // delete the LIVE instance's agents and grants. Stopping instead can leave
  // orphans behind; that is the strictly better failure, and it is loud.
  const revived = await ctx.db
    .query("instances")
    .withIndex("by_name", (query) => query.eq("name", name))
    .first();
  if (revived !== null) {
    console.log(
      `[cascade] abandoning the sweep of "${name}": an instance now serves that ` +
        "name again, and these rows can no longer be told apart from its own",
    );
    return "done";
  }

  const discovery = await ctx.db
    .query("instanceDiscovery")
    .withIndex("by_instance", (query) => query.eq("instanceName", name))
    .take(CASCADE_BATCH);
  if (discovery.length > 0) {
    for (const row of discovery) await ctx.db.delete(row._id);
    return "more";
  }

  const usage = await ctx.db
    .query("instanceUsage")
    .withIndex("by_instance", (query) => query.eq("instanceName", name))
    .take(CASCADE_BATCH);
  if (usage.length > 0) {
    for (const row of usage) await ctx.db.delete(row._id);
    return "more";
  }

  // AGENT FILE CONTENT, before anything else that could free the name. These two
  // hold actual file bodies attributed to (instanceName, agentId): a curation is a
  // PROPOSAL that `claimForApply` writes to a gateway, and a revision is stored
  // history. Left behind, a gateway recreated under the same name inherits them —
  // `listCurations` surfaces the old proposal and applying it copies the removed
  // instance's files, MEMORY.md included, onto the replacement. That is content
  // crossing between two organisations' gateways, which is the precise thing
  // separate instances exist to prevent.
  //
  // Both are swept through an index whose FIRST field is `instanceName`
  // (`by_target` / `by_agent_file`), queried on that prefix — no new index needed.
  const curations = await ctx.db
    .query("agentFileCurations")
    .withIndex("by_target", (query) => query.eq("instanceName", name))
    .take(CONTENT_BATCH);
  if (curations.length > 0) {
    for (const row of curations) {
      // RELEASE THE CHAT THAT IS WAITING ON IT. A curation still `dispatched` is
      // referenced by its requester's hidden curator chat through
      // `pendingCurate.curationId`. Deleting only the curation row leaves that
      // chat pointing at nothing: the user stays blocked behind an in-flight job
      // that can never settle, and a delayed dispatch could later rebind the chat
      // and carry the departed instance's file content to a replacement gateway.
      // One indexed point read per curation — bounded by CONTENT_BATCH.
      const requester = await ctx.db
        .query("chats")
        .withIndex("by_user_kind", (query) =>
          query.eq("userId", row.requestedByUserId).eq("kind", "curator"),
        )
        .first();
      if (
        requester !== null &&
        requester.pendingCurate?.curationId === row._id
      ) {
        await ctx.db.patch(requester._id, { pendingCurate: undefined });
      }
      await ctx.db.delete(row._id);
    }
    return "more";
  }

  const revisions = await ctx.db
    .query("agentFileRevisions")
    .withIndex("by_agent_file", (query) => query.eq("instanceName", name))
    .take(CONTENT_BATCH);
  if (revisions.length > 0) {
    for (const row of revisions) await ctx.db.delete(row._id);
    return "more";
  }

  const agents = await ctx.db
    .query("agents")
    .withIndex("by_instance", (query) => query.eq("instanceName", name))
    .take(CASCADE_BATCH);
  if (agents.length > 0) {
    for (const row of agents) await ctx.db.delete(row._id);
    return "more";
  }

  const groupAgents = await ctx.db
    .query("groupAgents")
    .withIndex("by_instance", (query) => query.eq("instanceName", name))
    .take(CASCADE_BATCH);
  if (groupAgents.length > 0) {
    for (const row of groupAgents) await ctx.db.delete(row._id);
    return "more";
  }

  // Grants LAST: their removal is what changes what a user can reach, and each
  // one may cost a re-election read, so they get the smallest batch.
  const userAgents = await ctx.db
    .query("userAgents")
    .withIndex("by_instance", (query) => query.eq("instanceName", name))
    .take(REELECT_BATCH);
  if (userAgents.length > 0) {
    // Only the users whose DEFAULT grant is being removed need a new one. That is
    // knowable from the row itself, which spares the expensive part: there is no
    // need to scan a user's remaining grants looking for a default, because the
    // "exactly one default" invariant means the one we just deleted WAS it.
    //
    // The earlier version scanned instead, and skipped re-election whenever the
    // scan came back exactly full — permanently violating the invariant for anyone
    // holding many grants, since no later pass revisits them.
    const lostDefault = new Set<Id<"users">>();
    for (const row of userAgents) {
      if (row.isDefault) lostDefault.add(row.userId);
      await ctx.db.delete(row._id);
    }
    for (const userId of lostDefault) {
      const survivor = await ctx.db
        .query("userAgents")
        .withIndex("by_user", (query) => query.eq("userId", userId))
        .first();
      if (survivor !== null && !survivor.isDefault) {
        await ctx.db.patch(survivor._id, { isDefault: true });
      }
    }
    return "more";
  }

  // Chats intentionally remain: dispatch resolves the now-missing grant and
  // rebinds to a surviving default while preserving conversation history.
  return "done";
}

export const CASCADE_TUNING = {
  CASCADE_BATCH,
  REELECT_BATCH,
  CONTENT_BATCH,
} as const;
