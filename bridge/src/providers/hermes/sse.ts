// Minimal, allocation-frugal SSE (Server-Sent Events) frame parser for the
// Hermes gateway's streaming endpoints (`/api/sessions/{id}/chat/stream`,
// `/v1/runs/{id}/events`). Hermes frames are the standard text/event-stream
// shape: `event: <name>` + one-or-more `data: <chunk>` lines, dispatched on a
// blank line. This is a PURE incremental parser (feed bytes as they arrive from
// the fetch body reader) so the client never buffers the whole stream — a long
// agent turn streams through with bounded memory.

/** One dispatched SSE frame: an event name (defaults to "message") + its data
 *  payload (multiple `data:` lines are joined with "\n", per the SSE spec). */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed raw decoded text chunks; it yields complete
 * frames as their terminating blank line arrives. Partial frames are retained
 * across `push()` calls (a chunk boundary can fall mid-line or mid-frame).
 */
export class SseParser {
  private buf = "";
  private event = "";
  private dataLines: string[] = [];

  /** Push a decoded text chunk; returns every frame COMPLETED by this chunk. */
  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const out: SseFrame[] = [];
    // Normalize CRLF/CR to LF so line splitting is uniform (SSE allows all three).
    for (;;) {
      const idx = this.buf.search(/\r\n|\r|\n/);
      if (idx === -1) break;
      // A lone "\r" at the very END of the buffer may be the first half of a
      // "\r\n" split across chunks — WAIT for the next chunk rather than treat
      // it as a line end (which would fabricate a premature blank line and
      // dispatch an event without its data; codex P2).
      if (this.buf[idx] === "\r" && idx === this.buf.length - 1) break;
      const line = this.buf.slice(0, idx);
      const nl = this.buf[idx] === "\r" && this.buf[idx + 1] === "\n" ? 2 : 1;
      this.buf = this.buf.slice(idx + nl);
      const frame = this.consumeLine(line);
      if (frame) out.push(frame);
    }
    return out;
  }

  /** Flush any frame held without a trailing blank line (stream closed cleanly). */
  end(): SseFrame[] {
    if (this.buf.length > 0) {
      const frame = this.consumeLine(this.buf);
      this.buf = "";
      if (frame) return [frame];
    }
    // A frame with data but no terminating blank line still dispatches on close.
    if (this.dataLines.length > 0 || this.event) {
      return [this.dispatch()];
    }
    return [];
  }

  private consumeLine(line: string): SseFrame | null {
    // Blank line = dispatch the accumulated frame.
    if (line === "") {
      if (this.dataLines.length === 0 && this.event === "") return null;
      return this.dispatch();
    }
    // Comment line (keepalive) — ignored.
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec: a single leading space after the colon is stripped.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.dataLines.push(value);
    // `id`/`retry` are irrelevant to Hermes here — ignored.
    return null;
  }

  private dispatch(): SseFrame {
    const frame: SseFrame = {
      event: this.event || "message",
      data: this.dataLines.join("\n"),
    };
    this.event = "";
    this.dataLines = [];
    return frame;
  }
}
