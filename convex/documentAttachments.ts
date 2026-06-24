// L2 "Joindre les documents" — fetch the real files behind a reply's documentary
// sources and surface them as downloadable links in each source's "Source d'origine"
// slot.
//
// FLOW (see docs / atrium-sources-panel-L1 memory):
//   1. attachDocuments(sourceMessageId, references[])  [user mutation]
//      - entitlement: resolve a DOCUMENTARY agent the user is granted (never global);
//      - create `documentAttachments` rows (status "pending") for each reference;
//      - dispatch a fetch TURN in a HIDDEN per-user documentary chat — its OWN gateway
//        session (distinct chatId) so the conversational chats are never re-keyed;
//      - mark that hidden chat's `pendingFetch` = this source message.
//   2. The documentary agent returns the files via the EXISTING outbound-media contract
//      (MEDIA: → addMediaPart → media parts on the fetch turn's assistant message).
//   3. correlateDocumentaryFetch(...)  [called from stream.finalize]
//      - match each returned file BY FILENAME to a pending reference → status "ready"
//        (+ storageId); unmatched references → "not_found";
//      - write a recap SYSTEM message into the CONVERSATIONAL chat;
//      - clear `pendingFetch`.
//   4. getDocumentAttachments(sourceMessageId)  [panel query] → per-reference status +
//      download URL, read into each source card's slot.

import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";
import { resolveDocumentaryTarget } from "./agents";
import { writeTraceEvent } from "./observability";
import { stripGatewayMediaId } from "./lib/mediaName";
import { isChatBusy } from "./lib/outboxQueue";
import { isFindableDocumentItem } from "./lib/provenance";

/** Max document references one fetch may request (matches the panel's bounds). */
export const MAX_DOC_REFS = 24;

/**
 * The correlationId that ties ONE document fetch's whole lifecycle together across
 * the SOC2 trace surface: `documentary.attach` (dispatch) → `documentary.correlate`
 * (settle) OR `documentary.fail` (error/stuck). Derived from the source message id +
 * the pendingFetch.createdAt (which `attachDocuments` sets to `now`), so every site
 * reproduces the SAME value with no extra plumbing. Both parts are opaque ids/numbers
 * (SOC2-safe — never a file_name or reference). An operator queries the chain with
 * `list_traces?correlationId=docfetch:<id>:<ts>` to follow a fetch end-to-end.
 */
export function docFetchCorrelationId(
  sourceMessageId: Id<"messages">,
  createdAt: number,
): string {
  return `docfetch:${sourceMessageId}:${createdAt}`;
}

/** Basename, lowercased, with the gateway media-store `---<uuid>` id stripped — the
 *  correlation key (returned media file vs requested ref). The agent returns a file
 *  named `<ref>---<uuid>.<ext>` while the reference is just `<ref>.<ext>`, so without
 *  the strip a correct file would never match (→ wrong `not_found`). Same
 *  normalization as the media DISPLAY (lib/mediaName, shared). */
function baseName(path: string): string {
  const noQuery = path.split(/[?#]/)[0] ?? path;
  const seg = noQuery.split(/[\\/]/).pop() ?? noQuery;
  return stripGatewayMediaId(seg.trim()).toLowerCase();
}

/** The instruction sent to the documentary agent. Best-effort: the agent must write
 *  the files to its outbound media dir + emit `MEDIA:` per the contract; whether it
 *  CAN resolve a reference to a file is the plugin's capability, not Atrium's. */
function buildFetchPrompt(refs: readonly string[]): string {
  return (
    "Fournis les fichiers source téléchargeables correspondant EXACTEMENT à ces " +
    "références de documents (un fichier par référence, nommé d'après la référence). " +
    "Réponds uniquement avec les fichiers, sans commentaire :\n" +
    refs.map((r) => `- ${r}`).join("\n")
  );
}

/** Find (or lazily create) the user's HIDDEN documentary chat, bound to `target`. */
async function ensureDocumentaryChat(
  ctx: MutationCtx,
  userId: Id<"users">,
  target: { instanceName: string; agentId: string },
  now: number,
): Promise<Doc<"chats">> {
  const existing = await ctx.db
    .query("chats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("kind"), "documentary"))
    .first();
  if (existing) {
    // Keep the binding current (the entitled documentary agent may have changed).
    if (
      existing.instanceName !== target.instanceName ||
      existing.agentId !== target.agentId
    ) {
      await ctx.db.patch(existing._id, {
        instanceName: target.instanceName,
        agentId: target.agentId,
      });
    }
    return (await ctx.db.get(existing._id))!;
  }
  const id = await ctx.db.insert("chats", {
    userId,
    kind: "documentary" as const,
    title: "Documents",
    instanceName: target.instanceName,
    agentId: target.agentId,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

/**
 * Re-denormalize the source message's `attachedDocCount` = the number of currently
 * READY rows (undefined when 0). MUST be called on every path that changes the ready
 * set: correlate (pending -> ready/not_found, inline there), a RE-ATTACH that resets a
 * previously-ready card to pending, and the dispatch-failure path. Without it the
 * Sources chip keeps advertising downloads that no longer exist (over-count).
 */
async function recomputeAttachedDocCount(
  ctx: MutationCtx,
  sourceMessageId: Id<"messages">,
): Promise<void> {
  const srcMsg = await ctx.db.get(sourceMessageId);
  if (srcMsg === null) return;
  const readyRows = await ctx.db
    .query("documentAttachments")
    .withIndex("by_source_status", (q) =>
      q.eq("sourceMessageId", sourceMessageId).eq("status", "ready"),
    )
    .collect();
  await ctx.db.patch(sourceMessageId, {
    attachedDocCount: readyRows.length > 0 ? readyRows.length : undefined,
  });
}

export const attachDocuments = mutation({
  args: {
    sourceMessageId: v.id("messages"),
    // One entry per SELECTED card: its unique SourceEntry.key + the file_name to
    // fetch. Scoping to entryKey is what keeps an unchecked duplicate / sibling
    // chunk of the same file from lighting up (only the checked card does).
    items: v.array(v.object({ entryKey: v.string(), reference: v.string() })),
  },
  handler: async (ctx, { sourceMessageId, items }) => {
    const { userId } = await requireActive(ctx);
    const now = Date.now();

    // Ownership: the source message's chat must belong to the caller.
    const srcMsg = await ctx.db.get(sourceMessageId);
    if (srcMsg === null) throw new Error("source_not_found");
    const srcChat = await ctx.db.get(srcMsg.chatId);
    if (srcChat === null || srcChat.userId !== userId) throw new Error("forbidden");

    // Entitlement: a documentary agent the user is actually granted.
    const target = await resolveDocumentaryTarget(ctx, userId);
    if (target === null) throw new Error("no_documentary_agent");

    // Server-side authorization on the TRUST BOUNDARY: the agent may only be sent
    // references that ACTUALLY appeared as DOCUMENT sources in THIS reply. Without
    // this, a modified client could submit an arbitrary `reference` and make the
    // documentary agent fetch a file outside the shown sources. Build the allowed set
    // from the message's stored provenance and drop anything not in it. ONLY a
    // FINDABLE document source counts: a documents-group item WITH a file_name (the
    // real file the documentary agent fetches). A documents-group item WITHOUT a
    // file_name is a synthesized CONTEXT excerpt (e.g. LightRAG's "lightrag-context"
    // blob) with no file to fetch — it must NOT be attachable even for a direct
    // (non-UI) caller, else the agent is dispatched a non-file reference it can never
    // resolve. This mirrors the client rule (src/chat/sourcesView.ts isFindableDocument)
    // on the trust boundary. The client-chosen `entryKey` stays a UI correlation label.
    const provParts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", sourceMessageId))
      .collect();
    const allowedRefs = new Set<string>();
    for (const { part } of provParts) {
      if (part.kind !== "provenance" || part.group !== "documents") continue;
      for (const item of part.items) {
        // THE shared rule (convex/lib/provenance): only a FINDABLE document is
        // attachable — a context excerpt (explicit `context:true`, or no file_name)
        // is excluded, even if a caller bypasses the UI.
        if (item.file_name && isFindableDocumentItem(item, part.group)) {
          allowedRefs.add(item.file_name);
        }
      }
    }

    // Dedup by entryKey (one row per selected card); drop blanks AND any reference
    // that is not a real document source of this message (the boundary check above).
    const byKey = new Map<string, string>();
    for (const it of items) {
      const entryKey = it.entryKey.trim();
      const reference = it.reference.trim();
      if (
        entryKey &&
        reference &&
        allowedRefs.has(reference) &&
        !byKey.has(entryKey)
      ) {
        byKey.set(entryKey, reference);
      }
    }
    const selected = [...byKey.entries()]
      .slice(0, MAX_DOC_REFS)
      .map(([entryKey, reference]) => ({ entryKey, reference }));
    if (selected.length === 0) throw new Error("no_references");

    const hidden = await ensureDocumentaryChat(ctx, userId, target, now);
    // Serial: one fetch per hidden chat at a time. pendingFetch is the L2 lock, but
    // it can be RELEASED (releaseDanglingDocumentaryFetch) while the OLD turn is still
    // streaming on the gateway; also guard on isChatBusy so a new fetch never dispatches
    // a SECOND concurrent chat.send onto that hidden session (which corrupts it).
    if (hidden.pendingFetch || (await isChatBusy(ctx, hidden._id))) {
      throw new Error("fetch_in_flight");
    }

    // Upsert one pending row PER SELECTED CARD (keyed by entryKey).
    for (const { entryKey, reference } of selected) {
      const prior = await ctx.db
        .query("documentAttachments")
        .withIndex("by_source_entry", (q) =>
          q.eq("sourceMessageId", sourceMessageId).eq("entryKey", entryKey),
        )
        .unique();
      if (prior) {
        await ctx.db.patch(prior._id, {
          reference,
          status: "pending",
          storageId: undefined,
          filename: undefined,
          mimeType: undefined,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("documentAttachments", {
          userId,
          sourceMessageId,
          entryKey,
          reference,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Re-attaching a previously-READY card just reset it to `pending` (storageId
    // cleared) — drop the denormalized count NOW so the Sources chip stops advertising
    // a download that no longer resolves while the re-fetch is in flight (and stays
    // correct even if that fetch later fails). correlate restores it on success.
    await recomputeAttachedDocCount(ctx, sourceMessageId);

    // The agent fetches each distinct FILE once (multiple cards may share a file).
    const refs = [...new Set(selected.map((s) => s.reference))];

    // Dispatch the fetch turn in the hidden chat (separate session, documentary agent).
    const text = buildFetchPrompt(refs);
    const msgId = await ctx.db.insert("messages", {
      chatId: hidden._id,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text,
      updatedAt: now,
    });

    // FRESH gateway session per fetch. The documentary agent is a stateless utility
    // ("resolve these refs -> deliver these files"), but the hidden chat is REUSED, so its
    // single gateway session accumulated EVERY prior fetch's refs/files/tool-runs. Live
    // data showed the agent delivering media on a clean first turn, then returning ZERO
    // media once the session was polluted (mediaReturned:0, all "not_found"). Rotating
    // openclawChatId makes the bridge's buildSessionKey(openclawChatId ?? chatId, ...)
    // derive a NEW sessionKey per fetch, so each runs in a CLEAN session — like that first
    // turn. Keyed by THIS fetch's message id (always unique); the Convex chat row stays
    // (no chat-row churn), only the gateway session resets.
    await ctx.db.patch(hidden._id, {
      pendingFetch: { sourceMessageId, createdAt: now },
      openclawChatId: `documentary:${msgId}`,
    });
    const outboxId = await ctx.db.insert("outbox", {
      chatId: hidden._id,
      userId,
      clientMessageId: `docfetch-${sourceMessageId}-${now}`,
      messageId: msgId,
      text,
      attachmentIds: [],
      status: "pending" as const,
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    // SOC2-safe lifecycle trace (counts only — never references/filenames/entryKeys,
    // which can carry PHI). `droppedNotSource` > 0 flags a client that submitted a
    // reference NOT shown as a source of this reply (a tamper signal). Best-effort.
    const droppedNotSource = items.filter((it) => {
      const r = it.reference.trim();
      return r.length > 0 && !allowedRefs.has(r);
    }).length;
    try {
      await writeTraceEvent(ctx, {
        kind: "documentary.attach",
        direction: "internal",
        principalType: "user",
        principalId: userId,
        chatId: srcChat._id,
        correlationId: docFetchCorrelationId(sourceMessageId, now),
        meta: JSON.stringify({
          sourceMessageId,
          hiddenChatId: hidden._id,
          submitted: items.length,
          queued: selected.length,
          distinctFiles: refs.length,
          droppedNotSource,
        }),
      });
    } catch {
      /* trace is best-effort: never fail the dispatch on an observability write */
    }
    return { dispatched: refs.length };
  },
});

/**
 * Correlate a finished documentary FETCH turn back to its source's selected cards.
 * Called from stream.finalize when a `kind:"documentary"` chat's assistant message
 * settles. Matches returned media parts BY FILENAME to each pending row's reference
 * → ready/not_found (a file shared by several selected cards readies all of them),
 * denormalizes the ready count onto the source message (the subtle Sources-chip
 * "joints" badge — no per-message query), and clears `pendingFetch`. Best-effort:
 * never throws into finalize (a correlation failure must not break the turn lifecycle).
 */
export async function correlateDocumentaryFetch(
  ctx: MutationCtx,
  hiddenChat: Doc<"chats">,
  assistantMessage: Doc<"messages">,
): Promise<void> {
  const pending = hiddenChat.pendingFetch;
  if (!pending) return;
  const sourceMessageId = pending.sourceMessageId;
  const now = Date.now();

  // Returned files = media parts on the fetch turn's assistant message.
  const parts = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", assistantMessage._id))
    .collect();
  const media = parts
    .map((p) => p.part)
    .filter((p): p is Extract<typeof p, { kind: "media" }> => p.kind === "media");
  const byBase = new Map<string, (typeof media)[number]>();
  for (const mp of media) {
    if (mp.filename) byBase.set(baseName(mp.filename), mp);
  }

  const rows = await ctx.db
    .query("documentAttachments")
    .withIndex("by_source_status", (q) =>
      q.eq("sourceMessageId", sourceMessageId).eq("status", "pending"),
    )
    .collect();
  let readyCount = 0;
  let notFoundCount = 0;
  for (const row of rows) {
    const match = byBase.get(baseName(row.reference));
    if (match) {
      await ctx.db.patch(row._id, {
        status: "ready",
        storageId: match.storageId,
        filename: match.filename,
        mimeType: match.mimeType,
        updatedAt: now,
      });
      readyCount++;
    } else {
      await ctx.db.patch(row._id, { status: "not_found", updatedAt: now });
      notFoundCount++;
    }
  }

  // Denormalize the count of READY attachments onto the source message so the
  // Sources chip can show a subtle "joints" badge with no extra per-message query.
  const srcMsg = await ctx.db.get(sourceMessageId);
  if (srcMsg) {
    const readyRows = await ctx.db
      .query("documentAttachments")
      .withIndex("by_source_status", (q) =>
        q.eq("sourceMessageId", sourceMessageId).eq("status", "ready"),
      )
      .collect();
    await ctx.db.patch(sourceMessageId, {
      attachedDocCount: readyRows.length > 0 ? readyRows.length : undefined,
    });
  }

  // SOC2-safe settle trace (counts only). latencyMs = full fetch round-trip from
  // attach. correlationId ties it to the originating `documentary.attach`. Best-effort
  // (runs inside stream.finalize — a trace failure must never abort the turn).
  try {
    await writeTraceEvent(ctx, {
      kind: "documentary.correlate",
      direction: "internal",
      principalType: "user",
      principalId: hiddenChat.userId,
      chatId: srcMsg?.chatId,
      runId: assistantMessage.runId ?? undefined,
      latencyMs: now - pending.createdAt,
      correlationId: docFetchCorrelationId(sourceMessageId, pending.createdAt),
      meta: JSON.stringify({
        sourceMessageId,
        hiddenChatId: hiddenChat._id,
        total: rows.length,
        ready: readyCount,
        notFound: notFoundCount,
        mediaReturned: media.length,
      }),
    });
  } catch {
    /* observability is best-effort; the turn lifecycle takes priority */
  }

  await ctx.db.patch(hiddenChat._id, { pendingFetch: undefined });
}

/**
 * Release a documentary FETCH that failed BEFORE stream.finalize (a DISPATCH error
 * path: bridge down, no_agent, not_configured — which never reach the finalize that
 * normally clears pendingFetch via correlateDocumentaryFetch). Marks the source's
 * still-pending rows `failed` AND clears the hidden chat's pendingFetch; without the
 * latter the `fetch_in_flight` guard would lock the owner out of every future
 * document fetch. Takes the chat doc (like correlateDocumentaryFetch); the caller
 * invokes it best-effort so an L2-feature error never rolls back the core fail path.
 */
export async function failDocumentaryFetchForChat(
  ctx: MutationCtx,
  hiddenChat: Doc<"chats">,
  reason: "dispatch_error" | "stuck_stream" = "dispatch_error",
): Promise<void> {
  const pending = hiddenChat.pendingFetch;
  if (!pending) return;
  const now = Date.now();
  const rows = await ctx.db
    .query("documentAttachments")
    .withIndex("by_source_status", (q) =>
      q.eq("sourceMessageId", pending.sourceMessageId).eq("status", "pending"),
    )
    .collect();
  for (const row of rows) {
    await ctx.db.patch(row._id, { status: "failed", updatedAt: now });
  }
  await ctx.db.patch(hiddenChat._id, { pendingFetch: undefined });
  // Keep the denormalized count honest on the failure path too (a card that was
  // re-fetched is now `failed`, not `ready`) — the chip must not advertise it.
  await recomputeAttachedDocCount(ctx, pending.sourceMessageId);

  // SOC2-safe failure trace (counts only). `reason` distinguishes a dispatch error
  // from the watchdog releasing a stuck fetch — the latter is how the otherwise
  // SILENT "pendingFetch never cleared" case becomes observable. Best-effort.
  try {
    const srcMsg = await ctx.db.get(pending.sourceMessageId);
    await writeTraceEvent(ctx, {
      kind: "documentary.fail",
      direction: "internal",
      principalType: "user",
      principalId: hiddenChat.userId,
      chatId: srcMsg?.chatId,
      correlationId: docFetchCorrelationId(pending.sourceMessageId, pending.createdAt),
      latencyMs: now - pending.createdAt,
      meta: JSON.stringify({
        sourceMessageId: pending.sourceMessageId,
        hiddenChatId: hiddenChat._id,
        failed: rows.length,
        reason,
      }),
    });
  } catch {
    /* observability is best-effort; the fail/cleanup path takes priority */
  }
}

/**
 * Release the user's hidden documentary fetch lock if its SOURCE message no longer
 * exists — i.e. the source was deleted/truncated (deleteMessage) or its chat was
 * removed (cascadeDeleteChat) WHILE a fetch was in flight. Without this the next
 * "Joindre les documents" throws fetch_in_flight until the orphaned run finishes or
 * the watchdog fires. `exceptChatId` skips the documentary chat when IT is the one
 * being deleted (its pendingFetch goes with it).
 */
export async function releaseDanglingDocumentaryFetch(
  ctx: MutationCtx,
  userId: Id<"users">,
  exceptChatId?: Id<"chats">,
): Promise<void> {
  const docChat = await ctx.db
    .query("chats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("kind"), "documentary"))
    .first();
  if (!docChat || docChat._id === exceptChatId || !docChat.pendingFetch) return;
  if ((await ctx.db.get(docChat.pendingFetch.sourceMessageId)) !== null) return;
  await failDocumentaryFetchForChat(ctx, docChat, "dispatch_error");
}

/** Panel query: per-CARD attachment state (keyed by entryKey) + a download URL. */
export const getDocumentAttachments = query({
  args: { sourceMessageId: v.id("messages") },
  handler: async (ctx, { sourceMessageId }) => {
    const { userId } = await requireActive(ctx);
    const rows = await ctx.db
      .query("documentAttachments")
      .withIndex("by_source_message", (q) => q.eq("sourceMessageId", sourceMessageId))
      .collect();
    const out: Array<{
      entryKey: string;
      reference: string;
      status: "pending" | "ready" | "not_found" | "failed";
      url: string | null;
      filename: string | null;
    }> = [];
    for (const r of rows) {
      // Owner scope (defensive — rows are created only for the owner).
      if (r.userId !== userId) continue;
      // Skip pre-entryKey rows (additive migration): they can't map to a card.
      if (!r.entryKey) continue;
      out.push({
        entryKey: r.entryKey,
        reference: r.reference,
        status: r.status,
        url: r.storageId ? await ctx.storage.getUrl(r.storageId) : null,
        filename: r.filename ?? null,
      });
    }
    return out;
  },
});
