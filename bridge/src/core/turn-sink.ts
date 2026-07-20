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
import { cronPartFromTool } from "./cron-part.js";
import { planPartFromTool } from "./plan-part.js";
import {
  asyncTaskStartFromTool,
  isDeliveryRunId,
  taskChildKey,
  taskDeliveryRunFromRunId,
} from "./async-task.js";
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
// ZERO-WORK clean close (silent NO_REPLY on a top-level turn / end-of-run
// grace with nothing at all): distinct from EMPTY_RESPONSE_CODE because ONLY
// this class is auto-retryable — a worked-but-undelivered turn (e.g. a billed
// native media generation whose delivery dropped) must surface its failure,
// never silently re-run (codex P1).
const SILENT_RESPONSE_CODE = "empty_response_silent";
const SILENT_RESPONSE_TEXT =
  "The agent ended the turn without producing any response.";

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
  /** TRUE when the turn's own artifacts name this file — the scan's
   *  cross-conversation containment gate (see outbound-scan.ts). */
  correlated: (name: string) => boolean,
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
  // Running UTF-16 length of the turn's visible text (deltas applied, snapshots
  // replace) — the textOffset stamped on tool parts so the client can anchor
  // each card inside the narrative flow. FIFO ordering with the writer's
  // flushDelta guarantees the server-side text length matches at addPart time.
  private visibleTextLen = 0;
  /** Offset just after the LAST newline of the visible text — the start of
   *  the line currently being written. Tool anchors stamp THIS instead of the
   *  raw length: an anchor landing mid-line would make the client cut the
   *  narrative inside a Markdown construct ("**bold" / a link / a table row),
   *  rendering two broken fragments (codex P2). Snapping to the line start at
   *  EMISSION time is stable forever (the stored offset never moves) and
   *  consistent across live view and reload. */
  private visibleLineStart = 0;
  /** SENTINEL GATE: the first few streamed chars of the turn are HELD while
   *  they are still a prefix of the NO_REPLY protocol sentinel, so a silent
   *  reply never flashes "NO_REPLY" in the live bubble (codex P2). Diverging
   *  text flushes the held prefix; a turn that ends on the pure sentinel
   *  simply never wrote it. Null = gate resolved (text diverged / flushed). */
  private sentinelGate: string | null = "";
  // The turn generated media natively but delivered none (no MEDIA:/outbound) —
  // read from the final event so the empty-result guard sees it (codex P2).
  private pendingMediaGeneratedUndelivered = false;
  // Child keys observed on the wire THIS turn (from the final event) and the
  // keys THIS turn's own sessions_spawn calls returned: only their INTERSECTION
  // proves a CURRENT-turn child is working — the announce pattern (reply arrives
  // as a later spontaneous turn), never an error card (report ms79rj0e…). A
  // stale child of a previous turn or a spawn that never started both fail the
  // intersection, keeping the empty_response guard honest (codex P2 ×2).
  private pendingObservedChildKeys: string[] = [];
  private spawnedChildKeysThisTurn = new Set<string>();
  // Fallback signal when the spawn RESULT omits the child key (gateway variance):
  // spawn called this turn + ANY child activity observed still exempts.
  private spawnCalledThisTurn = false;
  // The turn EXPLICITLY handed off to a child via `sessions_yield`: an
  // unambiguous "the child answers, not me" — so an empty parent reply is
  // INTENTIONAL (the async announce pattern), never an error, even when the
  // child ran entirely AFTER the yield so no child key was observed on THIS
  // turn's wire (the intersection can't catch that case). Live prod: denis'
  // delegate-then-yield turn was falsely marked empty_response (2026-07-10).
  private yieldCalledThisTurn = false;
  /** A tool result STARTED a gateway background task this turn (structured
   *  details {async:true, taskId}): the reply may legitimately end silent —
   *  the delivery arrives later as a correlated spontaneous run. Same
   *  empty-response exemption class as an explicit yield. */
  private asyncTaskStartedThisTurn = false;
  /** The ack runId of the CURRENT turn (normal or deferred). Lets the settle
   *  paths recognize a background-task DELIVERY run and close its engagement
   *  row even when the run stayed invisible (NO_REPLY). */
  private turnRunId: string | null = null;
  // Last child-activity heartbeat (ms wall): while the parent waits silently on
  // a long-running child, each observed child frame refreshes the streaming
  // row's updatedAt (via the awaiting_subagents phase) at most once a minute,
  // so the stuck-stream watchdog never orphans a parent whose child is alive.
  private lastChildHeartbeatMs = 0;
  // THIS send prepended rehydration history (threaded from beginTurn): the
  // gateway chews it silently first — surfaced as the processing_history phase.
  private pendingRehydrated = false;

  // Buffered final from message.final, applied when the paired run.status lands.
  private pendingFinalText = "";
  private pendingFinalError: string | null = null;
  // Stable gateway failure class (refusal|timeout|rate_limit|context_length)
  // from message.final — persisted as the message's errorCode at finalize.
  private pendingFinalErrorKind: string | null = null;
  /** The provider marked the streamed live text as NOISE (promoted failure
   *  prose / sentinel): the finalize must not fall back to it. */
  private pendingDiscardStream = false;
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
  // update_plan calls observed on a DELIVERY run this turn (item-derived —
  // the plan content never reaches those runs' wire). Applied ONCE at turn
  // end: the advance must know whether the turn spawned a further child
  // (chain continues -> one step per call) or left the pipeline idle (the
  // model closed its plan -> settle it), which is only known at finalize.
  private planAdvancesThisTurn = 0;
  // Non-update_plan tool calls this turn: a delivery run may keep the chain
  // going through ANY tool (an async generation's item carries no taskId, a
  // spawn's item no childSessionKey) — settling the plan is only safe when
  // update_plan was the turn's ONLY tool activity (codex P2).
  private otherToolCallsThisTurn = 0;
  // Everything the TURN itself said or touched (tool args/outputs + the
  // final reply text), flattened to strings and bounded: the outbound scan's
  // correlation source. A shared-dir file the turn never NAMED is another
  // conversation's work — the scan must leave it alone (prod leak reports
  // 2026-07-14/15).
  private turnArtifactChunks: string[] = [];
  private turnArtifactBytes = 0;
  // A USER abort (the /abort RPC) targeted this turn: dispatchAbort is
  // kill-THEN-finalize, so the gateway's chat:aborted lands while the message
  // is still streaming — without this flag the delivery-run fold below would
  // record the user's stop as a success before the guaranteed settle
  // (codex P2). Set by the /abort handler through the session registry.
  private userAbortThisTurn = false;
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

  // Notifies the health registry that a TURN finalized in error AFTER its send
  // was accepted (HealthRegistry.recordTurnError) — else errored turns stay
  // invisible in the admin Connections stats ("0 échec(s)" beside two error
  // cards — report 2026-07-09). Observability-only; exceptions are swallowed.
  private readonly onTurnError?: (code: string) => void;

  constructor(
    chatId: string,
    writer: ConvexWriter,
    outboundScan?: OutboundScan,
    sessionKey?: string,
    onTurnError?: (code: string) => void,
  ) {
    this.chatId = chatId;
    this.writer = writer;
    this.outboundScan = outboundScan;
    this.sessionKey = sessionKey;
    this.onTurnError = onTurnError;
  }

  /** True between beginTurn and the terminal flush; gates driving the provider. */
  get active(): boolean {
    return this.turnActive;
  }

  /** True while flushFinal is writing the turn's tail (media chain, plan
   *  advance, the finalize POST): `active` is already false there, but the
   *  message is still `streaming` in Convex — an announce opened in that
   *  window would fail the reopen's streaming gate and fall to a fresh
   *  bubble. The run-manager stashes announce frames while this holds. */
  get finalizing(): boolean {
    return this.finalizeInFlight;
  }

  /** A user /abort RPC targeted the active turn: the terminal `aborted` that
   *  follows is the USER'S stop — the delivery-run fold must let it stand. */
  noteUserAbort(): void {
    this.userAbortThisTurn = true;
  }

  /** A real dispatch is preempting an OPEN spontaneous (announce) turn whose
   *  final never arrived: the gateway KILLS the announce run the moment the
   *  new chat.send lands (one run per session — measured live 2026-07-19), so
   *  no further frame of it will ever come. Finalize it COMPLETE now with the
   *  streamed text (writer.finalize falls back to the stream row's text when
   *  the buffer is empty). Without this the reopened bubble strands in
   *  `streaming` forever — busy chat, stalled queue drain, then the 12-min
   *  watchdog errors it as stream_orphaned. The dispatch-side busy re-check
   *  (bridge.reparkIfBusy) makes this window rare; this is the belt. No-op
   *  when the turn is inactive or the message was never created. */
  async preemptOpenTurn(): Promise<void> {
    await this.flushFinal("complete");
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
    rehydrated = false,
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
    this.pendingDiscardStream = false;
    this.pendingDiagErrorKind = null;
    this.pendingDiagStopReason = null;
    this.pendingDiagFinalizeCause = null;
    this.pendingDiagUsage = null;
    this.hasPendingFinal = false;
    this.provenanceCount = 0;
    this.pressure = pressure ?? null;
    this.compactionPhase = null;
    this.toolCallCount = 0;
    this.planAdvancesThisTurn = 0;
    this.otherToolCallsThisTurn = 0;
    this.userAbortThisTurn = false;
    this.turnArtifactChunks = [];
    this.turnArtifactBytes = 0;
    this.turnStartMs = Date.now();
    this.hostedThisTurn = new Set<string>();
    this.mediaChain = Promise.resolve();
    this.hasPendingMedia = false;
    this.sawVisibleText = false;
    this.visibleTextLen = 0;
    this.visibleLineStart = 0;
    this.sentinelGate = "";
    this.pendingMediaGeneratedUndelivered = false;
    this.pendingObservedChildKeys = [];
    this.spawnedChildKeysThisTurn = new Set();
    this.spawnCalledThisTurn = false;
    this.yieldCalledThisTurn = false;
    this.asyncTaskStartedThisTurn = false;
    this.turnRunId = ackRunId;
    this.lastChildHeartbeatMs = 0;
    this.pendingRehydrated = false;
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
    this.pendingRehydrated = rehydrated;
    this.messageId = await this.writer.startAssistant(
      this.chatId,
      ackRunId,
      this.sessionKey ?? null,
    );
    this.turnActive = true;
    if (this.pendingRehydrated && this.messageId !== null) {
      // Tools-ON placeholder detail: the gateway is silently processing the
      // prepended history before any visible output.
      this.writer.setPhase?.(this.messageId, "processing_history");
    }
  }

  /** When the settling turn IS a background-task delivery run, close its
   *  engagement row (`task:<taskId>`), bubble or not: the task registry has
   *  delivered — the thread indicator must stop pointing at it. Idempotent
   *  (the Convex upsert never downgrades a terminal row). */
  private async settleTaskDeliveryEngagement(): Promise<void> {
    const delivery = taskDeliveryRunFromRunId(this.turnRunId);
    if (delivery !== null) {
      try {
        await this.writer.upsertSubAgent?.({
          chatId: this.chatId,
          childSessionKey: taskChildKey(delivery.taskId),
          kind: "task",
          status: delivery.outcome === "ok" ? "done" : "error",
          taskName: delivery.toolName,
        });
      } catch (err) {
        console.error(
          "task engagement settle failed (non-fatal):",
          (err as Error)?.message ?? err,
        );
      }
      return;
    }
    // SUB-AGENT announce family: a SILENT (NO_REPLY) announce never reaches
    // startAssistant, so its Convex-side settle never runs — yet the announce
    // proves the child ended. Flip a stuck running row here (running->done
    // only, server-side; an observer-recorded failure stands) or the dead
    // child holds the chat until the reaper (codex P2).
    const runId = this.turnRunId;
    if (typeof runId === "string" && runId.startsWith("announce:v1:")) {
      const seg = runId.split(":");
      const childKey = seg.slice(2, -1).join(":");
      if (childKey !== "") {
        try {
          await this.writer.settleAnnouncedChild?.(this.chatId, childKey);
        } catch (err) {
          console.error(
            "announced child settle failed (non-fatal):",
            (err as Error)?.message ?? err,
          );
        }
      }
    }
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
      // Even a silent delivery means the background task FINISHED.
      await this.settleTaskDeliveryEngagement();
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
          let text = asString(event.text);
          if (text && this.sentinelGate !== null) {
            // Hold the turn's opening chars while they can still be the
            // NO_REPLY sentinel — never flash it live (codex P2). Divergence
            // flushes the whole held prefix through the normal path below.
            const candidate = this.sentinelGate + text;
            if ("NO_REPLY".startsWith(candidate.trimStart())) {
              this.sentinelGate = candidate;
              break;
            }
            this.sentinelGate = null;
            text = candidate;
          }
          if (text) {
            // Only NON-whitespace makes the reply "visible" — a whitespace-only
            // delta before an empty final is still a blank bubble (codex P2).
            if (text.trim().length > 0) this.sawVisibleText = true;
            const nl = text.lastIndexOf("\n");
            if (nl !== -1) this.visibleLineStart = this.visibleTextLen + nl + 1;
            this.visibleTextLen += text.length;
            await this.writer.appendDelta(messageId, text);
          }
          break;
        }
        case "message.snapshot": {
          let snap = asString(event.text);
          // A snapshot of exactly the sentinel is silence — write the purge,
          // never the literal (codex P2). Any other snapshot resolves the gate.
          if (snap.trim() === "NO_REPLY") snap = "";
          this.sentinelGate = null;
          // A snapshot REPLACES the whole reply text, so visibility must track the
          // new content: an empty/whitespace snapshot (e.g. the "" emitted to clear
          // an invalidated prefix on compaction) RESETS visibility to false, so a
          // replay that then ends empty still trips the empty-result guard (codex P2).
          this.sawVisibleText = snap.trim().length > 0;
          this.visibleTextLen = snap.length;
          this.visibleLineStart = snap.lastIndexOf("\n") + 1;
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
              const nm = asString(event.name);
              if (nm !== "update_plan" && nm !== "message") {
                this.otherToolCallsThisTurn++;
              }
            }
            if (
              asString(event.name) === "sessions_spawn" &&
              // A FAILED spawn is not a live delegation: the fallback exemption
              // must never ride an errored spawn call (codex P2).
              asString(event.phase) === "completed"
            ) {
              this.spawnCalledThisTurn = true;
              // The spawn tool's RESULT carries the child's session key — string-
              // match it shape-agnostically (output nesting varies by gateway).
              const m = JSON.stringify(event.output ?? "").match(
                // Agent ids may carry dots/dashes; a NESTED child appends
                // further `:subagent:<uuid>` segments — capture the FULL key
                // or the intersection with the frame's key fails (codex P2).
                /agent:[A-Za-z0-9_.-]+(?::subagent:[A-Za-z0-9-]+)+/g,
              );
              for (const k of m ?? []) this.spawnedChildKeysThisTurn.add(k);
              if ((m?.length ?? 0) > 0 && messageId !== null) {
                // The parent is now waiting on its children (announce pattern).
                this.writer.setPhase?.(messageId, "awaiting_subagents");
              }
            }
            // An explicit hand-off to a child: the parent deliberately produces
            // no reply of its own (the child announces later). Exempts the
            // empty-response guard even when the child ran async after the yield.
            if (
              asString(event.name) === "sessions_yield" &&
              asString(event.phase) === "completed"
            ) {
              this.yieldCalledThisTurn = true;
            }
          }
          // Correlation source for the outbound scan: the call's ARGUMENTS
          // only — an agent that CREATED a file chose its name, so the name
          // rides its own tool args (or the reply text / a media event).
          // Tool OUTPUTS are deliberately excluded: a mere `ls`/`find` of the
          // shared dir would list ANOTHER conversation's fresh files and
          // turn a listing into false ownership (codex P1).
          this.noteTurnArtifacts(event.input);
          // Delivery/announce runs render as MERGED bubbles whose server-side
          // text is not provably aligned with this sink's accumulator — omit
          // the anchor there (legacy grouped rendering, zero replay-dedup
          // interaction). Normal turns stamp the offset at emission time.
          // KNOWN RESIDUAL (accepted): a REPLACING snapshot (compaction clear +
          // replay, private-ack replace) invalidates the offsets of parts
          // ALREADY persisted — the sink cannot rebase them without keeping the
          // full old/new texts. The client clamps stale offsets into range
          // (buildTurnFlow), and the dominant case (compaction "" + refill of
          // near-identical text) re-aligns naturally; a rare divergent replace
          // may shift a card toward the end of the reply — display-only.
          const anchorable =
            taskDeliveryRunFromRunId(this.turnRunId) === null &&
            !(this.turnRunId ?? "").startsWith("announce:v1:") &&
            // The `message` pseudo-tool IS the visible reply (OpenClaw's
            // delivery mechanism), not user-facing activity: anchoring it
            // would render the reply's own text as an inline tool card
            // (codex P2). It stays on the legacy metadata path.
            asString(event.name) !== "message";
          const toolCallId = asString(event.toolCallId);
          const part: ToolPart = {
            kind: "tool",
            name: asString(event.name),
            phase: asString(event.phase),
            ...(toolCallId ? { toolCallId } : {}),
            ...(anchorable ? { textOffset: this.visibleLineStart } : {}),
            ...(event.input !== undefined ? { input: event.input } : {}),
            ...(event.output !== undefined ? { output: event.output } : {}),
          };
          await this.writer.addToolPart(messageId, part);
          // A successful cron mutation (add/update/remove) ALSO gets its own
          // compact part so the thread renders a dedicated "Crons" section —
          // the user must see their prompt produced/changed scheduled jobs
          // without digging into raw tool cards. Read-only cron actions and
          // errored calls yield null. (OpenClaw only: Hermes tool events
          // carry no args/result to parse — its jobs still surface in
          // Settings > Scheduled via cron.manage.)
          {
            const cronPart = cronPartFromTool(
              asString(event.name),
              asString(event.phase),
              event.input,
              event.output,
            );
            if (cronPart !== null) {
              await this.writer.addCronPart?.(messageId, cronPart);
            }
          }
          // update_plan (GPT-5-family runs): each successful call is a plan
          // snapshot part — the thread renders the newest as the live plan
          // and the user watches steps complete in real time.
          {
            const planPart = planPartFromTool(
              asString(event.name),
              asString(event.phase),
              event.input,
              event.output,
            );
            if (planPart !== null) {
              await this.writer.addPlanPart?.(messageId, planPart);
            }
          }
          // BACKGROUND TASK started (structured {async:true, taskId} on the
          // tool result — image/video generation, any durable gateway work):
          // record the ENGAGEMENT as a task row anchored to THIS message, so
          // the thread's activity indicator keeps running after the turn
          // settles and the delivery run can merge back into this bubble.
          {
            const asyncStart = asyncTaskStartFromTool(
              asString(event.name),
              asString(event.phase),
              event.output,
            );
            if (asyncStart !== null) {
              this.asyncTaskStartedThisTurn = true;
              const engagement = {
                chatId: this.chatId,
                parentMessageId: messageId,
                // The ack landed in THIS run's own message -> correlated.
                anchorExact: true,
                childSessionKey: taskChildKey(asyncStart.taskId),
                kind: "task" as const,
                status: "running" as const,
                taskName: asyncStart.toolName,
              };
              try {
                await this.writer.upsertSubAgent?.(engagement);
              } catch (err) {
                // Non-critical observation write: a transient failure must
                // never abort the frame (it would not be replayed) — but the
                // row is the ONLY seed the reconciliation reads, so retry
                // once off the critical path before giving up.
                console.error(
                  "task engagement upsert failed (retrying once):",
                  (err as Error)?.message ?? err,
                );
                setTimeout(() => {
                  void this.writer.upsertSubAgent?.(engagement).catch((e) =>
                    console.error(
                      "task engagement upsert retry failed:",
                      (e as Error)?.message ?? e,
                    ),
                  );
                }, 2_000);
              }
            }
          }
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
            // Correlation source too: an explicit MEDIA:/mediaUrls delivery
            // whose attach FAILS (readiness race) must stay rescuable by the
            // scan — the directive is stripped from the visible text, so
            // this event is the only place its name appears (codex P1).
            this.noteTurnArtifacts(filename, path);
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
          this.pendingDiscardStream =
            (event as { discardStreamText?: unknown }).discardStreamText === true;
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
          {
            const keys = (event as { observedChildKeys?: unknown })
              .observedChildKeys;
            this.pendingObservedChildKeys = Array.isArray(keys)
              ? keys.filter((k): k is string => typeof k === "string")
              : [];
          }
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
        case "plan.advance": {
          // Item-derived update_plan on a DELIVERY run (no tool frames on the
          // wire — see the normalizer's item branch). Counted here, applied
          // once at flushFinal: only the turn's END knows whether the chain
          // continued (a further spawn) or the pipeline settled.
          this.planAdvancesThisTurn++;
          break;
        }
        case "context.compaction": {
          this.writer.setPhase?.(messageId, "compacting");
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
        case "agent.activity": {
          // Child observation (persisted by the SubAgentObserver, not here) —
          // but it PROVES the delegated work is alive: refresh the parent's
          // awaiting-subagents phase/heartbeat (throttled) so the watchdog
          // never orphans a silent parent whose child still works (codex P2).
          const nowMs = Date.now();
          // Correlate to THIS turn's children (same predicate as the empty-
          // result exemption): a PREVIOUS turn's chatty child must not keep a
          // stuck current turn alive forever (codex P2).
          const childKey =
            typeof (event as { childSessionKey?: unknown }).childSessionKey ===
            "string"
              ? String((event as { childSessionKey?: unknown }).childSessionKey)
              : null;
          const belongsToThisTurn =
            (childKey !== null && this.spawnedChildKeysThisTurn.has(childKey)) ||
            (this.spawnCalledThisTurn &&
              this.spawnedChildKeysThisTurn.size === 0);
          if (
            this.turnActive &&
            messageId !== null &&
            belongsToThisTurn &&
            nowMs - this.lastChildHeartbeatMs >= 60_000
          ) {
            this.lastChildHeartbeatMs = nowMs;
            this.writer.setPhase?.(messageId, "awaiting_subagents");
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
  /** Flatten every string reachable in a tool payload into the turn's
   *  artifact bag (bounded — older chunks stay, overflow is dropped: the
   *  filename of a rescue-worthy file appears in the SAME call that created
   *  it, so early chunks are the valuable ones). */
  private noteTurnArtifacts(...values: unknown[]): void {
    const CAP = 512 * 1024;
    // FIFO walk (never LIFO): tool ARGS come before a possibly huge OUTPUT —
    // the filename of a rescue-worthy file usually rides the args (codex P2).
    const queue = [...values];
    let head = 0;
    while (head < queue.length) {
      if (this.turnArtifactBytes >= CAP) return;
      const v = queue[head++];
      if (typeof v === "string") {
        if (v === "") continue;
        // Truncate to the remaining budget: one multi-megabyte tool output
        // must not blow past the announced cap (codex P2).
        const room = CAP - this.turnArtifactBytes;
        const chunk = v.length > room ? v.slice(0, room) : v;
        this.turnArtifactChunks.push(chunk);
        this.turnArtifactBytes += chunk.length;
      } else if (Array.isArray(v)) {
        queue.push(...v);
      } else if (typeof v === "object" && v !== null) {
        queue.push(...Object.values(v));
      }
    }
  }

  /** TRUE when the turn's artifacts name `name` — the outbound scan's
   *  containment predicate. WHOLE-name match: `report.pdf` inside
   *  `annual-report.pdf` is another file (codex P1), so the char before the
   *  hit must not be filename material, and the char after must not extend
   *  it (an extension continuation like `.old` refuses; a sentence period
   *  does not). */
  private turnNames(name: string): boolean {
    if (name === "") return false;
    return this.turnArtifactChunks.some((c) => chunkNamesFile(c, name));
  }

  private finalizeInFlight = false;

  private async flushFinal(status: FinalizeStatus): Promise<void> {
    const messageId = this.messageId;
    if (messageId === null || !this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.finalizeInFlight = true;
    try {
      await this.flushFinalInner(messageId, status);
    } finally {
      this.finalizeInFlight = false;
    }
  }

  private async flushFinalInner(
    messageId: string,
    status: FinalizeStatus,
  ): Promise<void> {
    // DETERMINISTIC outbound media — PHASE 1 (DETECT, fast, no upload): list any
    // file the agent dropped in the outbound dir this turn (LLM omitted MEDIA:,
    // or an explicit delivery lost a readiness race). Runs first so the
    // text-first gate below knows the FULL media set. Best-effort.
    let scanHost: (() => Promise<void>) | null = null;
    let scanCandidates = 0;
    if (this.outboundScan) {
      try {
        // The reply text is part of the turn's artifacts too (an agent that
        // wrote "j'ai produit rapport.pdf" without MEDIA: still names it).
        // Pushed DIRECTLY, bypassing the cap: an early oversized tool-args
        // chunk must never starve the final reply out of the correlation
        // (codex P2). Bounded on its own.
        const replyArtifact = this.hasPendingFinal ? this.pendingFinalText : "";
        if (replyArtifact !== "") {
          this.turnArtifactChunks.push(replyArtifact.slice(0, 64 * 1024));
        }
        const r = await this.outboundScan(
          messageId,
          this.chatId,
          this.turnStartMs,
          this.hostedThisTurn,
          (name) => this.turnNames(name),
        );
        scanHost = r.host;
        scanCandidates = r.candidates.length;
        // The predicate is consumed at DETECT time (candidates are already
        // filtered) — release the bag now instead of holding up to the cap
        // across an idle session until the next turn (codex P2).
        this.turnArtifactChunks = [];
        this.turnArtifactBytes = 0;
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
    // A held gate remnant that never diverged NOR matched the full sentinel
    // (e.g. an abort after 3 chars): it is part of the streamed reply — flush
    // it so the fallback text is complete. A full-sentinel hold stays unwritten.
    if (
      this.sentinelGate !== null &&
      this.sentinelGate.trim() !== "" &&
      this.sentinelGate.trim() !== "NO_REPLY"
    ) {
      try {
        await this.writer.appendDelta(messageId, this.sentinelGate);
      } catch {
        /* best-effort — the final text below still carries the full reply */
      }
    }
    this.sentinelGate = null;
    let replyText = this.hasPendingFinal ? this.pendingFinalText : "";
    // The NO_REPLY protocol sentinel is SILENCE, not content: a top-level
    // model reply of exactly the sentinel must neither render nor count as
    // visible work — it falls through to the zero-work guard below instead of
    // settling a bubble that literally shows "NO_REPLY" (codex P2).
    const sentinelOnly = replyText.trim() === "NO_REPLY";
    if (sentinelOnly) replyText = "";
    let effectiveStatus = status;
    let effectiveError = this.pendingFinalError;
    let effectiveErrorKind = this.pendingFinalErrorKind;
    // A RETRYABLE provider failure on a turn that already GENERATED media it
    // never delivered (native imageGeneration billed, delivery lost): the
    // auto-retry would re-bill that generation (codex P1 — the undelivered
    // signal is trace-only, invisible to the Convex gates). Reclass to the
    // WORKED-but-undelivered class (non-retryable, honest delivery-failure
    // card); the provider error text stays as the detail.
    if (
      effectiveErrorKind === "provider_internal" &&
      this.pendingMediaGeneratedUndelivered
    ) {
      effectiveErrorKind = EMPTY_RESPONSE_CODE;
    }
    // A DELIVERY run's terminal `aborted` with nothing streamed is the gateway
    // closing a TOOL-ONLY continuation turn (measured live 2026.7.1: an
    // announce turn that only ran update_plan/sessions_spawn ends
    // state=aborted with no content) — never a user stop on visible work.
    // Fold it to complete so a bubble the turn merged into keeps its settled
    // look (its parts stay). A real abort of streamed text keeps aborting.
    if (
      status === "aborted" &&
      isDeliveryRunId(this.turnRunId) &&
      !this.userAbortThisTurn &&
      !this.sawVisibleText &&
      replyText.trim().length === 0 &&
      effectiveError === null
    ) {
      effectiveStatus = "complete";
    }
    if (
      status === "complete" &&
      // DELIVERY runs are exempt: their tool-only turns legitimately end with
      // no text of their own (the item-derived cards ARE the content, and the
      // turn usually merged into an already-complete bubble) — the guard
      // would misread every one of them as an empty response.
      !isDeliveryRunId(this.turnRunId) &&
      effectiveErrorKind === null &&
      replyText.trim().length === 0 &&
      (!this.sawVisibleText || sentinelOnly) &&
      // An EXPLICIT hand-off (sessions_yield): the parent deliberately answers
      // nothing — the child announces later. Unambiguous, and it catches the
      // ASYNC case the child-key intersection below cannot (the child ran after
      // the yield, so no child key was on THIS turn's wire — live prod denis
      // 2026-07-10, falsely flagged empty_response).
      !this.yieldCalledThisTurn &&
      // A background task was STARTED this turn (async tool ack): the reply
      // arrives later as the task's correlated delivery run — a silent end
      // here is the async pattern, not an empty response.
      !this.asyncTaskStartedThisTurn &&
      // A child SPAWNED BY THIS TURN was observed working (intersection of the
      // turn's own spawn results with the observed child keys): the parent
      // ending silent is the ANNOUNCE pattern (reply arrives as a spontaneous
      // turn) — keep the pre-0.34 contract, never an error card (ms79rj0e…).
      !(
        this.pendingObservedChildKeys.some((k) =>
          this.spawnedChildKeysThisTurn.has(k),
        ) ||
        // Fallback (gateway variance: spawn result without a child key): the
        // turn CALLED the spawn tool and SOME child activity was observed —
        // ONLY when no key could be extracted at all. When keys WERE extracted,
        // the intersection above is the sole judge (a stale old child must not
        // ride a failed intersection through this fallback — codex).
        (this.spawnCalledThisTurn &&
          this.spawnedChildKeysThisTurn.size === 0 &&
          this.pendingObservedChildKeys.length > 0)
      ) &&
      this.hostedThisTurn.size === 0
      // No "the agent WORKED" requirement anymore: a top-level turn the
      // gateway closes CLEANLY with zero content and zero activity (a silent
      // NO_REPLY reply, an end-of-run grace with nothing) rendered as a
      // SILENT empty complete bubble — the user cannot tell a failure from
      // "nothing to say" (live prod 2026-07-19 ×3: 7-8 min thinking runs all
      // settled empty; reproduced live 2026-07-20 with the NO_REPLY
      // sentinel). Every legitimate silent class is already exempted above
      // (delivery/announce runs, yield hand-off, async task start, observed
      // children, private ack, media in flight).
    ) {
      effectiveStatus = "error";
      const zeroWork =
        this.toolCallCount === 0 &&
        !this.hasPendingMedia &&
        scanCandidates === 0 &&
        !this.pendingMediaGeneratedUndelivered;
      if (zeroWork) {
        // Clean close with nothing at all (the Fabien signature, prod
        // 2026-07-19 ×3; reproduced live 2026-07-20 via NO_REPLY) — the ONLY
        // auto-retryable empty class (zero work = re-running bills nothing).
        effectiveError = SILENT_RESPONSE_TEXT;
        effectiveErrorKind = SILENT_RESPONSE_CODE;
      } else {
        effectiveError = EMPTY_RESPONSE_TEXT;
        effectiveErrorKind = EMPTY_RESPONSE_CODE;
      }
    }
    if (this.planAdvancesThisTurn > 0) {
      // Apply the delivery turn's plan movement now that the chain outcome is
      // known: a turn that spawned a further child advances one step per
      // update_plan call; a turn that spawned nothing may settle the plan
      // (Convex checks that no child is still running). Best-effort — a plan
      // estimation must never break the finalize.
      try {
        await this.writer.advancePlanPart?.(
          messageId,
          this.planAdvancesThisTurn,
          // Settle only when update_plan was the turn's ONLY tool activity
          // AND the turn closed successfully: any other call (spawn, async
          // generation, exec) may be the next link of the chain — its item
          // carries no taskId/childSessionKey, so no engagement row exists
          // yet for Convex's idle check — and an errored/aborted close must
          // never mark the whole plan done (codex P2). The one-step advances
          // themselves stand: their update_plan calls DID complete.
          this.otherToolCallsThisTurn === 0 && effectiveStatus === "complete",
        );
      } catch (e) {
        console.error(
          "[sink] plan advance failed (non-fatal):",
          (e as Error)?.message ?? e,
        );
      }
    }
    // The error string (if any) was buffered from message.final; on a clean turn
    // it is null. lifecycle:error finalizes with both partial text + error.
    await this.writer.finalize(
      messageId,
      effectiveStatus,
      replyText,
      effectiveError,
      effectiveErrorKind,
      // Discard the live-stream fallback whenever the reply was the SENTINEL
      // (even on a turn that worked — yield/tool then NO_REPLY, codex P2), the
      // turn classed SILENT (its stream holds only noise/whitespace, which
      // would also block the auto-retry via finalTextLen>0), or the PROVIDER
      // marked the streamed text as noise (promoted Hermes failure prose —
      // codex P1: without the flag the prose survives as the reply via the
      // stream fallback and blocks the retry). Atomic with the finalize.
      sentinelOnly ||
        effectiveErrorKind === SILENT_RESPONSE_CODE ||
        this.pendingDiscardStream
        ? { discardStreamText: true }
        : undefined,
    );
    // A visible task-delivery run also settles its engagement here (the
    // Convex-side settle on startAssistant covers the merge path; this one is
    // the belt for a delivery that opened its own bubble).
    await this.settleTaskDeliveryEngagement();
    // Stats: a turn that ends in ERROR (never a user abort) counts as a
    // downstream failure on its target — AFTER the finalize so a stats throw
    // can never break the turn lifecycle.
    if (effectiveStatus === "error") {
      try {
        this.onTurnError?.(effectiveErrorKind ?? "gateway_error");
      } catch {
        // observability-only — never let stats break a finalize
      }
    }
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
    // REAL window usage of this turn -> the chat's context gauge. The
    // sessions.get totalTokens is CUMULATIVE under a context engine (LCM):
    // dividing it by the window read 859% in prod. Fire-and-forget.
    const active = this.pendingDiagUsage?.totalTokens;
    if (active != null && active > 0) {
      void this.writer
        .reportSessionActiveTokens?.(this.chatId, active, Date.now())
        ?.catch((e) =>
          console.error(
            "[session-active-tokens] skipped (non-fatal):",
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
      // A tool START alone must not open a spontaneous bubble: a NO_REPLY
      // delivery run may do invisible work and end bubble-less (its start is
      // buffered and replayed if a visible event opens the bubble later). The
      // completed/error card keeps the historic open-on-activity behavior.
      return asString((event as { phase?: unknown }).phase) !== "start";
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

// Anything that can CONTINUE a filename on a Unix filesystem: Unicode
// letters/digits (accented names are common here) plus the usual joiners.
// `~` included (backup suffixes). Everything else — spaces, quotes,
// brackets, slashes, punctuation — delimits (codex P1).
const FILENAME_CHAR = /[\p{L}\p{N}._~-]/u;

/** WHOLE-name occurrence of `name` in `chunk` (see turnNames). Pure.
 *  KNOWN residual: a Unix filename may itself contain spaces/punctuation
 *  ("IFOA Presentation.pdf"), so a foreign file named exactly like the TAIL
 *  of a mentioned space-containing name still whole-matches. Accepted:
 *  reaching it requires an exact tail collision inside the turn's own mtime
 *  window on top of the args-only sourcing — defense in depth, not a proof
 *  of creation (a per-conversation outbound dir would be the real proof;
 *  that is a gateway-side layout change, out of the bridge's hands). */
export function chunkNamesFile(chunk: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const i = chunk.indexOf(name, from);
    if (i < 0) return false;
    from = i + 1;
    const before = i > 0 ? (chunk[i - 1] as string) : "";
    // A filename char right BEFORE the hit means we matched a suffix of a
    // longer name (`annual-report.pdf` vs `report.pdf`). Path separators are
    // fine (`outbound/report.pdf`).
    if (before !== "" && FILENAME_CHAR.test(before)) continue;
    const after = i + name.length < chunk.length ? (chunk[i + name.length] as string) : "";
    if (after === "" || !FILENAME_CHAR.test(after)) return true;
    // A dot may end a SENTENCE ("j'ai produit report.pdf.") — only a dot that
    // CONTINUES into filename material extends the name (`report.pdf.old`).
    if (after === ".") {
      const next = i + name.length + 1 < chunk.length ? (chunk[i + name.length + 1] as string) : "";
      if (next === "" || !FILENAME_CHAR.test(next)) return true;
    }
    // Otherwise the hit extends into a longer name — keep scanning.
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
