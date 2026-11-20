// Envelope-seq continuity — the frame-loss detector.
//
// The gateway drops frames to a slow consumer WHILE ADVANCING the per-connection
// `seq` counter (upstream server-broadcast.ts), so a hole in that sequence is the
// only trace a silently dropped frame leaves. Nothing checked it before this lot:
// content went missing and the user was the one who noticed.
//
// The load-bearing test is the FALSE POSITIVE one: targeted broadcasts carry no
// seq at all, so a naive "every frame must increment" check would report a gap on
// a perfectly healthy connection — worse than no detection, because it would
// train us to ignore the signal.

import { describe, expect, it } from "vitest";
import { createSeqTracker } from "../src/providers/openclaw/frame-seq.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ToolPart,
} from "../src/convex-writer.js";

describe("envelope-seq gap detection", () => {
  it("reports the hole when the gateway drops a frame (1,2,4)", () => {
    const t = createSeqTracker();
    expect(t.observe({ seq: 1 })).toBeNull();
    expect(t.observe({ seq: 2 })).toBeNull();
    expect(t.observe({ seq: 4 })).toEqual({
      missing: 1,
      expected: 3,
      received: 4,
    });
    expect(t.missingTotal).toBe(1);
  });

  it("counts EVERY lost frame, not just the event (2 -> 7 = five lost)", () => {
    const t = createSeqTracker();
    t.observe({ seq: 1 });
    t.observe({ seq: 2 });
    expect(t.observe({ seq: 7 })).toEqual({
      missing: 4,
      expected: 3,
      received: 7,
    });
    expect(t.missingTotal).toBe(4);
  });

  it("a TARGETED frame (no seq) between numbered ones is NOT a gap", () => {
    // THE false positive: upstream sends targeted broadcasts without any seq
    // (`const eventSeq = isTargeted ? undefined : nextSeq`). A naive counter
    // would flag one here — and this test fails if anyone writes that counter.
    const t = createSeqTracker();
    expect(t.observe({ seq: 1 })).toBeNull();
    expect(t.observe({})).toBeNull(); // targeted: no seq at all
    expect(t.observe({ seq: undefined })).toBeNull(); // explicit undefined
    expect(t.observe({ seq: "3" })).toBeNull(); // non-numeric: not a counter
    // The next NUMBERED frame continues from the last numbered one (1 -> 2),
    // so the untracked frames in between must not have shifted the baseline.
    expect(t.observe({ seq: 2 })).toBeNull();
    expect(t.missingTotal).toBe(0);
  });

  it("the first numbered frame never reports a gap, whatever its value", () => {
    // A bridge that connects mid-stream (reconnect) starts at an arbitrary seq:
    // there is no baseline to compare against, so claiming N-1 lost frames would
    // be a fabrication.
    const t = createSeqTracker();
    expect(t.observe({ seq: 4211 })).toBeNull();
    expect(t.missingTotal).toBe(0);
  });

  it("a repeat or an out-of-order seq is not a loss", () => {
    const t = createSeqTracker();
    t.observe({ seq: 5 });
    expect(t.observe({ seq: 5 })).toBeNull(); // redelivery
    expect(t.observe({ seq: 4 })).toBeNull(); // never a negative "missing"
    expect(t.missingTotal).toBe(0);
  });

  it("an out-of-order frame never manufactures a gap on the NEXT one (5,4,6)", () => {
    // The baseline must keep the HIGHEST seq seen: after the stale 4, frame 6 is
    // contiguous with the 5 we already received. Downgrading `last` to 4 would
    // report "5 lost" — a fabricated loss, which is worse than no detection
    // because it teaches us to distrust the signal (codex P3).
    const t = createSeqTracker();
    expect(t.observe({ seq: 5 })).toBeNull();
    expect(t.observe({ seq: 4 })).toBeNull();
    expect(t.observe({ seq: 6 })).toBeNull();
    expect(t.missingTotal).toBe(0);
  });

  it("accumulates across several gaps on one connection", () => {
    const t = createSeqTracker();
    t.observe({ seq: 1 });
    t.observe({ seq: 3 }); // 1 lost
    t.observe({ seq: 6 }); // 2 lost
    expect(t.missingTotal).toBe(3);
  });
});

// The DETECTION is worthless if it is not wired: the connection-level callback
// must reach the writer as an `openclaw.frame_gap` trace.
// The SHAPE contract, pinned from a LIVE capture against the supported gateway
// (bridge frame capture, 2026-07-25): the per-CONNECTION counter is `frame.seq`
// at the ENVELOPE root and it is contiguous across every event type, while
// `payload.seq` is a DIFFERENT per-run counter that is NOT monotonic frame to
// frame. Reading the wrong one would either miss every gap or invent hundreds.
describe("which seq is the connection counter (live-captured shape)", () => {
  it("root seq is contiguous across mixed event types; payload seq is not the counter", () => {
    const t = createSeqTracker();
    // Verbatim shape of a real turn: health, agent x2, chat, agent x3, chat x2,
    // tick — root seq 1..10, payload seq 1,2,2,3,4,5,5,5 (per-run, repeats).
    const captured = [
      { event: "health", seq: 1 },
      { event: "agent", seq: 2, payload: { seq: 1 } },
      { event: "agent", seq: 3, payload: { seq: 2 } },
      { event: "chat", seq: 4, payload: { seq: 2 } },
      { event: "agent", seq: 5, payload: { seq: 3 } },
      { event: "agent", seq: 6, payload: { seq: 4 } },
      { event: "agent", seq: 7, payload: { seq: 5 } },
      { event: "chat", seq: 8, payload: { seq: 5 } },
      { event: "chat", seq: 9, payload: { seq: 5 } },
      { event: "tick", seq: 10 },
    ];
    for (const f of captured) expect(t.observe(f)).toBeNull();
    expect(t.missingTotal).toBe(0);
  });

  it("acks (type:\"res\") carry no seq and never register as a gap", () => {
    // They are correlated replies, not broadcasts — the client returns before the
    // continuity check, and the tracker ignores them anyway.
    const t = createSeqTracker();
    t.observe({ event: "health", seq: 1 });
    expect(t.observe({ type: "res", id: "1" })).toBeNull();
    expect(t.observe({ event: "agent", seq: 2 })).toBeNull();
    expect(t.missingTotal).toBe(0);
  });
});

describe("frame-gap reporting reaches the writer", () => {
  type GapCall = {
    source: string;
    expected: number | null;
    received: number | null;
    missing: number | null;
  };

  class GapWriter implements ConvexWriter {
    readonly gaps: GapCall[] = [];
    readonly pressures: Record<string, unknown>[] = [];
    async startAssistant(): Promise<string> {
      return "msg_gap_1";
    }
    async appendDelta(): Promise<void> {}
    async setSnapshot(): Promise<boolean> {
    return true;
  }
    async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
    async addCompactionPart(): Promise<void> {}
    async recordGatewayPressure(
      _chatId: string,
      _messageId: string,
      data: Record<string, unknown>,
    ): Promise<void> {
      this.pressures.push(data);
    }
    async addProvenancePart(): Promise<void> {}
    async addMedia(): Promise<boolean> {
      return true;
    }
    async noteMediaUndelivered(): Promise<void> {}
    async noteFrameGap(_chatId: string, data: GapCall): Promise<void> {
      this.gaps.push({ ...data });
    }
    async finalize(
      _messageId: string,
      _status: FinalizeStatus,
      _text: string,
    ): Promise<void> {}
    async getRehydrationContext(): Promise<{
      history: string | null;
      turnCount: number;
    }> {
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

  const SK = "agent:alice:atrium:chat:u:mh7gap";

  function gapFrame(runId: string, data: Record<string, unknown>): unknown {
    return {
      type: "event",
      event: "agent",
      payload: { runId, sessionKey: SK, stream: "error", ts: 0, data },
    };
  }

  it("the gateway's own seq-gap report is NOT a frame gap: nothing reaches this writer path", async () => {
    // It compares two counters inside the gateway and says nothing about this socket
    // (gateway-seq-report.test.ts): only a hole in the envelope seq is a lost frame.
    const writer = new GapWriter();
    const manager = new RunManager("chatGap", SK, writer);
    await manager.beginTurn(1000, "webchat-gap-run");
    await manager.feed(
      gapFrame("webchat-gap-run", { reason: "seq gap", expected: 2, received: 5 }),
      1010,
    );
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-gap-run",
          sessionKey: SK,
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Voici le résultat complet." }],
          },
        },
      },
      1100,
    );
    await new Promise((r) => setTimeout(r, 0)); // the traces are fire-and-forget
    expect(writer.gaps).toEqual([]);
    expect(writer.pressures.every((p) => !Object.hasOwn(p, "framesLost"))).toBe(true);
  });
});
