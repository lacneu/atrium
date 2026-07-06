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

/** A fake client whose openStream either resolves (then emits `frames`) or throws. */
function fakeClient(opts: {
  openError?: HermesError;
  frames?: { event: string; data: string }[];
  open404Once?: boolean;
}): HermesClient {
  let opens = 0;
  return {
    ensureSession: async () => "api_1_abcd",
    openStream: async () => {
      opens++;
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
