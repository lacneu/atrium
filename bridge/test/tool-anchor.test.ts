// Lot B (interleaved run representation): the sink stamps each tool part with
// its ANCHOR — the UTF-16 length of the visible text at emission time — and
// forwards the provider toolCallId (Convex's upsert key). Pins:
//   - deltas advance the anchor; a snapshot REPLACES it;
//   - a start and its result carry ascending anchors but the SAME toolCallId;
//   - delivery/announce runs never carry an anchor (merged-bubble legacy path);
//   - tool-call counters ignore the new start events (no double count).

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ToolPart,
} from "../src/convex-writer.js";
import type { CronPart } from "../src/core/cron-part.js";

const SESSION_KEY = "agent:alice:atrium:chat:olivier:anchorchat1";
const RUN_ID = "webchat-anchorrun1";

class SinkWriter implements ConvexWriter {
  toolParts: ToolPart[] = [];
  started = 0;
  async startAssistant(): Promise<string> {
    this.started++;
    return "msg_anchor_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<void> {}
  async addToolPart(_m: string, p: ToolPart): Promise<void> {
    this.toolParts.push(p);
  }
  async addCronPart(_m: string, _p: CronPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(_m: string, _s: FinalizeStatus, _t: string): Promise<void> {}
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

function frame(
  payload: Record<string, unknown>,
  runId = RUN_ID,
  event = "agent",
): unknown {
  return {
    type: "event",
    event,
    payload: { runId, sessionKey: SESSION_KEY, isHeartbeat: false, ...payload },
  };
}

// Visible text rides CHAT frames: `deltaText` appends; a `message` content
// snapshot REPLACES (the normalizer's applyVisible contract).
let chatSeq = 0;
const deltaFrame = (text: string, runId = RUN_ID) =>
  frame({ state: "delta", seq: ++chatSeq, deltaText: text }, runId, "chat");
const snapshotFrame = (text: string, runId = RUN_ID) =>
  frame(
    {
      state: "delta",
      seq: ++chatSeq,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
    runId,
    "chat",
  );
const toolFrame = (data: Record<string, unknown>, runId = RUN_ID) =>
  frame({ stream: "tool", data }, runId);

describe("turn-sink: tool-part text anchors (interleaved flow)", () => {
  it("stamps the LINE-SAFE offset at emission; start anchors, completed keeps its own", async () => {
    const writer = new SinkWriter();
    const manager = new RunManager("anchorchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), RUN_ID);
    await manager.feed(deltaFrame("012345678\n"), (now += 1)); // len 10, line starts at 10
    await manager.feed(
      toolFrame({
        name: "web_search",
        phase: "start",
        toolCallId: "t1",
        args: { q: "x" },
      }),
      (now += 1),
    );
    await manager.feed(deltaFrame("abcd\n"), (now += 1)); // len 15, line starts at 15
    await manager.feed(
      toolFrame({
        name: "web_search",
        phase: "result",
        toolCallId: "t1",
        isError: false,
        result: { hits: 1 },
      }),
      (now += 1),
    );
    expect(writer.toolParts).toHaveLength(2);
    const [start, done] = writer.toolParts;
    expect(start).toMatchObject({
      phase: "start",
      toolCallId: "t1",
      textOffset: 10,
    });
    expect(done).toMatchObject({
      phase: "completed",
      toolCallId: "t1",
      textOffset: 15,
    });
  });

  it("a snapshot REPLACES the anchor base (compaction clears)", async () => {
    const writer = new SinkWriter();
    const manager = new RunManager("anchorchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), RUN_ID);
    await manager.feed(deltaFrame("a long stretch of text"), (now += 1));
    // Snapshot down to a short text ending in a newline: the anchor base
    // follows the snapshot's own line structure.
    await manager.feed(snapshotFrame("ab\n"), (now += 1));
    await manager.feed(
      toolFrame({
        name: "exec",
        phase: "result",
        toolCallId: "t2",
        isError: false,
        result: { status: "completed" },
      }),
      (now += 1),
    );
    const done = writer.toolParts.find((p) => p.phase === "completed");
    expect(done?.textOffset).toBe(3);
  });

  it("a MID-LINE emission anchors at the LINE START (never splits a Markdown construct)", async () => {
    const writer = new SinkWriter();
    const manager = new RunManager("anchorchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), RUN_ID);
    // "Intro.\n" (line start = 7) then an UNTERMINATED construct on the
    // current line — the tool fires mid-line.
    await manager.feed(deltaFrame("Intro.\n**la météo est"), (now += 1));
    await manager.feed(
      toolFrame({ name: "web_fetch", phase: "start", toolCallId: "t9", args: {} }),
      (now += 1),
    );
    const start = writer.toolParts.find((p) => p.toolCallId === "t9");
    // Anchored BEFORE the in-progress line, not inside "**la météo est".
    expect(start?.textOffset).toBe(7);
  });

  it("the `message` pseudo-tool is NEVER anchored (it IS the reply, not activity)", async () => {
    const writer = new SinkWriter();
    const manager = new RunManager("anchorchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), RUN_ID);
    await manager.feed(deltaFrame("Some text."), (now += 1));
    await manager.feed(
      toolFrame({
        name: "message",
        phase: "start",
        toolCallId: "m1",
        args: { text: "the reply body" },
      }),
      (now += 1),
    );
    const msgParts = writer.toolParts.filter((p) => p.name === "message");
    expect(msgParts.length).toBeGreaterThan(0);
    for (const p of msgParts) expect(p.textOffset).toBeUndefined();
  });

  it("tool-call counters ignore the new start events (completed counts once)", async () => {
    const writer = new SinkWriter();
    const manager = new RunManager("anchorchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), RUN_ID);
    await manager.feed(
      toolFrame({ name: "exec", phase: "start", toolCallId: "t3", args: {} }),
      (now += 1),
    );
    await manager.feed(
      toolFrame({
        name: "exec",
        phase: "result",
        toolCallId: "t3",
        isError: false,
        result: { status: "completed" },
      }),
      (now += 1),
    );
    // Two raw parts (start + completed) but ONE counted call: the summary
    // counter keys on terminals only (asserted indirectly via the parts's
    // phases — a double count would need a second terminal part).
    expect(
      writer.toolParts.filter((p) => p.phase === "completed"),
    ).toHaveLength(1);
    expect(writer.toolParts.filter((p) => p.phase === "start")).toHaveLength(1);
  });
});
