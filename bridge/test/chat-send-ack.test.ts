// The custody a `chat.send` ACK states. From 2026.10.33 on, a repeated key whose turn
// sits in the follow-up queue is answered `{runId, status: "accepted"}`: the queue
// admission stores that payload as the key's replayable response
// (src/gateway/server-methods/chat-send-turn-adoption.ts, `setGatewayDedupeEntry … entry:
// { ts, ok: true, payload: { runId, status: "accepted" } }`), asserted upstream by
// chat-send-queued-identity.test.ts:116-120. The gateway HOLDS that input; read as a
// refusal, the input was forgotten and the run that answers it refused as a stranger.

import { describe, expect, it } from "vitest";

import type { ConvexWriter } from "../src/convex-writer.js";
import { chatSendAckHoldsInput, settleHeldInputAck } from "../src/providers/openclaw/chat-send-ack.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const KEY = "agent:alice:atrium:chat:u:c1";

describe("chatSendAckHoldsInput — which ACK statuses are custody", () => {
  it.each([
    ["started", true],
    ["in_flight", true],
    // 2026.10.33: the replayed response of a queued turn.
    ["accepted", true],
    // The reply is already in the transcript: not custody (the shadow reads instead).
    ["ok", false],
    // Terminal failures (Control UI `isTerminalFailureChatSendAck`).
    ["timeout", false],
    ["error", false],
    // Unreadable: never taken for custody.
    [undefined, false],
    [null, false],
    ["", false],
    ["ACCEPTED", false],
    [{ status: "accepted" }, false],
  ])("%j → %s", (status, holds) => {
    expect(chatSendAckHoldsInput(status)).toBe(holds);
  });
});

describe("settleHeldInputAck — the held-input path (server.ts sendHeldInput)", () => {
  const held = () => {
    const rm = new RunManager("c1", KEY, {} as ConvexWriter);
    rm.noteHeldInput("sendB", "sendB", "userB");
    return rm;
  };

  it.each(["started", "in_flight", "accepted"])(
    "an ACK `%s` keeps the input the gateway holds",
    (status) => {
      const rm = held();
      settleHeldInputAck(rm, "sendB", status, "sendB");
      expect(rm.outstandingInputs).toEqual(["sendB"]);
    },
  );

  it.each(["ok", "timeout", "error", undefined])(
    "an ACK `%s` forgets it: the gateway holds nothing to answer later",
    (status) => {
      const rm = held();
      settleHeldInputAck(rm, "sendB", status, "sendB");
      expect(rm.outstandingInputs).toEqual([]);
    },
  );

  it("a kept input follows the run the ACK names", () => {
    const calls: unknown[] = [];
    const ledger = {
      noteInputAckRun: (sendId: string, runId: string | null) => calls.push(["ack", sendId, runId]),
      forgetHeldInput: (sendId: string) => calls.push(["forget", sendId]),
    };
    settleHeldInputAck(ledger, "sendB", "accepted", "runB");
    settleHeldInputAck(ledger, "sendC", "error", "runC");
    expect(calls).toEqual([
      ["ack", "sendB", "runB"],
      ["forget", "sendC"],
    ]);
  });
});
