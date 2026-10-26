// Codex passes 3 and 4 (0.102.1) — no bubble is left without someone to end it, and nothing
// is decided from this process's memory.
//
// Pass 3: a `/resume` answered `unknown` (the gateway says the session is active but
// withholds its exact run set) leaves the session LISTENING — its reconciler on — so the
// run's own end, arriving later on the socket, is read and posted.
// Pass 4: EVERY close of a conversation socket asks Convex once (`resumeStreams(chat)`),
// whatever the bridge held in memory; Convex decides from its state. Tested on the REAL
// OpenClawConnection (its own close path and listener order), over a scripted socket.

import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../src/session.js";
import { admitResume, createBridgeServer } from "../src/server.js";
import { HealthRegistry } from "../src/core/health.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";

const ROUTING = { chatId: "c1", openclawChatId: "oc1", agentId: "a", canonical: "alice" };
const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  bridgeInstanceSecret: null,
  instanceName: "primary",
  bridgeSharedSecret: "test-shared-secret",
  mediaOutboundDir: "/tmp/media-outbound",
  mediaOutboundAgentMount: "/home/node/.openclaw/media/outbound",
} as unknown as BridgeConfig;

type GatewayState = {
  history: Record<string, unknown>;
  down?: boolean;
  /** Only the full transcript reads fail (the one-row facts read answers). */
  downFull?: boolean;
  /** Per session key: what `chat.history` answers for that session (default: `history`). */
  bySession?: Record<string, Record<string, unknown>>;
  /** Per session key: a transcript that answers each request from its params (cursor,
   *  offset, limit), as the gateway does. */
  transcripts?: Record<string, (params: HistoryParams) => unknown>;
};

type HistoryParams = { limit?: number; sessionKey?: string; cursor?: string; offset?: number };

/** A REAL OpenClawConnection over a scripted socket: requests are answered from the
 *  gateway's current state; frames and the socket's close are driven by the test. */
function realConnection(state: GatewayState, historyCalls: unknown[]) {
  const ws = new EventEmitter() as EventEmitter & {
    send(data: string): void;
    close(): void;
    terminate(): void;
  };
  ws.send = (data: string) => {
    const frame = JSON.parse(data) as { type?: string; id?: string; method?: string; params?: unknown };
    if (frame.type !== "req") return;
    let payload: unknown = {};
    if (frame.method === "chat.history") {
      historyCalls.push(frame.params);
      const params = (frame.params ?? {}) as { limit?: number; sessionKey?: string };
      if (state.down === true || (state.downFull === true && params.limit !== 1)) {
        setImmediate(() =>
          ws.emit(
            "message",
            Buffer.from(
              JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "UNAVAILABLE", message: "storage" } }),
            ),
          ),
        );
        return;
      }
      const transcript = params.sessionKey === undefined ? undefined : state.transcripts?.[params.sessionKey];
      payload =
        transcript !== undefined
          ? transcript(params as HistoryParams)
          : (params.sessionKey !== undefined && state.bySession?.[params.sessionKey]) || state.history;
    }
    setImmediate(() =>
      ws.emit("message", Buffer.from(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }))),
    );
  };
  ws.close = () => setImmediate(() => ws.emit("close", 1000, Buffer.from("")));
  ws.terminate = ws.close;
  const conn = new (OpenClawConnection as unknown as new (w: unknown) => OpenClawConnection)(ws);
  (conn as unknown as { attachReader(): void }).attachReader();
  return {
    conn,
    /** A frame from the gateway. */
    push: (frame: unknown) => ws.emit("message", Buffer.from(JSON.stringify(frame))),
    /** The GATEWAY closes the socket (not the bridge). */
    dropByGateway: () => ws.emit("close", 1006, Buffer.from("")),
  };
}

function scriptedGateway() {
  const state: GatewayState = { history: { messages: [], sessionInfo: { hasActiveRun: true } } };
  const historyCalls: unknown[] = [];
  const sockets: ReturnType<typeof realConnection>[] = [];
  const connect = vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
    const c = realConnection(state, historyCalls);
    sockets.push(c);
    return c.conn;
  });
  return { state, historyCalls, sockets, connect };
}

function writerRecording() {
  const applies: Array<Record<string, unknown>> = [];
  const resumeAsked: string[] = [];
  const writer = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "applyTranscript") {
          return async (report: Record<string, unknown>) => {
            applies.push(report);
            return { ok: true, settledRuns: [] };
          };
        }
        if (prop === "resumeStreams") {
          return async (chatId: string) => {
            resumeAsked.push(chatId);
          };
        }
        if (prop === "then") return undefined;
        return async () => undefined;
      },
    },
  ) as unknown as ConvexWriter;
  return { writer, applies, resumeAsked };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};
const settle = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex pass 3 — an `unknown` resume leaves the session LISTENING", () => {
  it("4× unknown, then the run's terminal on the socket: the transcript is read and its end posted", async () => {
    const gw = scriptedGateway();
    const { writer, applies, resumeAsked } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    const session = await reg.acquire(ROUTING);
    const shadow = session.transcriptShadow!;
    for (let i = 0; i < 4; i++) {
      expect(await admitResume(session as never, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
        "unknown",
      );
    }
    await shadow.idle();
    expect(shadow.active).toBe(true);
    const appliesBefore = applies.length;
    const connectsBefore = gw.connect.mock.calls.length;
    gw.state.history = { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } };
    gw.sockets[0]!.push({
      type: "event",
      event: "chat",
      payload: { runId: "runA", sessionKey: session.sessionKey, state: "final", message: { role: "assistant", content: [] } },
    });
    await until(() => applies.length > appliesBefore);
    await shadow.idle();
    const after = applies.slice(appliesBefore).filter((a) => a.textsOnly !== true);
    expect(after.length).toBeGreaterThan(0);
    const last = after[after.length - 1]!;
    expect(last.terminals).toEqual([expect.objectContaining({ runId: "runA", status: "completed" })]);
    expect(last.hasActiveRun).toBe(false);
    expect(gw.connect.mock.calls.length).toBe(connectsBefore); // no reconnection
    expect(resumeAsked).toEqual([]); // the socket never closed
    reg.closeAll();
  });

  it("a socket that moved on while reading switches nothing on", async () => {
    scriptedGateway();
    const { writer } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    const session = await reg.acquire(ROUTING);
    expect(await admitResume(session as never, "c1", { messageId: "m1", runId: "runA" }, () => false)).toBe(
      "unknown",
    );
    expect(session.transcriptShadow!.active).toBe(false);
    reg.closeAll();
  });
});

describe("Codex pass 4 — EVERY close of a conversation socket asks Convex, once", () => {
  it("4× unknown, then the GATEWAY drops the socket: exactly one question for the chat (real close path)", async () => {
    const gw = scriptedGateway();
    const { writer, resumeAsked } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    const session = await reg.acquire(ROUTING);
    for (let i = 0; i < 4; i++) {
      expect(await admitResume(session as never, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
        "unknown",
      );
    }
    await session.transcriptShadow!.idle();
    gw.sockets[0]!.dropByGateway();
    await until(() => resumeAsked.length > 0);
    await settle();
    expect(resumeAsked).toEqual(["c1"]);
    // …then the reconnection Convex asks for reads the gateway's state on a NEW socket: the
    // run is over, and one transcript read (its idle fact) settles the bubble.
    gw.state.history = { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } };
    const again = await reg.acquire(ROUTING);
    expect(again).not.toBe(session);
    expect(await admitResume(again as never, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "not_running",
    );
    reg.closeAll();
  });

  it("a close in the middle of a turn: exactly one question", async () => {
    const gw = scriptedGateway();
    const { writer, resumeAsked } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    const session = await reg.acquire(ROUTING);
    await session.runManager.beginTurn(1_000, "run-1");
    session.wake();
    gw.sockets[0]!.dropByGateway();
    await until(() => resumeAsked.length > 0);
    await settle();
    expect(resumeAsked).toEqual(["c1"]);
    reg.closeAll();
  });

  it("a close with no turn and no question ever asked: the question is still sent (Convex decides)", async () => {
    const gw = scriptedGateway();
    const { writer, resumeAsked } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    await reg.acquire(ROUTING);
    gw.sockets[0]!.dropByGateway();
    await until(() => resumeAsked.length > 0);
    await settle();
    expect(resumeAsked).toEqual(["c1"]);
    reg.closeAll();
  });

  it("the bridge closing the socket itself asks too — once", async () => {
    const gw = scriptedGateway();
    const { writer, resumeAsked } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    await reg.acquire(ROUTING);
    gw.sockets[0]!.conn.close();
    await until(() => resumeAsked.length > 0);
    await settle();
    expect(resumeAsked).toEqual(["c1"]);
    reg.closeAll();
  });
});


describe("Codex pass 6 — a listener whose reads failed is read again by the cycle", () => {
  it("reads fail through the run's end, retries spent, the gateway back with no new event: the next cycle settles it", async () => {
    const gw = scriptedGateway();
    const { writer, applies } = writerRecording();
    const served = servedMap(config, writer);
    const reg = new SessionRegistry(served, () => 1_000);
    const session = await reg.acquire({ ...ROUTING, instanceName: "primary" });
    const shadow = session.transcriptShadow!;
    // No waiting in the reconciler's own bounded retries.
    (shadow as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    expect(await admitResume(session as never, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe("unknown");
    await shadow.idle();
    // The gateway's storage fails: the run's end arrives, every read of it fails.
    gw.state.down = true;
    gw.sockets[0]!.push({
      type: "event",
      event: "chat",
      payload: { runId: "runA", sessionKey: session.sessionKey, state: "final", message: { role: "assistant", content: [] } },
    });
    await until(() => (shadow as unknown as { stats: { failures: number } }).stats.failures >= 4);
    await shadow.idle();
    await new Promise((r) => setTimeout(r, 50));
    const failed = applies.filter((a) => a.textsOnly !== true && a.hasActiveRun === false).length;
    expect(failed).toBe(0);
    expect(shadow.active).toBe(true); // still "listening" — the trap of pass 6
    // The gateway is back; no new event comes. A reconciliation cycle asks /resume.
    gw.state.down = false;
    gw.state.history = { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } };
    const server = createBridgeServer({
      shared: sharedFromConfig(config),
      served,
      registry: reg,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify({
          ...ROUTING,
          instanceName: "primary",
          sessionKey: session.sessionKey,
          liveBubble: { messageId: "m1", runId: "runA" },
        }),
      });
      expect(await res.json()).toEqual({ ok: true, resumed: false, reason: "followed" });
      await until(() => applies.some((a) => a.textsOnly !== true && a.hasActiveRun === false));
      await shadow.idle();
      // The read the cycle asked for applied the gateway's state: the session is idle — the
      // projection settles the bubble from it (convex/runEndIsTheGateways.test.ts).
      expect(applies.some((a) => a.textsOnly !== true && a.hasActiveRun === false)).toBe(true);
      expect(gw.connect.mock.calls.length).toBe(2); // the conversation socket + session events: no reconnection
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });
});


describe("Codex pass 7 — only the gateway's proof APPLIED closes; a moved socket never hides a bubble", () => {
  it("over by the facts, but the transcript reads fail ×4: unknown; restored, the next cycle settles it with the full answer", async () => {
    const gw = scriptedGateway();
    const { writer, applies } = writerRecording();
    const served = servedMap(config, writer);
    const reg = new SessionRegistry(served, () => 1_000);
    const session = await reg.acquire({ ...ROUTING, instanceName: "primary" });
    const shadow = session.transcriptShadow!;
    (shadow as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    gw.state.history = { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } };
    gw.state.downFull = true;
    for (let i = 0; i < 4; i++) {
      expect(await admitResume(session as never, "c1", { messageId: "m1", runId: "runA" }, () => true, 200)).toBe(
        "unknown",
      );
    }
    await shadow.idle();
    expect(applies.filter((a) => a.textsOnly !== true)).toHaveLength(0);
    // Restored: the next cycle (followed → one coalesced read) applies the gateway's state.
    gw.state.downFull = false;
    const server = createBridgeServer({
      shared: sharedFromConfig(config),
      served,
      registry: reg,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify({
          ...ROUTING,
          instanceName: "primary",
          sessionKey: session.sessionKey,
          liveBubble: { messageId: "m1", runId: "runA" },
        }),
      });
      expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false);
      await until(() => applies.some((a) => a.textsOnly !== true && a.hasActiveRun === false));
      expect(applies.some((a) => a.textsOnly !== true && a.hasActiveRun === false)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });

  it("per-turn routing A→B: A's run ends while the chat's socket serves B — A's session is read APART and settled, B untouched", async () => {
    const gw = scriptedGateway();
    const { writer, applies } = writerRecording();
    const served = servedMap(config, writer);
    const reg = new SessionRegistry(served, () => 1_000);
    const routeA = { ...ROUTING, agentId: "agent-a", instanceName: "primary" };
    const routeB = { ...ROUTING, agentId: "agent-b", instanceName: "primary" };
    const a = await reg.acquire(routeA);
    const keyA = a.sessionKey;
    const b = await reg.acquire(routeB); // the next turn goes to B: the chat's socket moves
    expect(reg.peekByChat("c1")).toBe(b);
    const bSocket = gw.sockets.find((x) => x.conn === b.connection)!;
    const bHistoryBefore = gw.historyCalls.length;
    // A's run is over on the gateway; B's session is busy with its own.
    gw.state.bySession = {
      [keyA]: { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } },
      [b.sessionKey]: { messages: [], sessionInfo: { hasActiveRun: true, activeRunIds: ["runB"] } },
    };
    const server = createBridgeServer({
      shared: sharedFromConfig(config),
      served,
      registry: reg,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify({ ...routeA, sessionKey: keyA, liveBubble: { messageId: "mA", runId: "runA" } }),
      });
      expect(await res.json()).toEqual({ ok: true, resumed: false, reason: "not_running" });
      // A's session was read and applied: idle — the projection settles A's bubble.
      const appliedA = applies.filter((x) => x.textsOnly !== true && x.sessionKey === keyA);
      expect(appliedA.some((x) => x.hasActiveRun === false)).toBe(true);
      // B: same socket, still the chat's, nothing read on its behalf by this resume.
      expect(reg.peekByChat("c1")).toBe(b);
      expect(bSocket.conn.isClosed).toBe(false);
      const readsOfB = gw.historyCalls
        .slice(bHistoryBefore)
        .filter((p) => (p as { sessionKey?: string }).sessionKey === b.sessionKey);
      expect(readsOfB).toHaveLength(0);
      // The connection the read used was its own, and is closed after.
      const apart = gw.sockets.filter((x) => x.conn !== a.connection && x.conn !== b.connection);
      expect(apart.length).toBeGreaterThan(0);
      expect(apart.every((x) => x.conn.isClosed || x === gw.sockets[1])).toBe(true);
      // A still running elsewhere (no proof it ended): `unknown`, nothing applied for it.
      gw.state.bySession[keyA] = { messages: [], sessionInfo: { hasActiveRun: true } };
      const before = applies.length;
      const again = await fetch(`${url}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify({ ...routeA, sessionKey: keyA, liveBubble: { messageId: "mA", runId: "runA" } }),
      });
      expect(await again.json()).toEqual({ ok: true, resumed: false, reason: "unknown" });
      expect(applies.slice(before).filter((x) => x.textsOnly !== true)).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });
});

describe("Codex pass 8 — the bubble's session is its own key, never the conversation's current segment", () => {
  it("two instances, two segments: after the switch to B, Convex's routing names B's segment — A is still read and settled", async () => {
    const gw = scriptedGateway();
    const { writer, applies } = writerRecording();
    const served = new Map([
      ...servedMap(config, writer),
      ...servedMap({ ...config, instanceName: "secondary" } as BridgeConfig, writer),
    ]);
    const reg = new SessionRegistry(served, () => 1_000);
    const routeA = { ...ROUTING, agentId: "agent-a", openclawChatId: "turn:first", instanceName: "primary" };
    const routeB = { ...ROUTING, agentId: "agent-b", openclawChatId: "turn:second", instanceName: "secondary" };
    const a = await reg.acquire(routeA);
    const keyA = a.sessionKey;
    const b = await reg.acquire(routeB);
    expect(reg.peekByChat("c1")).toBe(b);
    gw.state.bySession = {
      [keyA]: { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } },
      [b.sessionKey]: { messages: [], sessionInfo: { hasActiveRun: true, activeRunIds: ["runB"] } },
    };
    const server = createBridgeServer({
      shared: sharedFromConfig(config),
      served,
      registry: reg,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // What Convex sends for A's bubble: A's agent and instance, A's own session key — but
      // the conversation's CURRENT segment (B's), which getChatRouting reads off the chat.
      const res = await fetch(`${url}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify({
          ...routeA,
          openclawChatId: "turn:second",
          sessionKey: keyA,
          liveBubble: { messageId: "mA", runId: "runA" },
        }),
      });
      expect(await res.json()).toEqual({ ok: true, resumed: false, reason: "not_running" });
      expect(applies.some((x) => x.textsOnly !== true && x.sessionKey === keyA && x.hasActiveRun === false)).toBe(true);
      expect(reg.peekByChat("c1")).toBe(b);
      expect(b.connection.isClosed).toBe(false);
      // A key of ANOTHER agent or person is not this bubble's: refused, nothing read.
      const foreignKey = keyA.replace("agent-a", "agent-z");
      const refused = await fetch(`${url}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
        body: JSON.stringify({ ...routeA, sessionKey: foreignKey, liveBubble: { messageId: "mA", runId: "runA" } }),
      });
      expect(await refused.json()).toEqual({ ok: true, resumed: false, reason: "stale" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    }
  });
});

/** A session whose transcript holds `n` rows (seq 1..n): the user's row, then the run's
 *  answer in `n - 1` parts, the last one its final answer — far more than one tail page
 *  (80 rows). Answered like the gateway: a delta from `c:2` either brings everything after
 *  it, or is too far behind (`reset`); a request without a cursor is the newest page. */
function longTranscript(n: number, runId: string, opts: { deltaFromCursor?: boolean } = {}) {
  const all = Array.from({ length: n }, (_, i) => {
    const seq = i + 1;
    if (seq === 1) return { role: "user", content: "question", __openclaw: { id: "u1", seq, idempotencyKey: `${runId}:user` } };
    const text = seq === n ? "FINAL ANSWER" : `part ${seq}`;
    return { role: "assistant", content: [{ type: "text", text }], __openclaw: { id: `a${seq}`, seq, runId } };
  });
  const info = { sessionId: "sA", hasActiveRun: false, activeRunIds: [] };
  const asked: Array<string | null> = [];
  const answer = (p: HistoryParams): unknown => {
    if (p.limit === 1) return { sessionId: "sA", messages: all.slice(-1), sessionInfo: info };
    asked.push(p.cursor ?? null);
    if (p.cursor === "c:2") {
      return opts.deltaFromCursor === true
        ? { kind: "delta", messages: all.slice(2).map((message) => ({ message })), deltaCursor: `c:${n}`, sessionInfo: info }
        : { kind: "reset" };
    }
    if (p.cursor === `c:${n}`) return { kind: "delta", messages: [], deltaCursor: `c:${n}`, sessionInfo: info };
    return { sessionId: "sA", messages: all.slice(-80), sessionInfo: info, deltaCursor: `c:${n}` };
  };
  return { answer, asked };
}

describe("Codex passes 10-11 — the catch-up reader resumes at the store's cursor; a reset reads the newest page, as upstream", () => {
  async function aToB(n: number, opts: { deltaFromCursor?: boolean; noCursor?: boolean } = {}) {
    const gw = scriptedGateway();
    const { writer, applies } = writerRecording();
    const served = servedMap(config, writer);
    const reg = new SessionRegistry(served, () => 1_000);
    const routeA = { ...ROUTING, agentId: "agent-a", instanceName: "primary" };
    const routeB = { ...ROUTING, agentId: "agent-b", instanceName: "primary" };
    const a = await reg.acquire(routeA);
    const keyA = a.sessionKey;
    const b = await reg.acquire(routeB);
    const t = longTranscript(n, "runA", opts);
    gw.state.transcripts = { [keyA]: t.answer };
    gw.state.bySession = {
      [b.sessionKey]: { messages: [], sessionInfo: { hasActiveRun: true, activeRunIds: ["runB"] } },
    };
    const server = createBridgeServer({
      shared: sharedFromConfig(config),
      served,
      registry: reg,
      health: new HealthRegistry(1000, () => 2000),
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "test-shared-secret" },
      body: JSON.stringify({
        ...routeA,
        sessionKey: keyA,
        ...(opts.noCursor === true ? {} : { resumeCursor: { sessionId: "sA", deltaCursor: "c:2" } }),
        liveBubble: { messageId: "mA", runId: "runA" },
      }),
    });
    const answer = await res.json();
    const reads = applies.filter((x) => x.textsOnly !== true && x.sessionKey === keyA);
    const texts = applies
      .filter((x) => x.textsOnly === true && x.sessionKey === keyA)
      .flatMap((x) => (x.rows as Array<{ text?: string }>).map((r) => r.text));
    const close = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      reg.closeAll();
    };
    return { answer, reads, texts, asked: t.asked, close };
  }

  it("A→B, the delta from the store's cursor answered `reset`: the NEWEST page is read and posted — the final answer with it — then not_running", async () => {
    const { answer, reads, texts, asked, close } = await aToB(180);
    try {
      expect(answer).toEqual({ ok: true, resumed: false, reason: "not_running" });
      // The store's cursor first, then the newest page (no cursor), as the Control UI does.
      expect(asked.slice(0, 2)).toEqual(["c:2", null]);
      const page = reads.find((x) => x.kind === "page")!;
      const seqs = (page.rows as Array<{ seq: number }>).map((r) => r.seq);
      expect(seqs[0]).toBe(101);
      expect(seqs.at(-1)).toBe(180);
      expect(page.hasActiveRun).toBe(false);
      expect(texts).toContain("FINAL ANSWER");
    } finally {
      await close();
    }
  });

  it("the store's cursor is the reader's: a delta from `c:2` brings rows 3..180 — no page read", async () => {
    const { answer, reads, asked, close } = await aToB(180, { deltaFromCursor: true });
    try {
      expect(answer).toEqual({ ok: true, resumed: false, reason: "not_running" });
      expect(asked[0]).toBe("c:2");
      expect(asked).not.toContain(null);
      const seqs = reads.flatMap((x) => ((x.rows as Array<{ seq: number }> | undefined) ?? []).map((r) => r.seq));
      for (let seq = 3; seq <= 180; seq++) expect(seqs).toContain(seq);
    } finally {
      await close();
    }
  });

  it("no cursor stored: the newest page, as the Control UI's first read", async () => {
    const { answer, asked, close } = await aToB(180, { noCursor: true });
    try {
      expect(answer).toEqual({ ok: true, resumed: false, reason: "not_running" });
      expect(asked[0]).toBeNull();
    } finally {
      await close();
    }
  });

  it("the chat's own socket (a bridge restarted: its reconciler fresh): admitResume resumes at the store's cursor too", async () => {
    const gw = scriptedGateway();
    const { writer, applies } = writerRecording();
    const reg = new SessionRegistry(servedMap(config, writer), () => 1_000);
    const session = await reg.acquire({ ...ROUTING, instanceName: "primary" });
    const key = session.sessionKey;
    const t = longTranscript(180, "runA", { deltaFromCursor: true });
    gw.state.transcripts = { [key]: t.answer };
    try {
      expect(
        await admitResume(session as never, "c1", { messageId: "m1", runId: "runA" }, () => true, 2_000, {
          sessionId: "sA",
          deltaCursor: "c:2",
        }),
      ).toBe("not_running");
      expect(t.asked[0]).toBe("c:2");
      const seqs = applies
        .filter((x) => x.textsOnly !== true && x.sessionKey === key)
        .flatMap((x) => ((x.rows as Array<{ seq: number }> | undefined) ?? []).map((r) => r.seq));
      for (let seq = 3; seq <= 180; seq++) expect(seqs).toContain(seq);
    } finally {
      reg.closeAll();
    }
  });
});
