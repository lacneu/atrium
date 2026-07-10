/// <reference types="vitest" />
// Hermes turn LIFECYCLE contract (codex P1/P2): /send resolves on ACCEPTANCE
// (not full generation), and a pre-stream dispatch failure creates NO assistant
// message (Convex's failDispatch owns the single error bubble — no orphan, no
// double bubble). Uses a fake client + a spy writer.

import { describe, expect, it } from "vitest";
import { runHermesTurn } from "../src/providers/hermes/turn.js";
import type { HermesClient } from "../src/providers/hermes/client.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { HermesError } from "../src/providers/hermes/client.js";

function spyWriter() {
  const calls: string[] = [];
  const writer = {
    startAssistant: async () => {
      calls.push("startAssistant");
      return "msg-1";
    },
    appendDelta: async () => {},
    setSnapshot: async () => {},
    addPart: async () => {},
    addMedia: async () => {},
    addProvenancePart: async () => {},
    finalize: async () => {
      calls.push("finalize");
    },
    reportSessionMeta: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  return { writer, calls };
}

/** A fake client whose openStream either resolves (then emits `frames`) or
 *  throws. `sentTexts` records the prompt of every openStream attempt (the
 *  404-recovery rehydration contract asserts on it). */
function fakeClient(opts: {
  openError?: HermesError;
  frames?: { event: string; data: string }[];
  open404Once?: boolean;
  sentTexts?: string[];
}): HermesClient {
  let opens = 0;
  return {
    ensureSession: async () => "api_1_abcd",
    openStream: async (_sid: string, text: string) => {
      opens++;
      opts.sentTexts?.push(text);
      if (opts.open404Once && opens === 1) {
        throw new HermesError("gone", "HTTP_ERROR", 404);
      }
      if (opts.openError) throw opts.openError;
      return {} as Response;
    },
    readStream: async (
      _res: Response,
      onFrame: (f: { event: string; data: string }) => void,
    ) => {
      for (const f of opts.frames ?? []) onFrame(f);
    },
  } as unknown as HermesClient;
}

describe("Hermes turn lifecycle", () => {
  it("a vanished session (404) auto-recovers with a fresh session and succeeds", async () => {
    const { writer, calls } = spyWriter();
    const bound: string[] = [];
    const run = runHermesTurn({
      client: fakeClient({
        open404Once: true,
        frames: [{ event: "run.completed", data: "{}" }],
      }),
      writer,
      chatId: "c1",
      sessionKey: "hermes:a:chat:u:c1",
      providerChatId: "api_1_abcd", // reused id that 404s
      text: "hi",
      onBoundSession: async (sid) => {
        bound.push(sid);
      },
    });
    await run.accepted; // recovered → accepted resolves
    await run.done;
    expect(calls).toContain("startAssistant");
    expect(bound.length).toBe(1); // the fresh session was persisted
  });

  it("the 404-recovery re-sends the prompt WITH the rehydration history (the real session is brand new)", async () => {
    const { writer } = spyWriter();
    const sentTexts: string[] = [];
    const run = runHermesTurn({
      client: fakeClient({
        open404Once: true,
        frames: [{ event: "run.completed", data: "{}" }],
        sentTexts,
      }),
      writer,
      chatId: "c1",
      sessionKey: "hermes:a:chat:u:c1",
      providerChatId: "api_1_abcd", // expected warm → bare prompt first
      text: "Et maintenant ?",
      freshText: async () => "[HISTORIQUE]\n\nEt maintenant ?",
    });
    await run.accepted;
    await run.done;
    // Attempt 1 (warm assumption) shipped bare; the recovery attempt carried
    // the history — the minted session must not start cold.
    expect(sentTexts).toEqual([
      "Et maintenant ?",
      "[HISTORIQUE]\n\nEt maintenant ?",
    ]);
  });

  it("a minted session is persisted only AFTER acceptance — a failed first send stays fresh for the retry", async () => {
    const { writer } = spyWriter();
    const bound: string[] = [];
    const run = runHermesTurn({
      client: fakeClient({
        openError: new HermesError("boom", "HTTP_ERROR", 500),
      }),
      writer,
      chatId: "c1",
      sessionKey: "hermes:a:chat:u:c1",
      providerChatId: null, // turn 1: the session is minted by this turn
      text: "hi",
      onBoundSession: async (sid) => {
        bound.push(sid);
      },
    });
    await expect(run.accepted).rejects.toThrow(/boom/);
    await run.done;
    // NOT persisted: the prompt never reached the session, so the retry must
    // mint fresh (and re-carry the history) instead of resuming a virgin
    // session as warm.
    expect(bound.length).toBe(0);
  });

  it("a pre-stream dispatch failure REJECTS accepted and creates NO message (codex P2)", async () => {
    const { writer, calls } = spyWriter();
    const run = runHermesTurn({
      client: fakeClient({
        openError: new HermesError("nope", "UNAUTHORIZED", 401),
      }),
      writer,
      chatId: "c1",
      sessionKey: "hermes:a:chat:u:c1",
      providerChatId: "api_1_abcd",
      text: "hi",
    });
    await expect(run.accepted).rejects.toThrow(/nope/);
    await run.done;
    // No assistant message was created → Convex failDispatch owns the bubble.
    expect(calls).not.toContain("startAssistant");
    expect(calls).not.toContain("finalize");
  });

  it("a beginTurn failure REJECTS accepted → /send 502 (chat opened before ACK)", async () => {
    const writer = {
      startAssistant: async () => {
        throw new Error("convex down");
      },
    } as unknown as ConvexWriter;
    const run = runHermesTurn({
      client: fakeClient({ frames: [{ event: "run.started", data: '{"run_id":"r"}' }] }),
      writer,
      chatId: "c1",
      sessionKey: "hermes:a:chat:u:c1",
      providerChatId: "api_1_abcd",
      text: "hi",
    });
    // beginTurn (the streaming row) runs BEFORE accepted resolves — its failure
    // rejects accepted so /send returns 502, and cancels the accepted stream.
    await expect(run.accepted).rejects.toThrow(/convex down/);
    await run.done; // must not hang
  });

  it("accepted resolves once the stream is taken; done resolves after the drain", async () => {
    const { writer, calls } = spyWriter();
    const run = runHermesTurn({
      client: fakeClient({
        frames: [
          { event: "assistant.delta", data: '{"text":"Hi"}' },
          { event: "run.completed", data: "{}" },
        ],
      }),
      writer,
      chatId: "c1",
      sessionKey: "hermes:a:chat:u:c1",
      providerChatId: "api_1_abcd",
      text: "hi",
    });
    await run.accepted; // resolves AFTER the streaming row is opened (chat busy)
    expect(calls).toContain("startAssistant");
    await run.done;
    expect(calls).toContain("finalize");
  });
});
