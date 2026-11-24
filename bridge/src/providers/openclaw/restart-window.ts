/**
 * "The gateway said it is restarting" — remembered per gateway, between the notice and
 * the next connection.
 *
 * A `shutdown` notice with `restartExpectedMs` is read on the sockets that are open
 * (connection-end.ts); a request that needs a NEW socket while the gateway is down sees
 * only a refused connection, which names nothing. The Control UI keeps the announcement
 * across that gap: it arms `restartPending` on the notice, for `max(15 s, 3 × the delay
 * given)`, and drops it at the next hello (ui/src/app/gateway-store.ts `shutdown`,
 * ui/src/app/gateway-store.availability.ts `setUnavailableDeadline` at v2026.9.36). The
 * same window here, compared against the clock when a connection fails — no timer.
 */

/** Floor of the window: stale evidence must fall back to the plain disconnect. */
const RESTART_WINDOW_FLOOR_MS = 15_000;
/** The window, as a multiple of the delay the gateway gave. */
const RESTART_WINDOW_FACTOR = 3;
/** Gateways remembered at once (one entry per gateway URL the bridge serves). */
const MAX_GATEWAYS = 64;

export class RestartWindows {
  private readonly until = new Map<string, number>();

  /** The gateway at `url` announced a restart (`restartExpectedMs`: null when it gave
   *  no usable delay — the floor applies). */
  announce(url: string, restartExpectedMs: number | null, nowMs: number): void {
    const windowMs = Math.max(RESTART_WINDOW_FLOOR_MS, (restartExpectedMs ?? 0) * RESTART_WINDOW_FACTOR);
    this.until.delete(url);
    this.until.set(url, nowMs + windowMs);
    while (this.until.size > MAX_GATEWAYS) {
      const oldest = this.until.keys().next().value;
      if (oldest === undefined) break;
      this.until.delete(oldest);
    }
  }

  /** A connection to `url` completed its handshake: the restart is over. */
  connected(url: string): void {
    this.until.delete(url);
  }

  /** Whether a restart announced by `url` is still awaited at `nowMs`. */
  pending(url: string, nowMs: number): boolean {
    const until = this.until.get(url);
    if (until === undefined) return false;
    if (nowMs < until) return true;
    this.until.delete(url);
    return false;
  }

  clear(): void {
    this.until.clear();
  }
}

/** The bridge's one record, shared by every connection of the process. */
export const restartWindows = new RestartWindows();
