// THE DISPLAY GROUPS OF A PROJECTED CONVERSATION (transcript redesign, phase 5 — design
// §14). `regroup` recomputes the cache `messages.displayGroupId` of a conversation's most
// recent bubbles from identities only (convex/lib/delegationChain.ts holds the rules), and
// anchors the sub-agents a launch row names to the bubble of the run that launched them.
// Idempotent: running it twice, or after any order of arrival of the facts, gives the same
// groups.
//
// `on` only, checked when it RUNS (a task planned before a rollback to `shadow` writes
// nothing). It never reads a row text.
//
// SCOPED (codex phase 5 pass 1 #1): a launch fact is a proof only inside the instance and
// the session whose bridge read it. It never moves a sub-agent row another instance wrote,
// nor one whose child run is not the one the fact names; it never groups bubbles of two
// instances.
//
// BOUNDED (pass 1 #2, #5): ONE read meter for the whole call — anchoring, fact loading and
// the window share it. Anchoring stops before the meter reaches ANCHOR_STOP_BYTES and hands
// the remaining ids to an id-only continuation; grouping starts only under GROUP_START_BYTES
// and its window stops at REGROUP_READ_BYTES. Every list read as a proof is read with one
// element MORE than it may hold: a fuller list is never a proof.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  ChainResolver,
  deliveryParentRef,
  groupMessages,
  MAX_CHAIN_DEPTH,
  type ChainFacts,
  type GroupUnit,
  type LaunchFact,
  type TaskStart,
} from "./lib/delegationChain";
import { docBytes } from "./lib/bubbleProjectionStore";
import { projectionModeOfChat } from "./lib/followUp";
import { compareOrder } from "./lib/messageOrder";
import { bubbleInScope, type BubbleScope } from "./lib/projectedRuns";
import { rowSegment, steerSeqsOf, transcriptStoredText, type ReadMeter } from "./lib/transcriptProjection";

/** Most recent messages a regroup considers. A chain is recent by nature; an older bubble
 *  keeps its cached group. */
export const REGROUP_WINDOW = 24;
/** Bytes the whole call may read before the window stops widening (a message can carry
 *  ~800 KiB of text; Convex reads at most 16 MiB per transaction). */
export const REGROUP_READ_BYTES = 8 * 1024 * 1024;
/** Anchoring stops before this many bytes were read (one anchor reads at most ~6.5 MiB:
 *  eight bubble documents), and hands the rest on. */
export const ANCHOR_STOP_BYTES = 4 * 1024 * 1024;
/** Grouping runs in the same call only under this; otherwise in a continuation. */
export const GROUP_START_BYTES = 4 * 1024 * 1024;
/** Fact loading reads as unknown past this (each fact is a few hundred bytes; a task row
 *  may carry a child's answer). */
export const FACT_READ_BYTES = 12 * 1024 * 1024;
/** Index probes the fact walk may take (the rest of the walk reads as unknown: no chain). */
export const REGROUP_FACT_PROBES = 400;
/** Sub-agents anchored per call; the rest in a continuation. */
export const REGROUP_ANCHORS = 32;
/** How many times a launch waits for its launching run's bubble before it gives up. */
export const MAX_ANCHOR_TRIES = 16;
/** Facts read per child run (and rows per child key): one more makes the list unprovable. */
export const LAUNCHES_PER_CHILD = 4;

type Meter = ReadMeter;
const metered = <T>(meter: Meter, doc: T): T => {
  meter.bytes += docBytes(doc);
  return doc;
};

/** The window, oldest first in DISPLAY order (the order listByChat shows), bounded in
 *  count and by the shared meter. */
async function windowOf(ctx: MutationCtx, chatId: Id<"chats">, meter: Meter): Promise<Doc<"messages">[]> {
  const out: Doc<"messages">[] = [];
  for await (const m of ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")) {
    out.push(metered(meter, m));
    if (out.length >= REGROUP_WINDOW || meter.bytes >= REGROUP_READ_BYTES) break;
  }
  return out.sort(compareOrder);
}

/** Every fact the rules may ask about the runs of `runs`, walked up to MAX_CHAIN_DEPTH
 *  levels of launchers; a run whose walk ran out of probes or bytes is `unknown`, a child
 *  with more facts than read is `overflow` (no chain either way). */
async function loadFacts(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runs: readonly string[],
  meter: Meter,
): Promise<ChainFacts> {
  const launchesOfChild = new Map<string, LaunchFact[]>();
  const taskStarts = new Map<string, TaskStart[]>();
  const unknown = new Set<string>();
  const overflow = new Set<string>();
  let probes = 0;
  const seen = new Set<string>();
  const out = () => probes >= REGROUP_FACT_PROBES || meter.bytes >= FACT_READ_BYTES;
  let level = [...new Set(runs)];
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const runId of level) {
      if (seen.has(runId)) continue;
      seen.add(runId);
      const ref = deliveryParentRef(runId);
      if (ref === null) continue;
      if (ref.kind === "task") {
        if (!taskStarts.has(ref.taskId) && !overflow.has(ref.taskId)) {
          if (out()) {
            unknown.add(runId);
            continue;
          }
          probes++;
          const rows = (
            await ctx.db
              .query("subAgents")
              .withIndex("by_child", (q) => q.eq("childSessionKey", `task:${ref.taskId}`))
              .take(LAUNCHES_PER_CHILD + 1)
          ).map((r) => metered(meter, r));
          if (rows.length > LAUNCHES_PER_CHILD) {
            overflow.add(ref.taskId);
            continue;
          }
          const starts = rows.flatMap((r) =>
            r.chatId === chatId && r.startRunId !== undefined
              ? [{ startRunId: r.startRunId, ...(r.instanceName !== undefined ? { instanceName: r.instanceName } : {}) }]
              : [],
          );
          taskStarts.set(ref.taskId, starts);
        }
        next.push(...(taskStarts.get(ref.taskId) ?? []).map((s) => s.startRunId));
        continue;
      }
      const children = ref.kind === "announce" ? [ref.childRunId] : ref.childRunIds;
      for (const child of children) {
        if (overflow.has(child)) continue;
        if (!launchesOfChild.has(child)) {
          if (out()) {
            unknown.add(runId);
            break;
          }
          probes++;
          const facts = (
            await ctx.db
              .query("transcriptSpawns")
              .withIndex("by_chat_child_run", (q) => q.eq("chatId", chatId).eq("childRunId", child))
              .take(LAUNCHES_PER_CHILD + 1)
          ).map((f) => metered(meter, f));
          if (facts.length > LAUNCHES_PER_CHILD) {
            overflow.add(child);
            continue;
          }
          launchesOfChild.set(
            child,
            facts.map((f) => ({
              parentRunId: f.parentRunId,
              childSessionKey: f.childSessionKey,
              sessionKey: f.sessionKey,
              instanceName: f.instanceName,
            })),
          );
        }
        next.push(...launchesOfChild.get(child)!.map((f) => f.parentRunId));
      }
    }
    level = next;
  }
  // Runs still to walk past the depth are left unread: the rules stop at the same depth.
  return { launchesOfChild, taskStarts, unknown, overflow };
}

/** Recompute the display groups of the chat's most recent bubbles; returns how many
 *  messages changed. */
export async function regroupChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  meter: Meter = { bytes: 0 },
): Promise<number> {
  const window = await windowOf(ctx, chatId, meter);
  const runs = window.flatMap((m) => (m.role === "assistant" && m.runId !== undefined ? [m.runId] : []));
  const facts = await loadFacts(ctx, chatId, runs, meter);
  const units: GroupUnit[] = window.map((m) => ({
    id: m._id,
    role: m.role,
    ...(m.role === "assistant" && m.runId !== undefined ? { runId: m.runId } : {}),
    ...(m.role === "assistant" && m.turnSessionKey !== undefined ? { sessionKey: m.turnSessionKey } : {}),
    ...(m.role === "assistant" && m.boundInstance !== undefined ? { instanceName: m.boundInstance } : {}),
    ...(m.displayGroupId !== undefined ? { current: m.displayGroupId } : {}),
  }));
  const resolver = new ChainResolver(facts);
  const changes = groupMessages(units, (runId, scope) => resolver.root(runId, scope));
  for (const [id, groupId] of changes) {
    await ctx.db.patch(id as Id<"messages">, { displayGroupId: groupId });
  }
  return changes.size;
}

/** `liveBubbleFor` (lib/projectedRuns.ts), every document it reads charged to the meter. */
async function bubbleOfSegment(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  segment: number,
  scope: BubbleScope,
  meter: Meter,
): Promise<Id<"messages"> | null> {
  if (segment === 0) {
    const recorded = (
      await ctx.db
        .query("runBubbles")
        .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
        .take(4)
    ).map((r) => metered(meter, r));
    for (const r of recorded) {
      const m = metered(meter, await ctx.db.get(r.messageId));
      if (m !== null && m.chatId === chatId && bubbleInScope(m, scope)) return r.messageId;
    }
  }
  const own = (
    await ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) =>
        q.eq("chatId", chatId).eq("runId", runId).eq("runSegment", segment === 0 ? undefined : segment),
      )
      .take(4)
  ).map((m) => metered(meter, m));
  return own.find((m) => m.role === "assistant" && bubbleInScope(m, scope))?._id ?? null;
}

/** What a launch fact proves for its own scope: the bubble of the segment of the launching
 *  run that holds the launch row ("pending" when that run has no bubble yet), or nothing —
 *  another launcher of the same child in the scope, more facts than read, cuts not all
 *  readable. */
async function launchBubble(
  ctx: MutationCtx,
  fact: Doc<"transcriptSpawns">,
  meter: Meter,
): Promise<Id<"messages"> | "pending" | null> {
  const all = (
    await ctx.db
      .query("transcriptSpawns")
      .withIndex("by_chat_child_run", (q) => q.eq("chatId", fact.chatId).eq("childRunId", fact.childRunId))
      .take(LAUNCHES_PER_CHILD + 1)
  ).map((f) => metered(meter, f));
  if (all.length > LAUNCHES_PER_CHILD) return null;
  const parents = new Set(
    all
      .filter(
        (f) =>
          f.instanceName === fact.instanceName &&
          f.sessionKey === fact.sessionKey &&
          f.childSessionKey === fact.childSessionKey,
      )
      .map((f) => f.parentRunId),
  );
  if (parents.size !== 1 || !parents.has(fact.parentRunId)) return null;
  const cuts = await steerSeqsOf(ctx, fact.chatId, fact.sessionKey, fact.parentRunId, meter);
  // Cuts not all readable: the segment is unknown — no anchor rather than a wrong one.
  if (!cuts.complete) return null;
  const bubble = await bubbleOfSegment(
    ctx,
    fact.chatId,
    fact.parentRunId,
    rowSegment(fact.seq, cuts.seqs),
    { instanceName: fact.instanceName, sessionKey: fact.sessionKey },
    meter,
  );
  return bubble ?? "pending";
}

/** The sub-agent rows a launch fact may anchor: same chat, written by the SAME instance,
 *  for the SAME child run. Null when more rows share the child key than are read. */
async function rowsOfFact(
  ctx: MutationCtx,
  fact: Doc<"transcriptSpawns">,
  meter: Meter,
): Promise<Doc<"subAgents">[] | null> {
  const rows = (
    await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", fact.childSessionKey))
      .take(LAUNCHES_PER_CHILD + 1)
  ).map((r) => metered(meter, r));
  if (rows.length > LAUNCHES_PER_CHILD) return null;
  // A row of this chat not yet correlated (its run id or its instance still unknown) may
  // be this child: it is marked so its next observation — the one that brings them —
  // resolves it (codex phase 5 pass 2 #2). Never anchored from here without both.
  for (const r of rows) {
    if (
      r.chatId === fact.chatId &&
      (r.childRunId === undefined || r.instanceName === undefined) &&
      (r.childRunId === undefined || r.childRunId === fact.childRunId) &&
      (r.instanceName === undefined || r.instanceName === fact.instanceName) &&
      r.kind !== "task" &&
      r.anchorPending !== true
    ) {
      await ctx.db.patch(r._id, { anchorPending: true });
    }
  }
  return rows.filter(
    (r) => r.chatId === fact.chatId && r.instanceName === fact.instanceName && r.childRunId === fact.childRunId,
  );
}

/** Anchor the sub-agent a launch row names. Authoritative over the bridge's anchor (a
 *  launch row is an identity, the bridge's fallback anchor a position) — inside its scope
 *  only. Returns whether the launch still waits for its run's bubble. */
async function anchorFromFact(
  ctx: MutationCtx,
  fact: Doc<"transcriptSpawns">,
  meter: Meter,
): Promise<"pending" | "done"> {
  const rows = await rowsOfFact(ctx, fact, meter);
  // No row (yet): its first observation takes the anchor (`transcriptAnchorOf`).
  if (rows === null || rows.length === 0) return "done";
  const bubble = await launchBubble(ctx, fact, meter);
  if (bubble === null) return "done";
  for (const row of rows) {
    if (bubble === "pending") {
      if (row.anchorPending !== true) await ctx.db.patch(row._id, { anchorPending: true });
      continue;
    }
    if (row.parentMessageId === bubble && row.anchorExact === true && row.anchorPending === undefined) continue;
    await ctx.db.patch(row._id, { parentMessageId: bubble, anchorExact: true, anchorPending: undefined });
  }
  return bubble === "pending" ? "pending" : "done";
}

/** Record the outcome of an anchoring attempt on the fact (bounded retries). */
async function settleFactAnchor(
  ctx: MutationCtx,
  fact: Doc<"transcriptSpawns">,
  outcome: "pending" | "done",
): Promise<void> {
  if (outcome === "done") {
    if (fact.anchorPending !== undefined || fact.anchorTries !== undefined) {
      await ctx.db.patch(fact._id, { anchorPending: undefined, anchorTries: undefined });
    }
    return;
  }
  const tries = (fact.anchorTries ?? 0) + 1;
  await ctx.db.patch(
    fact._id,
    tries >= MAX_ANCHOR_TRIES ? { anchorPending: undefined, anchorTries: tries } : { anchorPending: true, anchorTries: tries },
  );
}

/**
 * The anchor the transcript gives a sub-agent observed by `instanceName` — for its first
 * observation, or one marked pending. The fact must be the instance's own, name this child
 * key and this child run, and be the only launcher of the child in its scope; the bubble
 * is taken inside that scope only (codex phase 5 pass 1 #1, #5). "pending": the launch is
 * known, its run has no bubble yet (the fact is marked so the bubble's opening re-tries).
 */
export async function transcriptAnchorOf(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  childSessionKey: string,
  childRunId: string | undefined,
  instanceName: string | undefined,
): Promise<Id<"messages"> | "pending" | null> {
  if (childRunId === undefined || instanceName === undefined) return null;
  const meter: Meter = { bytes: 0 };
  const facts = await ctx.db
    .query("transcriptSpawns")
    .withIndex("by_chat_child_run", (q) => q.eq("chatId", chatId).eq("childRunId", childRunId))
    .take(LAUNCHES_PER_CHILD + 1);
  if (facts.length > LAUNCHES_PER_CHILD) return null;
  const fact = facts.find((f) => f.instanceName === instanceName && f.childSessionKey === childSessionKey);
  if (fact === undefined) return null;
  const bubble = await launchBubble(ctx, fact, meter);
  if (bubble === "pending" && fact.anchorPending !== true) {
    await ctx.db.patch(fact._id, { anchorPending: true, anchorTries: fact.anchorTries ?? 0 });
  }
  return bubble;
}

/** A bubble of `runId` opens (projection `on`): a launch of that run waiting for it gets a
 *  regroup that anchors it (one index probe). */
export async function regroupIfLaunchWaits(ctx: MutationCtx, chatId: Id<"chats">, runId: string): Promise<void> {
  const waiting = await ctx.db
    .query("transcriptSpawns")
    .withIndex("by_chat_pending_parent", (q) => q.eq("chatId", chatId).eq("anchorPending", true).eq("parentRunId", runId))
    .first();
  if (waiting !== null) await scheduleRegroup(ctx, chatId);
}

export const regroup = internalMutation({
  args: {
    chatId: v.id("chats"),
    /** Launch rows stored since the last regroup: their sub-agents get their anchor. */
    spawnIds: v.optional(v.array(v.id("transcriptSpawns"))),
    /** A continuation that only regroups (the anchors were done by the call before). */
    groupOnly: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { chatId, spawnIds, groupOnly }) => {
    const meter: Meter = { bytes: 0 };
    const chat = metered(meter, await ctx.db.get(chatId));
    if (chat === null || !transcriptStoredText(chat)) return null;
    // Re-read when it runs: a regroup planned before a rollback writes nothing.
    if ((await projectionModeOfChat(ctx, chat)) !== "on") return null;
    if (groupOnly !== true) {
      // The launches named now, then those still waiting for their run's bubble.
      const explicit = spawnIds ?? [];
      const waiting = (
        await ctx.db
          .query("transcriptSpawns")
          .withIndex("by_chat_pending_parent", (q) => q.eq("chatId", chatId).eq("anchorPending", true))
          .take(REGROUP_ANCHORS)
      ).map((f) => metered(meter, f));
      const queue: Array<Id<"transcriptSpawns">> = [...explicit];
      for (const f of waiting) if (!queue.includes(f._id)) queue.push(f._id);
      for (let i = 0; i < queue.length; i++) {
        if (i >= REGROUP_ANCHORS || meter.bytes >= ANCHOR_STOP_BYTES) {
          // Handed on, ids only: the explicit ones left (the waiting ones are found again).
          const rest = queue.slice(i).filter((id) => explicit.includes(id));
          await ctx.scheduler.runAfter(0, internal.displayGroups.regroup, {
            chatId,
            ...(rest.length > 0 ? { spawnIds: rest } : { groupOnly: true }),
          });
          return null;
        }
        const fact = metered(meter, await ctx.db.get(queue[i]!));
        if (fact === null || fact.chatId !== chatId) continue;
        await settleFactAnchor(ctx, fact, await anchorFromFact(ctx, fact, meter));
      }
    }
    if (meter.bytes >= GROUP_START_BYTES) {
      await ctx.scheduler.runAfter(0, internal.displayGroups.regroup, { chatId, groupOnly: true });
      return null;
    }
    await regroupChat(ctx, chatId, meter);
    return null;
  },
});

/** Plan a regroup of an `on` conversation (ids only). */
export async function scheduleRegroup(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  spawnIds: readonly Id<"transcriptSpawns">[] = [],
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.displayGroups.regroup, {
    chatId,
    ...(spawnIds.length > 0 ? { spawnIds: [...spawnIds] } : {}),
  });
}
