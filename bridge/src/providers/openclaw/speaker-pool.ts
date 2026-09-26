// SPEAKER SOCKETS — a group conversation's PARTICIPANT sending a turn as themselves.
//
// In trusted-proxy mode a conversation's socket acts for its OWNER: it claims the
// gateway session for them (claimSessionForOwner) and consumes every frame of the
// conversation. When an instance lets participants speak in their own name
// (`instances.participantIdentity === "self"`), a participant's `chat.send` must
// leave on a socket that is THEIRS, so the gateway records them as the author.
//
// WHAT WAS MEASURED (live, OpenClaw 2026.9.6, trusted-proxy, no gateway.roles —
// openclaw-notes/atrium/bench-runs/participant-identity-2026-09-25):
//   - bob's chat.send into the session alice created is ACCEPTED, and the
//     transcript names bob as its sender; alice stays creator and owner;
//   - every frame of bob's run reaches BOTH sockets — EXCEPT `agent` frames of the
//     `tool` stream, which upstream sends only to the socket that called chat.send
//     (upstream server-chat.ts `toolEventRecipients`);
//   - alice's socket can abort bob's run (same device).
//
// HENCE THE SHAPE. The owner's socket stays the ONE consumer of the conversation —
// its normalizer, holds and recovery are untouched. The speaker socket SENDS, and
// carries the participant's run IN FULL: every frame of that run is forwarded from
// the speaker socket (one socket, one order), and the owner's socket drops its own
// native copies of it (OpenClawConnection.carryRunElsewhere). Forwarding only the
// tool frames the owner's socket lacks would interleave two sockets with no order
// between them — a tool result could land after the run's terminal, on a turn
// already closed (codex pass 7).
//
// THE ROUTE PRECEDES THE SEND. A chat.send's runId IS its idempotencyKey (upstream
// chat-send-session.ts `clientRunId = p.idempotencyKey`, echoed by the ack in
// chat-send-admission.ts), so the route is installed before the request leaves —
// no frame of the run can arrive before its route.
//
// One speaker socket per (instance, person), shared by every conversation that
// person speaks in: the forward is keyed by runId, not by chat.
//
// A LOSS ON THE SPEAKER SOCKET IS THE OWNER'S LOSS. While a run is carried, the
// owner's socket drops its native copies, so what the speaker socket misses — a
// hole in its own sequence, or its end mid-run — reaches the consumer from nowhere.
// Its runs are then handed back to the owner's socket (from here on its native
// copies flow again) and the owner's own loss path is told (`onFrameGap`), exactly
// as if the hole had been in its own sequence.

import { eventRunId, type GatewayFrame, type OpenClawConnection } from "./openclaw-client.js";
import type { SeqGap } from "./frame-seq.js";

/** A run started from a speaker socket, and the owner socket its frames go to. */
interface RunRoute {
  target: OpenClawConnection;
  at: number;
  /** The run's terminal was forwarded; the route is being released. */
  ending?: boolean;
}

interface Speaker {
  conn: OpenClawConnection;
  routes: Map<string, RunRoute>;
  lastUsedAt: number;
  /** A hole the client reported, waiting for the frame that revealed it. */
  pendingGap?: SeqGap;
}

/** How long a run's route is kept: well past any single turn. */
export const SPEAKER_ROUTE_TTL_MS = 60 * 60 * 1000;
/** How long a route outlives its run's terminal frame. */
export const SPEAKER_TERMINAL_GRACE_MS = 10_000;

/** A run's END on the wire: a `chat` event in a terminal state. */
function isRunTerminal(frame: GatewayFrame): boolean {
  if (frame.type !== "event" || frame.event !== "chat") return false;
  const state = (frame.payload as { state?: unknown } | undefined)?.state;
  return state === "final" || state === "aborted" || state === "error";
}

/** The speaker socket ended with runs in flight: nothing counted, only the fact. */
const SPEAKER_CLOSED: SeqGap = {
  missing: 0,
  expected: 0,
  received: 0,
  carriedBy: "speaker_closed",
};

/** A speaker socket nobody used for this long is closed. */
export const SPEAKER_IDLE_MS = 15 * 60 * 1000;

/**
 * Is this frame one only the SENDING socket receives — a tool-stream `agent`
 * event? Pure; exported for tests (and for the measured fact it states).
 */
export function speakerOnlyRunId(frame: GatewayFrame): string | null {
  if (frame.type !== "event" || frame.event !== "agent") return null;
  const payload = frame.payload as { stream?: unknown; runId?: unknown } | undefined;
  if (payload?.stream !== "tool") return null;
  return typeof payload.runId === "string" && payload.runId.length > 0
    ? payload.runId
    : null;
}

type Carrying = OpenClawConnection & {
  carryRunElsewhere?: (runId: string) => void;
  releaseRun?: (runId: string) => void;
};

export class SpeakerPool {
  private readonly speakers = new Map<string, Speaker>();
  private readonly opening = new Map<string, Promise<Speaker>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * The speaker socket for `key` (instance + person), opened with `open` when
   * there is none or the previous one closed. Concurrent callers share one open.
   */
  async acquire(
    key: string,
    open: () => Promise<OpenClawConnection>,
  ): Promise<OpenClawConnection> {
    this.ensureSweeper();
    const live = this.speakers.get(key);
    if (live && !live.conn.isClosed) {
      live.lastUsedAt = this.clock();
      return live.conn;
    }
    if (live) this.speakers.delete(key);
    const pending = this.opening.get(key);
    if (pending) {
      // A shared open can hand back a socket that closed meanwhile: open again.
      const shared = (await pending).conn;
      return shared.isClosed ? this.acquire(key, open) : shared;
    }
    const promise = (async () => {
      const conn = await open();
      const speaker: Speaker = { conn, routes: new Map(), lastUsedAt: this.clock() };
      // NOTED, not acted on at once: the client reports a hole BEFORE it queues the
      // frame that revealed it, and that frame may be a tool frame only this
      // socket receives. The runs are handed back once the reader has delivered it
      // (consume), never ahead of it.
      conn.onFrameGap = (gap) => {
        speaker.pendingGap = { ...gap, carriedBy: "speaker_gap" };
      };
      this.speakers.set(key, speaker);
      void this.consume(key, speaker);
      return speaker;
    })().finally(() => this.opening.delete(key));
    this.opening.set(key, promise);
    return (await promise).conn;
  }

  /**
   * Carry `runId`, about to be started on the speaker socket `speakerConn`, to the
   * owner socket `target`: from now on its frames reach `target` from the speaker
   * socket only. Called BEFORE the chat.send that starts it.
   */
  route(speakerConn: OpenClawConnection, runId: string, target: OpenClawConnection): boolean {
    // Only onto a socket still held AND open: one that closed since it was acquired
    // (while the owner's hold was being re-proven) is already out of the pool, and
    // a send on it could only fail — the caller sends from the owner's socket.
    if (speakerConn.isClosed) return false;
    for (const speaker of this.speakers.values()) {
      if (speaker.conn !== speakerConn) continue;
      speaker.routes.set(runId, { target, at: this.clock() });
      speaker.lastUsedAt = this.clock();
      (target as Carrying).carryRunElsewhere?.(runId);
      return true;
    }
    return false;
  }

  /** Undo `route` — the send did not start the run (refused, failed). */
  unroute(speakerConn: OpenClawConnection, runId: string): void {
    for (const speaker of this.speakers.values()) {
      if (speaker.conn !== speakerConn) continue;
      this.dropRoute(speaker, runId);
      return;
    }
  }

  /**
   * The send that was to start `runId` got NO answer — the speaker socket closed or
   * the request timed out: the run may have started, and the owner's socket has
   * been dropping its native copies meanwhile. Hand it back WITH the loss signal
   * (`speaker_closed`), never silently: `unroute` is for a send the gateway refused.
   * A no-op when the socket's own close already handed it back — one signal, not two.
   */
  abandon(speakerConn: OpenClawConnection, runId: string): void {
    for (const speaker of this.speakers.values()) {
      if (speaker.conn !== speakerConn) continue;
      const route = speaker.routes.get(runId);
      if (route === undefined) return;
      this.dropRoute(speaker, runId);
      this.reportLoss(route.target, SPEAKER_CLOSED);
      return;
    }
  }

  /** Close every speaker socket (bridge shutdown). */
  closeAll(): void {
    for (const speaker of this.speakers.values()) {
      for (const runId of [...speaker.routes.keys()]) this.dropRoute(speaker, runId);
      speaker.conn.close();
    }
    this.speakers.clear();
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  /** Test seam: how many speaker sockets are held. */
  get size(): number {
    return this.speakers.size;
  }

  /**
   * The speaker socket lost frames (or ended) while carrying runs: hand every run
   * back to its owner socket and report the loss there, once per owner socket. A
   * sequence hole names no run, so every run it carried may be the one missing a
   * piece. Nothing to report when it carried none.
   */
  private handBack(speaker: Speaker, gap: SeqGap): void {
    const targets = new Set<OpenClawConnection>();
    for (const [runId, route] of [...speaker.routes]) {
      targets.add(route.target);
      this.dropRoute(speaker, runId);
    }
    for (const target of targets) this.reportLoss(target, gap);
  }

  private reportLoss(target: OpenClawConnection, gap: SeqGap): void {
    if (target.isClosed) return;
    try {
      target.onFrameGap?.(gap);
    } catch {
      /* a loss report must never break the speaker's receive loop */
    }
  }

  private dropRoute(speaker: Speaker, runId: string): void {
    const route = speaker.routes.get(runId);
    if (route === undefined) return;
    speaker.routes.delete(runId);
    (route.target as Carrying).releaseRun?.(runId);
  }

  /**
   * Read the speaker socket for as long as it lives. It MUST be read: an unread
   * socket fills its inbound queue until the client closes it for overflow. Frames
   * of runs it does not carry — anybody else's run in a session this person is a
   * member of — are duplicates of what their own consumer has, and are dropped.
   */
  private async consume(key: string, speaker: Speaker): Promise<void> {
    try {
      for await (const frame of speaker.conn.frames()) {
        this.forward(speaker, frame);
        // A hole was reported with the frame that revealed it (seq >= its
        // `received`): now that this frame is delivered, the runs go back.
        const gap = speaker.pendingGap;
        const seq = (frame as { seq?: unknown }).seq;
        if (gap !== undefined && typeof seq === "number" && seq >= gap.received) {
          speaker.pendingGap = undefined;
          this.handBack(speaker, gap);
        }
      }
    } catch {
      /* the socket ended; the next acquire re-opens it */
    } finally {
      // The runs it carried are the owner's socket's own again: whatever of them
      // still arrives reaches the consumer natively. What arrived on neither socket
      // meanwhile is a loss the owner's socket must hear of — uncounted, since the
      // speaker socket's end says nothing of how much. A deliberate close (closeAll,
      // the idle sweep) carries no run by then, so it reports nothing.
      this.handBack(speaker, speaker.pendingGap ?? SPEAKER_CLOSED);
      if (this.speakers.get(key) === speaker) this.speakers.delete(key);
    }
  }

  /** Hand one frame of the speaker socket to the owner socket carrying its run. */
  private forward(speaker: Speaker, frame: GatewayFrame): void {
    const runId = eventRunId(frame);
    if (runId === null) return;
    const route = speaker.routes.get(runId);
    if (route === undefined || route.target.isClosed) return;
    route.target.injectFrame(frame);
    // The run ENDED: its route goes — after a short grace, not at once. A frame
    // the gateway emits after the terminal (the lifecycle end) may already have
    // reached the owner's socket and been dropped there as carried; released
    // this instant, the speaker's copy would be ignored too, and lost.
    if (isRunTerminal(frame) && !route.ending) {
      route.ending = true;
      const t = setTimeout(() => {
        if (speaker.routes.get(runId) === route) this.dropRoute(speaker, runId);
      }, SPEAKER_TERMINAL_GRACE_MS);
      (t as { unref?: () => void }).unref?.();
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper !== null) return;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    // Never keep the process alive for housekeeping.
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** Drop expired routes; close sockets idle past SPEAKER_IDLE_MS with no route. */
  sweep(): void {
    const now = this.clock();
    for (const [key, speaker] of this.speakers) {
      for (const [runId, route] of speaker.routes) {
        if (now - route.at > SPEAKER_ROUTE_TTL_MS || route.target.isClosed) {
          this.dropRoute(speaker, runId);
        }
      }
      if (speaker.routes.size === 0 && now - speaker.lastUsedAt > SPEAKER_IDLE_MS) {
        speaker.conn.close();
        this.speakers.delete(key);
      }
    }
  }
}
