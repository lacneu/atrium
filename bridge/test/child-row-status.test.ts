// A sub-agent's status is its SESSION ROW (0.101.4): the follower reads the child's row
// from the gateway on every trigger the Control UI refreshes on, and hands it to Convex
// as read. These tests drive the real SessionEventsHub with the frames captured on the
// 2026.9.33 bench, and pin the follower's bounds: coalescing, one deferred retry, a
// bounded set, a full release on close.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ChildRowStatus,
  FINISHED_CHILD_KEEP_MS,
  MAX_CHILD_LIST_PAGES,
  MAX_CHILD_LIST_PASSES,
  MAX_TRACKED_CHILDREN,
  ROW_READ_RETRY_LADDER_MS,
  ROW_READ_RETRY_MS,
  childSessionListQuery,
  rowStatusOf,
  type RowRequester,
} from "../src/providers/openclaw/child-row-status.js";
import {
  SessionEventsHub,
  type SessionEventsConnection,
} from "../src/providers/openclaw/session-events.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import type {
  SubAgentRowStatusRecord,
  SubAgentRowStatusResult,
} from "../src/convex-writer.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/subagent-status-timeout-2026.9.33.json", import.meta.url), "utf8"),
) as { frames: Array<{ frame: GatewayFrame & { payload: Record<string, unknown> } }> };
const [SETTLED, REGISTRY] = FIXTURE.frames.map((f) => f.frame) as [
  GatewayFrame & { payload: Record<string, unknown> },
  GatewayFrame & { payload: Record<string, unknown> },
];
const CHILD = SETTLED.payload.sessionKey as string;
const PARENT = SETTLED.payload.spawnedBy as string;

/** Manual timers: nothing fires until the test says so. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    setTimer(fn: () => void, ms: number) {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
    live: () => pending.filter((t) => !t.cancelled),
    /** Fire every live timer armed for exactly `ms`. */
    fire(ms: number) {
      for (const t of pending.filter((p) => !p.cancelled && p.ms === ms)) {
        t.cancelled = true;
        t.fn();
      }
    },
  };
}

/** The instance's session-events socket: frames pushed by the test. */
function fakeEventsConnection() {
  const queue: GatewayFrame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const conn: SessionEventsConnection & { push(f: GatewayFrame): void } = {
    gatewayVersion: "2026.9.33",
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

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A gateway whose `sessions.describe` answers the row the test sets, and records. */
function gateway(rowOf: (key: string) => unknown) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const requester: RowRequester = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === "sessions.describe") return { payload: { session: rowOf(params.key as string) } };
      return { payload: {} };
    },
  };
  return { requester, calls, describes: () => calls.filter(([m]) => m === "sessions.describe").length };
}

function writes() {
  const written: SubAgentRowStatusRecord[] = [];
  const write = async (r: SubAgentRowStatusRecord): Promise<SubAgentRowStatusResult> => {
    written.push(r);
    return { applied: true, display: r.status ?? "unknown" };
  };
  return { written, write };
}

describe("the captured 2026.9.33 timeout, through the real session-events hub", () => {
  it("each sessions.changed rereads the row; the last write is the registry's timeout, with its run and clock", async () => {
    const timers = manualTimers();
    const conn = fakeEventsConnection();
    const hub = new SessionEventsHub({
      instanceName: "primary",
      connect: async () => conn,
      setTimer: timers.setTimer,
      log: () => {},
    });
    // The row the gateway holds, moved as the bench saw it move.
    let row: unknown = { key: CHILD, status: "running", hasActiveRun: true, snapshotAt: 1 };
    const gw = gateway(() => row);
    const { written, write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: gw.requester,
      write,
      events: hub,
      setTimer: timers.setTimer,
      log: () => {},
    });
    follower.track(CHILD);
    await flush();
    // Subscribed: the child's row is read once (missed events are not replayed).
    expect(written.map((w) => w.status)).toEqual(["running"]);

    row = SETTLED.payload.session;
    conn.push(SETTLED);
    await flush();
    row = REGISTRY.payload.session;
    conn.push(REGISTRY);
    await flush();

    expect(written.map((w) => w.status)).toEqual(["running", "done", "timeout"]);
    expect(written.at(-1)).toEqual({
      chatId: "c1",
      childSessionKey: CHILD,
      status: "timeout",
      hasActiveRun: false,
      runId: "1355bb44-f5ea-4f60-b3e9-9dabbc490abf",
      snapshotAt: 1792448269766,
      parentKey: PARENT,
    });
    // The registry's timeout was sampled AFTER the settled `done` — the clock that orders
    // them (`updatedAt` is equal on both: it cannot).
    expect(written[1]!.snapshotAt).toBe(1792448269709);
    expect(SETTLED.payload.updatedAt).toBe(REGISTRY.payload.updatedAt);
    follower.close();
    hub.stop();
  });
});

describe("a reconnection while the hub is already subscribed for another conversation", () => {
  it("the correction published before the attachment is read once attached: the final write is the timeout", async () => {
    const conn = fakeEventsConnection();
    const hub = new SessionEventsHub({ instanceName: "primary", connect: async () => conn, log: () => {} });
    // Another conversation keeps the subscription live.
    const detachOther = hub.attach("agent:alice:atrium:chat:other", {
      onSessionMessage: () => {},
      onSessionsChanged: () => {},
      onSubscribed: () => {},
    });
    await flush();
    expect(hub.ready).toBe(true);
    // The list sampled `done`; the registry published `timeout` before this conversation
    // attached the child — a live subscription does not replay it.
    const settled = { ...(SETTLED.payload.session as Record<string, unknown>), updatedAt: Date.now() };
    const corrected = REGISTRY.payload.session as Record<string, unknown>;
    const requester: RowRequester = {
      async request(method) {
        if (method === "sessions.list") return { payload: { sessions: [settled] } };
        return { payload: { session: corrected } };
      },
    };
    const { written, write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, events: hub, log: () => {} });
    await follower.relistChildren();
    await flush();
    expect(written.map((w) => w.status)).toEqual(["done", "timeout"]);
    follower.close();
    detachOther();
    hub.stop();
  });
});

describe("ChildRowStatus bounds", () => {
  it("coalesces: one read in flight per child, at most one more after it", async () => {
    let release: (() => void) | null = null;
    let reads = 0;
    const requester: RowRequester = {
      async request() {
        reads++;
        await new Promise<void>((r) => (release = r));
        return { payload: { session: { key: CHILD, status: "done" } } };
      },
    };
    const { write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, log: () => {} });
    follower.runEnded(CHILD);
    for (let i = 0; i < 5; i++) follower.runEnded(CHILD);
    await flush();
    expect(reads).toBe(1);
    release!();
    await flush();
    expect(reads).toBe(2);
    release!();
    await flush();
    expect(reads).toBe(2);
  });

  it("a failed read: retried on a progressive capped ladder while followed — one timer, never a queue", async () => {
    const timers = manualTimers();
    let fail = true;
    let reads = 0;
    const requester: RowRequester = {
      async request() {
        reads++;
        if (fail) throw new Error("UNAVAILABLE");
        return { payload: { session: { key: CHILD, status: "timeout" } } };
      },
    };
    const { written, write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write,
      setTimer: timers.setTimer,
      log: () => {},
    });
    follower.runEnded(CHILD);
    await flush();
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const armed = timers.live();
      expect(armed).toHaveLength(1);
      steps.push(armed[0]!.ms);
      timers.fire(armed[0]!.ms);
      await flush();
    }
    expect(steps).toEqual([...ROW_READ_RETRY_LADDER_MS, 300_000, 300_000]);
    expect(reads).toBe(7);
    // A new event starts the ladder over…
    follower.runEnded(CHILD);
    await flush();
    expect(timers.live().map((t) => t.ms)).toEqual([ROW_READ_RETRY_MS]);
    // …and a success ends it.
    fail = false;
    timers.fire(ROW_READ_RETRY_MS);
    await flush();
    expect(written.map((w) => w.status)).toEqual(["timeout"]);
    expect(timers.live()).toEqual([]);
  });

  it("Convex unavailable for 45 s, then back, with NO new event: the terminal row is applied", async () => {
    const timers = manualTimers();
    let down = true;
    const requester: RowRequester = {
      async request() {
        return { payload: { session: { key: CHILD, status: "timeout", hasActiveRun: false, snapshotAt: 5 } } };
      },
    };
    const written: SubAgentRowStatusRecord[] = [];
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write: async (r) => {
        if (down) throw new Error("ingest 503");
        written.push(r);
        return { applied: true, display: "timeout" };
      },
      setTimer: timers.setTimer,
      log: () => {},
    });
    follower.runEnded(CHILD); // t = 0: fails
    await flush();
    timers.fire(30_000); // t = 30 s: still down
    await flush();
    expect(written).toEqual([]);
    down = false; // t = 45 s: Convex is back — no event comes
    timers.fire(60_000); // t = 90 s: the ladder's next step
    await flush();
    expect(written.map((w) => w.status)).toEqual(["timeout"]);
    expect(timers.live()).toEqual([]);
  });

  it("no retry timer survives close, eviction or a child no longer followed", async () => {
    const timers = manualTimers();
    const requester: RowRequester = {
      async request() {
        throw new Error("UNAVAILABLE");
      },
    };
    const { write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write,
      setTimer: timers.setTimer,
      maxTracked: 1,
      log: () => {},
    });
    follower.runEnded(CHILD);
    await flush();
    expect(timers.live()).toHaveLength(1);
    // Evicted by another child: its timer goes with it.
    follower.runEnded("agent:files:subagent:other");
    await flush();
    expect(follower.trackedKeys).toEqual(["agent:files:subagent:other"]);
    expect(timers.live()).toHaveLength(1);
    follower.close();
    expect(timers.live()).toEqual([]);
  });

  it("Convex has no row for the child yet: the read is retried once, not dropped", async () => {
    const timers = manualTimers();
    const requester: RowRequester = {
      async request() {
        return { payload: { session: { key: CHILD, status: "timeout" } } };
      },
    };
    const results: SubAgentRowStatusResult[] = [
      { applied: false, reason: "no_row" },
      { applied: true, display: "timeout" },
    ];
    let posts = 0;
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write: async () => results[posts++]!,
      setTimer: timers.setTimer,
      log: () => {},
    });
    follower.runEnded(CHILD);
    await flush();
    expect(posts).toBe(1);
    timers.fire(ROW_READ_RETRY_MS);
    await flush();
    expect(posts).toBe(2);
    expect(timers.live()).toEqual([]);
  });

  it("is bounded: a finished child leaves first, every eviction detaches from the hub", async () => {
    const attached = new Set<string>();
    const events = {
      attach(key: string) {
        attached.add(key);
        return () => attached.delete(key);
      },
    };
    let now = 0;
    const requester: RowRequester = {
      async request(_m, params) {
        const key = params.key as string;
        return { payload: { session: { key, status: key.endsWith(":0") ? "done" : "running" } } };
      },
    };
    const { write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write,
      events,
      now: () => now,
      log: () => {},
    });
    // 63 live children, then the newest one, finished.
    for (let i = 1; i < MAX_TRACKED_CHILDREN; i++) {
      now++;
      follower.track(`agent:files:subagent:${i}`);
    }
    now++;
    follower.runEnded("agent:files:subagent:0");
    await flush();
    for (let i = MAX_TRACKED_CHILDREN; i < MAX_TRACKED_CHILDREN + 3; i++) {
      now++;
      follower.track(`agent:files:subagent:${i}`);
    }
    expect(follower.trackedKeys.length).toBeLessThanOrEqual(MAX_TRACKED_CHILDREN);
    expect(attached.size).toBe(follower.trackedKeys.length);
    // The finished child leaves first though it is the most recently touched; then the
    // least recently touched live ones.
    expect(follower.trackedKeys).not.toContain("agent:files:subagent:0");
    expect(follower.trackedKeys).not.toContain("agent:files:subagent:1");
    expect(follower.trackedKeys).toContain("agent:files:subagent:3");
    expect(follower.trackedKeys).toContain(`agent:files:subagent:${MAX_TRACKED_CHILDREN + 2}`);
    follower.close();
    expect(attached.size).toBe(0);
    expect(follower.trackedKeys).toEqual([]);
  });

  it("a finished child leaves after its keep window, at the next admission", async () => {
    const attached = new Set<string>();
    const events = {
      attach(key: string) {
        attached.add(key);
        return () => attached.delete(key);
      },
    };
    let now = 0;
    const requester: RowRequester = {
      async request(_m, params) {
        return { payload: { session: { key: params.key, status: "done" } } };
      },
    };
    const { write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, events, now: () => now, log: () => {} });
    follower.runEnded(CHILD);
    await flush();
    now += FINISHED_CHILD_KEEP_MS - 1;
    follower.track("agent:files:subagent:b");
    expect(follower.trackedKeys).toContain(CHILD);
    now += 2;
    follower.track("agent:files:subagent:c");
    expect(follower.trackedKeys).not.toContain(CHILD);
    expect(attached.has(CHILD)).toBe(false);
  });

  it("close releases the session-events connection: an `off` instance's socket closes after its linger", async () => {
    const timers = manualTimers();
    const conn = fakeEventsConnection();
    const hub = new SessionEventsHub({
      instanceName: "primary",
      connect: async () => conn,
      setTimer: timers.setTimer,
      lingerMs: 30_000,
      log: () => {},
    });
    const gw = gateway(() => ({ key: CHILD, status: "running", hasActiveRun: true }));
    const { write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: gw.requester,
      write,
      events: hub,
      setTimer: timers.setTimer,
      log: () => {},
    });
    follower.track(CHILD);
    await flush();
    expect(hub.attachedKeys).toEqual([CHILD]);
    expect(hub.ready).toBe(true);
    follower.close();
    expect(hub.attachedKeys).toEqual([]);
    timers.fire(30_000);
    expect(conn.isClosed).toBe(true);
    // Nothing of the follower left armed.
    follower.runEnded(CHILD);
    await flush();
    expect(gw.describes()).toBe(1);
  });
});

describe("relisting a parent's children (a new conversation socket)", () => {
  it("asks the Control UI's query, writes each row, follows live and recent ones, and reads each followed row once attached", async () => {
    const now = 1_800_000_000_000;
    const calls: Array<[string, Record<string, unknown>]> = [];
    const listed: Array<Record<string, unknown>> = [];
    const requester: RowRequester = {
      async request(method, params) {
        calls.push([method, params]);
        if (method === "sessions.list") {
          return {
            payload: {
              sessions: listed,
            },
          };
        }
        return { payload: { session: listed.find((r) => r.key === params.key) ?? null } };
      },
    };
    listed.push(...[
                { key: "agent:files:subagent:live", spawnedBy: PARENT, status: "running", hasActiveRun: true, snapshotAt: 5 },
                { key: "agent:files:subagent:recent", spawnedBy: PARENT, status: "timeout", updatedAt: now - 60_000, lastRunId: "r1", snapshotAt: 5 },
                { key: "agent:files:subagent:old", spawnedBy: PARENT, status: "done", updatedAt: now - 7 * 3600_000, snapshotAt: 5 },
                { key: "agent:files:subagent:other", spawnedBy: "agent:alice:other", status: "running" },
    ]);
    const attached: string[] = [];
    const events = {
      attach(key: string, listener: { onSubscribed(): void }) {
        attached.push(key);
        listener.onSubscribed(); // a live subscription calls it synchronously
        return () => {};
      },
    };
    const { written, write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write,
      events,
      now: () => now,
      log: () => {},
    });
    await follower.relistChildren();
    await flush();
    expect(calls[0]).toEqual(["sessions.list", childSessionListQuery(PARENT)]);
    expect(childSessionListQuery(PARENT)).toEqual({
      spawnedBy: PARENT,
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    // Followed: the live and the recently finished. Written: every row of this parent,
    // the old one included.
    expect(attached).toEqual(["agent:files:subagent:live", "agent:files:subagent:recent"]);
    // (each followed row is written from the list, then once more from its read)
    expect([...new Set(written.map((w) => `${w.childSessionKey}=${w.status}`))].sort()).toEqual([
      "agent:files:subagent:live=running",
      "agent:files:subagent:old=done",
      "agent:files:subagent:recent=timeout",
    ]);
    expect(follower.trackedKeys).not.toContain("agent:files:subagent:old");
    // Each followed child is read once more after its attachment (a correction published
    // between the list and the attachment is not replayed by a live subscription).
    expect(calls.filter(([m]) => m === "sessions.describe").map(([, p]) => p.key)).toEqual([
      "agent:files:subagent:live",
      "agent:files:subagent:recent",
    ]);
  });

  it("a correction made 7 h ago while nobody listened is applied at reconnection (not followed)", async () => {
    const now = 1_800_000_000_000;
    const sevenHours = 7 * 3600_000;
    const requester: RowRequester = {
      async request(method) {
        if (method !== "sessions.list") return { payload: { session: null } };
        return {
          payload: {
            sessions: [
              { ...(REGISTRY.payload.session as Record<string, unknown>), updatedAt: now - sevenHours },
            ],
          },
        };
      },
    };
    const { written, write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, now: () => now, log: () => {} });
    await follower.relistChildren();
    expect(written).toEqual([rowStatusOf("c1", CHILD, REGISTRY.payload.session)]);
    expect(written[0]!.status).toBe("timeout");
    expect(follower.trackedKeys).toEqual([]);
  });

  it("walks every page as the Control UI does: a correction on page 2 is applied", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      key: `agent:files:subagent:p1-${i}`,
      spawnedBy: PARENT,
      status: "done",
      updatedAt: 0,
    }));
    const requester: RowRequester = {
      async request(_m, params) {
        calls.push(params);
        return params.offset === 100
          ? { payload: { sessions: [{ ...(REGISTRY.payload.session as Record<string, unknown>), updatedAt: 0 }], totalCount: 101, hasMore: false, nextOffset: null } }
          : { payload: { sessions: page1, totalCount: 101, hasMore: true, nextOffset: 100, offset: 0 } };
      },
    };
    const { written, write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, now: () => 1_800_000_000_000, log: () => {} });
    await follower.relistChildren();
    expect(calls).toEqual([childSessionListQuery(PARENT), childSessionListQuery(PARENT, 100)]);
    expect(calls[1]).toMatchObject({ offset: 100 });
    expect(written).toHaveLength(101);
    expect(written.find((w) => w.childSessionKey === CHILD)?.status).toBe("timeout");
  });

  it("a row that moved between pages: another pass, as upstream, finds the missing child", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const others = Array.from({ length: 100 }, (_, i) => ({
      key: `agent:files:subagent:o${i}`,
      spawnedBy: PARENT,
      status: "done",
      updatedAt: 0,
    }));
    const child = { ...(REGISTRY.payload.session as Record<string, unknown>), updatedAt: 0 };
    let pass = 0;
    const requester: RowRequester = {
      async request(_m, params) {
        calls.push(params);
        const offset = (params.offset as number | undefined) ?? 0;
        if (offset === 0) pass++;
        // Pass 1: the child (sorted by updatedAt) moves up while page 2 is read, so page 2
        // repeats a row of page 1. Pass 2: the child is on page 1.
        if (pass === 1) {
          return offset === 0
            ? { payload: { sessions: others, totalCount: 101, hasMore: true, nextOffset: 100 } }
            : { payload: { sessions: [others[99]], totalCount: 101, hasMore: false } };
        }
        return offset === 0
          ? { payload: { sessions: [child, ...others.slice(0, 99)], totalCount: 101, hasMore: true, nextOffset: 100 } }
          : { payload: { sessions: [others[99]], totalCount: 101, hasMore: false } };
      },
    };
    const { written, write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, now: () => 1_800_000_000_000, log: () => {} });
    await follower.relistChildren();
    expect(calls).toHaveLength(4);
    expect(written).toHaveLength(101);
    expect(written.find((w) => w.childSessionKey === CHILD)?.status).toBe("timeout");
  });

  it("passes are bounded as upstream's (4), and a list still short is retried once, deferred", async () => {
    const timers = manualTimers();
    let reads = 0;
    // Every pass brings a new key but never reaches the announced total.
    const requester: RowRequester = {
      async request() {
        reads++;
        return { payload: { sessions: [{ key: `agent:files:subagent:n${reads}`, spawnedBy: PARENT, status: "done", updatedAt: 0 }], totalCount: 50, hasMore: false } };
      },
    };
    const { write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, setTimer: timers.setTimer, log: () => {} });
    await follower.relistChildren();
    expect(reads).toBe(MAX_CHILD_LIST_PASSES);
    expect(timers.live().map((t) => t.ms)).toEqual([ROW_READ_RETRY_MS]);
  });

  it("without hasMore, pages by totalCount; a stalled or endless list is bounded", async () => {
    let reads = 0;
    const endless: RowRequester = {
      async request(_m, params) {
        reads++;
        const offset = (params.offset as number | undefined) ?? 0;
        return { payload: { sessions: [{ key: `agent:files:subagent:e${offset}`, spawnedBy: PARENT, status: "done", updatedAt: 0 }], totalCount: 10_000 } };
      },
    };
    const { write } = writes();
    await new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: endless, write, log: () => {} }).relistChildren();
    expect(reads).toBe(MAX_CHILD_LIST_PAGES);
    reads = 0;
    const stalled: RowRequester = {
      async request() {
        reads++;
        return { payload: { sessions: [], hasMore: true, nextOffset: 0 } };
      },
    };
    await new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: stalled, write, log: () => {} }).relistChildren();
    expect(reads).toBe(1);
  });

  it("a failed write of a row not followed retries the list once, deferred", async () => {
    const timers = manualTimers();
    let lists = 0;
    const requester: RowRequester = {
      async request() {
        lists++;
        return { payload: { sessions: [{ key: CHILD, spawnedBy: PARENT, status: "timeout", updatedAt: 0 }] } };
      },
    };
    let fail = true;
    const posted: string[] = [];
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write: async (r) => {
        posted.push(r.status ?? "");
        if (fail) throw new Error("ingest 503");
        return { applied: true, display: "timeout" };
      },
      setTimer: timers.setTimer,
      now: () => 1_800_000_000_000,
      log: () => {},
    });
    await follower.relistChildren();
    expect(timers.live().map((t) => t.ms)).toEqual([ROW_READ_RETRY_MS]);
    fail = false;
    timers.fire(ROW_READ_RETRY_MS);
    await flush();
    expect([lists, posted]).toEqual([2, ["timeout", "timeout"]]);
    expect(timers.live()).toEqual([]);
  });

  it("a failed list is retried once, deferred", async () => {
    const timers = manualTimers();
    let lists = 0;
    const requester: RowRequester = {
      async request() {
        lists++;
        throw new Error("UNAVAILABLE");
      },
    };
    const { write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write,
      setTimer: timers.setTimer,
      log: () => {},
    });
    await follower.relistChildren();
    expect(timers.live().map((t) => t.ms)).toEqual([ROW_READ_RETRY_MS]);
    timers.fire(ROW_READ_RETRY_MS);
    await flush();
    expect(lists).toBe(2);
    expect(timers.live()).toEqual([]);
  });
});

describe("a child the gateway deleted (cleanup: \"delete\")", () => {
  it("`{ session: null }` is written as gone; a payload without the field writes nothing", async () => {
    let answer: unknown = { session: null };
    const requester: RowRequester = { async request() { return { payload: answer }; } };
    const { written, write } = writes();
    const follower = new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, log: () => {} });
    follower.runEnded(CHILD);
    await flush();
    expect(written).toEqual([{ chatId: "c1", childSessionKey: CHILD, absent: true }]);
    answer = {};
    follower.runEnded(CHILD);
    await flush();
    expect(written).toHaveLength(1);
  });

  it("a COMPLETE list asks for the missing candidates and READS each; only `session: null` makes one gone", async () => {
    const timers = manualTimers();
    let total = 1;
    const spawnedAfter = "agent:files:subagent:spawned-after-the-list";
    const deleted = "agent:files:subagent:deleted";
    const requester: RowRequester = {
      async request(method, params) {
        if (method === "sessions.list") {
          return { payload: { sessions: [{ key: CHILD, spawnedBy: PARENT, status: "done", updatedAt: 0 }], totalCount: total, hasMore: false } };
        }
        // The child spawned after the list was sampled exists; the deleted one does not.
        return params.key === spawnedAfter
          ? { payload: { session: { key: spawnedAfter, spawnedBy: PARENT, status: "running", hasActiveRun: true, snapshotAt: 9 } } }
          : { payload: { session: null } };
      },
    };
    const asks: Array<[string, string[]]> = [];
    let fail = true;
    const { written, write } = writes();
    const follower = new ChildRowStatus({
      chatId: "c1",
      parentSessionKey: PARENT,
      gateway: requester,
      write,
      missing: async (parentKey, keys) => {
        asks.push([parentKey, keys]);
        if (fail) throw new Error("ingest 503");
        return [spawnedAfter, deleted];
      },
      setTimer: timers.setTimer,
      log: () => {},
    });
    await follower.relistChildren();
    expect(asks).toEqual([[PARENT, [CHILD]]]);
    expect(timers.live().map((t) => t.ms)).toEqual([ROW_READ_RETRY_MS]);
    fail = false;
    timers.fire(ROW_READ_RETRY_MS);
    await flush();
    expect(asks).toHaveLength(2);
    // The new child is written live; only the deleted one is gone.
    expect(written.filter((w) => w.childSessionKey === spawnedAfter).map((w) => w.status)).toContain("running");
    expect(written.filter((w) => w.childSessionKey === spawnedAfter).some((w) => w.absent)).toBe(false);
    expect(written.filter((w) => w.childSessionKey === deleted)).toEqual([
      { chatId: "c1", childSessionKey: deleted, absent: true },
    ]);
    // Short of its announced total: nothing asked (a missing child may only have moved).
    total = 5;
    await new ChildRowStatus({ chatId: "c1", parentSessionKey: PARENT, gateway: requester, write, missing: async (p, k) => { asks.push([p, k]); return []; }, setTimer: timers.setTimer, log: () => {} }).relistChildren();
    expect(asks).toHaveLength(2);
  });
});

describe("rowStatusOf", () => {
  it("forwards the row's own fields as read, nothing else", () => {
    expect(rowStatusOf("c1", CHILD, REGISTRY.payload.session)).toEqual({
      chatId: "c1",
      childSessionKey: CHILD,
      status: "timeout",
      hasActiveRun: false,
      runId: "1355bb44-f5ea-4f60-b3e9-9dabbc490abf",
      snapshotAt: 1792448269766,
      parentKey: PARENT,
    });
    expect(rowStatusOf("c1", CHILD, null)).toBeNull();
    expect(rowStatusOf("c1", CHILD, { status: 7, lastRunId: "" })).toEqual({ chatId: "c1", childSessionKey: CHILD });
  });
});
