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
import { maskCredentialId } from "./lib/chatRenderState";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat, requireReachableChat } from "./lib/access";
import { resolveTargetForChat, resolveGatewayUser } from "./routing";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { assertOwnsUpload } from "./uploads";
import { SUBAGENT_STALE_TTL_MS } from "./lib/outboxQueue";
import { liveTalkCall } from "./talk";
import { subAgentOwnerAgentId } from "./lib/talkFreeze";
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
/**
 * Settle `pending` interactions nothing will ever answer.
 *
 * A successful POST deliberately leaves the row pending: the child's reply arrives
 * asynchronously, and the bridge holds the correlation IN MEMORY. A restart between
 * the ACK and that reply loses it, and no Convex path terminalizes the row — which
 * then blocks the panel and, since this lot, every call to another agent too
 * (codex P2, pass 22).
 *
 * ONLY WHEN THE CHILD IS NOT WORKING. An age cutoff on its own would cut a child
 * still legitimately running; the child's own row is the liveness signal, and it has
 * its own reaper for when THAT goes stale. So this settles a pending interaction that
 * is both old AND whose child is no longer running.
 */
export const reapStalePendingInteractions = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ settled: number }> => {
    const cutoff = Date.now() - SUBAGENT_STALE_TTL_MS;
    const stale = await ctx.db
      .query("subAgentInteractions")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "pending").lt("updatedAt", cutoff),
      )
      .take(100);
    let settled = 0;
    for (const row of stale) {
      const child = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) =>
          q.eq("childSessionKey", row.childSessionKey),
        )
        .first();
      // LIVENESS IS THE CHILD'S CLOCK, NOT ITS STATUS. An interaction may only be
      // started on a TERMINAL child, and Convex refuses to move a terminal child back
      // to `running` — so the row stays `done` for the whole interaction even while
      // the child works. Keying on the status therefore settled live work after twenty
      // minutes and opened the freeze with it (codex P1, pass 23). Every observer
      // event patches `updatedAt` whether or not the status transition is applied, so
      // that is the heartbeat. A child row absent entirely is nothing working at all.
      if (child !== null && child.updatedAt >= cutoff) continue;
      await ctx.db.patch(row._id, {
        status: "error",
        errorMessage: "no reply: the sub-agent session was lost",
        updatedAt: Date.now(),
      });
      settled += 1;
    }
    return { settled };
  },
});

/** How long the sub-agent POST may take. Comfortably over a child `chat.send`, and
 *  well under the action budget — the point is that SOMETHING settles the row rather
 *  than the platform killing the action with it still `pending`. */
const SUBAGENT_SEND_TIMEOUT_MS = 4 * 60_000;

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
    // NOT WHILE SOMEONE IS SPEAKING TO ANOTHER AGENT.
    //
    // This door bypassed the freeze entirely: it writes no outbox row and no parent
    // assistant message, so neither the send rule nor the mirror ever saw it. And the
    // bridge cannot catch it either — `/subagent-send` acquires the PARENT's socket,
    // which during a call is already the call's own, so the key matches, nothing is
    // re-keyed, and `holdsVoiceCall` is never consulted before the child `chat.send`
    // goes out (codex P1, pass 19). A message typed into a child of ANOTHER agent
    // therefore reached it mid-call.
    //
    // A child of the agent on the line is fine — it is that agent's own delegate, and
    // its answer comes back into the same conversation.
    //
    // Placed HERE, after the row is known, for two reasons: the row carries the
    // INSTANCE (two gateways can expose the same agent id, so the id alone is not an
    // identity), and the more specific refusals above — a copied `fork:` card, an
    // unknown child — should say what they are rather than be masked by this one.
    const call = await liveTalkCall(ctx, chatId);
    if (call !== null) {
      const owner = subAgentOwnerAgentId(child.childSessionKey);
      // ABSENT BLOCKS, here too. `?? call.instanceName` turned "I was not told" into
      // "it matches", so a legacy child on one gateway was typed into while the call
      // ran on another under the same agent name — the same fail-open the mirror had,
      // in the other direction (codex P1, pass 23).
      if (child.instanceName !== call.instanceName) {
        throw new Error("TALK_CALL_ACTIVE");
      }
      // UNPARSEABLE BLOCKS. The schema pins the key's shape in prose only
      // (`v.string()`), and the observer accepts any non-empty key — so a key this
      // parser cannot read must not pass for "the agent on the line" (codex P1,
      // pass 24).
      if (owner === null || owner !== call.agentId) {
        throw new Error("TALK_CALL_ACTIVE");
      }
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
    // THE GATEWAY THE POST GOES TO MUST BE THE CHILD'S. This resolves the PARENT's
    // routing, which on a per-turn chat can have moved to another instance since the
    // child was spawned — the interaction then left for a bridge that never held the
    // child, while the freeze above had vetted the CHILD's identity, not this one
    // (codex P1, pass 24: a guard that validates one destination and sends to another
    // is no guard). A pre-existing routing defect, refused here rather than sent wrong.
    if (child.instanceName !== undefined && child.instanceName !== target.instanceName) {
      throw new Error("sub-agent belongs to another instance than the chat routes to");
    }
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
    // Same derivation as the dispatch path — the instance row is already in hand.
    const gatewayUser = await resolveGatewayUser(ctx, {
      instanceName: target.instanceName,
      ownerUserId: chat.userId,
      canonical: target.canonical,
      instance,
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
      // CAPTURED, like the routing the action carries: the POST goes to THIS
      // instance whatever the chat resolves to later.
      instanceName: target.instanceName,
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
        // Interacting with a sub-agent acquires the PARENT's socket, so this door
        // names the owner exactly as the send path does. Absent ⇒ the canonical.
        ...(gatewayUser === undefined ? {} : { gatewayUser }),
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
      // The interaction's failure sentence is shown in the sub-agent panel, and this
      // path does not go through `stream.finalize` (codex).
      errorMessage: maskCredentialId(errorMessage),
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
      errorMessage: maskCredentialId(errorMessage),
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
    await requireReachableChat(ctx, userId, chatId);
    const rows = await ctx.db
      .query("subAgentInteractions")
      .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
      .collect();
    return rows
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a.createdAt - b.createdAt)
      // Rows written before the backfill reached them still hold the credential id,
      // and the backfill is operator-invoked, so a read can precede it (codex).
      .map((r) => ({ ...r, errorMessage: maskCredentialId(r.errorMessage) }));
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
    // EVERYTHING AFTER THE ROW EXISTS IS INSIDE THE TRY. The row is written before
    // this, and a `pending` row now refuses voice calls to other agents as well as
    // holding the panel — so every way out of here has to settle it. Reading and
    // encoding the blobs used to sit outside, where a failure escaped and left the
    // row pending with no reconciler to clear it (codex P2, pass 21).
    try {
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
      const httpRes = await fetch(
        `${prep.bridgeUrl.replace(/\/$/, "")}/subagent-send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: sharedSecret,
          },
          // BOUNDED. Without a deadline a hung bridge held this action until the
          // platform killed it — and a killed action settles nothing, so the row
          // stayed `pending` for good.
          signal: AbortSignal.timeout(SUBAGENT_SEND_TIMEOUT_MS),
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
