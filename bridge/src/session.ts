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
import type { BridgeConfig } from "./config.js";
import { buildSessionKey } from "./providers/openclaw/session-keys.js";

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
}

export interface BridgeSession {
  readonly chatId: string;
  readonly sessionKey: string;
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
  gatewayVersion: string | null;
}

class Session implements BridgeSession {
  readonly chatId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly canonical: string;
  readonly connection: OpenClawConnection;
  readonly runManager: RunManager;
  readonly clock: Clock;
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
    routing: { agentId: string; canonical: string },
    connection: OpenClawConnection,
    writer: ConvexWriter,
    clock: Clock,
  ) {
    this.chatId = chatId;
    this.sessionKey = sessionKey;
    this.agentId = routing.agentId;
    this.canonical = routing.canonical;
    this.connection = connection;
    this.runManager = new RunManager(chatId, sessionKey, writer);
    this.clock = clock;
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

/**
 * Owns the live sessions. `acquire` returns the session for a chat, creating
 * (and connecting) it on first use. Routing uses `openclawChatId` to build the
 * gateway session key; when absent we fall back to the Convex chatId.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<string, Promise<Session>>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly writer: ConvexWriter,
    private readonly clock: Clock = defaultClock,
  ) {}

  /** The Convex writer (read seam for session re-hydration in performSend). */
  getWriter(): ConvexWriter {
    return this.writer;
  }

  async acquire(routing: SessionRouting): Promise<BridgeSession> {
    const { chatId, openclawChatId, agentId, canonical } = routing;
    // The session key is derived from THIS turn's routed agent + canonical, so a
    // rebind (deleted agent → default = new agentId, or a changed canonical)
    // yields a DIFFERENT key. We keep at most one live connection per chatId; if
    // the key changed we must close the stale one (else its consumer loop keeps
    // writing to the same chat under the old agent → leak + cross-write).
    const sessionKey = buildSessionKey(openclawChatId ?? chatId, agentId, canonical);

    const existing = this.sessions.get(chatId);
    if (existing && !existing.connection.isClosed && existing.sessionKey === sessionKey) {
      return existing;
    }
    // A closed, missing, OR re-keyed session: drop (closing if still open) and
    // (re)connect, deduping concurrent acquisitions for the same chat.
    if (existing) {
      if (!existing.connection.isClosed) existing.close();
      this.sessions.delete(chatId);
    }
    const pending = this.inflight.get(chatId);
    if (pending) {
      // Honor an in-flight create only if it targets the SAME key; otherwise wait
      // for it to settle, then recurse so the re-key is applied.
      return pending.then((s) =>
        s.sessionKey === sessionKey ? s : this.acquire(routing),
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
    const connection = await OpenClawConnection.connect(
      this.config.openclawGatewayUrl,
      this.config.openclawToken,
      this.config.deviceIdentity,
    );
    const session = new Session(
      chatId,
      sessionKey,
      { agentId: routing.agentId, canonical: routing.canonical },
      connection,
      this.writer,
      this.clock,
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
        gatewayVersion: session.connection.gatewayVersion,
      });
    }
    return out;
  }

  /** Cleanly close every live session (graceful shutdown). */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}
