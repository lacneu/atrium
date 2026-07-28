/// <reference types="vitest" />
// Hermes turn LIFECYCLE contract (codex P1/P2): /send resolves on ACCEPTANCE
// (not full generation), and a pre-stream dispatch failure creates NO assistant
// message (Convex's failDispatch owns the single error bubble — no orphan, no
// double bubble). Uses a fake client + a spy writer.

import { describe, expect, it, vi } from "vitest";
import { runHermesTurn } from "../src/providers/hermes/turn.js";
import type { HermesClient } from "../src/providers/hermes/client.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { HermesError } from "../src/providers/hermes/client.js";
import { invalidateSession } from "../src/core/dispatch-deadline.js";

function spyWriter() {
  const calls: string[] = [];
  const writer = {
    startAssistant: async () => {
      calls.push("startAssistant");
      return "msg-1";
    },
    appendDelta: async () => {},
    setSnapshot: async () => true,
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

describe("a silent REST stream settles instead of hanging (lot 30)", () => {
  // The acceptance phase was bounded; the BODY was "deliberately unbounded". A provider
  // holding the connection open and saying nothing therefore left the turn waiting for
  // Convex's stuck-stream watchdog — twelve minutes. Nothing had ever exercised it.

  /** A writer that records what `finalize` was actually told — the shared spy above
   *  keeps only the call NAME, and the whole point here is the named cause. */
  function detailWriter(
    finals: Array<{ status?: string; errorKind?: string }>,
  ): ConvexWriter {
    return {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addPart: async () => {},
      addMedia: async () => {},
      addProvenancePart: async () => {},
      finalize: async (
        _id: string,
        status: string,
        _text?: string,
        _error?: string | null,
        errorKind?: string | null,
      ) => {
        finals.push({ status, errorKind: errorKind ?? undefined });
      },
      reportSessionMeta: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    } as unknown as ConvexWriter;
  }

  /** A client whose stream emits `firstFrames` and then only ends when the caller's own
   *  signal aborts it — the shape of a provider that starts answering and goes quiet. */
  function silentClient(
    seen: { signal?: AbortSignal },
    firstFrames: { event: string; data: string }[] = [],
    stopped: string[] = [],
  ): HermesClient {
    return {
      ensureSession: async () => "api_1_abcd",
      stopRun: async (runId: string) => {
        stopped.push(runId);
      },
      openStream: async (_sid: string, _text: string, signal?: AbortSignal) => {
        seen.signal = signal;
        return {} as Response;
      },
      readStream: (
        _res: Response,
        onFrame: (f: { event: string; data: string }) => void,
      ) =>
        new Promise((_resolve, reject) => {
          for (const f of firstFrames) onFrame(f);
          const s = seen.signal;
          if (!s) return;
          s.addEventListener(
            "abort",
            () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            },
            { once: true },
          );
        }),
    } as unknown as HermesClient;
  }

  it("asks Hermes to STOP the run it can no longer see", async () => {
    // Cancelling the HTTP read stops US reading, not Hermes running — the abort path
    // sends `stopRun` for exactly that reason, and the timeout path had the same
    // asymmetry the WS path carried until lot 29.
    vi.useFakeTimers();
    try {
      const finals: Array<{ status?: string; errorKind?: string }> = [];
      const stopped: string[] = [];
      const run = runHermesTurn({
        client: silentClient(
          {},
          [{ event: "run.started", data: '{"run_id":"run-77"}' }],
          stopped,
        ),
        writer: detailWriter(finals),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "hello",
      });
      await run.accepted;
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      expect(stopped).toEqual(["run-77"]);
      expect(finals[0]?.errorKind).toBe("response_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles response_timeout, and drops the session BEFORE settling", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const finals: Array<{ status?: string; errorKind?: string }> = [];
      const writer = detailWriter(finals);
      const run = runHermesTurn({
        client: silentClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "hello",
        onSessionUntrusted: async () => {
          order.push("untrusted");
        },
      });
      await run.accepted;
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      order.push("settled");
      expect(order).toEqual(["untrusted", "settled"]);
      expect(finals).toHaveLength(1);
      expect(finals[0]?.status).toBe("error");
      expect(finals[0]?.errorKind).toBe("response_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a user Stop stays an ABORT — the two share an AbortError and must not be confused", async () => {
    vi.useFakeTimers();
    try {
      const finals: Array<{ status?: string; errorKind?: string }> = [];
      const writer = detailWriter(finals);
      const dropped: string[] = [];
      const external = new AbortController();
      const run = runHermesTurn({
        client: silentClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "hello",
        signal: external.signal,
        onSessionUntrusted: async () => {
          dropped.push("x");
        },
      });
      await run.accepted;
      external.abort();
      await vi.advanceTimersByTimeAsync(10);
      await run.done;
      // A user Stop is Convex's to finalize (optimistic): the bridge writes no terminal
      // here, and it certainly does not throw the session away.
      expect(finals).toEqual([]);
      expect(dropped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the invalidation must not fail quietly (lot 30)", () => {
  it("retries once, and says so loudly when it still fails", async () => {
    // The callback clears the PERSISTED binding, and the next send prefers that persisted
    // value over the in-memory registry already forgotten. A swallowed failure therefore
    // hands the suspect session back — the one outcome this path exists to prevent.
    const attempts: number[] = [];
    const errors: unknown[] = [];
    const spy = console.error;
    console.error = (...a: unknown[]) => errors.push(a[0]);
    try {
      await invalidateSession(async () => {
        attempts.push(attempts.length + 1);
        throw new Error("convex down");
      }, "test");
    } finally {
      console.error = spy;
    }
    expect(attempts).toEqual([1, 2]);
    expect(String(errors[errors.length - 1])).toContain("GIVING UP");
  });

  it("stops retrying as soon as it succeeds", async () => {
    let calls = 0;
    await invalidateSession(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    }, "test");
    expect(calls).toBe(2);
  });

  it("does nothing when no callback is supplied", async () => {
    await expect(invalidateSession(undefined, "test")).resolves.toBeUndefined();
  });
});
