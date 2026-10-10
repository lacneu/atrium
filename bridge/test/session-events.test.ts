// The SESSION-EVENTS connection (transcript redesign, phase 2, design §6.2): one
// dedicated, scoped socket per instance; `sessions.subscribe` once per connection; each
// `session.message` / `sessions.changed` handed to the reconciler of the session it
// names — and to NOTHING else. Deterministic: connections and timers are injected.

import { describe, expect, it } from "vitest";

import {
  SessionEventsHub,
  type SessionEventsConnection,
} from "../src/providers/openclaw/session-events.js";
import type { SessionEventListener } from "../src/providers/openclaw/transcript-shadow.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A scriptable connection: requests recorded, frames pushed by the test. */
function fakeConn(opts: { version?: string | null; subscribeFails?: boolean } = {}) {
  const queue: (GatewayFrame | null)[] = [];
  let wake: (() => void) | null = null;
  const calls: Array<[string, Record<string, unknown>]> = [];
  let closed = false;
  const conn: SessionEventsConnection & { push(f: GatewayFrame | null): void; calls: typeof calls } = {
    calls,
    gatewayVersion: opts.version === undefined ? "2026.9.8" : opts.version,
    get isClosed() {
      return closed;
    },
    async request(method, params) {
      calls.push([method, params]);
      if (method === "sessions.subscribe" && opts.subscribeFails) throw new Error("UNAVAILABLE");
      return { ok: true, payload: { subscribed: true } };
    },
    async *frames() {
      for (;;) {
        if (queue.length === 0) {
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        const f = queue.shift()!;
        if (f === null) return;
        yield f;
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

/** Manual timers: fire them when the test says so. */
function timers() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    pending,
    setTimer(fn: () => void, ms: number) {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
    fireAll() {
      for (const t of pending.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

function recorder() {
  const got: string[] = [];
  const listener: SessionEventListener = {
    onSessionMessage: (p) => got.push(`message:${String((p.message as { id?: string })?.id ?? "")}`),
    onSessionsChanged: (p) => got.push(`changed:${String(p.reason ?? p.phase ?? "")}`),
    onSubscribed: () => got.push("subscribed"),
  };
  return { got, listener };
}

const msg = (sessionKey: string, id: string): GatewayFrame => ({
  type: "event",
  event: "session.message",
  payload: { sessionKey, message: { id } },
});
const changed = (sessionKey: string, reason: string): GatewayFrame => ({
  type: "event",
  event: "sessions.changed",
  payload: { sessionKey, reason },
});

function hubWith(conns: ReturnType<typeof fakeConn>[], t = timers()) {
  const opened: ReturnType<typeof fakeConn>[] = [];
  const hub = new SessionEventsHub({
    instanceName: "primary",
    connect: async () => {
      const c = conns.shift() ?? fakeConn();
      opened.push(c);
      return c;
    },
    versionSupported: (v) => v !== "2026.8.1",
    setTimer: t.setTimer,
    log: () => {},
  });
  return { hub, opened, t };
}

describe("one subscription, opened by the first projected session", () => {
  it("no socket until a session attaches; then `sessions.subscribe {}` once, and the session reads", async () => {
    const { hub, opened } = hubWith([]);
    await flush();
    expect(opened).toHaveLength(0);
    const a = recorder();
    hub.attach("k1", a.listener);
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.calls).toEqual([["sessions.subscribe", {}]]);
    expect(a.got).toEqual(["subscribed"]);
    // A second session shares the connection and reads on attach.
    const b = recorder();
    hub.attach("k2", b.listener);
    await flush();
    expect(opened).toHaveLength(1);
    expect(b.got).toEqual(["subscribed"]);
  });

  it("demultiplexes by session key: each event to the session it names, and only to it", async () => {
    const { hub, opened } = hubWith([]);
    const a = recorder();
    const b = recorder();
    hub.attach("k1", a.listener);
    hub.attach("k2", b.listener);
    await flush();
    opened[0]!.push(msg("k1", "m1"));
    opened[0]!.push(changed("k2", "compact"));
    opened[0]!.push(msg("k3", "m3")); // nobody's
    await flush();
    expect(a.got).toEqual(["subscribed", "message:m1"]);
    expect(b.got).toEqual(["subscribed", "changed:compact"]);
    expect(hub.stats).toMatchObject({ sessionMessages: 2, sessionsChanged: 1, routed: 2, unrouted: 1 });
  });

  it("turn frames that reach this socket are COUNTED and forwarded to no one", async () => {
    const { hub, opened } = hubWith([]);
    const a = recorder();
    hub.attach("k1", a.listener);
    await flush();
    for (const event of ["chat", "agent", "session.tool", "session.observer"]) {
      opened[0]!.push({ type: "event", event, payload: { sessionKey: "k1", runId: "r" } });
    }
    opened[0]!.push({ type: "event", event: "tick", payload: {} });
    await flush();
    expect(a.got).toEqual(["subscribed"]);
    expect(hub.stats.strayTurnFrames).toBe(4);
    expect(hub.stats.otherFrames).toBe(1);
  });

  it("a listener that throws harms neither the others nor the reader", async () => {
    const { hub, opened } = hubWith([]);
    const ok = recorder();
    hub.attach("k1", {
      onSessionMessage: () => {
        throw new Error("boom");
      },
      onSessionsChanged: () => {},
      onSubscribed: () => {},
    });
    hub.attach("k1", ok.listener);
    await flush();
    opened[0]!.push(msg("k1", "m1"));
    opened[0]!.push(msg("k1", "m2"));
    await flush();
    expect(ok.got).toEqual(["subscribed", "message:m1", "message:m2"]);
    expect(hub.stats.listenerErrors).toBe(2);
  });
});

describe("reconnects, failures, lingering", () => {
  it("a closed socket is reopened after the backoff, and every attached session reads again", async () => {
    const { hub, opened, t } = hubWith([]);
    const a = recorder();
    hub.attach("k1", a.listener);
    await flush();
    opened[0]!.push(null); // the gateway went away
    await flush();
    expect(hub.ready).toBe(false);
    expect(t.pending.some((p) => p.ms === 1_000 && !p.cancelled)).toBe(true);
    t.fireAll();
    await flush();
    expect(opened).toHaveLength(2);
    expect(a.got).toEqual(["subscribed", "subscribed"]);
    opened[1]!.push(msg("k1", "after"));
    await flush();
    expect(a.got.at(-1)).toBe("message:after");
  });

  it("a refused subscription closes that socket and retries — nothing is delivered from it meanwhile", async () => {
    const { hub, opened, t } = hubWith([fakeConn({ subscribeFails: true })]);
    const a = recorder();
    hub.attach("k1", a.listener);
    await flush();
    expect(opened[0]!.isClosed).toBe(true);
    expect(a.got).toEqual([]);
    expect(hub.stats.subscribeFailures).toBe(1);
    t.fireAll();
    await flush();
    expect(a.got).toEqual(["subscribed"]);
  });

  it("a gateway KNOWN to predate the scoped events is not subscribed", async () => {
    const { hub, opened } = hubWith([fakeConn({ version: "2026.8.1" })]);
    hub.attach("k1", recorder().listener);
    await flush();
    expect(opened[0]!.calls).toEqual([]);
    expect(opened[0]!.isClosed).toBe(true);
  });

  it("the socket closes after the LAST session detached and the linger elapsed — not before", async () => {
    const { hub, opened, t } = hubWith([]);
    const d1 = hub.attach("k1", recorder().listener);
    const d2 = hub.attach("k2", recorder().listener);
    await flush();
    d1();
    expect(t.pending.filter((p) => !p.cancelled)).toHaveLength(0);
    d2();
    d2(); // idempotent
    expect(opened[0]!.isClosed).toBe(false);
    t.fireAll();
    expect(opened[0]!.isClosed).toBe(true);
    expect(hub.ready).toBe(false);
  });

  it("re-attaching during the linger keeps the socket", async () => {
    const { hub, opened, t } = hubWith([]);
    const d1 = hub.attach("k1", recorder().listener);
    await flush();
    d1();
    hub.attach("k1", recorder().listener);
    t.fireAll();
    expect(opened[0]!.isClosed).toBe(false);
  });

  it("stop() closes everything and refuses later attaches", async () => {
    const { hub, opened } = hubWith([]);
    hub.attach("k1", recorder().listener);
    await flush();
    hub.stop();
    expect(opened[0]!.isClosed).toBe(true);
    const late = recorder();
    hub.attach("k1", late.listener);
    await flush();
    expect(opened).toHaveLength(1);
    expect(late.got).toEqual([]);
  });
});

/** mulberry32 — deterministic, so a failing seed replays. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: every session event reaches exactly the sessions attached to its key", () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`seed ${seed}`, async () => {
      const rand = prng(seed);
      const { hub, opened } = hubWith([]);
      const keys = ["k1", "k2", "k3"];
      const recs = new Map<string, ReturnType<typeof recorder>>();
      for (const k of keys) {
        if (rand() < 0.7) {
          const r = recorder();
          recs.set(k, r);
          hub.attach(k, r.listener);
        }
      }
      if (recs.size === 0) {
        const r = recorder();
        recs.set("k1", r);
        hub.attach("k1", r.listener);
      }
      await flush();
      const expected = new Map<string, string[]>([...recs.keys()].map((k) => [k, ["subscribed"]]));
      for (let i = 0; i < 40; i++) {
        const k = keys[Math.floor(rand() * keys.length)]!;
        const x = rand();
        if (x < 0.5) {
          opened[0]!.push(msg(k, `m${i}`));
          expected.get(k)?.push(`message:m${i}`);
        } else if (x < 0.8) {
          opened[0]!.push(changed(k, "send"));
          expected.get(k)?.push("changed:send");
        } else {
          opened[0]!.push({ type: "event", event: "chat", payload: { sessionKey: k, state: "final" } });
        }
      }
      await flush();
      for (const [k, r] of recs) expect(r.got, k).toEqual(expected.get(k));
    });
  }
});

describe("dropped events (review pass 5): a frame gap rereads every attached session, once per burst", () => {
  it("a gap → one coalesced reread per attached session after the debounce, however many gaps", async () => {
    const t = timers();
    const { hub, opened } = hubWith([], t);
    const a = recorder();
    const b = recorder();
    hub.attach("k1", a.listener);
    hub.attach("k2", b.listener);
    await flush();
    expect(a.got).toEqual(["subscribed"]);
    const gap = { missing: 3, expected: 10, received: 13 };
    opened[0]!.onFrameGap!(gap);
    opened[0]!.onFrameGap!(gap);
    opened[0]!.onFrameGap!(gap);
    // Nothing before the debounce fires.
    expect(a.got).toEqual(["subscribed"]);
    t.fireAll();
    expect(a.got).toEqual(["subscribed", "subscribed"]);
    expect(b.got).toEqual(["subscribed", "subscribed"]);
    expect(hub.stats).toMatchObject({ frameGaps: 3, gapRereads: 1 });
    // A later gap is a new burst.
    opened[0]!.onFrameGap!(gap);
    t.fireAll();
    expect(a.got).toHaveLength(3);
  });

  it("a gap reported by a connection that is no longer the live one does nothing", async () => {
    const t = timers();
    const { hub, opened } = hubWith([], t);
    const a = recorder();
    hub.attach("k1", a.listener);
    await flush();
    const stale = opened[0]!;
    const handler = stale.onFrameGap!;
    stale.push(null); // the socket ends; a new one will be opened
    await flush();
    handler({ missing: 1, expected: 2, received: 3 });
    t.fireAll(); // fires the reconnect timer only
    await flush();
    expect(hub.stats.gapRereads).toBe(0);
  });
});
