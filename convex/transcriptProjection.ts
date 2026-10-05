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
  loadProjectionReport,
  mergeRunStatus,
  MAX_ACTIVE_RUN_IDS,
  MAX_COVERAGE_GAPS,
  MAX_ROWS_PER_APPLY,
  MAX_RUN_ID_CHARS,
  MAX_TERMINALS_PER_APPLY,
  mergeInputFact,
  sameRow,
  sanitizeRow,
  type InputFact,
  type RunStatus,
  type TranscriptRowInput,
} from "./lib/transcriptProjection";

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

/** Upsert identity rows by (chat, session key, entry id). */
async function upsertRows(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; instanceName: string; sessionKey: string; sessionId: string; now: number },
  rows: readonly TranscriptRowInput[],
): Promise<{
  inserted: number;
  updated: number;
  maxSeq: number;
  seqByRun: Map<string, { first: number; last: number }>;
}> {
  let inserted = 0;
  let updated = 0;
  let maxSeq = 0;
  const seqByRun = new Map<string, { first: number; last: number }>();
  for (const r of rows) {
    if (r.seq > maxSeq) maxSeq = r.seq;
    if (r.runId !== undefined && r.role !== "user") {
      const span = seqByRun.get(r.runId);
      seqByRun.set(r.runId, {
        first: Math.min(span?.first ?? r.seq, r.seq),
        last: Math.max(span?.last ?? r.seq, r.seq),
      });
    }
    const next = { ...r, sessionId: a.sessionId };
    const stored = await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_session_entry", (q) =>
        q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("entryId", r.entryId),
      )
      .first();
    if (stored === null) {
      await ctx.db.insert("transcriptRows", {
        chatId: a.chatId,
        instanceName: a.instanceName,
        sessionKey: a.sessionKey,
        ...next,
        updatedAt: a.now,
      });
      inserted++;
    } else if (!sameRow(stored, next)) {
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
  return { inserted, updated, maxSeq, seqByRun };
}

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
    const rows: TranscriptRowInput[] = [];
    for (const raw of args.rows.slice(0, MAX_ROWS_PER_APPLY)) {
      const row = sanitizeRow(raw);
      if (row === null) unidentified++;
      else rows.push(row);
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
    // A DIRECT row post (CU-16, phase 2): its rows and their runs, nothing else. The read
    // the same event asked for carries the session state; this never moves it.
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
        },
        rows,
      );
      const persisted = new Map<string, RunObservation[]>(
        [...res.seqByRun.keys()].map((runId) => [runId, [{ status: "persisted" as const }]]),
      );
      await upsertRuns(ctx, { chatId: args.chatId, sessionKey: args.sessionKey, now }, persisted, res.seqByRun);
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
      },
      rows,
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

    if (stale && cursor !== null) {
      await ctx.db.patch(cursor._id, {
        reads: cursor.reads + 1,
        staleReads: (cursor.staleReads ?? 0) + 1,
        unidentified: cursor.unidentified + unidentified,
      });
      return { ok: true as const, inserted, updated, floorSeq, sessionChanged: false, stale: true };
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
    return { ok: true as const, inserted, updated, floorSeq, sessionChanged, stale: false };
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
