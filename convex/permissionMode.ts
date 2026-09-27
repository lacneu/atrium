/**
 * The conversation OWNER changes the execution-permission mode of the conversation's
 * OpenClaw sessions — the Control UI composer's "Execution permissions" picker
 * (upstream ui/src/pages/chat/components/chat-permission-picker.ts), for Atrium.
 *
 * The choice is a property of the CONVERSATION (`chats.permissionModeChoice`): stored
 * here, applied at once to the session the next turn uses (bridge `POST
 * /permission-mode`), and applied again by the bridge to every OpenClaw session the
 * conversation opens later — a per-turn switch, a new segment, a session recreated
 * after it was pruned — before that session's first turn (getChatRouting →
 * /send `permissionModeChoice`). Rules in lib/permissionMode.ts.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { requireActive, requireOwnedChat, requireReachableChat } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import {
  instanceManagesPermissions,
  permissionChoiceRefusal,
  storedChoice,
} from "./lib/permissionMode";
import { isSessionPermissionMode } from "./lib/sessionAccess";
import { roomProjection } from "./chatAgents";
import { decideTurnPermission, type TurnPermission } from "./bridge";

const choiceValidator = v.union(
  v.literal("default"),
  v.literal("read-only"),
  v.literal("guarded"),
  v.literal("workspace"),
  v.literal("full"),
);

const applyStatusValidator = v.union(
  v.literal("pending"),
  v.literal("applied"),
  v.literal("deferred"),
  v.literal("failed"),
);

/**
 * Choose the conversation's execution-permission mode. OWNER only; `full` only for an
 * Atrium administrator (the EFFECTIVE role: an administrator impersonating a regular
 * owner does not lend them the right — and the dispatch re-checks the owner's role
 * anyway). Audited under impersonation like the owner's other session actions.
 */
export const setPermissionMode = mutation({
  args: { chatId: v.id("chats"), mode: choiceValidator },
  handler: async (ctx, { chatId, mode }) => {
    const { userId, actor, role } = await requireActive(ctx);
    // Throws for anyone but the owner — participants SEE the mode, never set it.
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const refusal = permissionChoiceRefusal({
      choice: mode,
      isOwner: true,
      isAdmin: role === "admin",
      anyManaged: await conversationManagesPermissions(ctx, chat),
    });
    if (refusal !== null) {
      throw new Error(`Forbidden: ${refusal}`);
    }
    // Every choice is a new REVISION: an apply carries the one it was made for, and
    // only the current revision's outcome is ever recorded (recordPermissionModeApply).
    const revision = (chat.permissionModeRevision ?? 0) + 1;
    await ctx.db.patch(chatId, {
      permissionModeChoice: mode,
      permissionModeRevision: revision,
      permissionModeApply: { mode, revision, status: "pending", at: Date.now() },
    });
    // An unchanged choice is still re-applied: the gateway may have been changed behind
    // Atrium's back (the Control UI), and choosing again is how the owner restores it.
    await ctx.scheduler.runAfter(0, internal.permissionMode.dispatchPermissionMode, {
      chatId,
      userId,
      mode,
      revision,
    });
    await auditImpersonated(ctx, actor, "chat.permission_mode", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

/** The instances the conversation can reach: its binding, its last routed agent and
 *  the agents added to its room. */
async function conversationInstances(
  ctx: QueryCtx,
  chat: Doc<"chats">,
): Promise<Set<string>> {
  const names = new Set<string>();
  if (chat.instanceName !== undefined) names.add(chat.instanceName);
  if (chat.lastRoutedInstanceName !== undefined) names.add(chat.lastRoutedInstanceName);
  const room = await ctx.db
    .query("chatAgents")
    .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
    .take(50);
  for (const a of room) names.add(a.instanceName);
  return names;
}

async function instanceByName(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
}

/** Does Atrium manage execution permissions on at least one OpenClaw instance of the
 *  conversation? When none, the owner has nothing to choose. */
async function conversationManagesPermissions(
  ctx: QueryCtx,
  chat: Doc<"chats">,
): Promise<boolean> {
  for (const name of await conversationInstances(ctx, chat)) {
    const inst = await instanceByName(ctx, name);
    if ((inst?.kind ?? "openclaw") === "openclaw" && instanceManagesPermissions(inst)) {
      return true;
    }
  }
  return false;
}

/** The agent a session operation on this chat reaches when nobody names one: the last
 *  routed agent on a per-turn chat, else the bound one (getChatRouting's rule). */
function currentAgentRef(
  chat: Doc<"chats">,
): { instanceName: string; agentId: string } | null {
  const instanceName =
    chat.perTurnRouting === true
      ? (chat.lastRoutedInstanceName ?? chat.instanceName)
      : chat.instanceName;
  const agentId =
    chat.perTurnRouting === true ? (chat.lastRoutedAgentId ?? chat.agentId) : chat.agentId;
  return instanceName === undefined || agentId === undefined
    ? null
    : { instanceName, agentId };
}

/**
 * What the composer's permission control shows — to EVERY reader of the conversation
 * (participants see the mode, they do not set it). `routedAgent`: the agent the next
 * message goes to, for "Default (<that agent's mode>)"; a guest's value is kept only
 * when it is one of the room's agents (roomProjection).
 */
export const permissionControl = query({
  args: {
    chatId: v.id("chats"),
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }) => {
    const { userId, role } = await requireActive(ctx);
    const access = await requireReachableChat(ctx, userId, chatId);
    const room = await roomProjection(ctx, access, routedAgent ?? null);
    const ref = room.routedAgent ?? currentAgentRef(access.chat);
    const agent =
      ref === null
        ? null
        : await ctx.db
            .query("agents")
            .withIndex("by_instance_agent", (q) =>
              q.eq("instanceName", ref.instanceName).eq("agentId", ref.agentId),
            )
            .first();
    const agentDefault = agent?.defaultPermissionMode;
    const nextInstance = ref === null ? null : await instanceByName(ctx, ref.instanceName);
    return {
      // Atrium manages permissions on the instance the next message goes to…
      managed: instanceManagesPermissions(nextInstance),
      // …and on at least one OpenClaw instance of the conversation.
      anyManaged: await conversationManagesPermissions(ctx, access.chat),
      viewerRole: access.role,
      // May this viewer choose `full`? Only an Atrium administrator (and only the
      // owner chooses at all).
      viewerIsAdmin: role === "admin",
      choice: storedChoice(access.chat) ?? null,
      apply: access.chat.permissionModeApply ?? null,
      agentDefault: isSessionPermissionMode(agentDefault) ? agentDefault : null,
    };
  },
});

/** How many times one revision may be re-applied because an older apply may have
 *  landed after it (see recordPermissionModeApply). */
export const MAX_REAPPLIES_PER_REVISION = 3;

/** Record the outcome of an on-the-spot apply — only for the choice it was made for. */
export const recordPermissionModeApply = internalMutation({
  args: {
    chatId: v.id("chats"),
    mode: choiceValidator,
    revision: v.number(),
    status: applyStatusValidator,
    reason: v.optional(v.string()),
    /** The request left and the answer does not say whether the gateway changed. */
    uncertain: v.optional(v.boolean()),
  },
  handler: async (ctx, { chatId, mode, revision, status, reason, uncertain }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    const current = chat.permissionModeRevision ?? 0;
    if (revision !== current) {
      // STALE: a newer choice was made while this apply was in flight. Its outcome is
      // dropped — but when it DID (or MAY have) change(d) the gateway, it may have
      // landed after the newer choice's own apply and left the session under the older
      // mode. The newer choice is then applied again, and shown as pending until it is.
      //
      // BOUNDED: a re-apply is only ever triggered by a STALE outcome, each dispatch
      // yields exactly one outcome, and a current-revision outcome never schedules
      // anything — so re-applies cannot feed themselves. As a belt, at most
      // MAX_REAPPLIES_PER_REVISION per revision; past it the current choice is shown
      // failed, and the next turn's own enforcement still puts it on the session.
      const previous =
        chat.permissionModeApply?.revision === current ? (chat.permissionModeApply.repairs ?? 0) : 0;
      if ((status === "applied" || uncertain === true) && chat.permissionModeChoice !== undefined) {
        const choice = chat.permissionModeChoice;
        if (previous >= MAX_REAPPLIES_PER_REVISION) {
          await ctx.db.patch(chatId, {
            permissionModeApply: {
              mode: choice,
              revision: current,
              repairs: previous,
              status: "failed",
              reason: "reapply_exhausted",
              at: Date.now(),
            },
          });
          return;
        }
        await ctx.db.patch(chatId, {
          permissionModeApply: {
            mode: choice,
            revision: current,
            repairs: previous + 1,
            status: "pending",
            at: Date.now(),
          },
        });
        await ctx.scheduler.runAfter(0, internal.permissionMode.dispatchPermissionMode, {
          chatId,
          userId: chat.userId,
          mode: choice,
          revision: current,
        });
      }
      return;
    }
    if (chat.permissionModeChoice !== mode) return;
    const repairs = chat.permissionModeApply?.revision === revision ? chat.permissionModeApply.repairs : undefined;
    await ctx.db.patch(chatId, {
      permissionModeApply: {
        mode,
        revision,
        ...(repairs === undefined ? {} : { repairs }),
        status,
        ...(reason === undefined ? {} : { reason }),
        at: Date.now(),
      },
    });
  },
});

/**
 * The LAST Convex-side gate before an on-the-spot apply is POSTed: is `revision` still
 * the current choice, and what does the permission decision say NOW (the owner's role
 * for `full`, the instance's opt-in, the snapshot) — one transaction, like the send's
 * lastGateBeforeSend.
 */
export const claimPermissionApply = internalMutation({
  args: { chatId: v.id("chats"), revision: v.number(), instanceName: v.string() },
  handler: async (
    ctx,
    { chatId, revision, instanceName },
  ): Promise<{ current: false } | { current: true; permission: TurnPermission }> => {
    const chat = await ctx.db.get(chatId);
    if (chat === null || (chat.permissionModeRevision ?? 0) !== revision) {
      return { current: false };
    }
    return { current: true, permission: await decideTurnPermission(ctx, chat, instanceName) };
  },
});

/**
 * Apply the choice NOW to the session the next turn uses (`currentSession`: on a
 * per-turn routed chat, the last confirmed agent's). Never throws (a thrown action is
 * retried by Convex): every outcome is RECORDED for the composer, failures included —
 * the owner is told the mode did not change, never left believing it did.
 */
export const dispatchPermissionMode = internalAction({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    mode: choiceValidator,
    revision: v.number(),
  },
  handler: async (ctx, { chatId, userId, mode, revision }) => {
    const record = async (
      status: "applied" | "deferred" | "failed",
      reason?: string,
      uncertain?: boolean,
    ): Promise<void> => {
      await ctx.runMutation(internal.permissionMode.recordPermissionModeApply, {
        chatId,
        mode,
        revision,
        status,
        ...(reason === undefined ? {} : { reason }),
        ...(uncertain === true ? { uncertain: true } : {}),
      });
    };
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) {
      console.error("permissionMode.dispatch: BRIDGE_SHARED_SECRET not configured");
      await record("failed", "not_configured");
      return;
    }
    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId,
      userId,
      currentSession: true,
    });
    if (!routing || routing.target === null || routing.permission === null) {
      await record("failed", "no_agent");
      return;
    }
    if (!routing.bridgeUrl) {
      await record("failed", "not_configured");
      return;
    }
    // Decided AGAIN at the last moment, in one transaction with the revision check —
    // never from the routing read above.
    const claim = await ctx.runMutation(internal.permissionMode.claimPermissionApply, {
      chatId,
      revision,
      instanceName: routing.target.instanceName,
    });
    // Superseded by a newer choice: its own dispatch applies and reports.
    if (!claim.current) return;
    const permission = claim.permission;
    const choice = permission.choice;
    if (choice === null && permission.managed) {
      // The session the next turn uses is not an OpenClaw one (Hermes has no modes):
      // the choice waits for the conversation's next OpenClaw session.
      await record("deferred", "not_openclaw");
      return;
    }
    if (choice === null) {
      // The session the next turn uses sits on an instance whose operator manages
      // permissions: nothing is sent there (the choice applies to the conversation's
      // managed instances, at their next turn).
      await record("deferred", "not_managed");
      return;
    }
    // The target's bridge is not CONFIRMED to take modes (no fresh snapshot declaring
    // them): an older bridge would answer 404 — said as what it is.
    if (!permission.confirmed) {
      await record("failed", "unsupported_gateway");
      return;
    }
    let outcome: { status: "applied" | "deferred" | "failed"; reason?: string; effect: ApplyEffect };
    try {
      const response = await fetch(
        `${routing.bridgeUrl.replace(/\/$/, "")}/permission-mode`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: sharedSecret },
          body: JSON.stringify({
            chatId,
            openclawChatId: routing.openclawChatId,
            instanceName: routing.target.instanceName,
            agentId: routing.target.agentId,
            canonical: routing.target.canonical,
            // Same person, same gateway name: reach the SAME per-conversation socket
            // as /send and /patch (see dispatchPatch).
            ...(routing.gatewayUser === undefined ? {} : { gatewayUser: routing.gatewayUser }),
            choice: choice.choice,
            fullAuthorized: choice.fullAuthorized,
            // Re-read at the claim: the bridge refuses without it.
            managed: permission.managed,
          }),
        },
      );
      outcome = await readPermissionModeResponse(response);
    } catch (err) {
      console.error("bridge POST /permission-mode failed:", err);
      // The POST may have reached the bridge and the patch the gateway: uncertain.
      outcome = { status: "failed", reason: "bridge_unreachable", effect: "uncertain" };
    }
    await record(outcome.status, outcome.reason, outcome.effect === "uncertain");
    // Metadata only: the mode name and the outcome enum.
    try {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "openclaw.permission_mode",
        direction: "outbound",
        principalType: "user",
        principalId: userId,
        chatId,
        correlationId: `${chatId}:permission_mode`,
        meta: JSON.stringify({
          mode,
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
        }),
      });
    } catch {
      // best-effort
    }
  },
});

/** The bridge's answer, as an outcome for the composer. Exported for tests. */
/**
 * What an apply may have done to the GATEWAY, whatever its recorded status:
 *  - "applied": the bridge says it patched (or found the mode already there);
 *  - "none": DEFINITELY nothing changed — a deferral, or a refusal the bridge names
 *    before any patch (scope_refused, active_run, rejected, not_managed,
 *    session_not_established, unsupported_gateway, full_not_authorized…) or a request
 *    it refused outright (4xx: bad body, instance not served);
 *  - "uncertain": the request left and the answer does not say — a 5xx (the bridge
 *    rethrows a `sessions.patch` that got NO answer, which may have landed) or a
 *    transport failure after the POST was sent.
 */
export type ApplyEffect = "applied" | "none" | "uncertain";

export async function readPermissionModeResponse(
  response: Response,
): Promise<{ status: "applied" | "deferred" | "failed"; reason?: string; effect: ApplyEffect }> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const b = (body ?? {}) as {
    ok?: unknown;
    result?: unknown;
    savedNotApplied?: unknown;
    error?: { code?: unknown; reason?: unknown } | unknown;
  };
  if (response.ok && b.ok === true) {
    if (b.result === "deferred") return { status: "deferred", effect: "none" };
    return b.savedNotApplied === true
      ? { status: "applied", reason: "saved_not_applied", effect: "applied" }
      : { status: "applied", effect: "applied" };
  }
  // A 5xx says nothing about what happened on the gateway.
  const effect: ApplyEffect = response.status >= 500 ? "uncertain" : "none";
  const err = (typeof b.error === "object" && b.error !== null ? b.error : {}) as {
    code?: unknown;
    reason?: unknown;
  };
  if (err.code === "permission_mode_not_applied" && typeof err.reason === "string") {
    return { status: "failed", reason: err.reason, effect };
  }
  if (typeof err.code === "string" && /^[a-z_]{1,48}$/.test(err.code)) {
    return { status: "failed", reason: err.code, effect };
  }
  return { status: "failed", reason: "bridge_error", effect };
}
