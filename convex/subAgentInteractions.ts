// Phase 2c — the user's DIRECT interaction with a sub-agent ("Interagir").
//
// The user types a message in the panel; it is dispatched to the CHILD session key
// via the bridge (chat.send — verified live: the gateway routes it to the child and
// the reply streams back on the child lane). The child's reply is recorded async by
// the bridge (recordInteractionReply) when its chat:final lands.
//
// SECURITY: `sendToSubAgent` is the only public entry; it runs `prepareInteraction`
// which re-derives the target from OWNED state (requireOwnedChat + the child MUST be a
// sub-agent of THIS chat) — the childSessionKey is a bare UUID that does NOT embed the
// chatId, so it is NEVER trusted (mirrors listSubAgentToolParts' defense-in-depth +
// the upload-storageId IDOR lesson). The reply/mutations are internal (bridge-only).

import { v } from "convex/values";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat } from "./lib/access";
import { resolveTargetForChat } from "./routing";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { assertOwnsUpload } from "./uploads";
import type { Id } from "./_generated/dataModel";

const MAX_INTERACTION_CHARS = 8000;
// At most a few files per interaction message (matches the composer's expectation;
// a bound so a crafted call can't ask us to resolve an unbounded blob list).
const MAX_INTERACTION_ATTACHMENTS = 6;

/** Base64-encode an ArrayBuffer in bounded chunks (avoids a spread-arg stack blow on
 *  large buffers) — the same technique the main dispatch uses (convex/bridge.ts). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const ATTACHMENT_REF = v.object({
  storageId: v.id("_storage"),
  filename: v.string(),
  mimeType: v.string(),
});

/**
 * IDOR gate + insert. The child MUST belong to a `subAgents` row in THIS chat.
 * Inserts the pending interaction and resolves the routing the bridge needs to reach
 * the operator connection (the SAME resolution as a normal dispatch). Throws on a
 * missing/foreign child or an unresolvable agent. Internal — only the action calls it.
 */
export const prepareInteraction = internalMutation({
  args: {
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    userText: v.string(),
    attachments: v.optional(v.array(ATTACHMENT_REF)),
  },
  handler: async (ctx, { chatId, childSessionKey, userText, attachments }) => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    // IDOR: every attachment storageId MUST have been uploaded by THIS user (the
    // client-supplied id is never trusted — the upload-storageId lesson). Bounded.
    const atts = (attachments ?? []).slice(0, MAX_INTERACTION_ATTACHMENTS);
    for (const a of atts) {
      await assertOwnsUpload(ctx, userId, a.storageId);
    }
    // A COPIED card in a branched chat (chatFork re-keys with the `fork:`
    // prefix) is display-only: its gateway session belongs to the SOURCE
    // conversation — resuming it from the branch would steer the original.
    if (childSessionKey.startsWith("fork:")) {
      throw new Error(
        "sub-agent card copied from the source chat: cannot interact",
      );
    }
    const child = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
      .first();
    if (!child || child.chatId !== chatId) {
      throw new Error("sub-agent not found in this chat");
    }
    // SCOPE (2c): only a TERMINAL sub-agent (resume-done — LIVE-VERIFIED) can be
    // interacted with. Steering a still-RUNNING child is unverified — the reply-capture
    // keys on the child's next chat:final, which on a live child could bind to the
    // ORIGINAL run's final (wrong-reply bug); gate it out until it is live-proven.
    if (child.status === "running") {
      throw new Error("sub-agent still running: cannot interact yet");
    }
    // A `cleanup: "delete"` child is ARCHIVED by the gateway right after its announce:
    // there is no session left to deliver to. Refuse here (server truth) instead of
    // parking a pending interaction that can only error/time out — the panel disables
    // its composer for the same state, but Enter/direct callers land here too.
    if (child.sessionMeta?.cleanup === "delete") {
      throw new Error(
        "sub-agent session archived (cleanup: delete): cannot interact",
      );
    }
    // CONCURRENCY: the observer tracks ONE interactionId per child (last-writer-wins),
    // so refuse a second send while one is still pending for this child.
    const pending = await ctx.db
      .query("subAgentInteractions")
      .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
      .collect();
    if (pending.some((r) => r.chatId === chatId && r.status === "pending")) {
      throw new Error("an interaction is already pending for this sub-agent");
    }
    const res = await resolveTargetForChat(ctx, chat, userId);
    if (!res.target) throw new Error("no resolvable agent for this chat");
    const target = res.target;
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", target.instanceName))
      .first();
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: target.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    const text = userText.trim().slice(0, MAX_INTERACTION_CHARS);
    const now = Date.now();
    const attachmentMeta = atts.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
    }));
    const interactionId = await ctx.db.insert("subAgentInteractions", {
      chatId,
      childSessionKey,
      userText: text,
      ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return {
      interactionId,
      bridgeUrl: bridgeUrl ?? null,
      text,
      // The validated refs the ACTION resolves to base64 (storageId kept ONLY here in
      // the return, never persisted on the row).
      attachmentRefs: atts.map((a) => ({
        storageId: a.storageId as Id<"_storage">,
        filename: a.filename,
        mimeType: a.mimeType,
      })),
      routing: {
        chatId: chatId as string,
        openclawChatId: chat.openclawChatId ?? null,
        agentId: target.agentId,
        canonical: target.canonical,
        instanceName: target.instanceName,
      },
    };
  },
});

/**
 * The bridge records the sub-agent's reply here (by interactionId) when the child's
 * chat:final lands — server-paths already stripped. Drops silently if the interaction
 * (or its chat) vanished mid-flight.
 */
export const recordInteractionReply = internalMutation({
  args: {
    interactionId: v.id("subAgentInteractions"),
    replyText: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    status: v.union(v.literal("done"), v.literal("error")),
    boundInstanceName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { interactionId, replyText, errorMessage, status, boundInstanceName },
  ) => {
    const row = await ctx.db.get(interactionId);
    if (row === null) return null;
    // ATOMIC cross-gateway barrier: the interaction's chat must allow the
    // proven instance (the row read is already paid).
    if (
      boundInstanceName !== undefined &&
      !(await chatAllowsInstance(ctx, row.chatId, boundInstanceName))
    ) {
      throw new Error("forbidden: cross-instance interaction target");
    }
    await ctx.db.patch(interactionId, {
      replyText,
      errorMessage,
      status,
      updatedAt: Date.now(),
    });
    return interactionId;
  },
});

/** Mark a still-pending interaction failed (the dispatch POST never reached the child). */
export const failInteraction = internalMutation({
  args: {
    interactionId: v.id("subAgentInteractions"),
    errorMessage: v.string(),
  },
  handler: async (ctx, { interactionId, errorMessage }) => {
    const row = await ctx.db.get(interactionId);
    if (row === null || row.status !== "pending") return null;
    await ctx.db.patch(interactionId, {
      status: "error",
      errorMessage,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * OWNER-SCOPED interaction thread for the open sub-agent (oldest first). The panel
 * reads it live; requireOwnedChat is the access boundary + a chatId filter is the
 * defense-in-depth (the childSessionKey is a bare UUID, not chat-scoped).
 */
export const listSubAgentInteractions = query({
  args: { chatId: v.id("chats"), childSessionKey: v.string() },
  handler: async (ctx, { chatId, childSessionKey }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    const rows = await ctx.db
      .query("subAgentInteractions")
      .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
      .collect();
    return rows
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * PUBLIC entry: the panel's "Interagir" send. Verifies ownership + the child link
 * (prepareInteraction), then POSTs the message to the bridge, which dispatches it to
 * the child session (chat.send) + records the reply async. Marks the interaction
 * failed if the bridge is unconfigured/unreachable so a pending row never dangles.
 */
export const sendToSubAgent = action({
  args: {
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    text: v.string(),
    attachments: v.optional(v.array(ATTACHMENT_REF)),
  },
  handler: async (
    ctx,
    { chatId, childSessionKey, text, attachments },
  ): Promise<{ ok: boolean; interactionId?: string; reason?: string }> => {
    const hasAttachments = (attachments ?? []).length > 0;
    // A message may be text-only OR attachment-only (a file with no words) — reject
    // only when BOTH are empty.
    if (text.trim() === "" && !hasAttachments) return { ok: false, reason: "empty" };
    const prep = await ctx.runMutation(
      internal.subAgentInteractions.prepareInteraction,
      { chatId, childSessionKey, userText: text, attachments },
    );
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!prep.bridgeUrl || !sharedSecret) {
      await ctx.runMutation(internal.subAgentInteractions.failInteraction, {
        interactionId: prep.interactionId,
        errorMessage: "bridge not configured",
      });
      return { ok: false, reason: "not_configured" };
    }
    // Resolve the validated attachment refs to inline base64 ({type,mimeType,fileName,
    // content}) — the SAME shape the main dispatch sends; the bridge frame-guards it.
    const resolved: Array<{
      type: string;
      mimeType: string;
      fileName: string;
      content: string;
    }> = [];
    for (const ref of prep.attachmentRefs) {
      const blob = await ctx.storage.get(ref.storageId);
      if (blob === null) continue; // blob gone — skip (never fail the whole send)
      resolved.push({
        type: "file",
        mimeType: ref.mimeType || blob.type || "application/octet-stream",
        fileName: ref.filename,
        content: arrayBufferToBase64(await blob.arrayBuffer()),
      });
    }
    try {
      const httpRes = await fetch(
        `${prep.bridgeUrl.replace(/\/$/, "")}/subagent-send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: sharedSecret,
          },
          body: JSON.stringify({
            ...prep.routing,
            childSessionKey,
            interactionId: prep.interactionId,
            message: prep.text,
            ...(resolved.length > 0 ? { attachments: resolved } : {}),
          }),
        },
      );
      if (!httpRes.ok) {
        await ctx.runMutation(internal.subAgentInteractions.failInteraction, {
          interactionId: prep.interactionId,
          errorMessage: `http_${httpRes.status}`,
        });
        return { ok: false, reason: `http_${httpRes.status}` };
      }
      return { ok: true, interactionId: prep.interactionId as string };
    } catch {
      await ctx.runMutation(internal.subAgentInteractions.failInteraction, {
        interactionId: prep.interactionId,
        errorMessage: "unreachable",
      });
      return { ok: false, reason: "unreachable" };
    }
  },
});
