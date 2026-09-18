// Realtime voice ("talk") — SLICE 2: mint a gateway-owned ephemeral browser
// session for a chat's instance.
//
// Flow: the browser calls `mintTalkSession({chatId})` (public action) -> the
// prepare query resolves the target from owned state (requireOwnedChat + the chat's
// own routing) and applies the admin gate (integrationConfig.talk.enabled, default
// OFF) -> the action POSTs the instance's bridge /talk-session ->
// the bridge calls gateway `talk.client.create` -> the SHORT-LIVED provider
// clientSecret is relayed to the authenticated owner.
//
// SECURITY:
//  - the gateway holds the provider API key and mints the ephemeral secret;
//    this deployment NEVER sees a long-lived provider credential;
//  - the clientSecret is returned to the caller and NEVER logged/persisted;
//  - graceful degradation for every OPERATIONAL failure ({ok:false, code}): a throw
//    would surface to the browser as an opaque failure with no code to act on, and
//    each of these outcomes has a specific thing for the UI to say. Authorization
//    gates still REJECT the action (that is what `requireOwnedChat` does); the
//    control catches that and turns it into a generic code, so the button never
//    leaves the panel mid-connect.
//
// WHAT THE CLIENT MAY NAME. Two things, and neither is trusted: the agent it wants
// (the composer's selection — AUTHORIZED against the effective grants by
// resolveTargetForTurn, the dispatch's own boundary) and the ID of a handle for the
// session a mid-call consult belongs to (a `talkSessions` row, checked against the
// caller, the chat and the clock, and whose agent is re-authorized on every use).
// The conversation and the canonical are never named by the client: they are read
// from that row, which the SERVER wrote at mint.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat } from "./lib/access";
import { currentTurnRouting, resolveTargetForTurn } from "./routing";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { capabilitiesForInstance } from "./lib/compat";
import { capabilityOf } from "../src/chat/capabilities";
import { readDoc as readCompatDoc } from "./compat";
import { parseTalkSessionResponse, type TalkSession } from "./lib/talk";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Is realtime voice OFFERED on this chat? Drives the composer button's
 * VISIBILITY (the gateway-version capability alone is not enough — the admin
 * enables talk PER INSTANCE, and a disabled instance must show no button at
 * all, not a button that errors on click). Reactive: flipping the instance
 * switch adds/removes the button live. SOFT on every failure (false) — a
 * visibility probe must never crash the composer.
 */
export const talkAvailable = query({
  args: {
    chatId: v.id("chats"),
    // The agent the COMPOSER currently targets. A user can pick another agent and
    // press the voice button before sending anything — without this the session
    // would be minted for the agent the THREAD last engaged, and agents differ in
    // instructions, tools and access. Authorized server-side by resolveTargetForTurn
    // (the dispatch's own boundary), so a forged value can never reach an instance
    // the caller is not granted.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }): Promise<boolean> => {
    try {
      const { userId } = await requireActive(ctx);
      // OWNER-ONLY, like the mint (`requireOwnedChat`). A participant who saw the
      // button would get an action that refuses: the control recovers (the mint call
      // is guarded), but the button is dead, which is worse than absent.
      const chat = await requireOwnedChat(ctx, userId, chatId);
      // The SAME resolution the mint uses: on a per-turn routed chat the button
      // must reflect the instance the session would really reach, not the chat's
      // primary binding (talk is enabled per instance).
      const routing = await resolveTalkRouting(
        ctx,
        chat,
        userId,
        routedAgent ?? null,
      );
      if (routing === null) return false;
      const instance = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", routing.target.instanceName))
        .first();
      if (instance?.kind === "hermes" || instance?.config?.talkEnabled !== true) {
        return false;
      }
      // …AND the gateway must actually expose the surface. This is read HERE, for the
      // instance this session would reach, because `compat.forChat` answers about the
      // chat AS IT STANDS: with no explicit selection it prefers `chat.instanceName`
      // over the resolver, so a chat whose bound agent is gone and which now falls
      // back to another instance would be described by the OLD one — hiding a button
      // that works, or offering one that cannot.
      //
      // FAIL CLOSED, the standing policy for talk: no snapshot, no target row, or no
      // capability map means NO button. A legacy bridge is assumed to have the
      // historic surface and nothing newer (LEGACY_CAPABILITIES), and a button on a
      // gateway without `talk.client.create` hard-fails at the mint.
      const compat = await readCompatDoc(ctx);
      if (compat === null) return false;
      const caps = capabilitiesForInstance(
        compat.targets,
        routing.target.instanceName,
      );
      if (caps === null) return false; // the instance is not in the snapshot
      // Through the TYPED gate, never the raw key: a capability spelled in a string
      // survives a rename by going silently false (capabilityAccess.test.ts). Note
      // that `capabilityOf` treats a null map as the LEGACY set, which does not
      // include talk — the fail-closed answer this wants.
      return capabilityOf(caps.capabilities, "talk");
    } catch {
      return false;
    }
  },
});

/**
 * WHICH agent owns this chat's voice session, and WHICH gateway conversation it
 * must land in — the two facts every Talk lane needs, resolved in ONE place.
 *
 * All three lanes previously read `resolveTargetForChat` + `chat.routingSegment`
 * side by side, which disagrees with the TYPED-turn path:
 *
 *  - the AGENT came from the chat's PRIMARY binding while the segment came from
 *    whatever the thread last routed. A chat bound to alice whose turns go to bob
 *    minted `agent:alice:…:<bob's segment>` — one agent's name over another
 *    agent's conversation, and a POST to alice's instance when bob lives on a
 *    different gateway;
 *  - on a REBIND (the bound agent GONE from the gateway — a revoked but present
 *    agent is `agent_restricted` instead, with no rebind) `chat.openclawChatId` is the
 *    OLD agent's provider conversation. convex/bridge.ts drops it for exactly that
 *    reason; carrying it would point the new agent at a session that is not its
 *    own.
 *
 * `currentTurnRouting` answers both halves from ONE source, so voice, text and the
 * capacity gauge agree — including mid-switch, after a FAILED switch, and for a
 * composer selection the user has not sent yet (`explicit`).
 *
 * WHEN THAT SOURCE HAS NO CONVERSATION (an agent nothing has run for yet), the
 * answer stays null and the bridge keys on the chat id. It is deliberately NOT
 * `chat.openclawChatId`: that id belongs to whichever agent the chat was bound to,
 * and borrowing it is the very mixing this resolution exists to prevent. DECLARED
 * LIMIT: this voice session is then its own conversation — the first typed turn to
 * that agent will mint `turn:<turnId>` through beginTurnRouting, which no read can
 * predict. Sharing a conversation with a turn that does not exist yet would require
 * the mint to allocate the segment itself, which is a routing change, not this fix.
 *
 * `null` = no routable agent (the callers answer `no_agent`).
 */
async function resolveTalkRouting(
  ctx: QueryCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
  explicit: { instanceName: string; agentId: string } | null = null,
): Promise<{
  target: { instanceName: string; agentId: string; canonical: string };
  openclawChatId: string | null;
} | null> {
  const current = await currentTurnRouting(ctx, chat, explicit);
  const res = await resolveTargetForTurn(ctx, chat, userId, current.agent);
  if (!res.target) return null;
  return {
    target: res.target,
    // The conversation THAT source named, verbatim — except on a REBIND, where it
    // is the bound id of an agent that is gone and the dispatch drops it too.
    openclawChatId: res.rebind ? null : current.conversation,
  };
}

/**
 * How long a voice handle stays valid.
 *
 * NOT the gateway's `expiresAt`: that expires the connection SECRET, and a WebRTC
 * connection already established outlives it — taking the handle down with it would
 * drop a legitimately live conversation's consult back into the thread's routing.
 * And not an end-of-call boundary either: nothing invalidates a row when the user
 * hangs up. It is a hard ceiling on how long a handle can address its session,
 * generous enough to cover a long call; expiry does not end anything, it only stops
 * the handle from answering.
 */
const TALK_HANDLE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Record the session a successful mint opened, and hand back the only thing the
 * browser needs to hold.
 *
 * WHAT THE ROW PROVES, exactly: that a mint SUCCEEDED with this address. It does not
 * prove a call is up — the microphone, the SDP exchange or the connection can still
 * fail afterwards — and nothing invalidates it on hang-up. That is why the consult
 * re-authorizes what the row names rather than trusting it wholesale, and why the
 * row carries a hard expiry.
 *
 * `canonical` is stored with the rest because it is the THIRD component of the
 * gateway session key: a profile whose canonical changes mid-call would otherwise
 * make the consult address a different session than the one on the line.
 *
 * Expired rows are swept here, bounded; a scheduled janitor does the rest, since a
 * deployment that stops minting would otherwise keep its last expired rows forever.
 */
export const recordTalkSession = internalMutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
    canonical: v.string(),
    conversation: v.string(),
  },
  handler: async (
    ctx,
    { chatId, instanceName, agentId, canonical, conversation },
  ): Promise<Id<"talkSessions">> => {
    const { userId } = await requireActive(ctx);
    // RE-CHECK EVERY AUTHORIZATION AND GATE AT THE WRITE. The prepare, the POST and
    // this mutation are three moments, and the credential is only handed to the
    // browser after this one returns. The canonical and the conversation are NOT
    // re-derived — pinning what the mint used is the whole point of the row; what is
    // re-checked is the right to be talking to this agent at all. A grant revoked, an agent deleted or retyped
    // utility-only, or talk switched off on the instance BETWEEN the prepare and
    // here would otherwise still hand out a working voice session — the consult
    // would be blocked afterwards, far too late. Throwing here fails the mint
    // closed: the caller answers `talk_session_unrecorded`, the secret is never
    // relayed, and the orphaned gateway session expires on its own.
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const still = await resolveTargetForTurn(ctx, chat, userId, {
      instanceName,
      agentId,
    });
    if (
      !still.target ||
      still.target.instanceName !== instanceName ||
      still.target.agentId !== agentId
    ) {
      throw new Error("talk target no longer authorized");
    }
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    if (instance?.kind === "hermes" || instance?.config?.talkEnabled !== true) {
      throw new Error("talk no longer enabled on this instance");
    }
    const now = Date.now();
    const stale = await ctx.db
      .query("talkSessions")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of stale) await ctx.db.delete(row._id);
    return await ctx.db.insert("talkSessions", {
      userId,
      chatId,
      instanceName,
      agentId,
      canonical,
      conversation,
      createdAt: now,
      expiresAt: now + TALK_HANDLE_TTL_MS,
    });
  },
});

/** Scheduled sweep: the opportunistic one only runs when someone mints, so a quiet
 *  deployment would keep its last expired handles indefinitely. Bounded per run. */
export const sweepTalkSessions = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const stale = await ctx.db
      .query("talkSessions")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(200);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});

const TALK_MINT_TIMEOUT_MS = 50_000; // cold gateway connect (30s) + mint

type PrepareResult =
  | {
      ok: true;
      instanceName: string;
      bridgeUrl: string | null;
      transport: string;
      /** Session-key ingredients for the OWNING agent — see the prepare below. */
      agentId: string;
      canonical: string;
      openclawChatId: string | null;
    }
  | { ok: false; code: string };

/** Ownership + per-instance gate + routing resolution (query ctx owns the db). */
export const prepareTalkSession = internalQuery({
  args: {
    chatId: v.id("chats"),
    // The agent the COMPOSER currently targets. A user can pick another agent and
    // press the voice button before sending anything — without this the session
    // would be minted for the agent the THREAD last engaged, and agents differ in
    // instructions, tools and access. Authorized server-side by resolveTargetForTurn
    // (the dispatch's own boundary), so a forged value can never reach an instance
    // the caller is not granted.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }): Promise<PrepareResult> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const routing = await resolveTalkRouting(
      ctx,
      chat,
      userId,
      routedAgent ?? null,
    );
    if (routing === null) return { ok: false, code: "no_agent" };
    const target = routing.target;
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", target.instanceName))
      .first();
    // Hermes has no talk surface (capability-gated in the UI too) — answer
    // with the honest code rather than a bridge 400.
    if (instance?.kind === "hermes") return { ok: false, code: "talk_unsupported" };
    // PER-GATEWAY opt-in (default OFF), like every voice feature: the admin
    // enables talk on the instances whose gateway is configured for it. The
    // GATEWAY owns the talk configuration (provider/model/voice defaults, API
    // key) — Atrium only consumes the surface.
    if (instance?.config?.talkEnabled !== true) {
      return { ok: false, code: "talk_disabled" };
    }
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: target.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    return {
      ok: true,
      instanceName: target.instanceName,
      bridgeUrl: bridgeUrl ?? null,
      // The browser lane — the only client-owned transport; the gateway
      // validates it regardless.
      transport: "webrtc",
      // The SESSION-KEY ingredients — the same three `prepareTalkToolCall`
      // already resolves. The canonical and the chat come from OWNED state; the
      // agent may be NAMED by the caller (the composer's selection) and is
      // AUTHORIZED here through the effective grants, which is not the same as
      // being trusted.
      // The gateway reads a Talk session's owning agent OFF an agent-scoped key;
      // without one it falls back to `config.talk.agentId`, and refuses outright
      // when several agents exist with no such fallback — which is how the voice
      // button died on both multi-agent instances (live prod 2026-09-17). The
      // fallback is no better: it answers as one arbitrary agent, not the chat's.
      agentId: target.agentId,
      canonical: target.canonical,
      openclawChatId: routing.openclawChatId,
    };
  },
});

type ToolCallPrepare =
  | {
      ok: true;
      instanceName: string;
      agentId: string;
      canonical: string;
      openclawChatId: string | null;
      bridgeUrl: string | null;
    }
  | { ok: false; code: string };

/** Ownership + admin-gate + FULL routing for the agent-consult relay: the bridge
 *  needs the session-key ingredients (chatId/openclawChatId + agentId + canonical).
 *  WITH a handle — the normal case during a call — the agent, the canonical and the
 *  conversation all come from the server's own row, and only the agent is re-checked
 *  against current authorization. WITHOUT one, they are resolved from owned state,
 *  and the caller may name the agent it wants (AUTHORIZED through the effective
 *  grants, which is not the same thing as trusted). */
export const prepareTalkToolCall = internalQuery({
  args: {
    chatId: v.id("chats"),
    // The handle of the session this consult belongs to (talk.recordTalkSession,
    // returned by the mint). The ROW carries the agent, the canonical and the
    // conversation the call was opened on, so the consult reaches the session the
    // user is speaking in rather than whatever the thread has moved to since. The
    // browser holds only the id.
    sessionId: v.optional(v.id("talkSessions")),
    // Fallback when no handle is held (a session minted before this contract): the
    // agent the COMPOSER currently targets, authorized by resolveTargetForTurn.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, routedAgent, sessionId },
  ): Promise<ToolCallPrepare> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    // A handle names the address the mint succeeded with. When one is SUPPLIED it
    // decides the answer — re-resolving is exactly what would walk the consult out of
    // the live call — but it is never a bypass:
    //
    //  - a supplied handle that is unknown, expired or another chat's FAILS. Falling
    //    back to the thread's current routing would silently send the consult into a
    //    different session, which is the defect this handle exists to prevent; only
    //    the ABSENCE of a handle takes the legacy path.
    //  - its agent is re-run through the CURRENT authorization. A grant revoked, a
    //    group left, an agent retyped utility-only or deleted mid-call must stop the
    //    consult, and the re-resolution must land on THAT agent — never fall back to
    //    another one, which would answer as someone the user is not speaking to.
    //
    // The CHAT check is the load-bearing half of the ownership pair. The `userId`
    // check beside it cannot fire today, since `recordTalkSession` and this handler
    // both run `requireOwnedChat`; it stays for the day a chat can change hands.
    const live = sessionId === undefined ? null : await ctx.db.get(sessionId);
    if (sessionId !== undefined) {
      if (
        live === null ||
        live.userId !== userId ||
        live.chatId !== chatId ||
        live.expiresAt <= Date.now()
      ) {
        return { ok: false, code: "talk_session_stale" };
      }
      const still = await resolveTargetForTurn(ctx, chat, userId, {
        instanceName: live.instanceName,
        agentId: live.agentId,
      });
      // The EQUALITY half cannot fire against today's resolver: given an explicit
      // choice it answers that agent or nothing (not entitled → agent_restricted,
      // deleted → no_agent), never a substitute. It is written anyway because the
      // substitute is the dangerous outcome — the consult would answer as an agent
      // the user is not speaking to — and a resolver that one day falls back for an
      // explicit choice must not silently acquire that power here.
      if (
        !still.target ||
        still.target.instanceName !== live.instanceName ||
        still.target.agentId !== live.agentId
      ) {
        return { ok: false, code: "agent_restricted" };
      }
    }
    const routing = live
      ? {
          target: {
            instanceName: live.instanceName,
            agentId: live.agentId,
            // PINNED: the key's third component. A canonical that changes mid-call
            // would otherwise address a different session.
            canonical: live.canonical,
          },
          openclawChatId: live.conversation,
        }
      : await resolveTalkRouting(ctx, chat, userId, routedAgent ?? null);
    if (routing === null) return { ok: false, code: "no_agent" };
    const target = routing.target;
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", target.instanceName))
      .first();
    if (instance?.kind === "hermes") return { ok: false, code: "talk_unsupported" };
    // Same PER-GATEWAY opt-in as the session mint.
    if (instance?.config?.talkEnabled !== true) {
      return { ok: false, code: "talk_disabled" };
    }
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: target.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    return {
      ok: true,
      instanceName: target.instanceName,
      agentId: target.agentId,
      canonical: target.canonical,
      openclawChatId: routing.openclawChatId,
      bridgeUrl: bridgeUrl ?? null,
    };
  },
});

// The consult can run a real (long) agent turn: bridge holds up to 90s, so the
// action budget must comfortably exceed it.
const TALK_CONSULT_TIMEOUT_MS = 110_000;
const MAX_CONSULT_FIELD_CHARS = 6_000;

/**
 * PUBLIC entry: relay the voice model's `openclaw_agent_consult` tool call to
 * a real agent run on this chat's session, and wait (bounded) for its result.
 * Returns {ok:true, resultText} | {ok:true, pending:true} (still running) |
 * {ok:true, errorText} (the run failed — the voice says so) | {ok:false, code}.
 */
export const relayTalkToolCall = action({
  args: {
    chatId: v.id("chats"),
    callId: v.string(),
    args: v.object({
      question: v.string(),
      context: v.optional(v.string()),
      responseStyle: v.optional(v.string()),
    }),
    // The handle of the session this consult belongs to (from the mint). It names
    // the agent AND the conversation, so the consult reaches the call the user is
    // in rather than whatever the thread has moved to since.
    sessionId: v.optional(v.id("talkSessions")),
    // Fallback for a session minted before this contract: the composer's selection.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, callId, args, routedAgent, sessionId },
  ): Promise<
    | { ok: true; resultText?: string; errorText?: string; pending?: boolean }
    | { ok: false; code: string }
  > => {
    if (args.question.trim() === "" || callId.trim() === "") {
      return { ok: false, code: "invalid_args" };
    }
    const prep: ToolCallPrepare = await ctx.runQuery(
      internal.talk.prepareTalkToolCall,
      {
        chatId,
        ...(routedAgent ? { routedAgent } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    );
    if (!prep.ok) return prep;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = prep.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret) return { ok: false, code: "not_configured" };
    // Bound every relayed field: the voice model's args are model-generated
    // input, not trusted sizes.
    const bounded = {
      question: args.question.slice(0, MAX_CONSULT_FIELD_CHARS),
      ...(args.context
        ? { context: args.context.slice(0, MAX_CONSULT_FIELD_CHARS) }
        : {}),
      ...(args.responseStyle
        ? { responseStyle: args.responseStyle.slice(0, 500) }
        : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TALK_CONSULT_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${bridgeUrl.replace(/\/$/, "")}/talk-toolcall`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: sharedSecret,
          },
          body: JSON.stringify({
            instanceName: prep.instanceName,
            chatId,
            openclawChatId: prep.openclawChatId,
            canonical: prep.canonical,
            agentId: prep.agentId,
            callId: callId.slice(0, 200),
            args: bounded,
          }),
          signal: controller.signal,
        },
      );
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const code =
          (data as { error?: { code?: string } } | null)?.error?.code ??
          `bridge_${response.status}`;
        return { ok: false, code };
      }
      const d = data as {
        ok?: boolean;
        resultText?: unknown;
        errorText?: unknown;
        pending?: unknown;
      } | null;
      if (d?.ok !== true) return { ok: false, code: "talk_malformed" };
      return {
        ok: true,
        ...(typeof d.resultText === "string" ? { resultText: d.resultText } : {}),
        ...(typeof d.errorText === "string" ? { errorText: d.errorText } : {}),
        ...(d.pending === true ? { pending: true } : {}),
      };
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});

/**
 * PUBLIC entry: mint an ephemeral realtime-voice session for this chat's
 * instance. Returns `{ok:true, session, sessionId}` — the browser opens the WebRTC
 * connection with `session` and carries `sessionId` on the mid-call consult — or
 * `{ok:false, code}`; codes include talk_disabled
 * (admin gate), talk_unsupported (provider), not_configured / bridge_<status>
 * (transport), talk_malformed (unexpected gateway shape).
 */
export const mintTalkSession = action({
  args: {
    chatId: v.id("chats"),
    // The composer's voice pick (optional): forwarded to the gateway, which
    // validates against ITS allowlist (unknown -> configured default).
    voice: v.optional(v.string()),
    // Mic sensitivity (server_vad threshold 0..1) — the composer's talk
    // settings; the gateway/provider clamps and defaults.
    vadThreshold: v.optional(v.number()),
    // The agent the composer currently targets — see prepareTalkSession. Passed
    // through, never trusted: the prepare authorizes it.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, voice, vadThreshold, routedAgent },
  ): Promise<
    | { ok: true; session: TalkSession; sessionId: Id<"talkSessions"> }
    | { ok: false; code: string }
  > => {
    const prep: PrepareResult = await ctx.runQuery(
      internal.talk.prepareTalkSession,
      { chatId, ...(routedAgent ? { routedAgent } : {}) },
    );
    if (!prep.ok) return prep;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    const bridgeUrl = prep.bridgeUrl ?? process.env.BRIDGE_URL ?? null;
    if (!bridgeUrl || !sharedSecret) return { ok: false, code: "not_configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TALK_MINT_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${bridgeUrl.replace(/\/$/, "")}/talk-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Bare value (NOT Bearer-prefixed) — matches bridge.dispatch.
            Authorization: sharedSecret,
          },
          body: JSON.stringify({
            instanceName: prep.instanceName,
            transport: prep.transport,
            // Names the OWNER: the bridge builds the chat's agent-scoped session
            // key from these, and the gateway reads the agent off it.
            chatId,
            agentId: prep.agentId,
            canonical: prep.canonical,
            ...(prep.openclawChatId !== null
              ? { openclawChatId: prep.openclawChatId }
              : {}),
            ...(typeof voice === "string" && voice !== ""
              ? { voice: voice.slice(0, 60) }
              : {}),
            ...(typeof vadThreshold === "number" &&
            Number.isFinite(vadThreshold) &&
            vadThreshold > 0 &&
            vadThreshold < 1
              ? { vadThreshold }
              : {}),
          }),
          signal: controller.signal,
        },
      );
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        // Surface the bridge's structured code when present (e.g. the gateway
        // has no realtime provider configured); never the body itself.
        const code =
          (data as { error?: { code?: string } } | null)?.error?.code ??
          `bridge_${response.status}`;
        return { ok: false, code };
      }
      const session = parseTalkSessionResponse(data);
      if (session === null) return { ok: false, code: "talk_malformed" };
      // PROOF that the bridge actually scoped the create on the agent we named. A
      // bridge predating this contract answers the same shape while dropping the
      // ownership fields: the gateway then opens the session under its own
      // `talk.agentId` fallback — possibly an agent this user was never granted —
      // while the handle below would record the agent we ASKED for. Voice and
      // consult would run on two different agents, which is the whole defect this
      // lot exists to remove. Refuse instead; the orphaned gateway session expires.
      if ((data as { ownerScoped?: unknown } | null)?.ownerScoped !== true) {
        // COST, stated: the gateway session this POST opened is now orphaned, and a
        // user who keeps pressing the button orphans one per attempt until each
        // expires. That is the price of the skew window, and it is the cheaper side
        // — the alternative is a voice call running as an agent this user may never
        // have been granted.
        return { ok: false, code: "talk_owner_unconfirmed" };
      }
      // NEVER log `session` — it carries the ephemeral provider credential.
      // The mint SUCCEEDED. Record the address it opened BEFORE the secret is
      // relayed: the row is what tells the mid-call consult which agent, canonical
      // and conversation this call belongs to, and recording it re-checks that the
      // address is still authorized — so a right withdrawn during the POST cannot
      // hand out a working session. The browser gets an id, nothing else. The
      // EFFECTIVE conversation is `openclawChatId ?? chatId`, the same fallback the
      // bridge applies when it builds the key, so a call opened before any turn
      // existed is pinned just as firmly as one that inherited a segment.
      let sessionId: Id<"talkSessions">;
      try {
        sessionId = await ctx.runMutation(internal.talk.recordTalkSession, {
          chatId,
          instanceName: prep.instanceName,
          agentId: prep.agentId,
          canonical: prep.canonical,
          conversation: prep.openclawChatId ?? chatId,
        });
      } catch {
        // The gateway session is OPEN and we cannot prove what it is. Fail closed —
        // the clientSecret is never handed out — and say so under its own code: the
        // broad catch below would report this as an unreachable bridge, which is the
        // one thing it is not. The orphaned gateway session expires on its own.
        return { ok: false, code: "talk_session_unrecorded" };
      }
      return { ok: true, session, sessionId };
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});
