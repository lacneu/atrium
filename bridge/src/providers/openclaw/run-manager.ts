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

import { randomUUID } from "node:crypto";
import type { PresendDescribeOutcome } from "../../core/pressure-telemetry.js";
import { Normalizer, type SettledCompletion } from "./normalizer.js";
import { protocolDrift } from "./protocol-drift.js";
import { TurnSink, type OutboundScan, type RunFactWrite } from "../../core/turn-sink.js";
import type { SessionFillSource } from "../../core/context-budget.js";
import type { FinalizeCause } from "../../core/finalize-causes.js";
import { taskDeliveryRunFromRunId } from "../../core/async-task.js";
import {
  compactionCompleted,
  compactionFailedForGood,
} from "../../core/compaction-verdict.js";
import {
  isRelayOwnedTalkRun,
  isTalkConsultRunId,
} from "../../core/talk-consult.js";
import { ConvexIngestError, lateFinalAskedOnce, type ConvexWriter } from "../../convex-writer.js";
import { EVENT_SESSION_OVERFULL, type BridgeEvent } from "../../core/events.js";
import { modelFallbackFromFrame, type ModelFallback } from "./model-fallback.js";
import { sanitizeText } from "./sanitize.js";
import {
  MAX_PROVENANCE_PARTS_PER_TURN,
  parseProvenanceFrame,
  provenanceSignature,
  type ProvenancePart,
} from "../../core/provenance.js";
import { EXEC_APPROVAL_FOLLOWUP_PREFIX } from "./run-families.js";
import {
  ApprovalGenerations,
  ApprovalIdentitySet,
  approvalIdentity,
  type ApprovalGeneration,
} from "./approval-identity.js";
import { redactAllQuestionAnswers } from "../../core/secret-answer-redaction.js";
import { errForLog } from "../../core/log-safe-error.js";

// Cap on the pre-ack frame stash (see `pendingFrames`): bounds memory if a
// dispatch fails and beginTurn never drains it. Generous — a whole turn's worth.
const MAX_PENDING_FRAMES = 1000;
/** A status notice is one line of the gateway's own text; anything longer is cut. */
const MAX_GATEWAY_NOTICE_CHARS = 2000;

/** Something the gateway states about a run that is not the run's content. */
type RunFact = { kind: "fallback"; fallback: ModelFallback } | { kind: "notice"; text: string };

/** A run's facts still to write, oldest first. */
interface RunFactQueue {
  facts: RunFact[];
  /** A turn owning the run has ended: "no bubble" is then Convex's last word. */
  settled: boolean;
  /** A write pass for this run is queued and has not started: another is not stacked. */
  scheduled: boolean;
}
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
/** One run's serial lane (see RunManager `lanes`). */
interface RunLane {
  runId: string;
  /** Where its later media and terminal go: the bubble its turn showed — or, when none
   *  opened here, the one the transcript made (looked up in Convex). */
  messageId: string | null;
  /** The run segment that bubble is (the steer cuts before it opened). */
  segment: number;
  /** Set when the destination is the bubble the transcript made under the run's OTHER
   *  name (a link stated late): the name that bubble's writes carry. */
  transcriptRunId?: string;
  /** Frames waiting for the destination to be known (bounded with the lane). */
  awaiting: Array<{ frame: unknown; now: number }>;
  /** Destination lookups made so far (bounded). */
  lookups: number;
  turnStartMs: number;
  createdAt: number;
  /** closing: the close is queued or writing; closed: draining onto the bubble;
   *  aborted: the close was refused — what it holds goes back to the turn; done: its
   *  terminal is written. */
  state: "closing" | "closed" | "aborted" | "done";
  normalizer: Normalizer | null;
  tail: Promise<void>;
  queued: number;
}

/** A settled run's bubble (null: none) and whole visible text. */
type SettledRecord = { messageId: string | null; text: string };

/** A late run link Convex has not recorded yet, with the bubble it is to be recorded on
 *  (RunManager `owedLateLinks`). */
export interface OwedLateLink {
  clientRunId: string;
  executionRunId: string;
  messageId: string;
}
/** A settled bubble's write queue (see `RunManager.offerCompletion`): the completion it
 *  is owed — the latest text offered for that bubble, null when the queue was opened by
 *  a late final and nothing is owed — the record of the turn that settled it, and how
 *  many write passes failed. */
interface KeptCompletion {
  runId: string;
  offer: SettledCompletion | null;
  record: SettledRecord;
  failures: number;
  scheduled: boolean;
  /** The offer whose debt is SETTLED (written, joined, or dropped): a later pass — one
   *  that only has what waits behind to write — does not ask for it again. */
  settledOffer: SettledCompletion | null;
  /** The key of this debt's last-resort join (see `LateFinal.writeKey`): one per bubble
   *  owed, the same across the passes that ask for it again. */
  joinKey: string;
  /** Late finals for the same bubble, in arrival order: written once the debt is
   *  settled (see `RunManager.writeCompletion`). */
  behind: LateFinal[];
}
/** A `chat` final of a settled run (CU-8): the run, its visible text and its record. */
interface LateFinal {
  runId: string;
  text: string;
  settled: SettledRecord;
  /** THIS late final's write, named once: the same key at every attempt to write it, a
   *  different one for another late final — even of the same run with the same text.
   *  Convex answers a repeat with the bubble the first attempt opened. */
  writeKey: string;
  /** Write passes that failed while it waited in a bubble's queue. */
  failures?: number;
}
/** What became of a write on the completion chain. `refused` is an ANSWER (Convex holds
 *  something else; nothing to add; no bubble to join) — `failed` is no answer at all,
 *  and the write can be asked again — `lost` is no answer either, from a write that
 *  cannot be asked again (a Convex from before write keys: a repeat would open a second
 *  bubble). */
type SettledWriteOutcome = "written" | "refused" | "failed" | "lost";

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
  // (or all) of a streaming response. Buffer them (bounded) and REPLAY them in
  // beginTurn, each through the unit a live frame takes once the turn is open. The
  // normalizer's runId filter (ownRunIds seeded from the ack) drops any foreign-run
  // frame on replay.
  private pendingFrames: { frame: unknown; now: number }[] = [];
  // A frame was REFUSED by the pre-ack cap since the last arm: the upcoming turn's
  // stream is known to be incomplete (consumed by beginTurn).
  private pendingFramesOverflowed = false;
  // The buffer is ARMED only for the chat.send -> ack window (armReplayBuffer is
  // called right before the request; beginTurn disarms it as it takes the frames). Outside
  // that window an inactive feed() drops non-provenance frames as before, so a
  // late/background frame arriving AFTER a turn finalizes is NEVER buffered and
  // can never be replayed into the next turn (no stale-frame leak).
  private replayArmed = false;
  // Set while beginTurn replays the pre-ack frames, resolved when the last one has been
  // processed. The replay hands each frame to the SAME unit a live frame takes, one after
  // the other, so it spans several awaits: a frame (or a tick) arriving meanwhile is
  // younger than every frame being replayed and waits here for its turn.
  private replayGate: Promise<void> | null = null;
  // Frames whose chat-scoped compaction verdict was written at arrival: a frame that
  // went on to the pre-ack buffer is not a second verdict when it is replayed.
  private readonly idleVerdictRead = new WeakSet<object>();
  // ANNOUNCE frames that arrived while a REAL dispatch was in flight (or while a
  // real turn streamed): they must not open a spontaneous turn mid-send (the real
  // beginTurn would clobber it) NOR ride the pre-ack buffer (the replay seeds
  // ownRunIds with the REAL run -> the announce would be dropped as foreign,
  // losing the report — codex P2). Stash them here; flushed once the sink is
  // inactive again (feed()/tick() flush on the next frame — gateway health/tick
  // frames arrive every ~30s, bounding the delay).
  private pendingAnnounce: { frame: unknown; now: number }[] = [];
  // Announce runs ALREADY turned into a spontaneous turn: a gateway retransmit of
  // the same run's chat:final after finalize should not open a SECOND turn.
  //
  // HONEST SCOPE (G-15b): this is a BEST-EFFORT recent-window guard — a bounded
  // FIFO of 100 runs, so a retransmit arriving after 100 other announce runs finds
  // nothing here. It is not the guarantee. What durably prevents a duplicate BUBBLE
  // is Convex: the announce merge reopens the parent message and dedupes the replay
  // (`stream.addPart`'s armed-window dedup, keyed by announceRun). This set exists
  // to spare the common case a round trip, not to be the invariant — the comment
  // used to claim otherwise, which is the kind of belief that survives until an
  // incident disproves it.
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

  /**
   * ONE SERIAL LANE PER RUN THE TRANSCRIPT CLOSES (projection `on`, phase 4 — codex
   * passes 17–20). The turn ends on the transcript's fact (`settleFromTranscript`) while
   * the live run may still have something to say: its own terminal. Everything of that
   * run goes through its lane, strictly one item at a time, each awaited to completion:
   * the close finalize, then every frame of the run in arrival order — its live terminal
   * through `finalizeClosedRun` (the terminal Convex waits for before judging a file
   * job). So a failed close never drops what follows: the run stays recorded, with the destination captured when the close was
   * decided. A close the ordered unit refuses (the turn moved on) turns the lane back
   * into the turn's own pipeline for what it holds. Frames of other runs never wait on a
   * lane (the routing is decided synchronously — G-29). Bounded by count, by queued
   * items and by age; removed after the run's terminal or its TTL.
   */
  private readonly lanes = new Map<string, RunLane>();
  static readonly MAX_TRANSCRIPT_CLOSED = 16;
  /** In the INJECTED clock's unit — seconds (session.ts `defaultClock`): every `now` this
   *  class receives is one (codex phase 4 pass 21: a millisecond bound made it ~7 days). */
  static readonly TRANSCRIPT_CLOSED_TTL_S = 10 * 60;
  static readonly MAX_LANE_ITEMS = 256;
  /** Lookups of a closed run's projected bubble before its lane gives up (the Convex
   *  deferred check then settles its file job). One per lane event, never on a timer. */
  static readonly MAX_DESTINATION_LOOKUPS = 3;
  private readonly chatId: string;
  private readonly writer: ConvexWriter;
  private readonly providerSessionId: string | null;

  constructor(
    chatId: string,
    sessionKey: string,
    writer: ConvexWriter,
    outboundScan?: OutboundScan,
    // Health-stats hook (see TurnSink.onTurnError): a turn finalizing in error
    // counts as a downstream failure on this session's target.
    onTurnError?: (code: string) => void,
    /** The provider session Convex stored for this chat — see Normalizer. */
    providerSessionId: string | null = null,
  ) {
    this.sessionKey = sessionKey;
    this.chatId = chatId;
    this.writer = writer;
    this.providerSessionId = providerSessionId;
    this.normalizer = new Normalizer(sessionKey, providerSessionId);
    this.sink = new TurnSink(chatId, writer, outboundScan, sessionKey, onTurnError);
    // No file is taken from the live side of an OpenClaw session — the turn's, the
    // outbound scan's, nor a closed run's lane's: a file is the transcript row's that
    // carries it, copied by its identity (core/artifact-copier.ts).
    this.sink.liveFilesOff = true;
  }

  /** Where the turn's `chat.gateway_pressure` trace reads the gateway version from. */
  setGatewayVersionSource(source: () => string | null): void {
    this.sink.setGatewayVersionSource(source);
  }

  // ── TRANSCRIPT PROJECTION `on` (redesign phase 3) ─────────────────────────────────
  //
  // Sending like the Control UI means a send can land while a run is in the foreground:
  // its ACK is CUSTODY, not a new turn (ui/src/pages/chat/chat-send-delivery.ts:497-502
  // at v2026.9.8, "Accepted steering/queued custody identifies the input, not a
  // replacement for the active model run"). The live overlay then follows the gateway's
  // own facts, three rules of the Control UI, applied ONLY on this switch:
  //   - CU-20: a steered input's `<sendId>:user` row (steerTargetRunId = the foreground
  //     run) cuts the run's bubble — onUserRow → splitSegment;
  //   - CU-9/CU-10, bounded to inputs the gateway holds for us: a run of the session that
  //     is not the foreground one is never folded into it; while it streams it waits,
  //     and once the sink is free it opens its own (deferred) bubble — the announce
  //     machinery, generalised (adoptableRunFor);
  //   - CU-8: a DISTINCT final of a settled run joins its bubble (lateFinalFor).
  // Every OpenClaw session runs them (0.102.0: the switch is gone for OpenClaw).
  /** Inputs the gateway accepted while a run was in the foreground, by send identity. */
  private readonly heldInputs = new Map<
    string,
    {
      ackRunId: string | null;
      userMessageId: string | null;
      steered: boolean;
      answered: boolean;
      /** Runs already live when the gateway accepted the input: none of them is the
       *  run that ANSWERS it (a followup's answer is a run that starts after it) —
       *  except the one the transcript proves it was steered into (steerAdoptRuns). */
      predating: ReadonlySet<string>;
      /** The run adopted as the ANSWER to this input (never a delivery-family run), or
       *  null: what its own ack run is the client name of, once that run speaks. */
      answeredBy: string | null;
    }
  >();
  /** Runs of the session that are NOT the foreground turn's but into which the
   *  transcript proves a held input was steered (`<sendId>:user`.steerTargetRunId):
   *  what they write from there answers that input, in their own bubble. */
  private readonly steerAdoptRuns = new Set<string>();
  /** The ACK run ids of those inputs (custody runs: a bare final for steer/followup). */
  private readonly inputAckRuns = new Map<string, string>();
  /** The SETTLED runs of this session (bounded, insertion-ordered): the bubble each
   *  left (null: none) and the run's whole visible text — every segment of a run cut at
   *  steered inputs — what CU-8 joins a late final to. The runs of one turn share one
   *  record. Kept across turns: a late final of A may follow B's settle. */
  private readonly settledRuns = new Map<string, { messageId: string | null; text: string }>();
  private static readonly MAX_SETTLED_RUNS = 200;
  /** Every run a turn of this session has owned (bounded, insertion-ordered): a late
   *  frame of one of them is that run's tail, never a new run to adopt. */
  private readonly ownedRunHistory = new Set<string>();
  private static readonly MAX_OWNED_RUN_HISTORY = 200;
  private static readonly MAX_HELD_INPUTS = 50;

  // ── ONE RUN, TWO NAMES (2026.10.33) ──────────────────────────────────────────────
  //
  // A queued input keeps its identity upstream from 2026.10.33: when its execution
  // starts, the gateway links the EXECUTION run to the input's CLIENT run
  // (src/gateway/server-methods/chat-send-turn-adoption.ts:289-302, `addChatRun(runId,
  // { clientRunId })`) and from then on broadcasts that run's `agent` and `chat` frames
  // under the client run id (src/gateway/server-chat.ts:1158, `chatLink?.clientRunId ??
  // evt.runId`; src/gateway/server-chat-live-text.ts:114, the envelope's `runId` is
  // swapped, nothing else) — pinned by src/gateway/server-methods/
  // chat-send-queued-identity.test.ts:91-150 (each input's terminal carries its own run
  // id). The transcript keeps the execution run (`__openclaw.runId`), which is the
  // producer's and never a client correlation key (ui/src/pages/chat/
  // session-message-apply.ts:82-85). Through 2026.9.36 the client run was closed at
  // admission and never spoke again (chat-send-agent-dispatch.ts:681-691 there).
  //
  // The bridge holds ONE name for such a run — the transcript's — and renames the
  // frames at the door (`canonicalFrame`), so the turn, the lanes, the run facts and
  // every Convex write name the run the rows name. Two facts establish a link, neither
  // of them a gateway version:
  //   - the input's own ack run SPEAKS after a run was adopted as that input's answer
  //     (a session runs one run at a time — its lane has one slot,
  //     src/process/command-queue.ts:125-129 — so both are that one execution);
  //   - the gateway says so: `sessions.changed` carrying `clientRunId` ≠ `runId`
  //     (src/gateway/server-chat-lifecycle-publication.ts:122), what the Control UI
  //     correlates on (ui/src/pages/chat/chat-state-events.ts:182,345). Best-effort
  //     there (`dropIfSlow`, another socket): it can confirm or precede the first
  //     fact, never be required.
  // `lifecycle end`'s `terminalReceipt.runId` differs from the envelope too, but only
  // because the swap leaves `data` alone: no reader upstream, so it founds nothing here.
  /** Client run id → the execution run it is the wire name of (bounded, oldest first). */
  private readonly runAliases = new Map<string, string>();
  /** The reverse: execution run → its client name (what the gateway acts on). */
  private readonly clientRunIds = new Map<string, string>();
  /** The renamed copy of each frame, so one frame is one object wherever it waits. */
  private readonly canonicalCopies = new WeakMap<object, object>();
  private static readonly MAX_RUN_ALIASES = 100;

  /** Record that `clientRunId` is the wire name of `executionRunId`. Refused when the
   *  client run has been a turn's own run here: it then has a bubble under that name,
   *  and renaming its later frames would split the run instead of joining it. */
  private linkRuns(clientRunId: string, executionRunId: string): boolean {
    if (clientRunId === executionRunId) return false;
    const known = this.runAliases.get(clientRunId);
    if (known !== undefined) return known === executionRunId;
    // No chain, no loop: a name is either a client's or an execution's.
    if (this.runAliases.has(executionRunId) || this.clientRunIds.has(clientRunId)) return false;
    if (this.normalizer.ownRunIds.has(clientRunId) || this.ownedRunHistory.has(clientRunId)) {
      console.warn(
        `[run-link] refused: the client run already has a turn of its own client=${clientRunId.slice(0, 60)} execution=${executionRunId.slice(0, 60)}`,
      );
      return false;
    }
    this.runAliases.set(clientRunId, executionRunId);
    this.clientRunIds.set(executionRunId, clientRunId);
    while (this.runAliases.size > RunManager.MAX_RUN_ALIASES) {
      const oldest = this.runAliases.keys().next().value as string;
      this.clientRunIds.delete(this.runAliases.get(oldest) as string);
      this.runAliases.delete(oldest);
    }
    console.log(
      `[run-link] one run, two names: client=${clientRunId.slice(0, 60)} execution=${executionRunId.slice(0, 60)}`,
    );
    return true;
  }

  /** The execution run `runId` is the client name of, or null. Establishes the link the
   *  first time an input's ack run speaks after a run was adopted as its answer. */
  private executionRunFor(runId: string): string | null {
    const known = this.runAliases.get(runId);
    if (known !== undefined) return known;
    const sendId = this.inputAckRuns.get(runId);
    if (sendId === undefined) return null;
    const answer = this.heldInputs.get(sendId)?.answeredBy ?? null;
    if (answer === null) return null;
    return this.linkRuns(runId, answer) ? answer : null;
  }

  /**
   * The frame under the ONE name of its run: a frame the gateway broadcast under a
   * linked client run id is returned as a copy naming the execution run; any other
   * frame is returned as it is. Every reader of a conversation frame takes it from
   * here, so none of them can open, close or anchor anything on the second name.
   */
  canonicalFrame<T>(frame: T): T {
    if (this.runAliases.size === 0 && this.inputAckRuns.size === 0) return frame;
    const runId = sessionRunIdFor(frame, this.sessionKey);
    if (runId === null) return frame;
    const execution = this.executionRunFor(runId);
    if (execution === null) return frame;
    const original = frame as unknown as { payload: Record<string, unknown> };
    let copy = this.canonicalCopies.get(original);
    if (copy === undefined) {
      copy = { ...original, payload: { ...original.payload, runId: execution } };
      this.canonicalCopies.set(original, copy);
    }
    // A frame that waited under its client name (a stash) was read once already.
    if (this.observedFrames.has(original)) this.observedFrames.add(copy);
    return copy as unknown as T;
  }

  /**
   * The gateway STATED the link (`sessions.changed` with `clientRunId` ≠ `runId`).
   * Taken only for a run this session knows from one side: the client run is the ack
   * run of an input it holds, or the execution run is the foreground turn's (a turn
   * resumed after a restart no longer remembers the input). Returns whether it holds.
   */
  noteRunLink(executionRunId: string, clientRunId: string, now: number): boolean {
    // A late link known already — stated here, read back with a resumed bubble, or carried
    // from the chat's previous socket — is never taken again as an early one.
    const lateKnown = this.lateExecutionRuns.has(clientRunId);
    if (lateKnown || (this.hasOwnTurn(clientRunId) && !this.runAliases.has(clientRunId))) {
      const linked = this.linkLate(clientRunId, executionRunId);
      // The approvals of the execution run noted BEFORE the statement (a reconnection's
      // pending list can precede it) hold the turn now: the run's `waiting-approval` went
      // to the socket that closed, and the observer notes each request once.
      if (linked && this.hasOwnTurn(clientRunId)) {
        void this.holdKeptApprovals(clientRunId, now).catch((err: unknown) =>
          console.error("[approval] hold after a late run link failed:", errForLog(err)),
        );
      }
      return linked;
    }
    const ours =
      this.inputAckRuns.has(clientRunId) ||
      ((this.sink.active || this.sink.finalizing) && this.normalizer.ownRunIds.has(executionRunId));
    return ours && this.linkRuns(clientRunId, executionRunId);
  }

  // ── THE LINK STATED LATE ─────────────────────────────────────────────────────────
  //
  // The statement and the stream travel on two sockets: the client run can SPEAK before
  // anything named its execution run (no frame under that run, no statement yet). Its
  // turn is then open under the client run, with every per-run fact of the stream keyed
  // by it — renaming the frames from there would split the run (`linkRuns` refuses).
  // The turn keeps the name it was opened under, which is also the one the gateway
  // stops (`foregroundRunId`), and the link is held the other way round: the
  // TRANSCRIPT's name of the run is translated where the transcript speaks to the turn
  // (`settleFromTranscript`, `onAssistantRow`, `onUserRow`, the foreground runs Convex is
  // asked about, the terminal the reconciler posts — `transcriptFrame`), and Convex is
  // told that the bubble shows the execution run's rows (`linkRunBubble`) before any row
  // of that run is posted (`runLinksRecorded`). Convex keeps the fact with the bubble —
  // with every bubble of the run, when a steer cuts it into segments — so a bridge
  // restarted between the first delta and the statement, its turn resumed under the
  // client run, takes the same path.
  /** Client run a turn of this session runs (or ran) under → its execution run. */
  private readonly lateExecutionRuns = new Map<string, string>();
  /** The reverse: the transcript's name → the name the turn has here. */
  private readonly lateClientRuns = new Map<string, string>();
  /** Late links Convex has not recorded yet (by client run): no bubble to record them on
   *  so far, or a write that failed — with how many times Convex ANSWERED that write
   *  with an error. Asked again before each transcript post. */
  private readonly unrecordedLinks = new Map<string, number>();
  /** The bubble each late link carried from the chat's previous socket is owed on
   *  (`adoptOwedLateLinks`): no turn here knows it. */
  private readonly inheritedLinkBubbles = new Map<string, string>();
  private linkWrites: Promise<void> = Promise.resolve();
  /** Errors Convex may ANSWER a link's write with before the link is given up (each
   *  write is already retried by the writer). A Convex that does not answer at all is
   *  never counted: it cannot take the rows either. */
  private static readonly MAX_LINK_WRITE_ERRORS = 3;

  /** The name the turn of `runId` has HERE: a linked run's other name when the turn runs
   *  under that one (the execution run of a link stated first, the client run of one
   *  stated late), else `runId` itself. */
  private localRunName(runId: string): string {
    return this.runAliases.get(runId) ?? this.lateClientRuns.get(runId) ?? runId;
  }

  /** Whether two run ids name ONE run, as far as this session knows the gateway's links. */
  sameRun(a: string, b: string): boolean {
    return a === b || this.localRunName(a) === this.localRunName(b);
  }

  /**
   * The frame under the name the TRANSCRIPT gives its run: a frame of a turn whose link
   * was stated late — still read here under the client run — is returned as a copy
   * naming the execution run; any other frame as it is. For the reader that files what
   * it sees beside the transcript's rows (the reconciler's terminal observation).
   */
  transcriptFrame<T>(frame: T): T {
    if (this.lateExecutionRuns.size === 0) return frame;
    const runId = sessionRunIdFor(frame, this.sessionKey);
    const execution = runId === null ? undefined : this.lateExecutionRuns.get(runId);
    if (execution === undefined) return frame;
    const original = frame as unknown as { payload: Record<string, unknown> };
    return { ...original, payload: { ...original.payload, runId: execution } } as unknown as T;
  }

  /** `runId` is, or was, a turn's own run here. */
  private hasOwnTurn(runId: string): boolean {
    return this.normalizer.ownRunIds.has(runId) || this.ownedRunHistory.has(runId);
  }

  /** The gateway states that `clientRunId`, which already has a turn here, is the wire
   *  name of `executionRunId`. Returns whether the link holds. */
  private linkLate(clientRunId: string, executionRunId: string): boolean {
    if (clientRunId === executionRunId) return false;
    const known = this.lateExecutionRuns.get(clientRunId);
    if (known !== undefined) {
      // Stated again (`phase: "end"` after `phase: "model"`): a write still owed is retried.
      if (known === executionRunId) void this.recordRunLinks();
      return known === executionRunId;
    }
    // No chain, no loop — and an execution run that has a turn of its own here already
    // has its bubble: two exist, and nothing joins them.
    if (
      this.runAliases.has(executionRunId) ||
      this.clientRunIds.has(executionRunId) ||
      this.clientRunIds.has(clientRunId) ||
      this.lateClientRuns.has(executionRunId) ||
      this.lateExecutionRuns.has(executionRunId) ||
      this.hasOwnTurn(executionRunId)
    ) {
      console.warn(
        `[run-link] late link refused: a name is already taken client=${clientRunId.slice(0, 60)} execution=${executionRunId.slice(0, 60)}`,
      );
      return false;
    }
    this.lateExecutionRuns.set(clientRunId, executionRunId);
    this.lateClientRuns.set(executionRunId, clientRunId);
    this.trimLateLinks();
    this.unrecordedLinks.set(clientRunId, 0);
    console.log(
      `[run-link] stated after the client run opened its turn: client=${clientRunId.slice(0, 60)} execution=${executionRunId.slice(0, 60)}`,
    );
    void this.recordRunLinks();
    return true;
  }

  /** Bounded, oldest first: a late link and everything kept with it go together. */
  private trimLateLinks(): void {
    while (this.lateExecutionRuns.size > RunManager.MAX_RUN_ALIASES) {
      const oldest = this.lateExecutionRuns.keys().next().value as string;
      this.lateClientRuns.delete(this.lateExecutionRuns.get(oldest) as string);
      this.lateExecutionRuns.delete(oldest);
      this.unrecordedLinks.delete(oldest);
      this.inheritedLinkBubbles.delete(oldest);
    }
  }

  /** A late link Convex already holds (read back with a resumed bubble): known again,
   *  and asked once more before the transcript's rows are posted. Convex records a link
   *  page by page (`linkRunBubble`), so the bubble that came back may carry it while a
   *  later page of the run's segments does not — a process stopped between two pages.
   *  The repeat is the same fact (Convex completes what is missing and changes nothing
   *  else). Taken only under the conditions a statement is (`linkLate`). */
  private restoreRecordedLateLink(clientRunId: string, executionRunId: string): void {
    if (clientRunId === executionRunId || this.lateExecutionRuns.get(clientRunId) === executionRunId) return;
    if (
      this.lateExecutionRuns.has(clientRunId) ||
      this.runAliases.has(clientRunId) ||
      this.runAliases.has(executionRunId) ||
      this.clientRunIds.has(executionRunId) ||
      this.clientRunIds.has(clientRunId) ||
      this.lateClientRuns.has(executionRunId) ||
      this.lateExecutionRuns.has(executionRunId) ||
      this.hasOwnTurn(executionRunId)
    ) {
      return;
    }
    this.lateExecutionRuns.set(clientRunId, executionRunId);
    this.lateClientRuns.set(executionRunId, clientRunId);
    this.unrecordedLinks.set(clientRunId, 0);
    this.trimLateLinks();
  }

  /** The bubble a turn of `runId` shows or left: `undefined` while its turn is open with
   *  nothing shown yet, `null` when it ended without one. */
  private bubbleOfOwnRun(runId: string): string | null | undefined {
    if ((this.sink.active || this.sink.finalizing) && this.normalizer.ownRunIds.has(runId)) {
      return this.sink.currentMessageId ?? undefined;
    }
    return this.settledRuns.get(runId)?.messageId ?? this.inheritedLinkBubbles.get(runId) ?? null;
  }

  /** The late links still OWED, each with the bubble it is to be recorded on: what the
   *  session that replaces this one on the chat (its socket closed) carries on
   *  (SessionRegistry). A link with no bubble yet is not carried: it holds nothing back. */
  owedLateLinks(): OwedLateLink[] {
    const owed: OwedLateLink[] = [];
    for (const clientRunId of this.unrecordedLinks.keys()) {
      const executionRunId = this.lateExecutionRuns.get(clientRunId);
      const messageId = this.bubbleOfOwnRun(clientRunId);
      if (executionRunId !== undefined && typeof messageId === "string") owed.push({ clientRunId, executionRunId, messageId });
    }
    return owed;
  }

  /** The late links the chat's previous session still owed when its socket closed: owed
   *  here, and the transcript's rows wait for them as they waited there — the new
   *  socket's reconciler reads the same session, and rows posted before the link make
   *  a second bubble for good. */
  adoptOwedLateLinks(links: readonly OwedLateLink[]): void {
    for (const { clientRunId, executionRunId, messageId } of links) {
      if (clientRunId === executionRunId || this.lateExecutionRuns.has(clientRunId) || this.lateClientRuns.has(executionRunId)) continue;
      this.lateExecutionRuns.set(clientRunId, executionRunId);
      this.lateClientRuns.set(executionRunId, clientRunId);
      this.inheritedLinkBubbles.set(clientRunId, messageId);
      this.unrecordedLinks.set(clientRunId, 0);
    }
    this.trimLateLinks();
    if (links.length > 0) void this.recordRunLinks();
  }

  /**
   * Tell Convex every late link it does not hold yet (one write per link, in order).
   * Resolves once each has been asked; never rejects. The write is the same fact
   * however often it is asked (Convex answers a repeat with what it holds).
   *
   * A write that FAILED leaves its link owed, and the transcript's rows wait for it
   * (`runLinksRecorded`). It stops being owed when Convex REFUSES it — `linked: false`,
   * or a rejection of the request itself (a 4xx: a Convex without the op, a bubble of
   * another instance) — or keeps ANSWERING with an error: the link is then given up,
   * said in the log, and the rows of the execution run make that run's own bubble
   * beside the client run's (two bubbles for one answer — what a statement that never
   * arrives leaves too).
   */
  recordRunLinks(): Promise<void> {
    if (this.unrecordedLinks.size === 0) return this.linkWrites;
    this.linkWrites = this.linkWrites.then(async () => {
      for (const client of [...this.unrecordedLinks.keys()]) {
        const execution = this.lateExecutionRuns.get(client);
        const messageId = this.bubbleOfOwnRun(client);
        if (messageId === undefined) continue;
        if (execution === undefined || messageId === null || this.writer.linkRunBubble === undefined) {
          // No bubble under the client run to record it on: the rows make the run's.
          this.unrecordedLinks.delete(client);
          continue;
        }
        try {
          const linked = await this.writer.linkRunBubble(messageId, client, execution);
          this.unrecordedLinks.delete(client);
          if (!linked) {
            console.warn(
              `[run-link] Convex did not take the late link (the execution run already shows elsewhere) client=${client.slice(0, 60)} execution=${execution.slice(0, 60)}`,
            );
          }
        } catch (err) {
          const status = err instanceof ConvexIngestError ? err.status : null;
          const errors = (this.unrecordedLinks.get(client) ?? 0) + (status === null ? 0 : 1);
          const rejected = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
          if (rejected || errors >= RunManager.MAX_LINK_WRITE_ERRORS) {
            this.unrecordedLinks.delete(client);
            console.error(
              `[run-link] the late link is GIVEN UP (${rejected ? "Convex rejected it" : "Convex keeps failing it"}): the execution run's rows will make a bubble of their own client=${client.slice(0, 60)} execution=${execution.slice(0, 60)}:`,
              errForLog(err),
            );
            continue;
          }
          if (this.unrecordedLinks.has(client)) this.unrecordedLinks.set(client, errors);
          console.error("[run-link] the late link was not recorded (asked again):", errForLog(err));
        }
      }
    });
    return this.linkWrites;
  }

  /**
   * What the transcript reader awaits before it posts rows: every late link that has a
   * bubble to be recorded on IS recorded, or was refused. Rejects while one is still owed
   * (its write failed): the rows of an execution run posted before their link give birth
   * to a second bubble, after which Convex refuses the link for good — so the post is not
   * made, and the read is asked again (TranscriptShadow `beforeApply`). A link whose turn
   * has shown nothing yet has no bubble to name and holds nothing back.
   */
  async runLinksRecorded(): Promise<void> {
    await this.recordRunLinks();
    for (const client of this.unrecordedLinks.keys()) {
      if (typeof this.bubbleOfOwnRun(client) === "string") {
        throw new Error("a run link stated late is not recorded in Convex yet");
      }
    }
  }

  /** The foreground turn's runs under the names the TRANSCRIPT gives them. */
  get activeTranscriptRunIds(): string[] {
    return this.activeRunIds.map((id) => this.lateExecutionRuns.get(id) ?? id);
  }

  /** The runs the foreground turn owns (empty when no turn is live). */
  get foregroundRunIds(): string[] {
    return this.sink.active || this.sink.finalizing ? [...this.normalizer.ownRunIds] : [];
  }

  /** The run the foreground turn last heard from (the one a Stop targets), or null —
   *  under the name the GATEWAY acts on: a linked run's abort controller is registered
   *  under its client run (src/gateway/server-methods/chat-send-admission.ts:380 at
   *  v2026.10.33), which is also the run the Control UI stops. */
  get foregroundRunId(): string | null {
    if (!this.sink.active) return null;
    const current = this.normalizer.currentRunId;
    return current === null ? null : (this.clientRunIds.get(current) ?? current);
  }

  /** A send the gateway accepted while a turn was in the foreground (custody only). */
  noteHeldInput(
    sendId: string,
    ackRunId: string | null,
    userMessageId: string | null,
    predatingRunIds: readonly string[] = [],
  ): void {
    this.heldInputs.delete(sendId);
    const predating = new Set(predatingRunIds);
    for (const id of this.foregroundRunIds) predating.add(id);
    if (ackRunId !== null) predating.delete(ackRunId);
    this.heldInputs.set(sendId, {
      ackRunId,
      userMessageId,
      steered: false,
      answered: false,
      predating,
      answeredBy: null,
    });
    if (ackRunId !== null) this.inputAckRuns.set(ackRunId, sendId);
    while (this.heldInputs.size > RunManager.MAX_HELD_INPUTS) {
      const oldest = this.heldInputs.keys().next().value as string;
      const gone = this.heldInputs.get(oldest);
      this.heldInputs.delete(oldest);
      if (gone?.ackRunId) this.inputAckRuns.delete(gone.ackRunId);
    }
  }

  /** The ACK named the input's custody run: it replaces the provisional one. */
  noteInputAckRun(sendId: string, ackRunId: string | null): void {
    const held = this.heldInputs.get(sendId);
    if (held === undefined || ackRunId === null || ackRunId === held.ackRunId) return;
    if (held.ackRunId !== null) this.inputAckRuns.delete(held.ackRunId);
    held.ackRunId = ackRunId;
    this.inputAckRuns.set(ackRunId, sendId);
  }

  /** The send was refused (or not accepted): the input is not the gateway's. */
  forgetHeldInput(sendId: string): void {
    const held = this.heldInputs.get(sendId);
    if (held === undefined) return;
    if (held.ackRunId !== null) this.inputAckRuns.delete(held.ackRunId);
    this.heldInputs.delete(sendId);
  }

  /** After a bridge restart (CU-22 resume): the inputs Convex still records as held by
   *  the gateway while the resumed bubble streamed. The resumed run predates them (it
   *  is in the foreground now); an input already known here is left as it is. Its
   *  custody run is restored as a fresh send's is — the send identity, the gateway's
   *  client run id: without it the input's bare custody final looked like the run that
   *  answers it, consumed the input, and the real answer was refused as foreign (codex
   *  pass 4). */
  rehydrateHeldInputs(inputs: ReadonlyArray<{ sendId: string; messageId: string }>): void {
    for (const i of inputs) {
      if (this.heldInputs.has(i.sendId)) continue;
      this.noteHeldInput(i.sendId, i.sendId, i.messageId);
    }
  }

  /** Held inputs still waiting for the run that answers them. */
  get outstandingInputs(): string[] {
    const out: string[] = [];
    for (const [id, h] of this.heldInputs) if (!h.steered && !h.answered) out.push(id);
    return out;
  }

  /**
   * A transcript USER row of this session (session.message or a read), CU-20: an input
   * we hold that the gateway STEERED into the foreground run cuts that run's bubble —
   * what the run writes next is the answer to the steered message.
   */
  async onUserRow(row: { sendId?: string; steerTargetRunId?: string }): Promise<void> {
    if (row.sendId === undefined) return;
    const held = this.heldInputs.get(row.sendId);
    if (held === undefined || held.steered) return;
    if (row.steerTargetRunId === undefined) return;
    // Claimed at once (the live event and a read can deliver the same row), and released
    // if the cut fails before Convex has it: a later delivery of the row re-arms it.
    held.steered = true;
    await this.runOrdered(async () => {
      // The row names the run as the TRANSCRIPT knows it; the turn may run under its
      // other name here (a link stated late). Resolved in the frames' own order.
      const target = this.localRunName(row.steerTargetRunId!);
      if (!this.sink.active || !this.normalizer.ownRunIds.has(target)) {
        // Steered into a run that is not the foreground turn here (one the gateway was
        // already running when the input was accepted): that run now answers it — it
        // opens its own bubble, never the bubble of another turn.
        if (!this.ownedRunHistory.has(target)) {
          this.steerAdoptRuns.add(target);
          while (this.steerAdoptRuns.size > RunManager.MAX_HELD_INPUTS) {
            this.steerAdoptRuns.delete(this.steerAdoptRuns.values().next().value as string);
          }
        }
        return;
      }
      let split: boolean;
      try {
        split = await this.sink.splitSegment(
          held.userMessageId,
          this.normalizer.currentSegmentText,
        );
      } catch (err) {
        held.steered = false;
        console.error(
          `[send] steered input: the cut failed, re-armed for the next delivery of its row:`,
          errForLog(err),
        );
        return;
      }
      if (split) this.normalizer.splitSegment();
      console.log(
        `[send] steered input ${split ? "cut the run's bubble" : "joined the run (no bubble to cut)"} run=${target.slice(0, 60)}`,
      );
    });
  }

  /**
   * A transcript ASSISTANT row of this session that a reader sees (`session.message`):
   * the run that wrote it has that text recorded. The live text needs the fact when the
   * gateway then withdraws the text from the run's stream (2026.10.33 — normalizer.ts
   * `recordedText`). Taken in the frames' own order, under the one name the run's frames
   * are read by (`canonicalFrame`).
   */
  async onAssistantRow(row: { runId?: string; seq: number }): Promise<void> {
    if (row.runId === undefined) return;
    const runId = row.runId;
    // The other name of the run, whichever of the two its turn has here.
    const other = this.runAliases.get(runId) ?? this.lateClientRuns.get(runId);
    await this.runOrdered(() => {
      this.normalizer.noteAssistantRowRecorded(other === undefined ? [runId] : [other, runId], row.seq);
    });
  }

  /** The gateway will never run this input (cancelled, or no receipt when asked): no run
   *  is coming to answer it. */
  noteInputDropped(sendId: string): void {
    const held = this.heldInputs.get(sendId);
    if (held !== undefined) held.answered = true;
  }

  /** The run id of a frame that must open its OWN deferred bubble rather than join the
   *  foreground turn (projection `on`), or null. */
  private adoptableRunFor(frame: unknown): string | null {
    const rid = sessionRunIdFor(frame, this.sessionKey);
    if (rid === null) return null;
    if (this.normalizer.ownRunIds.has(rid) && (this.sink.active || this.sink.finalizing)) {
      return null;
    }
    if (this.ownedRunHistory.has(rid)) return null;
    if (this.inputAckRuns.has(rid)) return rid;
    if (this.steerAdoptRuns.has(rid)) return rid;
    // The gateway linked this run to an input's own run: it answers that input.
    if (this.clientRunIds.has(rid)) return rid;
    // Only an input this run can answer: a run that was already live when the input
    // was accepted is not its answer (it predates it).
    if (this.waitingInputFor(rid) === undefined) return null;
    // A heartbeat run is the gateway's own wake, never an answer (CU-21).
    const p = (frame as { payload?: { isHeartbeat?: unknown } }).payload;
    if (p?.isHeartbeat === true) return null;
    return rid;
  }

  /** The oldest held input still waiting that run `rid` may answer (it did not predate
   *  the input's acceptance), or undefined. */
  private waitingInputFor(rid: string): string | undefined {
    return this.outstandingInputs.find((id) => !this.heldInputs.get(id)!.predating.has(rid));
  }

  /** When a run is adopted for the held inputs, the oldest waiting one is its question
   *  (ack runs answer only their own input, and only if they show something). */
  private noteRunAdopted(runId: string, delivery: boolean): void {
    if (this.inputAckRuns.has(runId)) return;
    // A run proven steered-into answers the input already marked steered.
    if (this.steerAdoptRuns.has(runId)) return;
    // A run the gateway linked to an input's own run answers THAT input.
    const client = this.clientRunIds.get(runId);
    const linked = client === undefined ? undefined : this.inputAckRuns.get(client);
    const first = linked ?? this.waitingInputFor(runId);
    if (first === undefined) return;
    const held = this.heldInputs.get(first);
    if (held === undefined) return;
    held.answered = true;
    // A delivery-family run (an announce, a task delivery) is never an input's
    // execution: the gateway links only the run it starts FOR the queued input.
    if (!delivery) held.answeredBy = runId;
  }

  /** A `chat` final of a settled run that is not the open turn's (CU-8): the run, its
   *  visible text and its record — or null. */
  private lateFinalFor(frame: unknown): LateFinal | null {
    if (typeof frame !== "object" || frame === null) return null;
    const f = frame as { event?: unknown; payload?: Record<string, unknown> };
    if (f.event !== "chat" || f.payload?.state !== "final") return null;
    const rid = sessionRunIdFor(frame, this.sessionKey);
    const record = rid === null ? undefined : this.settledRuns.get(rid);
    if (rid === null || record === undefined) return null;
    if ((this.sink.active || this.sink.finalizing) && this.normalizer.ownRunIds.has(rid)) {
      return null;
    }
    return { runId: rid, text: visibleFinalText(f.payload?.message), settled: record, writeKey: randomUUID() };
  }

  /**
   * Join what a late final ADDS to its settled run's bubble, compared with the record as
   * it is NOW. Null: it adds nothing, nothing was asked. Otherwise the outcome of the
   * write: `refused` when there is no bubble to join and none could be opened.
   * Idempotent in Convex under its `writeKey` (`appendLateFinal`): an addition the bubble
   * already holds is not appended again, and a write that OPENED a bubble is answered
   * with that bubble when it is asked again — so `failed` can be asked again. `lost`: the
   * write went without a key (an older Convex) and cannot.
   */
  private async joinLateFinal(late: LateFinal): Promise<SettledWriteOutcome | null> {
    const settled = late.settled;
    const add = this.lateAddition(late.text, settled);
    if (add === null) return null;
    const opened = settled.messageId === null;
    let into: string | null;
    try {
      into = await this.sink.writeLateFinal(late.runId, settled.messageId, add, late.writeKey);
    } catch (e) {
      this.completionFailure = e;
      return lateFinalAskedOnce(e) ? "lost" : "failed";
    }
    if (into === null) return "refused";
    settled.messageId = into;
    settled.text = settled.text === "" ? add : `${settled.text}\n\n${add}`;
    console.log(
      `[final] a distinct late final joined the settled run's bubble (CU-8) run=${late.runId.slice(0, 60)}${opened ? " (new bubble)" : ""}`,
    );
    return "written";
  }

  /**
   * A DISTINCT late final (CU-8) on the frame path: put in its bubble's queue, never
   * awaited — its write is retried by the writer (its key makes it repeatable), and a
   * frame must not wait a minute for a text beside the turn. A bubble with no queue gets
   * one with nothing owed at its head (keyed by the run's record, so two finals of a run
   * that left no bubble share it and the second is compared with what the first wrote).
   * Both bounds refuse the newcomer.
   */
  private queueLateFinal(late: LateFinal): void {
    const queue = this.keptCompletions.get(late.settled);
    if (queue !== undefined) {
      if (queue.behind.length < RunManager.MAX_BEHIND_A_COMPLETION) {
        queue.behind.push(late);
      } else {
        console.error(
          `[final] late final DROPPED: ${RunManager.MAX_BEHIND_A_COMPLETION} already wait in its bubble's queue run=${late.runId.slice(0, 60)}`,
        );
      }
      return;
    }
    if (this.keptCompletions.size >= RunManager.MAX_KEPT_COMPLETIONS) {
      console.error(
        `[final] late final DROPPED: ${RunManager.MAX_KEPT_COMPLETIONS} settled bubbles already have a write queue run=${late.runId.slice(0, 60)}`,
      );
      return;
    }
    this.keptCompletions.set(late.settled, {
      runId: late.runId,
      offer: null,
      record: late.settled,
      failures: 0,
      scheduled: false,
      settledOffer: null,
      joinKey: randomUUID(),
      behind: [late],
    });
    this.scheduleCompletion(late.settled);
  }

  /** What a late terminal text adds to a settled run's record, or null. */
  private lateAddition(text: string, record: { text: string }): string | null {
    if (text === "") return null;
    const settled = normText(record.text);
    const add = normText(text);
    if (add === "NO_REPLY" || add === "HEARTBEAT_OK") return null;
    // An exact (or shorter) repetition of what the run showed adds nothing.
    if (settled.includes(add)) return null;
    // A CUMULATIVE final that repeats the shown reply (all of its segments) AND adds to
    // it: only the addition joins the bubble (the reply is already there).
    if (settled !== "" && add.includes(settled)) {
      const extra = textBeyond(text, record.text);
      return extra === "" ? null : extra;
    }
    return text;
  }

  /** The settled run's whole visible text: the earlier segments (cut at steers) + the
   *  last bubble's. */
  private settledRunText(): string {
    const earlier = this.normalizer.segmentPrefixText;
    const last = this.sink.lastSettledBubble?.text ?? "";
    return earlier === null ? last : last === "" ? earlier : `${earlier}\n\n${last}`;
  }

  /** A turn began and its settlement is not recorded yet (see noteIfSettled). */
  private settleUnrecorded = false;

  /** Bookkeeping after any unit that may have ENDED the turn. Idempotent: it records
   *  a begun turn once, as soon as the sink is free — and it runs before anything can
   *  open the NEXT turn (beginTurn, resumeTurn, the announce flush), because a feed
   *  that finalizes A can open B before its own epilogue runs, and A's runs were then
   *  never recorded (codex pass 4: A's distinct late final was lost). */
  private noteIfSettled(): void {
    if (this.settleUnrecorded && !this.sink.active) {
      this.settleUnrecorded = false;
      const record = {
        messageId: this.sink.lastSettledBubble?.messageId ?? null,
        text: this.settledRunText(),
      };
      for (const id of this.normalizer.ownRunIds) {
        this.settledRuns.delete(id);
        this.settledRuns.set(id, record);
        // The window this turn's early close opened is for THIS record: a later turn
        // re-using the run id gets another record, and another window.
        const window = this.normalizer.settledWindowOf(id);
        if (window !== undefined && !this.windowRecords.has(window)) {
          this.windowRecords.set(window, record);
        }
      }
      // The turn is over: what its runs still have queued goes on the bubble it left
      // (or on the one Convex finds for the run).
      for (const id of this.normalizer.ownRunIds) {
        if (this.runFacts.has(id)) this.scheduleRunFacts(id, true);
      }
      while (this.settledRuns.size > RunManager.MAX_SETTLED_RUNS) {
        this.settledRuns.delete(this.settledRuns.keys().next().value as string);
      }
      for (const id of this.normalizer.ownRunIds) {
        this.ownedRunHistory.delete(id);
        this.ownedRunHistory.add(id);
      }
      while (this.ownedRunHistory.size > RunManager.MAX_OWNED_RUN_HISTORY) {
        this.ownedRunHistory.delete(this.ownedRunHistory.values().next().value as string);
      }
    }
  }

  /** Whether this session's socket declared `inline-widgets` (decided per handshake
   *  in session.ts). The normalizer emits widget parts only then. */
  setWidgetsEnabled(enabled: boolean): void {
    this.normalizer.widgetsEnabled = enabled;
  }

  get widgetsEnabled(): boolean {
    return this.normalizer.widgetsEnabled;
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
        // A question's answers may be a secret: redacted BEFORE matching and printing.
        const s = JSON.stringify(redactAllQuestionAnswers(frame));
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
      typeof payload.deltaText === "string" && payload.deltaText
        ? "delta"
        : "-",
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
          // A question's answers may be a secret: never in a log, even a debug one.
          sample = JSON.stringify(redactAllQuestionAnswers(frame)).slice(0, 300);
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

  /** Projection `on`: a silence was answered by a transcript read — the silence budget
   *  restarts (one read per budget, never an end). */
  rearmSilence(now: number): void {
    this.normalizer.rearmSilence(now);
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

  /** The turn's terminal is being written (media tail, finalize POST). */
  get turnFinalizing(): boolean {
    return this.sink.finalizing;
  }

  /** True in the chat.send→ack window (pre-ack buffer armed): a dispatch has
   *  been POSTed but no turn is active YET. The /reset execution-time guard
   *  must treat this as live too — resetting here would wipe the session of
   *  the turn the gateway is about to start (codex P1, pass 13). */
  get dispatchInFlight(): boolean {
    return this.replayArmed || this.replayGate !== null;
  }

  /**
   * Why this socket still carries work the bridge owes a reply for — null when none.
   * A turn driving the sink, or still finalizing its tail (media, finalize POST); a
   * `chat.send` awaiting its ACK (the gateway may already have accepted the turn —
   * closing the socket now loses its ACK and every frame of the answer, codex pass
   * 10); delivery frames stashed to open a turn as soon as the sink is free.
   */
  get liveWork(): "turn in progress" | "dispatch in flight" | "delivery pending" | null {
    if (this.sink.active || this.sink.finalizing) return "turn in progress";
    if (this.dispatchInFlight) return "dispatch in flight";
    if (this.pendingAnnounce.length > 0) return "delivery pending";
    return null;
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
    this.pendingFramesOverflowed = false;
  }

  /** Frames of the active turn may have been lost — see Normalizer.noteStreamGap. */
  noteStreamGap(): void {
    this.normalizer.noteStreamGap();
  }

  get streamGapNoted(): boolean {
    return this.normalizer.streamGapNoted;
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
    this.pendingFramesOverflowed = false;
    this.scheduleWaitingRunFacts();
    if (this.pendingAnnounce.length > 0) {
      // `now` MUST be the session's own clock (the normalizer arms its recv
      // deadlines against it — an epoch value would park them forever).
      // `onFlushed` fires AFTER the flush settles (the spontaneous turn's
      // deadlines are armed by then) — a caller's wake() issued synchronously
      // would race the async open and could leave the consume loop parked on a
      // null timeout (codex P2).
      void this.flushPendingAnnounce(now)
        .catch((e) =>
          console.error(
            "[announce] post-failed-send flush skipped (non-fatal):",
            errForLog(e),
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
        /** THE fill and WHICH figure produced it — derived once on the send path
         *  (context-budget's sessionFillDetail), never recomputed downstream. */
        fillPct?: number | null;
        fillSource?: SessionFillSource | null;
        model?: string | null;
        /** How the pre-send describe went (core/pressure-telemetry.ts): answered with a
         *  session, answered that there is none, or failed (threw / unreadable). */
        describe?: PresendDescribeOutcome;
      };
      /** Spontaneous (announce) turn: the sink DEFERS creating the assistant
       *  message until the normalizer proves visible content (turn-sink). */
      spontaneous?: boolean;
      /** THIS send prepended rehydration history: the gateway will chew it
       *  silently first — surfaced as the `processing_history` phase. */
      rehydrated?: boolean;
      /** The OUTBOX row this turn was dispatched from (from the `/send` body):
       *  the correlation that lets Convex answer "did this send ever run?".
       *  Absent on a spontaneous turn — no queued send is waiting on it. */
      dispatchOutboxId?: string | null;
      /** The pre-send guard COMPACTED this session right before this send (W2):
       *  makes a `context_length` failure retryable exactly once. */
      compactedBeforeSend?: boolean;
      /** …and the cause that compaction gives the rotation it produces (W2): the marker
       *  of THIS turn may say why. Carried by the send, never kept beside the turns — a
       *  cause no rotation consumed would name a later turn's compaction. */
      presendCompactionCause?: string | null;
      /** Projection `on`, `interrupt` send: the foreground turn is replaced. The
       *  gateway aborts its run; its bubble settles as stopped. */
      interruptActive?: boolean;
    },
  ): Promise<void> {
    if (
      turnContext?.interruptActive === true &&
      turnContext.spontaneous !== true &&
      this.sink.active
    ) {
      await this.runOrdered(() => this.sink.preemptOpenTurn("aborted"));
    }
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
    } else if (
      this.currentSpontaneousRun !== null &&
      turnContext?.spontaneous !== true &&
      this.sink.active
    ) {
      // OPEN announce turn preempted by a real dispatch (the queued follow-up
      // was already in flight when the announce reopened the parent bubble —
      // rare: bridge.reparkIfBusy re-parks a paced dispatch that wakes into
      // this state). In the observed 2026.7.x incident the announce's final NEVER came
      // after the new chat.send (live 2026-07-19; attributed to a prompt-lock takeover by timing, no frame
      // proves the cause). On 2026.8.1+ no announce-kill mechanism was found on the
      // production paths read — one-slot per-session lane, stopped handles are not
      // supersedable (see docs/UPSTREAM_INTERPRETATION.md §2); there, under the default
      // `steer` queue mode (the bridge sets no `queueMode`; an effective `interrupt` mode
      // aborts the announce instead), the send is queued as a followup
      // behind the announce (measured live 2026-09-14, defect 18 in the
      // 2026.9.4 queue): the announce run is NOT dead, it ends normally while the real
      // turn waits, and its remaining frames are refused below as stale retransmits
      // (the announce tail after this point is lost). An `interrupt` send replaces the
      // foreground turn explicitly (interruptActive above); this branch is the rest.
      // On the 7.x shape, left alone the reopened bubble strands `streaming`, the busy
      // gate stalls the queue drain, and the 12-min watchdog errors it as
      // stream_orphaned (live 2026-07-19, "Génération…" stuck + last queued card never
      // dispatched). Close it COMPLETE now with the streamed partial text; no replay is
      // attempted. Best-effort — the real turn must start regardless.
      try {
        console.log(
          `[announce] open announce turn preempted by real dispatch — closing run=${this.currentSpontaneousRun.slice(0, 60)}`,
        );
        // Through the SAME chain (codex P2): a preemption is a turn transition, and
        // closing the announce while one of its frames is still being applied would
        // finalize it before its own tail — then the normalizer reset would discard
        // that frame. The partial reply the preemption exists to preserve would lose
        // exactly the part it was preserving.
        await this.runOrdered(() => this.sink.preemptOpenTurn());
      } catch (e) {
        console.error(
          "[announce] preempt close failed (non-fatal):",
          errForLog(e),
        );
      }
    }
    this.spontaneousReplayCopy = [];
    this.currentSpontaneousRun =
      turnContext?.spontaneous === true ? ackRunId : null;
    this.noteIfSettled();
    this.reofferCompletions();
    this.settleUnrecorded = true;
    this.turnEpoch++;
    this.normalizer.beginTurn(now);
    // A frame of this run was refused by the pre-ack cap: what the normalizer reads
    // as an ABSENCE (no lifecycle start, say) proves nothing for this turn.
    if (this.pendingFramesOverflowed) {
      this.normalizer.noteStreamGap();
      this.pendingFramesOverflowed = false;
    }
    this.normalizer.noteExpectedSessionId(
      turnContext?.expectedSessionId ?? null,
    );
    this.normalizer.notePresendCompactionCause(
      turnContext?.presendCompactionCause ?? null,
    );
    this.frameTally.clear();
    this.frameSampled.clear();
    this.tallyDumped = false;
    if (ackRunId) {
      this.normalizer.noteRunStarted(ackRunId, now);
    }
    // PROJECTION `on` (phase 4): a sent turn's bubble is born from its run (first visible
    // content or tool activity), never at the ACK — a run with nothing to show leaves none.
    const bornFromRun = turnContext?.spontaneous !== true;
    await this.sink.beginTurn(
      ackRunId,
      turnContext?.pressure,
      turnContext?.spontaneous === true || bornFromRun,
      turnContext?.rehydrated === true,
      turnContext?.dispatchOutboxId ?? null,
      {
        compactedBeforeSend: turnContext?.compactedBeforeSend === true,
        projection: true,
        ...(bornFromRun ? { openOnActivity: true } : {}),
      },
    );
    // Flush the pre-turn provenance stash for THIS run only; entries from any
    // other run (a failed earlier dispatch, a foreign run) are dropped here.
    const matched = ackRunId
      ? this.pendingProvenance.filter((p) => p.runId === ackRunId)
      : [];
    this.pendingProvenance = [];
    if (matched.length > 0) {
      await this.applyOrdered(() =>
        matched.map((p) => ({ type: "provenance", part: p.part })),
      );
    }
    // Replay the frames that raced ahead of the ack, in arrival order, each through the
    // unit a LIVE frame takes after its observation (`feedObserved`): lanes, the
    // completion of a settled bubble, the held text, a late final, the routing, the
    // settle record. A replayed sequence then writes what the same sequence writes when
    // it arrives after this point — the turn it opens can also close inside the replay,
    // and what follows its close is read as what follows a close. They were observed and
    // classified when they arrived (`feedInner`), which is not done again.
    //
    // DISARMED FIRST: the buffer is being drained, and a replayed frame must not be put
    // back into it (foreign-run frames reach the normalizer's own admission, as live).
    // The dispatch stays in flight for its readers until the gate opens.
    const raced = this.pendingFrames;
    this.pendingFrames = [];
    this.replayArmed = false;
    if (raced.length > 0) {
      // ONE FRAME AT A TIME, each awaited: a frame's decisions are taken on what the
      // frames before it left (a close opens the window its next delta completes). The
      // order against LIVE frames, which the synchronous enqueue used to give (measured
      // without it: `one, four, two, three`), is given by the gate — `feed` and `tick`
      // wait behind it, so nothing younger is read before the replay ends.
      let release!: () => void;
      this.replayGate = new Promise<void>((resolve) => (release = resolve));
      try {
        for (const { frame, now: frameNow } of raced) {
          try {
            // The one reading that depends on what the frames before it did (see
            // `runFactsFor`): a notice beside an answer the replay has just settled.
            const facts = this.runFactsFor(frame, true);
            if (facts !== null) this.noteRunFacts(facts.runId, facts.facts);
            else await this.feedObserved(frame, frameNow);
          } catch (err) {
            // STOP at the first failure (codex P2): `beginTurn` rejects and /send treats
            // the whole send as failed — the remainder must not keep writing into a turn
            // the caller is about to fail. Reported with the exact frame that failed,
            // which is the only thing that tells an operator which shape broke the send.
            protocolDrift.observeException(frame, err, "pre-ack-replay");
            throw err;
          }
        }
      } finally {
        this.replayGate = null;
        release();
      }
      this.dumpTallyOnce();
    }
    // Facts that arrived before the ACK waited for it: this run's for its bubble, which
    // the replay may just have opened (a turn it also finished drains at its settle);
    // any other run's for the dispatch to stop being in flight.
    this.scheduleWaitingRunFacts();
    // The replay itself can FINALIZE the turn (a whole response raced the ack):
    // deliver any announce stashed during the send window now — no later
    // feed/tick is guaranteed once the loop goes idle (codex P2). No-op while
    // the turn is still streaming (sink active) or when called FROM the flush
    // (the spontaneous turn just went active).
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }

  /**
   * RESUME a turn this process did not open (projection `on`, CU-22): the gateway still
   * runs `runId`, whose bubble `messageId` is streaming in Convex — a bridge restart
   * lost the turn, not the run. The sink goes active on that bubble; the run's frames
   * flow into it again.
   */
  async resumeTurn(
    now: number,
    messageId: string,
    runId: string,
    segmentPrefix?: string,
    /** The name the run's transcript rows carry, when Convex recorded a late link on the
     *  bubble (convex/stream.ts `linkRunBubble`). */
    transcriptRunId?: string,
  ): Promise<void> {
    // Behind a pre-ack replay, like a frame: no turn is resumed between two replayed frames.
    if (this.replayGate !== null) await this.behindReplay();
    if (this.sink.active || this.sink.finalizing) return;
    this.spontaneousReplayCopy = [];
    this.currentSpontaneousRun = null;
    this.noteIfSettled();
    this.reofferCompletions();
    this.settleUnrecorded = true;
    this.turnEpoch++;
    this.normalizer.beginTurn(now);
    // A later segment of a cut run: the run's buffer still starts with the earlier
    // segments, which their own bubbles already show.
    if (segmentPrefix !== undefined) this.normalizer.restoreSegmentPrefix(segmentPrefix);
    this.normalizer.noteRunStarted(runId, now);
    // The late link the previous process stated is Convex's fact of the bubble: read again
    // here, the transcript's word on the run (its settle, its approvals, its foreground
    // name) reaches the resumed turn as it reached the turn that opened it.
    if (transcriptRunId !== undefined) this.restoreRecordedLateLink(runId, transcriptRunId);
    this.frameTally.clear();
    this.frameSampled.clear();
    this.tallyDumped = false;
    await this.sink.resumeTurn(messageId, runId);
    // The approvals of THIS run noted before the turn came back — a reconnection's replay
    // lists them while `/resume` still reads the session — hold it now, each until its own
    // deadline: the run's `waiting-approval` went to the socket that closed, and the
    // observer notes each request once.
    await this.holdKeptApprovals(runId, now);
  }

  /** Hold the active turn of `runId` (its name HERE) for every kept request of that run
   *  still waiting, each until its own deadline. A request kept under the other name of
   *  a linked run is that run's: the name is resolved when it is applied, never when it
   *  was kept. Only what still waits: a request — an identity — seen resolved is never
   *  held again. */
  private async holdKeptApprovals(runId: string, now: number): Promise<void> {
    if (!this.sink.active) return;
    for (const kept of [...this.approvalsWithoutTurn.values()]) {
      if (kept.runId === null || this.localRunName(kept.runId) !== runId) continue;
      if (this.approvalsResolved.has(kept.approvalId, kept.generation)) continue;
      await this.applyOrdered(() =>
        this.normalizer.noteApprovalRequested(
          kept.approvalId,
          {
            kind: kept.kind,
            runId,
            toolCallId: kept.toolCallId,
            expiresInSec: kept.deadline === null ? null : Math.max(0, kept.deadline - now),
            generation: kept.generation,
          },
          now,
        ),
      );
    }
  }

  private static readonly MAX_APPROVALS_WITHOUT_TURN = 64;
  /** This session's approvals seen RESOLVED (their broadcast, a terminal snapshot, an answer
   *  given here), by IDENTITY — the id and its generation (approval-identity.ts) — with or
   *  without a turn: never held again — not from a list read before they were decided and
   *  answered after, nor when a turn resumes. A new generation of the same id is another
   *  request, never blocked by them. Bounded like the normalizer's deadlines. */
  private readonly approvalsResolved = new ApprovalIdentitySet(RunManager.MAX_APPROVALS_WITHOUT_TURN);
  /** The generations announced for each id, each marked once resolved: a resolution that
   *  names none (an answer without it) is about the one still waiting, else the only one
   *  known. */
  private readonly approvalGenerations = new ApprovalGenerations(RunManager.MAX_APPROVALS_WITHOUT_TURN);

  /** This session's exec approval requests no turn held when they were noted — none was
   *  active, or the active one did not own the run they name (yet: a link stated late) —
   *  by identity, each with its own deadline on this clock (null: none known) and the run
   *  under the name the REQUEST gave it: re-applied to the turn that resumes their run
   *  (resumeTurn) or that a late link makes theirs (noteRunLink), forgotten once settled.
   *  Kept apart from the observer's memory of the cards, which notes each request once.
   *  Bounded like the normalizer's deadlines. */
  private readonly approvalsWithoutTurn = new Map<
    string,
    {
      approvalId: string;
      generation: ApprovalGeneration;
      kind: "exec" | "plugin" | "system-agent";
      runId: string | null;
      toolCallId: string | null;
      deadline: number | null;
    }
  >();

  private keepApprovalWithoutTurn(
    approvalId: string,
    generation: ApprovalGeneration,
    facts: {
      kind: "exec" | "plugin" | "system-agent";
      runId: string | null;
      toolCallId: string | null;
      expiresInSec: number | null;
      hold?: boolean;
    },
    now: number,
  ): void {
    const left = facts.expiresInSec;
    const deadline = left !== null && Number.isFinite(left) && left >= 0 ? now + left : null;
    const key = approvalIdentity(approvalId, generation);
    const kept = this.approvalsWithoutTurn.get(key);
    if (facts.hold === false) {
      // A deadline update only (the record's snapshot): never a reason to keep a request.
      if (kept !== undefined && deadline !== null) kept.deadline = deadline;
      return;
    }
    this.approvalsWithoutTurn.delete(key);
    this.approvalsWithoutTurn.set(key, {
      approvalId,
      generation,
      kind: facts.kind,
      runId: facts.runId,
      toolCallId: facts.toolCallId,
      deadline: deadline ?? kept?.deadline ?? null,
    });
    while (this.approvalsWithoutTurn.size > RunManager.MAX_APPROVALS_WITHOUT_TURN) {
      const oldest = this.approvalsWithoutTurn.keys().next().value;
      if (oldest === undefined) break;
      this.approvalsWithoutTurn.delete(oldest);
    }
  }

  /** A user /abort RPC targeted this chat's active run — see TurnSink. */
  noteUserAbort(): void {
    this.sink.noteUserAbort();
  }

  /**
   * A HUMAN is being asked a question on this session (OpenClaw `ask_user`).
   *
   * Session-scoped, not run-scoped, on purpose: a gateway session runs one run at a
   * time, so a question pending on it blocks whatever turn this chat is driving —
   * the record's `runId` names the embedded run, which is not always the id the
   * turn was admitted under. Returns whether an active turn is now held by it (the
   * caller wakes the consume loop so the new deadlines take effect).
   */
  async noteHumanQuestion(
    id: string,
    expiresInSec: number | null,
    now: number,
  ): Promise<boolean> {
    if (!this.sink.active) return false;
    await this.applyOrdered(() =>
      this.normalizer.noteQuestionRequested(id, expiresInSec, now),
    );
    return true;
  }

  /** The question was settled by the gateway (answered, cancelled, expired). */
  async noteHumanQuestionSettled(id: string, now: number): Promise<void> {
    if (!this.sink.active) return;
    await this.applyOrdered(() => this.normalizer.noteQuestionSettled(id, now));
  }

  /** An approval request of THIS session (its broadcast or the pending list): its own
   *  deadline bounds the turn's approval wait, and an exec one naming the turn's run
   *  holds it (see Normalizer.noteApprovalRequested). With no turn active it is KEPT,
   *  for the turn that resumes its run (resumeTurn). `generation`: with the id, the
   *  request's identity (null: not known). */
  async noteApprovalRequested(
    approvalId: string,
    facts: {
      kind: "exec" | "plugin" | "system-agent";
      runId: string | null;
      toolCallId: string | null;
      expiresInSec: number | null;
      hold?: boolean;
      generation?: ApprovalGeneration;
    },
    now: number,
  ): Promise<void> {
    const generation = facts.generation ?? null;
    this.approvalGenerations.announce(approvalId, generation);
    // Already decided: a list read before the decision and answered after it is stale.
    if (this.approvalsResolved.has(approvalId, generation)) return;
    if (!this.sink.active) {
      this.keepApprovalWithoutTurn(approvalId, generation, facts, now);
      return;
    }
    await this.applyOrdered(() => {
      // The request names the run that asked by its EXECUTION name (upstream
      // exec-approval.ts `operationalRunInstance.runId`); a turn linked late runs here under
      // its client name. Read under the name the turn has here — when the request is
      // APPLIED, behind the frames before it.
      const named = facts.runId === null ? facts : { ...facts, runId: this.localRunName(facts.runId) };
      // A run the turn does not own (yet): kept under the request's own name, for the
      // statement that would make it the turn's.
      if (facts.kind === "exec" && named.runId !== null && !this.normalizer.ownRunIds.has(named.runId)) {
        this.keepApprovalWithoutTurn(approvalId, generation, facts, now);
      }
      return this.normalizer.noteApprovalRequested(approvalId, { ...named, generation }, now);
    });
  }

  /** An approval of this session was settled outside its frames (see
   *  Normalizer.noteApprovalSettled): that IDENTITY — `generation` null when the caller does
   *  not know it, then the one announced and still waiting, else the only one known. */
  async noteApprovalSettled(
    approvalId: string,
    now: number,
    generation: ApprovalGeneration = null,
  ): Promise<void> {
    const decided = generation ?? this.approvalGenerations.attach(approvalId);
    // Decided: never held again, by this turn or one resumed later.
    this.approvalGenerations.resolve(approvalId, decided);
    this.approvalsResolved.add(approvalId, decided);
    this.approvalsWithoutTurn.delete(approvalIdentity(approvalId, decided));
    if (!this.sink.active) return;
    await this.applyOrdered(() =>
      this.normalizer.noteApprovalSettled(approvalId, now, decided),
    );
  }

  /** A question of the active turn is still waiting on a human — a silence while it
   *  waits is not a lost run (see Session's recv-silence recovery). */
  get questionPending(): boolean {
    return this.sink.active && this.normalizer.questionPending;
  }

  /**
   * CONNECTION-level frame loss (the gateway dropped frames destined for this
   * socket while still advancing its envelope `seq` — see frame-seq.ts). One
   * connection serves exactly one chat, so the loss belongs to THIS chat's turn.
   *
   * Observe-only and best-effort: it records a diagnostic, never text and never a
   * terminal, so it cannot corrupt the turn it describes. No-op between turns —
   * a gap with no reply in flight has nothing to qualify (the next turn's frames
   * are all still to come).
   */
  /** Feed one raw gateway frame; apply the resulting events to Convex. */
  async feed(arrived: unknown, now: number): Promise<void> {
    // C4 (W9) SITS ON THE READER, not on the callers. Instrumenting catch blocks meant
    // chasing call sites, and the chase was already losing: the programme named two, the
    // session loop had three, and TWO MORE readers bypass that loop entirely — the
    // pre-ack replay below and the voice relay in `server.ts` both call a feed directly,
    // where a throw reached a bare `console.error`. One guard here covers every caller,
    // present and future. It REPORTS AND RETHROWS: callers decide what a failed frame
    // means (a /send rejects, the loop logs and continues); the sensor only refuses to
    // let it vanish.
    // One run, one name — before the observation, the facts, the lanes and the routing.
    const frame = this.canonicalFrame(arrived);
    if (this.replayGate !== null) await this.behindReplay(frame);
    try {
      await this.feedInner(frame, now);
    } catch (err) {
      protocolDrift.observeException(frame, err, "feed");
      throw err;
    }
  }

  /** A pre-ack replay in progress goes first (see `replayGate`). Called only while one
   *  is: a frame takes no extra await otherwise (G-29).
   *  A frame this manager hands itself back (a stash replaying through `feed` — it was
   *  observed at its arrival) is already inside that unit and does not wait for it. */
  private async behindReplay(frame?: unknown): Promise<void> {
    while (
      this.replayGate !== null &&
      !(typeof frame === "object" && frame !== null && this.observedFrames.has(frame))
    ) {
      await this.replayGate;
    }
  }

  /**
   * Frames this manager has already observed. EVERY frame is observed and classified
   * exactly once, at arrival; a frame that comes back through `feed` — the announce
   * stash and the preemption copy replay through it — is recognised here and neither
   * observed nor classified again.
   *
   * Keyed by the frame OBJECT, weakly: the stashes keep the frame they were handed and
   * hand the same object back, so its identity is the one thing every stash and replay
   * path already carries — no stash changes shape, a stash added later inherits the rule
   * without knowing it, and the mark dies with the frame. A wrapper would have had to be
   * unwrapped at each of the entry points that take a raw frame.
   *
   * What is decided here cannot be decided twice: "a notice-only final after its run's
   * final" is true of any final seen a second time.
   */
  private readonly observedFrames = new WeakSet<object>();

  private async feedInner(frame: unknown, now: number): Promise<void> {
    const carried = typeof frame === "object" && frame !== null;
    if (!carried || !this.observedFrames.has(frame)) {
      if (carried) this.observedFrames.add(frame);
      // Observe-only protocol-drift classification (never gates the frame).
      protocolDrift.observe(frame);
      // FACTS ABOUT A RUN that are not a turn's content (a model fallback, the
      // gateway's status notices) are taken HERE, at arrival — before the lanes, the
      // stashes and the turn's pipeline — so the same frame is read the same way
      // whether it comes during its turn, before the ACK or after the terminal, and
      // can neither become a turn's content nor open or close one.
      const facts = this.runFactsFor(frame);
      if (facts !== null) {
        this.noteRunFacts(facts.runId, facts.facts);
        return;
      }
    }
    await this.feedObserved(frame, now);
  }

  /** A frame already observed (a held frame replays through here — counted once). */
  private async feedObserved(frame: unknown, now: number): Promise<void> {
    // A frame of a run with a lane (closing or closed by the transcript): onto its lane,
    // decided SYNCHRONOUSLY and never awaited here — a frame of any other run takes no
    // extra await, so the feed's single ordered application path (G-29) is untouched.
    if (this.enqueueOnLane(frame, now)) return;
    await this.feedPipeline(frame, now);
  }

  // --- FACTS ABOUT A RUN ------------------------------------------------------------
  //
  // A model fallback, its clearing, and the gateway's status notices say something about
  // a RUN after (or beside) its work. They are best-effort METADATA: they never delay,
  // block or reorder a turn's content. `runFactsFor` reads the frame at arrival and
  // `noteRunFacts` appends what it states to the run's ordered queue — both synchronous,
  // and all the frame path ever does. The WRITES are detached from it: one chain
  // (`factsTail`) writes the queues, oldest fact first, on the run's bubble — at once
  // when the bubble exists, when it opens or when the turn settles otherwise. A fact is
  // never written ahead of one still queued for its run, so the last one received is the
  // last one written.
  //
  // Nothing is retried here. The writer retries a transient failure itself, bounded
  // (convex-writer.ts `doPostWithRetry`: these two ops are idempotent in Convex); a write
  // that still fails, or that Convex refuses, drops that one fact with one trace
  // (TurnSink.writeRunFallback / writeRunNotice) and the next one goes on.
  //
  // A manager that is dropped (its session closed) leaves its chain to finish by itself:
  // a write already started completes or times out in the writer, whose timers do not
  // hold the process; the passes queued behind it only read this object's own memory,
  // and facts still waiting for a bubble are never written.

  /** Per-run queues, by run (insertion-ordered: the oldest run is dropped first). */
  private readonly runFacts = new Map<string, RunFactQueue>();
  /** Runs the gateway stated a fallback for and whose notice final is still expected
   *  (bounded): the first status notice that follows is that fallback in words. */
  private readonly fallbackStatedRuns = new Set<string>();
  /** Runs whose `chat` final has been seen (bounded): a notice-only final after it is
   *  beside the answer, not the answer. */
  private readonly finalSeenRuns = new Set<string>();
  /** Serializes the writes: one fact at a time, in the order they were queued. Never
   *  awaited by a frame; it cannot reject. */
  private factsTail: Promise<void> = Promise.resolve();
  private static readonly MAX_RUN_FACT_RUNS = 32;
  private static readonly MAX_RUN_FACTS_PER_RUN = 16;
  private static readonly MAX_REMEMBERED_RUNS = 200;

  private static remember(set: Set<string>, key: string, cap: number): void {
    set.delete(key);
    set.add(key);
    while (set.size > cap) set.delete(set.values().next().value as string);
  }

  /**
   * What a frame states about a run of this session, or null when it is the turn's own
   * material.
   *
   * A model fallback (model-fallback.ts) always is. A `chat` final is when it carries
   * nothing but status notices — blocks the gateway marks `openclawStatusNotice`
   * (2026.9.6+, src/gateway/server-methods/chat-assistant-content.ts) — AND the run's
   * final has already been seen, or the run is settled: upstream sends such notices in a
   * final of their own after the answer's ("status notices remain visible but do not
   * define the terminal reply they accompany"). A notice-only final that is the run's
   * FIRST final is its reply (a command's answer) and stays the turn's.
   *
   * Decided from the order of arrival, not from the turn's state at that instant: the
   * answer and its notice may both precede the ACK.
   *
   * `replayed`: the frame comes back from the pre-ACK buffer, where it went because it
   * was not a fact when it arrived. The order of arrival has been read (and this very
   * frame counted as a final): only what could not be known then is asked again — the
   * run has SETTLED since, on a frame replayed before this one (a lifecycle error, an
   * aborted terminal), and a notice-only final after that is beside the answer, as it
   * is when the same frames arrive during the turn.
   */
  private runFactsFor(frame: unknown, replayed = false): { runId: string; facts: RunFact[] } | null {
    const fallback = modelFallbackFromFrame(frame, this.sessionKey);
    if (fallback !== null) return { runId: fallback.runId, facts: [{ kind: "fallback", fallback }] };
    if (typeof frame !== "object" || frame === null) return null;
    const f = frame as { event?: unknown; payload?: Record<string, unknown> };
    if (f.event !== "chat" || f.payload?.state !== "final") return null;
    const rid = sessionRunIdFor(frame, this.sessionKey);
    if (rid === null) return null;
    const answered =
      (!replayed && this.finalSeenRuns.has(rid)) ||
      (this.settledRuns.has(rid) &&
        !((this.sink.active || this.sink.finalizing) && this.normalizer.ownRunIds.has(rid)));
    if (!replayed) RunManager.remember(this.finalSeenRuns, rid, RunManager.MAX_REMEMBERED_RUNS);
    if (!answered) return null;
    const content = (f.payload.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const facts: RunFact[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) return null;
      const b = block as { type?: unknown; text?: unknown; openclawStatusNotice?: unknown };
      if (b.type !== "text" || typeof b.text !== "string" || b.openclawStatusNotice !== true) {
        return null;
      }
      facts.push({ kind: "notice", text: b.text });
    }
    return { runId: rid, facts };
  }

  /** Queue what a frame states about `runId` and schedule its writing. Synchronous: the
   *  frame that stated it is done here. */
  private noteRunFacts(runId: string, stated: RunFact[]): void {
    let facts = stated;
    if (facts.some((fact) => fact.kind === "fallback")) {
      RunManager.remember(this.fallbackStatedRuns, runId, RunManager.MAX_REMEMBERED_RUNS);
    } else if (this.fallbackStatedRuns.delete(runId)) {
      // The fallback notice is built first and PREPENDED to the run's reply payloads
      // (src/auto-reply/reply/agent-runner-result-payloads.ts): after a fallback the
      // gateway stated for this run, the first notice is that fallback in words —
      // which the bubble's fallback marker already says. Decided in arrival order,
      // whether or not either of them has been written yet.
      facts = facts.slice(1);
    }
    const queue: RunFactQueue = this.runFacts.get(runId) ?? {
      facts: [],
      // A run already settled when its first fact arrives will get no later settle.
      settled:
        this.settledRuns.has(runId) && !(this.sink.active && this.normalizer.ownRunIds.has(runId)),
      scheduled: false,
    };
    const before = queue.facts.length;
    for (const fact of facts) {
      if (fact.kind === "notice") {
        const text = sanitizeText(fact.text).trim().slice(0, MAX_GATEWAY_NOTICE_CHARS);
        if (text === "") continue;
        queue.facts.push({ kind: "notice", text });
      } else {
        queue.facts.push(fact);
      }
    }
    if (queue.facts.length === before) return;
    // Bounded, oldest first — and said, because a dropped fact is a marker or a notice
    // the reader will not see.
    if (queue.facts.length > RunManager.MAX_RUN_FACTS_PER_RUN) {
      const dropped = queue.facts.splice(0, queue.facts.length - RunManager.MAX_RUN_FACTS_PER_RUN);
      console.warn(
        `[run-facts] ${dropped.length} fact(s) dropped, oldest first (per-run bound ${RunManager.MAX_RUN_FACTS_PER_RUN}) run=${runId.slice(0, 60)}`,
      );
    }
    this.runFacts.delete(runId);
    this.runFacts.set(runId, queue);
    while (this.runFacts.size > RunManager.MAX_RUN_FACT_RUNS) {
      const oldest = this.runFacts.keys().next().value as string;
      const lost = this.runFacts.get(oldest)?.facts.length ?? 0;
      this.runFacts.delete(oldest);
      console.warn(
        `[run-facts] ${lost} fact(s) dropped with their run, the oldest waiting (bound ${RunManager.MAX_RUN_FACT_RUNS} runs) run=${oldest.slice(0, 60)}`,
      );
    }
    this.scheduleRunFacts(runId, false);
  }

  /**
   * Queue a write pass for `runId`'s facts on the detached chain. `settled`: a turn
   * owning the run just ended. Returns at once; nothing on the frame path waits for it.
   * One pass per run waits at a time: a frame arriving while the chain is held by a slow
   * write stacks nothing.
   */
  private scheduleRunFacts(runId: string, settled: boolean): void {
    const queue = this.runFacts.get(runId);
    if (queue === undefined) return;
    if (settled) queue.settled = true;
    if (queue.scheduled) return;
    queue.scheduled = true;
    this.factsTail = this.factsTail
      .then(() => {
        queue.scheduled = false;
        return this.writeRunFacts(runId, queue);
      })
      .catch((err: unknown) => {
        console.error("[run-facts] a write pass failed (non-fatal):", errForLog(err));
      });
  }

  /**
   * Write `runId`'s queued facts on its bubble, oldest first. The outcome of a write
   * (RunFactWrite) decides what follows:
   *  - written: next fact;
   *  - failed — after the writer's own retries, or refused outright: that fact is
   *    dropped (the sink traced why) and the next one goes on;
   *  - no bubble — Convex's ANSWER: for a settled run it is final, the run showed
   *    nothing and its facts are dropped, and said; for any other run the bubble may
   *    still come — the fact goes back to the head of its queue and the queue waits
   *    for the bubble to open or the turn to settle.
   */
  private async writeRunFacts(runId: string, queue: RunFactQueue): Promise<void> {
    let waitedFor: SettledRecord | undefined;
    while (this.runFacts.get(runId) === queue && queue.facts.length > 0) {
      const live = this.sink.active && this.normalizer.ownRunIds.has(runId);
      // While the run is the live turn's, its bubble is the turn's — once it is open.
      const known = live
        ? this.sink.currentMessageId
        : (this.lanes.get(runId)?.messageId ?? this.settledRuns.get(runId)?.messageId ?? null);
      if (live && known === null) return;
      // A DISPATCH IS IN FLIGHT and the run is not the open turn's: until the ACK names
      // the turn's run, nothing says whether this fact is beside the bubble the run
      // settled earlier or the first word of the turn about to open on the same run id
      // — written now, it went on the earlier bubble. It waits for the turn to begin
      // (or the send to fail), which schedules every queue again.
      if (!live && this.dispatchInFlight) return;
      // The settled run left no bubble, and a write queued for it may OPEN one (a late
      // final, a refused completion's join): asked now, Convex would answer "no bubble"
      // and the fact would be dropped beside a bubble about to exist. It waits for that
      // queue's pass — once: a write that keeps failing does not hold the facts.
      const record = live ? undefined : this.settledRuns.get(runId);
      if (known === null && record !== undefined && record !== waitedFor && this.keptCompletions.has(record)) {
        waitedFor = record;
        await this.completionsIdle();
        continue;
      }
      // Taken out before the write: the per-run bound may drop the head meanwhile. And
      // "settled" as it stood when Convex was ASKED: its answer is about that instant.
      const fact = queue.facts.shift()!;
      const settled = queue.settled;
      // `known` null: a run this bridge holds no bubble for (the transcript made it,
      // or the frame preceded the turn) — Convex looks the run's bubble up.
      const outcome: RunFactWrite =
        fact.kind === "fallback"
          ? await this.sink.writeRunFallback(fact.fallback, known)
          : await this.sink.writeRunNotice(runId, known, fact.text);
      if (outcome !== "no_bubble") continue;
      queue.facts.unshift(fact);
      if (settled && this.runFacts.get(runId) === queue) {
        console.warn(
          `[run-facts] ${queue.facts.length} fact(s) dropped: the run left no bubble to carry them run=${runId.slice(0, 60)}`,
        );
        this.runFacts.delete(runId);
      }
      return;
    }
    if (this.runFacts.get(runId) === queue && queue.facts.length === 0) this.runFacts.delete(runId);
  }

  /** The live turn's bubble may just have opened: schedule what waited for it. */
  private scheduleLiveRunFacts(): void {
    if (this.runFacts.size === 0 || !this.sink.active || this.sink.currentMessageId === null) return;
    for (const runId of this.runFacts.keys()) {
      if (this.normalizer.ownRunIds.has(runId)) this.scheduleRunFacts(runId, false);
    }
  }

  /** The dispatch is no longer in flight: every queue is given a pass again. */
  private scheduleWaitingRunFacts(): void {
    for (const runId of this.runFacts.keys()) this.scheduleRunFacts(runId, false);
  }

  /** Resolves once every write pass queued so far is done (tests, orderly teardown). */
  async runFactsIdle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.factsTail;
      await tail;
    } while (tail !== this.factsTail);
  }

  /** The turn's own pipeline for a frame (a lane hands back what it held here). */
  private async feedPipeline(frame: unknown, now: number): Promise<void> {
    // Decided SYNCHRONOUSLY, and never awaited: a frame takes no extra await before the
    // ordered path below (G-29), whatever a settled bubble's write is doing.
    this.reofferCompletions();
    const completion = this.normalizer.settledCompletion(frame as never);
    if (completion !== null) {
      this.offerCompletion(completion);
      return;
    }
    // The gateway moved on: a bubble takes the text it was closed without.
    for (const rest of this.normalizer.settledRemainders(frame as never)) {
      this.offerCompletion(rest);
    }
    const late = this.lateFinalFor(frame);
    if (late !== null) {
      // THAT bubble has a queue: this final goes to its tail, whatever its head is
      // doing, and is compared with what the bubble holds only when its turn comes.
      // No queue: the record is what the bubble holds, and a final that adds nothing to
      // it is an ordinary frame.
      if (this.keptCompletions.has(late.settled) || this.lateAddition(late.text, late.settled) !== null) {
        this.queueLateFinal(late);
        return;
      }
    }
    try {
      await this.feedRouted(frame, now);
    } finally {
      this.noteIfSettled();
    }
    this.scheduleLiveRunFacts();
  }

  // --- THE COMPLETION OF A SETTLED BUBBLE ---------------------------------------------
  //
  // Text a run sent after its bubble settled — before that run's chat terminal (a
  // definitive `lifecycle` error, a net) — completes THAT RUN's bubble
  // (Normalizer.settledCompletion), whatever turn is open by then. Never a turn event:
  // no status, no terminal, no phase.
  //
  // `offerCompletion` is all the frame path does, synchronously: the run is owed the
  // text (`keptCompletions`, one per run, the latest text wins) and a write pass is
  // queued on a chain of its own (`completionTail`), like the facts about a run. A frame
  // never waits for that chain — nor does a DISTINCT late final (CU-8,
  // `queueLateFinal`): every write to a settled bubble goes through its queue.
  //
  // ONE QUEUE PER BUBBLE (`keptCompletions`, by the bubble's record): the debt if there
  // is one, then the late finals that arrived for the same bubble while the queue
  // existed (the first of them opens the queue when nothing is owed). The queue is
  // listed from its first entry until it is DRAINED — the debt settled (written,
  // joined, or dropped after its passes) and what waited behind it written — and "is
  // there a queue for this bubble?" is the one question the frame path asks to route a
  // late final. They are written when the debt is settled, never between two passes,
  // each compared with the record as the writes before it left it: what awaiting the
  // write on the frame path used to guarantee, kept by the queue's order.
  //
  // Two bounds, and neither can reorder what it does not drop: at most
  // `MAX_KEPT_COMPLETIONS` bubbles have a queue (the completion or the late final of one
  // more is dropped, and said — no queue is ever removed to make room), and at most
  // `MAX_BEHIND_A_COMPLETION` finals wait in one (one more is dropped, and said).
  //
  // A pass that FAILS — past the writer's own bounded retries (convex-writer.ts
  // `IDEMPOTENT_OPS`: a repeat of a completion that landed is answered as written) —
  // leaves the text owed. It is offered again when something already happens: the next
  // frame of the connection, a turn beginning. No timer here. After
  // `MAX_COMPLETION_PASSES` failed passes the text is dropped, and said.

  /** What settled bubbles are still owed, by DESTINATION — the record of the turn that
   *  settled the bubble (insertion-ordered, bounded). Never by run id: a run id can
   *  settle a second bubble while the first is still owed its text. */
  private readonly keptCompletions = new Map<SettledRecord, KeptCompletion>();
  /** The record each early close's window completes (see `noteIfSettled`). */
  private readonly windowRecords = new WeakMap<object, SettledRecord>();
  /** Serializes the writes to settled bubbles. Never awaited by a frame; cannot reject. */
  private completionTail: Promise<void> = Promise.resolve();
  /** Why the last write to a settled bubble failed (for the trace of whoever asked). */
  private completionFailure: unknown = null;
  private static readonly MAX_COMPLETION_PASSES = 3;
  private static readonly MAX_KEPT_COMPLETIONS = 32;
  private static readonly MAX_BEHIND_A_COMPLETION = 8;

  /** The bubble `offer`'s window settled is owed `offer.text`. Synchronous. */
  private offerCompletion(offer: SettledCompletion): void {
    // The destination is the WINDOW's: the record of the turn whose early close opened
    // it, whatever record the run id names by now.
    const record = this.windowRecords.get(offer.window);
    if (record === undefined) return;
    const kept = this.keptCompletions.get(record);
    if (kept !== undefined) {
      // Same bubble: the latest text wins, it is the gateway's later view of one buffer.
      kept.offer = offer;
    } else {
      // The bound is on the bubbles with a queue, and it refuses the NEWCOMER: a queue
      // lives until it is drained (its debt settled, what waited behind it written),
      // so no bound ever takes a queue away from under the finals routed to it.
      if (this.keptCompletions.size >= RunManager.MAX_KEPT_COMPLETIONS) {
        console.warn(
          `[final] a settled bubble's completion was dropped: ${RunManager.MAX_KEPT_COMPLETIONS} bubbles are already owed one run=${offer.runId.slice(0, 60)}`,
        );
        return;
      }
      this.keptCompletions.set(record, {
        runId: offer.runId,
        offer,
        record,
        failures: 0,
        scheduled: false,
        settledOffer: null,
        joinKey: randomUUID(),
        behind: [],
      });
    }
    this.scheduleCompletion(record);
  }

  /** Queue a write pass for every completion still owed and not already queued: what a
   *  failed pass left. Synchronous, and nothing when nothing is owed. */
  private reofferCompletions(): void {
    if (this.keptCompletions.size === 0) return;
    for (const record of this.keptCompletions.keys()) this.scheduleCompletion(record);
  }

  private scheduleCompletion(record: SettledRecord): void {
    const kept = this.keptCompletions.get(record);
    if (kept === undefined || kept.scheduled) return;
    kept.scheduled = true;
    this.completionTail = this.completionTail
      .then(() => {
        kept.scheduled = false;
        return this.writeCompletion(kept);
      })
      .catch((err: unknown) => {
        console.error("[final] a completion pass failed (non-fatal):", errForLog(err));
      });
  }

  /**
   * Write what a settled bubble is owed. Every write of the pass has one of three
   * outcomes (`SettledWriteOutcome`), and the debt is discharged only by `written` or by
   * the refusal of its LAST resort:
   *  - the completion, WRITTEN: the normalizer's reference and the run's record follow
   *    the bubble;
   *  - the completion, REFUSED (Convex holds a text this one does not extend — the
   *    sanitiser rewrote something already persisted; or the run left no bubble): the
   *    text is never dropped, what it ADDS to the run's record is joined as a late final
   *    is (CU-8) — the last resort. Joined, or nothing to add, or no bubble to join:
   *    discharged;
   *  - either write FAILED: the text stays owed (see above), under one bounded counter.
   *    The next pass asks both again; both are idempotent in Convex.
   */
  private async writeCompletion(kept: KeptCompletion): Promise<void> {
    const { record, runId } = kept;
    while (this.keptCompletions.get(record) === kept) {
      const offer = kept.offer;
      if (offer !== null && kept.settledOffer !== offer) {
        let outcome = await this.completeSettled(record, runId, offer);
        if (outcome === "written") {
          this.normalizer.noteCompletionWritten(offer);
          // The run's record follows its bubble (what a later distinct final is compared with).
          record.text = offer.earlier === null ? offer.text : `${offer.earlier}\n\n${offer.text}`;
        } else if (outcome === "refused") {
          // The last resort, under the debt's own key: a run that left no bubble has one
          // OPENED by this join, and Convex answers a repeat of it with that bubble.
          const whole = offer.earlier === null ? offer.text : `${offer.earlier}\n\n${offer.text}`;
          outcome = (await this.joinLateFinal({ runId, text: whole, settled: record, writeKey: kept.joinKey })) ?? "refused";
          if (outcome === "lost") {
            console.error(
              `[final] a settled run's late text was not written, and is not asked again (this Convex cannot tell a repeat of the write) run=${runId.slice(0, 60)}:`,
              errForLog(this.completionFailure),
            );
          }
        }
        const dropped = outcome === "failed" && ++kept.failures >= RunManager.MAX_COMPLETION_PASSES;
        if (outcome === "failed") {
          console.error(
            `[final] a settled bubble's completion was not written (pass ${kept.failures}/${RunManager.MAX_COMPLETION_PASSES}) — ${dropped ? "DROPPED: the bubble keeps the text it settled with" : "kept, offered again at the next frame"} run=${runId.slice(0, 60)}:`,
            errForLog(this.completionFailure),
          );
          // Still owed: what waits behind it for the same bubble waits too.
          if (!dropped) return;
        }
        // This text is SETTLED (written, joined, or dropped). A newer text offered
        // meanwhile is the debt now (the same text, once written, is done).
        if (kept.offer !== offer && !(outcome === "written" && kept.offer?.text === offer.text)) continue;
        kept.settledOffer = kept.offer;
      }
      // What waited behind the debt, in order. A final whose write failed stays at the
      // head of the queue, owed like the debt was: the pass ends, and the next one
      // (the next frame, a turn beginning) asks for it again.
      if (!(await this.writeBehind(kept))) return;
      // A text offered, or a final queued, while the last write was answered: the queue
      // is not drained.
      if (kept.settledOffer !== kept.offer || kept.behind.length > 0) continue;
      if (this.keptCompletions.get(record) === kept) this.keptCompletions.delete(record);
      return;
    }
  }

  /** The late finals that waited behind a settled debt, oldest first, each compared
   *  with the bubble as the writes before it left it. The debt is still listed while
   *  they are written, so one arriving meanwhile queues behind them. False: the head's
   *  write failed and it stays owed (bounded like a debt: `MAX_COMPLETION_PASSES`
   *  failed passes, then dropped and said) — nothing behind it is written before it. */
  private async writeBehind(kept: KeptCompletion): Promise<boolean> {
    for (let late = kept.behind[0]; late !== undefined; late = kept.behind[0]) {
      const outcome = await this.joinLateFinal(late);
      if (outcome === "failed") {
        late.failures = (late.failures ?? 0) + 1;
        const dropped = late.failures >= RunManager.MAX_COMPLETION_PASSES;
        console.error(
          `[final] a late final in a settled bubble's queue was not written (pass ${late.failures}/${RunManager.MAX_COMPLETION_PASSES}) — ${dropped ? "DROPPED" : "kept, asked again at the next frame"} run=${late.runId.slice(0, 60)}:`,
          errForLog(this.completionFailure),
        );
        if (!dropped) return false;
      } else if (outcome === "lost") {
        console.error("[final] late final not written (non-fatal):", errForLog(this.completionFailure));
      }
      if (kept.behind[0] === late) kept.behind.shift();
    }
    return true;
  }

  /** The completion write itself. No bubble to complete is a refusal. */
  private async completeSettled(
    record: SettledRecord,
    runId: string,
    offer: SettledCompletion,
  ): Promise<SettledWriteOutcome> {
    if (record.messageId === null) return "refused";
    try {
      return (await this.sink.completeSettledText(record.messageId, runId, offer.text))
        ? "written"
        : "refused";
    } catch (e) {
      this.completionFailure = e;
      return "failed";
    }
  }

  /** Resolves once every write to a settled bubble queued so far is done (tests,
   *  orderly teardown). */
  async completionsIdle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.completionTail;
      await tail;
    } while (tail !== this.completionTail);
  }

  /** A run of the session that opens a spontaneous (deferred) turn of its own: the
   *  gateway's delivery families, and — projection `on` — the runs answering inputs it
   *  holds for us. */
  private spontaneousRunFor(frame: unknown): string | null {
    return announceRunIdFor(frame, this.sessionKey) ?? this.adoptableRunFor(frame);
  }

  /**
   * A frame of an input's CUSTODY run that says nothing (projection `on`): the run the
   * ACK named for a steered / queued input ends with a bare `chat final` — the input
   * went into another run (CU-4: "Accepted steering/queued custody identifies the
   * input, not a replacement for the active model run"). Such frames open no turn:
   * one would hold the sink while the run that actually answers streams. A custody run that DOES carry content (the gateway ran
   * the input on its own) is adopted like any other run.
   */
  private custodyRunNoise(frame: unknown): boolean {
    const rid = sessionRunIdFor(frame, this.sessionKey);
    if (rid === null || !this.inputAckRuns.has(rid)) return false;
    if (this.normalizer.ownRunIds.has(rid) && (this.sink.active || this.sink.finalizing)) {
      return false;
    }
    const f = frame as { event?: unknown; payload?: Record<string, unknown> };
    const p = f.payload ?? {};
    if (f.event === "chat") return p.message === undefined && p.deltaText === undefined;
    if (f.event === "agent") {
      const stream = p.stream;
      return stream === "lifecycle" || stream === "run_status" || stream === "status";
    }
    return false;
  }

  private async feedRouted(frame: unknown, now: number): Promise<void> {
    if (this.custodyRunNoise(frame)) return;
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
      const announceRun = this.spontaneousRunFor(frame);
      if (announceRun !== null && this.handledAnnounceRuns.has(announceRun)) {
        // Stale retransmit of a finished announce: NEVER the pre-ack buffer
        // (beginTurn's replay could admit it as a follow-up during a
        // lifecycle-end/compaction grace and overwrite the user's reply with
        // the old report — codex P1), never a new turn. Drop outright.
        return;
      }
      if (announceRun !== null) {
        if (this.replayArmed || this.replayGate !== null || this.sink.finalizing) {
          // A real dispatch is in flight (replayArmed), OR the previous
          // turn's finalize is still writing its tail: in Convex the merged
          // message is still `streaming`, so opening this announce NOW would
          // fail the reopen's streaming gate and fall to a fresh bubble
          // (live incident 2026-07-14: back-to-back parallel deliveries).
          // Stash — flushed right after the finalize settles.
          //
          // OR A PRE-ACK REPLAY IS RUNNING (replayGate): this is the one place a
          // spontaneous turn begins — reached by a replayed frame itself, and by the
          // announce flush a replayed close triggers — and no turn begins between two
          // replayed frames: what the closed run sent after its close (its flushed
          // text, its chat terminal) is still in the buffer. `beginTurn` flushes the
          // stash once the replay is over.
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
        // across every gateway shape (string content, delta-only, message-tool...),
        // and the sink only creates the assistant message
        // on the first user-visible normalized event. A run that terminates
        // silent (the NO_REPLY sentinel) never creates anything — zero bubble.
        this.noteAnnounceHandled(announceRun);
        this.noteRunAdopted(announceRun, announceRunIdFor(frame, this.sessionKey) !== null);
        await this.beginTurn(now, announceRun, {
          expectedSessionId: null,
          spontaneous: true,
        });
        this.noteSpontaneousFrame(frame, now);
        this.tallyFrame(frame);
        await this.applyOrdered(() => this.normalizer.feed(frame, now));
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
      // The compaction VERDICT is read FIRST: the announce flush just below can
      // open a spontaneous turn and route this very frame into it, where the
      // admission policy refuses it as a foreign background run. It is
      // chat-scoped and creates no message, so reading it here costs the
      // announce path nothing.
      //
      // KEPT WITHOUT A FAILING TEST, said plainly: codex raised the ordering and
      // it is obviously the safer one, but every interleaving I built still
      // recorded the verdict either way — the flush does not make the sink
      // active without the announce's own terminal. Ordering, not a proven fix.
      const idleVerdict = idleCompactionVerdict(frame, this.sessionKey);
      if (idleVerdict !== null) {
        if (!this.noteIdleVerdictRead(frame)) return;
        await this.sink.apply([
          {
            type: EVENT_SESSION_OVERFULL,
            overfull: idleVerdict,
            // Stamped at FRAME RECEIPT, not at the POST: a verdict observed
            // before a session reset must still lose the reset fence even if
            // its write queues behind slower ones.
            observedAt: Date.now(),
          },
        ]);
        // …and the frame CONTINUES to the pre-ack buffer when one is armed
        // (codex P2): its matching `start` may already be buffered for the turn
        // about to open, and swallowing the `end` would leave that turn stuck in
        // compaction state and without its thread marker. The chat-scoped
        // verdict above and the turn-scoped replay are two different consumers.
        if (!this.replayArmed) return;
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
          await this.applyOrdered(() => this.normalizer.feed(frame, now));
          return;
        }
      }
      // BETWEEN TURNS the gateway still compacts on its own, and a compaction
      // that FAILS is the state the NEXT turn inherits (G-08). The verdict is
      // CHAT-scoped — it needs no message and no active turn — so it is the one
      // thing that must reach the sink here: without this the branch that
      // records it is dead code in production, and the next turn walks into the
      // context wall unwarned (codex P1).
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
          (p) =>
            p.runId === stashed.runId && provenanceSignature(p.part) === sig,
        );
        if (
          !isDup &&
          this.pendingProvenance.length < MAX_PROVENANCE_PARTS_PER_TURN
        ) {
          this.pendingProvenance.push(stashed);
        }
      } else if (this.replayArmed) {
        // Only while a chat.send is in flight (armed). Between turns the buffer
        // stays empty, so post-finalization stray frames are never replayed.
        if (this.pendingFrames.length < MAX_PENDING_FRAMES) {
          this.pendingFrames.push({ frame, now });
        } else {
          this.pendingFramesOverflowed = true;
        }
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
    // A BACKGROUND compaction can also land while a turn is running (it started
    // between turns and ends after the next one opened). Its run is foreign to
    // the active turn, so the admission policy refuses it and the verdict would
    // be lost (codex P2). Read it here — chat-scoped, no message, no effect on
    // the reply — and let the frame continue: a compaction of OUR OWN run still
    // has to reach the normalizer for the turn's own compaction handling.
    {
      const rid = sessionRunIdFor(frame, this.sessionKey);
      const foreign = rid !== null && !this.normalizer.ownRunIds.has(rid);
      if (foreign) {
        const verdict = idleCompactionVerdict(frame, this.sessionKey);
        if (verdict !== null) {
          if (!this.noteIdleVerdictRead(frame)) return;
          await this.sink.apply([
            {
              type: EVENT_SESSION_OVERFULL,
              overfull: verdict,
              observedAt: Date.now(),
            },
          ]);
          // …and the frame CONTINUES when a send is armed (codex P2): during the
          // pre-ack window `ownRunIds` still holds only the announce run, so the
          // UPCOMING turn's own compaction looks foreign here. Swallowing its
          // `end` would leave that turn holding a buffered `start`, stuck in
          // `compactionPending` until the 900 s budget and missing its marker.
          if (!this.replayArmed) return; // never into the active reply stream
        }
      }
    }
    const activeAnnounce = this.spontaneousRunFor(frame);
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
        } else {
          this.pendingFramesOverflowed = true;
        }
        return;
      }
    }
    this.tallyFrame(frame);
    await this.applyOrdered(() => this.normalizer.feed(frame, now));
    this.dumpTallyOnce();
    // If that frame FINALIZED the turn, deliver any announce stashed during it
    // RIGHT NOW: the consume loop may go idle (nextTimeout null) with no later
    // tick guaranteed — waiting for the next frame could park the report
    // indefinitely (codex P2).
    if (!this.sink.active) {
      await this.flushPendingAnnounce(now);
    }
  }

  /** False when this frame's chat-scoped compaction verdict was already written (the
   *  frame is replaying from the pre-ack buffer): one verdict per frame. */
  private noteIdleVerdictRead(frame: unknown): boolean {
    if (typeof frame !== "object" || frame === null) return true;
    if (this.idleVerdictRead.has(frame)) return false;
    this.idleVerdictRead.add(frame);
    return true;
  }

  /** Resolve expired normalizer deadlines; apply any emitted events. */
  async tick(now: number): Promise<void> {
    // Behind a pre-ack replay, like a frame: a deadline is judged on what the replayed
    // frames leave, not between two of them.
    if (this.replayGate !== null) await this.behindReplay();
    if (!this.sink.active) {
      // Between turns: drain announce frames stashed while a real turn streamed
      // (the other flush point beside feed(); whichever fires first wins).
      await this.flushPendingAnnounce(now);
      return;
    }
    await this.applyOrdered(() => this.normalizer.tick(now));
    this.noteIfSettled();
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
    // Whatever ended before this flush is recorded before it can open the next turn.
    this.noteIfSettled();
    if (
      this.sink.active ||
      this.sink.finalizing ||
      this.replayArmed ||
      this.pendingAnnounce.length === 0
    ) {
      return;
    }
    const stashed = this.pendingAnnounce;
    this.pendingAnnounce = [];
    for (const entry of stashed) {
      if (entry.frame === null) continue; // overflow marker, not a frame
      // ARRIVAL clock, not flush clock (G-35): a frame stashed minutes ago and
      // replayed now would arm the normalizer's deadlines from the wrong instant and
      // read as freshly arrived. Bounded by `now` so a clock oddity can never place
      // an arrival in the future.
      await this.feed(entry.frame, Math.min(entry.now, now));
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

  /** Record an announce run as handled (bounded FIFO of 100 — see the field's note:
   *  a recent-window guard, NOT the anti-duplicate guarantee, which is Convex's). */
  private noteAnnounceHandled(runId: string): void {
    this.handledAnnounceRuns.add(runId);
    this.handledAnnounceOrder.push(runId);
    while (this.handledAnnounceOrder.length > 100) {
      const oldest = this.handledAnnounceOrder.shift();
      if (oldest !== undefined) this.handledAnnounceRuns.delete(oldest);
    }
  }

  /**
   * SINGLE ORDERED APPLICATION PATH (G-29).
   *
   * The sink has more than one producer, and they do not share a call stack: the
   * consume loop drives `feed`/`tick`, while `beginTurn` runs in the /send HTTP
   * handler — including its replay of frames that raced the ack. Both `await`
   * inside `sink.apply`, so a live frame could be applied BETWEEN the produce and
   * the apply of a replayed one: the normalizer's state and the writer's order both
   * stop reflecting arrival order, and the start of a reply can land after its
   * middle.
   *
   * Everything therefore goes through this one chain, and the unit is deliberately
   * SMALL — produce the events from the normalizer AND apply them, nothing else.
   * The producing call must be INSIDE the unit (the normalizer mutates as it
   * produces), and nothing that itself enqueues may run within one: `feed` recurses
   * and `beginTurn` enqueues, so both stay outside the unit they schedule.
   *
   * The chain does not change the nominal order — it guarantees it. Every existing
   * ordering test must therefore still pass unmodified.
   */
  private applyChain: Promise<void> = Promise.resolve();

  private runOrdered(task: () => Promise<void> | void): Promise<void> {
    // BOUND to the turn that enqueued it (codex P2). The chain orders the writes, but
    // `beginTurn` resets the normalizer and the sink OUTSIDE it — a unit still queued
    // when that happens would produce against the NEW turn's state, dropping the old
    // turn's tail or applying it to the wrong reply. Serializing `beginTurn` itself
    // is not an option: it enqueues its own units (the pre-ack replay), so it would
    // wait on a chain containing itself.
    // NOTE on coverage: this binding and the serialized preemption above are
    // belt-and-braces. In the test harness the normalizer's own admission rules
    // (a reset turn no longer owns the dead run's id) already discard such a unit's
    // events, so neither could be given a test that fails without it. They are kept
    // because those rules protect FRAME producers only — `tick`, `endTurn` and the
    // provenance flush produce without re-checking the run id.
    const epoch = this.turnEpoch;
    const run = this.applyChain.then(async () => {
      if (this.turnEpoch !== epoch) {
        console.log(
          `[apply] unit dropped: its turn ended while queued (epoch=${epoch} current=${this.turnEpoch})`,
        );
        return;
      }
      await task();
    });
    // The tail swallows rejections so one failed unit cannot poison the next; the
    // caller still sees its own error through the returned promise.
    this.applyChain = run.catch(() => undefined);
    return run;
  }

  private applyOrdered(produce: () => BridgeEvent[]): Promise<void> {
    return this.runOrdered(async () => {
      await this.sink.apply(produce());
    });
  }

  /**
   * Force-finalize the active turn (e.g. on socket close or a send error). The
   * normalizer emits its terminal pair; the sink flushes it to Convex.
   */
  /**
   * THE TRANSCRIPT SAYS THE RUN IS OVER (projection `on`, phase 4): Convex's run table
   * marked these runs settled — a terminal was observed, or a fresh `chat.history` found
   * the session idle (`hasActiveRun:false`, which the gateway reports only once the
   * terminal row is queryable — src/gateway/server-methods/chat-history-handler.ts:364-373
   * at v2026.9.8; the Control UI retires its run on such a read, ui/src/pages/chat/
   * run-lifecycle.ts:637-690). When the foreground turn's run is among them, the turn
   * ends HERE — on the transcript's fact, never on a timer. The
   * bubble itself was already settled from the rows, in the same Convex mutation; this
   * write is the sink's own close (a no-op there: the first terminal wins).
   * Returns whether a turn ended.
   */
  async settleFromTranscript(transcriptRunIds: readonly string[], now: number): Promise<boolean> {
    if (!this.sink.active || this.normalizer.finalized) return false;
    // A run whose link was stated late has its turn under the client run here.
    const runIds = transcriptRunIds.map((id) => this.lateClientRuns.get(id) ?? id);
    // Only the run the turn is CURRENTLY following: a turn keeps the ids of the runs it
    // owned before (a compaction that resumed the turn on a new run, an abandoned
    // generation), and one of those ending says nothing about the run still writing —
    // closing on it finalized a live answer half-written (codex phase 4 pass 2).
    const current = this.normalizer.currentRunId;
    if (current === null || !runIds.includes(current)) return false;
    if (this.lanes.get(current)?.state === "closing") return false; // already under way
    // The lane, SYNCHRONOUSLY, before any await: from here every frame of the run waits
    // in it. Its destination is captured now (the bubble the turn shows), refined by the
    // close itself when the bubble opened meanwhile.
    const lane: RunLane = {
      runId: current,
      messageId: this.sink.currentMessageId,
      segment: this.sink.openSegment,
      awaiting: [],
      lookups: 0,
      turnStartMs: this.sink.turnStartedAtMs,
      createdAt: now,
      state: "closing",
      normalizer: null,
      tail: Promise.resolve(),
      queued: 0,
    };
    this.lanes.set(current, lane);
    this.pruneLanes(now);
    let closed = false;
    const done = this.onLane(lane, null, async () => {
      // The close and the capture of ITS bubble are ONE ordered unit, before anything can
      // open the next turn (codex phase 4 pass 18: `endTurn` flushes stashed announces,
      // and the next turn's bubble — or none — was read as this run's).
      try {
        await this.runOrdered(async () => {
          // Re-checked INSIDE the unit (codex phase 4 pass 19): units queued before this
          // one can move the turn on a new run (a compaction resume keeps the epoch) or
          // end it. Then this settle is not for it.
          if (
            !this.sink.active ||
            this.normalizer.finalized ||
            this.normalizer.currentRunId !== current
          ) {
            return;
          }
          closed = true;
          // The destination, refreshed HERE — before the close's finalize, which can
          // fail: a bubble that opened while the close was queued is this run's.
          lane.messageId = this.sink.currentMessageId ?? lane.messageId;
          lane.segment = this.sink.openSegment;
          await this.sink.apply(this.normalizer.endTurn(now, "final", null, "transcript_settled", null));
          const b = this.sink.lastSettledBubble;
          if (b !== null && !this.sink.active && (b.runId === null || this.normalizer.ownRunIds.has(b.runId))) {
            lane.messageId = b.messageId;
          }
        });
      } catch (err) {
        // A close that FAILED (Convex unreachable past its retries) still closed the turn
        // here: the lane keeps the run with the destination it captured, and drains.
        protocolDrift.observeException({ settle: current }, err, "feed");
        console.error("[transcript] the close of a run failed (its lane keeps draining):", errForLog(err));
      }
      if (closed) {
        lane.state = "closed";
        lane.normalizer = this.laneNormalizer(current, now);
        this.noteIfSettled();
        // No bubble opened here: the transcript's own (Convex made it from the rows).
        if (lane.messageId === null) await this.lookUpDestination(lane);
      } else {
        lane.state = "aborted";
      }
    });
    await done;
    if (closed && !this.sink.active) await this.flushPendingAnnounce(now);
    return closed;
  }

  /** The bubble the transcript made for a closed run that opened none here (Convex,
   *  verified for this bridge's instance, chat, session, run and segment). Only a lane
   *  reaches this — and a lane exists only for a run a projected turn closed. */
  private async lookUpDestination(lane: RunLane): Promise<void> {
    if (this.writer.findProjectedBubble === undefined) {
      lane.lookups = RunManager.MAX_DESTINATION_LOOKUPS;
      return;
    }
    lane.lookups++;
    try {
      // The rows' bubble is the EXECUTION run's (a link stated late keeps the turn under
      // the client run): asked, and then written to, under the transcript's name.
      const transcriptRunId = this.lateExecutionRuns.get(lane.runId) ?? lane.runId;
      const id = await this.writer.findProjectedBubble(this.chatId, this.sessionKey, transcriptRunId, lane.segment);
      if (id !== null) {
        lane.messageId = id;
        if (transcriptRunId !== lane.runId) lane.transcriptRunId = transcriptRunId;
      }
    } catch (err) {
      protocolDrift.observeException({ closedRun: lane.runId }, err, "feed");
      console.error("[transcript] a closed run's bubble lookup failed (will retry):", errForLog(err));
    }
  }

  /** The private normalizer that reads a closed run's later frames as its turn would. */
  private laneNormalizer(runId: string, now: number): Normalizer {
    const normalizer = new Normalizer(this.sessionKey, this.providerSessionId);
    normalizer.beginTurn(now);
    normalizer.noteRunStarted(runId, now);
    return normalizer;
  }

  /** Drop the lanes past their age, then the oldest past the count. */
  private pruneLanes(now: number): void {
    for (const [id, lane] of this.lanes) {
      if (now - lane.createdAt > RunManager.TRANSCRIPT_CLOSED_TTL_S) this.lanes.delete(id);
    }
    while (this.lanes.size > RunManager.MAX_TRANSCRIPT_CLOSED) {
      this.lanes.delete(this.lanes.keys().next().value as string);
    }
  }

  /** Queue `task` on the lane, strictly after everything already on it. Errors are
   *  reported (the same sensor as `feed`) and never stop the lane. */
  private onLane(lane: RunLane, frame: unknown, task: () => Promise<void>): Promise<void> {
    lane.queued++;
    const run = lane.tail.then(async () => {
      try {
        await task();
      } catch (err) {
        protocolDrift.observeException(frame, err, "feed");
        console.error("[transcript] a run lane item failed (non-fatal):", errForLog(err));
      } finally {
        lane.queued--;
        // An aborted lane has handed back what it held: the run is the turn's again.
        if (lane.state === "aborted" && lane.queued === 0 && this.lanes.get(lane.runId) === lane) {
          this.lanes.delete(lane.runId);
        }
      }
    });
    lane.tail = run;
    return run;
  }

  /** A frame of a run that has a lane: queued on it (true), never awaited by the caller. */
  private enqueueOnLane(frame: unknown, now: number): boolean {
    if (this.lanes.size === 0) return false;
    this.pruneLanes(now);
    const rid = sessionRunIdFor(frame, this.sessionKey);
    const lane = rid === null ? undefined : this.lanes.get(rid);
    if (lane === undefined) return false;
    // A closed run followed by a live turn again (a resume): that turn owns its frames.
    if (lane.state === "closed" && this.sink.active && this.normalizer.ownRunIds.has(lane.runId)) return false;
    if (lane.queued >= RunManager.MAX_LANE_ITEMS) {
      console.log("[transcript] a frame of a closed run was dropped (lane bound reached)");
      return true;
    }
    void this.onLane(lane, frame, () => this.laneFrame(lane, frame, now));
    return true;
  }

  /** One frame on its run's lane: handed back to the turn (aborted close), or its media
   *  and terminal written onto the run's bubble (closed), each to completion. */
  private async laneFrame(lane: RunLane, frame: unknown, now: number): Promise<void> {
    if (lane.state === "aborted") {
      await this.feedPipeline(frame, now);
      return;
    }
    if (lane.state !== "closed" || lane.normalizer === null) return;
    if (lane.messageId === null) {
      // Still no destination: look again — one lookup per lane event; the lane gives up
      // (below) once MAX_DESTINATION_LOOKUPS failed, so this is bounded. Meanwhile the
      // frame waits, in order.
      await this.lookUpDestination(lane);
      if (lane.messageId === null) {
        if (lane.lookups < RunManager.MAX_DESTINATION_LOOKUPS && lane.awaiting.length < RunManager.MAX_LANE_ITEMS) {
          lane.awaiting.push({ frame, now });
          return;
        }
        // Given up: the Convex deferred check settles the file job with what arrived.
        protocolDrift.observeException(
          { closedRun: lane.runId },
          new Error("closed run: no bubble found for its late media and terminal"),
          "feed",
        );
        console.error("[transcript] a closed run's bubble was not found — its late frames are dropped");
        lane.awaiting = [];
        lane.state = "done";
        if (this.lanes.get(lane.runId) === lane) this.lanes.delete(lane.runId);
        return;
      }
      // Found: what waited goes first, in arrival order.
      const waited = lane.awaiting;
      lane.awaiting = [];
      for (const w of waited) {
        await this.laneFrame(lane, w.frame, w.now);
        if (lane.state !== "closed") return;
      }
    }
    const messageId = lane.messageId;
    let final: { error: string | null; errorKind: string | null; cause: string | null } | null = null;
    for (const e of lane.normalizer.feed(frame as never, now)) {
      const ev = e as unknown as Record<string, unknown>;
      if (e.type === "message.final") {
        final = {
          error: typeof ev.error === "string" ? ev.error : null,
          errorKind: typeof ev.errorKind === "string" && ev.errorKind !== "" ? ev.errorKind : null,
          cause: typeof ev.diagnosticFinalizeCause === "string" ? ev.diagnosticFinalizeCause : null,
        };
      } else if (
        e.type === "run.status" &&
        (ev.status === "final" || ev.status === "complete" || ev.status === "error" || ev.status === "aborted")
      ) {
        const status = ev.status === "error" ? "error" : ev.status === "aborted" ? "aborted" : "complete";
        const f = final ?? { error: null, errorKind: null, cause: null };
        lane.state = "done";
        if (this.lanes.get(lane.runId) === lane) this.lanes.delete(lane.runId);
        // The run's LIVE terminal, with ITS generation (the bubble may belong to another
        // run by now — codex phase 4 pass 18): Convex keeps the bubble's text and status
        // and settles what waited for the run's media.
        await this.writer.finalizeClosedRun?.(
          messageId,
          lane.transcriptRunId ?? lane.runId,
          status,
          f.error,
          f.errorKind,
          f.cause !== null && f.cause !== "transcript_settled" ? f.cause : "gateway_final",
        );
        return;
      }
    }
  }

  /** Every lane drained (tests; a session closing down). */
  async lanesIdle(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const tails = [...this.lanes.values()].map((l) => l.tail);
      if (tails.length === 0) return;
      await Promise.all(tails);
      if ([...this.lanes.values()].every((l) => l.queued === 0)) return;
    }
  }

  async endTurn(
    now: number,
    status = "final",
    error: string | null = null,
    cause: FinalizeCause = "external",
    /** Known failure class, when the caller has one (see Normalizer.endTurn). */
    errorKind: string | null = null,
  ): Promise<void> {
    if (!this.sink.active) {
      return;
    }
    await this.applyOrdered(() =>
      this.normalizer.endTurn(now, status, error, cause, errorKind),
    );
    this.noteIfSettled();
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
  if (runId === null) return null;
  // THREE gateway-initiated run families ride the same spontaneous-turn
  // machinery (deferOpen + stash-during-active-turn + NO_REPLY discard):
  // sub-agent announces, background-task deliveries (`<tool>:<taskId>:ok`,
  // pinned live 2026-07-12 — image_generate/video/any durable tool), and
  // realtime-voice agent consults (`talk-<callId>-<uuid>`, measured
  // 2026-07-16) — the voice-triggered agent turn lands in the thread too.
  if (runId.startsWith("announce:")) return runId;
  if (taskDeliveryRunFromRunId(runId) !== null) return runId;
  // An APPROVED command's continuation: after a person allows an exec approval the
  // gateway runs the command and resumes the session with a run whose id is its
  // idempotency key, `exec-approval-followup:<approvalId>[:nonce:<n>]`
  // (bash-tools.exec-approval-followup-state.ts:80 at v2026.9.5). Without admission
  // the agent's reply to its own authorised command was dropped here — the same
  // loss the three families above were admitted to prevent.
  if (runId.startsWith(EXEC_APPROVAL_FOLLOWUP_PREFIX)) return runId;
  // Talk consults are normally written by the /talk-toolcall RELAY itself
  // (voice-first chats have no warm session): skip the runs it CLAIMED so a
  // warm session never double-writes the bubble. Unclaimed talk runs (relay
  // timed out and released, or a consult triggered by another client, e.g.
  // the Control UI) still merge here.
  if (isTalkConsultRunId(runId) && !isRelayOwnedTalkRun(runId)) return runId;
  return null;
}

/** The frame's runId when it is an agent/chat event addressed EXACTLY to this
 *  session (child-lane frames carry the child's key -> null). */
/**
 * The compaction VERDICT carried by a `stream:"compaction"` frame of OUR session
 * arriving BETWEEN turns, or null when the frame says nothing about it.
 *
 * Read here rather than through the normalizer on purpose: between turns the
 * frame belongs to a gateway BACKGROUND run, which the admission policy refuses
 * by construction (G-12) — routing it through would have been dead code. The
 * decision itself is the SHARED rule (`core/compaction-verdict.ts`), so the two
 * producers can never drift.
 */
function idleCompactionVerdict(
  frame: unknown,
  sessionKey: string,
): boolean | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.event !== "agent") return null;
  const payload = f.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.sessionKey !== sessionKey || p.stream !== "compaction") return null;
  const data = p.data;
  if (compactionFailedForGood(data)) return true;
  if (compactionCompleted(data)) return false;
  return null;
}

function sessionRunIdFor(frame: unknown, sessionKey: string): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  // `chat.side_result` carries visible reply text too (G-18), so it must be
  // attributable like any other content frame: without it the pre-ack replay
  // buffer does not recognize the frame, and a side-result racing an announce
  // turn's ack reaches the WRONG turn's normalizer, where it is refused as a
  // foreign run — the reply simply disappears (codex P1).
  if (f.event !== "agent" && f.event !== "chat" && f.event !== "chat.side_result") {
    return null;
  }
  const payload = f.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.sessionKey !== sessionKey) return null;
  const runId = p.runId;
  return typeof runId === "string" && runId ? runId : null;
}

/** Collapse whitespace (late-final comparison only). */
function normText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/** What `full` says beyond `shown` (located whitespace-insensitively, exactly as
 *  `normText` compares them — no regex: both are model text of any size): the raw text
 *  before and after it, or "" when nothing is added. */
function textBeyond(full: string, shown: string): string {
  const needle = normText(shown);
  if (needle === "") return full.trim();
  // normText(full), with the raw index of each normalized character.
  let norm = "";
  const rawAt: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < full.length; i++) {
    const ch = full[i]!;
    if (/\s/.test(ch)) {
      if (norm !== "" && pendingSpace === -1) pendingSpace = i;
      continue;
    }
    if (pendingSpace !== -1) {
      norm += " ";
      rawAt.push(pendingSpace);
      pendingSpace = -1;
    }
    norm += ch;
    rawAt.push(i);
  }
  const at = norm.indexOf(needle);
  if (at === -1) return full.trim();
  const rawStart = rawAt[at]!;
  const rawEnd = rawAt[at + needle.length - 1]! + 1;
  const head = full.slice(0, rawStart).trim();
  const tail = full.slice(rawEnd).trim();
  return [head, tail].filter((x) => x !== "").join("\n\n");
}

/** The visible text of a `chat` final's message: its `text` parts (never thinking or
 *  tool blocks), else its `text` field. */
function visibleFinalText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const m = message as { content?: unknown; text?: unknown };
  if (Array.isArray(m.content)) {
    const parts = m.content
      .filter(
        (c): c is { type: string; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text);
    if (parts.length > 0) return parts.join("\n").trim();
  }
  if (typeof m.content === "string") return m.content.trim();
  return typeof m.text === "string" ? m.text.trim() : "";
}
