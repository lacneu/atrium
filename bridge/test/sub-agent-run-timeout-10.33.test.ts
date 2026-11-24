/**
 * A child cut off by its time limit on OpenClaw 2026.10.33, as the bridge reads it.
 *
 * 2026.9.36 ended such a run with a plain `chat` final, then published `subagent-status`
 * `status:"timeout"`: the session row said it. On 2026.10.33 a run cut off WHILE A TOOL IS
 * EXECUTING ends in error (src/agents/embedded-agent-runner/run/terminal-timeout.ts:35-60)
 * and the row settles as `interrupted` (src/gateway/session-lifecycle-state.ts:196-212) —
 * the word a gateway restart leaves too. The registry's `subagent-status` is published by
 * its own `agent.wait` timer, which is not ordered against the run's end
 * (src/agents/subagents/registry/subagent-registry-run-wait.ts:273-316): captured ~300 ms
 * BEFORE it, so it reads `running`.
 *
 * Two facts the bridge hands on, and nothing else:
 *   - the row, as read after each `sessions.changed` (the follower) — the late `running`
 *     is replaced by the read the run's `agent.input.settled` triggers;
 *   - the run whose own terminal the gateway classed as a timeout: `errorKind:"timeout"`
 *     on the child's `chat` error (src/gateway/server-chat.ts:509-514), under the run id
 *     the row then carries as `lastRunId`.
 *
 * Frames: bridge/test/fixtures/subagent-run-timeout-2026.10.33.json (bench run
 * 2026-11-24T21-28-40-832Z, scenario settle-chain-no-synthesis), in the order received.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { ChildRowStatus, type RowRequester } from "../src/providers/openclaw/child-row-status.js";
import {
  SessionEventsHub,
  type SessionEventsConnection,
} from "../src/providers/openclaw/session-events.js";
import { SubAgentObserver } from "../src/providers/openclaw/sub-agent-observer.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import type { SubAgentRowStatusRecord, SubAgentRowStatusResult } from "../src/convex-writer.js";

type Captured = {
  line: number;
  connection: "session-events" | "conversation";
  frame: GatewayFrame & { payload: Record<string, any> };
};
const FRAMES = (
  JSON.parse(
    readFileSync(new URL("./fixtures/subagent-run-timeout-2026.10.33.json", import.meta.url), "utf8"),
  ) as { frames: Captured[] }
).frames;
const at = (line: number): Captured["frame"] => {
  const found = FRAMES.find((f) => f.line === line);
  if (found === undefined) throw new Error(`no captured frame at line ${line}`);
  return structuredClone(found.frame);
};

const STATUS_BEFORE_END = at(1625); // sessions.changed, reason subagent-status
const LIFECYCLE_ERROR = at(1641);
const CHAT_ERROR = at(1645);
const SETTLED = at(1649); // sessions.changed, reason agent.input.settled
const CHILD = CHAT_ERROR.payload.sessionKey as string;
const PARENT = CHAT_ERROR.payload.spawnedBy as string;
const RUN = CHAT_ERROR.payload.runId as string;

describe("the capture itself (what 2026.10.33 sends)", () => {
  it("publishes the registry's status before the run ends, and never says `timeout` on a row", () => {
    expect(FRAMES.map((f) => f.line)).toEqual([...FRAMES.map((f) => f.line)].sort((a, b) => a - b));
    expect(STATUS_BEFORE_END.payload).toMatchObject({
      reason: "subagent-status",
      status: "running",
      hasActiveRun: true,
      runtimeMs: 20000,
    });
    expect(LIFECYCLE_ERROR.payload.data).toMatchObject({
      phase: "error",
      aborted: false,
      timeoutPhase: "tool_execution",
    });
    expect(CHAT_ERROR.payload).toMatchObject({ state: "error", errorKind: "timeout" });
    expect(SETTLED.payload).toMatchObject({
      reason: "agent.input.settled",
      status: "interrupted",
      abortedLastRun: true,
      hasActiveRun: false,
      lastRunId: RUN,
    });
    const rows = FRAMES.map((f) => f.frame.payload?.session?.status ?? f.frame.payload?.status);
    expect(rows.filter((s) => s !== undefined)).not.toContain("timeout");
  });
});

describe("the observer: the run the gateway classed as a timeout", () => {
  const terminal = (frame: Captured["frame"]) => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(at(1641), 1, null, "msgA");
    return obs.observe(frame, 2, null, "msgA").find((u) => u.childSessionKey === CHILD && u.status === "error");
  };

  it("names the run of the captured `chat` error", () => {
    const term = terminal(CHAT_ERROR);
    expect(term).toMatchObject({ status: "error", errorCode: "timeout", timedOutRunId: RUN });
  });

  it("only the gateway's own class names it — never the sentence", () => {
    // The same sentence ("Tool execution timed out…") without the class names no run.
    const withoutKind = structuredClone(CHAT_ERROR);
    delete withoutKind.payload.errorKind;
    expect(terminal(withoutKind)?.timedOutRunId).toBeUndefined();
    const otherKind = structuredClone(CHAT_ERROR);
    otherKind.payload.errorKind = "rate_limit";
    expect(terminal(otherKind)?.timedOutRunId).toBeUndefined();
  });

  it("a run id that is not one is not forwarded", () => {
    const bad = structuredClone(CHAT_ERROR);
    bad.payload.runId = "announce:requester-settle:alice:x";
    const term = terminal(bad);
    expect(term?.errorCode).toBe("timeout");
    expect(term?.timedOutRunId).toBeUndefined();
  });
});

/** The instance's session-events socket: frames pushed by the test. */
function eventsConnection() {
  const queue: GatewayFrame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const conn: SessionEventsConnection & { push(f: GatewayFrame): void } = {
    gatewayVersion: "2026.10.33",
    onFrameGap: null,
    get isClosed() {
      return closed;
    },
    async request() {
      return {};
    },
    async *frames() {
      while (!closed) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => (wake = r));
      }
    },
    close() {
      closed = true;
      wake?.();
    },
    push(f) {
      queue.push(f);
      const w = wake;
      wake = null;
      w?.();
    },
  };
  return conn;
}

describe("the follower: the late `running` does not stand", () => {
  it("each captured `sessions.changed` is followed by a read; the last one written is the settled row", async () => {
    // The gateway answers a `sessions.describe` with the row it held at that moment: the
    // captured responses, in order (lines 1626, 1640, 1651).
    let held = at(1626).payload.session as Record<string, unknown>;
    const gateway: RowRequester = {
      async request(method) {
        return method === "sessions.describe" ? { payload: { session: held } } : { payload: {} };
      },
    };
    const written: SubAgentRowStatusRecord[] = [];
    const conn = eventsConnection();
    const hub = new SessionEventsHub({ instanceName: "prod", connect: async () => conn, log: () => {} });
    const follower = new ChildRowStatus({
      chatId: "chat1",
      parentSessionKey: PARENT,
      gateway,
      write: async (record): Promise<SubAgentRowStatusResult> => {
        written.push(record);
        return { applied: true, display: "x" } as SubAgentRowStatusResult;
      },
      events: hub,
      log: () => {},
    });
    follower.track(CHILD);
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const settle = async () => {
      const before = written.length;
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(before));
      await new Promise((r) => setTimeout(r, 0));
    };
    conn.push(STATUS_BEFORE_END);
    await settle();
    expect(written.at(-1)).toMatchObject({ status: "running", hasActiveRun: true });

    held = at(1640).payload.session as Record<string, unknown>;
    conn.push(at(1639));
    await settle();
    expect(written.at(-1)).toMatchObject({ status: "running", hasActiveRun: true });

    held = at(1651).payload.session as Record<string, unknown>;
    conn.push(SETTLED);
    await settle();
    expect(written.at(-1)).toEqual({
      chatId: "chat1",
      childSessionKey: CHILD,
      status: "interrupted",
      hasActiveRun: false,
      runId: RUN,
      snapshotAt: 1795556349871,
      parentKey: PARENT,
    });
    follower.close();
    hub.stop();
  });
});
