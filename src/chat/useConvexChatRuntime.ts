import { useEffect, useMemo, useState } from "react";
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
      // Query not loaded yet (e.g. send before the first read settled): nothing
      // to append to — skip rather than seed a partial cache.
      if (current === undefined) return;
      // Idempotency / double-fire guard: never echo the same logical send twice.
      const echoId = `optimistic-${args.clientMessageId}`;
      if (current.some((m) => m._id === echoId)) return;
      const now = Date.now();
      const optimistic = {
        _id: echoId as Id<"messages">,
        chatId: args.chatId,
        _creationTime: now,
        role: "user" as const,
        status: "complete" as const,
        runId: undefined,
        error: undefined,
        text: args.text,
        updatedAt: now,
        // Attachments reconcile a beat later with their server-signed URL; the
        // instant echo carries the text (the primary case). Empty is fine — the
        // converter renders the text bubble immediately.
        parts: [] as (typeof current)[number]["parts"],
      } satisfies (typeof current)[number];
      localStore.setQuery(api.messages.listByChat, key, [...current, optimistic]);
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

  const attachmentAdapter = useMemo(
    () => createConvexAttachmentAdapter(convex),
    [convex],
  );

  const list = useMemo(() => messages ?? [], [messages]);
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

        // TEMP DIAGNOSTIC (prod file-import investigation): how many attachments
        // survived the adapter and reached the send. `attachments=0` here while a
        // file was attached means the upload path (adapter.send) never completed.
        console.info(
          `[attach] onNew: text.len=${text.length} attachments=${attachments.length} ` +
            `(raw=${message.attachments?.length ?? 0})`,
        );

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

  return { runtime: useExternalStoreRuntime(adapter), turnGate };
}
