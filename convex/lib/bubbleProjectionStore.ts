// THE TRANSCRIPT MAKES THE BUBBLES — the store side (redesign phase 4, projection `on`).
//
// Loads the view `planProjection` (lib/bubbleProjection.ts) needs through bounded index
// reads, and executes its plan in the caller's transaction (`applyTranscript`): rows are
// assigned, bubbles born from rows are inserted, settled bubbles are recomposed in the
// SAME message and — when still streaming — settled by `finalize`'s own core, so the
// live row is deleted and the queue drained exactly as a live terminal would.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { deliveryRefusedByStop, finalizeMessageCore, settleTurnEnd } from "../stream";
import { ALL_SEGMENTS, deletedMergeOf, segmentDeleted, steerSeqsOf, tombstonedSegments } from "./transcriptProjection";
import { effectiveOrder, QUEUED_ORDER_SENTINEL } from "./messageOrder";
import { bubbleInScope, type BubbleScope } from "./projectedRuns";
import {
  planProjection,
  segmentKey,
  utf8Bytes,
  segmentOf,
  type PlanBubble,
  type PlanRow,
  type ProjectionPlan,
  type RunFacts,
  type RunStatus,
} from "./bubbleProjection";

/** Runs projected by one mutation; the rest are handed back to the caller, which
 *  schedules a continuation (a reconnect can settle more runs at once than fit here). */
export const MAX_PROJECTED_RUNS = 20;
/** Rows of one run / of one bubble / steers of one run read for a projection. A run
 *  whose rows reach the bound is treated as NOT covered (its bubble keeps its text). */
const MAX_ROWS_PER_RUN = 400;
const MAX_ROWS_PER_BUBBLE = 400;
const MAX_MERGED_RUNS = 50;
/** Rows looked back for the anchor of a bubble born from rows. */
const MAX_ANCHOR_LOOKBACK = 50;

type Gap = { fromSeq: number; toSeq: number };

export type ProjectionScope = {
  chatId: Id<"chats">;
  sessionKey: string;
  /** The gateway transcript the cursor reads (rows of another one are not projected). */
  sessionId: string;
  instanceName: string;
  floorSeq: number;
  gaps: readonly Gap[];
};

function toPlanRow(d: Doc<"transcriptRows">, shown?: RowText): PlanRow {
  return {
    entryId: d.entryId,
    seq: d.seq,
    role: d.role.toLowerCase(),
    ...(d.runId === undefined ? {} : { runId: d.runId }),
    ...(d.steerTargetRunId === undefined ? {} : { steerTargetRunId: d.steerTargetRunId }),
    hidden: d.hidden,
    visible: d.visible,
    ...(shown?.text === undefined ? {} : { text: shown.text }),
    ...(shown?.yieldAck === undefined ? {} : { yieldAck: shown.yieldAck }),
    ...(d.messageId === undefined ? {} : { messageId: d.messageId }),
  };
}

type RowText = { text?: string; yieldAck?: string };

/** What one projection call may read and write, in bytes. Convex refuses a transaction
 *  past 16 MiB read (and as much written), and the read that triggers a projection has
 *  its own load: rows carry their text (up to 32 KiB each), and bubbles theirs (up to the
 *  composed bound), so the bound must be on BYTES, not on counts (codex phase 4 pass 2 —
 *  20 runs × 28 rows × 32 700 chars, all within the row bounds, rolled the whole read
 *  back; pass 3 — 26 steer segments of a 500 KB live bubble each). EVERY document a call
 *  reads is charged — rows, their texts, bubbles, merges, runs. A call that reaches the
 *  soft bound hands the rest to a continuation before it can reach the hard one. */
export const PROJECTION_BYTE_BUDGET = 6 * 1024 * 1024;
/** Reads stop here whatever they were doing (well under Convex's 16 MiB). */
const PROJECTION_READ_CEILING = 9 * 1024 * 1024;
/** What settling one streaming bubble may read beyond the bubble itself (see `loadBubble`). */
const SETTLE_RESERVE_BYTES = 1024 * 1024 + 64 * 1024;

/** INDEX QUERIES one projection call may issue. Convex also bounds a transaction to 4 096
 *  index ranges, and the bytes budget does not see them: a row's text is one lookup, and a
 *  run of 300 short rows costs 300 of them (codex phase 4 pass 5 — 7 runs × 300 rows of "x"
 *  rolled every idle read back in `executePlan`). The read that triggers the projection
 *  has issued its own before, so the soft bound leaves room for it and for the plan's
 *  execution (reserved per bubble to settle and per bubble to create). */
export const PROJECTION_QUERY_BUDGET = 1500;
/** Lookups stop here whatever they were doing. */
const PROJECTION_QUERY_CEILING = 2400;
/** What settling one streaming bubble may query (`finalize`'s core and its drain). */
const SETTLE_RESERVE_QUERIES = 64;
/** What placing one bubble born from rows queries (its two neighbours). */
const CREATE_RESERVE_QUERIES = 4;

/** The bytes and index queries charged so far, and the documents already loaded (each read
 *  once, charged once — and the row identities reused by the plan's execution). */
export type Budget = {
  bytes: number;
  queries: number;
  messages: Map<string, Doc<"messages"> | null>;
  runs: Map<string, Doc<"transcriptRuns"> | null>;
  rows: Map<string, Doc<"transcriptRows">>;
  /** User bubbles by send id (custody and assignment share them). */
  userBubbles: Map<string, Doc<"messages"> | null>;
};

export const newBudget = (): Budget => ({
  bytes: 0,
  queries: 0,
  messages: new Map(),
  runs: new Map(),
  rows: new Map(),
  userBubbles: new Map(),
});

export const docBytes = (d: unknown): number => (d === null ? 16 : utf8Bytes(JSON.stringify(d)));
const overCeiling = (b: Budget): boolean =>
  b.bytes > PROJECTION_READ_CEILING || b.queries > PROJECTION_QUERY_CEILING;
export const overSoft = (b: Budget): boolean =>
  b.bytes > PROJECTION_BYTE_BUDGET || b.queries > PROJECTION_QUERY_BUDGET;

/** Read lazily (each document is charged as it is read) until `limit` documents, or until
 *  the budget's ceiling: `complete` false then — the caller must not read it as whole. */
async function readBounded<T>(
  query: AsyncIterable<T>,
  limit: number,
  budget: Budget,
): Promise<{ docs: T[]; complete: boolean }> {
  const docs: T[] = [];
  budget.queries++;
  for await (const d of query) {
    if (docs.length >= limit || overCeiling(budget)) {
      return { docs, complete: false };
    }
    budget.bytes += docBytes(d);
    docs.push(d);
  }
  return { docs, complete: true };
}

/** A message, read once per call and charged once. */
async function messageOf(
  ctx: MutationCtx,
  id: Id<"messages">,
  budget: Budget,
): Promise<Doc<"messages"> | null> {
  const key = String(id);
  if (budget.messages.has(key)) return budget.messages.get(key)!;
  const m = await ctx.db.get(id);
  budget.bytes += docBytes(m);
  budget.messages.set(key, m);
  return m;
}

/** A run of the session's run table, read once per call and charged once. */
async function runOf(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runId: string,
  budget: Budget,
): Promise<Doc<"transcriptRuns"> | null> {
  if (budget.runs.has(runId)) return budget.runs.get(runId)!;
  budget.queries++;
  const run = await ctx.db
    .query("transcriptRuns")
    .withIndex("by_chat_session_run", (q) =>
      q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("runId", runId),
    )
    .first();
  budget.bytes += docBytes(run);
  budget.runs.set(runId, run);
  return run;
}

/** The texts of rows whose text is known (`textSig`), charged. `complete` false: the
 *  ceiling stopped the reads — the rows not reached stay without text (not covered). */
async function textsOf(
  ctx: MutationCtx,
  rows: readonly Doc<"transcriptRows">[],
  budget: Budget,
): Promise<{ texts: Map<string, RowText>; complete: boolean }> {
  const texts = new Map<string, RowText>();
  for (const r of rows) {
    if (r.textSig === undefined) continue;
    if (overCeiling(budget)) return { texts, complete: false };
    budget.queries++;
    const doc = await ctx.db
      .query("transcriptRowTexts")
      .withIndex("by_row", (q) => q.eq("rowId", r._id))
      .first();
    budget.bytes += docBytes(doc);
    if (doc !== null) {
      texts.set(String(r._id), {
        ...(doc.text === undefined ? {} : { text: doc.text }),
        ...(doc.yieldAck === undefined ? {} : { yieldAck: doc.yieldAck }),
      });
    }
  }
  return { texts, complete: true };
}

async function rowsOfRun(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runId: string,
  budget: Budget,
): Promise<{ rows: Doc<"transcriptRows">[]; complete: boolean }> {
  const { docs, complete } = await readBounded(
    ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_run", (q) => q.eq("chatId", scope.chatId).eq("runId", runId)),
    MAX_ROWS_PER_RUN,
    budget,
  );
  for (const d of docs) budget.rows.set(`${d.sessionKey}\u0000${d.entryId}`, d);
  return {
    rows: docs.filter((d) => d.sessionKey === scope.sessionKey && d.sessionId === scope.sessionId),
    complete,
  };
}

function overlapsGap(gaps: readonly Gap[], first: number, last: number): boolean {
  return gaps.some((g) => g.fromSeq <= last && g.toSeq >= first);
}

async function runFacts(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runId: string,
  complete: boolean,
  budget: Budget,
): Promise<RunFacts | undefined> {
  const run = await runOf(ctx, scope, runId, budget);
  if (run === null) return undefined;
  const covered =
    complete &&
    run.firstSeq !== undefined &&
    run.lastSeq !== undefined &&
    run.firstSeq > scope.floorSeq &&
    !overlapsGap(scope.gaps, run.firstSeq, run.lastSeq);
  return { settled: run.settledAt !== undefined, covered, status: run.status as RunStatus };
}

/**
 * Is every visible answer row of a run shown by a bubble this call touches — merged into
 * it, or assigned to it — ASSIGNED (codex phase 4 pass 12)? Its rows arrive with their own
 * read and are assigned when IT is projected: until then the bubble's composition would
 * leave them out (a merged settle reduced to the parent's answer). Not assigned ⇒ the
 * bubble keeps its text. An assigned row whose text is unknown is the planner's own rule
 * (`textKnown`: the bubble's rows are all loaded with it). Read under the shared budget:
 * past the soft bound nothing is read and the run counts as not known.
 */
async function mergedRunKnown(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runId: string,
  budget: Budget,
): Promise<boolean> {
  if (overSoft(budget)) return false;
  const { rows, complete } = await rowsOfRun(ctx, scope, runId, budget);
  if (!complete) return false;
  for (const d of rows) {
    if (d.role.toLowerCase() !== "assistant" || d.hidden || !d.visible) continue;
    if (d.messageId === undefined) return false;
  }
  return true;
}

/** Where a call stopped inside a run: its next steer segment to project. */
export type ProjectionResume = { runId: string; fromSegment: number };

/**
 * Project the given runs of one session into bubbles, in TRANSCRIPT ORDER (each run's
 * first `seq`; codex phase 4 pass 3 — runs projected in the order a read named them made
 * a later answer's bubble before an earlier one's). `resume`: the run a previous call
 * stopped inside, continued from that segment, first.
 */
export async function projectBubbles(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runIds: readonly string[],
  resume?: ProjectionResume,
  /** The transaction's SHARED budget (codex phase 4 pass 6): what the mutation already
   *  read before projecting counts against the same bounds. Fresh when absent. */
  shared?: Budget,
): Promise<{
  created: number;
  rewritten: number;
  settled: number;
  assigned: number;
  /** Runs NOT projected by this call (over the per-call run or byte bound), in the order
   *  to continue them: the caller schedules a continuation, with a fresh budget. */
  remaining: string[];
  /** The first of `remaining` was started: continue it from this segment. */
  resume?: ProjectionResume;
}> {
  const total = { created: 0, rewritten: 0, settled: 0, assigned: 0, remaining: [] as string[] };
  const chat = await ctx.db.get(scope.chatId);
  if (chat === null) return total;
  const budget = shared ?? newBudget();
  // The mutation already spent its share: everything goes to a fresh transaction.
  if (overSoft(budget)) return { ...total, remaining: [...new Set(runIds)], ...(resume !== undefined ? { resume } : {}) };
  const unique = await inTranscriptOrder(ctx, scope, [...new Set(runIds)], budget, resume?.runId);
  // ONE segment at a time against one budget: the soft bound is checked once a segment is
  // loaded, and a segment whose reads crossed it is left whole to a continuation (nothing
  // of it written) — except the call's first, so every call makes progress.
  const progress = { segments: 0 };
  for (let i = 0; i < unique.length; i++) {
    const runId = unique[i]!;
    if (i >= MAX_PROJECTED_RUNS || (progress.segments > 0 && overSoft(budget))) {
      total.remaining = unique.slice(i);
      break;
    }
    const from = resume !== undefined && resume.runId === runId ? resume.fromSegment : 0;
    const r = await projectRun(ctx, scope, chat, runId, from, budget, progress);
    total.created += r.created;
    total.rewritten += r.rewritten;
    total.settled += r.settled;
    total.assigned += r.assigned;
    if (r.stoppedAt !== undefined) {
      total.remaining = unique.slice(i);
      return { ...total, resume: { runId, fromSegment: r.stoppedAt } };
    }
  }
  return total;
}

/** The runs sorted by their first row's `seq` (a run with no row yet last, by id); the
 *  run a previous call stopped inside stays first. */
async function inTranscriptOrder(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runIds: readonly string[],
  budget: Budget,
  first?: string,
): Promise<string[]> {
  const keyed: Array<{ runId: string; seq: number }> = [];
  for (const runId of runIds) {
    const run = await runOf(ctx, scope, runId, budget);
    keyed.push({ runId, seq: run?.firstSeq ?? Number.POSITIVE_INFINITY });
  }
  keyed.sort((a, b) =>
    a.runId === first ? -1 : b.runId === first ? 1 : a.seq - b.seq || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
  );
  return keyed.map((k) => k.runId);
}

type Counts = { created: number; rewritten: number; settled: number; assigned: number };

/** Project one run's segments from `from` (load, plan, execute) within `budget`.
 *  `stoppedAt`: the reads crossed the soft bound before that segment — it and the ones
 *  after it are left to a continuation (nothing of them written). */
async function projectRun(
  ctx: MutationCtx,
  scope: ProjectionScope,
  chat: Doc<"chats">,
  runId: string,
  from: number,
  budget: Budget,
  progress: { segments: number },
): Promise<Counts & { stoppedAt?: number }> {
  const result: Counts = { created: 0, rewritten: 0, settled: 0, assigned: 0 };
  // THE INTERRUPTION EPOCH (the live door's own rule, stream.ts `deliveryRefusedByStop`):
  // a delivery the user stopped never makes nor rewrites a bubble from its rows either.
  if (await deliveryRefusedByStop(ctx, chat, runId)) return result;
  // A run not known over plans nothing (the planner's first rule): nothing is loaded for it.
  const run = await runOf(ctx, scope, runId, budget);
  if (run === null || run.settledAt === undefined) return result;
  const bubbleScope = { instanceName: scope.instanceName, sessionKey: scope.sessionKey };
  // The segments of this run whose bubble a person DELETED (`transcriptTombstones`): their
  // rows — assigned or not yet, early or late — never make a bubble again, and what they
  // say is not kept (codex phase 4 pass 5).
  budget.queries += 2;
  const tombs = await tombstonedSegments(ctx, scope.chatId, scope.sessionKey, runId);
  // …and a run merged into a bubble already deleted while its tombstoning still paginates.
  const mergedInto = await deletedMergeOf(ctx, scope.chatId, runId);
  const { rows, complete } = await rowsOfRun(ctx, scope, runId, budget);
  // The run's cuts: ONE bounded read shared with storage and every purge
  // (lib/transcriptProjection `steerSeqsOf`). More than one read takes: the segments cannot
  // be drawn, so no row of this run is placed and its bubbles are never recomposed — only
  // settled (codex phase 4 passes 10–11). The run is not covered.
  budget.queries++;
  const runCuts = await steerSeqsOf(ctx, scope.chatId, scope.sessionKey, runId);
  budget.bytes += 1024 * runCuts.seqs.length;
  const steers = runCuts.seqs;
  const cutsComplete = runCuts.complete;
  const own = cutsComplete ? rows.filter((d) => d.role.toLowerCase() !== "user") : [];
  const segmentsAll = new Set<number>(own.map((d) => segmentOf(d.seq, steers)));
  for (let k = 0; k <= steers.length; k++) segmentsAll.add(k);
  const segments = [...segmentsAll].filter((k) => k >= from).sort((a, b) => a - b);

  // Load segment by segment; stop at the first one that crossed the soft bound.
  const planRows: PlanRow[] = [];
  const liveBubbleOf = new Map<string, string>();
  const bubbles = new Map<string, PlanBubble>();
  const runsToKnow = new Set<string>([runId]);
  let textsComplete = true;
  let stoppedAt: number | undefined;
  /** Rows of a segment whose bubble the user DELETED: purged, and assigned to it if not yet. */
  const tombstoned: Array<{ row: Doc<"transcriptRows">; to?: Id<"messages"> }> = [];
  /** A steer whose user message was deleted: from its segment on, the run is deleted
   *  (open-ended, as every deleted span — codex phase 4 pass 27). */
  let steerDeletedFrom: { to?: Id<"messages"> } | null = null;
  for (const k of segments) {
    const before = {
      rows: planRows.length,
      live: new Map(liveBubbleOf),
      bubbles: new Map(bubbles),
      tombstoned: tombstoned.length,
    };
    const segRows = own.filter((d) => segmentOf(d.seq, steers) === k);
    // A segment a STEER started whose user message was deleted: that message's answer —
    // never placed, even before the deletion's follow-up has tombstoned the segment
    // itself (codex phase 4 pass 13). One probe per steered segment.
    // By STABLE boundaries (codex phase 4 pass 27): the segment is deleted when a deleted
    // span reaches into it, however many cuts arrived since.
    const hit = segmentDeleted(tombs, runCuts, k);
    const cutSend = k >= 1 && cutsComplete ? runCuts.sends[k - 1] : undefined;
    if (cutSend !== undefined && hit === null && steerDeletedFrom === null && mergedInto === null) {
      budget.queries++;
      const own = await tombstonedSegments(ctx, scope.chatId, scope.sessionKey, cutSend);
      if (own.has(ALL_SEGMENTS)) {
        const by = own.get(ALL_SEGMENTS);
        steerDeletedFrom = by !== undefined ? { to: by } : {};
      }
    }
    if (hit !== null || mergedInto !== null || steerDeletedFrom !== null) {
      const to = mergedInto ?? hit?.to ?? steerDeletedFrom?.to;
      for (const d of segRows) tombstoned.push({ row: d, ...(to !== undefined ? { to } : {}) });
      progress.segments++;
      continue;
    }
    // A segment may place a bubble born from its rows (its two neighbours' lookups).
    budget.queries += CREATE_RESERVE_QUERIES;
    const t = await textsOf(ctx, segRows, budget);
    if (!t.complete) textsComplete = false;
    for (const d of segRows) planRows.push(toPlanRow(d, t.texts.get(String(d._id))));
    const ids = new Set<string>();
    for (const d of segRows) if (d.messageId !== undefined) ids.add(d.messageId);
    const live = await liveBubbleCharged(ctx, scope.chatId, runId, k, bubbleScope, budget);
    if (live !== null) {
      liveBubbleOf.set(segmentKey(runId, k), live);
      ids.add(live);
    }
    for (const id of ids) {
      if (!bubbles.has(id)) await loadBubble(ctx, scope, id, bubbleScope, budget, bubbles, runsToKnow);
    }
    // The segment's bubble was DELETED (a tombstone): its rows arriving later are never
    // shown again — and what they say is not kept either (codex phase 4 pass 4).
    const target = segRows.find((d) => d.messageId !== undefined)?.messageId ?? live ?? undefined;
    if (target !== undefined && budget.messages.has(String(target)) && budget.messages.get(String(target)) === null) {
      for (const d of segRows) if (d.messageId === undefined) tombstoned.push({ row: d, to: target });
    }
    if (progress.segments > 0 && overSoft(budget)) {
      // This segment waits for a fresh call: drop what it loaded from the plan.
      planRows.length = before.rows;
      liveBubbleOf.clear();
      for (const [key, v] of before.live) liveBubbleOf.set(key, v);
      bubbles.clear();
      for (const [key, v] of before.bubbles) bubbles.set(key, v);
      tombstoned.length = before.tombstoned;
      stoppedAt = k;
      break;
    }
    progress.segments++;
  }
  const facts = new Map<string, RunFacts>();
  for (const id of runsToKnow) {
    if (id === "\u0000unbounded") continue;
    const f = await runFacts(
      ctx,
      scope,
      id,
      id === runId ? complete && textsComplete && cutsComplete : await mergedRunKnown(ctx, scope, id, budget),
      budget,
    );
    if (f !== undefined) facts.set(id, f);
  }
  const plan: ProjectionPlan = planProjection({
    floorSeq: scope.floorSeq,
    runIds: [runId],
    rowsOfRun: new Map([[runId, planRows]]),
    steersOfRun: new Map([[runId, steers]]),
    liveBubbleOf,
    bubbles,
    runs: facts,
  });
  await executePlan(ctx, scope, chat, plan, result, budget);
  // A deleted segment's rows are rattached to the deleted bubble (never placed again).
  // Their texts are NOT read here: the deletion's own purge removes what was stored before
  // it (bounded in bytes), and nothing is stored after it (`writeRowTexts` refuses).
  const copies: Array<Id<"transcriptRows">> = [];
  for (const t of tombstoned) {
    if (t.row.messageId === undefined && t.to !== undefined) {
      await ctx.db.patch(t.row._id, { messageId: t.to });
    }
    // A copy stored before the segment was known deleted: its own bounded step.
    if (t.row.textSig !== undefined) copies.push(t.row._id);
  }
  if (copies.length > 0) {
    await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeRowTextsById, {
      chatId: scope.chatId,
      rowIds: copies,
    });
  }
  // What the plan wrote counts too (Convex bounds writes like reads).
  for (const c of plan.create) budget.bytes += utf8Bytes(c.text);
  for (const w of plan.rewrite) if (w.text !== undefined) budget.bytes += utf8Bytes(w.text);
  return stoppedAt === undefined ? result : { ...result, stoppedAt };
}

/** liveBubbleFor (lib/projectedRuns.ts) with every read charged and every message kept
 *  for the loader: the merge record, the run's own bubbles of segment k. */
async function liveBubbleCharged(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  segment: number,
  scope: BubbleScope,
  budget: Budget,
): Promise<Id<"messages"> | null> {
  if (segment === 0) {
    const recorded = await readBounded(
      ctx.db.query("runBubbles").withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId)),
      4,
      budget,
    );
    for (const r of recorded.docs) {
      const m = await messageOf(ctx, r.messageId, budget);
      if (m !== null && m.chatId === chatId && bubbleInScope(m, scope)) return r.messageId;
    }
  }
  const own = await readBounded(
    ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) =>
        q.eq("chatId", chatId).eq("runId", runId).eq("runSegment", segment === 0 ? undefined : segment),
      ),
    4,
    budget,
  );
  for (const m of own.docs) budget.messages.set(String(m._id), m);
  return own.docs.find((m) => m.role === "assistant" && bubbleInScope(m, scope))?._id ?? null;
}

/** A bubble the plan may touch, with every run it shows (charged). */
async function loadBubble(
  ctx: MutationCtx,
  scope: ProjectionScope,
  id: string,
  bubbleScope: BubbleScope,
  budget: Budget,
  bubbles: Map<string, PlanBubble>,
  runsToKnow: Set<string>,
): Promise<void> {
  const messageId = id as Id<"messages">;
  const message = await messageOf(ctx, messageId, budget);
  // Gone, or not this read's to touch: another instance's or another session's bubble is
  // never assigned to, recomposed nor settled from here — checked BEFORE any assignment
  // (codex phase 4 pass 1). For the plan it is a tombstone: its segment is left alone.
  if (
    message === null ||
    message.chatId !== scope.chatId ||
    message.role !== "assistant" ||
    !bubbleInScope(message, bubbleScope)
  ) {
    bubbles.set(id, { messageId: id, exists: false, status: "complete", text: "", runIds: [], rows: [] });
    return;
  }
  // A bubble still streaming may be SETTLED by this call, through `finalize`'s own core:
  // it reads the message again (and the rewrite once more after it), its live row and
  // parts, and drains the queue — whose busy check reads the chat's next streaming bubble
  // (up to a document's 1 MiB). Reserved now, so the segments loaded after it stop in time.
  if (message.status === "streaming") {
    budget.bytes += 2 * docBytes(message) + SETTLE_RESERVE_BYTES;
    budget.queries += SETTLE_RESERVE_QUERIES;
  }
  const read = await readBounded(
    ctx.db.query("transcriptRows").withIndex("by_message_seq", (q) => q.eq("messageId", messageId)),
    MAX_ROWS_PER_BUBBLE,
    budget,
  );
  const assignedDocs = read.docs;
  for (const d of assignedDocs) budget.rows.set(`${d.sessionKey}\u0000${d.entryId}`, d);
  // Rows of ANOTHER scope assigned to this bubble (written before this check existed)
  // are never read as its own: they are dropped from the composition, and their mere
  // presence keeps the bubble uncovered (its text stays what it is).
  const assigned = assignedDocs.filter(
    (d) =>
      d.chatId === scope.chatId &&
      d.instanceName === scope.instanceName &&
      d.sessionKey === scope.sessionKey &&
      d.sessionId === scope.sessionId,
  );
  const foreignRows = assigned.length !== assignedDocs.length;
  const texts = await textsOf(ctx, assigned, budget);
  const merged = await readBounded(
    ctx.db.query("runBubbles").withIndex("by_message", (q) => q.eq("messageId", messageId)),
    MAX_MERGED_RUNS,
    budget,
  );
  const runIdsOfBubble = new Set<string>();
  if (message.runId !== undefined) runIdsOfBubble.add(message.runId);
  for (const m of merged.docs) runIdsOfBubble.add(m.runId);
  // A bubble whose rows, texts or merges overflow the bounds is never recomposed: an
  // unknown run in its set keeps it uncovered.
  if (!read.complete || !texts.complete || !merged.complete) {
    runIdsOfBubble.add("\u0000unbounded");
  }
  for (const r of assigned) if (r.runId !== undefined) runIdsOfBubble.add(r.runId);
  for (const r of runIdsOfBubble) runsToKnow.add(r);
  bubbles.set(id, {
    messageId: id,
    exists: true,
    status: message.status,
    text: message.text,
    runIds: [...runIdsOfBubble],
    rows: assigned.map((d) => toPlanRow(d, texts.texts.get(String(d._id)))),
    ...(foreignRows ? { uncovered: true } : {}),
  });
}

async function executePlan(
  ctx: MutationCtx,
  scope: ProjectionScope,
  chat: Doc<"chats">,
  plan: ProjectionPlan,
  result: Counts,
  budget: Budget,
): Promise<void> {
  const now = Date.now();
  const born = new Map<string, Id<"messages">>();
  // The identities the loads already read are reused (codex phase 4 pass 5: re-reading
  // each one cost an index query per row); a row the call never loaded is looked up.
  const assign = async (entryId: string, target: Id<"messages">): Promise<void> => {
    const key = `${scope.sessionKey}\u0000${entryId}`;
    let doc = budget.rows.get(key) ?? null;
    if (doc === null) {
      budget.queries++;
      doc = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("entryId", entryId),
        )
        .first();
      budget.bytes += docBytes(doc);
    }
    if (doc === null || doc.messageId !== undefined || doc.instanceName !== scope.instanceName) return;
    await ctx.db.patch(doc._id, { messageId: target });
    budget.rows.set(key, { ...doc, messageId: target });
    result.assigned++;
  };
  // In TRANSCRIPT ORDER, each born bubble's rows assigned before the next one looks for
  // its place: two consecutive answers are placed one after the other by `seq`, never on
  // the same anchor with a tie broken by creation order (codex phase 4 pass 1).
  for (const c of [...plan.create].sort((a, b) => a.firstSeq - b.firstSeq)) {
    const orderTime = await placeBetween(ctx, scope, c.firstSeq, budget);
    const before = orderTime.before;
    const messageId = await ctx.db.insert("messages", {
      chatId: scope.chatId,
      userId: chat.userId,
      turnSessionKey: scope.sessionKey,
      role: "assistant",
      runId: c.runId,
      ...(c.segment > 0 ? { runSegment: c.segment } : {}),
      status: c.status,
      text: c.text,
      finalizeCause: "transcript_settled",
      ...(c.inferred ? { closeInferred: true } : {}),
      boundInstance: scope.instanceName,
      ...(before?.routedInstanceName !== undefined
        ? { routedInstanceName: before.routedInstanceName }
        : {}),
      ...(before?.routedAgentId !== undefined ? { routedAgentId: before.routedAgentId } : {}),
      // Placed by the transcript (CU-17): between the bubbles of the rows around it.
      ...(orderTime.at !== undefined ? { orderTime: orderTime.at } : {}),
      updatedAt: now,
      finalizedAt: now,
    });
    born.set(c.born, messageId);
    result.created++;
    for (const a of plan.assign) {
      if ("born" in a.to && a.to.born === c.born) await assign(a.entryId, messageId);
    }
    // Born TERMINAL: what a turn's end settles beyond its bubble (a service job's
    // correlate and sweep, a summarize check) runs now, once — a late live finalize
    // finds the answer terminal and runs nothing (codex phase 4 pass 15).
    // A service job's correlate reads what a settle reads (reserved like one); a regular
    // conversation's end only reads its chat again.
    budget.queries += chat.kind !== undefined ? SETTLE_RESERVE_QUERIES : 2;
    budget.bytes += chat.kind !== undefined ? SETTLE_RESERVE_BYTES : docBytes(chat);
    const bornDoc = await ctx.db.get(messageId);
    // …except the file jobs: their media come with the LIVE run, after these rows (codex
    // phase 4 pass 16) — the live terminal, or a deferred check, settles them.
    if (bornDoc !== null) await settleTurnEnd(ctx, bornDoc, { files: false, inferred: c.inferred && c.status === "complete" });
  }
  if (plan.create.length > 0) {
    await ctx.db.patch(scope.chatId, { updatedAt: now, lastAssistantAt: now });
  }
  for (const a of plan.assign) {
    if ("messageId" in a.to) await assign(a.entryId, a.to.messageId as Id<"messages">);
  }
  for (const w of plan.rewrite) {
    const messageId = w.messageId as Id<"messages">;
    const message = await messageOf(ctx, messageId, budget);
    if (message === null) continue;
    // The bubble's OWN bridge only: in a conversation several instances serve, a read of
    // instance A never settles or rewrites what instance B's bridge streamed.
    if (message.boundInstance !== undefined && message.boundInstance !== scope.instanceName) {
      continue;
    }
    const settle = message.status === "streaming" ? w.settle : undefined;
    const settling = settle !== undefined;
    if (settle !== undefined) {
      // The recomposed text is the WHOLE bubble: a merge's parked parent reply is in it
      // already, and `finalize` must not prepend it a second time.
      if (w.text !== undefined && message.announcePrefix !== undefined) {
        await ctx.db.patch(messageId, { announcePrefix: undefined });
      }
      await finalizeMessageCore(ctx, {
        messageId,
        status: settle,
        ...(w.text !== undefined ? { text: w.text } : {}),
        finalizeCause: "transcript_settled",
        boundInstanceName: scope.instanceName,
        // A run over with nothing a reader sees leaves no bubble (CU-21), as phase 3's
        // live terminal already did.
        ...(settle === "complete" ? { dropIfEmpty: true } : {}),
      });
      result.settled++;
    }
    if (w.text !== undefined) {
      // After a settle too: `finalize`'s anti-regression keeps a longer streamed text
      // over a shorter final, and the rows are the authority here.
      // Read again only when `finalize` just wrote it (reserved by `loadBubble`); else the
      // copy this call already read IS the current one.
      const fresh = settling ? await ctx.db.get(messageId) : message;
      if (fresh !== null && fresh.text !== w.text && fresh.status !== "streaming") {
        await ctx.db.patch(messageId, { text: w.text, updatedAt: now });
      }
      result.rewritten++;
    }
  }
}

/**
 * Where a bubble born from rows goes in the thread: right after the bubble of the nearest
 * EARLIER row of the session that has one, and before the bubble of the nearest LATER row
 * that has one. The later neighbour matters when the bubble is born late — a run projected
 * after the one that followed it in the transcript (codex phase 4 pass 3): placed only
 * "after the earlier one", both would share a slot and creation order would put the late
 * one last.
 */
async function placeBetween(
  ctx: MutationCtx,
  scope: ProjectionScope,
  seq: number,
  budget: Budget,
): Promise<{ before: Doc<"messages"> | null; at?: number }> {
  const before = await neighbourBubble(ctx, scope, seq, "desc", budget);
  const after = await neighbourBubble(ctx, scope, seq, "asc", budget);
  const lo = before === null ? null : effectiveOrder(before);
  // A queued message's sentinel says nothing about where it will be sent.
  const hiRaw = after === null ? null : effectiveOrder(after);
  const hi = hiRaw !== null && hiRaw < QUEUED_ORDER_SENTINEL ? hiRaw : null;
  if (lo !== null && hi !== null && hi > lo) return { before, at: Math.min(lo + 1, lo + (hi - lo) / 2) };
  if (lo !== null) return { before, at: lo + 1 };
  if (hi !== null) return { before, at: hi - 1 };
  return { before };
}

/** The bubble of the nearest row of the session before (`desc`) or after (`asc`) `seq`
 *  that has one (any role). */
async function neighbourBubble(
  ctx: MutationCtx,
  scope: ProjectionScope,
  seq: number,
  direction: "asc" | "desc",
  budget: Budget,
): Promise<Doc<"messages"> | null> {
  let seen = 0;
  const range = ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_session_seq", (q) => {
      const s = q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("sessionId", scope.sessionId);
      return direction === "desc" ? s.lt("seq", seq) : s.gt("seq", seq);
    })
    .order(direction);
  budget.queries++;
  for await (const r of range) {
    if (++seen > MAX_ANCHOR_LOOKBACK || overCeiling(budget)) return null;
    budget.bytes += docBytes(r);
    if (r.messageId === undefined) continue;
    const m = await messageOf(ctx, r.messageId, budget);
    if (m !== null && m.chatId === scope.chatId) return m;
  }
  return null;
}

/** The user bubble of a send (`messages.by_chat_send_id`), read once per transaction and
 *  charged to its budget — shared by custody and assignment (codex phase 4 pass 9). */
export async function userBubbleOf(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  sendId: string,
  budget: Budget,
): Promise<Doc<"messages"> | null> {
  if (budget.userBubbles.has(sendId)) return budget.userBubbles.get(sendId)!;
  budget.queries++;
  const found = await ctx.db
    .query("messages")
    .withIndex("by_chat_send_id", (q) => q.eq("chatId", chatId).eq("sendId", sendId))
    .take(2);
  for (const m of found) budget.bytes += docBytes(m);
  const bubble = found.find((m) => m.role === "user") ?? null;
  budget.userBubbles.set(sendId, bubble);
  if (bubble !== null) budget.messages.set(String(bubble._id), bubble);
  return bubble;
}

/** USER rows of a projected session point at the user bubble of their send (I3): what a
 *  bubble born from rows is placed after. Sticky like every assignment. Every read is
 *  charged to the transaction's budget; past its soft bound the rows not reached are
 *  returned for a continuation (codex phase 4 pass 9: 100 user rows tied to big messages
 *  read past 16 MiB outside any budget). */
export async function assignUserRows(
  ctx: MutationCtx,
  scope: ProjectionScope,
  rows: ReadonlyArray<{ entryId: string; role: string; sendId?: string }>,
  budget: Budget = newBudget(),
): Promise<string[]> {
  const remaining: string[] = [];
  let done = 0;
  for (const r of rows) {
    if (r.role.toLowerCase() !== "user" || r.sendId === undefined) continue;
    if (done > 0 && overSoft(budget)) {
      remaining.push(r.entryId);
      continue;
    }
    done++;
    const bubble = await userBubbleOf(ctx, scope.chatId, r.sendId, budget);
    if (bubble === null) continue;
    const key = `${scope.sessionKey}\u0000${r.entryId}`;
    let doc = budget.rows.get(key) ?? null;
    if (doc === null) {
      budget.queries++;
      doc = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("entryId", r.entryId),
        )
        .first();
      budget.bytes += docBytes(doc);
    }
    if (doc === null || doc.messageId !== undefined) continue;
    await ctx.db.patch(doc._id, { messageId: bubble._id });
    budget.rows.set(key, { ...doc, messageId: bubble._id });
  }
  return remaining;
}
