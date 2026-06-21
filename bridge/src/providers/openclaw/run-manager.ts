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

  constructor(
    chatId: string,
    sessionKey: string,
    writer: ConvexWriter,
    outboundScan?: OutboundScan,
  ) {
    this.sessionKey = sessionKey;
    this.normalizer = new Normalizer(sessionKey);
    this.sink = new TurnSink(chatId, writer, outboundScan);
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

  get isFinalized(): boolean {
    return this.normalizer.finalized;
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
   */
  disarmReplayBuffer(): void {
    this.replayArmed = false;
    this.pendingFrames = [];
  }

  /**
   * Start a new assistant turn. Seeds ownRunIds from the chat.send ack runId
   * (foreign-run isolation) BEFORE the sink creates the streaming message, so
   * ordering matches the pre-refactor monolith. Call before feeding any frames.
   */
  async beginTurn(now: number, ackRunId: string | null): Promise<void> {
    this.normalizer.beginTurn(now);
    this.frameTally.clear();
    this.frameSampled.clear();
    this.tallyDumped = false;
    if (ackRunId) {
      this.normalizer.noteRunStarted(ackRunId, now);
    }
    await this.sink.beginTurn(ackRunId);
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
  }

  /** Feed one raw gateway frame; apply the resulting events to Convex. */
  async feed(frame: unknown, now: number): Promise<void> {
    if (!this.sink.active) {
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
    this.tallyFrame(frame);
    await this.sink.apply(this.normalizer.feed(frame, now));
    this.dumpTallyOnce();
  }

  /** Resolve expired normalizer deadlines; apply any emitted events. */
  async tick(now: number): Promise<void> {
    if (!this.sink.active) {
      return;
    }
    await this.sink.apply(this.normalizer.tick(now));
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
  }

  /**
   * Force-finalize the active turn (e.g. on socket close or a send error). The
   * normalizer emits its terminal pair; the sink flushes it to Convex.
   */
  async endTurn(
    now: number,
    status = "final",
    error: string | null = null,
  ): Promise<void> {
    if (!this.sink.active) {
      return;
    }
    await this.sink.apply(this.normalizer.endTurn(now, status, error));
  }
}
