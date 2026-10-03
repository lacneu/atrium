// THE SHADOW RECONCILER (transcript redesign, phase 1, design §4).
//
// Per conversation session: reads the gateway's `chat.history` back with a delta cursor
// at the Control UI's own triggers, and posts what it read — identity rows, run
// statuses, the cursor — to Convex (`applyTranscript`). It NEVER creates, edits or
// finalizes a bubble: shadow mode measures the distance between the transcript and the
// bubbles Atrium built from the live stream, it does not decide anything.
//
// TRIGGERS available in phase 1 (design §4.1), each the Control UI's:
//   - a terminal chat frame of ANY run of the session (`final`/`error`/`aborted`):
//     one delta read (ui/src/pages/chat/chat-state-events.ts, terminal handling);
//   - a `final` WITHOUT a message: the bounded recovery — read, then 100/400/1500/3000 ms
//     (five reads), stopping as soon as a visible row of that run was read
//     (chat-state-events.ts:73 `MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS`, :319-342
//     `recoverMissingTerminalReply`);
//   - the `chat.send` ACK `ok` (chat-send-delivery.ts:476-490);
//   - the projection switched on for a session — a new conversation socket is a new
//     session, so this is also the reconnect read: a fresh tail page when no cursor is
//     known (chat-history-stream.ts reconnect).
// `session.message` / `sessions.changed` need the dedicated session-event connection of
// phase 2; they are not wired here.
//
// COST: at most ONE read in flight and ONE chained behind it per session (the Control
// UI's coalescing, chat-history.ts:107-148). A delta costs only what changed; a `reset`
// costs one tail page of 80 rows.

import type { TranscriptApplyReport } from "../../convex-writer.js";
import type { GatewayFrame } from "./openclaw-client.js";
import {
  parseHistoryReply,
  runTerminalStatus,
  type HistoryRead,
  type TranscriptRow,
} from "./transcript-rows.js";

export type ProjectionMode = "off" | "shadow" | "on";

/** Upstream `MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS` (chat-state-events.ts:73). */
export const TERMINAL_RECOVERY_DELAYS_MS: readonly number[] = [100, 400, 1_500, 3_000];

export type TerminalObservation = TranscriptApplyReport["terminals"][number];

/** What one read posts to Convex (convex/transcriptProjection.ts `applyTranscript`). */
export type TranscriptApply = TranscriptApplyReport & { rows: TranscriptRow[] };

export type TranscriptCursor = { sessionId: string; deltaCursor: string };

export interface TranscriptShadowDeps {
  chatId: string;
  sessionKey: string;
  /** One `chat.history` read: `cursor` null ⇒ a tail page. Resolves to the reply payload. */
  readHistory: (cursor: string | null) => Promise<unknown>;
  /** Post one read to Convex. */
  apply: (payload: TranscriptApply) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Pending terminal observations kept between reads (a burst of runs is bounded). */
const MAX_PENDING_TERMINALS = 50;

export class TranscriptShadow {
  private mode: ProjectionMode = "off";
  private cursor: TranscriptCursor | null = null;
  private inFlight: Promise<void> | null = null;
  private chained = false;
  private closed = false;
  private pendingTerminals: TerminalObservation[] = [];
  /** Runs a visible durable row was read for — what ends a terminal recovery. */
  private readonly visibleRuns = new Set<string>();
  /** Runs whose bounded recovery is running (one per run, like the Control UI's claim). */
  private readonly recovering = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastReadAt = 0;
  private readonly log: (line: string) => void;
  /** Counters, for tests and the log line. */
  readonly stats = { reads: 0, applies: 0, failures: 0, resets: 0 };

  constructor(private readonly deps: TranscriptShadowDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** The projection is doing something on this session. `on` behaves as `shadow` in
   *  phase 1: no phase has given the projection a decision yet. */
  get active(): boolean {
    return !this.closed && this.mode !== "off";
  }

  /**
   * Apply the instance switch and the cursor Convex stored, as carried by a `/send`.
   * Turning the projection on for a live session triggers a read (a tail page when no
   * cursor is known yet) — the Control UI's own "pane opened" read.
   */
  configure(opts: { mode: ProjectionMode | undefined; cursor?: TranscriptCursor | null }): void {
    if (this.closed) return;
    const next = opts.mode ?? "off";
    const wasActive = this.mode !== "off";
    this.mode = next;
    if (next === "off") {
      this.pendingTerminals = [];
      return;
    }
    // Convex's cursor is adopted only when this process holds none: a live process is
    // never behind the store it writes to.
    if (this.cursor === null && opts.cursor) this.cursor = { ...opts.cursor };
    if (!wasActive) this.requestRead("configured");
  }

  /** The `chat.send` ACK. Only `ok` asks for a read (the reply is in the transcript);
   *  `started`/`in_flight` are custody, not persistence (docs/web/webchat.md:55-56). */
  noteAck(status: unknown): void {
    if (!this.active || status !== "ok") return;
    this.requestRead("ack_ok");
  }

  /**
   * Observe a frame of the conversation socket. Only a TERMINAL `chat` frame of THIS
   * session counts — of any run, foreign or ours (CU-6: the session is the only filter).
   * Read-only: the frame continues to the turn pipeline untouched.
   */
  observeFrame(frame: GatewayFrame): void {
    if (!this.active || frame.type !== "event" || frame.event !== "chat") return;
    const payload = frame.payload as Record<string, unknown> | undefined;
    if (payload === undefined || payload.sessionKey !== this.deps.sessionKey) return;
    const runId = typeof payload.runId === "string" && payload.runId !== "" ? payload.runId : null;
    if (runId === null) return;
    const status = runTerminalStatus(payload);
    if (status === null) return;
    const emptyFinal = payload.state === "final" && payload.message === undefined;
    this.pendingTerminals.push({
      runId,
      status,
      ...(emptyFinal ? { emptyFinal: true as const } : {}),
      at: this.now(),
    });
    if (this.pendingTerminals.length > MAX_PENDING_TERMINALS) {
      this.pendingTerminals.splice(0, this.pendingTerminals.length - MAX_PENDING_TERMINALS);
    }
    if (emptyFinal) void this.recoverTerminal(runId);
    else this.requestRead("terminal");
  }

  /** Stop everything: the connection is gone. */
  close(): void {
    this.closed = true;
    this.pendingTerminals = [];
  }

  /** Resolves when no read is in flight or chained (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }

  /** Ask for a read: joins the one in flight by chaining ONE more behind it. */
  requestRead(reason: string): void {
    if (!this.active) return;
    if (this.inFlight !== null) {
      this.chained = true;
      return;
    }
    this.inFlight = this.runReads(reason).finally(() => {
      this.inFlight = null;
    });
  }

  /** CU-13: a final without a message → read, then up to four more reads at
   *  100/400/1500/3000 ms, stopping once a visible row of the run was read. */
  private async recoverTerminal(runId: string): Promise<void> {
    if (this.recovering.has(runId)) return;
    this.recovering.add(runId);
    try {
      for (let attempt = 0; ; attempt++) {
        if (!this.active || this.visibleRuns.has(runId)) return;
        this.requestRead(`recover:${attempt}`);
        await this.idle();
        if (!this.active || this.visibleRuns.has(runId)) return;
        const delay = TERMINAL_RECOVERY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.log(
            `[transcript] chat=${this.deps.chatId} run ${runId} ended with no message and no visible row after ${attempt + 1} reads — nothing to show (CU-13)`,
          );
          return;
        }
        await this.sleep(delay);
      }
    } finally {
      this.recovering.delete(runId);
    }
  }

  private async runReads(reason: string): Promise<void> {
    let why = reason;
    for (;;) {
      this.chained = false;
      await this.readOnce(why);
      if (!this.chained || !this.active) return;
      why = "chained";
    }
  }

  private async readOnce(reason: string): Promise<void> {
    let read: HistoryRead | null = null;
    try {
      this.stats.reads++;
      let readAt = this.nextReadAt();
      read = parseHistoryReply(await this.deps.readHistory(this.cursor?.deltaCursor ?? null));
      if (read === null) {
        this.stats.failures++;
        this.log(`[transcript] chat=${this.deps.chatId} unreadable chat.history reply (${reason})`);
        return;
      }
      if (read.kind === "reset") {
        // A normal cursor discontinuity (logs-chat.ts `ChatHistoryResetResultSchema`):
        // record it, drop the cursor, and take a fresh tail page in the SAME read.
        this.stats.resets++;
        await this.post(read, readAt);
        this.cursor = null;
        this.stats.reads++;
        readAt = this.nextReadAt();
        read = parseHistoryReply(await this.deps.readHistory(null));
        if (read === null || read.kind === "reset") {
          this.stats.failures++;
          return;
        }
      }
      await this.post(read, readAt);
    } catch (err) {
      this.stats.failures++;
      this.log(
        `[transcript] chat=${this.deps.chatId} read failed (${reason}, non-fatal): ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  /** The issue time of a read, STRICTLY increasing: Convex lets an older read (a POST
   *  that timed out here and still committed there) merge its rows but never move the
   *  cursor or the session back (convex/transcriptProjection.ts `readAt`). */
  private nextReadAt(): number {
    this.lastReadAt = Math.max(this.now(), this.lastReadAt + 1);
    return this.lastReadAt;
  }

  private async post(read: HistoryRead, readAt: number): Promise<void> {
    const terminals = this.pendingTerminals;
    this.pendingTerminals = [];
    const sessionId = read.sessionId ?? this.cursor?.sessionId ?? "";
    // A different gateway session (reset, rotation): its seq restarts, the old cursor
    // means nothing there.
    if (this.cursor !== null && read.sessionId !== null && read.sessionId !== this.cursor.sessionId) {
      this.cursor = null;
    }
    const payload: TranscriptApply = {
      chatId: this.deps.chatId,
      sessionKey: this.deps.sessionKey,
      sessionId,
      kind: read.kind,
      ...(read.deltaCursor === null ? {} : { deltaCursor: read.deltaCursor }),
      rows: read.rows,
      terminals,
      ...(read.activeRunIds === null ? {} : { activeRunIds: read.activeRunIds }),
      ...(read.hasActiveRun === null ? {} : { hasActiveRun: read.hasActiveRun }),
      unidentified: read.unidentified,
      readAt,
    };
    try {
      await this.deps.apply(payload);
      this.stats.applies++;
    } catch (err) {
      // The read is lost, not the terminals: they ride the next apply.
      this.pendingTerminals = [...terminals, ...this.pendingTerminals].slice(-MAX_PENDING_TERMINALS);
      throw err;
    }
    for (const row of read.rows) {
      if (row.runId !== undefined && !row.hidden && (row.visible || row.role === "toolresult")) {
        this.visibleRuns.add(row.runId);
      }
    }
    if (this.visibleRuns.size > 500) {
      // Bounded memory: the oldest runs are long settled.
      const keep = [...this.visibleRuns].slice(-250);
      this.visibleRuns.clear();
      for (const id of keep) this.visibleRuns.add(id);
    }
    if (read.deltaCursor !== null) {
      this.cursor = { sessionId, deltaCursor: read.deltaCursor };
    }
  }
}
