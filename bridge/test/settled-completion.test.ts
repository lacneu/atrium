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
import { describe, expect, it, vi } from "vitest";
import { HttpConvexWriter, type FinalizeStatus } from "../src/convex-writer.js";
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
  /** Convex's write keys (`appendLateFinal`, table `lateFinalWrites`): with it, a late
   *  final that names no bubble OPENS one, remembered by its key. Off: "no bubble" is
   *  answered (the older tests' reading of a run that left none). */
  opensBubbles = false;
  readonly openedByKey = new Map<string, string>();
  /** Every key a late-final write carried, in order. */
  readonly lateKeys: Array<string | undefined> = [];
  async appendLateFinal(a: { messageId: string | null; text: string; writeKey?: string | null; runId?: string }): Promise<string | null> {
    this.lateKeys.push(a.writeKey ?? undefined);
    if (this.failLate) throw new Error("convex down");
    if (this.lateFailures > 0) {
      this.lateFailures--;
      throw new Error("convex down");
    }
    this.late.push(a.text);
    this.log.push(`late ${a.messageId} ${JSON.stringify(a.text)}`);
    if (a.messageId === null && this.opensBubbles && typeof a.writeKey === "string") {
      let id = this.openedByKey.get(a.writeKey);
      if (id === undefined) {
        id = `late${this.openedByKey.size + 1}`;
        this.openedByKey.set(a.writeKey, id);
        this.settled.set(id, { runId: a.runId ?? null, status: "complete", text: a.text, error: null });
      } else {
        const held = this.settled.get(id)!;
        if (!held.text.includes(a.text)) held.text = a.text.startsWith(held.text) ? a.text : `${held.text}\n\n${a.text}`;
      }
      if (this.lostLateAnswers > 0) {
        this.lostLateAnswers--;
        throw new Error("answer lost");
      }
      return id;
    }
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

  it("at most 32 bubbles are owed a completion: the next one's is dropped, and said — never an older one", async () => {
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
    const texts = [...h.writer.settled.values()].map((b) => b.text);
    expect(texts.slice(0, 32)).toEqual(Array.from({ length: 32 }, () => "Hello world"));
    expect(texts.slice(32)).toEqual(["Hello", "Hello"]);
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
    // Off the frame path, on the one chain every settled bubble's write takes: it is
    // asked once the write in flight is answered — in ITS bubble, not behind msg1's debt.
    expect(h.writer.late).toEqual([]);
    release();
    await h.rm.completionsIdle();
    expect(h.writer.log.at(-1)).toBe('late msg2 "A distinct answer"');
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

describe("one queue per bubble: a late final stays behind the completion its bubble is owed", () => {
  const erred = async (run: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines;
  };

  it("the reviewed sequence: two failing passes with a distinct final waiting, then recovery — the completion, then the final, once, in order", async () => {
    const h = await closedOnLifecycleError();
    h.writer.transientFailures = 2;
    await h.feed(chatAborted("runA", 3, "Hello world"));
    // The final's own frame gives the debt its second pass, which fails too: the final
    // is not written in front of a text the bubble is still owed.
    await h.feed(chatFinal("runA", 4, "A distinct answer"));
    expect(only(h.writer).text).toBe("Hello");
    expect(h.writer.late).toEqual([]);
    await h.feed(tickFrame());
    expect(only(h.writer).text).toBe("Hello world\n\nA distinct answer");
    expect(h.writer.late).toEqual(["A distinct answer"]);
    expect(h.writer.completions.at(-1)).toBe('complete msg1 "Hello world" true');
  });

  it("the debt is finally DROPPED: the final then lands against the bubble as it is", async () => {
    const h = await closedOnLifecycleError();
    h.writer.failCompletions = true;
    await h.feed(chatAborted("runA", 3, "Hello world"), chatFinal("runA", 4, "A distinct answer"));
    expect(h.writer.late).toEqual([]);
    await h.feed(tickFrame(), tickFrame());
    expect(h.writer.late).toEqual(["A distinct answer"]);
    expect(only(h.writer).text).toBe("Hello\n\nA distinct answer");
    // Nothing is owed any more: the next final is written at once.
    await h.feedOnly(chatFinal("runA", 5, "And another"));
    expect(h.writer.late).toEqual(["A distinct answer", "And another"]);
  });

  it("several finals behind one debt keep their order, and one arriving while they are written goes after them", async () => {
    const h = await closedOnLifecycleError();
    let landed!: () => void;
    h.writer.gate = new Promise<void>((r) => (landed = r));
    await h.feedOnly(
      chatAborted("runA", 3, "Hello world"),
      chatFinal("runA", 4, "First late"),
      chatFinal("runA", 5, "Second late"),
    );
    expect(h.writer.late).toEqual([]);
    // The completion lands; the first queued final's write is held while a third arrives.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const late = h.writer.appendLateFinal.bind(h.writer);
    let n = 0;
    h.writer.appendLateFinal = async (a) => {
      if (n++ === 0) await held;
      return late(a);
    };
    landed();
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBe(1);
    await h.feedOnly(chatFinal("runA", 6, "Third late"));
    release();
    await h.rm.completionsIdle();
    expect(h.writer.late).toEqual(["First late", "Second late", "Third late"]);
    expect(only(h.writer).text).toBe("Hello world\n\nFirst late\n\nSecond late\n\nThird late");
  });

  it("at most eight wait behind one debt: one more is dropped, and said", async () => {
    const h = await closedOnLifecycleError();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    const lines = await erred(async () => {
      await h.feedOnly(chatAborted("runA", 3, "Hello world"));
      for (let i = 0; i < 9; i++) await h.feedOnly(chatFinal("runA", 4 + i, `Late ${i}`));
      release();
      await h.rm.completionsIdle();
    });
    expect(lines.filter((l) => l.includes("late final DROPPED"))).toHaveLength(1);
    expect(h.writer.late).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `Late ${i}`));
  });

  it("AT THE CEILING (the reviewed sequence): a final arriving while 34 bubbles wait still goes behind the one already waiting", async () => {
    const h = harness();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    const original = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 34; i++) {
        await h.rm.beginTurn(h.tick(), `run${i}`, { expectedSessionId: null });
        await h.feedOnly(
          chatDelta(`run${i}`, 1, "Hello"),
          lifecycleError(`run${i}`, 2),
          chatDelta(`run${i}`, 2, "Hello world"),
          ...(i === 1 ? [chatAborted("run1", 2, "Hello world"), chatFinal("run1", 3, "First late")] : []),
        );
      }
      // Past the bound on bubbles owed a completion: run1's queue is still its own.
      await h.feedOnly(chatFinal("run1", 4, "Second late"));
      expect(h.writer.late).toEqual([]);
      release();
      await h.rm.completionsIdle();
    } finally {
      console.warn = original;
    }
    expect(h.writer.settled.get("msg2")!.text).toBe("Hello world\n\nFirst late\n\nSecond late");
  });

  /** A delivery that showed nothing when a net closed its deferred turn: no bubble. */
  const RUN = "announce:v1:agent:alice:subagent:child:run-1";
  async function noBubble() {
    const h = harness();
    await h.feed(agent(RUN, 0, "lifecycle", { phase: "start" }));
    await h.rm.endTurn(h.tick(), "final", null, "recv_timeout");
    expect(h.rm.turnActive).toBe(false);
    expect(h.writer.starts).toBe(0);
    h.writer.opensBubbles = true;
    return h;
  }

  it("a run that left NO bubble: the write that opens one fails, and is asked again under the SAME key until it lands", async () => {
    const h = await noBubble();
    h.writer.lateFailures = 2;
    const lines = await erred(async () => {
      await h.feed(chatAborted(RUN, 1, "Hello world"), tickFrame(), tickFrame(), tickFrame());
    });
    expect(h.writer.lateKeys).toHaveLength(3);
    expect(new Set(h.writer.lateKeys).size).toBe(1);
    expect(typeof h.writer.lateKeys[0]).toBe("string");
    expect([...h.writer.settled.values()].map((b) => b.text)).toEqual(["Hello world"]);
    expect(lines.filter((l) => l.includes("is not asked again"))).toEqual([]);
    // The run's record follows the bubble that write opened: a later final joins IT.
    await h.feed(chatFinal(RUN, 2, "And more"));
    expect([...h.writer.settled.values()].map((b) => b.text)).toEqual(["Hello world\n\nAnd more"]);
  });

  it("…its ANSWER is lost after the bubble was opened: the repeat is given that bubble — one bubble", async () => {
    const h = await noBubble();
    h.writer.lostLateAnswers = 1;
    await erred(async () => {
      await h.feed(chatAborted(RUN, 1, "Hello world"), tickFrame());
    });
    expect(h.writer.lateKeys).toHaveLength(2);
    expect(new Set(h.writer.lateKeys).size).toBe(1);
    expect(h.writer.openedByKey.size).toBe(1);
    expect([...h.writer.settled.values()].map((b) => b.text)).toEqual(["Hello world"]);
  });

  it("…it never lands: three passes, then dropped and said", async () => {
    const h = await noBubble();
    h.writer.failLate = true;
    const lines = await erred(async () => {
      await h.feed(chatAborted(RUN, 1, "Hello world"), tickFrame(), tickFrame(), tickFrame(), tickFrame());
    });
    expect(h.writer.lateKeys).toHaveLength(3);
    expect(lines.filter((l) => l.includes("DROPPED"))).toHaveLength(1);
    expect(h.writer.settled.size).toBe(0);
  });

  it("…on a Convex that cannot tell a repeat (the writer says the write was asked once): asked once, as before", async () => {
    const h = await noBubble();
    let asked = 0;
    h.writer.appendLateFinal = async (a) => {
      asked++;
      expect(a.messageId).toBeNull();
      throw Object.assign(new Error("convex down"), { askedOnce: true });
    };
    const lines = await erred(async () => {
      await h.feed(chatAborted(RUN, 1, "Hello world"), tickFrame(), tickFrame(), tickFrame());
    });
    expect(asked).toBe(1);
    expect(lines.filter((l) => l.includes("is not asked again"))).toHaveLength(1);
    expect(h.writer.offered).toEqual([]);
  });

  it("a final waiting behind a debt, its write FAILS: it stays at the head, nothing behind it passes it, and it is asked again with its own key", async () => {
    const h = await closedOnLifecycleError();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    await h.feedOnly(chatAborted("runA", 3, "Hello world"), chatFinal("runA", 4, "First late"), chatFinal("runA", 5, "Second late"));
    // Two passes are already due (the offer's, and the one the finals' frames asked for).
    h.writer.lateFailures = 2;
    const lines = await erred(async () => {
      release();
      await h.rm.completionsIdle();
      // Both passes ended on the failure: the second final did NOT go in front.
      expect(h.writer.late).toEqual([]);
      expect(only(h.writer).text).toBe("Hello world");
      // A third arrives meanwhile: behind the two that wait.
      await h.feedOnly(chatFinal("runA", 6, "Third late"));
      await h.rm.completionsIdle();
    });
    expect(h.writer.late).toEqual(["First late", "Second late", "Third late"]);
    expect(only(h.writer).text).toBe("Hello world\n\nFirst late\n\nSecond late\n\nThird late");
    // Five writes asked: the first final three times under ONE key, each other under its own.
    expect(h.writer.lateKeys).toHaveLength(5);
    expect(new Set(h.writer.lateKeys.slice(0, 3)).size).toBe(1);
    expect(new Set(h.writer.lateKeys).size).toBe(3);
    expect(lines.filter((l) => l.includes("kept, asked again at the next frame"))).toHaveLength(2);
    // The completion was written once: a later pass does not ask for it again.
    expect(h.writer.completions.filter((c) => c.startsWith("complete msg1"))).toHaveLength(1);
  });

  it("…it never lands: dropped after three passes, said, and the next one is then written", async () => {
    const h = await closedOnLifecycleError();
    let release!: () => void;
    h.writer.gate = new Promise<void>((r) => (release = r));
    await h.feedOnly(chatAborted("runA", 3, "Hello world"), chatFinal("runA", 4, "First late"), chatFinal("runA", 5, "Second late"));
    h.writer.lateFailures = 3;
    const lines = await erred(async () => {
      release();
      // The two passes already due fail; each later frame gives it one more.
      await h.rm.completionsIdle();
      await h.feed(tickFrame());
      await h.feed(tickFrame());
    });
    expect(lines.filter((l) => l.includes("a late final in a settled bubble's queue was not written") && l.includes("DROPPED"))).toHaveLength(1);
    expect(h.writer.late).toEqual(["Second late"]);
    expect(only(h.writer).text).toBe("Hello world\n\nSecond late");
  });

  it("two late finals of one run with the same text are two writes: each carries its own key", async () => {
    const h = await closedOnLifecycleError();
    await h.feed(chatAborted("runA", 3, "Hello world"));
    await h.feed(chatFinal("runA", 4, "Late"), chatFinal("runA", 5, "Late too"));
    expect(h.writer.lateKeys).toHaveLength(2);
    expect(h.writer.lateKeys[0]).not.toBe(h.writer.lateKeys[1]);
    expect(h.writer.lateKeys.every((k) => typeof k === "string" && k.length >= 32)).toBe(true);
  });
});

// A DISTINCT late final (CU-8) of a bubble that is owed nothing was awaited by the frame
// that carried it — and, its keyed write being retried by the writer (three attempts of
// 20 s), a Convex endpoint that times out held every following frame of the connection
// for up to 62.5 s. It takes the bubble's queue like every other write to a settled
// bubble; what the wait guaranteed is kept by the queue's order.
describe("a direct late final is written off the frame path", () => {
  const erred = async (run: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines;
  };
  /** "Hello" answered and settled by its own final: the bubble is owed nothing. */
  async function answered() {
    const h = harness();
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 1, "Hello"), chatFinal("runA", 2, "Hello"));
    expect(only(h.writer)).toMatchObject({ status: "complete", text: "Hello" });
    return h;
  }
  /** Hold the late-final writes: each waits for `release()`. */
  function holdLate(h: ReturnType<typeof harness>) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const late = h.writer.appendLateFinal.bind(h.writer);
    let asked = 0;
    h.writer.appendLateFinal = async (a) => {
      asked++;
      await held;
      return late(a);
    };
    return { release, asked: () => asked };
  }

  it("THE REAL WRITER, an endpoint that never answers: `feed` returns, the next turn's frames are written, and the final lands when Convex is back", async () => {
    const h = await answered();
    // The late final goes through the real HTTP writer: its timeout, its retries.
    const posts: Array<{ op: string; writeKey?: string }> = [];
    let down = true;
    const fetchImpl = (async (_url: unknown, init: { body: string; signal: AbortSignal }) => {
      const body = JSON.parse(init.body) as { op: string; writeKey?: string; messageId: string | null };
      posts.push({ op: body.op, writeKey: body.writeKey });
      if (down) {
        // Never answers: only the writer's own deadline ends the attempt.
        await new Promise<void>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return new Response(JSON.stringify({ ok: true, messageId: body.messageId }), { status: 200 });
    }) as unknown as typeof fetch;
    const http = new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", fetchImpl });
    const recorded = h.writer.appendLateFinal.bind(h.writer);
    h.writer.appendLateFinal = async (a) => {
      const id = await http.appendLateFinal({ chatId: "c1", runId: a.runId ?? "", messageId: a.messageId, text: a.text, sessionKey: KEY, writeKey: a.writeKey });
      await recorded(a);
      return id;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const lines = await erred(async () => {
        let fed = false;
        const feeding = h.feedOnly(chatFinal("runA", 3, "A second, distinct answer")).then(() => (fed = true));
        await vi.advanceTimersByTimeAsync(0);
        // The frame is done while its write has not been answered.
        expect(fed).toBe(true);
        await feeding;
        expect(posts).toHaveLength(1);
        // The connection goes on: a whole turn of another run is read and written.
        await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
        await h.feedOnly(chatDelta("runB", 1, "Next answer"), chatFinal("runB", 2, "Next answer"));
        expect(h.writer.settled.get("msg2")).toMatchObject({ status: "complete", text: "Next answer" });
        expect(h.writer.late).toEqual([]);
        // The writer's whole budget for one pass: 20 s, 0.5 s, 20 s, 2 s, 20 s.
        await vi.advanceTimersByTimeAsync(62_500);
        // That pass failed; the frames read meanwhile had asked for one more, now asking.
        expect(posts).toHaveLength(4);
        expect(h.writer.late).toEqual([]);
        // Convex is back: the attempt in flight times out, the writer's retry lands.
        down = false;
        await vi.advanceTimersByTimeAsync(20_500);
        await h.rm.completionsIdle();
      });
      expect(posts.map((p) => p.op)).toEqual(Array(5).fill("appendLateFinalKeyed"));
      expect(new Set(posts.map((p) => p.writeKey)).size).toBe(1);
      expect(h.writer.settled.get("msg1")!.text).toBe("Hello\n\nA second, distinct answer");
      expect(h.writer.settled.get("msg2")!.text).toBe("Next answer");
      expect(lines.filter((l) => l.includes("kept, asked again at the next frame"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the NEXT final of the same bubble waits for the first, and is compared with what the first wrote", async () => {
    const h = await answered();
    const { release, asked } = holdLate(h);
    // The second is the gateway's cumulative view: the reply, the first late text, more.
    await h.feedOnly(
      chatFinal("runA", 3, "First late"),
      chatFinal("runA", 4, "Hello\n\nFirst late\n\nAnd more"),
      chatFinal("runA", 5, "First late"),
    );
    await new Promise((r) => setTimeout(r, 5));
    // One write in flight: nothing of the same bubble is asked beside it.
    expect(asked()).toBe(1);
    release();
    await h.rm.completionsIdle();
    // Only what each ADDS to the bubble as the one before left it; the repeat adds nothing.
    expect(h.writer.late).toEqual(["First late", "And more"]);
    expect(only(h.writer).text).toBe("Hello\n\nFirst late\n\nAnd more");
  });

  it("two finals of a run that left NO bubble share one queue: the first opens the bubble, the second joins it", async () => {
    const RUN = "announce:v1:agent:alice:subagent:child:run-1";
    const h = harness();
    await h.feed(agent(RUN, 0, "lifecycle", { phase: "start" }));
    await h.rm.endTurn(h.tick(), "final", null, "recv_timeout");
    await h.feed(chatAborted(RUN, 1));
    expect(h.writer.starts).toBe(0);
    h.writer.opensBubbles = true;
    const { release } = holdLate(h);
    await h.feedOnly(chatFinal(RUN, 2, "The report"), chatFinal(RUN, 3, "An addendum"));
    release();
    await h.rm.completionsIdle();
    expect(h.writer.openedByKey.size).toBe(1);
    expect([...h.writer.settled.values()].map((b) => b.text)).toEqual(["The report\n\nAn addendum"]);
    expect(h.writer.log.filter((l) => l.startsWith("late "))).toEqual(['late null "The report"', 'late late1 "An addendum"']);
  });

  it("its write fails: kept at the head of its queue under its key, asked again at the next frames, dropped and said after three passes", async () => {
    const h = await answered();
    h.writer.failLate = true;
    const lines = await erred(async () => {
      await h.feed(chatFinal("runA", 3, "A distinct answer"), tickFrame(), tickFrame(), tickFrame(), tickFrame());
    });
    expect(h.writer.lateKeys).toHaveLength(3);
    expect(new Set(h.writer.lateKeys).size).toBe(1);
    expect(lines.filter((l) => l.includes("kept, asked again at the next frame"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("DROPPED"))).toHaveLength(1);
    expect(only(h.writer).text).toBe("Hello");
    // The queue is gone with it: a later final is asked at once.
    h.writer.failLate = false;
    await h.feed(chatFinal("runA", 4, "Another"));
    expect(only(h.writer).text).toBe("Hello\n\nAnother");
  });

  it("AT THE BOUND on the queues: the late final of one more bubble is dropped and said, and no queue is taken away", async () => {
    const h = harness();
    for (let i = 0; i < 33; i++) {
      await h.rm.beginTurn(h.tick(), `run${i}`, { expectedSessionId: null });
      await h.feed(chatDelta(`run${i}`, 1, `Answer ${i}`), chatFinal(`run${i}`, 2, `Answer ${i}`));
    }
    const { release } = holdLate(h);
    const lines = await erred(async () => {
      for (let i = 0; i < 33; i++) await h.feedOnly(chatFinal(`run${i}`, 3, `Late ${i}`));
      // A second final for a bubble that HAS a queue is still routed to it.
      await h.feedOnly(chatFinal("run0", 4, "Late again"));
      release();
      await h.rm.completionsIdle();
    });
    expect(lines.filter((l) => l.includes("late final DROPPED") && l.includes("already have a write queue"))).toHaveLength(1);
    expect(h.writer.late).toEqual([...Array.from({ length: 32 }, (_, i) => `Late ${i}`).flatMap((t, i) => (i === 0 ? [t, "Late again"] : [t]))]);
    expect(h.writer.settled.get("msg33")!.text).toBe("Answer 32");
    expect(h.writer.settled.get("msg1")!.text).toBe("Answer 0\n\nLate 0\n\nLate again");
  });

  it("a final that adds nothing to a bubble with no queue takes no queue: 32 repeats, and the late final of one more bubble is still written", async () => {
    const h = harness();
    for (let i = 0; i < 34; i++) {
      await h.rm.beginTurn(h.tick(), `run${i}`, { expectedSessionId: null });
      await h.feed(chatDelta(`run${i}`, 1, `Answer ${i}`), chatFinal(`run${i}`, 2, `Answer ${i}`));
    }
    const { release } = holdLate(h);
    const lines = await erred(async () => {
      await h.feedOnly(chatFinal("run0", 3, "Late 0"));
      // Repeats of finals already shown, and silent ones: ordinary frames.
      for (let i = 1; i < 33; i++) await h.feedOnly(chatFinal(`run${i}`, 3, i % 2 === 0 ? `Answer ${i}` : "NO_REPLY"));
      await h.feedOnly(chatFinal("run33", 3, "Late 33"));
      release();
      await h.rm.completionsIdle();
    });
    expect(lines).toEqual([]);
    expect(h.writer.late).toEqual(["Late 0", "Late 33"]);
  });

  it("a fact about a run that left no bubble waits for the late final that opens one", async () => {
    const RUN = "announce:v1:agent:alice:subagent:child:run-1";
    const h = harness();
    await h.feed(agent(RUN, 0, "lifecycle", { phase: "start" }));
    await h.rm.endTurn(h.tick(), "final", null, "recv_timeout");
    await h.feed(chatAborted(RUN, 1));
    h.writer.opensBubbles = true;
    // Convex's lookup of the run's bubble when the bridge names none.
    h.writer.noteGatewayNotice = async (_c, d) => {
      const id = d.messageId ?? [...h.writer.settled].find(([, b]) => b.runId === RUN)?.[0] ?? null;
      if (id !== null) h.writer.facts.push(`notice ${d.text} → ${id}`);
      return id;
    };
    const { release } = holdLate(h);
    const lines = await erred(async () => {
      await h.feedOnly(chatFinal(RUN, 2, "The report"));
      await h.feedOnly({
        type: "event",
        event: "chat",
        payload: { sessionKey: KEY, runId: RUN, seq: 3, state: "final", message: { role: "assistant", content: [{ type: "text", text: "Usage: 1 in / 1 out", openclawStatusNotice: true }] } },
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(h.writer.facts).toEqual([]);
      release();
      await h.rm.completionsIdle();
      await h.rm.runFactsIdle();
    });
    expect(lines).toEqual([]);
    expect(h.writer.facts).toEqual(["notice Usage: 1 in / 1 out → late1"]);
  });

  it("…and only for one pass: the write that would open the bubble keeps failing, the fact is then asked, answered `no bubble`, dropped and said", async () => {
    const RUN = "announce:v1:agent:alice:subagent:child:run-1";
    const h = harness();
    await h.feed(agent(RUN, 0, "lifecycle", { phase: "start" }));
    await h.rm.endTurn(h.tick(), "final", null, "recv_timeout");
    await h.feed(chatAborted(RUN, 1));
    h.writer.opensBubbles = true;
    h.writer.failLate = true;
    const asked: Array<string | null> = [];
    h.writer.noteGatewayNotice = async (_c, d) => {
      asked.push(d.messageId);
      return null;
    };
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
    try {
      await erred(async () => {
        await h.feedOnly(chatFinal(RUN, 2, "The report"));
        await h.feedOnly({
          type: "event",
          event: "chat",
          payload: { sessionKey: KEY, runId: RUN, seq: 3, state: "final", message: { role: "assistant", content: [{ type: "text", text: "Usage: 1 in / 1 out", openclawStatusNotice: true }] } },
        });
        await h.rm.completionsIdle();
        await h.rm.runFactsIdle();
      });
    } finally {
      console.warn = warn;
    }
    expect(asked).toEqual([null]);
    expect(warned.filter((l) => l.includes("the run left no bubble to carry them"))).toHaveLength(1);
  });
});

// PROPERTY: whatever the interleaving and whatever each write does, a settled bubble's
// text is its settled text, then what its run sent afterwards, each piece once and in
// the order it arrived. A piece may be MISSING (a write that kept failing, a final asked
// once that failed); it is never duplicated, and never ahead of an earlier one.
describe("property — every interleaving leaves each bubble an in-order, duplicate-free composition", () => {
  /** mulberry32. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  async function run(seed: number): Promise<void> {
    const rand = prng(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const h = harness();
    // What each write does, decided by the seed.
    const complete = h.writer.completeSettledText.bind(h.writer);
    h.writer.completeSettledText = async (a) => {
      const fate = pick(["ok", "ok", "ok", "fail", "lost"] as const);
      if (fate === "fail") throw new Error("convex down");
      const applied = await complete(a);
      if (fate === "lost") throw new Error("answer lost");
      return applied;
    };
    const late = h.writer.appendLateFinal.bind(h.writer);
    h.writer.appendLateFinal = async (a) => {
      const fate = pick(["ok", "ok", "ok", "fail", "lost"] as const);
      if (fate === "fail") throw new Error("convex down");
      const into = await late(a);
      if (fate === "lost") throw new Error("answer lost");
      return into;
    };

    // Two or three bubbles, each settled by its run's lifecycle error — on "Hello", or on
    // a text whose line end the sanitiser rewrites: Convex then REFUSES every completion
    // of that bubble (never an extension of what it holds), and each is joined.
    const bubbles = rand() < 0.5 ? 2 : 3;
    const scripts: Array<Array<() => unknown>> = [];
    const expected: Array<{ base: string; words: string[]; lates: string[] }> = [];
    for (let b = 0; b < bubbles; b++) {
      const runId = `run${b}`;
      const base = rand() < 0.35 ? "Hel\r\nlo" : "Hello";
      await h.rm.beginTurn(h.tick(), runId, { expectedSessionId: null });
      await h.feedOnly(chatDelta(runId, 1, base), lifecycleError(runId, 2));
      // The run's script, in ITS order: flushed deltas, the terminal, then late finals.
      const words: string[] = [];
      const steps: Array<() => unknown> = [];
      let seq = 2;
      let text = base;
      const deltas = Math.floor(rand() * 3);
      for (let d = 0; d < deltas; d++) {
        const word = `w${b}${d}`;
        words.push(word);
        text = `${text} ${word}`;
        const [at, snapshot] = [++seq, text];
        steps.push(() => chatDelta(runId, at, snapshot));
      }
      const last = `w${b}t`;
      words.push(last);
      text = `${text} ${last}`;
      const [at, whole] = [++seq, text];
      steps.push(() => chatAborted(runId, at, whole));
      const lates: string[] = [];
      const finals = Math.floor(rand() * 4);
      for (let f = 0; f < finals; f++) {
        const token = `L${b}${f}.`;
        lates.push(token);
        const n = ++seq;
        steps.push(() => chatFinal(runId, n, token));
      }
      scripts.push(steps);
      expected.push({ base, words, lates });
    }

    // Interleave the scripts, with ticks and turns of other runs in between.
    let other = 0;
    while (scripts.some((s) => s.length > 0)) {
      const roll = rand();
      if (roll < 0.15) {
        await h.feedOnly(tickFrame());
      } else if (roll < 0.25) {
        const runId = `other${other++}`;
        await h.rm.beginTurn(h.tick(), runId, { expectedSessionId: null });
        await h.feedOnly(chatDelta(runId, 1, "Other"), chatFinal(runId, 2, "Other"));
      } else {
        const live = scripts.filter((s) => s.length > 0);
        await h.feedOnly(pick(live).shift()!());
      }
      // Sometimes the chain is left to run, sometimes the next frame finds it busy.
      if (rand() < 0.3) await h.rm.completionsIdle();
    }
    // The connection goes on: every debt gets its passes.
    for (let i = 0; i < 6; i++) await h.feed(tickFrame());

    for (let b = 0; b < bubbles; b++) {
      const got = h.writer.settled.get(`msg${b + 1}`)!.text;
      const where = `seed ${seed}, bubble ${b}: ${JSON.stringify(got)}`;
      expect(got.startsWith(expected[b]!.base), where).toBe(true);
      for (const order of [expected[b]!.words, expected[b]!.lates]) {
        let from = 0;
        for (const piece of order) {
          const at = got.indexOf(piece);
          if (at === -1) continue; // missing is allowed
          expect(got.indexOf(piece, at + 1), `${where} — ${piece} twice`).toBe(-1);
          expect(at >= from, `${where} — ${piece} out of order`).toBe(true);
          from = at + piece.length;
        }
      }
      // The run's own text comes before any late final.
      const firstLate = Math.min(
        ...expected[b]!.lates.map((t) => got.indexOf(t)).filter((i) => i !== -1),
        Number.POSITIVE_INFINITY,
      );
      for (const word of expected[b]!.words) {
        const at = got.indexOf(word);
        if (at !== -1) expect(at < firstLate, `${where} — ${word} after a late final`).toBe(true);
      }
    }
    expect(h.writer.writesAfterSettle, `seed ${seed}`).toBe(0);
  }

  it("400 seeded interleavings of offers, late finals, write outcomes, ticks and turns", async () => {
    const { error, warn, log } = console;
    console.error = console.warn = console.log = () => {};
    try {
      for (let seed = 1; seed <= 400; seed++) await run(seed);
    } finally {
      console.error = error;
      console.warn = warn;
      console.log = log;
    }
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
    // The last replayed frame is held while it is read (no write of the frame path is
    // left to hold it: a late final's is detached).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const reader = h.rm as unknown as { feedPipeline: (frame: unknown, now: number) => Promise<void> };
    const read = reader.feedPipeline.bind(h.rm);
    let frames = 0;
    reader.feedPipeline = async (frame, now) => {
      if (++frames === 3) await held;
      return read(frame, now);
    };
    const opening = h.rm.beginTurn(h.tick(), "runA", { expectedSessionId: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(frames).toBe(3);
    expect(h.rm.turnActive || h.rm.turnFinalizing).toBe(false);
    expect(h.rm.liveWork).toBe("dispatch in flight");
    release();
    await opening;
    expect(h.rm.liveWork).toBeNull();
    await h.rm.completionsIdle();
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
