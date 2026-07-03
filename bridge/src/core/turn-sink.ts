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
  private hasPendingFinal = false;
  // Per-turn provenance budget: a misbehaving plugin (or several) must never
  // turn the sources affordance into a flood of parts.
  private provenanceCount = 0;

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

  /**
   * Start a new assistant turn: reset the finalize buffer and create the
   * streaming assistant message up-front (run.status begin is not guaranteed
   * before content; chat-final-content has none until the end). The provider
   * driver calls this AFTER seeding its own per-turn state.
   */
  async beginTurn(ackRunId: string | null): Promise<void> {
    this.pendingFinalText = "";
    this.pendingFinalError = null;
    this.hasPendingFinal = false;
    this.provenanceCount = 0;
    this.turnStartMs = Date.now();
    this.hostedThisTurn = new Set<string>();
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
    const messageId = this.messageId;
    if (messageId === null) {
      return; // beginTurn not called: nothing to write to
    }
    for (const event of events) {
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
    );
  }
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
