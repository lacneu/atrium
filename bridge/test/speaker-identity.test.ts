// A group conversation's PARTICIPANT speaking in their own name (trusted-proxy).
//
// What is pinned, from what was measured live on 2026.9.6
// (openclaw-notes/atrium/bench-runs/participant-identity-2026-09-25):
//   - the participant's own socket SENDS the turn, the conversation's socket stays
//     the one consumer;
//   - the participant's socket carries that run IN FULL to the conversation's socket
//     (it alone receives the tool frames, and one socket has one order), and the
//     conversation's socket drops its own native copies of that run;
//   - attribution never costs the turn: a gateway that refuses the participant, or
//     a socket that cannot open, sends as the owner instead.

import { describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
  OpenClawError,
} from "../src/providers/openclaw/openclaw-client.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import { LiveTextBaselines } from "../src/providers/openclaw/live-text-baseline.js";
import type { SeqGap } from "../src/providers/openclaw/frame-seq.js";
import { SessionRegistry } from "../src/session.js";
import { modelsConnSpy } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import {
  SPEAKER_IDLE_MS,
  SPEAKER_TERMINAL_GRACE_MS,
  SpeakerPool,
  speakerOnlyRunId,
} from "../src/providers/openclaw/speaker-pool.js";
import {
  KnowledgePolicyNotAppliedError,
  clearKnowledgeGuards,
  knowledgeChatSendGate,
  knowledgeGuard,
  noteAppliedKnowledgeRevision,
  noteKnowledgeRevision,
} from "../src/providers/openclaw/knowledge-policy.js";
import {
  isSpeakerRefusal,
  parseSendBody,
  defaultSpeakers,
  sendAsSpeaker,
  speakerCaps,
  speakerPoolKey,
  SessionVanishedBeforeSend,
  withOneRePreparation,
  type SpeakerSource,
} from "../src/server.js";

type FakeConn = OpenClawConnection & {
  injected: GatewayFrame[];
  feed: (frame: GatewayFrame) => void;
  end: () => void;
};

/** A connection double: `request` scripted, frames fed by hand. */
function fakeConn(
  request: (method: string) => Promise<{ payload?: Record<string, unknown> }> = async () => ({
    // The ack names the run by the send's idempotencyKey (upstream contract).
    payload: { runId: "k", status: "started" },
  }),
): FakeConn {
  const queue: GatewayFrame[] = [];
  let waiter: ((f: GatewayFrame | null) => void) | null = null;
  let closed = false;
  const conn = {
    injected: [] as GatewayFrame[],
    request: vi.fn(request),
    injectFrame(frame: GatewayFrame) {
      conn.injected.push(frame);
    },
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      waiter?.(null);
    },
    feed(frame: GatewayFrame) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(frame);
      } else queue.push(frame);
    },
    end() {
      conn.close();
    },
    async *frames() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        const f = await new Promise<GatewayFrame | null>((r) => (waiter = r));
        if (f === null) return;
        yield f;
      }
    },
  };
  return conn as unknown as FakeConn;
}

/** The conversation's socket, its claim for the owner PROVEN (the normal case): it
 *  describes the session as created by its own profile. */
function ownerConn(creator = "p-owner"): FakeConn {
  const conn = fakeConn(async (method) =>
    method === "sessions.describe"
      ? {
          payload: {
            session: {
              createdActor: {
                type: "human",
                id: creator,
                identity: { type: "profile", id: creator },
              },
            },
          },
        }
      : { payload: { runId: "run-1", status: "started" } },
  );
  Object.assign(conn, { sessionClaimed: true, selfProfileId: "p-owner" });
  return conn;
}

/** How many chat.send a connection double made. */
const sends = (conn: FakeConn) =>
  (conn.request as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    ([m]) => m === "chat.send",
  ).length;

const proxyConfig = {
  openclawAuthMode: "trusted-proxy",
  instanceName: "lacneu",
} as unknown as BridgeConfig;
const tokenConfig = {
  openclawAuthMode: "token",
  instanceName: "lacneu",
} as unknown as BridgeConfig;

const params = { sessionKey: "agent:a:atrium:chat:owner:c1", message: "hi", idempotencyKey: "k" };

/** A speaker source double; `routed` lists the routes still in place. */
function source(speakerConn: OpenClawConnection | Error) {
  const routed: Array<[OpenClawConnection, string, OpenClawConnection]> = [];
  /** Runs handed back WITH the loss signal (may be live) — as opposed to unrouted. */
  const abandoned: string[] = [];
  const src: SpeakerSource = {
    acquire: vi.fn(async () => {
      if (speakerConn instanceof Error) throw speakerConn;
      return speakerConn;
    }),
    route: (from, runId, to) => {
      if (from.isClosed) return false;
      routed.push([from, runId, to]);
      return true;
    },
    unroute: (from, runId) => {
      const i = routed.findIndex(([f, r]) => f === from && r === runId);
      if (i >= 0) routed.splice(i, 1);
    },
    abandon: (from, runId) => {
      abandoned.push(runId);
      const i = routed.findIndex(([f, r]) => f === from && r === runId);
      if (i >= 0) routed.splice(i, 1);
    },
  };
  return { src, routed, abandoned };
}

describe("who sends a participant's turn", () => {
  it("the participant's own socket, and its run is routed to the conversation's socket", async () => {
    const owner = ownerConn();
    const bob = fakeConn();
    const { src, routed } = source(bob);
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(bob.request).toHaveBeenCalledWith("chat.send", params, 20_000);
    expect(sends(owner)).toBe(0);
    // Routed under the send's idempotencyKey — the run's id — BEFORE the send.
    expect(routed).toEqual([[bob, "k", owner]]);
  });

  it("the owner's socket when no speaker is named", async () => {
    const owner = ownerConn();
    const bob = fakeConn();
    const { src } = source(bob);
    await sendAsSpeaker(owner, params, { chatId: "c1" }, proxyConfig, src);
    expect(owner.request).toHaveBeenCalledOnce();
    expect(src.acquire).not.toHaveBeenCalled();
  });

  it("the owner's socket in token mode, whatever the body says", async () => {
    // One shared identity: there is no "their own socket" to speak from.
    const owner = ownerConn();
    const bob = fakeConn();
    const { src } = source(bob);
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, tokenConfig, src);
    expect(owner.request).toHaveBeenCalledOnce();
    expect(src.acquire).not.toHaveBeenCalled();
  });
});

describe("attribution never costs the turn", () => {
  it("a gateway that refuses the participant: the owner's socket sends, same key", async () => {
    const owner = ownerConn();
    const bob = fakeConn(async () => {
      throw new Error('INVALID_REQUEST: Session "agent:a:atrium:chat:owner:c1" was not found.');
    });
    const { src, routed } = source(bob);
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(owner.request).toHaveBeenCalledWith("chat.send", params, 20_000);
    expect(routed).toEqual([]);
  });

  it("a VISIBILITY that refuses the participant: the turn fails, never re-sent as the owner", async () => {
    // read-only / suggest / draft is the session owner's decision about this person's
    // turns: re-sending under the owner's name would walk straight through it.
    for (const visibility of ["read-only", "suggest", "draft"]) {
      const owner = ownerConn();
      const bob = fakeConn(async () => {
        throw new Error(`INVALID_REQUEST: session is ${visibility} for this connection`);
      });
      const { src } = source(bob);
      await expect(
        sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src),
      ).rejects.toThrow(/for this connection/);
      expect(sends(owner), visibility).toBe(0);
    }
  });

  it("a speaker socket that cannot open: the owner's socket sends", async () => {
    const owner = ownerConn();
    const { src } = source(new Error("connect refused"));
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(sends(owner)).toBe(1);
  });

  it("a failure of the TURN itself is not retried from another socket", async () => {
    // It would fail the same way from the owner's socket — and the caller's error
    // handling (classification, report) must see it.
    const owner = ownerConn();
    const bob = fakeConn(async () => {
      throw new Error("INVALID_REQUEST: attachment too large");
    });
    const { src } = source(bob);
    await expect(
      sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src),
    ).rejects.toThrow(/attachment too large/);
    expect(sends(owner)).toBe(0);
  });

  it("names the sharing refusals upstream answers, and only those", () => {
    expect(isSpeakerRefusal(new Error('INVALID_REQUEST: Session "k" was not found.'))).toBe(true);
    expect(
      isSpeakerRefusal(new Error("INVALID_REQUEST: session is read-only for this connection")),
    ).toBe(true);
    expect(isSpeakerRefusal(new Error("FORBIDDEN: missing scope: operator.write"))).toBe(true);
    // A generic FORBIDDEN (a role's agent list) is the person's refusal too.
    expect(isSpeakerRefusal(new Error("FORBIDDEN: agent not allowed"))).toBe(true);
    // …but only as the answer's code, not a word in some other error's prose.
    expect(isSpeakerRefusal(new Error("INVALID_REQUEST: FORBIDDEN word in text"))).toBe(false);
    expect(isSpeakerRefusal(new Error("chat.send timed out"))).toBe(false);
    expect(isSpeakerRefusal(new Error("INVALID_REQUEST: attachment too large"))).toBe(false);
  });
});

describe("the speaker socket carries the participant's run in full", () => {
  const frame = (runId: string, n: number, event = "agent"): GatewayFrame => ({
    type: "event",
    event,
    payload: { runId, stream: n % 2 ? "tool" : "assistant", data: { n } },
  });

  it("recognises a run's tool frame — the one the owner's socket never gets", () => {
    expect(speakerOnlyRunId(frame("r1", 1))).toBe("r1");
    expect(speakerOnlyRunId(frame("r1", 2))).toBeNull();
    expect(speakerOnlyRunId({ type: "event", event: "chat", payload: { runId: "r1" } })).toBeNull();
  });

  it("forwards EVERY frame of a carried run, in the speaker socket's order; drops other runs", async () => {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    const owner = ownerConn();
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    pool.route(conn, "r1", owner);
    bob.feed(frame("r1", 1));
    bob.feed(frame("someone-else", 2));
    bob.feed(frame("r1", 2));
    bob.feed({ type: "event", event: "chat", payload: { runId: "r1", state: "final" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(owner.injected).toEqual([
      frame("r1", 1),
      frame("r1", 2),
      { type: "event", event: "chat", payload: { runId: "r1", state: "final" } },
    ]);
    pool.closeAll();
  });

  it("the owner's socket is told to drop its native copies, and gets them back after", async () => {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    const carried: string[] = [];
    const owner = Object.assign(ownerConn(), {
      carryRunElsewhere: (r: string) => carried.push(r),
      releaseRun: (r: string) => carried.splice(carried.indexOf(r), 1),
    });
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    pool.route(conn, "r1", owner);
    expect(carried).toEqual(["r1"]);
    pool.unroute(conn, "r1");
    expect(carried).toEqual([]);
    // …and when the speaker socket ends, every run it carried is released.
    pool.route(conn, "r2", owner);
    bob.end();
    await new Promise((r) => setTimeout(r, 0));
    expect(carried).toEqual([]);
    pool.closeAll();
  });

  it("one socket per person, shared across their conversations", async () => {
    const pool = new SpeakerPool();
    const open = vi.fn(async () => fakeConn());
    const a = await pool.acquire("lacneu\u0000bob", open);
    const b = await pool.acquire("lacneu\u0000bob", open);
    expect(a).toBe(b);
    expect(open).toHaveBeenCalledOnce();
    pool.closeAll();
  });

  it("an idle socket with no run in flight is closed", async () => {
    let now = 0;
    const pool = new SpeakerPool(() => now);
    const bob = fakeConn();
    await pool.acquire("lacneu\u0000bob", async () => bob);
    now = SPEAKER_IDLE_MS + 1;
    pool.sweep();
    expect(bob.isClosed).toBe(true);
    expect(pool.size).toBe(0);
    pool.closeAll();
  });

  it("a socket still carrying a run is kept, however idle", async () => {
    let now = 0;
    const pool = new SpeakerPool(() => now);
    const bob = fakeConn();
    const owner = ownerConn();
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    pool.route(conn, "r1", owner);
    now = SPEAKER_IDLE_MS + 1;
    pool.sweep();
    expect(bob.isClosed).toBe(false);
    pool.closeAll();
  });
});

describe("the owner's socket drops the native copies of a run carried elsewhere", () => {
  it("after the sequence tracker, before the consumer; injected frames still pass", () => {
    const conn = Object.create(OpenClawConnection.prototype) as OpenClawConnection;
    const pushed: unknown[] = [];
    Object.assign(conn, {
      runsCarriedElsewhere: new Set<string>(),
      liveText: new LiveTextBaselines(),
      liveTextRereads: new Map(),
      seq: { observe: () => null },
      configChangedListeners: new Set(),
      rosterEpoch: 0,
      push: (f: unknown) => pushed.push(f),
    });
    const onMessage = (conn as unknown as { onMessage: (raw: Buffer) => void }).onMessage.bind(conn);
    const wire = (runId: string) =>
      Buffer.from(JSON.stringify({ type: "event", event: "chat", payload: { runId, state: "delta" } }));
    conn.carryRunElsewhere("r1");
    onMessage(wire("r1"));
    onMessage(wire("r2"));
    expect(pushed.map((f) => (f as { payload: { runId: string } }).payload.runId)).toEqual(["r2"]);
    conn.releaseRun("r1");
    onMessage(wire("r1"));
    expect(pushed).toHaveLength(2);
  });
});

describe("a participant never opens the owner's session", () => {
  it("while the owner's claim is not proven, the owner's socket sends", async () => {
    // Whoever sends first into a key that does not exist creates the session and
    // owns it (measured, 2026.9.6): a participant must not be that sender.
    const owner = fakeConn(); // sessionClaimed unset: the claim failed
    const bob = fakeConn();
    const { src } = source(bob);
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(owner.request).toHaveBeenCalledOnce();
    expect(bob.request).not.toHaveBeenCalled();
    expect(src.acquire).not.toHaveBeenCalled();
  });
});

describe("what is forwarded weighs what it weighs", () => {
  const big = (runId: string, n: number): GatewayFrame => ({
    type: "event",
    event: "agent",
    payload: { runId, stream: "tool", data: { n, output: "x".repeat(1024 * 1024) } },
  });

  it("an injected frame counts against the receiving socket's inbound byte ceiling", () => {
    // Same accounting as a frame read off the wire: the queue must refuse to grow
    // past MAX_INBOUND_BYTES through forwards alone.
    const conn = Object.create(OpenClawConnection.prototype) as OpenClawConnection;
    const internals = conn as unknown as { queuedBytes: number };
    Object.assign(conn, {
      queue: [],
      queuedBytes: 0,
      closed: false,
      waiter: null,
      ws: { close: () => {} },
      closedListeners: new Set(),
      configChangedListeners: new Set(),
      pending: new Map(),
    });
    const frame = big("r1", 0);
    conn.injectFrame(frame);
    expect(internals.queuedBytes).toBe(Buffer.byteLength(JSON.stringify(frame), "utf8"));
  });
});

describe("the owner's hold on the session is re-read right before a participant sends", () => {
  it("a session re-created by someone else since the claim: the owner's socket sends", async () => {
    const owner = ownerConn("p-bob");
    const bob = fakeConn();
    const { src } = source(bob);
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(bob.request).not.toHaveBeenCalled();
    expect(sends(owner)).toBe(1);
    // The proof is dropped: the next send claims again.
    expect((owner as unknown as { sessionClaimed: boolean }).sessionClaimed).toBe(false);
  });

  it("a session pruned since the claim: nothing is sent — the send is prepared again", async () => {
    // The message in hand was built for the old session, without history: sending
    // it from either socket would start a cold session holding this turn alone.
    const owner = fakeConn(async (method) =>
      method === "sessions.describe" ? { payload: {} } : { payload: { runId: "k" } },
    );
    Object.assign(owner, { sessionClaimed: true, selfProfileId: "p-owner" });
    const bob = fakeConn();
    const { src } = source(bob);
    await expect(
      sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src),
    ).rejects.toBeInstanceOf(SessionVanishedBeforeSend);
    expect(bob.request).not.toHaveBeenCalled();
    expect(sends(owner)).toBe(0);
    expect((owner as unknown as { sessionClaimed: boolean }).sessionClaimed).toBe(false);
  });
});

describe("a send prepared for a vanished session is prepared again, once", () => {
  it("re-runs the whole send once, and only for that failure", async () => {
    let calls = 0;
    await withOneRePreparation(async () => {
      calls += 1;
      if (calls === 1) throw new SessionVanishedBeforeSend("c1");
    }, "c1");
    expect(calls).toBe(2);
    // Twice in a row: the second one propagates — no loop.
    await expect(
      withOneRePreparation(async () => {
        throw new SessionVanishedBeforeSend("c1");
      }, "c1"),
    ).rejects.toBeInstanceOf(SessionVanishedBeforeSend);
    // Anything else is not retried here.
    let other = 0;
    await expect(
      withOneRePreparation(async () => {
        other += 1;
        throw new Error("INVALID_REQUEST");
      }, "c1"),
    ).rejects.toThrow(/INVALID_REQUEST/);
    expect(other).toBe(1);
  });
});

describe("a speaker 'not found' is asked again before the owner takes the turn", () => {
  it("gone since the re-proof: nothing sent — the send is prepared again", async () => {
    let describes = 0;
    const owner = fakeConn(async (method) => {
      if (method !== "sessions.describe") return { payload: { runId: "k" } };
      describes += 1;
      // First the re-proof (owned), then the second look after the refusal (absent).
      return describes === 1
        ? {
            payload: {
              session: {
                createdActor: {
                  type: "human",
                  id: "p-owner",
                  identity: { type: "profile", id: "p-owner" },
                },
              },
            },
          }
        : { payload: {} };
    });
    Object.assign(owner, { sessionClaimed: true, selfProfileId: "p-owner" });
    const bob = fakeConn(async () => {
      throw new Error('INVALID_REQUEST: Session "agent:a:atrium:chat:owner:c1" was not found.');
    });
    const { src } = source(bob);
    await expect(
      sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src),
    ).rejects.toBeInstanceOf(SessionVanishedBeforeSend);
    expect(sends(owner)).toBe(0);
  });
});

describe("a loss on the speaker socket is the owner's loss", () => {
  // While a run is carried, the owner's socket drops its native copies: what the
  // speaker socket misses reaches the consumer from nowhere unless the run is handed
  // back and the owner's own loss path is told.
  function carryingOwner() {
    const carried: string[] = [];
    const gaps: SeqGap[] = [];
    const owner = Object.assign(ownerConn(), {
      carryRunElsewhere: (r: string) => carried.push(r),
      releaseRun: (r: string) => carried.splice(carried.indexOf(r), 1),
    });
    owner.onFrameGap = (gap) => gaps.push(gap);
    return { owner, carried, gaps };
  }

  it("a hole in the speaker socket's sequence: its runs go back, the owner hears of it", async () => {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    const a = carryingOwner();
    const b = carryingOwner();
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    pool.route(conn, "r1", a.owner);
    pool.route(conn, "r2", a.owner);
    pool.route(conn, "r3", b.owner);
    // The REAL order: the client reports the hole BEFORE it queues the frame that
    // revealed it — here a tool frame only this socket ever receives.
    bob.onFrameGap?.({ missing: 2, expected: 5, received: 7 });
    const revealing: GatewayFrame = {
      type: "event",
      event: "agent",
      seq: 7,
      payload: { runId: "r1", stream: "tool", data: { phase: "result" } },
    } as GatewayFrame;
    // Nothing handed back yet: the revealing frame is still on its way.
    expect(a.carried.length).toBeGreaterThan(0);
    bob.feed(revealing);
    await new Promise((r) => setTimeout(r, 0));
    // Delivered exactly once, THEN the runs go back.
    expect(a.owner.injected).toEqual([revealing]);
    expect(a.carried).toEqual([]);
    expect(b.carried).toEqual([]);
    // Once per owner socket, with the speaker socket's own counts.
    const told = { missing: 2, expected: 5, received: 7, carriedBy: "speaker_gap" };
    expect(a.gaps).toEqual([told]);
    expect(b.gaps).toEqual([told]);
    // The run is no longer forwarded: the owner's native copies carry it now.
    bob.feed({ type: "event", event: "chat", seq: 8, payload: { runId: "r1", state: "delta" } } as GatewayFrame);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.owner.injected).toEqual([revealing]);
    pool.closeAll();
  });

  it("the speaker socket ending mid-run: its runs go back, the owner hears of it, uncounted", async () => {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    const a = carryingOwner();
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    pool.route(conn, "r1", a.owner);
    bob.end();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.carried).toEqual([]);
    expect(a.gaps).toEqual([
      { missing: 0, expected: 0, received: 0, carriedBy: "speaker_closed" },
    ]);
    pool.closeAll();
  });

  it("a speaker socket carrying nothing reports nothing", async () => {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    const a = carryingOwner();
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    pool.route(conn, "r1", a.owner);
    pool.unroute(conn, "r1");
    bob.onFrameGap?.({ missing: 1, expected: 2, received: 3 });
    bob.end();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.gaps).toEqual([]);
    pool.closeAll();
  });

  it("the owner's session records it under the speaker source, uncounted on a close", async () => {
    const { conn } = modelsConnSpy(() => ({}));
    const spy = vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const noted: Array<[string, Record<string, unknown>]> = [];
    const writer = {
      reportSessionMeta: async () => {},
      reportSessionRoster: async () => {},
      noteFrameGap: async (chatId: string, data: Record<string, unknown>) => {
        noted.push([chatId, data]);
      },
    };
    const config = {
      openclawGatewayUrl: "ws://127.0.0.1:1",
      openclawToken: "t",
      deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    } as unknown as BridgeConfig;
    const reg = new SessionRegistry(servedMap(config, writer as never));
    try {
      await reg.acquire({ chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "alice" });
      // The hook the session installed on its connection — the one the pool calls.
      const report = (conn as unknown as OpenClawConnection).onFrameGap!;
      report({ missing: 2, expected: 5, received: 7, carriedBy: "speaker_gap" });
      report({ missing: 0, expected: 0, received: 0, carriedBy: "speaker_closed" });
      report({ missing: 1, expected: 3, received: 4 });
      expect(noted).toEqual([
        ["c1", { source: "speaker_gap", expected: 5, received: 7, missing: 2 }],
        ["c1", { source: "speaker_closed", expected: null, received: null, missing: null }],
        ["c1", { source: "envelope", expected: 3, received: 4, missing: 1 }],
      ]);
    } finally {
      reg.closeAll();
      spy.mockRestore();
    }
  });
});

describe("a finished run's route does not outlive it", () => {
  it("is released a short grace after its terminal, and the socket can then idle out", async () => {
    vi.useFakeTimers();
    try {
      const pool = new SpeakerPool();
      const bob = fakeConn();
      const released: string[] = [];
      const owner = Object.assign(ownerConn(), {
        carryRunElsewhere: () => {},
        releaseRun: (r: string) => released.push(r),
      });
      const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
      pool.route(conn, "r1", owner);
      bob.feed({ type: "event", event: "chat", payload: { runId: "r1", state: "final" } });
      await vi.advanceTimersByTimeAsync(0);
      // Not at once: a late frame of the run may still be on its way.
      expect(released).toEqual([]);
      bob.feed({ type: "event", event: "agent", payload: { runId: "r1", stream: "lifecycle" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.injected).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(SPEAKER_TERMINAL_GRACE_MS + 1);
      expect(released).toEqual(["r1"]);
      pool.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the owner's hold is proven AFTER the speaker socket is open", () => {
  // Opening the socket can take the whole connect timeout; a session pruned in that
  // wait would be re-created by the participant's send — theirs, with no history.
  const owned = {
    payload: {
      session: {
        createdActor: { type: "human", id: "p-owner", identity: { type: "profile", id: "p-owner" } },
      },
    },
  };
  function vanishingOwner() {
    const state = { gone: false };
    const owner = fakeConn(async (method) =>
      method === "sessions.describe"
        ? state.gone
          ? { payload: {} }
          : owned
        : { payload: { runId: "k" } },
    );
    Object.assign(owner, { sessionClaimed: true, selfProfileId: "p-owner" });
    return { owner, state };
  }

  it("a session that vanishes while the socket opens is not sent into by the speaker", async () => {
    const { owner, state } = vanishingOwner();
    const bob = fakeConn();
    const { src } = source(bob);
    src.acquire = vi.fn(async () => {
      state.gone = true;
      return bob;
    });
    await expect(
      sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src),
    ).rejects.toBeInstanceOf(SessionVanishedBeforeSend);
    expect(sends(bob)).toBe(0);
    expect(sends(owner)).toBe(0);
  });

  it("a socket that fails to open after a long wait: re-proven before the owner sends", async () => {
    const { owner, state } = vanishingOwner();
    const { src } = source(new Error("unused"));
    src.acquire = vi.fn(async () => {
      state.gone = true;
      throw new Error("connect timed out");
    });
    await expect(
      sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src),
    ).rejects.toBeInstanceOf(SessionVanishedBeforeSend);
    expect(sends(owner)).toBe(0);
  });

  it("…and still owned: the owner's socket takes the turn", async () => {
    const { owner } = vanishingOwner();
    const { src } = source(new Error("connect refused"));
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(sends(owner)).toBe(1);
  });
});

describe("a send that got no answer hands the run back WITH the loss signal", () => {
  // The speaker socket's close rejects the pending chat.send BEFORE the pool's reader
  // sees the end: releasing the route there silently would leave the owner's socket
  // never told that the native copies it dropped are gone.
  function wiring(request: (bob: FakeConn) => Promise<never>) {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    (bob as unknown as { request: unknown }).request = vi.fn(async (method: string) =>
      method === "chat.send" ? request(bob) : { payload: {} },
    );
    const carried: string[] = [];
    const gaps: SeqGap[] = [];
    const owner = Object.assign(ownerConn(), {
      carryRunElsewhere: (r: string) => carried.push(r),
      releaseRun: (r: string) => carried.splice(carried.indexOf(r), 1),
    });
    owner.onFrameGap = (gap) => gaps.push(gap);
    const src: SpeakerSource = {
      acquire: (_config, speaker) => pool.acquire(speaker, async () => bob),
      route: (from, runId, to) => pool.route(from, runId, to),
      unroute: (from, runId) => pool.unroute(from, runId),
      abandon: (from, runId) => pool.abandon(from, runId),
    };
    return { pool, bob, owner, carried, gaps, src };
  }
  const send = (w: ReturnType<typeof wiring>) =>
    sendAsSpeaker(w.owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, w.src);
  const closedSignal = { missing: 0, expected: 0, received: 0, carriedBy: "speaker_closed" };

  it("the socket closes before the ack: released, and the owner is told — once", async () => {
    const w = wiring(async (bob) => {
      // The close's own rejection comes first; the reader sees the end after.
      setTimeout(() => bob.close(), 0);
      throw new OpenClawError("OpenClaw Gateway connection closed");
    });
    await expect(send(w)).rejects.toThrow(/connection closed/);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.carried).toEqual([]);
    expect(w.gaps).toEqual([closedSignal]);
    w.pool.closeAll();
  });

  it("the send times out on a live socket: released, and the owner is told", async () => {
    const w = wiring(async () => {
      throw new OpenClawError("chat.send timed out");
    });
    await expect(send(w)).rejects.toThrow(/timed out/);
    expect(w.carried).toEqual([]);
    expect(w.gaps).toEqual([closedSignal]);
    w.pool.closeAll();
  });

  it("a refusal the gateway ANSWERED: released, nothing to report", async () => {
    const w = wiring(async () => {
      throw new GatewayAnsweredError("INVALID_REQUEST: attachment too large");
    });
    await expect(send(w)).rejects.toThrow(/attachment too large/);
    expect(w.carried).toEqual([]);
    expect(w.gaps).toEqual([]);
    w.pool.closeAll();
  });

  it("a sharing refusal: released, nothing to report, the owner's socket sends", async () => {
    const w = wiring(async () => {
      throw new GatewayAnsweredError('INVALID_REQUEST: Session "k" was not found.');
    });
    await send(w);
    expect(w.carried).toEqual([]);
    expect(w.gaps).toEqual([]);
    expect(sends(w.owner)).toBe(1);
    w.pool.closeAll();
  });
});

describe("a participant's address the identity header cannot carry", () => {
  // The conversation's socket falls back to the Atrium key (gatewayNameFor); the
  // speaker socket must too, or the turn silently goes out as the owner's.
  it("opens the speaker socket under their Atrium key, and the speaker sends", async () => {
    const owner = ownerConn();
    const bob = fakeConn();
    const { src } = source(bob);
    await sendAsSpeaker(
      owner,
      params,
      { speakerGatewayUser: "josé@example.com", speakerCanonical: "jose", chatId: "c1" },
      proxyConfig,
      src,
    );
    expect(src.acquire).toHaveBeenCalledWith(proxyConfig, "jose", { inlineWidgets: false });
    expect(sends(bob)).toBe(1);
    expect(sends(owner)).toBe(0);
  });

  it("a name the header carries is kept; with no key to fall back to, nothing changes", async () => {
    const owner = ownerConn();
    const { src } = source(fakeConn());
    await sendAsSpeaker(
      owner,
      params,
      { speakerGatewayUser: "bob@example.com", speakerCanonical: "bob", chatId: "c1" },
      proxyConfig,
      src,
    );
    expect(src.acquire).toHaveBeenLastCalledWith(proxyConfig, "bob@example.com", { inlineWidgets: false });
    await sendAsSpeaker(
      owner,
      params,
      { speakerGatewayUser: "josé@example.com", chatId: "c1" },
      proxyConfig,
      src,
    );
    expect(src.acquire).toHaveBeenLastCalledWith(proxyConfig, "josé@example.com", { inlineWidgets: false });
  });

  it("the send body carries the key across the HTTP boundary", () => {
    const body = parseSendBody(
      JSON.stringify({
        chatId: "c1",
        text: "hi",
        clientMessageId: "m1",
        instanceName: "lacneu",
        agentId: "a",
        canonical: "owner",
        speakerGatewayUser: "josé@example.com",
        speakerCanonical: "jose",
      }),
    );
    expect(body?.speakerCanonical).toBe("jose");
  });
});

describe("a participant's socket that closes before the send", () => {
  it("closed while the owner's hold is re-proven: no speaker send, exactly one owner send", async () => {
    const bob = fakeConn();
    const owner = fakeConn(async (method) => {
      if (method === "sessions.describe") {
        // The re-proof runs AFTER the socket is acquired: bob closes meanwhile.
        bob.end();
        return {
          payload: {
            session: {
              createdActor: { type: "human", id: "p-owner", identity: { type: "profile", id: "p-owner" } },
            },
          },
        };
      }
      return { payload: { runId: "k" } };
    });
    Object.assign(owner, { sessionClaimed: true, selfProfileId: "p-owner" });
    const { src, routed } = source(bob);
    await sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src);
    expect(bob.request).not.toHaveBeenCalled();
    expect(sends(owner)).toBe(1);
    expect(routed).toEqual([]);
  });

  it("the pool refuses to route onto a socket it no longer holds or that closed", async () => {
    const pool = new SpeakerPool();
    const bob = fakeConn();
    const conn = await pool.acquire("lacneu\u0000bob", async () => bob);
    const owner = ownerConn();
    // Closed, and the pool's reader has not yet seen the end: still in the pool.
    bob.end();
    expect(pool.route(conn, "r1", owner)).toBe(false);
    pool.closeAll();
  });

  it("a shared open that hands back a closed socket opens again", async () => {
    const pool = new SpeakerPool();
    const first = fakeConn();
    const second = fakeConn();
    let opens = 0;
    const open = async () => {
      opens += 1;
      if (opens === 1) {
        await new Promise((r) => setTimeout(r, 5));
        first.end();
        return first;
      }
      return second;
    };
    const [a, b] = await Promise.all([
      pool.acquire("lacneu\u0000bob", open),
      pool.acquire("lacneu\u0000bob", open),
    ]);
    // The caller that joined the shared open got a live socket, not the closed one.
    expect([a, b]).toContain(second);
    pool.closeAll();
  });
});

// Codex pass 6 (P1): the participant's socket opening and its ownership proof are WAITS
// between the send path's knowledge check and the request. The gate runs inside the one
// door (issueChatSend), right before the request, whichever socket sends.
describe("a newer knowledge choice announced while the participant's socket opens", () => {
  it("the turn is withheld (superseded) — neither socket sends, nothing stays routed", async () => {
    clearKnowledgeGuards();
    const guard = knowledgeGuard("lacneu", params.sessionKey);
    noteKnowledgeRevision(guard, 2);
    noteAppliedKnowledgeRevision(guard, 2, { injection: "off" });
    const owner = ownerConn();
    const bob = fakeConn();
    let open: () => void = () => {};
    const opening = new Promise<void>((r) => (open = r));
    const { src, routed, abandoned } = source(bob);
    (src.acquire as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await opening;
      return bob;
    });
    let withheld = false;
    const sending = sendAsSpeaker(
      owner,
      params,
      { speakerGatewayUser: "bob", chatId: "c1" },
      proxyConfig,
      src,
      knowledgeChatSendGate(guard, 2, () => {
        withheld = true;
      }),
    );
    // The owner's newer choice arrives now — and is not (yet) on the session.
    noteKnowledgeRevision(guard, 3);
    open();
    await expect(sending).rejects.toBeInstanceOf(KnowledgePolicyNotAppliedError);
    expect(sends(bob)).toBe(0);
    expect(sends(owner)).toBe(0);
    expect(routed).toEqual([]);
    // Never issued: the route is simply withdrawn — no "may be live" signal to the owner.
    expect(abandoned).toEqual([]);
    expect(withheld).toBe(true);
    clearKnowledgeGuards();
  });

  it("…the same on the owner's fallback after the participant's socket failed to open", async () => {
    clearKnowledgeGuards();
    const guard = knowledgeGuard("lacneu", params.sessionKey);
    noteKnowledgeRevision(guard, 2);
    noteAppliedKnowledgeRevision(guard, 2, { injection: "off" });
    const owner = ownerConn();
    const { src } = source(new Error("connect refused"));
    (src.acquire as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      noteKnowledgeRevision(guard, 3);
      throw new Error("connect refused");
    });
    await expect(
      sendAsSpeaker(owner, params, { speakerGatewayUser: "bob", chatId: "c1" }, proxyConfig, src, knowledgeChatSendGate(guard, 2)),
    ).rejects.toBeInstanceOf(KnowledgePolicyNotAppliedError);
    expect(sends(owner)).toBe(0);
    clearKnowledgeGuards();
  });
});

describe("a participant's socket declares widgets exactly when the conversation's would", () => {
  // Upstream offers `show_widget` on a turn only to the socket that SENT it: a
  // participant's socket without `inline-widgets` gave their turns no widgets.
  const withVersion = (v: string | null) => Object.assign(ownerConn(), { gatewayVersion: v });

  it("widgets on + a gateway that renders them: the participant's socket is asked WITH widgets", async () => {
    const bob = fakeConn();
    const { src } = source(bob);
    await sendAsSpeaker(
      withVersion("2026.9.6"),
      params,
      { speakerGatewayUser: "bob", chatId: "c1", inlineWidgets: true },
      proxyConfig,
      src,
    );
    expect(src.acquire).toHaveBeenCalledWith(proxyConfig, "bob", { inlineWidgets: true });
  });

  it("widgets off, or a gateway before the widget generation (or unknown): WITHOUT", async () => {
    for (const [inlineWidgets, version] of [
      [false, "2026.9.6"],
      [true, "2026.9.5"],
      [true, null],
    ] as const) {
      const bob = fakeConn();
      const { src } = source(bob);
      await sendAsSpeaker(
        withVersion(version),
        params,
        { speakerGatewayUser: "bob", chatId: "c1", inlineWidgets },
        proxyConfig,
        src,
      );
      expect(src.acquire).toHaveBeenCalledWith(proxyConfig, "bob", { inlineWidgets: false });
    }
  });

  it("the declaration is part of the socket's identity: one socket per (instance, person, declaration)", () => {
    expect(speakerPoolKey(proxyConfig, "bob", true)).not.toBe(speakerPoolKey(proxyConfig, "bob", false));
    expect(speakerPoolKey(proxyConfig, "bob", true)).toBe(speakerPoolKey(proxyConfig, "bob", true));
    expect(speakerCaps(true)).toEqual(["inline-widgets"]);
    expect(speakerCaps(false)).toEqual([]);
  });

  it("the pooled socket is opened with those caps", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const cfg = {
      ...(proxyConfig as unknown as Record<string, unknown>),
      instanceName: "widgets-caps-test",
      openclawGatewayUrl: "wss://gw.test",
      deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    } as unknown as BridgeConfig;
    const on = await defaultSpeakers.acquire(cfg, "carol", { inlineWidgets: true });
    const off = await defaultSpeakers.acquire(cfg, "carol", { inlineWidgets: false });
    expect(on).not.toBe(off);
    const caps = connect.mock.calls.map((c) => c[7]);
    expect(caps).toEqual([["inline-widgets"], []]);
    on.close();
    off.close();
    connect.mockRestore();
  });
});
