// Hermes → Atrium normalizer. Translates the Hermes gateway's per-turn SSE
// stream (`POST /api/sessions/{id}/chat/stream`) into the SAME six
// NormalizedEvents the OpenClaw path emits, so the ENTIRE downstream
// (TurnSink → convex-writer → Convex → UI) is reused unchanged. This is the
// seam that proves the multi-provider design held: a provider is "a thing that
// emits NormalizedEvents into a TurnSink."
//
// STABLE (live-verified on the error path, 2026-07-06): every Hermes SSE frame
// carries a JSON envelope `{ session_id, run_id, seq, ts, ... }`. The frame
// NAMES for the streaming deltas/tools/final are the one contract slot that
// must be confirmed against a live SUCCESS capture — the doc names and the live
// names already diverged (docs said flat `assistant.delta`; the live envelope
// is dotted with seq/ts). The EVENT_NAMES table below is that slot: it accepts
// every documented AND observed spelling so a capture only PRUNES it, never
// requires a rewrite.

import {
  EVENT_MESSAGE_DELTA,
  EVENT_MESSAGE_FINAL,
  EVENT_MESSAGE_SNAPSHOT,
  EVENT_RUN_STATUS,
  EVENT_TOOL_STATUS,
  type BridgeEvent,
} from "../../core/events.js";
import type { SseFrame } from "./sse.js";

/** Frame names bound to the LIVE captures (error path 2026-07-06 AM, success
 *  path 2026-07-06 PM — fixtures under test/fixtures/hermes/). The live success
 *  stream is: run.started → message.started → assistant.delta×N →
 *  [tool.progress (thinking noise)] → assistant.completed{content} →
 *  run.completed{messages,usage} → done. */
export const HERMES_EVENT_NAMES = {
  // Turn started. message.started = the assistant message opening — no
  // NormalizedEvent needed (the sink opened the row on beginTurn).
  started: new Set(["run.started"]),
  opened: new Set(["message.started"]),
  // Streaming text deltas: {delta: "..."} (LIVE-confirmed flat string).
  delta: new Set(["assistant.delta"]),
  // LIVE: `tool.progress` streams tool/thinking DELTAS (tool_name "_thinking"
  // carries the reply text again — NOISE, never surface it as reply text). Real
  // tool activity uses the same frame with a real tool_name.
  toolProgress: new Set(["tool.progress"]),
  toolStarted: new Set(["tool.started"]),
  toolCompleted: new Set(["tool.completed"]),
  // The assistant message's AUTHORITATIVE text: {content: "..."} — a snapshot,
  // NOT a terminal (run.completed follows).
  assistantCompleted: new Set(["assistant.completed"]),
  // Run-level terminal: {messages:[{content}], usage:{input/output/total}}.
  completed: new Set(["run.completed"]),
  error: new Set(["error", "run.error", "run.failed"]),
  // Stream closed (always last; carries no content).
  done: new Set(["done"]),
} as const;

/** Pull the delta text from any of the observed/documented delta shapes:
 *  `{delta:{content}}` (chat-completions), `{delta:"..."}`, `{text}`,
 *  `{content}`, `{output_text}` (Responses). First non-empty wins. */
function extractDeltaText(data: Record<string, unknown>): string {
  const delta = data.delta;
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    const c = (delta as { content?: unknown; text?: unknown }).content;
    if (typeof c === "string") return c;
    const t = (delta as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  for (const k of ["text", "content", "output_text"] as const) {
    const v = data[k];
    if (typeof v === "string") return v;
  }
  // OpenAI-compatible chunk shape: choices[0].delta.content.
  const choices = data.choices;
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const d = (ch as { delta?: unknown })?.delta;
      const c = (d as { content?: unknown })?.content;
      if (typeof c === "string" && c) return c;
    }
  }
  return "";
}

/** Pull the authoritative final text from a terminal frame's many shapes:
 *  `{message:{content}}`, `{output:[...]}` (Responses), `{output:"..."}`,
 *  `{text}`. Returns "" when the frame carries no text (then the accumulated
 *  deltas are authoritative). */
function extractFinalText(data: Record<string, unknown>): string {
  const msg = data.message;
  if (msg && typeof msg === "object") {
    const c = (msg as { content?: unknown }).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      // content parts: [{type:"text"|"output_text", text:"..."}]
      const parts = c
        .map((p) =>
          p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
            ? String((p as { text: string }).text)
            : "",
        )
        .filter(Boolean);
      if (parts.length) return parts.join("");
    }
  }
  // LIVE run.completed shape: {messages: [{role:"assistant", content:"..."}]}.
  const messages = data.messages;
  if (Array.isArray(messages)) {
    const parts = messages
      .filter(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as { role?: unknown }).role === "assistant" &&
          typeof (m as { content?: unknown }).content === "string",
      )
      .map((m) => String((m as { content: string }).content));
    if (parts.length) return parts.join("");
  }
  const output = data.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts = output
      .filter(
        (o) =>
          o && typeof o === "object" && (o as { type?: unknown }).type === "message",
      )
      .flatMap((o) => {
        const c = (o as { content?: unknown }).content;
        if (typeof c === "string") return [c];
        if (Array.isArray(c))
          return c
            .map((p) => (p as { text?: unknown })?.text)
            .filter((t): t is string => typeof t === "string");
        return [];
      });
    if (parts.length) return parts.join("");
  }
  const text = data.text;
  return typeof text === "string" ? text : "";
}

function nameIn(set: ReadonlySet<string>, event: string): boolean {
  return set.has(event);
}

/**
 * One Hermes turn's transducer. `beginTurn()` per turn, then `feed(frame)` for
 * every SSE frame; the returned NormalizedEvents flow straight into a TurnSink.
 * Emits the message.final + run.status PAIR the sink requires (the sink cannot
 * finalize on either alone). Idempotent after the terminal frame.
 */
export class HermesNormalizer {
  private runId: string | null = null;
  private text = "";
  // Real tools already surfaced from tool.progress deltas (one start per tool).
  private seenProgressTools = new Set<string>();
  // Synthetic tool-call ids (Hermes frames carry none): per-name FIFO of open
  // ids so a started and its completed pair up — Convex's addPart upserts on
  // the id, collapsing the pair into ONE card (previously two stacked parts).
  // `fromProgress` marks an id minted by a tool.progress frame: a follow-up
  // tool.started for the same name CONFIRMS that call (reuse, no double
  // start), while a second tool.started is a CONCURRENT same-name call and
  // mints its own id (codex P2 — reusing would fuse two calls into one card).
  private openTools = new Map<
    string,
    Array<{ id: string; fromProgress: boolean }>
  >();
  private toolSeq = 0;

  private openToolId(name: string, fromProgress: boolean): string {
    const id = `h:${name}:${this.toolSeq++}`;
    const queue = this.openTools.get(name) ?? [];
    queue.push({ id, fromProgress });
    this.openTools.set(name, queue);
    return id;
  }

  private closeToolId(name: string): string | undefined {
    const queue = this.openTools.get(name);
    const entry = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.openTools.delete(name);
    return entry?.id;
  }
  private finalized = false;
  constructor(ackRunId: string | null = null) {
    this.runId = ackRunId;
  }

  /** The run id learned from the stream (for abort routing). */
  get currentRunId(): string | null {
    return this.runId;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  feed(frame: SseFrame): BridgeEvent[] {
    if (this.finalized) return [];
    let data: Record<string, unknown> = {};
    if (frame.data) {
      try {
        const parsed = JSON.parse(frame.data);
        if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        // A non-JSON data line (keepalive text): ignore its body, keep the name.
      }
    }
    // Learn the run id from any frame that carries it (envelope is uniform).
    const rid = data.run_id;
    if (typeof rid === "string" && rid) this.runId = rid;

    const ev = frame.event;

    if (nameIn(HERMES_EVENT_NAMES.error, ev)) {
      const message =
        typeof data.message === "string" && data.message
          ? data.message
          : typeof data.error === "string"
            ? data.error
            : "Hermes run failed.";
      return this.finalize("error", message);
    }
    if (nameIn(HERMES_EVENT_NAMES.assistantCompleted, ev)) {
      // The assistant message's authoritative text (LIVE: {content}) — a
      // SNAPSHOT that replaces the delta accumulator; run.completed follows.
      const content = data.content;
      if (typeof content === "string" && content) {
        this.text = content;
        return [
          { type: EVENT_MESSAGE_SNAPSHOT, text: content, runId: this.runId },
        ];
      }
      return [];
    }
    if (nameIn(HERMES_EVENT_NAMES.completed, ev)) {
      const finalText = extractFinalText(data);
      if (finalText) this.text = finalText;
      return this.finalize("complete", null);
    }
    if (nameIn(HERMES_EVENT_NAMES.done, ev)) {
      // Stream closed. Success terminals precede it; if none did (clean close
      // with only deltas), settle complete on the accumulated text.
      return this.finalize("complete", null);
    }
    if (nameIn(HERMES_EVENT_NAMES.delta, ev)) {
      const text = extractDeltaText(data);
      if (!text) return [];
      this.text += text;
        return [{ type: EVENT_MESSAGE_DELTA, text, runId: this.runId }];
    }
    if (nameIn(HERMES_EVENT_NAMES.toolProgress, ev)) {
      // LIVE: per-delta tool progress. `_thinking` mirrors the reply text —
      // pure noise, never a tool part. A REAL tool_name surfaces as ONE
      // tool.status start (first sight) so the activity view shows it without
      // flooding a part per token.
      const name = toolName(data);
      if (!name || name.startsWith("_")) return [];
      if (this.seenProgressTools.has(name)) return [];
      this.seenProgressTools.add(name);
      // Anti double-start: a started frame may follow for the same tool — only
      // mint an id here when none is open for this name yet.
      if (this.openTools.has(name)) return [];
      return [
        {
          type: EVENT_TOOL_STATUS,
          name,
          phase: "start",
          toolCallId: this.openToolId(name, true),
          runId: this.runId,
        },
      ];
    }
    if (nameIn(HERMES_EVENT_NAMES.toolStarted, ev)) {
      const name = toolName(data);
      let toolCallId: string | undefined;
      if (name !== null) {
        // A progress frame may have opened this call already: CONFIRM that id
        // (reuse once). Any other started of the same name is a CONCURRENT
        // call and mints its own id — the FIFO pairs completions in order.
        const pending = this.openTools
          .get(name)
          ?.find((e) => e.fromProgress);
        if (pending !== undefined) {
          pending.fromProgress = false;
          toolCallId = pending.id;
        } else {
          toolCallId = this.openToolId(name, false);
        }
      }
      return [
        {
          type: EVENT_TOOL_STATUS,
          name,
          phase: "start",
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          runId: this.runId,
        },
      ];
    }
    if (nameIn(HERMES_EVENT_NAMES.toolCompleted, ev)) {
      const name = toolName(data);
      const id = name !== null ? this.closeToolId(name) : undefined;
      return [
        {
          type: EVENT_TOOL_STATUS,
          name,
          phase: "completed",
          // No open start for this name (completed-only wire): omit the id —
          // the append-only legacy path renders it as before.
          ...(id !== undefined ? { toolCallId: id } : {}),
          runId: this.runId,
        },
      ];
    }
    if (nameIn(HERMES_EVENT_NAMES.started, ev)) {
      return [{ type: EVENT_RUN_STATUS, status: "streaming", runId: this.runId }];
    }
    // opened / unknown frames: no NormalizedEvent (forward-compat: a new Hermes
    // frame name is ignored, never crashes the turn).
    return [];
  }

  /** Force-finalize (transport error / socket close before a terminal frame). */
  endTurn(error: string | null = null): BridgeEvent[] {
    if (this.finalized) return [];
    return this.finalize(error ? "error" : "complete", error);
  }

  /** Finalize as ABORTED — used when a /reset cancels a live stream (Convex has
   *  NOT finalized the message, unlike a user Stop), so the bridge must settle
   *  it or the row is left streaming until the watchdog. */
  abortTurn(): BridgeEvent[] {
    if (this.finalized) return [];
    this.finalized = true;
    return [
      { type: EVENT_MESSAGE_FINAL, text: this.text },
      { type: EVENT_RUN_STATUS, status: "aborted", runId: this.runId },
    ];
  }

  private finalize(status: "complete" | "error", error: string | null): BridgeEvent[] {
    this.finalized = true;
    const finalEvent: BridgeEvent = {
      type: EVENT_MESSAGE_FINAL,
      text: this.text,
    };
    const statusEvent: BridgeEvent = {
      type: EVENT_RUN_STATUS,
      status,
      runId: this.runId,
    };
    if (error) {
      finalEvent.error = error;
      statusEvent.message = error;
    }
    return [finalEvent, statusEvent];
  }
}

/** Tool name from a tool frame's several shapes: `{tool}`, `{name}`,
 *  `{tool:{name}}`. Falls back to a neutral label. */
function toolName(data: Record<string, unknown>): string {
  const tn = data.tool_name; // LIVE field on tool.progress
  if (typeof tn === "string" && tn) return tn;
  const t = data.tool;
  if (typeof t === "string" && t) return t;
  if (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
    return String((t as { name: string }).name);
  }
  const n = data.name;
  return typeof n === "string" && n ? n : "tool";
}
