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

  it("WITHOUT wake (reproduces the bug): the idle-blocked loop never sees the armed deadline and the turn hangs", async () => {
    vi.useFakeTimers();
    let now = 1000;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(config, writer, () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);

    // Arm the turn but DO NOT wake the loop (the pre-fix behavior).
    await s.runManager.beginTurn(now, "run-1");
    // Even advancing time massively, the loop is blocked on a null-timeout frame
    // wait it computed BEFORE beginTurn — it installed no timer, so nothing fires.
    now += 100_000;
    await vi.advanceTimersByTimeAsync(1_000_000);

    expect(finalized.length).toBe(0); // hung in "streaming" — the bug
    reg.closeAll();
  });
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
