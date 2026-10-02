import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
} from "@assistant-ui/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId, ConvexMessageView } from "./convexTypes";
import { convertConvexMessage } from "./convertMessage";
import {
  attachmentParts,
  createConvexAttachmentAdapter,
} from "./attachmentAdapter";
import {
  restorePendingQuotesExcept,
  takePendingQuotes,
  type PendingQuote,
} from "./pendingQuote";
import {
  peekPendingMentions,
  restorePendingMentions,
  stagedAgents,
  subscribePendingMentions,
  takeMentionsForSend,
  type PendingMention,
} from "./pendingMention";
import { useToast } from "@/components/ui/toast";
import {
  lastRoutedAgent,
  resolveEffectiveSelection,
  roomTargets,
  resolveImportedAgentLabels,
  resolveMessageAgents,
  resolveTurnRoute,
  type AgentRef,
} from "./perTurnAgent";
import type { PickableAgent } from "./AgentPicker";
import { useSseStreamingText, sseDevOverride } from "./useSseStreamingText";
import { useDeliveryRecorder } from "./useDeliveryRecorder";
import type { SseTimingSample } from "./deliveryRecorder";
import { m } from "@/paraglide/messages.js";

// The single source of truth for the chat UI runtime.
//
// We deliberately use useExternalStoreRuntime backed by a *reactive* Convex
// query — NOT the AI SDK useChat default HTTP transport (POST + SSE per turn).
// That transport opens a request-scoped stream per turn and closes it when the
// turn "ends", which loses post-turn OpenClaw events (extra tool calls, late
// media, status corrections) — exactly the Open WebUI failure mode this project
// exists to kill. Here, the bridge worker holds the persistent OpenClaw socket
// and writes every normalized event into Convex; useQuery(listByChat) makes the
// browser reactive to the DB, so streaming and post-turn events all land the
// same way: a doc patch -> query re-run -> re-render.

/** Stable empty staging (useSyncExternalStore compares snapshots by identity). */
const NO_STAGED: readonly PendingMention[] = [];

export interface UseConvexChatRuntimeArgs {
  chatId: ConvexId<"chats"> | null;
}

/**
 * Imperative handle on the in-flight turn gate, for flows that start a run
 * OUTSIDE the composer (delete-assistant -> regenerate). `begin()` arms the
 * gate THIS FRAME — same thinking placeholder + composer lock as a send —
 * and the existing reactive machinery clears it when the reply (or its error
 * bubble) lands. `cancel()` releases it after a CLIENT-side failure, where no
 * reply will ever arrive to clear it reactively.
 */
export interface TurnGate {
  begin: () => void;
  cancel: () => void;
}

/** Anchors the server just named as GONE, parsed out of its rejection.
 *
 *  `sendMessage` refuses a turn ATOMICALLY — quoting fewer passages than the
 *  user picked would answer a question they did not ask — but it names the
 *  stale anchor, so the composer can drop THAT chip and hand the rest back.
 *  Throwing the whole selection away because one target was regenerated is how
 *  a user silently loses work they deliberately assembled. */
export function goneQuoteTargets(error: unknown): Set<string> {
  const message = error instanceof Error ? error.message : "";
  return new Set(
    [...message.matchAll(/Invalid: quote target gone \[([^\]]+)\]/g)].map(
      (found) => found[1]!,
    ),
  );
}

/** Whether the rejection is one that RE-SENDING the same passages would hit
 *  again. Restaging those would wedge every retry behind the same refusal. */
export function quotesRejectedOutright(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  if (goneQuoteTargets(error).size > 0) return false;
  return /Invalid:.*quote/i.test(message);
}

/** Why the server refused to ADDRESS a message to the agents it mentions, when that
 *  is why the send failed: `too_many` (more agents than one message may chain),
 *  `invalid` (an agent no longer in the room or no longer usable, or spans that do
 *  not hold). Null for any other failure. */
export function agentAddressFailure(error: unknown): "too_many" | "invalid" | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("agent_mentions_invalid:too_many_agents")) return "too_many";
  if (
    message.includes("agent_mentions_invalid:") ||
    message.includes("Forbidden: agent is not part of this conversation") ||
    message.includes("Forbidden: routed agent is not dispatchable")
  ) {
    return "invalid";
  }
  return null;
}

/** The server refused a COMMAND (`/…`) sent with files: a command leaves exactly as
 *  typed, and files can only reach the agent as text added to the message
 *  (convex/lib/gatewayCommand.ts `COMMAND_WITH_ATTACHMENTS`). */
export function commandWithFilesRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("COMMAND_WITH_ATTACHMENTS");
}

export function useConvexChatRuntime({ chatId }: UseConvexChatRuntimeArgs) {
  const convex = useConvex();
  // Surface attachment rejections (e.g. too large) as a visible toast — assistant-ui
  // only logs a thrown add() error, so the composer adapter needs this to tell the
  // user WHY the file did not attach (the user's actual complaint: silent drop).
  const toast = useToast();
  // OPTIMISTIC ECHO (perceived performance — Doherty ~400ms / Nielsen 0.1s
  // "instant"): without this the user message only appears AFTER the Convex
  // round-trip (insert -> reactive listByChat re-run), a ~1-2s void where the
  // user can't tell their send registered. `withOptimisticUpdate` writes a
  // synthetic user message straight into the local listByChat cache so the
  // bubble renders on the NEXT FRAME; Convex atomically drops it when the real
  // server result lands (and auto-rolls-back if the mutation throws).
  const sendMessage = useMutation(api.send.sendMessage).withOptimisticUpdate(
    (localStore, args) => {
      // Must match the EXACT args the component subscribes with (see useQuery
      // below) so this patches the same cached query result.
      const key = { chatId: args.chatId as unknown as string };
      const current = localStore.getQuery(api.messages.listByChat, key);
      // The list may not be loaded yet — a fast send before the first read
      // settles, OR a slow/overloaded/just-created chat (the exact "did my send
      // register?" window). SEED onto an empty base so the user's message ALWAYS
      // echoes this frame. Convex REAPPLIES this updater whenever listByChat
      // changes, so when the real list loads it re-runs as [...history, optimistic]
      // (no permanent history loss — at worst history is hidden for the in-flight
      // ~1-2s, far better than a void), and drops the echo when the mutation
      // commits (the real message takes its place).
      const base = current ?? [];
      // Idempotency / double-fire guard: never echo the same logical send twice.
      const echoId = `optimistic-${args.clientMessageId}`;
      if (base.some((m) => m._id === echoId)) return;
      const now = Date.now();
      const optimistic = {
        _id: echoId as Id<"messages">,
        chatId: args.chatId,
        _creationTime: now,
        orderTime: undefined, // an echo's moment IS its creation time
        role: "user" as const,
        // `complete` keeps the status switches simple; the "sending…" affordance
        // keys off the `optimistic-` id prefix instead (see convertMessage), so no
        // MessageStatus enum surgery / gate-logic risk.
        status: "complete" as const,
        runId: undefined,
        error: undefined,
        errorCode: undefined, // optimistic user echo never carries a dispatch code
        attachedDocCount: undefined, // a user echo never has attachments
        finalizedAt: undefined, // a user echo has no generation window
        text: args.text,
        updatedAt: now,
        // MULTI-AGENT: echo the routed agent too, so the in-flight thinking
        // placeholder attributes to the agent the user just addressed (else
        // lastRoutedAgent would briefly see the PREVIOUS turn's agent until the
        // real message lands and corrects it). Keys always present (value
        // undefined on an unrouted send) to match the query's inferred shape.
        // A turn addressed by mention is routed to its FIRST agent (send.ts).
        routedInstanceName:
          args.routedAgent?.instanceName ?? args.agentMentions?.[0]?.instanceName,
        routedAgentId: args.routedAgent?.agentId ?? args.agentMentions?.[0]?.agentId,
        // Quote-reply echo: the collapsed headers render this frame (key always
        // present to match the query's inferred shape).
        quotedRefs: args.quotes,
        // A user echo is never a merged bubble; key present to match the
        // query's inferred shape.
        hasMergedRuns: false,
        hasAnnouncePrefix: false,
        mergedIntoTurn: undefined,
        continuationAt: undefined,
        continuations: undefined,
        followedUpChildRunIds: undefined,
        // Never on a user echo; keys present to match the query's shape.
        autoRetry: undefined,
        autoRetryOutcome: undefined,
        interruptedAt: undefined,
        // Attachments reconcile a beat later with their server-signed URL; the
        // instant echo carries the text (the primary case). Empty is fine — the
        // converter renders the text bubble immediately.
        parts: [] as (typeof base)[number]["parts"],
        // No outbox row yet at echo time (the mutation creates it on commit); the real
        // message that replaces this echo carries the queued/pending/sent status.
        outbox: null,
        // A turn this session just echoed has not closed, so there is no verdict
        // on why it did. Diagnosis-only field; nothing here reads it.
        finalizeCause: undefined,
        priorFinalizeCauses: undefined,
        // Never set on a message this session just wrote: the label only exists on
        // imported history.
        importedAgentLabel: undefined,
        chatImportedAgentLabel: undefined,
      } satisfies (typeof base)[number];
      localStore.setQuery(api.messages.listByChat, key, [...base, optimistic]);
    },
  );

  // Reactive message feed. Returns messages joined with ordered parts and
  // resolved storage URLs (see convexTypes). `skip` while no chat is selected.
  const messages = useQuery(
    api.messages.listByChat,
    // ConvexId<"chats"> is our structural string-id type; the generated arg
    // validator brands it Id<"chats">. Same runtime value; cast at the boundary.
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as ConvexMessageView[] | undefined;

  // The CHEAP live-text companion. The bridge's per-delta writes land in the
  // streamingText table, read here, so the heavy listByChat above does NOT re-run
  // on every token (it only re-runs when the message set / parts change). We
  // overlay each row's text onto its streaming message below. A finalize patches
  // the message AND deletes the row in ONE mutation, so Convex delivers both query
  // updates from a single consistent snapshot — the live→final handoff never flickers.
  const streamingRows = useQuery(
    api.messages.getStreamingText,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as
    | { messageId: Id<"messages">; text: string; chunkSeq?: number }[]
    | undefined;

  // SSE transport (Phase 3, behind a flag): when enabled, the live text of the active
  // streaming message comes from the SSE stream (standard fetch-stream) instead of the
  // reactive streamingText row above. Returns null when disabled/none -> reactive fallback.
  const sseMessageId =
    streamingRows && streamingRows.length > 0
      ? (streamingRows[0].messageId as string)
      : null;
  // Phase 4b: the transport is chosen per the chat's gateway INSTANCE
  // (getChatStreamTransport: "reactive" | "sse"), or forced on by the DEV override for
  // local testing. The reactive path stays the default + the fallback.
  const streamTransport = useQuery(
    api.messages.getChatStreamTransport,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const sseEnabled = streamTransport === "sse" || sseDevOverride();
  // Delivery recorder (Phase 5): when SSE is the display, the recorder must close segment C
  // at the SSE receipt, not the parallel reactive one. The SSE hook stamps t4 here as each
  // correlated chunk arrives; the recorder (below) drains these when SSE is active.
  const sseSamplesRef = useRef<SseTimingSample[]>([]);
  // Sample the SSE leg for the recorder ONLY for chunks at/past the reactive frontier — i.e.
  // chunks the SSE actually DISPLAYS (caught up), not the initial replay after a reload (seq <
  // frontier), whose already-displayed chunks would inject inflated, late samples that
  // overwrite the originals. Gating per-CHUNK by `seq` (not a render-stale boolean) also
  // catches the boundary chunk that crosses the frontier within a replay batch (Codex review).
  // Any residual jitter is corrected by min(legs): a still-behind SSE sample loses to the
  // earlier reactive one. Same `caughtUp` threshold the display uses below.
  const sseFrontierRef = useRef(0);
  const onTimingSample = useCallback((timingId: string, seq: number) => {
    if (seq < sseFrontierRef.current) return;
    sseSamplesRef.current.push({ timingId, t4: Date.now() });
  }, []);
  const sseGenerationKey =
    streamingRows && streamingRows.length > 0
      ? ((streamingRows[0] as { streamRowId?: string }).streamRowId ?? null)
      : null;
  const sse = useSseStreamingText(
    sseMessageId,
    sseGenerationKey,
    sseEnabled,
    onTimingSample,
  );
  sseFrontierRef.current = (streamingRows?.[0]?.chunkSeq ?? 1) - 1;
  // Segment-C recorder (one owner). Transport-AGNOSTIC: it reports min(reactive, SSE) per
  // delta — the receipt the user saw first. Lives here (not ConvexChat) so it sees the SSE
  // samples. The SSE ref is empty when SSE is off. Inert unless a recording is active.
  useDeliveryRecorder(chatId, sseSamplesRef);


  // MULTI-AGENT per-turn router. The composer routes a turn to a chosen agent and
  // each reply is attributed to the agent that answered it. Source of truth:
  //   - getChatAgent → the chat's PRIMARY (resolved) agent + whether the USER has
  //     more than one agent (`multiAgent`, which gates the composer selector).
  //   - getSessionMeta → `perTurnRouting`: has the chat actually flipped to
  //     multi-agent (gates the per-message chip).
  // Both are deduped by Convex against the same subscriptions ConvexChat holds.
  const chatAgentInfo = useQuery(
    api.agents.getChatAgent,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const chatMeta = useQuery(
    api.messages.getSessionMeta,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  // The user's CURRENT entitled agent pool (the composer selector + chip display
  // names AND — load-bearing — the filter that keeps a revoked/deleted agent from
  // remaining the default selection). `skip` keeps a no-chat shell from querying.
  const myAgents = useQuery(
    api.agents.listMyAgents,
    chatId ? {} : "skip",
  ) as PickableAgent[] | undefined;
  // DISTINGUISH loading (undefined) from a genuinely empty pool ([]): during
  // loading the selection must NOT be filtered against an empty pool (that would
  // silently drop a perTurnRouting chat's last-routed agent — see P2-D).
  // THE ROOM'S AGENTS (primary + the ones the owner added). A GUEST may only
  // address those — the server refuses anything else (send.ts) — so their pool is
  // narrowed to them; the owner keeps their whole pool, room first in the selector.
  const roomInfo = useQuery(
    api.chatAgents.listChatAgents,
    chatId ? { chatId: chatId as string } : "skip",
  );
  // The reader's standing, from whichever answer lands first (the roster, or the
  // session meta the chat view already subscribes to).
  const isGuest = (roomInfo?.viewerRole ?? chatMeta?.viewerRole) === "participant";
  const roomKey = roomInfo
    ? [roomInfo.primary, ...roomInfo.agents]
        .filter((a) => a !== null)
        .map((a) => `${a!.instanceName}\0${a!.agentId}`)
        .join("|")
    : "";
  const roomAgents = useMemo<AgentRef[]>(
    () =>
      (roomInfo?.agents ?? []).map((a) => ({
        instanceName: a.instanceName,
        agentId: a.agentId,
      })),
    // roomKey encodes the only fields read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomKey],
  );
  // A guest's pool is not known until the room is: filtering against an absent
  // room would briefly offer agents the send then refuses.
  const poolLoading =
    myAgents === undefined || (chatId !== null && roomInfo === undefined);
  const pool = useMemo<PickableAgent[]>(() => {
    // NOTHING until the room is known: the reader may be a guest, and a guest's
    // pool is the room, never their own agents — offered even for a moment, one of
    // them could be picked and the send refused (codex pass 21).
    if (chatId !== null && roomInfo === undefined) return [];
    if (!isGuest || !roomInfo) return myAgents ?? [];
    // A GUEST's pool IS the room: they speak through its agents on the owner's
    // delegation (send.ts), whatever their own grants. An agent the owner can no
    // longer reach is kept as a disabled row ("deleted"), so the list still says
    // who is in the room.
    return [roomInfo.primary, ...roomInfo.agents]
      .filter((a) => a !== null)
      .map((a) => ({
        instanceName: a!.instanceName,
        agentId: a!.agentId,
        isDefault: a!.role === "primary",
        displayName: a!.displayName,
        emoji: a!.emoji,
        model: a!.model,
        description: a!.description,
        kind: a!.kind,
        state: a!.usable ? ("ok" as const) : ("deleted" as const),
      }));
    // roomKey encodes the room; roomInfo is read for the rows it keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, myAgents, isGuest, roomKey, roomInfo]);
  // WHO a message may be addressed to: the room's agents only. The popover still
  // lists the reader's other agents, but as ADD-only rows (ConvexChat.tsx).
  const targetPool = useMemo<PickableAgent[]>(
    () => roomTargets(pool, roomInfo ? [roomInfo.primary, ...roomInfo.agents] : null),
    // roomKey encodes the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, roomKey, roomInfo === undefined],
  );
  const multiAgent = chatAgentInfo?.multiAgent === true;
  const perTurnRouting = chatMeta?.perTurnRouting === true;
  // Routing is allowed only when there is a genuine choice: the user has MORE THAN
  // ONE entitled agent, OR the chat is already perTurnRouting. A single-agent user
  // (exactly one agent, not perTurnRouting) must NEVER stamp a routedAgent — an
  // implicit route would flip the chat to multi-agent + bypass the normal rebind
  // (P2-C). `multiAgent` is getChatAgent's "user has >1 agent" flag.
  const canRoute = multiAgent || perTurnRouting;
  // Stable primary ref (a fresh object each render would churn the routing context
  // and re-render every consumer per streamed token).
  const primaryKey = chatAgentInfo?.agent
    ? `${chatAgentInfo.agent.instanceName}\0${chatAgentInfo.agent.agentId}`
    : "";
  const primary = useMemo<AgentRef | null>(
    () =>
      chatAgentInfo?.agent
        ? {
            instanceName: chatAgentInfo.agent.instanceName,
            agentId: chatAgentInfo.agent.agentId,
          }
        : null,
    // primaryKey encodes the only fields read; the agent object id is unstable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primaryKey],
  );

  // The chat's LAST-ROUTED agent from getSessionMeta (the dispatch-maintained
  // `lastRouted*`). This loads BEFORE the heavier listByChat, so it is the
  // last-used agent we can rely on while messages are still loading (P2-E) — a fast
  // send then still routes a perTurnRouting chat to the last agent, not the primary.
  const chatLastRoutedKey =
    chatMeta?.lastRoutedInstanceName && chatMeta?.lastRoutedAgentId
      ? `${chatMeta.lastRoutedInstanceName}\0${chatMeta.lastRoutedAgentId}`
      : "";
  const chatLastRouted = useMemo<AgentRef | null>(
    () =>
      chatMeta?.lastRoutedInstanceName && chatMeta?.lastRoutedAgentId
        ? {
            instanceName: chatMeta.lastRoutedInstanceName,
            agentId: chatMeta.lastRoutedAgentId,
          }
        : null,
    // chatLastRoutedKey encodes the only fields read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatLastRoutedKey],
  );

  // THE AGENTS STAGED for the next message (their "@Name" tokens, picked in the room
  // popover) — the only thing that addresses a message to an agent. There is no
  // hidden selection: nothing mentioned = the primary (resolveTurnRoute).
  const staged = useSyncExternalStore(
    subscribePendingMentions,
    () => (chatId ? peekPendingMentions(chatId) : NO_STAGED),
  );
  const stagedAgentsKey = stagedAgents(staged)
    .map((a) => `${a.instanceName}\0${a.agentId}`)
    .join("|");
  const severalAgents = roomAgents.length > 0;

  // DISTINGUISH messages LOADING (undefined, listByChat not yet responded) from a
  // genuinely EMPTY new chat ([]). While loading we must not treat the chat as
  // first-turn nor drop the last-routed agent (P2-E) — both would reroute a fast
  // send to the primary.
  const messagesLoading = messages === undefined;
  // Routing derivations read the RAW `messages` (the routed fields live there and
  // are untouched by the streaming overlay), so they recompute only when the
  // message SET changes — not per streamed token.
  const messageAgents = useMemo(
    () => resolveMessageAgents(messages ?? []),
    [messages],
  );
  // The last-routed agent: prefer the thread (freshest — includes the optimistic
  // echo of a just-sent turn), fall back to the chat-level `lastRouted*` (which is
  // available while messages are still loading). `messages` undefined → thread
  // contributes nothing, so this is exactly the chat-level value during loading.
  const threadLastRouted = useMemo(
    () => (messages ? lastRoutedAgent(messages) : null) ?? chatLastRouted,
    [messages, chatLastRouted],
  );
  // The in-flight PLACEHOLDER's attribution: the thread's last-routed agent (the
  // optimistic echo of a just-sent turn carries it), else the primary — gated by
  // canRoute, loading-aware, and pool-filtered (see resolveEffectiveSelection).
  const defaultAgent = useMemo<AgentRef | null>(
    () =>
      resolveEffectiveSelection({
        selected: null,
        lastRouted: threadLastRouted,
        primary,
        pool: targetPool,
        poolLoading,
        messagesLoading,
        canRoute,
      }),
    [threadLastRouted, primary, targetPool, poolLoading, messagesLoading, canRoute],
  );
  // WHERE THE NEXT MESSAGE GOES, as far as the composer knows before the text is
  // final: the first agent staged, else the primary (resolveTurnRoute). What the
  // availability, capability and usage projections — and a voice call — scope to.
  // Null for a single-agent user: the chat's own resolution applies, unchanged.
  const nextTarget = useMemo<AgentRef | null>(
    () =>
      resolveTurnRoute({
        mentioned: stagedAgents(staged),
        primary,
        severalAgents,
        perTurnRouting,
        canRoute,
      }) ?? null,
    // stagedAgentsKey encodes the only part of `staged` read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stagedAgentsKey, primary, severalAgents, perTurnRouting, canRoute],
  );
  // Has the thread said NOTHING at all? Gates the conversation panel's REBIND of an
  // empty chat (rebindChatAgent — never the composer's). LOADING (`undefined`) is
  // NOT empty — offering a rebind on a thread we have not read yet could move the
  // binding under messages that exist, which is exactly what the server refuses.
  const emptyThread = messages !== undefined && messages.length === 0;

  // onNew / queueSend run from memoized closures; read the live routing inputs via
  // refs so a selection change never has to rebuild the runtime adapter.
  const routingRef = useRef<{
    primary: AgentRef | null;
    severalAgents: boolean;
    perTurnRouting: boolean;
    canRoute: boolean;
    nextTarget: AgentRef | null;
  }>({
    primary: null,
    severalAgents: false,
    perTurnRouting: false,
    canRoute: false,
    nextTarget: null,
  });
  routingRef.current = {
    primary,
    severalAgents,
    perTurnRouting,
    canRoute,
    nextTarget,
  };
  // What a send carries for its ROUTE, from the agents its text mentions (resolved
  // against the text as sent): the mentions themselves when there are any — the
  // server chains one reply per agent, in text order — else the route of a message
  // that names no agent, the primary (resolveTurnRoute).
  const computeTurnAddress = useCallback(
    (
      agentMentions: ReadonlyArray<AgentRef & { start: number; end: number }>,
    ):
      | { agentMentions: Array<AgentRef & { start: number; end: number }> }
      | { routedAgent: AgentRef }
      | Record<string, never> => {
      const r = routingRef.current;
      if (agentMentions.length > 0 && r.canRoute) {
        return {
          agentMentions: agentMentions.map((a) => ({
            instanceName: a.instanceName,
            agentId: a.agentId,
            start: a.start,
            end: a.end,
          })),
        };
      }
      const routedAgent = resolveTurnRoute({
        mentioned: [],
        primary: r.primary,
        severalAgents: r.severalAgents,
        perTurnRouting: r.perTurnRouting,
        canRoute: r.canRoute,
      });
      return routedAgent ? { routedAgent } : {};
    },
    [],
  );

  // Reads the routing ref (set above): the adapter resolves the upload cap
  // against the agent the COMPOSER currently targets — on a multi-instance chat the
  // last-send scope would apply the WRONG gateway's frame limit after a switch
  // (codex P2: reject a file the target accepts / accept one it rejects).
  const attachmentAdapter = useMemo(
    () =>
      createConvexAttachmentAdapter(
        convex,
        (msg) => toast.error(msg),
        chatId,
        () => routingRef.current.nextTarget,
      ),
    [convex, toast, chatId],
  );

  // Overlay the live streaming text onto its message (keyed by messageId — robust
  // to >1 in-flight stream, e.g. a mid-turn queue). Only while the message is
  // STILL streaming: once listByChat reports it `complete`, we show the
  // authoritative message.text and ignore any (possibly stale) live row — the
  // status-keyed handoff that keeps the transition seamless.
  const list = useMemo(() => {
    const base = messages ?? [];
    if (!streamingRows || streamingRows.length === 0) return base;
    // Key by the raw string id: getStreamingText returns the branded Id<"messages">
    // while ConvexMessageView carries our loose ConvexId — same value at runtime.
    const liveByMsg = new Map<
      string,
      {
        text: string;
        chunkSeq?: number;
        phase?: string;
        phaseRetry?: { attempt: number; maxAttempts: number };
      }
    >(
      streamingRows.map((r) => [
        r.messageId as string,
        {
          text: r.text,
          chunkSeq: r.chunkSeq,
          phase: (r as { phase?: string }).phase,
          // The back-off counter travels WITH its phase; separating them is how
          // a label ends up reading "2/10" during a turn that already resumed.
          phaseRetry: (r as { phaseRetry?: { attempt: number; maxAttempts: number } })
            .phaseRetry,
        },
      ]),
    );
    return base.map((msg) => {
      if (msg.status !== "streaming") return msg;
      const id = msg._id as string;
      const reactive = liveByMsg.get(id);
      // ANNOUNCE MERGE in progress (the bubble was reopened by a sub-agent
      // delivery): the raw announce stream is a DRAFT — the parent model
      // deliberates, duplicates and recomposes its text mid-run (live
      // 2026-07-19: a finished-looking report rewrote itself twice). Never
      // stream that draft: keep the parked message text stable and let the
      // finalize reveal the definitive report in ONE step (finalize patches
      // text + status in one mutation, so the reveal is atomic). The phase
      // overlay still applies — the placeholder needs it.
      if (typeof msg.runId === "string" && msg.runId.startsWith("announce:v1:")) {
        // The counter travels WITH the phase on this branch too — merging one
        // without the other is the same drop, one layer further down.
        const phase = reactive?.phase;
        const phaseRetry = reactive?.phaseRetry;
        return phase !== undefined ? { ...msg, phase, phaseRetry } : msg;
      }
      // SSE transport: when active for THIS message, the SSE text drives the display —
      // BUT only once it has CAUGHT UP to the reactive frontier seq. A fresh connection
      // after a mid-stream reload replays from cursor 0, so its lastSeq trails the frontier
      // briefly; show the reactive text until then (no regression). Once caught up, the SSE
      // wins even when SHORTER — so a `replace`/snapshot revision is honored over a stale or
      // lagging reactive row (seq, not length — Codex review). chunkSeq is the NEXT seq, so
      // the latest written = chunkSeq - 1.
      // `sse.messageId === sseMessageId` rejects STALE state: the hook resets only after the
      // next render, so on a chat/turn/transport switch the previous message's text would
      // otherwise flash on the new one for a frame (Codex review).
      // `generationKey` additionally rejects the CLOSED generation's state on
      // an announce-merge reopen (same messageId, fresh live row).
      if (
        sse !== null &&
        sse.messageId === sseMessageId &&
        sse.generationKey === sseGenerationKey &&
        id === sseMessageId
      ) {
        const reactiveFrontier = (reactive?.chunkSeq ?? 1) - 1;
        const caughtUp = sse.lastSeq >= reactiveFrontier;
        return {
          ...msg,
          text: caughtUp ? sse.text : (reactive?.text ?? sse.text),
          ...(reactive?.phase !== undefined ? { phase: reactive.phase } : {}),
          ...(reactive?.phaseRetry !== undefined ? { phaseRetry: reactive.phaseRetry } : {}),
        };
      }
      if (reactive !== undefined)
        return {
          ...msg,
          text: reactive.text,
          ...(reactive.phase !== undefined ? { phase: reactive.phase } : {}),
          ...(reactive.phaseRetry !== undefined ? { phaseRetry: reactive.phaseRetry } : {}),
        };
      return msg;
    });
  }, [messages, streamingRows, sse, sseMessageId]);
  // ── Codex-style queue dock: a turn parked in the outbox QUEUE is NOT part
  // of the conversation yet — it renders as a card ABOVE the composer (where
  // the user can still cancel/edit it), never as a thread bubble. The echo of
  // a queue-send (no outbox yet) is matched via the client ids queueSend
  // recorded, so the card appears instantly without a bubble flash.
  const queuedEchoIds = useRef<Set<string>>(new Set());
  const isQueuedTurn = (m: ConvexMessageView): boolean =>
    m.role === "user" &&
    (m.outbox?.status === "queued" ||
      queuedEchoIds.current.has(String(m._id)));
  const queuedTurns = list.filter(isQueuedTurn).map((m) => ({
    messageId: String(m._id),
    text: m.text,
    // Rewriting is its author's alone; withdrawing, its author's or the owner's
    // (convex/send.ts). The optimistic echo is always the reader's own.
    mine: (m as { mine?: boolean }).mine !== false,
    canCancel: (m as { mine?: boolean }).mine !== false || !isGuest,
    // The optimistic echo has no server row yet — its card shows but its
    // actions arm only once the real id lands (no `optimistic-` prefix).
    pending: String(m._id).startsWith("optimistic-"),
  }));
  const visibleList = useMemo(
    () => list.filter((m) => !isQueuedTurn(m)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isQueuedTurn reads a ref
    [list],
  );
  const lastRole =
    visibleList.length > 0 ? visibleList[visibleList.length - 1].role : null;
  const anyStreaming = visibleList.some((m) => m.status === "streaming");

  // "A turn I sent this session is awaiting its first assistant message."
  // This — NOT "the last message is a user message" — is what drives the gap
  // indicator + the double-send gate. Keying on an actual send avoids two false
  // positives the naive last-role check has (red-team): a chat LOADED ending in a
  // user turn would show a phantom "thinking" + lock the composer; and a turn the
  // gateway silently never answers would lock it forever.
  const [pendingSince, setPendingSince] = useState<number | null>(null);

  // Reset on chat switch (the hook is reused across chats, not remounted) so a
  // send in chat A never marks chat B as awaiting.
  useEffect(() => {
    setPendingSince(null);
  }, [chatId]);

  // PRIMARY clear (authoritative + reactive): the instant an assistant message
  // is the last one, the turn is answered — success OR failDispatch's terminal
  // error bubble. No timer involved in the common path. Depends on `list` (not
  // just lastRole) so a truncation that leaves an assistant message last —
  // lastRole unchanged, no transition — still releases the gate.
  useEffect(() => {
    if (lastRole === "assistant") setPendingSince(null);
  }, [lastRole, list]);

  // SAFETY escape hatch ONLY: if the gateway accepts the send but never emits a
  // reply (post-accept silence), the primary clear never fires — without this the
  // composer would stay locked forever. Long enough (120s) NOT to trip on a
  // legitimately slow time-to-first-token. (The real fix is a server-side outbox
  // watchdog; out of scope here.)
  useEffect(() => {
    if (pendingSince === null) return;
    const t = window.setTimeout(() => setPendingSince(null), 120000);
    return () => window.clearTimeout(t);
  }, [pendingSince]);

  // A turn is mid-flight while EITHER an assistant message is streaming OR a send
  // is awaiting its first reply. This flips the composer Send->disabled (closes
  // the double-send hole — Nielsen heuristic #1) AND triggers assistant-ui's
  // upcoming-message placeholder, which RunStatus renders as the thinking label
  // (m.runstatus_thinking) to fill the gap (see runStatusView's `undefined` case).
  const isRunning = pendingSince !== null || anyStreaming;

  // The LAST user turn is parked in the mid-turn QUEUE (its outbox is `queued`),
  // parked BEHIND the in-flight turn. assistant-ui still shows a synthetic
  // upcoming-message placeholder after it (isRunning is true because the OTHER turn
  // streams) — misleadingly "processing". RunStatus reads this to label that
  // placeholder "En attente" instead. Only the LAST user turn can be the queued one
  // the placeholder follows.
  // With queued turns extracted to the dock, no thread bubble is queued any
  // more — the placeholder-label special case only applies while a queued turn
  // exists (dock non-empty) and nothing streams.
  const lastUserTurnQueued = queuedTurns.length > 0 && !anyStreaming;

  // Memoized SEPARATELY from the adapter: assistant-ui clears its per-message
  // conversion cache whenever convertMessage's identity changes, so an inline
  // lambda here would reconvert the whole thread on EVERY streamed delta
  // (`list` changes per token; `messageAgents` only when the message SET does).
  const importedAgentLabels = useMemo(
    () => resolveImportedAgentLabels(messages ?? []),
    [messages],
  );
  const convertWithAgents = useCallback(
    (msg: ConvexMessageView) =>
      convertConvexMessage(
        msg,
        messageAgents.get(msg._id) ?? null,
        importedAgentLabels.get(msg._id) ?? null,
      ),
    [messageAgents, importedAgentLabels],
  );

  const adapter = useMemo<ExternalStoreAdapter<ConvexMessageView>>(() => {
    return {
      messages: visibleList,
      isRunning,
      convertMessage: convertWithAgents,

      // New user turn: persist to Convex; the bridge picks it up from the
      // outbox and forwards it to OpenClaw. No HTTP streaming round-trip here —
      // the assistant reply arrives via the reactive query.
      onNew: async (message: AppendMessage) => {
        if (!chatId) throw new Error("No chat selected");
        const text = message.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");

        // Build the {storageId, filename, mimeType}[] shape that
        // api.send.sendMessage validates (NOT a bare storage-id string[]). The
        // storage ids are opaque strings client-side; the generated mutation
        // validator brands them as Id<"_storage">, so we assert that type here.
        const attachments = attachmentParts(message.attachments).map((a) => ({
          storageId: a.storageId as Id<"_storage">,
          filename: a.filename,
          mimeType: a.mimeType,
          ...(a.origin ? { origin: a.origin } : {}),
        }));

        // QUOTE-REPLY: consume THIS chat's staged passages exactly once — the
        // per-chat keying means a quote staged in another chat can never ride
        // this send.
        const quotes = takePendingQuotes(chatId);
        // MENTIONS: consumed like the quotes, but their offsets are computed HERE,
        // against the text as it is about to be sent — a span captured when the
        // person was picked would have drifted with every keystroke since. A token
        // the writer deleted resolves to nothing and the mention goes with it.
        const {
          staged: stagedMentions,
          mentions: resolved,
          agentMentions,
        } = takeMentionsForSend(chatId, text);
        const mentions = resolved.map((m) => ({
          userId: m.userId as Id<"users">,
          start: m.start,
          end: m.end,
        }));
        // MULTI-AGENT: WHO the turn is for — the agents it mentions (each answers in
        // turn), else the primary where there is a choice. Authorized + stamped
        // server-side.
        const address = computeTurnAddress(agentMentions);

        // Mark the turn in-flight IMMEDIATELY (before the await) so isRunning
        // flips this frame — the optimistic echo + gap indicator + double-send
        // gate all engage without waiting on the round-trip. Cleared when the
        // reply lands (or the safety timeout) — see the effects above.
        setPendingSince(Date.now());

        // clientMessageId is REQUIRED and is the server-side idempotency key:
        // the Convex client may transparently retry a mutation on a transient
        // failure, and `sendMessage` dedupes on it so a retry never
        // double-inserts the user message or double-dispatches to the bridge.
        try {
          await sendMessage({
            chatId: chatId as Id<"chats">,
            text,
            clientMessageId: crypto.randomUUID(),
            attachments,
            ...address,
            ...(quotes.length > 0
              ? {
                  quotes: quotes.map((q) => ({
                    messageId: q.messageId as Id<"messages">,
                    blockIndex: q.blockIndex,
                    excerpt: q.excerpt,
                  })),
                }
              : {}),
            ...(mentions.length > 0 ? { mentions } : {}),
          });
        } catch (e) {
          // Same rule as the quotes: a failed send must not silently un-name the
          // people the writer chose. Restored by TOKEN, so a retry re-resolves the
          // spans against whatever the text is then.
          restorePendingMentions(chatId, stagedMentions);
          // Restage the passages so a failed send does not silently drop the
          // user's "replying to" references — but never clobber quotes staged
          // while this send was in flight (restoring on top would REORDER them,
          // and could exceed the bound), and never restage quotes the SERVER
          // rejected as invalid (deleted target, over budget): that would wedge
          // every retry behind the same rejection (codex P2).
          // A stale anchor is NOT a reason to lose the whole selection: drop
          // the passages the server named as gone, give the rest back, and say
          // what changed. Anything the merge could not fit is reported too —
          // never dropped quietly.
          if (!quotesRejectedOutright(e)) {
            const gone = goneQuoteTargets(e);
            const outcome = restorePendingQuotesExcept(chatId, quotes, gone);
            if (outcome.gone > 0) {
              toast.error(
                m.quote_reply_target_dropped({ count: outcome.gone }),
              );
            }
            if (outcome.dropped > 0) {
              toast.error(
                m.quote_reply_restore_dropped({ count: outcome.dropped }),
              );
            }
          }
          // The agents it mentions could not be addressed: said, so the writer knows
          // the text is intact and only the addressing needs fixing.
          const addressing = agentAddressFailure(e);
          if (addressing !== null) {
            toast.error(
              addressing === "too_many"
                ? m.chat_send_agents_too_many()
                : m.chat_send_agents_invalid(),
            );
          }
          // A command (`/…`) is sent exactly as typed and cannot carry files: said, so
          // the writer removes them or sends them apart (convex/lib/gatewayCommand.ts).
          if (commandWithFilesRefused(e)) toast.error(m.chat_send_command_with_files());
          // The mutation rejected BEFORE the server accepted the turn (validation,
          // auth, transient client failure). No assistant reply will arrive, so
          // the reactive clear can't fire — release the in-flight gate now instead
          // of locking the composer until the 120s safety timeout. Convex rolls
          // back the optimistic echo; re-throw so assistant-ui surfaces the error.
          setPendingSince(null);
          throw e;
        }
      },

      adapters: {
        attachments: attachmentAdapter,
      },
    };
  }, [list, isRunning, chatId, sendMessage, attachmentAdapter, computeTurnAddress]);

  // Stable identity: the gate is consumed through context by every message row.
  const turnGate = useMemo<TurnGate>(
    () => ({
      begin: () => setPendingSince(Date.now()),
      cancel: () => setPendingSince(null),
    }),
    [],
  );

  // MID-TURN QUEUE (Phase 1): send a follow-up WHILE a turn is in flight. Unlike
  // `onNew`, this must NOT touch `pendingSince` — the in-flight gate belongs to
  // the CURRENT turn; this message is serialized SERVER-SIDE (parked as a `queued`
  // outbox row) and auto-dispatched when that turn ends. The optimistic echo (the
  // same `sendMessage` updater) makes the queued user message appear instantly,
  // below the streaming reply. Returns true if accepted, false if rejected
  // (e.g. QUEUE_FULL) so the caller can keep the text for a retry.
  const abortTurnMutation = useMutation(api.messages.abortTurn);

  const cancelQueuedMutation = useMutation(api.send.cancelQueuedMessage);
  const cancelQueued = useCallback(
    async (messageId: string): Promise<boolean> => {
      try {
        await cancelQueuedMutation({ messageId: messageId as Id<"messages"> });
        return true;
      } catch {
        // Promoted in the meantime: the turn is in flight — the dock row
        // disappears reactively; nothing actionable.
        toast.error(m.chat_queue_too_late());
        return false;
      }
    },
    [cancelQueuedMutation, toast],
  );

  const queueSend = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!chatId || trimmed === "") return false;
      const quotes = takePendingQuotes(chatId);
      // MENTIONS: the same consumption as onNew — a person picked while a turn
      // runs is named in the follow-up that queues, not sent as plain text.
      const {
        staged: stagedMentions,
        mentions: resolved,
        agentMentions,
      } = takeMentionsForSend(chatId, text);
      // MULTI-AGENT: a queued follow-up is addressed by the SAME rule.
      const address = computeTurnAddress(agentMentions);
      const mentions = resolved.map((m) => ({
        userId: m.userId as Id<"users">,
        start: m.start,
        end: m.end,
      }));
      const clientMessageId = crypto.randomUUID();
      // Route the optimistic echo to the QUEUE DOCK (not the thread): the echo
      // id is deterministic (optimistic-<clientMessageId>).
      queuedEchoIds.current.add(`optimistic-${clientMessageId}`);
      try {
        await sendMessage({
          chatId: chatId as Id<"chats">,
          text,
          clientMessageId,
          ...address,
          ...(quotes.length > 0
            ? {
                quotes: quotes.map((q) => ({
                  messageId: q.messageId as Id<"messages">,
                  blockIndex: q.blockIndex,
                  excerpt: q.excerpt,
                })),
              }
            : {}),
          ...(mentions.length > 0 ? { mentions } : {}),
        });
        return true;
      } catch (e) {
        restorePendingMentions(chatId, stagedMentions);
        // Same restage rules as onNew: never clobber a newer staged quote,
        // never restage a server-rejected (invalid-target) one.
        // A stale anchor is NOT a reason to lose the whole selection: drop
        // the passages the server named as gone, give the rest back, and say
        // what changed. Anything the merge could not fit is reported too —
        // never dropped quietly.
        if (!quotesRejectedOutright(e)) {
          const gone = goneQuoteTargets(e);
          const outcome = restorePendingQuotesExcept(chatId, quotes, gone);
          if (outcome.gone > 0) {
            toast.error(
              m.quote_reply_target_dropped({ count: outcome.gone }),
            );
          }
          if (outcome.dropped > 0) {
            toast.error(
              m.quote_reply_restore_dropped({ count: outcome.dropped }),
            );
          }
        }
        const failure = (e as Error)?.message ?? "";
        // The agents it mentions could not be addressed (agentAddressFailure).
        const addressing = agentAddressFailure(e);
        toast.error(
          addressing === "too_many"
            ? m.chat_send_agents_too_many()
            : addressing === "invalid"
            ? m.chat_send_agents_invalid()
            : failure.includes("QUEUE_FULL")
            ? m.chat_queue_full()
            : commandWithFilesRefused(e)
            ? m.chat_send_command_with_files()
            : // A voice call pins this chat's agent. The selector normally says so
              // BEFORE the click — but not for a reader who has no selector: a
              // single-agent participant sees no picker and no voice control, so the
              // refusal reached them as the generic "send failed" with nothing to act
              // on (codex P2, pass 8). Named here, where every send failure passes.
              //
              // ITS OWN STRING, not the selector's tooltip: that one says "the agent
              // cannot be changed — hang up first", and this reader changed nothing
              // and cannot hang up a call that is not theirs. It states what actually
              // happened to their message instead.
              failure.includes("TALK_CALL_ACTIVE")
              ? m.chat_send_call_active()
              : m.chat_queue_failed(),
        );
        return false;
      }
    },
    [chatId, sendMessage, toast, computeTurnAddress],
  );

  // The per-turn router surface the chat UI consumes (composer selector + the
  // per-message attribution chip). `messageAgents`/`fallbackAgent` resolve WHO
  // answered each message; `nextTarget` is where the next message goes.
  const routing = useMemo(
    () => ({
      // The user's entitled pool (selector list + chip display names) — narrowed
      // to the room's agents for a guest.
      pool,
      // The agents the owner added to this conversation (not the primary).
      roomAgents,
      multiAgent,
      perTurnRouting,
      emptyThread,
      primary,
      nextTarget,
      messageAgents,
      // The in-flight assistant PLACEHOLDER has a synthetic id absent from
      // messageAgents — fall back to the just-routed agent so it does not flash
      // the wrong identity before the real message lands.
      fallbackAgent: defaultAgent,
    }),
    [
      pool,
      roomAgents,
      multiAgent,
      perTurnRouting,
      emptyThread,
      primary,
      nextTarget,
      messageAgents,
      defaultAgent,
    ],
  );

  // The STOP button: settle the active turn instantly (server-side optimistic
  // finalize) and best-effort kill the gateway run. Releases the local pending
  // gate too, so the composer unfreezes even if the reactive flip lags.
  const abortTurn = useCallback(async (): Promise<void> => {
    if (!chatId) return;
    try {
      const res = await abortTurnMutation({ chatId: chatId as Id<"chats"> });
      if (res.ok) {
        setPendingSince(null);
        return;
      }
      // No streaming message yet (the turn is still dispatching): releasing
      // the gate here would let a second send race a turn that is NOT stopped.
      // Keep the composer held and tell the user to retry in a moment.
      toast.error(m.chat_stop_too_early());
    } catch (e) {
      // The turn keeps running — keep the gate held (honest UI).
      toast.error(m.chat_stop_failed(), e);
    }
  }, [chatId, abortTurnMutation, toast]);

  return {
    runtime: useExternalStoreRuntime(adapter),
    turnGate,
    queueSend,
    abortTurn,
    routing,
    lastUserTurnQueued,
    // The queue dock's data + actions (cards above the composer).
    queuedTurns,
    cancelQueued,
    // TRUE until listByChat first responds for this chat: drives the loading
    // skeleton (without it a content-heavy chat looks EMPTY for the 2-3s the
    // payload takes to arrive, reading as "is anything happening?").
    initialLoading: messagesLoading,
  };
}

/** The per-turn router surface returned by useConvexChatRuntime (see `routing`). */
export type ChatRouting = ReturnType<typeof useConvexChatRuntime>["routing"];
