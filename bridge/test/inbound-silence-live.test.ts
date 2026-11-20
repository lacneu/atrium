/**
 * The connection-silence watch, over a REAL socket.
 *
 * `inbound-silence.test.ts` pins the policy; this one pins the wiring: the interval is
 * read off the hello-ok the gateway really sends, every inbound frame resets the watch,
 * a silent socket is closed through the connection's ordinary end (named, pending
 * requests rejected, consumer released, timer gone), and a gateway that advertises no
 * interval gets no watch at all.
 *
 * The socket and its I/O are real; only the timers and the monotonic clock are faked,
 * so thirty-second intervals cost nothing and nothing depends on timing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { SILENCE_CONFIRM_MS } from "../src/providers/openclaw/inbound-silence.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { SessionRegistry } from "../src/session.js";
import { servedMap } from "./helpers/served.js";
import { classifyGatewayError, LOST_RESPONSE_CODES } from "../src/core/dispatch-errors.js";
import {
  CAPTURED_HELLO_POLICY,
  MAX_BUFFERED,
  MAX_PAYLOAD,
  NO_ANSWER,
  deviceIdentity,
  startWsFakeGateway,
  type WsFakeGateway,
} from "./helpers/ws-fake-gateway.js";

/** A real wait: the timers below are faked, the socket's I/O is not. */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** A `tick` VERBATIM from a bench capture (gateway 2026.9.33). */
const CAPTURED_TICK = { type: "event", event: "tick", payload: { ts: 1792169947526 }, seq: 12 };

let gateway: WsFakeGateway | null = null;
let conn: OpenClawConnection | null = null;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"],
  });
});

afterEach(async () => {
  conn?.close();
  conn = null;
  await gateway?.stop();
  gateway = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const connect = async (policy: Record<string, unknown>, onMethod?: () => unknown) => {
  gateway = startWsFakeGateway({ version: "2026.9.36", policy, onMethod });
  await gateway.ready;
  conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
  return conn;
};

/** One interval of the watch elapses (the timer fires once). */
const interval = (ms = 30_000) => vi.advanceTimersByTime(ms);
/** The confirmation delay of a "silent" verdict elapses. */
const confirm = () => vi.advanceTimersByTime(SILENCE_CONFIRM_MS);
/** The watch's own timers still armed (the handshake's and the requests' are not its). */
const watchTimers = (c: OpenClawConnection) => {
  const w = c as unknown as { silenceTimer: unknown; silenceConfirmTimer: unknown };
  return (w.silenceTimer === null ? 0 : 1) + (w.silenceConfirmTimer === null ? 0 : 1);
};

describe("connection silence over a real socket", () => {
  it("reads the tick interval off the hello-ok", async () => {
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    expect(c.tickIntervalMs).toBe(30_000);
  });

  it("closes a socket that stayed silent for more than twice the interval, and names the end", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await connect({ ...CAPTURED_HELLO_POLICY }, () => NO_ANSWER);
    const frames = c.frames();
    const next = frames.next();
    const pending = c.request("sessions.describe", { key: "k" }, 3_600_000).then(
      () => null,
      (e: unknown) => e as Error,
    );
    interval();
    interval();
    expect(c.isClosed).toBe(false); // exactly 2 x the interval: not yet over it
    expect(watchTimers(c)).toBe(1); // …and no verdict awaits confirmation
    interval();
    // Over the budget: the verdict is reached, and acted on only once confirmed —
    // the whole confirmation delay, not a moment less.
    expect(c.isClosed).toBe(false);
    vi.advanceTimersByTime(SILENCE_CONFIRM_MS - 1);
    expect(c.isClosed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(c.isClosed).toBe(true);
    expect(c.connectionEnd).toEqual({
      kind: "inbound_silence",
      restartExpectedMs: null,
      reasonPresent: false,
    });
    // The consumer is released (the session's close path runs)…
    expect((await next).done).toBe(true);
    // …and a request still waiting for its ack is rejected as a LOST response: on a
    // half-open socket the gateway may have applied it.
    const failure = await pending;
    expect(failure?.message).toContain("[inbound_silence]");
    const code = classifyGatewayError(failure);
    expect(code).toBe("GATEWAY_DISCONNECTED");
    expect(LOST_RESPONSE_CODES.has(code)).toBe(true);
    // The watch is gone with the connection: no timer of its own is left to fire.
    expect(watchTimers(c)).toBe(0);
  });

  it("does not close a socket whose frames were only waiting to be read (a pause of this process)", async () => {
    // After a stalled event loop or a suspended host, the watch's timer runs BEFORE the
    // frames the gateway sent meanwhile are read. The verdict must not be acted on until
    // the loop has delivered them.
    let paused = 0;
    const clock = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => clock() + paused);
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    const frames = c.frames();
    // The process did not run for ten minutes; the one check that then runs sees a
    // long silence…
    paused = 600_000;
    interval();
    expect(c.isClosed).toBe(false);
    expect(watchTimers(c)).toBe(2);
    // …and the tick that was waiting in the socket is read before the confirmation.
    gateway!.push({ ...CAPTURED_TICK });
    await frames.next();
    confirm();
    expect(c.isClosed).toBe(false);
    expect(c.connectionEnd).toBeNull();
    // A socket that stays silent after that is still closed, a budget later.
    interval();
    interval();
    interval();
    confirm();
    expect(c.isClosed).toBe(true);
    expect(c.connectionEnd?.kind).toBe("inbound_silence");
  });

  it("keeps a socket whose only traffic is the gateway's ticks — a long silent tool call", async () => {
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    const frames = c.frames();
    for (let i = 0; i < 12; i++) {
      gateway!.push({ ...CAPTURED_TICK, seq: i + 1 });
      // The tick is delivered to the consumer like any frame (observe-only).
      const got = await frames.next();
      expect((got.value as { event?: string }).event).toBe("tick");
      interval();
      confirm();
      expect(c.isClosed, `interval ${i}`).toBe(false);
    }
    expect(c.connectionEnd).toBeNull();
  });

  it("counts a response frame as activity too", async () => {
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    for (let i = 0; i < 6; i++) {
      await c.request("health", {}, 5_000);
      interval();
      interval();
      confirm();
      expect(c.isClosed, `round ${i}`).toBe(false);
    }
  });

  it("starts no watch when the gateway advertises no tick interval", async () => {
    const c = await connect({ maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED });
    expect(c.tickIntervalMs).toBeNull();
    expect(watchTimers(c)).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(c.isClosed).toBe(false);
  });

  it("starts no watch on a zero or malformed interval", async () => {
    for (const tickIntervalMs of [0, -1, "30000", null]) {
      const c = await connect({ ...CAPTURED_HELLO_POLICY, tickIntervalMs });
      expect(c.tickIntervalMs, String(tickIntervalMs)).toBeNull();
      expect(watchTimers(c)).toBe(0);
      c.close();
      await gateway!.stop();
      gateway = null;
    }
  });

  it("stops the watch when the connection is closed for any other reason", async () => {
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    expect(watchTimers(c)).toBe(1);
    // …including while a verdict awaits its confirmation.
    interval();
    interval();
    interval();
    expect(watchTimers(c)).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    c.close();
    expect(watchTimers(c)).toBe(0);
    // Really cancelled, not merely forgotten: nothing is left armed.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    // Closed by the bridge: the end is not renamed after the fact.
    expect(c.connectionEnd?.kind).toBe("connection_closed");
  });

  it("stops the watch when the GATEWAY closes, and keeps that end's own name", async () => {
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    const frames = c.frames();
    gateway!.push({ type: "event", event: "shutdown", payload: { reason: "gateway stopping" } });
    await frames.next();
    gateway!.socket!.close(1012, "service restart");
    await frames.next();
    expect(c.connectionEnd?.kind).toBe("gateway_stopping");
    expect(watchTimers(c)).toBe(0);
  });

  it("keeps an ANNOUNCED end's name when the socket then goes quiet instead of closing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await connect({ ...CAPTURED_HELLO_POLICY });
    const frames = c.frames();
    gateway!.push({
      type: "event",
      event: "shutdown",
      payload: { reason: "gateway restarting", restartExpectedMs: 1500 },
    });
    await frames.next();
    // The gateway announced its restart, then hung without closing the socket.
    interval();
    interval();
    interval();
    confirm();
    expect(c.isClosed).toBe(true);
    expect(c.connectionEnd?.kind).toBe("gateway_restarting");
    expect(c.connectionEnd?.restartExpectedMs).toBe(1500);
  });
});

describe("a silent conversation socket, through the session", () => {
  it("is closed mid-turn WITHOUT settling the turn, and the next acquire opens a new socket", async () => {
    // The turn in flight is not lost: the consume loop's own close path leaves it to
    // the transcript (the `/resume` a send or the stuck-stream net asks for), exactly
    // as for any other close — and the registry reconnects on the next use.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    gateway = startWsFakeGateway({ version: "2026.9.36", policy: { ...CAPTURED_HELLO_POLICY } });
    await gateway.ready;
    const finalized: unknown[][] = [];
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      addProvenancePart: async () => {},
      finalize: async (...args: unknown[]) => {
        finalized.push(args);
      },
      reportSessionMeta: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    } as unknown as ConvexWriter;
    const config = {
      openclawGatewayUrl: gateway.url,
      openclawToken: "t",
      deviceIdentity: deviceIdentity(),
    } as unknown as BridgeConfig;
    const routing = { chatId: "c1", openclawChatId: "oc1", agentId: "a", canonical: "alice" };
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    try {
      const s = await reg.acquire(routing);
      await sleep(20);
      await s.runManager.beginTurn(1000, "run-1");
      s.wake();
      await sleep(5);
      const socketsBefore = gateway.upgradeCount;
      expect(s.connection.isClosed).toBe(false);

      interval();
      interval();
      interval();
      confirm();
      expect(s.connection.isClosed).toBe(true);
      expect((s.connection as OpenClawConnection).connectionEnd?.kind).toBe("inbound_silence");
      await sleep(20);
      // Not finalized by the bridge, and marked as a stream with a hole.
      expect(finalized).toEqual([]);
      expect(s.runManager.streamGapNoted).toBe(true);

      const again = await reg.acquire(routing);
      expect(again).not.toBe(s);
      expect(again.connection.isClosed).toBe(false);
      expect(gateway.upgradeCount).toBeGreaterThan(socketsBefore);
    } finally {
      reg.closeAll();
    }
  });
});
