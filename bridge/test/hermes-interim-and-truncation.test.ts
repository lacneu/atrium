/// <reference types="vitest" />
//
// The reply must not silently DISAPPEAR, nor be presented as finished when it is not
// (lot 34 — G-43 and G-44).
//
// Two defects of the same family: what the terminal says about the answer.
//
//  * G-44 — upstream reports THREE terminal outcomes. On WS, `message.complete.status` is
//    `complete` | `error` | `interrupted`; on REST/SSE, `assistant.completed` carries
//    `completed` / `partial` / `interrupted`. Atrium read a binary on both: anything that
//    was not `error` became `complete`. So a run cut short mid-sentence was handed to the
//    user as the finished answer — the worst kind of loss, because nothing marks it.
//
//  * G-43 — `message.interim` carries assistant text emitted alongside tool calls, or an
//    attempted final answer before a verify-on-stop nudge. Upstream emits it, in its own
//    words, "so the desktop can seal it as its own segment instead of losing it when
//    message.complete replaces the streaming buffer". Atrium dropped it in the reader's
//    default case, so exactly that loss happened.
//
// The interim segment is sealed as its own PART, never merged into the reply text. Merging
// would need a containment test on prose, and the gateway re-renders its final text
// (whitespace collapsed, directives stripped) — a false negative duplicates the prose in
// the bubble, a false positive loses it. Both are visible to the client and neither is
// decidable here. A part is the surface upstream actually asks for: a segment.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import { HermesNormalizer } from "../src/providers/hermes/normalizer.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

type Final = { status: string; text?: string };

async function wsTurn(
  emit: (send: (t: string, p: Record<string, unknown>) => void) => void,
) {
  const parts: unknown[] = [];
  const finals: Final[] = [];
  const deltas: string[] = [];
  const client = {
    call: async (method: string) => {
      if (method === "session.create") {
        return { session_id: "cc4ebdee", stored_session_id: "20260706_212939_aee24e" };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async (_id: string, t: string) => {
      deltas.push(t);
    },
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async (_id: string, part: unknown) => {
      parts.push(part);
    },
    setPhase: () => {},
    finalize: async (_id: string, status: string, text?: string) => {
      finals.push({ status, text });
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
  emit(lane);
  await run.done;
  return { parts, finals, deltas };
}

const interimParts = (parts: unknown[]) =>
  parts.filter((p) => (p as { name?: string }).name === "hermes.interim");

describe("a run cut short is NOT presented as finished (G-44)", () => {
  it("WS: status `interrupted` settles the turn as aborted, keeping the partial text", async () => {
    const { finals } = await wsTurn((send) => {
      send("message.delta", { text: "La réponse commence" });
      send("message.complete", {
        text: "La réponse commence",
        status: "interrupted",
      });
    });
    expect(finals).toHaveLength(1);
    // `complete` here is the lie: the user keeps a half-sentence believing it is the
    // whole answer. `aborted` is Atrium's existing word for a turn stopped mid-flight,
    // and it keeps the partial text rather than throwing it away.
    expect(finals[0]?.status).toBe("aborted");
    expect(finals[0]?.text).toBe("La réponse commence");
  });

  it("WS: an ordinary complete is untouched", async () => {
    const { finals } = await wsTurn((send) =>
      send("message.complete", { text: "voilà", status: "complete" }),
    );
    expect(finals[0]?.status).toBe("complete");
  });

  it("SSE: `interrupted` on assistant.completed does the same", async () => {
    // The REST transport carries the same fact under different names — three lots of this
    // programme were paid for fixing one transport and leaving the other.
    const norm = new HermesNormalizer();
    norm.feed({ event: "assistant.delta", data: JSON.stringify({ delta: "La réponse" }) });
    const events = norm.feed({
      event: "assistant.completed",
      data: JSON.stringify({
        content: "La réponse commence",
        completed: false,
        partial: true,
        interrupted: true,
      }),
    });
    const runStatus = events.find((e) => e.type === "run.status") as
      | { status?: string }
      | undefined;
    expect(runStatus?.status).toBe("aborted");
  });

  it("SSE: an EMPTY partial is still aborted — the flags describe the run, not the string", async () => {
    // The likeliest shape of the defect, and the one the first fix missed: a run cut short
    // before it wrote anything sends `content: ""`, so gating the flags on non-empty
    // content let the `run.completed` behind it settle `complete` on the accumulated
    // deltas (raised in review).
    const norm = new HermesNormalizer();
    norm.feed({ event: "assistant.delta", data: JSON.stringify({ delta: "Début" }) });
    const events = norm.feed({
      event: "assistant.completed",
      data: JSON.stringify({ content: "", completed: false, partial: true }),
    });
    const runStatus = events.find((e) => e.type === "run.status") as
      | { status?: string }
      | undefined;
    expect(runStatus?.status).toBe("aborted");
    // …and the text the user already read is kept, not thrown away.
    const final = events.find((e) => e.type === "message.final") as
      | { text?: string }
      | undefined;
    expect(final?.text).toBe("Début");
  });

  it("SSE: a clean assistant.completed still completes", async () => {
    const norm = new HermesNormalizer();
    const events = norm.feed({
      event: "assistant.completed",
      data: JSON.stringify({ content: "voilà", completed: true, interrupted: false }),
    });
    // A snapshot, then the run.completed terminal settles it — nothing is aborted here.
    expect(
      events.some((e) => (e as { status?: string }).status === "aborted"),
    ).toBe(false);
  });
});

describe("interim assistant text is SEALED, not lost (G-43)", () => {
  it("a never-streamed interim segment survives the terminal", async () => {
    const { parts, finals } = await wsTurn((send) => {
      send("message.interim", {
        text: "Je vérifie d'abord la configuration.",
        already_streamed: false,
      });
      send("message.delta", { text: "Réponse finale" });
      send("message.complete", { text: "Réponse finale", status: "complete" });
    });
    const sealed = interimParts(parts);
    expect(sealed, "the segment upstream sends precisely so it is not lost").toHaveLength(
      1,
    );
    expect((sealed[0] as { output?: string }).output).toContain("configuration");
    // …and the reply text is left EXACTLY as the gateway rendered it. Merging the segment
    // in would require guessing whether the final already contains it.
    expect(finals[0]?.text).toBe("Réponse finale");
  });

  it("an ALREADY-STREAMED segment is sealed too — the terminal replaces the buffer", async () => {
    // `already_streamed` says the text went out as deltas; it does NOT say the final will
    // keep it. Upstream's whole reason for the event is that `message.complete` replaces
    // the streaming buffer, so the sealing is what makes the segment survive either way.
    const { parts } = await wsTurn((send) => {
      send("message.delta", { text: "Commentaire en cours" });
      send("message.interim", {
        text: "Commentaire en cours",
        already_streamed: true,
      });
      send("message.complete", { text: "La vraie réponse", status: "complete" });
    });
    expect(interimParts(parts)).toHaveLength(1);
  });

  it("an empty interim is not a segment", async () => {
    const { parts } = await wsTurn((send) => {
      send("message.interim", { text: "", already_streamed: false });
      send("message.complete", { text: "ok", status: "complete" });
    });
    expect(interimParts(parts)).toEqual([]);
  });
});
