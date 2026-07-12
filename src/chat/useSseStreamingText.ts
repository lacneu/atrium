import { useEffect, useRef, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { convexSiteUrl } from "@/lib/runtimeConfig";
import {
  parseSseBuffer,
  applySseEvent,
  chunkTimingId,
  EMPTY_SSE_ACCUM,
} from "./sseStream";

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
  // Stream GENERATION key (the live row's id): a reopened message (announce
  // merge) keeps its messageId but gets a fresh live row — without this in the
  // effect deps, the finished previous connection's stale state would shadow
  // the new stream until its final.
  generationKey: string | null,
  enabled: boolean,
  // Called with a chunk's (recTimingId, seq) the moment it ARRIVES over SSE (during a
  // recording), so the delivery recorder can stamp t4 on the SSE leg. The seq lets the runtime
  // gate on the chunk being at/past the displayed frontier (skip replay). Held in a ref so a
  // changing callback identity never reconnects the stream.
  onTimingSample?: (timingId: string, seq: number) => void,
): {
  text: string;
  lastSeq: number;
  messageId: string;
  generationKey: string | null;
} | null {
  const token = useAuthToken();
  const onSampleRef = useRef(onTimingSample);
  onSampleRef.current = onTimingSample;
  // Carries `lastSeq` (so the runtime can tell a REPLAYING connection from one at the
  // frontier) AND the `messageId` the text belongs to — the effect resets state only AFTER
  // the next render, so on a message/transport switch the stale previous-message text would
  // otherwise be applied to the new message for one frame (a cross-conversation flash). The
  // runtime gates on `messageId` to ignore stale state (Codex review). null = reactive.
  const [state, setState] = useState<{
    text: string;
    lastSeq: number;
    messageId: string;
    // The stream GENERATION this state belongs to — a reopened message (same
    // messageId, fresh live row) resets the effect only AFTER a render, so
    // the runtime must be able to reject the closed generation's state.
    generationKey: string | null;
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
            for (const ev of parsed.events) {
              accum = applySseEvent(accum, ev);
              // Recorder (Phase 5): a chunk carrying a recTimingId means a recording is
              // active — stamp t4 at THIS receipt (the displayed SSE leg) via the callback.
              const tid = chunkTimingId(ev);
              // Recorder (Phase 5): the SSE sample's t4 is stamped HERE, at parse — so under
              // main-thread load it reads up to one render cycle EARLY vs the reactive leg
              // (stamped in its effect). A residual bias WITHIN the recorder's existing
              // approximation (single-ping skew, effect-not-paint timing); accepted, not chased.
              if (tid !== null) onSampleRef.current?.(tid, ev.id ?? 0);
            }
            if (!cancelled)
              setState({
                text: accum.text,
                lastSeq: accum.lastSeq,
                messageId: streamingMessageId,
                generationKey,
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
  }, [enabled, streamingMessageId, token, generationKey]);

  return state;
}
