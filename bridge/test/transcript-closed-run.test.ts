// A RUN THE TRANSCRIPT CLOSED still delivers (codex phase 4 pass 17): on a projected
// session the turn ends on the transcript's fact (`settleFromTranscript`) while the live
// run can still send its media (a converted PDF) and its own terminal. Those frames land
// on the run's bubble — `addMedia`, then the LIVE `finalize` Convex waits for before it
// judges a file job — without reopening the turn. Deterministic: real RunManager,
// Normalizer and TurnSink, a recording writer.

import { describe, expect, it, vi } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const SK = "agent:convbot:atrium:chat:u:c1";
const RUN = "run-conv";
const PDF = "/home/node/.openclaw/media/outbound/result.pdf";

const chat = (payload: Record<string, unknown>, runId = RUN) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: SK, runId, ...payload },
});
const mediaFrame = (runId = RUN) => ({
  type: "event",
  event: "agent",
  payload: { sessionKey: SK, runId, stream: "assistant", data: { mediaUrls: [PDF] } },
});
const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

function recordingWriter(bubbles: string[] = ["m1"]) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let opened = 0;
  const rec = (op: string) => vi.fn(async (...args: unknown[]) => {
    calls.push({ op, args });
    if (op === "startAssistant") return bubbles[Math.min(opened++, bubbles.length - 1)];
    return op === "addMedia" ? true : undefined;
  });
  const w = {
    finalizeClosedRun: rec("finalizeClosedRun"),
    startAssistant: rec("startAssistant"),
    appendDelta: rec("appendDelta"),
    setSnapshot: rec("setSnapshot"),
    finalize: rec("finalize"),
    addPart: rec("addPart"),
    addMedia: rec("addMedia"),
    addCompactionPart: rec("addCompactionPart"),
    recordGatewayPressure: rec("recordGatewayPressure"),
    addToolPart: rec("addToolPart"),
    noteMediaUndelivered: rec("noteMediaUndelivered"),
  };
  return { writer: w as unknown as ConvexWriter, calls };
}

async function run(opts: { closeEarly: boolean; rollback?: boolean }) {
  const { writer, calls } = recordingWriter();
  const rm = new RunManager("chat1", SK, writer);
  rm.setProjection(true);
  await rm.beginTurn(1000, RUN, { expectedSessionId: null });
  await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
  if (opts.closeEarly) expect(await rm.settleFromTranscript([RUN], 1002)).toBe(true);
  if (opts.rollback === true) rm.setProjection(false);
  await rm.feed(mediaFrame(), 1003);
  await rm.lanesIdle();
  await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1004);
  await rm.lanesIdle();
  return { rm, calls };
}

const finalizes = (calls: Array<{ op: string; args: unknown[] }>) =>
  calls
    .filter((c) => c.op === "finalize" || c.op === "finalizeClosedRun")
    .map((c) =>
      c.op === "finalize"
        ? { messageId: c.args[0], cause: (c.args[5] as { finalizeCause?: string } | undefined)?.finalizeCause }
        : { messageId: c.args[0], runId: c.args[1], cause: c.args[5] },
    );

describe("a run the transcript closed still delivers its media and its live terminal", () => {
  it("baseline (no early close): the live turn attaches the PDF once", async () => {
    const { calls } = await run({ closeEarly: false });
    expect(calls.filter((c) => c.op === "addMedia")).toHaveLength(1);
  });

  for (const rollback of [false, true]) {
    it(`closed by the transcript${rollback ? ", then rolled back to shadow" : ""}: the PDF lands on the bubble, then the live terminal — the turn stays closed`, async () => {
      const { rm, calls } = await run({ closeEarly: true, rollback });
      const media = calls.filter((c) => c.op === "addMedia");
      expect(media).toHaveLength(1);
      expect(media[0]!.args[0]).toBe("m1");
      expect((media[0]!.args[1] as { filename: string }).filename).toBe("result.pdf");
      // The transcript's echo, then the run's LIVE terminal — on the same bubble.
      expect(finalizes(calls)).toEqual([
        { messageId: "m1", cause: "transcript_settled" },
        { messageId: "m1", runId: RUN, cause: "gateway_final" },
      ]);
      // The live terminal comes AFTER the media.
      const order = calls
        .filter((c) => c.op === "addMedia" || c.op === "finalize" || c.op === "finalizeClosedRun")
        .map((c) => c.op);
      expect(order).toEqual(["finalize", "addMedia", "finalizeClosedRun"]);
      expect(rm.turnActive).toBe(false);
      expect(calls.filter((c) => c.op === "startAssistant")).toHaveLength(1);
    });
  }

  it("bounded by count: past MAX_TRANSCRIPT_CLOSED closed runs, the oldest is forgotten", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    const n = RunManager.MAX_TRANSCRIPT_CLOSED + 1;
    for (let i = 0; i < n; i++) {
      const rid = `run-${i}`;
      await rm.beginTurn(1000 + 10 * i, rid, { expectedSessionId: null });
      await rm.feed(chat({ state: "delta", message: text(`réponse ${i}`) }, rid), 1001 + 10 * i);
      expect(await rm.settleFromTranscript([rid], 1002 + 10 * i)).toBe(true);
    }
    await rm.feed(mediaFrame("run-0"), 1200);
    await rm.lanesIdle();
    expect(calls.filter((c) => c.op === "addMedia")).toHaveLength(0);
    await rm.feed(mediaFrame(`run-${n - 1}`), 1201);
    await rm.lanesIdle();
    expect(calls.filter((c) => c.op === "addMedia")).toHaveLength(1);
  });

  for (const rollback of [false, true]) {
    it(`bounded by age, in the injected clock's unit (seconds): reconciled at 599 s, not at 601 s${rollback ? " (rolled back)" : ""}`, async () => {
      for (const [after, expected] of [[599, 1], [601, 0]] as const) {
        const { writer, calls } = recordingWriter();
        const rm = new RunManager("chat1", SK, writer);
        rm.setProjection(true);
        await rm.beginTurn(1000, RUN, { expectedSessionId: null });
        await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
        await rm.settleFromTranscript([RUN], 1002);
        if (rollback) rm.setProjection(false);
        await rm.feed(mediaFrame(), 1002 + after);
        await rm.lanesIdle();
        expect(calls.filter((c) => c.op === "addMedia")).toHaveLength(expected);
      }
      expect(RunManager.TRANSCRIPT_CLOSED_TTL_S).toBe(600);
    });
  }
});

// codex phase 4 pass 18: a stashed announce B, flushed when A's turn closes, must never
// be taken for A — nor A's late terminal end B.
const ANNOUNCE = "announce:v1:agent:files:subagent:child-1:run-child-1";

describe("pass 18 — the closed run keeps ITS identity, whatever opens next", () => {
  async function closedWithAnnounce(bTerminal: boolean) {
    const { writer, calls } = recordingWriter(["m1", "m2"]);
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
    // B arrives while A streams: stashed until A's turn is over.
    await rm.feed(chat({ state: "delta", message: text("Résultat du sous-agent.") }, ANNOUNCE), 1002);
    if (bTerminal) await rm.feed(chat({ state: "final", message: text("Résultat du sous-agent.") }, ANNOUNCE), 1003);
    expect(await rm.settleFromTranscript([RUN], 1004)).toBe(true);
    await rm.feed(mediaFrame(), 1005);
    await rm.lanesIdle();
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1006);
    await rm.lanesIdle();
    return { rm, calls };
  }

  for (const bTerminal of [false, true]) {
    it(`B ${bTerminal ? "already terminal" : "still active"} after the flush: A's media and live terminal go to A's bubble, with A's run`, async () => {
      const { calls } = await closedWithAnnounce(bTerminal);
      expect(calls.filter((c) => c.op === "startAssistant")).toHaveLength(2);
      const media = calls.filter((c) => c.op === "addMedia");
      expect(media).toHaveLength(1);
      expect(media[0]!.args[0]).toBe("m1");
      expect((media[0]!.args[1] as { runId?: string }).runId).toBe(RUN);
      expect(finalizes(calls).filter((f) => "runId" in f)).toEqual([{ messageId: "m1", runId: RUN, cause: "gateway_final" }]);
    });
  }

  it("B took over A's bubble: A's late terminal names A's run, B keeps streaming", async () => {
    // The announce merge reopens the parent: B's start answers A's bubble, m1.
    const { writer, calls } = recordingWriter(["m1", "m1"]);
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.feed(chat({ state: "delta", message: text("Je délègue.") }), 1001);
    expect(await rm.settleFromTranscript([RUN], 1002)).toBe(true);
    await rm.feed(chat({ state: "delta", message: text("Résultat…") }, ANNOUNCE), 1003);
    expect(rm.turnActive).toBe(true);
    expect(calls.filter((c) => c.op === "startAssistant")).toHaveLength(2);
    await rm.feed(chat({ state: "final", message: text("Je délègue.") }), 1004);
    await rm.lanesIdle();
    // Never the plain `finalize` (whose generation tag is the bubble's CURRENT run, B's).
    expect(calls.filter((c) => c.op === "finalize").map((c) => c.args[0])).toEqual(["m1"]); // A's echo only
    expect(finalizes(calls).filter((f) => "runId" in f)).toEqual([{ messageId: "m1", runId: RUN, cause: "gateway_final" }]);
    expect(rm.turnActive).toBe(true);
  });
});

describe("pass 18 — the writer's closed-run terminal names its own generation and leaves the bubble's", () => {
  it("B owns m1: A's terminal posts A's run; B's next write still carries B's", async () => {
    const { HttpConvexWriter } = await import("../src/convex-writer.js");
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push(body);
      return { ok: true, json: async () => (body.op === "startAssistant" ? { messageId: "m1" } : { ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", deltaFlushMs: 1, fetchImpl });
    // B's turn re-owns the bubble A's run had.
    expect(await w.startAssistant("chat1", ANNOUNCE, SK)).toBe("m1");
    await w.finalizeClosedRun("m1", RUN, "complete", null, null, "gateway_final");
    const terminal = sent.find((b) => b.op === "finalize")!;
    expect(terminal.runId).toBe(RUN);
    expect(terminal.finalizeCause).toBe("gateway_final");
    // B's stream state survives: its next delta is still tagged with B's generation.
    await w.appendDelta("m1", "suite de B");
    await new Promise((r) => setTimeout(r, 20));
    const delta = sent.filter((b) => b.op === "appendDelta" || b.op === "delta").at(-1);
    expect(delta?.runId).toBe(ANNOUNCE);
  });
});

// codex phase 4 pass 19.
describe("pass 19 — frames during the close are held, and the close re-checks its run", () => {
  /** A writer whose `op` call waits for a manual release. */
  function suspendedWriter(op: string, bubbles: string[] = ["m1"]) {
    const base = recordingWriter(bubbles);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = base.writer as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const original = w[op]!;
    let first = true;
    w[op] = async (...args: unknown[]) => {
      if (first) {
        first = false;
        await gate;
      }
      return original(...args);
    };
    return { ...base, release };
  }

  it("a PDF and the live terminal arriving while the close's finalize is suspended reach the bubble", async () => {
    const { writer, calls, release } = suspendedWriter("finalize");
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
    const settling = rm.settleFromTranscript([RUN], 1002);
    await new Promise((r) => setTimeout(r, 0));
    await rm.feed(mediaFrame(), 1003);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1004);
    release();
    expect(await settling).toBe(true);
    await rm.lanesIdle();
    const media = calls.filter((c) => c.op === "addMedia");
    expect(media.map((c) => c.args[0])).toEqual(["m1"]);
    expect(finalizes(calls).filter((f) => "runId" in f)).toEqual([{ messageId: "m1", runId: RUN, cause: "gateway_final" }]);
  });

  it("…and the same after a rollback to shadow during the close", async () => {
    const { writer, calls, release } = suspendedWriter("finalize");
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
    const settling = rm.settleFromTranscript([RUN], 1002);
    await new Promise((r) => setTimeout(r, 0));
    rm.setProjection(false);
    await rm.feed(mediaFrame(), 1003);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1004);
    release();
    expect(await settling).toBe(true);
    await rm.lanesIdle();
    expect(calls.filter((c) => c.op === "addMedia")).toHaveLength(1);
    expect(finalizes(calls).filter((f) => "runId" in f)).toHaveLength(1);
  });

  it("a settle queued while the projection is rolled back closes nothing (the legacy terminals decide)", async () => {
    const { writer, calls, release } = suspendedWriter("startAssistant");
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    const a = rm.feed(chat({ state: "delta", message: text("début") }), 1001);
    await new Promise((r) => setTimeout(r, 0));
    const settling = rm.settleFromTranscript([RUN], 1002);
    rm.setProjection(false);
    release();
    await a;
    expect(await settling).toBe(false);
    expect(rm.turnActive).toBe(true);
    expect(finalizes(calls)).toEqual([]);
  });

  it("a settle queued behind a compaction resume onto B never closes B", async () => {
    // A's first write (the bubble's open) is suspended: everything after it queues.
    const { writer, calls, release } = suspendedWriter("startAssistant");
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    const a = rm.feed(chat({ state: "delta", message: text("début") }), 1001);
    await new Promise((r) => setTimeout(r, 0));
    // The gateway abandons A and resumes the turn on B (same epoch)…
    const ab = rm.feed(
      { type: "event", event: "agent", payload: { sessionKey: SK, runId: RUN, stream: "lifecycle", data: { phase: "end", livenessState: "abandoned" } } },
      1002,
    );
    const b = rm.feed(chat({ state: "delta", message: text("suite") }, "run-B"), 1003);
    // …while the transcript says A is over (A is still the current run at this point).
    const settling = rm.settleFromTranscript([RUN], 1004);
    release();
    await Promise.all([a, ab, b]);
    expect(await settling).toBe(false);
    expect(rm.turnActive).toBe(true);
    expect(rm.foregroundRunId).toBe("run-B");
    expect(finalizes(calls)).toEqual([]);
  });
});

// codex phase 4 pass 20: ONE serial lane per closed run — a terminal never overtakes a
// media, and a failed close never drops what follows.
describe("pass 20 — the closed run's lane is strictly serial and survives a failed close", () => {
  type Gate = { wait: Promise<void>; open: () => void };
  const gate = (): Gate => {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  for (const rollback of [false, true]) {
    it(`the terminal arrives DURING the upload of a held media: it waits for it${rollback ? " (rolled back during the close)" : ""}`, async () => {
      const base = recordingWriter();
      const w = base.writer as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const closeGate = gate();
      const uploadGate = gate();
      const log: string[] = [];
      const finalize = w.finalize!;
      let firstFinalize = true;
      w.finalize = async (...a: unknown[]) => {
        if (firstFinalize) {
          firstFinalize = false;
          await closeGate.wait;
        }
        return finalize(...a);
      };
      const addMedia = w.addMedia!;
      w.addMedia = async (...a: unknown[]) => {
        log.push("upload:start");
        await uploadGate.wait;
        const r = await addMedia(...a);
        log.push("upload:done");
        return r;
      };
      const finalizeClosedRun = w.finalizeClosedRun!;
      w.finalizeClosedRun = async (...a: unknown[]) => {
        log.push("terminal");
        return finalizeClosedRun(...a);
      };
      const rm = new RunManager("chat1", SK, base.writer);
      rm.setProjection(true);
      await rm.beginTurn(1000, RUN, { expectedSessionId: null });
      await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
      const settling = rm.settleFromTranscript([RUN], 1002);
      await tick();
      if (rollback) rm.setProjection(false);
      await rm.feed(mediaFrame(), 1003); // held while the close writes
      closeGate.open();
      expect(await settling).toBe(true);
      await tick();
      expect(log).toEqual(["upload:start"]);
      await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1004);
      await tick();
      expect(log).toEqual(["upload:start"]); // the terminal waits for the upload
      uploadGate.open();
      await rm.lanesIdle();
      expect(log).toEqual(["upload:start", "upload:done", "terminal"]);
    });

    it(`the close's finalize is REJECTED, then a media, then the terminal: both still land${rollback ? " (rolled back during the close)" : ""}`, async () => {
      const base = recordingWriter();
      const w = base.writer as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const closeGate = gate();
      const finalize = w.finalize!;
      let firstFinalize = true;
      w.finalize = async (...a: unknown[]) => {
        if (firstFinalize) {
          firstFinalize = false;
          await closeGate.wait;
          throw new Error("Convex ingest finalize -> HTTP 503");
        }
        return finalize(...a);
      };
      const rm = new RunManager("chat1", SK, base.writer);
      rm.setProjection(true);
      await rm.beginTurn(1000, RUN, { expectedSessionId: null });
      await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
      const settling = rm.settleFromTranscript([RUN], 1002);
      await tick();
      if (rollback) rm.setProjection(false);
      closeGate.open();
      expect(await settling).toBe(true);
      await rm.feed(mediaFrame(), 1003);
      await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1004);
      await rm.lanesIdle();
      const media = base.calls.filter((c) => c.op === "addMedia");
      expect(media.map((c) => c.args[0])).toEqual(["m1"]);
      expect(finalizes(base.calls).filter((f) => "runId" in f)).toEqual([{ messageId: "m1", runId: RUN, cause: "gateway_final" }]);
      expect(rm.turnActive).toBe(false);
    });
  }
});

// codex phase 4 pass 21: a run closed before any bubble opened here still delivers — onto
// the bubble the transcript made, looked up in Convex (verified), with bounded retries.
describe("pass 21 — a closed run without a local bubble finds the projected one", () => {
  function lookupWriter(answers: Array<string | null | Error>) {
    const base = recordingWriter();
    const w = base.writer as unknown as Record<string, unknown>;
    const lookups: unknown[][] = [];
    w.findProjectedBubble = async (...args: unknown[]) => {
      lookups.push(args);
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (a instanceof Error) throw a;
      return a;
    };
    return { ...base, lookups };
  }

  it("closed before any bubble opened: the PDF and the terminal go to the projected bubble", async () => {
    const { writer, calls, lookups } = lookupWriter(["m9"]);
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    expect(await rm.settleFromTranscript([RUN], 1001)).toBe(true);
    await rm.feed(mediaFrame(), 1002);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1003);
    await rm.lanesIdle();
    expect(lookups).toEqual([["chat1", SK, RUN, 0]]);
    expect(calls.filter((c) => c.op === "addMedia").map((c) => c.args[0])).toEqual(["m9"]);
    expect(finalizes(calls).filter((f) => "runId" in f)).toEqual([{ messageId: "m9", runId: RUN, cause: "gateway_final" }]);
  });

  it("the bubble opened while the close was queued, then the close failed: its frames go to THAT bubble", async () => {
    const { writer, calls, lookups } = lookupWriter([null]);
    const w = writer as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let openGate!: () => void;
    const opening = new Promise<void>((r) => (openGate = r));
    const start = w.startAssistant!;
    w.startAssistant = async (...a: unknown[]) => {
      await opening;
      return start(...a);
    };
    w.finalize = async () => {
      throw new Error("Convex ingest finalize -> HTTP 503");
    };
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    const delta = rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
    await new Promise((r) => setTimeout(r, 0));
    const settling = rm.settleFromTranscript([RUN], 1002);
    openGate();
    await delta;
    expect(await settling).toBe(true);
    await rm.feed(mediaFrame(), 1003);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1004);
    await rm.lanesIdle();
    expect(lookups).toEqual([]);
    expect(calls.filter((c) => c.op === "addMedia").map((c) => c.args[0])).toEqual(["m1"]);
    expect(finalizes(calls).filter((f) => "runId" in f)).toEqual([{ messageId: "m1", runId: RUN, cause: "gateway_final" }]);
  });

  it("the lookup fails, then finds nothing, then finds it: the waiting frames drain in order", async () => {
    const { writer, calls, lookups } = lookupWriter([new Error("ingest down"), null, "m9"]);
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.settleFromTranscript([RUN], 1001);
    await rm.feed(mediaFrame(), 1002);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1003);
    await rm.lanesIdle();
    expect(lookups).toHaveLength(3);
    const order = calls.filter((c) => c.op === "addMedia" || c.op === "finalizeClosedRun").map((c) => `${c.op}:${c.args[0]}`);
    expect(order).toEqual(["addMedia:m9", "finalizeClosedRun:m9"]);
  });

  it("never found: the lane gives up after MAX_DESTINATION_LOOKUPS, writes nothing", async () => {
    const { writer, calls, lookups } = lookupWriter([null]);
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.settleFromTranscript([RUN], 1001);
    await rm.feed(mediaFrame(), 1002);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1003);
    await rm.feed(chat({ state: "final", message: text("encore") }), 1004);
    await rm.lanesIdle();
    expect(lookups).toHaveLength(RunManager.MAX_DESTINATION_LOOKUPS);
    expect(calls.filter((c) => c.op === "addMedia" || c.op === "finalizeClosedRun")).toHaveLength(0);
  });

  it("projection off or shadow: no lane, so the lookup is never reached", async () => {
    const { writer, lookups } = lookupWriter(["m9"]);
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(false);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    expect(await rm.settleFromTranscript([RUN], 1001)).toBe(false);
    await rm.feed(mediaFrame(), 1002);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1003);
    await rm.lanesIdle();
    expect(lookups).toEqual([]);
  });
});

// codex phase 4 pass 22: an upload of a projected run tells Convex it is under way.
describe("pass 22 — projected uploads are announced; others are not", () => {
  it("the lane's upload carries markUpload", async () => {
    const { writer, calls } = recordingWriter();
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(true);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
    await rm.settleFromTranscript([RUN], 1002);
    await rm.feed(mediaFrame(), 1003);
    await rm.lanesIdle();
    const media = calls.filter((c) => c.op === "addMedia");
    expect((media[0]!.args[1] as { markUpload?: boolean }).markUpload).toBe(true);
  });

  for (const projection of [true, false]) {
    it(`the turn's own upload carries markUpload only when projected (${projection ? "on" : "off/shadow"})`, async () => {
      const { writer, calls } = recordingWriter();
      const rm = new RunManager("chat1", SK, writer);
      rm.setProjection(projection);
      await rm.beginTurn(1000, RUN, { expectedSessionId: null });
      await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
      await rm.feed(mediaFrame(), 1002);
      await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1003);
      await new Promise((r) => setTimeout(r, 10));
      const media = calls.filter((c) => c.op === "addMedia");
      expect(media).toHaveLength(1);
      expect((media[0]!.args[1] as { markUpload?: boolean }).markUpload).toBe(projection ? true : undefined);
    });
  }

  it("the writer names the destination and its window on getUploadUrl only when asked", async () => {
    const { HttpConvexWriter, UPLOAD_MARKER_WINDOW_MS } = await import("../src/convex-writer.js");
    const { Readable } = await import("node:stream");
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: unknown, init: { body: unknown }) => {
      if (String(url).startsWith("http://upload.invalid")) {
        return { ok: true, json: async () => ({ storageId: "st_1" }) } as unknown as Response;
      }
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      sent.push(body);
      if (body.op === "getUploadUrl") return { ok: true, json: async () => ({ uploadUrl: "http://upload.invalid/u" }) } as unknown as Response;
      return { ok: true, json: async () => ({ ok: true, accepted: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = new HttpConvexWriter({
      convexHttpActionsUrl: "http://test.invalid",
      ingestSecret: "s",
      fetchImpl,
      mediaFetcher: { open: async () => ({ ok: true, stream: Readable.from([Buffer.alloc(4)]), mimeType: "application/pdf", size: 4 }) },
    });
    await w.addMedia("m1", { chatId: "c1", filename: "a.pdf", path: "/x/a.pdf", runId: RUN, markUpload: true });
    await w.addMedia("m2", { chatId: "c1", filename: "b.pdf", path: "/x/b.pdf", runId: RUN });
    const urls = sent.filter((b) => b.op === "getUploadUrl");
    expect(urls[0]).toEqual({ op: "getUploadUrl", messageId: "m1", runId: RUN, uploadWindowMs: UPLOAD_MARKER_WINDOW_MS });
    expect(urls[1]).toEqual({ op: "getUploadUrl" });
    expect(UPLOAD_MARKER_WINDOW_MS).toBe(5 * 60_000 + 20_000);
  });
});

// codex phase 4 pass 23: the outbound scan's rescue uploads announce themselves too —
// only on a projected turn (a turn begun `on` stays so across a rollback).
describe("pass 23 — the outbound scan announces its uploads on a projected turn", () => {
  async function scannedTurn(projection: boolean, rollbackMidTurn = false) {
    const { writer } = recordingWriter();
    const scans: unknown[][] = [];
    const scan = async (...args: unknown[]) => {
      scans.push(args);
      return { candidates: [] as string[], host: async () => {} };
    };
    const rm = new RunManager("chat1", SK, writer, scan as never);
    rm.setProjection(projection);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    await rm.feed(chat({ state: "delta", message: text("Voici le PDF.") }), 1001);
    if (rollbackMidTurn) rm.setProjection(false);
    await rm.feed(chat({ state: "final", message: text("Voici le PDF.") }), 1002);
    await new Promise((r) => setTimeout(r, 10));
    return scans;
  }

  it("projected turn: the scan is asked to announce", async () => {
    const scans = await scannedTurn(true);
    expect(scans).toHaveLength(1);
    expect(scans[0]![6]).toBe(true);
  });

  it("a turn begun `on`, rolled back mid-turn: still announced (its job may be deferred)", async () => {
    const scans = await scannedTurn(true, true);
    expect(scans[0]![6]).toBe(true);
  });

  it("never-on turn: not announced", async () => {
    const scans = await scannedTurn(false);
    expect(scans[0]![6]).toBe(false);
  });

  for (const mark of [true, false]) {
    it(`scanAndHostOutbound passes markUpload to addMedia only when asked (${mark})`, async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { scanAndHostOutbound } = await import("../src/core/outbound-scan.js");
      const dir = await mkdtemp(join(tmpdir(), "scan-"));
      await writeFile(join(dir, "result.pdf"), "%PDF");
      const { writer, calls } = recordingWriter();
      const r = await scanAndHostOutbound(
        { writer, dir, maxBytes: 1_000_000, enabled: () => true },
        "m1",
        "chat1",
        Date.now() - 1000,
        new Set(),
        () => true,
        RUN,
        mark,
      );
      await r.host();
      const media = calls.filter((c) => c.op === "addMedia");
      expect(media).toHaveLength(1);
      expect((media[0]!.args[1] as { markUpload?: boolean }).markUpload).toBe(mark ? true : undefined);
    });
  }
});
