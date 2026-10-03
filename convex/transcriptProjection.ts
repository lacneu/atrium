// THE SESSION TRANSCRIPT AS THE TRUTH — the projection's store (redesign phase 1, SHADOW).
//
// `applyTranscript` records what one `chat.history` read returned: identity rows, run
// statuses, the cursor to resume from. It is IDEMPOTENT by construction (upsert by
// entry id, sticky run statuses, a cursor that only moves forward within one gateway
// session) — replaying a read, a reconnect or a bridge restart rewrites nothing — and it
// NEVER touches a message: shadow mode measures, it does not decide. The policy lives in
// lib/transcriptProjection.ts (pure, tested); this file loads and stores.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import {
  dispatchTimeOf,
  floorForFirstRead,
  loadProjectionReport,
  mergeRunStatus,
  MAX_ACTIVE_RUN_IDS,
  MAX_COVERAGE_GAPS,
  MAX_ROWS_PER_APPLY,
  MAX_RUN_ID_CHARS,
  MAX_TERMINALS_PER_APPLY,
  sameRow,
  sanitizeRow,
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

export const applyTranscript = internalMutation({
  args: {
    chatId: v.id("chats"),
    boundInstanceName: v.string(),
    sessionKey: v.string(),
    /** The gateway transcript the read came from ("" when the reply named none). */
    sessionId: v.string(),
    kind: v.union(v.literal("page"), v.literal("delta"), v.literal("reset")),
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
    let inserted = 0;
    let updated = 0;
    let lastSeq = sessionChanged ? 0 : (cursor?.lastSeq ?? 0);
    const seqByRun = new Map<string, { first: number; last: number }>();
    for (const r of rows) {
      if (r.seq > lastSeq) lastSeq = r.seq;
      if (r.runId !== undefined && r.role !== "user") {
        const span = seqByRun.get(r.runId);
        seqByRun.set(r.runId, {
          first: Math.min(span?.first ?? r.seq, r.seq),
          last: Math.max(span?.last ?? r.seq, r.seq),
        });
      }
      const next = { ...r, sessionId: effectiveSessionId };
      const stored = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey).eq("entryId", r.entryId),
        )
        .first();
      if (stored === null) {
        await ctx.db.insert("transcriptRows", {
          chatId: args.chatId,
          instanceName: args.boundInstanceName,
          sessionKey: args.sessionKey,
          ...next,
          updatedAt: now,
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
          updatedAt: now,
        });
        updated++;
      }
    }

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
    const observations = new Map<string, Array<{ status: RunStatus; emptyFinal?: boolean; at?: number }>>();
    const observe = (runId: string, o: { status: RunStatus; emptyFinal?: boolean; at?: number }) => {
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
    for (const [runId, list] of observations) {
      const stored = await ctx.db
        .query("transcriptRuns")
        .withIndex("by_chat_session_run", (q) =>
          q.eq("chatId", args.chatId).eq("sessionKey", args.sessionKey).eq("runId", runId),
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
        span === undefined
          ? stored?.firstSeq
          : Math.min(stored?.firstSeq ?? span.first, span.first);
      const lastRunSeq =
        span === undefined ? stored?.lastSeq : Math.max(stored?.lastSeq ?? span.last, span.last);
      if (stored === null) {
        await ctx.db.insert("transcriptRuns", {
          chatId: args.chatId,
          sessionKey: args.sessionKey,
          runId,
          status: status as RunStatus,
          ...(emptyFinal === true ? { emptyFinal: true } : {}),
          ...(terminalAt === undefined ? {} : { terminalAt }),
          ...(firstSeq === undefined ? {} : { firstSeq }),
          ...(lastRunSeq === undefined ? {} : { lastSeq: lastRunSeq }),
          updatedAt: now,
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
          updatedAt: now,
        });
      }
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
