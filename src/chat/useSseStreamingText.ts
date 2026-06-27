import { useEffect, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { convexSiteUrl } from "@/lib/runtimeConfig";
import { parseSseBuffer, applySseEvent, EMPTY_SSE_ACCUM } from "./sseStream";

// Phase 4b: the SSE transport is chosen PER GATEWAY-INSTANCE (the chat's instance config,
// resolved server-side by getChatStreamTransport; the runtime passes the result as
// `enabled`). This DEV-only override lets local testing force SSE on without touching the
// instance config. See openclaw-notes/docs/atrium/convex-http-streaming-transport.md.
export function sseDevOverride(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem("oc_sse") === "1";
  } catch {
    return false;
  }
}

/**
 * Consume the live token stream for `streamingMessageId` over SSE (Plan B). Returns the
 * accumulated live text, or null when disabled / no streaming message / no auth / no site
 * URL — the caller then FALLS BACK to the reactive streamingRows text, so the SSE path is
 * purely additive. Reconnects with `Last-Event-ID` if the server closes mid-turn (its
 * lifetime deadline); aborts the fetch on unmount or when the streaming message changes.
 */
export function useSseStreamingText(
  streamingMessageId: string | null,
  enabled: boolean,
): { text: string; lastSeq: number; messageId: string } | null {
  const token = useAuthToken();
  // Carries `lastSeq` (so the runtime can tell a REPLAYING connection from one at the
  // frontier) AND the `messageId` the text belongs to — the effect resets state only AFTER
  // the next render, so on a message/transport switch the stale previous-message text would
  // otherwise be applied to the new message for one frame (a cross-conversation flash). The
  // runtime gates on `messageId` to ignore stale state (Codex review). null = reactive.
  const [state, setState] = useState<{
    text: string;
    lastSeq: number;
    messageId: string;
  } | null>(null);

  useEffect(() => {
    const site = convexSiteUrl();
    if (!enabled || !streamingMessageId || !token || !site) {
      setState(null);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    let accum = EMPTY_SSE_ACCUM;
    // Reset to null (NOT "") so the reactive streamingRows fallback keeps showing the
    // already-live text until the SSE replay delivers the first chunk for THIS message —
    // else a fresh attach (reload / tab switch / active stream during deploy) would blank
    // it until the replay catches up (Codex review).
    setState(null);

    void (async () => {
      while (!cancelled && !accum.done) {
        try {
          const res = await fetch(
            `${site}/api/v1/message-stream?messageId=${encodeURIComponent(streamingMessageId)}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                ...(accum.lastSeq > 0
                  ? { "Last-Event-ID": String(accum.lastSeq) }
                  : {}),
              },
              signal: ctrl.signal,
            },
          );
          if (!res.ok || !res.body) {
            // Auth/endpoint failure -> null (NOT "") so the runtime FALLS BACK to the
            // reactive streamingRows path instead of showing an empty message.
            setState(null);
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buffer = "";
          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += dec.decode(value, { stream: true });
            const parsed = parseSseBuffer(buffer);
            buffer = parsed.rest;
            for (const ev of parsed.events) accum = applySseEvent(accum, ev);
            if (!cancelled)
              setState({
                text: accum.text,
                lastSeq: accum.lastSeq,
                messageId: streamingMessageId,
              });
            if (accum.done) break;
          }
        } catch {
          if (cancelled) return; // aborted on unmount/message change
          // Network error -> fall back to reactive (null) while we back off + reconnect;
          // a successful reconnect restores the SSE text from lastSeq.
          setState(null);
        }
        if (accum.done || cancelled) break;
        // Stream ended WITHOUT `done` (server lifetime deadline) -> brief backoff, then
        // reconnect from lastSeq. The turn is still live; the client resumes seamlessly.
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [enabled, streamingMessageId, token]);

  return state;
}
