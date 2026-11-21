// TEXT A RUN SENDS AFTER ITS BUBBLE SETTLED.
//
// A turn can close before its run's `chat` terminal. On a definitive `lifecycle` error
// the gateway sends the `agent` frame FIRST, then — in the same synchronous call
// (src/gateway/server-chat.ts, `finalizeLifecycleEvent` → `emitChatTerminal`) — flushes
// the paced chat buffer (`flushBufferedChatDeltaIfNeeded`) and sends the chat terminal,
// which carries the buffered text for `aborted` and, from 2026.9.5, for `error`. The turn
// still closes at once on the lifecycle frame; what follows completes the settled bubble.
//
// Every test runs the whole bridge path — run manager, normalizer, sink — onto a writer
// that applies Convex's rule (convex/stream.ts `completeSettledText`): a strict extension
// of what that message of that run holds, a repeat of a text already there, or nothing.
//
// The completion's write is DETACHED from the frame path (RunManager `completionTail`):
// `feed` returns before it lands. The harness's `feed` waits for the chain once its
// frames are all read; `feedOnly` does not.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FinalizeStatus } from "../src/convex-writer.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { loadCorpus, replay, RecordingWriter, type Fixture } from "./helpers/golden-corpus.js";

const KEY = "agent:alice:atrium:chat:u:c1";
const __dirname = dirname(fileURLToPath(import.meta.url));

interface Settled {
  runId: string | null;
  status: FinalizeStatus;
  text: string;
  error: string | null;
}

/** Convex, as far as this path goes: the live text of each bubble, what each settled
 *  with, and the completion rule. */
class Writer extends RecordingWriter {
  readonly live = new Map<string, string>();
  readonly runs = new Map<string, string | null>();
  readonly settled = new Map<string, Settled>();
  readonly finalizes: string[] = [];
  readonly offered: Array<{ messageId: string; runId: string; text: string; applied: boolean }> = [];
  /** Live writes made to a bubble AFTER it settled (there must be none). */
  writesAfterSettle = 0;
  failCompletions = false;
  /** Convex's answer to a repeat of a landed write (false: as before it was idempotent). */
  convexAnswersRepeat = true;
  /** Completion writes that fail before anything is committed, then the backend is back. */
  transientFailures = 0;
  /** While set, a completion write does not answer (its ACK is suspended). */
  gate: Promise<void> | null = null;
  /** Completion writes whose ANSWER is lost after the write committed. */
  lostAnswers = 0;
  /** Every write of the frame path, in the order it was made. */
  readonly log: string[] = [];
  /** The writes to settled bubbles (their own detached chain), in order. */
  readonly completions: string[] = [];
  /** Where each bubble's first write and each completion fell, across both paths. */
  readonly order: string[] = [];
  /** The facts about a run written on a bubble, in order (their own detached chain). */
  readonly facts: string[] = [];
  async noteModelFallback(_c: string, d: { messageId: string | null; state: string; model: string }): Promise<string | null> {
    if (d.messageId !== null) this.facts.push(`fallback ${d.state} ${d.model} → ${d.messageId}`);
    return d.messageId;
  }
  async noteGatewayNotice(_c: string, d: { messageId: string | null; text: string }): Promise<string | null> {
    if (d.messageId !== null) this.facts.push(`notice ${d.text} → ${d.messageId}`);
    return d.messageId;
  }

  override async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const id = await super.startAssistant(chatId, runId);
    this.log.push(`start ${id} ${runId}`);
    this.order.push(`start ${id}`);
    this.live.set(id, "");
    this.runs.set(id, runId);
    return id;
  }
  override async appendDelta(m: string, text: string): Promise<void> {
    if (this.settled.has(m)) this.writesAfterSettle++;
    this.log.push(`delta ${m} ${JSON.stringify(text)}`);
    this.live.set(m, (this.live.get(m) ?? "") + text);
  }
  override async setSnapshot(m: string, text: string, replace?: boolean): Promise<boolean> {
    if (this.settled.has(m)) this.writesAfterSettle++;
    this.log.push(`snapshot ${m} ${JSON.stringify(text)}`);
    if (text.length < (this.live.get(m) ?? "").length && replace !== true) return false;
    this.live.set(m, text);
    return true;
  }
  override async finalize(
    m: string,
    status: FinalizeStatus,
    text: string,
    error?: string | null,
  ): Promise<void> {
    this.finalizes.push(m);
    this.log.push(`finalize ${m} ${status} ${JSON.stringify(text)}`);
    this.settled.set(m, {
      runId: this.runs.get(m) ?? null,
      status,
      text: text === "" ? (this.live.get(m) ?? "") : text,
      error: error ?? null,
    });
  }
  async completeSettledText(a: { messageId: string; runId: string; text: string }): Promise<boolean> {
    if (this.gate !== null) await this.gate;
    if (this.failCompletions) throw new Error("convex down");
    if (this.transientFailures > 0) {
      this.transientFailures--;
      throw new Error("convex down");
    }
    const s = this.settled.get(a.messageId);
    const mine = s !== undefined && s.runId === a.runId;
    const extends_ = mine && a.text.length > s.text.length && a.text.startsWith(s.text);
    // A repeat of a write that landed is answered as written (and writes nothing).
    const applied = extends_ || (mine && this.convexAnswersRepeat && a.text === s.text);
    this.offered.push({ ...a, applied });
    this.completions.push(`complete ${a.messageId} ${JSON.stringify(a.text)} ${applied}`);
    this.order.push(`complete ${a.messageId}`);
    if (extends_) s!.text = a.text;
    if (this.lostAnswers > 0) {
      this.lostAnswers--;
      throw new Error("answer lost");
    }
    return applied;
  }
  readonly late: string[] = [];
  /** Late-final writes that fail before anything is committed. */
  lateFailures = 0;
  /** Late-final writes whose ANSWER is lost after the write committed. */
  lostLateAnswers = 0;
  failLate = false;
  async appendLateFinal(a: { messageId: string | null; text: string }): Promise<string | null> {
    if (this.failLate) throw new Error("convex down");
    if (this.lateFailures > 0) {
      this.lateFailures--;
      throw new Error("convex down");
    }
    this.late.push(a.text);
    this.log.push(`late ${a.messageId} ${JSON.stringify(a.text)}`);
    const s = a.messageId === null ? undefined : this.settled.get(a.messageId);
    // Convex's rule (`appendLateFinal`): an addition the bubble already holds is not appended.
    if (s !== undefined && !s.text.includes(a.text)) s.text = s.text.trim() === "" ? a.text : `${s.text}\n\n${a.text}`;
    if (this.lostLateAnswers > 0) {
      this.lostLateAnswers--;
      throw new Error("answer lost");
    }
    return a.messageId;
  }
  /** A steer cut: the segment settles with its text, the run goes on in a new bubble. */
  async splitSegment(messageId: string, _after: string | null, text?: string): Promise<string | null> {
    this.settled.set(messageId, {
      runId: this.runs.get(messageId) ?? null,
      status: "complete",
      text: text ?? this.live.get(messageId) ?? "",
      error: null,
    });
    return this.startAssistant("c1", this.runs.get(messageId) ?? null);
  }
  get starts(): number {
    return this.calls.filter((c) => c.call === "startAssistant").length;
  }
}

const msg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const chatDelta = (runId: string, seq: number, text: string) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, runId, seq, state: "delta", message: msg(text) },
});
const chatError = (runId: string, seq: number, errorMessage: string, text?: string) => ({
  type: "event",
  event: "chat",
  payload: {
    sessionKey: KEY,
    runId,
    seq,
    state: "error",
    errorMessage,
    ...(text === undefined ? {} : { message: msg(text) }),
  },
});
const chatAborted = (runId: string, seq: number, text?: string) => ({
  type: "event",
  event: "chat",
  payload: {
    sessionKey: KEY,
    runId,
    seq,
    state: "aborted",
    ...(text === undefined ? {} : { message: msg(text) }),
  },
});
const chatFinal = (runId: string, seq: number, text?: string) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, runId, seq, state: "final", ...(text === undefined ? {} : { message: msg(text) }) },
});
const agent = (runId: string, seq: number, stream: string, data: Record<string, unknown>) => ({
  type: "event",
  event: "agent",
  payload: { sessionKey: KEY, runId, seq, stream, data },
});
/** A definitive lifecycle error, as every validated version publishes one
 *  (`executionSettled`, src/agents/command/lifecycle.ts at v2026.9.1). */
const lifecycleError = (runId: string, seq: number, error = "provider failed") =>
  agent(runId, seq, "lifecycle", { phase: "error", error, executionSettled: true });

function harness() {
  const writer = new Writer();
  const rm = new RunManager("c1", KEY, writer);
  let now = 1_000;
  const feedOnly = async (...frames: unknown[]) => {
    for (const f of frames) await rm.feed(f, (now += 0.01));
  };
  const feed = async (...frames: unknown[]) => {
    await feedOnly(...frames);
    await rm.completionsIdle();
  };
  return { writer, rm, feed, feedOnly, now: () => now, tick: () => (now += 1) };
}

/** "Hello" shown, the turn closed on the run's definitive lifecycle error. */
async function closedOnLifecycleError() {
  const h = harness();
  await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
  await h.feed(
    agent("runA", 0, "lifecycle", { phase: "start" }),
    chatDelta("runA", 1, "Hello"),
    agent("runA", 2, "assistant", { text: "Hello world", delta: " world" }),
    lifecycleError("runA", 3),
  );
  return h;
}

const tickFrame = () => ({ type: "event", event: "tick", payload: { ts: 1 } });

const only = (w: Writer): Settled => {
  expect(w.settled.size).toBe(1);
  return [...w.settled.values()][0]!;
};

describe("finding 1 — the chat buffer flushed after a definitive lifecycle error", () => {
  it("the turn still closes at once, on the lifecycle frame, as an error", async () => {
    const h = await closedOnLifecycleError();
    expect(h.rm.turnActive).toBe(false);
    expect(h.rm.isFinalized).toBe(true);
    expect(only(h.writer)).toMatchObject({ status: "error", text: "Hello", error: "provider failed" });
  });

  it("2026.9.1 / 9.2 shape: the flushed delta completes the bubble; the bare error terminal adds nothing", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatDelta("runA", 3, "Hello world"), chatError("runA", 3, "provider failed"));
    expect(only(h.writer)).toMatchObject({ status: "error", text: "Hello world", error: "provider failed" });
    expect(h.writer.offered.map((o) => [o.text, o.applied])).toEqual([["Hello world", true]]);
  });

  it("2026.9.5+ `reply-dispatch` shape: the flushed delta, then a terminal that repeats it — one write", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(
      chatDelta("runA", 3, "Hello world"),
      chatError("runA", 3, "provider failed", "Hello world"),
    );
    expect(only(h.writer).text).toBe("Hello world");
    expect(h.writer.offered).toHaveLength(1);
  });

  it("the flushed delta was dropped (`dropIfSlow`): the terminal's own text completes the bubble", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatError("runA", 3, "provider failed", "Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
  });

  it("an `aborted` terminal's text completes it too", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatAborted("runA", 3, "Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
  });

  it("nothing shown before the close: the flushed text fills the empty bubble", async () => {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(
      agent("runA", 0, "lifecycle", { phase: "start" }),
      agent("runA", 1, "tool", { phase: "start", name: "exec", toolCallId: "t1" }),
      lifecycleError("runA", 2),
      chatDelta("runA", 2, "Hello world"),
      chatError("runA", 2, "provider failed"),
    );
    expect(only(h.writer)).toMatchObject({ status: "error", text: "Hello world" });
  });

  it("the turn is never reopened: one terminal, no live write, no new bubble, no state", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(
      chatDelta("runA", 3, "Hello world"),
      chatError("runA", 3, "provider failed", "Hello world"),
    );
    expect(h.writer.finalizes).toHaveLength(1);
    expect(h.writer.writesAfterSettle).toBe(0);
    expect(h.writer.starts).toBe(1);
    expect(h.rm.turnActive).toBe(false);
    expect(h.rm.isFinalized).toBe(true);
    expect(h.rm.nextTimeout(h.now())).toBeNull();
    expect(only(h.writer)).toMatchObject({ status: "error", error: "provider failed" });
  });
});

describe("the bounds of a completion", () => {
  it("only a STRICT EXTENSION of the settled text: a shorter, an equal or a different view writes nothing", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(
      chatDelta("runA", 4, "Hell"),
      chatDelta("runA", 5, "Hello"),
      chatDelta("runA", 6, "Goodbye world"),
    );
    expect(h.writer.offered).toEqual([]);
    expect(only(h.writer).text).toBe("Hello");
  });

  it("only the SAME run: another run's text is not this bubble's", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatDelta("runB", 3, "Hello world"), chatError("runB", 3, "x", "Hello world"));
    expect(h.writer.offered).toEqual([]);
    expect(only(h.writer).text).toBe("Hello");
  });

  it("only until the run's chat terminal: what follows it is not read", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(
      chatError("runA", 3, "provider failed"),
      chatDelta("runA", 4, "Hello world"),
      chatAborted("runA", 5, "Hello world"),
    );
    expect(h.writer.offered).toEqual([]);
    expect(only(h.writer).text).toBe("Hello");
  });

  it("a turn beginning does not end the window: the run's later text lands on ITS bubble", async () => {
    const h = await closedOnLifecycleError();
    await h.rm.beginTurn(h.now(), "runB", { expectedSessionId: null });
    await h.feed(chatDelta("runB", 1, "Second answer"));
    await h.feed(chatDelta("runA", 3, "Hello world"), chatError("runA", 3, "x", "Hello world!"));
    expect(h.writer.offered.map((o) => [o.messageId, o.text, o.applied])).toEqual([
      ["msg1", "Hello world", true],
      ["msg1", "Hello world!", true],
    ]);
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world!");
    // Turn B is untouched, and still open.
    expect(h.rm.turnActive).toBe(true);
    expect(h.writer.live.get("msg2")).toBe("Second answer");
    expect(h.writer.writesAfterSettle).toBe(0);
  });

  it("a turn that owns the run again reads its frames itself: the old window is gone", async () => {
    const h = await closedOnLifecycleError();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 4, "Hello world"));
    expect(h.writer.offered).toEqual([]);
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello");
    expect(h.writer.live.get("msg2")).toBe("Hello world");
  });

  it("a re-broadcast of the same frame is not a second write", async () => {
    const h = await closedOnLifecycleError();
    const flush = chatDelta("runA", 3, "Hello world");
    await h.feed(flush, flush, flush);
    expect(h.writer.offered).toHaveLength(1);
  });

  it("a terminal `message` that only restates the error is not the answer", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatError("runA", 3, "Hello — provider failed", "Hello  —  provider failed"));
    expect(h.writer.offered).toEqual([]);
  });

  it("a turn its run's chat terminal closed has no window: a second terminal is not read", async () => {
    // The 2026.9.8 capture below ends on two terminals of one run (`aborted`, then `error`).
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(
      chatDelta("runA", 1, "Hello"),
      chatError("runA", 2, "provider failed"),
      chatAborted("runA", 3, "Hello world"),
    );
    expect(h.writer.offered).toEqual([]);
    expect(only(h.writer).text).toBe("Hello");
  });

  it("the run's record follows its bubble: a late final that repeats the completed text adds nothing", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatDelta("runA", 3, "Hello world"), chatFinal("runA", 4, "Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
    expect(h.writer.late).toEqual([]);
  });

  it("the normalizer alone: one window PER RUN, each until its own terminal", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(1);
    n.noteRunStarted("runA", 1);
    n.feed(chatDelta("runA", 1, "Hello"), 1);
    n.feed(lifecycleError("runA", 2), 1);
    // Another turn begins, runs and closes early too: run A's window is still its own.
    n.beginTurn(2);
    n.noteRunStarted("runB", 2);
    n.feed(chatDelta("runB", 1, "Hi"), 2);
    expect(n.settledCompletion(chatDelta("runA", 2, "Hello world"))).toMatchObject({ runId: "runA", text: "Hello world" });
    n.feed(lifecycleError("runB", 2), 2);
    expect(n.settledCompletion(chatDelta("runB", 2, "Hi there"))).toMatchObject({ runId: "runB", text: "Hi there" });
    // Each run's terminal ends its own window, and only that one.
    expect(n.settledCompletion(chatAborted("runA", 2, "Hello world!"))).toMatchObject({ runId: "runA", text: "Hello world!" });
    expect(n.settledCompletion(chatAborted("runA", 3, "Hello world!!"))).toBeNull();
    expect(n.settledCompletion(chatAborted("runB", 2, "Hi there!"))).toMatchObject({ runId: "runB", text: "Hi there!" });
  });

  it("the windows are bounded: past sixteen runs still waiting for their terminal, the oldest is forgotten", () => {
    const n = new Normalizer(KEY);
    for (let i = 0; i < 17; i++) {
      n.beginTurn(i);
      n.noteRunStarted(`run${i}`, i);
      n.feed(chatDelta(`run${i}`, 1, "Hello"), i);
      n.feed(lifecycleError(`run${i}`, 2), i);
    }
    expect(n.settledCompletion(chatDelta("run0", 2, "Hello world"))).toBeNull();
    expect(n.settledCompletion(chatDelta("run1", 2, "Hello world"))).toMatchObject({ runId: "run1" });
  });

  it("an error terminal with no `errorMessage` uses `message` for the reason: never read as text", async () => {
    const h = await closedOnLifecycleError();
    await h.feed({
      type: "event",
      event: "chat",
      payload: { sessionKey: KEY, runId: "runA", seq: 3, state: "error", message: msg("Hello, the provider failed") },
    });
    expect(h.writer.offered).toEqual([]);
  });

  it("a `final` ends the window too; one that extends the bubble completes it exactly", async () => {
    const bare = await closedOnLifecycleError();
    await bare.feed(chatFinal("runA", 3), chatDelta("runA", 4, "Hello world"));
    expect(bare.writer.offered).toEqual([]);

    const h = await closedOnLifecycleError();
    await h.feed(chatFinal("runA", 3, "Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
    expect(h.writer.late).toEqual([]);
  });

  it("a DISTINCT late final is still CU-8's: it joins the bubble, it does not complete it", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatFinal("runA", 3, "The tool run finished."));
    expect(h.writer.offered).toEqual([]);
    expect(h.writer.late).toEqual(["The tool run finished."]);
  });

  it("a run adopted into the turn completes nothing: the bubble may hold another run's text", async () => {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(
      agent("runA", 0, "lifecycle", { phase: "start" }),
      chatDelta("runA", 1, "Hello"),
      // The gateway abandons the run to compact and announces a replay: the run that
      // replays is admitted into the turn (adopted), and the turn then follows it.
      agent("runA", 2, "lifecycle", { phase: "end", livenessState: "abandoned", replayInvalid: true }),
      chatDelta("runB", 1, "Hello again"),
      lifecycleError("runB", 2),
    );
    expect(only(h.writer)).toMatchObject({ status: "error", runId: "runA" });
    await h.feed(
      chatDelta("runB", 2, "Hello again, world"),
      chatError("runB", 2, "provider failed", "Hello again, world"),
    );
    expect(h.writer.offered).toEqual([]);
  });

  it("a writer that refuses, fails, or predates the operation breaks nothing", async () => {
    const failing = await closedOnLifecycleError();
    failing.writer.failCompletions = true;
    await failing.feed(chatDelta("runA", 3, "Hello world"));
    expect(only(failing.writer).text).toBe("Hello");

    const old = await closedOnLifecycleError();
    (old.writer as { completeSettledText?: unknown }).completeSettledText = undefined;
    await old.feed(chatDelta("runA", 3, "Hello world"), chatError("runA", 3, "x", "Hello world"));
    // No completion to write with: the terminal's text still lands, joined as a late final.
    expect(old.writer.late).toEqual(["world"]);
  });

  it("after a steer split, the terminal's whole-run text completes the LAST segment only", async () => {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "First part."));
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    await h.feed(
      chatDelta("runA", 2, "First part.\n\nSecond"),
      lifecycleError("runA", 3),
      chatError("runA", 3, "provider failed", "First part.\n\nSecond part."),
    );
    expect([...h.writer.settled.values()].map((b) => b.text)).toEqual(["First part.", "Second part."]);
    expect(h.writer.offered.map((o) => [o.messageId, o.applied])).toEqual([["msg2", true]]);
    // The run's record is its WHOLE text, earlier segments included: a final repeating
    // it adds nothing.
    await h.feed(chatFinal("runA", 4, "First part.\n\nSecond part."));
    expect(h.writer.late).toEqual([]);
  });

  /** "First part." cut at a steer, then `last` in the second segment, closed on the
   *  run's lifecycle error. */
  async function closedAfterSplit(last: string) {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "First part."));
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    await h.feed(chatDelta("runA", 2, `First part.\n\n${last}`), lifecycleError("runA", 3));
    return h;
  }

  it("the earlier segments are the WINDOW's: stripped the same once another turn has begun", async () => {
    const h = await closedAfterSplit("Second");
    // Another turn, cut at a steer too: its segments are its own.
    await h.rm.beginTurn(h.tick(), "runC", { expectedSessionId: null });
    await h.feed(chatDelta("runC", 1, "Third answer."));
    h.rm.noteHeldInput("sendD", "ackD", "userD");
    await h.rm.onUserRow({ sendId: "sendD", steerTargetRunId: "runC" });
    await h.feed(chatError("runA", 3, "provider failed", "First part.\n\nSecond part."));
    expect(h.writer.settled.get("msg2")!.text).toBe("Second part.");
    expect(h.writer.late).toEqual([]);
  });

  it("after a steer split, a REFUSED terminal joins only what the run's whole text adds", async () => {
    const h = await closedAfterSplit("One\r\nTwo");
    await h.feed(chatAborted("runA", 3, "First part.\n\nOne\r\nTwo /home/node/.openclaw/media/outbound/a.txt ok"));
    expect(h.writer.offered.map((o) => o.applied)).toEqual([false]);
    expect(h.writer.late).toEqual(["a.txt ok"]);
  });
});

describe("one acceptance rule for a run's chat text, before and after the close", () => {
  const replace = (runId: string, seq: number, text: string) => ({
    type: "event",
    event: "chat",
    payload: { sessionKey: KEY, runId, seq, state: "delta", replace: true, message: msg(text) },
  });
  /** "Hello wrong tail" at seq 10, retracted to "Hello" at seq 11. */
  async function retracted() {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(
      agent("runA", 9, "lifecycle", { phase: "start" }),
      chatDelta("runA", 10, "Hello wrong tail"),
      replace("runA", 11, "Hello"),
    );
    expect(h.writer.live.get("msg1")).toBe("Hello");
    return h;
  }

  it("BEFORE the close: a copy of the retracted delta (a hand-back's queued copy) writes nothing", async () => {
    const h = await retracted();
    await h.feed({ ...chatDelta("runA", 10, "Hello wrong tail") });
    expect(h.writer.live.get("msg1")).toBe("Hello");
  });

  it("AFTER the close (the reviewed sequence): the same copy does not bring the retracted text back", async () => {
    const h = await retracted();
    await h.feed(lifecycleError("runA", 12));
    expect(only(h.writer).text).toBe("Hello");
    await h.feed({ ...chatDelta("runA", 10, "Hello wrong tail") });
    expect(h.writer.offered).toEqual([]);
    expect(only(h.writer).text).toBe("Hello");
    // The run's real flush and terminal still complete it.
    await h.feed(chatDelta("runA", 12, "Hello world"), chatAborted("runA", 12, "Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
  });

  it("the freshness mark survives the close and a turn beginning: a STALE frame never seen before is refused too", async () => {
    const h = await retracted();
    await h.feed(lifecycleError("runA", 12));
    await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
    // Not a repeat (never seen), at or below the run's mark: an older view of the buffer.
    await h.feed(chatDelta("runA", 10, "Hello wrong"), chatDelta("runA", 11, "Hello wro"));
    expect(h.writer.offered).toEqual([]);
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello");
  });

  it("a delta AT the mark is a copy; the terminal at the mark is the run's last frame and is read", async () => {
    const h = await retracted();
    await h.feed(lifecycleError("runA", 12), chatDelta("runA", 12, "Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
    // Same seq as the flush that was applied: a delta there cannot be told from a copy.
    await h.feed(chatDelta("runA", 12, "Hello world, stale"));
    expect(only(h.writer).text).toBe("Hello world");
    // The terminal shares the flush's seq (`emitChatTerminal`) and carries the whole text.
    await h.feed(chatAborted("runA", 12, "Hello world."));
    expect(only(h.writer).text).toBe("Hello world.");
  });

  it("a frame with no `seq` proves no order: it completes nothing", async () => {
    const h = await closedOnLifecycleError();
    await h.feed({
      type: "event",
      event: "chat",
      payload: { sessionKey: KEY, runId: "runA", state: "aborted", message: msg("Hello world") },
    });
    expect(h.writer.offered).toEqual([]);
  });

  it("the dedupe memory survives the close: a terminal the open turn had read and set aside is still a repeat", async () => {
    // An `aborted` while the gateway abandons the run to compact does not end the turn
    // (the run resumes): it is read, and set aside. Its text is the abandoned attempt's.
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    const abandonedAbort = () => chatAborted("runA", 3, "The abandoned attempt");
    await h.feed(
      agent("runA", 0, "lifecycle", { phase: "start" }),
      agent("runA", 1, "tool", { phase: "start", name: "exec", toolCallId: "t1" }),
      agent("runA", 2, "lifecycle", { phase: "end", livenessState: "abandoned", replayInvalid: true }),
      abandonedAbort(),
    );
    expect(h.rm.turnActive).toBe(true);
    await h.feed(lifecycleError("runA", 4));
    expect(only(h.writer)).toMatchObject({ status: "error", text: "" });
    // Its copy: fresh by position (no chat text was ever applied for the run), a
    // terminal, an extension of the empty bubble — and a frame already read.
    await h.feed(abandonedAbort());
    expect(h.writer.offered).toEqual([]);
    expect(h.writer.late).toEqual([]);
    expect(only(h.writer).text).toBe("");
    // The window is still the run's: its real terminal completes the bubble.
    await h.feed(chatAborted("runA", 4, "The answer"));
    expect(only(h.writer).text).toBe("The answer");
  });
});

describe("the completion's write: detached, kept until written, bounded", () => {
  const traced = async (run: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines.filter((l) => l.includes("completion"));
  };

  it.each([
    ["aborted", (text: string) => chatAborted("runA", 3, text)],
    ["error", (text: string) => chatError("runA", 3, "provider failed", text)],
  ])("the flush's write fails once, the identical `%s` terminal lands the text", async (_n, terminal) => {
    const h = await closedOnLifecycleError();
    h.writer.transientFailures = 1;
    await h.feed(chatDelta("runA", 3, "Hello world"));
    expect(only(h.writer).text).toBe("Hello");
    await h.feed(terminal("Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
    expect(h.writer.late).toEqual([]);
  });

  it("the TERMINAL's write fails once: the text is kept and lands at the next frame — no second terminal", async () => {
    const h = await closedOnLifecycleError();
    h.writer.transientFailures = 1;
    await h.feed(chatAborted("runA", 3, "Hello world"));
    expect(only(h.writer).text).toBe("Hello");
    // Any frame of the connection is the opportunity; the gateway sends no terminal again.
    await h.feed(tickFrame());
    expect(only(h.writer).text).toBe("Hello world");
    expect(h.writer.late).toEqual([]);
    expect(h.writer.offered.map((o) => o.applied)).toEqual([true]);
  });

  it.each([
    ["begins", (h: ReturnType<typeof harness>) => h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null })],
    ["is resumed", (h: ReturnType<typeof harness>) => h.rm.resumeTurn(h.tick(), "msg9", "runB")],
  ])("…or when the next turn %s", async (_n, open) => {
    const h = await closedOnLifecycleError();
    h.writer.transientFailures = 1;
    await h.feed(chatAborted("runA", 3, "Hello world"));
    await open(h);
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world");
  });

  it("the text is for the bubble the run HAD settled when it was offered, even once a later turn owned the run again", async () => {
    // Run Z's write holds the chain; run A's completion waits behind it.
    const h = harness();
    await h.rm.beginTurn(h.now(), "runZ", { expectedSessionId: null });
    await h.feed(chatDelta("runZ", 1, "Zed"), lifecycleError("runZ", 2));
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    await h.feedOnly(chatDelta("runZ", 2, "Zed said"));
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.feedOnly(chatDelta("runA", 1, "Hello"), lifecycleError("runA", 2), chatDelta("runA", 2, "Hello world"));
    // The same run id, a turn of its own, settled on another bubble with the same text.
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.feedOnly(chatDelta("runA", 5, "Hello"), chatFinal("runA", 6, "Hello"));
    expect(h.writer.settled.get("msg3")).toMatchObject({ status: "complete", text: "Hello" });
    release();
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")!.text).toBe("Zed said");
    expect(h.writer.settled.get("msg2")!.text).toBe("Hello world");
    expect(h.writer.settled.get("msg3")!.text).toBe("Hello");
  });

  it("what is owed is bounded by run: past the bound the oldest is dropped, and said", async () => {
    const h = harness();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
    try {
      // 34 runs close early and are owed their flushed text while the first write is held.
      for (let i = 0; i < 34; i++) {
        await h.rm.beginTurn(h.tick(), `run${i}`, { expectedSessionId: null });
        await h.feedOnly(
          chatDelta(`run${i}`, 1, "Hello"),
          lifecycleError(`run${i}`, 2),
          chatDelta(`run${i}`, 2, "Hello world"),
        );
      }
      release();
      await h.rm.completionsIdle();
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((w) => w.includes("completion was dropped"))).toHaveLength(2);
    // The oldest was the write in flight (it lands); the next oldest was never written.
    const texts = [...h.writer.settled.values()].map((b) => b.text);
    expect(texts.filter((t) => t === "Hello world")).toHaveLength(33);
    expect(h.writer.settled.get("msg2")!.text).toBe("Hello");
  });

  it("the ANSWER is lost after the write committed: the retry is answered as written, the tail is not joined twice", async () => {
    const h = await closedOnLifecycleError();
    h.writer.lostAnswers = 1;
    await h.feed(chatAborted("runA", 3, "Hello world"));
    // Committed in Convex, unknown here.
    expect(only(h.writer).text).toBe("Hello world");
    await h.feed(tickFrame());
    expect(h.writer.offered.map((o) => [o.text, o.applied])).toEqual([
      ["Hello world", true],
      ["Hello world", true],
    ]);
    expect(h.writer.late).toEqual([]);
    expect(only(h.writer).text).toBe("Hello world");
    // The run's record followed: a final repeating the text adds nothing.
    await h.feed(chatFinal("runA", 4, "Hello world"));
    expect(h.writer.late).toEqual([]);
  });

  it("THE TRAP, shown: were Convex to refuse the repeat, the same retry would join the tail a second time", async () => {
    const h = await closedOnLifecycleError();
    h.writer.convexAnswersRepeat = false;
    h.writer.lostAnswers = 1;
    await h.feed(chatAborted("runA", 3, "Hello world"), tickFrame());
    // The bridge reads the refusal as "not in the bubble" and joins what the text adds
    // to the record it still holds ("Hello"): the tail, a second time.
    expect(h.writer.late).toEqual(["world"]);
  });

  it("a permanent failure is bounded and said once: three passes, then the text is dropped", async () => {
    const h = await closedOnLifecycleError();
    h.writer.failCompletions = true;
    let attempts = 0;
    const real = h.writer.completeSettledText.bind(h.writer);
    h.writer.completeSettledText = async (a) => {
      attempts++;
      return real(a);
    };
    const lines = await traced(async () => {
      await h.feed(chatAborted("runA", 3, "Hello world"));
      for (let i = 0; i < 8; i++) await h.feed(tickFrame());
    });
    expect(attempts).toBe(3);
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.includes("DROPPED"))).toHaveLength(1);
    expect(lines[2]).toContain("DROPPED");
    expect(only(h.writer).text).toBe("Hello");
    // Dropped for good: the backend coming back writes nothing by itself.
    h.writer.failCompletions = false;
    await h.feed(tickFrame());
    expect(attempts).toBe(3);
  });

  it("`feed` keeps flowing while a completion's write is held: the next turn runs to its end", async () => {
    const h = await closedOnLifecycleError();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    // Not the harness's waiting `feed`: these return while the write is still held.
    await h.feedOnly(chatDelta("runA", 3, "Hello world"), chatAborted("runA", 3, "Hello world!"));
    await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
    await h.feedOnly(chatDelta("runB", 1, "Second answer"), chatFinal("runB", 2, "Second answer"));
    expect(h.writer.settled.get("msg2")).toMatchObject({ status: "complete", text: "Second answer" });
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello");
    release();
    await h.rm.completionsIdle();
    // The latest text offered while the write was held is the one that lands.
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world!");
    expect(h.writer.settled.get("msg2")!.text).toBe("Second answer");
    expect(h.writer.writesAfterSettle).toBe(0);
  });

  it("delta and terminal offered together: one text, one write, and no trace", async () => {
    const lines = await traced(async () => {
      const h = await closedOnLifecycleError();
      await Promise.all([
        h.rm.feed(chatDelta("runA", 3, "Hello world"), h.tick()),
        h.rm.feed(chatAborted("runA", 3, "Hello world"), h.tick()),
      ]);
      await h.rm.completionsIdle();
      expect(only(h.writer).text).toBe("Hello world");
      expect(h.writer.offered.map((o) => o.applied)).toEqual([true]);
      expect(h.writer.late).toEqual([]);
      expect(h.writer.finalizes).toHaveLength(1);
    });
    expect(lines).toEqual([]);
  });

  it("the normalizer's reference moves only on an accepted write", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(1);
    n.noteRunStarted("runA", 1);
    n.feed(chatDelta("runA", 1, "Hello"), 1);
    n.feed(lifecycleError("runA", 2), 1);
    const flush = n.settledCompletion(chatDelta("runA", 2, "Hello world"))!;
    expect(flush).toMatchObject({ text: "Hello world" });
    // Not written (failed, refused, still in flight): the terminal offers the same text.
    const terminal = n.settledCompletion(chatAborted("runA", 2, "Hello world"))!;
    expect(terminal).toMatchObject({ text: "Hello world" });

    const m = new Normalizer(KEY);
    m.beginTurn(1);
    m.noteRunStarted("runA", 1);
    m.feed(chatDelta("runA", 1, "Hello"), 1);
    m.feed(lifecycleError("runA", 2), 1);
    m.noteCompletionWritten(m.settledCompletion(chatDelta("runA", 2, "Hello world"))!);
    // Written: the same text is no longer an extension.
    expect(m.settledCompletion(chatAborted("runA", 2, "Hello world"))).toBeNull();
  });
});

describe("a debt is a DESTINATION, not a run id", () => {
  /** Run A closes early twice, on two bubbles; the first completion's write is held. */
  async function twoClosesOfOneRun() {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "Hello"), lifecycleError("runA", 2));
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    await h.feedOnly(chatDelta("runA", 2, "Hello old tail"));
    // The same run id again, before anything reconciled it: a second bubble, closed
    // early too, with positions above the first window's mark.
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.feedOnly(chatDelta("runA", 5, "Hello"), lifecycleError("runA", 6));
    return { h, release };
  }

  it("two early closes of one run id, the first write suspended: each bubble gets its own text", async () => {
    const { h, release } = await twoClosesOfOneRun();
    await h.feedOnly(chatDelta("runA", 6, "Hello new tail"), chatAborted("runA", 6, "Hello new tail"));
    release();
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello old tail");
    expect(h.writer.settled.get("msg2")!.text).toBe("Hello new tail");
    expect(h.writer.late).toEqual([]);
    // Two debts, written in the order they arose.
    expect(h.writer.offered.map((o) => [o.messageId, o.text, o.applied])).toEqual([
      ["msg1", "Hello old tail", true],
      ["msg2", "Hello new tail", true],
    ]);
  });

  it("a late final waits behind the debt of ITS bubble only", async () => {
    const { h, release } = await twoClosesOfOneRun();
    // The second turn's terminal brings nothing more; then a distinct late final of the
    // run, for its latest bubble — which is owed nothing.
    await h.feedOnly(chatAborted("runA", 6, "Hello"), chatFinal("runA", 7, "A distinct answer"));
    expect(h.writer.log.at(-1)).toBe('late msg2 "A distinct answer"');
    release();
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello old tail");
    expect(h.writer.settled.get("msg2")!.text).toBe("Hello\n\nA distinct answer");
  });

  it("the window of a run a later turn adopted keeps the bubble of the turn that opened it", async () => {
    // Run A's turn is closed from outside (a net): its window waits for its terminal.
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "Hello"));
    await h.rm.endTurn(h.tick(), "error", "approval_pending", "approval_timeout", "approval_pending");
    // Run B's turn abandons its run to compact; one frame of run A is admitted as the
    // replay, so A is one of that turn's runs when it settles — on B's bubble.
    await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
    await h.feed(
      chatDelta("runB", 1, "Partial"),
      agent("runB", 2, "lifecycle", { phase: "end", livenessState: "abandoned", replayInvalid: true }),
      chatDelta("runA", 5, "Other"),
      agent("runB", 3, "lifecycle", { phase: "start" }),
    );
    expect(h.rm.activeRunIds).toContain("runA");
    await h.rm.endTurn(h.tick(), "final", null, "recv_timeout");
    expect(h.writer.settled.get("msg2")).toMatchObject({ runId: "runB" });
    // Run A's terminal: for the bubble its own early close settled.
    await h.feed(chatAborted("runA", 9, "Hello world"));
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world");
    expect(h.writer.late).toEqual([]);
  });
});

describe("every write of the completion chain has an outcome: the JOIN too", () => {
  const OUT = "/home/node/.openclaw/media/outbound";
  /** "One\r\nTwo" persisted; the terminal's sanitised text will not extend it. */
  async function refusedCompletion() {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "One\r\nTwo"), lifecycleError("runA", 2));
    return h;
  }
  const terminal = () => chatAborted("runA", 2, `One\r\nTwo ${OUT}/a.txt ok`);

  it("the completion is refused, the join FAILS, service is back: the next frame joins the text", async () => {
    const h = await refusedCompletion();
    h.writer.lateFailures = 1;
    await h.feed(terminal());
    expect(only(h.writer).text).toBe("One\r\nTwo");
    await h.feed(tickFrame());
    expect(h.writer.late).toEqual(["a.txt ok"]);
    expect(only(h.writer).text).toBe("One\r\nTwo\n\na.txt ok");
    // Discharged: nothing more is asked.
    const asked = h.writer.offered.length;
    await h.feed(tickFrame(), tickFrame());
    expect(h.writer.offered).toHaveLength(asked);
    expect(h.writer.late).toEqual(["a.txt ok"]);
  });

  it("the join's ANSWER is lost after it committed: asked again, the addition is not appended twice", async () => {
    const h = await refusedCompletion();
    h.writer.lostLateAnswers = 1;
    await h.feed(terminal());
    expect(only(h.writer).text).toBe("One\r\nTwo\n\na.txt ok");
    await h.feed(tickFrame());
    // Asked twice, appended once; and the run's record followed.
    expect(h.writer.late).toEqual(["a.txt ok", "a.txt ok"]);
    expect(only(h.writer).text).toBe("One\r\nTwo\n\na.txt ok");
    await h.feed(chatFinal("runA", 3, "One\r\nTwo a.txt ok"));
    expect(h.writer.late).toHaveLength(2);
  });

  it("a join that keeps failing is bounded by the same three passes, and said", async () => {
    const h = await refusedCompletion();
    h.writer.failLate = true;
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await h.feed(terminal());
      for (let i = 0; i < 8; i++) await h.feed(tickFrame());
    } finally {
      console.error = original;
    }
    const passes = lines.filter((l) => l.includes("completion was not written"));
    expect(passes).toHaveLength(3);
    expect(passes[2]).toContain("DROPPED");
    expect(h.writer.offered).toHaveLength(3);
  });

  it("a join Convex answers with no bubble is an answer: the debt is discharged, not retried", async () => {
    const h = await refusedCompletion();
    h.writer.appendLateFinal = async () => null;
    await h.feed(terminal(), tickFrame(), tickFrame());
    expect(h.writer.offered).toHaveLength(1);
  });
});

describe("a turn boundary while a completion is in flight", () => {
  const settle = () => new Promise((r) => setTimeout(r, 5));
  async function suspended() {
    const h = await closedOnLifecycleError();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    await h.feedOnly(chatDelta("runA", 3, "Hello world"));
    await settle();
    return { h, release };
  }

  it.each([
    ["beginTurn", (h: ReturnType<typeof harness>) => h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null })],
    ["resumeTurn", (h: ReturnType<typeof harness>) => h.rm.resumeTurn(h.tick(), "msg9", "runB")],
  ])("the ACK returns after %s: the window and the run's record are still run A's, on the completed bubble", async (_n, open) => {
    const { h, release } = await suspended();
    await open(h);
    release();
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world");
    // The run's terminal, a turn later: an exact completion of its own bubble.
    await h.feed(chatFinal("runA", 4, "Hello world more"));
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world more");
    expect(h.writer.late).toEqual([]);
    // After the terminal, a later final is compared with the run's record as the
    // completions left it — not with an emptied one: only its addition joins.
    await h.feed(chatFinal("runA", 5, "Hello world more and more"));
    expect(h.writer.late).toEqual(["and more"]);
  });

  it("a late final of the run arriving WHILE its completion is held is written behind it, against the completed bubble", async () => {
    const h = await closedOnLifecycleError();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    await h.feedOnly(
      chatDelta("runA", 3, "Hello world"),
      chatAborted("runA", 3, "Hello world"),
      // After the run's terminal: a final that repeats the completed text and adds to it.
      chatFinal("runA", 4, "Hello world more"),
    );
    expect(h.writer.late).toEqual([]);
    release();
    await h.rm.completionsIdle();
    // Compared with "Hello" (the record before the write landed) it would add "world more".
    expect(h.writer.late).toEqual(["more"]);
    // The terminal offered the text the held write then landed: not written twice.
    expect(h.writer.offered.map((o) => [o.text, o.applied])).toEqual([["Hello world", true]]);
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world\n\nmore");
  });

  it("a completion still QUEUED when the next turn begins is written all the same, to its own bubble", async () => {
    const h = await closedOnLifecycleError();
    const write = h.rm.feed(chatDelta("runA", 3, "Hello world"), h.tick());
    const opening = h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
    await Promise.all([write, opening]);
    await h.rm.completionsIdle();
    expect(h.writer.offered.map((o) => [o.messageId, o.applied])).toEqual([["msg1", true]]);
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world");
  });

  it("the next turn's own record is untouched by a completion landing behind it", async () => {
    const { h, release } = await suspended();
    await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
    await h.feedOnly(chatDelta("runB", 1, "Second answer"), chatFinal("runB", 2, "Second answer"));
    release();
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello world");
    expect(h.writer.settled.get("msg2")!.text).toBe("Second answer");
    await h.feed(chatFinal("runB", 3, "Second answer"));
    expect(h.writer.late).toEqual([]);
  });

  // The reviewer's sequence: the whole turn raced its ACK. Replayed frames take the unit a
  // live frame takes, so the close opens the window its next delta completes.
  it("INTEGRATION trames-3b — a turn replayed from the pre-ACK buffer completes its settled bubble", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    await h.feed(
      chatDelta("runA", 1, "Hello"),
      lifecycleError("runA", 2),
      chatDelta("runA", 2, "Hello world"),
      chatAborted("runA", 2, "Hello world"),
    );
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.rm.completionsIdle();
    expect(only(h.writer)).toMatchObject({ status: "error", text: "Hello world" });
    expect(h.writer.finalizes).toHaveLength(1);
    expect(h.writer.offered.map((o) => o.applied)).toEqual([true]);
  });
});

// THE SECOND REVIEWED SEQUENCE: a delivery (run B) waits while run A's turn closes on a
// definitive lifecycle error; B's turn opens before A's flushed text and terminal are read.
describe("a delivery opening its turn before the end of the settled run's answer", () => {
  const B = "announce:v1:agent:alice:subagent:child:run-1";
  const expectBoth = (w: Writer) => {
    expect(w.settled.get("msg1")).toMatchObject({ runId: "runA", status: "error", text: "Hello world" });
    expect(w.settled.get("msg2")).toMatchObject({ runId: B, status: "complete", text: "The report" });
    expect(w.offered.map((o) => [o.messageId, o.applied])).toEqual([["msg1", true]]);
    expect(w.late).toEqual([]);
    expect(w.writesAfterSettle).toBe(0);
  };

  it("LIVE: B's turn is open when A's flush and terminal arrive — they still complete A's bubble", async () => {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(
      chatDelta("runA", 1, "Hello"),
      chatDelta(B, 1, "The rep"),
      lifecycleError("runA", 2),
    );
    // The close delivered the waiting delivery at once: its turn is the open one.
    expect(h.rm.turnActive).toBe(true);
    expect(h.rm.activeRunIds).toEqual([B]);
    await h.feed(
      chatDelta("runA", 2, "Hello world"),
      chatAborted("runA", 2, "Hello world"),
      chatFinal(B, 2, "The report"),
    );
    expectBoth(h.writer);
  });

  it("ENTIRELY PRE-ACK: the replay reads A's whole answer before the delivery opens its turn", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    await h.feed(
      chatDelta(B, 1, "The rep"),
      chatDelta("runA", 1, "Hello"),
      lifecycleError("runA", 2),
      chatDelta("runA", 2, "Hello world"),
      chatAborted("runA", 2, "Hello world"),
      chatFinal(B, 2, "The report"),
    );
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.rm.completionsIdle();
    expectBoth(h.writer);
    // Nothing began another turn between two replayed frames: A's completion was
    // offered, and written, before B's bubble was born.
    expect(h.writer.order).toEqual(["start msg1", "complete msg1", "start msg2"]);
    expect(h.rm.liveWork).toBeNull();
  });

  it("PRE-ACK: a buffered run that became an input's run opens its turn after the replay, not inside it", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    // Run X is buffered as an unknown run, between run A's close and its flushed text;
    // the ACK of a queued input then names it.
    await h.feed(
      chatDelta("runA", 1, "Hello"),
      lifecycleError("runA", 2),
      chatDelta("runX", 1, "The other answer"),
      chatDelta("runA", 2, "Hello world"),
      chatAborted("runA", 2, "Hello world"),
    );
    h.rm.noteHeldInput("sendX", "runX", "userX");
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")).toMatchObject({ status: "error", text: "Hello world" });
    expect(h.writer.live.get("msg2")).toBe("The other answer");
    expect(h.writer.order).toEqual(["start msg1", "complete msg1", "start msg2"]);
  });

  it("PRE-ACK, a resume asked during the replay waits for its end", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    await h.feed(chatDelta("runA", 1, "Hello"), lifecycleError("runA", 2), chatAborted("runA", 2, "Hello world"));
    // The close's write is held: the replay stands between the close and the terminal.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const finalize = h.writer.finalize.bind(h.writer);
    h.writer.finalize = async (...a) => {
      await held;
      return finalize(...a);
    };
    const opening = h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await new Promise((r) => setTimeout(r, 5));
    let resumed = false;
    const resuming = h.rm.resumeTurn(h.tick(), "msg9", "runC").then(() => (resumed = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(resumed).toBe(false);
    release();
    await Promise.all([opening, resuming]);
    await h.rm.completionsIdle();
    expect(h.writer.settled.get("msg1")).toMatchObject({ status: "error", text: "Hello world" });
  });
});

// ONE UNIT FOR A FRAME, LIVE OR REPLAYED. The same frames, cut at every point between
// "before the ACK" and "after it", make the same writes in the same order as when all of
// them arrive during the turn. (model-fallback.test.ts holds the same table for the facts
// about a run.)
describe("replay equivalence — the pre-ACK buffer and the live path write the same", () => {
  const OUT = "/home/node/.openclaw/media/outbound";
  const tickFrame = () => ({ type: "event", event: "tick", payload: { ts: 1 } });
  const SEQUENCES: { name: string; frames: () => unknown[]; settled: string; proof: (w: Writer) => void }[] = [
    {
      name: "completion after a lifecycle error, then the aborted terminal (the reviewed sequence)",
      frames: () => [
        chatDelta("runA", 1, "Hello"),
        lifecycleError("runA", 2),
        chatDelta("runA", 2, "Hello world"),
        chatAborted("runA", 2, "Hello world"),
      ],
      settled: "Hello world",
      proof: (w) => expect(w.offered.map((o) => o.applied)).toEqual([true]),
    },
    {
      name: "the flushed delta dropped: the error terminal's own text completes",
      frames: () => [
        agent("runA", 0, "lifecycle", { phase: "start" }),
        chatDelta("runA", 1, "Hello"),
        lifecycleError("runA", 2),
        chatError("runA", 3, "provider failed", "Hello world"),
      ],
      settled: "Hello world",
      proof: (w) => expect(w.offered.map((o) => o.applied)).toEqual([true]),
    },
    {
      name: "an unstable tail held at the close, written when the gateway moves on",
      frames: () => [
        chatDelta("runA", 1, "The log is in /tmp/x"),
        lifecycleError("runA", 2),
        agent("runA", 3, "lifecycle", { phase: "end" }),
        tickFrame(),
        tickFrame(),
      ],
      settled: "The log is in /tmp/x",
      proof: (w) => expect(w.offered.map((o) => [o.text, o.applied])).toEqual([["The log is in /tmp/x", true]]),
    },
    {
      name: "an unstable tail completed by the terminal's sanitised text",
      frames: () => [
        chatDelta("runA", 1, "Report at /home/node/.openclaw/media/out"),
        lifecycleError("runA", 2),
        chatDelta("runA", 2, `Report at ${OUT}/report.pdf. The answer is 42.`),
        chatAborted("runA", 2, `Report at ${OUT}/report.pdf. The answer is 42.`),
      ],
      settled: "Report at report.pdf. The answer is 42.",
      proof: (w) => expect(w.late).toEqual([]),
    },
    {
      name: "a distinct late final after the run's final (CU-8)",
      frames: () => [
        chatDelta("runA", 1, "Hello"),
        chatFinal("runA", 2, "Hello"),
        chatFinal("runA", 3, "A second, distinct answer"),
      ],
      settled: "Hello\n\nA second, distinct answer",
      proof: (w) => expect(w.late).toEqual(["A second, distinct answer"]),
    },
    {
      name: "a terminal whose completion is refused: its text joins the bubble",
      frames: () => [
        chatDelta("runA", 1, "One\r\nTwo"),
        lifecycleError("runA", 2),
        chatAborted("runA", 2, `One\r\nTwo ${OUT}/a.txt ok`),
      ],
      settled: "One\r\nTwo\n\na.txt ok",
      proof: (w) => {
        expect(w.offered.map((o) => o.applied)).toEqual([false]);
        expect(w.late).toEqual(["a.txt ok"]);
      },
    },
  ];

  async function play(frames: unknown[], cut: number): Promise<Writer> {
    const h = harness();
    h.rm.armReplayBuffer();
    await h.feed(...frames.slice(0, cut));
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await h.feed(...frames.slice(cut));
    await h.rm.completionsIdle();
    return h.writer;
  }

  it.each(SEQUENCES)("$name", async ({ frames, settled, proof }) => {
    const live = await play(frames(), 0);
    expect(only(live).text).toBe(settled);
    proof(live);
    const n = frames().length;
    for (let cut = 1; cut <= n; cut++) {
      const split = await play(frames(), cut);
      expect(split.log, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.log);
      // The writes to the settled bubble have their own chain, and so their own order.
      expect(split.completions, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.completions);
      expect([...split.settled], `first ${cut} frame(s) before the ACK`).toStrictEqual([...live.settled]);
      expect(split.writesAfterSettle).toBe(0);
    }
  });

  it.each([
    ["closed by its aborted terminal", true],
    ["closed by the lifecycle error alone", false],
  ])("both lots at once: a fallback and its notices around a completed bubble (%s), cut at every position", async (_n, terminal) => {
    const notice = (...texts: string[]) => ({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: KEY,
        runId: "runA",
        state: "final",
        message: { role: "assistant", content: texts.map((text) => ({ type: "text", text, openclawStatusNotice: true })) },
      },
    });
    const frames = () => [
      chatDelta("runA", 1, "Hello"),
      agent("runA", 2, "fallback", { fromModel: "m", toModel: "model-B" }),
      lifecycleError("runA", 3),
      chatDelta("runA", 3, "Hello world"),
      ...(terminal ? [chatAborted("runA", 3, "Hello world")] : []),
      notice("↪️ Model Fallback: model-B", "Usage: 1 in / 1 out"),
    ];
    const run = async (cut: number) => {
      const h = harness();
      h.rm.armReplayBuffer();
      await h.feed(...frames().slice(0, cut));
      await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
      await h.feed(...frames().slice(cut));
      await h.rm.completionsIdle();
      await h.rm.runFactsIdle();
      return h.writer;
    };
    const live = await run(0);
    expect(only(live)).toMatchObject({ status: "error", text: "Hello world" });
    expect(live.facts).toStrictEqual(["fallback active model-B → msg1", "notice Usage: 1 in / 1 out → msg1"]);
    for (let cut = 1; cut <= frames().length; cut++) {
      const split = await run(cut);
      expect(split.log, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.log);
      expect(split.completions, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.completions);
      expect(split.facts, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.facts);
    }
  });

  it("a frame arriving DURING the replay is read after every replayed frame", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    await h.feed(chatDelta("runA", 1, "Hello"), lifecycleError("runA", 2));
    // The close's write is held: the replay is suspended between its two frames' effects.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const finalize = h.writer.finalize.bind(h.writer);
    h.writer.finalize = async (...a) => {
      await held;
      return finalize(...a);
    };
    const opening = h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await new Promise((r) => setTimeout(r, 5));
    // Live, while the replay waits: the run's flushed delta. Decided before the close has
    // landed, it would find no settled bubble to complete.
    const live = h.rm.feed(chatDelta("runA", 2, "Hello world"), h.tick());
    await new Promise((r) => setTimeout(r, 5));
    expect(h.rm.dispatchInFlight).toBe(true);
    release();
    await Promise.all([opening, live]);
    await h.rm.completionsIdle();
    expect(only(h.writer)).toMatchObject({ status: "error", text: "Hello world" });
    expect(h.rm.dispatchInFlight).toBe(false);
  });

  it("a tick DURING the replay judges no deadline between two replayed frames", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    // The run waited for an approval and got it, all before the ACK.
    await h.feed(
      chatDelta("runA", 1, "Hello"),
      agent("runA", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap1", toolCallId: "tc1" }),
      agent("runA", 3, "lifecycle", { phase: "approval-resolved", approvalId: "ap1", toolCallId: "tc1" }),
      chatFinal("runA", 4, "Hello"),
    );
    // The label's write is held: the replay stands between the request and its answer.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let phases = 0;
    (h.writer as unknown as { setPhase: () => Promise<void> }).setPhase = async () => {
      if (phases++ === 0) await held;
    };
    const opening = h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(phases).toBe(1);
    // Far past the approval's own bound: judged there, the turn would close on
    // `approval_timeout` with the answer one frame away.
    const ticking = h.rm.tick(h.now() + 100_000);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([opening, ticking]);
    expect(only(h.writer)).toMatchObject({ status: "complete", text: "Hello", error: null });
  });

  it("a delivery stashed during the send is opened by the replay that closes the turn, without waiting for itself", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    const DELIVERY = "announce:v1:agent:alice:subagent:child:run-1";
    await h.feed(
      chatFinal(DELIVERY, 1, "The report"),
      chatDelta("runA", 1, "Hello"),
      chatFinal("runA", 2, "Hello"),
    );
    // The replayed final closes the turn; the stashed delivery then comes back through
    // `feed` from inside the replay — a frame the gate must recognise as its own.
    await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    expect([...h.writer.settled.values()].map((b) => b.text)).toEqual(["Hello", "The report"]);
  });

  it("the dispatch stays in flight until the last replayed frame is done, even once the turn it opened has closed", async () => {
    const h = harness();
    h.rm.armReplayBuffer();
    await h.feed(
      chatDelta("runA", 1, "Hello"),
      chatFinal("runA", 2, "Hello"),
      chatFinal("runA", 3, "A second, distinct answer"),
    );
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const late = h.writer.appendLateFinal.bind(h.writer);
    h.writer.appendLateFinal = async (a) => {
      await held;
      return late(a);
    };
    const opening = h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.rm.turnActive || h.rm.turnFinalizing).toBe(false);
    expect(h.rm.liveWork).toBe("dispatch in flight");
    release();
    await opening;
    expect(h.rm.liveWork).toBeNull();
    expect(h.writer.late).toEqual(["A second, distinct answer"]);
  });

  it("a replayed frame of another run is not put back in the buffer: it meets the turn's own admission", async () => {
    // The run the gateway replays the turn on after a compaction is foreign to the ACK
    // and admitted by the normalizer (the compaction announced it). Put back in the
    // buffer it would be lost with it.
    const frames = [
      chatDelta("runA", 1, "Partial"),
      agent("runA", 2, "compaction", { phase: "start" }),
      agent("runA", 3, "compaction", { phase: "end", willRetry: true, completed: true }),
      agent("runB", 0, "lifecycle", { phase: "start" }),
      chatDelta("runB", 1, "The whole answer"),
      chatFinal("runB", 2, "The whole answer"),
    ];
    const run = async (cut: number) => {
      const h = harness();
      h.rm.armReplayBuffer();
      await h.feed(...frames.slice(0, cut));
      await h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
      await h.feed(...frames.slice(cut));
      return h;
    };
    const live = await run(0);
    expect(only(live.writer)).toMatchObject({ status: "complete", text: "The whole answer" });
    const replayed = await run(frames.length);
    expect(replayed.writer.log).toStrictEqual(live.writer.log);
    expect(replayed.rm.dispatchInFlight).toBe(false);
  });
});

describe("part seven — an unstable tail at the close", () => {
  const OUT = "/home/node/.openclaw/media/outbound";
  async function closedWith(text: string) {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(
      agent("runA", 0, "lifecycle", { phase: "start" }),
      chatDelta("runA", 1, text),
      lifecycleError("runA", 2),
    );
    return h;
  }
  const tickFrame = { type: "event", event: "tick", payload: { ts: 1 } };

  it("a path in progress: the close keeps the stable text, and the sanitised completion extends it", async () => {
    const h = await closedWith("Report at /home/node/.openclaw/media/out");
    expect(only(h.writer).text).toBe("Report at");
    const full = `Report at ${OUT}/report.pdf. The answer is 42.`;
    await h.feed(chatDelta("runA", 2, full), chatAborted("runA", 2, full));
    expect(only(h.writer).text).toBe("Report at report.pdf. The answer is 42.");
    expect(h.writer.offered.map((o) => o.applied)).toEqual([true]);
    expect(h.writer.late).toEqual([]);
  });

  it.each([
    ["a `MEDIA:` directive in progress", "Here.\nMEDIA:/home/no", `Here.\nMEDIA:${OUT}/a.png\nDone.`, "Here.", "Here.\nDone."],
    ["a `path:` label in progress", "Intro\npath: /home/node/.openclaw/med", `Intro\npath: ${OUT}/a.txt\nDone.`, "Intro", "Intro\nDone."],
    ["a path behind a prefix", "See file=/home/node/.openclaw/media/out", `See file=${OUT}/a.txt now.`, "See", "See file=a.txt now."],
    ["a trailing line break the sanitiser drops", "Here.\n", `Here.\nMEDIA:${OUT}/a.png\nDone.`, "Here.", "Here.\nDone."],
  ])("%s: closed on the stable text, completed exactly", async (_n, atClose, full, settled, completed) => {
    const h = await closedWith(atClose);
    expect(only(h.writer).text).toBe(settled);
    await h.feed(chatError("runA", 2, "provider failed", full));
    expect(only(h.writer).text).toBe(completed);
    expect(h.writer.late).toEqual([]);
  });

  it("no completion ever comes: the first frame that is not the run's gives the bubble its whole text", async () => {
    const h = await closedWith("The log is in /tmp/x");
    expect(only(h.writer).text).toBe("The log is in");
    // The run's own frames do not end the wait: its flush may still be on its way.
    await h.feed(agent("runA", 3, "lifecycle", { phase: "end" }));
    expect(only(h.writer).text).toBe("The log is in");
    await h.feed(tickFrame);
    expect(only(h.writer).text).toBe("The log is in /tmp/x");
    await h.feed(tickFrame, tickFrame);
    expect(h.writer.offered).toHaveLength(1);
  });

  it("no completion ever comes: the run's bare terminal gives the bubble its whole text", async () => {
    const h = await closedWith("The log is in /tmp/x");
    await h.feed(chatError("runA", 2, "provider failed"));
    expect(only(h.writer).text).toBe("The log is in /tmp/x");
  });

  it("no completion ever comes: the next turn's first frame is such a frame", async () => {
    const h = await closedWith("The log is in /tmp/x");
    await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
    await h.feed(agent("runB", 0, "lifecycle", { phase: "start" }));
    expect(h.writer.settled.get("msg1")!.text).toBe("The log is in /tmp/x");
  });

  it("the whole text's write fails: it is offered again, a bounded number of times", async () => {
    const h = await closedWith("The log is in /tmp/x");
    h.writer.transientFailures = 1;
    await h.feed(tickFrame);
    expect(only(h.writer).text).toBe("The log is in");
    await h.feed(tickFrame);
    expect(only(h.writer).text).toBe("The log is in /tmp/x");

    const down = await closedWith("The log is in /tmp/x");
    down.writer.failCompletions = true;
    let attempts = 0;
    const real = down.writer.completeSettledText.bind(down.writer);
    down.writer.completeSettledText = async (a) => {
      attempts++;
      return real(a);
    };
    for (let i = 0; i < 8; i++) await down.feed(tickFrame);
    expect(attempts).toBe(3);
  });

  it("the whole text Convex refuses is offered once, and what it adds joins the bubble — once", async () => {
    const h = await closedWith("The log is in /tmp/x");
    only(h.writer).text = "something else";
    await h.feed(tickFrame, tickFrame, tickFrame);
    expect(h.writer.offered.map((o) => o.applied)).toEqual([false]);
    expect(h.writer.late).toEqual(["/tmp/x"]);
  });

  it.each([
    ["a bare error terminal (2026.9.1 / 9.2)", () => chatError("runA", 2, "provider failed")],
    ["a terminal repeating the text (2026.9.5+)", () => chatError("runA", 2, "provider failed", `One\r\nTwo ${OUT}/a.txt ok`)],
  ])("a REFUSED flush is joined, never left to a terminal that may carry nothing: %s", async (_n, terminal) => {
    const h = await closedWith("One\r\nTwo");
    // One at a time: the flush's write (and its join) is done when the terminal arrives.
    await h.feed(chatDelta("runA", 2, `One\r\nTwo ${OUT}/a.txt ok`));
    await h.feed(terminal());
    expect(h.writer.late).toEqual(["a.txt ok"]);
    expect(only(h.writer).text).toBe("One\r\nTwo\n\na.txt ok");
    // A refused text that adds nothing to the record is discharged: asked once per offer.
    const asked = h.writer.offered.length;
    await h.feed(tickFrame, tickFrame);
    expect(h.writer.offered).toHaveLength(asked);
  });

  it("a stale view shorter than the text held back is never written", async () => {
    const h = await closedWith("The log is in /tmp/x");
    await h.feed(chatDelta("runA", 2, "The log is in /tm"));
    expect(h.writer.offered).toEqual([]);
  });

  it("an early close that did not fail keeps its whole text: nothing is held back", async () => {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "The log is in /tmp/x"));
    await h.rm.endTurn(h.tick(), "final", null, "recv_timeout");
    expect(only(h.writer).text).toBe("The log is in /tmp/x");
  });

  it.each([
    ["aborted", (text: string) => chatAborted("runA", 2, text)],
    ["error", (text: string) => chatError("runA", 2, "provider failed", text)],
    ["final", (text: string) => chatFinal("runA", 2, text)],
  ])("DECLARED — a rewrite of text already persisted (line ends normalised): the `%s` terminal's text joins, never lost", async (_n, terminal) => {
    const h = await closedWith("One\r\nTwo");
    expect(only(h.writer).text).toBe("One\r\nTwo");
    await h.feed(terminal(`One\r\nTwo ${OUT}/a.txt ok`));
    // The sanitised text ("One\nTwo a.txt ok") does not extend "One\r\nTwo": refused, joined.
    expect(h.writer.offered.map((o) => o.applied)).toEqual([false]);
    expect(h.writer.late).toEqual(["a.txt ok"]);
    expect(only(h.writer).text).toBe("One\r\nTwo\n\na.txt ok");
  });

  it("the silence sentinel is never a completion", async () => {
    const h = await closedWith("");
    await h.feed(chatAborted("runA", 2, "NO_REPLY"));
    expect(h.writer.offered).toEqual([]);
    expect(h.writer.late).toEqual([]);
  });
});

describe("the other early closes: the terminal's text, never a delta", () => {
  // A close decided outside the stream (a net, a connection end). The run may go on for
  // a long time: its deltas are not followed into a settled bubble; its terminal's text is.
  async function closedExternally() {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(agent("runA", 0, "lifecycle", { phase: "start" }), chatDelta("runA", 1, "Hello"));
    await h.rm.endTurn(h.tick(), "error", "approval_pending", "approval_timeout", "approval_pending");
    expect(only(h.writer)).toMatchObject({ status: "error", text: "Hello" });
    return h;
  }

  it("a delta after such a close is not written", async () => {
    const h = await closedExternally();
    await h.feed(chatDelta("runA", 2, "Hello world"));
    expect(h.writer.offered).toEqual([]);
  });

  it("an `aborted` or `error` terminal's text is", async () => {
    const aborted = await closedExternally();
    await aborted.feed(chatDelta("runA", 2, "Hello wor"), chatAborted("runA", 3, "Hello world"));
    expect(only(aborted.writer).text).toBe("Hello world");

    const failed = await closedExternally();
    await failed.feed(chatError("runA", 3, "provider failed", "Hello world"));
    expect(only(failed.writer)).toMatchObject({ status: "error", text: "Hello world", error: "approval_pending" });
  });

  it("a run the transcript closed keeps its lane: no completion window", async () => {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(agent("runA", 0, "lifecycle", { phase: "start" }), chatDelta("runA", 1, "Hello"));
    await h.rm.endTurn(h.tick(), "final", null, "transcript_settled");
    await h.feed(chatAborted("runA", 3, "Hello world"));
    expect(h.writer.offered).toEqual([]);
  });
});

describe("captured 2026.9.8 — a chat terminal carrying the text AFTER the run's lifecycle error", () => {
  const CAPTURED = (
    JSON.parse(
      readFileSync(resolve(__dirname, "./fixtures/lifecycle-terminal-frames.json"), "utf-8"),
    ) as {
      abortedAfterLifecycleError: {
        gatewayVersion: string;
        sessionKey: string;
        runId: string;
        frames: GatewayFrame[];
      };
    }
  ).abortedAfterLifecycleError;
  const fixture: Fixture = {
    version: CAPTURED.gatewayVersion,
    file: "abortedAfterLifecycleError.json",
    header: {
      corpus: "bench-capture",
      promoter: 0,
      scenario: "abortedAfterLifecycleError",
      gatewayVersion: CAPTURED.gatewayVersion,
      bodySha256: "",
      frames: CAPTURED.frames.length,
      sessionKey: CAPTURED.sessionKey,
      ackRunIds: [CAPTURED.runId],
    },
    entries: CAPTURED.frames.map((frame) => ({ receivedAt: null, frame })),
  } as Fixture;
  const state = (f: GatewayFrame) => (f.payload as { state?: unknown }).state;
  const phase = (f: GatewayFrame) =>
    ((f.payload as { data?: { phase?: unknown } }).data ?? {}).phase;
  const FULL = "J’ai créé le fichier texte demandé dans le dossier sortant téléchargeable du webchat.";

  it("the capture shows the order: lifecycle error, then `chat aborted` with the text, same run and seq", () => {
    const frames = CAPTURED.frames;
    const at = frames.findIndex((f) => f.event === "agent" && phase(f) === "error");
    const next = frames[at + 1]!;
    expect(at).toBeGreaterThan(0);
    expect(next.event).toBe("chat");
    expect(state(next)).toBe("aborted");
    const a = frames[at]!.payload as { runId: string; seq: number };
    const b = next.payload as { runId: string; seq: number; message?: unknown };
    expect([b.runId, b.seq]).toEqual([a.runId, a.seq]);
    expect(b.message).toBeDefined();
  });

  it("as captured: the chat stream had delivered everything — nothing to complete, nothing written", async () => {
    const w = await replay(fixture, new Writer());
    expect(only(w)).toMatchObject({ status: "error", text: FULL });
    expect(w.offered).toEqual([]);
    expect(w.finalizes).toHaveLength(1);
  });

  it("with its last chat delta dropped: the terminal that follows the lifecycle error completes the bubble", async () => {
    const lastDelta = CAPTURED.frames.reduce(
      (found, f, i) => (f.event === "chat" && state(f) === "delta" ? i : found),
      -1,
    );
    const w = await replay(fixture, new Writer(), undefined, lastDelta);
    expect(only(w)).toMatchObject({ status: "error", text: FULL });
    expect(w.offered.map((o) => o.applied)).toEqual([true]);
    expect(w.finalizes).toHaveLength(1);
    expect(w.writesAfterSettle).toBe(0);
  });
});

describe("the golden corpus — a completion never appears where the chat stream was whole", () => {
  it("every fixture of every version: no completion is offered and refused", async () => {
    let offered = 0;
    for (const fx of loadCorpus()) {
      const w = await replay(fx, new Writer());
      expect(w.offered.filter((o) => !o.applied), `${fx.version}/${fx.header.scenario}`).toEqual([]);
      expect(w.writesAfterSettle, `${fx.version}/${fx.header.scenario}`).toBe(0);
      offered += w.offered.length;
    }
    // Measured: no golden fixture closes a turn before text its run then sends.
    expect(offered).toBe(0);
  });
});
