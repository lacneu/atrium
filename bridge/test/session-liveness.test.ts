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
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
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

describe("Session consume loop — history recovery survives a wake (review #14 P1)", () => {
  it("a pre-ACK-buffered message-tool reply triggers sessions.get AFTER the wake", async () => {
    let now = 1000;
    const conn = fakeConnRecording();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
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

// FD-leak reaping (audit CRITICAL): each chat holds an open WebSocket/FD; an idle
// gateway socket stays open forever, so without reaping the bridge accumulates
// sockets until FD exhaustion takes down ALL chats. The sweeper closes + drops
// idle sessions and closed husks.
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

describe("close mid-turn = transcript recovery, then connection lost (never a user interruption)", () => {
  // The registry injects a transcript fetcher (its polls run on the mocked
  // OpenClawConnection.connect), so a close mid-turn STARTS recovery instead
  // of finalizing immediately — the gateway restart-recovery case (live CSV
  // 2026-07-04: a resumed run delivered its answer 7 min after the SIGTERM).

  it("recovers the RESUMED run's reply from the transcript and finalizes COMPLETE", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const conn = fakeConn();
    // First connect = the session socket; later connects = the recovery polls.
    // The transcript starts WITHOUT a reply (gateway rebooting), then the
    // resumed run finishes and the assistant entry appears.
    let transcriptReady = false;
    const pollConn = {
      get isClosed() {
        return false;
      },
      close() {},
      async *frames() {},
      async request(method: string) {
        expect(method).toBe("sessions.get");
        return {
          payload: {
            messages: [
              { role: "user", content: "analyse ça s'il te plaît" },
              ...(transcriptReady
                ? [{ role: "assistant", content: [{ text: "réponse reprise après redémarrage" }] }]
                : []),
            ],
          },
        };
      },
    };
    let first = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      if (first) {
        first = false;
        return conn as never;
      }
      return pollConn as never;
    });
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    s.noteTurnUserAnchor("analyse ça s'il te plaît");
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    // The gateway is SIGTERMed mid-turn.
    conn.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(finalized.length).toBe(0); // NOT settled — recovery is polling
    // Two polls come back empty (run still resuming)...
    now += 40_000;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(finalized.length).toBe(0);
    // ...then the resumed run finishes.
    transcriptReady = true;
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finalized.length).toBeGreaterThan(0);
    const last = finalized[finalized.length - 1] as unknown[];
    expect(last?.[1]).toBe("complete"); // the REAL answer, not an error
    expect(String(last?.[2] ?? "")).toContain("réponse reprise après redémarrage");
    reg.closeAll();
  });

  it("prefers a message-tool DELIVERY over the private ack when the resumed run used it", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const conn = fakeConn();
    const pollConn = {
      get isClosed() {
        return false;
      },
      close() {},
      async *frames() {},
      async request() {
        return {
          payload: {
            messages: [
              { role: "user", content: "question suffisamment longue" },
              {
                role: "toolResult",
                toolName: "message",
                content: [
                  {
                    text: JSON.stringify({
                      deliveryStatus: "sent",
                      channel: "webchat",
                      target: "current-run",
                      sourceReply: { text: "la VRAIE réponse livrée par le message-tool" },
                    }),
                  },
                ],
              },
              { role: "assistant", content: "Envoyé dans le webchat." },
            ],
          },
        };
      },
    };
    let first = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      if (first) {
        first = false;
        return conn as never;
      }
      return pollConn as never;
    });
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    s.noteTurnUserAnchor("question suffisamment longue");
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    conn.close();
    await vi.advanceTimersByTimeAsync(0);
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finalized.length).toBeGreaterThan(0);
    const last = finalized[finalized.length - 1] as unknown[];
    expect(last?.[1]).toBe("complete");
    expect(String(last?.[2] ?? "")).toContain("la VRAIE réponse livrée par le message-tool");
    expect(String(last?.[2] ?? "")).not.toContain("Envoyé dans le webchat");
    reg.closeAll();
  });

  it("rejects a STALE transcript (previous turn's reply) until the current turn appears", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const conn = fakeConn();
    let staleServed = 0;
    const pollConn = {
      get isClosed() {
        return false;
      },
      close() {},
      async *frames() {},
      async request() {
        staleServed++;
        if (staleServed < 2) {
          // Mid-reboot: the transcript still predates the current turn.
          return {
            payload: {
              messages: [
                { role: "user", content: "ANCIENNE question" },
                { role: "assistant", content: "ANCIENNE réponse à ne jamais livrer" },
              ],
            },
          };
        }
        return {
          payload: {
            messages: [
              { role: "user", content: "question du tour COURANT" },
              { role: "assistant", content: "réponse reprise correcte" },
            ],
          },
        };
      },
    };
    let first = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      if (first) {
        first = false;
        return conn as never;
      }
      return pollConn as never;
    });
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    s.noteTurnUserAnchor("question du tour COURANT");
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    conn.close();
    await vi.advanceTimersByTimeAsync(0);
    // First poll serves the STALE transcript — must be rejected, nothing finalized.
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finalized.length).toBe(0);
    // Second poll serves the current-turn transcript — recovered.
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finalized.length).toBeGreaterThan(0);
    const last = finalized[finalized.length - 1] as unknown[];
    expect(last?.[1]).toBe("complete");
    expect(String(last?.[2] ?? "")).toContain("réponse reprise correcte");
    expect(String(last?.[2] ?? "")).not.toContain("ANCIENNE");
    reg.closeAll();
  });

  it("an ANCHOR-LESS turn (attachment-only) accepts only a transcript that GREW", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const conn = fakeConn();
    let served = 0;
    const pollConn = {
      get isClosed() {
        return false;
      },
      close() {},
      async *frames() {},
      async request() {
        served++;
        const base = [
          { role: "user", content: "" }, // attachment-only send
          { role: "assistant", content: "réponse du tour précédent" },
        ];
        // Polls 1-2: stale, constant transcript. Poll 3+: the resumed run grew it.
        return {
          payload: {
            messages:
              served < 3
                ? base
                : [...base, { role: "user", content: "" }, { role: "assistant", content: "réponse du run repris (pièce jointe)" }],
          },
        };
      },
    };
    let first = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      if (first) {
        first = false;
        return conn as never;
      }
      return pollConn as never;
    });
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    // NO anchor (attachment-only) — the structural baseline is the only guard.
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    conn.close();
    await vi.advanceTimersByTimeAsync(0);
    // Polls 1-2 (baseline + constant): nothing finalized — the stale reply is NEVER delivered.
    now += 40_000;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(finalized.length).toBe(0);
    // Poll 3: the transcript grew — the resumed reply is accepted.
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finalized.length).toBeGreaterThan(0);
    const last = finalized[finalized.length - 1] as unknown[];
    expect(last?.[1]).toBe("complete");
    expect(String(last?.[2] ?? "")).toContain("réponse du run repris");
    reg.closeAll();
  });

  it("settles as error(connection_lost) when no resumed reply ever appears (deadline)", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const conn = fakeConn();
    const emptyPollConn = {
      get isClosed() {
        return false;
      },
      close() {},
      async *frames() {},
      async request() {
        return { payload: { messages: [{ role: "user", content: "question" }] } };
      },
    };
    let first = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      if (first) {
        first = false;
        return conn as never;
      }
      return emptyPollConn as never;
    });
    const { writer, finalized } = fakeWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    await vi.advanceTimersByTimeAsync(0);
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await vi.advanceTimersByTimeAsync(0);
    conn.close();
    await vi.advanceTimersByTimeAsync(0);
    // Poll to the deadline (9 min) with no reply.
    for (let i = 0; i < 30; i++) {
      now += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(finalized.length).toBeGreaterThan(0);
    const last = finalized[finalized.length - 1] as unknown[];
    expect(last?.[1]).toBe("error"); // NOT "aborted"
    expect(String(last?.[3] ?? "")).toContain("connection_lost");
    reg.closeAll();
  });
});
