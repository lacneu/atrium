// THE PARTS A BUBBLE'S ROWS DERIVE (final design step 3, projection `on`).
//
// A bubble composed from its transcript rows (`messages.rowLayout`) shows each row's files
// and tool cards under that row. They are kept as ordinary message parts so that every
// reader of parts — the viewer, the files list, the archive, the trash — keeps working
// unchanged:
//   - a FILE part per `transcriptFiles` copy the bubble's rows name (once `copied`), stamped
//     with its record (`transcriptFileId`) and mirrored in `files`;
//   - a TOOL part per tool block no part of the bubble shows yet (a bubble born from rows,
//     never followed live), by its `toolCallId` — the live frames name the same ids.
// Idempotent: a part already derived is never derived twice. What a reader SEES of them is
// the layout's decision (convex/messages.ts, lib/displayDedup.ts), never this function's.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { conversationWantsWidgets, viewRegisteredTo, widgetInstanceFor } from "../widgets";
import { partStorageField } from "./blobs";
import { LAYOUT_MAX_FILES, LAYOUT_MAX_ROWS, LAYOUT_MAX_TOOLS, LAYOUT_MAX_WIDGETS, type LayoutWidget } from "./bubbleProjection";
import { deleteFileRowsForStorage, recordFileForPart } from "./files";
import { segmentOfRow, steerSeqsOf } from "./transcriptProjection";
import { partWidgetField, WIDGET_TITLE_MAX_CHARS, WIDGET_VIEW_ID_RE } from "./widgetDescriptor";
import { hydrateToolPart, toolPayloadsOf, type ToolPayload } from "./viewReconcile";

/** Parts one bubble may hold before a derivation stops reading them: room for every part
 *  a layout can derive (`LAYOUT_MAX_*`) beside as many live ones. */
const MAX_PARTS_READ = 2 * (LAYOUT_MAX_FILES + LAYOUT_MAX_TOOLS + LAYOUT_MAX_WIDGETS);

/** The record a layout file names: a managed copy by its artifact, any other by its row. */
export async function fileOfLayout(
  ctx: Pick<QueryCtx, "db">,
  message: Pick<Doc<"messages">, "chatId" | "boundInstance" | "turnSessionKey">,
  entryId: string,
  f: { blockIndex: number; artifactId?: string },
): Promise<Doc<"transcriptFiles"> | null> {
  if (f.artifactId !== undefined && message.boundInstance !== undefined && message.turnSessionKey !== undefined) {
    const byArtifact = await ctx.db
      .query("transcriptFiles")
      .withIndex("by_instance_session_artifact", (q) =>
        q
          .eq("instanceName", message.boundInstance!)
          .eq("sessionKey", message.turnSessionKey!)
          .eq("artifactId", f.artifactId)
          .eq("chatId", message.chatId),
      )
      .first();
    if (byArtifact !== null) return byArtifact;
  }
  return await ctx.db
    .query("transcriptFiles")
    .withIndex("by_chat_entry", (q) => q.eq("chatId", message.chatId).eq("entryId", entryId).eq("blockIndex", f.blockIndex))
    .first();
}

const TOOL_PHASE = { call: "started", result: "completed", error: "error" } as const;

/** One derived file part — a copy of the bubble's row, stamped with its record — and its
 *  `files` row. */
async function insertDerivedFilePart(
  ctx: MutationCtx,
  message: Doc<"messages">,
  chat: Doc<"chats"> | null,
  record: Doc<"transcriptFiles"> & { storageId: Id<"_storage"> },
  order: number,
): Promise<void> {
  const part = {
    kind: "media" as const,
    storageId: record.storageId,
    filename: record.label ?? "file",
    mimeType: record.mimeType ?? "application/octet-stream",
  };
  await ctx.db.insert("messageParts", {
    messageId: message._id,
    order,
    part,
    ...partStorageField(part),
    transcriptFileId: record._id,
  });
  if (chat !== null) {
    await recordFileForPart(ctx, {
      messageId: message._id,
      chatId: message.chatId,
      userId: chat.userId,
      direction: "outbound",
      ...(message.boundInstance !== undefined ? { instanceName: message.boundInstance } : {}),
      part,
      createdAt: Date.now(),
    });
  }
}

/**
 * A copy that finished while its run is still LIVE (final design step 3): its row is not
 * placed in a bubble yet (that happens when the run settles), but the Control UI shows the
 * row — and its file — as soon as the row exists. The file goes on the run's live bubble
 * now, derived like any other (stamped with its record): the layout written at settle finds
 * it there and shows it under its row; a part the settled layout does not name is removed
 * by `syncBubbleRowParts`. Idempotent. Returns whether a part was added.
 */
export async function deriveCopiedFileOnLiveBubble(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  record: Doc<"transcriptFiles">,
): Promise<boolean> {
  if (record.state !== "copied" || record.storageId === undefined) return false;
  const message = await ctx.db.get(messageId);
  if (message === null || message.role !== "assistant" || message.chatId !== record.chatId) return false;
  const parts = await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", messageId)).take(MAX_PARTS_READ);
  if (parts.some((p) => p.transcriptFileId === record._id)) return false;
  const order = parts.reduce((max, p) => Math.max(max, p.order), -1) + 1;
  await insertDerivedFilePart(ctx, message, await ctx.db.get(message.chatId), { ...record, storageId: record.storageId }, order);
  return true;
}

/** Derive the parts a bubble's layout names and no part shows yet. */
export async function syncBubbleRowParts(
  ctx: MutationCtx,
  messageId: Id<"messages">,
): Promise<{ files: number; tools: number; widgets: number; removed: number }> {
  const out = { files: 0, tools: 0, widgets: 0, removed: 0 };
  const message = await ctx.db.get(messageId);
  if (message === null || message.rowLayout === undefined) return out;
  const parts = await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", messageId)).take(MAX_PARTS_READ);
  let order = parts.reduce((max, p) => Math.max(max, p.order), -1) + 1;
  const toolIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const p of parts) {
    if (p.part.kind === "tool" && p.part.toolCallId !== undefined) toolIds.add(p.part.toolCallId);
    if (p.transcriptFileId !== undefined) fileIds.add(String(p.transcriptFileId));
  }
  const chat = await ctx.db.get(message.chatId);
  // The payloads the bubble's rows carry, read once and only when a card needs them.
  let payloadMap: Map<string, ToolPayload> | null = null;
  const payloads = async (): Promise<Map<string, ToolPayload>> => (payloadMap ??= await toolPayloadsOfBubble(ctx, message));
  // THE ONE RULE for a derived file part (final design steps 3-4): it exists only while
  // the CURRENT rows name its record. A row that replaced its `MEDIA:` copy by its managed
  // block (the gateway's structured rewrite) takes the old part away here, with its
  // `files` row — so the viewer, the files list, the export, the archive, the search and
  // the summarizer never see it. The copy itself (`transcriptFiles`) stays: storage is
  // faithful; only the bubble's derivation follows the rows.
  const current = new Set<string>();
  for (const row of message.rowLayout) {
    for (const f of row.files ?? []) {
      const record = await fileOfLayout(ctx, message, row.entryId, f);
      if (record !== null) current.add(String(record._id));
    }
  }
  for (const p of parts) {
    if (p.transcriptFileId === undefined || current.has(String(p.transcriptFileId))) continue;
    await ctx.db.delete(p._id);
    fileIds.delete(String(p.transcriptFileId));
    const storageId = "storageId" in p.part ? (p.part as { storageId?: Id<"_storage"> }).storageId : undefined;
    if (storageId !== undefined) await deleteFileRowsForStorage(ctx, messageId, storageId);
    out.removed++;
  }
  for (const row of message.rowLayout) {
    for (const f of row.files ?? []) {
      const record = await fileOfLayout(ctx, message, row.entryId, f);
      if (record === null || record.state !== "copied" || record.storageId === undefined) continue;
      if (fileIds.has(String(record._id))) continue;
      fileIds.add(String(record._id));
      await insertDerivedFilePart(ctx, message, chat, { ...record, storageId: record.storageId }, order++);
      out.files++;
    }
    for (const t of row.tools ?? []) {
      if (toolIds.has(t.toolCallId)) continue;
      toolIds.add(t.toolCallId);
      // With the arguments and result the rows carry (codex review 11): a card rebuilt from
      // the transcript is the live card it stands for.
      await ctx.db.insert("messageParts", {
        messageId,
        order: order++,
        part: hydrateToolPart({ kind: "tool", name: t.name ?? "tool", phase: TOOL_PHASE[t.status], toolCallId: t.toolCallId }, (await payloads()).get(t.toolCallId)),
      });
      out.tools++;
    }
  }
  // …and a live card the rows complete (one without its arguments or result) gets them;
  // one that has them keeps its own.
  for (const p of parts) {
    if (p.part.kind !== "tool" || p.part.toolCallId === undefined) continue;
    if (p.part.input !== undefined && p.part.output !== undefined) continue;
    const payload = (await payloads()).get(p.part.toolCallId);
    if (payload === undefined) continue;
    const next = hydrateToolPart(p.part, payload);
    if (next !== p.part && JSON.stringify(next) !== JSON.stringify(p.part)) await ctx.db.patch(p._id, { part: next });
  }
  await syncRowWidgets(ctx, message, chat, parts, () => order++, out, namedWidgets(message.rowLayout), true);
  return out;
}

type NamedWidget = LayoutWidget & { entryId: string };

/** The widgets a layout names, one per view (the `tool` carrier wins). */
function namedWidgets(layout: Doc<"messages">["rowLayout"]): Map<string, NamedWidget> {
  const named = new Map<string, NamedWidget>();
  for (const row of layout ?? []) {
    for (const w of row.widgets ?? []) {
      const known = named.get(w.viewId);
      if (known === undefined || (known.origin !== "tool" && w.origin === "tool")) named.set(w.viewId, { ...w, entryId: row.entryId });
    }
  }
  return named;
}

/**
 * The widgets rows just stored name, on the LIVE bubble of their run (codex review 6): the
 * view shows a row's widget from the moment the row exists, not at the terminal — under the
 * same ownership rule (`syncRowWidgets`). Nothing is removed here: the layout written at
 * settle decides that.
 */
export async function deriveRowWidgetsOnLiveBubble(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  widgets: ReadonlyArray<NamedWidget>,
): Promise<number> {
  const message = await ctx.db.get(messageId);
  if (message === null || message.role !== "assistant" || widgets.length === 0) return 0;
  const parts = await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", messageId)).take(MAX_PARTS_READ);
  let order = parts.reduce((max, p) => Math.max(max, p.order), -1) + 1;
  const named = new Map<string, NamedWidget>();
  for (const w of widgets) {
    const known = named.get(w.viewId);
    if (known === undefined || (known.origin !== "tool" && w.origin === "tool")) named.set(w.viewId, w);
  }
  const out = { widgets: 0, removed: 0 };
  await syncRowWidgets(ctx, message, await ctx.db.get(message.chatId), parts, () => order++, out, named, false);
  return out.widgets;
}

/**
 * The inline widgets the bubble's rows name (projection `on`), under the OWNERSHIP rule of
 * convex/widgets.ts — the gateway's `canvas.document.view` serves any document to any
 * operator socket, so the conversation a document belongs to is Atrium's to decide:
 *  - a view is REGISTERED to this conversation (`widgetViews`) only from a `show_widget`
 *    RESULT row (`origin: "tool"`) of the bubble's own session (`turnSessionKey`) — the
 *    row the bridge read on this conversation's socket, written by the tool that minted
 *    the document — and only if no conversation registered it first (the live rule,
 *    stream.ts addPart);
 *  - a widget a `canvas` history block or an `[embed]` shortcode names is derived only
 *    for a view registered to this conversation: such a carrier can name any document
 *    (upstream projects canvas blocks from ANY canvas-shaped tool result, a shortcode is
 *    model text). Never registered, never stored, never shown;
 *  - nothing at all while widgets are off for the conversation.
 * One widget part per view (a live one counts); a derived part (`transcriptWidget`) goes
 * when the current rows no longer name its view. Bounded by the layout.
 */
async function syncRowWidgets(
  ctx: MutationCtx,
  message: Doc<"messages">,
  chat: Doc<"chats"> | null,
  parts: ReadonlyArray<Doc<"messageParts">>,
  nextOrder: () => number,
  out: { widgets: number; removed: number },
  named: ReadonlyMap<string, NamedWidget>,
  removeUnnamed: boolean,
): Promise<void> {
  const derived = parts.filter((p) => p.transcriptWidget === true);
  if (named.size === 0 && derived.length === 0) return;
  const instance = chat === null ? null : await widgetInstanceFor(ctx, message, chat);
  const wants = message.role === "assistant" && chat !== null && instance !== null && conversationWantsWidgets(instance, chat);
  const shown = new Set<string>();
  for (const p of parts) if (p.part.kind === "widget" && p.transcriptWidget !== true) shown.add(p.part.viewId);
  const keep = new Set<string>();
  if (wants && chat !== null && instance !== null) {
    for (const w of named.values()) {
      if (!WIDGET_VIEW_ID_RE.test(w.viewId)) continue;
      const reg = await viewRegisteredTo(ctx, instance.name, w.viewId, chat._id);
      let mine = reg.mine;
      if (!mine && !reg.anyone && w.origin === "tool" && (await rowOfOwnSession(ctx, message, w.entryId))) {
        await ctx.db.insert("widgetViews", {
          instanceName: instance.name,
          viewId: w.viewId,
          chatId: chat._id,
          messageId: message._id,
          source: "gateway",
          createdAt: Date.now(),
        });
        mine = true;
      }
      if (!mine) continue;
      keep.add(w.viewId);
      if (shown.has(w.viewId) || derived.some((p) => p.part.kind === "widget" && p.part.viewId === w.viewId)) continue;
      const part = {
        kind: "widget" as const,
        provider: "openclaw" as const,
        viewId: w.viewId,
        ...(w.title !== undefined ? { title: w.title.slice(0, WIDGET_TITLE_MAX_CHARS) } : {}),
        ...(w.preferredHeight !== undefined ? { preferredHeight: w.preferredHeight } : {}),
        sandbox: "scripts" as const,
      };
      await ctx.db.insert("messageParts", {
        messageId: message._id,
        order: nextOrder(),
        part,
        ...partWidgetField(part),
        transcriptWidget: true,
      });
      out.widgets++;
    }
  }
  for (const p of removeUnnamed ? derived : []) {
    if (p.part.kind === "widget" && keep.has(p.part.viewId)) continue;
    await ctx.db.delete(p._id);
    out.removed++;
  }
}

/** Is `entryId` a tool-result row (or a nested-tool row) of the bubble's OWN session (the one the conversation's
 *  socket reads), still shown? */
async function rowOfOwnSession(ctx: MutationCtx, message: Doc<"messages">, entryId: string): Promise<boolean> {
  if (message.turnSessionKey === undefined) return false;
  const row = await ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_session_entry", (q) =>
      q.eq("chatId", message.chatId).eq("sessionKey", message.turnSessionKey!).eq("entryId", entryId),
    )
    .first();
  const role = row?.role.toLowerCase();
  // `custom`: a nested code-mode call (`openclaw.nested-tool.v1`), call and result in one row.
  return (
    row !== null &&
    (role === "toolresult" || role === "tool_result" || role === "tool" || role === "custom") &&
    row.retracted !== true
  );
}

/**
 * A LIVE BUBBLE OPENS AFTER ITS ROWS (codex review 8): the rows of its run already received
 * — and the copies already finished — said files and widgets before the bubble existed, so
 * no derivation could place them. At the opening, everything those rows say is taken up at
 * once: the copied files (`deriveCopiedFileOnLiveBubble`) and the widgets
 * (`deriveRowWidgetsOnLiveBubble`, same ownership rule). Cards and text need nothing here:
 * the view reads them from the rows at read time (convex/messages.ts `activeRowLayout`).
 * Only the rows not placed elsewhere, of the bubble's own session and segment. Bounded.
 */
export async function catchUpLiveBubbleFromRows(ctx: MutationCtx, messageId: Id<"messages">, runId: string): Promise<void> {
  const message = await ctx.db.get(messageId);
  // A LIVE bubble only (a settled one is composed from its rows by the projection), whose
  // writer is `runId` (its own run, or the announce run a reopened parent now carries).
  if (message === null || message.role !== "assistant" || message.status !== "streaming" || message.turnSessionKey === undefined) return;
  // The segment the run writes into this bubble: its own run's segment, else the first.
  const segment = message.runId === runId ? (message.runSegment ?? 0) : 0;
  const sessionKey = message.turnSessionKey;
  const docs = await ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_run", (q) => q.eq("chatId", message.chatId).eq("runId", runId))
    .take(LAYOUT_MAX_ROWS);
  const cuts = await steerSeqsOf(ctx, message.chatId, sessionKey, runId);
  const widgets: NamedWidget[] = [];
  for (const d of docs) {
    if (d.sessionKey !== sessionKey || d.messageId !== undefined || d.retracted === true) continue;
    if ((segmentOfRow(d.seq, cuts) ?? 0) !== segment) continue;
    if (d.textSig !== undefined) {
      const doc = await ctx.db.query("transcriptRowTexts").withIndex("by_row", (q) => q.eq("rowId", d._id)).first();
      for (const b of doc?.blocks ?? []) {
        if (b.type === "widget") {
          widgets.push({
            viewId: b.viewId,
            ...(b.title !== undefined ? { title: b.title } : {}),
            ...(b.preferredHeight !== undefined ? { preferredHeight: b.preferredHeight } : {}),
            origin: b.origin,
            entryId: d.entryId,
          });
        }
      }
    }
    const files = await ctx.db
      .query("transcriptFiles")
      .withIndex("by_chat_entry", (q) => q.eq("chatId", message.chatId).eq("entryId", d.entryId))
      .take(LAYOUT_MAX_FILES);
    for (const record of files) {
      if (record.sessionKey === sessionKey && record.state === "copied") await deriveCopiedFileOnLiveBubble(ctx, messageId, record);
    }
  }
  if (widgets.length > 0) await deriveRowWidgetsOnLiveBubble(ctx, messageId, widgets);
}

/** The tool payloads the rows assigned to a bubble carry, by call id, in transcript order
 *  (lib/viewReconcile.ts `toolPayloadsOf`). Only the rows that name a call are read. */
async function toolPayloadsOfBubble(ctx: MutationCtx, message: Doc<"messages">): Promise<Map<string, ToolPayload>> {
  const rows = await ctx.db
    .query("transcriptRows")
    .withIndex("by_message_seq", (q) => q.eq("messageId", message._id))
    .take(LAYOUT_MAX_ROWS);
  const blocks = [];
  for (const r of rows) {
    if ((r.toolCallIds ?? []).length === 0 || r.textSig === undefined) continue;
    const doc = await ctx.db.query("transcriptRowTexts").withIndex("by_row", (q) => q.eq("rowId", r._id)).first();
    for (const b of doc?.blocks ?? []) if (b.type === "tool") blocks.push(b);
  }
  return toolPayloadsOf(blocks);
}
