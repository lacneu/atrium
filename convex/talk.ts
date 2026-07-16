// Realtime voice ("talk") — SLICE 2: mint a gateway-owned ephemeral browser
// session for a chat's instance.
//
// Flow: the browser calls `mintTalkSession({chatId})` (public action) -> the
// prepare query re-derives EVERYTHING from owned state (requireOwnedChat +
// the chat's own routing — nothing client-supplied is trusted beyond the
// chatId) and applies the admin gate (integrationConfig.talk.enabled,
// default OFF) -> the action POSTs the instance's bridge /talk-session ->
// the bridge calls gateway `talk.client.create` -> the SHORT-LIVED provider
// clientSecret is relayed to the authenticated owner.
//
// SECURITY:
//  - the gateway holds the provider API key and mints the ephemeral secret;
//    this deployment NEVER sees a long-lived provider credential;
//  - the clientSecret is returned to the caller and NEVER logged/persisted;
//  - graceful degradation everywhere ({ok:false, code} — an action throw
//    would be retried by Convex, and none of these failures are retryable).

import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat } from "./lib/access";
import { resolveTargetForChat } from "./routing";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { parseTalkSessionResponse, type TalkSession } from "./lib/talk";

/**
 * Is realtime voice OFFERED on this chat? Drives the composer button's
 * VISIBILITY (the gateway-version capability alone is not enough — the admin
 * enables talk PER INSTANCE, and a disabled instance must show no button at
 * all, not a button that errors on click). Reactive: flipping the instance
 * switch adds/removes the button live. SOFT on every failure (false) — a
 * visibility probe must never crash the composer.
 */
export const talkAvailable = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<boolean> => {
    try {
      const { userId } = await requireActive(ctx);
      const chat = await requireOwnedChat(ctx, userId, chatId);
      const res = await resolveTargetForChat(ctx, chat, userId);
      if (!res.target) return false;
      const instance = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", res.target!.instanceName))
        .first();
      return instance?.kind !== "hermes" && instance?.config?.talkEnabled === true;
    } catch {
      return false;
    }
  },
});

const TALK_MINT_TIMEOUT_MS = 50_000; // cold gateway connect (30s) + mint

type PrepareResult =
  | {
      ok: true;
      instanceName: string;
      bridgeUrl: string | null;
      transport: string;
    }
  | { ok: false; code: string };

/** Ownership + per-instance gate + routing resolution (query ctx owns the db). */
export const prepareTalkSession = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<PrepareResult> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const res = await resolveTargetForChat(ctx, chat, userId);
    if (!res.target) return { ok: false, code: "no_agent" };
    const target = res.target;
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

/** Ownership + admin-gate + FULL routing for the agent-consult relay: the
 *  bridge needs the session-key ingredients (chatId/openclawChatId + agentId +
 *  canonical) — all re-derived from OWNED state, never client-supplied. */
export const prepareTalkToolCall = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<ToolCallPrepare> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const res = await resolveTargetForChat(ctx, chat, userId);
    if (!res.target) return { ok: false, code: "no_agent" };
    const target = res.target;
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
      // The chat's CURRENT gateway session: the per-turn segment when routed
      // per turn (last confirmed), else the bound provider conversation id.
      openclawChatId: chat.perTurnRouting
        ? (chat.routingSegment ?? null)
        : (chat.openclawChatId ?? null),
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
  },
  handler: async (
    ctx,
    { chatId, callId, args },
  ): Promise<
    | { ok: true; resultText?: string; errorText?: string; pending?: boolean }
    | { ok: false; code: string }
  > => {
    if (args.question.trim() === "" || callId.trim() === "") {
      return { ok: false, code: "invalid_args" };
    }
    const prep: ToolCallPrepare = await ctx.runQuery(
      internal.talk.prepareTalkToolCall,
      { chatId },
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
 * instance. Returns `{ok:true, session}` (the browser opens the WebRTC
 * connection with it) or `{ok:false, code}` — codes include talk_disabled
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
  },
  handler: async (
    ctx,
    { chatId, voice, vadThreshold },
  ): Promise<{ ok: true; session: TalkSession } | { ok: false; code: string }> => {
    const prep: PrepareResult = await ctx.runQuery(
      internal.talk.prepareTalkSession,
      { chatId },
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
      // NEVER log `session` — it carries the ephemeral provider credential.
      return { ok: true, session };
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  },
});
