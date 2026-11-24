/**
 * The connection-silence watch: is this socket still carrying anything?
 *
 * A WebSocket can die without closing — a NAT entry dropped, a gateway that hangs —
 * and nothing then arrives, not even the close. The gateway gives its clients the
 * means to notice: `hello-ok.policy.tickIntervalMs` (`TICK_INTERVAL_MS`, 30 s,
 * `src/gateway/server/ws-connection/connect-hello.ts`) and a `tick` event broadcast
 * on that period to every connection (`src/gateway/server-maintenance.ts`; scope-free,
 * `EVENT_SCOPE_GUARDS.tick = []`). Its own Control UI reconnects after twice that
 * interval without ANY inbound frame (`ui/src/api/gateway.ts` startTickWatch:
 * `maxInboundSilenceMs = tickIntervalMs * 2`, checked once per interval).
 *
 * This module is the PURE half — what to read from the handshake and when a silence
 * is one — so both are testable without a socket. The timer and the close live with
 * the connection (openclaw-client.ts).
 */

/** Floor of the watch interval (the Control UI's `MIN_GATEWAY_TICK_WATCH_INTERVAL_MS`):
 *  an advertised 1 ms must not close a healthy socket between two frames. */
export const MIN_TICK_WATCH_INTERVAL_MS = 1_000;
/** Largest delay a Node timer holds; past it the timer fires every millisecond
 *  (upstream `MAX_SAFE_TIMEOUT_DELAY_MS`, packages/gateway-client/src/timeouts.ts). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long a silent socket is given to ANSWER before it is closed.
 *
 * A "silent" verdict is never acted on at once: the connection asks the gateway one
 * question (openclaw-client.ts) and closes only if nothing at all arrives within this
 * deadline. Its own deadline, on purpose — not the tick interval, not a few seconds:
 * the gateway that is asked may be draining a restart with its event loop busy, and
 * the longest bounded read it grants itself is seven seconds
 * (`HEALTH_COLLECTION_TIMEOUT_MS`, src/gateway/health/collector.ts). Twice that, plus
 * a second for the network.
 */
export const SILENCE_PROBE_DEADLINE_MS = 15_000;

/**
 * The tick interval a `hello-ok.policy` advertises, clamped, or null.
 *
 * Null means NO WATCH: a gateway that states no interval promises no periodic frame,
 * and assuming one would close sockets that are merely quiet. (The Control UI falls
 * back to 30 s there; the bridge has turns in flight on these sockets and does not
 * guess.) Remote input: only a positive finite number is accepted.
 */
export function readTickIntervalMs(policy: unknown): number | null {
  if (typeof policy !== "object" || policy === null) return null;
  const advertised = (policy as Record<string, unknown>).tickIntervalMs;
  if (typeof advertised !== "number" || !Number.isFinite(advertised) || advertised <= 0) {
    return null;
  }
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_TICK_WATCH_INTERVAL_MS, Math.floor(advertised)));
}

export interface SilenceWatch {
  /** The silence past which the socket is declared dead: twice the interval. */
  readonly maxSilenceMs: number;
  /** A frame arrived (any event or response frame). */
  noteInbound(): void;
  /** Has the socket been silent for too long? Called once per interval. A check that
   *  runs far later than its interval means THIS process was not running: it starts a
   *  fresh window and answers "alive". */
  check(): "alive" | "silent";
  /** Start a fresh observation window: the time before now was not listened to. */
  restart(): void;
  /** How many times `noteInbound` was called: "did anything arrive since I asked?" */
  readonly inboundCount: number;
}

/**
 * @param intervalMs the watch interval (readTickIntervalMs)
 * @param now        a MONOTONIC clock in ms — a wall clock stepped by NTP would
 *                   manufacture or hide a silence
 */
export function createSilenceWatch(intervalMs: number, now: () => number): SilenceWatch {
  const maxSilenceMs = intervalMs * 2;
  let lastInboundAt = now();
  let lastCheckAt = lastInboundAt;
  let inboundCount = 0;
  return {
    maxSilenceMs,
    get inboundCount() {
      return inboundCount;
    },
    noteInbound() {
      lastInboundAt = now();
      inboundCount += 1;
    },
    check() {
      const at = now();
      const sinceLastCheck = at - lastCheckAt;
      lastCheckAt = at;
      // "I WAS NOT LISTENING." Checks are a period apart; one that comes more than two
      // periods after the previous means this process was suspended or its event loop
      // blocked, and read nothing off the socket meanwhile. That time is not silence of
      // the gateway's: the window starts again from now.
      if (sinceLastCheck > intervalMs * 2) {
        lastInboundAt = at;
        return "alive";
      }
      // Strictly more than the budget, like the gateway's own clients.
      return at - lastInboundAt > maxSilenceMs ? "silent" : "alive";
    },
    restart() {
      lastInboundAt = lastCheckAt = now();
    },
  };
}
