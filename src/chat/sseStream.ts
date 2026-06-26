// Pure parser for the SSE / streamable-HTTP transport the frontend consumes from
// /api/v1/message-stream (Plan B Phase 3). Kept free of React/fetch so the
// chunk-accumulation logic is unit-testable; the fetch + reconnect live in
// useSseStreamingText.ts. See openclaw-notes/docs/atrium/convex-http-streaming-transport.md.
//
// Wire format (from convex/http.ts): per chunk `id: <seq>\ndata: {kind,text}\n\n`;
// `event: final\ndata: {text}\n\n` (authoritative final text); `event: done\ndata: {}\n\n`.

export type SseEvent = { id?: number; event?: string; data: string };

/**
 * Split a raw decoded buffer into COMPLETE SSE events (separated by a blank line)
 * plus the leftover incomplete trailing block, which the caller carries into the
 * next read. CRLF-tolerant.
 */
export function parseSseBuffer(buffer: string): {
  events: SseEvent[];
  rest: string;
} {
  const events: SseEvent[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? ""; // trailing block has no boundary yet — incomplete
  for (const block of blocks) {
    if (block.trim() === "") continue;
    const ev: SseEvent = { data: "" };
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) {
        const n = Number.parseInt(line.slice(3).trim(), 10);
        if (Number.isFinite(n)) ev.id = n;
      } else if (line.startsWith("event:")) {
        ev.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    ev.data = dataLines.join("\n");
    events.push(ev);
  }
  return { events, rest };
}

// The accumulated live-stream state. `lastSeq` is the resume cursor (Last-Event-ID).
export type SseAccum = { text: string; lastSeq: number; done: boolean };

export const EMPTY_SSE_ACCUM: SseAccum = { text: "", lastSeq: 0, done: false };

/**
 * Apply one parsed SSE event to the accumulator (pure). A chunk's `append` concatenates,
 * `replace` resets the text; `event: final` sets the authoritative final text; `event:
 * done` ends. Malformed/empty events are ignored (best-effort display).
 */
export function applySseEvent(state: SseAccum, ev: SseEvent): SseAccum {
  if (ev.event === "done") return { ...state, done: true };
  if (ev.event === "final") {
    try {
      const d = JSON.parse(ev.data) as { text?: unknown };
      if (typeof d.text === "string") return { ...state, text: d.text };
    } catch {
      /* ignore a malformed final */
    }
    return state;
  }
  if (ev.data === "") return state;
  try {
    const c = JSON.parse(ev.data) as { kind?: unknown; text?: unknown };
    if (typeof c.text !== "string") return state;
    const text = c.kind === "replace" ? c.text : state.text + c.text;
    return { ...state, text, lastSeq: ev.id ?? state.lastSeq };
  } catch {
    return state;
  }
}
