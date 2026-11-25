// ONE RUN, TWO NAMES (OpenClaw 2026.10.33). A message sent while a run works is queued;
// when the gateway executes it, it links the EXECUTION run to the input's CLIENT run
// (src/gateway/server-methods/chat-send-turn-adoption.ts:289-302) and broadcasts the
// live stream, the `lifecycle end` and the `chat final` under the client run, while the
// transcript rows keep the execution run. Atrium opened one bubble per name. The run
// manager now holds ONE name — the transcript's — for such a run (`canonicalFrame`).
//
// Deterministic: the sequence captured on the bench (fixtures/
// queued-followup-linked-run-2026.10.33.jsonl) replayed in its real order through the
// real RunManager, Normalizer and TurnSink, a recording writer; then the variants the
// capture did not exercise, each compared with the same run under a single name — the
// shape every version through 2026.9.36 sends, which is the reference by construction.
//
// TO PROVE ON THE BENCH (pinned here from the sources, not from a capture): a queued
// run with tools, an error or abort terminal under the client run, a first frame that
// already carries the client run, `collect` mode, and a Stop during a linked run.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ConvexIngestError, HttpConvexWriter, type ConvexWriter } from "../src/convex-writer.js";
import { LiveTextBaselines } from "../src/providers/openclaw/live-text-baseline.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { sessionsChangedRunLink } from "../src/providers/openclaw/transcript-rows.js";
import { parseLiveBubble } from "../src/server.js";
import { loadCorpus } from "./helpers/golden-corpus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = "agent:alice:atrium:chat:u-bench:c1";
/** The execution run: the transcript's name. */
const X = "11111111-2222-4333-8444-555555555555";
/** The client run: the `chat.send` idempotency key, the ACK's run id. */
const C = `webchat-${"c".repeat(64)}`;
const ANNOUNCE =
  "announce:v1:agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000001:aaaaaaaa-0000-4000-8000-000000000002";

type Entry = { n: number; conn: "chat" | "events"; receivedAt: number; frame: Frame };
type Frame = { type: string; event: string; payload: Record<string, unknown> };

const CAPTURE: Entry[] = readFileSync(
  join(HERE, "fixtures", "queued-followup-linked-run-2026.10.33.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as Entry);

type Call = { op: string; args: unknown[] };

/** Records every write. `rowBubble`: the bubble Convex made from the transcript rows of
 *  a run that opened none here (`findProjectedBubble`). */
function recordingWriter(rowBubble: string | null = null) {
  const calls: Call[] = [];
  let opened = 0;
  const rec = (op: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ op, args });
      if (op === "startAssistant") return `m${++opened}`;
      if (op === "findProjectedBubble") return rowBubble;
      if (op === "splitSegment") return `${String(args[0])}+`;
      return op === "addMedia" || op === "setSnapshot" || op === "linkRunBubble" ? true : undefined;
    });
  const writer = {
    startAssistant: rec("startAssistant"),
    appendDelta: rec("appendDelta"),
    setSnapshot: rec("setSnapshot"),
    finalize: rec("finalize"),
    finalizeClosedRun: rec("finalizeClosedRun"),
    findProjectedBubble: rec("findProjectedBubble"),
    linkRunBubble: rec("linkRunBubble"),
    splitSegment: rec("splitSegment"),
    addToolPart: rec("addToolPart"),
    addProvenancePart: rec("addProvenancePart"),
    addCompactionPart: rec("addCompactionPart"),
    addMedia: rec("addMedia"),
    noteMediaUndelivered: rec("noteMediaUndelivered"),
    recordGatewayPressure: rec("recordGatewayPressure"),
  };
  return { writer: writer as unknown as ConvexWriter, calls };
}

const opens = (calls: Call[]) => calls.filter((c) => c.op === "startAssistant").map((c) => c.args[1]);
const on = (calls: Call[], op: string, messageId: string) =>
  calls.filter((c) => c.op === op && c.args[0] === messageId);
/** What a bubble finally shows: its terminal, whichever write carried it. */
const terminals = (calls: Call[]) =>
  calls
    .filter((c) => c.op === "finalize" || c.op === "finalizeClosedRun")
    .map((c) =>
      c.op === "finalize"
        ? {
            op: c.op,
            messageId: c.args[0],
            status: c.args[1],
            text: c.args[2],
            cause: (c.args[5] as { finalizeCause?: string } | undefined)?.finalizeCause,
          }
        : { op: c.op, messageId: c.args[0], runId: c.args[1], status: c.args[2], cause: c.args[5] },
    );

/** A session as the send path leaves it: the input is held by the gateway, its custody
 *  run is the send identity (server.ts `sendHeldInput`), the announce run predates it. */
function heldSession(rowBubble: string | null = null) {
  const { writer, calls } = recordingWriter(rowBubble);
  const rm = new RunManager("chat1", KEY, writer);
  rm.noteHeldInput(C, C, "userMsg", [ANNOUNCE]);
  return { rm, calls };
}

const clock = (e: Entry) => 1000 + (e.receivedAt - CAPTURE[0]!.receivedAt) / 1000;

/**
 * Replay the capture. A `chat` frame goes to the run manager; a `sessions.changed`
 * goes where the session wires it (the stated run link — dropped here when
 * `sessionEvents` is false, as the gateway may drop it: `dropIfSlow`); the transcript's
 * settle of the execution run happens `settleAfter` (the capture: after frame 211, when
 * the `chat.history` reply 212 brings the row).
 */
async function replay(
  rm: RunManager,
  opts: { sessionEvents?: boolean; settleAfter?: number | null; from?: number; rename?: (f: Frame) => Frame } = {},
) {
  const { sessionEvents = true, settleAfter = 211, from = 0, rename } = opts;
  let now = 1000;
  // The capture is the raw wire: the connection restores append-only live text before
  // the session sees a frame (live-text-baseline.ts), under the name the frame carries.
  const baselines = new LiveTextBaselines();
  for (const e of CAPTURE) {
    if (e.n < from) continue;
    now = clock(e);
    if (e.conn === "chat") {
      const wire = rename === undefined ? e.frame : rename(e.frame);
      await rm.feed(baselines.project(wire as unknown as GatewayFrame).frame, now);
    } else if (sessionEvents && e.frame.event === "sessions.changed") {
      const link = sessionsChangedRunLink(e.frame.payload);
      if (link !== null) rm.noteRunLink(link.runId, link.clientRunId, now);
    }
    if (e.n === settleAfter) await rm.settleFromTranscript([X], now);
  }
  await rm.lanesIdle();
  await rm.tick(now + 1);
  await rm.completionsIdle();
  await rm.lanesIdle();
  return now;
}

/** The capture as every version through 2026.9.36 would have sent it: one name. */
const underExecutionRun = (f: Frame): Frame =>
  f.payload.runId === C ? { ...f, payload: { ...f.payload, runId: X } } : f;

describe("the captured 2026.10.33 sequence — a queued input executed under two names", () => {
  it("the capture is the defect's: frames 189-192 under the execution run, the rest under the client run", () => {
    const runs = CAPTURE.filter((e) => e.conn === "chat" && e.n >= 189).map((e) => [e.n, e.frame.payload.runId]);
    expect(runs.filter(([, r]) => r === X).map(([n]) => n)).toEqual([189, 190, 191, 192]);
    expect(runs.filter(([, r]) => r === C).length).toBe(runs.length - 4);
    const end = CAPTURE.find((e) => e.n === 209)!.frame.payload;
    expect(end.runId).toBe(C);
    expect((end.data as { terminalReceipt: { runId: string } }).terminalReceipt.runId).toBe(X);
    expect(sessionsChangedRunLink(CAPTURE.find((e) => e.n === 199)!.frame.payload)).toEqual({
      runId: X,
      clientRunId: C,
    });
  });

  for (const sessionEvents of [true, false]) {
    it(`ONE bubble, under the transcript's run, settled (${sessionEvents ? "with" : "WITHOUT"} the session events)`, async () => {
      const { rm, calls } = heldSession();
      await replay(rm, { sessionEvents });
      // The announce's bubble, then ONE for the queued input — never one per name.
      expect(opens(calls)).toEqual([ANNOUNCE, X]);
      expect(calls.some((c) => c.args.includes(C))).toBe(false);
      // What the run stated before the link reaches the bubble the stream opened.
      expect(on(calls, "addProvenancePart", "m2")).toHaveLength(2);
      // Settled, in the captured order: the row arrives (frame 212) before the `chat
      // final` (213), so the transcript closes the turn — Convex settled the bubble from
      // the row in the same mutation, and the text retired by frame 207 is the row's —
      // then the live terminal joins the SAME bubble under the SAME run.
      expect(terminals(calls).filter((t) => t.messageId === "m2")).toEqual([
        { op: "finalize", messageId: "m2", status: "complete", text: "", cause: "transcript_settled" },
        { op: "finalizeClosedRun", messageId: "m2", runId: X, status: "complete", cause: "gateway_final" },
      ]);
      expect(rm.turnActive).toBe(false);
      expect(rm.outstandingInputs).toEqual([]);
    });
  }

  it("writes exactly what the same run writes under a single name (the shape through 2026.9.36)", async () => {
    const linked = heldSession();
    await replay(linked.rm, { sessionEvents: false });
    const single = heldSession();
    await replay(single.rm, { sessionEvents: false, rename: underExecutionRun });
    expect(linked.calls).toEqual(single.calls);
  });

  it("the live terminal FIRST, the row after: the `chat final` closes the bubble with the reply, the settle finds the turn over", async () => {
    const { rm, calls } = heldSession();
    const now = await replay(rm, { sessionEvents: false, settleAfter: null });
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
    expect(terminals(calls).filter((t) => t.messageId === "m2")).toEqual([
      { op: "finalize", messageId: "m2", status: "complete", text: "HOLD_USER_OK", cause: "gateway_final" },
    ]);
    expect(await rm.settleFromTranscript([X], now + 2)).toBe(false);
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
  });

  it("the transcript settles the run BEFORE the stream showed anything: the rows' bubble takes the live terminal", async () => {
    // The row first: Convex made the bubble from the rows and proved the run over
    // while the turn here had shown nothing (frames 189-192 are statuses and sources).
    const { rm, calls } = heldSession("rowBubble");
    await replay(rm, { sessionEvents: false, settleAfter: 192 });
    expect(opens(calls)).toEqual([ANNOUNCE]);
    expect(terminals(calls).filter((t) => t.messageId !== "m1")).toEqual([
      { op: "finalizeClosedRun", messageId: "rowBubble", runId: X, status: "complete", cause: "gateway_final" },
    ]);
    expect(rm.turnActive).toBe(false);
  });

  it("the transcript settles the run MID-STREAM: the open bubble is closed by it, the live terminal joins it", async () => {
    const { rm, calls } = heldSession();
    await replay(rm, { sessionEvents: false, settleAfter: 203 });
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
    expect(terminals(calls).filter((t) => t.messageId === "m2")).toEqual([
      { op: "finalize", messageId: "m2", status: "complete", text: "HOLD_USER_OK", cause: "transcript_settled" },
      { op: "finalizeClosedRun", messageId: "m2", runId: X, status: "complete", cause: "gateway_final" },
    ]);
  });

  it("the link stated FIRST (a `sessions.changed` ahead of every frame of the run) gives the same bubble", async () => {
    const { rm, calls } = heldSession();
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await replay(rm, { sessionEvents: false });
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
    expect(terminals(calls).filter((t) => t.messageId === "m2").map((t) => t.cause)).toEqual([
      "transcript_settled",
      "gateway_final",
    ]);
  });

  it("both names WAIT behind the announce turn (the sink busy): flushed in order, still one bubble, each frame read once", async () => {
    // The announce's `chat final` (frame 184) held back until the whole queued run has
    // arrived: its frames wait in the stash under the name they came with, the client
    // run's before any run was adopted for the input.
    const { rm, calls } = heldSession();
    const observe = vi.spyOn(protocolDrift, "observe");
    const baselines = new LiveTextBaselines();
    const wire = CAPTURE.filter((e) => e.conn === "chat" && e.n !== 183 && e.n !== 184);
    const held = CAPTURE.filter((e) => e.n === 183 || e.n === 184);
    let now = 1000;
    for (const e of [...wire, ...held]) {
      await rm.feed(baselines.project(e.frame as unknown as GatewayFrame).frame, (now += 0.01));
    }
    await rm.tick(now + 1);
    await rm.lanesIdle();
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
    expect(calls.some((c) => c.args.includes(C))).toBe(false);
    expect(terminals(calls).filter((t) => t.messageId === "m2")).toEqual([
      { op: "finalize", messageId: "m2", status: "complete", text: "HOLD_USER_OK", cause: "gateway_final" },
    ]);
    // Renamed on its way out of the stash, a frame is still the frame observed at arrival.
    expect(observe).toHaveBeenCalledTimes(wire.length + held.length);
    observe.mockRestore();
  });

  it("a Stop names the run the gateway acts on: the client run, while the turn is the execution run's", async () => {
    const { rm } = heldSession();
    let seen: string | null = null;
    const baselines = new LiveTextBaselines();
    for (const e of CAPTURE) {
      if (e.conn !== "chat") continue;
      await rm.feed(baselines.project(e.frame as unknown as GatewayFrame).frame, clock(e));
      if (e.n === 201) seen = rm.foregroundRunId;
    }
    expect(seen).toBe(C);
    expect(rm.activeRunIds).toEqual([X]);
  });
});

describe("a bridge restart in the middle of the linked run", () => {
  it("resumed on the bubble, the link stated again: the rest of the stream lands on it, nothing opens", async () => {
    // The process is new: it knows neither the input nor the link. Convex shows the
    // bubble streaming under the execution run; the gateway still runs it (CU-22).
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    await rm.resumeTurn(1000, "bubbleX", X);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await replay(rm, { from: 204, sessionEvents: false, settleAfter: null });
    expect(opens(calls)).toEqual([]);
    expect(terminals(calls)).toEqual([
      { op: "finalize", messageId: "bubbleX", status: "complete", text: "HOLD_USER_OK", cause: "gateway_final" },
    ]);
  });

  it("resumed with NO link stated: the client run's frames open nothing, the transcript closes the bubble", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    await rm.resumeTurn(1000, "bubbleX", X);
    await replay(rm, { from: 204, sessionEvents: false, settleAfter: 211 });
    expect(opens(calls)).toEqual([]);
    expect(terminals(calls).map((t) => [t.messageId, t.cause])).toEqual([["bubbleX", "transcript_settled"]]);
    expect(rm.turnActive).toBe(false);
  });

  it("a client run names ONE execution: a second, different statement is refused, the same one holds", () => {
    const { rm } = heldSession();
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    expect(rm.noteRunLink("another-execution", C, 1001)).toBe(false);
    const frame = { type: "event", event: "chat", payload: { sessionKey: KEY, runId: C, state: "final" } };
    expect((rm.canonicalFrame(frame) as typeof frame).payload.runId).toBe(X);
    // The same frame is the same renamed object wherever it is asked again.
    expect(rm.canonicalFrame(frame)).toBe(rm.canonicalFrame(frame));
    expect(frame.payload.runId).toBe(C);
  });

  it("a link the session knows from neither side is not taken", () => {
    const { writer } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    expect(rm.noteRunLink("someone-elses-execution", "someone-elses-client-run", 1001)).toBe(false);
    const frame = { type: "event", event: "chat", payload: { sessionKey: KEY, runId: "someone-elses-client-run", state: "final" } };
    expect(rm.canonicalFrame(frame)).toBe(frame);
  });
});

// ── Variants the capture did not exercise, in the captured frame shapes ───────────────
const agent = (runId: string, stream: string, data: Record<string, unknown>, seq?: number): Frame => ({
  type: "event",
  event: "agent",
  payload: { sessionKey: KEY, runId, stream, data, ...(seq === undefined ? {} : { seq }) },
});
const chat = (runId: string, payload: Record<string, unknown>): Frame => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: KEY, runId, ...payload },
});
const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
/** What precedes the link, as captured (frames 189-190): the execution run's statuses. */
const beforeLink = [
  agent(X, "run_status", { phase: "preparing_workspace" }, 1),
  agent(X, "run_status", { phase: "preparing_context" }, 2),
];

/** Feed `tail` under the client run after the pre-link frames, and the same frames
 *  under the execution run alone: the two must write the same thing. */
async function linkedAndSingle(tail: (runId: string) => Frame[]) {
  const out: Call[][] = [];
  for (const name of [C, X]) {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "userMsg");
    let now = 1000;
    for (const f of [...beforeLink, ...tail(name)]) await rm.feed(f, (now += 0.1));
    await rm.tick(now + 0.1);
    await rm.lanesIdle();
    await rm.completionsIdle();
    expect(rm.activeRunIds).toEqual([X]);
    out.push(calls);
  }
  return { linked: out[0]!, single: out[1]! };
}

describe("the terminal under the client run is not a `final` (to prove on the bench)", () => {
  it("a `chat` error after text: the bubble of the execution run ends in error, once", async () => {
    const { linked, single } = await linkedAndSingle((r) => [
      agent(r, "lifecycle", { phase: "model", provider: "openai", model: "m" }, 4),
      chat(r, { seq: 5, state: "delta", deltaText: "Partial", message: said("Partial") }),
      agent(r, "lifecycle", { phase: "error", error: "provider exploded", endedAt: 1 }, 6),
      chat(r, { seq: 6, state: "error", errorMessage: "provider exploded" }),
    ]);
    expect(linked).toEqual(single);
    expect(opens(linked)).toEqual([X]);
    expect(terminals(linked).map((t) => [t.messageId, t.status])).toEqual([["m1", "error"]]);
  });

  it("a `chat` error with NOTHING shown — the only frames the client run carries say nothing", async () => {
    const { linked, single } = await linkedAndSingle((r) => [
      agent(r, "lifecycle", { phase: "error", error: "provider exploded", endedAt: 1 }, 4),
      chat(r, { seq: 4, state: "error", errorMessage: "provider exploded" }),
    ]);
    // Without the link these two frames were custody noise and the turn of the
    // execution run waited for a terminal that had already come.
    expect(linked).toEqual(single);
    expect(linked.some((c) => c.args.includes(C))).toBe(false);
  });

  it("a `chat` aborted after text: the bubble ends aborted, once", async () => {
    const { linked, single } = await linkedAndSingle((r) => [
      chat(r, { seq: 4, state: "delta", deltaText: "Partial", message: said("Partial") }),
      agent(r, "lifecycle", { phase: "end", aborted: true, stopReason: "rpc", endedAt: 1 }, 5),
      chat(r, { seq: 5, state: "aborted", stopReason: "rpc", message: said("Partial") }),
    ]);
    expect(linked).toEqual(single);
    expect(terminals(linked).map((t) => [t.messageId, t.status])).toEqual([["m1", "aborted"]]);
  });

  it("a silent run (a bare `chat final` under the client run): no bubble, the turn ends", async () => {
    const { linked, single } = await linkedAndSingle((r) => [
      agent(r, "lifecycle", { phase: "end", endedAt: 1 }, 4),
      chat(r, { seq: 4, state: "final" }),
    ]);
    expect(linked).toEqual(single);
    expect(opens(linked)).toEqual([]);
  });
});

describe("a queued run with tools (to prove on the bench)", () => {
  it("the tool cards and the text land on the one bubble, as under a single name", async () => {
    const { linked, single } = await linkedAndSingle((r) => [
      agent(r, "tool", { phase: "start", name: "exec", toolCallId: "t1" }, 4),
      agent(r, "tool", { phase: "result", name: "exec", toolCallId: "t1", result: "ok" }, 5),
      chat(r, { seq: 6, state: "delta", deltaText: "Done", message: said("Done") }),
      agent(r, "lifecycle", { phase: "end", endedAt: 1 }, 7),
      chat(r, { seq: 1, state: "final", message: said("Done") }),
    ]);
    expect(linked).toEqual(single);
    expect(opens(linked)).toEqual([X]);
    expect(on(linked, "addToolPart", "m1").length).toBeGreaterThan(0);
  });
});

describe("the stated link, for an input another run was taken to answer", () => {
  // An announce that STARTS after the input was accepted is taken as its answer by the
  // adoption rule (unchanged). The input's real execution then has no input left to
  // answer — only the gateway's statement makes it this session's.
  async function answeredByAnAnnounce() {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "user1");
    await rm.feed(agent(ANNOUNCE, "lifecycle", { phase: "start" }, 1), 1000);
    await rm.feed(chat(ANNOUNCE, { seq: 2, state: "final", message: said("Report") }), 1001);
    await rm.feed(agent(ANNOUNCE, "lifecycle", { phase: "end", endedAt: 1 }, 3), 1002);
    await rm.tick(1100);
    expect(rm.outstandingInputs).toEqual([]);
    return { rm, calls };
  }
  const reply = async (rm: RunManager) => {
    await rm.feed(chat(C, { seq: 8, state: "delta", deltaText: "Mine", message: said("Mine") }), 1101);
    await rm.feed(chat(C, { seq: 1, state: "final", message: said("Mine") }), 1102);
  };

  it("the execution run opens its bubble though no input is left waiting", async () => {
    const { rm, calls } = await answeredByAnAnnounce();
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await reply(rm);
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
    expect(terminals(calls).map((t) => [t.messageId, t.status])).toEqual([
      ["m1", "complete"],
      ["m2", "complete"],
    ]);
  });

  it("it consumes ITS input, not the oldest one still waiting", async () => {
    const C2 = `webchat-${"d".repeat(64)}`;
    const { rm, calls } = await answeredByAnAnnounce();
    rm.noteHeldInput(C2, C2, "user2", [ANNOUNCE]);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await reply(rm);
    expect(opens(calls)).toEqual([ANNOUNCE, X]);
    expect(rm.outstandingInputs).toEqual([C2]);
  });
});

describe("what does NOT establish a link", () => {
  it("through 2026.9.36: the client run's bare final at admission stays custody — no link, no rename", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "userMsg");
    const bare = chat(C, { seq: 1, state: "final" });
    // Before any run answers the input, the frame is returned AS IT IS (same object).
    expect(rm.canonicalFrame(bare)).toBe(bare);
    await rm.feed(bare, 1000);
    for (const [i, f] of [
      ...beforeLink,
      agent(X, "lifecycle", { phase: "start" }, 3),
      chat(X, { seq: 4, state: "delta", deltaText: "Hi", message: said("Hi") }),
      agent(X, "lifecycle", { phase: "end", endedAt: 1 }, 5),
      chat(X, { seq: 5, state: "final", message: said("Hi") }),
    ].entries()) {
      expect(rm.canonicalFrame(f)).toBe(f);
      await rm.feed(f, 1001 + i);
    }
    expect(opens(calls)).toEqual([X]);
    expect(rm.foregroundRunId).toBeNull();
    expect(terminals(calls).map((t) => [t.messageId, t.status])).toEqual([["m1", "complete"]]);
  });

  it("the 2026.9.36 capture of the SAME scenario, its input held as the send path holds it: not one frame is renamed", async () => {
    const fx = loadCorpus().find((f) => f.version === "2026.9.36" && f.header.scenario === "announce-reverse-hold")!;
    const [firstSend, heldSend] = fx.header.ackRunIds as [string, string];
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", fx.header.sessionKey, writer);
    const baselines = new LiveTextBaselines();
    rm.armReplayBuffer();
    let now = 1000;
    let renamed = 0;
    let held = false;
    for (const e of fx.entries) {
      const f = e.frame as { type?: string; payload?: { runId?: unknown; status?: unknown } };
      now += 0.01;
      if (f.type === "res" && f.payload?.status === "started") {
        if (f.payload.runId === firstSend) await rm.beginTurn(now, firstSend, { expectedSessionId: null });
        if (f.payload.runId === heldSend) {
          // server.ts `sendHeldInput`: custody run = the send identity, the ACK's run.
          rm.noteHeldInput(heldSend, heldSend, "userMsg");
          held = true;
        }
        continue;
      }
      const frame = baselines.project(e.frame as GatewayFrame).frame;
      if (rm.canonicalFrame(frame) !== frame) renamed++;
      await rm.feed(frame, now);
    }
    await rm.tick(now + 400);
    expect(held).toBe(true);
    expect(renamed).toBe(0);
    // The input's answer: ONE bubble, under the run that carried it — a stranger to
    // both sends and to the announce, as through 2026.9.36 — and none under the ack run.
    const answers = opens(calls).filter((r) => r !== firstSend && !String(r).startsWith("announce:"));
    expect(answers).toHaveLength(1);
    expect(answers[0]).not.toBe(heldSend);
    expect(rm.foregroundRunId).toBeNull();
  });

  it("an announce that starts after the input is never the input's execution", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "userMsg");
    await rm.feed(agent(ANNOUNCE, "lifecycle", { phase: "start" }, 1), 1000);
    await rm.feed(chat(ANNOUNCE, { seq: 2, state: "delta", deltaText: "Report", message: said("Report") }), 1001);
    // The input's own run speaks while the announce turn is open: it is NOT renamed.
    const own = chat(C, { seq: 2, state: "delta", deltaText: "Mine", message: said("Mine") });
    expect(rm.canonicalFrame(own)).toBe(own);
    await rm.feed(own, 1002);
    await rm.feed(chat(ANNOUNCE, { seq: 3, state: "final", message: said("Report") }), 1003);
    await rm.feed(chat(C, { seq: 3, state: "final", message: said("Mine") }), 1004);
    expect(opens(calls)).toEqual([ANNOUNCE, C]);
  });

  it("`sessions.changed` states a link only with BOTH names and only when they differ", () => {
    expect(sessionsChangedRunLink({ phase: "end", runId: X, clientRunId: C })).toEqual({ runId: X, clientRunId: C });
    // Through 2026.9.36, and for a run broadcast under its own name: no `clientRunId`.
    expect(sessionsChangedRunLink({ phase: "end", runId: X })).toBeNull();
    expect(sessionsChangedRunLink({ phase: "end", runId: X, clientRunId: X })).toBeNull();
    expect(sessionsChangedRunLink({ reason: "send", clientRunId: C })).toBeNull();
    expect(sessionsChangedRunLink({ runId: 7, clientRunId: {} })).toBeNull();
    expect(sessionsChangedRunLink(null)).toBeNull();
  });

  it("`collect`: one execution for two inputs links the OLDEST input's run only (to prove on the bench)", async () => {
    const C2 = `webchat-${"d".repeat(64)}`;
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "user1");
    rm.noteHeldInput(C2, C2, "user2");
    let now = 1000;
    for (const f of beforeLink) await rm.feed(f, (now += 1));
    const first = chat(C, { seq: 4, state: "delta", deltaText: "Both", message: said("Both") });
    const second = chat(C2, { seq: 1, state: "final" });
    expect(rm.canonicalFrame(first)).not.toBe(first);
    expect(rm.canonicalFrame(second)).toBe(second);
    await rm.feed(first, (now += 1));
    await rm.feed(second, (now += 1));
    await rm.feed(chat(C, { seq: 1, state: "final", message: said("Both") }), (now += 1));
    expect(opens(calls)).toEqual([X]);
    expect(rm.outstandingInputs).toEqual([C2]);
  });
});

// ── THE LINK STATED LATE ──────────────────────────────────────────────────────────────
// The statement (`sessions.changed`, session-events socket, `dropIfSlow`) and the stream
// (conversation socket) are not ordered with each other. Hand-built in the captured frame
// shapes: the capture has the four frames under the execution run first (to prove on the
// bench: a queued run whose first frame already carries the client run). What Convex does
// with the recorded link — one bubble, settled by the rows of the execution run — is
// convex/lateRunLink.test.ts.
describe("the link stated AFTER the client run opened its turn", () => {
  const links = (calls: Call[]) => calls.filter((c) => c.op === "linkRunBubble").map((c) => c.args);
  const delta = (seq: number, t: string) => chat(C, { seq, state: "delta", deltaText: t, message: said(t) });

  /** The client run speaks first: its bubble is open under it. */
  async function spokenFirst(rowBubble: string | null = null) {
    const { writer, calls } = recordingWriter(rowBubble);
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "userMsg");
    await rm.feed(delta(6, "Hi"), 1000);
    expect(opens(calls)).toEqual([C]);
    return { rm, calls, writer };
  }

  it("ONE bubble: Convex is told it shows the execution run, the transcript closes it, the live terminal joins it", async () => {
    const { rm, calls } = await spokenFirst();
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([["m1", C, X]]);
    // The turn keeps the name it was opened under: nothing is renamed at the door, and a
    // Stop names the run the gateway acts on.
    const next = delta(8, "Hi there");
    expect(rm.canonicalFrame(next)).toBe(next);
    await rm.feed(next, 1001);
    expect(rm.foregroundRunId).toBe(C);
    expect(rm.activeRunIds).toEqual([C]);
    // …while the transcript is asked about, and answers about, the execution run.
    expect(rm.activeTranscriptRunIds).toEqual([X]);
    expect(await rm.settleFromTranscript([X], 1002)).toBe(true);
    await rm.feed(chat(C, { seq: 1, state: "final", message: said("Hi there") }), 1003);
    await rm.lanesIdle();
    expect(opens(calls)).toEqual([C]);
    expect(terminals(calls)).toEqual([
      { op: "finalize", messageId: "m1", status: "complete", text: "Hi there", cause: "transcript_settled" },
      { op: "finalizeClosedRun", messageId: "m1", runId: C, status: "complete", cause: "gateway_final" },
    ]);
    expect(rm.turnActive).toBe(false);
    expect(links(calls)).toHaveLength(1);
  });

  it("a settle that names the execution run closes nothing without the statement (the fact that maps it)", async () => {
    const { rm } = await spokenFirst();
    expect(await rm.settleFromTranscript([X], 1002)).toBe(false);
    expect(rm.turnActive).toBe(true);
  });

  it("stated twice (`phase: model`, then `end`): one write; another execution for the same client run is refused", async () => {
    const { rm, calls } = await spokenFirst();
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    expect(rm.noteRunLink("another-execution", C, 1001)).toBe(false);
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([["m1", C, X]]);
  });

  it("stated once the turn is over (the `end` statement after the `chat final`): recorded on the bubble it left", async () => {
    const { rm, calls } = await spokenFirst();
    await rm.feed(chat(C, { seq: 1, state: "final", message: said("Hi") }), 1001);
    expect(rm.turnActive).toBe(false);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([["m1", C, X]]);
  });

  it("a bridge restarted between the first delta and the statement: resumed under the client run, the same path", async () => {
    // The new process knows neither the input nor any link; Convex shows the bubble
    // streaming under the client run, and the turn is resumed on it.
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    await rm.resumeTurn(1000, "bubbleC", C);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([["bubbleC", C, X]]);
    await rm.feed(delta(8, "Hi there"), 1001);
    expect(await rm.settleFromTranscript([X], 1002)).toBe(true);
    expect(opens(calls)).toEqual([]);
    expect(terminals(calls).map((t) => [t.messageId, t.cause])).toEqual([["bubbleC", "transcript_settled"]]);
  });

  it("stated while the turn has shown NOTHING yet: recorded when its bubble opens, before the next transcript post", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "userMsg");
    await rm.feed(delta(7, ""), 1000);
    expect(rm.activeRunIds).toEqual([C]);
    expect(opens(calls)).toEqual([]);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([]);
    await rm.feed(delta(8, "Hi"), 1001);
    expect(opens(calls)).toEqual([C]);
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([["m1", C, X]]);
  });

  it("…and when the rows settle the run before anything is shown: the rows' bubble, asked and written under the execution run", async () => {
    const { writer, calls } = recordingWriter("rowBubble");
    const rm = new RunManager("chat1", KEY, writer);
    rm.noteHeldInput(C, C, "userMsg");
    await rm.feed(delta(7, ""), 1000);
    expect(rm.activeRunIds).toEqual([C]);
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    expect(await rm.settleFromTranscript([X], 1001)).toBe(true);
    await rm.recordRunLinks();
    await rm.feed(chat(C, { seq: 1, state: "final", message: said("Hi") }), 1002);
    await rm.lanesIdle();
    expect(opens(calls)).toEqual([]);
    expect(links(calls)).toEqual([]);
    expect(calls.filter((c) => c.op === "findProjectedBubble").map((c) => c.args[2])).toEqual([X]);
    expect(terminals(calls)).toEqual([
      { op: "finalizeClosedRun", messageId: "rowBubble", runId: X, status: "complete", cause: "gateway_final" },
    ]);
  });

  it("a write that FAILED is asked again before the next transcript post; one Convex did not take is not", async () => {
    const failing = await spokenFirst();
    const link = failing.writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
    link.mockRejectedValueOnce(new Error("convex unreachable"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    // The statement asks at once (the write that fails)…
    expect(failing.rm.noteRunLink(X, C, 1001)).toBe(true);
    await failing.rm.lanesIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(link).toHaveBeenCalledTimes(1);
    // …the transcript reader asks again before it posts, once.
    await failing.rm.recordRunLinks();
    expect(link).toHaveBeenCalledTimes(2);
    await failing.rm.recordRunLinks();
    expect(link).toHaveBeenCalledTimes(2);
    expect(link.mock.calls).toEqual([
      ["m1", C, X],
      ["m1", C, X],
    ]);
    quiet.mockRestore();

    const refused = await spokenFirst();
    const second = refused.writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
    second.mockResolvedValueOnce(false);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(refused.rm.noteRunLink(X, C, 1001)).toBe(true);
    await refused.rm.recordRunLinks();
    await refused.rm.recordRunLinks();
    expect(second).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });

  it("the row recorded under the execution run is the client run's: an emptied stream keeps its text", async () => {
    // 2026.10.33 withdraws recorded text from the stream (retired-live-text.test.ts): the
    // row names the execution run, the stream the client run.
    const { rm, calls } = await spokenFirst();
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await rm.onAssistantRow({ runId: X, seq: 16 });
    await rm.feed(chat(C, { seq: 9, state: "delta", deltaText: "", replace: true, message: said("") }), 1001);
    await rm.feed(chat(C, { seq: 1, state: "final", message: said("Hi") }), 1002);
    expect(calls.filter((c) => c.op === "setSnapshot" && c.args[1] === "")).toEqual([]);
    expect(calls.filter((c) => c.op === "setSnapshot" && c.args[2] === true)).toEqual([]);
    expect(terminals(calls).map((t) => [t.messageId, t.status, t.text])).toEqual([["m1", "complete", "Hi"]]);
  });

  it("an execution run that already has a turn of its own is not joined to the client run's (two bubbles exist)", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", KEY, writer);
    await rm.beginTurn(1000, X);
    await rm.feed(chat(X, { seq: 2, state: "delta", deltaText: "A", message: said("A") }), 1000);
    await rm.feed(chat(X, { seq: 3, state: "final", message: said("A") }), 1001);
    rm.noteHeldInput(C, C, "userMsg");
    await rm.feed(delta(6, "Hi"), 1002);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(rm.noteRunLink(X, C, 1001)).toBe(false);
    warned.mockRestore();
    await rm.recordRunLinks();
    expect(links(calls)).toEqual([]);
  });

  // A message steered into the run: its transcript row names the run it was injected
  // into as the TRANSCRIPT knows it — the execution run — while the turn here is the
  // client run's.
  describe("a steer into the linked run", () => {
    const C2 = `webchat-${"d".repeat(64)}`;
    const splits = (calls: Call[]) => calls.filter((c) => c.op === "splitSegment").map((c) => c.args.slice(0, 2));

    for (const [name, target] of [["the execution run (the transcript's name)", X], ["the client run", C]] as const) {
      it(`its row names ${name}: the bubble is cut, the answer goes to a new segment`, async () => {
        const { rm, calls } = await spokenFirst();
        expect(rm.noteRunLink(X, C, 1001)).toBe(true);
        await rm.recordRunLinks();
        rm.noteHeldInput(C2, C2, "userMsg2", [C]);
        await rm.onUserRow({ sendId: C2, steerTargetRunId: target });
        expect(splits(calls)).toEqual([["m1", "userMsg2"]]);
        await rm.feed(delta(9, "Hi again"), 1002);
        // What the run writes next lands on the new segment, never on the cut bubble.
        expect(calls.filter((c) => c.op === "appendDelta" || c.op === "setSnapshot").at(-1)?.args[0]).toBe("m1+");
        expect(opens(calls)).toEqual([C]);
      });
    }

    it("the link stated AFTER the cut is recorded on the open segment (Convex links every segment of the run from it)", async () => {
      const { rm, calls } = await spokenFirst();
      rm.noteHeldInput(C2, C2, "userMsg2", [C]);
      await rm.onUserRow({ sendId: C2, steerTargetRunId: C });
      expect(splits(calls)).toEqual([["m1", "userMsg2"]]);
      expect(rm.noteRunLink(X, C, 1001)).toBe(true);
      await rm.recordRunLinks();
      expect(links(calls)).toEqual([["m1+", C, X]]);
    });

    it("an unlinked turn is not cut by a steer into another run (through 2026.9.36: unchanged)", async () => {
      const { rm, calls } = await spokenFirst();
      rm.noteHeldInput(C2, C2, "userMsg2", [C]);
      await rm.onUserRow({ sendId: C2, steerTargetRunId: X });
      expect(splits(calls)).toEqual([]);
    });
  });

  // The rows of the execution run must not reach Convex before the link: posted first,
  // they give birth to a bubble of their own, and the link is then refused for good.
  describe("the transcript post waits for the link (`runLinksRecorded`)", () => {
    const transient = () => new ConvexIngestError("linkRunBubble", 503, "Convex ingest linkRunBubble -> HTTP 503");

    it("a write that failed transiently holds the post back, and is asked again at the next one", async () => {
      const { rm, writer } = await spokenFirst();
      const link = writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
      // The statement asks at once (a network failure), then each post asks again.
      link.mockRejectedValueOnce(new Error("fetch failed")).mockRejectedValueOnce(transient()).mockRejectedValueOnce(new Error("fetch failed"));
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(rm.noteRunLink(X, C, 1001)).toBe(true);
      await expect(rm.runLinksRecorded()).rejects.toThrow(/run link/);
      await expect(rm.runLinksRecorded()).rejects.toThrow(/run link/);
      // Convex answers: recorded, the post goes on — and nothing is asked again.
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      expect(link.mock.calls).toEqual([["m1", C, X], ["m1", C, X], ["m1", C, X], ["m1", C, X]]);
      quiet.mockRestore();
    });

    it("a link Convex REFUSES releases the post at once (the rows then make the run's own bubble)", async () => {
      for (const refusal of [false, new ConvexIngestError("linkRunBubble", 400, "Convex ingest linkRunBubble -> HTTP 400: unknown op")]) {
        const { rm, writer } = await spokenFirst();
        const link = writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
        if (refusal === false) link.mockResolvedValueOnce(false);
        else link.mockRejectedValueOnce(refusal);
        const quiet = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
        expect(rm.noteRunLink(X, C, 1001)).toBe(true);
        await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
        await rm.runLinksRecorded();
        expect(link).toHaveBeenCalledTimes(1);
        quiet.forEach((q) => q.mockRestore());
      }
    });

    it("a Convex that keeps ANSWERING with an error is not waited on for ever: bounded, then the post goes on", async () => {
      const { rm, writer } = await spokenFirst();
      const link = writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
      link.mockRejectedValue(transient());
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(rm.noteRunLink(X, C, 1001)).toBe(true);
      let held = 0;
      for (let i = 0; i < 20; i++) {
        try {
          await rm.runLinksRecorded();
          break;
        } catch {
          held++;
        }
      }
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(10);
      const asked = link.mock.calls.length;
      await rm.runLinksRecorded();
      expect(link).toHaveBeenCalledTimes(asked);
      quiet.mockRestore();
    });

    it("an UNREACHABLE Convex never gives the link up: the rows could not be posted either", async () => {
      const { rm, writer } = await spokenFirst();
      const link = writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
      link.mockRejectedValue(new ConvexIngestError("linkRunBubble", null, "Convex ingest linkRunBubble timed out after 20000ms"));
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(rm.noteRunLink(X, C, 1001)).toBe(true);
      for (let i = 0; i < 30; i++) await expect(rm.runLinksRecorded()).rejects.toThrow(/run link/);
      link.mockResolvedValue(true);
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      quiet.mockRestore();
    });

    // A bridge RESTART: the run manager's memory is gone. Convex keeps what it recorded,
    // and hands it back with the bubble it asks the new process to resume.
    it("after a restart, a link Convex recorded comes back with the resumed bubble: the transcript's word reaches the turn", async () => {
      const { writer, calls } = recordingWriter();
      const rm = new RunManager("chat1", KEY, writer);
      await rm.resumeTurn(1000, "m1", C, undefined, X);
      expect(rm.activeTranscriptRunIds).toEqual([X]);
      expect(rm.sameRun(X, C)).toBe(true);
      // Asked once more before any row (the record that came back may be partial), once.
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      expect(links(calls)).toEqual([["m1", C, X]]);
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      expect(links(calls)).toHaveLength(1);
      expect(await rm.settleFromTranscript([X], 1001)).toBe(true);
    });

    // A process stopped between two PAGES of a link (a run cut into more segments than one
    // page holds): the resumed bubble carries the link, a later page does not. Rows posted
    // on the restored link alone would give the unlinked segment a second bubble.
    it("after a restart, the restored link holds the rows until Convex has confirmed it again", async () => {
      const { writer } = recordingWriter();
      const link = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue(true);
      (writer as { linkRunBubble?: unknown }).linkRunBubble = link;
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const rm = new RunManager("chat1", KEY, writer);
      await rm.resumeTurn(1000, "m1", C, undefined, X);
      await expect(rm.runLinksRecorded()).rejects.toThrow(/run link/);
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      expect(link).toHaveBeenLastCalledWith("m1", C, X);
      quiet.mockRestore();
    });

    it("the resumed bubble's `transcriptRunId` is read bounded, and never as the run's own name", () => {
      expect(parseLiveBubble({ messageId: "m1", runId: C, transcriptRunId: X })).toMatchObject({ transcriptRunId: X });
      for (const bad of [C, "", "x".repeat(257), 7]) {
        expect(parseLiveBubble({ messageId: "m1", runId: C, transcriptRunId: bad })).not.toHaveProperty("transcriptRunId");
      }
    });

    it("…without it (a bubble with no recorded link), the resumed turn is the client run's alone, as before", async () => {
      const { writer } = recordingWriter();
      const rm = new RunManager("chat1", KEY, writer);
      await rm.resumeTurn(1000, "m1", C);
      expect(rm.activeTranscriptRunIds).toEqual([C]);
      expect(await rm.settleFromTranscript([X], 1001)).toBe(false);
    });

    // A SOCKET closed (a reconnection): the registry replaces the chat's session, and the
    // new run manager knows nothing of its own. The links its predecessor still owed are
    // carried over (SessionRegistry `owedLateLinks`), and hold the rows back there too.
    it("a link still owed when the socket closes is carried to the next session: its rows wait, the write is asked again", async () => {
      const failing = await spokenFirst();
      const link = failing.writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
      link.mockRejectedValue(new Error("fetch failed"));
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(failing.rm.noteRunLink(X, C, 1001)).toBe(true);
      await expect(failing.rm.runLinksRecorded()).rejects.toThrow(/run link/);
      const owed = failing.rm.owedLateLinks();
      expect(owed).toEqual([{ clientRunId: C, executionRunId: X, messageId: "m1" }]);
      // The next session: no turn (the run is over), the same writer.
      const next = new RunManager("chat1", KEY, failing.writer);
      next.adoptOwedLateLinks(owed);
      await expect(next.runLinksRecorded()).rejects.toThrow(/run link/);
      link.mockResolvedValue(true);
      await expect(next.runLinksRecorded()).resolves.toBeUndefined();
      expect(link.mock.calls.at(-1)).toEqual(["m1", C, X]);
      expect(next.owedLateLinks()).toEqual([]);
      // The transcript's name of the run is the turn's here too, and a statement heard
      // again on this socket is the same late link — never an early one.
      expect(next.sameRun(X, C)).toBe(true);
      next.noteHeldInput(C, C, "userMsg");
      expect(next.noteRunLink(X, C, 1002)).toBe(true);
      expect(next.canonicalFrame(delta(9, "x"))).toEqual(delta(9, "x"));
      quiet.mockRestore();
    });

    // THE LIMIT (codex pass 3, finding 1), pinned as it is: a link whose write never landed
    // lives only in the process that observed it. The gateway does not state it again after
    // its `phase: "end"` statement, and no durable record of the gateway pairs the two names
    // (the session row keeps `lastRunId` = the client run, the rows the execution run, the
    // input receipts the user row): a restart in that window loses it, and the rows of the
    // execution run then make their own bubble — what a statement never received leaves.
    it("LIMIT: a link still OWED when the PROCESS restarts is lost with it — nothing holds the new process's posts", async () => {
      const failing = await spokenFirst();
      const link = failing.writer.linkRunBubble as unknown as ReturnType<typeof vi.fn>;
      link.mockRejectedValue(new Error("fetch failed"));
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(failing.rm.noteRunLink(X, C, 1001)).toBe(true);
      await expect(failing.rm.runLinksRecorded()).rejects.toThrow(/run link/);
      // The restart: Convex resumes the bubble, with no link to hand back.
      const { writer } = recordingWriter();
      const restarted = new RunManager("chat1", KEY, writer);
      await restarted.resumeTurn(1002, "m1", C);
      await expect(restarted.runLinksRecorded()).resolves.toBeUndefined();
      expect(restarted.activeTranscriptRunIds).toEqual([C]);
      quiet.mockRestore();
    });

    it("a link with no bubble to record it on yet holds nothing back", async () => {
      const { writer, calls } = recordingWriter();
      const rm = new RunManager("chat1", KEY, writer);
      rm.noteHeldInput(C, C, "userMsg");
      await rm.feed(delta(7, ""), 1000);
      expect(rm.noteRunLink(X, C, 1001)).toBe(true);
      await expect(rm.runLinksRecorded()).resolves.toBeUndefined();
      expect(links(calls)).toEqual([]);
    });
  });

  // An exec approval names the run that asked under its EXECUTION name (upstream
  // exec-approval.ts: `operationalRunInstance.runId`), while the turn here is the client
  // run's: the request read off its broadcast or a pending list must still hold it.
  it("an exec approval naming the execution run holds the turn opened under the client run", async () => {
    const { rm, writer, calls } = await spokenFirst();
    (writer as unknown as { setPhase: unknown }).setPhase = vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "setPhase", args });
    });
    expect(rm.noteRunLink(X, C, 1001)).toBe(true);
    await rm.recordRunLinks();
    await rm.noteApprovalRequested("appr-1", { kind: "exec", runId: X, toolCallId: "call-1", expiresInSec: 600 }, 1001);
    expect(calls.filter((c) => c.op === "setPhase").map((c) => c.args.slice(0, 2))).toContainEqual(["m1", "awaiting_approval"]);
  });

  // A reconnection's pending list can name the request BEFORE the statement arrives
  // (codex pass 3): the turn does not own the execution run yet, so nothing holds it then.
  // The request is kept under its own name and holds the turn once the link makes the
  // run the turn's.
  it("an exec approval noted BEFORE the late link holds the turn once the link is stated", async () => {
    const { rm, writer, calls } = await spokenFirst();
    (writer as unknown as { setPhase: unknown }).setPhase = vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "setPhase", args });
    });
    const phases = () => calls.filter((c) => c.op === "setPhase").map((c) => c.args.slice(0, 2));
    await rm.noteApprovalRequested("appr-1", { kind: "exec", runId: X, toolCallId: "call-1", expiresInSec: 600 }, 1001);
    expect(phases()).not.toContainEqual(["m1", "awaiting_approval"]);
    expect(rm.noteRunLink(X, C, 1002)).toBe(true);
    await rm.lanesIdle();
    expect(phases()).toContainEqual(["m1", "awaiting_approval"]);
  });

  it("…not once it was settled, and not for a request of another run", async () => {
    const { rm, writer, calls } = await spokenFirst();
    (writer as unknown as { setPhase: unknown }).setPhase = vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "setPhase", args });
    });
    await rm.noteApprovalRequested("appr-1", { kind: "exec", runId: X, toolCallId: "call-1", expiresInSec: 600 }, 1001);
    await rm.noteApprovalSettled("appr-1", 1001.5);
    await rm.noteApprovalRequested("appr-2", { kind: "exec", runId: "another-run", toolCallId: "call-2", expiresInSec: 600 }, 1001);
    expect(rm.noteRunLink(X, C, 1002)).toBe(true);
    await rm.lanesIdle();
    expect(calls.filter((c) => c.op === "setPhase").map((c) => c.args.slice(0, 2))).not.toContainEqual(["m1", "awaiting_approval"]);
  });

  it("a request kept with NO turn (the reconnection's list) holds the turn resumed under the client run once linked", async () => {
    const { writer, calls } = recordingWriter();
    (writer as unknown as { setPhase: unknown }).setPhase = vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "setPhase", args });
    });
    const rm = new RunManager("chat1", KEY, writer);
    await rm.noteApprovalRequested("appr-1", { kind: "exec", runId: X, toolCallId: "call-1", expiresInSec: 600 }, 1000);
    await rm.resumeTurn(1001, "m-resumed", C);
    const phases = () => calls.filter((c) => c.op === "setPhase").map((c) => c.args.slice(0, 2));
    expect(phases()).not.toContainEqual(["m-resumed", "awaiting_approval"]);
    expect(rm.noteRunLink(X, C, 1002)).toBe(true);
    await rm.lanesIdle();
    expect(phases()).toContainEqual(["m-resumed", "awaiting_approval"]);
  });

  it("…and one naming ANOTHER run does not (unchanged without a link)", async () => {
    const { rm, writer, calls } = await spokenFirst();
    (writer as unknown as { setPhase: unknown }).setPhase = vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "setPhase", args });
    });
    await rm.noteApprovalRequested("appr-1", { kind: "exec", runId: X, toolCallId: "call-1", expiresInSec: 600 }, 1001);
    expect(calls.filter((c) => c.op === "setPhase").map((c) => c.args.slice(0, 2))).not.toContainEqual(["m1", "awaiting_approval"]);
  });

  it("the two names are ONE run to whoever asks (`sameRun`), linked early or late; strangers are not", async () => {
    const late = await spokenFirst();
    expect(late.rm.sameRun(X, C)).toBe(false);
    late.rm.noteRunLink(X, C, 1001);
    expect(late.rm.sameRun(X, C)).toBe(true);
    expect(late.rm.sameRun(C, X)).toBe(true);
    expect(late.rm.sameRun(C, C)).toBe(true);
    expect(late.rm.sameRun(C, "another")).toBe(false);
    const early = heldSession();
    early.rm.noteRunLink(X, C, 1001);
    expect(early.rm.sameRun(C, X)).toBe(true);
  });

  it("through 2026.9.36 nothing states a link: the 9.36 capture of the scenario records none", async () => {
    const fx = loadCorpus().find((f) => f.version === "2026.9.36" && f.header.scenario === "announce-reverse-hold")!;
    const stated = fx.entries.filter((e) => {
      const f = e.frame as { event?: string; payload?: unknown };
      return f.event === "sessions.changed" && sessionsChangedRunLink(f.payload) !== null;
    });
    expect(stated).toEqual([]);
  });
});

// A run cut into more segments than Convex links in one call (codex pass 3): the writer
// asks page after page, and the link holds — the rows stop waiting — only once Convex
// answers without a cursor.
describe("the writer covers every bubble of the run before it says linked", () => {
  function writerAnswering(answers: Array<Record<string, unknown> | Error>) {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: unknown }) => {
      sent.push(JSON.parse(init.body as string) as Record<string, unknown>);
      const next = answers.shift() ?? { ok: true, linked: true };
      if (next instanceof Error) throw next;
      return { ok: true, status: 200, json: async () => next } as unknown as Response;
    }) as unknown as typeof fetch;
    return { sent, w: new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", fetchImpl }) };
  }

  it("pages until Convex answers without a cursor", async () => {
    const { sent, w } = writerAnswering([
      { ok: true, linked: true, continueCursor: "p2" },
      { ok: true, linked: true, continueCursor: "p3" },
      { ok: true, linked: true },
    ]);
    expect(await w.linkRunBubble("m1", C, X)).toBe(true);
    expect(sent.map((b) => b.cursor)).toEqual([undefined, "p2", "p3"]);
  });

  it("a page refused refuses the link", async () => {
    const { w } = writerAnswering([{ ok: true, linked: true, continueCursor: "p2" }, { ok: true, linked: false }]);
    expect(await w.linkRunBubble("m1", C, X)).toBe(false);
  });

  it("a run with more pages than any read can place is refused, not confirmed", async () => {
    const { sent, w } = writerAnswering(Array.from({ length: 200 }, () => ({ ok: true, linked: true, continueCursor: "again" })));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await w.linkRunBubble("m1", C, X)).toBe(false);
    expect(sent.length).toBe(64);
    quiet.mockRestore();
  });
});
