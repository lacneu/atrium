/// <reference types="vitest" />
//
// The facts the gateway already computed (lot 39 — G-50).
//
// Hermes reports, on its terminal: token counts, the number of COMPACTIONS it has
// performed on this session, its own occupancy percentage, live delegations and API calls.
// Atrium read two of those fields on WS and NONE at all on REST.
//
// `compressions` is the one that matters. Atrium learns of a Hermes compaction from a
// `status.update` marker — which upstream broadcasts `dropIfSlow`, so a slow consumer
// simply never receives it and the thread never mentions that the session forgot half its
// history. The COUNT rides the terminal instead, so it cannot be missed; and it says HOW
// MANY, which a marker cannot.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import { HermesNormalizer } from "../src/providers/hermes/normalizer.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

type Meta = Record<string, unknown>;

async function wsTerminalWith(usage: Record<string, unknown>) {
  const metas: Meta[] = [];
  const client = {
    call: async (method: string) => {
      if (method === "session.create") {
        return { session_id: "rt-1", stored_session_id: "20260706_212939_aee24e" };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async () => {},
    addReasoningPart: async () => {},
    setPhase: () => {},
    finalize: async () => {},
    reportSessionMeta: async (_chatId: string, meta: Meta) => {
      metas.push(meta);
    },
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: "c1",
      sessionKey: "k",
      providerChatId: null,
      text: "explique-moi",
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  lane("message.complete", { text: "voilà", status: "complete", usage });
  await run.done;
  return metas;
}

describe("WS: the terminal's usage block is read, not just its two token counts", () => {
  it("carries the COMPACTION COUNT — the signal a dropped marker loses", async () => {
    const metas = await wsTerminalWith({
      context_used: 15968,
      context_max: 272000,
      compressions: 3,
      context_percent: 6,
      active_subagents: 2,
      calls: 41,
    });
    const meta = metas.find((m) => m.compactionCount !== undefined);
    expect(meta, "the count was dropped — a compaction the thread never mentions").
      toBeDefined();
    expect(meta!.compactionCount).toBe(3);
    // …alongside the rest, and WITHOUT losing the two the gauge already used.
    expect(meta!.totalTokens).toBe(15968);
    expect(meta!.contextTokens).toBe(272000);
    expect(meta!.contextPercent).toBe(6);
    expect(meta!.activeSubagents).toBe(2);
    expect(meta!.apiCalls).toBe(41);
  });

  it("the gateway's own percentage is kept BESIDE the token counts, not instead", async () => {
    // Recording both is the point: when the two disagree, the disagreement is the
    // finding. Overwriting one with the other would erase it.
    const metas = await wsTerminalWith({
      context_used: 100,
      context_max: 1000,
      context_percent: 55, // deliberately inconsistent with 100/1000
    });
    const meta = metas.find((m) => m.contextPercent !== undefined)!;
    expect(meta.contextPercent).toBe(55);
    expect(meta.totalTokens).toBe(100);
    expect(meta.contextTokens).toBe(1000);
  });

  it("a non-numeric field is dropped, not forwarded", async () => {
    const metas = await wsTerminalWith({
      context_used: 10,
      compressions: "beaucoup",
      calls: Number.NaN,
    });
    const meta = metas.find((m) => m.totalTokens !== undefined)!;
    expect(meta.compactionCount).toBeUndefined();
    expect(meta.apiCalls).toBeUndefined();
  });
});

describe("REST: usage exists at all now", () => {
  it("the normalizer learns the usage block from run.completed", () => {
    // This transport reported NONE of it: a Hermes chat on REST had no context gauge and
    // no compaction ever reached its thread.
    const norm = new HermesNormalizer();
    expect(norm.currentUsage).toBeNull();
    norm.feed({
      event: "run.completed",
      data: JSON.stringify({
        usage: { context_used: 900, context_max: 8000, compressions: 1 },
      }),
    });
    expect(norm.currentUsage).not.toBeNull();
    expect(norm.currentUsage!.compressions).toBe(1);
  });

  it("a non-object usage is refused", () => {
    const norm = new HermesNormalizer();
    norm.feed({ event: "run.completed", data: JSON.stringify({ usage: [1, 2] }) });
    expect(norm.currentUsage).toBeNull();
  });
});
