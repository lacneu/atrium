/// <reference types="vitest" />
//
// A transient provider failure must reach the classifier (lot 37 — G-42).
//
// When the backend produces no visible answer and reports a real error, upstream puts the
// DETAIL in the assistant TEXT — `raw = f"Error: {result.get('error')}"`, and the same
// shape on the compute-host path — while the terminal's own `error` field falls back to
// the generic "Hermes run failed.".
//
// Atrium promoted failure prose to the error detail for exactly two prefixes, neither of
// which is `Error:`. So the real cause stayed in the reply body — rendered to the user as
// if the agent had answered "Error: connection error" — and the finalize carried a
// generic string that matches no transient marker. `convex/turnRetry.ts` therefore never
// scheduled the bounded auto-retry, and every upstream blip became a turn the user had to
// re-send by hand.
//
// The classifier already knows these failures ("connection error", "internal server
// error", "socket hang up"…) and already excludes the never-transient ones (auth, quota,
// invalid model). The only broken link was getting the text to it.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import {
  classifyProviderInternal,
  isHermesRuntimeFailureText,
  isHermesSyntheticErrorText,
} from "../src/providers/hermes/normalizer.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

type Final = { status: string; text?: string; error?: string; kind?: string };

async function terminalWith(payload: Record<string, unknown>) {
  const finals: Final[] = [];
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
    finalize: async (
      _id: string,
      status: string,
      text?: string,
      error?: string | null,
      kind?: string | null,
    ) => {
      finals.push({
        status,
        text,
        error: error ?? undefined,
        kind: kind ?? undefined,
      });
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
      providerChatId: null,
      text: "explique-moi",
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  lane("message.complete", payload);
  await run.done;
  return finals;
}

describe("the real cause reaches the retry gate (G-42)", () => {
  it("`Error: <detail>` in the text is promoted, and classified transient", async () => {
    const finals = await terminalWith({
      text: "Error: API connection error",
      status: "error",
    });
    expect(finals).toHaveLength(1);
    // The prose is NOT the reply: leaving it there rendered a fake answer AND blocked the
    // zero-content retry gate, which requires an empty turn.
    expect(finals[0]?.text).toBe("");
    expect(finals[0]?.error).toContain("connection error");
    // …and the stable class is what `turnRetry` reads to schedule the bounded re-send.
    expect(finals[0]?.kind).toBe("provider_internal");
  });

  it("a NEVER-transient cause is promoted too, but not retried", async () => {
    // Promotion and classification are separate decisions: the user must always see the
    // real cause; only a transient one earns an automatic re-send. An invalid model is a
    // wall a retry would only hit again.
    const finals = await terminalWith({
      text: "Error: invalid model slug 'gpt-nope'",
      status: "error",
    });
    expect(finals[0]?.error).toContain("invalid model");
    expect(finals[0]?.kind).toBeUndefined();
  });

  it("a real answer that merely mentions an error is left alone", async () => {
    // The promotion only fires on a terminal-ERROR turn and on SHORT prose. A complete
    // turn keeps its text no matter how it starts.
    const finals = await terminalWith({
      text: "Error: is the prefix your log uses; here is why it happens…",
      status: "complete",
    });
    expect(finals[0]?.status).toBe("complete");
    expect(finals[0]?.text).toContain("here is why");
  });
});

describe("the promotion rule itself", () => {
  it("the runtime's own log prefixes are evidence in themselves", () => {
    expect(
      isHermesRuntimeFailureText("API call failed after 3 retries: Connection error"),
    ).toBe(true);
    expect(isHermesRuntimeFailureText("Streaming failed before delivery: reset")).toBe(
      true,
    );
    // `Error:` is NOT one of them: on its own it is far too loose to act on.
    expect(isHermesRuntimeFailureText("Error: Connection error")).toBe(false);
  });

  it("`Error:` is admitted only when NOTHING was produced", () => {
    // The condition upstream itself puts on writing that text: it substitutes
    // `Error: <detail>` for a missing answer, and only when no visible response exists.
    // So the evidence Atrium requires is the same one — nothing streamed.
    expect(isHermesSyntheticErrorText("Error: Connection error", "")).toBe(true);
    expect(
      isHermesSyntheticErrorText("Error: Connection error", "une vraie réponse"),
      "a turn that produced text has produced an answer, whatever it starts with",
    ).toBe(false);
  });

  it("does not swallow a long body that happens to start the same way", () => {
    const long = "Error: " + "x".repeat(400);
    expect(isHermesRuntimeFailureText(long)).toBe(false);
  });

  it("the classifier still discriminates transient from permanent", () => {
    expect(classifyProviderInternal("Error: connection error")).toBe("provider_internal");
    expect(classifyProviderInternal("Error: rate limit exceeded")).toBeNull();
    expect(classifyProviderInternal("Error: invalid api key")).toBeNull();
  });
});

describe("a real answer is never erased by the loose rule", () => {
  it("a short reply starting `Error:` SURVIVES an error terminal", async () => {
    // The dangerous case, and the one the first cut of this lot got wrong: the pipeline
    // accepts error terminals carrying partial text, so a genuine answer that begins
    // "Error: …" would have been wiped from the bubble, its displayed deltas discarded,
    // and — containing a transient marker — re-sent automatically (raised in review).
    const finals: Final[] = [];
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
      finalize: async (
        _id: string,
        status: string,
        text?: string,
        error?: string | null,
        kind?: string | null,
      ) => {
        finals.push({
          status,
          text,
          error: error ?? undefined,
          kind: kind ?? undefined,
        });
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
        providerChatId: null,
        text: "explique-moi",
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    // The agent ANSWERED — and its answer happens to start the same way.
    lane("message.delta", { text: "Error: connection error, voici pourquoi" });
    lane("message.complete", {
      text: "Error: connection error, voici pourquoi",
      status: "error",
    });
    await run.done;
    expect(finals[0]?.text).toBe("Error: connection error, voici pourquoi");
    // …and nothing was classified transient off the back of it, so no automatic re-send.
    expect(finals[0]?.kind).toBeUndefined();
  });
});

// REST is a NON-CASE, said with its evidence rather than assumed: the `Error: <detail>`
// substitution lives in the WS gateway (`tui_gateway/server.py`), while the REST server
// answers a failed run with a 502 `_openai_error` body. The two runtime log prefixes,
// which the REST normalizer does share, are unchanged by this lot.
