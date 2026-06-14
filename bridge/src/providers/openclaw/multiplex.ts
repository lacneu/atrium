// SessionMultiplexer — the OpenClaw-specific core of Model A (one operator
// WebSocket per instance, MANY conversations multiplexed by sessionKey). It owns
// one Normalizer PER active session and fans each inbound gateway frame to the
// right one by `payload.sessionKey`. See docs/OPENCLAW_CONNECTION_MODEL.md
// (Model A) + docs/BRIDGE_ARCHITECTURE.md §2.3.
//
// 🔒 ISOLATION (load-bearing, see OPENCLAW_CONNECTION_MODEL.md §Q4): the Gateway
// gates session content by the operator.read SCOPE, NOT by user identity — one
// operator socket sees ALL sessions on the gateway. THIS multiplexer (its
// sessionKey routing) + the Normalizer's own sessionKey gate are the per-user
// isolation boundary: a frame tagged sessionKey X is fed ONLY to session X's
// normalizer, which only emits for chat X. A routing bug here = a cross-user PHI
// leak, so isolation is double-layered (route by sessionKey AND the normalizer
// re-checks its own sessionKey) and is unit-tested.
//
// This unit holds the testable LOGIC (routing, min-deadline, tick, isolation,
// the per-sessionKey verbose guard). The adapter wraps it with the real
// connection + the single-pending-read consume loop + the BridgeProvider.on()
// emit. Keeping it pure (no I/O) is what lets the isolation guarantee be proven
// offline.

import { Normalizer } from "./normalizer.js";
import type { BridgeEvent } from "../../core/events.js";

/** Events emitted by one session during a feed/tick, tagged with the chat they belong to. */
export interface SessionEmit {
  chatId: string;
  events: BridgeEvent[];
}

interface ChatTurn {
  normalizer: Normalizer;
  chatId: string;
}

export class SessionMultiplexer {
  private readonly turns = new Map<string, ChatTurn>();
  // fix #7: verboseLevel=full is patched PER sessionKey, never once per socket —
  // under one-connection-many-sessions a per-connection flag would let chat A's
  // patch suppress chat B's (sessions.patch takes a per-session key).
  private readonly verboseApplied = new Set<string>();

  /** Number of sessions with an active (un-finalized) turn. */
  get activeCount(): number {
    return this.turns.size;
  }

  /** Whether `verboseLevel=full` still needs patching for this sessionKey. */
  needsVerbose(sessionKey: string): boolean {
    return !this.verboseApplied.has(sessionKey);
  }

  /** Record that `verboseLevel=full` has been patched for this sessionKey. */
  markVerbose(sessionKey: string): void {
    this.verboseApplied.add(sessionKey);
  }

  /**
   * Begin a turn for a sessionKey: create + seed its Normalizer (ownRunIds from
   * the chat.send ack runId, for foreign-run isolation). Replaces any prior turn
   * on the same sessionKey (a new send supersedes a stale one).
   */
  beginSession(
    sessionKey: string,
    chatId: string,
    ackRunId: string | null,
    now: number,
  ): void {
    const normalizer = new Normalizer(sessionKey);
    normalizer.beginTurn(now);
    if (ackRunId) {
      normalizer.noteRunStarted(ackRunId, now);
    }
    this.turns.set(sessionKey, { normalizer, chatId });
  }

  /**
   * Route one inbound frame to its session's Normalizer by `payload.sessionKey`.
   * A frame for an unregistered session is DROPPED (returns []), which is the
   * outer isolation layer; the Normalizer's own sessionKey gate is the inner one.
   * Removes the session if the frame finalized it.
   */
  feedFrame(frame: unknown, now: number): SessionEmit[] {
    const sessionKey = frameSessionKey(frame);
    if (sessionKey === null) {
      return [];
    }
    const turn = this.turns.get(sessionKey);
    if (!turn) {
      return []; // no active turn for this session -> drop (isolation)
    }
    const events = turn.normalizer.feed(frame, now);
    this.reapIfFinalized(sessionKey, turn);
    return events.length ? [{ chatId: turn.chatId, events }] : [];
  }

  /** Minimum seconds-until-deadline across all active turns (null = none armed). */
  minTimeout(now: number): number | null {
    let min: number | null = null;
    for (const { normalizer } of this.turns.values()) {
      const t = normalizer.nextTimeout(now);
      if (t !== null && (min === null || t < min)) {
        min = t;
      }
    }
    return min;
  }

  /**
   * Tick every turn whose deadline has expired at `now`, finalizing the ones
   * whose grace elapsed. Returns the events per chat, and reaps finalized turns.
   */
  tickExpired(now: number): SessionEmit[] {
    const out: SessionEmit[] = [];
    for (const [sessionKey, turn] of this.turns) {
      const t = turn.normalizer.nextTimeout(now);
      if (t !== null && t <= 0) {
        const events = turn.normalizer.tick(now);
        if (events.length) {
          out.push({ chatId: turn.chatId, events });
        }
      }
      this.reapIfFinalized(sessionKey, turn);
    }
    return out;
  }

  /**
   * Force-finalize one session (e.g. abort, or socket close mid-turn). Emits the
   * normalizer's terminal pair and reaps the session. Returns null if unknown.
   */
  endSession(sessionKey: string, now: number, status = "aborted"): SessionEmit | null {
    const turn = this.turns.get(sessionKey);
    if (!turn) {
      return null;
    }
    const events = turn.normalizer.endTurn(now, status, null);
    this.turns.delete(sessionKey);
    this.verboseApplied.delete(sessionKey);
    return { chatId: turn.chatId, events };
  }

  /** Force-finalize EVERY active session (graceful shutdown / connection close). */
  endAll(now: number, status = "aborted"): SessionEmit[] {
    const out: SessionEmit[] = [];
    for (const sessionKey of [...this.turns.keys()]) {
      const emit = this.endSession(sessionKey, now, status);
      if (emit) out.push(emit);
    }
    return out;
  }

  private reapIfFinalized(sessionKey: string, turn: ChatTurn): void {
    if (turn.normalizer.finalized) {
      this.turns.delete(sessionKey);
      this.verboseApplied.delete(sessionKey);
    }
  }
}

/** Extract `payload.sessionKey` from a raw gateway frame, or null if absent. */
function frameSessionKey(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) {
    return null;
  }
  const payload = (frame as Record<string, unknown>).payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const sk = (payload as Record<string, unknown>).sessionKey;
  return typeof sk === "string" ? sk : null;
}
