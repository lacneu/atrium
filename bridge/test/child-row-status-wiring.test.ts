// The session-row follower on the REAL Session (0.101.4), projection `off` (the default:
// no /send switched it on). The child is registered by its spawn result, followed on the
// instance's session-events connection, its row reread when its run ends on the
// conversation socket — and when that socket drops while the child is ending, the new
// socket relists the parent's children and writes the row the gateway now holds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./helpers/sleep.js";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import type {
  ConvexWriter,
  SubAgentRecord,
  SubAgentRowStatusRecord,
} from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "../src/providers/openclaw/session-keys.js";

type Rows = Map<string, Record<string, unknown>>;

/** A conversation socket: frames pushed by the test; rows answered from `rows`. */
function conversationSocket(rows: Rows, parentKey: () => string) {
  let closed = false;
  const buffer: unknown[] = [];
  let pending: ((r: IteratorResult<unknown>) => void) | null = null;
  const closedListeners: Array<() => void> = [];
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    push(frame: unknown) {
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: frame, done: false });
      } else buffer.push(frame);
    },
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      for (const l of closedListeners.splice(0)) l();
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: undefined, done: true });
      }
    },
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: (l: () => void) => {
      closedListeners.push(l);
      return () => {};
    },
    frames() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => (pending = resolve));
        },
      };
    },
    async request(method: string, params: Record<string, unknown>) {
      calls.push([method, params]);
      if (method === "sessions.describe") return { payload: { session: rows.get(params.key as string) ?? null } };
      if (method === "sessions.list") {
        return {
          payload: {
            sessions: [...rows.values()].filter((r) => r.spawnedBy === parentKey()),
          },
        };
      }
      return { payload: {} };
    },
  };
}

/** The instance's session-events socket. */
function eventsSocket() {
  let closed = false;
  let wake: (() => void) | null = null;
  return {
    gatewayVersion: "2026.9.33",
    onFrameGap: null,
    get isClosed() {
      return closed;
    },
    async request() {
      return { payload: {} };
    },
    async *frames() {
      while (!closed) await new Promise<void>((r) => (wake = r));
    },
    close() {
      closed = true;
      wake?.();
    },
  };
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

describe("ChildRowStatus on the real Session (projection off)", () => {
  it("a reconnection while the child ends: the new socket relists and writes the row's timeout", async () => {
    const parentKey = buildSessionKey(ROUTING.openclawChatId, ROUTING.agentId, ROUTING.canonical);
    const childKey = "agent:files:subagent:wiring-child";
    const rows: Rows = new Map();
    const conversations: Array<ReturnType<typeof conversationSocket>> = [];
    const events = eventsSocket();
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async (...args: unknown[]) => {
      const caps = (args[7] as readonly string[] | undefined) ?? [];
      if (caps.includes("session-scoped-events")) return events as never;
      const c = conversationSocket(rows, () => parentKey);
      conversations.push(c);
      return c as never;
    });
    const upserts: SubAgentRecord[] = [];
    const rowWrites: SubAgentRowStatusRecord[] = [];
    const reconciles: Array<[string, string, string[]]> = [];
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      upsertSubAgent: async (r: SubAgentRecord) => void upserts.push(r),
      missingSubAgentRows: async (chat: string, parent: string, keys: string[]) => {
        reconciles.push([chat, parent, keys]);
        return [];
      },
      applySubAgentRowStatus: async (r: SubAgentRowStatusRecord) => {
        rowWrites.push(r);
        return { applied: true as const, display: r.status ?? "unknown" };
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const hub = reg.sessionEventsFor("primary", config);

    const s1 = await reg.acquire(ROUTING);
    await sleep(5);
    const conv1 = conversations[0]!;
    // A new socket relists the parent's children (none yet).
    expect(conv1.calls.filter(([m]) => m === "sessions.list")).toEqual([
      [
        "sessions.list",
        {
          spawnedBy: parentKey,
          limit: 100,
          includeGlobal: false,
          includeUnknown: false,
          configuredAgentsOnly: true,
        },
      ],
    ]);

    // The complete (empty) list is reported to Convex for this conversation's parent.
    expect(reconciles).toEqual([["c1", parentKey, []]]);

    // The spawn result registers the child; it is followed on the session-events socket.
    rows.set(childKey, { key: childKey, spawnedBy: parentKey, status: "running", hasActiveRun: true, snapshotAt: 10 });
    await s1.runManager.beginTurn(1000, "run-1");
    s1.wake();
    conv1.push({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: parentKey,
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          name: "sessions_spawn",
          meta: "task wait, agent files",
          result: { contentItems: [{ text: JSON.stringify({ childSessionKey: childKey, status: "accepted" }) }] },
        },
      },
    });
    await sleep(20);
    expect(hub.attachedKeys).toContain(childKey);
    expect(rowWrites.map((w) => w.status)).toEqual(["running"]);

    // The child's run ends on the conversation socket (a plain final): content from the
    // frame, status from the row read right after.
    rows.set(childKey, { key: childKey, spawnedBy: parentKey, status: "done", hasActiveRun: false, lastRunId: "child-run", snapshotAt: 20 });
    conv1.push({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: childKey,
        runId: "child-run",
        spawnedBy: parentKey,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "partial work" }] },
      },
    });
    await sleep(20);
    expect(upserts.find((u) => u.status === "done")?.resultText).toBe("partial work");
    expect(rowWrites.map((w) => w.status)).toEqual(["running", "done"]);

    // The socket drops; meanwhile the registry records the timeout — nobody hears it.
    conv1.close();
    await sleep(20);
    expect(hub.attachedKeys).not.toContain(childKey);
    rows.set(childKey, { key: childKey, spawnedBy: parentKey, status: "timeout", hasActiveRun: false, lastRunId: "child-run", updatedAt: Date.now(), snapshotAt: 30 });

    // A new socket: no memory inherited, the parent's children relisted.
    const s2 = await reg.acquire(ROUTING);
    expect(s2).not.toBe(s1);
    await sleep(20);
    expect(rowWrites.at(-1)).toEqual({
      chatId: "c1",
      childSessionKey: childKey,
      status: "timeout",
      hasActiveRun: false,
      runId: "child-run",
      snapshotAt: 30,
      parentKey: parentKey,
    });
    expect(hub.attachedKeys).toContain(childKey);
    expect(reconciles.at(-1)).toEqual(["c1", parentKey, [childKey]]);
    reg.closeAll();
    expect(hub.attachedKeys).toEqual([]);
  });
});
