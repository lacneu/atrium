// Inline widgets — the Convex half.
//
// An OpenClaw agent shows an HTML widget in its reply (`show_widget`). Convex stores a
// DESCRIPTOR (`kind:"widget"` message part: provider, viewId, title, preferred height),
// never the document: the reader fetches the bytes per view through
// `GET /api/v1/widget-view` (convex/http.ts), which calls `authorizeWidgetView` below and
// relays `canvas.document.view` through the bridge (`/canvas-view`).
//
// WHY the check lives here. The gateway's `canvas.document.view {docId}` has no session,
// agent or capability scoping — any `operator.read` socket reads any document by id, and
// documents outlive the gateway session. So the only thing standing between a reader and
// every widget of the gateway is this module:
//  - a view is REGISTERED to a conversation (`widgetViews`) only from that
//    conversation's own `show_widget` result, the one carrier that proves the document
//    was produced there — first writer wins, forks inherit the registration;
//  - a widget part that any other carrier names (a `canvas` chat part, which the gateway
//    projects from ANY tool result shaped like a canvas; an `[embed]` shortcode, which is
//    model text) is stored only for a view already registered to the conversation;
//  - the reader must be able to read the conversation, the view must be one of the
//    named message's widget parts, AND it must be registered to that conversation. A
//    part that arrived any other way (an imported archive, say) is shown as unavailable.
//
// Two switches decide whether a conversation gets widgets at all: the instance's
// (`instances.config.widgetsEnabled`, default ON, OpenClaw only) and the conversation's
// own override (`chats.widgetsDisabled`, set by its owner). Both are read at dispatch
// (bridge.ts lastGateBeforeSend -> `inlineWidgets` on the `/send` body), so a change
// applies from the next turn.

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  requireActive,
  requireOwnedChat,
  requirePermission,
  requireReachableChat,
} from "./lib/access";
import { recordAudit, auditImpersonated } from "./lib/audit";
import { resolveChatAccess } from "./lib/chatAccess";
import { parseInstanceConfig } from "./lib/instanceConfig";
import { PERMISSIONS } from "./lib/rbac";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
// The gateway's managed-document grammar — re-checked so an id that could never be
// fetched is never forwarded.
import { WIDGET_VIEW_ID_RE, partWidgetField } from "./lib/widgetDescriptor";


/** How many parts of one message the authorization reads, at most. A reply holds a
 *  handful of parts; the bound keeps the check a single bounded read. */
const MAX_PARTS_READ = 512;

type InstanceDoc = Doc<"instances">;

/** The instance a chat routes to, with the single-instance fallback for legacy chats
 *  (same rule as voice.voiceConfigForChat). */
async function chatInstance(
  ctx: QueryCtx,
  instanceName: string | undefined | null,
): Promise<InstanceDoc | null> {
  if (instanceName) {
    return await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
  }
  const all = await ctx.db.query("instances").take(2);
  return all.length === 1 ? (all[0] ?? null) : null;
}

/** The instance whose gateway STORES a message's widget documents: the one whose bridge
 *  wrote the reply (`boundInstance`, validated at startAssistant); a per-turn routed
 *  conversation carries no instance of its own. */
export async function widgetInstanceFor(
  ctx: QueryCtx,
  message: Pick<Doc<"messages">, "boundInstance" | "routedInstanceName">,
  chat: Pick<Doc<"chats">, "instanceName">,
): Promise<InstanceDoc | null> {
  return await chatInstance(
    ctx,
    message.boundInstance ?? message.routedInstanceName ?? chat.instanceName ?? null,
  );
}

/**
 * The instance whose gateway stores widget views `viewIds` of `message`, as read by the
 * conversation `chat` that holds the message — the ONE answer the card
 * (`widgetConfigForMessage`), the document fetch (`authorizeWidgetView`) and the fork's
 * ownership copy (chatFork) use.
 *
 * The message's own instance (`widgetInstanceFor`) decides whenever the message or its
 * conversation NAMES one, resolvable or not: the registry never overrides a named
 * instance. Only an unnamed message that the single-instance rule cannot resolve falls
 * back — the copy a FORK makes of a per-turn routed reply, which deliberately does not
 * carry `boundInstance` (it drives ingest barriers). Its instance is then the one on
 * THIS conversation's own `widgetViews` rows for exactly those views (the fork writes
 * them from the source reply at copy time). Never another conversation's row; no row,
 * or rows naming two instances, answer null (fail closed). Registration itself is
 * still checked by the caller.
 */
export async function widgetInstanceForViews(
  ctx: QueryCtx,
  message: Pick<Doc<"messages">, "boundInstance" | "routedInstanceName">,
  chat: Pick<Doc<"chats">, "_id" | "instanceName">,
  viewIdsOf: () => Promise<readonly string[]>,
): Promise<InstanceDoc | null> {
  const named = message.boundInstance ?? message.routedInstanceName ?? chat.instanceName ?? null;
  const own = await widgetInstanceFor(ctx, message, chat);
  if (own !== null || named) return own;
  const viewIds = await viewIdsOf();
  let found: string | null = null;
  for (const viewId of viewIds) {
    // Two rows are enough to see a disagreement; one conversation registers a view
    // once per instance.
    const rows = await ctx.db
      .query("widgetViews")
      .withIndex("by_chatId_and_viewId", (q) => q.eq("chatId", chat._id).eq("viewId", viewId))
      .take(2);
    for (const row of rows) {
      if (found !== null && found !== row.instanceName) return null;
      found = row.instanceName;
    }
  }
  return found === null ? null : await chatInstance(ctx, found);
}

/** The distinct widget view ids a message shows — read through the widget index, so
 *  a widget after any number of other parts is found. Rows written before the field
 *  existed (until the backfill has stamped them) are found by the bounded scan. */
async function widgetViewIdsOf(ctx: QueryCtx, messageId: Doc<"messages">["_id"]): Promise<string[]> {
  const ids = new Set<string>();
  const indexed = await ctx.db
    .query("messageParts")
    .withIndex("by_messageId_and_widgetViewId", (q) =>
      q.eq("messageId", messageId).gt("widgetViewId", ""),
    )
    .take(MAX_PARTS_READ);
  for (const row of indexed) if (row.part.kind === "widget") ids.add(row.part.viewId);
  const legacy = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .take(MAX_PARTS_READ);
  for (const row of legacy) if (row.part.kind === "widget") ids.add(row.part.viewId);
  return [...ids];
}

/** Does this message carry a widget part for exactly `viewId`? A direct index lookup —
 *  whatever the message's size — with the bounded scan kept for rows written before
 *  `widgetViewId` was stamped (backfillWidgetPartViewIds). */
export async function messageShowsWidgetView(
  ctx: QueryCtx,
  messageId: Doc<"messages">["_id"],
  viewId: string,
): Promise<boolean> {
  const direct = await ctx.db
    .query("messageParts")
    .withIndex("by_messageId_and_widgetViewId", (q) =>
      q.eq("messageId", messageId).eq("widgetViewId", viewId),
    )
    .first();
  if (direct !== null && direct.part.kind === "widget" && direct.part.viewId === viewId) return true;
  const legacy = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .take(MAX_PARTS_READ);
  return legacy.some((row) => row.part.kind === "widget" && row.part.viewId === viewId);
}

/** Is view `viewId` of `instanceName` registered to conversation `chatId`? */
export async function viewRegisteredTo(
  ctx: QueryCtx,
  instanceName: string,
  viewId: string,
  chatId: Doc<"chats">["_id"],
): Promise<{ mine: boolean; anyone: boolean }> {
  const mine = await ctx.db
    .query("widgetViews")
    .withIndex("by_instanceName_and_viewId_and_chatId", (q) =>
      q.eq("instanceName", instanceName).eq("viewId", viewId).eq("chatId", chatId),
    )
    .first();
  if (mine !== null) return { mine: true, anyone: true };
  const any = await ctx.db
    .query("widgetViews")
    .withIndex("by_instanceName_and_viewId", (q) =>
      q.eq("instanceName", instanceName).eq("viewId", viewId),
    )
    .first();
  return { mine: false, anyone: any !== null };
}

/** Widgets are an OpenClaw feature; the instance switch defaults to ON. */
export function instanceWidgetsEnabled(instance: InstanceDoc | null): boolean {
  if (instance === null || instance.kind === "hermes") return false;
  const cfg = parseInstanceConfig(instance.config);
  if (cfg === "invalid") return false;
  return cfg.widgetsEnabled !== false;
}

export function instanceWidgetPromptConfirm(instance: InstanceDoc | null): boolean {
  if (instance === null) return false;
  const cfg = parseInstanceConfig(instance.config);
  return cfg !== "invalid" && cfg.widgetPromptConfirm === true;
}

/** THE dispatch decision (read by bridge.ts lastGateBeforeSend): the instance allows
 *  widgets AND the conversation did not turn them off. The gateway VERSION is judged
 *  by the bridge (compat.ts `inlineWidgets`). */
export function conversationWantsWidgets(
  instance: InstanceDoc | null,
  chat: Pick<Doc<"chats">, "widgetsDisabled">,
): boolean {
  return instanceWidgetsEnabled(instance) && chat.widgetsDisabled !== true;
}

/** What the conversation view needs to render widgets and the two switches. */
export const widgetConfigForChat = query({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const none = {
      provider: null as "openclaw" | "hermes" | null,
      instanceEnabled: false,
      chatDisabled: false,
      effective: false,
      promptConfirm: false,
      canToggle: false,
    };
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return none;
    const chat = await ctx.db.get(id);
    if (chat === null) return none;
    if (chat.userId !== userId && (await resolveChatAccess(ctx, chat._id, userId)) === null) {
      throw new Error("Forbidden: chat not owned by user");
    }
    // A per-turn routed conversation has no fixed instance: its switches are the ones
    // of the instance it last routed to (the one its next send is most likely to use).
    const inst = await chatInstance(ctx, chat.instanceName ?? chat.lastRoutedInstanceName);
    const provider = inst === null ? null : inst.kind === "hermes" ? "hermes" : "openclaw";
    const instanceEnabled = instanceWidgetsEnabled(inst);
    return {
      provider,
      instanceEnabled,
      chatDisabled: chat.widgetsDisabled === true,
      effective: instanceEnabled && chat.widgetsDisabled !== true,
      promptConfirm: instanceWidgetPromptConfirm(inst),
      // The override is the OWNER's, like every conversation setting that changes
      // what the agent is offered (permission mode, knobs).
      canToggle: provider === "openclaw" && instanceEnabled && chat.userId === userId,
    };
  },
});

/** The per-MESSAGE answer the widget card gates on: are widgets on for the instance
 *  whose gateway stores THIS reply's documents (`widgetInstanceForViews`), in this
 *  conversation? A per-turn routed conversation can mix instances, so the chat-level
 *  answer (`widgetConfigForChat`, the instance it last routed to) cannot decide a
 *  given reply. Same rule as `authorizeWidgetView`, which refuses the fetch anyway. */
export const widgetConfigForMessage = query({
  args: { chatId: v.string(), messageId: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await requireActive(ctx);
    const none = { effective: false, promptConfirm: false };
    const chatId = ctx.db.normalizeId("chats", args.chatId);
    const messageId = ctx.db.normalizeId("messages", args.messageId);
    if (chatId === null || messageId === null) return none;
    const chat = await ctx.db.get(chatId);
    if (chat === null) return none;
    if (chat.userId !== userId && (await resolveChatAccess(ctx, chat._id, userId)) === null) {
      throw new Error("Forbidden: chat not owned by user");
    }
    const message = await ctx.db.get(messageId);
    if (message === null || message.chatId !== chatId) return none;
    const instance = await widgetInstanceForViews(ctx, message, chat, () =>
      widgetViewIdsOf(ctx, messageId),
    );
    return {
      effective: conversationWantsWidgets(instance, chat),
      promptConfirm: instanceWidgetPromptConfirm(instance),
    };
  },
});

/** The conversation owner's override: widgets on (follow the instance) or off. */
export const setChatWidgets = mutation({
  args: { chatId: v.id("chats"), enabled: v.boolean() },
  handler: async (ctx, { chatId, enabled }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { widgetsDisabled: enabled ? undefined : true });
    await auditImpersonated(ctx, actor, "chat.widgets", { resource: "chat", resourceId: chatId });
    return null;
  },
});

/** The instance switches (admin). Merges only its two keys into `instances.config`. */
export const setInstanceWidgets = mutation({
  args: {
    instanceId: v.id("instances"),
    enabled: v.optional(v.boolean()),
    promptConfirm: v.optional(v.boolean()),
  },
  handler: async (ctx, { instanceId, enabled, promptConfirm }) => {
    const adminId = await requirePermission(ctx, PERMISSIONS.BRIDGE_CONFIG_WRITE);
    const inst = await ctx.db.get(instanceId);
    if (inst === null) throw new Error("Instance not found");
    if (inst.kind === "hermes") throw new Error("Widgets are not available on Hermes");
    const cfg = parseInstanceConfig(inst.config);
    if (cfg === "invalid") throw new Error("Invalid instance config");
    const next = { ...cfg };
    // Defaults are stored as ABSENCE (on / no confirmation), so a row never carries a
    // value that merely repeats the default.
    if (enabled !== undefined) {
      if (enabled) delete next.widgetsEnabled;
      else next.widgetsEnabled = false;
    }
    if (promptConfirm !== undefined) {
      if (promptConfirm) next.widgetPromptConfirm = true;
      else delete next.widgetPromptConfirm;
    }
    await ctx.db.patch(instanceId, { config: next });
    await recordAudit(
      ctx,
      { realUserId: adminId, effectiveUserId: adminId, impersonating: false },
      "instance.widgets",
      { resource: "instance", resourceId: instanceId },
    );
    return null;
  },
});

export type WidgetViewAuthorization =
  | {
      ok: true;
      instanceName: string;
      bridgeUrl: string | null;
      /** The reader — the per-user rate limit keys on it (http.ts). */
      userId: string;
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "not_found"
        | "not_a_widget"
        | "not_openclaw"
        | "widgets_off"
        | "not_registered";
    };

/**
 * May the CALLER read widget `viewId` of message `messageId` in chat `chatId`?
 *
 * Runs under the caller's identity (the HTTP action's Bearer token propagates): a
 * reader who cannot read the chat is refused by `requireReachableChat` (it throws, and
 * the route answers 403). A view id that is not one of this message's widget parts is
 * refused — the IDOR the gateway's docId-only RPC would otherwise open.
 */
export const authorizeWidgetView = internalQuery({
  args: { chatId: v.string(), messageId: v.string(), viewId: v.string() },
  handler: async (ctx, args): Promise<WidgetViewAuthorization> => {
    const { userId } = await requireActive(ctx);
    if (!WIDGET_VIEW_ID_RE.test(args.viewId)) return { ok: false, reason: "invalid" };
    const chatId = ctx.db.normalizeId("chats", args.chatId);
    const messageId = ctx.db.normalizeId("messages", args.messageId);
    if (chatId === null || messageId === null) return { ok: false, reason: "invalid" };
    const { chat } = await requireReachableChat(ctx, userId, chatId);
    const message = await ctx.db.get(messageId);
    if (message === null || message.chatId !== chatId || message.role !== "assistant") {
      return { ok: false, reason: "not_found" };
    }
    if (!(await messageShowsWidgetView(ctx, messageId, args.viewId))) {
      return { ok: false, reason: "not_a_widget" };
    }
    // The gateway that STORES the document is the one whose bridge wrote this reply —
    // the message's ingest stamp (`boundInstance`, validated at startAssistant). A
    // per-turn routed conversation carries no instance of its own; a fork's copy carries
    // no ingest stamp, and is answered by its own registry row (widgetInstanceForViews).
    const viewId = args.viewId;
    const instance = await widgetInstanceForViews(ctx, message, chat, async () => [viewId]);
    if (instance === null || instance.kind === "hermes") return { ok: false, reason: "not_openclaw" };
    // Turned off for THIS reply's instance, or for the conversation: the document is
    // not served, whatever the card was told before the switch changed.
    if (!conversationWantsWidgets(instance, chat)) return { ok: false, reason: "widgets_off" };
    // The part alone proves nothing (model text, an imported archive can name any id):
    // the view must have been produced in THIS conversation (or inherited by its fork).
    if (!(await viewRegisteredTo(ctx, instance.name, args.viewId, chatId)).mine) {
      return { ok: false, reason: "not_registered" };
    }
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: instance.name,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    return { ok: true, instanceName: instance.name, bridgeUrl: bridgeUrl ?? null, userId };
  },
});

// --- backfill: messageParts.widgetViewId on rows written before the field ----------

/** The migration key of the widget-part view-id backfill. */
export const WIDGET_PART_BACKFILL = "messageParts.widgetViewId";
/** Parts one backfill step reads at most — and bytes (a part can carry up to a
 *  document's worth of payload): one step stays far below a transaction's 32k reads
 *  and 16 MiB, whatever the size of the message being walked. */
export const WIDGET_BACKFILL_PARTS_PER_STEP = 256;
export const WIDGET_BACKFILL_BYTES_PER_STEP = 4_000_000;
const WIDGET_BACKFILL_STALE_MS = 10 * 60 * 1000;
/** The registry cursor once every registry row has been taken. */
const REGISTRY_END = "end";

/** The backfill's durable position, stored as JSON in the marker's `cursor`:
 *  `registry` = the widget-registry cursor of the NEXT message to start; `message` =
 *  the message being walked (its part cursor, and the registry cursor that becomes
 *  current once it is finished). */
interface WidgetBackfillState {
  registry: string | null;
  lastMessageId?: string;
  message?: { messageId: string; partCursor: string | null; registryAfter: string | null };
}

function readBackfillState(cursor: string | null | undefined): WidgetBackfillState {
  if (!cursor) return { registry: null };
  try {
    const parsed = JSON.parse(cursor) as WidgetBackfillState;
    return typeof parsed === "object" && parsed !== null ? parsed : { registry: null };
  } catch {
    return { registry: null };
  }
}

/**
 * One step: stamp `widgetViewId` on widget parts written before the field, walking
 * the widget REGISTRY (every widget part a conversation was ever allowed to open is
 * named there with its message). A step does ONE of two things, each bounded:
 *  - walks one page of the CURRENT message's parts (≤ WIDGET_BACKFILL_PARTS_PER_STEP
 *    rows, ≤ WIDGET_BACKFILL_BYTES_PER_STEP bytes), saving its part cursor — a
 *    message of any size is finished over as many steps as it needs;
 *  - or, with no message in progress, takes the NEXT registry row and makes its
 *    message current. The registry cursor moves past a message only once that
 *    message has been walked to its end.
 * It saves its position and schedules the next step, until the registry is done.
 * Idempotent. Parts no registry row names (an imported archive's) are never
 * authorized anyway, and keep the bounded scan.
 */
export const backfillWidgetPartViewIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const marker = await ctx.db
      .query("migrationMarkers")
      .withIndex("by_key", (q) => q.eq("key", WIDGET_PART_BACKFILL))
      .first();
    if (marker?.completedAt !== undefined) return { done: true, stamped: 0 };
    const state = readBackfillState(marker?.cursor);
    let stamped = 0;
    let done = false;
    if (state.message !== undefined) {
      const current = state.message;
      const messageId = ctx.db.normalizeId("messages", current.messageId);
      const page =
        messageId === null
          ? { page: [], isDone: true, continueCursor: "" }
          : await ctx.db
              .query("messageParts")
              .withIndex("by_message", (q) => q.eq("messageId", messageId))
              .paginate({
                cursor: current.partCursor,
                numItems: WIDGET_BACKFILL_PARTS_PER_STEP,
                maximumRowsRead: WIDGET_BACKFILL_PARTS_PER_STEP,
                maximumBytesRead: WIDGET_BACKFILL_BYTES_PER_STEP,
              });
      for (const row of page.page) {
        const field = partWidgetField(row.part);
        if (field.widgetViewId !== undefined && row.widgetViewId !== field.widgetViewId) {
          await ctx.db.patch(row._id, field);
          stamped += 1;
        }
      }
      if (page.isDone) {
        state.registry = current.registryAfter;
        state.lastMessageId = current.messageId;
        delete state.message;
      } else {
        state.message = { ...current, partCursor: page.continueCursor };
      }
    } else {
      // The next message of the registry: ONE row (a message is walked in its own
      // steps). Several views of the same message are walked once.
      const page = await ctx.db
        .query("widgetViews")
        .paginate({ cursor: state.registry, numItems: 1 });
      const view = page.page[0];
      // Past the last registry row, the registry cursor reads REGISTRY_END.
      const after = page.isDone ? REGISTRY_END : page.continueCursor;
      if (view === undefined || view.messageId === state.lastMessageId) {
        state.registry = after;
      } else {
        state.message = { messageId: view.messageId, partCursor: null, registryAfter: after };
      }
    }
    if (state.message === undefined && state.registry === REGISTRY_END) done = true;
    const now = Date.now();
    const progress = {
      cursor: done ? null : JSON.stringify(state),
      updatedAt: now,
      ...(done ? { completedAt: now } : {}),
    };
    if (marker === null) {
      await ctx.db.insert("migrationMarkers", { key: WIDGET_PART_BACKFILL, ...progress });
    } else {
      await ctx.db.patch(marker._id, progress);
    }
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.widgets.backfillWidgetPartViewIds, {});
    }
    return { done, stamped };
  },
});

/** Start — or resume — the backfill unless it completed or a live chain runs it. Run
 *  by a cron, so a deployment converges without anyone running anything. */
export const ensureWidgetPartBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const marker = await ctx.db
      .query("migrationMarkers")
      .withIndex("by_key", (q) => q.eq("key", WIDGET_PART_BACKFILL))
      .first();
    if (marker?.completedAt !== undefined) return "complete" as const;
    if (marker !== null && marker.updatedAt > Date.now() - WIDGET_BACKFILL_STALE_MS) {
      return "running" as const;
    }
    await ctx.scheduler.runAfter(0, internal.widgets.backfillWidgetPartViewIds, {});
    return "started" as const;
  },
});
