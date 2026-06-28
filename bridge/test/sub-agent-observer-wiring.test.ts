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
        spawnedBy: "agent:alice:webchat:chat:someone:OTHER",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "LEAK" }] },
      },
    });
    await tick();

    expect(subAgents).toHaveLength(0);
    reg.closeAll();
  });
});
