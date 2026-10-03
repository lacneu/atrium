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
// Identity only — no text, no content: a row is (entry id, seq, role, run, send) plus
// two display facts (hidden, visible) the bridge computed with the Control UI's own
// predicates. The pure functions below are the whole policy; the mutation and the query
// in convex/transcriptProjection.ts only load and store.

import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { ATRIUM_SEND_ID_RE } from "./sendIdentity";
import type { TranscriptProjectionMode } from "./instanceConfig";

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
};

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

  // I1 — per visible run.
  const firstSeqByRun = new Map<string, number>();
  for (const r of rows) {
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
    if (durable) continue;
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
  return gaps;
}

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
    g.i3.unmatchedAtriumSend
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
      if (m.role === "assistant") set.add(m._id);
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
        if (m.role === "assistant" && m.chatId === chatId) set.add(m._id);
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
  for (const b of bubbles) {
    if (!b.settled || b.status === "streaming") continue;
    for (const runId of b.runIds) {
      if (runsNeeded.has(runId) || outsideWindow.has(runId) || outsideUnmeasured.has(runId)) {
        continue;
      }
      let seen = 0;
      for await (const r of ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
        .order("desc")) {
        if (seen === MAX_ROWS_PER_RUN_LOOKUP) {
          outsideUnmeasured.add(runId);
          break;
        }
        seen++;
        if (rowNeedsBubble(r)) {
          outsideWindow.add(runId);
          break;
        }
      }
    }
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
