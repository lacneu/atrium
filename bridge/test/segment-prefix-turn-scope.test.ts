// THE EARLIER SEGMENTS OF A CUT RUN BELONG TO THAT RUN'S TURN.
//
// A steer cut settles the bubble and remembers its text as the run's `segmentPrefix`: the
// gateway keeps one cumulative buffer per run, so every later snapshot of THAT run still
// starts with it and is stripped. The next turn is another run with another buffer.
// Carried into it, the prefix trimmed an answer that began with the same words, and put
// the old segments into the next runs' records — what a late final is compared with.

import { describe, expect, it } from "vitest";
import type { FinalizeStatus } from "../src/convex-writer.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { RecordingWriter } from "./helpers/golden-corpus.js";

const KEY = "agent:alice:atrium:chat:u:c1";

class Writer extends RecordingWriter {
  readonly live = new Map<string, string>();
  readonly settled = new Map<string, string>();
  readonly late: string[] = [];
  override async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const id = await super.startAssistant(chatId, runId);
    this.live.set(id, "");
    return id;
  }
  override async appendDelta(m: string, text: string): Promise<void> {
    this.live.set(m, (this.live.get(m) ?? "") + text);
  }
  override async setSnapshot(m: string, text: string, replace?: boolean): Promise<boolean> {
    if (text.length < (this.live.get(m) ?? "").length && replace !== true) return false;
    this.live.set(m, text);
    return true;
  }
  override async finalize(m: string, _status: FinalizeStatus, text: string): Promise<void> {
    this.settled.set(m, text === "" ? (this.live.get(m) ?? "") : text);
  }
  async appendLateFinal(a: { messageId: string | null; text: string }): Promise<string | null> {
    this.late.push(a.text);
    return a.messageId;
  }
  async splitSegment(messageId: string, _after: string | null, text?: string): Promise<string | null> {
    this.settled.set(messageId, text ?? this.live.get(messageId) ?? "");
    return this.startAssistant("c1", null);
  }
}

const msg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const chat = (runId: string, seq: number, state: "delta" | "final", text: string) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, runId, seq, state, message: msg(text) },
});

/** Turn one: "First part." cut at a steered input, then "Second part." — complete. */
async function afterACutTurn() {
  const writer = new Writer();
  const rm = new RunManager("c1", KEY, writer);
  let now = 1_000;
  const feed = async (...frames: unknown[]) => {
    for (const f of frames) await rm.feed(f, (now += 0.01));
  };
  await rm.beginTurn(now, "runA", { expectedSessionId: null });
  await feed(chat("runA", 1, "delta", "First part."));
  rm.noteHeldInput("sendB", "ackB", "userB");
  await rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
  await feed(
    chat("runA", 2, "delta", "First part.\n\nSecond part."),
    chat("runA", 3, "final", "First part.\n\nSecond part."),
  );
  expect([...writer.settled.values()]).toEqual(["First part.", "Second part."]);
  return { writer, rm, feed, tick: () => (now += 1) };
}

describe("a steer cut's earlier segments do not outlive their turn", () => {
  it("the next turn's answer beginning with the same words is shown whole", async () => {
    const h = await afterACutTurn();
    await h.rm.beginTurn(h.tick(), "runC", { expectedSessionId: null });
    await h.feed(chat("runC", 1, "delta", "First part. And this time, the rest."));
    expect(h.writer.live.get("msg3")).toBe("First part. And this time, the rest.");
    await h.feed(chat("runC", 2, "final", "First part. And this time, the rest."));
    expect(h.writer.settled.get("msg3")).toBe("First part. And this time, the rest.");
  });

  it("…and one that is a shorter view of those words is not swallowed", async () => {
    const h = await afterACutTurn();
    await h.rm.beginTurn(h.tick(), "runC", { expectedSessionId: null });
    await h.feed(chat("runC", 1, "delta", "First"), chat("runC", 2, "final", "First"));
    expect(h.writer.settled.get("msg3")).toBe("First");
  });

  it("the next run's record is its own text: a cumulative late final adds only its addition", async () => {
    const h = await afterACutTurn();
    await h.rm.beginTurn(h.tick(), "runC", { expectedSessionId: null });
    await h.feed(chat("runC", 1, "delta", "Other answer"), chat("runC", 2, "final", "Other answer"));
    // Compared with a record that begins with turn one's "First part.", the final would
    // not be recognised as repeating the reply, and all of it would be joined again.
    await h.feed(chat("runC", 3, "final", "Other answer, and more"));
    expect(h.writer.late).toEqual([", and more"]);
  });

  it("a RESUMED turn still takes the earlier segments it is given, and only those", async () => {
    const h = await afterACutTurn();
    const prefix = () =>
      (h.rm as unknown as { normalizer: Normalizer }).normalizer.segmentPrefixText;
    // Resumed with no earlier segment (an uncut bubble): nothing is stripped.
    await h.rm.resumeTurn(h.tick(), "msg8", "runD");
    expect(prefix()).toBeNull();
    await h.feed(chat("runD", 1, "final", "First part. Again."));
    // Resumed on the later segment of a cut run: its own earlier segments, as given.
    await h.rm.resumeTurn(h.tick(), "msg9", "runE", "Earlier.");
    expect(prefix()).toBe("Earlier.");
    await h.feed(chat("runE", 1, "delta", "Earlier.\n\nLater."));
    expect(h.writer.live.get("msg9")).toBe("Later.");
  });

  it("the normalizer alone: a new turn starts with no earlier segment", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(1);
    n.noteRunStarted("runA", 1);
    n.feed(chat("runA", 1, "delta", "First part."), 1);
    n.splitSegment();
    expect(n.segmentPrefixText).toBe("First part.");
    n.beginTurn(2);
    expect(n.segmentPrefixText).toBeNull();
  });
});
