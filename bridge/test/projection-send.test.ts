// TRANSCRIPT PROJECTION `on` — the live overlay of a send made while the agent works
// (redesign phase 3). Deterministic: synthetic frames in the gateway's wire shapes
// (chat delta/final, agent lifecycle), a fake Convex writer. Each rule below is the
// Control UI's, cited where it is implemented (run-manager.ts, turn-sink.ts).
//
//   CU-20  a steered input cuts the foreground run's bubble at the steered row;
//   CU-4   an input's custody run (bare final) opens no turn;
//   CU-9   a run that answers a held input opens its OWN bubble, never folded into
//          the foreground turn;
//   CU-8   a distinct late final of a settled run joins its bubble;
//   CU-21  a projected turn with nothing visible leaves no bubble (no empty verdict);
//   off    none of the above happens when the switch is off (legacy unchanged).

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { prefixEndIgnoringSpace } from "../src/providers/openclaw/normalizer.js";
import type { ConvexWriter, FinalizeStatus, ToolPart } from "../src/convex-writer.js";

const KEY = "agent:alice:atrium:chat:u:c1";

type Call =
  | ["startAssistant", string | null]
  | ["appendDelta", string, string]
  | ["setSnapshot", string, string]
  | ["finalize", string, FinalizeStatus, string, Record<string, unknown>]
  | ["split", string, string | null]
  | ["late", string, string | null, string]
  | ["tool", string, string];

class FakeWriter implements ConvexWriter {
  readonly calls: Call[] = [];
  private n = 0;
  /** Remove `splitSegment` to model a writer that predates it. */
  supportsSplit = true;
  async startAssistant(_chatId: string, runId: string | null): Promise<string | null> {
    this.calls.push(["startAssistant", runId]);
    return `msg${++this.n}`;
  }
  /** Make the next `splitSegment` calls throw (a Convex write that fails). */
  failSplits = 0;
  /** The authoritative text each cut carried, in order. */
  readonly splitTexts: Array<string | undefined> = [];
  splitSegment = async (
    messageId: string,
    after: string | null,
    text?: string,
  ): Promise<string | null> => {
    if (!this.supportsSplit) return null;
    if (this.failSplits > 0) {
      this.failSplits--;
      throw new Error("convex down");
    }
    this.calls.push(["split", messageId, after]);
    this.splitTexts.push(text);
    return `msg${++this.n}`;
  };
  async appendLateFinal(a: {
    runId: string;
    messageId: string | null;
    text: string;
  }): Promise<string | null> {
    this.calls.push(["late", a.runId, a.messageId, a.text]);
    return a.messageId ?? `msg${++this.n}`;
  }
  async appendDelta(messageId: string, text: string): Promise<void> {
    this.calls.push(["appendDelta", messageId, text]);
  }
  async setSnapshot(messageId: string, text: string): Promise<boolean> {
    this.calls.push(["setSnapshot", messageId, text]);
    return true;
  }
  async addToolPart(messageId: string, p: ToolPart): Promise<void> {
    this.calls.push(["tool", messageId, `${p.name}:${p.phase}`]);
  }
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
    _e: string | null,
    _k?: string | null,
    opts?: Record<string, unknown>,
  ): Promise<void> {
    this.calls.push(["finalize", messageId, status, text, opts ?? {}]);
  }
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

const msg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const chat = (runId: string, state: "delta" | "final", text?: string) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, runId, state, ...(text === undefined ? {} : { message: msg(text) }) },
});
const lifecycle = (runId: string, phase: "start" | "end") => ({
  type: "event",
  event: "agent",
  payload: { sessionKey: KEY, runId, stream: "lifecycle", data: { phase } },
});
const tool = (runId: string, phase: "start" | "result", id: string) => ({
  type: "event",
  event: "agent",
  payload: {
    sessionKey: KEY,
    runId,
    stream: "tool",
    data: { phase, name: "exec", toolCallId: id, ...(phase === "result" ? { result: "ok" } : {}) },
  },
});

function harness(projection: boolean) {
  const writer = new FakeWriter();
  const rm = new RunManager("c1", KEY, writer);
  rm.setProjection(projection);
  let now = 1_000;
  const feed = async (...frames: unknown[]) => {
    for (const f of frames) await rm.feed(f, (now += 10));
  };
  const tick = async (ms: number) => {
    now += ms;
    await rm.tick(now);
  };
  return { writer, rm, feed, tick, now: () => now };
}

const starts = (w: FakeWriter) => w.calls.filter((c) => c[0] === "startAssistant");
const finals = (w: FakeWriter) =>
  w.calls.filter((c): c is Extract<Call, { 0: "finalize" }> => c[0] === "finalize");

describe("projection on — a send while the agent works", () => {
  it("CU-20: a steered input cuts the run's bubble; the answer streams into the new segment", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(lifecycle("runA", "start"), tool("runA", "start", "t1"), tool("runA", "result", "t1"));
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "delta", "B_OK"), chat("runA", "final", "B_OK"), lifecycle("runA", "end"));
    const split = h.writer.calls.find((c) => c[0] === "split");
    expect(split).toEqual(["split", "msg1", "userB"]);
    // The tool card stayed in segment 1; the answer is in segment 2, and only there.
    expect(h.writer.calls.filter((c) => c[0] === "tool").every((c) => c[1] === "msg1")).toBe(true);
    const f = finals(h.writer);
    expect(f).toHaveLength(1);
    expect(f[0]![1]).toBe("msg2");
    expect(f[0]![3]).toBe("B_OK");
  });

  it("CU-20: the text written BEFORE the cut is not repeated in the new segment", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "Je lance la commande."));
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    // The gateway's buffer is cumulative per run: the next snapshot repeats the head.
    await h.feed(
      chat("runA", "delta", "Je lance la commande.\n\nB_OK"),
      chat("runA", "final", "Je lance la commande.\n\nB_OK"),
    );
    const f = finals(h.writer);
    expect(f).toHaveLength(1);
    expect(f[0]![1]).toBe("msg2");
    expect(f[0]![3]).toBe("B_OK");
  });

  it("CU-20: a tool card opened before the cut finishes in its own segment, never a twin", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(tool("runA", "start", "t1"));
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    await h.feed(tool("runA", "result", "t1"), chat("runA", "final", "B_OK"));
    const cards = h.writer.calls.filter((c) => c[0] === "tool");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.every((c) => c[1] === "msg1")).toBe(true);
  });

  it("CU-20: a steered row of an input this bridge does not hold, or of another run, cuts nothing", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "x"));
    await h.rm.onUserRow({ sendId: "unknown", steerTargetRunId: "runA" });
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "otherRun" });
    expect(h.writer.calls.some((c) => c[0] === "split")).toBe(false);
  });

  it("CU-4: an input's custody run (bare final) opens no turn — even while the sink is free", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.feed(chat("ackB", "final"));
    await h.feed(chat("runA", "final", "A_OK"), lifecycle("runA", "end"));
    await h.tick(200_000);
    expect(starts(h.writer).map((c) => c[1])).toEqual(["runA"]);
    // The sink is free: a later run answering the input opens at once.
    await h.feed(lifecycle("uuid-1", "start"), chat("uuid-1", "final", "B_OK"));
    expect(starts(h.writer).map((c) => c[1])).toEqual(["runA", "uuid-1"]);
  });

  it("CU-9: a followup run answering a held input gets its OWN bubble, never folded into A's", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.feed(chat("ackB", "final"));
    await h.feed(chat("runA", "delta", "A_OK"), chat("runA", "final", "A_OK"));
    // The gateway drains its followup queue right after A — inside the legacy 10 s
    // follow-on window that used to fold the run into A's bubble.
    await h.feed(lifecycle("runA", "end"), lifecycle("uuid-1", "start"));
    await h.feed(chat("uuid-1", "delta", "B_OK"), chat("uuid-1", "final", "B_OK"));
    const f = finals(h.writer);
    expect(f.map((c) => c[3])).toEqual(["A_OK", "B_OK"]);
    expect(f[0]![1]).not.toBe(f[1]![1]);
  });

  it("CU-9: while A still streams, the other run waits and opens after A settles", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.feed(chat("runA", "delta", "A_"));
    await h.feed(lifecycle("uuid-1", "start"), chat("uuid-1", "final", "B_OK"));
    expect(starts(h.writer)).toHaveLength(1);
    await h.feed(chat("runA", "final", "A_OK"));
    const f = finals(h.writer);
    expect(f.map((c) => c[3])).toEqual(["A_OK", "B_OK"]);
  });

  it("a dropped input (cancelled / absent) stops the adoption of strangers", async () => {
    const h = harness(true);
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    expect(h.rm.outstandingInputs).toEqual(["sendB"]);
    h.rm.noteInputDropped("sendB");
    expect(h.rm.outstandingInputs).toEqual([]);
    await h.feed(lifecycle("stranger", "start"), chat("stranger", "final", "hello"));
    expect(starts(h.writer)).toHaveLength(0);
  });

  it("CU-8: a DISTINCT late final of the settled run joins its bubble; a repeat does not", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runB", { expectedSessionId: null });
    await h.feed(chat("runB", "final", "widget done"));
    const fallback = "The tool run finished, but no final summary was produced.";
    await h.feed(chat("runB", "final", fallback), chat("runB", "final", fallback));
    await h.feed(chat("runB", "final", "widget done"));
    const late = h.writer.calls.filter((c) => c[0] === "late");
    expect(late).toEqual([["late", "runB", "msg1", fallback]]);
  });

  it("CU-21: a projected turn with nothing visible asks Convex to drop its bubble — no empty verdict", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "final", "NO_REPLY"));
    await h.tick(200_000);
    const f = finals(h.writer);
    expect(f).toHaveLength(1);
    expect(f[0]![2]).toBe("complete");
    expect(f[0]![4]).toMatchObject({ dropIfEmpty: true });
  });

  it("interrupt: the foreground turn settles as stopped when the interrupting send's turn begins", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "partial"));
    await h.rm.beginTurn(h.now(), "runB", { expectedSessionId: null, interruptActive: true });
    const f = finals(h.writer);
    expect(f).toHaveLength(1);
    expect(f[0]![1]).toBe("msg1");
    expect(f[0]![2]).toBe("aborted");
  });

  it("CU-22: a resumed turn writes into the bubble Convex still shows streaming", async () => {
    const h = harness(true);
    await h.rm.resumeTurn(h.now(), "bubbleA", "runA");
    await h.feed(chat("runA", "final", "A_OK"));
    expect(starts(h.writer)).toHaveLength(0);
    const f = finals(h.writer);
    expect(f).toEqual([["finalize", "bubbleA", "complete", "A_OK", expect.anything()]]);
  });

  it("a run live before the input (none here) is never its answer: A's final leaves B waiting for B's run", async () => {
    const h = harness(true);
    // The gateway runs A (no turn here); B is accepted as a followup behind it.
    h.rm.noteHeldInput("sendB", "ackB", "userB", ["runA"]);
    await h.feed(chat("ackB", "final"));
    await h.feed(chat("runA", "delta", "A_OLD"), chat("runA", "final", "A_OLD"), lifecycle("runA", "end"));
    // A is not B's answer: no bubble for it on B's behalf, and B still waits.
    expect(starts(h.writer)).toHaveLength(0);
    expect(h.rm.outstandingInputs).toEqual(["sendB"]);
    // B's own run (it starts after B was accepted) opens B's bubble.
    await h.feed(lifecycle("runB", "start"), chat("runB", "delta", "B_OK"), chat("runB", "final", "B_OK"));
    expect(starts(h.writer).map((c) => c[1])).toEqual(["runB"]);
    expect(finals(h.writer).map((c) => c[3])).toEqual(["B_OK"]);
    expect(h.rm.outstandingInputs).toEqual([]);
  });

  it("a steer into a run live before the input: the transcript's steer target answers it, in its own bubble", async () => {
    const h = harness(true);
    h.rm.noteHeldInput("sendB", "ackB", "userB", ["runA"]);
    await h.feed(chat("runA", "delta", "working"));
    expect(starts(h.writer)).toHaveLength(0);
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "delta", "working\n\nB_OK"), chat("runA", "final", "working\n\nB_OK"));
    expect(starts(h.writer).map((c) => c[1])).toEqual(["runA"]);
    expect(finals(h.writer)).toHaveLength(1);
    expect(finals(h.writer)[0]![3]).toContain("B_OK");
  });
});

describe("projection on — successive steers and late finals (codex pass 1)", () => {
  it("three steers: each segment carries only its own text (the buffer's separators kept)", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "First."));
    h.rm.noteHeldInput("s1", "ack1", "u1");
    await h.rm.onUserRow({ sendId: "s1", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "delta", "First.\n\nSecond."));
    h.rm.noteHeldInput("s2", "ack2", "u2");
    await h.rm.onUserRow({ sendId: "s2", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "delta", "First.\n\nSecond.\n\nThird."));
    h.rm.noteHeldInput("s3", "ack3", "u3");
    await h.rm.onUserRow({ sendId: "s3", steerTargetRunId: "runA" });
    const full = "First.\n\nSecond.\n\nThird.\n\nFourth.";
    await h.feed(chat("runA", "delta", full), chat("runA", "final", full));
    const splits = h.writer.calls.filter((c) => c[0] === "split").map((c) => c[1]);
    expect(splits).toEqual(["msg1", "msg2", "msg3"]);
    // What each segment was written with (last text write per bubble).
    const lastText = new Map<string, string>();
    for (const c of h.writer.calls) {
      if (c[0] === "setSnapshot") lastText.set(c[1], c[2]);
      if (c[0] === "appendDelta") lastText.set(c[1], (lastText.get(c[1]) ?? "") + c[2]);
      if (c[0] === "finalize") lastText.set(c[1], c[3]);
    }
    expect(lastText.get("msg2")).toBe("Second.");
    expect(lastText.get("msg3")).toBe("Third.");
    expect(lastText.get("msg4")).toBe("Fourth.");
  });

  it("a tool open across two cuts finishes in the segment it was opened in", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "x"), tool("runA", "start", "t1"));
    h.rm.noteHeldInput("s1", "ack1", "u1");
    await h.rm.onUserRow({ sendId: "s1", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "delta", "x\n\ny"));
    h.rm.noteHeldInput("s2", "ack2", "u2");
    await h.rm.onUserRow({ sendId: "s2", steerTargetRunId: "runA" });
    await h.feed(tool("runA", "result", "t1"), chat("runA", "final", "x\n\ny\n\nz"));
    const cards = h.writer.calls.filter((c) => c[0] === "tool");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.every((c) => c[1] === "msg1")).toBe(true);
  });

  it("CU-8: a late cumulative final that repeats the reply AND adds to it joins with the addition only", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runB", { expectedSessionId: null });
    await h.feed(chat("runB", "final", "Widget done."));
    await h.feed(chat("runB", "final", "Widget done.\n\nAlso: the file is saved."));
    // Exact repeats (of the first or the enriched final) add nothing more.
    await h.feed(chat("runB", "final", "Widget done."));
    await h.feed(chat("runB", "final", "Widget done.\n\nAlso: the file is saved."));
    const late = h.writer.calls.filter((c) => c[0] === "late");
    expect(late).toEqual([["late", "runB", "msg1", "Also: the file is saved."]]);
  });
});

describe("codex pass 2 — a bridge restart", () => {
  it("P1: the inputs held while the resumed bubble streamed are known again — B's run gets B's bubble", async () => {
    const h = harness(true);
    await h.rm.resumeTurn(h.now(), "bubbleA", "runA");
    h.rm.rehydrateHeldInputs([{ sendId: "sendB", messageId: "userB" }]);
    await h.feed(chat("runA", "final", "A_OK"), lifecycle("runA", "end"));
    await h.feed(lifecycle("runB", "start"), chat("runB", "final", "B_OK"));
    expect(starts(h.writer).map((c) => c[1])).toEqual(["runB"]);
    expect(finals(h.writer).map((c) => [c[1], c[3]])).toEqual([
      ["bubbleA", "A_OK"],
      ["msg1", "B_OK"],
    ]);
  });
});

describe("codex pass 4 — a restored input keeps its custody run (P1)", () => {
  it("resume A, restore B, B's bare custody final, A ends: B's real answer still gets B's bubble", async () => {
    const h = harness(true);
    await h.rm.resumeTurn(h.now(), "bubbleA", "runA");
    h.rm.rehydrateHeldInputs([{ sendId: "sendB", messageId: "userB" }]);
    // The custody run of B (the send identity, the gateway's client run id) ends bare.
    await h.feed(chat("sendB", "final"));
    await h.feed(chat("runA", "final", "A_OK"), lifecycle("runA", "end"));
    await h.tick(200_000);
    await h.feed(lifecycle("uuid-1", "start"), chat("uuid-1", "final", "B_OK"));
    expect(starts(h.writer).map((c) => c[1])).toEqual(["uuid-1"]);
    expect(finals(h.writer).map((c) => [c[1], c[3]])).toEqual([
      ["bubbleA", "A_OK"],
      ["msg1", "B_OK"],
    ]);
  });
});

describe("codex pass 4 — a run is recorded settled before the next turn opens (P2)", () => {
  it("A finalizes, the stashed run B opens in the same feed: A's distinct late final still joins A's bubble", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.feed(chat("runA", "delta", "A_"));
    // B's run starts while A streams: stashed, and opened by the very feed that ends A.
    await h.feed(lifecycle("uuid-1", "start"), chat("uuid-1", "delta", "B_"));
    await h.feed(chat("runA", "final", "A_OK"));
    expect(starts(h.writer).map((c) => c[1])).toEqual(["runA", "uuid-1"]);
    // OpenClaw 2026.9.8 adds a distinct final to a run after its first terminal.
    await h.feed(chat("runA", "final", "The tool run finished."));
    expect(h.writer.calls.filter((c) => c[0] === "late")).toEqual([
      ["late", "runA", "msg1", "The tool run finished."],
    ]);
  });
});

describe("codex pass 5 — the cut settles the segment with its whole text (P1)", () => {
  it("the segment's text rides the cut; the cumulative final leaves only the rest to segment 2", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    // Whatever became of this stream write (failed, or committed with its answer lost),
    // the cut must settle segment 1 with "Before." — not with what Convex streamed.
    await h.feed(chat("runA", "delta", "Before."));
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    expect(h.writer.splitTexts).toEqual(["Before."]);
    await h.feed(chat("runA", "final", "Before.\n\nAfter."));
    const f = finals(h.writer);
    expect(f.map((c) => [c[1], c[3]])).toEqual([["msg2", "After."]]);
  });
});

describe("codex pass 2 — cut runs, restarts and late finals", () => {
  const textOf = (w: FakeWriter, id: string): string | undefined => {
    let t: string | undefined;
    for (const c of w.calls) {
      if (c[0] === "setSnapshot" && c[1] === id) t = c[2];
      if (c[0] === "appendDelta" && c[1] === id) t = (t ?? "") + c[2];
      if (c[0] === "finalize" && c[1] === id) t = c[3];
    }
    return t;
  };

  it("P2: a resumed LATER segment strips the earlier segments from the run's buffer", async () => {
    const h = harness(true);
    await h.rm.resumeTurn(h.now(), "seg2", "runA", "First.");
    await h.feed(chat("runA", "delta", "First.\n\nSecond"), chat("runA", "final", "First.\n\nSecond."));
    expect(textOf(h.writer, "seg2")).toBe("Second.");
  });

  it("P2: the stored segments' separators may differ from the buffer's — still stripped", async () => {
    const h = harness(true);
    await h.rm.resumeTurn(h.now(), "seg3", "runA", "First.\n\nSecond.");
    await h.feed(chat("runA", "final", "First.\nSecond.\n\nThird."));
    expect(textOf(h.writer, "seg3")).toBe("Third.");
  });

  it("prefixEndIgnoringSpace: whitespace runs compare equal, anything else does not", () => {
    expect(prefixEndIgnoringSpace("a  b\n\nc", "a b")).toBe(4);
    expect(prefixEndIgnoringSpace("a b c", "a b c ")).toBe(5);
    expect(prefixEndIgnoringSpace("ab c", "a b")).toBeNull();
    expect(prefixEndIgnoringSpace("a", "a b")).toBeNull();
  });

  it("P2: a late cumulative final of a cut run is compared with ALL its segments", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "First."));
    h.rm.noteHeldInput("s1", "ack1", "u1");
    await h.rm.onUserRow({ sendId: "s1", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "final", "First.\n\nSecond."));
    await h.feed(chat("runA", "final", "First.\n\nSecond."));
    await h.feed(chat("runA", "final", "First.\n\nSecond.\n\nExtra."));
    expect(h.writer.calls.filter((c) => c[0] === "late")).toEqual([["late", "runA", "msg2", "Extra."]]);
  });

  it("P2: a late final of A after B settled still joins A's bubble", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "final", "A."));
    await h.rm.beginTurn(h.now(), "runB", { expectedSessionId: null });
    await h.feed(chat("runB", "final", "B."));
    await h.feed(chat("runA", "final", "A2 fallback."));
    expect(h.writer.calls.filter((c) => c[0] === "late")).toEqual([["late", "runA", "msg1", "A2 fallback."]]);
  });

  it("P2: a cut that fails before Convex has it re-arms the input; the next delivery cuts", async () => {
    const h = harness(true);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "delta", "x"));
    h.rm.noteHeldInput("s1", "ack1", "u1");
    h.writer.failSplits = 1;
    await h.rm.onUserRow({ sendId: "s1", steerTargetRunId: "runA" });
    expect(h.rm.outstandingInputs).toEqual(["s1"]);
    await h.rm.onUserRow({ sendId: "s1", steerTargetRunId: "runA" });
    expect(h.writer.calls.filter((c) => c[0] === "split")).toEqual([["split", "msg1", "u1"]]);
  });
});

describe("projection OFF — the legacy pipeline, unchanged", () => {
  it("no split, no adoption, no late-final join, no drop flag", async () => {
    const h = harness(false);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    h.rm.noteHeldInput("sendB", "ackB", "userB");
    await h.rm.onUserRow({ sendId: "sendB", steerTargetRunId: "runA" });
    await h.feed(chat("runA", "final", "A_OK"));
    await h.feed(chat("runA", "final", "something else entirely"));
    expect(h.writer.calls.some((c) => c[0] === "split" || c[0] === "late")).toBe(false);
    expect(h.rm.outstandingInputs).toEqual([]);
    for (const f of finals(h.writer)) expect(f[4]).not.toHaveProperty("dropIfEmpty");
  });

  it("a run answering nothing is still the legacy empty-response verdict", async () => {
    const h = harness(false);
    await h.rm.beginTurn(h.now(), "runA", { expectedSessionId: null });
    await h.feed(chat("runA", "final", "NO_REPLY"));
    await h.tick(200_000);
    const f = finals(h.writer);
    expect(f).toHaveLength(1);
    expect(f[0]![2]).toBe("error");
  });
});
