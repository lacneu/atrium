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
// of what that message of that run holds, or nothing.

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
  /** Completion writes that fail before anything is committed, then the backend is back. */
  transientFailures = 0;

  override async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const id = await super.startAssistant(chatId, runId);
    this.live.set(id, "");
    this.runs.set(id, runId);
    return id;
  }
  override async appendDelta(m: string, text: string): Promise<void> {
    if (this.settled.has(m)) this.writesAfterSettle++;
    this.live.set(m, (this.live.get(m) ?? "") + text);
  }
  override async setSnapshot(m: string, text: string, replace?: boolean): Promise<boolean> {
    if (this.settled.has(m)) this.writesAfterSettle++;
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
    this.settled.set(m, {
      runId: this.runs.get(m) ?? null,
      status,
      text: text === "" ? (this.live.get(m) ?? "") : text,
      error: error ?? null,
    });
  }
  async completeSettledText(a: { messageId: string; runId: string; text: string }): Promise<boolean> {
    if (this.failCompletions) throw new Error("convex down");
    if (this.transientFailures > 0) {
      this.transientFailures--;
      throw new Error("convex down");
    }
    const s = this.settled.get(a.messageId);
    const applied =
      s !== undefined &&
      s.runId === a.runId &&
      a.text.length > s.text.length &&
      a.text.startsWith(s.text);
    this.offered.push({ ...a, applied });
    if (applied) s!.text = a.text;
    return applied;
  }
  readonly late: string[] = [];
  async appendLateFinal(a: { messageId: string | null; text: string }): Promise<string | null> {
    this.late.push(a.text);
    const s = a.messageId === null ? undefined : this.settled.get(a.messageId);
    if (s !== undefined && !s.text.includes(a.text)) s.text = s.text.trim() === "" ? a.text : `${s.text}\n\n${a.text}`;
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
  const feed = async (...frames: unknown[]) => {
    for (const f of frames) await rm.feed(f, (now += 0.01));
  };
  return { writer, rm, feed, now: () => now, tick: () => (now += 1) };
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

  it("only until the next turn begins", async () => {
    const h = await closedOnLifecycleError();
    await h.rm.beginTurn(h.now(), "runB", { expectedSessionId: null });
    await h.feed(chatDelta("runA", 3, "Hello world"), chatError("runA", 3, "x", "Hello world"));
    expect(h.writer.offered).toEqual([]);
    expect(h.writer.settled.get("msg1")!.text).toBe("Hello");
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

  it("the normalizer alone: no window once a turn began, and the window is the last close's", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(1);
    n.noteRunStarted("runA", 1);
    n.feed(chatDelta("runA", 1, "Hello"), 1);
    n.feed(lifecycleError("runA", 2), 1);
    n.beginTurn(2);
    expect(n.settledCompletion(chatDelta("runA", 2, "Hello world"))).toBeNull();
    // The next close replaces the window: run A's text is no longer accepted.
    n.noteRunStarted("runB", 2);
    n.feed(chatDelta("runB", 1, "Hi"), 2);
    n.feed(lifecycleError("runB", 2), 2);
    expect(n.settledCompletion(chatDelta("runA", 3, "Hello world"))).toBeNull();
    expect(n.settledCompletion(chatDelta("runB", 2, "Hi there"))).toMatchObject({ runId: "runB", text: "Hi there" });
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

  it("a completion that is not written leaves a final to CU-8: its text is never dropped", async () => {
    const h = await closedOnLifecycleError();
    h.writer.failCompletions = true;
    await h.feed(chatFinal("runA", 3, "Hello world"));
    expect(h.writer.late).toEqual(["world"]);
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
  });
});

describe("part seven — a write that fails does not consume the completion", () => {
  it.each([
    ["aborted", (text: string) => chatAborted("runA", 3, text)],
    ["error", (text: string) => chatError("runA", 3, "provider failed", text)],
  ])("the flush fails once, the identical `%s` terminal lands the text", async (_n, terminal) => {
    const h = await closedOnLifecycleError();
    h.writer.transientFailures = 1;
    await h.feed(chatDelta("runA", 3, "Hello world"));
    expect(only(h.writer).text).toBe("Hello");
    await h.feed(terminal("Hello world"));
    expect(only(h.writer).text).toBe("Hello world");
    expect(h.writer.late).toEqual([]);
  });

  it("the terminal's own write fails: its window stays open, a re-broadcast lands the text", async () => {
    const h = await closedOnLifecycleError();
    h.writer.transientFailures = 1;
    await h.feed(chatAborted("runA", 3, "Hello world"));
    expect(only(h.writer).text).toBe("Hello");
    expect(h.writer.late).toEqual([]);
    await h.feed({ ...chatAborted("runA", 3, "Hello world") });
    expect(only(h.writer).text).toBe("Hello world");
  });

  it("delta and terminal in flight together: one text, whichever write lands, and no trace", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      for (const failures of [0, 1]) {
        const h = await closedOnLifecycleError();
        h.writer.transientFailures = failures;
        // Not awaited one by one: both offers are decided before either write resolves.
        await Promise.all([
          h.rm.feed(chatDelta("runA", 3, "Hello world"), h.tick()),
          h.rm.feed(chatAborted("runA", 3, "Hello world"), h.tick()),
        ]);
        expect(only(h.writer).text).toBe("Hello world");
        expect(h.writer.offered.filter((o) => o.applied)).toHaveLength(1);
        expect(h.writer.late).toEqual([]);
        expect(h.writer.finalizes).toHaveLength(1);
        if (failures === 0) expect(errors).toEqual([]);
      }
    } finally {
      console.error = original;
    }
  });

  it("the normalizer's reference moves only on an accepted write, in either order of answers", () => {
    const closed = () => {
      const n = new Normalizer(KEY);
      n.beginTurn(1);
      n.noteRunStarted("runA", 1);
      n.feed(chatDelta("runA", 1, "Hello"), 1);
      n.feed(lifecycleError("runA", 2), 1);
      return n;
    };
    for (const order of [[0, 1], [1, 0]] as const) {
      const n = closed();
      const offers = [
        n.settledCompletion(chatDelta("runA", 3, "Hello world"))!,
        n.settledCompletion(chatAborted("runA", 3, "Hello world"))!,
      ];
      expect(offers.map((o) => o?.text)).toEqual(["Hello world", "Hello world"]);
      // The first answer accepts, the second is refused as a repeat: same end state.
      n.noteCompletion(offers[order[0]]!, true);
      n.noteCompletion(offers[order[1]]!, false);
      expect(n.settledCompletion(chatAborted("runA", 4, "Hello world"))).toBeNull();
    }
    // Refused or failed: nothing moved, the same text is offered again.
    const n = closed();
    const first = n.settledCompletion(chatDelta("runA", 3, "Hello world"))!;
    n.noteCompletion(first, null);
    expect(n.settledCompletion(chatDelta("runA", 4, "Hello world"))).toMatchObject({ text: "Hello world" });
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

  it("no completion ever comes: the next turn gives the bubble its whole text before it begins", async () => {
    const h = await closedWith("The log is in /tmp/x");
    await h.rm.beginTurn(h.tick(), "runB", { expectedSessionId: null });
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

  it("the whole text Convex refuses is offered once, not at every frame", async () => {
    const h = await closedWith("The log is in /tmp/x");
    only(h.writer).text = "something else";
    await h.feed(tickFrame, tickFrame, tickFrame);
    expect(h.writer.offered.map((o) => o.applied)).toEqual([false]);
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

  it("DECLARED — a rewrite of text already persisted (line ends normalised): the terminal's text joins, never lost", async () => {
    const h = await closedWith("One\r\nTwo");
    expect(only(h.writer).text).toBe("One\r\nTwo");
    await h.feed(chatAborted("runA", 2, `One\r\nTwo ${OUT}/a.txt ok`));
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
