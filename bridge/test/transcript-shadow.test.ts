// The SHADOW reconciler (redesign phase 1, design §4): when it reads the transcript
// back, with which cursor, how reads coalesce, the Control UI's bounded recovery after
// a final without a message — and that its only output is `apply` (it never writes a
// bubble). Deterministic: the gateway, Convex and time are injected.

import { describe, expect, it } from "vitest";

import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
import {
  TERMINAL_RECOVERY_DELAYS_MS,
  TranscriptShadow,
  type TranscriptApply,
} from "../src/providers/openclaw/transcript-shadow.js";

const KEY = "agent:alice:atrium:chat:u-1:c1";

type Reply = Record<string, unknown>;
const page = (cursor: string | null, rows: Reply[] = [], extra: Reply = {}): Reply => ({
  sessionKey: KEY,
  sessionId: "s-1",
  messages: rows,
  ...(cursor === null ? {} : { deltaCursor: cursor }),
  sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] },
  ...extra,
});
const delta = (cursor: string, envelopes: Reply[] = []): Reply => ({
  kind: "delta",
  deltaCursor: cursor,
  messages: envelopes,
  sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] },
});
const assistantRow = (id: string, seq: number, runId: string, text = "réponse"): Reply => ({
  role: "assistant",
  content: [{ type: "text", text }],
  __openclaw: { id, seq, runId },
});
const env = (row: Reply): Reply => ({ sessionKey: KEY, message: row });
const chatFrame = (payload: Reply) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, ...payload },
});

/** A scriptable gateway + Convex. `replies` are consumed in order; once empty, every
 *  read answers an empty delta that keeps the cursor. */
function rig(opts: { replies?: Reply[]; failApply?: number } = {}) {
  const replies = [...(opts.replies ?? [])];
  const reads: Array<string | null> = [];
  const applies: TranscriptApply[] = [];
  const sleeps: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failApply = opts.failApply ?? 0;
  let lastCursor = "c:0";
  const gate: Array<() => void> = [];
  let holdReads = false;
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: KEY,
    readHistory: async (cursor) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      reads.push(cursor);
      if (holdReads) await new Promise<void>((r) => gate.push(r));
      await Promise.resolve();
      inFlight--;
      const next = replies.shift();
      if (next !== undefined) {
        if (typeof next.deltaCursor === "string") lastCursor = next.deltaCursor;
        return next;
      }
      return delta(lastCursor);
    },
    apply: async (p) => {
      if (failApply > 0) {
        failApply--;
        throw new Error("convex down");
      }
      applies.push(p);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1000,
    log: () => {},
  });
  return {
    shadow,
    reads,
    applies,
    sleeps,
    get maxInFlight() {
      return maxInFlight;
    },
    hold(on: boolean) {
      holdReads = on;
      if (!on) while (gate.length) gate.shift()!();
    },
    failNextApplies(n: number) {
      failApply = n;
    },
  };
}

const flush = async (s: TranscriptShadow) => {
  for (let i = 0; i < 20; i++) {
    await s.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("off by default — nothing is read until the instance switch says so", () => {
  it("frames and acks are ignored while off", async () => {
    const r = rig();
    r.shadow.observeFrame(chatFrame({ runId: "run-1", state: "final", message: {} }));
    r.shadow.noteAck("ok");
    await flush(r.shadow);
    expect(r.reads).toEqual([]);
    expect(r.shadow.active).toBe(false);
  });

  it("switching it on reads a TAIL PAGE when no cursor is known, then resumes from its cursor", async () => {
    const r = rig({ replies: [page("c:1", [assistantRow("e1", 1, "run-1")])] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    expect(r.reads).toEqual([null]);
    expect(r.applies[0]).toMatchObject({ kind: "page", deltaCursor: "c:1", sessionId: "s-1" });
    r.shadow.observeFrame(chatFrame({ runId: "run-2", state: "final", message: {} }));
    await flush(r.shadow);
    expect(r.reads).toEqual([null, "c:1"]);
  });

  it("Convex's stored cursor is resumed on a fresh process", async () => {
    const r = rig();
    r.shadow.configure({ mode: "shadow", cursor: { sessionId: "s-1", deltaCursor: "c:77" } });
    await flush(r.shadow);
    expect(r.reads).toEqual(["c:77"]);
  });

  it("`on` behaves as shadow in phase 1, and `off` again stops it", async () => {
    const r = rig();
    r.shadow.configure({ mode: "on" });
    await flush(r.shadow);
    expect(r.reads).toHaveLength(1);
    r.shadow.configure({ mode: "off" });
    r.shadow.observeFrame(chatFrame({ runId: "run-1", state: "final", message: {} }));
    await flush(r.shadow);
    expect(r.reads).toHaveLength(1);
  });
});

describe("triggers (design §4.1)", () => {
  const on = async (replies: Reply[] = []) => {
    const r = rig({ replies: [page("c:1"), ...replies] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.reads.length = 0;
    r.applies.length = 0;
    return r;
  };

  it("a terminal of ANY run of the session reads once, and carries the run's status", async () => {
    const r = await on();
    r.shadow.observeFrame(chatFrame({ runId: "announce:v1:x:y", state: "final", message: { role: "assistant" } }));
    await flush(r.shadow);
    expect(r.reads).toEqual(["c:1"]);
    expect(r.applies[0]!.terminals).toEqual([
      { runId: "announce:v1:x:y", status: "completed", at: 1000 },
    ]);
  });

  it("a delta, another session's frame, a run-less frame or a non-chat event reads nothing", async () => {
    const r = await on();
    r.shadow.observeFrame(chatFrame({ runId: "run-1", state: "delta", deltaText: "x" }));
    r.shadow.observeFrame({ type: "event", event: "chat", payload: { sessionKey: "other", runId: "r", state: "final" } });
    r.shadow.observeFrame(chatFrame({ state: "final" }));
    r.shadow.observeFrame({ type: "event", event: "agent", payload: { sessionKey: KEY, runId: "r" } });
    await flush(r.shadow);
    expect(r.reads).toEqual([]);
  });

  it("the ACK `ok` reads; `started`/`in_flight` are custody, not persistence", async () => {
    const r = await on();
    r.shadow.noteAck("started");
    r.shadow.noteAck("in_flight");
    await flush(r.shadow);
    expect(r.reads).toEqual([]);
    r.shadow.noteAck("ok");
    await flush(r.shadow);
    expect(r.reads).toEqual(["c:1"]);
  });

  it("CU-13: a final WITHOUT a message reads, then at 100/400/1500/3000 ms — five reads, then silence", async () => {
    const r = await on();
    r.shadow.observeFrame(chatFrame({ runId: "run-steered", state: "final" }));
    await flush(r.shadow);
    expect(r.reads).toHaveLength(1 + TERMINAL_RECOVERY_DELAYS_MS.length);
    expect(r.sleeps).toEqual([...TERMINAL_RECOVERY_DELAYS_MS]);
    expect(r.applies[0]!.terminals).toEqual([
      { runId: "run-steered", status: "completed", emptyFinal: true, at: 1000 },
    ]);
  });

  it("CU-13: the recovery STOPS as soon as a visible row of that run was read", async () => {
    const r = await on([delta("c:2"), delta("c:3", [env(assistantRow("e9", 9, "run-late"))])]);
    r.shadow.observeFrame(chatFrame({ runId: "run-late", state: "final" }));
    await flush(r.shadow);
    expect(r.reads).toEqual(["c:1", "c:2"]);
    // 2 reads, 1 sleep — not five.
    expect(r.sleeps).toEqual([100]);
  });

  it("a hidden row (NO_REPLY) does not end the recovery: nothing visible was found", async () => {
    const r = await on([delta("c:2", [env(assistantRow("e9", 9, "run-x", "NO_REPLY"))])]);
    r.shadow.observeFrame(chatFrame({ runId: "run-x", state: "final" }));
    await flush(r.shadow);
    expect(r.reads).toHaveLength(5);
  });
});

describe("read ordering for Convex's freshness guard", () => {
  it("every apply carries a STRICTLY increasing issue time, even on a frozen clock", async () => {
    const r = rig({ replies: [page("c:1"), { kind: "reset" }, page("c:2")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteAck("ok");
    await flush(r.shadow);
    r.shadow.observeFrame(chatFrame({ runId: "x", state: "aborted" }));
    await flush(r.shadow);
    const stamps = r.applies.map((a) => a.readAt);
    expect(stamps.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    // The fake clock never moves (now() = 1000): the ordering comes from the guard.
    expect(stamps[0]).toBe(1000);
  });
});

describe("cost: one read in flight, one chained", () => {
  it("a burst of triggers during a read costs exactly ONE more read", async () => {
    const r = rig({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.hold(true);
    r.shadow.observeFrame(chatFrame({ runId: "a", state: "final", message: {} }));
    for (const id of ["b", "c", "d"]) {
      r.shadow.observeFrame(chatFrame({ runId: id, state: "aborted" }));
    }
    r.shadow.noteAck("ok");
    r.hold(false);
    await flush(r.shadow);
    expect(r.reads).toHaveLength(3); // page + the read in flight + ONE chained
    expect(r.maxInFlight).toBe(1);
    // Every terminal reached Convex exactly once, in order.
    expect(r.applies.flatMap((a) => a.terminals.map((t) => t.runId))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("resets and failures", () => {
  it("a `reset` is recorded, the cursor dropped, and a fresh tail page read in the SAME read", async () => {
    const r = rig({ replies: [page("c:1"), { kind: "reset" }, page("c:9", [assistantRow("e1", 1, "r")])] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteAck("ok");
    await flush(r.shadow);
    expect(r.reads).toEqual([null, "c:1", null]);
    expect(r.applies.map((a) => a.kind)).toEqual(["page", "reset", "page"]);
    expect(r.applies[2]!.deltaCursor).toBe("c:9");
  });

  it("a failed apply keeps its terminals for the next one (nothing lost, nothing doubled)", async () => {
    const r = rig({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.failNextApplies(1);
    r.shadow.observeFrame(chatFrame({ runId: "keep-me", state: "error" }));
    await flush(r.shadow);
    expect(r.applies).toHaveLength(1); // the page only: the terminal's apply failed
    r.shadow.noteAck("ok");
    await flush(r.shadow);
    const all = r.applies.flatMap((a) => a.terminals.map((t) => t.runId));
    expect(all).toEqual(["keep-me"]);
  });

  it("a gateway error never escapes (the turn pipeline is not its concern)", async () => {
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: KEY,
      readHistory: async () => {
        throw new Error("INVALID_REQUEST");
      },
      apply: async () => {},
      log: () => {},
    });
    shadow.configure({ mode: "shadow" });
    await shadow.idle();
    expect(shadow.stats.failures).toBe(1);
  });

  it("close() ends everything", async () => {
    const r = rig();
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.close();
    r.shadow.observeFrame(chatFrame({ runId: "r", state: "final", message: {} }));
    r.shadow.noteAck("ok");
    await flush(r.shadow);
    expect(r.reads).toHaveLength(1);
  });
});

// ── Properties, over seeded random schedules ─────────────────────────────────────────

/** mulberry32 — a deterministic PRNG so every failure replays from its seed. */
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

describe("properties (seeded schedules)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: one read at a time, cursors only move forward, every terminal posted once`, async () => {
      const rand = prng(seed);
      let cursorN = 1;
      const replies: Reply[] = [page("c:1")];
      for (let i = 0; i < 60; i++) {
        if (rand() < 0.08) replies.push({ kind: "reset" });
        cursorN++;
        replies.push(rand() < 0.15 ? page(`c:${cursorN}`) : delta(`c:${cursorN}`));
      }
      const r = rig({ replies });
      r.shadow.configure({ mode: "shadow" });
      const observed: string[] = [];
      for (let step = 0; step < 30; step++) {
        const x = rand();
        if (x < 0.5) {
          const id = `run-${seed}-${step}`;
          observed.push(id);
          const states = ["final", "error", "aborted"] as const;
          r.shadow.observeFrame(
            chatFrame({
              runId: id,
              state: states[Math.floor(rand() * 3)],
              message: rand() < 0.7 ? { role: "assistant" } : undefined,
            }),
          );
        } else if (x < 0.7) {
          r.shadow.noteAck(rand() < 0.5 ? "ok" : "started");
        } else if (x < 0.75) {
          r.hold(true);
        } else {
          r.hold(false);
        }
        if (rand() < 0.3) await new Promise((res) => setTimeout(res, 0));
      }
      r.hold(false);
      await flush(r.shadow);
      expect(r.maxInFlight, "never two reads at once").toBe(1);
      const posted = r.applies.flatMap((a) => a.terminals.map((t) => t.runId));
      expect(posted, "each observed terminal is posted exactly once, in order").toEqual(observed);
      // A non-null cursor handed to a read is always one the gateway gave earlier, and
      // never one OLDER than a cursor already used (no rewind except through a reset).
      let last = 0;
      for (const c of r.reads) {
        if (c === null) {
          last = 0;
          continue;
        }
        const n = Number(c.slice(2));
        expect(n, `cursor ${c} after c:${last}`).toBeGreaterThanOrEqual(last);
        last = n;
      }
    });
  }
});

// ── Phase 2: session events, the input guard, directly applied rows ─────────────────

/** A fake session-events source: the test calls the attached listener itself. */
function eventSource() {
  let listener: import("../src/providers/openclaw/transcript-shadow.js").SessionEventListener | null = null;
  let attaches = 0;
  let detaches = 0;
  return {
    source: {
      attach(_key: string, l: NonNullable<typeof listener>) {
        attaches++;
        listener = l;
        return () => {
          detaches++;
          listener = null;
        };
      },
    },
    get listener() {
      return listener;
    },
    get counts() {
      return { attaches, detaches };
    },
  };
}

/** The rig, with events, a foreground run and a reply script that RECORDS the
 *  inputRunIds each read asked about. */
function rig2(opts: { replies?: Reply[]; foreground?: () => string | null; now?: () => number } = {}) {
  const replies = [...(opts.replies ?? [])];
  const reads: Array<{ cursor: string | null; inputRunIds?: readonly string[] }> = [];
  const applies: TranscriptApply[] = [];
  const src = eventSource();
  let lastCursor = "c:0";
  let failApplies = 0;
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: KEY,
    readHistory: async (cursor, o) => {
      reads.push({ cursor, ...(o?.inputRunIds === undefined ? {} : { inputRunIds: o.inputRunIds }) });
      await Promise.resolve();
      const next = replies.shift();
      if (next !== undefined) {
        if (typeof next.deltaCursor === "string") lastCursor = next.deltaCursor;
        return next;
      }
      return delta(lastCursor);
    },
    apply: async (p) => {
      if (failApplies > 0) {
        failApplies--;
        throw new Error("convex down");
      }
      applies.push(p);
    },
    events: src.source,
    foregroundRunId: opts.foreground ?? (() => null),
    sleep: async () => {},
    now: opts.now ?? (() => 1000),
    log: () => {},
  });
  return {
    shadow,
    reads,
    applies,
    src,
    push(r: Reply) {
      replies.push(r);
    },
    failNextApplies(n: number) {
      failApplies = n;
    },
  };
}
const userEnv = (id: string, seq: number, sendId: string, extra: Reply = {}): Reply => ({
  sessionKey: KEY,
  sessionId: "s-1",
  message: { role: "user", content: "q", __openclaw: { id, seq, idempotencyKey: `${sendId}:user` } },
  ...extra,
});

describe("phase 2 — the session-events connection feeds the reconciler", () => {
  it("attaches when switched on, detaches when switched off or closed", async () => {
    const r = rig2();
    expect(r.src.counts.attaches).toBe(0);
    r.shadow.configure({ mode: "shadow" });
    expect(r.src.counts.attaches).toBe(1);
    r.shadow.configure({ mode: "shadow" }); // already on: no second attach
    expect(r.src.counts.attaches).toBe(1);
    r.shadow.configure({ mode: "off" });
    expect(r.src.counts.detaches).toBe(1);
    r.shadow.configure({ mode: "shadow" });
    r.shadow.close();
    expect(r.src.counts).toEqual({ attaches: 2, detaches: 2 });
    await flush(r.shadow);
  });

  it("the subscription (re)established reads the transcript back", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.src.listener!.onSubscribed();
    await flush(r.shadow);
    expect(r.reads.map((x) => x.cursor)).toEqual([null, "c:1"]);
  });

  it("a user row is applied DIRECTLY (kind `live`, rows only) and the transcript is read back", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.applies.length = 0;
    r.src.listener!.onSessionMessage(userEnv("u5", 5, "webchat-a"));
    await flush(r.shadow);
    const live = r.applies.filter((a) => a.kind === "live");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ sessionId: "s-1", terminals: [], unidentified: 0 });
    expect(live[0]!).not.toHaveProperty("deltaCursor");
    expect(live[0]!.rows.map((x) => x.entryId)).toEqual(["u5"]);
    expect(r.reads.map((x) => x.cursor)).toEqual([null, "c:1"]);
  });

  it("a row the read already brought is not posted again", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.push(delta("c:2", [userEnv("u5", 5, "webchat-a")]));
    r.applies.length = 0;
    r.src.listener!.onSessionMessage(userEnv("u5", 5, "webchat-a"));
    await flush(r.shadow);
    expect(r.applies.map((a) => a.kind)).toEqual(["delta"]);
  });

  it("while the turn is live, a non-user row of it asks for no read (its terminal will)", async () => {
    const r = rig2({ replies: [page("c:1")], foreground: () => "webchat-a" });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.src.listener!.onSessionMessage({
      sessionKey: KEY,
      hasActiveRun: true,
      message: { role: "toolResult", toolCallId: "t", content: [], __openclaw: { id: "t1", seq: 6, runId: "webchat-a" } },
    });
    await flush(r.shadow);
    expect(r.reads).toHaveLength(1);
    // A USER row during the same live turn reads (custody changed).
    r.src.listener!.onSessionMessage(userEnv("u7", 7, "webchat-b", { hasActiveRun: true }));
    await flush(r.shadow);
    expect(r.reads).toHaveLength(2);
  });

  it("sessions.changed: custody reasons and compaction read; housekeeping does not", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    for (const reason of ["patch", "chat.title"]) r.src.listener!.onSessionsChanged({ sessionKey: KEY, reason });
    await flush(r.shadow);
    expect(r.reads).toHaveLength(1);
    r.src.listener!.onSessionsChanged({ sessionKey: KEY, reason: "agent.input.settled" });
    await flush(r.shadow);
    r.src.listener!.onSessionsChanged({ sessionKey: KEY, reason: "compact" });
    await flush(r.shadow);
    expect(r.reads.map((x) => x.cursor)).toEqual([null, "c:1", "c:1"]);
  });

  it("a session RESET drops the cursor (fresh tail page) — and a read issued before it never restores it", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    // A read in flight with the OLD cursor, then the reset lands before it posts.
    r.push(delta("c:2"));
    r.shadow.requestRead("test");
    r.src.listener!.onSessionsChanged({ sessionKey: KEY, reason: "reset" });
    r.push(page("c:9"));
    await flush(r.shadow);
    r.shadow.requestRead("after");
    await flush(r.shadow);
    // The switch-on page, the in-flight delta (old cursor), then — after the reset — a
    // tail page, and the next read resumes from ITS cursor, never the pre-reset delta's.
    expect(r.reads.map((x) => x.cursor)).toEqual([null, "c:1", null, "c:9"]);
  });
});

describe("phase 2 — the input guard (inputRunIds → pendingInputs / inputReceipts)", () => {
  it("a send is asked about until its user row is read", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-a");
    r.shadow.noteAck("started", "webchat-a");
    r.push(delta("c:2"));
    r.shadow.requestRead("x");
    await flush(r.shadow);
    expect(r.reads.at(-1)!.inputRunIds).toEqual(["webchat-a"]);
    expect(r.applies.at(-1)!.inputRunIds).toEqual(["webchat-a"]);
    r.push(delta("c:3", [userEnv("u1", 1, "webchat-a")]));
    r.shadow.requestRead("y");
    await flush(r.shadow);
    r.shadow.requestRead("z");
    await flush(r.shadow);
    expect(r.reads.at(-1)!.inputRunIds).toEqual([]);
    expect(r.applies.at(-1)!).not.toHaveProperty("inputRunIds");
  });

  it("receipts and pending inputs are posted as read; consumed / cancelled settle custody", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    for (const id of ["webchat-a", "webchat-b", "webchat-c"]) {
      r.shadow.noteSend(id);
      r.shadow.noteAck("started", id);
    }
    r.push({
      ...delta("c:2"),
      pendingInputs: { items: [{ id: "p", runId: "webchat-b", state: "queued", queued: true, message: {}, acceptedAt: 1 }], total: 1, queuedCount: 1 },
      inputReceipts: [
        { runId: "webchat-a", state: "consumed", consumedByEventId: "e" },
        { runId: "webchat-b", state: "pending", queued: true },
        { runId: "webchat-c", state: "pending", cancelled: true },
      ],
    });
    r.shadow.requestRead("x");
    await flush(r.shadow);
    const last = r.applies.at(-1)!;
    expect(last.pendingInputs).toEqual({ total: 1, queuedCount: 1, items: [{ runId: "webchat-b", state: "queued", queued: true }], complete: true });
    expect(last.inputReceipts).toHaveLength(3);
    expect(r.shadow.inputRunIds).toEqual(["webchat-b"]);
  });

  it("an ACKed send the gateway answers NO receipt for is reported ABSENT once, then retired", async () => {
    let now = 1000;
    const r = rig2({ replies: [page("c:1")], now: () => now });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-lost");
    r.shadow.noteSend("webchat-unacked");
    now = 2000;
    r.shadow.noteAck("started", "webchat-lost");
    now = 3000;
    r.push({ ...delta("c:2"), inputReceipts: [] });
    r.shadow.requestRead("x");
    await flush(r.shadow);
    expect(r.applies.at(-1)!.inputAbsent).toEqual(["webchat-lost"]);
    // The send with no ACK yet is not judged: the read may have raced its arrival.
    expect(r.shadow.inputRunIds).toEqual(["webchat-unacked"]);
    r.push({ ...delta("c:3"), inputReceipts: [] });
    r.shadow.requestRead("y");
    await flush(r.shadow);
    expect(r.applies.at(-1)!).not.toHaveProperty("inputAbsent");
  });

  it("no receipts in the reply (an older gateway) proves no absence", async () => {
    const r = rig2({ replies: [page("c:1")], now: () => 5000 });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-a");
    r.shadow.noteAck("started", "webchat-a");
    r.push(delta("c:2"));
    r.shadow.requestRead("x");
    await flush(r.shadow);
    expect(r.applies.at(-1)!).not.toHaveProperty("inputAbsent");
    expect(r.shadow.inputRunIds).toEqual(["webchat-a"]);
  });

  it("a refused send stays asked about (failed): whether the gateway holds it is the measure", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-a");
    r.shadow.noteAck("error", "webchat-a");
    expect(r.shadow.inputRunIds).toEqual(["webchat-a"]);
  });

  it("custody is bounded to the upstream 50, newest kept; nothing is tracked while off", async () => {
    const r = rig2();
    r.shadow.noteSend("webchat-off");
    expect(r.shadow.inputRunIds).toEqual([]);
    r.shadow.configure({ mode: "shadow" });
    for (let i = 0; i < 60; i++) r.shadow.noteSend(`webchat-${String(i).padStart(2, "0")}`);
    const ids = r.shadow.inputRunIds;
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("webchat-10");
    r.shadow.noteSend("x".repeat(257));
    expect(r.shadow.inputRunIds).toHaveLength(50);
    await flush(r.shadow);
  });

  it("a failed live post drops its rows (the read brings them) — never a loop", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.failNextApplies(5);
    r.src.listener!.onSessionMessage(userEnv("u5", 5, "webchat-a"));
    await flush(r.shadow);
    expect(r.shadow.stats.liveApplies).toBe(0);
    expect(r.reads.length).toBeLessThanOrEqual(3);
  });
});

describe("phase 2 — properties over seeded event schedules (reorder, duplicates, resets)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: one flight, every admitted row posted, no pre-reset cursor after a reset`, async () => {
      const rand = prng(seed);
      let cursorN = 1;
      const r = rig2({ replies: [page("c:1")] });
      r.shadow.configure({ mode: "shadow" });
      // Rows admitted since the last reset: a reset discards the old transcript's live
      // rows (the Control UI's `sessionReset`), so only these are owed to Convex.
      let owed = new Set<string>();
      let epoch = 0;
      /** For each read: the reset epoch when it was ISSUED, and its cursor. */
      const issued: Array<{ epoch: number; cursor: string | null }> = [];
      let inFlight = 0;
      let maxInFlight = 0;
      // Wrap the read to watch concurrency.
      const original = (r.shadow as unknown as { deps: { readHistory: (...a: unknown[]) => Promise<unknown> } }).deps;
      const inner = original.readHistory;
      original.readHistory = async (...a: unknown[]) => {
        issued.push({ epoch, cursor: (a[0] as string | null) ?? null });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await inner(...a);
        } finally {
          inFlight--;
        }
      };
      const ids: Array<[string, number]> = [];
      for (let step = 0; step < 50; step++) {
        const x = rand();
        if (x < 0.4) {
          // A user row — sometimes one already seen (duplicate), sometimes out of order.
          const n = rand() < 0.3 && ids.length > 0 ? ids[Math.floor(rand() * ids.length)]! : ([`u${step}`, step + 2] as [string, number]);
          ids.push(n);
          owed.add(n[0]);
          r.src.listener!.onSessionMessage(userEnv(n[0], n[1], `webchat-${n[0]}`));
        } else if (x < 0.5) {
          epoch++;
          owed = new Set();
          r.src.listener!.onSessionsChanged({ sessionKey: KEY, reason: rand() < 0.5 ? "reset" : "new" });
        } else if (x < 0.75) {
          cursorN++;
          r.push(delta(`c:${cursorN}`));
          r.src.listener!.onSessionsChanged({ sessionKey: KEY, reason: "send" });
        } else {
          cursorN++;
          r.push(delta(`c:${cursorN}`));
          r.shadow.observeFrame(chatFrame({ runId: `run-${step}`, state: "final", message: { role: "assistant" } }));
        }
        if (rand() < 0.4) await new Promise((res) => setTimeout(res, 0));
      }
      await flush(r.shadow);
      expect(maxInFlight, "never two reads at once").toBe(1);
      // Every row admitted since the last reset reached Convex — live or by a read.
      const posted = new Set(r.applies.flatMap((a) => a.rows.map((x) => x.entryId)));
      for (const id of owed) expect(posted.has(id), `row ${id} lost`).toBe(true);
      // The FIRST read issued after a reset is a tail page: no pre-reset cursor survives.
      for (let i = 1; i < issued.length; i++) {
        if (issued[i]!.epoch > issued[i - 1]!.epoch) {
          expect(issued[i]!.cursor, `read ${i} after a reset`).toBeNull();
        }
      }
      // Live posts never carry cursor or session state.
      for (const a of r.applies.filter((x) => x.kind === "live")) {
        expect(a).not.toHaveProperty("deltaCursor");
        expect(a).not.toHaveProperty("activeRunIds");
        expect(a.terminals).toEqual([]);
      }
    });
  }
});

describe("phase 2 — custody is released only once the read is stored (review pass 1)", () => {
  it("a failed write after a no-receipt reply keeps the send asked about, and the absence is posted next time", async () => {
    let now = 1000;
    const r = rig2({ replies: [page("c:1")], now: () => now });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-lost");
    now = 2000;
    r.shadow.noteAck("started", "webchat-lost");
    now = 3000;
    r.push({ ...delta("c:2"), inputReceipts: [] });
    r.failNextApplies(1);
    r.shadow.requestRead("x");
    await flush(r.shadow);
    // The write failed: the send is still in custody, and the next read asks for it.
    expect(r.shadow.inputRunIds).toEqual(["webchat-lost"]);
    r.push({ ...delta("c:3"), inputReceipts: [] });
    r.shadow.requestRead("y");
    await flush(r.shadow);
    expect(r.reads.at(-1)!.inputRunIds).toEqual(["webchat-lost"]);
    expect(r.applies.at(-1)!.inputAbsent).toEqual(["webchat-lost"]);
    expect(r.shadow.inputRunIds).toEqual([]);
  });

  it("a failed write keeps a send its user row settled, too", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-a");
    r.shadow.noteAck("started", "webchat-a");
    r.push(delta("c:2", [userEnv("u1", 1, "webchat-a")]));
    r.failNextApplies(1);
    r.shadow.requestRead("x");
    await flush(r.shadow);
    expect(r.shadow.inputRunIds).toEqual(["webchat-a"]);
  });
});

describe("phase 2 — absence is judged on the sends ACKED WHEN THE READ LEFT, never by comparing clocks (review pass 2)", () => {
  /** A rig whose reads wait for the test to release them. */
  const held = (now: () => number) => {
    const r = rig2({ replies: [page("c:1")], now });
    return r;
  };

  it("an ACK in the SAME millisecond as the read it follows does not make that read prove absence", async () => {
    const r = held(() => 1000);
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-a");
    r.push({ ...delta("c:2"), inputReceipts: [] });
    r.shadow.requestRead("x"); // leaves now, before the ACK
    r.shadow.noteAck("started", "webchat-a"); // same millisecond
    await flush(r.shadow);
    expect(r.applies.at(-1)!).not.toHaveProperty("inputAbsent");
    expect(r.shadow.inputRunIds).toEqual(["webchat-a"]);
    // The next read leaves AFTER the ACK: its silence is evidence.
    r.push({ ...delta("c:3"), inputReceipts: [] });
    r.shadow.requestRead("y");
    await flush(r.shadow);
    expect(r.applies.at(-1)!.inputAbsent).toEqual(["webchat-a"]);
  });

  it("a wall clock going BACK between the read and the ACK changes nothing", async () => {
    let now = 5000;
    const r = held(() => now);
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-b");
    r.push({ ...delta("c:2"), inputReceipts: [] });
    r.shadow.requestRead("x");
    now = 100; // NTP step backwards
    r.shadow.noteAck("started", "webchat-b");
    await flush(r.shadow);
    expect(r.applies.at(-1)!).not.toHaveProperty("inputAbsent");
    expect(r.shadow.inputRunIds).toEqual(["webchat-b"]);
  });
});

describe("review 11 — an uninterpretable receipt never proves absence", () => {
  it("a receipt with an UNKNOWN state for an acked send: kept in custody, reported unreadable, never absent; the state reaches the drift sensor", async () => {
    protocolDrift.resetForTests();
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    r.shadow.noteSend("webchat-a");
    r.shadow.noteAck("started", "webchat-a");
    r.push({ ...delta("c:2"), inputReceipts: [{ runId: "webchat-a", state: "superseded" }] });
    r.shadow.requestRead("x");
    await flush(r.shadow);
    const last = r.applies.at(-1)!;
    expect(last).not.toHaveProperty("inputAbsent");
    expect(last.inputUnreadable).toEqual(["webchat-a"]);
    expect(r.shadow.inputRunIds).toEqual(["webchat-a"]);
    const names = protocolDrift.report().map((e) => e.shape);
    expect(names.some((n) => n.startsWith("chat.history.inputReceipts.state_"))).toBe(true);
    expect(names.join(",")).not.toContain("superseded");
  });

  it("an id-less unreadable receipt makes EVERY asked id unprovable this read", async () => {
    const r = rig2({ replies: [page("c:1")] });
    r.shadow.configure({ mode: "shadow" });
    await flush(r.shadow);
    for (const id of ["webchat-a", "webchat-b"]) {
      r.shadow.noteSend(id);
      r.shadow.noteAck("started", id);
    }
    r.push({ ...delta("c:2"), inputReceipts: [{ state: "garbled" }] });
    r.shadow.requestRead("x");
    await flush(r.shadow);
    const last = r.applies.at(-1)!;
    expect(last).not.toHaveProperty("inputAbsent");
    expect([...(last.inputUnreadable ?? [])].sort()).toEqual(["webchat-a", "webchat-b"]);
    expect(r.shadow.inputRunIds).toEqual(["webchat-a", "webchat-b"]);
  });
});
