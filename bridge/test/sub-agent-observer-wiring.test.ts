/**
 * WIRING test — the load-bearing guarantee of increment 1: a sub-agent child
 * frame arriving AFTER the parent turn has FINALIZED still updates the store.
 *
 * This drives the REAL Session.consume loop (not the observer in isolation), so it
 * catches the regression the feature exists to prevent: if `observe()` were ever
 * gated behind the parent turn's `sink.active`/finalized state, the gap silently
 * reopens — the child's progress + result (which arrive after the parent ends) are
 * lost. The fixture's natural ordering has the child finishing FIRST; this test
 * deliberately synthesizes the OPPOSITE order (parent final, THEN child final) —
 * the ordering that is the whole reason the monitor exists.
 *
 * Uses a controllable fake connection (push frames into the consume loop) + a
 * recording ConvexWriter, mirroring the session-liveness harness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import type { ConvexWriter, SubAgentRecord } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "../src/providers/openclaw/session-keys.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A connection whose frames() iterator yields frames pushed via `push`, and
 *  completes on `close`. Lets the test feed the consume loop one frame at a time. */
function fakeConnQueue() {
  let closed = false;
  const buffer: unknown[] = [];
  let pending: ((r: IteratorResult<unknown>) => void) | null = null;
  const iterator: AsyncIterator<unknown> = {
    next() {
      if (buffer.length) {
        return Promise.resolve({ value: buffer.shift(), done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
  };
  return {
    push(frame: unknown) {
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: frame, done: false });
      } else {
        buffer.push(frame);
      }
    },
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: undefined, done: true });
      }
    },
    frames() {
      return iterator;
    },
    async request() {
      return { payload: {} };
    },
  };
}

/** Writer recording finalize() + upsertSubAgent() calls. */
function recordingWriter() {
  const finalized: unknown[][] = [];
  const subAgents: SubAgentRecord[] = [];
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => {},
    addToolPart: async () => {},
    addMedia: async () => {},
    addProvenancePart: async () => {},
    noteMediaUndelivered: async () => {},
    finalize: async (...args: unknown[]) => {
      finalized.push(args);
    },
    reportSessionMeta: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    upsertSubAgent: async (record: SubAgentRecord) => {
      subAgents.push(record);
    },
  } as unknown as ConvexWriter;
  return { writer, finalized, subAgents };
}

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "oc1",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sub-agent observation wiring (Session.consume)", () => {
  it("a child frame arriving AFTER the parent turn finalized STILL updates the store", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConnQueue() as never,
    );
    const { writer, finalized, subAgents } = recordingWriter();
    let now = 1000;
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    const conn = s.connection as unknown as ReturnType<typeof fakeConnQueue>;
    await tick(); // let the consume loop reach its first frame wait

    const parentKey = buildSessionKey(
      ROUTING.openclawChatId,
      ROUTING.agentId,
      ROUTING.canonical,
    );
    expect(s.sessionKey).toBe(parentKey);
    const childKey = "agent:alice:subagent:wiring-child";

    // Start the parent turn (mirrors performSend's post-ack sequence).
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await tick();

    // The parent's sessions_spawn tool result -> register the child (running).
    conn.push({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          name: "sessions_spawn",
          meta: "task do the thing, agent alice",
          result: { contentItems: [{ text: JSON.stringify({ childSessionKey: childKey, status: "accepted" }) }] },
        },
      },
    });
    await tick();

    // The PARENT turn FINALIZES (its own chat:final), BEFORE the child finishes.
    conn.push({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "I delegated it." }] },
      },
    });
    await tick();
    expect(finalized.length).toBe(1); // parent turn is closed
    expect(s.runManager.isFinalized).toBe(true);

    // NOW — after the parent reaped — the CHILD reports its final result.
    conn.push({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: childKey,
        runId: "child-run",
        spawnedBy: parentKey,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "CHILD_LATE_RESULT" }] },
      },
    });
    await tick();

    // The store was updated even though the parent turn had already finalized.
    const done = subAgents.find((r) => r.childSessionKey === childKey && r.status === "done");
    expect(done).toBeDefined();
    expect(done!.resultText).toBe("CHILD_LATE_RESULT");
    expect(done!.chatId).toBe("c1");
    // The registration (running) was also recorded earlier, with the task name.
    const running = subAgents.find((r) => r.status === "running");
    expect(running?.taskName).toBe("do the thing");

    reg.closeAll();
  });

  it("AWAITS the spawn registration before the next frame (parent finalize) — closes the spawn-upsert race (P1.2)", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConnQueue() as never,
    );
    // A writer whose REGISTRATION (running) upsert is gated on a manual deferral, so
    // we can observe whether the consume loop blocks on it before finalizing.
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((res) => {
      releaseRegistration = res;
    });
    const order: string[] = [];
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => {},
      addToolPart: async () => {},
      addMedia: async () => {},
      addProvenancePart: async () => {},
      noteMediaUndelivered: async () => {},
      finalize: async () => {
        order.push("finalize");
      },
      reportSessionMeta: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      upsertSubAgent: async (record: SubAgentRecord) => {
        if (record.status === "running") {
          order.push("registration:start");
          await registrationGate; // block the ORDERED registration write
          order.push("registration:commit");
        }
      },
    } as unknown as ConvexWriter;

    let now = 1000;
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    const conn = s.connection as unknown as ReturnType<typeof fakeConnQueue>;
    await tick();
    const parentKey = buildSessionKey(
      ROUTING.openclawChatId,
      ROUTING.agentId,
      ROUTING.canonical,
    );
    const childKey = "agent:alice:subagent:race-child";
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await tick();

    // Parent's sessions_spawn result → the registration upsert is AWAITED (gate blocks).
    conn.push({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          name: "sessions_spawn",
          meta: "task race, agent alice",
          result: {
            contentItems: [{ text: JSON.stringify({ childSessionKey: childKey }) }],
          },
        },
      },
    });
    await tick();
    // The parent's chat:final is queued BEHIND the spawn frame.
    conn.push({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "delegated" }] },
      },
    });
    await tick();

    // ORDERING PROOF: the loop is blocked on the registration commit, so finalize has
    // NOT run yet. (If the registration were fire-and-forget, finalize would already
    // have happened here — the race that mis-routes a follow-up into the child.)
    expect(order).toEqual(["registration:start"]);
    expect(s.runManager.isFinalized).toBe(false);

    // Release the registration → it commits, THEN the loop reads + finalizes.
    releaseRegistration();
    await tick();
    await tick();
    expect(order).toEqual([
      "registration:start",
      "registration:commit",
      "finalize",
    ]);
    expect(s.runManager.isFinalized).toBe(true);
    reg.closeAll();
  });

  it("a TTL-SWEPT child frees its registeredChildren key (no set leak); a still-running one does NOT (P3)", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConnQueue() as never,
    );
    const { writer, subAgents } = recordingWriter();
    let now = 1000; // SECONDS clock (the observer's TTL unit)
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    const conn = s.connection as unknown as ReturnType<typeof fakeConnQueue>;
    await tick();
    const parentKey = buildSessionKey(
      ROUTING.openclawChatId,
      ROUTING.agentId,
      ROUTING.canonical,
    );
    const childKey = "agent:alice:subagent:swept-child";
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await tick();

    // Register the child (running) — its key is ordered into registeredChildren.
    conn.push({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          name: "sessions_spawn",
          meta: "task swept, agent alice",
          result: { contentItems: [{ text: JSON.stringify({ childSessionKey: childKey }) }] },
        },
      },
    });
    await tick();
    // Parent turn finalizes; the child keeps running (no chat:final for it).
    conn.push({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "delegated" }] },
      },
    });
    await tick();
    // STILL RUNNING: the key is held (not removed) — the set tracks a live child.
    expect(s.registeredChildCount).toBe(1);

    // Advance the clock PAST the observer's TTL (default 15 min = 900s) and poke the
    // loop: nextTimeout collapses to 0 → the timeout branch runs the TTL sweep, which
    // terminalizes the silently-hung child (status:error).
    now = 1000 + 16 * 60; // +16 min > 15-min TTL
    s.wake();
    await tick();
    await tick();

    // The sweep emitted a terminal error for the child...
    const sweptErr = subAgents.find(
      (r) => r.childSessionKey === childKey && r.status === "error",
    );
    expect(sweptErr).toBeDefined();
    // ...AND its key was freed from registeredChildren (the P3 leak fix: the sweep path
    // now routes through the same cleanup). Regression guard: with the old bare flush,
    // this stays 1 forever and the set leaks across every timed-out child.
    expect(s.registeredChildCount).toBe(0);

    reg.closeAll();
  });

  it("a child of ANOTHER chat (foreign spawnedBy) is never written through this session", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConnQueue() as never,
    );
    const { writer, subAgents } = recordingWriter();
    let now = 1000;
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire(ROUTING);
    const conn = s.connection as unknown as ReturnType<typeof fakeConnQueue>;
    await tick();
    await s.runManager.beginTurn(now, "run-1");
    s.wake();
    await tick();

    // A child frame whose spawnedBy belongs to a DIFFERENT chat must be ignored.
    conn.push({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:alice:subagent:foreign",
        runId: "x",
        spawnedBy: "agent:alice:atrium:chat:someone:OTHER",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "LEAK" }] },
      },
    });
    await tick();

    expect(subAgents).toHaveLength(0);
    reg.closeAll();
  });
});
