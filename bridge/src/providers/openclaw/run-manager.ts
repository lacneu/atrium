// RunManager — the OpenClaw-SPECIFIC half of the old monolith: it drives the
// proven Normalizer (begin_turn/feed/tick/next_timeout) and forwards the
// normalized events it emits to the provider-agnostic core `TurnSink`. The
// Normalizer is the only vendor coupling, which is exactly why this class lives
// under providers/openclaw/ and the sink lives in core/ (docs/BRIDGE_ARCHITECTURE
// §2.1). In P2 this driver is absorbed into the OpenClaw `adapter.ts`; for the P1
// refactor it keeps the same public surface session.ts + the tests already use,
// so behavior is byte-identical (the 23 normalizer + 8 run-manager tests pin it).
//
// One RunManager handles one OpenClaw session (one chat).

import { Normalizer } from "./normalizer.js";
import { protocolDrift } from "./protocol-drift.js";
import { TurnSink, type OutboundScan } from "../../core/turn-sink.js";
import type { ConvexWriter } from "../../convex-writer.js";
import {
  MAX_PROVENANCE_PARTS_PER_TURN,
  parseProvenanceFrame,
  provenanceSignature,
  type ProvenancePart,
} from "../../core/provenance.js";

// Cap on the pre-ack frame stash (see `pendingFrames`): bounds memory if a
// dispatch fails and beginTurn never drains it. Generous — a whole turn's worth.
const MAX_PENDING_FRAMES = 1000;
// Cap on the ANNOUNCE stash: it can hold a WHOLE late report streamed during a
// long user turn (deltas + tools), so it is much larger than the pre-ack cap.
// Overflow is logged loudly (a truncated report must never be silent) — the
// bound exists only as an OOM backstop for a pathological gateway.
const MAX_PENDING_ANNOUNCE_FRAMES = 5000;

/**
 * Drives one OpenClaw session's normalized stream into Convex (via TurnSink).
 *
 * Lifecycle per user turn:
 *   1. beginTurn(): reset normalizer state, seed ownRunIds from the chat.send ack
 *      runId (foreign-run isolation), and have the sink create the streaming
 *      assistant message (startAssistant).
 *   2. feed each inbound gateway frame; tick on the normalizer's timeout.
 *   3. the normalizer emits the terminal [message.final, run.status] pair, which
 *      the sink translates into a single writer.finalize().
 */
export class RunManager {
  private readonly normalizer: Normalizer;
  private readonly sink: TurnSink;
  // DIAGNOSTIC (streaming-lag investigation): per-turn tally of the raw frame
  // SHAPES the gateway delivered (type/event/state/has-delta/has-message), plus
  // a one-time 300-char sample per shape. Bounded: one line per NEW shape + one
  // summary per turn — this is what separates "the gateway never sent deltas"
  // from "the normalizer dropped them".
  private frameTally = new Map<string, number>();
  private frameSampled = new Set<string>();
  private tallyDumped = false;
  private readonly sessionKey: string;
  // PRE-TURN provenance stash: context-injecting plugins report at
  // prompt-build, which RACES the chat.send ack -> beginTurn window where
  // feed() drops everything (sink inactive). Stash by runId; beginTurn flushes
  // ONLY the entries matching the ack's runId (stale runs never leak into a
  // later turn). Bounded by the same per-turn cap as the sink.
  private pendingProvenance: { runId: string; part: ProvenancePart }[] = [];
  // PRE-ACK frame stash: response frames (delta/snapshot/tool/media/final) can
  // arrive on the shared socket BEFORE the chat.send `res` ack lands, while the
  // sink is still inactive — feed() would otherwise DROP them and lose the start
  // (or all) of a streaming response. Buffer them (bounded) and REPLAY through
  // the freshly-reset+seeded normalizer in beginTurn. The normalizer's runId
  // filter (ownRunIds seeded from the ack) drops any foreign-run frame on replay.
  private pendingFrames: { frame: unknown; now: number }[] = [];
  // The buffer is ARMED only for the chat.send -> ack window (armReplayBuffer is
  // called right before the request; beginTurn disarms after draining). Outside
  // that window an inactive feed() drops non-provenance frames as before, so a
  // late/background frame arriving AFTER a turn finalizes is NEVER buffered and
  // can never be replayed into the next turn (no stale-frame leak).
  private replayArmed = false;
  // ANNOUNCE frames that arrived while a REAL dispatch was in flight (or while a
  // real turn streamed): they must not open a spontaneous turn mid-send (the real
  // beginTurn would clobber it) NOR ride the pre-ack buffer (the replay seeds
  // ownRunIds with the REAL run -> the announce would be dropped as foreign,
  // losing the report — codex P2). Stash them here; flushed once the sink is
  // inactive again (feed()/tick() flush on the next frame — gateway health/tick
  // frames arrive every ~30s, bounding the delay).
  private pendingAnnounce: { frame: unknown; now: number }[] = [];
  // Announce runs ALREADY turned into a spontaneous turn: a gateway retransmit
  // of the same run's chat:final after finalize must not open a SECOND turn and
  // duplicate the report (codex P2). Bounded FIFO.
  private readonly handledAnnounceRuns = new Set<string>();
  private readonly handledAnnounceOrder: string[] = [];
  // The announce run whose SPONTANEOUS turn is currently driving the sink
  // (null when the current turn is a real dispatch). Lets a real beginTurn
  // detect that it is preempting a deferred announce whose message was never
  // created and un-handle it so the report re-opens later (codex P2).
  private currentSpontaneousRun: string | null = null;
  // Copy of the CURRENT spontaneous run's frames while its deferred message is
  // still unopened: a real dispatch preempting that window un-handles the run,
  // but the frames already fed are gone from the (reset) normalizer — for a
  // final-only/delta-only announce THE report frame itself would be lost. The
  // copy is re-stashed into pendingAnnounce at preemption and purged the moment
  // the deferred message opens (the sink owns delivery from there). Bounded.
  private spontaneousReplayCopy: { frame: unknown; now: number }[] = [];
  // The announce run whose spontaneous turn is being CREATED right now
  // (startAssistant's Convex write in flight): its frames racing that write on
  // the concurrent consume loop must be stashed, not dropped-as-stale (codex P2).

  constructor(
    chatId: string,
    sessionKey: string,
    writer: ConvexWriter,
    outboundScan?: OutboundScan,
    // Health-stats hook (see TurnSink.onTurnError): a turn finalizing in error
    // counts as a downstream failure on this session's target.
    onTurnError?: (code: string) => void,
  ) {
    this.sessionKey = sessionKey;
    this.normalizer = new Normalizer(sessionKey);
    this.sink = new TurnSink(chatId, writer, outboundScan, sessionKey, onTurnError);
  }

  private tallyFrame(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    // Targeted frame dump (BRIDGE_FRAME_DUMP=<substring>): logs every frame
    // whose JSON contains the substring. Diagnostic-only (e.g. capturing the
    // exact 6.5 shape of message-tool deliveries); off unless the env is set.
    const dumpNeedle = process.env.BRIDGE_FRAME_DUMP;
    if (dumpNeedle) {
      try {
        const s = JSON.stringify(frame);
        if (s.includes(dumpNeedle)) {
          console.log(`[frame-dump] ${s.slice(0, 2400)}`);
        }
      } catch {
        /* unserializable frame — tally below still counts it */
      }
    }
    const payload =
      typeof f.payload === "object" && f.payload !== null
        ? (f.payload as Record<string, unknown>)
        : {};
    const key = [
      String(f.type ?? "?"),
      String(f.event ?? "-"),
      typeof payload.state === "string" ? payload.state : "-",
      typeof payload.deltaText === "string" && payload.deltaText ? "delta" : "-",
      payload.message !== undefined ? "msg" : "-",
    ].join("/");
    this.frameTally.set(key, (this.frameTally.get(key) ?? 0) + 1);
    if (!this.frameSampled.has(key)) {
      this.frameSampled.add(key);
      // Default: log ONLY the non-PHI shape key (type/event/state/has-delta/
      // has-msg — booleans, never content). The raw JSON sample can contain
      // conversation text (payload.message / deltaText / tool output), so it is
      // STRICTLY opt-in (BRIDGE_DEBUG / BRIDGE_FRAME_DUMP) to keep PHI out of
      // production logs (SOC2).
      if (process.env.BRIDGE_DEBUG || process.env.BRIDGE_FRAME_DUMP) {
        let sample = "";
        try {
          sample = JSON.stringify(frame).slice(0, 300);
        } catch {
          sample = "<unserializable>";
        }
        console.log(`[frames] first shape ${key}: ${sample}`);
      } else {
        console.log(`[frames] first shape ${key}`);
      }
    }
  }

  private dumpTallyOnce(): void {
    if (this.tallyDumped || !this.normalizer.finalized) return;
    this.tallyDumped = true;
    const parts = [...this.frameTally.entries()]
      .map(([k, n]) => `${k}=${n}`)
      .join(" | ");
    console.log(`[frames] turn summary: ${parts || "(no frames)"}`);
  }

  /** Seconds until the normalizer's nearest deadline (null = idle). */
  nextTimeout(now: number): number | null {
    return this.normalizer.nextTimeout(now);
  }

  /** Forward the normalizer's pure-recv-silence signal (see Normalizer.takeRecvSilence).
   *  The session queries the gateway on it instead of closing the turn. */
  takeRecvSilence(): boolean {
    return this.normalizer.takeRecvSilence();
  }

  /** TRUE when own frames RESUMED since the silence elapse (recv re-armed). */
  get recvDeadlineArmed(): boolean {
    return this.normalizer.recvDeadlineArmed;
  }

  get isFinalized(): boolean {
    return this.normalizer.finalized;
  }

  /** True while the gateway abandoned the run to COMPACT (it will resume): a
   *  connection close in this window must not force-abort the turn. */
  get compactionPending(): boolean {
    return this.normalizer.compactionPending;
  }

  /** The assistant message id for the current/last turn (from the sink) -- the
   *  parent message a sub-agent observation is tagged with for robust correlation. */
  get currentMessageId(): string | null {
    return this.sink.currentMessageId;
  }

  /** True while a turn is actively driving the sink — gates whether
   *  currentMessageId belongs to a LIVE turn (vs the last finished one). */
  get turnActive(): boolean {
    return this.sink.active;
  }

  /** Whether this parent-lane frame belongs to the ACTIVE turn's run. Gates
   *  handing currentMessageId to the sub-agent observer: a STASHED announce
   *  frame arriving mid-turn must not anchor its spawns to the active turn's
   *  unrelated message. Child-lane frames (foreign sessionKey) return false —
   *  their anchor comes from sightings/backfill, never from this shortcut. */
  frameOwnedByActiveTurn(frame: unknown): boolean {
    const rid = sessionRunIdFor(frame, this.sessionKey);
    return rid !== null && this.normalizer.ownRunIds.has(rid);
  }

  /** The ACTIVE turn's run ids — lets the session propagate the turn's message
   *  anchor to the sub-agent observer even for frames it never re-observes
   *  (stashed announce frames replay INSIDE feed()). */
  get activeRunIds(): string[] {
    return [...this.normalizer.ownRunIds];
  }

  /**
   * Arm the pre-ack frame buffer for ONE upcoming turn — call RIGHT BEFORE the
   * chat.send request so response frames that race the ack are captured (not
   * dropped). beginTurn drains + disarms it. Re-arming clears any frames a failed
   * prior send left behind, so stale frames never replay into a later turn.
   */
  armReplayBuffer(): void {
    this.replayArmed = true;
    this.pendingFrames = [];
  }

  /**
   * Disarm the pre-ack buffer WITHOUT draining it — for a send whose `chat.send`
   * THREW before beginTurn could run (so beginTurn's normal disarm never fired).
   * Leaves no armed window lingering between a failed send and the next one (which
   * would otherwise buffer stray/background frames until the next arm). Idempotent.
   *
   * ANNOUNCE frames stashed during the failed send window are NOT dropped with
   * the pre-ack buffer: no turn will finalize to trigger their flush (codex P2),
   * so deliver them now (fire-and-forget — the failed-send error path must not
   * await or fail on the announce delivery).
   */
  disarmReplayBuffer(now: number, onFlushed?: () => void): void {
    this.replayArmed = false;
    this.pendingFrames = [];
    if (this.pendingAnnounce.length > 0) {
      // `now` MUST be the session's monotonic clock (the normalizer arms its
      // recv deadlines against it — an epoch value would park them forever).
      // `onFlushed` fires AFTER the flush settles (the spontaneous turn's
      // deadlines are armed by then) — a caller's wake() issued synchronously
      // would race the async open and could leave the consume loop parked on a
      // null timeout (codex P2).
      void this.flushPendingAnnounce(now)
        .catch((e) =>
          console.error(
            "[announce] post-failed-send flush skipped (non-fatal):",
            (e as Error)?.message ?? e,
          ),
        )
        .finally(() => onFlushed?.());
    } else {
      onFlushed?.();
    }
  }

  /**
   * Start a new assistant turn. Seeds ownRunIds from the chat.send ack runId
   * (foreign-run isolation) BEFORE the sink creates the streaming message, so
   * ordering matches the pre-refactor monolith. Call before feeding any frames.
   *
   * `turnContext` (optional, from the send path's pre-send `sessions.describe` —
   * zero extra gateway calls): the expected session id seeds the normalizer's
   * compaction-by-rotation detector; the pressure counters ride to the sink for
   * the turn's content-free `chat.gateway_pressure` trace. Best-effort — absent
   * on paths that never described the session (sub-agent sends, tests).
   */
  /** Monotonic turn counter — bumped on EVERY beginTurn (user send or spontaneous).
   *  A cross-turn worker (the silence/orphan recovery poll) captures it and
   *  self-cancels on mismatch, so it can never touch a LATER turn (codex P1). */
  turnEpoch = 0;

  async beginTurn(
    now: number,
    ackRunId: string | null,
    turnContext?: {
      expectedSessionId: string | null;
      pressure?: {
        totalTokens: number | null;
        contextTokens: number | null;
        costUsd?: number | null;
      };
      /** Spontaneous (announce) turn: the sink DEFERS creating the assistant
       *  message until the normalizer proves visible content (turn-sink). */
      spontaneous?: boolean;
      /** THIS send prepended rehydration history: the gateway will chew it
       *  silently first — surfaced as the `processing_history` phase. */
      rehydrated?: boolean;
    },
  ): Promise<void> {
    // PREEMPTION guard: a real dispatch resetting the pipeline while a deferred
    // announce turn is still INVISIBLE (no assistant message created — the chat
    // did not look busy, so a user send slipped in) would leave that run marked
    // handled with nothing delivered; its later frames would then drop as stale
    // retransmissions and the report would be lost (codex P2). Un-handle it:
    // the remaining frames re-stash via the normal announce paths and re-open a
    // fresh spontaneous turn after this real turn ends.
    if (
      this.currentSpontaneousRun !== null &&
      turnContext?.spontaneous !== true &&
      this.sink.deferredUnopened
    ) {
      this.unmarkAnnounceHandled(this.currentSpontaneousRun);
      // Requeue the already-fed frames (in order, ahead of anything stashed):
      // a final-only announce's ONLY frame lives here — without the requeue
      // the un-handling alone could not resurrect the report (codex P2).
      this.pendingAnnounce = [
        ...this.spontaneousReplayCopy,
        ...this.pendingAnnounce,
      ].slice(0, MAX_PENDING_ANNOUNCE_FRAMES);
    }
    this.spontaneousReplayCopy = [];
    this.currentSpontaneousRun =
      turnContext?.spontaneous === true ? ackRunId : null;
    this.turnEpoch++;
    this.normalizer.beginTurn(now);
    this.normalizer.noteExpectedSessionId(
      turnContext?.expectedSessionId ?? null,
    );
    this.frameTally.clear();
    this.frameSampled.clear();
    this.tallyDumped = false;
    if (ackRunId) {
      this.normalizer.noteRunStarted(ackRunId, now);
    }
    await this.sink.beginTurn(
      ackRunId,
      turnContext?.pressure,
      turnContext?.spontaneous === true,
      turnContext?.rehydrated === true,
    );
    // Flush the pre-turn provenance stash for THIS run only; entries from any
    // other run (a failed earlier dispatch, a foreign run) are dropped here.
    const matched = ackRunId
      ? this.pendingProvenance.filter((p) => p.runId === ackRunId)
      : [];
    this.pendingProvenance = [];
    if (matched.length > 0) {
      await this.sink.apply(matched.map((p) => ({ type: "provenance", part: p.part })));
    }
    // Replay response frames that raced ahead of the ack, in arrival order,
    // through the now-active sink + seeded normalizer — so the start of a
    // streaming response is never lost. Foreign-run frames are filtered by the
    // normalizer's runId guard; the buffer is drained either way.
    const raced = this.pendingFrames;
    this.pendingFrames = [];
    for (const { frame, now: frameNow } of raced) {
      this.tallyFrame(frame);
      await this.sink.apply(this.normalizer.feed(frame, frameNow));
    }
    if (raced.length > 0) {
      this.dumpTallyOnce();
    }
    // Disarm: between turns (sink inactive, NOT armed) feed() drops non-provenance
    // frames, so a late/background frame can't accumulate and replay later.
    this.replayArmed = false;
    // The replay itself can FINALIZE the turn (a whole response raced the ack):
    // deliver any announce stashed during the send window now — no later
    // feed/tick is guaranteed once the loop goes idle (codex P2). No-op while
    // the turn is still streaming (sink active) or when called FROM the flush
    // (the spontaneous turn just went active).
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }

  /** Feed one raw gateway frame; apply the resulting events to Convex. */
  async feed(frame: unknown, now: number): Promise<void> {
    // Observe-only protocol-drift classification (never gates the frame).
    protocolDrift.observe(frame);
    if (!this.sink.active) {
      // --- GATEWAY-INITIATED POST-TURN RUN (the "announce" delivery) ----------
      // When a sub-agent finishes AFTER its parent turn ended (sessions_yield /
      // the maxConcurrent queue), the gateway starts a run ON OUR OWN SESSION
      // with runId `announce:v1:<childSessionKey>:<childRunId>` and streams the
      // parent's consolidated report as a NORMAL turn (lifecycle start ->
      // assistant/chat deltas -> chat final; live-captured 2026-07-03). Without
      // admission, that final answer (and any generated files) is silently
      // dropped here — the user never sees the result they paid for. Open a
      // SPONTANEOUS turn: same beginTurn as a real dispatch (startAssistant
      // creates the assistant message; ownRunIds seeded with the announce run),
      // then feed this frame through. Guards: the frame must carry EXACTLY our
      // sessionKey (no isolation relaxation) and must not race an in-flight
      // chat.send (replayArmed) — in that rare window the pre-ack buffer keeps
      // its existing semantics.
      const announceRun = announceRunIdFor(frame, this.sessionKey);
      if (announceRun !== null && this.handledAnnounceRuns.has(announceRun)) {
        // Stale retransmit of a finished announce: NEVER the pre-ack buffer
        // (beginTurn's replay could admit it as a follow-up during a
        // lifecycle-end/compaction grace and overwrite the user's reply with
        // the old report — codex P1), never a new turn. Drop outright.
        return;
      }
      if (announceRun !== null) {
        if (this.replayArmed) {
          // A real dispatch is in flight: stash — flushed after that turn ends.
          // Never the pre-ack buffer (the replay would drop it as foreign-run).
          this.stashAnnounceFrame(frame, now);
          return;
        }
        if (this.pendingAnnounce.length > 0) {
          // Earlier frames of this (or a prior) announce run are stashed from a
          // send/turn overlap — they must replay FIRST or the run would start
          // mid-stream (deltas before its lifecycle start — codex P2). Append
          // the current frame and drain the whole stash in arrival order; the
          // recursive feed() below opens the spontaneous turn on the oldest.
          this.stashAnnounceFrame(frame, now);
          await this.flushPendingAnnounce(now);
          return;
        }
        // Open the SPONTANEOUS turn immediately — but with a DEFERRED message
        // (turn-sink deferOpen): the normalizer is the sole judge of content
        // across every gateway shape (string content, delta-only, message-tool,
        // history recovery...), and the sink only creates the assistant message
        // on the first user-visible normalized event. A run that terminates
        // silent (the NO_REPLY sentinel) never creates anything — zero bubble.
        this.noteAnnounceHandled(announceRun);
        await this.beginTurn(now, announceRun, {
          expectedSessionId: null,
          spontaneous: true,
        });
        this.noteSpontaneousFrame(frame, now);
        this.tallyFrame(frame);
        await this.sink.apply(this.normalizer.feed(frame, now));
        // Earlier frames of this run stashed from a send/turn overlap replay
        // through the now-active pipeline (other runs' frames re-stash via the
        // active branch).
        if (this.pendingAnnounce.length > 0) {
          const raced = this.pendingAnnounce;
          this.pendingAnnounce = [];
          for (const entry of raced) {
            await this.feed(entry.frame, entry.now);
          }
        }
        return;
      }
      // Any inactive-window activity (gateway health/tick frames arrive every
      // ~30s) flushes announce frames stashed during a real turn.
      if (this.pendingAnnounce.length > 0) {
        await this.flushPendingAnnounce(now);
        // The current frame still gets its normal inactive-window treatment
        // below (it may itself be a provenance report or a raced response).
        if (this.sink.active) {
          // The flush opened a spontaneous turn — feed the current frame through
          // the ACTIVE pipeline instead of the inactive branches.
          this.tallyFrame(frame);
          await this.sink.apply(this.normalizer.feed(frame, now));
          return;
        }
      }
      // Inactive window (pre-ack / between turns). Keep two things for the
      // upcoming run: a provenance report (flushed by runId in beginTurn) and any
      // RESPONSE frame that raced ahead of the ack (replayed in beginTurn) — both
      // bounded. Without the latter, a streaming race silently drops the start of
      // the assistant reply.
      const stashed = parseProvenanceFrame(frame, this.sessionKey);
      if (stashed !== null) {
        // Drop an EXACT-duplicate report for THIS run (a plugin hook registered
        // twice on a reload emits the same report 2x → the Sources panel would
        // show every source doubled). De-dup by content signature so distinct
        // reports of the same group (pgvector vs LightRAG) are kept. SCOPE the dedup
        // to the SAME runId: an identical report stashed for a DIFFERENT run must NOT
        // suppress this run's — beginTurn flushes by ackRunId, so the foreign entry
        // is filtered out and this run would otherwise lose all its sources.
        const sig = provenanceSignature(stashed.part);
        const isDup = this.pendingProvenance.some(
          (p) => p.runId === stashed.runId && provenanceSignature(p.part) === sig,
        );
        if (!isDup && this.pendingProvenance.length < MAX_PROVENANCE_PARTS_PER_TURN) {
          this.pendingProvenance.push(stashed);
        }
      } else if (this.replayArmed && this.pendingFrames.length < MAX_PENDING_FRAMES) {
        // Only while a chat.send is in flight (armed). Between turns the buffer
        // stays empty, so post-finalization stray frames are never replayed.
        this.pendingFrames.push({ frame, now });
      }
      return;
    }
    // ACTIVE turn: a late announce for ANOTHER run must not reach the
    // normalizer (its foreign-run filter would drop it — the report would be
    // lost whenever the user sends a new message before a slow child's announce,
    // codex P2). Stash it; the post-turn flush opens its spontaneous turn. The
    // CURRENT spontaneous announce turn's own frames pass through. A RETRANSMIT
    // of an already-handled announce that is NOT the current turn's run is
    // DROPPED outright (codex P1): during a lifecycle-end/compaction grace the
    // normalizer admits foreign runIds as follow-ups — a stale announce
    // chat:final slipping in there could finalize/replace the user's in-flight
    // reply.
    const activeAnnounce = announceRunIdFor(frame, this.sessionKey);
    if (activeAnnounce !== null) {
      if (!this.handledAnnounceRuns.has(activeAnnounce)) {
        this.stashAnnounceFrame(frame, now);
        return;
      }
      if (!this.normalizer.ownRunIds.has(activeAnnounce)) {
        return; // stale retransmit of a finished announce — never the normalizer
      }
      this.noteSpontaneousFrame(frame, now);
    }
    // PRE-ACK window DURING an active (announce) turn: a user send can arm the
    // replay buffer while a spontaneous turn still drives the sink (the chat
    // did not look busy). A frame of the UPCOMING real run racing its ack must
    // reach the pre-ack buffer — fed to the normalizer now it would be dropped
    // as foreign (ownRunIds still = the announce run) and the start of the
    // user's reply would be lost (codex P2). Frames of the CURRENT run (in
    // ownRunIds) keep flowing; child-lane frames carry the child's sessionKey
    // and are unaffected.
    if (this.replayArmed) {
      const rid = sessionRunIdFor(frame, this.sessionKey);
      if (rid !== null && !this.normalizer.ownRunIds.has(rid)) {
        if (this.pendingFrames.length < MAX_PENDING_FRAMES) {
          this.pendingFrames.push({ frame, now });
        }
        return;
      }
    }
    this.tallyFrame(frame);
    await this.sink.apply(this.normalizer.feed(frame, now));
    this.dumpTallyOnce();
    // If that frame FINALIZED the turn, deliver any announce stashed during it
    // RIGHT NOW: the consume loop may go idle (nextTimeout null) with no later
    // tick guaranteed — waiting for the next frame could park the report
    // indefinitely (codex P2).
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }

  /** Resolve expired normalizer deadlines; apply any emitted events. */
  async tick(now: number): Promise<void> {
    if (!this.sink.active) {
      // Between turns: drain announce frames stashed while a real turn streamed
      // (the other flush point beside feed(); whichever fires first wins).
      await this.flushPendingAnnounce(now);
      return;
    }
    await this.sink.apply(this.normalizer.tick(now));
    // A deadline-driven finalize must also deliver stashed announces (same
    // no-later-tick-guaranteed rationale as feed()).
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }

  /**
   * Drain stashed ANNOUNCE frames once no real turn is active: re-feed them in
   * arrival order — feed() re-evaluates each one (the first opens the
   * spontaneous turn; frames of an already-handled run fall through and drop).
   * Re-entrancy-safe: the stash is taken before feeding, and a frame that must
   * wait again (a new send armed mid-flush) simply re-stashes.
   */
  private async flushPendingAnnounce(now: number): Promise<void> {
    if (this.sink.active || this.replayArmed || this.pendingAnnounce.length === 0) {
      return;
    }
    const stashed = this.pendingAnnounce;
    this.pendingAnnounce = [];
    for (const entry of stashed) {
      if (entry.frame === null) continue; // overflow marker, not a frame
      await this.feed(entry.frame, now);
    }
  }


  /** Keep a bounded replay copy of the current spontaneous run's frames while
   *  its deferred message is UNOPENED (preemption insurance); purge the copy —
   *  it is dead weight — the moment the message opens. */
  private noteSpontaneousFrame(frame: unknown, now: number): void {
    if (!this.sink.deferredUnopened) {
      if (this.spontaneousReplayCopy.length > 0) {
        this.spontaneousReplayCopy = [];
      }
      return;
    }
    if (this.spontaneousReplayCopy.length < MAX_PENDING_ANNOUNCE_FRAMES) {
      this.spontaneousReplayCopy.push({ frame, now });
    }
  }

  /** Stash an announce frame (bounded). Overflow is LOUD: dropping part of a
   *  late report must be visible in the logs, never a silent truncation. */
  private stashAnnounceFrame(frame: unknown, now: number): void {
    if (this.pendingAnnounce.length >= MAX_PENDING_ANNOUNCE_FRAMES) {
      if (this.pendingAnnounce.length === MAX_PENDING_ANNOUNCE_FRAMES) {
        // Log once per overflow episode (the marker entry below keeps length
        // above the cap so this branch logs a single time).
        console.error(
          "[announce] stash overflow: a late report is being TRUNCATED (cap",
          MAX_PENDING_ANNOUNCE_FRAMES,
          "frames) — pathological gateway stream",
        );
        this.pendingAnnounce.push({ frame: null, now });
      }
      return;
    }
    this.pendingAnnounce.push({ frame, now });
  }

  /** Roll back a handled mark whose spontaneous turn never delivered (the
   *  message was never created before a real dispatch preempted it). */
  private unmarkAnnounceHandled(runId: string): void {
    this.handledAnnounceRuns.delete(runId);
    const idx = this.handledAnnounceOrder.lastIndexOf(runId);
    if (idx >= 0) this.handledAnnounceOrder.splice(idx, 1);
  }

  /** Record an announce run as handled (bounded FIFO — a retransmitted terminal
   *  frame for the same run must never open a duplicate spontaneous turn). */
  private noteAnnounceHandled(runId: string): void {
    this.handledAnnounceRuns.add(runId);
    this.handledAnnounceOrder.push(runId);
    while (this.handledAnnounceOrder.length > 100) {
      const oldest = this.handledAnnounceOrder.shift();
      if (oldest !== undefined) this.handledAnnounceRuns.delete(oldest);
    }
  }

  /**
   * History-recovery seam (the webchat sink): true exactly once per turn when
   * the normalizer holds a bare ack after a gateway-delivered message-tool —
   * the session loop should fetch `sessions.get` and call `recoverVisibleText`.
   */
  takeRecoveryRequest(): boolean {
    if (!this.normalizer.wantsHistoryRecovery) {
      return false;
    }
    this.normalizer.markRecoveryAttempted();
    return true;
  }

  /** Apply transcript-recovered text as the answer (finalizes the turn). */
  async recoverVisibleText(text: string, now: number): Promise<void> {
    if (!this.sink.active) {
      return;
    }
    await this.sink.apply(this.normalizer.recoverVisibleText(text, now));
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }

  /**
   * Force-finalize the active turn (e.g. on socket close or a send error). The
   * normalizer emits its terminal pair; the sink flushes it to Convex.
   */
  async endTurn(
    now: number,
    status = "final",
    error: string | null = null,
    cause = "external",
  ): Promise<void> {
    if (!this.sink.active) {
      return;
    }
    await this.sink.apply(this.normalizer.endTurn(now, status, error, cause));
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }
}

/**
 * The gateway-initiated post-turn run detector: returns the frame's runId when
 * it is an ANNOUNCE run addressed to THIS session, else null. Contract pinned
 * on live capture (2026-07-03): `event: "agent" | "chat"`, `payload.sessionKey`
 * EXACTLY our session (never a prefix match — isolation stays strict), and
 * `payload.runId` prefixed `announce:` (v1 today:
 * `announce:v1:<childSessionKey>:<childRunId>`; the version segment is treated
 * as opaque so a future v2 keeps being admitted).
 */
function announceRunIdFor(frame: unknown, sessionKey: string): string | null {
  const runId = sessionRunIdFor(frame, sessionKey);
  return runId !== null && runId.startsWith("announce:") ? runId : null;
}

/** The frame's runId when it is an agent/chat event addressed EXACTLY to this
 *  session (child-lane frames carry the child's key -> null). */
function sessionRunIdFor(frame: unknown, sessionKey: string): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.event !== "agent" && f.event !== "chat") return null;
  const payload = f.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.sessionKey !== sessionKey) return null;
  const runId = p.runId;
  return typeof runId === "string" && runId ? runId : null;
}

