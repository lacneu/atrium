// A purged agent's access rows (userAgents grants, groupAgents shares,
// groupMemberAgents allowances, chatAgents room delegations) are deleted in bounded batches (agents.
// sweepAgentAccess), so for a while some of them still exist after the agent row is
// gone. Their deletion must not be what ends the access: a missing agent row reads as
// "never discovered" to the resolvers (an unknown agent stays usable — agentUsable,
// routing.isDeleted), and an agent re-discovered under the same id before the sweep
// ends would take every old row back. So the purge records, in its own transaction,
// the exact generation boundary of each table (`agentPurges`), and:
//   (room delegations are swept by their own chain, agents.sweepRoomDelegations,
//   and covered the same way: a participant addresses a room's agent on the
//   owner's delegation, so an old row would let them reach a re-enabled agent)
//   - every access READ drops the rows at or below that boundary (deadAccessRow);
//   - every access WRITE for the agent refuses with a retryable code while the
//     marker exists (assertNoPendingPurge) — so an assignment can never land on, or
//     be mistaken for, a row the sweep is about to delete;
//   - the sweep deletes the marker once no row at or below a boundary is left
//     (settlePurge).

import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** Typed, retryable refusal (ConvexError data) the UI localizes: an access change
 *  for an agent whose purge has not finished removing the old access rows. */
export const AGENT_PURGE_PENDING = "agent_purge_pending";

export type AccessKind = "grants" | "shares" | "allowances" | "rooms";

export type PurgeCutoffs = {
  grantsCutoff: number | null;
  sharesCutoff: number | null;
  allowancesCutoff: number | null;
  roomsCutoff: number | null;
};

/** Per-call memo of marker reads, keyed by (instance, agent). Pass one through a
 *  resolution that filters many rows so each agent costs one indexed read. It holds
 *  the PROMISE, stored before the first await: resolutions run concurrently
 *  (Promise.all over a page of users) would otherwise all miss and each read the
 *  same marker — 300 users × 15 shared grants was 4,500 reads for 15 keys, past a
 *  function's read limit (codex pass 8). */
export type PurgeReader = Map<string, Promise<Doc<"agentPurges"> | null>>;

export const newPurgeReader = (): PurgeReader => new Map();

const keyOf = (instanceName: string, agentId: string): string =>
  `${instanceName.length}:${instanceName}/${agentId}`;

async function markerOf(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
  reader?: PurgeReader,
): Promise<Doc<"agentPurges"> | null> {
  const key = keyOf(instanceName, agentId);
  const memo = reader?.get(key);
  if (memo !== undefined) return await memo;
  const read = ctx.db
    .query("agentPurges")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .unique();
  reader?.set(key, read);
  return await read;
}

function cutoffOf(marker: Doc<"agentPurges">, kind: AccessKind): number | null {
  if (kind === "grants") return marker.grantsCutoff;
  if (kind === "shares") return marker.sharesCutoff;
  if (kind === "rooms") return marker.roomsCutoff ?? null;
  return marker.allowancesCutoff;
}

/** Is this access row one a pending purge has already revoked? */
export async function deadAccessRow(
  ctx: QueryCtx | MutationCtx,
  kind: AccessKind,
  row: { instanceName: string; agentId: string; _creationTime: number },
  reader?: PurgeReader,
): Promise<boolean> {
  const marker = await markerOf(ctx, row.instanceName, row.agentId, reader);
  if (marker === null) return false;
  const cutoff = cutoffOf(marker, kind);
  return cutoff !== null && row._creationTime <= cutoff;
}

/** `rows` without those a pending purge has revoked (order preserved). */
export async function liveAccessRows<
  T extends { instanceName: string; agentId: string; _creationTime: number },
>(
  ctx: QueryCtx | MutationCtx,
  kind: AccessKind,
  rows: T[],
  reader: PurgeReader = newPurgeReader(),
): Promise<T[]> {
  const out: T[] = [];
  for (const r of rows) {
    if (!(await deadAccessRow(ctx, kind, r, reader))) out.push(r);
  }
  return out;
}

/** Refuse (retryably) any access change for an agent still being purged. */
export async function assertNoPendingPurge(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<void> {
  if ((await markerOf(ctx, instanceName, agentId)) !== null) {
    throw new ConvexError({ code: AGENT_PURGE_PENDING });
  }
}

/** Record (or widen) the purge boundary of (instance, agent). A second purge while
 *  the first is still sweeping keeps the later boundary of each table. */
export async function recordPurge(
  ctx: MutationCtx,
  instanceName: string,
  agentId: string,
  cutoffs: PurgeCutoffs,
): Promise<void> {
  const prior = await markerOf(ctx, instanceName, agentId);
  const later = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.max(a, b);
  if (prior === null) {
    await ctx.db.insert("agentPurges", { instanceName, agentId, ...cutoffs, purgedAt: Date.now() });
    return;
  }
  await ctx.db.patch(prior._id, {
    grantsCutoff: later(prior.grantsCutoff, cutoffs.grantsCutoff),
    sharesCutoff: later(prior.sharesCutoff, cutoffs.sharesCutoff),
    allowancesCutoff: later(prior.allowancesCutoff, cutoffs.allowancesCutoff),
    roomsCutoff: later(prior.roomsCutoff ?? null, cutoffs.roomsCutoff),
  });
}

/** Delete the marker once no row at or below any of its boundaries is left (four
 *  indexed point reads). Called by each sweep chain (access rows, room delegations)
 *  when its own batches ran dry: whichever finishes last removes it. */
export async function settlePurge(
  ctx: MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<void> {
  const marker = await markerOf(ctx, instanceName, agentId);
  if (marker === null) return;
  const tables = [
    ["userAgents", marker.grantsCutoff],
    ["groupAgents", marker.sharesCutoff],
    ["groupMemberAgents", marker.allowancesCutoff],
    ["chatAgents", marker.roomsCutoff ?? null],
  ] as const;
  for (const [table, cutoff] of tables) {
    if (cutoff === null) continue;
    const left = await ctx.db
      .query(table)
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId).lte("_creationTime", cutoff),
      )
      .first();
    if (left !== null) return;
  }
  await ctx.db.delete(marker._id);
}
