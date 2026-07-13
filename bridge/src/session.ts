// Per-session lifecycle: one OpenClaw connection + one RunManager + the inbound
// frame-consumer loop that drives the normalizer's receive-loop timing.
//
// A "session" maps a Convex chat (chatId) to an OpenClaw session key and the
// persistent operator WebSocket that serves it. The registry lazily creates a
// session on first send and reuses it for subsequent turns on the same chat.
//
// The consumer loop mirrors backend/app/main.py `_openclaw_to_browser`: a single
// pending `frames()` read across iterations so a frame dequeued exactly when the
// timeout fires is never dropped; on timeout we `tick()` the normalizer so an
// armed grace always finalizes (never a hung "thinking" UI).

import { OpenClawConnection } from "./providers/openclaw/openclaw-client.js";
import { RunManager } from "./providers/openclaw/run-manager.js";
import {
  extractLatestAssistantReply,
  extractMessageToolReplies,
  lastUserEntryText,
  transcriptEntryCount,
} from "./providers/openclaw/history-recovery.js";
import { SubAgentObserver } from "./providers/openclaw/sub-agent-observer.js";
import type { ConvexWriter, SubAgentRecord } from "./convex-writer.js";
import type { OutboundScan } from "./core/turn-sink.js";
import { gatewayHostOf } from "./core/health.js";
import type { BridgeConfig } from "./config.js";
import type { MediaFetcherProvider } from "./core/media-fetcher-provider.js";
import { buildSessionKey } from "./providers/openclaw/session-keys.js";

// Stable errorCode for a bridge-side infrastructure end (socket drop / crash
// mid-turn): the UI maps it to "connection lost — retry", never the user
// "Interrompu". Distinct from the user Stop (Convex-set "aborted").
const CONNECTION_LOST_CODE = "connection_lost";
// The gateway kept reasoning past the recovery budget (a recv-silence turn whose
// active status-query never resolved) — an actionable class distinct from a
// dropped connection (the socket was fine; the agent simply took too long).
const RESPONSE_TIMEOUT_CODE = "response_timeout";

// Orphan-turn recovery (gateway restart mid-turn): the gateway's
// main-session-restart-recovery RESUMES the run after boot and the answer
// lands only in the session transcript. Poll it over a fresh connection until
// the resumed reply appears, bounded WELL under the Convex stuck-stream
// watchdog (12 min) so the backstop keeps the last word.
const ORPHAN_RECOVERY_POLL_MS = 20_000;
// DOUBLE deadline: poll ticks AND wall clock. Ticks alone can stretch past the
// Convex watchdog when the gateway is down (each tick may burn the WS connect +
// request timeouts BEFORE arming the next 20s timer — codex P2); a wall bound
// alone tied to the injected Clock would misread its SECONDS unit (codex P1).
// Date.now() is used for the wall bound (vitest fake timers advance it, so the
// tests stay deterministic). 9 min, well under the 12-min stuck-stream watchdog.
const ORPHAN_RECOVERY_MAX_POLLS = 27;
const ORPHAN_RECOVERY_WALL_MS = 9 * 60_000;
// The recv-silence recovery starts LATE (after BASE_RECV_TIMEOUT = 240s of
// silence), so its budget must keep the TOTAL under the Convex stuck-stream
// watchdog (12 min): 240s + 6.5min = ~10.5min, 1.5min of margin. A 9-min wall
// here would reach ~13min and the watchdog would orphan the turn first,
// discarding a delivery landing in the 12-13min window (codex P2).
const SILENCE_RECOVERY_MAX_POLLS = 19;
const SILENCE_RECOVERY_WALL_MS = 6.5 * 60_000;

/** Fetches the raw `sessions.get` payload for a sessionKey over a FRESH
 *  connection (the session's own socket is dead when recovery runs). */
export type TranscriptFetcher = (sessionKey: string) => Promise<unknown>;

/**
 * Everything needed to serve ONE instance: its full per-instance config (gateway
 * URL + creds + media dirs), its Convex writer (with that instance's media fetcher
 * baked in), its hot media provider and its deterministic outbound scan. One bridge
 * holds a Map<instanceName, InstanceBundle> (one bridge, N gateways) — keeping the
 * per-instance-ness in the bundle leaves Session/RunManager/writer unchanged.
 */
export interface InstanceBundle {
  config: BridgeConfig;
  writer: ConvexWriter;
  mediaProvider: MediaFetcherProvider;
  outboundScan?: OutboundScan;
}

/** A monotonic clock in SECONDS (matches the normalizer's time unit). */
export type Clock = () => number;

const defaultClock: Clock = () => Date.now() / 1000;

/**
 * Per-turn routing the registry needs to build the gateway session key. `agentId`
 * and `canonical` are routed FROM THE REQUEST BODY (Convex resolves the discovered
 * agent + the per-user canonical) — never a static bridge env. This is the fix for
 * the "Agent <env-id> no longer exists" production bug.
 */
export interface SessionRouting {
  chatId: string;
  openclawChatId: string | null;
  agentId: string;
  canonical: string;
  /** Which served instance this turn routes to (selects the gateway + creds). The
   *  server always sets it (from the guarded body); when omitted, a bridge serving a
   *  SINGLE instance falls back to that one. */
  instanceName?: string;
}

export interface BridgeSession {
  readonly chatId: string;
  readonly sessionKey: string;
  /** The served instance (gateway) this session is bound to (one bridge, N gateways). */
  readonly instanceName: string;
  readonly connection: OpenClawConnection;
  readonly runManager: RunManager;
  readonly clock: Clock;
  /** TRUE until this bridge has run its first turn on this session (set false by
   *  performSend after the first send). A session is created fresh on an agent
   *  SWITCH (the epoch re-keys → a NEW sessionKey → acquire() builds a new Session),
   *  so `firstSendPending` is the bridge's OWN "never sent a turn on this key" signal
   *  — independent of the gateway's `systemSent`, which it reports truthy for a
   *  freshly-created webchat session (so it cannot tell a brand-new cross-agent
   *  session from a warm one). Rehydration uses it to re-ground a switched agent. */
  firstSendPending: boolean;
  /** Prod the inbound consume loop to re-evaluate its next deadline. MUST be
   *  called after `runManager.beginTurn` (which arms the recv/grace deadline from
   *  OUTSIDE the loop) so a loop blocked on a null-timeout frame wait does not
   *  hang the turn forever in "streaming". */
  wake(): void;
  /** Anchor the current turn's sent user text for orphan-recovery validation. */
  noteTurnUserAnchor(sentMessage: string): void;
  /** Test/diagnostic seam: count of children with an ordered registration recorded
   *  (registeredChildren). Asserts the set never leaks across terminated/swept children. */
  readonly registeredChildCount: number;
  /** Phase 2c: arm the sub-agent observer to capture the reply to a user INTERACTION
   *  before the /subagent-send endpoint dispatches the chat.send to the child. */
  armSubAgentInteraction(childKey: string, interactionId: string): void;
}

/**
 * A live session's non-secret routed identity + the gateway version its
 * connection captured at handshake. Consumed by `/health` and `/capabilities`
 * (compat manifest targets). Deliberately excludes chatId/sessionKey: both
 * endpoints are unauthenticated, so only the bounded operator identity leaks.
 */
export interface LiveTarget {
  canonical: string;
  agentId: string;
  /** Which served instance (gateway) this session belongs to (one bridge, N gateways). */
  instanceName: string;
  gatewayVersion: string | null;
  /** Gateway WS frame limit (policy.maxPayload) from this session's handshake —
   *  the authoritative inbound-attachment ceiling, surfaced for /health. */
  maxPayload: number | null;
}

class Session implements BridgeSession {
  readonly chatId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly canonical: string;
  readonly instanceName: string;
  readonly connection: OpenClawConnection;
  readonly runManager: RunManager;
  // PERSISTENT, chat-level observation of sub-agents this chat's agent spawns
  // (sessions_spawn). INBOUND-ONLY: it reads child frames off the same connection
  // and upserts their status to Convex; it NEVER influences what the bridge sends.
  // Decoupled from the parent-turn lifecycle so a child frame arriving AFTER the
  // parent turn finalized still records (the whole reason the monitor exists).
  readonly observer: SubAgentObserver;
  // Child session keys whose INITIAL running-row creation we have already ordered
  // (awaited). Lets flushSubAgentObserved await ONLY the first `running` upsert per
  // child (its spawn registration) and fire every later status/heartbeat off the
  // loop's critical path. Cleared with the observer on connection close.
  private readonly registeredChildren = new Set<string>();
  private readonly writer: ConvexWriter;
  readonly clock: Clock;
  // Last time this session saw work (a send via acquire, or an inbound frame), on
  // the SECONDS Clock. The registry's idle sweeper reaps a session — closing its
  // WebSocket/FD — once this is older than IDLE_SESSION_TTL_SECONDS, so idle sockets
  // don't accumulate to FD exhaustion (the next send transparently reconnects).
  lastActivityAt: number;
  private readonly transcriptFetcher?: TranscriptFetcher;
  // Tail of the CURRENT turn's sent user message (set by the send path at
  // beginTurn). The orphan recovery only accepts a transcript whose last user
  // entry ends with this anchor — a stale transcript served mid-reboot may
  // still predate the current turn (codex P2: without the check, the PREVIOUS
  // turn's reply could be finalized as the current answer).
  private turnUserAnchor: string | null = null;
  // The turnEpoch the anchor was set for: a SPONTANEOUS (announce) turn never
  // calls noteTurnUserAnchor, so its epoch differs — the recovery must then
  // treat the turn as anchor-less (baseline-growth gate) instead of matching
  // the PREVIOUS user turn's anchor against a stale transcript (codex R10 P2).
  private turnUserAnchorEpoch = -1;
  // The turnEpoch a transcript-recovery poll is currently bound to (socket-drop OR
  // recv-silence), or null. Per-EPOCH: the same turn never gets two polls, while a
  // NEW turn can always start its own (a stale poll self-cancels on mismatch).
  private recoveryEpoch: number | null = null;
  // Why the active recovery is running: a socket_drop SUPERSEDES a recv_silence
  // one on the same turn (graver event, longer budget, connection_lost class).
  private recoveryReason: "socket_drop" | "recv_silence" | null = null;
  // Poll-generation token: bumped on every accepted schedule; a superseded poll
  // sees the mismatch on its next wake and dies WITHOUT touching the new claim.
  private recoveryGen = 0;
  // See BridgeSession.firstSendPending. True until performSend runs the first turn.
  firstSendPending = true;
  private consumerStarted = false;
  // Wake seam for the consume loop (see consume() + wake()): lets beginTurn,
  // which runs OFF this loop and arms the recv/grace deadline, prod the loop to
  // re-evaluate. `wakeConsumer` resolves the loop's in-flight race; `wakePending`
  // captures a wake that lands while the loop is NOT in its race (resolver null),
  // making liveness independent of interleaving.
  private wakeConsumer: (() => void) | null = null;
  private wakePending = false;

  constructor(
    chatId: string,
    sessionKey: string,
    routing: { agentId: string; canonical: string; instanceName: string },
    connection: OpenClawConnection,
    writer: ConvexWriter,
    clock: Clock,
    outboundScan?: OutboundScan,
    transcriptFetcher?: TranscriptFetcher,
    // Health-stats hook: a turn of THIS session finalizing in error is a
    // downstream failure on its target (HealthRegistry.recordTurnError).
    onTurnError?: (code: string) => void,
  ) {
    this.chatId = chatId;
    this.sessionKey = sessionKey;
    this.agentId = routing.agentId;
    this.canonical = routing.canonical;
    this.instanceName = routing.instanceName;
    this.connection = connection;
    this.runManager = new RunManager(
      chatId,
      sessionKey,
      writer,
      outboundScan,
      onTurnError,
    );
    this.writer = writer;
    this.observer = new SubAgentObserver(sessionKey, chatId);
    this.clock = clock;
    this.lastActivityAt = clock();
    this.transcriptFetcher = transcriptFetcher;
  }

  /** Anchor the current turn's sent user text (tail) for orphan-recovery
   *  boundary validation. Called by the send path right after beginTurn. */
  noteTurnUserAnchor(sentMessage: string): void {
    // RAW user text only (never the enriched message — its static injection
    // suffixes are identical across turns and would defeat the guard). The
    // transcript entry may WRAP the raw text (history prefix, delivery
    // suffix), so the recovery checks CONTAINMENT of this tail.
    const trimmed = sentMessage.trim();
    this.turnUserAnchor = trimmed ? trimmed.slice(-120) : null;
    this.turnUserAnchorEpoch = this.runManager.turnEpoch;
  }

  /** Test/diagnostic seam (mirrors observer.size): how many children currently hold an
   *  ORDERED registration in registeredChildren. Lets a test assert the set never leaks
   *  — a child terminalized by a frame OR by the TTL sweep frees its key. */
  get registeredChildCount(): number {
    return this.registeredChildren.size;
  }

  /** Phase 2c: arm the sub-agent observer to capture the reply to a user INTERACTION,
   *  called just before the /subagent-send endpoint dispatches the chat.send to the
   *  child (so a re-woken, already-reaped child's terminal is recognized as the
   *  interaction reply and routed to the interaction store). */
  armSubAgentInteraction(childKey: string, interactionId: string): void {
    this.observer.armInteraction(childKey, interactionId, this.clock());
  }

  /**
   * Flush OBSERVED sub-agent records (from both observe() AND the TTL sweep()),
   * ORDERING the initial running-row creation.
   *
   * The FIRST `running` record for a child (its spawn registration) is AWAITED, so the
   * row commits before the consume loop reads the NEXT frame — e.g. the parent's
   * chat:final, which finalizes the turn and runs the queue drain. That closes the
   * spawn-upsert race (P1.2): by the time the parent reply is shown, the `running` row
   * exists, so a fast follow-up is HELD (isChatBusy) instead of mis-routed into the
   * yielded child. doPost is deadline-bounded, so this await can never wedge the loop.
   *
   * Every LATER record (status changes, the throttled keep-alive heartbeat, terminals)
   * stays OFF the loop's critical path (void + catch) — preserving the fire-and-forget
   * contract so a slow observation write never delays the turn. A terminal record frees
   * the child's key from registeredChildren so the set stays bounded to live children —
   * this is THE cleanup, and the sweep path MUST route through here (not a bare flush)
   * so a TTL-terminalized child's key is freed too.
   */
  private async flushSubAgentObserved(
    records: SubAgentRecord[],
  ): Promise<void> {
    for (const record of records) {
      // Phase 2c: a pure INTERACTION-reply record routes to the interaction store
      // ONLY — never the subAgents row (the original answer stays intact). Off the
      // critical path (best-effort), like the other observation writes.
      if (record.interactionReply) {
        void this.writer
          .recordInteractionReply(record.interactionReply)
          .catch((err) => {
            console.warn(
              `[subagent] interaction reply write failed chat=${this.chatId}:`,
              (err as Error)?.message ?? err,
            );
          });
        continue;
      }
      const isRegistration =
        record.status === "running" &&
        !this.registeredChildren.has(record.childSessionKey);
      if (isRegistration) {
        try {
          await this.writer.upsertSubAgent(record);
          this.registeredChildren.add(record.childSessionKey);
        } catch (err) {
          // Best-effort: a failed registration must not break the loop. Leave the
          // child UNREGISTERED so the next frame re-attempts the ordered write.
          console.warn(
            `[subagent] registration upsert failed chat=${this.chatId}:`,
            (err as Error)?.message ?? err,
          );
        }
      } else {
        if (record.status !== "running") {
          this.registeredChildren.delete(record.childSessionKey);
        }
        void this.writer.upsertSubAgent(record).catch((err) => {
          console.warn(
            `[subagent] upsert failed chat=${this.chatId}:`,
            (err as Error)?.message ?? err,
          );
        });
      }
      // Per-tool DETAIL (args + result) rides on the same tool-frame emission; route
      // it to its OWN table best-effort, off the critical path — it never gates the
      // summary upsert above and a failed detail write must not wedge the loop.
      if (record.toolPart) {
        void this.writer.upsertSubAgentToolPart(record.toolPart).catch((err) => {
          console.warn(
            `[subagent] tool-part upsert failed chat=${this.chatId}:`,
            (err as Error)?.message ?? err,
          );
        });
      }
    }
  }

  /**
   * Start the single inbound consumer loop for this session's connection.
   * Idempotent. Resolves when the connection closes (frames() terminates).
   */
  startConsumer(): void {
    if (this.consumerStarted) {
      return;
    }
    this.consumerStarted = true;
    // The consume loop catches its own feed/tick/endTurn errors, but a throw in
    // the loop machinery itself (iterator, race) would otherwise become an
    // unhandled rejection and kill the whole bridge. Guard it: finalize any
    // mid-flight turn, then CLOSE the connection so `SessionRegistry.acquire`
    // transparently reconnects on the next send — this session self-heals instead
    // of taking the process down. The `.catch` callback stays SYNCHRONOUS (it only
    // schedules the detached, fully-guarded recovery) so it can never itself reject.
    void this.consume().catch((err) => {
      console.error(
        `[session] consume loop crashed chat=${this.chatId} — recovering:`,
        (err as Error)?.message ?? err,
      );
      void this.recoverFromConsumeCrash();
    });
  }

  /**
   * Recover from a consume-loop crash. Mirrors the `winner.done` (connection
   * closed) path: if a turn was mid-flight, finalize it as `aborted` so the
   * assistant message never hangs in "streaming" forever; then close the
   * connection so the next send reconnects. Fully self-contained — it MUST NOT
   * throw (it runs detached, so a throw would be an unhandled rejection, i.e. the
   * very crash we are guarding against).
   */
  private async recoverFromConsumeCrash(): Promise<void> {
    // Close FIRST: close() synchronously marks the connection isClosed, so a
    // concurrent SessionRegistry.acquire() during the AWAITED endTurn() below can
    // no longer hand this dead-consumer session to a new /send (which would
    // chat.send + beginTurn with NO frame reader -> a turn stuck in "streaming").
    // acquire then drops this session and reconnects a fresh one. endTurn writes to
    // Convex (not this socket), so closing first does not affect the finalize.
    try {
      this.connection.close();
    } catch {
      /* already gone */
    }
    // The connection is gone -> no more child frames; drop observations AND the
    // registration-ordering set so the crash-recovery path can't leak the registry
    // (keep registeredChildren in lockstep with the observer — invariant: it only ever
    // holds keys of currently-observed children).
    this.observer.clear();
    this.registeredChildren.clear();
    if (!this.runManager.isFinalized) {
      try {
        // A crash/close mid-turn is an INFRASTRUCTURE end, not a user stop —
        // finalize as a clear "connection lost" error, never "aborted" (which
        // the UI renders as the user's "Interrompu"). A user Stop set Convex
        // status "aborted" already; first-terminal-wins keeps it.
        await this.runManager.endTurn(this.clock(), "error", CONNECTION_LOST_CODE);
      } catch (err) {
        console.error(
          `[session] crash finalize error chat=${this.chatId}:`,
          (err as Error)?.message ?? err,
        );
      }
    }
  }

  /**
   * Prod the consume loop to re-evaluate its next deadline. Called by performSend
   * right after `runManager.beginTurn` arms the recv/grace deadline from OUTSIDE
   * the loop: without it, a loop already blocked on a null-timeout frame wait
   * never re-reads nextTimeout, so when the gateway sends nothing further (or the
   * whole reply arrived in the pre-ack buffer) the turn hangs in "streaming"
   * forever (the recv guard never fires). Best-effort: a wake that lands while the
   * loop is not currently racing sets `wakePending`, which the loop checks
   * synchronously before blocking — so correctness does not depend on interleaving.
   */
  wake(): void {
    this.wakePending = true;
    const w = this.wakeConsumer;
    if (w) {
      this.wakeConsumer = null;
      w();
    }
  }

  private async consume(): Promise<void> {
    const iterator = this.connection.frames();
    // Maintain a single pending read so a frame is never lost on a tick timeout.
    let nextFrame = iterator.next();
    while (true) {
      // Webchat sink (history recovery), checked as the FIRST thing each iteration
      // so the wake `continue`s below DON'T skip it: when the whole reply arrived
      // in the pre-ACK buffer, beginTurn's replay arms wantsHistoryRecovery and
      // then wake() makes the loop `continue` — without this at the top, the next
      // event would be the private_ack grace finalizing a bare ack ("Sent.")
      // before sessions.get could recover the delivered message-tool text. For the
      // normal frame/tick path this is equivalent to the old loop-bottom placement
      // (no await between feed and the re-top). takeRecoveryRequest latches, so it
      // fires at most once per turn.
      if (this.runManager.takeRecoveryRequest()) {
        void this.recoverDeliveredReply();
      }
      // The next deadline is the EARLIER of the parent turn's grace and any live
      // sub-agent observation's TTL — so the observer's stalled-child sweep fires
      // even when the parent turn is idle/finalized (the FD-leak TTL guardrail).
      const tNow = this.clock();
      const timeoutSec = minTimeout(
        this.runManager.nextTimeout(tNow),
        this.observer.nextTimeout(tNow),
      );
      const timeoutMs = timeoutSec === null ? null : Math.max(0, timeoutSec * 1000);
      // Arm the wake resolver for THIS race, then check `wakePending`
      // synchronously BEFORE blocking: a wake() delivered during the previous
      // iteration's await (feed/tick/recovery, when the resolver was null) is
      // honored here without blocking, so a deadline armed off-loop (beginTurn)
      // is never missed regardless of interleaving.
      const wakeSignal = new Promise<"wake">((resolve) => {
        this.wakeConsumer = () => resolve("wake");
      });
      if (this.wakePending) {
        this.wakePending = false;
        this.wakeConsumer = null;
        continue;
      }
      const raced = await Promise.race([
        raceWithTimeout(nextFrame, timeoutMs),
        wakeSignal,
      ]);
      this.wakeConsumer = null;
      if (raced === "wake") {
        this.wakePending = false;
        continue; // deadlines changed (beginTurn) — re-evaluate nextTimeout
      }
      const winner = raced;
      const now = this.clock();
      if (winner.kind === "frame") {
        if (winner.done) {
          // Connection closed. If a turn was mid-flight, finalize it as aborted
          // so the UI never stays stuck on a "streaming" message — UNLESS the
          // gateway abandoned the run to COMPACT (a session compaction can
          // recreate the session and drop this socket): the run resumes after
          // the replay, so aborting here freezes a live turn as "Interrompu"
          // (live report 2026-07-04). The reconnect/replay resumes it; the
          // stuck-stream watchdog stays the backstop if it never does.
          if (!this.runManager.isFinalized) {
            if (this.transcriptFetcher) {
              // Unified orphan-turn recovery (gateway restart OR compaction
              // recreated the session and dropped this socket): the gateway's
              // restart-recovery resumes the run and the answer lands in the
              // TRANSCRIPT. Poll it over a fresh connection; settle as
              // connection_lost only when the deadline passes with no reply.
              console.log(
                `[session] close mid-turn — starting transcript recovery chat=${this.chatId} (compactionPending=${this.runManager.compactionPending})`,
              );
              this.scheduleOrphanRecovery();
            } else if (this.runManager.compactionPending) {
              // No fetcher injected (test harness): keep the bounded settle.
              const rm = this.runManager;
              const settleClock = this.clock;
              setTimeout(() => {
                if (!rm.isFinalized) {
                  void rm.endTurn(settleClock(), "error", CONNECTION_LOST_CODE).catch((e) =>
                    console.error(
                      "[session] deferred compaction settle failed:",
                      (e as Error)?.message ?? e,
                    ),
                  );
                }
              }, 120_000).unref?.();
            } else {
              console.log(
                `[session] close mid-turn — force-abort chat=${this.chatId} (no compaction pending)`,
              );
              try {
                await this.runManager.endTurn(now, "error", CONNECTION_LOST_CODE);
              } catch (err) {
                console.error("session close finalize error:", (err as Error)?.message ?? err);
              }
            }
          }
          // Drop every sub-agent observation (status left as last-known): the
          // connection is gone, so no more child frames can arrive — never leak
          // the registry past the session's life. Also drop the registration-ordering
          // set so a reconnect re-orders the first running-row write for each child.
          this.observer.clear();
          this.registeredChildren.clear();
          break;
        }
        nextFrame = iterator.next();
        this.lastActivityAt = now; // active turn (or live child) -> not idle, don't reap
        // Capture the live message BEFORE the feed: the frame that FINALIZES a
        // turn clears currentMessageId inside feed(), and the observer below
        // would then see null for the turn's own final — losing the anchor an
        // announce-spawned child's sighting backfills from (its spawn often
        // lands before the deferred message even opened). ONLY while the turn
        // is actually ACTIVE: after a finished turn the sink still remembers
        // its message, and handing that stale id to the FIRST frame of a NEW
        // deferred run would anchor its spawns to the previous bubble.
        const preFeedMessageId =
          this.runManager.turnActive &&
          this.runManager.frameOwnedByActiveTurn(winner.value)
            ? this.runManager.currentMessageId
            : null;
        try {
          await this.runManager.feed(winner.value, now);
        } catch (err) {
          console.error("session feed error:", (err as Error)?.message ?? err);
        }
        // POST-feed re-evaluation: a legitimately NEW runId admitted DURING
        // feed() (lifecycle_end / compaction adoption windows) was not in
        // ownRunIds when preFeedMessageId was computed. If that first frame
        // is the sessions_spawn result, registering without an anchor is
        // permanent (no spawnRunHint on tool-result registrations). preFeed
        // still wins when set — a turn-FINAL frame deactivates the turn
        // inside feed(), so only the pre-feed view holds its anchor.
        const postFeedMessageId =
          this.runManager.turnActive &&
          this.runManager.frameOwnedByActiveTurn(winner.value)
            ? this.runManager.currentMessageId
            : null;
        const observeAnchor = preFeedMessageId ?? postFeedMessageId;
        // INBOUND-ONLY sub-agent observation, INDEPENDENT of the parent turn's
        // lifecycle (runs even after runManager finalized / its sink went inactive
        // — that's the gap this closes). Errors here never affect the turn.
        try {
          // AWAIT: the initial spawn-registration write is ordered (commits before the
          // next frame / parent finalize) to close the spawn-upsert race; later
          // status/heartbeat writes stay off the critical path. See flushSubAgentObserved.
          await this.flushSubAgentObserved(
            this.observer.observe(
              winner.value,
              now,
              // NO unconditional fallback to currentMessageId here: the
              // anchor is null precisely when this frame does NOT belong to
              // the active turn (a stashed announce) — reading the active
              // turn's message back would re-anchor the announce's spawns to
              // an unrelated reply.
              observeAnchor,
              // CHILD-lane registration fallback (child frames are never
              // owned by the parent turn): the last-known message — the turn
              // that spawned the child, or post-final the settled parent.
              // Null while a deferred announce has not opened its message.
              this.runManager.currentMessageId,
            ),
          );
        } catch (err) {
          console.error("session subagent observe error:", (err as Error)?.message ?? err);
        }
        // Anchor propagation for frames the observer never re-observes (a
        // stashed announce replays INSIDE feed()): hand the turn's run ids +
        // message anchor to the observer's run-correlated backfill. NOT gated
        // on turnActive — a deferred announce whose first visible frame is
        // also terminal opens AND finalizes its message inside feed(), so the
        // anchor only becomes readable once the turn is already inactive
        // (ownRunIds and currentMessageId both persist until the NEXT turn).
        // Correlation stays strict by runId, so a stashed announce's parked
        // spawns can never take another turn's anchor. No-op when nothing is
        // parked for those runs.
        try {
          const anchor = this.runManager.currentMessageId;
          if (anchor !== null) {
            await this.flushSubAgentObserved(
              this.observer.noteRunAnchor(
                this.runManager.activeRunIds,
                anchor,
                now,
              ),
            );
          }
        } catch (err) {
          console.error(
            "session subagent anchor error:",
            (err as Error)?.message ?? err,
          );
        }
      } else {
        // timeout: resolve any expired normalizer deadline (may finalize) AND reap
        // any stalled sub-agent observation (FD-leak TTL guardrail).
        try {
          await this.runManager.tick(now);
        } catch (err) {
          console.error("session tick error:", (err as Error)?.message ?? err);
        }
        // A PURE recv-silence elapsed (the gateway is reasoning silently, socket
        // still alive) — do NOT let the turn close empty. QUERY the gateway for
        // the real status (self-heal): the SAME transcript-recovery machinery used
        // on a socket drop, but triggered by silence. Guarded so the live socket
        // and the poll don't both start it; a late live frame still finalizes
        // normally (recovery stops on isFinalized). No fetcher (tests) -> the
        // normalizer's own finalize path already handled it.
        if (this.runManager.takeRecvSilence() && !this.runManager.isFinalized) {
          if (this.transcriptFetcher) {
            if (this.recoveryEpoch !== this.runManager.turnEpoch) {
              console.log(
                `[session] recv-silence — querying gateway status (self-heal) chat=${this.chatId}`,
              );
              const liveMsgId = this.runManager.currentMessageId;
              if (liveMsgId !== null) {
                // Tools-ON placeholder detail: the bridge is actively asking the
                // gateway whether the silent run is still working.
                this.writer.setPhase?.(liveMsgId, "querying_gateway");
              }
              this.scheduleOrphanRecovery("recv_silence");
            }
          } else {
            // No fetcher (test harness / degraded deploy): the self-heal query is
            // unavailable, so keep the LIVENESS guarantee the old way — settle the
            // turn rather than hang it open forever.
            await this.runManager
              .endTurn(now, "final", null, "recv_timeout")
              .catch((e) =>
                console.error(
                  "[session] recv-silence settle failed:",
                  (e as Error)?.message ?? e,
                ),
              );
          }
        }
        try {
          // The TTL sweep returns visible terminal upserts for silently-hung
          // sub-agents (Bug C). Route them through the SAME observed-flush helper (not a
          // bare fire-and-forget) so a TTL-terminalized child's key is removed from
          // registeredChildren — else a swept child leaks its key forever (it never hits
          // the per-frame cleanup branch). Sweep emits only terminal records, so this
          // awaits nothing (no registration write) — it just cleans up + fires the writes.
          await this.flushSubAgentObserved(this.observer.sweep(now));
        } catch (err) {
          console.error("session subagent sweep error:", (err as Error)?.message ?? err);
        }
      }
    }
  }

  /**
   * Orphan-turn recovery: the socket died mid-turn (gateway restart /
   * compaction session-recreate) but the gateway RESUMES the run and its
   * answer lands in the session transcript (main-session-restart-recovery,
   * live CSV 2026-07-04). Poll `sessions.get` over a fresh connection until
   * the resumed assistant reply appears, then finalize the turn COMPLETE with
   * the real text. Bounded well under the Convex stuck-stream watchdog; on
   * deadline the turn settles as connection_lost. A user Stop meanwhile wins:
   * Convex finalize is first-terminal-wins, so a late recovery write is a
   * no-op there (and isFinalized stops the poll bridge-side).
   */
  private scheduleOrphanRecovery(
    reason: "socket_drop" | "recv_silence" = "socket_drop",
  ): void {
    const rm = this.runManager;
    const fetcher = this.transcriptFetcher;
    if (!fetcher) return;
    // Bind this recovery to the CURRENT turn: if the live socket finalizes it and
    // a NEW turn begins before the next poll wakes, the epoch mismatch kills the
    // stale poll instead of letting it settle/recover the wrong turn (codex P1).
    // Per-EPOCH claim (not a global boolean): the same turn never double-polls,
    // while a NEWER turn can always start its own recovery.
    const boundEpoch = rm.turnEpoch;
    if (this.recoveryEpoch === boundEpoch) {
      // Same-turn re-entry: a socket_drop SUPERSEDES a running recv_silence
      // (fresh 9-min budget + connection_lost class + the stale-transcript
      // baseline gate — the gateway may be REBOOTING now; codex R8 P2). Any
      // other combination is already covered by the active poll.
      if (!(reason === "socket_drop" && this.recoveryReason === "recv_silence")) {
        return;
      }
    }
    this.recoveryEpoch = boundEpoch;
    this.recoveryReason = reason;
    const boundGen = ++this.recoveryGen;
    const chatId = this.chatId;
    const sessionKey = this.sessionKey;
    const clock = this.clock;
    let polls = 0;
    const startedWallMs = Date.now();
    // Structural baseline for ANCHOR-LESS turns (attachment-only sends, or a
    // trivial anchor like "ok" that any old transcript would contain): a
    // resumed run always GROWS the transcript; a stale one never does. Set on
    // the first successful poll, so acceptance requires growth beyond it.
    // DELIBERATE trade-off (correctness > completeness): if the resumed reply
    // is ALREADY complete at the first poll, an anchor-less turn cannot
    // distinguish it from the previous turn's reply — that residual case (an
    // attachment-only turn finishing within the first ~20s after the drop)
    // settles honestly as connection_lost instead of risking delivering the
    // WRONG turn's answer into the conversation.
    let baselineCount: number | null = null;
    // recv_silence acceptance gate: the run is ALIVE, so sessions.get can show a
    // reply STILL BEING WRITTEN — accepting it would truncate the answer (codex
    // R12 P2). Require the extracted reply to be IDENTICAL on two consecutive
    // polls (a finished reply is stable across 20s; a streaming one grows).
    let lastSeenReply: string | null = null;
    const tick = async (): Promise<void> => {
      if (this.recoveryGen !== boundGen) {
        return; // superseded by a newer recovery (do NOT touch its claim)
      }
      if (rm.turnEpoch !== boundEpoch) {
        // A NEWER turn is running — this recovery belongs to a finished one.
        // Only release the claim if a newer recovery hasn't already re-claimed it.
        if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
        return;
      }
      if (rm.isFinalized) {
        // The live socket delivered the real result first — nothing to recover.
        if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
        return;
      }
      if (reason === "recv_silence" && rm.recvDeadlineArmed) {
        // The live stream RESUMED (own frames re-armed the recv deadline): the
        // turn is healthy again — cancel this recovery instead of racing it
        // (its wall could truncate a long in-flight reply as response_timeout;
        // codex P1). A NEW silence elapse re-raises the signal and a fresh
        // recovery re-claims the epoch (released here).
        if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
        return;
      }
      polls++;
      const maxPolls =
        reason === "recv_silence"
          ? SILENCE_RECOVERY_MAX_POLLS
          : ORPHAN_RECOVERY_MAX_POLLS;
      const wallMs =
        reason === "recv_silence"
          ? SILENCE_RECOVERY_WALL_MS
          : ORPHAN_RECOVERY_WALL_MS;
      if (polls > maxPolls || Date.now() - startedWallMs >= wallMs) {
        const settleCode =
          reason === "recv_silence"
            ? RESPONSE_TIMEOUT_CODE
            : CONNECTION_LOST_CODE;
        console.log(
          `[session] transcript recovery deadline — settling ${settleCode} chat=${chatId}`,
        );
        await rm
          .endTurn(clock(), "error", settleCode, settleCode)
          .catch((e) =>
            console.error(
              "[session] orphan settle failed:",
              (e as Error)?.message ?? e,
            ),
          );
        if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
        return;
      }
      try {
        const payload = await fetcher(sessionKey);
        // The fetch AWAIT is long: the live socket may have finalized this turn
        // AND a new turn may have begun meanwhile. Re-validate BEFORE any
        // acceptance/recovery so a stale poll can never touch the new turn
        // (codex P1 — anchor-less turns would otherwise pass the checks below).
        if (rm.turnEpoch !== boundEpoch || rm.isFinalized) {
          if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
          return;
        }
        if (reason === "recv_silence" && rm.recvDeadlineArmed) {
          // The live stream resumed WHILE we were fetching — same cancel as the
          // pre-fetch check, or a partial transcript could finalize a turn that
          // is actively streaming again (codex R9 P2).
          if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
          return;
        }
        // STALE-transcript guard: mid-reboot the gateway can serve a transcript
        // that predates the current turn; its last user entry is then the
        // PREVIOUS turn's. Only accept a transcript anchored to the message
        // this turn actually sent (codex P2). No anchor (no send through this
        // session) -> accept as before.
        // Boundary validation — NEVER finalize the previous turn's reply as
        // the current answer (codex P2 x2). A >=12-char anchor validates by
        // containment; an absent/trivial anchor falls back to the structural
        // baseline (the transcript must have GROWN since the first poll).
        const anchor =
          this.turnUserAnchor &&
          this.turnUserAnchor.length >= 12 &&
          this.turnUserAnchorEpoch === boundEpoch
            ? this.turnUserAnchor
            : null;
        if (anchor) {
          if (!lastUserEntryText(payload).includes(anchor)) {
            setTimeout(() => void tick(), ORPHAN_RECOVERY_POLL_MS).unref?.();
            return;
          }
        } else {
          // ANCHOR-LESS turns (attachment-only / <12-char text): require transcript
          // GROWTH before acceptance — for EVERY reason. Deliberate trade-off
          // (codex R5 vs R6): skipping this gate on recv_silence could accept a
          // lagging pre-turn snapshot and deliver the PREVIOUS turn's reply as the
          // current answer (content corruption). The residual cost of keeping it —
          // an anchor-less turn whose reply was already complete at the first poll
          // settles response_timeout instead of recovering — is the same honest
          // trade-off the socket-drop path already documents above.
          const count = transcriptEntryCount(payload);
          if (baselineCount === null || count <= baselineCount) {
            if (baselineCount === null) baselineCount = count;
            setTimeout(() => void tick(), ORPHAN_RECOVERY_POLL_MS).unref?.();
            return;
          }
        }
        // A resumed run may have delivered its REAL answer through the gateway
        // message-tool (the assistant entry is then only a private ack like
        // "Envoyé dans le webchat.") — prefer that delivery; fall back to the
        // plain assistant reply (codex P2). Both scan only the current turn
        // (backwards to the latest user entry).
        const text =
          extractMessageToolReplies(payload) ||
          extractLatestAssistantReply(payload);
        if (text && reason === "recv_silence" && text !== lastSeenReply) {
          // First sighting (or still growing): remember and re-poll — only a
          // reply UNCHANGED across two polls is proven finished.
          lastSeenReply = text;
          setTimeout(() => void tick(), ORPHAN_RECOVERY_POLL_MS).unref?.();
          return;
        }
        if (text && !rm.isFinalized) {
          console.log(
            `[session] transcript recovery SUCCESS chat=${chatId} (${text.length} chars after ${polls} polls)`,
          );
          await rm.recoverVisibleText(text, clock());
          if (this.recoveryEpoch === boundEpoch) this.recoveryEpoch = null;
          return;
        }
      } catch (err) {
        // Gateway may still be rebooting — keep polling until the deadline.
        console.log(
          `[session] transcript recovery poll failed (retrying): ${(err as Error)?.message ?? err}`,
        );
      }
      setTimeout(() => void tick(), ORPHAN_RECOVERY_POLL_MS).unref?.();
    };
    setTimeout(() => void tick(), ORPHAN_RECOVERY_POLL_MS).unref?.();
  }

  private async recoverDeliveredReply(): Promise<void> {
    try {
      const raw = await this.connection.request(
        "sessions.get",
        { key: this.sessionKey },
        10_000,
      );
      const payload =
        raw && typeof raw === "object" && "payload" in raw
          ? (raw as { payload: unknown }).payload
          : raw;
      const text = extractMessageToolReplies(payload);
      if (text) {
        await this.runManager.recoverVisibleText(text, this.clock());
        console.log(
          `[recovery] message-tool reply recovered (${text.length} chars) chat=${this.chatId}`,
        );
      } else {
        console.log(`[recovery] no recoverable delivery found chat=${this.chatId}`);
      }
    } catch (err) {
      // Non-fatal: the private-ack grace will flush best-effort content.
      console.error("[recovery] sessions.get failed:", (err as Error)?.message ?? err);
    }
  }

  close(): void {
    this.connection.close();
  }
}

type RaceResult<T> =
  | { kind: "frame"; done: false; value: T }
  | { kind: "frame"; done: true; value: undefined }
  | { kind: "timeout" };

/**
 * Await the pending iterator read, but give up after `timeoutMs` (null = wait
 * forever). On timeout the original `nextFrame` promise is left pending so the
 * next iteration re-awaits it — no frame is dropped.
 */
/** The earlier of two seconds-until-deadline values (null = no deadline on that
 *  side). Used to combine the parent turn's grace with the sub-agent observer TTL. */
export function minTimeout(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function raceWithTimeout<T>(
  nextFrame: Promise<IteratorResult<T>>,
  timeoutMs: number | null,
): Promise<RaceResult<T>> {
  const framePromise = nextFrame.then(
    (r): RaceResult<T> =>
      r.done
        ? { kind: "frame", done: true, value: undefined }
        : { kind: "frame", done: false, value: r.value },
  );
  if (timeoutMs === null) {
    return framePromise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RaceResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  // Cancel the timer the moment EITHER side settles. When a frame wins the race
  // (the common case during active streaming, called once per frame), an
  // un-cleared setTimeout stays armed for the full timeoutMs — thousands of live
  // timers would pile up over a long response. clearTimeout on the timeout-wins
  // path is a harmless no-op.
  return Promise.race([framePromise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

// Idle-session sweeper cadence + TTL. Each chat holds its own WebSocket (an open
// FD) for the lifetime of its Session, and an idle gateway socket stays open
// indefinitely (the gateway drives keepalive). Without reaping, EVERY chat ever
// sent-to leaks one socket/FD -> eventual EMFILE/ENFILE -> the bridge can open
// nothing (gateway, Convex, HTTP) -> ALL chats down, restart required (the prod
// "bridge falls + new chats readonly" failure). The sweeper closes + drops a
// session idle beyond the TTL, and reaps closed husks; the next send reconnects.
const SWEEP_INTERVAL_MS = 60_000; // setInterval unit = milliseconds
// TTL is compared against the module Clock, which is in SECONDS (Date.now()/1000),
// so it MUST be expressed in seconds too. A milliseconds value here would push the
// reap horizon to ~10 days and silently defeat the FD-leak fix.
export const IDLE_SESSION_TTL_SECONDS = 15 * 60;

/**
 * Owns the live sessions. `acquire` returns the session for a chat, creating
 * (and connecting) it on first use. Routing uses `openclawChatId` to build the
 * gateway session key; when absent we fall back to the Convex chatId.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<string, Promise<Session>>();
  // RECENT session keys per chat (bounded history): the sessions map keeps
  // ONE entry per chat, so an agent/instance re-key drops the previous key
  // instantly — but a background chain started on it can still produce
  // invisible links for a while, and the task discovery must keep matching
  // that registry session. Cap 4 keys / 30 min TTL per chat.
  private readonly recentChatKeys = new Map<
    string,
    { key: string; at: number }[]
  >();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    // The instances this bridge serves, keyed by instanceName. Each bundle carries
    // its own gateway config + writer + media — `acquire` picks the bundle for the
    // turn's routed instance (one bridge, N gateways).
    private readonly served: Map<string, InstanceBundle>,
    private readonly clock: Clock = defaultClock,
    // Health-stats hook wired by boot (index.ts): a turn finalizing in error is
    // reported against its target (full identity — recordTurnError may have to
    // CREATE the row when the error beats the send's recordOk) so the admin
    // Connections stats count turn-level failures, not just send transport.
    private readonly onTurnError?: (
      target: {
        instanceName: string;
        canonical: string;
        agentId: string;
        gatewayHost: string;
      },
      code: string,
    ) => void,
  ) {}

  /** The bundle serving `instanceName`, or undefined when this bridge does not serve
   *  it (the server's membership guard rejects before acquire is reached). */
  getBundle(instanceName: string): InstanceBundle | undefined {
    return this.served.get(instanceName);
  }

  /** Register a newly-resolved instance at RUNTIME (boot self-heal). Mutates the SAME
   *  served map the HTTP server holds, so the instance becomes routable immediately —
   *  no restart. Callers check membership/collision before building the bundle. */
  register(instanceName: string, bundle: InstanceBundle): void {
    this.served.set(instanceName, bundle);
  }

  /** Start the idle-session sweeper on first use (lazy, so pure-helper tests that
   *  never acquire don't spin a timer). The interval is unref'd — it never keeps
   *  the process alive — and is cleared by closeAll. */
  private ensureSweeper(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.reapStaleSessions(this.clock()), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  /** Close + drop sessions that are already closed (husks) or idle beyond the TTL.
   *  Returns the number reaped. Pure over `now` -> unit-testable with a fake clock. */
  reapStaleSessions(now: number): number {
    let reaped = 0;
    for (const [chatId, session] of this.sessions) {
      const dead = session.connection.isClosed;
      const idle = now - session.lastActivityAt > IDLE_SESSION_TTL_SECONDS;
      if (dead || idle) {
        if (!dead) {
          try {
            session.close();
          } catch {
            /* already gone */
          }
        }
        this.sessions.delete(chatId);
        reaped++;
      }
    }
    return reaped;
  }

  /** The Convex writer for an instance (read seam for session re-hydration in
   *  performSend). Undefined when the instance is not served. */
  getWriter(instanceName: string): ConvexWriter | undefined {
    return this.served.get(instanceName)?.writer;
  }

  async acquire(routing: SessionRouting): Promise<BridgeSession> {
    this.ensureSweeper();
    const { chatId, openclawChatId, agentId, canonical } = routing;
    // The session key is derived from THIS turn's routed agent + canonical, so a
    // rebind (deleted agent → default = new agentId, or a changed canonical)
    // yields a DIFFERENT key. We keep at most one live connection per chatId; if
    // the key changed we must close the stale one (else its consumer loop keeps
    // writing to the same chat under the old agent → leak + cross-write).
    const sessionKey = buildSessionKey(openclawChatId ?? chatId, agentId, canonical);
    // The routed instance is ALSO part of a session's identity (one bridge, N
    // gateways): a chat whose routed instance changes (a chat with no stored
    // instanceName re-resolves per turn, and two gateways can expose the SAME agent
    // ids → identical sessionKey) must NOT reuse the cached session bound to the OLD
    // gateway's connection. Re-key on an instance change so create() picks the right
    // bundle. (Sole-instance fallback mirrors create().)
    const effectiveInstance =
      routing.instanceName ??
      (this.served.size === 1 ? [...this.served.keys()][0] : undefined);
    const matches = (s: Session): boolean =>
      s.sessionKey === sessionKey && s.instanceName === effectiveInstance;

    const existing = this.sessions.get(chatId);
    if (existing && !existing.connection.isClosed && matches(existing)) {
      existing.lastActivityAt = this.clock(); // a send keeps it warm (not idle)
      return existing;
    }
    // A closed, missing, OR re-keyed (incl. re-routed) session: drop (closing if
    // still open) and (re)connect, deduping concurrent acquisitions for the same chat.
    if (existing) {
      if (!existing.connection.isClosed) existing.close();
      this.sessions.delete(chatId);
    }
    const pending = this.inflight.get(chatId);
    if (pending) {
      // Honor an in-flight create only if it targets the SAME key + instance;
      // otherwise wait for it to settle, then recurse so the re-key is applied.
      return pending.then((s) =>
        matches(s) ? s : this.acquire(routing),
      );
    }
    const promise = this.create(chatId, sessionKey, routing).finally(() => {
      this.inflight.delete(chatId);
    });
    this.inflight.set(chatId, promise);
    return promise;
  }

  private async create(
    chatId: string,
    sessionKey: string,
    routing: SessionRouting,
  ): Promise<Session> {
    // Pick the bundle for THIS turn's routed instance (selects the gateway + creds +
    // writer + outbound scan). The server's membership guard ran first, so the bundle
    // is present; we still throw a clear error if not (never connect with the wrong
    // instance's config). Credentials were RESOLVED AT BOOT from Convex and are
    // non-null by construction (a secret with missing creds is skipped at boot).
    const bundle =
      (routing.instanceName
        ? this.served.get(routing.instanceName)
        : undefined) ??
      (this.served.size === 1 ? [...this.served.values()][0] : undefined);
    if (!bundle) {
      throw new Error(
        `instance not served: ${routing.instanceName ?? "(unspecified)"}`,
      );
    }
    const instanceName =
      routing.instanceName ?? bundle.config.instanceName ?? "";
    const connection = await OpenClawConnection.connect(
      bundle.config.openclawGatewayUrl,
      bundle.config.openclawToken!,
      bundle.config.deviceIdentity!,
    );
    // Transcript fetcher for orphan-turn recovery: a SHORT dedicated
    // connection per poll (the session's own socket is dead when recovery
    // runs; the gateway may be mid-reboot — connect errors are the caller's
    // retry signal).
    const cfg = bundle.config;
    const transcriptFetcher: TranscriptFetcher = async (key) => {
      const conn = await OpenClawConnection.connect(
        cfg.openclawGatewayUrl,
        cfg.openclawToken!,
        cfg.deviceIdentity!,
      );
      try {
        const raw = await conn.request("sessions.get", { key }, 10_000);
        // request() resolves the response ENVELOPE; the transcript is .payload
        // (same unwrap as recoverDeliveredReply).
        return raw && typeof raw === "object" && "payload" in raw
          ? (raw as { payload: unknown }).payload
          : raw;
      } finally {
        conn.close();
      }
    };
    const onTurnError = this.onTurnError;
    const session = new Session(
      chatId,
      sessionKey,
      {
        agentId: routing.agentId,
        canonical: routing.canonical,
        instanceName,
      },
      connection,
      bundle.writer,
      this.clock,
      bundle.outboundScan,
      transcriptFetcher,
      // Bind the session's own target identity once — the sink only supplies
      // the failure code. Full identity (incl. host) so the health row can be
      // ensured even when the error beats the send's recordOk (codex P2).
      onTurnError
        ? (code) =>
            onTurnError(
              {
                instanceName,
                canonical: routing.canonical,
                agentId: routing.agentId,
                gatewayHost: gatewayHostOf(cfg.openclawGatewayUrl),
              },
              code,
            )
        : undefined,
    );
    session.startConsumer();
    this.sessions.set(chatId, session);
    {
      const hist = this.recentChatKeys.get(chatId) ?? [];
      if (!hist.some((h) => h.key === session.sessionKey)) {
        hist.push({ key: session.sessionKey, at: this.clock() });
        if (hist.length > 4) hist.shift();
      }
      this.recentChatKeys.set(chatId, hist);
    }
    return session;
  }

  /**
   * Snapshot the routed identity + handshake-captured gateway version of every
   * LIVE (non-closed) session, for `/health` and `/capabilities`. Non-secret.
   */
  listLive(): LiveTarget[] {
    const out: LiveTarget[] = [];
    for (const session of this.sessions.values()) {
      if (session.connection.isClosed) continue;
      out.push({
        canonical: session.canonical,
        agentId: session.agentId,
        instanceName: session.instanceName,
        gatewayVersion: session.connection.gatewayVersion,
        maxPayload: session.connection.maxPayload,
      });
    }
    return out;
  }

  /** The LIVE session keys currently bound to a chat (any instance). The
   *  task-discovery probe matches them against the gateway registry's
   *  requesterSessionKey (measured live: it IS the requesting session's
   *  exact key) to find background tasks this chat started — including the
   *  chain links whose ack the gateway never surfaced as a tool frame. */
  sessionKeysForChat(chatId: string): string[] {
    const keys = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.chatId === chatId && !session.connection.isClosed) {
        keys.add(session.sessionKey);
      }
    }
    // RECENT keys too (see recentChatKeys): a chain started before an
    // agent/instance re-key keeps producing invisible links on the OLD
    // session for a while — drop entries past the TTL as we read.
    const hist = this.recentChatKeys.get(chatId);
    if (hist !== undefined) {
      const cutoff = this.clock() - 30 * 60;
      const fresh = hist.filter((h) => h.at >= cutoff);
      if (fresh.length !== hist.length) {
        this.recentChatKeys.set(chatId, fresh);
      }
      for (const h of fresh) keys.add(h.key);
    }
    return [...keys];
  }

  /** Cleanly close every live session (graceful shutdown). */
  closeAll(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}
