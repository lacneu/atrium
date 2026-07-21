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
import { chatAllowsInstance } from "./lib/ingestAuthz";
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
import { contentLocaleForInstance } from "./lib/serverLocale";
import { bridgeDispatchConfig, resolveInstanceConfig } from "./lib/instanceConfig";
import {
  effectiveTemplate,
  fillTemplate,
  resolveInjection,
} from "./lib/promptInjections";
import { composeQuotedText } from "./lib/quoteReply";
import { classifyAttachment } from "./lib/mediaTransport";
import {
  chatHasActivityBlockers,
  drainNextQueued,
  isChatBusy,
} from "./lib/outboxQueue";
import { failDocumentaryFetchForChat } from "./documentAttachments";
import { failSummarizeForChat } from "./chatSummaries";

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
    // GENERATION binding (codex P1, pass 9): the EFFECTIVE dispatch key
    // (dispatchKey ?? clientMessageId) the acking dispatch READ when it
    // started. The preempt re-park mints a fresh dispatchKey at its flip — a
    // first dispatch's ack arriving after the flip (>10s network straggler)
    // must not touch the re-queued row: it would flip it `sent` and the
    // scheduled re-dispatch would bail on the status guard, losing the
    // user's turn with its card already deleted. Optional: legacy/other
    // callers keep the unbound behavior.
    expectedClientMessageId: v.optional(v.string()),
  },
  handler: async (ctx, { outboxId, status, expectedClientMessageId }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null) {
      return; // row gone; nothing to do
    }
    if (
      expectedClientMessageId !== undefined &&
      (row.dispatchKey ?? row.clientMessageId) !== expectedClientMessageId
    ) {
      console.log(
        "bridge.markOutbox: stale ack for a re-keyed row — dropped",
      );
      return;
    }
    // PREEMPT-REPARK HOLD (preemptRepark.ts, codex P1): when the gateway kill
    // was ingested BEFORE this ack landed, the flagged finalize already took
    // over the row — stamped it and re-held it `pending` so window sends stay
    // parked behind it. This late `sent` flip would release that hold AND
    // drain a window send ahead of the held turn (FIFO inversion, a fresh
    // collision with the delivery). The dispatch this ack reports was
    // consumed by the kill: drop the flip; the scheduled reparkAfterPreempt
    // owns the row's next transition. Keyed on the TRANSIENT `preemptHold`
    // (cleared at the flip), NEVER the permanent bound stamp — the row's own
    // RE-dispatch later re-enters `pending` with the stamp still set, and its
    // ack must land or the chat blocks forever (codex P1, pass 4). A `failed`
    // write is dropped too (mirrors failDispatch, codex P2 pass 11): the hold
    // PROVES the send reached the gateway — a run started and was killed by
    // the delivery — so a transport "failure" is a lost response, and failing
    // the row would cancel the recovery.
    if (row.preemptHold === true && row.status === "pending") {
      return;
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

// Dispatch failures are surfaced as STABLE CODES (never a pre-rendered
// sentence): the code is stored in BOTH `error` and `errorCode`, and the UI
// translates it into the READER's language (runStatusView ERROR_CODE_LABEL) —
// the former hardcoded French sentences assumed a mono-lingual app and froze
// the language at write time. Non-PHI by construction.
const ATTACHMENT_FAILURE_CODES = new Set([
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_REJECTED",
]);

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
    // GENERATION binding (mirrors markOutbox — codex P1, pass 14): the
    // effective dispatch key (dispatchKey ?? clientMessageId) the failing
    // dispatch READ when it started. A late failure of the KILLED dispatch
    // (lost/slow HTTP response outliving the 10s hold) must not fail the
    // re-parked row the flip just re-queued — that would cancel the recovery
    // and paint a spurious error card on a turn whose card is already gone.
    expectedClientMessageId: v.optional(v.string()),
  },
  handler: async (ctx, { outboxId, reason, errorCode, expectedClientMessageId }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null || row.status !== "pending") {
      return; // already terminal (or gone) — never double-fire
    }
    if (
      expectedClientMessageId !== undefined &&
      (row.dispatchKey ?? row.clientMessageId) !== expectedClientMessageId
    ) {
      console.log(
        "bridge.failDispatch: stale failure for a re-keyed row — dropped",
      );
      return;
    }
    // PREEMPT-REPARK HOLD (preemptRepark.ts, codex P2): the hold existing
    // PROVES the send reached the gateway — a run started and was killed by
    // the delivery (that kill is what installed the hold). This "failure" is
    // the POST's response getting lost on the way back, not a failed send:
    // failing the row would cancel the recovery and paint a spurious error
    // card. The scheduled reparkAfterPreempt owns the row's next transition.
    if (row.preemptHold === true) {
      console.log(
        "bridge.failDispatch: row is preempt-held (send provably reached the gateway) — failure dropped",
      );
      return;
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
      // `error` carries the LOCALIZABLE code string (the stream_orphaned
      // pattern): the attachment codes get their file-specific headline, every
      // other failure the generic reason headline. `errorCode` PRESERVES the
      // finest CURATED code when one exists (BRIDGE_UNREACHABLE, GATEWAY_*,
      // NO_AGENT, ...) — the diagnose/chat-state remediation flows key on it
      // (codex P2: collapsing it to the reason lost the root cause).
      error:
        errorCode && ATTACHMENT_FAILURE_CODES.has(errorCode)
          ? errorCode
          : reason,
      errorCode: errorCode ?? reason,
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
    // Hybrid rehydration: same shape for a SUMMARIZE job whose dispatch failed —
    // release the lock + apply the failure backoff, or the user's summarize engine
    // stays wedged until the watchdog. Best-effort like the docfetch release.
    if (chat.kind === "summarizer" && chat.pendingSummarize) {
      try {
        await failSummarizeForChat(ctx, chat, "dispatch_error");
      } catch (e) {
        console.error(
          "[chatsum] release on failed dispatch:",
          (e as Error)?.message ?? e,
        );
      }
    }
    // Agent-file curation: same shape — release the pendingCurate lock + mark the
    // curation failed on a dispatch failure, else the curator chat stays wedged.
    if (chat.kind === "curator" && chat.pendingCurate) {
      try {
        await ctx.runMutation(internal.agentFileCuration.failCurationForChat, {
          chatId: chat._id,
          reason: "dispatch_error",
        });
      } catch (e) {
        console.error(
          "[curation] release on failed dispatch:",
          (e as Error)?.message ?? e,
        );
      }
    }
    // Document conversion: same shape — release the pendingConvert lock + fail the
    // rendition, else the converter chat stays wedged and the viewer spins forever.
    if (chat.kind === "converter" && chat.pendingConvert) {
      try {
        await ctx.runMutation(internal.fileRenditions.failRenditionForChat, {
          chatId: chat._id,
          reason: "dispatch_failed",
        });
      } catch (e) {
        console.error(
          "[convert] release on failed dispatch:",
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
    // TRUE only when this routed turn is an ACTUAL agent SWITCH (the routed agent
    // differs from the immediately-preceding routed turn's agent), computed by
    // beginTurnRouting (codex P2). It gates the bridge's `routedSwitch` config: a
    // same-agent routed FOLLOW-UP — even one whose bridge Session was rebuilt by a
    // restart (firstSendPending true) — must NOT be marked a switch, else it would
    // re-inject the whole history onto the still-warm gateway session (duplicate).
    routedSwitch: v.optional(v.boolean()),
    // The EPHEMERAL session segment for THIS dispatch (beginTurnRouting's returned
    // `segment`) — the openclawChatId / bridge session key. Passed explicitly because
    // an unconfirmed switch's segment is NOT persisted to the chat doc (atomic-on-
    // confirm); falls back to the chat's last-confirmed segment for callers that don't
    // run beginTurnRouting (dispatchReset/dispatchPatch).
    routingSegment: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { chatId, userId, routedAgent, routedSwitch, routingSegment },
  ) => {
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
    // The instance's CONTENT locale drives the language of DEFAULT injection
    // texts sent to the bridge (an admin override always wins as-is).
    const contentLocale = await contentLocaleForInstance(ctx, instance?.config);
    return {
      // On a REBIND (unbound/legacy chat, or the bound agent was revoked/deleted)
      // the stored openclawChatId belongs to the OLD agent's provider conversation
      // — sending it with the NEW target would resume/reset the wrong agent's
      // session. Start the new agent fresh (the bridge falls back to the Convex
      // chatId as the routing-id segment). Persisted to null by bindChatTarget.
      // MULTI-AGENT: a per-turn chat keys on the EPHEMERAL segment the dispatch passes
      // (beginTurnRouting's `segment` — a NEW one on a switch, else the last-confirmed),
      // so the bridge re-keys — hence rehydrates — exactly on a switch and stays warm
      // within a same-agent run. The segment is passed (not read from the chat doc)
      // because an UNCONFIRMED switch's segment is not persisted (atomic-on-confirm);
      // falls back to the chat's confirmed segment for callers that don't run
      // beginTurnRouting. ONLY for an actual routed send (`routedAgent` present): a
      // no-agent call (dispatchPatch/Reset/compact) keeps the legacy session id.
      openclawChatId:
        chat.perTurnRouting && routedAgent
          ? (routingSegment ?? chat.routingSegment ?? null)
          : res.rebind
            ? null
            : (chat.openclawChatId ?? null),
      // BRANCHED chat with its first-turn rehydration still pending: the
      // dispatch consumes the one-shot flag at the TRUE acceptance point (the
      // gateway ACK) — see consumeForkRehydration. OPENCLAW ONLY: an OpenClaw
      // ACK means chat.send accepted the prompt. A Hermes /send 200 is NOT a
      // delivery signal (the WS transport settles a prompt.submit failure as a
      // bridge-owned error and still ACKs), and Hermes freshness is decided
      // bridge-side (no stored session -> history carried) — so on Hermes the
      // flag is inert (routedSwitch is ignored there) and never needs
      // consuming.
      forkFresh:
        chat.forkPendingRehydration === true &&
        (instance?.kind ?? "openclaw") === "openclaw",
      // Provider-session reset epoch (see bindProviderChat): rides the /send
      // body so the turn's post-ACK session bind can prove no /reset ran
      // while it was in flight.
      providerResetCount: chat.providerResetCount ?? 0,
      target: res.target, // null => no agent assigned (failReason no_agent)
      rebind: res.rebind,
      failReason: res.failReason,
      // The user's per-chat OpenClaw knob intent (reasoning/model). The bridge
      // re-applies these via sessions.patch before each turn so they survive a
      // session reset. Non-secret labels only.
      sessionSettings: chat.sessionSettings ?? null,
      // QUOTE-REPLY: the effective per-instance preamble template (registry
      // entry `quote_reply`, admin-customizable/disable-able). The dispatch
      // fills {excerpt} when the outbox row carries one — resolved HERE so
      // dispatch needs no extra read and follows the instance content locale.
      quoteReplyTemplate: effectiveTemplate(
        "quote_reply",
        resolveInjection(
          "quote_reply",
          instance?.config?.promptInjections,
          contentLocale,
        ),
        contentLocale,
      ),
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
      // `rehydration:true` is forced for every per-turn routed dispatch (it ENABLES the
      // knob; the bridge's freshness gate decides whether to actually inject). The
      // DISTINCT `routedSwitch` flag is emitted ONLY on an ACTUAL agent SWITCH (codex
      // P2 — the caller passes `routedSwitch`, computed by beginTurnRouting). A
      // same-agent routed FOLLOW-UP must NOT carry routedSwitch: otherwise, after a
      // bridge restart rebuilds its Session (firstSendPending true), the bridge would
      // treat the still-warm gateway session as fresh and re-inject the whole history
      // (duplicate). `rehydration` stays the admin/env enable knob.
      // BRANCHED chat, first turn (chatFork): the fork's session key is brand
      // new, but the gateway auto-creates its row (systemSent truthy) during the
      // pre-describe sessions.patch — without an explicit re-key signal the
      // bridge misreads it as WARM and the fork's agent starts COLD (the same
      // trap the per-turn router hit). `routedSwitch` IS that re-key signal:
      // emit it while the one-shot forkPendingRehydration flag is set (the
      // dispatch consumes the flag at the gateway ACK). Deliberately NO
      // `rehydration: true` force on THIS single-agent path: the freshness
      // signal and the ENABLE knob stay separate, so the operator kill-switches
      // (admin rehydration:false, OPENCLAW_REHYDRATION=off) still win over a
      // fork's grounding — a fork on a rehydration-disabled instance starts
      // cold BY CONFIGURATION. (A multi-agent fork goes through the per-turn
      // branch above, which forces the knob for EVERY routed dispatch — the
      // router's own pre-existing contract, fork or not: context carry across
      // agent switches is unusable without it.)
      configOverrides:
        chat.kind === "documentary" ||
        chat.kind === "summarizer" ||
        chat.kind === "curator" ||
        chat.kind === "converter"
          ? { ...bridgeDispatchConfig(instance?.config, contentLocale), rehydration: false }
          : chat.perTurnRouting && routedAgent
            ? {
                ...bridgeDispatchConfig(instance?.config, contentLocale),
                rehydration: true,
                ...(routedSwitch || chat.forkPendingRehydration === true
                  ? { routedSwitch: true }
                  : {}),
              }
            : chat.forkPendingRehydration === true
              ? {
                  ...bridgeDispatchConfig(instance?.config, contentLocale),
                  routedSwitch: true,
                }
              : bridgeDispatchConfig(instance?.config, contentLocale),
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
/** Persist a provider-minted conversation id onto the chat (Hermes mints its
 *  session id lazily on turn 1; the bridge reports it here so later turns reuse
 *  it). Idempotent: only writes when the value actually changes. */
/** Stamp the provider run id onto a streaming message once the bridge learns it
 *  (Hermes reports it on run.started, after the row was opened) — only while the
 *  message is still streaming and has no run id yet, so it never clobbers a
 *  finalized turn. Enables abort-by-run-id targeting. */
export const updateMessageRunId = internalMutation({
  args: {
    messageId: v.id("messages"),
    runId: v.string(),
    boundInstanceName: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, runId, boundInstanceName }) => {
    const msg = await ctx.db.get(messageId);
    if (msg === null) return;
    // Durable message stamp wins (survives finalize); legacy → chat check.
    if (
      boundInstanceName !== undefined &&
      msg.boundInstance !== undefined &&
      msg.boundInstance !== boundInstanceName
    ) {
      throw new Error("forbidden: cross-instance bridge target");
    }
    if (msg.boundInstance === undefined) {
      await assertIngestChatBound(ctx, msg.chatId, boundInstanceName);
    }
    if (msg.status !== "streaming") return;
    if (msg.runId) return;
    // Read the live row FIRST: its boundInstance stamp is STRICTER than chat
    // membership (per-TURN owner). A routed-but-not-owning instance rewriting
    // the runId would corrupt the generation guard and lock the legitimate
    // writer out of its own stream (codex P1 — the Hermes late-runId path).
    const row = await ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first();
    if (
      boundInstanceName !== undefined &&
      row !== null &&
      row.boundInstance !== undefined &&
      row.boundInstance !== boundInstanceName
    ) {
      throw new Error("forbidden: cross-instance bridge target");
    }
    await ctx.db.patch(messageId, { runId });
    // Keep the live row's GENERATION in lockstep (Hermes reveals its run id
    // AFTER startAssistant seeded generation=null): the bridge tags the
    // subsequent stream writes with the new run id, and the generation guard
    // would otherwise reject them all against the stale null.
    if (row !== null && (row.generation === null || row.generation === undefined)) {
      await ctx.db.patch(row._id, { generation: runId });
    }
  },
});

/** ATOMIC ingest authorization for the bridge-facing mutations below: when the
 *  ingest passes the caller's PROVEN instance, the target chat must allow it —
 *  in THIS transaction (no authorize→write TOCTOU). Undefined = trusted
 *  internal caller. */
async function assertIngestChatBound(
  ctx: { db: { get: (id: Id<"chats">) => Promise<unknown> } } & Parameters<typeof chatAllowsInstance>[0],
  chatId: Id<"chats">,
  bound: string | undefined,
): Promise<void> {
  if (bound === undefined) return;
  if (!(await chatAllowsInstance(ctx, chatId, bound))) {
    throw new Error("forbidden: cross-instance bridge target");
  }
}

export const bindProviderChat = internalMutation({
  args: {
    chatId: v.id("chats"),
    providerChatId: v.string(),
    // The chat's providerResetCount the TURN started under (rode the /send
    // body). A mismatch means a /reset ran while this bind was in flight —
    // refuse, or the bind would resurrect the session the reset discarded
    // into the freshly-cleared slot (codex P1; a pure slot-value CAS cannot
    // catch the null->null case of a reset on a not-yet-bound chat). Absent
    // (old bridge) = unguarded, the pre-existing behavior.
    resetCount: v.optional(v.number()),
    boundInstanceName: v.optional(v.string()),
  },
  handler: async (ctx, { chatId, providerChatId, resetCount, boundInstanceName }) => {
    // Deleted chat = no-op (pre-existing contract), never a 403.
    if ((await ctx.db.get(chatId)) === null) return;
    await assertIngestChatBound(ctx, chatId, boundInstanceName);
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    if (resetCount !== undefined && (chat.providerResetCount ?? 0) !== resetCount) {
      return;
    }
    if (chat.openclawChatId === providerChatId) return;
    // A per-turn-routing chat NEVER persists a Hermes id to the SHARED
    // openclawChatId slot: that slot belongs to the chat's PRIMARY OpenClaw
    // session (temporarily null between routed turns, which use routingSegment),
    // and later non-routed sends/reset/patch read it to build the primary
    // session — a Hermes id there would misdirect them (codex P2). The bridge's
    // in-memory per-target map carries Hermes continuity for these chats.
    if (chat.perTurnRouting === true) return;
    // Single-provider chat: occupy the slot only when it is empty or already
    // holds a Hermes session id (never clobber an OpenClaw primary/segment).
    const cur = chat.openclawChatId;
    const slotFree =
      cur === undefined ||
      cur === null ||
      /^api_[0-9]+_[0-9a-f]+$/i.test(cur) ||
      /^[0-9]{8}_[0-9]{6}_[0-9a-f]+$/i.test(cur);
    if (!slotFree) return;
    await ctx.db.patch(chatId, { openclawChatId: providerChatId });
  },
});

/** Clear a Hermes-minted conversation id from the chat on RESET, so the next
 *  turn starts a fresh Hermes session. Guarded: only clears an `api_...`-shaped
 *  id (a Hermes session), never an OpenClaw routing segment that happens to sit
 *  in the same slot (codex P1). */
export const clearProviderChat = internalMutation({
  args: { chatId: v.id("chats"), boundInstanceName: v.optional(v.string()) },
  handler: async (ctx, { chatId, boundInstanceName }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    await assertIngestChatBound(ctx, chatId, boundInstanceName);
    const cur = chat.openclawChatId;
    // The reset EPOCH bumps even when the slot is empty (nothing to clear):
    // an in-flight turn's late bind must see the mismatch and stand down —
    // the empty-slot case is exactly a not-yet-bound first turn (codex P1).
    const bumped = { providerResetCount: (chat.providerResetCount ?? 0) + 1 };
    // BOTH Hermes session shapes: REST (`api_<ts>_<hex>`) and WS
    // (`YYYYMMDD_HHMMSS_<hex>`, the stored_session_id) — a reset must clear
    // whichever transport persisted it (codex P1), never a routing segment.
    if (
      typeof cur === "string" &&
      (/^api_[0-9]+_[0-9a-f]+$/i.test(cur) ||
        /^[0-9]{8}_[0-9]{6}_[0-9a-f]+$/i.test(cur))
    ) {
      await ctx.db.patch(chatId, { openclawChatId: undefined, ...bumped });
    } else {
      await ctx.db.patch(chatId, bumped);
    }
  },
});

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
  // `isSwitch` = this turn re-keyed the gateway session (the routed agent differs from
  // the preceding routed turn's agent, OR the first per-turn selection that mints a
  // segment) — it DRIVES the bridge's `routedSwitch` freshness signal. `switchedFrom*`
  // = the previous agent's non-secret names for the trace/anomaly diagnostic; it can be
  // NULL on a real switch with no known predecessor (a legacy/unbound chat's first
  // per-turn selection — codex P2.B: that case is STILL a switch, isSwitch=true, so it
  // must rehydrate even though switchedFrom is null). null return = no per-turn routing
  // happened (early-returned: chat gone, unauthorized, or a single-agent primary turn).
  returns: v.union(
    v.object({
      isSwitch: v.boolean(),
      // The EPHEMERAL session segment for THIS dispatch (the bridge session key): a
      // NEW `turn:<turnId>` on a switch, else the chat's last-CONFIRMED segment. It is
      // RETURNED (not persisted here) so a FAILED dispatch never advances the chat's
      // segment — the persisted tuple advances atomically in confirmTurnRouting.
      segment: v.string(),
      switchedFromInstanceName: v.union(v.string(), v.null()),
      switchedFromAgentId: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { chatId, userId, routedAgent, turnId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return null;
    // AUTHORIZE before persisting ANY turn state (codex P2): a forged routedAgent — or one
    // revoked/deleted between sendMessage and dispatch — must NOT reconfigure the chat.
    // Otherwise the dispatch fails agent_restricted/no_agent but the chat is left with an
    // invalid per-turn session segment that corrupts every later routing. Resolve the exact
    // same way the dispatch does; only an entitled, present agent reconfigures the chat.
    const res = await resolveTargetForTurn(ctx, chat, userId, routedAgent);
    if (res.target === null) return null;
    // A turn explicitly routed to the chat's OWN primary agent, on a chat that is not yet
    // multi-agent, is just a normal single-agent turn — do NOT flip perTurnRouting or
    // re-key (codex P2): that would needlessly fork the warm gateway session and force a
    // rehydration when the single-agent flow should simply continue.
    const isToPrimary =
      routedAgent.agentId === chat.agentId &&
      routedAgent.instanceName === chat.instanceName;
    if (!chat.perTurnRouting && isToPrimary) return null;
    // Baseline for "did the agent change?": the previous turn's agent, or — on the first
    // per-turn turn — the chat's primary binding.
    const prevAgent = chat.lastRoutedAgentId ?? chat.agentId ?? null;
    const prevInstance =
      chat.lastRoutedInstanceName ?? chat.instanceName ?? null;
    const isSwitch =
      routedAgent.agentId !== prevAgent ||
      routedAgent.instanceName !== prevInstance ||
      !chat.routingSegment;
    // ATOMIC-ON-CONFIRM invariant (codex): the PERSISTED routing tuple
    // {routingSegment, lastRoutedAgentId, lastRoutedInstanceName} is what later turns
    // read for a routing DECISION — it must advance ATOMICALLY and ONLY when the
    // dispatch is CONFIRMED (confirmTurnRouting). beginTurnRouting persists ONLY the
    // monotonic `perTurnRouting` flag (it never encodes WHICH agent/segment, so a failed
    // switch leaving it set is harmless + needed so the retry takes the per-turn path).
    // The EPHEMERAL segment for THIS dispatch is RETURNED (a NEW one on a switch, else
    // the last-confirmed segment) so the live send keys correctly WITHOUT persisting an
    // unconfirmed segment — a failed switch then leaves the WHOLE tuple at the prior
    // confirmed agent+segment, so a return-to-prior reuses its REAL warm session.
    const segment = isSwitch
      ? `turn:${turnId}`
      : (chat.routingSegment ?? `turn:${turnId}`);
    await ctx.db.patch(chatId, { perTurnRouting: true });
    // `isSwitch` drives routedSwitch (the freshness signal). `switchedFrom*` is the
    // DIAGNOSTIC predecessor — present only on a switch with a KNOWN previous agent
    // (null on a legacy/unbound first selection, where isSwitch is still true).
    return {
      isSwitch,
      segment,
      switchedFromInstanceName: isSwitch ? prevInstance : null,
      switchedFromAgentId: isSwitch ? prevAgent : null,
    };
  },
});

// Advance the chat's PERSISTED routing tuple — {routingSegment, lastRoutedAgentId,
// lastRoutedInstanceName} — ATOMICALLY, called by the dispatch ONLY after the gateway
// accepted the send (mirrors the bridge's firstSendPending consume-on-success). A FAILED
// routed dispatch never reaches here, so the WHOLE tuple stays at the prior CONFIRMED
// values: a return-to-prior reuses its real warm session+segment, and a retry to the
// failed agent is re-detected as a switch (isSwitch=true → routedSwitch=true → rehydrate).
// This tuple is the ONLY persisted state any later turn reads for a routing DECISION.
export const confirmTurnRouting = internalMutation({
  args: {
    chatId: v.id("chats"),
    routedAgent: v.object({ instanceName: v.string(), agentId: v.string() }),
    // The segment THIS dispatch used (beginTurnRouting's returned `segment`).
    segment: v.string(),
  },
  handler: async (ctx, { chatId, routedAgent, segment }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    // Only meaningful once the chat is per-turn routed (beginTurnRouting flips it before
    // the dispatch); a non-per-turn send never confirms a routed agent.
    if (!chat.perTurnRouting) return;
    if (
      chat.lastRoutedAgentId === routedAgent.agentId &&
      chat.lastRoutedInstanceName === routedAgent.instanceName &&
      chat.routingSegment === segment
    ) {
      return; // already current — no write
    }
    await ctx.db.patch(chatId, {
      routingSegment: segment,
      lastRoutedInstanceName: routedAgent.instanceName,
      lastRoutedAgentId: routedAgent.agentId,
    });
  },
});

// BRANCHED chat (chatFork): consume the one-shot first-turn rehydration flag.
// Called by the dispatch ONLY after an OPENCLAW gateway ACK'd the send (the
// true acceptance point — same contract as confirmTurnRouting; getChatRouting
// returns forkFresh:false on Hermes, where the flag stays armed and inert).
export const consumeForkRehydration = internalMutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat?.forkPendingRehydration === true) {
      await ctx.db.patch(chatId, { forkPendingRehydration: undefined });
    }
  },
});

/**
 * PACED-DISPATCH RE-CHECK (called at the top of `dispatch`): between the
 * drain's queued→pending flip and the delayed wake-up (QUEUE_DRAIN_DELAY_MS),
 * a sub-agent ANNOUNCE may have reopened an assistant bubble — the chat is
 * streaming again. A chat.send now can kill that announce run mid-report —
 * not by gateway policy ("one run per session" is NOT an upstream invariant;
 * v2026.7.1 steers/queues by design) but by the emergent session-file
 * takeover, timing-dependent (live 2026-07-19: the report froze on
 * "Génération…" and the rest never arrived; see
 * docs/design/upstream-interpretation-comparison.md §2). Re-park the row as
 * `queued` instead; the announce's own finalize re-drains the queue FIFO.
 */
export const reparkIfBusy = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }): Promise<boolean> => {
    const row = await ctx.db.get(outboxId);
    if (row === null || row.status !== "pending") return false;
    // The FULL activity predicate (streaming message OR live sub-agent) — a
    // `subagent.start` observed during the dispatch delay must hold too, or
    // the follow-up would be routed into / kill the child session (codex P1).
    // Only the `pending` clause of isChatBusy is skipped: this row IS pending.
    if (!(await chatHasActivityBlockers(ctx, row.chatId))) return false;
    await ctx.db.patch(outboxId, { status: "queued" });
    return true;
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
    if (await ctx.runMutation(internal.bridge.reparkIfBusy, { outboxId })) {
      console.log(
        "bridge.dispatch: chat busy again (announce reopened a bubble) — re-parked",
      );
      return;
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
    // chat single-agent and skips this entirely. The return carries `isSwitch` (drives
    // routedSwitch — the freshness signal) + the diagnostic `switchedFrom*` (the prior
    // agent, can be null on a legacy switch).
    let turnRouting: {
      isSwitch: boolean;
      segment: string;
      switchedFromInstanceName: string | null;
      switchedFromAgentId: string | null;
    } | null = null;
    if (row.routedAgent && row.messageId) {
      turnRouting = await ctx.runMutation(internal.bridge.beginTurnRouting, {
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
      // ACTUAL switch only (codex P2): `isSwitch` is true EXACTLY when this turn
      // re-keyed the session (routed agent differs from the preceding routed turn, OR a
      // first per-turn selection minting a segment — even a legacy/unbound chat with no
      // known predecessor, where switchedFrom is null but it IS still a switch, P2.B). A
      // same-agent follow-up → isSwitch false → routedSwitch false → the bridge keeps a
      // warm gateway session (no duplicate re-inject after a restart).
      routedSwitch: turnRouting?.isSwitch ?? false,
      // The EPHEMERAL segment this dispatch keys on (a NEW one on a switch, else the
      // last-confirmed) — NOT persisted to the chat doc until confirm (atomic-on-confirm),
      // so it must travel explicitly. Absent for a non-routed send (falls back inside).
      ...(turnRouting ? { routingSegment: turnRouting.segment } : {}),
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
    } else if (
      // LAST-INSTANT revalidation: a summarize job invalidated by a deletion
      // CANCELS by deleting its outbox row — but this action may have loaded the
      // row before the deletion landed. Re-read just before the POST so a
      // cancelled prompt (which can carry deleted content) is never sent. Narrows
      // the race to the network call itself; a residual late reply correlates
      // against nothing and is swept (codex P2).
      (await ctx.runQuery(internal.bridge.getOutbox, { outboxId })) === null
    ) {
      return;
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
            // The OUTBOX id of this dispatch — the bridge echoes it as the
            // `openclaw.rehydrate` trace's correlationId (`chatId:outboxId`), the
            // master join key (matches chat.send's correlationId) so the
            // rehydration decision stitches to the turn in the obs MCP. Non-secret id.
            outboxId,
            // The agent THIS turn switched away from (null = not a switch, OR a switch
            // with no known predecessor) — non-secret names, echoed into the rehydrate
            // trace + anomaly so a routing bug reads "switched from X to Y". From
            // beginTurnRouting (the dispatch-time truth).
            switchedFromInstanceName: turnRouting?.switchedFromInstanceName ?? null,
            switchedFromAgentId: turnRouting?.switchedFromAgentId ?? null,
            openclawChatId: routing.openclawChatId,
            // Resolved valve target (non-secret names): the bridge maps
            // instanceName -> gateway token/device identity from its env.
            instanceName: routing.target.instanceName,
            agentId: routing.target.agentId,
            canonical: routing.target.canonical,
            // QUOTE-REPLY: a turn replying to a block ships the resolved
            // preamble AHEAD of the user's clean text — plain prompt text, so
            // OpenClaw and Hermes are covered identically (single send path).
            text: row.quotedExcerpt
              ? composeQuotedText(
                  fillTemplate(routing.quoteReplyTemplate ?? "", {
                    excerpt: row.quotedExcerpt,
                  }),
                  row.text,
                )
              : row.text,
            // The GATEWAY idempotency source: the re-park flip mints a fresh
            // `dispatchKey` alias (the killed dispatch consumed the original
            // key) while the browser's own clientMessageId stays intact for
            // send.sendMessage's retry dedup (preemptRepark.ts).
            clientMessageId: row.dispatchKey ?? row.clientMessageId,
            // The user message id for THIS turn — the bridge excludes it when it
            // fetches prior history for session re-hydration (so the current
            // message is not duplicated into the injected context).
            messageId: row.messageId ?? null,
            // Provider-session reset epoch: echoed back by the turn's session
            // bind so bindProviderChat can refuse a bind that raced a /reset
            // (see the mutation). An old bridge ignores this unknown field.
            providerResetCount: routing.providerResetCount,
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
        // Bind the ack to THIS dispatch's generation: a preempt re-park mints
        // a fresh dispatchKey at its flip, so a straggler ack from the killed
        // dispatch can never flip the re-queued row (codex P1).
        expectedClientMessageId: row.dispatchKey ?? row.clientMessageId,
      });
      // CONFIRM the WHOLE routing tuple {segment, lastRoutedAgent*} ONLY now that the
      // gateway accepted the send — so a FAILED routed dispatch advances NOTHING and a
      // return-to-prior reuses its real segment + a retry to the failed agent is still a
      // switch (rehydrate). Only when beginTurnRouting ran (turnRouting carries the
      // segment); a non-routed send never confirms.
      if (row.routedAgent && turnRouting) {
        await ctx.runMutation(internal.bridge.confirmTurnRouting, {
          chatId: row.chatId as Id<"chats">,
          routedAgent: row.routedAgent,
          segment: turnRouting.segment,
        });
      }
      // BRANCHED chat: consume the one-shot rehydration flag HERE — the
      // OpenClaw ACK is the true acceptance point (same contract as
      // confirmTurnRouting above; routing.forkFresh is false on Hermes, whose
      // 200 is not a delivery signal). Terminal message states over/under-
      // approximate delivery: a Hermes WS submit-failure finalizes an error
      // row though nothing was delivered, and the stuck-stream watchdog
      // terminates rows without stream.finalize. An INLINE-attachment first
      // send consumes too: the gateway-crash guard shipped it bare AND warmed
      // the session, so no later turn of this session can carry the history —
      // the SAME documented known-gap as an attachment turn right after a
      // session reset (the fork re-grounds when the session next rolls).
      if (routing.forkFresh) {
        await ctx.runMutation(internal.bridge.consumeForkRehydration, {
          chatId: row.chatId as Id<"chats">,
        });
      }
    } else {
      // The bridge accepted the POST shape but the gateway refused the turn
      // (502): surface it to the user instead of leaving the message unanswered.
      // Pass the curated errorCode so an attachment refusal shows a file-specific
      // message ("trop volumineuse" / "n'a pas pu être traitée"), not a blanket one.
      await ctx.runMutation(internal.bridge.failDispatch, {
        outboxId,
        reason: "send_failed",
        errorCode,
        // Generation-bound (codex P1, pass 14): a lost-response failure of the
        // KILLED dispatch outliving the hold must not fail the re-keyed row
        // (the only failDispatch site that can be slow — it sits behind the
        // network call; every earlier site fails in milliseconds, before a
        // hold can exist).
        expectedClientMessageId: row.dispatchKey ?? row.clientMessageId,
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
// Best-effort kill of the chat's ACTIVE gateway run (the stop button's second
// half — Convex already finalized the message as aborted). Same routing
// resolution as dispatchReset; failure is LOG-ONLY (the UI is already settled;
// worst case the gateway finishes a run whose frames drop as stale).
export const dispatchAbort = internalAction({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    // The streaming turn's exact gateway session key (preferred: per-turn
    // routing + epoch baked in); the bridge derives from routing when absent.
    sessionKey: v.optional(v.string()),
    // The streaming run's exact id — chat.abort kills the NAMED run, immune to
    // a queued follow-up starting a new run on the same session meanwhile.
    runId: v.optional(v.string()),
    // Settle THIS message as aborted AFTER the kill attempt — ordering matters:
    // finalize drains the queued follow-up, which must not dispatch while the
    // gateway still runs the old turn (one-turn-per-session).
    finalizeMessageId: v.optional(v.id("messages")),
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (
    ctx,
    { chatId, userId, sessionKey, runId, finalizeMessageId, routedAgent },
  ) => {
    try {
      const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
      if (!sharedSecret) {
        console.error(
          "bridge.dispatchAbort: BRIDGE_SHARED_SECRET not configured",
        );
        return;
      }
      const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
        chatId,
        userId,
        ...(routedAgent ? { routedAgent } : {}),
      });
      if (!routing || routing.target === null) {
        console.error(
          "bridge.dispatchAbort: no routing target (nothing to kill)",
        );
        return;
      }
      const bridgeUrl = routing.bridgeUrl;
      if (!bridgeUrl) {
        console.error(
          "bridge.dispatchAbort: no bridgeUrl for the routed instance",
        );
        return;
      }
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/abort`, {
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
          ...(sessionKey ? { sessionKey } : {}),
          ...(runId ? { runId } : {}),
        }),
      });
      if (!response.ok) {
        console.error(`bridge POST /abort -> HTTP ${response.status}`);
      }
    } catch (err) {
      console.error("bridge POST /abort failed:", err);
    } finally {
      // GUARANTEED settle, whatever the kill did: the user asked to stop.
      // TRADE-OFF (reviewed, deliberate): when the kill itself failed (legacy
      // bridge without /abort, gateway 502, missing secret), we still settle —
      // leaving the row `streaming` until the stuck-stream watchdog (minutes)
      // is strictly worse UX than the residual risk. That risk is bounded by
      // the GATEWAY's own one-turn-per-session guard: a drained follow-up
      // reaching a still-busy session is refused cleanly (OCC "reply session
      // initialization conflicted") and surfaces as a visible failed dispatch,
      // never as run interference.
      if (finalizeMessageId) {
        await ctx.runMutation(internal.stream.finalize, {
          messageId: finalizeMessageId,
          status: "aborted",
          // Generation guard: if an announce merge re-owned this message for a
          // NEWER run while the kill was in flight, this late settle must not
          // abort the announce stream (it targeted the OLD run only). `null`
          // pins a runId-LESS legacy turn — a reopen always sets a runId, so
          // the mismatch still protects the new generation.
          expectedRunId: runId ?? null,
        });
      }
    }
  },
});

/** Full busy predicate as a query — dispatchReset re-validates idleness at
 *  EXECUTION time (the resetSession check ran at schedule time; codex P1). */
export const chatBusyProbe = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<boolean> =>
    isChatBusy(ctx, chatId),
});

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
    // PANEL reset only (a regenerate reset runs while its OWN pending row
    // holds the chat — the check would veto every legitimate regenerate):
    // re-validate idleness at EXECUTION time. chats.resetSession checked at
    // SCHEDULE time; a send created in between would have its freshly started
    // turn killed by this very /reset (codex P1 — the exact interruption the
    // guard exists to prevent). Abandoning is the lesser evil: the user
    // re-clicks once the turn ends, nothing is interrupted. Traced.
    // DELIBERATE trade-off (codex P2, accepted): the panel already showed
    // "request sent" — honest for the request, optimistic for the outcome.
    // The window is milliseconds wide (schedule→execute on an idle-checked
    // chat), and the alternative — a deferred reset firing after the
    // intervening turn ends — would wipe a session the user just watched
    // answer, a worse surprise than one dead click.
    if (regenerateOutboxId === undefined) {
      const busy = await ctx.runQuery(internal.bridge.chatBusyProbe, {
        chatId,
      });
      if (busy) {
        console.log(
          "bridge.dispatchReset: chat became busy since schedule — reset abandoned",
        );
        try {
          await ctx.runMutation(internal.observability.recordEvent, {
            kind: "openclaw.reset",
            direction: "outbound",
            principalType: "user",
            principalId: userId,
            chatId,
            correlationId: `${chatId}:reset`,
            meta: JSON.stringify({ resetStatus: "abandoned_busy" }),
          });
        } catch {
          // best-effort
        }
        return;
      }
    }
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
    let refusedTurnActive = false;
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
          // PANEL resets only: the bridge refuses (409 turn_active) when a
          // turn is LIVE at execution time — the atomic close of the
          // schedule→execute race (codex P1, pass 8). Regenerate resets never
          // set it: their turn is terminal by construction, and the flag
          // would veto legitimate regenerates mid-announce. An older bridge
          // ignores the field (graceful).
          ...(regenerateOutboxId === undefined ? { refuseIfActive: true } : {}),
        }),
      });
      ok = response.ok;
      if (!ok) {
        // 409 is ALSO instance_not_served — only the explicit turn_active
        // code may read as "a turn was live" in the traces (codex P2).
        if (response.status === 409) {
          try {
            const body = (await response.json()) as {
              error?: { code?: string };
            };
            refusedTurnActive = body?.error?.code === "turn_active";
          } catch {
            // unparseable 409 body — keep the generic failed classification
          }
        }
        console.error(`bridge POST /reset -> HTTP ${response.status}`);
      }
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
          resetStatus: ok
            ? "sent"
            : refusedTurnActive
              ? "refused_turn_active"
              : "failed",
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
