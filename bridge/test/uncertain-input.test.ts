// An input whose chat.send got NO answer (codex pass 6): the gateway may have accepted
// it. It is kept, and the gateway is asked — bounded — whether it holds it, before it
// is ever forgotten. Forgetting it at once made its answer a stranger: refused, lost.

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { reconcileUncertainInput } from "../src/server.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const KEY = "agent:alice:atrium:chat:u:c1";

function harness(answers: Array<unknown | Error>) {
  const rm = new RunManager("c1", KEY, {} as ConvexWriter);
  rm.setProjection(true);
  rm.noteHeldInput("sendB", "sendB", "userB");
  const asked: unknown[] = [];
  let i = 0;
  const session = {
    sessionKey: KEY,
    runManager: rm,
    connection: {
      isClosed: false,
      gatewayVersion: "2026.9.8",
      request: async (_m: string, params: unknown) => {
        asked.push(params);
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a instanceof Error) throw a;
        return { payload: a };
      },
    },
  } as unknown as Parameters<typeof reconcileUncertainInput>[0];
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { rm, session, asked, sleeps, sleep };
}

describe("reconcileUncertainInput", () => {
  it("a receipt for the input: received, kept — its answer will be adopted", async () => {
    const h = harness([{ inputReceipts: [{ runId: "sendB", state: "consumed" }] }]);
    expect(await reconcileUncertainInput(h.session, "sendB", [1, 2, 3], h.sleep)).toBe("received");
    expect(h.rm.outstandingInputs).toEqual(["sendB"]);
    expect((h.asked[0] as { inputRunIds?: string[] }).inputRunIds).toEqual(["sendB"]);
  });

  it("a pending item for the input: received, kept", async () => {
    const h = harness([{ inputReceipts: [], pendingInputs: { items: [{ runId: "sendB", state: "queued" }] } }]);
    expect(await reconcileUncertainInput(h.session, "sendB", [1], h.sleep)).toBe("received");
    expect(h.rm.outstandingInputs).toEqual(["sendB"]);
  });

  it("receipts that name it not: never received, forgotten", async () => {
    const h = harness([{ inputReceipts: [] }]);
    expect(await reconcileUncertainInput(h.session, "sendB", [1, 2, 3], h.sleep)).toBe("absent");
    expect(h.rm.outstandingInputs).toEqual([]);
  });

  it("cancelled: no run will answer it", async () => {
    const h = harness([{ inputReceipts: [{ runId: "sendB", state: "consumed", cancelled: true }] }]);
    expect(await reconcileUncertainInput(h.session, "sendB", [1], h.sleep)).toBe("cancelled");
    expect(h.rm.outstandingInputs).toEqual([]);
  });

  it("bounded: reads that fail are retried at most once per delay, then the input is forgotten", async () => {
    const h = harness([new Error("socket closed")]);
    expect(await reconcileUncertainInput(h.session, "sendB", [10, 30, 60], h.sleep)).toBe("unproven");
    expect(h.asked).toHaveLength(3);
    expect(h.sleeps).toEqual([10, 20, 30]);
    expect(h.rm.outstandingInputs).toEqual([]);
  });

  it("a failed read, then a receipt: received on the second ask", async () => {
    const h = harness([new Error("timeout"), { inputReceipts: [{ runId: "sendB", state: "pending" }] }]);
    expect(await reconcileUncertainInput(h.session, "sendB", [1, 2], h.sleep)).toBe("received");
    expect(h.rm.outstandingInputs).toEqual(["sendB"]);
  });
});
