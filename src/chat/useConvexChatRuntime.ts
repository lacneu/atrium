import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useSseStreamingText, sseDevOverride } from "./useSseStreamingText";
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
        role: "user" as const,
        // `complete` keeps the status switches simple; the "sending…" affordance
        // keys off the `optimistic-` id prefix instead (see convertMessage), so no
        // MessageStatus enum surgery / gate-logic risk.
        status: "complete" as const,
        runId: undefined,
        error: undefined,
        errorCode: undefined, // optimistic user echo never carries a dispatch code
        attachedDocCount: undefined, // a user echo never has attachments
        text: args.text,
        updatedAt: now,
        // Attachments reconcile a beat later with their server-signed URL; the
        // instant echo carries the text (the primary case). Empty is fine — the
        // converter renders the text bubble immediately.
        parts: [] as (typeof base)[number]["parts"],
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
  const sse = useSseStreamingText(sseMessageId, sseEnabled);

  const attachmentAdapter = useMemo(
    () =>
      createConvexAttachmentAdapter(
        convex,
        (msg) => toast.error(msg),
        chatId,
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
    const liveByMsg = new Map<string, { text: string; chunkSeq?: number }>(
      streamingRows.map((r) => [
        r.messageId as string,
        { text: r.text, chunkSeq: r.chunkSeq },
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
      if (sse !== null && sse.messageId === sseMessageId && id === sseMessageId) {
        const reactiveFrontier = (reactive?.chunkSeq ?? 1) - 1;
        const caughtUp = sse.lastSeq >= reactiveFrontier;
        return {
          ...msg,
          text: caughtUp ? sse.text : (reactive?.text ?? sse.text),
        };
      }
      if (reactive !== undefined) return { ...msg, text: reactive.text };
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
  // upcoming-message placeholder, which RunStatus renders as "Réflexion…" to fill
  // the gap (see runStatusView's `undefined` case).
  const isRunning = pendingSince !== null || anyStreaming;

  const adapter = useMemo<ExternalStoreAdapter<ConvexMessageView>>(() => {
    return {
      messages: list,
      isRunning,
      convertMessage: convertConvexMessage,

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
        }));

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
  }, [list, isRunning, chatId, sendMessage, attachmentAdapter]);

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
  const queueSend = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!chatId || trimmed === "") return false;
      try {
        await sendMessage({
          chatId: chatId as Id<"chats">,
          text,
          clientMessageId: crypto.randomUUID(),
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
    [chatId, sendMessage, toast],
  );

  return { runtime: useExternalStoreRuntime(adapter), turnGate, queueSend };
}
