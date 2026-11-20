/**
 * The connection-silence watch — the pure policy.
 *
 * Upstream facts these tests encode (v2026.9.36, identical since v2026.6.11):
 *  - `hello-ok.policy.tickIntervalMs` is `TICK_INTERVAL_MS` (30 000 —
 *    `src/gateway/server-constants.ts`, sent by `server/ws-connection/connect-hello.ts`),
 *    and the gateway broadcasts `tick` on that period to every connection
 *    (`server-maintenance.ts`; scope-free: `EVENT_SCOPE_GUARDS.tick = []`).
 *  - The Control UI reconnects when NO inbound frame arrived for twice that interval
 *    (`ui/src/api/gateway.ts` startTickWatch: `maxInboundSilenceMs = tickIntervalMs * 2`,
 *    checked every interval; any event or response frame is activity).
 *  - The advertised value is remote input: clamped to a 1 s floor and to the largest
 *    delay a timer can hold (`resolveSafeTimeoutDelayMs`).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TIMER_DELAY_MS,
  MIN_TICK_WATCH_INTERVAL_MS,
  createSilenceWatch,
  readTickIntervalMs,
} from "../src/providers/openclaw/inbound-silence.js";

/** `hello-ok.policy`, verbatim from a bench capture (gateway 2026.9.33; 2026.9.6 sends
 *  the same object). */
const CAPTURED_POLICY = {
  allowedSessionVisibilities: ["shared", "read-only", "suggest", "draft"],
  attachments: { maxBytes: 19464192, maxImageBytes: 6291456 },
  hasMultipleSessionSharingIdentities: false,
  maxBufferedBytes: 52428800,
  maxPayload: 26214400,
  tickIntervalMs: 30000,
};

describe("readTickIntervalMs", () => {
  it("reads the interval the gateway advertises", () => {
    expect(readTickIntervalMs(CAPTURED_POLICY)).toBe(30_000);
  });

  it("is null — the watch stays inert — when the gateway advertises none", () => {
    expect(readTickIntervalMs({ maxPayload: 26214400, maxBufferedBytes: 52428800 })).toBeNull();
    expect(readTickIntervalMs({})).toBeNull();
    expect(readTickIntervalMs(undefined)).toBeNull();
    expect(readTickIntervalMs(null)).toBeNull();
    expect(readTickIntervalMs("policy")).toBeNull();
  });

  it("refuses a value that is not a positive finite number", () => {
    for (const bad of [0, -30_000, Number.NaN, Number.POSITIVE_INFINITY, "30000", null, true, {}]) {
      expect(readTickIntervalMs({ tickIntervalMs: bad }), String(bad)).toBeNull();
    }
  });

  it("clamps an absurd interval instead of trusting it", () => {
    // Too small would close a healthy socket between two frames; too large overflows
    // the timer, which Node then fires every millisecond.
    expect(readTickIntervalMs({ tickIntervalMs: 1 })).toBe(MIN_TICK_WATCH_INTERVAL_MS);
    expect(readTickIntervalMs({ tickIntervalMs: 0.4 })).toBe(MIN_TICK_WATCH_INTERVAL_MS);
    expect(readTickIntervalMs({ tickIntervalMs: 1e15 })).toBe(MAX_TIMER_DELAY_MS);
    expect(readTickIntervalMs({ tickIntervalMs: 30_000.9 })).toBe(30_000);
  });
});

describe("createSilenceWatch", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("allows twice the interval of silence, like the Control UI", () => {
    const c = clock();
    const watch = createSilenceWatch(30_000, c.now);
    expect(watch.maxSilenceMs).toBe(60_000);
    c.advance(30_000);
    expect(watch.check()).toBe("alive");
    c.advance(30_000);
    // Exactly 2 x the interval is not yet over it (`>` upstream).
    expect(watch.check()).toBe("alive");
    c.advance(30_000);
    expect(watch.check()).toBe("silent");
  });

  it("is reset by ANY inbound frame, so a long silent tool call on a live socket never trips it", () => {
    const c = clock();
    const watch = createSilenceWatch(30_000, c.now);
    // Twenty minutes of nothing but the gateway's own ticks.
    for (let i = 0; i < 40; i++) {
      c.advance(29_000);
      watch.noteInbound();
      c.advance(1_000);
      expect(watch.check(), `check ${i}`).toBe("alive");
    }
    // The ticks stop: the socket is given two intervals, then named silent.
    c.advance(30_000);
    expect(watch.check()).toBe("alive");
    c.advance(30_000);
    expect(watch.check()).toBe("silent");
  });

  it("a frame read between a silent verdict and its confirmation revives the socket", () => {
    // What the connection relies on to confirm a verdict: after a pause of the process
    // the first check runs before the frames waiting in the socket are read; once they
    // are, the same watch answers alive.
    const c = clock();
    const watch = createSilenceWatch(30_000, c.now);
    c.advance(600_000);
    expect(watch.check()).toBe("silent");
    watch.noteInbound();
    c.advance(5_000);
    expect(watch.check()).toBe("alive");
  });

  it("stays silent once silent (the close is the caller's, a second check agrees)", () => {
    const c = clock();
    const watch = createSilenceWatch(1_000, c.now);
    c.advance(1_000);
    watch.check();
    c.advance(1_000);
    watch.check();
    c.advance(1_000);
    expect(watch.check()).toBe("silent");
    c.advance(1_000);
    expect(watch.check()).toBe("silent");
  });
});
