// Append-only live text (OpenClaw 2026.9.7): the connection restores the cumulative
// `message` / `data.text` before any reader, so the normalizer sees 9.6-shaped frames.
//
// The frames below are upstream's own where a test pins them:
//  - chat: ui/src/api/gateway-chat-events.node.test.ts:29-87 and :195-235 (v2026.9.7);
//  - agent: src/gateway/server-chat.agent-events.test.ts:4859-4890 (v2026.9.7) —
//    `[{ text: "one", delta: "one" }, { delta: " two" }]` then a final "one two".

import { describe, expect, it, vi } from "vitest";

import {
  LiveTextBaselines,
  mergeChatStreamMessage,
} from "../src/providers/openclaw/live-text-baseline.js";
import { OpenClawConnection, type GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";
import { createSeqTracker } from "../src/providers/openclaw/frame-seq.js";

const KEY = "agent:main:atrium:chat:u-testuser01:own-chat";
const RUN = "run-own";

const chat = (payload: Record<string, unknown>): GatewayFrame => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, runId: RUN, ...payload },
});
const assistant = (data: Record<string, unknown>, extra: Record<string, unknown> = {}): GatewayFrame => ({
  type: "event",
  event: "agent",
  payload: { sessionKey: KEY, runId: RUN, stream: "assistant", data, ...extra },
});
const messageOf = (frame: GatewayFrame) => (frame.payload as { message?: unknown }).message;
const dataOf = (frame: GatewayFrame) => (frame.payload as { data: Record<string, unknown> }).data;

describe("chat deltas: the cumulative message is rebuilt per run", () => {
  it("upstream's own sequence: snapshot, append, replace, append (canvas block kept)", () => {
    const canvas = { type: "canvas", url: "/__openclaw__/canvas/demo.html" };
    const snapshot = {
      role: "assistant",
      timestamp: 123,
      content: [{ type: "text", text: "Hello" }, canvas],
    };
    const b = new LiveTextBaselines();
    const first = b.project(chat({ state: "delta", message: snapshot }));
    expect(first.gap).toBeNull();
    const second = b.project(chat({ state: "delta", deltaText: " world\n " }));
    expect(messageOf(second.frame)).toEqual({
      ...snapshot,
      content: [{ type: "text", text: "Hello world\n " }, canvas],
    });
    const third = b.project(chat({ state: "delta", deltaText: "", replace: true }));
    expect(messageOf(third.frame)).toEqual({
      ...snapshot,
      content: [{ type: "text", text: "" }, canvas],
    });
    const fourth = b.project(chat({ state: "delta", deltaText: "New answer" }));
    expect(messageOf(fourth.frame)).toEqual({
      ...snapshot,
      content: [{ type: "text", text: "New answer" }, canvas],
    });
  });

  it("a frame that already carries its message passes through UNCHANGED (9.6 identity)", () => {
    const b = new LiveTextBaselines();
    for (const text of ["Bon", "Bonjour", "Bonjour à toi"]) {
      const frame = chat({
        state: "delta",
        deltaText: text.slice(-3),
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      const out = b.project(frame);
      expect(out.frame).toBe(frame);
      expect(out.gap).toBeNull();
    }
  });

  it("frames of other events, and run-less chat frames, are returned as is", () => {
    const b = new LiveTextBaselines();
    for (const frame of [
      { type: "res", id: "1", ok: true, payload: {} },
      { type: "event", event: "sessions.changed", payload: { key: KEY } },
      { type: "event", event: "chat", payload: { state: "delta", deltaText: "x" } },
    ] as GatewayFrame[]) {
      expect(b.project(frame)).toEqual({ frame, gap: null, addedBytes: 0 });
    }
  });

  it("a terminal ends the run's baseline: a later append-only delta is a GAP", () => {
    // ui/src/api/gateway-chat-events.node.test.ts:195-235: after `final`, a "suffix"
    // delta has nothing to append to — the Control UI closes the socket on it.
    for (const terminal of ["final", "error", "aborted"]) {
      const b = new LiveTextBaselines();
      b.project(chat({ state: "delta", message: { role: "assistant", content: "Before" } }));
      b.project(chat({ state: terminal }));
      const out = b.project(chat({ state: "delta", deltaText: "suffix" }));
      expect(out.gap).toEqual({ stream: "chat", runId: RUN, sessionKey: KEY });
      // The fragment is NOT forwarded: appended without its prefix it corrupts the reply.
      expect(out.frame.payload).toMatchObject({ state: "delta", deltaText: "" });
      expect(messageOf(out.frame)).toBeUndefined();
    }
  });

  it("a baseline of another session or agent is not one", () => {
    const b = new LiveTextBaselines();
    b.project(chat({ state: "delta", message: { role: "assistant", content: "A" } }));
    const other = b.project({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:other", runId: RUN, state: "delta", deltaText: "B" },
    });
    expect(other.gap?.stream).toBe("chat");
    const agent = b.project(chat({ state: "delta", agentId: "work", deltaText: "B" }));
    expect(agent.gap?.stream).toBe("chat");
  });

  it("mergeChatStreamMessage mirrors upstream on string content and a missing delta", () => {
    expect(mergeChatStreamMessage({ role: "assistant", content: "ab" }, { deltaText: "c" })).toEqual({
      role: "assistant",
      content: "abc",
    });
    const previous = { role: "assistant", content: "ab" };
    expect(mergeChatStreamMessage(previous, {})).toBe(previous);
    expect(mergeChatStreamMessage(previous, { deltaText: "" })).toBe(previous);
    expect(mergeChatStreamMessage(undefined, { deltaText: "x", replace: true })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "x" }],
    });
    expect(mergeChatStreamMessage(undefined, { deltaText: "x" })).toBeUndefined();
  });
});

describe("agent assistant deltas: data.text is rebuilt per run and item", () => {
  it("upstream's own pair: {text,delta} then {delta}", () => {
    const b = new LiveTextBaselines();
    const first = assistant({ text: "one", delta: "one" });
    expect(b.project(first).frame).toBe(first);
    const second = b.project(assistant({ delta: " two" }));
    expect(second.gap).toBeNull();
    expect(dataOf(second.frame)).toEqual({ delta: " two", text: "one two" });
  });

  it("the same item keeps appending; a replace restarts; a new item without its snapshot is a gap", () => {
    const b = new LiveTextBaselines();
    b.project(assistant({ text: "a", delta: "a", itemId: "i1" }));
    expect(dataOf(b.project(assistant({ delta: "b", itemId: "i1" })).frame).text).toBe("ab");
    expect(dataOf(b.project(assistant({ delta: "z", itemId: "i1", replace: true })).frame).text).toBe(
      "z",
    );
    const fresh = b.project(assistant({ delta: "new", itemId: "i2" }));
    expect(fresh.gap).toEqual({ stream: "agent", runId: RUN, sessionKey: KEY });
    expect("delta" in dataOf(fresh.frame)).toBe(false);
    expect("text" in dataOf(fresh.frame)).toBe(false);
  });

  it("a lifecycle end retires the item baseline", () => {
    const b = new LiveTextBaselines();
    b.project(assistant({ text: "a", delta: "a" }));
    b.project({
      type: "event",
      event: "agent",
      payload: { sessionKey: KEY, runId: RUN, stream: "lifecycle", data: { phase: "end" } },
    });
    expect(b.project(assistant({ delta: "b" })).gap?.stream).toBe("agent");
  });
});

class Clock {
  now = 1000.0;
  tick(seconds = 0.01): number {
    this.now += seconds;
    return this.now;
  }
}

/** The 9.7 wire for one reply "Bonjour à toi", on both streams. */
function wire97(): GatewayFrame[] {
  return [
    assistant({ text: "Bon", delta: "Bon" }),
    chat({ seq: 1, state: "delta", deltaText: "Bon", message: { role: "assistant", content: [{ type: "text", text: "Bon" }] } }),
    assistant({ delta: "jour" }),
    chat({ seq: 2, state: "delta", deltaText: "jour" }),
    assistant({ delta: " à toi" }),
    chat({ seq: 3, state: "delta", deltaText: " à toi" }),
  ];
}

function liveTexts(frames: GatewayFrame[]): string[] {
  const normalizer = new Normalizer(KEY);
  const clock = new Clock();
  normalizer.beginTurn(clock.now);
  normalizer.noteRunStarted(RUN, clock.now);
  const events: BridgeEvent[] = [];
  for (const frame of frames) events.push(...normalizer.feed(frame, clock.tick()));
  return events
    .filter((e) => e.type === "message.snapshot" || e.type === "message.delta")
    .map((e) => (e as { text?: string }).text ?? "");
}

describe("what the normalizer shows from the 9.7 wire", () => {
  it("raw, the live reply FREEZES on its first fragment (the defect this module fixes)", () => {
    const shown = liveTexts(wire97());
    expect(shown.at(-1)).toBe("Bon");
  });

  it("through the baselines, it grows exactly as on 9.6", () => {
    const b = new LiveTextBaselines();
    const shown = liveTexts(wire97().map((f) => b.project(f).frame));
    expect(shown.at(-1)).toBe("Bonjour à toi");
  });
});

/** A connection whose receive path runs for real, with the socket and queue stubbed. */
function receivingConnection(
  request?: (method: string, params: unknown) => Promise<unknown>,
  realSeq = false,
) {
  const conn = Object.create(OpenClawConnection.prototype) as OpenClawConnection;
  const pushed: GatewayFrame[] = [];
  const requests: [string, unknown][] = [];
  Object.assign(conn, {
    runsCarriedElsewhere: new Set<string>(),
    liveText: new LiveTextBaselines(),
    liveTextRereads: new Map(),
    seq: realSeq ? createSeqTracker() : { observe: () => null },
    configChangedListeners: new Set(),
    sessionSharingListeners: new Set(),
    rosterEpoch: 0,
    gatewayVersion: "2026.9.7",
    push: (f: GatewayFrame) => pushed.push(f),
    request: (method: string, params: unknown) => {
      requests.push([method, params]);
      return (request ?? (async () => ({ payload: {} })))(method, params);
    },
  });
  const onMessage = (conn as unknown as { onMessage: (raw: Buffer) => void }).onMessage.bind(conn);
  return {
    pushed,
    requests,
    receive: (frame: GatewayFrame) => onMessage(Buffer.from(JSON.stringify(frame))),
    receiveRaw: (raw: Buffer) => onMessage(raw),
  };
}

describe("the connection projects BEFORE any consumer sees the frame", () => {
  it("an append-only chat delta reaches the consumer carrying the whole message", () => {
    const c = receivingConnection();
    c.receive(chat({ seq: 1, state: "delta", deltaText: "Bon", message: { role: "assistant", content: [{ type: "text", text: "Bon" }] } }));
    c.receive(chat({ seq: 2, state: "delta", deltaText: "jour" }));
    expect(messageOf(c.pushed[1]!)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Bonjour" }],
    });
    expect(c.requests).toEqual([]);
  });

  it("a missing baseline re-reads the in-flight text once, and hands it on as a snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const c = receivingConnection(async () => ({
        payload: { inFlightRun: { runId: RUN, text: "Bonjour" } },
      }));
      c.receive(chat({ seq: 5, state: "delta", deltaText: " à" }));
      c.receive(chat({ seq: 6, state: "delta", deltaText: " toi" }));
      // One read in flight at a time, and only `chat.history` of that session.
      expect(c.requests).toHaveLength(1);
      expect(c.requests[0]![0]).toBe("chat.history");
      expect(c.requests[0]![1]).toMatchObject({ sessionKey: KEY, limit: 1 });
      await vi.waitFor(() => expect(c.pushed).toHaveLength(3));
      // The two wire deltas went on WITHOUT their fragment…
      expect(c.pushed.slice(0, 2).map((f) => (f.payload as { deltaText: string }).deltaText)).toEqual([
        "",
        "",
      ]);
      // …and the re-read text arrived as a snapshot of the run.
      expect(c.pushed[2]).toMatchObject({
        type: "event",
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "Bonjour" }] },
        },
      });
      // Spaced: a further gap within two seconds asks nothing.
      c.receive(chat({ seq: 7, state: "delta", deltaText: "!" }));
      expect(c.requests).toHaveLength(1);
      vi.setSystemTime(Date.now() + 2_500);
      c.receive(chat({ seq: 8, state: "delta", deltaText: "!" }));
      expect(c.requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-read that comes back after a real snapshot is dropped (the snapshot is newer)", async () => {
    let answer: (v: unknown) => void = () => {};
    const c = receivingConnection(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    c.receive(chat({ seq: 5, state: "delta", deltaText: " à" }));
    c.receive(chat({ seq: 6, state: "delta", deltaText: " à toi", message: { role: "assistant", content: "Bonjour à toi" } }));
    answer({ payload: { inFlightRun: { runId: RUN, text: "Bonjour" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.pushed).toHaveLength(2);
  });

  it("an agent-stream gap asks nothing: the chat stream carries the reply's display", () => {
    const c = receivingConnection();
    c.receive(assistant({ delta: "orphan" }));
    expect(c.requests).toEqual([]);
    expect("delta" in dataOf(c.pushed[0]!)).toBe(false);
  });
});

describe("a re-read snapshot is weighed against the inbound byte ceiling", () => {
  it("counts its serialized size, like any frame read off the wire", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const conn = Object.create(OpenClawConnection.prototype) as OpenClawConnection;
    const internals = conn as unknown as { queuedBytes: number; queue: unknown[] };
    Object.assign(conn, {
      runsCarriedElsewhere: new Set<string>(),
      liveText: new LiveTextBaselines(),
      liveTextRereads: new Map(),
      seq: { observe: () => null },
      configChangedListeners: new Set(),
      sessionSharingListeners: new Set(),
      closedListeners: new Set(),
      pending: new Map(),
      rosterEpoch: 0,
      gatewayVersion: "2026.9.7",
      queue: [],
      queuedBytes: 0,
      closed: false,
      waiter: null,
      ws: { close: () => {} },
      request: async () => ({ payload: { inFlightRun: { runId: RUN, text: big } } }),
    });
    const onMessage = (conn as unknown as { onMessage: (raw: Buffer) => void }).onMessage.bind(conn);
    const gap = Buffer.from(JSON.stringify(chat({ seq: 9, state: "delta", deltaText: "y" })));
    onMessage(gap);
    const afterGap = internals.queuedBytes;
    await vi.waitFor(() => expect(internals.queue).toHaveLength(2));
    // The whole serialized frame: the text plus its envelope.
    expect(internals.queuedBytes - afterGap).toBeGreaterThan(big.length);
  });
});

describe("a rebuilt frame weighs what it carries (MAX_INBOUND_BYTES)", () => {
  it("reports the cumulative text it ADDED, carried forward per delta; 0 on a received frame", () => {
    const b = new LiveTextBaselines();
    // A 9.6-shaped frame (message present) is returned as received: nothing added.
    expect(
      b.project(chat({ state: "delta", deltaText: "é", message: { role: "assistant", content: [{ type: "text", text: "é" }] } }))
        .addedBytes,
    ).toBe(0);
    // 9.7 appends: the rebuilt message carries "éa" then "éab", in UTF-8 bytes.
    expect(b.project(chat({ state: "delta", deltaText: "a" })).addedBytes).toBe(3);
    expect(b.project(chat({ state: "delta", deltaText: "b" })).addedBytes).toBe(4);
    // A replace restarts from the delta alone.
    expect(b.project(chat({ state: "delta", deltaText: "zz", replace: true })).addedBytes).toBe(2);
    // The agent stream, same rule.
    expect(b.project(assistant({ text: "ü", delta: "ü" })).addedBytes).toBe(0);
    expect(b.project(assistant({ delta: "x" })).addedBytes).toBe(3);
    expect(b.project(assistant({ delta: "y" })).addedBytes).toBe(4);
  });

  it("a long 2026.9.7 reply with a stalled consumer trips the cap instead of growing unseen", () => {
    const conn = Object.create(OpenClawConnection.prototype) as OpenClawConnection;
    const closes: string[] = [];
    const internals = conn as unknown as { overflowClosing?: boolean; queue: unknown[] };
    Object.assign(conn, {
      runsCarriedElsewhere: new Set<string>(),
      liveText: new LiveTextBaselines(),
      liveTextRereads: new Map(),
      seq: { observe: () => null },
      configChangedListeners: new Set(),
      sessionSharingListeners: new Set(),
      rosterEpoch: 0,
      gatewayVersion: "2026.9.7",
      queue: [],
      queuedBytes: 0,
      closed: false,
      waiter: null, // nobody reads: the consumer is stalled
      ws: { close: () => {} },
      onClose: (err: Error) => {
        closes.push(err.message);
        (conn as unknown as { closed: boolean }).closed = true;
      },
    });
    const onMessage = (conn as unknown as { onMessage: (raw: Buffer) => void }).onMessage.bind(conn);
    const base = "x".repeat(1024 * 1024);
    let wire = 0;
    const send = (frame: GatewayFrame) => {
      const raw = Buffer.from(JSON.stringify(frame));
      wire += raw.length;
      onMessage(raw);
    };
    send(chat({ seq: 1, state: "delta", deltaText: "x", message: { role: "assistant", content: [{ type: "text", text: base }] } }));
    for (let i = 2; i <= 200 && closes.length === 0; i++) {
      send(chat({ seq: i, state: "delta", deltaText: "more text " }));
    }
    // What arrived is barely a megabyte; what the queue held was > 128 MiB of snapshots.
    expect(wire).toBeLessThan(2 * 1024 * 1024);
    expect(closes).toEqual(["inbound queue overflow"]);
    expect(internals.overflowClosing).toBe(true);
  });

  it("a gateway that sends the base every time is weighed exactly as before (wire bytes)", () => {
    const conn = Object.create(OpenClawConnection.prototype) as OpenClawConnection;
    const internals = conn as unknown as { queuedBytes: number };
    Object.assign(conn, {
      runsCarriedElsewhere: new Set<string>(),
      liveText: new LiveTextBaselines(),
      liveTextRereads: new Map(),
      seq: { observe: () => null },
      configChangedListeners: new Set(),
      sessionSharingListeners: new Set(),
      rosterEpoch: 0,
      queue: [],
      queuedBytes: 0,
      closed: false,
      waiter: null,
    });
    const onMessage = (conn as unknown as { onMessage: (raw: Buffer) => void }).onMessage.bind(conn);
    let wire = 0;
    for (const text of ["Bon", "Bonjour", "Bonjour à toi"]) {
      const raw = Buffer.from(
        JSON.stringify(chat({ state: "delta", deltaText: "x", message: { role: "assistant", content: [{ type: "text", text }] } })),
      );
      wire += raw.length;
      onMessage(raw);
    }
    expect(internals.queuedBytes).toBe(wire);
  });
});

describe("retransmitted and late frames never re-append (seq ordering before accumulation)", () => {
  const base = (seq: number, text: string) =>
    chat({ seq, state: "delta", deltaText: text, message: { role: "assistant", content: [{ type: "text", text }] } });
  const textOf = (p: { frame: GatewayFrame }) =>
    ((messageOf(p.frame) as { content: { text: string }[] }).content[0]!.text);

  it("an EXACT retransmission of an append returns the frame the first copy produced", () => {
    const b = new LiveTextBaselines();
    b.project(base(1, "Hello"));
    const first = b.project(chat({ seq: 2, state: "delta", deltaText: " world" }));
    const again = b.project(chat({ seq: 2, state: "delta", deltaText: " world" }));
    expect(textOf(first)).toBe("Hello world");
    expect(again.frame).toBe(first.frame);
    expect(again.addedBytes).toBe(0);
    // …and the run goes on from the right text.
    expect(textOf(b.project(chat({ seq: 3, state: "delta", deltaText: "!" })))).toBe("Hello world!");
  });

  it("through the normalizer, the retransmission adds nothing (no 'world world')", () => {
    const b = new LiveTextBaselines();
    const frames = [
      base(1, "Hello"),
      chat({ seq: 2, state: "delta", deltaText: " world" }),
      chat({ seq: 2, state: "delta", deltaText: " world" }),
    ].map((f) => b.project(f).frame);
    expect(liveTexts(frames).at(-1)).toBe("Hello world");
  });

  it("the same seq with OTHER content cannot be placed: withheld, reported, baseline untouched", () => {
    const b = new LiveTextBaselines();
    b.project(base(1, "Hello"));
    b.project(chat({ seq: 2, state: "delta", deltaText: " world" }));
    const other = b.project(chat({ seq: 2, state: "delta", deltaText: " there" }));
    expect(other.gap).toEqual({ stream: "chat", runId: RUN, sessionKey: KEY });
    expect(other.frame.payload).toMatchObject({ deltaText: "" });
    expect(textOf(b.project(chat({ seq: 3, state: "delta", deltaText: "!" })))).toBe("Hello world!");
  });

  it("an OLDER append after a newer one is not re-applied", () => {
    const b = new LiveTextBaselines();
    b.project(base(1, "A"));
    b.project(chat({ seq: 2, state: "delta", deltaText: "B" }));
    b.project(chat({ seq: 3, state: "delta", deltaText: "C" }));
    const late = b.project(chat({ seq: 2, state: "delta", deltaText: "B" }));
    expect(late.gap?.stream).toBe("chat");
    expect(textOf(b.project(chat({ seq: 4, state: "delta", deltaText: "D" })))).toBe("ABCD");
  });

  it("an older CUMULATIVE frame passes as received but does not rewind the baseline", () => {
    const b = new LiveTextBaselines();
    b.project(base(1, "Hello"));
    b.project(chat({ seq: 2, state: "delta", deltaText: " world" }));
    const stale = base(1, "Hello");
    expect(b.project(stale)).toEqual({ frame: stale, gap: null, addedBytes: 0 });
    expect(textOf(b.project(chat({ seq: 3, state: "delta", deltaText: "!" })))).toBe("Hello world!");
  });

  it("the agent stream follows the same rule", () => {
    const b = new LiveTextBaselines();
    b.project(assistant({ text: "one", delta: "one" }, { seq: 1 }));
    const first = b.project(assistant({ delta: " two" }, { seq: 2 }));
    const again = b.project(assistant({ delta: " two" }, { seq: 2 }));
    expect(dataOf(first.frame).text).toBe("one two");
    expect(again.frame).toBe(first.frame);
    expect(b.project(assistant({ delta: " zz" }, { seq: 2 })).gap?.stream).toBe("agent");
    expect(dataOf(b.project(assistant({ delta: "!" }, { seq: 3 })).frame).text).toBe("one two!");
  });

  it("9.6 cumulative frames, retransmitted or not, pass through exactly as received", () => {
    const b = new LiveTextBaselines();
    for (const f of [base(1, "Bon"), base(2, "Bonjour"), base(2, "Bonjour"), base(1, "Bon"), base(3, "Bonjour!")]) {
      expect(b.project(f)).toEqual({ frame: f, gap: null, addedBytes: 0 });
    }
  });
});

describe("a LOST frame retires the baselines before the next append", () => {
  const shown = (pushed: GatewayFrame[]) =>
    pushed
      .map((f) => messageOf(f) as { content?: { text: string }[] } | undefined)
      .filter((m) => m?.content !== undefined)
      .map((m) => m!.content![0]!.text);

  it("an unreadable frame mid-stream: nothing corrupted is shown, the re-read restores the text", async () => {
    const c = receivingConnection(async () => ({
      payload: { inFlightRun: { runId: RUN, text: "Hello world!" } },
    }));
    c.receive(chat({ seq: 1, state: "delta", deltaText: "Hello", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }));
    c.receiveRaw(Buffer.from("{ not json")); // the " world" append, lost
    c.receive(chat({ seq: 3, state: "delta", deltaText: "!" }));
    expect(c.requests.map(([m]) => m)).toEqual(["chat.history"]);
    await vi.waitFor(() => expect(shown(c.pushed)).toContain("Hello world!"));
    expect(shown(c.pushed)).not.toContain("Hello!");
  });

  it("a hole in the envelope seq does the same", async () => {
    const c = receivingConnection(
      async () => ({ payload: { inFlightRun: { runId: RUN, text: "Hello world!" } } }),
      true,
    );
    const env = (seq: number, frame: GatewayFrame): GatewayFrame => ({ ...frame, seq });
    c.receive(env(1, chat({ seq: 1, state: "delta", deltaText: "Hello", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } })));
    // envelope 2 (" world") never arrives
    c.receive(env(3, chat({ seq: 3, state: "delta", deltaText: "!" })));
    expect(c.requests.map(([m]) => m)).toEqual(["chat.history"]);
    await vi.waitFor(() => expect(shown(c.pushed)).toContain("Hello world!"));
    expect(shown(c.pushed)).not.toContain("Hello!");
  });
});

describe("a re-read that returns after the run's terminal is dropped", () => {
  it("terminal while the re-read is pending: the late snapshot never reaches the consumer", async () => {
    let answer: (v: unknown) => void = () => {};
    const c = receivingConnection(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    c.receive(chat({ seq: 5, state: "delta", deltaText: " à" })); // gap → re-read pending
    c.receive(chat({ seq: 6, state: "final", message: { role: "assistant", content: [{ type: "text", text: "Bonjour à toi" }] } }));
    answer({ payload: { inFlightRun: { runId: RUN, text: "Bonjour à" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.pushed.map((f) => (f.payload as { state: string }).state)).toEqual(["delta", "final"]);
  });
});
