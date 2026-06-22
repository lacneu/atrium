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
import { extractMessageToolReplies } from "./providers/openclaw/history-recovery.js";
import type { ConvexWriter } from "./convex-writer.js";
import type { OutboundScan } from "./core/turn-sink.js";
import type { BridgeConfig } from "./config.js";
import type { MediaFetcherProvider } from "./core/media-fetcher-provider.js";
import { buildSessionKey } from "./providers/openclaw/session-keys.js";

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
  /** Prod the inbound consume loop to re-evaluate its next deadline. MUST be
   *  called after `runManager.beginTurn` (which arms the recv/grace deadline from
   *  OUTSIDE the loop) so a loop blocked on a null-timeout frame wait does not
   *  hang the turn forever in "streaming". */
  wake(): void;
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
  readonly clock: Clock;
  // Last time this session saw work (a send via acquire, or an inbound frame), on
  // the SECONDS Clock. The registry's idle sweeper reaps a session — closing its
  // WebSocket/FD — once this is older than IDLE_SESSION_TTL_SECONDS, so idle sockets
  // don't accumulate to FD exhaustion (the next send transparently reconnects).
  lastActivityAt: number;
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
  ) {
    this.chatId = chatId;
    this.sessionKey = sessionKey;
    this.agentId = routing.agentId;
    this.canonical = routing.canonical;
    this.instanceName = routing.instanceName;
    this.connection = connection;
    this.runManager = new RunManager(chatId, sessionKey, writer, outboundScan);
    this.clock = clock;
    this.lastActivityAt = clock();
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
    if (!this.runManager.isFinalized) {
      try {
        await this.runManager.endTurn(this.clock(), "aborted");
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
      const timeoutSec = this.runManager.nextTimeout(this.clock());
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
          // so the UI never stays stuck on a "streaming" message.
          if (!this.runManager.isFinalized) {
            try {
              await this.runManager.endTurn(now, "aborted");
            } catch (err) {
              console.error("session close finalize error:", (err as Error)?.message ?? err);
            }
          }
          break;
        }
        nextFrame = iterator.next();
        this.lastActivityAt = now; // active turn -> not idle, don't let the sweeper reap it
        try {
          await this.runManager.feed(winner.value, now);
        } catch (err) {
          console.error("session feed error:", (err as Error)?.message ?? err);
        }
      } else {
        // timeout: resolve any expired normalizer deadline (may finalize).
        try {
          await this.runManager.tick(now);
        } catch (err) {
          console.error("session tick error:", (err as Error)?.message ?? err);
        }
      }
    }
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
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    // The instances this bridge serves, keyed by instanceName. Each bundle carries
    // its own gateway config + writer + media — `acquire` picks the bundle for the
    // turn's routed instance (one bridge, N gateways).
    private readonly served: Map<string, InstanceBundle>,
    private readonly clock: Clock = defaultClock,
  ) {}

  /** The bundle serving `instanceName`, or undefined when this bridge does not serve
   *  it (the server's membership guard rejects before acquire is reached). */
  getBundle(instanceName: string): InstanceBundle | undefined {
    return this.served.get(instanceName);
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
    );
    session.startConsumer();
    this.sessions.set(chatId, session);
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
