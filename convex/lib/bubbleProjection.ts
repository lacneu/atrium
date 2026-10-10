// THE TRANSCRIPT MAKES THE BUBBLES (transcript redesign, phase 4 — projection `on`).
//
// A bubble is a PURE FUNCTION of the transcript rows assigned to it. The live overlay of
// phase 3 (a bubble opened at the run's first content, cut at a steered input, joined by
// a distinct late final) stays what it is — a provisional display — and once the runs it
// shows are OVER, its text is recomposed from their durable rows in the SAME message
// (the Control UI's hand-over of authority at the terminal: a durable row replaces the
// live stream, ui/src/pages/chat/terminal-message-identity.ts:65-127 at v2026.9.8).
//
// This module is the planner, and it is pure: the same view always gives the same plan
// (property-tested in bubbleProjection.test.ts). convex/transcriptProjection.ts loads the
// view through bounded index reads and executes the plan. Nothing here reads a time, a
// position in the thread or the words of an answer to DECIDE anything: rows are placed by
// identity (`runId`, the steered user rows' `seq`), and text is only ever composed.
//
// THE RULES, each the Control UI's:
//  - SEGMENTS (CU-20): a user row whose `steerTargetRunId` names run R cuts R's stream at
//    that row (ui/src/pages/chat/session-message-apply.ts:168-187 `rolloverChatStream`);
//    segment k of R = R's rows between the k-th and the (k+1)-th steered row, by `seq`.
//  - ONE BUBBLE PER SEGMENT (CU-17/CU-24): the bubble a row was already assigned to
//    (assignment is STICKY — a replayed read never moves a row), else the bubble the live
//    overlay opened for (R, k), else a bubble BORN FROM THE ROWS.
//  - TEXT (CU-18): the visible, non-hidden assistant rows of the bubble, in `seq` order.
//    A `sessions_yield` acknowledgment counts only for a run that wrote no text of its
//    own (Atrium's display rule, core/turn-sink.ts — "an otherwise-silent parent turn").
//  - SETTLEMENT: a bubble still streaming whose runs are all over is settled — the run
//    table's sticky terminal (CU-7), never a timer.
//
// SAFETY, by identity only:
//  - a bubble is rewritten only when it is COVERED: every run it shows has rows above the
//    projection floor, outside any coverage hole, each visible row carrying its text (a
//    row read by an older bridge carries none). Otherwise its live text stays;
//  - an empty composition never erases a live text (a run with nothing visible keeps
//    what the overlay showed — its tool cards, say);
//  - a row assigned to a bubble that no longer exists (the user deleted it) is a
//    TOMBSTONE: its segment is left alone, never re-born.

export type RunStatus =
  | "streaming"
  | "completed"
  | "error"
  | "aborted"
  | "timeout"
  | "yielded"
  | "persisted";

export type PlanRow = {
  entryId: string;
  seq: number;
  /** Lower-cased, as upstream compares it. */
  role: string;
  runId?: string;
  steerTargetRunId?: string;
  hidden: boolean;
  visible: boolean;
  /** Display text (assistant rows read by a phase-4 bridge). */
  text?: string;
  yieldAck?: string;
  /** The bubble the row is assigned to (sticky). */
  messageId?: string;
};

export type BubbleStatus = "streaming" | "complete" | "error" | "aborted";

export type PlanBubble = {
  messageId: string;
  /** False: the row's bubble was deleted — a tombstone. */
  exists: boolean;
  status: BubbleStatus;
  text: string;
  /** Runs the bubble shows besides its rows' own: its `runId`, and every run merged into
   *  it (`runBubbles`). Each must be covered and over before the bubble is recomposed. */
  runIds: readonly string[];
  /** Rows already assigned to it (any run), from the store. */
  rows: readonly PlanRow[];
  /** Something assigned to it is not this projection's to read (another instance's or
   *  session's rows): it may be settled, never recomposed. */
  uncovered?: boolean;
};

export type RunFacts = {
  /** Known to be over (a terminal frame, or a fresh read found the session idle). */
  settled: boolean;
  /** Every row of the run lies above the floor and outside every coverage hole. */
  covered: boolean;
  status?: RunStatus;
};

export type ProjectionView = {
  /** Rows at or below it are shown by legacy bubbles: never placed. */
  floorSeq: number;
  /** The runs to project now (each one's facts in `runs`). */
  runIds: readonly string[];
  /** Assistant / tool rows of each run to project, any order. */
  rowsOfRun: ReadonlyMap<string, readonly PlanRow[]>;
  /** The `seq` of each user row that steered into a run. */
  steersOfRun: ReadonlyMap<string, readonly number[]>;
  /** The bubble the live overlay opened for a segment, keyed `segmentKey(run, k)`. */
  liveBubbleOf: ReadonlyMap<string, string>;
  /** Every bubble the plan may touch, by message id. */
  bubbles: ReadonlyMap<string, PlanBubble>;
  runs: ReadonlyMap<string, RunFacts>;
};

export type BubbleRef = { messageId: string } | { born: string };

export type ProjectionPlan = {
  /** New assignments (a row never moves once assigned). */
  assign: Array<{ entryId: string; to: BubbleRef }>;
  /** Bubbles born from rows: no live bubble ever existed for the segment. */
  create: Array<{
    born: string;
    runId: string;
    segment: number;
    firstSeq: number;
    text: string;
    status: "complete" | "aborted" | "error";
    /** The run's outcome was INFERRED (an idle read, no terminal of its own): its live
     *  terminal may still correct it (codex phase 4 pass 24). */
    inferred: boolean;
  }>;
  /** Existing bubbles: the recomposed text (when covered and changed) and/or the
   *  terminal to set (when still streaming and all of its runs are over). */
  rewrite: Array<{ messageId: string; text?: string; settle?: "complete" | "aborted" }>;
};

export function segmentKey(runId: string, segment: number): string {
  return `${segment}\u0000${runId}`;
}

/** The segment a row of run R falls in: the number of R's steered user rows before it. */
export function segmentOf(seq: number, steers: readonly number[]): number {
  let k = 0;
  for (const s of steers) if (s < seq) k++;
  return k;
}

const nonEmpty = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** Largest text a bubble is recomposed or born with, in UTF-8 bytes: a message document is
 *  capped at 1 MiB by Convex, and the bubble carries more than its text. A run that says
 *  more keeps its live text (codex phase 4 pass 2). */
export const MAX_COMPOSED_TEXT_BYTES = 768 * 1024;

/** UTF-8 size of a string (a document's limit is in bytes; `.length` counts UTF-16). */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A row a reader sees as text. */
function shownText(r: PlanRow): string | null {
  if (r.role !== "assistant" || r.hidden) return null;
  return nonEmpty(r.text) ? r.text.trim() : null;
}

/**
 * The text of a bubble from its rows: the visible assistant texts in `seq` order; a
 * run with no text of its own contributes its `sessions_yield` acknowledgment.
 */
export function composeText(rows: readonly PlanRow[]): string {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq || (a.entryId < b.entryId ? -1 : 1));
  const runsWithText = new Set<string>();
  for (const r of sorted) if (shownText(r) !== null) runsWithText.add(r.runId ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of sorted) {
    if (seen.has(r.entryId)) continue;
    seen.add(r.entryId);
    const t = shownText(r);
    if (t !== null) out.push(t);
    else if (nonEmpty(r.yieldAck) && !runsWithText.has(r.runId ?? "")) out.push(r.yieldAck.trim());
  }
  return out.join("\n\n");
}

/** Every visible assistant row carries its text: a row read before phase 4 does not. */
function textKnown(rows: readonly PlanRow[]): boolean {
  return rows.every((r) => r.role !== "assistant" || r.hidden || !r.visible || r.text !== undefined);
}

/** The terminal a bubble BORN from rows takes: its run's own — an error or a timeout stays
 *  an error (codex phase 4 pass 11: an answer recovered before its live error terminal was
 *  born `complete`, and that terminal could no longer correct it). */
/** A run status the gateway STATED (a terminal frame or row), as opposed to one only
 *  inferred from an idle read (`streaming`/`persisted`, or unknown). */
export function isExplicitTerminal(status: RunStatus | string | undefined): boolean {
  return (
    status === "completed" || status === "error" || status === "aborted" || status === "timeout" || status === "yielded"
  );
}

function bornStatus(status: RunStatus | undefined): "complete" | "aborted" | "error" {
  if (status === "error" || status === "timeout") return "error";
  if (status === "aborted") return "aborted";
  return "complete";
}

/** The terminal a bubble takes when its runs are over (null: not ours to set). An
 *  error or a timeout carries the gateway's own message, which only the live terminal
 *  has: those are left to it (and to the stuck-stream net). */
function settleStatus(statuses: ReadonlyArray<RunStatus | undefined>): "complete" | "aborted" | null {
  if (statuses.some((s) => s === "error" || s === "timeout")) return null;
  if (statuses.some((s) => s === "aborted")) return "aborted";
  return "complete";
}

/**
 * Plan the projection of the settled runs of `view`. Pure and idempotent: applying the
 * plan and planning again over the result yields an empty plan.
 */
export function planProjection(view: ProjectionView): ProjectionPlan {
  const plan: ProjectionPlan = { assign: [], create: [], rewrite: [] };
  /** Rows newly assigned to an existing bubble during this plan. */
  const added = new Map<string, PlanRow[]>();
  /** Insertion-ordered: the rewrites come out in the order the segments were met. */
  const touched = new Set<string>();
  const touch = (id: string) => {
    touched.add(id);
  };
  const runOrder = [...new Set(view.runIds)].sort();
  for (const runId of runOrder) {
    const facts = view.runs.get(runId);
    if (facts === undefined || !facts.settled) continue;
    const steers = [...(view.steersOfRun.get(runId) ?? [])].sort((a, b) => a - b);
    const bySegment = new Map<number, PlanRow[]>();
    const uniq = new Map<string, PlanRow>();
    for (const r of view.rowsOfRun.get(runId) ?? []) {
      if (r.seq <= view.floorSeq || r.runId !== runId || r.role === "user") continue;
      if (!uniq.has(r.entryId)) uniq.set(r.entryId, r);
    }
    for (const r of uniq.values()) {
      const k = segmentOf(r.seq, steers);
      const list = bySegment.get(k) ?? [];
      list.push(r);
      bySegment.set(k, list);
    }
    // A segment the live overlay opened but that holds no row (the run wrote nothing
    // after the steer) is over with its run all the same: its bubble is settled too.
    for (let k = 0; k <= steers.length; k++) {
      if (!bySegment.has(k) && view.liveBubbleOf.has(segmentKey(runId, k))) bySegment.set(k, []);
    }
    for (const k of [...bySegment.keys()].sort((a, b) => a - b)) {
      const rows = bySegment.get(k)!.sort((a, b) => a.seq - b.seq);
      const sticky = rows.find((r) => r.messageId !== undefined)?.messageId;
      const target = sticky ?? view.liveBubbleOf.get(segmentKey(runId, k));
      if (target !== undefined) {
        const bubble = view.bubbles.get(target);
        // A tombstone (deleted bubble), or one the loader could not read: left alone.
        if (bubble === undefined || !bubble.exists) continue;
        for (const r of rows) {
          if (r.messageId !== undefined) continue;
          plan.assign.push({ entryId: r.entryId, to: { messageId: target } });
          const list = added.get(target) ?? [];
          list.push(r);
          added.set(target, list);
        }
        touch(target);
        continue;
      }
      // No bubble: one is BORN from the rows — only for a covered run with something to
      // read (a tool-only run never shown live has nothing a bubble could hold yet).
      if (rows.length === 0) continue;
      const text = composeText(rows);
      if (!facts.covered || !textKnown(rows) || text === "") continue;
      if (utf8Bytes(text) > MAX_COMPOSED_TEXT_BYTES) continue;
      const born = segmentKey(runId, k);
      const status = bornStatus(facts.status);
      plan.create.push({
        born,
        runId,
        segment: k,
        firstSeq: rows[0]!.seq,
        text,
        status,
        inferred: !isExplicitTerminal(facts.status),
      });
      for (const r of rows) plan.assign.push({ entryId: r.entryId, to: { born } });
    }
  }
  for (const id of touched) {
    const bubble = view.bubbles.get(id)!;
    const merged = new Map<string, PlanRow>();
    for (const r of bubble.rows) merged.set(r.entryId, r);
    for (const r of added.get(id) ?? []) merged.set(r.entryId, { ...r, messageId: id });
    const rows = [...merged.values()];
    const runSet = new Set<string>(bubble.runIds);
    for (const r of rows) if (r.runId !== undefined) runSet.add(r.runId);
    const facts = [...runSet].map((run) => view.runs.get(run));
    const allSettled = facts.every((f) => f?.settled === true);
    const allCovered =
      bubble.uncovered !== true && facts.every((f) => f?.covered === true) && textKnown(rows);
    const text = composeText(rows);
    const write: { messageId: string; text?: string; settle?: "complete" | "aborted" } = {
      messageId: id,
    };
    if (
      allSettled &&
      allCovered &&
      text !== "" &&
      text !== bubble.text &&
      utf8Bytes(text) <= MAX_COMPOSED_TEXT_BYTES
    ) {
      write.text = text;
    }
    if (bubble.status === "streaming" && allSettled) {
      const status = settleStatus(facts.map((f) => f?.status));
      if (status !== null) write.settle = status;
    }
    if (write.text !== undefined || write.settle !== undefined) plan.rewrite.push(write);
  }
  return plan;
}
