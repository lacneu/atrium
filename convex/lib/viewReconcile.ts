// THE ONE RECONCILIATION OF A BUBBLE'S VIEW (codex review 6): where the live stream's parts
// meet what the bubble's transcript rows say. PURE: no I/O — convex/messages.ts reads, this
// decides, the SPA renders what it is handed.
//
// THE RULE. What a row says is authoritative for everything it says, from the moment the row
// is received — not at the terminal. The live stream keeps only what no row says yet: the
// text being streamed, a card the transcript does not hold yet, a card's input and output
// (the rows carry its identity and status, never its payloads). The bounds apply AFTER this,
// to what is actually rendered; R4 sees every rendered piece.
//
// The meeting points, and who wins:
//   - text: a settled bubble shows its rows' composition (lib/bubbleProjection.ts); an active
//     one shows the text being streamed — no row holds its in-flight message yet;
//   - tool cards: one card per call id. A row's RESULT or ERROR status replaces the live
//     phase (upstream reconciles `isError` from the result, ui/src/lib/chat/tool-cards.ts); a
//     call-only row says no outcome and leaves the live phase. A call a row names and no live
//     part shows gets its card from the row;
//   - files: the rows' files (copied, remote, pending, gone) are the bubble's — on an active
//     bubble too (`liveRowFiles`), a remote https file at once
//     (chat-message-attachments.ts). A live file part a row's copy already shows is not
//     shown twice; any other live file part stays;
//   - widgets: derived from the rows under the ownership rule (lib/rowParts.ts), deduplicated
//     by view with the live ones — parts, so nothing more to decide here;
//   - run error: the row's (lib/bubbleProjection.ts `rowError`), written at settle;
//   - R4 and bounds: over the rendered file pieces, after the filtering above
//     (`renderedFilePieces`).

import { LAYOUT_MAX_FILES, type LayoutRow } from "./bubbleProjection";

/** The live phase a row's status stands for (result / error); a call-only row has none. */
const ROW_PHASE = { result: "completed", error: "error" } as const;

type ToolLike = { kind: "tool"; name: string; phase: string; toolCallId?: string };

/** The tool cards of a bubble once its rows have spoken: each live card keeps its payloads,
 *  takes the row's outcome when a row carries one; a call a row names and no live part
 *  shows is added from the row (in row order, after the live ones). */
export function reconcileToolParts<P extends { kind: string }>(
  parts: readonly P[],
  layout: readonly LayoutRow[] | undefined,
): Array<P | ToolLike> {
  if (layout === undefined || layout.length === 0) return [...parts];
  const fromRows = new Map<string, { name?: string; status: "call" | "result" | "error" }>();
  for (const row of layout) for (const t of row.tools ?? []) fromRows.set(t.toolCallId, { ...(t.name !== undefined ? { name: t.name } : {}), status: t.status });
  const seen = new Set<string>();
  const out: Array<P | ToolLike> = parts.map((p) => {
    if (p.kind !== "tool") return p;
    const tool = p as unknown as ToolLike;
    if (tool.toolCallId === undefined) return p;
    seen.add(tool.toolCallId);
    const row = fromRows.get(tool.toolCallId);
    if (row === undefined || row.status === "call") return p;
    // A row's `result` only says no error was READ from it (lib tool-error: its flags and its
    // output text). A failure the live stream reported is a known fact the row's silence
    // does not undo (0.101.2 audit; the Control UI's live card keeps its activity outcome,
    // ui/src/lib/chat/tool-cards.ts:132-141 `isToolCardError`). A row's `error` always wins.
    if (row.status === "result" && tool.phase === "error") return p;
    return { ...p, phase: ROW_PHASE[row.status] } as P;
  });
  for (const [toolCallId, row] of fromRows) {
    if (seen.has(toolCallId)) continue;
    out.push({ kind: "tool", name: row.name ?? "tool", phase: row.status === "call" ? "started" : ROW_PHASE[row.status], toolCallId });
  }
  return out;
}

/** A file part of a bubble, as R4 sees it (convex/messages.ts reads the facts). */
export type FilePiece = {
  storageId: string;
  /** The transcript file a DERIVED part shows, with its row's position. */
  transcriptFileId?: string;
  seq?: number;
  blockIndex?: number;
  order: number;
};

/**
 * THE FILE PIECES A BUBBLE RENDERS BESIDE ITS ROWS' OWN, in reading order, bounded AFTER the
 * filtering: a derived part whose copy a row of the layout shows (`rowFileIds`) is that
 * row's piece, not this one; the other derived parts come first in their rows' order (the
 * piece kept while the run is live is the one the settled layout keeps); then the live
 * path's parts in their order. At most `LAYOUT_MAX_FILES` — counted on what is rendered,
 * whatever the number of other parts (cards, plans) the bubble holds.
 */
export function renderedFilePieces(pieces: readonly FilePiece[], rowFileIds: ReadonlySet<string>): FilePiece[] {
  const derived: FilePiece[] = [];
  const others: FilePiece[] = [];
  for (const p of pieces) {
    if (p.transcriptFileId !== undefined) {
      if (rowFileIds.has(p.transcriptFileId)) continue;
      derived.push(p);
    } else {
      others.push(p);
    }
  }
  derived.sort(
    (a, b) =>
      (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
      (a.blockIndex ?? 0) - (b.blockIndex ?? 0) ||
      a.order - b.order,
  );
  others.sort((a, b) => a.order - b.order);
  return [...derived, ...others].slice(0, LAYOUT_MAX_FILES);
}

/** What the rows say of one call's payloads (codex review 11): its arguments (the call
 *  block) and its result (the result block), or the size the row's budget cut them to. */
export type ToolPayload = {
  name?: string;
  input?: unknown;
  output?: unknown;
  inputOmittedBytes?: number;
  outputOmittedBytes?: number;
};

type ToolBlockLike = {
  type: string;
  toolCallId?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  inputOmitted?: boolean;
  inputBytes?: number;
  outputOmitted?: boolean;
  outputBytes?: number;
};

/** The payloads the rows' tool blocks carry, by call id, in transcript order — upstream
 *  tool-cards.ts `extractToolCards` pairs a call's arguments with its result the same way
 *  (one card per call id; the result's output lands on the call's card).
 */
export function toolPayloadsOf(blocks: Iterable<ToolBlockLike>): Map<string, ToolPayload> {
  const out = new Map<string, ToolPayload>();
  for (const b of blocks) {
    if (b.type !== "tool" || b.toolCallId === undefined) continue;
    const id = b.toolCallId;
    const known = out.get(id) ?? {};
    if (known.name === undefined && b.name !== undefined) known.name = b.name;
    if (known.input === undefined && known.inputOmittedBytes === undefined) {
      if (b.input !== undefined) known.input = b.input;
      else if (b.inputOmitted === true) known.inputOmittedBytes = b.inputBytes ?? 0;
    }
    if (b.output !== undefined) {
      known.output = b.output;
      delete known.outputOmittedBytes;
    } else if (b.outputOmitted === true && known.output === undefined) {
      known.outputOmittedBytes = b.outputBytes ?? 0;
    }
    out.set(id, known);
  }
  return out;
}

type RawToolPart = {
  kind: "tool";
  name: string;
  phase: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  inputOmittedBytes?: number;
  outputOmittedBytes?: number;
  inputFromTranscript?: boolean;
};

/** A live (or derived) tool part completed by what the rows say: its own input and output
 *  are kept when it has them (the more complete — a live payload is the tool's own, never
 *  cut by a row budget); a missing one is taken from the rows. */
export function hydrateToolPart<P extends RawToolPart>(part: P, payload: ToolPayload | undefined): P {
  if (payload === undefined) return part;
  const next = { ...part };
  if (next.input === undefined && next.inputOmittedBytes === undefined) {
    if (payload.input !== undefined) {
      next.input = payload.input;
      // Masked at display as the Control UI masks history (toolCardDisplay, review 15).
      next.inputFromTranscript = true;
    } else if (payload.inputOmittedBytes !== undefined) next.inputOmittedBytes = payload.inputOmittedBytes;
  }
  if (next.output === undefined && next.outputOmittedBytes === undefined) {
    if (payload.output !== undefined) next.output = payload.output;
    else if (payload.outputOmittedBytes !== undefined) next.outputOmittedBytes = payload.outputOmittedBytes;
  }
  return next;
}

/** The raw tool parts of a bubble its rows speak for: each part hydrated by call id, and a
 *  card for every call a row names and no part shows, from the rows (with their payloads).
 *  The phase is the pass-6 rule's (`reconcileToolParts`), applied after. */
export function hydrateToolParts<P extends { kind: string }>(
  parts: readonly P[],
  layout: readonly LayoutRow[] | undefined,
  payloads: ReadonlyMap<string, ToolPayload>,
): Array<P | RawToolPart> {
  const seen = new Set<string>();
  const out: Array<P | RawToolPart> = parts.map((p) => {
    if (p.kind !== "tool") return p;
    const tool = p as unknown as RawToolPart;
    if (tool.toolCallId === undefined) return p;
    seen.add(tool.toolCallId);
    return hydrateToolPart(tool, payloads.get(tool.toolCallId)) as unknown as P;
  });
  for (const row of layout ?? []) {
    for (const t of row.tools ?? []) {
      if (seen.has(t.toolCallId)) continue;
      seen.add(t.toolCallId);
      out.push(
        hydrateToolPart(
          { kind: "tool", name: t.name ?? payloads.get(t.toolCallId)?.name ?? "tool", phase: t.status === "call" ? "started" : ROW_PHASE[t.status], toolCallId: t.toolCallId },
          payloads.get(t.toolCallId),
        ),
      );
    }
  }
  return out;
}
