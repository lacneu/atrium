// THE PARTS A BUBBLE'S ROWS DERIVE (final design step 3, projection `on`).
//
// A bubble composed from its transcript rows (`messages.rowLayout`) shows each row's files
// and tool cards under that row. They are kept as ordinary message parts so that every
// reader of parts — the viewer, the files list, the archive, the trash — keeps working
// unchanged:
//   - a FILE part per `transcriptFiles` copy the bubble's rows name (once `copied`), stamped
//     with its record (`transcriptFileId`) and mirrored in `files`;
//   - a TOOL part per tool block no part of the bubble shows yet (a bubble born from rows,
//     never followed live), by its `toolCallId` — the live frames name the same ids;
//   - a PLAN part per successful work-plan call among the bubble's tool blocks, by the
//     call's id (`transcriptPlanCall`), when no plan of the live stream is on the bubble
//     (`planPartOfRowTool`) — whoever made the call's card, the rows or the live stream.
// Idempotent: a part already derived is never derived twice. What a reader SEES of them is
// the layout's decision (convex/messages.ts, lib/displayDedup.ts), never this function's.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { conversationWantsWidgets, viewRegisteredTo, widgetInstanceFor } from "../widgets";
import { partStorageField } from "./blobs";
import { LAYOUT_MAX_FILES, LAYOUT_MAX_ROWS, LAYOUT_MAX_TOOLS, LAYOUT_MAX_WIDGETS, type LayoutTool, type LayoutWidget } from "./bubbleProjection";
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

// The bounds of a plan part (bridge core/plan-part.ts — the live reader's own).
const PLAN_STEP_CAP = 300;
const PLAN_EXPLANATION_CAP = 500;
const PLAN_MAX_STEPS = 50;
const PLAN_STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
type RowPlanPart = {
  kind: "plan";
  steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
  explanation?: string;
};

/**
 * THE WORK PLAN A TRANSCRIPT ROW STATES — for a run whose live stream never reached the
 * bridge. The live path reads a plan from the run's `agent` frames (the `plan` stream, or
 * the `update_plan` tool result — bridge core/plan-part.ts). A run the gateway does not
 * broadcast has none: from 2026.10.33 a sub-agent completion delivered with
 * `completionTarget:"parent"` runs as a private requester turn
 * (src/agents/command/session-preparation.ts:160-174 `privateConversationWork` →
 * `isControlUiVisible:false`), whose `plan`, `tool` and `item` frames are all withheld
 * (src/gateway/server-chat.ts:1374-1379, :1446-1459). Its transcript rows are ordinary and
 * carry the call: `{name:"progress_card"|"update_plan", arguments:{plan:[{step,status}]}}`
 * (captured 2026-11-25 on 2026.10.33, a nested `openclaw.nested-tool.v1` row) — the same
 * argument the gateway's plan stream is built from.
 *
 * Same shape and bounds as the live reader. `progress_card` REPLACES the card on every
 * call, so one without steps — `plan` absent or empty — drops the checklist: an empty plan,
 * as the live stream states it (`planPartFromPlanStream`, `steps: []`; upstream
 * src/session-cards/progress-card-input.ts at v2026.9.36 and v2026.10.33). Null: not a
 * plan call, or nothing readable in it. The
 * gateway's "n/m complete" note is its own wording and is not rebuilt here.
 */
export function planPartOfRowTool(name: string | undefined, input: unknown): RowPlanPart | null {
  if (name !== "progress_card" && name !== "update_plan") return null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const args = input as Record<string, unknown>;
  const steps: RowPlanPart["steps"] = [];
  if (Array.isArray(args.plan)) {
    for (const item of args.plan) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const { step, status } = item as Record<string, unknown>;
      if (typeof step !== "string" || step === "") continue;
      steps.push({
        step: step.slice(0, PLAN_STEP_CAP),
        // An unknown status reads as not done — never a false check.
        status: typeof status === "string" && PLAN_STEP_STATUSES.has(status) ? (status as RowPlanPart["steps"][number]["status"]) : "pending",
      });
      if (steps.length >= PLAN_MAX_STEPS) break;
    }
  }
  if (steps.length === 0) {
    // No step at all, absent or an EMPTY array alike (upstream `normalizeProgressCardInput`
    // keeps no `steps` for either, and the put replaces the card): the checklist is
    // cleared. Anything else without a readable step is not a call that succeeded.
    const cleared = args.plan === undefined || (Array.isArray(args.plan) && args.plan.length === 0);
    return name === "progress_card" && cleared ? { kind: "plan", steps: [] } : null;
  }
  const explanation = typeof args.explanation === "string" && args.explanation !== "" ? args.explanation.slice(0, PLAN_EXPLANATION_CAP) : undefined;
  return { kind: "plan", steps, ...(explanation !== undefined ? { explanation } : {}) };
}

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
): Promise<{ files: number; tools: number; plans: number; widgets: number; removed: number }> {
  const out = { files: 0, tools: 0, plans: 0, widgets: 0, removed: 0 };
  const message = await ctx.db.get(messageId);
  if (message === null || message.rowLayout === undefined) return out;
  const parts = await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", messageId)).take(MAX_PARTS_READ);
  let order = parts.reduce((max, p) => Math.max(max, p.order), -1) + 1;
  const toolIds = new Set<string>();
  const fileIds = new Set<string>();
  // A plan the LIVE stream wrote (the sink stamps each one, core/turn-sink.ts): the run was
  // followed live and its plan is that stream's — the rows add none beside it.
  const livePlan = parts.some((p) => p.part.kind === "plan" && p.part.stamp !== undefined);
  // The calls whose plan the rows already gave, and the cards the bubble holds.
  const plannedCalls = new Set<string>();
  const cards = new Map<string, { name: string; input?: unknown }>();
  for (const p of parts) {
    if (p.part.kind === "tool" && p.part.toolCallId !== undefined) {
      toolIds.add(p.part.toolCallId);
      cards.set(p.part.toolCallId, p.part);
    }
    if (p.transcriptFileId !== undefined) fileIds.add(String(p.transcriptFileId));
    if (p.transcriptPlanCall !== undefined) plannedCalls.add(p.transcriptPlanCall);
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
      if (!toolIds.has(t.toolCallId)) {
        toolIds.add(t.toolCallId);
        // With the arguments and result the rows carry (codex review 11): a card rebuilt
        // from the transcript is the live card it stands for.
        const card = hydrateToolPart({ kind: "tool", name: t.name ?? "tool", phase: TOOL_PHASE[t.status], toolCallId: t.toolCallId }, (await payloads()).get(t.toolCallId));
        await ctx.db.insert("messageParts", { messageId, order: order++, part: card });
        cards.set(t.toolCallId, card);
        out.tools++;
      }
      // The plan of a call no plan of the live stream shows. Its identity is the CALL's
      // (`transcriptPlanCall`), never the card's birth: a card the live stream opened and
      // left without its result (the socket closed while the tool ran) is completed by
      // the rows, and its plan is theirs to give too. Only a call the transcript gives a
      // result to: the gateway publishes a plan for a successful call only. Unstamped:
      // within the bubble it orders by insertion, the rows' order (lib/planOrder.ts).
      if (livePlan || t.status !== "result" || plannedCalls.has(t.toolCallId)) continue;
      const card = cards.get(t.toolCallId);
      const name = card?.name ?? t.name;
      if (name !== "progress_card" && name !== "update_plan") continue;
      plannedCalls.add(t.toolCallId);
      // The card's own arguments, else the rows' (a live card left open has none yet).
      const plan = planPartOfRowTool(name, card?.input ?? (await payloads()).get(t.toolCallId)?.input);
      if (plan === null) continue;
      await ctx.db.insert("messageParts", { messageId, order: order++, part: plan, transcriptPlanCall: t.toolCallId });
      out.plans++;
    }
  }
  // …and a live card the rows complete (one without its arguments or result) gets them;
  // one that has them keeps its own. Its OUTCOME is the rows' too: a card whose result
  // frame never reached the bridge (the socket was closed while the tool ran, and the sink
  // that would have closed the card at the terminal died with it) is still stored `start`
  // on a settled bubble. The row that holds the result closes it here — as the Control UI
  // drops its live tool stream at the run's terminal and renders the cards of the reloaded
  // history (ui/src/pages/chat/run-lifecycle.ts `reconcileChatRunLifecycle`,
  // ui/src/lib/chat/tool-cards.ts `extractToolCards`). Only a card the live stream left
  // OPEN, and only by a row's result: the stored phase stays what the live stream said
  // wherever it spoke, so the view's rule (`phaseFromRow`) is always applied to a live
  // fact. A row's `error` is therefore never stored — a later read may correct that row,
  // and a stored error could no longer be told from one the stream reported; the view
  // shows it from the row. A call no row gives a result to keeps its phase.
  const rowStatus = new Map<string, LayoutTool["status"]>();
  for (const row of message.rowLayout) for (const t of row.tools ?? []) rowStatus.set(t.toolCallId, t.status);
  for (const p of parts) {
    if (p.part.kind !== "tool" || p.part.toolCallId === undefined) continue;
    let next = p.part;
    if (next.input === undefined || next.output === undefined) {
      const payload = (await payloads()).get(p.part.toolCallId);
      if (payload !== undefined) next = hydrateToolPart(next, payload);
    }
    const status = rowStatus.get(p.part.toolCallId);
    if (status === "result" && next.phase !== "completed" && next.phase !== "error") next = { ...next, phase: "completed" };
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
  // (Its own run under the name its rows carry: stream.ts `linkRunBubble`.)
  const segment = (message.transcriptRunId ?? message.runId) === runId ? (message.runSegment ?? 0) : 0;
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
