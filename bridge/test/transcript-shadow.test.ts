// The SHADOW reconciler (redesign phase 1, design §4): when it reads the transcript
// back, with which cursor, how reads coalesce, the Control UI's bounded recovery after
// a final without a message — and that its only output is `apply` (it never writes a
// bubble). Deterministic: the gateway, Convex and time are injected.

import { describe, expect, it } from "vitest";

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
