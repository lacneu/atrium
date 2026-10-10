// The reconciler's two facts for the projection `on` live overlay (phase 3): every
// transcript USER row (the steer fact CU-20 cuts on), from a `session.message` or a
// read; and the inputs the gateway will never run (cancelled, absent when asked).

import { describe, expect, it } from "vitest";
import {
  TranscriptShadow,
  type SessionEventListener,
} from "../src/providers/openclaw/transcript-shadow.js";

const KEY = "agent:alice:atrium:chat:u:c1";

function rig(replies: unknown[]) {
  let listener: SessionEventListener | null = null;
  const userRows: Array<{ sendId?: string; steerTargetRunId?: string }> = [];
  const dropped: string[] = [];
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: KEY,
    readHistory: async () => replies.shift() ?? { kind: "delta", messages: [], deltaCursor: "c:9", sessionInfo: {} },
    apply: async () => {},
    events: {
      attach: (_k, l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    onUserRow: (row) => userRows.push(row),
    onInputDropped: (id) => dropped.push(id),
    sleep: async () => {},
    now: () => 1000,
    log: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      await shadow.idle();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { shadow, userRows, dropped, flush, get listener() { return listener; } };
}

describe("TranscriptShadow → live overlay hooks", () => {
  it("a session.message user row reaches onUserRow with its steer target", async () => {
    const r = rig([]);
    r.shadow.configure({ mode: "on" });
    await r.flush();
    r.listener!.onSessionMessage({
      sessionKey: KEY,
      sessionId: "s-1",
      message: {
        role: "user",
        content: "B",
        __openclaw: { id: "u2", seq: 2, idempotencyKey: "sendB:user", steerTargetRunId: "runA" },
      },
    });
    await r.flush();
    expect(r.userRows).toEqual([expect.objectContaining({ sendId: "sendB", steerTargetRunId: "runA" })]);
  });

  it("a read's user rows reach onUserRow too (the live event may have been missed)", async () => {
    const r = rig([
      {
        sessionKey: KEY,
        sessionId: "s-1",
        messages: [
          { role: "user", content: "B", __openclaw: { id: "u2", seq: 2, idempotencyKey: "sendB:user", steerTargetRunId: "runA" } },
        ],
        sessionInfo: { sessionId: "s-1" },
      },
    ]);
    r.shadow.configure({ mode: "on" });
    await r.flush();
    expect(r.userRows.map((x) => x.sendId)).toEqual(["sendB"]);
  });

  it("a cancelled receipt / pending item reaches onInputDropped", async () => {
    const r = rig([
      {
        sessionKey: KEY,
        sessionId: "s-1",
        messages: [],
        sessionInfo: { sessionId: "s-1" },
        inputReceipts: [{ runId: "sendB", state: "pending", cancelled: true }],
        pendingInputs: { total: 1, items: [{ runId: "sendC", state: "cancelled" }] },
      },
    ]);
    r.shadow.noteSend("sendB");
    r.shadow.configure({ mode: "on" });
    await r.flush();
    expect(r.dropped.sort()).toEqual(["sendB", "sendC"]);
  });
});
