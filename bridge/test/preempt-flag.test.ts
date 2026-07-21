// The gatewayPreempted finalize flag (announce×queue race, INVERSE direction).
//
// Live prod 2026-07-21 (report ms746b01…): a queued follow-up dispatched, then
// the sub-agent's delivery (announce) claimed the session and the gateway
// killed the REAL turn via chat:aborted — zero content, no user Stop. The
// user's message was silently consumed. The sink must flag that exact finalize
// (gatewayPreempted) so Convex re-parks the outbox row for an automatic
// re-dispatch — and must NOT flag a user Stop, a turn with streamed content,
// or a delivery run (which folds to complete).

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ToolPart,
} from "../src/convex-writer.js";

const SESSION_KEY =
  "agent:fabien:atrium:chat:olivier:mh725a3hs0xg3a9k5fymf95qk18ajt26";

type FinalizeCall = {
  messageId: string;
  status: FinalizeStatus;
  text: string;
  opts?: { discardStreamText?: boolean; gatewayPreempted?: boolean };
};

class FakeWriter implements ConvexWriter {
  readonly finals: FinalizeCall[] = [];
  async startAssistant(): Promise<string> {
    return "msg_preempt_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<void> {}
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
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
    _error: string | null,
    _errorKind?: string | null,
    opts?: { discardStreamText?: boolean; gatewayPreempted?: boolean },
  ): Promise<void> {
    this.finals.push({ messageId, status, text, opts });
  }
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

function abortedFrame(runId: string): unknown {
  return {
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SESSION_KEY, state: "aborted", stopReason: "rpc" },
  };
}

function deltaFrame(runId: string, deltaText: string): unknown {
  return {
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SESSION_KEY, state: "delta", deltaText },
  };
}

describe("gatewayPreempted finalize flag (announce kills a dispatched real turn)", () => {
  it("a gateway chat:aborted on a ZERO-content real turn flags gatewayPreempted", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatPreempt", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), "webchat-preempted-run");
    await manager.feed(abortedFrame("webchat-preempted-run"), (now += 1));
    expect(writer.finals).toHaveLength(1);
    expect(writer.finals[0]?.status).toBe("aborted");
    expect(writer.finals[0]?.opts?.gatewayPreempted).toBe(true);
  });

  it("a USER Stop (noteUserAbort) never flags — the user asked for the kill", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatPreempt", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), "webchat-stopped-run");
    manager.noteUserAbort();
    await manager.feed(abortedFrame("webchat-stopped-run"), (now += 1));
    expect(writer.finals).toHaveLength(1);
    expect(writer.finals[0]?.status).toBe("aborted");
    expect(writer.finals[0]?.opts?.gatewayPreempted ?? false).toBe(false);
  });

  it("an abort AFTER streamed content keeps the honest Interrompu, never the flag", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatPreempt", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), "webchat-partial-run");
    await manager.feed(
      deltaFrame("webchat-partial-run", "Un début de réponse"),
      (now += 1),
    );
    await manager.feed(abortedFrame("webchat-partial-run"), (now += 1));
    expect(writer.finals).toHaveLength(1);
    expect(writer.finals[0]?.status).toBe("aborted");
    expect(writer.finals[0]?.opts?.gatewayPreempted ?? false).toBe(false);
  });
});
