// Convex -> Bridge dispatch.
//
// `sendMessage` (send.ts) schedules `dispatch` after inserting the outbox row.
// `dispatch` is an internalAction (only it can `fetch`) that POSTs the pending
// message to the bridge's authenticated `POST /send` endpoint, then marks the
// outbox row sent/failed via an internalMutation.
//
// SECURITY / DEPLOYMENT (load-bearing):
//   - `BRIDGE_URL` and `BRIDGE_SHARED_SECRET` are read from DEPLOYMENT ENV
//     (set with `npx convex env set ...`), NEVER from tables or the browser.
//   - These are internal functions: not part of the public (browser) API.
//   - REQUIRES A LIVE DEPLOYMENT + a reachable bridge to actually send; the
//     `fetch` here only runs server-side on Convex.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { resolveTargetForChat, resolveTargetForTurn } from "./routing";
import { requireActive, requirePermission } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { buildOpenClawThreadId } from "./lib/openclawThread";
import {
  base64ByteLength,
  base64FitsFrame,
  DEFAULT_GATEWAY_MAX_PAYLOAD,
} from "./lib/attachmentLimits";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { bridgeDispatchConfig, resolveInstanceConfig } from "./lib/instanceConfig";
import { classifyAttachment } from "./lib/mediaTransport";
import { drainNextQueued } from "./lib/outboxQueue";
import { failDocumentaryFetchForChat } from "./documentAttachments";

// OpenClaw's default WS frame limit (policy.maxPayload), observed live on every
// 2026.x hello-ok. The conservative inbound-attachment fallback (DEFAULT_GATEWAY_MAX_PAYLOAD)
// now lives in ./lib/attachmentLimits so the COMPOSER shares the exact same value
// (it must cap identically to this dispatch, or a file the composer accepts gets
// rejected here — the divergence that let an oversize upload through with no upfront
// "too large").

/**
 * ArrayBuffer -> base64 in the DEFAULT Convex action runtime (no Node Buffer;
 * `btoa` is available). Chunked so a multi-MB attachment doesn't blow the call
 * stack on `String.fromCharCode(...spread)`.
 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Emit an outbound `openclaw.dispatch` trace via the `recordEvent`
 * internalMutation (an action has no `ctx.db`). D2: metadata only — never the
 * outbox text, attachment contents, or gateway tokens. Target instance/agent
 * NAMES are non-secret (the bridge maps them to tokens) and may be logged.
 * Wrapped so a trace failure can NEVER affect the dispatch outcome.
 */
async function traceDispatch(
  ctx: ActionCtx,
  args: {
    outboxId: Id<"outbox">;
    chatId?: string;
    dispatchStatus: "sent" | "failed";
    target?: { instanceName?: string; agentId?: string };
    reason?: string;
    // Curated root-cause code (non-PHI enum). For a gateway refusal it comes from
    // the bridge's classified 502 body; for the pre-bridge branches it is a fixed
    // local code. NEVER the raw gateway message (that stays in the bridge log).
    errorCode?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "openclaw.dispatch",
      direction: "outbound",
      principalType: "system",
      principalId: "bridge",
      chatId: args.chatId,
      correlationId: args.chatId
        ? `${args.chatId}:${args.outboxId}`
        : `${args.outboxId}`,
      meta: JSON.stringify({
        outboxId: args.outboxId,
        // String lifecycle status lives in meta (the `status` column is numeric).
        dispatchStatus: args.dispatchStatus,
        instanceName: args.target?.instanceName,
        agentId: args.target?.agentId,
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      }),
    });
  } catch {
    // Best-effort: never break the dispatch flow on a trace error.
  }
}

/**
 * Extract the curated error CODE from the bridge's 502 response, tolerant of BOTH
 * shapes so a Convex deploy can land BEFORE the new bridge image is pulled:
 *   - new bridge: { ok:false, error: { code } }  -> returns code
 *   - old bridge: { ok:false, error: "..." }     -> returns undefined (no code)
 * The `response.json()` is itself guarded: a 502 with an empty/non-JSON body must
 * never throw here, or the dispatch would crash and regress to a SILENT failure
 * (the very bug we are fixing). Returns undefined on any parse problem.
 */
export async function readErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    const err = body?.error;
    if (
      err !== null &&
      typeof err === "object" &&
      typeof (err as { code?: unknown }).code === "string"
    ) {
      return (err as { code: string }).code;
    }
  } catch {
    // empty / non-JSON body -> no structured cause; never throw
  }
  return undefined;
}

// Read a single outbox row (used by the dispatch action, which has no db
// access of its own — actions read via queries).
export const getOutbox = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }): Promise<Doc<"outbox"> | null> => {
    return await ctx.db.get(outboxId);
  },
});

// Mark an outbox row's terminal status after the dispatch attempt.
export const markOutbox = internalMutation({
  args: {
    outboxId: v.id("outbox"),
    status: v.union(v.literal("sent"), v.literal("failed")),
  },
  handler: async (ctx, { outboxId, status }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null) {
      return; // row gone; nothing to do
    }
    await ctx.db.patch(outboxId, { status });
    // Drain the next queued send on BOTH terminal statuses. `drainNextQueued` is
    // idempotent and isChatBusy-guarded, so this is safe in every ordering:
    //   - failed: the turn never streamed → chat idle → drains now.
    //   - sent, NORMAL order (before finalize): the assistant message is streaming
    //     → still busy → no-op; stream.finalize drains later.
    //   - sent, RACE order (a very fast turn finalized BEFORE this `sent` commit):
    //     finalize's own drain saw the outbox still `pending` and no-opped, so THIS
    //     call is the one that runs — without it the queue stalls forever.
    await drainNextQueued(ctx, row.chatId);
  },
});

// User-facing message shown when a turn could NOT be dispatched. FR (the app is
// mono-lingual; the message `error` field already carries free-text). Each ends
// with a short non-secret `(réf. …)` so a user has something concrete to tell
// their admin and the admin a key to grep traces/logs by — no gateway detail,
// token, or PHI ever crosses into this user-visible string.
const DISPATCH_FAILURE_MESSAGE: Record<string, string> = {
  not_configured:
    "Le service de chat n’est pas encore configuré. Contactez votre administrateur. (réf. bridge-config)",
  no_agent:
    "Aucun agent ne vous est assigné. Contactez votre administrateur pour qu’il vous en attribue un. (réf. no-agent)",
  agent_restricted:
    "Cet agent ne vous est plus disponible : votre accès aux agents a été modifié. Démarrez un nouveau chat avec un agent disponible. (réf. agent-restricted)",
  send_failed:
    "Le service de chat est momentanément indisponible. Réessayez ; si le problème persiste, contactez votre administrateur. (réf. bridge)",
};

// A FINER, attachment-scoped user message keyed by the curated errorCode, when the
// generic `send_failed` reason has one. Same discipline: non-secret, no gateway
// detail/PHI, ends with a short `(réf. …)`. Lets the user know it's the FILE (and
// that text-only or a smaller file works) instead of a blanket "try again".
const CODE_FAILURE_MESSAGE: Record<string, string> = {
  ATTACHMENT_TOO_LARGE:
    "La pièce jointe est trop volumineuse pour cet agent. Réessayez avec un fichier plus petit, ou envoyez votre message sans la pièce jointe. (réf. attach-size)",
  ATTACHMENT_REJECTED:
    "La pièce jointe n’a pas pu être traitée par le service. Réessayez avec un fichier plus petit, ou envoyez votre message sans la pièce jointe. (réf. attach-parse)",
};

// Terminal FAILURE transition for a dispatch, in ONE transaction: mark the outbox
// row failed AND surface the failure to the user as an assistant `error` turn (the
// frontend's RunStatus renders status:"error" + the `error` text). Before this, a
// dispatch that never reached/was-refused-by the bridge left the user staring at
// their own message with no reply and no signal — the silent failure we are
// killing. Idempotent + retry-safe: an action may re-run after a partial commit,
// so the whole patch+insert is gated on the row still being `pending` inside the
// transaction — a second run sees `failed` and inserts no duplicate bubble.
export const failDispatch = internalMutation({
  args: {
    outboxId: v.id("outbox"),
    reason: v.union(
      v.literal("not_configured"),
      v.literal("no_agent"),
      v.literal("agent_restricted"),
      v.literal("send_failed"),
    ),
    // The curated non-PHI gateway code (when known) — lets us pick a finer,
    // attachment-scoped user message than the generic reason.
    errorCode: v.optional(v.string()),
  },
  handler: async (ctx, { outboxId, reason, errorCode }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null || row.status !== "pending") {
      return; // already terminal (or gone) — never double-fire
    }
    await ctx.db.patch(outboxId, { status: "failed" });

    // Resilient to a chat deleted mid-turn: no chat -> nothing to render.
    const chat = await ctx.db.get(row.chatId);
    if (chat === null) return;
    const now = Date.now();
    await ctx.db.insert("messages", {
      chatId: row.chatId,
      userId: row.userId,
      role: "assistant",
      status: "error",
      text: "",
      error:
        (errorCode ? CODE_FAILURE_MESSAGE[errorCode] : undefined) ??
        DISPATCH_FAILURE_MESSAGE[reason] ??
        DISPATCH_FAILURE_MESSAGE.send_failed,
      // Keep the STABLE code too (non-PHI) so /api/v1/diagnose can classify the
      // failure precisely (e.g. ATTACHMENT_TOO_LARGE) instead of seeing the
      // localized `error` phrase normalize to "unknown".
      ...(errorCode ? { errorCode } : {}),
      updatedAt: now,
    });
    // Keep the chat sorted-to-top so the failed turn is visible in the sidebar.
    await ctx.db.patch(row.chatId, { updatedAt: now });

    // L2: a DOCUMENTARY fetch whose dispatch failed BEFORE stream.finalize would
    // otherwise leave the hidden chat's pendingFetch set forever -> the owner is
    // locked out of every future document fetch (fetch_in_flight). Release it here.
    // Best-effort (wrapped): an L2-feature error must never roll back the core fail
    // path (mirrors correlateDocumentaryFetch's best-effort shape in stream.finalize).
    if (chat.kind === "documentary" && chat.pendingFetch) {
      try {
        await failDocumentaryFetchForChat(ctx, chat);
      } catch (e) {
        console.error(
          "[docfetch] release on failed dispatch:",
          (e as Error)?.message ?? e,
        );
      }
    }

    // A failed dispatch is a turn-end: the chat is now idle, so drain the next
    // QUEUED send (mirrors markOutbox + finalize; drainNextQueued is documented as
    // safe on every turn-end path). BARE (no try/catch): if it throws, the whole
    // atomic mutation rolls back and the action's retry re-runs cleanly (the
    // status!=="pending" guard only short-circuits already-COMMITTED runs).
    await drainNextQueued(ctx, row.chatId);
  },
});

// Resolve routing for an outbox row's owner: the OpenClaw chat id (non-secret
// thread id) PLUS the resolved instance/agent target from the valves. The
// bridge maps instanceName -> token/deviceIdentity from its env; only names
// cross this boundary, never secrets.
export const getChatRouting = internalQuery({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    // MULTI-AGENT per-turn router: the agent this turn is addressed to (absent = the
    // chat's primary, the unchanged single-agent path).
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, userId, routedAgent }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      return null;
    }
    // Routing v2: resolve from the CHAT's binding (∈ userAgents), with the
    // stale-vs-deleted + default-fallback logic. The returned target is ALWAYS
    // authorized for this user (dispatch-time IDOR defense). `rebind` (when set)
    // is persisted by the dispatch action before sending. A per-turn `routedAgent`
    // resolves to THAT agent (authorized the same way, never rebinding the chat).
    const res = await resolveTargetForTurn(ctx, chat, userId, routedAgent ?? null);
    // Model M: resolve the routed instance's OWN bridge endpoint + per-instance
    // NON-secret config. Look up the instance row by NAME (the same first()
    // duplicate-name resilience as routing); when there is no target (no_agent) the
    // instance is null → resolveBridgeUrlForDispatch falls back to env BRIDGE_URL and
    // the config resolves to defaults (the dispatch fails no_agent before POSTing anyway).
    const target = res.target;
    const instance =
      target !== null
        ? await ctx.db
            .query("instances")
            .withIndex("by_name", (q) => q.eq("name", target.instanceName))
            .first()
        : null;
    // Env fallback for a bridgeUrl-less instance is SAFE only for the sole/served
    // instance (else a chat would be POSTed to a different instance's gateway). A
    // cheap take(2) decides "sole" without a full count.
    const someInstances = await ctx.db.query("instances").take(2);
    const isSole = someInstances.length <= 1;
    return {
      // On a REBIND (unbound/legacy chat, or the bound agent was revoked/deleted)
      // the stored openclawChatId belongs to the OLD agent's provider conversation
      // — sending it with the NEW target would resume/reset the wrong agent's
      // session. Start the new agent fresh (the bridge falls back to the Convex
      // chatId as the routing-id segment). Persisted to null by bindChatTarget.
      // MULTI-AGENT: a per-turn chat keys on its epoch `routingSegment` (changed only
      // on an agent switch by beginTurnRouting) so the bridge re-keys — hence rehydrates
      // — exactly on a switch, and stays warm within a same-agent run. ONLY for an actual
      // routed send (`routedAgent` present): a no-agent call (dispatchPatch/Reset/compact)
      // resolves to the chat's binding/default, so it must NOT inherit the last routed
      // turn's segment (codex P2 — that targeted the primary agent on another agent's
      // session) and keeps the legacy session id.
      openclawChatId:
        chat.perTurnRouting && routedAgent
          ? (chat.routingSegment ?? null)
          : res.rebind
            ? null
            : (chat.openclawChatId ?? null),
      target: res.target, // null => no agent assigned (failReason no_agent)
      rebind: res.rebind,
      failReason: res.failReason,
      // The user's per-chat OpenClaw knob intent (reasoning/model). The bridge
      // re-applies these via sessions.patch before each turn so they survive a
      // session reset. Non-secret labels only.
      sessionSettings: chat.sessionSettings ?? null,
      // Per-instance bridge URL (Model M) + NON-secret config (hot, in-band).
      // Scoped fallback: a bridgeUrl-less instance only inherits env BRIDGE_URL when
      // it is the sole/served instance, never cross-attributed (see bridgeRouting).
      bridgeUrl: resolveBridgeUrlForDispatch(instance, {
        instanceName: target?.instanceName ?? null,
        served: process.env.BRIDGE_INSTANCE_NAME ?? null,
        isSole,
      }),
      // `config` is the RESOLVED (defaults-filled) view for Convex's OWN inbound
      // transport decision (classifyAttachment). `configOverrides` is the RAW stored
      // partial sent to the bridge — only fields the admin explicitly set, so an
      // UNSET field lets the bridge keep its OWN env default (D-F-b) instead of being
      // shadowed by a Convex default on every /send (which would force e.g. an
      // env-configured shared-fs/off bridge back to gateway-http).
      config: resolveInstanceConfig(instance?.config),
      // What the bridge receives as `body.config`: the raw transport overrides (partial)
      // PLUS the RESOLVED bridge-applied prompt injections (the bridge can't resolve them).
      // A DOCUMENTARY fetch is stateless ("resolve these refs -> deliver these files");
      // attachDocuments rotates openclawChatId for a fresh GATEWAY session, but the bridge
      // also REHYDRATES by chatId — it would re-prepend this hidden chat's PRIOR fetch turns
      // and defeat the clean-session guarantee (re-injecting old refs -> still not_found).
      // Force rehydration OFF for documentary dispatches, keeping the other overrides intact.
      // MULTI-AGENT: force rehydration ON for a per-turn chat so a freshly-routed agent
      // (cold session from the epoch segment) is re-grounded with the FULL thread; the
      // bridge's own fresh-session gate then SKIPS it on a warm same-agent turn.
      configOverrides:
        chat.kind === "documentary"
          ? { ...bridgeDispatchConfig(instance?.config), rehydration: false }
          : chat.perTurnRouting && routedAgent
            ? { ...bridgeDispatchConfig(instance?.config), rehydration: true }
            : bridgeDispatchConfig(instance?.config),
    };
  },
});

// Per-chat INBOUND attachment policy for the COMPOSER's upfront size gate. The
// inline cap (maxInboundBytes, from getBridgeAvailability) bounds base64 files that
// ride the WS frame; but a TOOL-READ file on a shared-fs instance rides BY
// REFERENCE (the bridge streams it — any size), so the composer must use the much
// larger shared-fs cap for those. This resolves the chat's ROUTED instance (same as
// dispatch) and returns its inbound transport + shared-fs byte cap. A hint only —
// the server (dispatch + bridge guard) still enforces; failing open is safe.
export const getChatInboundPolicy = query({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ inboundMediaMode: string; sharedFsMaxBytes: number } | null> => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    // Ownership scope (IDOR): this query must not reveal the existence/routing/media
    // config of another user's chat. Fail closed (return null = composer uses the
    // default inline cap) for both a missing chat AND one the caller does not own.
    if (chat === null || chat.userId !== userId) return null;
    const res = await resolveTargetForChat(ctx, chat, userId);
    const instanceName = res.target?.instanceName ?? null;
    const instance = instanceName
      ? await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", instanceName))
          .first()
      : null;
    const cfg = resolveInstanceConfig(instance?.config);
    return {
      inboundMediaMode: cfg.inboundMediaMode,
      sharedFsMaxBytes: cfg.mediaMaxMb * 1024 * 1024,
    };
  },
});

// Admin-gated resolution for the shared-fs "Valider" action: the routed instance's
// bridge URL + the modes (which legs to check). Auth is BRIDGE_CONFIG_WRITE (same
// admin gate as the config editor) — propagated from the calling action's identity.
export const validateMediaTargetInternal = internalQuery({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }) => {
    await requirePermission(ctx, PERMISSIONS.BRIDGE_CONFIG_WRITE);
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    const cfg = resolveInstanceConfig(instance?.config);
    // SAME scoped fallback as dispatch (resolveBridgeUrlForDispatch): a bridgeUrl-less
    // instance only inherits env BRIDGE_URL when it is the sole/served instance.
    // Otherwise "Valider" would round-trip a DIFFERENT instance's bridge and report
    // its paths as OK while this instance's real sends fail not_configured.
    const someInstances = await ctx.db.query("instances").take(2);
    return {
      bridgeUrl:
        resolveBridgeUrlForDispatch(instance, {
          instanceName,
          served: process.env.BRIDGE_INSTANCE_NAME ?? null,
          isSole: someInstances.length <= 1,
        }) ?? null,
      inboundMediaMode: cfg.inboundMediaMode,
      mediaMode: cfg.mediaMode,
    };
  },
});

type DirCheck = { checked: boolean; ok: boolean; detail: string };
type ValidateMediaResult = {
  reachable: boolean;
  reason?: string;
  inbound?: DirCheck;
  outbound?: DirCheck;
};

// Shared-fs "Valider" button: POST the routed instance's modes to its bridge's
// `/validate-media`, which checks the BRIDGE's access to the shared dirs (no
// gateway fs API → bridge-side only; the agent-side mount is the operator's to
// match). Admin-gated via the internal query above. NEVER throws to the UI on a
// transport error — returns a structured {reachable:false}.
export const validateMediaPaths = action({
  // The modes come from the EDITOR (the unsaved form), NOT the stored config, so an
  // operator can verify the bridge actually has its shared dirs BEFORE saving — and
  // never persist a config that turns out to be non-functional (a missing/wrong
  // OPENCLAW_MEDIA_OUTBOUND_DIR mount). The bridgeUrl is still resolved from the
  // instance (admin-gated). An invalid mode value simply reads as "not shared-fs".
  args: {
    instanceName: v.string(),
    inboundMediaMode: v.string(),
    mediaMode: v.string(),
  },
  handler: async (
    ctx,
    { instanceName, inboundMediaMode, mediaMode },
  ): Promise<ValidateMediaResult> => {
    const target = await ctx.runQuery(
      internal.bridge.validateMediaTargetInternal,
      { instanceName },
    );
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!target.bridgeUrl || !sharedSecret) {
      return { reachable: false, reason: "not_configured" };
    }
    try {
      const res = await fetch(
        `${target.bridgeUrl.replace(/\/$/, "")}/validate-media`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: sharedSecret,
          },
          body: JSON.stringify({ instanceName, inboundMediaMode, mediaMode }),
        },
      );
      if (!res.ok) {
        return { reachable: true, reason: `http_${res.status}` };
      }
      const data = (await res.json()) as {
        inbound?: DirCheck;
        outbound?: DirCheck;
      };
      return { reachable: true, inbound: data.inbound, outbound: data.outbound };
    } catch {
      return { reachable: false, reason: "unreachable" };
    }
  },
});

// Reconstruct the OpenClaw `thread_id` (== gateway session key) for a chat, so the
// trace-enrichment route can find OpenClaw's OWN Opik traces for it (they're tagged
// with this exact key). Mirrors the bridge's buildSessionKey input EXACTLY:
// `buildSessionKey(openclawChatId ?? chatId, agentId, canonical)` — same rebind +
// fallback rules as getChatRouting. Returns null when the chat is gone or has no
// resolvable target. No-auth internal (called from the key-gated httpAction).
export const openclawThreadForChat = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    let chat: Doc<"chats"> | null = null;
    try {
      chat = await ctx.db.get(chatId as Id<"chats">);
    } catch {
      return null; // not a valid chat id
    }
    if (chat === null) return null;
    const res = await resolveTargetForChat(ctx, chat, chat.userId);
    if (res.target === null) return null;
    // Same segment the bridge keys on (session.ts: `openclawChatId ?? chatId`):
    // the provider conversation id when one is bound, else the Convex chatId. On a
    // rebind the stored id belongs to the OLD agent, so fall back to the chatId.
    let segment = chatId;
    if (res.rebind === null && chat.openclawChatId) {
      segment = chat.openclawChatId;
    }
    return buildOpenClawThreadId({
      agentId: res.target.agentId,
      canonical: res.target.canonical,
      chatId: segment,
    });
  },
});

// Persist a chat's resolved binding (legacy/unbound chat resolved to default, or
// a re-bind after the bound agent was deleted on the gateway). Called by the
// dispatch action so the NEXT turn resolves straight to the binding (a stable
// sessionKey). Idempotent; resilient to a chat deleted mid-turn.
export const bindChatTarget = internalMutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { chatId, instanceName, agentId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    if (chat.instanceName === instanceName && chat.agentId === agentId) return;
    // Rebinding to a different agent: DROP the stale provider conversation id (it
    // belonged to the old agent) so the next turn starts the new agent fresh on
    // the Convex chatId instead of resuming the old agent's thread (Codex P1).
    await ctx.db.patch(chatId, {
      instanceName,
      agentId,
      openclawChatId: undefined,
    });
  },
});

// MULTI-AGENT per-turn router: persist the turn's routing BEFORE getChatRouting reads it.
// Flips the chat to `perTurnRouting` and tracks the last-routed agent. The gateway session
// is re-keyed ONLY on an agent SWITCH (epoch-on-switch): a fresh `routingSegment` makes the
// bridge's fresh-session gate rehydrate the newly-routed agent with the FULL thread, while a
// same-agent run keeps the segment (warm — no re-shipping the whole history every turn).
export const beginTurnRouting = internalMutation({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    routedAgent: v.object({ instanceName: v.string(), agentId: v.string() }),
    turnId: v.id("messages"),
  },
  handler: async (ctx, { chatId, userId, routedAgent, turnId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    // AUTHORIZE before persisting ANY turn state (codex P2): a forged routedAgent — or one
    // revoked/deleted between sendMessage and dispatch — must NOT reconfigure the chat.
    // Otherwise the dispatch fails agent_restricted/no_agent but the chat is left with an
    // invalid per-turn session segment that corrupts every later routing. Resolve the exact
    // same way the dispatch does; only an entitled, present agent reconfigures the chat.
    const res = await resolveTargetForTurn(ctx, chat, userId, routedAgent);
    if (res.target === null) return;
    // A turn explicitly routed to the chat's OWN primary agent, on a chat that is not yet
    // multi-agent, is just a normal single-agent turn — do NOT flip perTurnRouting or
    // re-key (codex P2): that would needlessly fork the warm gateway session and force a
    // rehydration when the single-agent flow should simply continue.
    const isToPrimary =
      routedAgent.agentId === chat.agentId &&
      routedAgent.instanceName === chat.instanceName;
    if (!chat.perTurnRouting && isToPrimary) return;
    // Baseline for "did the agent change?": the previous turn's agent, or — on the first
    // per-turn turn — the chat's primary binding.
    const prevAgent = chat.lastRoutedAgentId ?? chat.agentId ?? null;
    const prevInstance =
      chat.lastRoutedInstanceName ?? chat.instanceName ?? null;
    const isSwitch =
      routedAgent.agentId !== prevAgent ||
      routedAgent.instanceName !== prevInstance ||
      !chat.routingSegment;
    await ctx.db.patch(chatId, {
      perTurnRouting: true,
      lastRoutedInstanceName: routedAgent.instanceName,
      lastRoutedAgentId: routedAgent.agentId,
      ...(isSwitch ? { routingSegment: `turn:${turnId}` } : {}),
    });
  },
});

export const dispatch = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.runQuery(internal.bridge.getOutbox, { outboxId });
    if (row === null) {
      return; // nothing to dispatch
    }
    if (row.status !== "pending") {
      return; // already handled (guards duplicate schedules)
    }

    // The shared secret is deployment-wide env (Convex→bridge auth, shared across
    // all per-instance bridges). The bridge URL is now PER-INSTANCE (resolved from
    // routing below), so it is checked after we know the target. We do NOT throw on
    // a misconfig — a thrown action is retried by Convex and would re-POST/re-fail
    // without the operator fixing anything; the durable "failed" row is the signal.
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) {
      console.error("bridge.dispatch: BRIDGE_SHARED_SECRET not configured");
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId,
        reason: "not_configured",
      });
      await traceDispatch(ctx, {
        outboxId,
        chatId: row.chatId,
        dispatchStatus: "failed",
        reason: "not_configured",
        errorCode: "NOT_CONFIGURED",
      });
      return;
    }

    // MULTI-AGENT per-turn router: persist this turn's routing (switch detection + the
    // epoch session segment) BEFORE getChatRouting reads the chat. Only when the turn
    // carries an explicit agent (a deliberate per-turn choice); a normal send leaves the
    // chat single-agent and skips this entirely.
    if (row.routedAgent && row.messageId) {
      await ctx.runMutation(internal.bridge.beginTurnRouting, {
        chatId: row.chatId as Id<"chats">,
        userId: row.userId as Id<"users">,
        routedAgent: row.routedAgent,
        turnId: row.messageId as Id<"messages">,
      });
    }

    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId: row.chatId as Id<"chats">,
      userId: row.userId as Id<"users">,
      ...(row.routedAgent ? { routedAgent: row.routedAgent } : {}),
    });

    // Chat deleted mid-turn -> nothing to dispatch / render.
    if (!routing) {
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId,
        reason: "send_failed",
      });
      return;
    }

    // No routable target. Distinguish WHY: `agent_restricted` = the chat is bound
    // to an agent the user is no longer entitled to (READ-ONLY enforcement — never
    // a silent re-route); otherwise `no_agent` = the user has no usable agent. Both
    // mark the turn failed with a clear, actionable message instead of dispatching
    // to a wrong/absent target.
    if (routing.target === null) {
      const reason =
        routing.failReason === "agent_restricted"
          ? "agent_restricted"
          : "no_agent";
      console.error(`bridge.dispatch: ${reason} for user`);
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId,
        reason,
      });
      await traceDispatch(ctx, {
        outboxId,
        chatId: row.chatId,
        dispatchStatus: "failed",
        reason,
        errorCode: reason === "agent_restricted" ? "AGENT_RESTRICTED" : "NO_AGENT",
      });
      return;
    }

    // Per-instance bridge endpoint (Model M). routing.bridgeUrl is the instance's
    // own bridgeUrl, else the env BRIDGE_URL fallback (single-bridge path). Unset
    // both → not_configured (durable failed row, not a throw/retry).
    const bridgeUrl = routing.bridgeUrl;
    if (!bridgeUrl) {
      console.error(
        "bridge.dispatch: no bridgeUrl for the routed instance (set instances.bridgeUrl or BRIDGE_URL)",
      );
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId,
        reason: "not_configured",
      });
      await traceDispatch(ctx, {
        outboxId,
        chatId: row.chatId,
        dispatchStatus: "failed",
        reason: "not_configured",
        errorCode: "NOT_CONFIGURED",
      });
      return;
    }

    // Persist a re-bind (legacy/unbound chat resolved to the default, or the bound
    // agent was deleted on the gateway) BEFORE sending, so the chat's stored
    // binding matches the agent we dispatch to and the next turn is stable.
    if (routing.rebind) {
      await ctx.runMutation(internal.bridge.bindChatTarget, {
        chatId: row.chatId as Id<"chats">,
        instanceName: routing.rebind.instanceName,
        agentId: routing.rebind.agentId,
      });
    }

    // Resolve INBOUND attachments (storageId -> bytes -> base64) into OpenClaw's
    // chat.send.attachment shape. Inbound rides the JSON WS, so it MUST be inline
    // base64 (the gateway offloads it to media://inbound); the whole frame is
    // bounded by the gateway's maxPayload. An attachment over that ceiling CANNOT
    // be delivered (its base64 would overflow the WS frame and CLOSE the gateway
    // connection) — so we FAIL the send with a clear ATTACHMENT_TOO_LARGE rather
    // than SILENTLY dropping it (the prod bug: a 20.9 MiB pptx was skipped here and
    // the text went out fileless, no error). The cap is DERIVED from the gateway-
    // announced maxPayload (read from bridgeHealth), never a hardcoded size; when it
    // is not yet known the composer already capped upfront and the bridge frame
    // guard is the backstop, so we proceed.
    // The EFFECTIVE inbound frame (the bridge publishes min(gateway maxPayload, its
    // own HTTP body cap), envelope included). We check the AGGREGATE base64 size of
    // ALL attachments + the message against it — maxPayload bounds the whole
    // chat.send frame, NOT each file, so N files individually under the per-file cap
    // can still overflow it together (matches the bridge guard).
    const reportedMaxPayload = await ctx.runQuery(
      internal.bridgeHealth.maxPayloadInternal,
      // Per routed instance (Model M): the cap is derived from THIS instance's
      // gateway frame limit, not a global one.
      { instanceName: routing.target.instanceName },
    );
    // CONSERVATIVE fallback when the bridge has NOT reported a maxPayload yet — an
    // OLD bridge image in a mixed deploy (Convex/front shipped first), or a cold
    // poll. We must NEVER skip the size check: an old bridge lacks the frame guard,
    // so a 20+ MiB attachment POSTed to it would close the gateway connection (the
    // very bug this fixes). The fallback is OpenClaw's OWN default frame limit (the
    // value every 2026.x hello-ok reports) — it auto-corrects to the real value once
    // the new bridge publishes it, so it is derived knowledge, not a magic number.
    const maxPayload =
      typeof reportedMaxPayload === "number"
        ? reportedMaxPayload
        : DEFAULT_GATEWAY_MAX_PAYLOAD;
    const resolvedAttachments: Array<{
      type: string;
      mimeType: string;
      fileName: string;
      content: string;
    }> = [];
    // Phase 3 (shared-fs): TOOL-READ files in shared-fs mode ride BY REFERENCE — a
    // short-lived Convex getUrl the bridge STREAMS to a shared volume (no base64, no
    // frame ceiling → videos/audio of any size). The storageId is server-minted from
    // the outbox (never client-supplied — IDOR lesson). References are NOT counted
    // toward the maxPayload frame guard (only inline base64 is).
    const referenceAttachments: Array<{
      url: string;
      mimeType: string;
      fileName: string;
    }> = [];
    const inboundMediaMode = routing.config.inboundMediaMode;
    let attachmentTooLarge = false;
    // We size the frame by the SUM of the attachments' base64 only. The message
    // text + JSON structure ride the fixed envelope reserved inside base64FitsFrame
    // (FRAME_ENVELOPE_OVERHEAD_BYTES) — NOT counted here. This keeps the composer's
    // per-file cap (which reserves the same envelope) consistent with this check, so
    // a file at the advertised cap PLUS a normal prompt is never accepted-then-
    // rejected (the message is byte/encoding-agnostic to the budget), and matches
    // the bridge frame guard. A pathological prompt larger than the envelope is the
    // only residual, backstopped by the bridge body cap (413) + the gateway.
    let base64Total = 0;
    for (const a of row.attachments ?? []) {
      try {
        // Model-native (Vision) → inline base64 (size-bounded). Tool-read in
        // shared-fs mode → reference (streamed by the bridge, any size).
        if (
          classifyAttachment({ mimeType: a.mimeType, inboundMediaMode }) ===
          "reference"
        ) {
          const url = await ctx.storage.getUrl(a.storageId);
          if (url === null) continue; // blob gone — skip (never fail the whole turn)
          referenceAttachments.push({
            url,
            mimeType: a.mimeType || "application/octet-stream",
            fileName: a.filename,
          });
          continue; // NOT base64, NOT counted toward the frame guard
        }
        const blob = await ctx.storage.get(a.storageId);
        if (blob === null) continue;
        const next = base64Total + base64ByteLength(blob.size);
        if (!base64FitsFrame(next, maxPayload)) {
          console.error(
            `bridge.dispatch: inbound attachment frame too large (${next} base64 bytes > maxPayload ${maxPayload}) — failing send (not dropping)`,
          );
          attachmentTooLarge = true;
          break;
        }
        base64Total = next;
        resolvedAttachments.push({
          type: "file",
          mimeType: a.mimeType || blob.type || "application/octet-stream",
          fileName: a.filename,
          content: arrayBufferToBase64(await blob.arrayBuffer()),
        });
      } catch (err) {
        console.error("bridge.dispatch: attachment resolve failed:", err);
      }
    }

    // We mark the row terminal (sent/failed) and deliberately do NOT re-throw on
    // a transient bridge error. Re-throwing triggers Convex action retries,
    // which would re-POST after we already recorded "failed" -> duplicate sends.
    // The bridge MUST additionally dedupe on `clientMessageId` (it builds an
    // OpenClaw idempotencyKey from it) so even an at-least-once delivery here is
    // safe; retry/reconciliation is the operator's explicit action on a failed
    // row, not an implicit re-fire.
    let ok = false;
    // Curated root-cause code for a failed send (non-PHI). From the bridge's 502
    // body when reachable; a fixed local code when the bridge can't be reached.
    let errorCode: string | undefined;
    if (attachmentTooLarge) {
      // Over-cap attachment: do NOT POST it (its base64 would overflow the WS
      // frame and close the gateway connection). Fail with a clear, file-specific
      // code so the user sees "trop volumineuse" — never a silent text-only send.
      errorCode = "ATTACHMENT_TOO_LARGE";
    } else {
      try {
        const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Shared secret authenticates Convex -> bridge (server-to-server).
            Authorization: sharedSecret,
          },
          body: JSON.stringify({
            chatId: row.chatId,
            openclawChatId: routing.openclawChatId,
            // Resolved valve target (non-secret names): the bridge maps
            // instanceName -> gateway token/device identity from its env.
            instanceName: routing.target.instanceName,
            agentId: routing.target.agentId,
            canonical: routing.target.canonical,
            text: row.text,
            clientMessageId: row.clientMessageId,
            // The user message id for THIS turn — the bridge excludes it when it
            // fetches prior history for session re-hydration (so the current
            // message is not duplicated into the injected context).
            messageId: row.messageId ?? null,
            // Per-chat knob intent: the bridge re-applies these (sessions.patch)
            // before chat.send so a reset session keeps the user's reasoning/model.
            sessionSettings: routing.sessionSettings,
            attachments: resolvedAttachments,
            // Tool-read files streamed by reference (shared-fs). An old bridge
            // ignores this unknown field (those files simply won't reach the agent
            // until the bridge is updated — shared-fs is opt-in, default inline).
            referenceAttachments,
            // Per-instance NON-secret bridge config, hot-consumed in-band (media
            // mode + caps + rehydration). ONLY the admin's explicit overrides — an
            // unset field is absent so the bridge keeps its own env default (never
            // shadowed). An old bridge ignores this unknown field.
            config: routing.configOverrides,
          }),
        });
        ok = response.ok;
        if (!ok) {
          console.error(`bridge POST /send -> HTTP ${response.status}`);
          // Parse the curated cause from the 502 body (tolerant of old/new bridge).
          errorCode = await readErrorCode(response);
        }
      } catch (err) {
        console.error("bridge POST /send failed:", err);
        ok = false;
        // Network-level: the request never reached the bridge (down / wrong URL).
        errorCode = "BRIDGE_UNREACHABLE";
      }
    }

    if (ok) {
      await ctx.runMutation(internal.bridge.markOutbox, {
        outboxId,
        status: "sent",
      });
    } else {
      // The bridge accepted the POST shape but the gateway refused the turn
      // (502): surface it to the user instead of leaving the message unanswered.
      // Pass the curated errorCode so an attachment refusal shows a file-specific
      // message ("trop volumineuse" / "n'a pas pu être traitée"), not a blanket one.
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId,
        reason: "send_failed",
        errorCode,
      });
    }
    await traceDispatch(ctx, {
      outboxId,
      chatId: row.chatId,
      dispatchStatus: ok ? "sent" : "failed",
      // Non-secret valve target names (instanceName -> token mapping is the
      // bridge's job; only names cross this boundary).
      target: {
        instanceName: routing.target.instanceName,
        agentId: routing.target.agentId,
      },
      ...(ok ? {} : { reason: "send_failed", errorCode }),
    });
  },
});

/**
 * Immediate write-back of a per-chat OpenClaw knob (reasoning level / model).
 * Scheduled by `chats.setSessionKnob` after it persists `sessionSettings`. POSTs
 * the current intent to the bridge's `POST /patch`, which calls `sessions.patch`
 * then re-describes + reports the CONFIRMED live `sessionMeta` back (so the chip
 * is honest, never optimistic). Best-effort: a missing config / unrouted user /
 * bridge error is logged and traced but never throws (a thrown action is retried
 * by Convex). The chip simply does not move if the patch did not land.
 */
export const dispatchPatch = internalAction({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    // No `clears` arg (P2-4): unsets are PERSISTED in sessionSettings.clears by
    // chats.setSessionKnob, so this action reads ONE source of truth (the same
    // intent the per-turn /send re-apply consumes) — an unset lost to a bridge
    // outage is repaired on the next turn exactly like a set.
  },
  handler: async (ctx, { chatId, userId }) => {
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) {
      console.error("bridge.dispatchPatch: BRIDGE_SHARED_SECRET not configured");
      return;
    }

    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId,
      userId,
    });
    if (!routing || routing.target === null) {
      console.error("bridge.dispatchPatch: user is unrouted (no valve target)");
      return;
    }
    // Per-instance bridge endpoint (Model M), else env BRIDGE_URL fallback.
    const bridgeUrl = routing.bridgeUrl;
    if (!bridgeUrl) {
      console.error("bridge.dispatchPatch: no bridgeUrl for the routed instance");
      return;
    }
    const settings = routing.sessionSettings;
    const clearList = settings?.clears ?? [];
    const hasOverride =
      settings != null &&
      (settings.thinkingLevel != null ||
        settings.model != null ||
        settings.fastMode != null ||
        clearList.length > 0);
    if (!hasOverride) {
      return; // nothing to apply, nothing to clear
    }

    let ok = false;
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/patch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          chatId,
          openclawChatId: routing.openclawChatId,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
          canonical: routing.target.canonical,
          // The COMPLETE persisted intent (sets + clears) — the exact object the
          // per-turn /send re-apply consumes; ONE bridge call both clears the
          // removed knobs and re-asserts the rest. Single source of truth (P2-4).
          sessionSettings: settings,
        }),
      });
      ok = response.ok;
      if (!ok) {
        console.error(`bridge POST /patch -> HTTP ${response.status}`);
      }
    } catch (err) {
      console.error("bridge POST /patch failed:", err);
      ok = false;
    }

    // Trace the knob write-back (metadata only — knob NAMES are non-secret; never
    // tokens). Wrapped so a trace failure can never affect the outcome.
    try {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "openclaw.patch",
        direction: "outbound",
        principalType: "user",
        principalId: userId,
        chatId,
        correlationId: `${chatId}:patch`,
        meta: JSON.stringify({
          patchStatus: ok ? "sent" : "failed",
          thinkingLevel: settings?.thinkingLevel,
          model: settings?.model,
          fastMode: settings?.fastMode,
          clears: clearList,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
        }),
      });
    } catch {
      // best-effort
    }
  },
});

/**
 * Realign the OpenClaw session after a message DELETE: POST `/reset` so the
 * gateway flips `systemSent=false` and the next turn re-hydrates from the
 * (now-truncated) Convex state. Scheduled by `messages.deleteMessage`.
 *
 * If `regenerateOutboxId` is provided (assistant-delete -> regenerate), the
 * re-dispatch is chained ONLY AFTER a SUCCESSFUL reset — running it on a stale
 * (un-reset) session would re-answer with the deleted turn still in context.
 * Best-effort: a missing config / unrouted user / bridge error is logged and
 * traced but never throws (a thrown action would be retried by Convex).
 */
export const dispatchReset = internalAction({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    regenerateOutboxId: v.optional(v.id("outbox")),
    // MULTI-AGENT: the agent the regenerated turn was addressed to, so the RESET targets
    // that agent's per-turn session (else it would reset the chat's primary session while
    // the regenerate re-dispatches to a different agent — codex P2).
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, userId, regenerateOutboxId, routedAgent }) => {
    // A regenerate (assistant-delete) builds a pending outbox row that ONLY this
    // action can drive. Every path that does NOT chain its dispatch must mark that
    // row terminal + surface the cause, else it stays pending and the user sees
    // NOTHING (the silent failure we forbid — reported live). A plain reset (no
    // regenerate) has nothing to surface.
    const failRegen = async (
      reason:
        | "not_configured"
        | "no_agent"
        | "agent_restricted"
        | "send_failed",
    ) => {
      if (regenerateOutboxId) {
        await ctx.runMutation(internal.bridge.failDispatch, {
          outboxId: regenerateOutboxId,
          reason,
        });
      }
    };

    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) {
      console.error("bridge.dispatchReset: BRIDGE_SHARED_SECRET not configured");
      await failRegen("not_configured");
      return;
    }
    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId,
      userId,
      ...(routedAgent ? { routedAgent } : {}),
    });
    if (!routing || routing.target === null) {
      // Same distinction as the normal dispatch: a chat whose agent the user is no
      // longer entitled to fails READ-ONLY (agent_restricted), not "no_agent".
      const reason =
        routing && routing.failReason === "agent_restricted"
          ? "agent_restricted"
          : "no_agent";
      console.error(`bridge.dispatchReset: ${reason} for user`);
      await failRegen(reason);
      return;
    }
    // Per-instance bridge endpoint (Model M), else env BRIDGE_URL fallback.
    const bridgeUrl = routing.bridgeUrl;
    if (!bridgeUrl) {
      console.error("bridge.dispatchReset: no bridgeUrl for the routed instance");
      await failRegen("not_configured");
      return;
    }

    let ok = false;
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          chatId,
          openclawChatId: routing.openclawChatId,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
          canonical: routing.target.canonical,
        }),
      });
      ok = response.ok;
      if (!ok) console.error(`bridge POST /reset -> HTTP ${response.status}`);
    } catch (err) {
      console.error("bridge POST /reset failed:", err);
      ok = false;
    }

    // Chain the regenerate ONLY after a clean reset (else a stale-session
    // regenerate would answer with the deleted context). If the reset FAILED,
    // surface it on the regenerate row instead of leaving it pending + silent.
    if (regenerateOutboxId) {
      if (ok) {
        await ctx.scheduler.runAfter(0, internal.bridge.dispatch, {
          outboxId: regenerateOutboxId,
        });
      } else {
        await failRegen("send_failed");
      }
    }

    try {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "openclaw.reset",
        direction: "outbound",
        principalType: "user",
        principalId: userId,
        chatId,
        correlationId: `${chatId}:reset`,
        meta: JSON.stringify({
          resetStatus: ok ? "sent" : "failed",
          regenerated: Boolean(regenerateOutboxId) && ok,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
        }),
      });
    } catch {
      // best-effort
    }
  },
});
