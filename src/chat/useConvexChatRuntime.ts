import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useToast } from "@/components/ui/toast";
import {
  isFirstTurn,
  lastRoutedAgent,
  resolveEffectiveSelection,
  resolveMessageAgents,
  resolveRoutedAgentToSend,
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
        routedInstanceName: args.routedAgent?.instanceName,
        routedAgentId: args.routedAgent?.agentId,
        // A user echo is never a merged bubble; key present to match the
        // query's inferred shape.
        hasMergedRuns: false,
        // Attachments reconcile a beat later with their server-signed URL; the
        // instant echo carries the text (the primary case). Empty is fine — the
        // converter renders the text bubble immediately.
        parts: [] as (typeof base)[number]["parts"],
        // No outbox row yet at echo time (the mutation creates it on commit); the real
        // message that replaces this echo carries the queued/pending/sent status.
        outbox: null,
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
  const poolLoading = myAgents === undefined;
  const pool = useMemo(() => myAgents ?? [], [myAgents]);
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

  // The composer's explicit per-turn pick (null = use the derived default). Reset
  // on chat switch (the hook is reused across chats, not remounted).
  const [selectedAgent, setSelectedAgent] = useState<AgentRef | null>(null);
  useEffect(() => {
    setSelectedAgent(null);
  }, [chatId]);

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
  // Default selection = the thread's last-used agent, else the chat's primary —
  // gated by canRoute, loading-aware, and pool-filtered (see resolveEffectiveSelection).
  // Also the placeholder chip's fallback (the in-flight turn's just-routed agent).
  const defaultAgent = useMemo<AgentRef | null>(
    () =>
      resolveEffectiveSelection({
        selected: null,
        lastRouted: threadLastRouted,
        primary,
        pool,
        poolLoading,
        messagesLoading,
        canRoute,
      }),
    [threadLastRouted, primary, pool, poolLoading, messagesLoading, canRoute],
  );
  // Effective composer selection: the explicit pick if set, else the thread
  // default. ONE helper enforces all the edge rules — never for a single-agent user
  // (canRoute), preserve the last-routed agent while the pool OR messages load, and
  // drop a stale explicit pick OR stale last-routed once both are known.
  const effectiveSelected = useMemo<AgentRef | null>(
    () =>
      resolveEffectiveSelection({
        selected: selectedAgent,
        lastRouted: threadLastRouted,
        primary,
        pool,
        poolLoading,
        messagesLoading,
        canRoute,
      }),
    [selectedAgent, threadLastRouted, primary, pool, poolLoading, messagesLoading, canRoute],
  );
  // First turn? (loading-aware — see isFirstTurn). Drives the send-rule's "never
  // route turn 1": while messages load this is FALSE (we don't yet know the
  // history), so an already-perTurnRouting chat is not misread as turn 1.
  const firstTurn = isFirstTurn(messages);
  // Has the chat had a user turn yet? Gates the selector (meaningless on turn 1 —
  // the agent is bound at creation). Loading → false (selector stays disabled until
  // we know there is a turn). Distinct from `firstTurn` (which is loading-aware for
  // the SEND decision); here a conservative disable during load is the safe choice.
  const hasUserTurn = useMemo(
    () => (messages ?? []).some((mm) => mm.role === "user"),
    [messages],
  );

  // onNew / queueSend run from memoized closures; read the live routing inputs via
  // refs so a selection change never has to rebuild the runtime adapter.
  const routingRef = useRef<{
    selected: AgentRef | null;
    primary: AgentRef | null;
    perTurnRouting: boolean;
    isFirstTurn: boolean;
    canRoute: boolean;
  }>({
    selected: null,
    primary: null,
    perTurnRouting: false,
    isFirstTurn: false,
    canRoute: false,
  });
  routingRef.current = {
    selected: effectiveSelected,
    primary,
    perTurnRouting,
    isFirstTurn: firstTurn,
    canRoute,
  };
  // The routedAgent (if any) to send for a turn — the single-agent-path rule.
  const computeRoutedAgent = useCallback((): AgentRef | undefined => {
    const r = routingRef.current;
    return resolveRoutedAgentToSend({
      selected: r.selected,
      primary: r.primary,
      perTurnRouting: r.perTurnRouting,
      isFirstTurn: r.isFirstTurn,
      canRoute: r.canRoute,
    });
  }, []);

  // Defined AFTER computeRoutedAgent (TDZ): the adapter resolves the upload cap
  // against the agent the COMPOSER currently targets — on a multi-instance chat the
  // last-send scope would apply the WRONG gateway's frame limit after a switch
  // (codex P2: reject a file the target accepts / accept one it rejects).
  const attachmentAdapter = useMemo(
    () =>
      createConvexAttachmentAdapter(
        convex,
        (msg) => toast.error(msg),
        chatId,
        () => computeRoutedAgent() ?? null,
      ),
    [convex, toast, chatId, computeRoutedAgent],
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
      { text: string; chunkSeq?: number; phase?: string }
    >(
      streamingRows.map((r) => [
        r.messageId as string,
        {
          text: r.text,
          chunkSeq: r.chunkSeq,
          phase: (r as { phase?: string }).phase,
        },
      ]),
    );
    return base.map((msg) => {
      if (msg.status !== "streaming") return msg;
      const id = msg._id as string;
      const reactive = liveByMsg.get(id);
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
        };
      }
      if (reactive !== undefined)
        return {
          ...msg,
          text: reactive.text,
          ...(reactive.phase !== undefined ? { phase: reactive.phase } : {}),
        };
      return msg;
    });
  }, [messages, streamingRows, sse, sseMessageId]);
  const lastRole = list.length > 0 ? list[list.length - 1].role : null;
  const anyStreaming = list.some((m) => m.status === "streaming");

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
  let lastUserTurnQueued = false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "user") {
      lastUserTurnQueued = list[i].outbox?.status === "queued";
      break;
    }
  }

  // Memoized SEPARATELY from the adapter: assistant-ui clears its per-message
  // conversion cache whenever convertMessage's identity changes, so an inline
  // lambda here would reconvert the whole thread on EVERY streamed delta
  // (`list` changes per token; `messageAgents` only when the message SET does).
  const convertWithAgents = useCallback(
    (msg: ConvexMessageView) =>
      convertConvexMessage(msg, messageAgents.get(msg._id) ?? null),
    [messageAgents],
  );

  const adapter = useMemo<ExternalStoreAdapter<ConvexMessageView>>(() => {
    return {
      messages: list,
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

        // MULTI-AGENT: the agent this turn is routed to, per the single-agent-path
        // rule (undefined keeps the unchanged single-agent path — never sent on a
        // normal chat / the very first turn). Authorized + stamped server-side.
        const routedAgent = computeRoutedAgent();

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
            ...(routedAgent ? { routedAgent } : {}),
          });
        } catch (e) {
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
  }, [list, isRunning, chatId, sendMessage, attachmentAdapter, computeRoutedAgent]);

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

  const queueSend = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!chatId || trimmed === "") return false;
      // MULTI-AGENT: a queued follow-up routes by the SAME rule (the chat already
      // has a turn in flight, so it is never the first turn).
      const routedAgent = computeRoutedAgent();
      try {
        await sendMessage({
          chatId: chatId as Id<"chats">,
          text,
          clientMessageId: crypto.randomUUID(),
          ...(routedAgent ? { routedAgent } : {}),
        });
        return true;
      } catch (e) {
        toast.error(
          (e as Error)?.message?.includes("QUEUE_FULL")
            ? m.chat_queue_full()
            : m.chat_queue_failed(),
        );
        return false;
      }
    },
    [chatId, sendMessage, toast, computeRoutedAgent],
  );

  // The per-turn router surface the chat UI consumes (composer selector + the
  // per-message attribution chip). `messageAgents`/`fallbackAgent` resolve WHO
  // answered each message; `selected`/`setSelected` drive the composer pick.
  const routing = useMemo(
    () => ({
      // The user's entitled pool (selector list + chip display names).
      pool,
      multiAgent,
      perTurnRouting,
      hasUserTurn,
      primary,
      selected: effectiveSelected,
      setSelected: setSelectedAgent,
      messageAgents,
      // The in-flight assistant PLACEHOLDER has a synthetic id absent from
      // messageAgents — fall back to the just-routed agent so it does not flash
      // the wrong identity before the real message lands.
      fallbackAgent: defaultAgent,
    }),
    [
      pool,
      multiAgent,
      perTurnRouting,
      hasUserTurn,
      primary,
      effectiveSelected,
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
    // TRUE until listByChat first responds for this chat: drives the loading
    // skeleton (without it a content-heavy chat looks EMPTY for the 2-3s the
    // payload takes to arrive, reading as "is anything happening?").
    initialLoading: messagesLoading,
  };
}

/** The per-turn router surface returned by useConvexChatRuntime (see `routing`). */
export type ChatRouting = ReturnType<typeof useConvexChatRuntime>["routing"];
