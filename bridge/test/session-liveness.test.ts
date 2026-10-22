/**
 * Codex review #11 (P1) — STUCK-STREAM liveness. The consume loop computes its
 * timeout at the TOP of each iteration, then blocks in raceWithTimeout. On a fresh
 * (idle) session the normalizer has no deadline, so the loop blocks with a NULL
 * timeout (wait forever for a frame). `performSend` then calls
 * `runManager.beginTurn()` — which arms the recv/grace deadline INSIDE the
 * normalizer, but from OUTSIDE the loop. Without a wake, the loop never re-reads
 * nextTimeout: if the gateway sends nothing further (or the whole reply already
 * arrived in the pre-ack buffer), `tick()` never runs and the assistant message
 * hangs in "streaming" forever (the recv guard never fires). This is the upstream
 * cause of the "stuck thinking" stream the watchdog cron mitigates downstream.
 *
 * The fix: `session.wake()` (called by performSend right after beginTurn) prods
 * the loop to re-evaluate nextTimeout and install the recv timer. Its expiry never
 * ends the turn: the silence asks the transcript (a reconciler read), and the run's
 * durable rows or its live terminal end it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry, IDLE_SESSION_TTL_SECONDS } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";

/** Fake connection whose frames() NEVER yields — models "gateway sends nothing
 *  after the ack" (or "the whole reply arrived in the pre-ack buffer"). Completes
 *  only on close. */
function fakeConn() {
  let closed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      release();
    },
    async request() {
        return { payload: {} };
      },
      onConfigChanged: () => () => {},
      onSessionSharing: () => () => {},
      onClosed: () => () => {},
      async *frames() {
      await gate; // never yields a frame
    },
  };
}

/** Writer stub recording finalize() calls (the proof the turn closed). */
function fakeWriter() {
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
  return { writer, finalized };
}

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "oc1",
  agentId: "a",
  canonical: "alice",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Session consume loop — stuck-stream liveness (beginTurn wake)", () => {
  it("WITH wake: an idle-blocked loop installs the recv deadline; its expiry reads the transcript, never ends the turn", async () => {
    vi.useFakeTimers();
    let now = 1000;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    const reads = vi.spyOn(s.transcriptShadow!, "requestRead");
    // Let the consumer loop reach its first (null-timeout) frame wait.
    await vi.advanceTimersByTimeAsync(0);

    // Simulate performSend's post-ack sequence: arm the turn, THEN wake the loop.
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await vi.advanceTimersByTimeAsync(0); // loop re-evaluates -> installs recv timer

    // No frame will ever arrive. Move the logical clock past the recv deadline and
    // fire the loop's installed timer (BASE_RECV_TIMEOUT = 240s).
    now += 300;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).toHaveBeenCalledWith("silence");
    // …and the silence budget restarts: a longer silence asks again, once per budget.
    now += 300;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads.mock.calls.filter((c) => (c as unknown[])[0] === "silence").length).toBe(2);
    expect(finalized.length).toBe(0); // no turn ends on a timer
    reg.closeAll();
  });

  // NOTE: the paired "WITHOUT wake" bug-characterization test was removed — it
  // never called wake(), so reverting the wake() fix left its assertion unchanged
  // (no fix-discriminating power) and it would break on a benign future self-heal.
  // The "WITH wake" test above is the discriminating regression gate for the fix.
});

// Mars robustness — a throw in the consume loop's own machinery (NOT inside the
// feed/tick try/catch) used to become an UNHANDLED REJECTION (the loop is started
// with a bare `void this.consume()`), which kills the whole bridge process. The
// guard wraps the loop: it logs and CLOSES the connection so the session self-heals
// (SessionRegistry.acquire reconnects on the next send) instead of taking the
// process down. A single error must never invalidate the bridge.
/** Connection whose frames() blocks until `crash(err)` is called, which makes the
 *  async iterator THROW — modeling a throw in the loop machinery while a turn may
 *  be mid-flight. */
function fakeConnControllable() {
  let closed = false;
  let rejectGate: (e: Error) => void = () => {};
  const gate = new Promise<never>((_, rej) => {
    rejectGate = rej;
  });
  return {
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
    },
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: () => () => {},
    async *frames(): AsyncGenerator<never> {
      await gate; // rejects when crash() is called -> the generator throws
    },
    crash(err: Error) {
      rejectGate(err);
    },
    async request() {
      return { payload: {} };
    },
  };
}

describe("Session never mints gatewayPreempted through the real wiring", () => {
  // The flag was retired on every gateway version (2026-09-14, see
  // TurnSink.flushFinal). This feeds the historical incident shape to the RunManager
  // the SESSION built (connection acquired through the registry, the manager wired by
  // Session itself — the consume loop is not exercised, the frame is fed directly), not
  // a hand-built one, so a re-introduction wired from the session side — a version
  // getter, a policy knob — fails here and not only in preempt-flag.test.ts. The
  // finalize itself is asserted first: an absent finalize must never read as "unflagged".
  const abortedRpc = {
    type: "event",
    event: "chat",
    payload: {
      runId: "run-1",
      sessionKey: "agent:a:atrium:chat:alice:oc1",
      state: "aborted",
      stopReason: "rpc",
    },
  };

  async function preemptedFor(gatewayVersion: string | null): Promise<unknown> {
    const conn = { ...fakeConn(), gatewayVersion };
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    // The aborted finalize path reaches writer methods the minimal fakeWriter above does
    // not define (recordGatewayPressure…). Every other method is an inert no-op; `then`
    // stays undefined so the proxy is never mistaken for a promise.
    const finalized: unknown[][] = [];
    const writer = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "then") return undefined;
          if (prop === "finalize") {
            return async (...args: unknown[]) => {
              finalized.push(args);
            };
          }
          if (prop === "startAssistant") return async () => "msg-1";
          if (prop === "setSnapshot" || prop === "addMedia") return async () => true;
          if (prop === "getRehydrationContext") {
            return async () => ({ history: null, turnCount: 0 });
          }
          return async () => {};
        },
      },
    ) as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const s = await reg.acquire(ROUTING);
    const key = (s as unknown as { sessionKey: string }).sessionKey;
    await s.runManager.beginTurn(1001, "run-1");
    // Content first: the turn's bubble is born from its run, and the finalize below must
    // be a real one (a zero-content abort leaves no bubble to finalize at all).
    await s.runManager.feed(
      { type: "event", event: "chat", payload: { runId: "run-1", sessionKey: key, state: "delta", deltaText: "Un début" } },
      1001.5,
    );
    await s.runManager.feed({ ...abortedRpc, payload: { ...abortedRpc.payload, sessionKey: key } }, 1002);
    reg.closeAll();
    // Exactly ONE finalize, of status `aborted`, and only then the absence of the flag:
    // without the first two checks a lost frame or a removed finalize() would pass.
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.[1]).toBe("aborted");
    const opts = finalized[0]?.[5] as { gatewayPreempted?: boolean } | undefined;
    expect(opts?.gatewayPreempted).toBeUndefined();
    return opts?.gatewayPreempted === true;
  }

  it("a 2026.7.1 connection finalizes the historical race shape aborted, unflagged", async () => {
    expect(await preemptedFor("2026.7.1")).toBe(false);
  });

  it("…and so do a 2026.9.4 connection and one that reported no version", async () => {
    expect(await preemptedFor("2026.9.4")).toBe(false);
    expect(await preemptedFor(null)).toBe(false);
  });
});

describe("Session consume loop — crash self-heal (Mars robustness)", () => {
  it("an immediate loop crash CLOSES the connection (so acquire reconnects) and does NOT crash the process", async () => {
    const conn = fakeConnControllable();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => conn as never,
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);

    const s = await reg.acquire(ROUTING);
    await new Promise((r) => setTimeout(r, 5)); // loop reaches its frame wait
    conn.crash(new Error("frames machinery exploded")); // no active turn yet
    // (If the guard were missing, vitest would surface an unhandled rejection.)
    await new Promise((r) => setTimeout(r, 20));

    expect(s.connection.isClosed).toBe(true); // self-heal: next acquire reconnects
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("consume loop crashed")),
    ).toBe(true);
    reg.closeAll();
  });

  it("a crash WHILE A TURN IS MID-FLIGHT finalizes it as aborted (no stuck 'streaming')", async () => {
    const conn = fakeConnControllable();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => conn as never,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);

    const s = await reg.acquire(ROUTING);
    await new Promise((r) => setTimeout(r, 5));
    // A turn is now in flight (the UI shows "streaming")...
    await s.runManager.beginTurn(1000, "run-1");
    // ...and the consume loop's machinery throws.
    conn.crash(new Error("iterator exploded mid-turn"));
    await new Promise((r) => setTimeout(r, 20));

    expect(finalized.length).toBeGreaterThan(0); // turn finalized -> UI not stuck
    expect(s.connection.isClosed).toBe(true); // and self-healed
    reg.closeAll();
  });

  it("closes the connection BEFORE awaiting the (slow) turn finalize, so a concurrent acquire can't reuse the dead-consumer session", async () => {
    const conn = fakeConnControllable();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => conn as never,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    // finalize() HANGS until released — models slow Convex writes during recovery.
    const { writer } = fakeWriter();
    let releaseFinalize: () => void = () => {};
    (writer as unknown as { finalize: () => Promise<void> }).finalize = () =>
      new Promise<void>((r) => {
        releaseFinalize = r;
      });
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);

    const s = await reg.acquire(ROUTING);
    await new Promise((r) => setTimeout(r, 5));
    await s.runManager.beginTurn(1000, "run-1");
    conn.crash(new Error("iterator exploded mid-turn"));
    await new Promise((r) => setTimeout(r, 20)); // recovery: close() THEN await finalize (hung)

    // The finalize is still pending, yet the connection is ALREADY closed — so
    // SessionRegistry.acquire would drop this session and reconnect, never hand
    // its dead consumer to a new /send (which would hang in "streaming").
    expect(s.connection.isClosed).toBe(true);
    releaseFinalize();
    reg.closeAll();
  });
});

describe("SessionRegistry — idle-session sweeper (FD-leak reaping)", () => {
  // UNIT GUARD: the Clock is in SECONDS, so the TTL must be too. We assert the
  // concrete value (900 = 15 min) and drive the boundary in SECONDS — re-introducing
  // a milliseconds TTL (the codex P1 regression: reap horizon ~10 days) flips both
  // the value pin AND the "reaped just past 15 min" expectation to failure.
  it("the TTL is 15 minutes expressed in SECONDS (matches the Clock unit)", () => {
    expect(IDLE_SESSION_TTL_SECONDS).toBe(15 * 60);
  });

  it("reaps a session idle beyond the TTL and CLOSES its connection (no socket leak)", async () => {
    const start = 1000; // seconds
    const fifteenMinutes = 15 * 60; // 900 seconds of idle wall-clock
    let now = start;
    const conn = fakeConn();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING); // lastActivityAt = start (seconds)
    // At exactly 15 min idle: NOT yet reaped (strictly greater).
    expect(reg.reapStaleSessions(start + fifteenMinutes)).toBe(0);
    expect(s.connection.isClosed).toBe(false);
    // One second past 15 min with no activity: reaped + the socket/FD is closed.
    expect(reg.reapStaleSessions(start + fifteenMinutes + 1)).toBe(1);
    expect(s.connection.isClosed).toBe(true);
    reg.closeAll();
  });

  it("reaps a CLOSED husk immediately, regardless of idle time (crashed/dropped connection)", async () => {
    let now = 1000;
    const conn = fakeConn();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    await reg.acquire(ROUTING);
    conn.close(); // the gateway dropped it -> a husk that would otherwise linger
    expect(reg.reapStaleSessions(now)).toBe(1); // reaped now, not after the TTL
    reg.closeAll();
  });

  it("a send (re-acquire) keeps a session warm so an active conversation is NOT reaped", async () => {
    let now = 1000;
    const conn = fakeConn();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    await reg.acquire(ROUTING);
    now = 1000 + IDLE_SESSION_TTL_SECONDS - 1;
    await reg.acquire(ROUTING); // a fresh send touches lastActivityAt = now
    // The FIRST idle window elapsed, but the touch reset the clock -> not idle.
    expect(reg.reapStaleSessions(now + 1)).toBe(0);
    reg.closeAll();
  });
});

describe("close mid-turn: left to the transcript (CU-22), never settled by the bridge", () => {
  it("a close mid-turn marks the turn's stream as incomplete", async () => {
    // Whatever the gateway sent before the close is gone, so an absence in this turn's
    // stream — no lifecycle start, say — can no longer prove that nothing ran.
    vi.useFakeTimers();
    const now = 1000;
    const conn = fakeConn();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runManager.streamGapNoted).toBe(false);
    conn.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runManager.streamGapNoted).toBe(true);
    reg.closeAll();
  });

  it("the turn is neither finalized nor polled for: the next read (a send's, or `/resume`) settles it", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const conn = fakeConn();
    const connect = vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    const connectsBefore = connect.mock.calls.length;
    conn.close();
    for (let i = 0; i < 30; i++) {
      now += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(finalized.length).toBe(0);
    expect(connect.mock.calls.length).toBe(connectsBefore); // no recovery connection
    reg.closeAll();
  });
});
