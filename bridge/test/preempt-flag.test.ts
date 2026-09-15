// The gatewayPreempted finalize flag (announce×queue race, INVERSE direction) is
// NEVER minted by the bridge any more.
//
// Live prod 2026-07-21 (report ms746b01…, a 2026.7.x gateway): a queued follow-up
// dispatched, was aborted by the gateway via chat:aborted — zero content, no user
// Stop, stopReason "rpc" — and the sub-agent's delivery (announce) started 4 s later.
// The user's message was silently consumed. The incident was ATTRIBUTED to the
// announce race by its timing (no frame proves the cause), and the sink used to flag
// that finalize so Convex re-parked the outbox row for an automatic re-dispatch.
//
// Decided 2026-09-14 (sources + live bench), see TurnSink.flushFinal:
//   - from 2026.8.1 no announce-kill mechanism was found on the production paths read
//     at the instructed tags (a live observation on 2026.9.4 is consistent with it),
//     while known deliberate causes of a zero-content gateway abort exist (interrupt
//     queue mode, rollover, restart, archive/delete, timeout, a chat.abort from another
//     client — not an exhaustive list), and re-dispatching a turn one of those causes
//     ended would undo it;
//   - before 2026.8.1 no frame tells the announce kill apart ("rpc" is that gateway's
//     DEFAULT stop reason and the one a chat.abort from another client carries), and a
//     recent child is a temporal correlation, not a cause.
// So the flag is never set, whatever the terminal carries — the turn keeps the honest
// aborted card. These tests pin the ABSENCE on the shapes below (the measured incident,
// every stop reason, a superseded lifecycle end, a user Stop, streamed content); the
// Convex side pins it at the ingest boundary (convex/bridgeIngest.test.ts, "legacy
// gatewayPreempted"); convex/preemptRepark.test.ts still exercises the internal
// mechanism itself, which stays until its outbox fields are migrated out.

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
  async setSnapshot(): Promise<boolean> {
    return true;
  }
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
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

function abortedFrame(runId: string, stopReason?: string): unknown {
  return {
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      state: "aborted",
      ...(stopReason === undefined ? {} : { stopReason }),
    },
  };
}

/** A lifecycle end some upstream path may emit before the chat terminal — here the
 *  writer-takeover shape. It is not evidence of the announce race on any version, so it
 *  must not flag either. */
function supersededEndFrame(runId: string): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      stream: "lifecycle",
      data: { phase: "end", aborted: true, status: "superseded", stopReason: "superseded" },
    },
  };
}

function deltaFrame(runId: string, deltaText: string): unknown {
  return {
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SESSION_KEY, state: "delta", deltaText },
  };
}

async function flagFor(
  frames: (runId: string) => unknown[],
  before?: (m: RunManager) => void,
): Promise<{ flag: boolean; finals: FinalizeCall[] }> {
  const writer = new FakeWriter();
  const manager = new RunManager("chatPreempt", SESSION_KEY, writer);
  let now = 1000;
  const runId = "webchat-preempted-run";
  await manager.beginTurn((now += 1), runId);
  before?.(manager);
  for (const f of frames(runId)) await manager.feed(f, (now += 1));
  return { flag: writer.finals[0]?.opts?.gatewayPreempted === true, finals: writer.finals };
}

describe("gatewayPreempted finalize flag — never minted", () => {
  it("the measured 2026.7.x incident shape (chat:aborted, rpc, zero content) finalizes aborted, unflagged", async () => {
    const { flag, finals } = await flagFor((r) => [abortedFrame(r, "rpc")]);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.status).toBe("aborted");
    expect(finals[0]?.opts?.gatewayPreempted).toBeUndefined();
    expect(flag).toBe(false);
  });

  it("a zero-content gateway abort never flags, whatever its terminal carries", async () => {
    for (const stopReason of [
      "rpc",
      "superseded",
      "aborted",
      "restart",
      "archive",
      "delete",
      "timeout",
      "auth-revoked",
      "stop",
      undefined,
    ]) {
      const { flag, finals } = await flagFor((r) => [abortedFrame(r, stopReason)]);
      expect(finals, String(stopReason)).toHaveLength(1);
      expect(finals[0]?.status, String(stopReason)).toBe("aborted");
      expect(finals[0]?.opts?.gatewayPreempted, String(stopReason)).toBeUndefined();
      expect(flag, String(stopReason)).toBe(false);
    }
    // `flagFor` reads an ABSENT finalize as "unflagged" too: pin that the finalize happened.
    const superseded = await flagFor((r) => [supersededEndFrame(r), abortedFrame(r, "superseded")]);
    expect(superseded.finals, "with a superseded lifecycle end").toHaveLength(1);
    expect(superseded.finals[0]?.status, "with a superseded lifecycle end").toBe("aborted");
    expect(superseded.finals[0]?.opts?.gatewayPreempted).toBeUndefined();
    expect(superseded.flag, "with a superseded lifecycle end").toBe(false);
  });

  it("a USER Stop (noteUserAbort) finalizes aborted, unflagged", async () => {
    const { flag, finals } = await flagFor(
      (r) => [abortedFrame(r, "rpc")],
      (m) => m.noteUserAbort(),
    );
    expect(finals[0]?.status).toBe("aborted");
    expect(flag).toBe(false);
  });

  it("an abort AFTER streamed content keeps the honest Interrompu, unflagged", async () => {
    const { flag, finals } = await flagFor((r) => [
      deltaFrame(r, "Un début de réponse"),
      abortedFrame(r, "rpc"),
    ]);
    expect(finals[0]?.status).toBe("aborted");
    expect(flag).toBe(false);
  });
});
