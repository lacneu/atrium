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

// A turn that finalized COMPLETE but delivered NOTHING the user can act on (no
// reply text, no attached media) despite the agent having WORKED (tool calls or
// an attempted MEDIA: delivery) — a silent blank bubble. It is surfaced as an
// actionable error instead. Covers BOTH observed causes: a recv-timeout that
// cut a still-working/stuck turn, and an agent that "delivered" via a file whose
// MEDIA: was dropped (not_found) downstream (report ms7b5j… 2026-07-05).
const EMPTY_RESPONSE_CODE = "empty_response";
// Silence-driven finalize causes (vs a real gateway terminal): these warrant a
// gateway_pressure trace even when the turn had no pre-send describe.
const AUTO_CLOSE_CAUSES = new Set([
  "recv_timeout",
  "empty_final_timeout",
  "lifecycle_end_timeout",
  "compaction_timeout",
  "private_ack_grace",
  // The silence-recovery settle (gateway never answered within the recovery
  // budget) — same diagnostic family as the timeouts above.
  "response_timeout",
]);
const EMPTY_RESPONSE_TEXT =
  "The agent finished without a usable response (no text, and any file delivery failed).";

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
  chatId: string,
  sinceMs: number,
  hosted: Set<string>,
) => Promise<{ candidates: string[]; host: () => Promise<void> }>;

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
  // Media uploads run in a SEQUENTIAL background chain (not concurrent): part
  // order = item order (a small file can't overtake a big one), and dedup +
  // attach happen at EXECUTION time exactly as the old per-item await did (an
  // explicit re-delivery after a failed mention still attaches). flushFinal
  // awaits the chain AFTER writing the text visibly + before finalizing, so a
  // large attachment never gates the reply text (report ms70hx1c… 2026-07-05)
  // yet is never dropped and the busy-window stays streaming until finalize.
  private mediaChain: Promise<void> = Promise.resolve();
  private hasPendingMedia = false;
  // True once ANY non-empty text was made visible this turn (a streamed delta or
  // a snapshot), even if message.final is later empty — Convex keeps the streamed
  // text as the fallback, so the empty-result guard must NOT fire (codex P2).
  private sawVisibleText = false;
  // The turn generated media natively but delivered none (no MEDIA:/outbound) —
  // read from the final event so the empty-result guard sees it (codex P2).
  private pendingMediaGeneratedUndelivered = false;

  // Buffered final from message.final, applied when the paired run.status lands.
  private pendingFinalText = "";
  private pendingFinalError: string | null = null;
  // Stable gateway failure class (refusal|timeout|rate_limit|context_length)
  // from message.final — persisted as the message's errorCode at finalize.
  private pendingFinalErrorKind: string | null = null;
  // Trace-only error class: set even when the turn finalizes COMPLETE (a
  // post-reply gateway failure keeps the delivered answer but its class must
  // still reach the gateway_pressure trace). Never sent to writer.finalize —
  // an errorCode on a complete message would paint an error card on a
  // successful reply.
  private pendingDiagErrorKind: string | null = null;
  // Terminal stopReason + real post-turn usage (agent-event session metadata),
  // trace-only diagnostics (the protocol matrix's former gaps, closed here).
  private pendingDiagStopReason: string | null = null;
  private pendingDiagFinalizeCause: string | null = null;
  private pendingDiagUsage: {
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  } | null = null;
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
    costUsd?: number | null;
  } | null = null;
  private compactionPhase: string | null = null;
  // Tool calls emitted THIS turn: rides the pressure trace so a mid-turn
  // overflow reads causally at a glance ("40% pre-turn + 66 tool calls ->
  // overflow") instead of needing a manual reconstruction.
  private toolCallCount = 0;
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
    pressure?: {
      totalTokens: number | null;
      contextTokens: number | null;
      costUsd?: number | null;
    },
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
    this.pendingDiagErrorKind = null;
    this.pendingDiagStopReason = null;
    this.pendingDiagFinalizeCause = null;
    this.pendingDiagUsage = null;
    this.hasPendingFinal = false;
    this.provenanceCount = 0;
    this.pressure = pressure ?? null;
    this.compactionPhase = null;
    this.toolCallCount = 0;
    this.turnStartMs = Date.now();
    this.hostedThisTurn = new Set<string>();
    this.mediaChain = Promise.resolve();
    this.hasPendingMedia = false;
    this.sawVisibleText = false;
    this.pendingMediaGeneratedUndelivered = false;
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
            // Only NON-whitespace makes the reply "visible" — a whitespace-only
            // delta before an empty final is still a blank bubble (codex P2).
            if (text.trim().length > 0) this.sawVisibleText = true;
            await this.writer.appendDelta(messageId, text);
          }
          break;
        }
        case "message.snapshot": {
          const snap = asString(event.text);
          // A snapshot REPLACES the whole reply text, so visibility must track the
          // new content: an empty/whitespace snapshot (e.g. the "" emitted to clear
          // an invalidated prefix on compaction) RESETS visibility to false, so a
          // replay that then ends empty still trips the empty-result guard (codex P2).
          this.sawVisibleText = snap.trim().length > 0;
          await this.writer.setSnapshot(messageId, snap);
          break;
        }
        case "tool.status": {
          // Real tools arrive COALESCED (one completed/error event per call);
          // the message tool emits every phase — count it once, on its start.
          {
            const ph = asString(event.phase);
            if (
              ph === "completed" ||
              ph === "error" ||
              (ph === "start" && asString(event.name) === "message")
            ) {
              this.toolCallCount++;
            }
          }
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
            const filename = item.filename;
            const path = item.path;
            const explicit = item.explicit;
            const turnStartMs = this.turnStartMs;
            // ALWAYS enqueue on the SEQUENTIAL chain — dedup is at ATTACH time
            // only (hostedThisTurn), never at claim time. A delivery that fails
            // (file not yet readable, not_found, upload_error) leaves a same-turn
            // re-delivery — explicit OR mention — free to attach (codex P2), and
            // an explicit rescues a stale mention. The chain's leading
            // hostedThisTurn check keeps it to ONE real attach per file. Part
            // order = item order (sequential chain).
            this.hasPendingMedia = true;
            this.mediaChain = this.mediaChain.then(async () => {
              if (this.hostedThisTurn.has(filename)) return; // already attached
              try {
                const attached = await this.writer.addMedia(messageId, {
                  chatId: this.chatId,
                  filename,
                  path,
                  // Mention-only paths are freshness-gated against THIS turn's
                  // start, so an agent reading old notes never re-attaches last
                  // week's files.
                  ...(explicit !== undefined ? { explicit } : {}),
                  turnStartMs,
                });
                if (attached) this.hostedThisTurn.add(filename);
              } catch (e) {
                console.error(
                  "[sink] media upload failed (non-fatal):",
                  (e as Error)?.message ?? e,
                );
              }
            });
          }
          break;
        }
        case "media.undelivered": {
          // The agent generated media (e.g. a codex imageGeneration item) but the
          // turn delivered none -> record a SOC2-safe diagnostic so the gap (missing
          // MEDIA:/mediaUrls delivery directive) is visible. No content, no part.
          await this.writer.noteMediaUndelivered(messageId, this.chatId);
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
          this.pendingDiagErrorKind =
            typeof event.diagnosticErrorKind === "string" &&
            event.diagnosticErrorKind
              ? event.diagnosticErrorKind
              : this.pendingFinalErrorKind;
          this.pendingDiagStopReason =
            typeof event.diagnosticStopReason === "string" &&
            event.diagnosticStopReason
              ? event.diagnosticStopReason
              : null;
          this.pendingDiagFinalizeCause =
            typeof event.diagnosticFinalizeCause === "string" &&
            event.diagnosticFinalizeCause
              ? event.diagnosticFinalizeCause
              : null;
          this.pendingDiagUsage =
            typeof event.diagnosticUsage === "object" &&
            event.diagnosticUsage !== null
              ? (event.diagnosticUsage as {
                  totalTokens: number | null;
                  inputTokens: number | null;
                  outputTokens: number | null;
                  estimatedCostUsd: number | null;
                })
              : null;
          this.pendingMediaGeneratedUndelivered =
            (event as { mediaGeneratedUndelivered?: unknown })
              .mediaGeneratedUndelivered === true;
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
    // DETERMINISTIC outbound media — PHASE 1 (DETECT, fast, no upload): list any
    // file the agent dropped in the outbound dir this turn (LLM omitted MEDIA:,
    // or an explicit delivery lost a readiness race). Runs first so the
    // text-first gate below knows the FULL media set. Best-effort.
    let scanHost: (() => Promise<void>) | null = null;
    let scanCandidates = 0;
    if (this.outboundScan) {
      try {
        const r = await this.outboundScan(
          messageId,
          this.chatId,
          this.turnStartMs,
          this.hostedThisTurn,
        );
        scanHost = r.host;
        scanCandidates = r.candidates.length;
      } catch (e) {
        console.error(
          "[outbound-scan] detect skipped (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    }
    // TEXT-FIRST: write the reply text VISIBLY before waiting on any media upload
    // (explicit MEDIA: OR a scan candidate), so an attachment never gates the
    // text (report ms70hx1c… 2026-07-05). Status stays `streaming` until
    // writer.finalize() below (busy window unchanged). Gated on ACTUAL media
    // this turn — a normal (no-media) turn writes its text once, at finalize,
    // with no extra op.
    const earlyText = this.hasPendingFinal ? this.pendingFinalText : "";
    if (
      (this.hasPendingMedia || scanCandidates > 0) &&
      status === "complete" &&
      earlyText
    ) {
      try {
        await this.writer.setSnapshot(messageId, earlyText);
      } catch (e) {
        console.error(
          "[sink] early text snapshot failed (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    }
    // Await the explicit media chain, THEN host the scan candidates (PHASE 2):
    // hosting re-checks hostedThisTurn so a file the chain already attached is
    // deduped, while a failed/undelivered file is rescued. Media never dropped;
    // the message finalizes complete only once every part has landed.
    await this.mediaChain;
    if (scanHost) {
      try {
        await scanHost();
      } catch (e) {
        console.error(
          "[outbound-scan] host skipped (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    }
    // EMPTY-RESULT guard: a COMPLETE turn with NO reply text AND no media
    // actually attached (hostedThisTurn drained after the media chain above) —
    // yet the agent WORKED (tool calls or an attempted MEDIA:) — is a silent
    // blank bubble. Surface it as an actionable error (never overriding a real
    // error already buffered). The `hostedThisTurn` check is AFTER the media
    // chain, so a media that DROPPED not_found downstream correctly counts as
    // "nothing delivered" (report ms7b5j…).
    const replyText = this.hasPendingFinal ? this.pendingFinalText : "";
    let effectiveStatus = status;
    let effectiveError = this.pendingFinalError;
    let effectiveErrorKind = this.pendingFinalErrorKind;
    if (
      status === "complete" &&
      effectiveErrorKind === null &&
      replyText.trim().length === 0 &&
      !this.sawVisibleText &&
      this.hostedThisTurn.size === 0 &&
      (this.toolCallCount > 0 ||
        this.hasPendingMedia ||
        scanCandidates > 0 ||
        this.pendingMediaGeneratedUndelivered)
    ) {
      effectiveStatus = "error";
      effectiveError = EMPTY_RESPONSE_TEXT;
      effectiveErrorKind = EMPTY_RESPONSE_CODE;
    }
    // The error string (if any) was buffered from message.final; on a clean turn
    // it is null. lifecycle:error finalizes with both partial text + error.
    await this.writer.finalize(
      messageId,
      effectiveStatus,
      replyText,
      effectiveError,
      effectiveErrorKind,
    );
    // Context-pressure trace (Inc 2): one content-free record per turn — the
    // pre-turn fill counters + whether the gateway compacted. Fire-and-forget
    // AFTER finalize so observability never delays the visible reply; a write
    // failure only loses the trace, never the turn.
    if (
      this.pressure !== null ||
      this.compactionPhase !== null ||
      // Either error-class channel triggers the trace: the message's own
      // errorKind, OR the trace-only diagnostic kind (a post-reply failure
      // finalizes COMPLETE with errorKind null — the diag channel is then the
      // only copy of the class; codex P2).
      this.pendingFinalErrorKind === "context_length" ||
      this.pendingDiagErrorKind !== null ||
      // The new diagnostics (terminal stopReason / post-turn usage) must also
      // trigger the trace: a spontaneous turn has no pre-turn describe, and
      // its telemetry would otherwise be silently dropped (codex P2).
      this.pendingDiagStopReason !== null ||
      this.pendingDiagUsage !== null ||
      // A silence AUTO-close (recv/empty_final/lifecycle_end/compaction timeout,
      // private_ack grace) warrants a trace even with no pre-send pressure — it
      // is the exact diagnostic the launch bug hinges on. A NORMAL gateway
      // terminal does NOT force a trace (finalizeCause just rides one already
      // firing), so the common path keeps its writer-call sequence.
      (this.pendingDiagFinalizeCause !== null &&
        AUTO_CLOSE_CAUSES.has(this.pendingDiagFinalizeCause))
    ) {
      void this.writer
        .recordGatewayPressure(this.chatId, messageId, {
          totalTokens: this.pressure?.totalTokens ?? null,
          contextTokens: this.pressure?.contextTokens ?? null,
          // Session-cumulative cost BEFORE this turn (sessions.describe): the
          // delta between consecutive turns' traces IS the per-turn cost.
          costUsd: this.pressure?.costUsd ?? null,
          toolCalls: this.toolCallCount,
          compaction: this.compactionPhase,
          // The HARD-overflow marker: the gateway reported errorKind
          // "context_length" (un-recovered), vs `compaction` = handled silently.
          errorKind: this.pendingDiagErrorKind,
          stopReason: this.pendingDiagStopReason,
          finalizeCause: this.pendingDiagFinalizeCause,
          // REAL post-turn usage when the gateway stamps it on agent events
          // (vs the pre-turn describe counters above) — the delta per turn.
          postTotalTokens: this.pendingDiagUsage?.totalTokens ?? null,
          postInputTokens: this.pendingDiagUsage?.inputTokens ?? null,
          postOutputTokens: this.pendingDiagUsage?.outputTokens ?? null,
          postCostUsd: this.pendingDiagUsage?.estimatedCostUsd ?? null,
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
