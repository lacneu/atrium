// THE SESSION TRANSCRIPT AS THE TRUTH — the projection's store (redesign phases 1–2,
// SHADOW).
//
// `applyTranscript` records what one `chat.history` read returned: identity rows, run
// statuses, the cursor to resume from. It is IDEMPOTENT by construction (upsert by
// entry id, sticky run statuses, a cursor that only moves forward within one gateway
// session) — replaying a read, a reconnect or a bridge restart rewrites nothing — and it
// NEVER touches a message: shadow mode measures, it does not decide. The policy lives in
// lib/transcriptProjection.ts (pure, tested); this file loads and stores.

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import {
  clearCurrentPending,
  collectInputObservations,
  dispatchTimeOf,
  floorForFirstRead,
  gatewayHeldInput,
  loadProjectionReport,
  mergeRunStatus,
  MAX_ACTIVE_RUN_IDS,
  MAX_COVERAGE_GAPS,
  MAX_ROWS_PER_APPLY,
  MAX_RUN_ID_CHARS,
  MAX_TERMINALS_PER_APPLY,
  mergeInputFact,
  currentCustody,
  rowTextSignature,
  MAX_ROW_TEXT_BYTES,
  purgeRowText,
  segmentOfRow,
  steerSeqsOf,
  tombstoneHit,
  transcriptStoredText,
  ALL_SEGMENTS,
  ANY_SESSION,
  RUN_START,
  type RunTombs,
  boundaryOfOrdinal,
  type RunCuts,
  tombstonedSegments,
  insertTombstone,
  schedulePurgeIfAny,
  MAX_SENDS_READ,
  FOLLOW_UP_BYTE_BUDGET,
  docReadBytes,
  type ReadMeter,
  tombstoneSendRun,
  tombstoneSteerOf,
  steeredSegmentOf,
  FOLLOW_UP_PURGES_PER_CALL,
  FOLLOW_UP_QUERY_BUDGET,
  TOMBSTONE_MERGE_PAGE,
  deletedMergeOf,
  sameRow,
  TEXT_PURGED_SIG,
  TEXT_PURGE_BATCH,
  boundRowShown,
  sanitizeRow,
  type InputFact,
  type RunStatus,
  type TranscriptRowInput,
} from "./lib/transcriptProjection";
import { custodyOf, instanceNameOfChat, projectionModeOfChat } from "./lib/followUp";
import {
  assignUserRows,
  docBytes,
  overSoft,
  userBubbleOf,
  MAX_PROJECTED_RUNS,
  newBudget,
  projectBubbles,
  type Budget,
  type ProjectionResume,
  type ProjectionScope,
} from "./lib/bubbleProjectionStore";
import { drainNextQueued, SESSION_ACTIVE_FRESH_MS } from "./lib/outboxQueue";
import { utf8Bytes } from "./lib/bubbleProjection";

const rowValidator = v.object({
  entryId: v.string(),
  seq: v.number(),
  role: v.string(),
  runId: v.optional(v.string()),
  sendId: v.optional(v.string()),
  steerTargetRunId: v.optional(v.string()),
  mirrorOrigin: v.optional(v.string()),
  runTerminal: v.optional(v.boolean()),
  hidden: v.boolean(),
  visible: v.boolean(),
  toolCallIds: v.optional(v.array(v.string())),
  // Projection `on` (phase 4): what the row shows a reader. Kept only for an `on`
  // conversation (sanitized + bounded by lib/transcriptProjection `sanitizeRow`).
  text: v.optional(v.string()),
  yieldAck: v.optional(v.string()),
});

const terminalValidator = v.object({
  runId: v.string(),
  status: v.union(
    v.literal("completed"),
    v.literal("error"),
    v.literal("aborted"),
    v.literal("timeout"),
    v.literal("yielded"),
  ),
  emptyFinal: v.optional(v.boolean()),
  at: v.number(),
});

const pendingInputsValidator = v.object({
  total: v.number(),
  queuedCount: v.optional(v.number()),
  /** The page was the WHOLE list (no older page, every item kept): an input it does not
   *  name is in no queue now. Absent (an older bridge, a partial page) ⇒ not proven. */
  complete: v.optional(v.boolean()),
  items: v.array(
    v.object({
      runId: v.optional(v.string()),
      state: v.union(v.literal("queued"), v.literal("cancelled"), v.literal("interrupted")),
      queued: v.optional(v.boolean()),
    }),
  ),
});

const inputReceiptValidator = v.object({
  runId: v.string(),
  state: v.union(v.literal("pending"), v.literal("consumed")),
  queued: v.optional(v.boolean()),
  cancelled: v.optional(v.boolean()),
});

type RunObservation = { status: RunStatus; emptyFinal?: boolean; at?: number };

/** What one apply may carry of row TEXT (projection `on`), in UTF-8 bytes and in rows: an
 *  apply over either bound is REFUSED whole, before any write (`too_large`) — never cut,
 *  never deferred (codex phase 4 pass 6: every deferral scheme leaked a copy, a budget or a
 *  row). The bridge chunks its posts under both (providers/openclaw/transcript-shadow.ts
 *  `chunkTextRows`), so a refusal only ever means a bridge that did not: it splits and posts
 *  again, and its cursor never moves past a row whose text was not stored. The row bound
 *  keeps the stored texts a merge may read (one document each, up to MAX_TEXT_DOC_BYTES)
 *  within one transaction too. */
export const MAX_APPLY_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_APPLY_TEXT_ROWS = 40;
/** What the rest of `applyTranscript` reads besides rows, texts and projection (cursor,
 *  runs, inputs, custody, admissions), reserved in the shared budget. */
const APPLY_RESERVED_QUERIES = 400;
/** Runs one apply re-purges after new cut rows (each a tombstone probe and a step). */
const MAX_CUT_PURGES_PER_APPLY = 20;
const APPLY_RESERVED_BYTES = 1024 * 1024;
/** The worst a stored text document can weigh: a row's whole budget plus the envelope. */
const MAX_TEXT_DOC_BYTES = MAX_ROW_TEXT_BYTES + 256;
/** What the stored texts an apply must READ back to merge may weigh (each changed row
 *  whose text is known reads its document once). Checked before any write with the
 *  incoming bound: over it, the apply is refused like an oversized one. */
export const MAX_APPLY_TEXT_READ_BYTES = 6 * 1024 * 1024;

const textDocBytes = (d: { text?: string; yieldAck?: string }): number =>
  utf8Bytes(d.text ?? "") + utf8Bytes(d.yieldAck ?? "") + 128;

/** The text an apply carries: refused when over either bound (see MAX_APPLY_TEXT_BYTES). */
export function textLoadOf(rows: readonly TranscriptRowInput[]): { rows: number; bytes: number } {
  let n = 0;
  let bytes = 0;
  for (const r of rows) {
    if (r.text === undefined && r.yieldAck === undefined) continue;
    if (r.runId === undefined) continue; // never stored (see upsertRows)
    n++;
    bytes += textDocBytes(r);
  }
  return { rows: n, bytes };
}

/** One row's text to store: the identity it belongs to, and what the read carried. */
type TextWork = {
  row: {
    _id: Id<"transcriptRows">;
    entryId: string;
    seq: number;
    textSig?: string;
    runId?: string;
    messageId?: Id<"messages">;
  };
  text?: string;
  yieldAck?: string;
};

/** Is a row's run segment one whose bubble a person DELETED? — the run's tombstones
 *  (`transcriptTombstones`), and, while a deletion's tombstoning is still paginating, any
 *  merge record of the run (`runBubbles`) that points at a bubble that no longer exists
 *  (codex phase 4 pass 6). Each run read once per batch. */
function tombstoneCheck(ctx: MutationCtx, chatId: Id<"chats">, sessionKey: string, budget: Budget) {
  const cache = new Map<
    string,
    { tombs: RunTombs; mergedInto?: Id<"messages">; cuts?: RunCuts | null }
  >();
  /** The deleted bubble the row's segment belonged to — `null` when it is not tombstoned. */
  return async (runId: string | undefined, seq: number): Promise<{ to?: Id<"messages"> } | null> => {
    if (runId === undefined) return null;
    let entry = cache.get(runId);
    if (entry === undefined) {
      budget.queries += 2;
      entry = { tombs: await tombstonedSegments(ctx, chatId, sessionKey, runId) };
      const deleted = await deletedMergeOf(ctx, chatId, runId);
      if (deleted !== null) entry.mergedInto = deleted;
      cache.set(runId, entry);
    }
    // Merged into a deleted bubble: the whole run (a delivery run has one segment).
    if (entry.mergedInto !== undefined) return { to: entry.mergedInto };
    if (!entry.tombs.any) return null;
    // Stable boundaries need no cut; only an ordinal not yet resolved is read against the
    // current cuts (codex phase 4 pass 27).
    if (entry.cuts === undefined) {
      if (entry.tombs.size > 0) {
        budget.queries++;
        entry.cuts = await steerSeqsOf(ctx, chatId, sessionKey, runId);
      } else {
        entry.cuts = null;
      }
    }
    return tombstoneHit(entry.tombs, entry.cuts, seq);
  };
}

/**
 * Store row texts — EXACTLY ONE document per row: the row's document is looked up by its
 * id (`by_row`) on every write and upserted, so no path can add a second one (codex phase 4
 * pass 6). A purged row never takes a text again; a row of a deleted bubble's segment is
 * purged instead of stored. The caller has bounded the apply (MAX_APPLY_TEXT_*): this never
 * defers, and every read and write is charged to the transaction's budget.
 */
async function writeRowTexts(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string },
  work: readonly TextWork[],
  now: number,
  budget: Budget,
): Promise<TextWork[]> {
  const stored: TextWork[] = [];
  const tombstoned = tombstoneCheck(ctx, a.chatId, a.sessionKey, budget);
  /** Rows met in a purged or tombstoned state that may still hold a stored copy. */
  const copies: Array<Id<"transcriptRows">> = [];
  const deletedBubble = new Map<string, boolean>();
  for (const w of work) {
    // A row ASSIGNED to a bubble that no longer exists belongs to a deleted answer — even
    // before the deletion's follow-up has written every tombstone (codex phase 4 pass 9).
    let gone = false;
    if (w.row.messageId !== undefined) {
      const key = String(w.row.messageId);
      if (!deletedBubble.has(key)) deletedBubble.set(key, (await ctx.db.get(w.row.messageId)) === null);
      gone = deletedBubble.get(key)!;
    }
    const tomb = gone ? {} : w.row.textSig === TEXT_PURGED_SIG ? {} : await tombstoned(w.row.runId, w.row.seq);
    if (tomb !== null) {
      // Its text is never stored. A copy stored BEFORE (a purged mark set without its
      // deletion, a segment the cut row revealed only now — codex phase 4 pass 9) is
      // deleted too: in its own bounded step, never read here.
      if (w.row.textSig !== undefined) copies.push(w.row._id);
      if (w.row.textSig !== TEXT_PURGED_SIG || (w.row.messageId === undefined && tomb.to !== undefined)) {
        await ctx.db.patch(w.row._id, {
          textSig: TEXT_PURGED_SIG,
          ...(w.row.messageId === undefined && tomb.to !== undefined ? { messageId: tomb.to } : {}),
        });
      }
      continue;
    }
    if (w.row.textSig === rowTextSignature(w.text, w.yieldAck)) continue;
    budget.queries++;
    const doc = await ctx.db
      .query("transcriptRowTexts")
      .withIndex("by_row", (q) => q.eq("rowId", w.row._id))
      .first();
    if (doc !== null) budget.bytes += textDocBytes(doc);
    // A partial read (text without its acknowledgment, or the reverse) keeps the half it
    // does not carry.
    // …and the MERGED result is bounded again (codex phase 4 pass 8: a 600 KiB
    // acknowledgment kept beside a new 600 KiB text made a 1.2 MiB document): the text
    // first, the acknowledgment only while it still fits.
    const merged = boundRowShown(w.text ?? doc?.text, w.yieldAck ?? doc?.yieldAck);
    const sig = rowTextSignature(merged.text, merged.yieldAck);
    if (sig === w.row.textSig && doc !== null) continue;
    if (doc === null) {
      await ctx.db.insert("transcriptRowTexts", { chatId: a.chatId, rowId: w.row._id, ...merged, updatedAt: now });
    } else {
      await ctx.db.patch(doc._id, { text: merged.text, yieldAck: merged.yieldAck, updatedAt: now });
    }
    await ctx.db.patch(w.row._id, { textSig: sig });
    w.row.textSig = sig;
    stored.push(w);
  }
  if (copies.length > 0) await purgeRowTextsLater(ctx, a.chatId, copies);
  return stored;
}

/** Delete the stored copies of these rows' texts in their own bounded steps (ids only). */
export async function purgeRowTextsLater(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  rowIds: ReadonlyArray<Id<"transcriptRows">>,
): Promise<void> {
  if (rowIds.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeRowTextsById, {
    chatId,
    rowIds: [...new Set(rowIds)],
  });
}

/**
 * Upsert identity rows by (chat, session key, entry id), and — projection `on` — what each
 * row shows into `transcriptRowTexts`. An identity read never loads a text (codex phase 4
 * pass 3): the text is compared through its signature. Every read is charged to the
 * transaction's shared budget (codex phase 4 pass 6).
 */
async function upsertRows(
  ctx: MutationCtx,
  a: {
    chatId: Id<"chats">;
    instanceName: string;
    sessionKey: string;
    sessionId: string;
    now: number;
    /** The conversation ever stored row text (`chats.transcriptSeenAt`): only then can a
     *  new cut row reveal a stored copy to purge. */
    textsStored: boolean;
  },
  rows: readonly TranscriptRowInput[],
  budget: Budget,
): Promise<{
  inserted: number;
  updated: number;
  maxSeq: number;
  seqByRun: Map<string, { first: number; last: number }>;
  /** Runs whose rows got a text stored now (they may be projectable now). */
  textedRuns: string[];
}> {
  let inserted = 0;
  let updated = 0;
  let maxSeq = 0;
  const seqByRun = new Map<string, { first: number; last: number }>();
  const textWork: TextWork[] = [];
  /** Runs a NEW cut row (a steered user row) may have just redrawn. */
  const newCuts = new Set<string>();
  /** The new cut rows themselves: one whose send was DELETED takes its segment with it. */
  const newCutRows: LateCut[] = [];
  for (const r of rows) {
    const { text, yieldAck, ...identity } = r;
    const next: TranscriptRowInput & { sessionId: string } = { ...identity, sessionId: a.sessionId };
    budget.queries++;
    const stored = await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_session_entry", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("entryId", r.entryId),
      )
      .first();
    budget.bytes += docBytes(stored);
    // Another instance's row (codex pass 5/6): never rewritten from here, and it feeds
    // NOTHING this apply aggregates — not the session's last seq, not a run's span.
    if (stored !== null && stored.instanceName !== a.instanceName) continue;
    if (r.seq > maxSeq) maxSeq = r.seq;
    if (r.runId !== undefined && r.role !== "user") {
      const span = seqByRun.get(r.runId);
      seqByRun.set(r.runId, {
        first: Math.min(span?.first ?? r.seq, r.seq),
        last: Math.max(span?.last ?? r.seq, r.seq),
      });
    }
    if (
      r.steerTargetRunId !== undefined &&
      r.role.toLowerCase() === "user" &&
      (stored === null || stored.steerTargetRunId !== r.steerTargetRunId)
    ) {
      newCuts.add(r.steerTargetRunId);
      const own = r.sendId ?? r.runId;
      if (own !== undefined) newCutRows.push({ sendId: own, target: r.steerTargetRunId, seq: r.seq });
    }
    let rowId: Id<"transcriptRows">;
    if (stored === null) {
      rowId = await ctx.db.insert("transcriptRows", {
        chatId: a.chatId,
        instanceName: a.instanceName,
        sessionKey: a.sessionKey,
        ...next,
        updatedAt: a.now,
      });
      inserted++;
    } else {
      rowId = stored._id;
      if (!sameRow(stored, next)) {
        await ctx.db.patch(stored._id, {
          sessionId: next.sessionId,
          seq: next.seq,
          role: next.role,
          runId: next.runId,
          sendId: next.sendId,
          steerTargetRunId: next.steerTargetRunId,
          mirrorOrigin: next.mirrorOrigin,
          runTerminal: next.runTerminal,
          hidden: next.hidden,
          visible: next.visible,
          toolCallIds: next.toolCallIds,
          updatedAt: a.now,
        });
        updated++;
      }
    }
    // A text once read is a fact about the row: a later read that carries none (an older
    // bridge, a switch flipped back to shadow) never erases it — nor reads it.
    if (text === undefined && yieldAck === undefined) continue;
    // Only a row ATTRIBUTED to a run keeps its text: every purge reaches a text through
    // its run or its bubble, and a row of no run has neither — its text could never be
    // purged with what it belongs to (codex phase 4 pass 7: a producerless mirror row
    // outlived every message of its chat). Its identity is stored; its text is not.
    if (r.runId === undefined) continue;
    textWork.push({
      row: {
        _id: rowId,
        entryId: r.entryId,
        seq: r.seq,
        ...(stored?.textSig !== undefined ? { textSig: stored.textSig } : {}),
        ...(r.runId !== undefined ? { runId: r.runId } : {}),
        ...(stored?.messageId !== undefined ? { messageId: stored.messageId } : {}),
      },
      ...(text !== undefined ? { text } : {}),
      ...(yieldAck !== undefined ? { yieldAck } : {}),
    });
  }
  // A cut row read AFTER its user message was deleted (codex phase 4 pass 13): the segment
  // it starts in the run it steered is that message's answer — tombstoned now, before any
  // text below is stored and before the purge probe that follows. Bounded; the rest is
  // handed on.
  if (a.textsStored && newCutRows.length > 0) {
    budget.queries += 2 * Math.min(newCutRows.length, MAX_CUT_PURGES_PER_APPLY);
    await tombstoneLateCutRows(ctx, a.chatId, a.sessionKey, newCutRows.slice(0, MAX_CUT_PURGES_PER_APPLY));
    if (newCutRows.length > MAX_CUT_PURGES_PER_APPLY) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.tombstoneLateCuts, {
        chatId: a.chatId,
        sessionKey: a.sessionKey,
        cuts: newCutRows.slice(MAX_CUT_PURGES_PER_APPLY),
      });
    }
  }
  // A new cut can move rows stored earlier into a tombstoned segment: their copies go, in
  // a bounded step per run (only runs that HAVE a tombstone — one probe each, bounded).
  const cutRuns = a.textsStored ? [...newCuts] : [];
  // Past the bound, the rest is HANDED ON, never dropped (codex phase 4 pass 10: the 21st
  // run's identities were already stored, so no replay would ever name it a new cut).
  if (cutRuns.length > MAX_CUT_PURGES_PER_APPLY) {
    await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeCutRuns, {
      chatId: a.chatId,
      sessionKey: a.sessionKey,
      runIds: cutRuns.slice(MAX_CUT_PURGES_PER_APPLY),
    });
  }
  for (const runId of cutRuns.slice(0, MAX_CUT_PURGES_PER_APPLY)) {
    budget.queries++;
    if (!(await tombstonedSegments(ctx, a.chatId, a.sessionKey, runId)).any) continue;
    await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeTombstonedRun, {
      chatId: a.chatId,
      sessionKey: a.sessionKey,
      runId,
      cursor: null,
    });
  }
  const stored = await writeRowTexts(ctx, a, textWork, a.now, budget);
  const textedRuns = [...new Set(stored.flatMap((w) => (w.row.runId === undefined ? [] : [w.row.runId])))];
  return { inserted, updated, maxSeq, seqByRun, textedRuns };
}

/** A new cut row: its own send, the run it was steered into, its `seq`. */
type LateCut = { sendId: string; target: string; seq: number };

/** Cut rows whose own send carries a deleted user message's tombstone (`ANY_SESSION`,
 *  every segment): the segment each starts in its target run is tombstoned for that
 *  message. Returns the target runs that got a tombstone. */
async function tombstoneLateCutRows(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  sessionKey: string,
  cuts: readonly LateCut[],
): Promise<string[]> {
  const targets: string[] = [];
  for (const c of cuts) {
    const own = await tombstonedSegments(ctx, chatId, sessionKey, c.sendId);
    if (!own.has(ALL_SEGMENTS)) continue;
    const messageId = own.get(ALL_SEGMENTS);
    // The STABLE boundary: after this cut row's own `seq` (codex phase 4 pass 27).
    await ctx.db.insert("transcriptTombstones", {
      chatId,
      sessionKey,
      runId: c.target,
      segment: c.seq,
      fromSeq: c.seq,
      ...(messageId !== undefined ? { messageId } : {}),
      createdAt: Date.now(),
    });
    targets.push(c.target);
  }
  return targets;
}

/** The new cut rows one apply did not reach (`upsertRows`), MAX_CUT_PURGES_PER_APPLY per
 *  step: tombstoned as above, then their target runs purged. */
export const tombstoneLateCuts = internalMutation({
  args: {
    chatId: v.id("chats"),
    sessionKey: v.string(),
    cuts: v.array(v.object({ sendId: v.string(), target: v.string(), seq: v.number() })),
  },
  handler: async (ctx, { chatId, sessionKey, cuts }) => {
    const targets = await tombstoneLateCutRows(ctx, chatId, sessionKey, cuts.slice(0, MAX_CUT_PURGES_PER_APPLY));
    for (const runId of new Set(targets)) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeTombstonedRun, {
        chatId,
        sessionKey,
        runId,
        cursor: null,
      });
    }
    if (cuts.length > MAX_CUT_PURGES_PER_APPLY) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.tombstoneLateCuts, {
        chatId,
        sessionKey,
        cuts: cuts.slice(MAX_CUT_PURGES_PER_APPLY),
      });
    }
  },
});

/** Upsert run statuses: sticky terminals (`mergeRunStatus`), seq spans widened. */
async function upsertRuns(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string; now: number },
  observations: Map<string, RunObservation[]>,
  seqByRun: Map<string, { first: number; last: number }>,
): Promise<void> {
  for (const [runId, list] of observations) {
    const stored = await ctx.db
      .query("transcriptRuns")
      .withIndex("by_chat_session_run", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("runId", runId),
      )
      .first();
    let status: RunStatus | undefined = stored?.status;
    let terminalAt = stored?.terminalAt;
    let emptyFinal = stored?.emptyFinal;
    for (const o of list) {
      const before = status;
      status = mergeRunStatus(status, o.status);
      if (before !== status && o.at !== undefined) terminalAt = o.at;
      if (o.emptyFinal === true && before !== status) emptyFinal = true;
    }
    const span = seqByRun.get(runId);
    const firstSeq =
      span === undefined ? stored?.firstSeq : Math.min(stored?.firstSeq ?? span.first, span.first);
    const lastRunSeq =
      span === undefined ? stored?.lastSeq : Math.max(stored?.lastSeq ?? span.last, span.last);
    if (stored === null) {
      await ctx.db.insert("transcriptRuns", {
        chatId: a.chatId,
        sessionKey: a.sessionKey,
        runId,
        status: status as RunStatus,
        ...(emptyFinal === true ? { emptyFinal: true } : {}),
        ...(terminalAt === undefined ? {} : { terminalAt }),
        ...(firstSeq === undefined ? {} : { firstSeq }),
        ...(lastRunSeq === undefined ? {} : { lastSeq: lastRunSeq }),
        updatedAt: a.now,
      });
    } else if (
      stored.status !== status ||
      stored.terminalAt !== terminalAt ||
      stored.emptyFinal !== emptyFinal ||
      stored.firstSeq !== firstSeq ||
      stored.lastSeq !== lastRunSeq
    ) {
      await ctx.db.patch(stored._id, {
        status: status as RunStatus,
        emptyFinal,
        terminalAt,
        firstSeq,
        lastSeq: lastRunSeq,
        updatedAt: a.now,
      });
    }
  }
}

/** Most runs one idle read marks over (a session rarely holds more unsettled runs). */
const MAX_SETTLE_PER_READ = 50;

/**
 * PROJECTION `on` (phase 4): mark runs OVER — the run table's sticky terminal. A run is
 * over when a terminal frame was observed for it, or when a fresh read says so: the
 * session is idle (`hasActiveRun:false` — the gateway keeps a session active "until the
 * terminal row is queryable", src/gateway/server-methods/chat-history-handler.ts:364-373
 * at v2026.9.8, and the Control UI retires its run on a fresh idle read,
 * ui/src/pages/chat/run-lifecycle.ts:637-690), or the complete `activeRunIds` list
 * (chat-history-handler.ts:384-387) does not name a run whose rows this read returned.
 * Returns the runs newly marked.
 */
async function settleRuns(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string; now: number },
  explicit: readonly string[],
  sessionIdle: boolean,
  /** The transcript the idle read SAW (its last `seq`): only a run the read could have
   *  seen is over by its idle fact. A run whose first row lies beyond started after the
   *  read was issued — its live rows came in while the reply was on its way — and the
   *  read says nothing about it (codex phase 4 pass 18). Runs known without rows (named
   *  by an earlier read's active list) are dated by that read and stay covered. */
  idleCoverSeq?: number,
): Promise<{ runs: string[]; more: boolean }> {
  const out: string[] = [];
  let more = false;
  const mark = async (doc: Doc<"transcriptRuns">) => {
    if (doc.settledAt !== undefined) return;
    await ctx.db.patch(doc._id, { settledAt: a.now });
    out.push(doc.runId);
  };
  for (const runId of new Set(explicit)) {
    const doc = await ctx.db
      .query("transcriptRuns")
      .withIndex("by_chat_session_run", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("runId", runId),
      )
      .first();
    if (doc !== null) await mark(doc);
  }
  if (sessionIdle) {
    const open = await ctx.db
      .query("transcriptRuns")
      .withIndex("by_chat_session_settled", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("settledAt", undefined),
      )
      .take(MAX_SETTLE_PER_READ + 1);
    let marked = 0;
    for (const doc of open.slice(0, MAX_SETTLE_PER_READ)) {
      if (idleCoverSeq !== undefined && doc.firstSeq !== undefined && doc.firstSeq > idleCoverSeq) continue;
      await mark(doc);
      marked++;
    }
    // More to mark only while this page marked something (a page of runs the read could
    // not see would otherwise be read again and again).
    more = open.length > MAX_SETTLE_PER_READ && marked > 0;
  }
  return { runs: out, more };
}

/**
 * Is a SCHEDULED projection step still this instance's to run (phase 4)? Re-validated
 * atomically when the step runs, never trusted from when it was scheduled: the chat may
 * have been rebound to another instance, or switched back to `shadow`/`off` (a rollback
 * must stop every pending write of the projection) — codex phase 4 pass 2.
 */
async function projectionTaskInScope(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  instanceName: string,
): Promise<boolean> {
  const chat = await ctx.db.get(chatId);
  if (chat === null) return false;
  if ((await projectionModeOfChat(ctx, chat)) !== "on") return false;
  // The instance the conversation's turns go to NOW: a chat rebound to another instance
  // (or routed elsewhere turn by turn) is no longer this step's to write.
  if ((await instanceNameOfChat(ctx, chat)) !== instanceName) return false;
  return await chatAllowsInstance(ctx, chatId, instanceName);
}

/** The cursor a scheduled step may still act for: the instance's, of the same gateway
 *  session — else a newer truth replaced the one the step was scheduled under. */
async function cursorFor(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string; sessionId: string; instanceName: string },
): Promise<Doc<"transcriptCursors"> | null> {
  const cursor = await ctx.db
    .query("transcriptCursors")
    .withIndex("by_chat_session", (q) => q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey))
    .first();
  if (cursor === null || cursor.instanceName !== a.instanceName) return null;
  if (cursor.sessionId !== "" && cursor.sessionId !== a.sessionId) return null;
  return cursor;
}

/** The ONE scheduled re-check of a queue held by a projected gateway fact (phase 4,
 *  lib/outboxQueue `armProjectedHoldRecheck`): it releases its slot, then drains — which
 *  dispatches if the hold has ended, and otherwise re-arms one re-check at the hold's
 *  CURRENT end.
 *
 *  Unlike the projection's continuations it is NOT scoped to the mode and binding it was
 *  armed under, on purpose: what it does is the ordinary drain under the chat's CURRENT
 *  rules. After a rollback to `shadow`/`off` (or a rebind) the projected hold no longer
 *  counts (`chatHasActivityBlockers` asks it only on `on`), so the drain applies the legacy
 *  busy rules — it dispatches a queue the hold left behind when the chat is legacy-idle, and
 *  leaves it to the legacy turn-end drains when a turn streams. It never re-arms off `on`
 *  (`armProjectedHoldRecheck` refuses). Stopping instead would strand that queue: nothing
 *  in the legacy path would drain it until the next turn ends. */
export const projectedHoldRecheck = internalMutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    if (chat.projectedHoldRecheckId !== undefined || chat.projectedHoldRecheckAt !== undefined) {
      await ctx.db.patch(chatId, { projectedHoldRecheckId: undefined, projectedHoldRecheckAt: undefined });
    }
    await drainNextQueued(ctx, chatId);
  },
});

/** The continuation of an idle read's run marking (phase 4): only while that read is still
 *  the session's newest (a newer read is a newer truth, and continues its own scan). */
export const continueSettlement = internalMutation({
  args: {
    chatId: v.id("chats"),
    sessionKey: v.string(),
    sessionId: v.string(),
    instanceName: v.string(),
    /** The idle read this marking belongs to (its `readAt`). */
    readAt: v.number(),
    /** The transcript that read saw (`settleRuns` `idleCoverSeq`). */
    coverSeq: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!(await projectionTaskInScope(ctx, args.chatId, args.instanceName))) return { settled: 0 };
    const cursor = await cursorFor(ctx, args);
    if (cursor === null || cursor.lastReadAt !== args.readAt || cursor.hasActiveRun !== false) {
      return { settled: 0 };
    }
    const res = await settleRuns(
      ctx,
      { chatId: args.chatId, sessionKey: args.sessionKey, now: Date.now() },
      [],
      true,
      args.coverSeq,
    );
    await projectAll(
      ctx,
      {
        chatId: args.chatId,
        sessionKey: args.sessionKey,
        sessionId: args.sessionId,
        instanceName: args.instanceName,
        floorSeq: cursor.floorSeq,
        gaps: cursor.gaps ?? [],
      },
      res.runs,
    );
    if (res.more) await ctx.scheduler.runAfter(0, internal.transcriptProjection.continueSettlement, args);
    return { settled: res.runs.length };
  },
});

/** A queue-mode string from the wire, kept only when it is one of the gateway's modes
 *  (logs-chat.ts `QUEUE_MODES`) — never free text on a stored row. */
function boundedMode(v: string | undefined): "steer" | "followup" | "collect" | "interrupt" | undefined {
  return v === "steer" || v === "followup" || v === "collect" || v === "interrupt" ? v : undefined;
}

/** Most outbox rows read for one send id (the id is per-session; a few at most). */
const MAX_OUTBOX_PER_SEND = 8;

/**
 * Was the input `sendId` of this conversation sent to `instanceName`? Its durable owner
 * is its outbox row: the instance the last gate let it leave for (`sentToInstance`), else
 * the one it was routed to, else — a conversation bound to one instance — the binding.
 * No outbox row of this chat for that id ⇒ not provably this instance's: false.
 */
async function inputSentTo(
  ctx: MutationCtx,
  chat: Doc<"chats">,
  sendId: string,
  instanceName: string,
  budget?: Budget,
): Promise<boolean> {
  const rows = await ctx.db
    .query("outbox")
    .withIndex("by_send_id", (q) => q.eq("sendId", sendId))
    .take(MAX_OUTBOX_PER_SEND);
  if (budget !== undefined) {
    budget.queries++;
    for (const r of rows) budget.bytes += docBytes(r);
  }
  const own = rows.filter((r) => r.chatId === chat._id);
  if (own.length === 0) return false;
  return own.every((r) => {
    const owner =
      r.sentToInstance ??
      r.routedAgent?.instanceName ??
      (chat.perTurnRouting === true ? undefined : chat.instanceName);
    return owner === instanceName;
  });
}

/** Most user bubbles one apply updates (a read names ≤ 50 inputs and ≤ 200 rows). */
const MAX_CUSTODY_UPDATES = 100;

/**
 * THE USER BUBBLE'S CUSTODY (projection `on`, phase 3, design §3.2): the gateway's own
 * facts about an input — its `<sendId>:user` row (persisted, or steered into a running
 * turn), its pending-input state, the 9.7+ "queued" flags — projected onto the bubble
 * of the send. Display only. Never on `off`/`shadow`: those keep measuring.
 */
async function projectCustody(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string; instanceName: string },
  rows: ReadonlyArray<Pick<TranscriptRowInput, "role" | "sendId" | "steerTargetRunId">>,
  inputIds: readonly string[],
  budget: Budget = newBudget(),
  /** The chat and its switch, as the caller already resolved them (applyTranscript): never
   *  read or resolved twice — a shadow read must cost what it cost (codex phase 4 pass 11). */
  resolved?: { chat: Doc<"chats"> | null; projectionOn: boolean },
): Promise<string[]> {
  const chat = resolved !== undefined ? resolved.chat : await ctx.db.get(a.chatId);
  const on = resolved !== undefined ? resolved.projectionOn : (await projectionModeOfChat(ctx, chat)) === "on";
  if (!on) return [];
  if (chat === null) return [];
  const userRows = new Map<string, Pick<TranscriptRowInput, "steerTargetRunId">>();
  for (const r of rows) {
    if (r.role.toLowerCase() === "user" && r.sendId !== undefined) userRows.set(r.sendId, r);
  }
  const ids = [...new Set([...userRows.keys(), ...inputIds])].slice(0, MAX_CUSTODY_UPDATES);
  // Every read charged to the transaction's budget, the user bubbles shared with the
  // assignment; past the soft bound the sends not reached are handed back (codex phase 4
  // pass 9).
  const remaining: string[] = [];
  let done = 0;
  for (const sendId of ids) {
    if (sendId.length === 0 || sendId.length > MAX_RUN_ID_CHARS) continue;
    if (done > 0 && overSoft(budget)) {
      remaining.push(sendId);
      continue;
    }
    done++;
    const message = await userBubbleOf(ctx, a.chatId, sendId, budget);
    if (message === null) continue;
    // OWNERSHIP, atomic with the write (codex pass 5): in a conversation that several
    // instances serve, the ingest barrier admits each of their bridges — but an input
    // belongs to the instance it was SENT to. Only that instance's bridge moves its
    // custody; another one naming the same send id changes nothing.
    if (!(await inputSentTo(ctx, chat, sendId, a.instanceName, budget))) continue;
    budget.queries++;
    const fact = await ctx.db
      .query("transcriptInputs")
      .withIndex("by_chat_session_send", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("sendId", sendId),
      )
      .first();
    const known = userRows.get(sendId);
    let next = custodyOf({
      acked: message.custody !== undefined,
      row:
        known !== undefined
          ? { ...(known.steerTargetRunId !== undefined ? { steerTargetRunId: known.steerTargetRunId } : {}) }
          : null,
      ...(fact?.pendingState !== undefined ? { pendingState: fact.pendingState } : {}),
      queuedAtGateway:
        fact !== null &&
        currentCustody({
          receipt: fact.receipt,
          receiptQueued: fact.receiptQueued,
          receiptCancelled: fact.receiptCancelled,
          pendingState: fact.pendingState,
          pendingQueued: fact.pendingQueued,
          absentAt: fact.absentAt,
        }) === "queued",
      ...(fact?.receiptCancelled === true ? { receiptCancelled: true } : {}),
    });
    // A row read earlier stays the fact: a later read that does not carry it again (a
    // delta) proves nothing new, unless the gateway now says the input was stopped.
    if (
      known === undefined &&
      (message.custody === "persisted" || message.custody === "steered") &&
      next !== "cancelled" &&
      next !== "interrupted"
    ) {
      next = message.custody;
    }
    if (next !== undefined && next !== message.custody) {
      await ctx.db.patch(message._id, { custody: next });
    }
  }
  return remaining;
}

/** Record what a read says about the sends it asked about (phase 2 input guard). */
async function upsertInputs(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string; at: number; now: number },
  args: Parameters<typeof collectInputObservations>[0],
): Promise<{ written: number; cleanupPending: boolean }> {
  let written = 0;
  for (const o of collectInputObservations(args).values()) {
    const stored = await ctx.db
      .query("transcriptInputs")
      .withIndex("by_chat_session_send", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("sendId", o.sendId),
      )
      .first();
    const prev: InputFact | null =
      stored === null
        ? null
        : {
            receipt: stored.receipt,
            receiptQueued: stored.receiptQueued,
            receiptCancelled: stored.receiptCancelled,
            pendingState: stored.pendingState,
            pendingQueued: stored.pendingQueued,
            askedAt: stored.askedAt,
            absentAt: stored.absentAt,
            heldAt: stored.heldAt,
            receiptUnreadable: stored.receiptUnreadable,
          };
    const next = mergeInputFact(prev, o, a.at);
    const same =
      prev !== null &&
      (Object.keys({ ...prev, ...next }) as Array<keyof InputFact>).every((k) => prev[k] === next[k]);
    // What this read CONFIRMED (a receipt or a pending item named it): its freshness is
    // this read's, even when nothing else changed — a cleanup started before it must see
    // the entry as newer (`clearUnlistedPending` spares what was written since it began).
    const confirmed = o.receipt !== undefined || o.pending !== undefined;
    if (same) {
      if (confirmed && stored !== null) {
        await ctx.db.patch(stored._id, { confirmedAt: a.at, updatedAt: a.now });
        written++;
      }
      continue;
    }
    // Absent fields are left out of an insert and cleared by a patch.
    const defined = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ) as InputFact;
    if (stored === null) {
      await ctx.db.insert("transcriptInputs", {
        chatId: a.chatId,
        sessionKey: a.sessionKey,
        sendId: o.sendId,
        ...defined,
        ...(confirmed ? { confirmedAt: a.at } : {}),
        updatedAt: a.now,
      });
    } else {
      await ctx.db.patch(stored._id, {
        ...next,
        ...(confirmed ? { confirmedAt: a.at } : {}),
        updatedAt: a.now,
      });
    }
    written++;
  }
  // A COMPLETE pending-input list is authoritative about the current queue: an input of
  // this session it no longer names holds no pending state now. Bounded per mutation;
  // what one batch cannot reach continues in a scheduled one (`continuePendingCleanup`).
  let cleanupPending = false;
  if (args.pendingInputs?.complete === true) {
    const listed = args.pendingInputs.items
      .map((i) => i.runId)
      .filter((id): id is string => typeof id === "string");
    const res = await clearUnlistedPending(ctx, {
      chatId: a.chatId,
      sessionKey: a.sessionKey,
      listed,
      at: a.at,
      startedAt: a.now,
      now: a.now,
    });
    written += res.cleared;
    if (res.more) {
      cleanupPending = true;
      // The cleanup's GENERATION is this read: a continuation stands down as soon as a
      // newer read of the session has advanced the cursor (that read is the newer truth,
      // and starts its own cleanup when its list is complete).
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.continuePendingCleanup, {
        chatId: a.chatId,
        sessionKey: a.sessionKey,
        listed,
        at: a.at,
        startedAt: a.now,
        epoch: a.at,
      });
    }
  }
  return { written, cleanupPending };
}

/**
 * One bounded batch of the complete-list cleanup: every doc of the session that still
 * holds a CURRENT custody flag — a pending item's state, or a receipt-only queued flag —
 * and that the list did not name. Only docs not written since the cleanup started are
 * touched: a newer read is a newer truth. `more` ⇔ a page came back full AND this batch
 * cleared something (a page of only skipped docs cannot progress, and stops).
 */
async function clearUnlistedPending(
  ctx: MutationCtx,
  a: {
    chatId: Id<"chats">;
    sessionKey: string;
    listed: readonly string[];
    at: number;
    startedAt: number;
    now: number;
  },
): Promise<{ cleared: number; more: boolean }> {
  const listed = new Set(a.listed);
  const holders = new Map<string, Doc<"transcriptInputs">>();
  let full = false;
  for (const state of ["queued", "cancelled", "interrupted"] as const) {
    const page = await ctx.db
      .query("transcriptInputs")
      .withIndex("by_chat_session_pending", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("pendingState", state),
      )
      .take(MAX_PENDING_CLEAR_PER_STATE);
    if (page.length === MAX_PENDING_CLEAR_PER_STATE) full = true;
    for (const doc of page) holders.set(doc._id, doc);
  }
  const receiptPage = await ctx.db
    .query("transcriptInputs")
    .withIndex("by_chat_session_receipt_queued", (q) =>
      q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("receiptQueued", true),
    )
    .take(MAX_PENDING_CLEAR_PER_STATE);
  if (receiptPage.length === MAX_PENDING_CLEAR_PER_STATE) full = true;
  for (const doc of receiptPage) holders.set(doc._id, doc);
  let cleared = 0;
  for (const doc of holders.values()) {
    if (listed.has(doc.sendId) || doc.updatedAt > a.startedAt) continue;
    const next = clearCurrentPending(
      {
        pendingState: doc.pendingState,
        pendingQueued: doc.pendingQueued,
        receiptQueued: doc.receiptQueued,
        heldAt: doc.heldAt,
      },
      a.at,
    );
    await ctx.db.patch(doc._id, {
      pendingState: next.pendingState,
      pendingQueued: next.pendingQueued,
      receiptQueued: next.receiptQueued,
      // The cleanup is not a newer read: the doc keeps its own time, so a later batch of
      // the SAME cleanup still recognises it (and a newer read's write is still newer).
      updatedAt: doc.updatedAt,
    });
    cleared++;
  }
  return { cleared, more: full && cleared > 0 };
}

/** The continuation of a complete-list cleanup a single mutation could not finish. Clears
 *  the cursor's in-progress flag (which qualifies the report) once nothing is left. */
export const continuePendingCleanup = internalMutation({
  args: {
    chatId: v.id("chats"),
    sessionKey: v.string(),
    listed: v.array(v.string()),
    at: v.number(),
    startedAt: v.number(),
    /** The read that started this cleanup (its `readAt`). Absent ⇒ never stale. */
    epoch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cursorNow = await ctx.db
      .query("transcriptCursors")
      .withIndex("by_chat_session", (q) =>
        q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey),
      )
      .first();
    if (
      args.epoch !== undefined &&
      cursorNow !== null &&
      (cursorNow.lastReadAt ?? Number.NEGATIVE_INFINITY) > args.epoch
    ) {
      // A newer read owns the session's custody now. The in-progress flag is left to it:
      // a complete list resets it with its own cleanup; anything else keeps the report
      // qualified until one does.
      return { cleared: 0, done: false, aborted: true };
    }
    const res = await clearUnlistedPending(ctx, {
      chatId: args.chatId,
      sessionKey: args.sessionKey,
      listed: args.listed,
      at: args.at,
      startedAt: args.startedAt,
      now: Date.now(),
    });
    if (res.more) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.continuePendingCleanup, args);
      return { cleared: res.cleared, done: false, aborted: false };
    }
    const cursor = await ctx.db
      .query("transcriptCursors")
      .withIndex("by_chat_session", (q) =>
        q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey),
      )
      .first();
    if (cursor !== null && cursor.pendingCleanupInProgress === true) {
      await ctx.db.patch(cursor._id, { pendingCleanupInProgress: false });
    }
    return { cleared: res.cleared, done: true, aborted: false };
  },
});

/** Inputs per pending state one read may clear (a session's queue is far smaller). */
const MAX_PENDING_CLEAR_PER_STATE = 50;

/** Foreground runs one apply answers about (a turn owns a handful). */
const MAX_FOREGROUND_RUNS = 10;

/** Of `runIds`, the ones this session's run table holds as OVER (phase 4). */
async function alreadySettled(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string },
  runIds: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const runId of new Set(runIds.slice(0, MAX_FOREGROUND_RUNS))) {
    if (runId.length === 0 || runId.length > MAX_RUN_ID_CHARS) continue;
    const doc = await ctx.db
      .query("transcriptRuns")
      .withIndex("by_chat_session_run", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("runId", runId),
      )
      .first();
    if (doc?.settledAt !== undefined) out.push(runId);
  }
  return out;
}

/** Admitted sends one read may release (a chat holds one or two at a time). */
const MAX_ADMITTED_RELEASE = 20;

/**
 * Release the RUN-ADMITTED markers (lib/outboxQueue `projectedGatewayHoldUntil`) whose run
 * the transcript shows over (phase 4): the send's run settled, or the session is idle and
 * the send's own `<sendId>:user` row is persisted (the gateway keeps a session active until
 * its terminal row is queryable — an idle read issued before the run registered proves
 * nothing, which is why the user row is required). Returns how many were released.
 */
async function releaseAdmittedRuns(
  ctx: MutationCtx,
  scope: { chatId: Id<"chats">; sessionKey: string; instanceName: string },
  over: ReadonlySet<string>,
  sessionIdle: boolean,
  /** The transcript the idle read SAW (`settleRuns` `idleCoverSeq`): a user row beyond
   *  it was persisted after the read was issued — the idle fact predates that send and
   *  proves nothing about its run (codex phase 4 pass 19). */
  idleCoverSeq: number,
): Promise<number> {
  const chatId = scope.chatId;
  const chat = await ctx.db.get(chatId);
  if (chat === null) return 0;
  // Admission RECORDS, identities only — never the outbox rows and their prompts (codex
  // phase 4 pass 15: 20 admitted sends of 900 KB made every read of the chat fail at
  // Convex's read limit). A stale one holds nothing any more (lib/outboxQueue): removed
  // first, oldest first, so the live ones are always reached.
  const now = Date.now();
  const admitted = await ctx.db
    .query("runAdmissions")
    .withIndex("by_chat_admitted", (q) => q.eq("chatId", chatId))
    .take(MAX_ADMITTED_RELEASE);
  let released = 0;
  for (const row of admitted) {
    if (row.admittedAt <= now - SESSION_ACTIVE_FRESH_MS) {
      await ctx.db.delete(row._id);
      released++;
      continue;
    }
    const sendId = row.sendId;
    if (sendId === undefined) continue;
    // Only a send THIS session's instance received, proven by THIS session's own rows: in a
    // conversation several instances serve, one instance's idle read says nothing about
    // another's run (codex phase 4 pass 2).
    const owner =
      row.sentToInstance ??
      row.routedInstanceName ??
      (chat.perTurnRouting === true ? undefined : chat.instanceName);
    if (owner !== scope.instanceName) continue;
    let done = over.has(sendId);
    // …or the gateway's CURRENT custody of the input, in this session, says it will never
    // run: cancelled before it ran (a pending item or a receipt says so), or dropped — a
    // read asked after its ACK and the gateway held nothing for it, on an idle session.
    // Such an input brings neither a settled run nor a user row (codex phase 4 pass 3).
    if (!done) {
      const input = await ctx.db
        .query("transcriptInputs")
        .withIndex("by_chat_session_send", (q) =>
          q.eq("chatId", chatId).eq("sessionKey", scope.sessionKey).eq("sendId", sendId),
        )
        .first();
      if (input !== null) {
        const cancelled = input.pendingState === "cancelled" || input.receiptCancelled === true;
        // Never held at all (no receipt, no pending item, ever) and proven absent after
        // its ACK: the gateway dropped it.
        const dropped = sessionIdle && input.absentAt !== undefined && !gatewayHeldInput(input);
        done = cancelled || dropped;
      }
    }
    if (!done && sessionIdle) {
      const userRow = (
        await ctx.db
          .query("transcriptRows")
          .withIndex("by_chat_send", (q) => q.eq("chatId", chatId).eq("sendId", sendId))
          .take(4)
      ).find(
        (r) =>
          r.role.toLowerCase() === "user" &&
          r.sessionKey === scope.sessionKey &&
          r.instanceName === scope.instanceName &&
          r.seq <= idleCoverSeq,
      );
      done = userRow !== undefined;
    }
    if (done) {
      await ctx.db.delete(row._id);
      released++;
    }
  }
  return released;
}

/** Project runs, and hand what one mutation cannot hold to a scheduled continuation
 *  (bounded per call): a run marked over is always projected, however many there are. */
async function projectAll(
  ctx: MutationCtx,
  scope: ProjectionScope,
  runIds: readonly string[],
  resume?: ProjectionResume,
  shared?: Budget,
): Promise<void> {
  const res = await projectBubbles(ctx, scope, runIds, resume, shared);
  if (res.remaining.length > 0) {
    await ctx.scheduler.runAfter(0, internal.transcriptProjection.continueProjection, {
      chatId: scope.chatId,
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      instanceName: scope.instanceName,
      runIds: res.remaining,
      ...(res.resume !== undefined ? { resume: res.resume } : {}),
    });
  }
}

/** The continuation of a projection one mutation could not finish (phase 4). The floor
 *  and coverage holes are read again from the session's cursor: a newer read may have
 *  moved them, and they are what the projection must honour now. */
export const continueProjection = internalMutation({
  args: {
    chatId: v.id("chats"),
    sessionKey: v.string(),
    sessionId: v.string(),
    instanceName: v.string(),
    runIds: v.array(v.string()),
    /** The run the previous call stopped inside (its steer segments past the byte
     *  bound), continued from that segment. */
    resume: v.optional(v.object({ runId: v.string(), fromSegment: v.number() })),
  },
  handler: async (ctx, args) => {
    if (!(await projectionTaskInScope(ctx, args.chatId, args.instanceName))) return { projected: 0 };
    const cursor = await cursorFor(ctx, args);
    if (cursor === null) return { projected: 0 };
    await projectAll(
      ctx,
      {
        chatId: args.chatId,
        sessionKey: args.sessionKey,
        sessionId: args.sessionId,
        instanceName: args.instanceName,
        floorSeq: cursor.floorSeq,
        gaps: cursor.gaps ?? [],
      },
      args.runIds,
      args.resume,
    );
    return { projected: Math.min(args.runIds.length, MAX_PROJECTED_RUNS) };
  },
});

/**
 * The bubble the TRANSCRIPT made for a run (projection `on`, phase 4 — codex pass 21):
 * the bridge closed the run's turn on the transcript's fact before any bubble opened on
 * its side, and the run's late media and live terminal must land on this one. Read-only.
 * VERIFIED: the calling instance may write this chat (the ingest barrier), the bubble is
 * an answer of THIS run and segment, in THIS session, bound to THIS instance. A
 * conversation that never stored transcript text (never `on`) has none: answered with no
 * index read.
 */
export const projectedBubble = internalQuery({
  args: {
    chatId: v.id("chats"),
    boundInstanceName: v.string(),
    sessionKey: v.string(),
    runId: v.string(),
    segment: v.number(),
  },
  handler: async (ctx, a): Promise<{ messageId: Id<"messages"> | null }> => {
    if (
      a.sessionKey.length === 0 ||
      a.sessionKey.length > 512 ||
      a.runId.length === 0 ||
      a.runId.length > MAX_RUN_ID_CHARS ||
      !Number.isInteger(a.segment) ||
      a.segment < 0
    ) {
      return { messageId: null };
    }
    if (!(await chatAllowsInstance(ctx, a.chatId, a.boundInstanceName))) return { messageId: null };
    const chat = await ctx.db.get(a.chatId);
    if (!transcriptStoredText(chat)) return { messageId: null };
    const docs = await ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) =>
        q.eq("chatId", a.chatId).eq("runId", a.runId).eq("runSegment", a.segment > 0 ? a.segment : undefined),
      )
      .take(4);
    const bubble = docs.find(
      (m) => m.role === "assistant" && m.turnSessionKey === a.sessionKey && m.boundInstance === a.boundInstanceName,
    );
    return { messageId: bubble?._id ?? null };
  },
});

/** The follow-up of ONE deletion (lib/transcriptProjection `deletionTombstones`), ids
 *  only: for each deleted answer in turn, the runs merged into it are tombstoned (read by
 *  `_creationTime` pages, no pagination cursor needed), then its purge is scheduled. A
 *  GLOBAL bound per call (FOLLOW_UP_QUERY_BUDGET index queries, FOLLOW_UP_PURGES_PER_CALL
 *  purges) — the call hands the rest to itself, whatever the deletion removed. */
export const followUpDeletion = internalMutation({
  args: {
    chatId: v.id("chats"),
    deleted: v.array(
      v.object({
        id: v.id("messages"),
        sessionKey: v.optional(v.string()),
        runId: v.optional(v.string()),
        user: v.optional(v.boolean()),
        segment: v.optional(v.number()),
        sends: v.optional(v.array(v.string())),
        steerIndex: v.optional(v.number()),
        sendsAfter: v.optional(v.number()),
      }),
    ),
    /** The answer being walked, and the creation time its merges resume after. */
    index: v.number(),
    after: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    let queries = 0;
    let purges = 0;
    // EVERY document this call reads, in bytes (codex phase 4 pass 14): checked before each
    // step, the rest handed to the continuation — a call that failed at Convex's read
    // limit would roll back its own continuation with it, and nothing would ever purge.
    const meter: ReadMeter = { bytes: 0 };
    const spent = () =>
      queries >= FOLLOW_UP_QUERY_BUDGET || purges >= FOLLOW_UP_PURGES_PER_CALL || meter.bytes >= FOLLOW_UP_BYTE_BUDGET;
    let i = args.index;
    let after = args.after;
    const deleted = [...args.deleted];
    while (i < deleted.length) {
      if (spent()) break;
      const bubble = deleted[i]!;
      // A bubble not deleted after all is nothing to follow up (and never purged).
      queries++;
      const still = await ctx.db.get(bubble.id);
      meter.bytes += docReadBytes(still);
      if (still !== null) {
        i++;
        after = null;
        continue;
      }
      // An answer's own tombstone, written as an ORDINAL with no read at the deletion:
      // resolved here to its STABLE boundary (codex phase 4 pass 27) — the start of the
      // segment as the cuts known NOW place it, which can only be at or before the one
      // the answer started at (cuts only get added): conservative, then frozen.
      if (bubble.user !== true && bubble.segment !== undefined && bubble.sessionKey !== undefined && bubble.runId !== undefined) {
        const { segment, sessionKey, runId } = bubble;
        queries += 2;
        const cuts = await steerSeqsOf(ctx, args.chatId, sessionKey, runId, meter);
        const doc = await ctx.db
          .query("transcriptTombstones")
          .withIndex("by_message", (q) => q.eq("messageId", bubble.id).eq("runId", runId).eq("segment", segment))
          .first();
        meter.bytes += docReadBytes(doc);
        if (doc !== null && doc.fromSeq === undefined) {
          await ctx.db.patch(doc._id, { fromSeq: boundaryOfOrdinal(segment, cuts) });
        }
        const { segment: _resolved, ...rest } = bubble;
        deleted[i] = rest;
        continue;
      }
      // A deleted USER message (codex phase 4 pass 13): the segments its sends' steers
      // started, one send per step, then every send only its outbox rows still name (older
      // than the ones the message kept), one row per step — each under this call's budget.
      const sends = bubble.sends ?? [];
      if (bubble.user === true && (bubble.steerIndex ?? 0) < sends.length) {
        const k = bubble.steerIndex ?? 0;
        queries += await tombstoneSteerOf(ctx, args.chatId, bubble.id, sends[k]!, meter);
        deleted[i] = { ...bubble, steerIndex: k + 1 };
        continue;
      }
      if (bubble.user === true && bubble.sendsAfter !== undefined) {
        const from = bubble.sendsAfter;
        queries++;
        const page = await ctx.db
          .query("outbox")
          .withIndex("by_message", (q) => q.eq("messageId", bubble.id).gt("_creationTime", from))
          .take(MAX_SENDS_READ);
        meter.bytes += page.reduce((n, o) => n + docReadBytes(o), 0);
        const { sendsAfter: _done, ...rest } = bubble;
        if (page.length === 0) {
          deleted[i] = rest;
          continue;
        }
        const known = [...sends];
        for (const o of page) {
          if (o.sendId === undefined || known.includes(o.sendId)) continue;
          known.push(o.sendId);
          await tombstoneSendRun(ctx, args.chatId, bubble.id, o.sendId);
          queries += await tombstoneSteerOf(ctx, args.chatId, bubble.id, o.sendId, meter);
        }
        deleted[i] = { ...rest, sends: known, steerIndex: known.length, sendsAfter: page[page.length - 1]!._creationTime };
        continue;
      }
      queries++;
      const merges = await ctx.db
        .query("runBubbles")
        .withIndex("by_message", (q) =>
          after === null ? q.eq("messageId", bubble.id) : q.eq("messageId", bubble.id).gte("_creationTime", after),
        )
        .take(TOMBSTONE_MERGE_PAGE + 1);
      meter.bytes += merges.reduce((n, m) => n + docReadBytes(m), 0);
      // One merge at a time under the budget: past it, resume AT the merge not reached
      // (its tombstone is written once — `insertTombstone` probes first).
      let stopAt: number | null = null;
      let handled = 0;
      for (const m of merges.slice(0, TOMBSTONE_MERGE_PAGE)) {
        if (handled > 0 && spent()) {
          stopAt = m._creationTime;
          break;
        }
        handled++;
        if (bubble.sessionKey !== undefined && m.runId !== bubble.runId) {
          queries++;
          await insertTombstone(ctx, { _id: bubble.id, chatId: args.chatId }, bubble.sessionKey, m.runId, 0, meter);
        }
      }
      const next = stopAt ?? (merges.length > TOMBSTONE_MERGE_PAGE ? merges[TOMBSTONE_MERGE_PAGE]!._creationTime : null);
      if (next !== null) {
        // More merges: resume at the first one not handled. A page whose creation times
        // are all equal would not move: past it (its merges are refused by `deletedMergeOf`
        // anyway, and the purge below walks every tombstone written).
        if (after !== null && next === after) {
          after = null;
          i++;
          continue;
        }
        after = next;
        continue;
      }
      queries += 2;
      if (await schedulePurgeIfAny(ctx, args.chatId, bubble, meter)) purges++;
      i++;
      after = null;
    }
    if (i < deleted.length) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.followUpDeletion, {
        chatId: args.chatId,
        deleted,
        index: i,
        after,
      });
    }
    return { handled: i - args.index };
  },
});

/** A conversation's row TEXTS, purged in their own bounded transactions (phase 4): by the
 *  chat purge (`chats.sweepDeletedChat`) and the service-chat sweep (with `markPurged`:
 *  each row stays a tombstone, so no later read stores its text again). Never inside a
 *  message sweep's transaction (codex phase 4 pass 9). Ids only; self-continued. */
export const purgeChatRowTexts = internalMutation({
  args: {
    chatId: v.id("chats"),
    markPurged: v.boolean(),
    /** The service-chat sweep: only the texts stored by the time the sweep started — the
     *  FINISHED job's. A job started since (between two batches, or before this step
     *  ran) stores its own texts after it, and they are never touched (codex phase 4
     *  pass 16: the next summary's text was deleted and its row marked purged for good). */
    before: v.optional(v.number()),
  },
  handler: async (ctx, { chatId, markPurged, before }) => {
    const docs = await ctx.db
      .query("transcriptRowTexts")
      .withIndex("by_chat", (q) =>
        before === undefined ? q.eq("chatId", chatId) : q.eq("chatId", chatId).lte("_creationTime", before),
      )
      .take(TEXT_PURGE_BATCH);
    for (const d of docs) {
      if (markPurged) {
        const row = await ctx.db.get(d.rowId);
        if (row !== null && row.textSig !== TEXT_PURGED_SIG) await ctx.db.patch(row._id, { textSig: TEXT_PURGED_SIG });
      }
      await ctx.db.delete(d._id);
    }
    if (docs.length === TEXT_PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeChatRowTexts, {
        chatId,
        markPurged,
        ...(before !== undefined ? { before } : {}),
      });
      return { purged: docs.length };
    }
    // The chat purge (`markPurged` false: the chat is gone) also takes its tombstones —
    // identity documents, a few hundred bytes each.
    if (!markPurged && (await ctx.db.get(chatId)) === null) {
      const tombs = await ctx.db
        .query("transcriptTombstones")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .take(500);
      for (const t of tombs) await ctx.db.delete(t._id);
      // …and its run admissions (written only where the marker is: bridge.markOutbox).
      const admissions = await ctx.db
        .query("runAdmissions")
        .withIndex("by_chat_admitted", (q) => q.eq("chatId", chatId))
        .take(500);
      for (const a of admissions) await ctx.db.delete(a._id);
      if (tombs.length === 500 || admissions.length === 500) {
        await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeChatRowTexts, { chatId, markPurged });
      }
    }
    return { purged: docs.length };
  },
});

/** Rows whose stored copies must go (`purgeRowTextsLater`): TEXT_PURGE_BATCH per step. */
export const purgeRowTextsById = internalMutation({
  args: { chatId: v.id("chats"), rowIds: v.array(v.id("transcriptRows")) },
  handler: async (ctx, { chatId, rowIds }) => {
    for (const id of rowIds.slice(0, TEXT_PURGE_BATCH)) {
      const row = await ctx.db.get(id);
      if (row === null || row.chatId !== chatId) continue;
      await purgeRowText(ctx, row);
    }
    if (rowIds.length > TEXT_PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeRowTextsById, {
        chatId,
        rowIds: rowIds.slice(TEXT_PURGE_BATCH),
      });
    }
  },
});

/** A run whose segments a NEW cut row (a steered user row) may have just redrawn: every
 *  row of it that now falls in a tombstoned segment loses its stored text (codex phase 4
 *  pass 9: an answer stored before its cut row arrived was classified segment 0 and kept).
 *  Paged; ids only. */
export const purgeTombstonedRun = internalMutation({
  args: {
    chatId: v.id("chats"),
    sessionKey: v.string(),
    runId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { chatId, sessionKey, runId, cursor }) => {
    const tombs = await tombstonedSegments(ctx, chatId, sessionKey, runId);
    if (!tombs.any) return { purged: 0 };
    const cuts = await steerSeqsOf(ctx, chatId, sessionKey, runId);
    const page = await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
      .paginate({ numItems: TEXT_PURGE_BATCH, cursor });
    let purged = 0;
    for (const row of page.page) {
      if (row.sessionKey !== sessionKey || row.role.toLowerCase() === "user") continue;
      const hit = tombstoneHit(tombs, cuts, row.seq);
      if (hit === null) continue;
      if (await purgeRowText(ctx, row)) purged++;
      if (row.messageId === undefined && hit.to !== undefined) await ctx.db.patch(row._id, { messageId: hit.to });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeTombstonedRun, {
        chatId,
        sessionKey,
        runId,
        cursor: page.continueCursor,
      });
    }
    return { purged };
  },
});

/** Hand the user rows one transaction's budget did not reach to `continueUserRows`. */
async function continueUserRowsLater(
  ctx: MutationCtx,
  scope: { chatId: Id<"chats">; sessionKey: string; sessionId: string; instanceName: string },
  custodySendIds: readonly string[],
  assignEntryIds: readonly string[],
): Promise<void> {
  if (custodySendIds.length === 0 && assignEntryIds.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.transcriptProjection.continueUserRows, {
    chatId: scope.chatId,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    instanceName: scope.instanceName,
    custodySendIds: [...custodySendIds],
    assignEntryIds: [...assignEntryIds],
  });
}

/** The user rows' custody and assignment one transaction left (codex phase 4 pass 9),
 *  continued under a fresh budget; what still does not fit continues again. Ids only. */
export const continueUserRows = internalMutation({
  args: {
    chatId: v.id("chats"),
    sessionKey: v.string(),
    sessionId: v.string(),
    instanceName: v.string(),
    custodySendIds: v.array(v.string()),
    assignEntryIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await projectionTaskInScope(ctx, args.chatId, args.instanceName))) return;
    const budget = newBudget();
    const known: Array<Pick<TranscriptRowInput, "role" | "sendId" | "steerTargetRunId">> = [];
    for (const sendId of args.custodySendIds) {
      budget.queries++;
      const row = (
        await ctx.db
          .query("transcriptRows")
          .withIndex("by_chat_send", (q) => q.eq("chatId", args.chatId).eq("sendId", sendId))
          .take(4)
      ).find((r) => r.sessionKey === args.sessionKey && r.role.toLowerCase() === "user");
      if (row !== undefined) {
        known.push({
          role: "user",
          sendId,
          ...(row.steerTargetRunId !== undefined ? { steerTargetRunId: row.steerTargetRunId } : {}),
        });
      }
    }
    const custodyLeft = await projectCustody(
      ctx,
      { chatId: args.chatId, sessionKey: args.sessionKey, instanceName: args.instanceName },
      known,
      args.custodySendIds,
      budget,
    );
    const toAssign: Array<{ entryId: string; role: string; sendId?: string }> = [];
    for (const entryId of args.assignEntryIds) {
      budget.queries++;
      const row = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey).eq("entryId", entryId),
        )
        .first();
      if (row === null) continue;
      budget.rows.set(`${args.sessionKey}\u0000${entryId}`, row);
      toAssign.push({ entryId, role: row.role, ...(row.sendId !== undefined ? { sendId: row.sendId } : {}) });
    }
    const assignLeft = await assignUserRows(
      ctx,
      {
        chatId: args.chatId,
        sessionKey: args.sessionKey,
        sessionId: args.sessionId,
        instanceName: args.instanceName,
        floorSeq: 0,
        gaps: [],
      },
      toAssign,
      budget,
    );
    await continueUserRowsLater(ctx, args, custodyLeft, assignLeft);
  },
});

/** The runs new cut rows redrew beyond one apply's bound (`upsertRows`): each probed for a
 *  tombstone and, when it has one, re-purged (`purgeTombstonedRun`) — MAX_CUT_PURGES_PER_APPLY
 *  per step, the rest continued. Ids only. Not scoped to the mode: a purge is owed after a
 *  rollback too. */
export const purgeCutRuns = internalMutation({
  args: { chatId: v.id("chats"), sessionKey: v.string(), runIds: v.array(v.string()) },
  handler: async (ctx, { chatId, sessionKey, runIds }) => {
    for (const runId of runIds.slice(0, MAX_CUT_PURGES_PER_APPLY)) {
      if (!(await tombstonedSegments(ctx, chatId, sessionKey, runId)).any) continue;
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeTombstonedRun, {
        chatId,
        sessionKey,
        runId,
        cursor: null,
      });
    }
    if (runIds.length > MAX_CUT_PURGES_PER_APPLY) {
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeCutRuns, {
        chatId,
        sessionKey,
        runIds: runIds.slice(MAX_CUT_PURGES_PER_APPLY),
      });
    }
  },
});

/** Rows one purge batch clears: sized by bytes (lib/transcriptProjection). */
const ROW_TEXT_PURGE_BATCH = TEXT_PURGE_BATCH;

/** What a DELETED bubble's transcript rows said (lib/transcriptProjection
 *  `tombstoneDeletedBubble`), purged in ONE chain of bounded steps (ids only): first the
 *  rows already assigned to it, then, tombstone by tombstone, every row of that run
 *  segment in its session — assigned or not yet (received while streaming). Each text
 *  deleted, each identity kept as a tombstone (`TEXT_PURGED_SIG`, pointing at the
 *  deleted bubble). One scheduled step at a time, whatever the bubble merged. */
export const purgeDeletedBubbleTexts = internalMutation({
  args: {
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    /** Absent: the assigned rows. Present: the tombstone being walked (its key). */
    tomb: v.optional(v.object({ runId: v.string(), segment: v.number() })),
    /** Where the current row walk resumes. */
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { chatId, messageId, tomb, cursor }) => {
    // Not deleted after all (nothing here ever deletes a live bubble's texts).
    if ((await ctx.db.get(messageId)) !== null) return { purged: 0 };
    let purged = 0;
    const next = async (args: { tomb?: { runId: string; segment: number }; cursor: string | null }) =>
      ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeDeletedBubbleTexts, {
        chatId,
        messageId,
        ...(args.tomb !== undefined ? { tomb: args.tomb } : {}),
        cursor: args.cursor,
      });
    if (tomb === undefined) {
      const page = await ctx.db
        .query("transcriptRows")
        .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
        .paginate({ numItems: ROW_TEXT_PURGE_BATCH, cursor: cursor ?? null });
      for (const row of page.page) if (await purgeRowText(ctx, row)) purged++;
      if (!page.isDone) {
        await next({ cursor: page.continueCursor });
      } else {
        const first = await nextTombstone(ctx, messageId, null);
        if (first !== null) await next({ tomb: { runId: first.runId, segment: first.segment }, cursor: null });
      }
      return { purged };
    }
    const doc = await ctx.db
      .query("transcriptTombstones")
      .withIndex("by_message", (q) =>
        q.eq("messageId", messageId).eq("runId", tomb.runId).eq("segment", tomb.segment),
      )
      .first();
    if (doc !== null) {
      // A deleted USER message's run (`ANY_SESSION`, every segment — codex phase 4 pass 12):
      // every row of it, in every session, its own user row included.
      const wholeRun = doc.sessionKey === ANY_SESSION || (doc.fromSeq === undefined && doc.segment === ALL_SEGMENTS);
      // The span's STABLE start (codex phase 4 pass 27): its boundary, or — not resolved
      // yet — its ordinal read conservatively against the current cuts.
      const from = wholeRun
        ? RUN_START
        : (doc.fromSeq ?? boundaryOfOrdinal(doc.segment, await steerSeqsOf(ctx, chatId, doc.sessionKey, doc.runId)));
      const page = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", doc.runId))
        .paginate({ numItems: ROW_TEXT_PURGE_BATCH, cursor: cursor ?? null });
      for (const row of page.page) {
        if (doc.sessionKey !== ANY_SESSION && (row.role.toLowerCase() === "user" || row.sessionKey !== doc.sessionKey)) {
          continue;
        }
        if (row.seq <= from) continue;
        if (await purgeRowText(ctx, row)) purged++;
        if (row.messageId === undefined) await ctx.db.patch(row._id, { messageId });
      }
      if (!page.isDone) {
        await next({ tomb, cursor: page.continueCursor });
        return { purged };
      }
    }
    const after = await nextTombstone(ctx, messageId, tomb);
    if (after !== null) await next({ tomb: { runId: after.runId, segment: after.segment }, cursor: null });
    return { purged };
  },
});

/** The tombstone of `messageId` after `key` in (runId, segment) order, or the first. */
async function nextTombstone(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  key: { runId: string; segment: number } | null,
): Promise<Doc<"transcriptTombstones"> | null> {
  if (key === null) {
    return ctx.db.query("transcriptTombstones").withIndex("by_message", (q) => q.eq("messageId", messageId)).first();
  }
  const sameRun = await ctx.db
    .query("transcriptTombstones")
    .withIndex("by_message", (q) => q.eq("messageId", messageId).eq("runId", key.runId).gt("segment", key.segment))
    .first();
  if (sameRun !== null) return sameRun;
  return ctx.db
    .query("transcriptTombstones")
    .withIndex("by_message", (q) => q.eq("messageId", messageId).gt("runId", key.runId))
    .first();
}

export const applyTranscript = internalMutation({
  args: {
    chatId: v.id("chats"),
    boundInstanceName: v.string(),
    sessionKey: v.string(),
    /** The gateway transcript the read came from ("" when the reply named none). */
    sessionId: v.string(),
    /** `live`: rows CU-16 admitted from a `session.message` (phase 2). Rows and their
     *  runs only — never a cursor, a floor, a gap or session state. */
    kind: v.union(v.literal("page"), v.literal("delta"), v.literal("reset"), v.literal("live")),
    /** Where the next read resumes; absent on a reset or a page without one. */
    deltaCursor: v.optional(v.string()),
    rows: v.array(rowValidator),
    /** Terminal frames the bridge observed for runs of this session since its last apply. */
    terminals: v.array(terminalValidator),
    activeRunIds: v.optional(v.array(v.string())),
    hasActiveRun: v.optional(v.boolean()),
    /** The session's queue modes the read projected (phase 3: the composer's label). */
    queueMode: v.optional(v.string()),
    effectiveQueueMode: v.optional(v.string()),
    /** Durable rows the bridge could not identify (no `__openclaw.id` or `seq`). */
    unidentified: v.number(),
    /** When the bridge ISSUED this read (epoch ms, strictly increasing per reconciler).
     *  An apply can land after a newer one (its POST timed out on the bridge and still
     *  committed here): an older read never replaces the cursor or the session. Absent on
     *  an older bridge ⇒ the time it lands here. */
    readAt: v.optional(v.number()),
    // PHASE 2 — the input guard this read carried (identity only, bounded on use).
    inputRunIds: v.optional(v.array(v.string())),
    pendingInputs: v.optional(pendingInputsValidator),
    inputReceipts: v.optional(v.array(inputReceiptValidator)),
    inputAbsent: v.optional(v.array(v.string())),
    inputUnreadable: v.optional(v.array(v.string())),
    /** PROJECTION `on` (phase 4): the runs the bridge's foreground turn owns. Whatever
     *  apply first marked them over, the answer names them again while they are over —
     *  a notification lost with an HTTP response is replayed by the next read. */
    foregroundRunIds: v.optional(v.array(v.string())),
    /** A `live` post that only carries row TEXT for the read that follows it (the bridge
     *  chunks a read's texts under MAX_APPLY_TEXT_*): its rows and their texts are stored,
     *  nothing else — no run, no custody, no projection, no cursor. */
    textsOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // The cross-gateway write barrier, atomic with the write (lib/ingestAuthz).
    if (!(await chatAllowsInstance(ctx, args.chatId, args.boundInstanceName))) {
      throw new Error("forbidden: cross-instance transcript target");
    }
    if (args.sessionKey.length === 0 || args.sessionKey.length > 512) {
      return { ok: false as const, reason: "bad_session_key" };
    }
    const now = Date.now();
    const sessionId = args.sessionId.slice(0, 128);
    let unidentified = Math.max(0, Math.floor(args.unidentified));
    const sanitized: TranscriptRowInput[] = [];
    for (const raw of args.rows.slice(0, MAX_ROWS_PER_APPLY)) {
      const row = sanitizeRow(raw);
      if (row === null) unidentified++;
      else sanitized.push(row);
    }
    unidentified += Math.max(0, args.rows.length - MAX_ROWS_PER_APPLY);

    // The cursor and the floor. A new gateway session (reset, rotation) restarts `seq`:
    // its transcript was written entirely under the projection, so its floor is 0.
    const cursor = await ctx.db
      .query("transcriptCursors")
      .withIndex("by_chat_session", (q) =>
        q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey),
      )
      .first();
    // A session key is the instance's that projected it first (codex pass 5): another
    // bridge admitted to the same conversation never writes into it — not its rows, its
    // runs, its inputs nor its cursor. The owner is the cursor's instance, else — a
    // session so far written only by LIVE applies, which create no cursor — the instance
    // stamped on its rows: the first live write reserves the session in the very
    // transaction that inserts them (codex pass 6).
    const owner =
      cursor?.instanceName ??
      (
        await ctx.db
          .query("transcriptRows")
          .withIndex("by_chat_session_entry", (q) =>
            q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey),
          )
          .first()
      )?.instanceName;
    // Refused WITHOUT a write. Answered, not thrown: two instances exposing the same
    // agent id derive the same key for one conversation, and the second one's reads
    // must not fail in a loop — its session is simply not projected (stated limit).
    // Refused BEFORE the projection mode is resolved (codex phase 4 pass 12): a refusal
    // costs what it cost before phase 4 — the mode reads every instance row.
    if (owner !== undefined && owner !== args.boundInstanceName) {
      return { ok: false as const, reason: "session_owned_elsewhere" };
    }
    // PROJECTION `on` (phase 4) is the only mode that keeps what a row SAYS: `off` and
    // `shadow` store identities only, exactly as before.
    const chatDoc = await ctx.db.get(args.chatId);
    const projectionOn = (await projectionModeOfChat(ctx, chatDoc)) === "on";
    // A text post outside `on` has nothing to store — the read that follows carries the
    // identities. Answered without a write (codex phase 4 pass 12).
    if (!projectionOn && args.kind === "live" && args.textsOnly === true) {
      return {
        ok: true as const,
        inserted: 0,
        updated: 0,
        textsOnly: true as const,
        settledRuns: [] as string[],
      };
    }
    const rows: TranscriptRowInput[] = projectionOn
      ? sanitized
      : sanitized.map((row) => {
          const { text: _text, yieldAck: _ack, ...identity } = row;
          return identity;
        });
    // REFUSED WHOLE, before any write, when it carries more text than one transaction can
    // persist (codex phase 4 pass 6): nothing is stored, nothing deferred, the cursor does
    // not move — the bridge splits and posts again (transcript-shadow.ts `chunkTextRows`).
    const load = textLoadOf(rows);
    // …and when the stored texts it would have to read back to merge (a changed text of a
    // row whose text is known: its document, up to a row's whole budget) would not fit
    // either. Identity probes only, before any write.
    let readBack = 0;
    for (const r of rows) {
      if ((r.text === undefined && r.yieldAck === undefined) || r.runId === undefined) continue;
      const known = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey).eq("entryId", r.entryId),
        )
        .first();
      const sig = known?.textSig;
      if (sig !== undefined && sig !== TEXT_PURGED_SIG && sig !== rowTextSignature(r.text, r.yieldAck)) {
        readBack += MAX_TEXT_DOC_BYTES;
      }
    }
    if (
      load.rows > MAX_APPLY_TEXT_ROWS ||
      load.bytes > MAX_APPLY_TEXT_BYTES ||
      readBack > MAX_APPLY_TEXT_READ_BYTES
    ) {
      return {
        ok: false as const,
        reason: "too_large" as const,
        acceptedRows: 0,
        maxTextRows: MAX_APPLY_TEXT_ROWS,
        maxTextBytes: MAX_APPLY_TEXT_BYTES,
      };
    }
    // ONE budget for the whole transaction (codex phase 4 pass 6): the rows' upsert, their
    // texts and the projection count against the same bytes and index queries; the rest
    // of this mutation's own reads are reserved up front.
    const budget = newBudget();
    budget.queries += APPLY_RESERVED_QUERIES;
    budget.bytes += APPLY_RESERVED_BYTES;

    // THE PRESENCE MARKER, before the first text this conversation ever stores (texts are
    // stored in `on` only — shadow writes no chat, phase 2's invariant): a deletion that
    // follows must tombstone and purge (lib/transcriptProjection `deletionTombstones`), even
    // when no read has created a cursor yet. A shadow conversation is found by its cursor.
    if (projectionOn && chatDoc !== null && chatDoc.transcriptSeenAt === undefined) {
      await ctx.db.patch(args.chatId, { transcriptSeenAt: now });
    }
    const textsStored = projectionOn || chatDoc?.transcriptSeenAt !== undefined;
    // A DIRECT row post (CU-16, phase 2): its rows and their runs, nothing else. The read
    // the same event asked for carries the session state; this never moves it.
    if (args.kind === "live" && args.textsOnly === true) {
      const res = await upsertRows(
        ctx,
        {
          chatId: args.chatId,
          instanceName: args.boundInstanceName,
          sessionKey: args.sessionKey,
          sessionId: sessionId !== "" ? sessionId : (cursor?.sessionId ?? ""),
          now,
          textsStored,
        },
        rows,
        budget,
      );
      return {
        ok: true as const,
        inserted: res.inserted,
        updated: res.updated,
        textsOnly: true as const,
        settledRuns: [] as string[],
      };
    }
    if (args.kind === "live") {
      const liveSessionId = sessionId !== "" ? sessionId : (cursor?.sessionId ?? "");
      const res = await upsertRows(
        ctx,
        {
          chatId: args.chatId,
          instanceName: args.boundInstanceName,
          sessionKey: args.sessionKey,
          sessionId: liveSessionId,
          now,
          textsStored,
        },
        rows,
        budget,
      );
      const persisted = new Map<string, RunObservation[]>(
        [...res.seqByRun.keys()].map((runId) => [runId, [{ status: "persisted" as const }]]),
      );
      await upsertRuns(ctx, { chatId: args.chatId, sessionKey: args.sessionKey, now }, persisted, res.seqByRun);
      const custodyLeft = await projectCustody(
        ctx,
        { chatId: args.chatId, sessionKey: args.sessionKey, instanceName: args.boundInstanceName },
        rows,
        [],
        budget,
        { chat: chatDoc, projectionOn },
      );
      // PROJECTION `on` (phase 4): a row of a run already over (a delivery mirror written
      // after its terminal) joins that run's bubble now. Needs the cursor's floor: before
      // the first read nothing is placed.
      if (projectionOn && cursor !== null) {
        const scope: ProjectionScope = {
          chatId: args.chatId,
          sessionKey: args.sessionKey,
          sessionId: liveSessionId,
          instanceName: args.boundInstanceName,
          floorSeq: cursor.floorSeq,
          gaps: cursor.gaps ?? [],
        };
        const assignLeft = await assignUserRows(ctx, scope, rows, budget);
        await continueUserRowsLater(ctx, scope, custodyLeft, assignLeft);
        await projectAll(ctx, scope, [...res.seqByRun.keys()], undefined, budget);
      } else {
        await continueUserRowsLater(
          ctx,
          { chatId: args.chatId, sessionKey: args.sessionKey, sessionId: liveSessionId, instanceName: args.boundInstanceName },
          custodyLeft,
          [],
        );
      }
      if (cursor !== null) {
        await ctx.db.patch(cursor._id, {
          liveApplies: (cursor.liveApplies ?? 0) + 1,
          lastLiveAt: now,
          unidentified: cursor.unidentified + unidentified,
        });
      }
      return {
        ok: true as const,
        inserted: res.inserted,
        updated: res.updated,
        floorSeq: cursor?.floorSeq ?? null,
        sessionChanged: false,
        stale: false,
        live: true,
        settledRuns: projectionOn
          ? await alreadySettled(ctx, args, args.foregroundRunIds ?? [])
          : ([] as string[]),
      };
    }
    // FRESHNESS: a read OLDER than the one the cursor already reflects merges its rows
    // (idempotent upserts) and nothing else — no cursor, no session, no floor, no hole,
    // no active-run state. Otherwise a late stale POST would rewind the delta cursor or,
    // after a rotation, restore the old session and recompute its boundary.
    // The read's own time (the bridge's issue stamp); arrival only for an older bridge.
    // Every COVERAGE boundary below (coveredAt, a hole's detection, an unproven floor)
    // uses it.
    const readAt = args.readAt ?? now;
    const stale = cursor !== null && readAt < (cursor.lastReadAt ?? Number.NEGATIVE_INFINITY);
    // A cursor that never learnt its session (a read before the session existed) is
    // ADOPTED by the first named one, not "changed".
    const sessionChanged =
      !stale &&
      cursor !== null &&
      sessionId !== "" &&
      cursor.sessionId !== "" &&
      cursor.sessionId !== sessionId;
    // The earliest dispatch PROVEN by the user rows of this read (`<sendId>:user` whose
    // send is an outbox row of this chat): what bounds the bubbles of these rows.
    const provenSends = async (
      candidates: readonly TranscriptRowInput[],
    ): Promise<{ known: Set<string>; firstAt: number | null }> => {
      const known = new Set<string>();
      let firstAt: number | null = null;
      for (const r of candidates) {
        if (r.role !== "user" || r.sendId === undefined || known.has(r.sendId)) continue;
        const sendId = r.sendId;
        const outbox = await ctx.db
          .query("outbox")
          .withIndex("by_send_id", (q) => q.eq("sendId", sendId))
          .first();
        if (outbox !== null && outbox.chatId === args.chatId) {
          known.add(sendId);
          const at = dispatchTimeOf(outbox);
          if (firstAt === null || at < firstAt) firstAt = at;
        }
      }
      return { known, firstAt };
    };
    let floorSeq: number;
    let floorAt: number;
    let floorAtProven: boolean;
    if (stale) {
      floorSeq = cursor.floorSeq;
      floorAt = cursor.floorAt;
      floorAtProven = cursor.floorAtProven ?? true;
    } else if (cursor === null) {
      const { known, firstAt } = await provenSends(rows);
      floorSeq = floorForFirstRead(rows, (id) => known.has(id));
      floorAt = firstAt ?? readAt;
      floorAtProven = firstAt !== null;
    } else if (sessionChanged) {
      // A rotation found AFTER the fact: the new session's first turn may predate this
      // read, so its bubbles are bounded by the dispatch its rows prove — never by now.
      const { firstAt } = await provenSends(rows);
      floorSeq = 0;
      floorAt = firstAt ?? readAt;
      floorAtProven = firstAt !== null;
    } else {
      floorSeq = cursor.floorSeq;
      floorAt = cursor.floorAt;
      floorAtProven = cursor.floorAtProven ?? true;
      if (!floorAtProven) {
        const { firstAt } = await provenSends(rows.filter((r) => r.seq > floorSeq));
        if (firstAt !== null) {
          floorAt = firstAt;
          floorAtProven = true;
        }
      }
    }
    // COVERAGE: a tail page that starts ABOVE what was read before leaves a hole.
    const minSeq = rows.length === 0 ? null : Math.min(...rows.map((r) => r.seq));
    let gaps = sessionChanged ? [] : [...(cursor?.gaps ?? [])];
    let gapsDropped = sessionChanged ? 0 : (cursor?.gapsDropped ?? 0);
    if (!stale && cursor !== null && args.kind === "page" && minSeq !== null) {
      const readUpTo = sessionChanged ? 0 : (cursor.lastSeq ?? null);
      if (readUpTo !== null && minSeq > readUpTo + 1) {
        gaps.push({
          fromSeq: readUpTo + 1,
          toSeq: minSeq - 1,
          sinceAt: cursor.coveredAt ?? cursor.updatedAt,
          detectedAt: readAt,
        });
      }
    }
    if (gaps.length > MAX_COVERAGE_GAPS) {
      gapsDropped += gaps.length - MAX_COVERAGE_GAPS;
      gaps = gaps.slice(-MAX_COVERAGE_GAPS);
    }
    // Rows carry the session THEIR read named (a stale read's rows stay in its session).
    const effectiveSessionId = sessionId !== "" ? sessionId : (cursor?.sessionId ?? "");

    // Rows: upsert by (chat, session key, entry id).
    const upserted = await upsertRows(
      ctx,
      {
        chatId: args.chatId,
        instanceName: args.boundInstanceName,
        sessionKey: args.sessionKey,
        sessionId: effectiveSessionId,
        now,
        textsStored,
      },
      rows,
      budget,
    );
    const { inserted, updated, seqByRun } = upserted;
    let lastSeq = sessionChanged ? 0 : (cursor?.lastSeq ?? 0);
    if (upserted.maxSeq > lastSeq) lastSeq = upserted.maxSeq;

    // Runs: producers seen in rows (persisted / streaming) and terminal frames observed.
    // A stale read's view of the active runs is not the session's state any more, and a
    // reset reply carries none.
    const active = new Set(
      stale || args.kind === "reset"
        ? []
        : (args.activeRunIds ?? [])
            .filter((id) => id.length > 0 && id.length <= MAX_RUN_ID_CHARS)
            .slice(0, MAX_ACTIVE_RUN_IDS),
    );
    const observations = new Map<string, RunObservation[]>();
    const observe = (runId: string, o: RunObservation) => {
      const list = observations.get(runId) ?? [];
      list.push(o);
      observations.set(runId, list);
    };
    for (const runId of seqByRun.keys()) {
      observe(runId, { status: active.has(runId) ? "streaming" : "persisted" });
    }
    // A run the gateway names ACTIVE is streaming whether or not this read returned a row
    // of it. `active` is empty for a stale read and for a reset (neither describes the
    // session now), and `mergeRunStatus` never downgrades a terminal status.
    for (const runId of active) {
      if (!seqByRun.has(runId)) observe(runId, { status: "streaming" });
    }
    for (const t of args.terminals.slice(0, MAX_TERMINALS_PER_APPLY)) {
      if (t.runId.length === 0 || t.runId.length > MAX_RUN_ID_CHARS) continue;
      observe(t.runId, {
        status: t.status,
        ...(t.emptyFinal === true ? { emptyFinal: true } : {}),
        at: t.at,
      });
    }
    await upsertRuns(ctx, { chatId: args.chatId, sessionKey: args.sessionKey, now }, observations, seqByRun);

    // The input guard: what the gateway says it holds, per asked send. A stale read's
    // view of custody is older than the stored one: it is not recorded.
    let cleanupPending: boolean | null = null;
    if (!stale && args.kind !== "reset") {
      const res = await upsertInputs(
        ctx,
        { chatId: args.chatId, sessionKey: args.sessionKey, at: readAt, now },
        {
          ...(args.inputRunIds === undefined ? {} : { inputRunIds: args.inputRunIds }),
          ...(args.pendingInputs === undefined ? {} : { pendingInputs: args.pendingInputs }),
          ...(args.inputReceipts === undefined ? {} : { inputReceipts: args.inputReceipts }),
          ...(args.inputAbsent === undefined ? {} : { inputAbsent: args.inputAbsent }),
          ...(args.inputUnreadable === undefined ? {} : { inputUnreadable: args.inputUnreadable }),
        },
      );
      if (args.pendingInputs?.complete === true) cleanupPending = res.cleanupPending;
    }
    // PROJECTION `on` (phase 3): what the gateway said about each input, onto its bubble.
    const custodyLeft = await projectCustody(
      ctx,
      { chatId: args.chatId, sessionKey: args.sessionKey, instanceName: args.boundInstanceName },
      rows,
      stale || args.kind === "reset"
        ? []
        : [
            ...(args.inputRunIds ?? []),
            ...(args.pendingInputs?.items ?? []).flatMap((i) => (i.runId ? [i.runId] : [])),
            ...(args.inputReceipts ?? []).map((r) => r.runId),
          ],
      budget,
      { chat: chatDoc, projectionOn },
    );
    await continueUserRowsLater(
      ctx,
      { chatId: args.chatId, sessionKey: args.sessionKey, sessionId, instanceName: args.boundInstanceName },
      custodyLeft,
      [],
    );

    if (stale && cursor !== null) {
      await ctx.db.patch(cursor._id, {
        reads: cursor.reads + 1,
        staleReads: (cursor.staleReads ?? 0) + 1,
        unidentified: cursor.unidentified + unidentified,
      });
      return {
        ok: true as const,
        inserted,
        updated,
        floorSeq,
        sessionChanged: false,
        stale: true,
        settledRuns: projectionOn
          ? await alreadySettled(ctx, args, args.foregroundRunIds ?? [])
          : ([] as string[]),
      };
    }
    // The cursor: moves forward; a reset (or a new session) drops the delta cursor.
    const nextCursor =
      args.kind === "reset" ? undefined : (args.deltaCursor ?? (sessionChanged ? undefined : cursor?.deltaCursor));
    const cursorFields = {
      instanceName: args.boundInstanceName,
      sessionId: effectiveSessionId,
      deltaCursor: nextCursor,
      floorSeq,
      floorAt,
      floorAtProven,
      gaps,
      gapsDropped,
      // COVERAGE is the time the read was ISSUED, never the time its POST landed: a
      // delayed POST must not be taken to cover a bubble written after the read was made.
      ...(args.kind === "reset" ? {} : { coveredAt: readAt }),
      lastSeq: lastSeq > 0 ? lastSeq : undefined,
      lastKind: args.kind,
      lastReadAt: Math.max(readAt, cursor?.lastReadAt ?? Number.NEGATIVE_INFINITY),
      // A reset reply carries no session state: what the last effective read said about
      // active runs stands until a read that returned rows says otherwise.
      ...(args.kind === "reset" ? {} : { activeRunIds: [...active] }),
      ...(args.kind === "reset" || args.hasActiveRun === undefined
        ? {}
        : { hasActiveRun: args.hasActiveRun }),
      // The session's queue modes (phase 3): what the composer says a busy send does.
      ...(args.kind === "reset"
        ? {}
        : {
            sessionQueueMode: boundedMode(args.queueMode),
            effectiveQueueMode: boundedMode(args.effectiveQueueMode),
          }),
      ...(args.kind === "reset" || args.pendingInputs === undefined
        ? {}
        : {
            pendingInputsTotal: Math.max(0, Math.floor(args.pendingInputs.total)),
            pendingInputsComplete: args.pendingInputs.complete === true,
            ...(cleanupPending === null
              ? {}
              : { pendingCleanupInProgress: cleanupPending, pendingCleanupEpoch: readAt }),
            ...(args.pendingInputs.queuedCount === undefined
              ? {}
              : { pendingQueuedCount: Math.max(0, Math.floor(args.pendingInputs.queuedCount)) }),
          }),
      updatedAt: now,
    };
    if (cursor === null) {
      await ctx.db.insert("transcriptCursors", {
        chatId: args.chatId,
        sessionKey: args.sessionKey,
        ...cursorFields,
        reads: 1,
        resets: args.kind === "reset" ? 1 : 0,
        unidentified,
      });
    } else {
      await ctx.db.patch(cursor._id, {
        ...cursorFields,
        reads: cursor.reads + 1,
        resets: cursor.resets + (args.kind === "reset" || sessionChanged ? 1 : 0),
        unidentified: cursor.unidentified + unidentified,
      });
    }
    // PROJECTION `on` (phase 4): the transcript makes the bubbles. Runs over now (their
    // terminal, or this fresh read's own facts) are projected, with every run this read
    // brought rows of: a settled bubble is recomposed from its rows in the SAME message.
    let settledRuns: string[] = [];
    if (projectionOn && args.kind !== "reset") {
      const terminalRuns = args.terminals
        .slice(0, MAX_TERMINALS_PER_APPLY)
        .map((t) => t.runId)
        .filter((id) => id.length > 0 && id.length <= MAX_RUN_ID_CHARS);
      // A run whose rows this read returned and that a COMPLETE active list omits.
      // Only a list that was not cut is complete: past the bound, a run missing from it
      // may simply have been cut off.
      const absentFromActive =
        args.activeRunIds === undefined || args.activeRunIds.length > MAX_ACTIVE_RUN_IDS
          ? []
          : [...seqByRun.keys()].filter((runId) => !active.has(runId));
      const sessionIdle = args.hasActiveRun === false;
      const settledByIdle = await settleRuns(
        ctx,
        { chatId: args.chatId, sessionKey: args.sessionKey, now },
        [...terminalRuns, ...absentFromActive],
        sessionIdle,
        lastSeq,
      );
      settledRuns = settledByIdle.runs;
      const scope: ProjectionScope = {
        chatId: args.chatId,
        sessionKey: args.sessionKey,
        sessionId: effectiveSessionId,
        instanceName: args.boundInstanceName,
        floorSeq,
        gaps,
      };
      await continueUserRowsLater(ctx, scope, [], await assignUserRows(ctx, scope, rows, budget));
      await projectAll(ctx, scope, [...seqByRun.keys(), ...terminalRuns, ...settledRuns], undefined, budget);
      const released = await releaseAdmittedRuns(
        ctx,
        { chatId: args.chatId, sessionKey: args.sessionKey, instanceName: args.boundInstanceName },
        new Set([...settledRuns, ...terminalRuns]),
        sessionIdle,
        lastSeq,
      );
      // An idle read that found more open runs than one mutation marks continues the
      // marking in a scheduled step, tied to THIS read (codex phase 4 pass 2).
      if (sessionIdle && settledByIdle.more) {
        await ctx.scheduler.runAfter(0, internal.transcriptProjection.continueSettlement, {
          chatId: args.chatId,
          sessionKey: args.sessionKey,
          sessionId: effectiveSessionId,
          instanceName: args.boundInstanceName,
          readAt,
          coverSeq: lastSeq,
        });
      }
      // CU-2: the session is free — a message the person chose to QUEUE leaves now.
      if (sessionIdle || released > 0) await drainNextQueued(ctx, args.chatId);
      // A notification lost with an HTTP response is replayed: the foreground runs the
      // table holds as over are named again, whichever apply first marked them.
      const replay = await alreadySettled(ctx, args, args.foregroundRunIds ?? []);
      settledRuns = [...new Set([...settledRuns, ...replay])];
    }
    return {
      ok: true as const,
      inserted,
      updated,
      floorSeq,
      sessionChanged,
      stale: false,
      settledRuns,
    };
  },
});

/** The projection ↔ bubble measurement of one chat (invariants I1–I3), metadata only. */
export const projectionReportInternal = internalQuery({
  args: {
    chatId: v.string(),
    /** Test seam: a smaller message-read budget than PROJECTION_READ_BUDGET_BYTES. */
    readBudgetBytes: v.optional(v.number()),
  },
  handler: async (ctx, { chatId, readBudgetBytes }) => {
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return null;
    return await loadProjectionReport(ctx, id, {
      ...(readBudgetBytes === undefined ? {} : { readBudgetBytes }),
    });
  },
});
