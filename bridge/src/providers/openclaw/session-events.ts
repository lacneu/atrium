// THE SESSION-EVENTS CONNECTION (transcript redesign, phase 2, design §6.2).
//
// ONE dedicated gateway connection per served instance, opened only while at least one
// conversation session of that instance has its transcript projection switched on. It
// calls `sessions.subscribe` and receives `session.message` / `sessions.changed` for
// every session; a demultiplexer hands each event to the reconciler of the session it
// names (sessionKey → TranscriptShadow). Its frames NEVER reach `RunManager.feed`: they
// are read by this file's own loop and nothing else.
//
// WHY A SEPARATE SOCKET — the lesson of 2026-07-26 (bridge/src/session.ts, "NO
// `sessions.subscribe` on THIS connection"): subscribing the CONVERSATION socket pushed
// the sessions channel through the consumer the turn depends on, and
// `spawn-parallel-merge` broke. Nothing here touches a conversation socket.
//
// WHY `session-scoped-events` ON IT. Without that client capability the gateway fans the
// `chat` / `agent` (and, once subscribed, `session.tool`) frames of EVERY session out to
// every operator connection (src/gateway/server-broadcast.ts:361-393 at v2026.9.8,
// `SESSION_SUBSCRIPTION_EVENTS` :48-58; the same gate at v2026.9.6 :310-342 and
// v2026.8.2 :309-337). Declared, those families reach this socket only for keys it
// subscribed per key (`sessions.messages.subscribe`) — and it subscribes none. So the
// socket carries no copy of any turn frame: the turn path cannot be duplicated, and the
// bridge does not pay for a second fanout. `session.message` and `sessions.changed` are
// NOT in the gated set: `sessions.subscribe` alone delivers them for all sessions
// (src/gateway/server-session-events.ts:392-403 recipients, :583 the broadcast;
// src/gateway/server-methods/session-change-event.ts:150,225).
//
// `session.message` is broadcast WITHOUT `dropIfSlow` (server-session-events.ts:583): a
// consumer that falls 50 MiB behind is closed with 1008 (server-broadcast.ts:444-467,
// `MAX_BUFFERED_BYTES`, server-constants.ts:4). This loop therefore never awaits
// anything per frame: a listener only ENQUEUES a read on its reconciler.
//
// There is no `sessions.unsubscribe` (removed upstream in 2026-08,
// packages/gateway-protocol/CHANGELOG.md:172): the subscription ends with the socket,
// which is closed when the last session detaches (after a short linger).

import type { GatewayFrame } from "./openclaw-client.js";
import type { SeqGap } from "./frame-seq.js";
import { sessionEventKey } from "./transcript-rows.js";
import type { SessionEventListener, SessionEventSource } from "./transcript-shadow.js";

/** The client capability this connection declares (packages/gateway-protocol/src/
 *  client-info.ts `GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS`, v2026.8.1+). */
export const SESSION_SCOPED_EVENTS_CAP = "session-scoped-events";

/** The two event families this connection exists for. */
const SESSION_EVENTS = new Set(["session.message", "sessions.changed"]);
/** Families the scoped capability must keep off this socket: one seen here means the
 *  gateway did not honour the capability — counted, never forwarded. */
const TURN_EVENTS = new Set([
  "agent",
  "chat",
  "chat.side_result",
  "session.observer",
  "session.narration",
  "session.tool",
]);

/** The narrow connection surface the hub needs (OpenClawConnection satisfies it). */
export interface SessionEventsConnection {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  frames(): AsyncGenerator<GatewayFrame>;
  close(): void;
  readonly isClosed: boolean;
  readonly gatewayVersion: string | null;
  /** Called by the connection when the gateway's event sequence skipped frames
   *  (OpenClawConnection's sequence tracker). */
  onFrameGap?: ((gap: SeqGap) => void) | null;
}

export interface SessionEventsHubDeps {
  instanceName: string;
  /** Open the dedicated connection (declaring SESSION_SCOPED_EVENTS_CAP). */
  connect: () => Promise<SessionEventsConnection>;
  /** Does this gateway version carry what the connection relies on? A version KNOWN to
   *  be below it is not subscribed (the connection is closed and retried later, in case
   *  the gateway is upgraded). Absent ⇒ every version. */
  versionSupported?: (gatewayVersion: string | null) => boolean;
  /** Backoff between reconnect attempts, by attempt number (ms). */
  backoffMs?: (attempt: number) => number;
  /** How long the socket stays open after the last session detached (ms). */
  lingerMs?: number;
  /** Debounce of the reread a frame gap triggers (ms). */
  gapRereadMs?: number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (line: string) => void;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];
const SUBSCRIBE_TIMEOUT_MS = 10_000;
/** Listeners per session key (a chat holds one socket; a re-key replaces it). */
const MAX_LISTENERS_PER_KEY = 8;

export class SessionEventsHub implements SessionEventSource {
  private readonly listeners = new Map<string, Set<SessionEventListener>>();
  private conn: SessionEventsConnection | null = null;
  private connecting: Promise<void> | null = null;
  private subscribed = false;
  private attempt = 0;
  private retryTimer: { cancel(): void } | null = null;
  private lingerTimer: { cancel(): void } | null = null;
  private gapTimer: { cancel(): void } | null = null;
  private stopped = false;
  private readonly backoffMs: (attempt: number) => number;
  private readonly lingerMs: number;
  private readonly gapRereadMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  private readonly log: (line: string) => void;
  /** Counters (tests, the close log line, the bench). `strayTurnFrames` must stay 0: it
   *  counts turn frames the scoped capability should have kept off this socket. */
  readonly stats = {
    connects: 0,
    subscribes: 0,
    subscribeFailures: 0,
    sessionMessages: 0,
    sessionsChanged: 0,
    routed: 0,
    unrouted: 0,
    strayTurnFrames: 0,
    otherFrames: 0,
    listenerErrors: 0,
    frameGaps: 0,
    gapRereads: 0,
  };

  constructor(private readonly deps: SessionEventsHubDeps) {
    this.backoffMs =
      deps.backoffMs ?? ((n) => DEFAULT_BACKOFF[Math.min(n, DEFAULT_BACKOFF.length - 1)]!);
    this.lingerMs = deps.lingerMs ?? 30_000;
    this.gapRereadMs = deps.gapRereadMs ?? 1_000;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      });
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** The subscription is live (tests, diagnostics). */
  get ready(): boolean {
    return this.subscribed && this.conn !== null && !this.conn.isClosed;
  }

  /** Sessions currently attached (tests, diagnostics). */
  get attachedKeys(): string[] {
    return [...this.listeners.keys()];
  }

  attach(sessionKey: string, listener: SessionEventListener): () => void {
    if (this.stopped) return () => {};
    let set = this.listeners.get(sessionKey);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionKey, set);
    }
    if (set.size >= MAX_LISTENERS_PER_KEY) {
      // A leak, not a use: the oldest listener is a session that never detached.
      const oldest = set.values().next().value as SessionEventListener;
      set.delete(oldest);
    }
    set.add(listener);
    this.lingerTimer?.cancel();
    this.lingerTimer = null;
    if (this.ready) {
      // Attached to a live subscription: events from now on reach it; what came before
      // is in the transcript.
      this.safely(() => listener.onSubscribed());
    } else {
      this.ensureOpen();
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const current = this.listeners.get(sessionKey);
      current?.delete(listener);
      if (current !== undefined && current.size === 0) this.listeners.delete(sessionKey);
      if (this.listeners.size === 0) this.scheduleLinger();
    };
  }

  /** Close for good (bridge shutdown). */
  stop(): void {
    this.stopped = true;
    this.retryTimer?.cancel();
    this.lingerTimer?.cancel();
    this.gapTimer?.cancel();
    this.gapTimer = null;
    this.listeners.clear();
    this.closeConn("stopped");
  }

  /** Hand one frame of the dedicated connection to the session it names. Never awaits:
   *  a listener only enqueues work. Exported through the class for tests. */
  dispatch(frame: GatewayFrame): void {
    if (frame.type !== "event") return;
    const event = typeof frame.event === "string" ? frame.event : "";
    if (!SESSION_EVENTS.has(event)) {
      if (TURN_EVENTS.has(event)) this.stats.strayTurnFrames++;
      else this.stats.otherFrames++;
      return;
    }
    const payload = frame.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const record = payload as Record<string, unknown>;
    if (event === "session.message") this.stats.sessionMessages++;
    else this.stats.sessionsChanged++;
    const key = sessionEventKey(record);
    const set = key === null ? undefined : this.listeners.get(key);
    if (set === undefined || set.size === 0) {
      this.stats.unrouted++;
      return;
    }
    this.stats.routed++;
    for (const listener of [...set]) {
      this.safely(() =>
        event === "session.message"
          ? listener.onSessionMessage(record)
          : listener.onSessionsChanged(record),
      );
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.stats.listenerErrors++;
      this.log(
        `[session-events] ${this.deps.instanceName}: listener failed (non-fatal): ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  private noteFrameGap(conn: SessionEventsConnection): void {
    if (this.stopped || this.conn !== conn) return;
    this.stats.frameGaps++;
    if (this.gapTimer !== null) return;
    this.gapTimer = this.setTimer(() => {
      this.gapTimer = null;
      if (this.stopped || this.conn !== conn || !this.ready) return;
      this.stats.gapRereads++;
      for (const set of [...this.listeners.values()]) {
        for (const listener of [...set]) this.safely(() => listener.onSubscribed());
      }
    }, this.gapRereadMs);
  }

  private scheduleLinger(): void {
    this.lingerTimer?.cancel();
    this.lingerTimer = this.setTimer(() => {
      this.lingerTimer = null;
      if (this.listeners.size === 0) {
        this.retryTimer?.cancel();
        this.retryTimer = null;
        this.closeConn("idle");
      }
    }, this.lingerMs);
  }

  private ensureOpen(): void {
    if (this.stopped || this.connecting !== null || this.retryTimer !== null) return;
    if (this.conn !== null && !this.conn.isClosed) return;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
  }

  private async open(): Promise<void> {
    let conn: SessionEventsConnection;
    try {
      conn = await this.deps.connect();
    } catch (err) {
      this.scheduleRetry(`connect failed: ${(err as Error)?.message ?? err}`);
      return;
    }
    if (this.stopped || this.listeners.size === 0) {
      conn.close();
      return;
    }
    this.stats.connects++;
    if (this.deps.versionSupported?.(conn.gatewayVersion) === false) {
      conn.close();
      this.scheduleRetry(`gateway ${conn.gatewayVersion ?? "?"} predates session-scoped events`);
      return;
    }
    this.conn = conn;
    this.subscribed = false;
    try {
      // `{}`: no list snapshot, just the registration (sessions-subscriptions.ts:27-49).
      await conn.request("sessions.subscribe", {}, SUBSCRIBE_TIMEOUT_MS);
    } catch (err) {
      this.stats.subscribeFailures++;
      this.closeConn("subscribe failed");
      this.scheduleRetry(`sessions.subscribe failed: ${(err as Error)?.message ?? err}`);
      return;
    }
    this.subscribed = true;
    this.attempt = 0;
    this.stats.subscribes++;
    // DROPPED EVENTS. `sessions.changed` is broadcast `dropIfSlow` (src/gateway/
    // server-methods/session-change-event.ts:150,225 at v2026.9.8): under pressure the
    // gateway skips it WITHOUT closing the socket — the only trace is a hole in the
    // event sequence. A reset or a custody change may be in that hole, and no reconnect
    // will reread for it: every attached session reads its transcript again, coalesced
    // into one pass however many gaps a burst produces.
    conn.onFrameGap = () => this.noteFrameGap(conn);
    this.log(
      `[session-events] ${this.deps.instanceName}: subscribed (gateway ${conn.gatewayVersion ?? "?"}, caps ${SESSION_SCOPED_EVENTS_CAP}; ${this.listeners.size} session(s))`,
    );
    void this.consume(conn);
    // Registered BEFORE anything is read back (the gateway registers before it answers,
    // sessions-subscriptions.ts comments): every attached session reads once now.
    for (const set of [...this.listeners.values()]) {
      for (const listener of [...set]) this.safely(() => listener.onSubscribed());
    }
  }

  private async consume(conn: SessionEventsConnection): Promise<void> {
    try {
      for await (const frame of conn.frames()) {
        if (this.conn !== conn) return;
        this.dispatch(frame);
      }
    } catch (err) {
      this.log(
        `[session-events] ${this.deps.instanceName}: reader stopped: ${(err as Error)?.message ?? err}`,
      );
    }
    if (this.conn !== conn) return;
    this.conn = null;
    this.subscribed = false;
    if (!this.stopped && this.listeners.size > 0) this.scheduleRetry("connection closed");
  }

  private scheduleRetry(why: string): void {
    if (this.stopped || this.listeners.size === 0 || this.retryTimer !== null) return;
    const delay = this.backoffMs(this.attempt);
    this.attempt++;
    this.log(
      `[session-events] ${this.deps.instanceName}: ${why} — retrying in ${delay} ms (non-fatal: reads still follow the turn triggers)`,
    );
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.ensureOpen();
    }, delay);
  }

  private closeConn(why: string): void {
    const conn = this.conn;
    this.conn = null;
    this.subscribed = false;
    if (conn === null) return;
    const s = this.stats;
    this.log(
      `[session-events] ${this.deps.instanceName}: closing (${why}) — messages ${s.sessionMessages}, changed ${s.sessionsChanged}, routed ${s.routed}, unrouted ${s.unrouted}, stray turn frames ${s.strayTurnFrames}`,
    );
    try {
      conn.close();
    } catch {
      /* already gone */
    }
  }
}
