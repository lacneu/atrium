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

/** How long a "silent" verdict waits before it is acted on (capped by the interval).
 *  A timer fires BEFORE the I/O queued behind it: after a pause of this process (a
 *  stalled event loop, a suspended host) the first check runs while the frames the
 *  gateway sent meanwhile are still unread in the socket. The verdict is confirmed
 *  once the loop has had this long to deliver them. */
export const SILENCE_CONFIRM_MS = 5_000;

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
  /** Has the socket been silent for too long? Called once per interval, and once more
   *  to confirm a "silent" verdict (SILENCE_CONFIRM_MS) before the socket is closed. */
  check(): "alive" | "silent";
}

/**
 * @param intervalMs the watch interval (readTickIntervalMs)
 * @param now        a MONOTONIC clock in ms — a wall clock stepped by NTP would
 *                   manufacture or hide a silence
 */
export function createSilenceWatch(intervalMs: number, now: () => number): SilenceWatch {
  const maxSilenceMs = intervalMs * 2;
  let lastInboundAt = now();
  return {
    maxSilenceMs,
    noteInbound() {
      lastInboundAt = now();
    },
    check() {
      // Strictly more than the budget, like the gateway's own clients.
      return now() - lastInboundAt > maxSilenceMs ? "silent" : "alive";
    },
  };
}
