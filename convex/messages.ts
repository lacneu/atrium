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
import { provenancePartStructure } from "./lib/provenance";
import { Id, Doc } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { DEFAULT_STREAM_TRANSPORT } from "./lib/instanceConfig";
import { resolveTargetForChat } from "./routing";
import { auditImpersonated } from "./lib/audit";
import { deleteFilesByMessage } from "./lib/files";
import { enrichUserAgents, resolveAgentForChat } from "./agents";
import { invalidateSummaryOnDeletion } from "./chatSummaries";
import { compareOrder, effectiveOrder } from "./lib/messageOrder";
import { releaseDanglingDocumentaryFetch } from "./documentAttachments";
import {
  classifySubAgentError,
  shortChildId,
  type SubAgentStatus,
} from "./lib/subAgentFailure";

// Hard upper bound on how many recent messages the reactive feed loads. Chosen
// to cover a typical visible conversation while keeping the query (and the
// per-message part fan-out below) cheap and bounded. Older history must be
// reached via pagination, not by raising this.
const MESSAGE_WINDOW = 200;

// Bounded caps for the key-authed chat-state diagnostic reads (NEVER the
// unbounded listSubAgents.collect()): mirror subAgentReports' bounded
// by_chat_status point-ranges. Each is a CONSTANT number of indexed reads
// regardless of how many messages / sub-agents a long-lived chat accumulates —
// so this MCP-hit path can't reintroduce the listChats "too many system
// operations" read-amplification. A slice that hits the cap is flagged
// (`truncated`), never silently dropped.
const CHAT_STATE_SUBAGENT_CAP = 20; // per status (sample + count cap)
const CHAT_STATE_OUTBOX_CAP = 50; // per status, recent-first

// A part as returned to the client. For media/file parts we resolve the Convex
// storage id to a signed URL (`url`) so the browser can render it directly;
// the raw storageId is intentionally NOT returned.
type ClientPart =
  // Oversized `input`/`output` are ELIDED from this window projection (see
  // PART_FIELD_CAP): a big tool dump (e.g. a 15KB web_search result) re-pushed in
  // full on every window change stalled the WAN. `*Omitted` + `*Bytes` let the UI
  // show a "(N KB, not loaded here)" line; the full value stays in the DB.
  | {
      kind: "tool";
      name: string;
      phase: string;
      input?: unknown;
      inputOmitted?: boolean;
      inputBytes?: number;
      output?: unknown;
      outputOmitted?: boolean;
      outputBytes?: number;
    }
  // `storageId` is exposed (as an opaque string) ONLY so the Document Viewer can
  // request a PDF rendition of an Office file (fileRenditions.requestRendition).
  // SAFE despite the general "no raw storageId to the client" rule: every
  // rendition op is OWNERSHIP-gated server-side (ownedFile) and READ-ONLY — this
  // is NOT the delete-IDOR class (a client-provided id the SERVER deletes). The
  // signed `url` already embeds the same storage path, so this reveals nothing new.
  | { kind: "media"; url: string | null; storageId: string; filename: string; mimeType: string }
  | { kind: "file"; url: string | null; storageId: string; filename: string; mimeType: string }
  // Gateway context-compaction marker (content-free: phase + timestamp).
  | { kind: "compaction"; phase: string; at: number }
  // `text` elided when oversized (same rationale as tool fields).
  | { kind: "reasoning"; text?: string; textOmitted?: boolean; textBytes?: number }
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
        // Additive (provenance/v1): human display name for a document item. Carried to
        // the client as metadata (not stripped by compactProvenancePart); the Sources
        // view shows it as the title while file_name stays the retrieval/attach key.
        title?: string;
        collection?: string;
        // Additive (provenance/v1): documents-group synthesized context excerpt —
        // carried through to the client so the Sources view classifies it (see
        // convex/lib/provenance.ts). Text is stripped by compactProvenancePart; this
        // metadata flag is not.
        context?: boolean;
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

// Oversized tool/reasoning part fields are ELIDED from the window projection.
// loadChatView ships the WHOLE MESSAGE_WINDOW and re-runs on any message change
// (e.g. finalize), so a large field — measured: a single web_search turn carried
// ~89KB of raw tool `output`, re-pushed in full over the WS on each change —
// stalled delivery over the WAN. The full value stays in the DB (and in the
// stored part); only this reactive read drops it, flagged with `*Bytes` so the UI
// renders a "(N KB, not shown here)" line instead of the payload. Cap chosen from
// the wire: ordinary tool outputs are ≤~6KB, the pathological dumps are 10–15KB.
const PART_FIELD_CAP = 8192;
// Real UTF-8 byte size (what crosses the wire), NOT UTF-16 `.length`: a CJK/emoji
// field is multi-byte, so `.length` undercounts and would let an oversized payload
// slip past the cap (and mis-report its size).
const utf8 = new TextEncoder();
const fieldBytes = (v: unknown): number =>
  v === undefined ? 0 : utf8.encode(JSON.stringify(v)).length;

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

    // Present in LOGICAL turn order (see lib/messageOrder): identical to creation
    // time for idle sends + assistants, but a mid-turn QUEUE follow-up's orderTime
    // places it AFTER the in-flight turn instead of where its early _creationTime
    // fell. The window above is still read by _creationTime — valid because an
    // orderTime-bearing row always has a recent _creationTime (it can't escape the
    // newest-N window). Tie-break by _creationTime for a stable order.
    const messages = [...recentDesc].sort(compareOrder);

    // Dispatch lifecycle per message (queued | pending | sent | failed) — a CONSTANT
    // 4-read budget (see loadOutboxByMessage), NOT per-message. The frontend reads
    // `outbox.status === "queued"` to badge a mid-turn QUEUE follow-up "En attente"
    // (message badge + the synthetic placeholder RunStatus). Outbox transitions are
    // infrequent (send/dispatch/drain), NOT per-token, so this does not reintroduce a
    // per-delta re-run of this heavy view.
    const { byMessage: outboxByMsg } = await loadOutboxByMessage(ctx, id);

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
            case "tool": {
              // Elide oversized input/output from the window read (see PART_FIELD_CAP).
              const inBytes = fieldBytes(part.input);
              const outBytes = fieldBytes(part.output);
              parts.push({
                kind: "tool",
                name: part.name,
                phase: part.phase,
                ...(inBytes > PART_FIELD_CAP
                  ? { inputOmitted: true, inputBytes: inBytes }
                  : { input: part.input }),
                ...(outBytes > PART_FIELD_CAP
                  ? { outputOmitted: true, outputBytes: outBytes }
                  : { output: part.output }),
              });
              break;
            }
            case "media":
            case "file": {
              // Resolve storage id -> signed URL. Requires a live deployment to
              // produce a real URL; offline this returns null.
              const url = await ctx.storage.getUrl(part.storageId);
              parts.push({
                kind: part.kind,
                url,
                storageId: part.storageId,
                filename: part.filename,
                mimeType: part.mimeType,
              });
              break;
            }
            case "reasoning": {
              const tBytes = fieldBytes(part.text);
              parts.push(
                tBytes > PART_FIELD_CAP
                  ? { kind: "reasoning", textOmitted: true, textBytes: tBytes }
                  : { kind: "reasoning", text: part.text },
              );
              break;
            }
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
            case "compaction":
              // Gateway context-compaction marker (content-free by construction:
              // phase + timestamp). Always shipped — the user-facing "context was
              // optimized" note is not a tool detail.
              parts.push({ kind: "compaction", phase: part.phase, at: part.at });
              break;
          }
        }

        return {
          _id: message._id,
          chatId: message.chatId,
          _creationTime: message._creationTime,
          // Logical-order stamp (fork copies carry the SOURCE time here) — the
          // client shows `orderTime ?? _creationTime` as the message's moment.
          orderTime: message.orderTime,
          role: message.role,
          status: message.status,
          runId: message.runId,
          // MULTI-AGENT per-turn routing (read projection only — routing/dispatch is
          // owned server-side). Which agent THIS turn was addressed to; absent on a
          // single-agent message. The frontend attributes each reply (inheriting the
          // preceding user turn's agent for an assistant that lacks its own) and
          // defaults the composer to the last-used agent.
          routedInstanceName: message.routedInstanceName,
          routedAgentId: message.routedAgentId,
          // The live streaming tokens of a CURRENT-version turn live in the
          // `streamingText` table (read by the cheap getStreamingText), so this heavy
          // view does not re-run per delta — the frontend overlays them by id. The
          // `liveText ?? text` fallback is for a message that was MID-STREAM across
          // the deploy to the split: its tokens are still on the legacy `liveText`
          // and it has no streamingText row, so without this it would render empty
          // until its next delta/finalize. SAFE for the perf goal: the new write path
          // never writes `liveText` per delta (it writes streamingText), so reading it
          // here cannot reintroduce a per-delta re-run.
          text:
            message.status === "streaming"
              ? (message.liveText ?? message.text)
              : message.text,
          error: message.error,
          errorCode: message.errorCode, // stable curated code (set by failDispatch)
          // L2: ready downloadable-attachment count (subtle Sources-chip badge).
          attachedDocCount: message.attachedDocCount,
          // Dispatch lifecycle (queued | pending | sent | failed); null when no outbox
          // row (assistant messages; or a user message older than the outbox read cap).
          // Drives the mid-turn QUEUE "En attente" badge + placeholder.
          outbox: outboxByMsg.get(message._id) ?? null,
          updatedAt: message.updatedAt,
          parts,
        };
      }),
    );

  return result;
}

/**
 * Bounded reverse map messageId -> { outboxId, status } for a chat (the dispatch
 * JOIN KEY). FOUR indexed point-range reads (one per lifecycle status, capped),
 * joined in memory — a CONSTANT read budget independent of message count. (A
 * per-message `outbox.by_message` reverse lookup would be O(messages) on a
 * key-authed/MCP path — the exact read-amplification the listChats incident
 * warns against.) `outbox` rows are never deleted for a live chat, so the key is
 * durably recoverable, not just for in-flight turns. The resulting
 * `chatId:outboxId` is the correlationId of this turn's chat.send / openclaw.dispatch
 * (and the forthcoming openclaw.rehydrate) traces — so a chat-state message can be
 * stitched to its dispatch chain via list_traces. `truncated` flags a status slice
 * that hit the cap (a very long chat), never a silent drop.
 */
async function loadOutboxByMessage(
  ctx: QueryCtx,
  chatId: Id<"chats">,
): Promise<{
  byMessage: Map<string, { outboxId: Id<"outbox">; status: string }>;
  truncated: boolean;
}> {
  const byMessage = new Map<
    string,
    { outboxId: Id<"outbox">; status: string }
  >();
  let truncated = false;
  const STATUSES = ["queued", "pending", "sent", "failed"] as const;
  for (const status of STATUSES) {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", status),
      )
      .order("desc")
      .take(CHAT_STATE_OUTBOX_CAP + 1);
    if (rows.length > CHAT_STATE_OUTBOX_CAP) truncated = true;
    for (const r of rows.slice(0, CHAT_STATE_OUTBOX_CAP)) {
      // Recent-first within a status; a message maps to exactly one outbox row in
      // practice (dedup on clientMessageId), so first write wins.
      if (r.messageId !== undefined && !byMessage.has(r.messageId)) {
        byMessage.set(r.messageId, { outboxId: r._id, status });
      }
    }
  }
  return { byMessage, truncated };
}

/** One content-free sub-agent row for the chat-state summary. */
type SubAgentEntry = {
  childIdShort: string;
  status: SubAgentStatus;
  errorCategory: string;
  hasTaskName: boolean;
  // The spawning assistant message — surfaces the parent<->child CORRELATION for
  // debugging (a structural message id only, never content; SOC2-safe). null for a
  // row written before parentMessageId tagging. This is the field whose absence made
  // a "delegated turn shows no sub-agent" bug hard to diagnose from the obs API.
  parentMessageId: string | null;
  // How many tools the child has used (COUNT only — never names/args; SOC2-safe).
  toolCount: number;
  // The child's STATIC session config (CONFIG, not content — SOC2-safe): model /
  // reasoning / speed / control scope / role / depth. Lets the obs MCP diagnose a
  // misconfigured sub-agent (wrong model, unexpected scope/depth) without any content.
  // The parent session key is NEVER surfaced (it embeds the canonical + chatId).
  model: string | null;
  modelProvider: string | null;
  thinkingLevel: string | null;
  fastMode: boolean | null;
  controlScope: string | null;
  subagentRole: string | null;
  spawnDepth: number | null;
  // Spawn-time config (CONFIG, SOC2-safe). NOTE: `context:"fork"` means the child's
  // captured CONTENT is higher-sensitivity (parent transcript branched in) — the FLAG
  // is fine here, but this MUST NOT widen what content the observability path exposes.
  context: string | null;
  runtime: string | null;
  mode: string | null;
  cleanup: string | null;
  sandbox: string | null;
  gatewayKind: string | null;
  ageSeconds: number;
};

/**
 * CONTENT-FREE per-chat sub-agent summary for the diagnostic (G3 — make a failed/
 * stuck delegation visible to the MCP, not only to the UI monitor + a user-flagged
 * anomaly). Bounded reads via `by_chat_status` (running/done/error/aborted,
 * capped) — mirrors subAgentReports' point-ranges, NEVER the unbounded
 * listSubAgents.collect().
 *
 * SOC2: every per-child field is derived through the lib/subAgentFailure
 * content-free helpers (classifySubAgentError -> a FIXED enum, shortChildId -> an
 * opaque id tail) or a boolean (hasTaskName). The raw taskName / errorMessage /
 * resultText / phase are NEVER read into the output — `phase` in particular is a
 * free-form gateway string and is treated as content (the sentinel test seeds it
 * and asserts its absence).
 */
async function loadSubAgentSummary(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  now: number,
): Promise<{
  total: number;
  byStatus: { running: number; done: number; error: number; aborted: number };
  failedSample: SubAgentEntry[];
  runningSample: SubAgentEntry[];
  truncated: boolean;
}> {
  // Read each status slice via (chatId, status, updatedAt) so ordering is by the
  // STALENESS signal the detectors use, not by _creationTime:
  //   - running ASC  -> STALEST-updated first, so the stuck child (oldest updatedAt,
  //     ageSeconds > STUCK_SUBAGENT_SECONDS) is ALWAYS within the cap and the
  //     subagent_stuck detector is never blind to it (Codex P2: a newest-first
  //     sample drops exactly the oldest running rows the stuck check needs).
  //   - error/aborted DESC -> most-recently-updated first, so a RECENT failure (the
  //     subagent_failure signal) is within the cap.
  //   - done DESC -> count only (order irrelevant).
  const readStatus = (status: SubAgentStatus, dir: "asc" | "desc") =>
    ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_updated", (q) =>
        q.eq("chatId", chatId).eq("status", status),
      )
      .order(dir)
      .take(CHAT_STATE_SUBAGENT_CAP + 1);
  const [running, done, errored, aborted] = await Promise.all([
    readStatus("running", "asc"),
    readStatus("done", "desc"),
    readStatus("error", "desc"),
    readStatus("aborted", "desc"),
  ]);
  const cap = CHAT_STATE_SUBAGENT_CAP;
  const truncated =
    running.length > cap ||
    done.length > cap ||
    errored.length > cap ||
    aborted.length > cap;
  const capRows = <T,>(rows: T[]): T[] => rows.slice(0, cap);
  const byStatus = {
    running: capRows(running).length,
    done: capRows(done).length,
    error: capRows(errored).length,
    aborted: capRows(aborted).length,
  };
  const toEntry = (c: Doc<"subAgents">): SubAgentEntry => ({
    childIdShort: shortChildId(c.childSessionKey),
    status: c.status,
    // PATTERN-MATCHES the raw error but RETURNS ONLY a fixed enum (never the text).
    errorCategory: classifySubAgentError(c.status, c.errorMessage),
    // Presence boolean ONLY — never the taskName text.
    hasTaskName: typeof c.taskName === "string" && c.taskName.trim() !== "",
    // The spawning message id (structural, SOC2-safe) — the correlation link.
    parentMessageId: c.parentMessageId ?? null,
    // Count of the child's tools (never the names/args).
    toolCount: c.tools?.length ?? 0,
    // Static session config (CONFIG, SOC2-safe) — null until the first session frame.
    model: c.sessionMeta?.model ?? null,
    modelProvider: c.sessionMeta?.modelProvider ?? null,
    thinkingLevel: c.sessionMeta?.thinkingLevel ?? null,
    fastMode: c.sessionMeta?.fastMode ?? null,
    controlScope: c.sessionMeta?.controlScope ?? null,
    subagentRole: c.sessionMeta?.subagentRole ?? null,
    spawnDepth: c.sessionMeta?.spawnDepth ?? null,
    context: c.sessionMeta?.context ?? null,
    runtime: c.sessionMeta?.runtime ?? null,
    mode: c.sessionMeta?.mode ?? null,
    cleanup: c.sessionMeta?.cleanup ?? null,
    sandbox: c.sessionMeta?.sandbox ?? null,
    gatewayKind: c.sessionMeta?.gatewayKind ?? null,
    ageSeconds: Math.round((now - c.updatedAt) / 1000),
  });
  // Failed = error ∪ aborted, newest-first (each slice already desc by creation).
  const failedSample = [...capRows(errored), ...capRows(aborted)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, cap)
    .map(toEntry);
  const runningSample = capRows(running).map(toEntry);
  return {
    total: byStatus.running + byStatus.done + byStatus.error + byStatus.aborted,
    byStatus,
    failedSample,
    runningSample,
    truncated,
  };
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
 * The LIVE streaming text for a chat's in-flight assistant turn(s) — the CHEAP,
 * high-frequency companion to `listByChat`. The bridge's per-delta writes land in
 * `streamingText` (not the `messages` doc), so THIS query re-runs token-by-token
 * while the heavy `listByChat`/`loadChatView` does NOT (it only re-runs when the
 * message set / parts change). The frontend overlays each row onto its streaming
 * message by `messageId`. Owner-scoped (same IDOR guard as listByChat); a stable
 * empty array for a malformed/deleted/foreign chat. Typically 0-1 rows (one
 * in-flight turn per chat); bounded by the chat's streaming set regardless.
 */
export const getStreamingText = query({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const chat = await ctx.db.get(id);
    if (chat === null) return [];
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    const rows = await ctx.db
      .query("streamingText")
      .withIndex("by_chat", (q) => q.eq("chatId", id))
      .collect();
    return rows.map((r) => ({
      messageId: r.messageId,
      text: r.text,
      // SSE transport (Phase 4): the reactive frontier seq, so the runtime can tell a
      // REPLAYING SSE connection (its lastSeq is behind this) from one AT the frontier
      // (>=). That's what lets the SSE win on a `replace`-shrink yet NOT regress during a
      // reload replay. OMITTED when no chunk is written yet (Convex rejects an undefined
      // returned property).
      ...(r.chunkSeq !== undefined ? { chunkSeq: r.chunkSeq } : {}),
      // Live processing phase (Tools-ON placeholder detail) — absent on plain turns.
      ...(r.phase !== undefined ? { phase: r.phase } : {}),
      // In-band delivery-recorder fields, present ONLY while a recording is active
      // (appendDelta/setSnapshot stamp them) -> zero added payload otherwise. The
      // frontend reads recTimingId (the timing row's correlator) to stamp t4 and
      // close segment C (convex/deliveryTiming.ts).
      ...(r.recTimingId !== undefined
        ? { recTimingId: r.recTimingId, recCommittedAt: r.recCommittedAt }
        : {}),
    }));
  },
});

// SSE transport (Phase 4b): the live-stream transport CHOSEN for this chat's gateway
// instance (reactive | sse), so the frontend runtime knows whether to consume the SSE
// endpoint or stay on the reactive push. Per-instance config (Settings>Agents>Bridge);
// defaults to reactive when the chat has no instance / no override. Not sensitive (a
// display preference) but gated to the chat owner; a non-owned/absent chat -> the default.
export const getChatStreamTransport = query({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return DEFAULT_STREAM_TRANSPORT;
    const chat = await ctx.db.get(id);
    if (chat === null || chat.userId !== userId) return DEFAULT_STREAM_TRANSPORT;
    // Resolve the SAME routed target as dispatch (resolveTargetForChat: honor the chat's
    // binding, else the default agent + rebind) rather than the raw chat.instanceName — so a
    // legacy / unbound / stale-bound chat reads the instance ACTUALLY used (Codex review).
    // Mirrors getChatInboundPolicy.
    const res = await resolveTargetForChat(ctx, chat, userId);
    const instanceName = res.target?.instanceName ?? null;
    if (instanceName === null) return DEFAULT_STREAM_TRANSPORT;
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    return instance?.streamTransport ?? DEFAULT_STREAM_TRANSPORT;
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
    // The streaming HEARTBEAT + live length live on streamingText now (not the
    // message doc, whose updatedAt is frozen at the turn's start during streaming).
    // Read them so the stuck-stream + length signals stay accurate.
    const streamRows = await ctx.db
      .query("streamingText")
      .withIndex("by_chat", (q) => q.eq("chatId", id))
      .collect();
    const streamByMsg = new Map(streamRows.map((r) => [r.messageId, r]));
    // Dispatch JOIN KEY (G4 + the turn-reconstruction spine): map each message to
    // its outbox row id + lifecycle status, via a CONSTANT 4 indexed reads (not a
    // per-message reverse lookup). `chatId:outboxId` is the correlationId of the
    // turn's chat.send / openclaw.dispatch traces — the key that stitches a
    // chat-state message to its dispatch chain in list_traces.
    const { byMessage: outboxByMsg, truncated: outboxTruncated } =
      await loadOutboxByMessage(ctx, id);
    const messages = view.map((mDoc) => {
      const live =
        mDoc.status === "streaming" ? streamByMsg.get(mDoc._id) : undefined;
      // For a streaming message use the live-text row's heartbeat/length; else the
      // message doc (a finalized message, or a streaming one missing its row in the
      // rare race, falls back to the doc).
      const effectiveUpdatedAt = live ? live.updatedAt : mDoc.updatedAt;
      const ageMs = now - effectiveUpdatedAt;
      const effectiveLen = live ? live.text.length : (mDoc.text?.length ?? 0);
      const hasText = effectiveLen > 0;
      // Redacted structural parts (allowlist) — presence/type/order, never bytes.
      const parts = mDoc.parts.map((p) => {
        switch (p.kind) {
          case "tool":
            return {
              kind: "tool" as const,
              name: p.name, // base tool name as stored (no instantiated args)
              phase: p.phase ?? null,
              // Account for fields ELIDED by loadChatView (this consumes its view):
              // an oversized input/output is dropped but flagged, so presence must
              // OR in the omitted flag — else a big tool reads as having no IO.
              hasInput: p.input !== undefined || p.inputOmitted === true,
              hasOutput: p.output !== undefined || p.outputOmitted === true,
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
            // SOC2-safe STRUCTURE (convex/lib/provenance.ts): Atrium-derived item
            // kinds + presence booleans + allowlisted group/source/route + counts —
            // NEVER a file_name / excerpt / score VALUE. Lets the MCP diagnose e.g.
            // "the document items carry no score and no excerpt" (a bare LightRAG
            // attribution turn) without exposing any content.
            return {
              kind: "provenance" as const,
              structure: provenancePartStructure(p),
            };
          case "compaction":
            // Content-free by construction (phase + timestamp): the gateway
            // compacted this turn — pairs with the chat.gateway_pressure trace.
            return { kind: "compaction" as const, phase: p.phase };
          default:
            return { kind: "unknown" as const };
        }
      });
      return {
        messageId: mDoc._id,
        role: mDoc.role,
        status: mDoc.status,
        runId: mDoc.runId ?? null,
        // MULTI-AGENT per-turn routing (G1): which agent THIS turn was routed to —
        // null = the chat's primary agent. Non-secret slugs (same class as the
        // chat-level instanceName/agentId already exposed). Lets the MCP see a
        // switched turn that the rehydration/context bug hinges on.
        routedInstanceName: mDoc.routedInstanceName ?? null,
        routedAgentId: mDoc.routedAgentId ?? null,
        // Dispatch JOIN KEY + lifecycle (G4): the outbox row id (-> correlationId
        // chatId:outboxId) and its status (queued | pending | sent | failed). null
        // when no outbox row (assistant messages; or a user message older than the
        // outbox read cap — see outboxTruncated).
        outbox: outboxByMsg.get(mDoc._id) ?? null,
        updatedAt: effectiveUpdatedAt,
        ageSeconds: Math.round(ageMs / 1000),
        textLenBucket: textLenBucket(effectiveLen),
        // Prefer the STORED stable code (set by failDispatch) so a dispatch failure
        // is classified precisely; fall back to normalizing the error text (the
        // path for gateway/stream errors that only carry a text reason).
        errorCode: mDoc.errorCode ?? normalizeMessageErrorCode(mDoc.error),
        // Client's DERIVED render-state from the SHARED logic (runStatusView core).
        runStatusKind: runStatusKind(mDoc.status, hasText),
        stuckStreaming: mDoc.status === "streaming" && ageMs > STALE_STREAM_MS,
        // L2: count of READY downloadable document attachments fetched for this
        // reply (a COUNT — never references/filenames). null when none.
        attachedDocCount: mDoc.attachedDocCount ?? null,
        partCount: parts.length,
        parts,
      };
    });
    // CONTENT-FREE sub-agent summary (G3): make a failed / stuck delegation visible
    // to the MCP, not only the UI monitor. Bounded reads; enums + counts + opaque
    // ids only (see loadSubAgentSummary).
    const subAgents = await loadSubAgentSummary(ctx, id, now);
    return {
      ok: true as const,
      chatId: id,
      // The slug (instances.name), never the admin-settable displayName.
      instanceName: chat.instanceName ?? null,
      agentId: chat.agentId ?? null,
      // MULTI-AGENT per-turn routing at the chat level (G1): has the chat flipped to
      // per-turn routing, and what was the LAST-routed agent + the gateway session
      // SEGMENT the bridge keys on (`turn:<id>`, an opaque token). Non-secret slugs +
      // an opaque id — the chat-level half of the routing picture the rehydration /
      // switched-context bug needs (the dispatch half rides openclaw.rehydrate traces).
      routing: {
        perTurnRouting: chat.perTurnRouting === true,
        lastRoutedInstanceName: chat.lastRoutedInstanceName ?? null,
        lastRoutedAgentId: chat.lastRoutedAgentId ?? null,
        routingSegment: chat.routingSegment ?? null,
      },
      // CONTENT-FREE sub-agent summary (G3): counts by lifecycle status + a capped
      // failed/running sample (enums + opaque ids only). `truncated` flags a status
      // slice past the cap.
      subAgents,
      // The dispatch JOIN-KEY read hit its per-status cap (a very long chat): some
      // older messages' `outbox` may read null even though a row exists. Honest flag,
      // never a silent omission.
      outboxTruncated,
      // L2: the HIDDEN per-user documentary chat is tagged `kind:"documentary"`; a
      // diagnostic consumer keys off this (it's excluded from the sidebar).
      kind: chat.kind ?? null,
      // L2: an in-flight document fetch. A LARGE ageSeconds = a STUCK fetch (the
      // owner is locked out by the fetch_in_flight guard until the watchdog releases
      // it) — the primary L2 anomaly signal. sourceMessageId is an opaque id (SOC2).
      pendingDocFetch: chat.pendingFetch
        ? {
            sourceMessageId: chat.pendingFetch.sourceMessageId,
            ageSeconds: Math.round((now - chat.pendingFetch.createdAt) / 1000),
          }
        : null,
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
      // MULTI-AGENT: has this chat flipped to per-turn routing (a turn was routed to
      // an agent other than the primary)? Gates the per-message agent chip in the
      // thread. Read-only projection of the chat flag the dispatch maintains.
      perTurnRouting: chat.perTurnRouting === true,
      // MULTI-AGENT: the chat's LAST-ROUTED agent (the dispatch-maintained
      // `lastRouted*`). Surfaced so the composer can default to the last-used agent
      // even BEFORE listByChat loads (this loads fast — a single chat-doc read) —
      // without it, a fast send while messages are still loading would route a
      // perTurnRouting chat to the primary instead of the last-used agent. Names are
      // non-secret slugs (read-only projection — routing/dispatch is server-owned).
      lastRoutedInstanceName: chat.lastRoutedInstanceName ?? null,
      lastRoutedAgentId: chat.lastRoutedAgentId ?? null,
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
      if (c.kind !== undefined) continue; // hidden utility chats (documentary/summarizer) — never in the sidebar
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
    const active = chats.filter((c) => !c.archived);

    // For chats bound to an agent NOT in the effective set, the sidebar lock must
    // match the dispatch: read-only only when the agent still EXISTS (a restriction)
    // vs gone/purged (fallback). Look up the DISTINCT out-of-set bound agents ONCE
    // (typically 0-few) so this stays bounded on the listChats hot path.
    // Collision-free key (length-prefixed instanceName), so an instanceName or
    // agentId containing "/" can never make two distinct pairs share a key (which
    // would desync the sidebar lock from the dispatch/getChatAgent read-only state).
    const agentKey = (instanceName: string, agentId: string) =>
      `${instanceName.length}:${instanceName}/${agentId}`;
    const effectiveKeys = new Set(
      agents.map((a) => agentKey(a.instanceName, a.agentId)),
    );
    const toCheck = new Map<string, { instanceName: string; agentId: string }>();
    for (const c of active) {
      if (c.instanceName && c.agentId) {
        const key = agentKey(c.instanceName, c.agentId);
        if (!effectiveKeys.has(key)) {
          toCheck.set(key, {
            instanceName: c.instanceName,
            agentId: c.agentId,
          });
        }
      }
    }
    const existsKeys = new Set<string>();
    for (const [key, { instanceName, agentId }] of toCheck) {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", instanceName).eq("agentId", agentId),
        )
        .first();
      // PRESENT only (not gateway-deleted): a presentInLastOk:false row is "gone"
      // (falls back), same as the dispatch.
      if (row !== null && row.presentInLastOk !== false) existsKeys.add(key);
    }

    return active.map((c) => {
      // ONE resolution per chat: the provider kind for the bridge badge AND whether
      // the chat is READ-ONLY (bound to an agent the user is no longer entitled to,
      // but that still exists) so the sidebar can mark it.
      const boundAgentExists =
        c.instanceName && c.agentId
          ? existsKeys.has(agentKey(c.instanceName, c.agentId))
          : false;
      const resolved = resolveAgentForChat(agents, c, boundAgentExists);
      return {
        _id: c._id as Id<"chats">,
        title: c.title,
        updatedAt: c.updatedAt,
        projectId: c.projectId ?? null,
        sortKey: c.sortKey ?? 0,
        pinned: c.pinned ?? false,
        color: c.color ?? null,
        providerKind: resolved.agent?.kind ?? null,
        readOnly: resolved.readOnly,
      };
    });
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
// The user's STOP button: end the chat's active turn NOW (optimistic — the
// same internal finalize the gateway path uses, so text streamed so far is
// kept, the queue drains, chunks GC) and best-effort KILL the run at the
// gateway (bridge POST /abort -> chat.abort). Without the kill the gateway
// keeps generating for minutes and its late frames are dropped as stale; with
// it, the gateway's own chat:aborted frame finalizes idempotently after ours.
export const abortTurn = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    const streaming = await ctx.db
      .query("messages")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", "streaming"),
      )
      .order("desc")
      .first();
    if (streaming === null) {
      return { ok: false as const, reason: "no_active_turn" as const };
    }
    // MULTI-AGENT: per-turn routing stamps routedAgent on the USER message, not
    // the assistant row — resolve the turn's routing from the most recent user
    // message so the abort reaches the RIGHT bridge/instance (the exact
    // sessionKey alone cannot pick the bridgeUrl).
    // The ACTIVE turn's user message = the last user row created BEFORE the
    // streaming assistant row. A follow-up already QUEUED during the stream has
    // a LATER _creationTime and must not win (routed elsewhere, it would send
    // the abort to the wrong bridge/instance — codex P2).
    const lastUser = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("role"), "user"),
          q.lt(q.field("_creationTime"), streaming._creationTime),
        ),
      )
      .first();
    const routedAgent =
      lastUser?.routedAgentId && lastUser.routedInstanceName
        ? {
            instanceName: lastUser.routedInstanceName,
            agentId: lastUser.routedAgentId,
          }
        : streaming.routedAgentId && streaming.routedInstanceName
          ? {
              instanceName: streaming.routedInstanceName,
              agentId: streaming.routedAgentId,
            }
          : null;
    // ONE action does kill-THEN-finalize, in that order: finalize runs
    // drainNextQueued, and dispatching a queued follow-up while the gateway
    // still runs the old turn would break one-turn-per-session (the send gets
    // refused or interleaved — codex P1). The message stays `streaming` for the
    // ~1s the kill takes; the UI's "Interrompu" lands right after. The
    // assistant row carries the turn's EXACT gateway session key (per-turn
    // routing + session epochs included); routing derivation is the legacy
    // fallback. Finalize happens even when the kill fails (best-effort kill,
    // guaranteed settle).
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchAbort, {
      chatId,
      userId,
      finalizeMessageId: streaming._id,
      // Target the EXACT run: if the reply finishes and a queued follow-up
      // starts a NEW run on the same session before the abort lands, a
      // session-only abort would kill the wrong run (codex P2).
      ...(streaming.runId ? { runId: streaming.runId } : {}),
      ...(streaming.turnSessionKey
        ? { sessionKey: streaming.turnSessionKey }
        : {}),
      ...(routedAgent ? { routedAgent } : {}),
    });
    return { ok: true as const };
  },
});

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
    // Hybrid rehydration: deleting at-or-before the summary watermark makes the
    // rolling summary describe content that no longer exists — reset it (the engine
    // rebuilds on subsequent turns). Truncate-forward deletes everything from
    // `message` on, so ITS effectiveOrder is the earliest deleted order.
    try {
      await invalidateSummaryOnDeletion(
        ctx,
        chat._id,
        chat.userId,
        effectiveOrder(message),
      );
    } catch (e) {
      console.error("[chatsum] invalidate on delete:", (e as Error)?.message ?? e);
    }
    // Truncate-forward in LOGICAL turn order (see lib/messageOrder.compareOrder), NOT
    // raw _creationTime: a mid-turn QUEUE follow-up has an early _creationTime but a
    // later orderTime, so by _creationTime it would survive a delete of the turn it
    // logically follows — an undispatchable orphan once its outbox is purged below.
    // compareOrder tie-breaks by _creationTime, so deleting ONE of several still-queued
    // follow-ups (all sharing the SENTINEL orderTime) keeps the EARLIER queued ones.
    // This message + every LATER one in the chat (truncate forward). Bounded read.
    const chatMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
      .collect();
    const deletedIds = new Set<string>();
    for (const m of chatMessages) {
      if (compareOrder(m, message) < 0) continue; // strictly BEFORE → keep
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const p of parts) await ctx.db.delete(p._id);
      // Mirror the files-row invariant on the part deletion (delete + regenerate).
      await deleteFilesByMessage(ctx, m._id);
      // L2: purge this message's documentary attachments (rows reference it; else
      // getDocumentAttachments keeps surfacing/downloading them after truncation).
      const docs = await ctx.db
        .query("documentAttachments")
        .withIndex("by_source_message", (q) => q.eq("sourceMessageId", m._id))
        .collect();
      for (const d of docs) await ctx.db.delete(d._id);
      // Live-text row (present iff this message is mid-stream — a later streaming
      // turn truncated by deleting an earlier message): drop it with the message.
      const live = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const s of live) await ctx.db.delete(s._id);
      // SSE transport (Phase 1): a message truncated BEFORE its finalize GC ran (e.g. a
      // still-streaming later turn) leaks its stream chunks (which hold text). Schedule
      // the bounded purge. Cheap existence check first, so non-streaming messages (the
      // vast majority — their chunks were already GC'd at finalize) cost ~nothing.
      if (
        await ctx.db
          .query("streamChunks")
          .withIndex("by_message_seq", (q) => q.eq("messageId", m._id))
          .first()
      ) {
        await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
          messageId: m._id,
        });
      }
      deletedIds.add(m._id);
      await ctx.db.delete(m._id);
    }

    // Sub-agents anchored to a deleted turn: the spawning message is gone, so on a
    // retry/regenerate the child's SESSION is considered gone too — purge the row +
    // its tool detail + interaction thread (else orphaned rows linger AND the open
    // right-panel keeps showing a stale sub-agent). The open panel self-closes when
    // its viewed child vanishes from the list. Bounded read (by_chat).
    const chatSubAgents = await ctx.db
      .query("subAgents")
      .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
      .collect();
    for (const sa of chatSubAgents) {
      if (!sa.parentMessageId || !deletedIds.has(sa.parentMessageId)) continue;
      const parts = await ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", sa.childSessionKey),
        )
        .collect();
      for (const p of parts) await ctx.db.delete(p._id);
      const threads = await ctx.db
        .query("subAgentInteractions")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", sa.childSessionKey),
        )
        .collect();
      for (const t of threads) await ctx.db.delete(t._id);
      await ctx.db.delete(sa._id);
    }

    // Drop the non-terminal outbox of the TRUNCATED messages ONLY (a stale dispatch
    // or a later drainNextQueued must not resurrect a deleted turn). Scope by the
    // deleted ids — NOT every pending/queued row of the chat: deleting a `queued`
    // follow-up while an EARLIER turn is still `pending` (its message KEPT by the
    // logical-order truncation) must not wipe that in-flight turn's outbox.
    for (const status of ["pending", "queued"] as const) {
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chat._id).eq("status", status),
        )
        .collect();
      for (const o of rows) {
        if (o.messageId && deletedIds.has(o.messageId)) await ctx.db.delete(o._id);
      }
    }

    // L2: if the truncation removed the SOURCE of an in-flight documentary fetch,
    // release the hidden chat's lock (else future attaches throw fetch_in_flight).
    await releaseDanglingDocumentaryFetch(ctx, userId);

    // Assistant delete -> regenerate the now-last user message (if any): build a
    // fresh outbox from that user turn (text + its file attachments). dispatchReset
    // runs it AFTER the gateway reset, so it re-hydrates the truncated history.
    let regenerateOutboxId: Id<"outbox"> | undefined;
    // MULTI-AGENT: a regenerate must re-route to the SAME agent the regenerated user turn
    // was addressed to (else a Bob-routed turn would regenerate on the chat's primary, and
    // the reset would clear the wrong agent's session — codex P2). Carried to BOTH the
    // regen outbox (re-dispatch routes to it) and dispatchReset (its reset targets it).
    let regenRoutedAgent: { instanceName: string; agentId: string } | undefined;
    if (wasAssistant) {
      // The now-last message in LOGICAL order (reuse the already-read set, minus the
      // just-truncated tail) — same compareOrder as the truncation + display.
      const survivors = chatMessages
        .filter((m) => compareOrder(m, message) < 0)
        .sort(compareOrder);
      const lastUser = survivors[survivors.length - 1];
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
        regenRoutedAgent =
          lastUser.routedInstanceName && lastUser.routedAgentId
            ? {
                instanceName: lastUser.routedInstanceName,
                agentId: lastUser.routedAgentId,
              }
            : undefined;
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
          ...(regenRoutedAgent ? { routedAgent: regenRoutedAgent } : {}),
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
      // Reset the SAME agent's session the regenerate re-dispatches to (per-turn chats).
      ...(regenRoutedAgent ? { routedAgent: regenRoutedAgent } : {}),
    });

    await ctx.db.patch(chat._id, { updatedAt: Date.now() });
    await auditImpersonated(ctx, actor, "message.delete", {
      resource: "message",
      resourceId: messageId,
    });
  },
});
