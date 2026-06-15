// Public, reactive read surface for chat messages.
//
// `listByChat` is what the frontend subscribes to via `useQuery`. assistant-ui
// turns each returned message (with its resolved parts) into a
// ThreadMessageLike. Streaming works because the bridge patches the underlying
// `messages.text` / inserts `messageParts`, which re-runs this query and
// re-renders the thread.
//
// ACCESS CONTROL: scoped to the authenticated user. A user can only read
// messages in a chat they own.
//
// BOUND (load-bearing — see Convex guidelines: never .collect() unbounded):
// we read AT MOST `MESSAGE_WINDOW` most-recent messages via the `by_chat`
// index in descending creation order, then present them chronologically.
// Messages older than the window are intentionally NOT returned by this
// reactive query; a full-history/scrollback view should paginate (see
// `listByChatPaginated`) rather than widen this window.

import { v } from "convex/values";
import { query, mutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { STALE_STREAM_MS } from "./stuckStreams";
import {
  runStatusKind,
  textLenBucket,
  normalizeMessageErrorCode,
  mimeTypeBase,
} from "./lib/chatRenderState";
import { Id, Doc } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { deleteFilesByMessage } from "./lib/files";
import { enrichUserAgents, resolveAgentForChat } from "./agents";

// Hard upper bound on how many recent messages the reactive feed loads. Chosen
// to cover a typical visible conversation while keeping the query (and the
// per-message part fan-out below) cheap and bounded. Older history must be
// reached via pagination, not by raising this.
const MESSAGE_WINDOW = 200;

// A part as returned to the client. For media/file parts we resolve the Convex
// storage id to a signed URL (`url`) so the browser can render it directly;
// the raw storageId is intentionally NOT returned.
type ClientPart =
  | { kind: "tool"; name: string; phase: string; input?: unknown; output?: unknown }
  | { kind: "media"; url: string | null; filename: string; mimeType: string }
  | { kind: "file"; url: string | null; filename: string; mimeType: string }
  | { kind: "reasoning"; text: string }
  // Provenance reports (docs/PROVENANCE_CONTRACT.md). The REACTIVE projection
  // is COMPACT: item texts are stripped (Codex review P2 — the window-wide
  // stream must never carry megabytes of excerpts); `hasExcerpts` flags that
  // the on-demand getProvenanceParts query has more for this message.
  | {
      kind: "provenance";
      v: number;
      pluginId: string;
      source: string;
      group: "memory" | "documents";
      hasExcerpts?: boolean;
      injected?: { chars?: number; position?: string; truncated?: boolean };
      retrieval?: {
        route?: string;
        bank?: string;
        collections?: string[];
        lightragMode?: string;
      };
      items: {
        id?: string;
        type?: string;
        date?: string;
        score?: number;
        text?: string;
        file_name?: string;
        collection?: string;
      }[];
    };

/** Stored provenance part shape (matches the schema union variant). */
type StoredProvenancePart = Extract<
  ClientPart,
  { kind: "provenance" }
>;

/**
 * Reactive-stream projection of a provenance part: identical metadata, item
 * TEXTS stripped (they can weigh up to 32KB per report and the stream carries
 * the whole MESSAGE_WINDOW). `hasExcerpts` lets the UI decide whether
 * expanding the Sources panel should fetch getProvenanceParts.
 */
function compactProvenancePart(part: StoredProvenancePart): StoredProvenancePart {
  let hasExcerpts = false;
  const items = part.items.map((item) => {
    if (item.text === undefined) return item;
    hasExcerpts = true;
    const { text: _text, ...rest } = item;
    return rest;
  });
  return { ...part, items, ...(hasExcerpts ? { hasExcerpts: true } : {}) };
}

// Shared CORE of the chat view: the EXACT bounded read + per-message part
// resolution the client renders from. Extracted so the key-authed diagnostic
// (chatStateInternal) consumes the SAME data path as listByChat — a structural
// bug surfaces identically in both, never hidden behind a second implementation
// (the projection-drift the API was asked to eliminate). Auth + owner-scoping
// stay in the CALLERS; this core is identity-agnostic, keyed by a validated id.
async function loadChatView(ctx: QueryCtx, id: Id<"chats">) {
  // Bounded read: most-recent MESSAGE_WINDOW messages, newest first.
  const recentDesc = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", id))
      .order("desc")
      .take(MESSAGE_WINDOW);

    // Present chronologically (oldest -> newest) for rendering. The index's
    // descending order is already by creation time, so reversing is sufficient
    // and stable (no extra _creationTime sort needed).
    const messages = recentDesc.reverse();

    // Batch part resolution: fetch each message's parts in parallel. Convex has
    // no SQL join, so this is per-message — but the message set is bounded by
    // MESSAGE_WINDOW, so the fan-out is bounded too. Within a message, parts are
    // bounded by how many the bridge appended for that turn.
    const result = await Promise.all(
      messages.map(async (message) => {
        const partDocs = await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .collect();
        partDocs.sort((a, b) => a.order - b.order);

        const parts: ClientPart[] = [];
        for (const { part } of partDocs) {
          switch (part.kind) {
            case "tool":
              parts.push({
                kind: "tool",
                name: part.name,
                phase: part.phase,
                input: part.input,
                output: part.output,
              });
              break;
            case "media":
            case "file": {
              // Resolve storage id -> signed URL. Requires a live deployment to
              // produce a real URL; offline this returns null.
              const url = await ctx.storage.getUrl(part.storageId);
              parts.push({
                kind: part.kind,
                url,
                filename: part.filename,
                mimeType: part.mimeType,
              });
              break;
            }
            case "reasoning":
              parts.push({ kind: "reasoning", text: part.text });
              break;
            case "provenance":
              // COMPACT projection (Codex review P2): the reactive stream
              // carries the whole MESSAGE_WINDOW, so shipping the `full`-level
              // excerpts verbatim could reach tens of MB (200 msgs × 8
              // reports × 32KB) even with the Sources panel collapsed. Strip
              // item texts here; `hasExcerpts` tells the UI whether expanding
              // should fetch the bounded per-message detail
              // (getProvenanceParts) on demand.
              parts.push(compactProvenancePart(part));
              break;
          }
        }

        return {
          _id: message._id,
          chatId: message.chatId,
          _creationTime: message._creationTime,
          role: message.role,
          status: message.status,
          runId: message.runId,
          // A2 streaming: while streaming, the live tokens are in the un-indexed
          // `liveText`; at finalize the authoritative copy is in `text` and
          // `liveText` is cleared. Surface one `text` the client renders verbatim
          // (token-by-token live, then final) — no frontend change needed.
          text:
            message.status === "streaming"
              ? (message.liveText ?? message.text)
              : message.text,
          error: message.error,
          updatedAt: message.updatedAt,
          parts,
        };
      }),
    );

  return result;
}

export const listByChat = query({
  // v.string (NOT v.id): the chatId comes straight from the URL (/chat/$chatId)
  // and may be malformed (a truncated/typo'd deep link). With v.id a bad value
  // throws an ArgumentValidationError that surfaces as the router's raw "Something
  // went wrong" screen. We accept a string and validate via normalizeId instead.
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    // normalizeId validates the id FORMAT (null on a malformed shape). A
    // well-formed-but-deleted id passes here, then db.get returns null — so
    // malformed AND deleted both funnel to the same clean empty result the client
    // renders as "conversation introuvable". A chat owned by someone else still
    // throws (an IDOR signal, handled by the route fallback).
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const chat = await ctx.db.get(id);
    if (chat === null) return [];
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    return await loadChatView(ctx, id);
  },
});

/**
 * Diagnostic chat-state inspector behind the key-authed GET /api/v1/chat-state.
 *
 * SAME FUNCTIONS AS THE CLIENT: it consumes loadChatView (the EXACT data path
 * listByChat renders from) and the SHARED runStatusKind derivation — so a
 * structural/derived bug surfaces identically here and in the browser, with no
 * second implementation to drift.
 *
 * SOC2 / PHI: a POSITIVE-ALLOWLIST serializer — it emits STRUCTURE + LIFECYCLE
 * only, NEVER content (per the regulatory spec). No message text, filename,
 * storage URL, tool input/output, reasoning text or provenance source ever
 * leaves; `error` is normalized to a stable code, exact `textLen` is bucketed,
 * `mimeType` is reduced to its base. The no-content guarantee is pinned by a
 * sentinel test (see chatState.test). `internalQuery`: the HTTP route owns the
 * key auth + permission (traces.read).
 */
export const chatStateInternal = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return { ok: false as const, error: "bad chatId" };
    const chat = await ctx.db.get(id);
    if (chat === null) return { ok: false as const, error: "not found" };
    // SAME data path as the client.
    const view = await loadChatView(ctx, id);
    const now = Date.now();
    const messages = view.map((mDoc) => {
      const ageMs = now - mDoc.updatedAt;
      const hasText = (mDoc.text?.length ?? 0) > 0;
      // Redacted structural parts (allowlist) — presence/type/order, never bytes.
      const parts = mDoc.parts.map((p) => {
        switch (p.kind) {
          case "tool":
            return {
              kind: "tool" as const,
              name: p.name, // base tool name as stored (no instantiated args)
              phase: p.phase ?? null,
              hasInput: p.input !== undefined,
              hasOutput: p.output !== undefined,
            };
          case "media":
          case "file":
            return {
              kind: p.kind,
              mimeType: mimeTypeBase(p.mimeType),
              hasFilename: Boolean(p.filename),
              hasStorageUrl: p.url !== null && p.url !== undefined,
            };
          case "reasoning":
            return { kind: "reasoning" as const }; // presence only — never .text
          case "provenance":
            return { kind: "provenance" as const }; // presence only — never source/items
          default:
            return { kind: "unknown" as const };
        }
      });
      return {
        messageId: mDoc._id,
        role: mDoc.role,
        status: mDoc.status,
        runId: mDoc.runId ?? null,
        updatedAt: mDoc.updatedAt,
        ageSeconds: Math.round(ageMs / 1000),
        textLenBucket: textLenBucket(mDoc.text?.length ?? 0),
        errorCode: normalizeMessageErrorCode(mDoc.error), // stable code, never raw
        // Client's DERIVED render-state from the SHARED logic (runStatusView core).
        runStatusKind: runStatusKind(mDoc.status, hasText),
        stuckStreaming: mDoc.status === "streaming" && ageMs > STALE_STREAM_MS,
        partCount: parts.length,
        parts,
      };
    });
    return {
      ok: true as const,
      chatId: id,
      // The slug (instances.name), never the admin-settable displayName.
      instanceName: chat.instanceName ?? null,
      agentId: chat.agentId ?? null,
      messageCount: messages.length,
      streamingCount: messages.filter((m) => m.status === "streaming").length,
      stuckCount: messages.filter((m) => m.stuckStreaming).length,
      anyStreaming: messages.some((m) => m.status === "streaming"),
      messages,
    };
  },
});

/**
 * ON-DEMAND provenance detail for ONE message (Codex review P2): the reactive
 * listByChat ships the COMPACT projection (no item texts); the Sources panel
 * fetches the full reports — excerpts included — only when the user expands
 * it. Bounded by construction: a single message's provenance parts (bridge
 * caps: ≤8 reports × ≤32KB). Owner-scoped through the message's chat.
 */
export const getProvenanceParts = query({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const { userId } = await requireActive(ctx);
    const message = await ctx.db.get(messageId);
    if (message === null) return []; // deleted mid-expand: render nothing
    await requireOwnedChat(ctx, userId, message.chatId);
    const partDocs = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    partDocs.sort((a, b) => a.order - b.order);
    const parts: StoredProvenancePart[] = [];
    for (const { part } of partDocs) {
      if (part.kind === "provenance") parts.push(part);
    }
    return parts;
  },
});

// Chat-header read: the chat's title + OpenClaw session meta (model, reasoning
// level + its enum, verbosity, and the context-usage counts) so the top strip
// can render the model/reasoning chips + context meter. Owner-scoped; resilient
// to a just-deleted chat (returns null instead of throwing, so the reactive
// header does not error while the active chat is being removed).
export const getSessionMeta = query({
  // v.string + normalizeId (same rationale as listByChat): tolerate a malformed
  // URL chatId. Returns null for a malformed/deleted chat so the header renders
  // the clean "introuvable" state instead of throwing the router error screen.
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return null;
    const chat = await ctx.db.get(id);
    if (chat === null) return null;
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    return {
      title: chat.title ?? null,
      sessionMeta: chat.sessionMeta ?? null,
      // The user's explicit write-back intent (reasoning/model). The panel uses
      // it to mark which knob is an override vs inherited; the chip itself reads
      // sessionMeta (live truth).
      sessionSettings: chat.sessionSettings ?? null,
    };
  },
});

// Optional: list the chats owned by the authenticated user (sidebar). Scoped.
// Hard upper bound on how many recent chats the sidebar feed loads. Pinned chats
// are returned IN ADDITION (any age), so this caps only the unbounded "recent"
// tail, not the user's curated set.
const CHAT_WINDOW = 200;
// Hard ceiling on rows SCANNED while filling the recency window. The recency
// index (`by_user_updated`) is shared by archived chats, so a naive
// `take(CHAT_WINDOW)` could be entirely consumed by archived rows and evict
// active chats from the sidebar when a user has >= CHAT_WINDOW archived chats
// more recent than their active ones (Codex P2). We instead scan desc, SKIP
// archived, and stop at CHAT_WINDOW kept OR this cap — bounding the read either
// way. MUST be > CHAT_WINDOW: a value equal to it would break the scan at exactly
// CHAT_WINDOW archived rows and re-introduce the eviction.
const CHAT_RECENT_SCAN_CAP = CHAT_WINDOW * 5;

export const listChats = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    // BOUND (load-bearing — see Convex guidelines: never .collect() unbounded).
    // The sidebar must NOT read ALL of a user's chats: that scan grows forever and
    // on a heavy account exceeds Convex's per-function operation budget (observed
    // in prod: listChats failing "too many system operations" under load). Read AT
    // MOST CHAT_WINDOW most-recent NON-ARCHIVED chats by updatedAt, UNIONed with
    // every PINNED chat regardless of age — a pinned chat is explicitly kept by the
    // user, so the recency window must never silently drop it. Non-pinned chats
    // older than the window fall off the sidebar (still reachable via global search
    // / direct URL), as in every mainstream chat app.
    //
    // DELIBERATE tradeoff: a NON-pinned chat that was manually drag-ordered
    // (`sortKey`) but is older than the window also falls off. We do NOT union the
    // drag-ordered set: it would reintroduce an unbounded read, and drag-order is a
    // soft preference (pinning is the strong "keep this" signal). The chat re-enters
    // the sidebar on its next activity (updatedAt bumps back into the window).
    // Fill the recency window with NON-ARCHIVED chats. A plain take(CHAT_WINDOW)
    // here would let archived chats — which share this index — consume the window
    // and push active chats off the sidebar (Codex P2). Scan desc, SKIP archived,
    // stop at CHAT_WINDOW kept OR CHAT_RECENT_SCAN_CAP scanned. Async iteration
    // reads lazily, so `break` ends the scan — the read stays bounded either way.
    // `!c.archived` treats both undefined (legacy) and false as active, so no data
    // assumption is needed. DELIBERATE residual (mirrors the sortKey tradeoff
    // below): a user with MORE than CHAT_RECENT_SCAN_CAP archived chats newer than
    // an active one can still push that active chat off — acceptable, and there is
    // no archive feature today.
    const recent: Doc<"chats">[] = [];
    let scanned = 0;
    for await (const c of ctx.db
      .query("chats")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")) {
      if (++scanned > CHAT_RECENT_SCAN_CAP) break;
      if (c.archived) continue;
      recent.push(c);
      if (recent.length >= CHAT_WINDOW) break;
    }
    // Pinned set, BOUNDED too (same op-budget discipline as `recent` — never an
    // unbounded .collect()). Pinning is a deliberate per-chat action; a curated set
    // is ≪ CHAT_WINDOW in practice. The cap only bites a pathological pinner, who
    // would lose the oldest-pinned overflow from the sidebar — never a data loss.
    const pinnedRows = await ctx.db
      .query("chats")
      .withIndex("by_user_pinned", (q) =>
        q.eq("userId", userId).eq("pinned", true),
      )
      .take(CHAT_WINDOW);
    // Union by id (same doc from either source — last write wins, identical).
    const byId = new Map<Id<"chats">, Doc<"chats">>();
    for (const c of recent) byId.set(c._id, c);
    for (const c of pinnedRows) byId.set(c._id, c);
    const chats = [...byId.values()];
    // Single comparator: pinned first, then manual sortKey (asc), then recency.
    // Manual order WINS over recency (user explicitly drags); recency is only a
    // tiebreaker for chats that have never been ordered.
    chats.sort((a, b) => {
      const pa = a.pinned ? 0 : 1;
      const pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ka = a.sortKey ?? 0;
      const kb = b.sortKey ?? 0;
      if (ka !== kb) return ka - kb;
      return b.updatedAt - a.updatedAt;
    });

    // Per-chat provider kind (OpenClaw vs Hermes) for the sidebar's self-hiding
    // bridge badge. Resolved through the SAME `resolveAgentForChat` the header
    // chip uses (and that mirrors dispatch): a chat bound to a deleted/revoked
    // agent — or with a deleted default — resolves to the agent the NEXT turn
    // actually uses, so the badge can't name a bridge that won't handle the turn.
    // BATCHED: `enrichUserAgents` loads the user's agents + their instance kinds
    // ONCE (it already maps a kind-unset legacy instance to "openclaw"); then each
    // chat is mapped purely. The frontend shows the badge ONLY when chats span >1
    // kind (invisible until Hermes).
    const agents = await enrichUserAgents(ctx, userId);
    const kindOf = (c: { instanceName?: string; agentId?: string }) =>
      resolveAgentForChat(agents, c)?.kind ?? null;

    return chats
      .filter((c) => !c.archived)
      .map((c) => ({
        _id: c._id as Id<"chats">,
        title: c.title,
        updatedAt: c.updatedAt,
        projectId: c.projectId ?? null,
        sortKey: c.sortKey ?? 0,
        pinned: c.pinned ?? false,
        color: c.color ?? null,
        providerKind: kindOf(c),
      }));
  },
});

// Delete a message (owner-scoped) with the TRUNCATE-FORWARD semantics the product
// requires, PLUS the gateway realignment the trust requirement demands:
//   - User message deleted      -> delete it + ALL following turns (rewind).
//   - Assistant message deleted -> delete it + ALL following, then RE-RUN the
//     now-last user message (regenerate). For the LAST assistant turn (the common
//     case) this is exactly "delete + regenerate"; for a mid-thread one it rewinds
//     to that point then regenerates (a coherent superset of the literal ask).
// CRITICAL (advisor): deleting in Convex does NOT remove the turn from the OpenClaw
// SESSION context. So on every truncating delete we schedule a `sessions.reset`
// (bridge): reset -> systemSent=false -> the next turn re-hydrates from the
// TRUNCATED Convex state, realigning the gateway. Without it the model would keep
// reasoning over turns the user deleted and no longer sees — a trust violation.
// (docs/SESSION_CONTINUITY_DESIGN.md; OUTCOME proof gated on NAS #62.)
export const deleteMessage = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const { userId, actor } = await requireActive(ctx);
    const message = await ctx.db.get(messageId);
    if (message === null) return; // already gone (e.g. double-click)
    const chat = await requireOwnedChat(ctx, userId, message.chatId);

    // Do not delete a turn mid-stream — the bridge's finalize would then throw on
    // a missing message. Ask the user to wait for the reply to settle.
    if (message.status === "streaming") {
      throw new Error("Patientez la fin de la réponse avant de supprimer.");
    }

    const wasAssistant = message.role === "assistant";
    const cutoff = message._creationTime;

    // This message + every later one in the chat (truncate forward). Bounded read.
    const chatMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
      .collect();
    for (const m of chatMessages) {
      if (m._creationTime < cutoff) continue;
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const p of parts) await ctx.db.delete(p._id);
      // Mirror the files-row invariant on the part deletion (delete + regenerate).
      await deleteFilesByMessage(ctx, m._id);
      await ctx.db.delete(m._id);
    }

    // Drop this chat's pending outbox so a stale dispatch cannot resurrect a
    // deleted turn (mirrors chats.cascadeDeleteChat).
    const pending = await ctx.db
      .query("outbox")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    for (const o of pending) {
      if (o.chatId === chat._id) await ctx.db.delete(o._id);
    }

    // Assistant delete -> regenerate the now-last user message (if any): build a
    // fresh outbox from that user turn (text + its file attachments). dispatchReset
    // runs it AFTER the gateway reset, so it re-hydrates the truncated history.
    let regenerateOutboxId: Id<"outbox"> | undefined;
    if (wasAssistant) {
      const remaining = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
        .order("desc")
        .take(1);
      const lastUser = remaining[0];
      if (lastUser && lastUser.role === "user") {
        const partDocs = await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", lastUser._id))
          .collect();
        const attachments: {
          storageId: Id<"_storage">;
          filename: string;
          mimeType: string;
        }[] = [];
        for (const d of partDocs) {
          if (d.part.kind === "file") {
            attachments.push({
              storageId: d.part.storageId,
              filename: d.part.filename,
              mimeType: d.part.mimeType,
            });
          }
        }
        regenerateOutboxId = await ctx.db.insert("outbox", {
          chatId: chat._id,
          userId,
          // Unique key (Date.now() is deterministic in a mutation) so the send
          // idempotency guard never dedupes a regenerate against the original.
          clientMessageId: `regen-${lastUser._id}-${Date.now()}`,
          messageId: lastUser._id,
          text: lastUser.text,
          attachmentIds: attachments.map((a) => a.storageId),
          attachments,
          status: "pending",
        });
      }
    }

    // ALWAYS realign the gateway. For the regenerate case dispatchReset chains the
    // re-dispatch AFTER a successful reset (so it runs on the fresh, re-hydrating
    // session — never on the stale one).
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchReset, {
      chatId: chat._id,
      userId,
      ...(regenerateOutboxId ? { regenerateOutboxId } : {}),
    });

    await ctx.db.patch(chat._id, { updatedAt: Date.now() });
    await auditImpersonated(ctx, actor, "message.delete", {
      resource: "message",
      resourceId: messageId,
    });
  },
});
