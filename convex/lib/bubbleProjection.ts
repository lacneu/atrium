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

import { composeTranscriptDisplay } from "./transcriptDisplay";
import type { TranscriptPosition } from "./transcriptContent";

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
  // FINAL DESIGN STEP 3 (projection `on`): what the row shows besides its text.
  /** The gateway's display position (`composeTranscriptDisplay`); absent ⇒ `seq` order. */
  position?: TranscriptPosition;
  /** The row's CURRENT file blocks: their index in the row's blocks and, for a managed
   *  file, its artifact id (the record it is identified by, convex/transcriptFiles.ts). */
  files?: ReadonlyArray<{ blockIndex: number; artifactId?: string; label?: string; remoteUrl?: string; mimeType?: string }>;
  /** The row's blocks are known (the bridge sent them; an older one sends text only). */
  hasBlocks?: boolean;
  /** THE ROW AS ITS BLOCKS, in their order (texts and files; tools apart): when known and
   *  whole, a row is rendered by them alone — "Intro", image, "Outro", audio — never by its
   *  raw text, which still carries the `MEDIA:` directives its file blocks replaced
   *  (ui/src/lib/chat/message-normalizer.test.ts:501; the gateway's own projection strips
   *  them, `stripAssistantMediaDirectivesForDisplay`). Absent: the raw text (an older bridge,
   *  cut or omitted blocks). */
  items?: ReadonlyArray<{ kind: "text"; text: string } | { kind: "file"; blockIndex: number }>;
  /** The row's tool blocks, in block order. */
  tools?: ReadonlyArray<LayoutTool>;
  /** The inline widgets the row names, with their carrier (bridge row-blocks.ts
   *  `RowWidgetBlock`). */
  widgets?: ReadonlyArray<LayoutWidget>;
  /** The row's own error text (`errorMessage`) and stop reason (final design step 4). */
  errorText?: string;
  stopReason?: string;
  /** A stream segment split out of its transcript row: same `seq`, shown BEFORE the row
   *  that owns it (src/gateway/chat-display-projection.commentary.ts:96-125). */
  streamSegment?: boolean;
  /** Its place among the segments of the same row (`chat.history`'s order). */
  segmentOrder?: number;
  /** Retracted (§3.3): seen only live, absent from a durable read that covers it — never
   *  rendered (`hidden` is set with it). */
  retracted?: boolean;
};

/** One row of a bubble, as it is rendered (final design §3.4): its span in the bubble's
 *  text, then its files, then its tool cards. Stored on the message (`rowLayout`). */
export type LayoutRow = {
  entryId: string;
  /** [start, end) of the row's text in the composed text (start === end: no text). */
  start: number;
  end: number;
  files?: Array<{ blockIndex: number; artifactId?: string; remoteUrl?: string; label?: string; mimeType?: string }>;
  tools?: LayoutTool[];
  /** The inline widgets the row names (see `PlanRow.widgets`). */
  widgets?: LayoutWidget[];
  /** On the LAST row only: what the layout left out past its bounds (`LAYOUT_MAX_*`). */
  cut?: LayoutCut;
  /** The row's blocks are known: its tool cards are the row's own (see `PlanRow`). */
  blocks?: boolean;
  /** The row's texts and files in block order (`PlanRow.items`): spans of the bubble's text
   *  and file block indexes. Absent: the row's span, then its files. */
  items?: Array<{ kind: "text"; start: number; end: number } | { kind: "file"; blockIndex: number }>;
};

/** A tool card of a bubble: one per `toolCallId`, held by the first row that names it, at
 *  the most advanced status any of its rows states (a call, then its result or error). */
/** `parentToolCallId`: the call this card ran inside (the Control UI's nesting key,
 *  ui/src/lib/chat/tool-cards.ts:383, src/chat/tool-call-grouping.ts `groupToolCalls`). */
export type LayoutTool = { toolCallId: string; name?: string; status: "call" | "result" | "error"; parentToolCallId?: string };
/** THE bounds of a row layout, shared by the planner that writes it and by every reader of
 *  it (convex/messages.ts `rowFilesOf`, lib/rowParts.ts): whatever the layout renders, a
 *  reader resolves (codex review 5, finding 2). Rows: also the bubble/run row loads
 *  (lib/bubbleProjectionStore.ts). Widgets: the live per-turn bound (bridge widgets.ts
 *  `MAX_WIDGET_PARTS_PER_TURN`). */
export const LAYOUT_MAX_ROWS = 400;
export const LAYOUT_MAX_FILES = 256;
export const LAYOUT_MAX_TOOLS = 512;
export const LAYOUT_MAX_WIDGETS = 16;
/** What a layout left out past its bounds, counted. */
export type LayoutCut = { rows?: number; files?: number; tools?: number; widgets?: number };

/** An inline widget a row names, and the carrier that named it. */
export type LayoutWidget = { viewId: string; title?: string; preferredHeight?: number; origin: "tool" | "canvas" | "shortcode" };

const TOOL_RANK: Record<LayoutTool["status"], number> = { call: 0, result: 1, error: 2 };

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
  /** The bubble's stored row layout (`layoutKey` of it; absent: none). */
  layoutKey?: string;
  /** The bubble already carries an error text. */
  hasError?: boolean;
};

export type RunFacts = {
  /** Known to be over (a terminal frame, or a fresh read found the session idle). */
  settled: boolean;
  /** Every row of the run lies above the floor and outside every coverage hole. */
  covered: boolean;
  status?: RunStatus;
  /** The error the gateway recorded for the run (`sessionInfo.lastRunError`, step 4). */
  errorText?: string;
};

/** A failed / timed-out run's error when no failure row states one: the session row's
 *  (ui/src/pages/chat/chat-history-stream.ts:233-247 — `failureMessage ?? lastRunError`). */
function runError(facts: ReadonlyArray<RunFacts | undefined>): string | undefined {
  for (const f of facts) {
    if ((f?.status === "error" || f?.status === "timeout") && f.errorText !== undefined && f.errorText.trim() !== "") {
      return f.errorText.trim();
    }
  }
  return undefined;
}

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
    layout: LayoutRow[];
    status: "complete" | "aborted" | "error";
    /** An `error` bubble's text: its row's own (`stopReason: "error"`, `errorMessage`). */
    error?: string;
    /** The run's outcome was INFERRED (an idle read, no terminal of its own): its live
     *  terminal may still correct it (codex phase 4 pass 24). */
    inferred: boolean;
  }>;
  /** Existing bubbles: the recomposed text (when covered and changed), its row layout
   *  (when covered and changed) and/or the terminal to set (when still streaming and all
   *  of its runs are over). */
  rewrite: Array<{
    messageId: string;
    text?: string;
    layout?: LayoutRow[];
    settle?: "complete" | "aborted" | "error";
    /** With `settle: "error"`: the error text the row states. */
    error?: string;
    /** Every row the bubble showed was RETRACTED (§3.3) and nothing else of the transcript
     *  is left in it: the bubble goes — no text that the transcript does not hold stays. */
    vanish?: true;
    /** An `error` bubble with no error text: the text the transcript states (step 4). */
    errorText?: string;
  }>;
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
  if (r.items !== undefined) {
    const texts = itemTexts(r);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  // As written (codex review 8): leading spaces can be Markdown (an indented code block);
  // `trim` only decides whether there is anything to show.
  return nonEmpty(r.text) ? r.text : null;
}

/** The non-empty texts of a row's blocks, in order — as written (`trim` only tests). */
function itemTexts(r: PlanRow): string[] {
  return (r.items ?? []).flatMap((it) => (it.kind === "text" && it.text.trim() !== "" ? [it.text] : []));
}

/** The cache section that names a bubble's files in its text (final design §3.4 and R11:
 *  `messages.text` stays the derived cache search, the summarizer and the export read). The
 *  row layout never shows it: a rendered row is its own span. */
export const FILES_SECTION_PREFIX = "Fichiers : ";

/**
 * The text and the row layout of a bubble from its rows (final design §3.4): the rows in
 * the gateway's DISPLAY order (`composeTranscriptDisplay` over `seq` order, the rows with no
 * position keeping theirs); each visible row contributes its text — a run with no text of
 * its own its `sessions_yield` acknowledgment — then its files, then its tool blocks. The
 * text is the pieces joined by a blank line, followed by the files' names (the cache).
 */
export function composeBubble(rows: readonly PlanRow[]): { text: string; layout: LayoutRow[] } {
  // THE LAYOUT BOUNDS (`LAYOUT_MAX_*`, codex review 5, finding 2): what the layout renders
  // stops here, and every reader resolves all of it. What is left out is COUNTED on the
  // last row (`cut`) and shown as such — never laid out without its facts.
  // Same `seq`: a stream segment comes before the row it was split out of (the gateway
  // emits it first), segments in the order `chat.history` lists them (codex review 10:
  // never their identity — an entry id ends in a hash of the item id). A segment no read has
  // listed yet (posted live, one at a time) keeps its arrival place: the sort is stable and
  // the rows are loaded in the order they were stored.
  const bySeq = [...rows].sort(
    (a, b) =>
      a.seq - b.seq ||
      (b.streamSegment === true ? 1 : 0) - (a.streamSegment === true ? 1 : 0) ||
      (a.segmentOrder ?? 0) - (b.segmentOrder ?? 0),
  );
  const uniq: PlanRow[] = [];
  const seen = new Set<string>();
  for (const r of bySeq) {
    if (seen.has(r.entryId)) continue;
    seen.add(r.entryId);
    uniq.push(r);
  }
  const ordered = composeTranscriptDisplay(uniq, (r) => r.position);
  const runsWithText = new Set<string>();
  for (const r of ordered) if (shownText(r) !== null) runsWithText.add(r.runId ?? "");
  // One card per tool call, on the first row that names it, at its most advanced status.
  const toolOwner = new Map<string, LayoutTool>();
  for (const r of ordered) {
    if (r.hidden || r.role === "user") continue;
    for (const t of r.tools ?? []) {
      const known = toolOwner.get(t.toolCallId);
      if (known === undefined) toolOwner.set(t.toolCallId, { ...t });
      else {
        if (TOOL_RANK[t.status] > TOOL_RANK[known.status]) known.status = t.status;
        if (known.name === undefined && t.name !== undefined) known.name = t.name;
        // tool-cards.ts:448 `existing.parentToolCallId ??= parentToolCallId`.
        if (known.parentToolCallId === undefined && t.parentToolCallId !== undefined) known.parentToolCallId = t.parentToolCallId;
      }
    }
  }
  const placedTools = new Set<string>();
  let text = "";
  const layout: LayoutRow[] = [];
  const labels: string[] = [];
  const cut = { rows: 0, files: 0, tools: 0, widgets: 0 };
  let filesN = 0;
  let toolsN = 0;
  let widgetsN = 0;
  for (const r of ordered) {
    if (r.hidden || r.role === "user") continue;
    if (layout.length >= LAYOUT_MAX_ROWS) {
      cut.rows++;
      continue;
    }
    let piece = shownText(r);
    if (piece === null && nonEmpty(r.yieldAck) && !runsWithText.has(r.runId ?? "")) piece = r.yieldAck.trim();
    const keptFiles = (r.files ?? []).filter(() => {
      if (filesN < LAYOUT_MAX_FILES) {
        filesN++;
        return true;
      }
      cut.files++;
      return false;
    });
    const keptIndexes = new Set(keptFiles.map((f) => f.blockIndex));
    const files = keptFiles.map((f) => ({
      blockIndex: f.blockIndex,
      ...(f.artifactId !== undefined ? { artifactId: f.artifactId } : {}),
      ...(f.remoteUrl !== undefined
        ? {
            remoteUrl: f.remoteUrl,
            ...(f.label !== undefined ? { label: f.label } : {}),
            ...(f.mimeType !== undefined ? { mimeType: f.mimeType } : {}),
          }
        : {}),
    }));
    const tools: LayoutTool[] = [];
    for (const t of r.tools ?? []) {
      if (placedTools.has(t.toolCallId)) continue;
      placedTools.add(t.toolCallId);
      if (toolsN >= LAYOUT_MAX_TOOLS) {
        cut.tools++;
        continue;
      }
      toolsN++;
      tools.push(toolOwner.get(t.toolCallId)!);
    }
    const widgets = (r.widgets ?? []).flatMap((w) => {
      if (widgetsN >= LAYOUT_MAX_WIDGETS) {
        cut.widgets++;
        return [];
      }
      widgetsN++;
      return [{ ...w }];
    });
    if (piece === null && files.length === 0 && tools.length === 0 && widgets.length === 0) continue;
    let start = text.length;
    let items: LayoutRow["items"];
    if (r.items !== undefined && itemTexts(r).length > 0) {
      // Rendered by its blocks, in their order: each text block its own span.
      items = [];
      let first = true;
      for (const it of r.items) {
        if (it.kind === "file") {
          if (keptIndexes.has(it.blockIndex)) items.push({ kind: "file", blockIndex: it.blockIndex });
          continue;
        }
        // As written: leading spaces can be Markdown (an indented code block).
        const t = it.text;
        if (t.trim() === "") continue;
        if (first) {
          if (text.length > 0) text += "\n\n";
          start = text.length;
          first = false;
        } else {
          text += "\n";
        }
        items.push({ kind: "text", start: text.length, end: text.length + t.length });
        text += t;
      }
    } else if (piece !== null) {
      if (text.length > 0) text += "\n\n";
      start = text.length;
      text += piece;
      if (r.items !== undefined) {
        // Files only, or the acknowledgment: the text first, then the files in block order.
        items = [
          { kind: "text", start, end: text.length },
          ...r.items.flatMap((it) =>
            it.kind === "file" && keptIndexes.has(it.blockIndex) ? [{ kind: "file" as const, blockIndex: it.blockIndex }] : [],
          ),
        ];
      }
    }
    for (const f of keptFiles) if (nonEmpty(f.label)) labels.push(f.label.trim());
    layout.push({
      entryId: r.entryId,
      start,
      end: text.length,
      ...(files.length > 0 ? { files } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(widgets.length > 0 ? { widgets } : {}),
      ...(r.hasBlocks === true ? { blocks: true as const } : {}),
      ...(items !== undefined && items.length > 0 ? { items } : {}),
    });
  }
  if (labels.length > 0) text += `${text.length > 0 ? "\n\n" : ""}${FILES_SECTION_PREFIX}${labels.join(", ")}`;
  const omitted = Object.fromEntries(Object.entries(cut).filter(([, n]) => n > 0)) as LayoutCut;
  if (layout.length > 0 && Object.keys(omitted).length > 0) layout[layout.length - 1] = { ...layout[layout.length - 1]!, cut: omitted };
  return { text, layout };
}

/** The text of a bubble from its rows (`composeBubble`'s text). */
export function composeText(rows: readonly PlanRow[]): string {
  return composeBubble(rows).text;
}

/** A stable key of a layout (stored layouts are compared through it). */
export function layoutKey(layout: readonly LayoutRow[] | undefined): string | undefined {
  if (layout === undefined || layout.length === 0) return undefined;
  return JSON.stringify(
    layout.map((r) => [
      r.entryId,
      r.start,
      r.end,
      (r.files ?? []).map((f) => [f.blockIndex, f.artifactId ?? null, f.remoteUrl ?? null]),
      (r.tools ?? []).map((t) => [t.toolCallId, t.name ?? null, t.status]),
      r.blocks === true,
      (r.items ?? []).map((it) => (it.kind === "text" ? [it.start, it.end] : it.blockIndex)),
      (r.widgets ?? []).map((w) => [w.viewId, w.origin, w.title ?? null, w.preferredHeight ?? null]),
      r.cut ?? null,
    ]),
  );
}

/** Every visible assistant row carries its text: a row read before phase 4 does not. */
function textKnown(rows: readonly PlanRow[]): boolean {
  // Known: its text was read, or its blocks — what it shows — were (a tool-call row has
  // blocks and no text).
  return rows.every((r) => r.role !== "assistant" || r.hidden || !r.visible || r.text !== undefined || r.items !== undefined);
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

/** The error a bubble's rows state (final design §3.4 and step 4: « le texte d'erreur
 *  vient de la ligne »). The Control UI shows a run's failure as the gateway's `custom` row
 *  `run-failed-before-reply` (its content, ui/src/pages/chat/components/chat-message-group
 *  .ts:410-425 at v2026.9.33; written by src/sessions/session-run-error.ts:35-62) — not an
 *  assistant row's `errorMessage`, which it never renders. The bridge carries that row's
 *  content as its error text (transcript-rows.ts `RUN_FAILED_BEFORE_REPLY`); the LAST such
 *  row in transcript order is the bubble's error. Undefined when no row states one. */
export function rowError(rows: readonly PlanRow[]): string | undefined {
  let found: string | undefined;
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (r.role !== "custom" || r.hidden || !nonEmpty(r.errorText)) continue;
    found = r.errorText.trim();
  }
  return found;
}

/** The terminal a bubble takes when its runs are over (null: not ours to set). An error
 *  or a timeout is the row's when a row states its error text (step 4); otherwise only the
 *  live terminal has the gateway's message, and it is left to it (and to the stuck-stream
 *  net) as before. */
function settleStatus(
  statuses: ReadonlyArray<RunStatus | undefined>,
  error: string | undefined,
): { status: "complete" | "aborted" | "error"; error?: string } | null {
  if (error !== undefined) return { status: "error", error };
  if (statuses.some((s) => s === "error" || s === "timeout")) return null;
  if (statuses.some((s) => s === "aborted")) return { status: "aborted" };
  return { status: "complete" };
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
      // No bubble: one is BORN from the rows — for a covered run with something a reader
      // sees: text, a file, or tool cards. A run of tool calls only is shown by its cards,
      // as the Control UI shows an independent run's activity
      // (ui/src/pages/chat/chat-thread-grouping.test.ts:570 at v2026.9.33, "activity-run").
      if (rows.length === 0) continue;
      const { text, layout } = composeBubble(rows);
      // The failure row IS the run's outcome (the gateway writes it only for a run that
      // ended before a reply): an error, with its text — shown by that row alone (step 4).
      const error = rowError(rows) ?? runError([facts]);
      const status = error !== undefined ? "error" : bornStatus(facts.status);
      if (!facts.covered || !textKnown(rows) || (layout.length === 0 && error === undefined)) continue;
      if (utf8Bytes(text) > MAX_COMPOSED_TEXT_BYTES) continue;
      const born = segmentKey(runId, k);
      plan.create.push({
        born,
        runId,
        segment: k,
        firstSeq: rows[0]!.seq,
        text,
        layout,
        status,
        ...(error !== undefined ? { error } : {}),
        inferred: error === undefined && !isExplicitTerminal(facts.status),
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
    const { text, layout } = composeBubble(rows);
    const write: ProjectionPlan["rewrite"][number] = {
      messageId: id,
    };
    // THE ROWS DECIDE when every row a reader could see states its blocks, whole (codex
    // review 5, finding 1): their composition is the bubble's, EVEN EMPTY — a row that
    // normalized to nothing (inbound metadata only) erases what the live stream showed of
    // it. Rows of an older bridge (no blocks) or with cut blocks keep the previous rule.
    const shownRows = rows.filter((r) => !r.hidden && r.role !== "user");
    const rowsDecide = shownRows.length > 0 && shownRows.every((r) => r.items !== undefined);
    // Composable once a reader sees something of the rows — text, a file or a tool card —
    // or once the rows decide.
    const composable =
      allSettled &&
      allCovered &&
      (text !== "" || layout.length > 0 || rowsDecide) &&
      utf8Bytes(text) <= MAX_COMPOSED_TEXT_BYTES;
    if (composable && text !== bubble.text) {
      write.text = text;
    }
    // The layout follows the text: written whenever the composition is, and changed.
    if (composable && layoutKey(layout) !== bubble.layoutKey) {
      write.layout = layout;
    }
    if (bubble.status === "streaming" && allSettled) {
      const settled = settleStatus(
        facts.map((f) => f?.status),
        rowError(rows) ?? runError(facts),
      );
      if (settled !== null) {
        write.settle = settled.status;
        if (settled.error !== undefined) write.error = settled.error;
      }
    }
    // An error bubble whose live terminal carried no text gets the transcript's (step 4).
    if (bubble.status === "error" && bubble.hasError !== true && allSettled) {
      const stated = rowError(rows) ?? runError(facts);
      if (stated !== undefined) write.errorText = stated;
    }
    // §3.3: every row the bubble showed was retracted and nothing of the transcript is left
    // in it — the text it carries exists nowhere any more.
    if (
      allSettled &&
      allCovered &&
      text === "" &&
      layout.length === 0 &&
      rows.length > 0 &&
      rows.some((r) => r.retracted === true) &&
      rows.every((r) => r.hidden || r.role === "user") &&
      rowError(rows) === undefined
    ) {
      write.vanish = true;
    }
    // The rows decide and show nothing (no text, no file, no card, no error): the bubble
    // goes, as an empty bubble does (CU-21) — never kept with the live text.
    if (composable && rowsDecide && text === "" && layout.length === 0 && rowError(rows) === undefined && runError(facts) === undefined) {
      write.vanish = true;
    }
    if (
      write.text !== undefined ||
      write.layout !== undefined ||
      write.settle !== undefined ||
      write.vanish === true ||
      write.errorText !== undefined
    ) {
      plan.rewrite.push(write);
    }
  }
  return plan;
}
