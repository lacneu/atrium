// THE SESSION TRANSCRIPT AS THE TRUTH — Convex side of the projection (redesign phase 1).
//
// Phase 1 is SHADOW: the bridge reads the gateway's `chat.history` back (cursor/delta,
// at the Control UI's own triggers) and this module records the transcript's IDENTITY
// rows beside the bubbles. Nothing here creates, edits or finalizes a bubble. What it
// adds is a MEASUREMENT: how far the bubbles Atrium built from the live stream are from
// the transcript, stated as the three invariants of the design (§4.4):
//
//   I1  every visible assistant/toolResult run of a projected session has EXACTLY ONE
//       bubble;
//   I2  after a run ended, no bubble of that run is left without a durable row;
//   I3  every user row `"<sendId>:user"` has exactly one user bubble.
//
// PHASE 2 adds two measures (still shadow, still metadata only):
//
//   I4  an ERROR CARD whose run has durable, visible assistant rows in the transcript
//       — Atrium told the person the turn failed while the gateway holds its answer
//       (the Denis case, 2026-09-30) — unless the gateway itself says that run failed;
//   G   the INPUT GUARD against Atrium's outbox: an input the gateway holds (a receipt,
//       a pending-input entry or its `<sendId>:user` row) while Atrium's outbox calls
//       the send failed or never sent, and a sent input the gateway — asked after its
//       ACK — holds no receipt for.
//
// Identity only — no text, no content: a row is (entry id, seq, role, run, send) plus
// two display facts (hidden, visible) the bridge computed with the Control UI's own
// predicates. The pure functions below are the whole policy; the mutation and the query
// in convex/transcriptProjection.ts only load and store.

import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { ATRIUM_SEND_ID_RE, sendIdsOf } from "./sendIdentity";
import type { TranscriptProjectionMode } from "./instanceConfig";
import { MAX_COMPOSED_TEXT_BYTES, utf8Bytes } from "./bubbleProjection";

/** Per-run status: the Control UI's run table (upstream
 *  packages/gateway-client/src/session-projection-run-event.ts:50-71) plus `persisted`,
 *  a run known only from its durable rows (no terminal frame observed, not active). */
export type RunStatus =
  | "streaming"
  | "completed"
  | "error"
  | "aborted"
  | "timeout"
  | "yielded"
  | "persisted";

/** The statuses a TERMINAL FRAME sets. */
export type WireTerminalStatus = "completed" | "error" | "aborted" | "timeout" | "yielded";

const WIRE_TERMINAL: ReadonlySet<RunStatus> = new Set([
  "completed",
  "error",
  "aborted",
  "timeout",
  "yielded",
]);

/** Bounds of one apply (the bridge reads pages of 80 and deltas of at most 200 events,
 *  upstream chat-history-delta.ts `CHAT_HISTORY_DELTA_MAX_EVENTS`). */
export const MAX_ROWS_PER_APPLY = 200;
export const MAX_TERMINALS_PER_APPLY = 50;
/** Coverage gaps kept per cursor (the newest; older ones are counted, not kept). */
export const MAX_COVERAGE_GAPS = 20;
/** Upstream bound of a run id inside `inputRunIds` (chat-history-constants.ts). */
export const MAX_RUN_ID_CHARS = 256;
const MAX_ENTRY_ID_CHARS = 128;
const MAX_TOOL_CALL_IDS = 32;
/** `sessionInfo.activeRunIds` kept on the cursor (upstream caps inputs at 50 too). */
export const MAX_ACTIVE_RUN_IDS = 50;

/**
 * Merge a run's status with a new observation — the upstream rule
 * (session-projection.ts `updateRun`): once a run left `streaming`, a later event never
 * changes its status (the FIRST terminal wins; only message/sequence recovery follows,
 * which this projection does not hold). `persisted` is ours: it is not a terminal frame,
 * so a terminal frame observed later still upgrades it, and a run seen streaming again
 * after its rows were read goes back to `streaming` only from `persisted`.
 *
 * Not mirrored: upstream's error→streaming resumption at a NEWER run-event seq — the
 * projection does not receive the run-event seq in phase 1.
 */
export function mergeRunStatus(prev: RunStatus | undefined, next: RunStatus): RunStatus {
  if (prev === undefined) return next;
  if (WIRE_TERMINAL.has(prev)) return prev;
  if (prev === "persisted") return next === "persisted" ? prev : next;
  // prev === "streaming"
  return next === "persisted" ? prev : next;
}

/** The incoming row shape (validated again here: the body came over the network). */
export type TranscriptRowInput = {
  entryId: string;
  seq: number;
  role: string;
  runId?: string;
  sendId?: string;
  steerTargetRunId?: string;
  mirrorOrigin?: string;
  runTerminal?: boolean;
  hidden: boolean;
  visible: boolean;
  toolCallIds?: string[];
  /** Projection `on` (phase 4): the row's display text / `sessions_yield` acknowledgment. */
  text?: string;
  yieldAck?: string;
};

/** Most a row may SAY, in UTF-8 bytes, text and acknowledgment together — ONE budget,
 *  the bridge's too (providers/openclaw/transcript-rows.ts `ROW_TEXT_MAX_BYTES`). It IS the
 *  largest text a bubble is ever composed from rows with (lib/bubbleProjection.ts
 *  `MAX_COMPOSED_TEXT_BYTES`): a row over it could never make or rewrite a bubble whatever
 *  was stored, so not storing it loses nothing the projection could show — its bubble keeps
 *  the live text (codex phase 4 pass 7: a 32 769-character answer the live frames missed
 *  had no bubble at all under the old 32 Ki-character bound). One row fits one document
 *  (1 MiB) and one apply (MAX_APPLY_TEXT_BYTES). */
export const MAX_ROW_TEXT_BYTES = MAX_COMPOSED_TEXT_BYTES;

/** What every purge and sweep of row texts may READ in one transaction, and the batch
 *  that follows from it: sized by BYTES against the worst document (a row's whole budget
 *  plus its envelope), never by a count chosen alone — codex phase 4 pass 8: 32 texts of
 *  768 KiB read 24 MiB and the batch failed, its continuation with it. ONE helper for the
 *  bubble purge, the chat purge and the service-chat sweep, so this class cannot return. */
export const TEXT_PURGE_READ_BYTES = 8 * 1024 * 1024;
export const TEXT_PURGE_BATCH = Math.max(1, Math.floor(TEXT_PURGE_READ_BYTES / (MAX_COMPOSED_TEXT_BYTES + 256)));

/** What a row keeps of what it says under MAX_ROW_TEXT_BYTES: a text over the bound is
 *  DROPPED, never cut (a cut text would be recomposed as if it were the whole reply); the
 *  acknowledgment only while it fits beside the text (it is shown only for a run with no
 *  text of its own, so beside a text it was never going to be shown). */
export function boundRowShown(
  text: unknown,
  yieldAck: unknown,
): { text?: string; yieldAck?: string } {
  const t = typeof text === "string" && utf8Bytes(text) <= MAX_ROW_TEXT_BYTES ? text : undefined;
  const a =
    typeof yieldAck === "string" && utf8Bytes(t ?? "") + utf8Bytes(yieldAck) <= MAX_ROW_TEXT_BYTES
      ? yieldAck
      : undefined;
  return { ...(t !== undefined ? { text: t } : {}), ...(a !== undefined ? { yieldAck: a } : {}) };
}

/** 32-bit FNV-1a over UTF-16 code units, seeded (two seeds make a 64-bit signature). */
function fnv1a(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The bytes a bounded step has READ so far (every document, codex phase 4 pass 14): a
 *  step hands the rest to its continuation before Convex's 16 MiB read limit. */
export type ReadMeter = { bytes: number };

/** What one document weighs on a read (its encoded size, approximated by its JSON). */
export function docReadBytes(doc: unknown): number {
  return doc === null || doc === undefined ? 0 : utf8Bytes(JSON.stringify(doc));
}

const meterAll = (meter: ReadMeter | undefined, docs: readonly unknown[]): void => {
  if (meter !== undefined) for (const d of docs) meter.bytes += docReadBytes(d);
};

/** `transcriptRows.textSig` of a row whose text was PURGED — its bubble was deleted, or its
 *  service conversation swept: the identity stays (a tombstone, so the row is never placed
 *  again), and no later read ever stores its text again (codex phase 4 pass 4). */
export const TEXT_PURGED_SIG = "purged";

/** Most tombstones / cut rows ONE read of a run takes. Past it, nothing is guessed: every
 *  reader takes the CONSERVATIVE path — the whole run is treated as deleted for its texts
 *  (purged, never stored) and never placed (codex phase 4 pass 11: cuts silently cut at 64
 *  classified a segment-65 row as segment 64 and its tombstone was missed). */
export const MAX_TOMBSTONES_READ = 1000;
export const MAX_CUTS_READ = 1000;
/** A tombstone map holding this key: the run's tombstones could not all be read — every
 *  segment counts as deleted. */
export const ALL_SEGMENTS = -1;

/** `transcriptTombstones.sessionKey` of a tombstone that holds in EVERY session of its run:
 *  a deleted USER message's run (its `sendId`), whose session the deletion cannot tell
 *  without a read — and no read may have told it yet (codex phase 4 pass 12). */
export const ANY_SESSION = "";

/**
 * A run's deletion tombstones (codex phase 4 pass 27): what was deleted is identified by a
 * STABLE boundary, never by a segment ordinal that a later read recounts. A deleted span
 * starts AFTER a cut row's `seq` (`transcriptTombstones.fromSeq`; RUN_START for the run's
 * first segment) and is OPEN-ENDED: every later segment of the run belongs to a later
 * message, which the same truncating deletion removes too. A late cut — earlier or
 * inside — never moves nor shrinks it: it can only add a boundary the span already covers.
 *  - `spans`: the boundaries stored (`fromSeq`).
 *  - the map: tombstones not yet resolved to a boundary (an answer's own, written with no
 *    read at the deletion and resolved by its follow-up), keyed by their ordinal at
 *    deletion time — read CONSERVATIVELY against the current cuts (`deletedFromOf`);
 *    `ALL_SEGMENTS`: the whole run.
 */
export class RunTombs extends Map<number, Id<"messages"> | undefined> {
  spans: Array<{ from: number; messageId?: Id<"messages"> }> = [];
  /** Any tombstone at all (resolved or not). */
  get any(): boolean {
    return this.size > 0 || this.spans.length > 0;
  }
}

/** `fromSeq` of a span covering the whole run (before its first row). */
export const RUN_START = -1;

/** The deleted segments of a run in a session (`transcriptTombstones`). Empty for nearly
 *  every run — one index range. The run's session-less tombstones count in every session;
 *  `sessionKey` undefined: those only. */
export async function tombstonedSegments(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  sessionKey: string | undefined,
  runId: string,
  meter?: ReadMeter,
): Promise<RunTombs> {
  const rows = await ctx.db
    .query("transcriptTombstones")
    .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
    .take(MAX_TOMBSTONES_READ + 1);
  meterAll(meter, rows);
  const tombs = new RunTombs();
  for (const r of rows.slice(0, MAX_TOMBSTONES_READ)) {
    if (r.sessionKey !== ANY_SESSION && r.sessionKey !== sessionKey) continue;
    if (r.fromSeq !== undefined) tombs.spans.push({ from: r.fromSeq, ...(r.messageId !== undefined ? { messageId: r.messageId } : {}) });
    else tombs.set(r.segment, r.messageId);
  }
  // Past the bound nothing is guessed: every segment counts as deleted.
  if (rows.length > MAX_TOMBSTONES_READ) tombs.set(ALL_SEGMENTS, undefined);
  return tombs;
}

/** The boundary an UNRESOLVED ordinal tombstone (segment `k` at deletion) stands for under
 *  the CURRENT cuts — conservative: cuts only get added, so the k-th boundary known now is
 *  at or before the one the segment started at; RUN_START when it cannot be told. */
export function boundaryOfOrdinal(k: number, cuts: RunCuts | null): number {
  if (k <= 0 || cuts === null || !cuts.complete || cuts.seqs.length === 0) return RUN_START;
  return cuts.seqs[Math.min(k, cuts.seqs.length) - 1]!;
}

/** Where the run's deleted part begins (rows with a greater `seq` are deleted), with the
 *  bubble the most specific span names; null when nothing of the run is deleted. */
export function deletedFromOf(
  tombs: ReadonlyMap<number, Id<"messages"> | undefined>,
  cuts: RunCuts | null,
): Array<{ from: number; messageId?: Id<"messages"> }> {
  const spans: Array<{ from: number; messageId?: Id<"messages"> }> = [];
  if (tombs instanceof RunTombs) spans.push(...tombs.spans);
  for (const [k, messageId] of tombs) {
    const from = k === ALL_SEGMENTS ? RUN_START : boundaryOfOrdinal(k, cuts);
    spans.push({ from, ...(messageId !== undefined ? { messageId } : {}) });
  }
  return spans;
}

/** A run's cuts (the `seq` of the user rows steered into it, in its session), read in ONE
 *  bounded range shared by storage, projection and every purge; `complete` false: there
 *  were more than one read takes — no row's segment can be told. */
export type RunCuts = {
  seqs: number[];
  /** The send each cut's row belongs to, aligned with `seqs` (the user message it is). */
  sends: Array<string | undefined>;
  complete: boolean;
};

export async function steerSeqsOf(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  sessionKey: string,
  runId: string,
  meter?: ReadMeter,
): Promise<RunCuts> {
  const docs = await ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_steer_target", (q) => q.eq("chatId", chatId).eq("steerTargetRunId", runId))
    .take(MAX_CUTS_READ + 1);
  meterAll(meter, docs);
  const cuts = docs
    .slice(0, MAX_CUTS_READ)
    .filter((d) => d.sessionKey === sessionKey && d.role.toLowerCase() === "user")
    .map((d) => ({ seq: d.seq, send: d.sendId ?? d.runId }))
    .sort((a, b) => a.seq - b.seq);
  return {
    seqs: cuts.map((c) => c.seq),
    sends: cuts.map((c) => c.send),
    complete: docs.length <= MAX_CUTS_READ,
  };
}

/** A row's steer segment: how many of its run's steers precede it. */
export function rowSegment(seq: number, steers: readonly number[]): number {
  let k = 0;
  for (const s of steers) if (s < seq) k++;
  return k;
}

/** A row's segment under its run's cuts, or null when the cuts could not all be read. */
export function segmentOfRow(seq: number, cuts: RunCuts): number | null {
  return cuts.complete ? rowSegment(seq, cuts.seqs) : null;
}

/** Is the row deleted? `null`: no. Otherwise the deleted bubble its span names (the most
 *  specific one: the latest boundary before the row). By STABLE boundaries (codex phase 4
 *  pass 27): a row lies in a deleted span when its `seq` is past the span's start — no
 *  ordinal is ever compared, so a late cut cannot move a row out. */
export function tombstoneHit(
  tombs: ReadonlyMap<number, Id<"messages"> | undefined>,
  cuts: RunCuts | null,
  seq: number,
): { to?: Id<"messages"> } | null {
  const spans = deletedFromOf(tombs, cuts);
  let best: { from: number; messageId?: Id<"messages"> } | null = null;
  for (const sp of spans) {
    if (seq > sp.from && (best === null || sp.from > best.from)) best = sp;
  }
  if (best === null) return null;
  return best.messageId === undefined ? {} : { to: best.messageId };
}

/** Is the CURRENT segment `k` (between its cuts) deleted, and by which bubble? It is when
 *  a deleted span reaches into it (conservative: the whole segment). */
export function segmentDeleted(
  tombs: ReadonlyMap<number, Id<"messages"> | undefined>,
  cuts: RunCuts,
  k: number,
): { to?: Id<"messages"> } | null {
  const hi = k < cuts.seqs.length ? cuts.seqs[k]! : Number.POSITIVE_INFINITY;
  // The segment's rows lie in (lo, hi): a span starting before `hi - 1` reaches it.
  return tombstoneHit(tombs, cuts, hi === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : hi - 0.5);
}

/**
 * THE GATE of every piece of transcript-text protection (tombstones, purges, refusals,
 * holds) on a path an off or shadow conversation also takes: did this conversation EVER
 * store row text? `chats.transcriptSeenAt` is set in `on` before any text (and kept after a
 * rollback, so the protection stays). Read on a chat document the caller already holds:
 * a conversation never `on` costs exactly what it did before phase 4 — no read, no write,
 * no scheduled step (codex phase 4 pass 10).
 */
export function transcriptStoredText(chat: { transcriptSeenAt?: number } | null | undefined): boolean {
  return chat?.transcriptSeenAt !== undefined;
}

/** A deleted bubble, as its deletion's follow-up needs it (identifiers only). `user`: a
 *  deleted USER message — `sends`: the send identities it carried (their runs already
 *  tombstoned), whose steers the follow-up looks up from `steerIndex`; `sendsAfter`:
 *  where the follow-up's walk of its outbox rows resumes (creation time; any send not
 *  tombstoned yet is). */
export type DeletedBubbleRef = {
  id: Id<"messages">;
  sessionKey?: string;
  runId?: string;
  user?: boolean;
  /** An answer's own tombstone, still an ordinal: resolved by the follow-up. */
  segment?: number;
  sends?: string[];
  steerIndex?: number;
  sendsAfter?: number;
};

/** Outbox rows (sends) of a deleted user message one follow-up page reads: ONE — a row
 *  carries its whole prompt, so the walk is paced by the call's byte budget. */
export const MAX_SENDS_READ = 1;

/** The segment of the run a steered user row was steered into that STARTS at its cut:
 *  one past the cuts before it (`ALL_SEGMENTS` when the run's cuts cannot all be read). */
export async function steeredSegmentOf(
  ctx: QueryCtx,
  row: { chatId: Id<"chats">; sessionKey: string; seq: number },
  targetRunId: string,
  meter?: ReadMeter,
): Promise<number> {
  const cuts = await steerSeqsOf(ctx, row.chatId, row.sessionKey, targetRunId, meter);
  return cuts.complete ? rowSegment(row.seq, cuts.seqs) + 1 : ALL_SEGMENTS;
}

/** One send of a deleted USER message: its own run, tombstoned in every session and every
 *  segment (`ANY_SESSION`). One insert, no read. */
export async function tombstoneSendRun(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  messageId: Id<"messages">,
  sendId: string,
): Promise<void> {
  await ctx.db.insert("transcriptTombstones", {
    chatId,
    sessionKey: ANY_SESSION,
    runId: sendId,
    segment: ALL_SEGMENTS,
    messageId,
    createdAt: Date.now(),
  });
}

/**
 * The STEER of a deleted user message's send, when its row is already read (codex phase
 * 4 pass 13): the segment of the run it was steered into that starts at its cut is that
 * message's answer too — tombstoned. A cut row read only later is matched by the write
 * path (`transcriptProjection` `tombstoneLateCutRows`); until the deletion's follow-up has
 * run, the projection refuses any segment whose cut's send is tombstoned (bubbleProjection-
 * Store `projectRun`). Returns the index ranges it used.
 */
export async function tombstoneSteerOf(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  messageId: Id<"messages">,
  sendId: string,
  meter?: ReadMeter,
): Promise<number> {
  const now = Date.now();
  let queries = 1;
  const rows = await ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_send", (q) => q.eq("chatId", chatId).eq("sendId", sendId))
    .take(4);
  meterAll(meter, rows);
  for (const r of rows) {
    if (r.role.toLowerCase() !== "user" || r.steerTargetRunId === undefined) continue;
    // The STABLE boundary (codex phase 4 pass 27): the span starts after this cut row's
    // own `seq` — no cut read, no ordinal. `segment` is only the purge walk's key (one per
    // cut row: `seq` is unique in the run's session).
    await ctx.db.insert("transcriptTombstones", {
      chatId,
      sessionKey: r.sessionKey,
      runId: r.steerTargetRunId,
      segment: r.seq,
      fromSeq: r.seq,
      messageId,
      createdAt: now,
    });
  }
  return queries;
}

/**
 * The tombstoning of ONE deletion (one mutation that deletes messages): `add` each deleted
 * message, `finish` once at the end (codex phase 4 passes 4–9).
 *  - GATED on stored text: only a conversation that ever stored row text (`on`, or `on`
 *    then rolled back) has anything to purge or to protect from being made again —
 *    `chats.transcriptSeenAt`, set in `on` before any text, read on the chat document the
 *    deletion already holds. Every other conversation (off, shadow: shadow stores no text
 *    and makes no bubble) costs EXACTLY what it cost before: no read, no write, nothing
 *    scheduled (codex phase 4 pass 9: one lookup per answer on top of the cascade pushed a
 *    280-turn shadow chat's deletion past 4 096 index ranges).
 *  - `add` writes the PRIMARY tombstone of an answer (its own run segment, its session):
 *    ONE insert, no index read (a duplicate tombstone is harmless — every reader keys them).
 *    A deleted USER message tombstones the WHOLE run of every send it carried (`sendId` and
 *    `priorSendIds` — a regenerate re-sends under a new one), in every session
 *    (`ANY_SESSION`): one insert each, no read. Its answer may not have a bubble yet, while
 *    the rows already stored (a text chunk ahead of its read) would make it again (codex
 *    phase 4 passes 12–13). The follow-up adds the segments its steers started and any
 *    send only its outbox rows still name, under its query budget.
 *  - `finish` schedules ONE step, ids only (`transcriptProjection.followUpDeletion`): the
 *    runs merged into every deleted answer, tombstoned under a GLOBAL bound per call, then
 *    each answer's purge. Until then a row assigned to a deleted bubble, or a run merged
 *    into one, is refused by every write path (`deletedMergeOf`, the row's `messageId`).
 */
export function deletionTombstones(
  ctx: MutationCtx,
  chat: { _id: Id<"chats">; transcriptSeenAt?: number },
) {
  const stored = transcriptStoredText(chat);
  const deleted: DeletedBubbleRef[] = [];
  return {
    async add(message: Doc<"messages">): Promise<void> {
      if (!stored) return;
      if (message.role === "user") {
        const sends = sendIdsOf(message);
        for (const sendId of sends) await tombstoneSendRun(ctx, chat._id, message._id, sendId);
        deleted.push({
          id: message._id,
          user: true,
          ...(message.sendId !== undefined ? { runId: message.sendId } : {}),
          sends,
          sendsAfter: 0,
        });
        return;
      }
      if (message.role !== "assistant") return;
      if (message.turnSessionKey !== undefined && message.runId !== undefined) {
        await ctx.db.insert("transcriptTombstones", {
          chatId: chat._id,
          sessionKey: message.turnSessionKey,
          runId: message.runId,
          segment: message.runSegment ?? 0,
          messageId: message._id,
          createdAt: Date.now(),
        });
      }
      deleted.push({
        id: message._id,
        ...(message.turnSessionKey !== undefined ? { sessionKey: message.turnSessionKey } : {}),
        ...(message.runId !== undefined ? { runId: message.runId } : {}),
        // Its tombstone is written as an ORDINAL here (no read); the follow-up resolves it
        // to the stable boundary (codex phase 4 pass 27).
        ...(message.turnSessionKey !== undefined && message.runId !== undefined
          ? { segment: message.runSegment ?? 0 }
          : {}),
      });
    },
    async finish(): Promise<void> {
      if (deleted.length === 0) return;
      await ctx.scheduler.runAfter(0, internal.transcriptProjection.followUpDeletion, {
        chatId: chat._id,
        deleted: deleted.splice(0),
        index: 0,
        after: null,
      });
    },
  };
}

/** One deleted message, alone (a retry's replaced card), with its chat already in hand. */
export async function tombstoneDeletedBubble(
  ctx: MutationCtx,
  message: Doc<"messages">,
  chat: { _id: Id<"chats">; transcriptSeenAt?: number },
): Promise<void> {
  if (!transcriptStoredText(chat)) return;
  const t = deletionTombstones(ctx, chat);
  await t.add(message);
  await t.finish();
}

/** The purge of a deleted bubble's rows, scheduled only when its conversation holds rows
 *  that could have said something (assigned to it, or of its session). */
export async function schedulePurgeIfAny(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  bubble: DeletedBubbleRef,
  meter?: ReadMeter,
): Promise<boolean> {
  const assigned = await ctx.db
    .query("transcriptRows")
    .withIndex("by_message_seq", (q) => q.eq("messageId", bubble.id))
    .first();
  meterAll(meter, [assigned]);
  const sessionKey = bubble.sessionKey;
  // A deleted USER message always left tombstones (its sends' runs, its steers' segments):
  // the purge walks them, whatever their session.
  const ofSession =
    assigned !== null || bubble.user === true || sessionKey === undefined
      ? null
      : await ctx.db
          .query("transcriptRows")
          .withIndex("by_chat_session_entry", (q) => q.eq("chatId", chatId).eq("sessionKey", sessionKey))
          .first();
  meterAll(meter, [ofSession]);
  if (assigned === null && ofSession === null && bubble.user !== true) return false;
  await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeDeletedBubbleTexts, {
    chatId,
    messageId: bubble.id,
  });
  return true;
}

/** One run segment of a deleted bubble: its tombstone, once. */
export async function insertTombstone(
  ctx: MutationCtx,
  message: { _id: Id<"messages">; chatId: Id<"chats"> },
  sessionKey: string,
  runId: string,
  segment: number,
  meter?: ReadMeter,
): Promise<void> {
  const known = await tombstonedSegments(ctx, message.chatId, sessionKey, runId, meter);
  // A run merged into a deleted bubble (segment 0): deleted from its start — a STABLE
  // boundary (codex phase 4 pass 27).
  const from = segment === 0 ? RUN_START : undefined;
  if (from !== undefined ? known.spans.some((sp) => sp.from === from) : known.has(segment)) return;
  await ctx.db.insert("transcriptTombstones", {
    chatId: message.chatId,
    sessionKey,
    runId,
    segment,
    ...(from !== undefined ? { fromSeq: from } : {}),
    messageId: message._id,
    createdAt: Date.now(),
  });
}

/** Merges of a deleted bubble one read takes. */
export const TOMBSTONE_MERGE_PAGE = 50;
/** Index queries one `followUpDeletion` call may spend (a GLOBAL bound, whatever the
 *  number of answers the deletion removed), and purges it may schedule. */
export const FOLLOW_UP_QUERY_BUDGET = 600;
export const FOLLOW_UP_PURGES_PER_CALL = 50;
/** Bytes one `followUpDeletion` call may READ — every document, outbox rows (a prompt up
 *  to a document's 1 MiB) included. Checked before each step; no step reads more than
 *  ~2 MiB, so a call stays far under Convex's 16 MiB (codex phase 4 pass 14). */
export const FOLLOW_UP_BYTE_BUDGET = 8 * 1024 * 1024;

/** Is this run segment one whose bubble a person deleted — by its tombstone, or by a merge
 *  record pointing at a bubble that no longer exists? Asked before ANY live bubble is
 *  opened or merged into, in every mode (codex phase 4 pass 7). */
export async function deletedRunSegment(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  sessionKey: string | undefined,
  runId: string,
  segment: number,
): Promise<boolean> {
  const tombs = await tombstonedSegments(ctx, chatId, sessionKey, runId);
  if (tombs.any) {
    // By STABLE boundaries against the current cuts (codex phase 4 pass 27). Without a
    // session the cuts cannot be read: any tombstone of the run counts (conservative).
    if (sessionKey === undefined) return true;
    const cuts = await steerSeqsOf(ctx, chatId, sessionKey, runId);
    // The live door names the segment by the BRIDGE's count, which a late, earlier cut
    // makes stale: a steered segment (k ≥ 1) may really start at any later cut, so it is
    // deleted as soon as any span of the run is (spans are open-ended). The run's first
    // segment ends at the first cut known now (never later than its real end).
    if (segment === 0 ? segmentDeleted(tombs, cuts, 0) !== null : tombstoneHit(tombs, cuts, Number.MAX_SAFE_INTEGER) !== null) {
      return true;
    }
  }
  return (await deletedMergeOf(ctx, chatId, runId)) !== null;
}

/** A bubble left no content to purge (an empty bubble dropped at its terminal): only the
 *  rows already assigned to it are marked, no segment is tombstoned — a later row of its
 *  run may still have something to show (CU-21 removes an EMPTY bubble, not the run). */
export async function purgeRowTextsOfMessage(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  chatId: Id<"chats">,
): Promise<void> {
  const shown = await ctx.db
    .query("transcriptRows")
    .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
    .first();
  if (shown === null) return;
  await ctx.scheduler.runAfter(0, internal.transcriptProjection.purgeDeletedBubbleTexts, {
    chatId,
    messageId,
  });
}

/** Delete one row's text and mark its identity purged. True when something was purged. */
export async function purgeRowText(
  ctx: MutationCtx,
  row: { _id: Id<"transcriptRows">; textSig?: string },
): Promise<boolean> {
  // EVERY document of the row first, whatever its mark says — idempotent, and a purged
  // mark never shields a copy left behind (codex phase 4 pass 6: five copies of one row,
  // four deleted, the mark set, the fifth kept forever). One per row by construction now;
  // the loop is what makes the purge true even for a deployment that holds more.
  let deleted = 0;
  for (;;) {
    // Two at a time: one per row by construction, so this reads one document (a batch is
    // sized by TEXT_PURGE_BATCH against exactly that).
    const docs = await ctx.db
      .query("transcriptRowTexts")
      .withIndex("by_row", (q) => q.eq("rowId", row._id))
      .take(2);
    for (const d of docs) await ctx.db.delete(d._id);
    deleted += docs.length;
    if (docs.length < 2) break;
  }
  if (row.textSig === TEXT_PURGED_SIG) return deleted > 0;
  await ctx.db.patch(row._id, { textSig: TEXT_PURGED_SIG });
  return true;
}

/** While a deletion's tombstoning still paginates the merges of the deleted bubble, a run
 *  merged into a bubble that no longer exists is already refused: the bubble it pointed at
 *  (codex phase 4 pass 6). `runBubbles` records outlive their bubble on purpose. */
export async function deletedMergeOf(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  runId: string,
): Promise<Id<"messages"> | null> {
  const merges = await ctx.db
    .query("runBubbles")
    .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
    .take(4);
  for (const m of merges) if ((await ctx.db.get(m.messageId)) === null) return m.messageId;
  return null;
}

/** The signature of what a row shows (`transcriptRows.textSig`): compared on upsert so a
 *  replayed read never has to load the text document to know nothing changed. Undefined
 *  when the row carries neither a text nor an acknowledgment (nothing known). */
export function rowTextSignature(text: string | undefined, yieldAck: string | undefined): string | undefined {
  if (text === undefined && yieldAck === undefined) return undefined;
  const body = JSON.stringify([text ?? null, yieldAck ?? null]);
  return `${body.length}:${fnv1a(body, 0x811c9dc5)}${fnv1a(body, 0x050c5d1f)}`;
}

const boundedId = (x: unknown, max: number): string | undefined =>
  typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined;

/** Keep a row only when it is identified (entry id + positive integer seq) and every
 *  identity it carries fits the upstream bounds; null drops it (counted unidentified). */
export function sanitizeRow(raw: TranscriptRowInput): TranscriptRowInput | null {
  const entryId = boundedId(raw.entryId, MAX_ENTRY_ID_CHARS);
  if (entryId === undefined) return null;
  if (!Number.isSafeInteger(raw.seq) || raw.seq <= 0) return null;
  const role = boundedId(raw.role, 32);
  if (role === undefined) return null;
  const runId = boundedId(raw.runId, MAX_RUN_ID_CHARS);
  const sendId = boundedId(raw.sendId, MAX_RUN_ID_CHARS);
  const steerTargetRunId = boundedId(raw.steerTargetRunId, MAX_RUN_ID_CHARS);
  const mirrorOrigin = boundedId(raw.mirrorOrigin, 64);
  const toolCallIds = Array.isArray(raw.toolCallIds)
    ? raw.toolCallIds
        .filter((id): id is string => boundedId(id, MAX_RUN_ID_CHARS) !== undefined)
        .slice(0, MAX_TOOL_CALL_IDS)
    : [];
  return {
    entryId,
    seq: raw.seq,
    role,
    ...(runId === undefined ? {} : { runId }),
    ...(sendId === undefined ? {} : { sendId }),
    ...(steerTargetRunId === undefined ? {} : { steerTargetRunId }),
    ...(mirrorOrigin === undefined ? {} : { mirrorOrigin }),
    ...(raw.runTerminal === true ? { runTerminal: true } : {}),
    hidden: raw.hidden === true,
    visible: raw.visible === true,
    ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
    ...boundRowShown(raw.text, raw.yieldAck),
  };
}

/**
 * The FLOOR of a session's first projected read (design §10.2): rows at or below it are
 * already shown by legacy bubbles and are never compared.
 *
 * Refined from the design's "largest seq present at the first read": in phase 1 the
 * first read happens at the END of the first turn sent under the projection (there is
 * no session-open trigger before phase 2), so "everything present" would put that very
 * turn under the floor and measure nothing. The floor is therefore placed just below the
 * first user row whose send Atrium can PROVE it made under this release (its `sendId` is
 * stamped on an outbox row); with no such row, at the largest seq read (nothing in the
 * page belongs to a projected send).
 */
export function floorForFirstRead(
  rows: ReadonlyArray<Pick<TranscriptRowInput, "seq" | "role" | "sendId">>,
  knownSend: (sendId: string) => boolean,
): number {
  let firstKnown: number | null = null;
  let max = 0;
  for (const r of rows) {
    if (r.seq > max) max = r.seq;
    if (r.role === "user" && r.sendId !== undefined && knownSend(r.sendId)) {
      if (firstKnown === null || r.seq < firstKnown) firstKnown = r.seq;
    }
  }
  return firstKnown === null ? max : firstKnown - 1;
}

// ── The input guard (phase 2): what the gateway says it holds ──────────────────────────

/** Upstream bounds of one read's guard facts (chat-history-constants.ts / logs-chat.ts). */
export const MAX_INPUT_RUN_IDS = 50;
export const MAX_PENDING_INPUT_ITEMS = 20;

export type PendingInputState = "queued" | "cancelled" | "interrupted";

/** What ONE read says about ONE send identity. */
export type InputObservation = {
  sendId: string;
  asked: boolean;
  receipt?: { state: "pending" | "consumed"; queued?: boolean; cancelled?: boolean };
  pending?: { state: PendingInputState; queued?: boolean };
  absent?: boolean;
  /** The reply carried a receipt for it that could not be interpreted. */
  unreadable?: boolean;
};

/** The stored fact (convex/schema.ts `transcriptInputs`), minus its keys. */
export type InputFact = {
  receipt?: "pending" | "consumed";
  receiptQueued?: boolean;
  receiptCancelled?: boolean;
  pendingState?: PendingInputState;
  pendingQueued?: boolean;
  askedAt?: number;
  absentAt?: number;
  /** HISTORICAL: when a read first proved the gateway received it (receipt or pending
   *  entry). Never cleared — unlike `pendingState`, which is the CURRENT custody. */
  heldAt?: number;
  /** CURRENT: the last read's receipt for it could not be interpreted (protocol drift).
   *  Cleared by the next readable receipt or a proven absence. */
  receiptUnreadable?: boolean;
};

/** Collect one read's guard facts per send, sanitized and bounded (the body came over the
 *  network). A send named nowhere is absent from the map. */
export function collectInputObservations(args: {
  inputRunIds?: readonly string[];
  pendingInputs?: {
    items: ReadonlyArray<{ runId?: string; state: string; queued?: boolean }>;
    complete?: boolean;
  };
  inputReceipts?: ReadonlyArray<{ runId: string; state: string; queued?: boolean; cancelled?: boolean }>;
  inputAbsent?: readonly string[];
  inputUnreadable?: readonly string[];
}): Map<string, InputObservation> {
  const out = new Map<string, InputObservation>();
  const ok = (id: unknown): id is string =>
    typeof id === "string" && id.length > 0 && id.length <= MAX_RUN_ID_CHARS;
  const get = (sendId: string): InputObservation => {
    let o = out.get(sendId);
    if (o === undefined) {
      o = { sendId, asked: false };
      out.set(sendId, o);
    }
    return o;
  };
  for (const id of (args.inputRunIds ?? []).slice(0, MAX_INPUT_RUN_IDS)) if (ok(id)) get(id).asked = true;
  for (const r of (args.inputReceipts ?? []).slice(0, MAX_INPUT_RUN_IDS)) {
    if (!ok(r.runId) || (r.state !== "pending" && r.state !== "consumed")) continue;
    get(r.runId).receipt = {
      state: r.state,
      ...(r.queued === true ? { queued: true } : {}),
      ...(r.cancelled === true ? { cancelled: true } : {}),
    };
  }
  for (const item of (args.pendingInputs?.items ?? []).slice(0, MAX_PENDING_INPUT_ITEMS)) {
    if (!ok(item.runId)) continue;
    if (item.state !== "queued" && item.state !== "cancelled" && item.state !== "interrupted") continue;
    get(item.runId).pending = { state: item.state, ...(item.queued === true ? { queued: true } : {}) };
  }
  for (const id of (args.inputAbsent ?? []).slice(0, MAX_INPUT_RUN_IDS)) {
    // Absence is only meaningful for a send this very read asked about.
    const o = ok(id) ? out.get(id) : undefined;
    if (o?.asked === true && o.receipt === undefined && o.pending === undefined) o.absent = true;
  }
  for (const id of (args.inputUnreadable ?? []).slice(0, MAX_INPUT_RUN_IDS)) {
    const o = ok(id) ? out.get(id) : undefined;
    if (o?.asked === true && o.receipt === undefined) {
      o.unreadable = true;
      // Observed: an uninterpretable receipt is never an absence.
      o.absent = undefined;
    }
  }
  return out;
}

// ── THE CUSTODY STATE MODEL (phase 2, review pass 4) ──────────────────────────────────
//
// Two separate things are recorded per send, and must never be confused:
//
//   HISTORICAL — did the gateway EVER hold this input? `heldAt` (first receipt or pending
//     entry seen), the sticky `consumed` receipt, `absentAt`. Never cleared: once proven,
//     a re-execution of the input is a re-execution (G `retriedWhileHeld`, retryOutcome).
//
//   CURRENT — what the gateway's custody is NOW: `pendingState` (the pending-input item's
//     state), `pendingQueued` / `receiptQueued` (the explicit "waits in the gateway's own
//     queue" flags), `receiptCancelled`. Replaced by every AUTHORITATIVE read: a
//     consumed or cancelled receipt, a proven absence, or a complete pending list that
//     no longer names the input. A partial list proves nothing (the report qualifies).
//
// "Queued at the gateway" is read ONLY from the explicit flags. `state:"queued"` on a
// pending item is the custody state of an ACCEPTED input, not the gateway queue: 2026.9.7
// added `queued: Type.Optional(Type.Literal(true))` on items and receipts, plus
// `queuedCount` (packages/gateway-protocol/src/schema/logs-chat.ts
// `ChatPendingInputsPageSchema` / `ChatInputReceiptsSchema` at v2026.9.7/v2026.9.8;
// absent at v2026.9.6 and v2026.8.2, where no reply can say it). The captured 9.8 reply
// (bridge/test/fixtures/session-events-2026.9.8.json) carries `state:"queued"` with
// `queuedCount: 0` and no flag. So on 9.6 nothing ever counts as queued.

export type InputEvent =
  | { kind: "asked" }
  | { kind: "pendingItem"; state: PendingInputState; queued: boolean }
  | { kind: "receipt"; state: "pending" | "consumed"; queued: boolean; cancelled: boolean }
  /** Asked after its ACK, the gateway answered no receipt and no pending item. */
  | { kind: "absent" }
  /** A COMPLETE pending-input list did not name it. */
  | { kind: "listMissing" }
  /** A PARTIAL pending-input list did not name it: proves nothing. */
  | { kind: "partialList" }
  /** The reply carried a receipt for it Atrium could not interpret: observed, unproven. */
  | { kind: "receiptUnreadable" };

/** Every CURRENT custody field cleared; history kept. */
function clearCurrent(f: InputFact): InputFact {
  return {
    ...f,
    pendingState: undefined,
    pendingQueued: undefined,
    receiptQueued: undefined,
  };
}

/** THE transition function. PURE; every custody write goes through it. */
export function applyInputEvent(prev: InputFact, ev: InputEvent, at: number): InputFact {
  const held = (f: InputFact): InputFact => (f.heldAt === undefined ? { ...f, heldAt: at } : f);
  switch (ev.kind) {
    case "asked":
      return prev.askedAt === undefined ? { ...prev, askedAt: at } : prev;
    case "pendingItem":
      // A newer item observation is AUTHORITATIVE for current custody: it also replaces
      // the receipt-derived queued flag (a reread may return the item without asking for
      // its receipt again). History stays.
      return held({
        ...prev,
        pendingState: ev.state,
        pendingQueued: ev.queued ? true : undefined,
        receiptQueued: undefined,
      });
    case "receipt": {
      const readable = { ...prev, receiptUnreadable: undefined };
      if (ev.state === "consumed") {
        // Consumed: in no queue, never again pending (sticky).
        return held({ ...clearCurrent(readable), receipt: "consumed", receiptCancelled: undefined });
      }
      if (prev.receipt === "consumed") return held(readable);
      if (ev.cancelled) {
        return held({ ...clearCurrent(readable), receipt: "pending", receiptCancelled: true });
      }
      return held({
        ...readable,
        receipt: "pending",
        receiptQueued: ev.queued ? true : undefined,
        receiptCancelled: undefined,
      });
    }
    case "absent":
      return { ...clearCurrent(prev), receiptUnreadable: undefined, absentAt: prev.absentAt ?? at };
    case "receiptUnreadable":
      return { ...prev, receiptUnreadable: true };
    case "listMissing":
      return clearCurrent(prev);
    case "partialList":
      return prev;
  }
}

/** One read's observation as events, in the order a read proves them: the ask, the
 *  receipt, then the pending item (which states the current custody precisely), then a
 *  proven absence (only when neither a receipt nor an item named it). */
export function mergeInputFact(prev: InputFact | null, o: InputObservation, at: number): InputFact {
  let f: InputFact = { ...(prev ?? {}) };
  if (o.asked) f = applyInputEvent(f, { kind: "asked" }, at);
  if (o.receipt !== undefined) {
    f = applyInputEvent(
      f,
      {
        kind: "receipt",
        state: o.receipt.state,
        queued: o.receipt.queued === true,
        cancelled: o.receipt.cancelled === true,
      },
      at,
    );
  }
  if (o.pending !== undefined) {
    f = applyInputEvent(
      f,
      { kind: "pendingItem", state: o.pending.state, queued: o.pending.queued === true },
      at,
    );
  }
  if (o.absent === true && o.receipt === undefined && o.pending === undefined) {
    f = applyInputEvent(f, { kind: "absent" }, at);
  }
  if (o.unreadable === true && o.receipt === undefined) {
    f = applyInputEvent(f, { kind: "receiptUnreadable" }, at);
  }
  return f;
}

/** The CURRENT custody a complete pending-input list no longer names is gone. */
export function clearCurrentPending(f: InputFact, at: number): InputFact {
  return applyInputEvent(f, { kind: "listMissing" }, at);
}

/** CURRENT custody, as the gateway states it now. `queued` only from the explicit flags. */
export function currentCustody(f: InputFact): "none" | "pending" | "queued" {
  if (f.pendingQueued === true) return "queued";
  if (f.receipt === "pending" && f.receiptQueued === true && f.receiptCancelled !== true) {
    return "queued";
  }
  if (f.pendingState === "queued" || f.pendingState === "interrupted") return "pending";
  if (f.receipt === "pending" && f.receiptCancelled !== true && f.absentAt === undefined) {
    return "pending";
  }
  return "none";
}

/** Did the gateway, at any point, hold this input? HISTORICAL — the ONE definition, used
 *  by G and by the retry evidence alike. */
export function gatewayHeldInput(f: InputFact): boolean {
  return f.heldAt !== undefined || f.receipt !== undefined || f.pendingState !== undefined;
}

/** Is this row one a bubble must exist for (I1)? */
export function rowNeedsBubble(r: Pick<TranscriptRowInput, "role" | "hidden" | "visible">): boolean {
  if (r.hidden) return false;
  // Roles arrive LOWER-CASED (upstream readSessionMessageIdentity compares them so).
  const role = r.role.toLowerCase();
  if (role === "toolresult") return true;
  return role === "assistant" && r.visible;
}

// ── The measurement ────────────────────────────────────────────────────────────────────

export type ProjectionRow = {
  sessionKey: string;
  sessionId: string;
  seq: number;
  role: string;
  runId?: string;
  sendId?: string;
  steerTargetRunId?: string;
  hidden: boolean;
  visible: boolean;
};

export type ProjectionBubble = {
  messageId: string;
  /** The runs whose output this bubble shows: its `runId` and every run merged into it. */
  runIds: string[];
  status: "streaming" | "complete" | "error" | "aborted";
  hasText: boolean;
  /** The reconciler has read the transcript since this bubble last changed, and none of
   *  its runs was active then — only such a bubble can be judged (I2). */
  settled: boolean;
  /** Written while a COVERAGE GAP was open (rows no read returned): its rows may be in
   *  the hole, so it is not judged by I2. */
  inCoverageGap?: boolean;
};

export type SendResolution =
  /** An outbox row carries the send; `bubbleCount` = user bubbles stamped with it,
   *  `headBubble` = the outbox row's own user message still exists. */
  | { kind: "atrium"; headBubble: boolean; bubbleCount: number; internal: boolean }
  /** No outbox row. */
  | { kind: "unknown" }
  /** The lookup did not run (the read budget was spent): nothing is known either way. */
  | { kind: "unmeasured" };

const SAMPLE = 20;

export type ProjectionGaps = {
  i1: {
    visibleRuns: number;
    transcriptOnly: number;
    duplicated: number;
    unattributedRows: number;
    /** Visible runs whose bubble lookup did not run (read budget spent). */
    unmeasuredRuns: number;
    samples: Array<{ runId: string; firstSeq: number; bubbles: number }>;
  };
  i2: {
    judged: number;
    /** Bubbles still streaming, or changed since the last read that returned rows. */
    unsettled: number;
    /** Bubbles naming no run at all: nothing to look their rows up by. */
    unattributedBubbles: number;
    /** Bubbles written while a coverage gap was open: not judged. */
    inCoverageGap: number;
    /** Bubbles whose run's durable rows lie outside the window and whose bounded
     *  lookup ended before finding one: absence is not proven, so they are not judged. */
    unmeasuredBubbles: number;
    bubbleWithoutRow: number;
    errorCardWithoutRow: number;
    samples: Array<{ messageId: string; runId: string; status: string; hasText: boolean }>;
  };
  i4: {
    /** Settled error cards (status `error`) of the window whose runs have durable,
     *  visible ASSISTANT rows — the ones I4 judges. */
    judged: number;
    /** GAP: the gateway holds the answer and does not say the run failed. */
    errorCardWithAnswer: number;
    /** The gateway's own run status is `error`/`timeout`: the card is its verdict. */
    errorCardRunFailed: number;
    /** Error cards whose answer lookup was cut by its bound: not judged. */
    unmeasured: number;
    samples: Array<{ messageId: string; runId: string; runStatus: string | null }>;
  };
  guard: {
    /** Atrium sends of the measured sessions the gateway was asked about. */
    inputs: number;
    /** The gateway holds or held it (a receipt, a pending-input entry, its user row). */
    held: number;
    queuedAtGateway: number;
    interrupted: number;
    cancelled: number;
    /** Inputs whose send is not Atrium's (no outbox row in this chat). */
    foreignInputs: number;
    /** GAP: the gateway holds it while Atrium's outbox says the send FAILED (a retry
     *  would execute it twice). */
    heldButFailed: number;
    /** GAP: the gateway holds it while Atrium's outbox never dispatched it. */
    heldButQueuedLocal: number;
    /** GAP: the outbox says sent, the gateway — asked after the ACK — had no receipt,
     *  and no user row of it was ever read. */
    sentButAbsent: number;
    /** GAP: Atrium auto-retried a message whose earlier send the gateway HOLDS — the
     *  same input submitted twice (design §4.4 I4, the double execution of 2026-09-30). */
    retriedWhileHeld: number;
    /** An auto-retry of a held input passed the last gate, and nothing proves whether the
     *  gateway accepted it: neither counted as a re-execution nor as clean. */
    retryOutcomeUnknown: number;
    /** Dispatched Atrium sends (outbox sent/failed) the gateway has NOT confirmed either
     *  way after their ACK: no receipt, no pending entry, no durable user row, no proven
     *  absence (e.g. only a read issued before the ACK asked about them). Unmeasured. */
    custodyUnconfirmed: number;
    /** Inputs whose last receipt could not be interpreted (protocol drift): unproven. */
    receiptUnreadable: number;
    /** Inputs with a current pending state in a session whose last pending-input list was
     *  partial: that state may be stale. */
    pendingUnconfirmed: number;
    /** The dispatch is still in flight (outbox `pending`): nothing to judge yet. */
    unsettled: number;
    /** The outbox lookup did not run (read budget spent). */
    unmeasured: number;
    samples: Array<{ send: string; kind: string; outbox: string }>;
  };
  i3: {
    userRows: number;
    /** User rows carrying no send key: no send to verify them against. */
    unattributedUserRows: number;
    /** User rows whose send lookup did not run (read budget spent). */
    unmeasuredSends: number;
    missingBubble: number;
    duplicated: number;
    unmatchedAtriumSend: number;
    internalSends: number;
    foreignInputs: number;
    steeredInputs: number;
    samples: Array<{ seq: number; kind: string; bubbles: number }>;
  };
};

/**
 * The invariants, measured. PURE: every input is an identity the loader read through an
 * index; the same inputs always give the same verdict (property-tested).
 */
export function assessProjection(input: {
  rows: readonly ProjectionRow[];
  /** Bubbles (by message id) that show a run's output: `messages.runId` + `runBubbles`. */
  /** null ⇔ the lookup did not run (the read budget was spent). */
  bubblesForRun: (runId: string) => ReadonlySet<string> | null;
  bubbles: readonly ProjectionBubble[];
  resolveSend: (sendId: string) => SendResolution;
  /** A run with durable visible rows OUTSIDE the measured window (below the row bound),
   *  which still counts as durable for I2. Absent ⇒ none. */
  runHasRowsOutsideWindow?: (runId: string) => boolean;
  /** A run whose bounded lookup outside the window was cut before it found a durable
   *  row: neither found nor proven absent. Absent ⇒ none. */
  runRowsUnmeasured?: (runId: string) => boolean;
  /** A run with a durable visible ASSISTANT row outside the window (I4). */
  runAnsweredOutsideWindow?: (runId: string) => boolean;
  /** A run whose answer lookup was cut by its bound (I4 unmeasured). */
  runAnswerUnmeasured?: (runId: string) => boolean;
  /** The gateway's status of a run (`transcriptRuns`), null when none is recorded. */
  runStatus?: (runId: string) => RunStatus | null;
  /** The input guard facts of the measured sessions (G). */
  guardInputs?: readonly GuardInput[];
  /** Sessions whose last read carried a PARTIAL pending-input list (more than a page). */
  partialPendingSessions?: ReadonlySet<string>;
}): ProjectionGaps {
  const gaps: ProjectionGaps = {
    i1: {
      visibleRuns: 0,
      transcriptOnly: 0,
      duplicated: 0,
      unattributedRows: 0,
      unmeasuredRuns: 0,
      samples: [],
    },
    i2: {
      judged: 0,
      unsettled: 0,
      unattributedBubbles: 0,
      inCoverageGap: 0,
      unmeasuredBubbles: 0,
      bubbleWithoutRow: 0,
      errorCardWithoutRow: 0,
      samples: [],
    },
    i4: { judged: 0, errorCardWithAnswer: 0, errorCardRunFailed: 0, unmeasured: 0, samples: [] },
    guard: {
      inputs: 0,
      held: 0,
      queuedAtGateway: 0,
      interrupted: 0,
      cancelled: 0,
      foreignInputs: 0,
      heldButFailed: 0,
      heldButQueuedLocal: 0,
      sentButAbsent: 0,
      retriedWhileHeld: 0,
      retryOutcomeUnknown: 0,
      custodyUnconfirmed: 0,
      receiptUnreadable: 0,
      pendingUnconfirmed: 0,
      unsettled: 0,
      unmeasured: 0,
      samples: [],
    },
    i3: {
      userRows: 0,
      unattributedUserRows: 0,
      unmeasuredSends: 0,
      missingBubble: 0,
      duplicated: 0,
      unmatchedAtriumSend: 0,
      internalSends: 0,
      foreignInputs: 0,
      steeredInputs: 0,
      samples: [],
    },
  };

  // One row per transcript position: a row read twice (a replayed page, overlapping
  // reads) is the same row, and the measurement must not count it twice.
  const seen = new Set<string>();
  const rows = input.rows.filter((r) => {
    const key = `${r.sessionKey}\u0000${r.sessionId}\u0000${r.seq}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // I1 — per visible run. (I4 needs the runs with a visible ASSISTANT row: an answer.)
  const firstSeqByRun = new Map<string, number>();
  const answeredRuns = new Set<string>();
  for (const r of rows) {
    if (r.runId !== undefined && !r.hidden && r.visible && r.role.toLowerCase() === "assistant") {
      answeredRuns.add(r.runId);
    }
    if (!rowNeedsBubble(r)) continue;
    if (r.runId === undefined) {
      gaps.i1.unattributedRows++;
      continue;
    }
    const prev = firstSeqByRun.get(r.runId);
    if (prev === undefined || r.seq < prev) firstSeqByRun.set(r.runId, r.seq);
  }
  const visibleRuns = new Set(firstSeqByRun.keys());
  for (const [runId, firstSeq] of [...firstSeqByRun.entries()].sort((a, b) => a[1] - b[1])) {
    gaps.i1.visibleRuns++;
    const found = input.bubblesForRun(runId);
    if (found === null) {
      gaps.i1.unmeasuredRuns++;
      continue;
    }
    const bubbles = found.size;
    if (bubbles === 1) continue;
    if (bubbles === 0) gaps.i1.transcriptOnly++;
    else gaps.i1.duplicated++;
    if (gaps.i1.samples.length < SAMPLE) gaps.i1.samples.push({ runId, firstSeq, bubbles });
  }

  // I2 — per settled bubble.
  for (const b of input.bubbles) {
    if (b.runIds.length === 0) {
      gaps.i2.unattributedBubbles++;
      continue;
    }
    if (b.status === "streaming") {
      gaps.i2.unsettled++;
      continue;
    }
    if (!b.settled) {
      gaps.i2.unsettled++;
      continue;
    }
    if (b.inCoverageGap === true) {
      gaps.i2.inCoverageGap++;
      continue;
    }
    const durable = b.runIds.some(
      (id) => visibleRuns.has(id) || input.runHasRowsOutsideWindow?.(id) === true,
    );
    // A lookup cut by its bound proves nothing: never "no durable row" from it.
    if (!durable && b.runIds.some((id) => input.runRowsUnmeasured?.(id) === true)) {
      gaps.i2.unmeasuredBubbles++;
      continue;
    }
    gaps.i2.judged++;
    if (durable) {
      // I4 — an error card over a run the transcript ANSWERED.
      if (b.status === "error") {
        const answered = b.runIds.filter(
          (id) => answeredRuns.has(id) || input.runAnsweredOutsideWindow?.(id) === true,
        );
        if (answered.length === 0) {
          if (b.runIds.some((id) => input.runAnswerUnmeasured?.(id) === true)) gaps.i4.unmeasured++;
        } else {
          gaps.i4.judged++;
          const statuses = answered.map((id) => input.runStatus?.(id) ?? null);
          if (statuses.some((st) => st === "error" || st === "timeout")) {
            gaps.i4.errorCardRunFailed++;
          } else {
            gaps.i4.errorCardWithAnswer++;
            if (gaps.i4.samples.length < SAMPLE) {
              gaps.i4.samples.push({
                messageId: b.messageId,
                runId: answered[0] as string,
                runStatus: statuses[0] ?? null,
              });
            }
          }
        }
      }
      continue;
    }
    if (b.status === "error" || b.status === "aborted") gaps.i2.errorCardWithoutRow++;
    else gaps.i2.bubbleWithoutRow++;
    if (gaps.i2.samples.length < SAMPLE) {
      gaps.i2.samples.push({
        messageId: b.messageId,
        runId: b.runIds[0] as string,
        status: b.status,
        hasText: b.hasText,
      });
    }
  }

  // I3 — per user row carrying a send key.
  for (const r of rows) {
    if (r.role !== "user") continue;
    if (r.sendId === undefined) {
      gaps.i3.unattributedUserRows++;
      continue;
    }
    gaps.i3.userRows++;
    if (r.steerTargetRunId !== undefined) gaps.i3.steeredInputs++;
    const res = input.resolveSend(r.sendId);
    let kind: string | null = null;
    let bubbles = 0;
    if (res.kind === "unmeasured") {
      gaps.i3.unmeasuredSends++;
      continue;
    }
    if (res.kind === "unknown") {
      if (ATRIUM_SEND_ID_RE.test(r.sendId)) {
        gaps.i3.unmatchedAtriumSend++;
        kind = "unmatched_atrium_send";
      } else {
        gaps.i3.foreignInputs++;
      }
    } else if (res.internal) {
      // Atrium's own hidden work (summaries, conversions…) sends without a user bubble.
      gaps.i3.internalSends++;
    } else {
      bubbles = res.bubbleCount;
      if (!res.headBubble) {
        gaps.i3.missingBubble++;
        kind = "missing_bubble";
      } else if (bubbles > 1) {
        gaps.i3.duplicated++;
        kind = "duplicated";
      }
    }
    if (kind !== null && gaps.i3.samples.length < SAMPLE) {
      gaps.i3.samples.push({ seq: r.seq, kind, bubbles });
    }
  }

  // G — the input guard against Atrium's outbox.
  for (const g of input.guardInputs ?? []) {
    if (g.outbox === "unmeasured") {
      gaps.guard.unmeasured++;
      continue;
    }
    if (g.outbox === "unknown") {
      gaps.guard.foreignInputs++;
      continue;
    }
    gaps.guard.inputs++;
    const held = gatewayHeldInput(g.fact) || g.userRow;
    if (held) gaps.guard.held++;
    // CURRENT custody (the state model above): queued only from the explicit flags.
    const now = currentCustody(g.fact);
    if (now === "queued") gaps.guard.queuedAtGateway++;
    // A current custody the last read could not confirm (its pending list was a partial
    // page): reported, never trusted as now.
    const hasCurrentFlags =
      g.fact.pendingState !== undefined || g.fact.pendingQueued === true || g.fact.receiptQueued === true;
    if (hasCurrentFlags && input.partialPendingSessions?.has(g.sessionKey) === true) {
      gaps.guard.pendingUnconfirmed++;
    }
    if (g.fact.receiptUnreadable === true) gaps.guard.receiptUnreadable++;
    if (g.fact.pendingState === "interrupted") gaps.guard.interrupted++;
    if (g.fact.pendingState === "cancelled" || g.fact.receiptCancelled === true) gaps.guard.cancelled++;
    let kind: string | null = null;
    if (held && g.retryUnknown === true && g.retriedAfter !== true) {
      // A retry passed the last gate, and nothing says whether the gateway got it.
      gaps.guard.retryOutcomeUnknown++;
    }
    if (held && g.retriedAfter === true) {
      // Whatever this row's own status says: the input reached the gateway, and a later
      // auto-retry of the same message sent it again.
      gaps.guard.retriedWhileHeld++;
      if (gaps.guard.samples.length < SAMPLE) {
        gaps.guard.samples.push({ send: g.sendId.slice(-12), kind: "retried_while_held", outbox: g.outbox.status });
      }
      continue;
    }
    if (g.outbox.status === "pending") {
      gaps.guard.unsettled++;
      continue;
    }
    if (held && g.outbox.status === "failed") {
      gaps.guard.heldButFailed++;
      kind = "held_but_failed";
    } else if (held && g.outbox.status === "queued") {
      gaps.guard.heldButQueuedLocal++;
      kind = "held_but_queued_local";
    } else if (
      !held &&
      g.fact.absentAt === undefined &&
      (g.outbox.status === "sent" || g.outbox.status === "failed")
    ) {
      // Neither proof nor disproof: never `consistent` on it.
      gaps.guard.custodyUnconfirmed++;
    } else if (!held && g.fact.absentAt !== undefined && g.outbox.status === "sent") {
      gaps.guard.sentButAbsent++;
      kind = "sent_but_absent";
    }
    if (kind !== null && gaps.guard.samples.length < SAMPLE) {
      gaps.guard.samples.push({ send: g.sendId.slice(-12), kind, outbox: g.outbox.status });
    }
  }
  return gaps;
}

/** One send of the measured sessions, with what the gateway said and what Atrium's outbox
 *  says (G). `unknown`: no outbox row of this chat; `unmeasured`: not looked up. */
export type GuardInput = {
  sendId: string;
  sessionKey: string;
  fact: InputFact;
  /** A `<sendId>:user` row of this chat was read. */
  userRow: boolean;
  outbox: { status: "queued" | "pending" | "sent" | "failed" } | "unknown" | "unmeasured";
  /** A LATER auto-retry outbox row of the same user message exists. */
  retriedAfter?: boolean;
  /** A later auto-retry passed the last gate but its acceptance is not proven. */
  retryUnknown?: boolean;
};

/**
 * Every reason a measurement can be INCOMPLETE — something in scope that it could not
 * see or could not verify. ONE list, ONE predicate: `consistent` is returned only when
 * none applies (`projectionVerdict`). A counter added to the report without a reason
 * here would let a measurement that verified nothing read as clean — the defect this
 * list exists to make impossible (four review passes found one each).
 */
export const INCOMPLETENESS_REASONS = [
  "sessions_truncated",
  "rows_truncated",
  "bubbles_truncated",
  "coverage_gaps",
  "coverage_gaps_evicted",
  "boundary_unproven",
  "unidentified_rows",
  "unattributed_rows",
  "unattributed_user_rows",
  "unattributed_bubbles",
  "unsettled_bubbles",
  "bubbles_in_coverage_gap",
  "read_budget_exhausted",
  "unmeasured_runs",
  "unmeasured_bubbles",
  "unmeasured_sends",
  "unmeasured_error_cards",
  "unmeasured_inputs",
  "unproven_retries",
  "pending_inputs_partial",
  "unconfirmed_inputs",
  "pending_cleanup_in_progress",
  "guard_receipt_unreadable",
  "unsettled_inputs",
  "inputs_truncated",
] as const;
export type IncompletenessReason = (typeof INCOMPLETENESS_REASONS)[number];

export type CompletenessFacts = {
  sessionsTruncated: boolean;
  rowsTruncated: boolean;
  bubblesTruncated: boolean;
  coverageGaps: number;
  coverageGapsEvicted: number;
  boundaryUnproven: boolean;
  unidentifiedRows: number;
  readBudgetExhausted: boolean;
  /** More guard inputs than the report reads: the oldest were not measured. */
  inputsTruncated: boolean;
  /** A complete pending list's cleanup is still running for a measured session. */
  pendingCleanupInProgress: boolean;
  gaps: ProjectionGaps;
};

/** The reasons that apply, in the registry's order. PURE. */
export function incompletenessReasons(f: CompletenessFacts): IncompletenessReason[] {
  const applies: Record<IncompletenessReason, boolean> = {
    sessions_truncated: f.sessionsTruncated,
    rows_truncated: f.rowsTruncated,
    bubbles_truncated: f.bubblesTruncated,
    coverage_gaps: f.coverageGaps > 0,
    coverage_gaps_evicted: f.coverageGapsEvicted > 0,
    boundary_unproven: f.boundaryUnproven,
    unidentified_rows: f.unidentifiedRows > 0,
    unattributed_rows: f.gaps.i1.unattributedRows > 0,
    unattributed_user_rows: f.gaps.i3.unattributedUserRows > 0,
    unattributed_bubbles: f.gaps.i2.unattributedBubbles > 0,
    unsettled_bubbles: f.gaps.i2.unsettled > 0,
    bubbles_in_coverage_gap: f.gaps.i2.inCoverageGap > 0,
    read_budget_exhausted: f.readBudgetExhausted,
    unmeasured_runs: f.gaps.i1.unmeasuredRuns > 0,
    unmeasured_bubbles: f.gaps.i2.unmeasuredBubbles > 0,
    unmeasured_sends: f.gaps.i3.unmeasuredSends > 0,
    unmeasured_error_cards: f.gaps.i4.unmeasured > 0,
    unmeasured_inputs: f.gaps.guard.unmeasured > 0,
    unproven_retries: f.gaps.guard.retryOutcomeUnknown > 0,
    pending_inputs_partial: f.gaps.guard.pendingUnconfirmed > 0,
    unconfirmed_inputs: f.gaps.guard.custodyUnconfirmed > 0,
    pending_cleanup_in_progress: f.pendingCleanupInProgress,
    guard_receipt_unreadable: f.gaps.guard.receiptUnreadable > 0,
    unsettled_inputs: f.gaps.guard.unsettled > 0,
    inputs_truncated: f.inputsTruncated,
  };
  return INCOMPLETENESS_REASONS.filter((r) => applies[r]);
}

/** THE verdict, from the gaps found and what could not be measured. */
export function projectionVerdict(
  total: number,
  reasons: readonly IncompletenessReason[],
): "gaps" | "consistent_in_window" | "consistent" {
  if (total > 0) return "gaps";
  return reasons.length > 0 ? "consistent_in_window" : "consistent";
}

export function gapTotal(g: ProjectionGaps): number {
  return (
    g.i1.transcriptOnly +
    g.i1.duplicated +
    g.i2.bubbleWithoutRow +
    g.i3.missingBubble +
    g.i3.duplicated +
    g.i3.unmatchedAtriumSend +
    g.i4.errorCardWithAnswer +
    g.guard.heldButFailed +
    g.guard.heldButQueuedLocal +
    g.guard.sentButAbsent +
    g.guard.retriedWhileHeld
  );
}

/** When a send LEFT for the gateway: the last gate's stamp, else the moment it entered
 *  `pending` (the dispatch window), else — a row older than both fields — its creation. A
 *  queued send is created long before it is dispatched, so creation alone would pull the
 *  previous session's bubbles into the window. */
export function dispatchTimeOf(o: {
  dispatchedAt?: number;
  pendingSince?: number;
  _creationTime: number;
}): number {
  return o.dispatchedAt ?? o.pendingSince ?? o._creationTime;
}

// ── Loaders (indexed, bounded) ─────────────────────────────────────────────────────────

/** What a dispatch carries about the projection: the switch and where the session's
 *  last read stopped (null cursor ⇒ the bridge reads a fresh tail page). */
export async function transcriptRoutingFor(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  args: { mode: TranscriptProjectionMode; sessionKey: string },
): Promise<{
  mode: TranscriptProjectionMode;
  sessionKey: string;
  cursor: { sessionId: string; deltaCursor: string } | null;
}> {
  const doc = await ctx.db
    .query("transcriptCursors")
    .withIndex("by_chat_session", (q) => q.eq("chatId", chatId).eq("sessionKey", args.sessionKey))
    .first();
  return {
    mode: args.mode,
    sessionKey: args.sessionKey,
    cursor:
      doc !== null && doc.deltaCursor !== undefined
        ? { sessionId: doc.sessionId, deltaCursor: doc.deltaCursor }
        : null,
  };
}

/** Bounds of one measurement. */
const MAX_SESSIONS = 10;
export const MAX_ROWS_PER_SESSION = 600;
export const MAX_BUBBLES = 200;
const MAX_ROWS_PER_RUN_LOOKUP = 50;
/**
 * What is PROVEN about an auto-retry row's execution. `autoRetryTurn` inserts the row
 * `pending` before its session reset (which can fail with no `chat.send`), and
 * `lastGateBeforeSend` stamps `sentToInstance` / `sendId` / `dispatchedAt` BEFORE the
 * bridge sends — a dispatch can still die after the gate (bridge unreachable, the send
 * deadline). So only the GATEWAY's acceptance proves a re-execution:
 *   - the row marked `sent` (the bridge's `/send` returned, i.e. `chat.send` was ACKed —
 *     convex/bridge.ts markOutbox; or outboxReconcile saw the late turn);
 *   - a durable `<sendId>:user` row of the retry's send identity;
 *   - a receipt / pending input the gateway reported for that identity.
 * Gate-stamped without any of these: `unknown` (never a gap, an incompleteness reason).
 * Neither: `none` — it never left.
 */
export function retryOutcome(
  o: { status: string; dispatchedAt?: number; sentToInstance?: string },
  evidence: { userRow: boolean; gatewayHeld: boolean },
): "accepted" | "unknown" | "none" {
  if (o.status === "sent" || evidence.userRow || evidence.gatewayHeld) return "accepted";
  if (o.dispatchedAt !== undefined || o.sentToInstance !== undefined) return "unknown";
  return "none";
}

/** Guard inputs one report reads (the newest; one more is read so a cut is KNOWN). */
export const MAX_GUARD_INPUTS = 100;
/** Outbox rows read for dispatched-send candidates (newest dispatch first). */
const MAX_OUTBOX_CANDIDATES = 100;
/** Outbox rows of one user message read for its auto-retries (a retry chain is ≤ 2). */
const MAX_RETRY_SIBLINGS = 10;

export type ProjectionReport = {
  mode: TranscriptProjectionMode | null;
  /** `not_projected`: no session of this chat was ever read back.
   *  `consistent_in_window`: no gap in the measured window, but the window did NOT cover
   *  everything above the floor (`window.truncated`) — never an unqualified "consistent". */
  verdict: "not_projected" | "consistent" | "consistent_in_window" | "gaps";
  gapTotal: number;
  sessions: Array<{
    /** A short digest of the gateway session key (the key names a person's canonical). */
    session: string;
    sessionId: string;
    floorSeq: number;
    lastSeq: number | null;
    /** Rows measured: the NEWEST rows above the floor, at most MAX_ROWS_PER_SESSION. */
    rowsInWindow: number;
    /** More rows than the window holds sit above the floor: the oldest were not measured. */
    rowsTruncated: boolean;
    /** The oldest seq measured (floorSeq + 1 when nothing was cut). */
    windowStartSeq: number;
    /** Holes no read returned, inside the window (seq ranges). */
    coverageGaps: Array<{ fromSeq: number; toSeq: number }>;
    /** The bubble boundary rests on a proven dispatch. */
    boundaryProven: boolean;
    reads: number;
    resets: number;
    unidentified: number;
    lastKind: "page" | "delta" | "reset";
    hasActiveRun: boolean | null;
    updatedAt: number;
  }>;
  runs: { total: number; byStatus: Record<string, number> };
  /** What the measurement covered. `truncated` ⇔ rows, bubbles or sessions were cut;
   *  `coverageGaps` = holes no read returned inside the window; `boundaryUnproven` =
   *  a session's bubble boundary rests on a read time, not a proven dispatch.
   *  `qualified` ⇔ any of them: the verdict is then never an unqualified `consistent`. */
  window: {
    truncated: boolean;
    rowsTruncated: boolean;
    bubblesTruncated: boolean;
    /** More projected sessions than the report reads: the least recently read were not measured. */
    sessionsTruncated: boolean;
    /** The byte budget for message reads was spent: some lookups did not run. */
    readBudgetExhausted: boolean;
    coverageGaps: number;
    boundaryUnproven: boolean;
    /** Why the measurement is incomplete (INCOMPLETENESS_REASONS); empty ⇔ complete. */
    incompleteReasons: IncompletenessReason[];
    qualified: boolean;
  };
  gaps: ProjectionGaps | null;
};

/** FNV-1a — a disambiguator for display, not a security primitive. */
function shortDigest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Load every identity the measurement needs, through indexes, bounded. */
/** The bytes of MESSAGES one report may read. Convex caps a function's reads (16 MiB);
 *  a conversation of large replies would otherwise make the measurement — and the
 *  `diagnose_chat` it rides — fail outright. Well under the cap, leaving room for the
 *  small identity tables and for the one document that crosses the line. */
export const PROJECTION_READ_BUDGET_BYTES = 6 * 1024 * 1024;

/** UTF-8 byte length of a string, computed without encoding it (no buffer the size of
 *  a large reply). A lone surrogate counts 3 bytes, as its U+FFFD replacement does. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A running count of the message bytes a report read: the UTF-8 size of the document
 *  as JSON. `.length` counts UTF-16 code units and undercounts CJK text three times,
 *  which would let a 6 MiB budget read past the 16 MiB cap. Once spent, every further
 *  message lookup is skipped and counted unmeasured. */
class ReadBudget {
  used = 0;
  exhausted = false;
  constructor(private readonly limit: number) {}
  charge(doc: unknown): void {
    this.used += utf8ByteLength(JSON.stringify(doc));
    if (this.used >= this.limit) this.exhausted = true;
  }
}

export async function loadProjectionReport(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  opts: { readBudgetBytes?: number } = {},
): Promise<ProjectionReport> {
  const budget = new ReadBudget(opts.readBudgetBytes ?? PROJECTION_READ_BUDGET_BYTES);
  const chat = await ctx.db.get(chatId);
  // The MOST RECENTLY read sessions (a per-turn routed chat opens one per agent
  // segment): the newest are the ones a report is about. One more than the bound is read
  // so a cut is KNOWN and qualifies the verdict.
  const cursorsPlus = await ctx.db
    .query("transcriptCursors")
    .withIndex("by_chat_updated", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(MAX_SESSIONS + 1);
  const sessionsTruncated = cursorsPlus.length > MAX_SESSIONS;
  const cursors = cursorsPlus.slice(0, MAX_SESSIONS);
  // The instance whose switch applies: the chat's own, else (a per-turn routed chat
  // names none) the one whose bridge wrote the projected reads.
  const instanceName = chat?.instanceName ?? cursors[0]?.instanceName ?? null;
  const instance =
    instanceName === null
      ? null
      : await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", instanceName))
          .first();
  const mode = instance?.config?.transcriptProjection ?? (instance === null ? null : "off");
  const runs = await ctx.db
    .query("transcriptRuns")
    .withIndex("by_chat_run", (q) => q.eq("chatId", chatId))
    .take(1000);
  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  if (cursors.length === 0) {
    return {
      mode,
      verdict: "not_projected",
      gapTotal: 0,
      sessions: [],
      runs: { total: runs.length, byStatus },
      window: {
        truncated: false,
        rowsTruncated: false,
        bubblesTruncated: false,
        sessionsTruncated: false,
        readBudgetExhausted: false,
        coverageGaps: 0,
        boundaryUnproven: false,
        incompleteReasons: [],
        qualified: false,
      },
      gaps: null,
    };
  }
  // ONE ALIGNED RECENT WINDOW. Rows are read NEWEST FIRST per session (the index is
  // (chat, key, session, seq)), so a long conversation measures its latest turns — the
  // ones a report is about — and never stops at its oldest ones. Bubbles are judged
  // only inside the same window: from the dispatch of the OLDEST send whose user row
  // the window holds (transcript order of user rows is the order their sends were
  // dispatched), so a bubble whose rows fell out of the window is never called
  // row-less (I2) and a row in the window is never compared with a bubble set that
  // stopped short of it.
  const rows: ProjectionRow[] = [];
  const sessions: ProjectionReport["sessions"] = [];
  /** Per session key: bubbles created at or after this instant are in the window. */
  const bubbleBoundary = new Map<string, number>();
  let rowsTruncated = false;
  let coverageGaps = 0;
  let coverageGapsEvicted = 0;
  let unidentifiedRows = 0;
  let boundaryUnproven = false;
  /** Per session key: the time spans during which a coverage hole was open. */
  const gapSpans = new Map<string, Array<{ sinceAt: number; detectedAt: number }>>();
  for (const c of cursors) {
    const newest = await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_session_seq", (q) =>
        q
          .eq("chatId", chatId)
          .eq("sessionKey", c.sessionKey)
          .eq("sessionId", c.sessionId)
          .gt("seq", c.floorSeq),
      )
      .order("desc")
      .take(MAX_ROWS_PER_SESSION + 1);
    const truncated = newest.length > MAX_ROWS_PER_SESSION;
    const inWindow = truncated ? newest.slice(0, MAX_ROWS_PER_SESSION) : newest;
    rowsTruncated ||= truncated;
    for (const r of inWindow) {
      rows.push({
        sessionKey: r.sessionKey,
        sessionId: r.sessionId,
        seq: r.seq,
        role: r.role,
        ...(r.runId === undefined ? {} : { runId: r.runId }),
        ...(r.sendId === undefined ? {} : { sendId: r.sendId }),
        ...(r.steerTargetRunId === undefined ? {} : { steerTargetRunId: r.steerTargetRunId }),
        hidden: r.hidden,
        visible: r.visible,
      });
    }
    const windowStartSeq = truncated
      ? Math.min(...inWindow.map((r) => r.seq))
      : c.floorSeq + 1;
    if (!truncated) {
      bubbleBoundary.set(c.sessionKey, c.floorAt);
    } else {
      // The oldest user row of the window whose send Atrium dispatched: its outbox row's
      // creation bounds the bubbles. None ⇒ no bubble of this session can be placed in
      // the window by identity, so none is judged (no false I2), and the report says so.
      let boundary = Number.POSITIVE_INFINITY;
      const users = inWindow.filter((r) => r.role === "user" && r.sendId !== undefined);
      for (const u of users.sort((a, b) => a.seq - b.seq)) {
        const sendId = u.sendId as string;
        const ob = await ctx.db
          .query("outbox")
          .withIndex("by_send_id", (q) => q.eq("sendId", sendId))
          .first();
        if (ob !== null && ob.chatId === chatId) {
          boundary = dispatchTimeOf(ob);
          break;
        }
      }
      bubbleBoundary.set(c.sessionKey, Math.max(boundary, c.floorAt));
    }
    const holes = (c.gaps ?? []).filter((g) => g.toSeq >= windowStartSeq && g.fromSeq > c.floorSeq);
    coverageGaps += holes.length;
    gapSpans.set(
      c.sessionKey,
      holes.map((g) => ({ sinceAt: g.sinceAt, detectedAt: g.detectedAt })),
    );
    coverageGapsEvicted += c.gapsDropped ?? 0;
    unidentifiedRows += c.unidentified;
    const proven = c.floorAtProven ?? true;
    boundaryUnproven ||= !proven;
    sessions.push({
      session: shortDigest(c.sessionKey),
      sessionId: c.sessionId,
      floorSeq: c.floorSeq,
      lastSeq: c.lastSeq ?? null,
      rowsInWindow: inWindow.length,
      rowsTruncated: truncated,
      windowStartSeq,
      coverageGaps: holes.map((g) => ({ fromSeq: g.fromSeq, toSeq: g.toSeq })),
      boundaryProven: proven,
      reads: c.reads,
      resets: c.resets,
      unidentified: c.unidentified,
      lastKind: c.lastKind,
      hasActiveRun: c.hasActiveRun ?? null,
      updatedAt: c.updatedAt,
    });
  }

  // Bubbles of the window, newest first, bounded. One more than the bound is read so a
  // cut is KNOWN: if the oldest bubble read is still inside some session's window, the
  // bubbles were truncated and the verdict cannot be unqualified.
  const projectedKeys = new Set(cursors.map((c) => c.sessionKey));
  const cursorByKey = new Map(cursors.map((c) => [c.sessionKey, c] as const));
  const earliestBoundary = Math.min(...bubbleBoundary.values());
  // Read newest first, ONE document at a time, and stop as soon as the window is passed,
  // the count bound is reached or the byte budget is spent — a cut that leaves window
  // bubbles unread is a truncation the verdict states.
  const recent: Doc<"messages">[] = [];
  let bubblesTruncated = false;
  for await (const m of ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")) {
    if (m._creationTime < earliestBoundary) break;
    if (recent.length >= MAX_BUBBLES || budget.exhausted) {
      bubblesTruncated = true;
      break;
    }
    budget.charge(m);
    recent.push(m);
  }
  const bubbles: ProjectionBubble[] = [];
  // A bubble's FIRST run is the send that opened it: a delivery merged into it later
  // rotates `messages.runId` to the delivery run and never restores it (stream.ts
  // reopenParentForAnnounce), so the turn's own run is read back from its dispatch.
  const sendOfOutbox = new Map<string, string | null>();
  const dispatchSend = async (outboxId: string | undefined): Promise<string | null> => {
    if (outboxId === undefined) return null;
    if (sendOfOutbox.has(outboxId)) return sendOfOutbox.get(outboxId) ?? null;
    const id = ctx.db.normalizeId("outbox", outboxId);
    const row = id === null ? null : await ctx.db.get(id);
    const sendId = row?.sendId ?? null;
    sendOfOutbox.set(outboxId, sendId);
    return sendId;
  };
  for (const m of recent) {
    if (m.role !== "assistant") continue;
    if (m.turnSessionKey === undefined || !projectedKeys.has(m.turnSessionKey)) continue;
    const boundary = bubbleBoundary.get(m.turnSessionKey);
    if (boundary === undefined || m._creationTime < boundary) continue;
    const opened = await dispatchSend(m.dispatchOutboxId);
    const runIds = [
      ...(opened === null ? [] : [opened]),
      ...(m.runId === undefined ? [] : [m.runId]),
      ...(m.mergedAnnounceRuns ?? []),
    ];
    const cursor = cursorByKey.get(m.turnSessionKey);
    const active = new Set(cursor?.activeRunIds ?? []);
    // Written (created or last changed) while a hole was open: its rows may be in it.
    const inCoverageGap = (gapSpans.get(m.turnSessionKey) ?? []).some(
      (g) => m.updatedAt >= g.sinceAt && m._creationTime <= g.detectedAt,
    );
    bubbles.push({
      messageId: m._id,
      runIds: [...new Set(runIds)],
      status: m.status,
      hasText: m.text.trim().length > 0,
      // Judged only once a read that RETURNED ROWS landed after the bubble's last change:
      // `coveredAt` does not move on a reset (or a failed recovery after one), when
      // `updatedAt` does.
      settled:
        cursor !== undefined &&
        (cursor.coveredAt ?? cursor.updatedAt) >= m.updatedAt &&
        !runIds.some((id) => active.has(id)),
      ...(inCoverageGap ? { inCoverageGap: true } : {}),
    });
  }

  // Run → bubbles (messages.runId + runBubbles), memoized.
  const bubbleCache = new Map<string, Set<string> | null>();
  const runsNeeded = new Set<string>();
  for (const r of rows) if (r.runId !== undefined && rowNeedsBubble(r)) runsNeeded.add(r.runId);
  for (const runId of runsNeeded) {
    if (budget.exhausted) {
      // Not looked up: unmeasured, never "no bubble".
      bubbleCache.set(runId, null);
      continue;
    }
    const set = new Set<string>();
    // Set when a bound or the budget stopped the lookup while more could exist: what was
    // found is then a floor, never the count.
    let interrupted = false;
    let seen = 0;
    for await (const m of ctx.db
      .query("messages")
      .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))) {
      if (seen === 10 || budget.exhausted) {
        interrupted = true;
        break;
      }
      seen++;
      budget.charge(m);
      // A run cut at a steered input (phase 3, CU-20) is ONE bubble in several segments:
      // the segments after the first (`runSegment`) are the same run's continuation.
      if (m.role === "assistant" && m.runSegment === undefined) set.add(m._id);
    }
    const mergedPlus = await ctx.db
      .query("runBubbles")
      .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
      .take(11);
    if (mergedPlus.length > 10) interrupted = true;
    // A record can outlive its bubble (a deleted or regenerated message does not purge
    // `runBubbles`): only a bubble that still EXISTS in this chat counts.
    for (const b of mergedPlus.slice(0, 10)) {
      if (set.has(b.messageId)) continue;
      if (budget.exhausted) {
        interrupted = true;
        break;
      }
      const m = await ctx.db.get(b.messageId);
      if (m !== null) budget.charge(m);
      if (m !== null && m.chatId === chatId && m.role === "assistant") set.add(m._id);
    }
    // The run of a SEND (its key): the bubble its dispatch opened, whatever run the
    // bubble names now (see `dispatchSend` above).
    const outbox = await ctx.db
      .query("outbox")
      .withIndex("by_send_id", (q) => q.eq("sendId", runId))
      .first();
    if (outbox !== null && outbox.chatId === chatId) {
      let opened = 0;
      for await (const m of ctx.db
        .query("messages")
        .withIndex("by_dispatch_outbox", (q) => q.eq("dispatchOutboxId", String(outbox._id)))) {
        if (opened === 10 || budget.exhausted) {
          interrupted = true;
          break;
        }
        opened++;
        budget.charge(m);
        if (m.role === "assistant" && m.chatId === chatId && m.runSegment === undefined) {
          set.add(m._id);
        }
      }
    }
    // One bubble found proves the run HAS a bubble, not that it has only one: a cut
    // lookup that found fewer than two is unmeasured. Two or more is a duplicate however
    // the lookup ended.
    bubbleCache.set(runId, interrupted && set.size < 2 ? null : set);
  }
  // Rows of a bubble's run that fall outside the measured window (beyond the row bound)
  // still count as durable: look them up by run for the bubbles being judged.
  // Newest first: a run's visible reply is normally its last row. A lookup that reaches
  // its bound without finding one proves nothing — the run is unmeasured, never row-less.
  const outsideWindow = new Set<string>();
  const outsideUnmeasured = new Set<string>();
  /** Runs with a visible ASSISTANT row outside the window (I4: the transcript answered). */
  const outsideAnswered = new Set<string>();
  /** Runs whose answer lookup was cut by its bound (I4: neither found nor disproven). */
  const answerUnmeasured = new Set<string>();
  const isAnswer = (r: { role: string; hidden: boolean; visible: boolean }) =>
    !r.hidden && r.visible && r.role.toLowerCase() === "assistant";
  for (const b of bubbles) {
    if (!b.settled || b.status === "streaming") continue;
    // An error card is also judged by I4, which needs an ANSWER row, not just any
    // durable one: its lookup continues past tool results to the bound.
    const wantsAnswer = b.status === "error";
    for (const runId of b.runIds) {
      if (runsNeeded.has(runId) && !wantsAnswer) continue;
      if (outsideAnswered.has(runId) || outsideUnmeasured.has(runId)) continue;
      if (outsideWindow.has(runId) && !wantsAnswer) continue;
      let seen = 0;
      for await (const r of ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
        .order("desc")) {
        if (seen === MAX_ROWS_PER_RUN_LOOKUP) {
          if (!runsNeeded.has(runId) && !outsideWindow.has(runId)) outsideUnmeasured.add(runId);
          // Cut before an answer was found: I4 cannot say this card has none.
          if (wantsAnswer) answerUnmeasured.add(runId);
          break;
        }
        seen++;
        if (rowNeedsBubble(r) && !runsNeeded.has(runId)) outsideWindow.add(runId);
        if (isAnswer(r)) {
          outsideAnswered.add(runId);
          break;
        }
        if (!wantsAnswer && outsideWindow.has(runId)) break;
      }
    }
  }
  // The gateway's status of the runs I4 judges (one indexed lookup per run).
  const runStatusCache = new Map<string, RunStatus | null>();
  for (const b of bubbles) {
    if (b.status !== "error") continue;
    for (const runId of b.runIds) {
      if (runStatusCache.has(runId)) continue;
      const doc = await ctx.db
        .query("transcriptRuns")
        .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
        .first();
      runStatusCache.set(runId, doc?.status ?? null);
    }
  }

  // G — the input guard of the measured sessions, newest first, bounded. Candidates are
  // the sends the gateway was asked about (`transcriptInputs`) AND every send whose
  // durable `<sendId>:user` row the window holds: a read that started before the send was
  // registered asked nothing about it, yet the row it returned is the gateway's proof of
  // custody all the same — and the bridge then retires the send without any fact row.
  const inputsPlus = await ctx.db
    .query("transcriptInputs")
    .withIndex("by_chat_updated", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(MAX_GUARD_INPUTS + 1);
  let inputsTruncated = inputsPlus.length > MAX_GUARD_INPUTS;
  const candidates = new Map<
    string,
    { fact: InputFact; userRow: boolean | null; sessionKey: string }
  >();
  for (const doc of inputsPlus.slice(0, MAX_GUARD_INPUTS)) {
    if (!projectedKeys.has(doc.sessionKey)) continue;
    candidates.set(doc.sendId, {
      fact: {
        receipt: doc.receipt,
        receiptQueued: doc.receiptQueued,
        receiptCancelled: doc.receiptCancelled,
        pendingState: doc.pendingState,
        pendingQueued: doc.pendingQueued,
        askedAt: doc.askedAt,
        absentAt: doc.absentAt,
        heldAt: doc.heldAt,
        receiptUnreadable: doc.receiptUnreadable,
      },
      userRow: null,
      sessionKey: doc.sessionKey,
    });
  }
  // `rows` is newest first per session: the most recent sends are kept when bounded.
  for (const r of rows) {
    if (r.role !== "user" || r.sendId === undefined) continue;
    const known = candidates.get(r.sendId);
    if (known !== undefined) {
      known.userRow = true;
      continue;
    }
    if (candidates.size >= MAX_GUARD_INPUTS) {
      inputsTruncated = true;
      continue;
    }
    candidates.set(r.sendId, { fact: {}, userRow: true, sessionKey: r.sessionKey });
  }
  /** One candidate, measured: what the gateway said, what the outbox says. */
  const measureCandidate = async (
    sendId: string,
    c: { fact: InputFact; userRow: boolean | null; sessionKey: string },
  ): Promise<GuardInput> => {
    const fact = c.fact;
    const sessionKey = c.sessionKey;
    const userRow =
      c.userRow ??
      (
        await ctx.db
          .query("transcriptRows")
          .withIndex("by_chat_send", (q) => q.eq("chatId", chatId).eq("sendId", sendId))
          .take(5)
      ).some((r) => r.role === "user");
    if (budget.exhausted) {
      return { sendId, sessionKey, fact, userRow, outbox: "unmeasured" };
    }
    const ob = await ctx.db
      .query("outbox")
      .withIndex("by_send_id", (q) => q.eq("sendId", sendId))
      .first();
    // Charged whoever it belongs to: it was read.
    if (ob !== null) budget.charge(ob);
    if (ob === null || ob.chatId !== chatId) {
      return { sendId, sessionKey, fact, userRow, outbox: "unknown" };
    }
    // A later, DISPATCHED auto-retry of the same user message (convex/turnRetry.ts inserts
    // it with the message's id and a higher `autoRetryAttempt`). Read ONE document at a
    // time, newest first, charged as it is read: a conversation of large messages
    // regenerated several times must not load a page past the budget. A lookup cut by
    // the bound or the budget proves nothing either way: unmeasured.
    let retriedAfter = false;
    let retryUnknown = false;
    let interrupted = false;
    const messageId = ob.messageId;
    if (messageId !== undefined && budget.exhausted) {
      // The send's own row may have spent the budget: the attempts query is never
      // opened past it (an async iteration fetches ahead of the loop body).
      interrupted = true;
    } else if (messageId !== undefined) {
      let seen = 0;
      for await (const sibling of ctx.db
        .query("outbox")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .order("desc")) {
        if (sibling._id === ob._id) continue;
        if (seen === MAX_RETRY_SIBLINGS || budget.exhausted) {
          interrupted = true;
          break;
        }
        seen++;
        budget.charge(sibling);
        if (
          sibling._creationTime > ob._creationTime &&
          (sibling.autoRetryAttempt ?? 0) > (ob.autoRetryAttempt ?? 0)
        ) {
          const retrySend = sibling.sendId;
          let userRowOfRetry = false;
          let heldRetry = false;
          if (sibling.status !== "sent" && retrySend !== undefined) {
            userRowOfRetry = (
              await ctx.db
                .query("transcriptRows")
                .withIndex("by_chat_send", (q) => q.eq("chatId", chatId).eq("sendId", retrySend))
                .take(5)
            ).some((r) => r.role === "user");
            if (!userRowOfRetry) {
              const fact = await ctx.db
                .query("transcriptInputs")
                .withIndex("by_chat_send", (q) => q.eq("chatId", chatId).eq("sendId", retrySend))
                .first();
              // The same HISTORICAL definition as G: a retry the gateway held once (even
              // one a later complete list no longer names) was accepted.
              heldRetry =
                fact !== null &&
                gatewayHeldInput({
                  receipt: fact.receipt,
                  pendingState: fact.pendingState,
                  heldAt: fact.heldAt,
                });
            }
          }
          const outcome = retryOutcome(sibling, { userRow: userRowOfRetry, gatewayHeld: heldRetry });
          if (outcome === "accepted") {
            retriedAfter = true;
            break;
          }
          if (outcome === "unknown") retryUnknown = true;
        }
      }
    }
    if (interrupted && !retriedAfter) {
      return { sendId, sessionKey, fact, userRow, outbox: "unmeasured" };
    }
    return {
      sendId,
      sessionKey,
      fact,
      userRow,
      outbox: { status: ob.status },
      retriedAfter,
      ...(retryUnknown ? { retryUnknown } : {}),
    };
    };
  const guardInputs: GuardInput[] = [];
  // The observed candidates first — before the dispatched-send scan below spends any of
  // the byte budget on rows that may add nothing.
  for (const [sendId, c] of candidates) guardInputs.push(await measureCandidate(sendId, c));
  // …and every send of the window Atrium DISPATCHED (stamped by `lastGateBeforeSend`:
  // `sendId` plus `dispatchedAt` / `sentToInstance`), whether or not anything was ever
  // observed about it: a send whose only read preceded it and whose connection closed
  // before any other read has neither a fact row nor a user row, and must still be owed a
  // confirmation (`custodyUnconfirmed`) rather than vanish. User-visible sends only
  // (`messageId`): Atrium's hidden work runs in sessions of its own. Newest first, read
  // one document at a time under the byte budget; a cut list qualifies the verdict.
  const added: string[] = [];
  // Only sends to an instance whose sessions are PROJECTED (switch shadow/on, and a read
  // cursor of that instance in this report): `lastGateBeforeSend` stamps a send identity
  // whatever the switch, and a send to an unprojected instance has nobody to confirm it.
  const projectedInstances = new Set<string>();
  for (const name of new Set(cursors.map((c) => c.instanceName))) {
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    const m = inst?.config?.transcriptProjection;
    if (m === "shadow" || m === "on") projectedInstances.add(name);
  }
  if (Number.isFinite(earliestBoundary) && projectedInstances.size > 0) {
    // ONE stream in DISPATCH order (`dispatchedAt` is stamped only by the last gate before
    // the send), newest first, the window's boundary as the index range: creation order
    // says nothing about when a queued row left, so it cannot bound this scan.
    let seen = 0;
    for await (const ob of ctx.db
      .query("outbox")
      .withIndex("by_chat_dispatched", (q) =>
        q.eq("chatId", chatId).gte("dispatchedAt", earliestBoundary),
      )
      .order("desc")) {
      if (seen === MAX_OUTBOX_CANDIDATES || budget.exhausted) {
        inputsTruncated = true;
        break;
      }
      seen++;
      budget.charge(ob);
      // Sent, failed, or still in flight (`pending` → counted unsettled, never skipped).
      if (ob.status === "queued") continue;
      const sendId = ob.sendId;
      if (sendId === undefined || ob.messageId === undefined) continue;
      const destination = ob.sentToInstance ?? ob.routedAgent?.instanceName;
      if (destination === undefined || !projectedInstances.has(destination)) continue;
      if (candidates.has(sendId)) continue;
      if (candidates.size >= MAX_GUARD_INPUTS) {
        inputsTruncated = true;
        break;
      }
      candidates.set(sendId, { fact: {}, userRow: null, sessionKey: "" });
      added.push(sendId);
    }
  }
  for (const sendId of added) {
    guardInputs.push(await measureCandidate(sendId, candidates.get(sendId)!));
  }

  // Send → outbox → bubble.
  const sendCache = new Map<string, SendResolution>();
  for (const r of rows) {
    if (r.role !== "user" || r.sendId === undefined || sendCache.has(r.sendId)) continue;
    const sendId = r.sendId;
    const outbox = await ctx.db
      .query("outbox")
      .withIndex("by_send_id", (q) => q.eq("sendId", sendId))
      .first();
    if (outbox === null || outbox.chatId !== chatId) {
      sendCache.set(sendId, { kind: "unknown" });
      continue;
    }
    if (budget.exhausted) {
      sendCache.set(sendId, { kind: "unmeasured" });
      continue;
    }
    const head =
      outbox.messageId === undefined ? null : await ctx.db.get(outbox.messageId);
    if (head !== null) budget.charge(head);
    // DISTINCT bubbles carrying this send: the outbox row's own message and every
    // message stamped with the key. A chained step shares the head's bubble (which keeps
    // the head's key), so a second bubble stamped with the step's key is a duplicate the
    // max of two counts would hide.
    const ids = new Set<string>(head !== null && head.chatId === chatId ? [head._id] : []);
    let interrupted = false;
    for await (const m of ctx.db
      .query("messages")
      .withIndex("by_chat_send_id", (q) => q.eq("chatId", chatId).eq("sendId", sendId))) {
      if (ids.size >= 5) break;
      if (budget.exhausted) {
        interrupted = true;
        break;
      }
      budget.charge(m);
      ids.add(m._id);
    }
    // Same rule as a run's bubbles: a cut count under two proves no uniqueness. A missing
    // head bubble is a fact whatever the count, and stays judged.
    if (interrupted && ids.size < 2 && head !== null) {
      sendCache.set(sendId, { kind: "unmeasured" });
      continue;
    }
    sendCache.set(sendId, {
      kind: "atrium",
      internal: outbox.messageId === undefined,
      headBubble: head !== null,
      bubbleCount: ids.size,
    });
  }

  const gaps = assessProjection({
    rows,
    bubblesForRun: (runId) => {
      const found = bubbleCache.get(runId);
      return found === undefined ? new Set<string>() : found;
    },
    bubbles,
    resolveSend: (sendId) => sendCache.get(sendId) ?? { kind: "unknown" },
    runHasRowsOutsideWindow: (runId) => outsideWindow.has(runId),
    runRowsUnmeasured: (runId) => outsideUnmeasured.has(runId),
    runAnsweredOutsideWindow: (runId) => outsideAnswered.has(runId),
    runAnswerUnmeasured: (runId) => answerUnmeasured.has(runId),
    runStatus: (runId) => runStatusCache.get(runId) ?? null,
    guardInputs,
    partialPendingSessions: new Set(
      cursors.filter((c) => c.pendingInputsComplete === false).map((c) => c.sessionKey),
    ),
  });
  const total = gapTotal(gaps);
  const truncated = rowsTruncated || bubblesTruncated || sessionsTruncated;
  const incompleteReasons = incompletenessReasons({
    readBudgetExhausted: budget.exhausted,
    sessionsTruncated,
    rowsTruncated,
    bubblesTruncated,
    coverageGaps,
    coverageGapsEvicted,
    boundaryUnproven,
    unidentifiedRows,
    inputsTruncated,
    pendingCleanupInProgress: cursors.some((c) => c.pendingCleanupInProgress === true),
    gaps,
  });
  const qualified = incompleteReasons.length > 0;
  return {
    mode,
    verdict: projectionVerdict(total, incompleteReasons),
    gapTotal: total,
    sessions,
    runs: { total: runs.length, byStatus },
    window: {
      truncated,
      rowsTruncated,
      bubblesTruncated,
      sessionsTruncated,
      readBudgetExhausted: budget.exhausted,
      coverageGaps,
      boundaryUnproven,
      incompleteReasons,
      qualified,
    },
    gaps,
  };
}

/** The stored row for an upsert comparison: true when nothing identity-bearing moved. */
export function sameRow(
  stored: Doc<"transcriptRows">,
  next: TranscriptRowInput & { sessionId: string },
): boolean {
  return (
    stored.sessionId === next.sessionId &&
    stored.seq === next.seq &&
    stored.role === next.role &&
    stored.runId === next.runId &&
    stored.sendId === next.sendId &&
    stored.steerTargetRunId === next.steerTargetRunId &&
    stored.mirrorOrigin === next.mirrorOrigin &&
    (stored.runTerminal ?? false) === (next.runTerminal ?? false) &&
    stored.hidden === next.hidden &&
    stored.visible === next.visible &&
    JSON.stringify(stored.toolCallIds ?? []) === JSON.stringify(next.toolCallIds ?? [])
  );
}

/** What `diagnose_chat` carries as `projection`: the report, or — when its own query
 *  failed for any reason — a stated `unavailable`. The diagnosis around it never fails
 *  because of the projection (it runs in its own query, with its own read budget). */
export type DiagnoseProjection =
  | ProjectionReport
  | null
  | { verdict: "unavailable"; reason: "projection_query_failed" };

export async function projectionForDiagnose(
  ctx: Pick<ActionCtx, "runQuery">,
  chatId: string,
): Promise<DiagnoseProjection> {
  try {
    return await ctx.runQuery(internal.transcriptProjection.projectionReportInternal, { chatId });
  } catch (err) {
    // The class only: an error message may quote data, and this surface is metadata-only.
    console.error(
      "diagnose: projection report unavailable:",
      err instanceof Error ? err.name : typeof err,
    );
    return { verdict: "unavailable", reason: "projection_query_failed" };
  }
}
