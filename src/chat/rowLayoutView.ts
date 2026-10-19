// A BUBBLE SHOWN ROW BY ROW (final design §3.4, step 3 — projection `on`).
//
// A bubble the transcript rows composed carries their layout (`rowLayout`): in the
// gateway's display order, each row shows its text (its span of the bubble's text), the
// files it carries just under it, then its tool cards — as the Control UI renders each
// transcript row as a message of its run's group. What the display withholds (Olivier's R4
// decision, `displayHidden`) is skipped here, by name; nothing else is filtered. Pure.

import type { ConvexMessagePartView, ConvexMessageView, RowFileView } from "./convexTypes";

export type RowFile =
  | { kind: "copied"; url: string; filename: string; mimeType: string; storageId: string }
  /** A remote https reference: the browser loads it as is, as the Control UI does for a
   *  source that is not local (chat-message-attachments.ts:127-134, `downloadHref` of the
   *  compact card, chat-message-attachments.ts:600-606). */
  | { kind: "remote"; url: string; filename: string; mimeType: string }
  | { kind: "unavailable"; state: "pending" | "gone" | "refused"; reason?: string; filename: string; mimeType: string };

export type RowSegment =
  /** `capped` (0.101.3): a text the gateway's display cap cut, whose full version could not
   *  be recovered — rendered with an honest note, never the gateway's in-band sentinel. */
  | { kind: "text"; entryId: string; text: string; capped?: true }
  | { kind: "file"; entryId: string; blockIndex: number; file: RowFile }
  /** ONE activity block: every tool card of the consecutive rows that show nothing else
   *  between them (the Control UI's "activity-run", ui/src/pages/chat/chat-thread-grouping.ts:
   *  493-538 — consecutive tool-only message groups render as one block). `entryId` is the
   *  first row's. `parents`: a card's recorded parent call (the Control UI's nesting key). */
  | { kind: "tools"; entryId: string; toolCallIds: string[]; parents?: Record<string, string> }
  /** What the layout left out past its bounds: shown as such, at the end. */
  | { kind: "cut"; count: number };

type FilePart = Extract<ConvexMessagePartView, { kind: "media" | "file" }>;

const isFilePart = (p: ConvexMessagePartView): p is FilePart => p.kind === "media" || p.kind === "file";

/** One file a row names, as the reader sees it: copied (its derived part's URL), remote (its
 *  https URL, as is), or what it is (pending, gone, refused) — never hidden. */
function fileSegment(
  message: ConvexMessageView,
  files: readonly RowFileView[] | undefined,
  entryId: string,
  blockIndex: number,
): Extract<RowSegment, { kind: "file" }> {
  const view = files?.find((f) => f.entryId === entryId && f.blockIndex === blockIndex);
  const part =
    view?.fileId === undefined ? undefined : message.parts.filter(isFilePart).find((p) => p.transcriptFileId === view.fileId);
  const filename = part?.filename ?? view?.label ?? "file";
  const mimeType = part?.mimeType ?? view?.mimeType ?? "application/octet-stream";
  if (view?.state === "remote" && view.url !== undefined) {
    return { kind: "file", entryId, blockIndex, file: { kind: "remote", url: view.url, filename, mimeType } };
  }
  // Copied: the derived part's URL, or the copy's own (read with the view) before any part
  // was derived — the view never depends on WHEN a part was written (codex review 8).
  const copiedUrl = part?.url ?? (view?.state === "copied" ? view.url : undefined);
  const copiedStorage = part?.storageId ?? view?.storageId;
  if (view?.state === "copied" && copiedUrl && copiedStorage !== undefined) {
    return { kind: "file", entryId, blockIndex, file: { kind: "copied", url: copiedUrl, filename, mimeType, storageId: copiedStorage } };
  }
  // Copied, but its URL not readable yet, counts as being copied.
  const state = view === undefined || view.state === "copied" || view.state === "remote" ? "pending" : view.state;
  return {
    kind: "file",
    entryId,
    blockIndex,
    file: { kind: "unavailable", state, ...(view?.reason !== undefined ? { reason: view.reason } : {}), filename, mimeType },
  };
}

/** The segments of a bubble with a row layout, or null for any other bubble. */
export function rowSegments(message: ConvexMessageView): RowSegment[] | null {
  const layout = message.rowLayout;
  if (message.role !== "assistant" || layout === undefined || layout.length === 0) return null;
  const hiddenText = new Set<string>();
  const hiddenFile = new Set<string>();
  for (const d of message.displayHidden ?? []) {
    if (d.rule === "repeated_text_in_group") hiddenText.add(d.entryId);
    else if ("entryId" in d) hiddenFile.add(`${d.entryId}\u0000${d.blockIndex}`);
  }
  const out: RowSegment[] = [];
  const text = message.text ?? "";
  const pushFile = (entryId: string, blockIndex: number): void => {
    if (hiddenFile.has(`${entryId}\u0000${blockIndex}`)) return;
    out.push(fileSegment(message, message.rowFiles, entryId, blockIndex));
  };
  for (const row of layout) {
    if (row.items !== undefined) {
      // The row as its blocks, in their order ("Intro", image, "Outro", audio —
      // ui/src/lib/chat/message-normalizer.test.ts:501): never its raw text.
      for (const it of row.items) {
        if (it.kind === "file") pushFile(row.entryId, it.blockIndex);
        else if (!hiddenText.has(row.entryId)) {
          const piece = text.slice(it.start, it.end);
          if (piece.trim() !== "") {
            out.push({ kind: "text", entryId: row.entryId, text: piece, ...(it.capped === true ? { capped: true as const } : {}) });
          }
        }
      }
    } else {
      const piece = text.slice(row.start, row.end);
      if (piece.trim() !== "" && !hiddenText.has(row.entryId)) out.push({ kind: "text", entryId: row.entryId, text: piece });
      for (const f of row.files ?? []) pushFile(row.entryId, f.blockIndex);
    }
    const tools = row.tools ?? [];
    if (tools.length > 0) {
      // Rows that show only cards, one after another (a code-mode turn writes one row per
      // call), are ONE block, as in the Control UI; a text or a file between them ends it.
      const last = out[out.length - 1];
      const block: Extract<RowSegment, { kind: "tools" }> =
        last?.kind === "tools" ? last : { kind: "tools", entryId: row.entryId, toolCallIds: [] };
      if (block !== last) out.push(block);
      for (const t of tools) {
        block.toolCallIds.push(t.toolCallId);
        if (t.parentToolCallId !== undefined) (block.parents ??= {})[t.toolCallId] = t.parentToolCallId;
      }
    }
  }
  const cut = layout[layout.length - 1]?.cut;
  const count = (cut?.rows ?? 0) + (cut?.files ?? 0) + (cut?.tools ?? 0) + (cut?.widgets ?? 0);
  if (count > 0) out.push({ kind: "cut", count });
  return out;
}

/** Who shows a bubble's tool cards, ROW BY ROW (codex review 3, finding 2). A row with
 *  its blocks shows its own cards (`cardsOfBlockRows`); a row without — written by a
 *  bridge older than the transcript blocks (0.100.x), the older rows of a conversation a
 *  progressive upgrade resumed by cursor — names none, so the bubble keeps the live cards
 *  for it (`rowsWithoutBlocks`). Only a card a blocks row already shows is withheld from
 *  the live ones. */
export function cardOwnership(message: ConvexMessageView): { cardsOfBlockRows: Set<string>; rowsWithoutBlocks: boolean } {
  const layout = message.rowLayout ?? [];
  return {
    cardsOfBlockRows: new Set(
      layout.flatMap((r) => (r.blocks === true ? (r.tools ?? []).map((t) => t.toolCallId) : [])),
    ),
    rowsWithoutBlocks: layout.some((r) => r.blocks !== true),
  };
}

/** The file parts R4 withholds in a mixed group (a live part whose bytes the group already
 *  shows), by storage id — never rendered. */
export function hiddenPartStorageIds(message: ConvexMessageView): Set<string> {
  return new Set(
    (message.displayHidden ?? []).flatMap((d) => (d.rule === "same_sha256_in_group" && "storageId" in d ? [d.storageId] : [])),
  );
}

/** The file parts a row layout shows (derived from transcript files): the rest of the
 *  bubble's file parts are rendered after its rows, as before. */
export function layoutFileIds(message: ConvexMessageView): Set<string> {
  return new Set((message.rowFiles ?? []).flatMap((f) => (f.fileId === undefined ? [] : [f.fileId])));
}
