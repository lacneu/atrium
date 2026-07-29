/// <reference types="vitest" />
//
// "Visible but not saved" (lot 40 — G-45).
//
// The gateway can finish a turn and tell us, in its own words: "History changed during
// this turn — the response above is visible but was not saved to session history." Its
// history_version moved under the turn, so the reply sits in the bubble and NOT in the
// session. Resuming that session means the agent has forgotten what it just said — the
// "il a oublié ce qu'on vient de dire" report, arriving PRE-ANNOUNCED and thrown away.
//
// So the warning is not merely displayed: the session is DROPPED, and the next turn
// re-carries the history. A session whose history is missing our own reply cannot be
// resumed faithfully — the same reasoning, and the same machinery, as the silence path.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import {
  HermesNormalizer,
  isHermesHistoryDesyncWarning,
} from "../src/providers/hermes/normalizer.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const STORED = "20260706_212939_aee24e";
const WARNING =
  "History changed during this turn — the response above is visible but was not " +
  "saved to session history.";

async function turnEndingWith(payload: Record<string, unknown>) {
  const finals: Array<{ status: string; text?: string; clear?: string }> = [];
  const forgotten: string[] = [];
  const codes: string[] = [];
  const client = {
    call: async (method: string) => {
      if (method === "session.resume") {
        return { session_id: "rt-1", stored_session_id: STORED };
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
    finalize: async (
      _id: string,
      status: string,
      text?: string,
      _e?: string | null,
      _k?: string | null,
      o?: { clearProviderSession?: string },
    ) => {
      finals.push({ status, text, clear: o?.clearProviderSession });
    },
    reportSessionMeta: async () => {},
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
      providerChatId: STORED,
      text: "explique-moi",
      onSessionForgotten: () => forgotten.push("c1"),
      onTurnError: (c: string) => codes.push(c),
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  lane("message.complete", payload);
  await run.done;
  return { finals, forgotten, codes };
}

describe("a reply the gateway did not persist", () => {
  it("keeps the answer AND drops the session that lost it", async () => {
    const { finals, forgotten, codes } = await turnEndingWith({
      text: "voilà ma réponse",
      status: "complete",
      warning: WARNING,
    });
    expect(finals).toHaveLength(1);
    // The user keeps what the agent said — the warning is about the SESSION, not the text.
    expect(finals[0]?.status).toBe("complete");
    expect(finals[0]?.text).toBe("voilà ma réponse");
    // …and the session goes, so the next turn re-carries the history instead of resuming
    // one that never recorded this reply.
    expect(finals[0]?.clear).toBe(STORED);
    expect(forgotten, "the in-process cache must be told too").toEqual(["c1"]);
    // …and it is counted where the operator looks.
    expect(codes).toContain("history_desync");
  });

  it("an ordinary turn keeps its session", async () => {
    const { finals, forgotten, codes } = await turnEndingWith({
      text: "voilà",
      status: "complete",
    });
    expect(finals[0]?.clear).toBeUndefined();
    expect(forgotten).toEqual([]);
    expect(codes).toEqual([]);
  });

  it("an EMPTY warning is not a warning", async () => {
    const { finals, codes } = await turnEndingWith({
      text: "voilà",
      status: "complete",
      warning: "   ",
    });
    expect(finals[0]?.clear).toBeUndefined();
    expect(codes).toEqual([]);
  });
});

describe("the predicate is SPECIFIC to the desync", () => {
  it("recognises the sentence upstream writes, reworded or not", () => {
    expect(isHermesHistoryDesyncWarning(WARNING)).toBe(true);
    expect(
      isHermesHistoryDesyncWarning("agent output NOT written to session history"),
    ).toBe(true);
  });

  it("an UNRELATED warning keeps the session", () => {
    // Acting on any non-empty warning was too broad: a future or benign one would drop a
    // healthy session, and re-carrying the history is bounded — so that false positive is
    // a real regression, not a harmless excess of caution (raised in review).
    expect(isHermesHistoryDesyncWarning("Rate limit approaching")).toBe(false);
    expect(isHermesHistoryDesyncWarning("")).toBe(false);
  });

  it("a benign warning does not drop the session, end to end", async () => {
    const { finals, forgotten, codes } = await turnEndingWith({
      text: "voilà",
      status: "complete",
      warning: "Model switched to a fallback for this turn",
    });
    expect(finals[0]?.clear).toBeUndefined();
    expect(forgotten).toEqual([]);
    expect(codes).toEqual([]);
  });
});

describe("one turn, one health record", () => {
  it("an ERROR terminal carrying the warning is not counted twice", async () => {
    // The sink already counts an error terminal at finalize, with its own normalized code.
    // Signalling here too booked two failures for one turn AND let the later code
    // overwrite this one (raised in review). The DROP still happens.
    const { finals, forgotten, codes } = await turnEndingWith({
      text: "",
      status: "error",
      error: "boom",
      warning: WARNING,
    });
    expect(codes, "the sink owns the count for an error terminal").not.toContain(
      "history_desync",
    );
    expect(forgotten, "…but the session is dropped all the same").toEqual(["c1"]);
    expect(finals[0]?.clear).toBe(STORED);
  });
});

describe("REST carries the same rule", () => {
  it("the normalizer learns the desync from its terminal", () => {
    // The first cut handled only the WS terminal, so a REST chat kept resuming a session
    // whose history is missing the reply the user is looking at.
    const norm = new HermesNormalizer();
    expect(norm.historyDesync).toBe(false);
    norm.feed({
      event: "run.completed",
      data: JSON.stringify({ warning: WARNING }),
    });
    expect(norm.historyDesync).toBe(true);
  });

  it("…and ignores an unrelated one", () => {
    const norm = new HermesNormalizer();
    norm.feed({
      event: "run.completed",
      data: JSON.stringify({ warning: "Rate limit approaching" }),
    });
    expect(norm.historyDesync).toBe(false);
  });
});
