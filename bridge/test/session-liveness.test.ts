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
 * the loop to re-evaluate nextTimeout and install the recv timer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
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
    setSnapshot: async () => {},
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
  it("WITH wake: an idle-blocked loop installs the recv deadline and finalizes even if NO frame ever arrives", async () => {
    vi.useFakeTimers();
    let now = 1000;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(config, writer, () => now);
    const s = await reg.acquire(ROUTING);
    // Let the consumer loop reach its first (null-timeout) frame wait.
    await vi.advanceTimersByTimeAsync(0);

    // Simulate performSend's post-ack sequence: arm the turn, THEN wake the loop.
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await vi.advanceTimersByTimeAsync(0); // loop re-evaluates -> installs recv timer

    // No frame will ever arrive. Move the logical clock past the recv deadline and
    // fire the loop's installed timer (BASE_RECV_TIMEOUT = 180s).
    now += 300;
    await vi.advanceTimersByTimeAsync(300_000);

    expect(finalized.length).toBeGreaterThan(0); // turn closed — no stuck stream
    reg.closeAll();
  });

  // NOTE: the paired "WITHOUT wake" bug-characterization test was removed — it
  // never called wake(), so reverting the wake() fix left its assertion unchanged
  // (no fix-discriminating power) and it would break on a benign future self-heal.
  // The "WITH wake" test above is the discriminating regression gate for the fix.
});

// Codex review #14 (P1) — history recovery must survive the wake `continue`s.
// When the whole reply arrives in the pre-ACK buffer, beginTurn's replay arms
// wantsHistoryRecovery and then wake() makes the loop `continue`; the recovery
// check is the FIRST statement of the loop body so the `continue` does NOT skip
// it (pre-fix it sat at the loop bottom -> skipped -> the private_ack grace
// finalized a bare "Envoyé." before sessions.get could recover the delivered text).
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/openclaw_frames.json", import.meta.url), "utf-8"),
) as { run_id: string; scenarios: Record<string, { frames: unknown[] }> };

/** fakeConn that ALSO records `request(method)` so we can assert the recovery
 *  fetch (`sessions.get`) fired. frames() never yields (the whole reply was
 *  pre-ACK-buffered, replayed by beginTurn, not delivered through the loop). */
function fakeConnRecording() {
  let closed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const requests: string[] = [];
  return {
    requests,
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      release();
    },
    async *frames() {
      await gate;
    },
    async request(method: string) {
      requests.push(method);
      return { payload: {} }; // benign; recovery extracts no text -> logs, harmless
    },
  };
}

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

describe("Session consume loop — crash self-heal (Mars robustness)", () => {
  it("an immediate loop crash CLOSES the connection (so acquire reconnects) and does NOT crash the process", async () => {
    const conn = fakeConnControllable();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => conn as never,
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(config, writer, () => 1000);

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
    const reg = new SessionRegistry(config, writer, () => 1000);

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
    const reg = new SessionRegistry(config, writer, () => 1000);

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

describe("Session consume loop — history recovery survives a wake (review #14 P1)", () => {
  it("a pre-ACK-buffered message-tool reply triggers sessions.get AFTER the wake", async () => {
    let now = 1000;
    const conn = fakeConnRecording();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(config, writer, () => now);
    // Routing chosen so the session key matches the fixture, else the normalizer
    // filters the replayed frames as foreign-session.
    const s = await reg.acquire({
      chatId: "own-chat",
      openclawChatId: "own-chat",
      agentId: "main",
      canonical: "u-testuser01",
    });
    await new Promise((r) => setTimeout(r, 10)); // loop reaches its first (null) wait

    // Whole reply arrived in the pre-ACK buffer: arm, feed the message-tool item +
    // private-ack frames (sink inactive -> buffered), beginTurn replays them
    // (arming wantsHistoryRecovery), then wake the loop.
    s.runManager.armReplayBuffer();
    for (const frame of FIXTURES.scenarios["message-tool-item-then-private-ack"]!.frames) {
      await s.runManager.feed(frame, now);
    }
    await s.runManager.beginTurn(now, FIXTURES.run_id);
    s.wake();
    await new Promise((r) => setTimeout(r, 30)); // loop TOP checks recovery -> sessions.get

    expect(conn.requests).toContain("sessions.get");
    reg.closeAll();
  });
});
