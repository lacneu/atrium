// TurnSink — the provider-AGNOSTIC half of the old RunManager: it consumes the
// normalized event stream and translates it into ordered ConvexWriter calls. It
// owns NO normalizer and imports NO vendor code, so both the OpenClaw driver and
// (later) Hermes feed the same sink. This is the "core/run-manager.ts sink" of
// docs/BRIDGE_ARCHITECTURE.md §2.1/§2.6.
//
// Event -> writer mapping (see convex/stream.ts + the normalized event shapes):
//   beginTurn(ackRunId)      -> startAssistant(chatId, ackRunId)  [once, returns messageId]
//   message.delta {text}     -> appendDelta(messageId, text)
//   message.snapshot {text}  -> setSnapshot(messageId, text)
//   tool.status {name,phase} -> addToolPart(kind:tool)
//   media {items[]}          -> addMedia per item (writer stores bytes)
//   message.final {text,error?} + paired run.status {status} -> finalize(...)
//   intermediate run.status (working/running/compacting) -> dropped (no schema fit)
//
// finalize semantics (load-bearing): the normalizer emits the PAIR
// [message.final{text,error?}, run.status{status}]. message.final alone cannot
// distinguish complete vs aborted (aborted carries no error), so we BUFFER the
// final text/error from message.final and emit writer.finalize() only when the
// paired terminal run.status arrives (final->complete, error->error,
// aborted->aborted). Every other run.status is intermediate and dropped.

import type { NormalizedEvent } from "./events.js";
import type { ConvexWriter, FinalizeStatus, ToolPart } from "../convex-writer.js";
import {
  MAX_PROVENANCE_PARTS_PER_TURN,
  type ProvenancePart,
} from "./provenance.js";

// Bound on events buffered before a deferred open. Tiny in practice: the first
// tool/media/meaningful-text event OPENS the message, so only provenance +
// non-meaningful deltas ever accumulate here.
const MAX_DEFERRED_EVENTS = 500;

const TERMINAL_STATUS: Record<string, FinalizeStatus> = {
  final: "complete",
  complete: "complete",
  error: "error",
  aborted: "aborted",
};

interface MediaItem {
  filename: string;
  path: string;
  /** Delivery intent from discovery: MEDIA: directive / structured field = true;
   *  a path merely embedded in prose = false (freshness-gated at fetch). Absent
   *  on a pre-tag event -> treated as explicit (no gate; fail open). */
  explicit?: boolean;
}

/**
 * Deterministic outbound-media hook (see core/outbound-scan). Called at finalize
 * with the turn-start time + the set of basenames already hosted via MEDIA: this
 * turn; it hosts any other file the agent dropped in the outbound dir. Optional —
 * absent in tests / when outbound media is off.
 */
export type OutboundScan = (
  messageId: string,
  sinceMs: number,
  hosted: Set<string>,
) => Promise<void>;

export class TurnSink {
  private readonly chatId: string;
  private readonly writer: ConvexWriter;
  private readonly outboundScan?: OutboundScan;
  // The gateway session key this sink's turns run under. Echoed into
  // startAssistant so Convex can DETERMINISTICALLY join an assistant reply to
  // the send that produced it (the hybrid-rehydration correlate relies on the
  // openclawChatId nonce embedded in it; time-based joins race on late replies).
  private readonly sessionKey?: string;

  private messageId: string | null = null;
  /** The assistant message id for the CURRENT/last turn (null before the first
   *  beginTurn). Lets the session tag a sub-agent observation with the message
   *  that spawned it -- robust parent-message correlation (no toolPart parse). */
  get currentMessageId(): string | null {
    return this.messageId;
  }
  private turnActive = false;
  // Turn-start wall clock + the basenames hosted via MEDIA: this turn — together
  // they let the finalize-time outbound scan host ONLY this turn's NEW files and
  // skip ones already delivered.
  private turnStartMs = 0;
  private hostedThisTurn = new Set<string>();
  // Buffered final from message.final, applied when the paired run.status lands.
  private pendingFinalText = "";
  private pendingFinalError: string | null = null;
  // Stable gateway failure class (refusal|timeout|rate_limit|context_length)
  // from message.final — persisted as the message's errorCode at finalize.
  private pendingFinalErrorKind: string | null = null;
  private hasPendingFinal = false;
  // Per-turn provenance budget: a misbehaving plugin (or several) must never
  // turn the sources affordance into a flood of parts.
  private provenanceCount = 0;
  // Gateway context-pressure for THIS turn (from the send path's pre-send
  // describe — zero extra calls) + whether a compaction was detected. Flushed as
  // ONE content-free `chat.gateway_pressure` trace at finalize (fire-and-forget:
  // observability must never delay the user's reply).
  private pressure: {
    totalTokens: number | null;
    contextTokens: number | null;
  } | null = null;
  private compactionPhase: string | null = null;
  // --- Deferred open (SPONTANEOUS announce turns) ---------------------------
  // A gateway-initiated announce run may be entirely silent (the NO_REPLY
  // protocol sentinel: "nothing to show the user"). For those turns the
  // assistant message is NOT created up-front: normalized events buffer here
  // until the first USER-VISIBLE one (meaningful text / tool / media) proves
  // there is something to show — the NORMALIZER is the sole judge of content
  // (all gateway shapes: string content, deltas, message-tool, history
  // recovery). A run that reaches its terminal with nothing visible is
  // discarded without ever creating a message — zero transient bubble.
  private pendingOpen = false;
  private deferredRunId: string | null = null;
  private deferredEvents: NormalizedEvent[] = [];
  private openPromise: Promise<void> | null = null;
  private sawDeferredVisible = false;
  // Turn GENERATION token: bumped by every beginTurn/discard. An in-flight
  // deferred open (startAssistant awaited) captures it and re-checks before
  // mutating sink state — a user send preempting the open must never have the
  // stale closure overwrite the NEW turn's messageId or replay old events
  // into it (codex P1).
  private turnEpoch = 0;

  constructor(
    chatId: string,
    writer: ConvexWriter,
    outboundScan?: OutboundScan,
    sessionKey?: string,
  ) {
    this.chatId = chatId;
    this.writer = writer;
    this.outboundScan = outboundScan;
    this.sessionKey = sessionKey;
  }

  /** True between beginTurn and the terminal flush; gates driving the provider. */
  get active(): boolean {
    return this.turnActive;
  }

  /** True while a deferred (spontaneous) turn is active but its assistant
   *  message has not been created yet — the preemption-sensitive window. */
  get deferredUnopened(): boolean {
    return this.turnActive && this.pendingOpen;
  }

  /**
   * Start a new assistant turn: reset the finalize buffer and create the
   * streaming assistant message up-front (run.status begin is not guaranteed
   * before content; chat-final-content has none until the end). The provider
   * driver calls this AFTER seeding its own per-turn state.
   */
  async beginTurn(
    ackRunId: string | null,
    pressure?: { totalTokens: number | null; contextTokens: number | null },
    deferOpen = false,
  ): Promise<void> {
    this.turnEpoch++;
    // A REAL turn preempting a DEFERRED (announce) turn that never opened must
    // deactivate the sink BEFORE the startAssistant await below: leaving
    // turnActive=true across that await would route the new run's racing
    // frames into apply() (null messageId / stale deferred state) instead of
    // the armed pre-ack buffer — losing the start of the user's reply. No-op
    // on the normal path (a finalized turn already left turnActive false).
    this.turnActive = false;
    this.pendingFinalText = "";
    this.pendingFinalError = null;
    this.pendingFinalErrorKind = null;
    this.hasPendingFinal = false;
    this.provenanceCount = 0;
    this.pressure = pressure ?? null;
    this.compactionPhase = null;
    this.turnStartMs = Date.now();
    this.hostedThisTurn = new Set<string>();
    this.pendingOpen = false;
    this.deferredRunId = null;
    this.deferredEvents = [];
    this.openPromise = null;
    this.sawDeferredVisible = false;
    if (deferOpen) {
      // SPONTANEOUS (announce) turn: go active WITHOUT creating the assistant
      // message — apply() opens it on the first user-visible event, or discards
      // the whole turn silently if none ever arrives (NO_REPLY announce).
      this.deferredRunId = ackRunId;
      this.pendingOpen = true;
      this.messageId = null;
      this.turnActive = true;
      return;
    }
    // Create the streaming message FIRST, go active SECOND. If we flipped
    // turnActive before awaiting startAssistant, frames arriving during that
    // network round-trip would see an ACTIVE sink with a null messageId and be
    // dropped (apply() early-returns on messageId === null) — reopening the very
    // race the pre-ack buffer fixes. Staying inactive across the await keeps
    // RunManager.feed buffering them (the buffer is still armed); the replay loop
    // drains them right after this returns. (No await between the two lines, so
    // there is no active-with-null-messageId window.)
    this.messageId = await this.writer.startAssistant(
      this.chatId,
      ackRunId,
      this.sessionKey ?? null,
    );
    this.turnActive = true;
  }

  /** Apply a batch of normalized events to the writer, strictly in order. */
  async apply(events: NormalizedEvent[]): Promise<void> {
    for (const event of events) {
      if (this.pendingOpen) {
        const consumed = await this.applyDeferred(event);
        if (consumed) continue;
        // The turn just opened — fall through to the normal path.
      }
      const messageId = this.messageId;
      if (messageId === null) {
        return; // beginTurn not called: nothing to write to
      }
      await this.applyOne(event, messageId);
    }
  }

  /**
   * Deferred-open gate for spontaneous (announce) turns. Returns true when the
   * event was consumed here (buffered, or the whole silent turn discarded);
   * false when the message just got created and the event should flow through
   * the normal path.
   */
  private async applyDeferred(event: NormalizedEvent): Promise<boolean> {
    const epoch = this.turnEpoch;
    if (event.type === "run.status") {
      const status = asString(event.status);
      if (TERMINAL_STATUS[status] === undefined) {
        return true; // intermediate status — dropped anyway
      }
      if (this.sawDeferredVisible) {
        // Visible content WAS seen but a transient create failure kept us
        // unopened — one last attempt so a brief Convex outage doesn't eat the
        // report; only a persistent failure (nothing writable anyway) loses it.
        const opened = await this.tryOpenDeferred();
        if (this.turnEpoch !== epoch) return true; // preempted: dead turn's event
        if (opened) return false; // finalize normally
        console.error(
          "[announce] report LOST: message create kept failing through the terminal",
        );
      } else {
        // The run terminated with nothing user-visible (the NO_REPLY protocol
        // sentinel / an empty reply): no message was ever created — silence.
        console.log("[announce] silent run discarded (no visible content)");
      }
      this.resetDeferred();
      return true;
    }
    if (!eventIsVisible(event)) {
      if (this.deferredEvents.length < MAX_DEFERRED_EVENTS) {
        this.deferredEvents.push(event);
      }
      return true;
    }
    this.sawDeferredVisible = true;
    const opened = await this.tryOpenDeferred();
    if (this.turnEpoch !== epoch) {
      return true; // preempted while opening: this event belongs to a dead turn
    }
    if (!opened) {
      // Transient create failure: keep the event so the next visible one (or
      // the terminal's last attempt) replays it.
      if (this.deferredEvents.length < MAX_DEFERRED_EVENTS) {
        this.deferredEvents.push(event);
      }
      return true;
    }
    return false;
  }

  /** Create the deferred assistant message once (mutex via openPromise: the
   *  consume loop and a stash flush can apply concurrently) and replay the
   *  buffered pre-open events in arrival order. */
  private async tryOpenDeferred(): Promise<boolean> {
    if (!this.pendingOpen) return true;
    if (this.openPromise === null) {
      const epoch = this.turnEpoch;
      this.openPromise = (async () => {
        const id = await this.writer.startAssistant(
          this.chatId,
          this.deferredRunId,
          this.sessionKey ?? null,
        );
        if (this.turnEpoch !== epoch) {
          // A new turn preempted this open while the write was in flight: do
          // NOT touch the sink (the new turn owns it). The created message is
          // an orphan streaming row — the stuck-stream watchdog settles it.
          console.error(
            "[announce] deferred open superseded by a new turn — orphan message",
            id,
          );
          return;
        }
        this.messageId = id;
        this.pendingOpen = false;
        const buffered = this.deferredEvents;
        this.deferredEvents = [];
        for (const ev of buffered) {
          try {
            await this.applyOne(ev, id);
          } catch (e) {
            // The message EXISTS: a replay failure must not reject this
            // promise — the caller's catch would treat it as a CREATE failure
            // and re-buffer behind a now-closed gate (events never replayed,
            // message stuck streaming). Best-effort per event: log, keep
            // replaying; the terminal run.status still finalizes the message.
            console.error(
              "[announce] deferred replay event failed (skipped, non-fatal):",
              (e as Error)?.message ?? e,
            );
          }
        }
      })();
    }
    try {
      await this.openPromise;
      return true;
    } catch (e) {
      this.openPromise = null; // allow a retry on the next visible event
      console.error(
        "[announce] deferred message create failed (will retry):",
        (e as Error)?.message ?? e,
      );
      return false;
    }
  }

  /** Abandon a deferred turn that produced nothing visible. */
  private resetDeferred(): void {
    this.turnEpoch++;
    this.turnActive = false;
    this.pendingOpen = false;
    this.deferredRunId = null;
    this.deferredEvents = [];
    this.openPromise = null;
    this.sawDeferredVisible = false;
  }

  /** Apply ONE normalized event to the writer (the turn's message exists). */
  private async applyOne(
    event: NormalizedEvent,
    messageId: string,
  ): Promise<void> {
    {
      switch (event.type) {
        case "message.delta": {
          const text = asString(event.text);
          if (text) {
            await this.writer.appendDelta(messageId, text);
          }
          break;
        }
        case "message.snapshot": {
          await this.writer.setSnapshot(messageId, asString(event.text));
          break;
        }
        case "tool.status": {
          const part: ToolPart = {
            kind: "tool",
            name: asString(event.name),
            phase: asString(event.phase),
            ...(event.input !== undefined ? { input: event.input } : {}),
            ...(event.output !== undefined ? { output: event.output } : {}),
          };
          await this.writer.addToolPart(messageId, part);
          break;
        }
        case "provenance": {
          // Already validated + bounded by core/provenance.parseProvenanceReport
          // (the only producer of this event type). Per-turn cap as the belt.
          if (this.provenanceCount >= MAX_PROVENANCE_PARTS_PER_TURN) break;
          this.provenanceCount++;
          await this.writer.addProvenancePart(
            messageId,
            event.part as ProvenancePart,
          );
          break;
        }
        case "media": {
          for (const item of mediaItems(event.items)) {
            // Already ATTACHED this turn (e.g. a fresh mention delivered, then the
            // same path re-emitted as an explicit upgrade) -> never double-attach.
            if (this.hostedThisTurn.has(item.filename)) continue;
            const attached = await this.writer.addMedia(messageId, {
              filename: item.filename,
              path: item.path,
              // Mention-only paths are freshness-gated against THIS turn's start,
              // so an agent reading old notes never re-attaches last week's files.
              ...(item.explicit !== undefined ? { explicit: item.explicit } : {}),
              turnStartMs: this.turnStartMs,
            });
            // Mark hosted ONLY on a real attach: a stale-dropped mention must stay
            // eligible for a later EXPLICIT re-delivery of the same path (and the
            // finalize-time outbound scan keys on actually-delivered files).
            if (attached) this.hostedThisTurn.add(item.filename);
          }
          break;
        }
        case "media.undelivered": {
          // The agent generated media (e.g. a codex imageGeneration item) but the
          // turn delivered none -> record a SOC2-safe diagnostic so the gap (missing
          // MEDIA:/mediaUrls delivery directive) is visible. No content, no part.
          await this.writer.noteMediaUndelivered(messageId);
          break;
        }
        case "message.final": {
          // Buffer; the paired run.status decides complete vs error vs aborted.
          this.pendingFinalText = asString(event.text);
          this.pendingFinalError =
            event.error === undefined || event.error === null
              ? null
              : String(event.error);
          this.pendingFinalErrorKind =
            typeof event.errorKind === "string" && event.errorKind
              ? event.errorKind
              : null;
          this.hasPendingFinal = true;
          break;
        }
        case "run.status": {
          const status = asString(event.status);
          const mapped = TERMINAL_STATUS[status];
          if (mapped !== undefined) {
            await this.flushFinal(mapped);
          }
          // Intermediate statuses (working/running/compacting) have no schema
          // representation -> dropped.
          break;
        }
        case "context.compaction": {
          // The gateway summarized this session's older context during the turn
          // (see core/events.ts). Persist ONE user-facing marker part — it both
          // explains a long "Réflexion…" wait live (parts stream to the UI) and
          // stays in the thread as the honest "context was optimized" note.
          // Content-free: phase + timestamp only, never the summary.
          const phase = asString(event.phase) || "preflight";
          if (this.compactionPhase === null) {
            this.compactionPhase = phase;
            await this.writer.addCompactionPart(messageId, {
              kind: "compaction",
              phase,
              at: Date.now(),
            });
          }
          break;
        }
        case "openclaw.frame":
        default:
          // Deprecated raw passthrough / unknown -> not persisted.
          break;
      }
    }
  }

  /** Emit the buffered final via writer.finalize(); ends the turn. */
  private async flushFinal(status: FinalizeStatus): Promise<void> {
    const messageId = this.messageId;
    if (messageId === null || !this.turnActive) {
      return;
    }
    this.turnActive = false;
    // DETERMINISTIC outbound media: before finalizing, host any file the agent
    // dropped in the outbound dir this turn that wasn't already delivered via a
    // MEDIA: directive (the LLM often omits it / a space breaks the path parse).
    // Best-effort — a scan failure must never block the finalize.
    if (this.outboundScan) {
      try {
        await this.outboundScan(messageId, this.turnStartMs, this.hostedThisTurn);
      } catch (e) {
        console.error(
          "[outbound-scan] skipped (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    }
    // The error string (if any) was buffered from message.final; on a clean turn
    // it is null. lifecycle:error finalizes with both partial text + error.
    await this.writer.finalize(
      messageId,
      status,
      this.hasPendingFinal ? this.pendingFinalText : "",
      this.pendingFinalError,
      this.pendingFinalErrorKind,
    );
    // Context-pressure trace (Inc 2): one content-free record per turn — the
    // pre-turn fill counters + whether the gateway compacted. Fire-and-forget
    // AFTER finalize so observability never delays the visible reply; a write
    // failure only loses the trace, never the turn.
    if (
      this.pressure !== null ||
      this.compactionPhase !== null ||
      this.pendingFinalErrorKind === "context_length"
    ) {
      void this.writer
        .recordGatewayPressure(this.chatId, messageId, {
          totalTokens: this.pressure?.totalTokens ?? null,
          contextTokens: this.pressure?.contextTokens ?? null,
          compaction: this.compactionPhase,
          // The HARD-overflow marker: the gateway reported errorKind
          // "context_length" (un-recovered), vs `compaction` = handled silently.
          errorKind: this.pendingFinalErrorKind,
        })
        .catch((e) =>
          console.error(
            "[gateway-pressure] trace skipped (non-fatal):",
            (e as Error)?.message ?? e,
          ),
        );
    }
  }
}

/**
 * True when a normalized event carries USER-VISIBLE content — the deferred-open
 * trigger for spontaneous turns. Tools and media always show in the UI;
 * text counts only when meaningful (non-empty and not the NO_REPLY protocol
 * sentinel, which the gateway emits to mean "nothing to show the user").
 * Provenance/compaction/diagnostics never justify a message on their own.
 */
function eventIsVisible(event: NormalizedEvent): boolean {
  switch (event.type) {
    case "message.delta":
    case "message.snapshot":
      return meaningfulText(asString((event as { text?: unknown }).text));
    case "message.final": {
      // An ERRORED final counts as visible even with no text: a failed announce
      // must surface as an error banner, never vanish silently (codex P2).
      const ev = event as { text?: unknown; error?: unknown };
      return (
        meaningfulText(asString(ev.text)) ||
        (ev.error != null && asString(ev.error) !== "")
      );
    }
    case "tool.status":
    case "media":
      return true;
    default:
      return false;
  }
}

function meaningfulText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t !== "NO_REPLY";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function mediaItems(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: MediaItem[] = [];
  for (const raw of value) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as Record<string, unknown>).filename === "string" &&
      typeof (raw as Record<string, unknown>).path === "string"
    ) {
      const obj = raw as { filename: string; path: string; explicit?: unknown };
      items.push({
        filename: obj.filename,
        path: obj.path,
        ...(typeof obj.explicit === "boolean"
          ? { explicit: obj.explicit }
          : {}),
      });
    }
  }
  return items;
}
