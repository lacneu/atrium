/// <reference types="vitest" />
// Hermes WS transport, bound to the LIVE-CAPTURED JSON-RPC exchange
// (test/fixtures/hermes/ws-capture.jsonl — a real WS_PONG turn, 2026-07-06).
// Contract pinned here: prompt.submit ACK = acceptance (chat busy first),
// message.delta streams, thinking.delta NEVER reaches the reply, and
// message.complete finalizes with usage → reportSessionMeta.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runHermesWsTurn, isHermesWsStoredSessionId } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Replay the captured event stream (in-frames after the submit ACK). */
function capturedEvents(): Array<{ type: string; sid: string; payload: Record<string, unknown> }> {
  const lines = readFileSync(join(__dirname, "fixtures/hermes/ws-capture.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { dir: string; frame: Record<string, unknown> });
  const out: Array<{ type: string; sid: string; payload: Record<string, unknown> }> = [];
  for (const { dir, frame } of lines) {
    if (dir !== "in" || frame.method !== "event") continue;
    const p = frame.params as Record<string, unknown>;
    const type = String(p.type ?? "");
    if (type === "gateway.ready") continue;
    out.push({
      type,
      sid: String(p.session_id ?? ""),
      payload: (p.payload ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

function spyWriter() {
  const calls: Array<[string, unknown]> = [];
  const writer = {
    startAssistant: async () => {
      calls.push(["startAssistant", null]);
      return "msg-1";
    },
    appendDelta: async (_id: string, text: string) => {
      calls.push(["appendDelta", text]);
    },
    setSnapshot: async (_id: string, text: string) => {
      calls.push(["setSnapshot", text]);
    },
    addPart: async (_id: string, part: unknown) => {
      calls.push(["addPart", part]);
    },
    addToolPart: async (_id: string, part: unknown) => {
      calls.push(["addToolPart", part]);
    },
    setPhase: (_id: string, phase: string) => {
      calls.push(["setPhase", phase]);
    },
    finalize: async (
      _id: string,
      status: string,
      text?: string,
      error?: string | null,
      errorKind?: string | null,
    ) => {
      calls.push(["finalize", status]);
      calls.push(["finalizeDetail", { status, text, error, errorKind }]);
    },
    reportSessionMeta: async (_chatId: string, meta: unknown) => {
      calls.push(["reportSessionMeta", meta]);
    },
    heartbeat: async () => {
      calls.push(["heartbeat", null]);
    },
    upsertSubAgent: async (record: unknown) => {
      calls.push(["upsertSubAgent", record]);
    },
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  return { writer, calls };
}

function fakeWsClient(opts: {
  submitError?: Error;
  resumeError?: Error;
  /** Records every prompt.submit text (the recovery-rehydration contract). */
  submittedTexts?: string[];
}): HermesWsClient {
  return {
    call: async (method: string, params?: Record<string, unknown>) => {
      if (method === "session.resume") {
        if (opts.resumeError) throw opts.resumeError;
        return {
          session_id: "resumed01",
          stored_session_id: (params as { session_id?: string })?.session_id,
        };
      }
      if (method === "session.create") {
        return { session_id: "cc4ebdee", stored_session_id: "20260706_212939_aee24e" };
      }
      if (method === "prompt.submit") {
        opts.submittedTexts?.push(
          String((params as { text?: string })?.text ?? ""),
        );
        if (opts.submitError) throw opts.submitError;
        return { status: "streaming" };
      }
      return {};
    },
  } as unknown as HermesWsClient;
}

describe("isHermesWsStoredSessionId", () => {
  it("accepts the live stored id shape, rejects REST ids + routing nonces", () => {
    expect(isHermesWsStoredSessionId("20260706_212939_aee24e")).toBe(true);
    expect(isHermesWsStoredSessionId("api_1783351043_b99e6df2")).toBe(false);
    expect(isHermesWsStoredSessionId("turn:alice:msg_1")).toBe(false);
    expect(isHermesWsStoredSessionId(null)).toBe(false);
  });
});

describe("Hermes WS turn (live capture replay)", () => {
  it("streams the captured WS_PONG turn end-to-end into the sink", async () => {
    const { writer, calls } = spyWriter();
    const bound: string[] = [];
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "hermes:hermes-agent:chat:u:c1",
        providerChatId: null,
        text: "Reponds exactement: WS_PONG",
        onBoundSession: async (sid) => {
          bound.push(sid);
        },
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted; // ACK — the streaming row already exists (chat busy)
    expect(calls.map(([n]) => n)).toContain("startAssistant");
    expect(bound).toEqual(["20260706_212939_aee24e"]); // stored id persisted
    // Replay the REAL captured events.
    for (const ev of capturedEvents()) onEvent(ev.type, ev.payload);
    await run.done;
    const names = calls.map(([n]) => n);
    expect(names).toContain("finalize");
    // The reply text is exactly the captured deltas ("WS" + "_P" + "ONG" …).
    const deltas = calls.filter(([n]) => n === "appendDelta").map(([, t]) => t);
    expect(deltas.join("")).toBe("WS_PONG");
    // thinking.delta noise ("( ˘⌣˘)♡ brainstorming...") must NEVER be a delta.
    expect(deltas.join("")).not.toMatch(/brainstorming/);
    // usage → the session-meta channel with the REAL numbers and the RIGHT
    // semantics: totalTokens = context_used (15968), contextTokens = the
    // WINDOW context_max (272000) → the captured 6% pressure.
    const metas = calls.filter(([n]) => n === "reportSessionMeta").map(([, m]) => m);
    expect(
      metas.some(
        (m) =>
          (m as { totalTokens?: number }).totalTokens === 15968 &&
          (m as { contextTokens?: number }).contextTokens === 272000,
      ),
    ).toBe(true);
    // model/provider from session.info.
    expect(
      metas.some((m) => (m as { model?: string }).model === "gpt-5.5"),
    ).toBe(true);
  });

  it("replays the live TOOLS turn: tool.start/complete surface as tool parts (name only)", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "ls",
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    const lines = readFileSync(
      join(__dirname, "fixtures/hermes/ws-tools.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { dir: string; frame: Record<string, unknown> });
    for (const { dir, frame } of lines) {
      if (dir !== "in" || frame.method !== "event") continue;
      const p = frame.params as Record<string, unknown>;
      const type = String(p.type ?? "");
      if (type === "gateway.ready") continue;
      onEvent(type, (p.payload ?? {}) as Record<string, unknown>);
    }
    await run.done;
    const parts = calls.filter(([n]) => n === "addToolPart");
    // The captured terminal tool surfaced, NAME only (no args/output).
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(parts)).toContain("terminal");
    expect(JSON.stringify(parts)).not.toContain("exit_code");
    expect(calls.map(([n]) => n)).toContain("finalize");
  });

  it("status.update kind=compacting surfaces Atrium's compaction marker", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "long",
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    onEvent("status.update", { kind: "compacting", text: "Summarizing…" });
    onEvent("message.complete", { text: "done", status: "complete" });
    await run.done;
    // The sink translated it (setPhase compacting and/or a marker part).
    const names = calls.map(([n]) => n);
    expect(
      names.includes("setPhase") || names.includes("addPart"),
    ).toBe(true);
  });

  it("a FAILED resume recovers with a fresh session that carries the rehydration history", async () => {
    const { writer } = spyWriter();
    const bound: string[] = [];
    const submittedTexts: string[] = [];
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({
          resumeError: new Error("session not found"),
          submittedTexts,
        }),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: "20260101_000000_dead", // stored id that no longer resumes
        text: "Et maintenant ?",
        freshText: async () => "[HISTORIQUE]\n\nEt maintenant ?",
        onBoundSession: async (sid) => {
          bound.push(sid);
        },
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    // The minted session received the HISTORY-carrying prompt, not the bare
    // warm-assumption one — the recovered agent must not start cold.
    expect(submittedTexts).toEqual(["[HISTORIQUE]\n\nEt maintenant ?"]);
    // …and the fresh stored id was persisted (post-ACK).
    expect(bound).toEqual(["20260706_212939_aee24e"]);
    onEvent("message.complete", { text: "ok", status: "complete" });
    await run.done;
  });

  it("a minted session is NOT persisted when prompt.submit fails — the retry must stay fresh", async () => {
    const { writer, calls } = spyWriter();
    const bound: string[] = [];
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({ submitError: new Error("socket died") }),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "hi",
        onBoundSession: async (sid) => {
          bound.push(sid);
        },
      },
      () => () => {},
    );
    await run.accepted; // bridge-owned error settle still ACKs (single bubble)
    await run.done;
    // The prompt never reached the session: persisting the id would make the
    // NEXT send resume a virgin session as warm (bare prompt → cold agent).
    expect(bound.length).toBe(0);
    expect(calls.map(([n]) => n)).toContain("finalize");
  });

  it("replays the live DELEGATION turn: subagent events drive the awaiting pill + delegate_task tool part", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "delegue",
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    const lines = readFileSync(
      join(__dirname, "fixtures/hermes/ws-subagent.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { dir: string; frame: Record<string, unknown> });
    for (const { dir, frame } of lines) {
      if (dir !== "in" || frame.method !== "event") continue;
      const p = frame.params as Record<string, unknown>;
      const type = String(p.type ?? "");
      if (type === "gateway.ready") continue;
      onEvent(type, (p.payload ?? {}) as Record<string, unknown>);
    }
    await run.done;
    const phases = calls.filter(([n]) => n === "setPhase").map(([, v]) => v);
    expect(phases).toContain("awaiting_subagents");
    expect(phases).toContain("generating");
    // The delegate_task spawn surfaced as a tool part.
    expect(JSON.stringify(calls.filter(([n]) => n === "addToolPart"))).toContain(
      "delegate_task",
    );
    // The child fed the STRUCTURED monitor: start (running, goal+model+depth)
    // then complete (done + resultText from the live capture).
    const ups = calls
      .filter(([n]) => n === "upsertSubAgent")
      .map(([, r]) => r as { status: string; resultText?: string; taskName?: string });
    expect(ups.some((r) => r.status === "running" && (r.taskName ?? "").includes("Calculer"))).toBe(true);
    expect(ups.some((r) => r.status === "done" && r.resultText === "42")).toBe(true);
    expect(calls.map(([n]) => n)).toContain("finalize");
  });

  it("long pure-reasoning stretches heartbeat the row (thinking pill, watchdog-safe)", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "think hard",
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    // A burst of thinking deltas → exactly ONE phase beat (throttled 60s).
    for (let i = 0; i < 5; i++) onEvent("thinking.delta", { text: "…" });
    onEvent("message.complete", { text: "done", status: "complete" });
    await run.done;
    // Exactly ONE watchdog heartbeat (throttled) driven by the real reasoning
    // frames, plus the working pill.
    expect(calls.filter(([n]) => n === "heartbeat").length).toBe(1);
    expect(
      calls.filter(([n, v]) => n === "setPhase" && v === "querying_gateway").length,
    ).toBe(1);
  });

  it("replays the live MoA turn: reference + aggregator cards feed the monitor", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "pourquoi le ciel est bleu ?",
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    const lines = readFileSync(
      join(__dirname, "fixtures/hermes/ws-moa.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { dir: string; frame: Record<string, unknown> });
    for (const { dir, frame } of lines) {
      if (dir !== "in" || frame.method !== "event") continue;
      const p = frame.params as Record<string, unknown>;
      const type = String(p.type ?? "");
      if (type === "gateway.ready") continue;
      onEvent(type, (p.payload ?? {}) as Record<string, unknown>);
    }
    await run.done;
    const ups = calls
      .filter(([n]) => n === "upsertSubAgent")
      .map(([, r]) => r as { taskName?: string; status: string; resultText?: string; childSessionKey: string });
    // Both captured references, DONE with their text, labelled i/n.
    expect(ups.filter((r) => (r.taskName ?? "").startsWith("MoA 1/2")).length).toBe(1);
    expect(ups.filter((r) => (r.taskName ?? "").startsWith("MoA 2/2")).length).toBe(1);
    expect(ups.some((r) => (r.resultText ?? "").includes("diffuse"))).toBe(true);
    // The aggregator card opens running then closes done at message.complete.
    const agg = ups.filter((r) => r.childSessionKey.endsWith(":aggregate"));
    expect(agg.some((r) => r.status === "running")).toBe(true);
    expect(agg.some((r) => r.status === "done")).toBe(true);
    expect(calls.map(([n]) => n)).toContain("finalize");
  });

  it("a sub-agent terminal arriving AFTER the parent's final still reaches the monitor (live order)", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "delegue",
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    onEvent("subagent.start", {
      goal: "calc",
      child_session_id: "kid1",
      depth: 0,
      model: "m",
    });
    // The PARENT finishes FIRST (live-observed order)…
    onEvent("message.complete", { text: "= 100", status: "complete" });
    await run.done;
    // …then the child's terminal arrives late: it must still flip the card.
    onEvent("subagent.complete", {
      child_session_id: "kid1",
      status: "completed",
      text: "100",
      summary: "100",
    });
    await new Promise((r) => setTimeout(r, 10));
    const ups = calls
      .filter(([n]) => n === "upsertSubAgent")
      .map(([, r]) => r as { status: string; resultText?: string });
    expect(ups.some((r) => r.status === "done" && r.resultText === "100")).toBe(true);
  });

  it("a refused prompt.submit settles the row as error and RESOLVES (single bubble)", async () => {
    const { writer, calls } = spyWriter();
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({ submitError: new Error("session busy [RPC_ERROR]") }),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null,
        text: "hi",
      },
      () => () => {},
    );
    // The row already exists → the bridge owns the error (finalized onto the
    // row); /send returns 200 so Convex does NOT add a second failDispatch
    // bubble (codex P2).
    await run.accepted;
    await run.done;
    expect(calls.map(([n]) => n)).toContain("finalize");
  });

  it("flushes a tool left open (lost tool.complete) when the turn settles", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "c1",
        sessionKey: "hermes:hermes-agent:chat:u:c1",
        providerChatId: null,
        text: "tool sans complete",
        onBoundSession: async () => {},
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    onEvent("message.start", {});
    onEvent("tool.start", { name: "web_search", tool_id: "t1" });
    // NO tool.complete — the completion event was lost.
    onEvent("message.complete", { text: "done", usage: {} });
    await run.done;
    const phases = calls
      .filter(([n]) => n === "addToolPart")
      .map(([, part]) => {
        const p = part as { name?: string; phase?: string };
        return `${p.name}:${p.phase}`;
      });
    expect(phases).toContain("web_search:start");
    // The settle path emitted the terminal phase for the still-open tool.
    expect(phases).toContain("web_search:completed");
  });

});

describe("WS failure-prose promotion + transient classification (codex P2)", () => {
  it("failure prose streamed as deltas then a bare `error` event: promoted, classified, zero text", async () => {
    const { writer, calls } = spyWriter();
    let onEvent!: (type: string, payload: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: fakeWsClient({}),
        writer,
        chatId: "cerr",
        sessionKey: "hermes:hermes-agent:chat:u:cerr",
        providerChatId: null,
        text: "ping",
        onBoundSession: async () => {},
      },
      (_sid, cb) => {
        onEvent = cb;
        return () => {};
      },
    );
    await run.accepted;
    onEvent("message.delta", { text: "API call failed after 3 retries: Connection error" });
    onEvent("error", {});
    await run.done;
    const fin = calls.find(([n]) => n === "finalizeDetail");
    expect(fin).toBeDefined();
    const d = (fin as [string, Record<string, unknown>])[1];
    expect(d.status).toBe("error");
    expect(d.text).toBe(""); // prose never persisted as the reply
    expect(String(d.error)).toContain("API call failed after 3 retries");
    expect(d.errorKind).toBe("provider_internal");
  });
});

describe("a silent provider settles the turn instead of hanging (lot 29)", () => {
  // Until this deadline, `await turnDone` had NO bound: a dropped frame or a stalled
  // gateway left the row `streaming` until Convex's stuck-stream watchdog reaped it —
  // up to twelve minutes of "Réflexion…" for someone waiting on an answer already lost.

  it("settles response_timeout after the silence budget, with a named cause", async () => {
    vi.useFakeTimers();
    try {
      const { writer, calls } = spyWriter();
      const run = runHermesWsTurn(
        {
          client: fakeWsClient({}),
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
        },
        () => () => {},
      );
      await run.accepted;
      expect(calls.map(([n]) => n)).toContain("startAssistant");
      // …and then nothing at all arrives.
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      const detail = calls.find(([n]) => n === "finalizeDetail")?.[1] as
        | { status?: string; errorKind?: string }
        | undefined;
      expect(detail?.status).toBe("error");
      expect(detail?.errorKind).toBe("response_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ANY event re-arms it — a slow turn that keeps reporting is not a stalled one", async () => {
    vi.useFakeTimers();
    try {
      const { writer, calls } = spyWriter();
      let onEvent!: (type: string, payload: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client: fakeWsClient({}),
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
        },
        (_sid, cb) => {
          onEvent = cb;
          return () => {};
        },
      );
      await run.accepted;
      // Three quarters of the budget, an event, three quarters again: a turn that would
      // have died on a fixed timer survives on a re-armed one.
      await vi.advanceTimersByTimeAsync(180_000);
      onEvent("message.delta", { text: "still here" });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.map(([n]) => n)).not.toContain("finalize");
      // …and it still settles once the provider really goes quiet.
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      expect(calls.map(([n]) => n)).toContain("finalize");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT run during the pre-ACK staging — the prompt still goes out", async () => {
    // The deadline used to be armed at SUBSCRIBE, before beginTurn, the attachment
    // staging and prompt.submit — a sequence the code documents as able to take minutes.
    // It would then finalize the bubble `response_timeout` and let the prompt go out
    // anyway: the user told the turn failed while the gateway ran it, and a retry
    // duplicating any side effect. Staging has its own budget (PRE_SEND_DEADLINE_MS);
    // this deadline starts when the provider has accepted and owes us a reply.
    vi.useFakeTimers();
    try {
      const { writer, calls } = spyWriter();
      let releaseSubmit!: () => void;
      const slowSubmit = new Promise<void>((res) => {
        releaseSubmit = res;
      });
      const submitted: string[] = [];
      const client = {
        call: async (method: string, params?: Record<string, unknown>) => {
          if (method === "session.create") {
            return { session_id: "cc4ebdee", stored_session_id: "stored-1" };
          }
          if (method === "prompt.submit") {
            await slowSubmit; // staging/upload takes "minutes"
            submitted.push(String((params as { text?: string })?.text ?? ""));
            return { status: "streaming" };
          }
          return {};
        },
      } as unknown as HermesWsClient;

      const run = runHermesWsTurn(
        {
          client,
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
        },
        () => () => {},
      );
      // Far past the silence budget, while the submit is still in flight.
      await vi.advanceTimersByTimeAsync(240_000 * 2);
      expect(calls.map(([n]) => n)).not.toContain("finalize");
      // …and the prompt is still delivered, not abandoned behind an error.
      releaseSubmit();
      await run.accepted;
      expect(submitted).toEqual(["hello"]);
      // Only NOW does the clock start.
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      const detail = calls.find(([n]) => n === "finalizeDetail")?.[1] as
        | { errorKind?: string }
        | undefined;
      expect(detail?.errorKind).toBe("response_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a PRE-ACK event cannot start the clock either", async () => {
    // Arming after the ACK was not enough on its own: the callback re-arms on every
    // frame, and a frame can land while `prompt.submit` is still in flight — the same
    // divergence through the other door. The previous test could not see this one: its
    // `registerSession` discarded the callback, so no pre-ACK event could be injected.
    vi.useFakeTimers();
    try {
      const { writer, calls } = spyWriter();
      let releaseSubmit!: () => void;
      const slowSubmit = new Promise<void>((res) => {
        releaseSubmit = res;
      });
      const client = {
        call: async (method: string) => {
          if (method === "session.create") {
            return { session_id: "cc4ebdee", stored_session_id: "stored-1" };
          }
          if (method === "prompt.submit") {
            await slowSubmit;
            return { status: "streaming" };
          }
          return {};
        },
      } as unknown as HermesWsClient;
      let onEvent!: (type: string, payload: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client,
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
        },
        (_sid, cb) => {
          onEvent = cb;
          return () => {};
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      onEvent("session.info", { model: "gpt-5.5" }); // arrives BEFORE the ACK
      await vi.advanceTimersByTimeAsync(240_000 * 2);
      expect(calls.map(([n]) => n)).not.toContain("finalize");
      releaseSubmit();
      await run.accepted;
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      const detail = calls.find(([n]) => n === "finalizeDetail")?.[1] as
        | { errorKind?: string }
        | undefined;
      expect(detail?.errorKind).toBe("response_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-conforming ACK is still BOUNDED, but never binds the session", async () => {
    // Two separate questions, and conflating them was my own error: refusing to arm the
    // clock on an unrecognised ACK left the turn awaiting its terminal with no deadline
    // at all — the `finally` never ran, so the session stayed subscribed and the run
    // held, per chat. Waiting forever leaks; a bounded wait that might be wrong at least
    // ends. What the ACK decides is the session BIND: a prompt that may never have been
    // delivered must not leave its session remembered as warm, or the next turn resumes
    // a virgin session without re-carrying the history.
    for (const ack of [{}, { status: "error" }, "streaming", null]) {
      vi.useFakeTimers();
      try {
        const { writer, calls } = spyWriter();
        const bound: string[] = [];
        const interrupted: string[] = [];
        const client = {
          call: async (method: string, params?: Record<string, unknown>) => {
            if (method === "session.create") {
              return { session_id: "cc4ebdee", stored_session_id: "s1" };
            }
            if (method === "prompt.submit") return ack;
            if (method === "session.interrupt") {
              interrupted.push(String((params as { session_id?: string })?.session_id));
            }
            return {};
          },
        } as unknown as HermesWsClient;
        const run = runHermesWsTurn(
          {
            client,
            writer,
            chatId: "c1",
            sessionKey: "k",
            providerChatId: null,
            text: "hello",
            onBoundSession: async (sid) => {
              bound.push(sid);
            },
          },
          () => () => {},
        );
        await run.accepted;
        await vi.advanceTimersByTimeAsync(240_000 + 1_000);
        await run.done;
        const detail = calls.find(([n]) => n === "finalizeDetail")?.[1] as
          | { errorKind?: string }
          | undefined;
        expect(detail?.errorKind, JSON.stringify(ack)).toBe("response_timeout");
        expect(bound, JSON.stringify(ack)).toEqual([]);
        // …and the provider is told, so a run that was actually alive stops.
        expect(interrupted, JSON.stringify(ack)).toEqual(["cc4ebdee"]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("the timed-out session is dropped BEFORE the turn settles", async () => {
    // The interrupt is best-effort and may still be in flight, so the next send must not
    // be able to resume this session and race a run that never stopped. Ordering is the
    // guarantee: while the handler runs the chat is still busy, so no later turn exists
    // whose binding the epoch bump could land under.
    vi.useFakeTimers();
    try {
      const { writer, calls } = spyWriter();
      const order: string[] = [];
      const run = runHermesWsTurn(
        {
          client: fakeWsClient({}),
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
          onSessionUntrusted: async () => {
            order.push("untrusted");
          },
        },
        () => () => {},
      );
      await run.accepted;
      const finalizeAt = () => calls.findIndex(([n]) => n === "finalize");
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      await run.done;
      order.push("settled");
      expect(order).toEqual(["untrusted", "settled"]);
      expect(finalizeAt()).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a turn that ends NORMALLY never drops its session", async () => {
    // Only silence is ambiguous. A delivered answer — or a delivered gateway error —
    // says the run is over, and clearing there would cost a rehydration every time.
    vi.useFakeTimers();
    try {
      const { writer } = spyWriter();
      let onEvent!: (type: string, payload: Record<string, unknown>) => void;
      const dropped: string[] = [];
      const run = runHermesWsTurn(
        {
          client: fakeWsClient({}),
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
          onSessionUntrusted: async () => {
            dropped.push("x");
          },
        },
        (_sid, cb) => {
          onEvent = cb;
          return () => {};
        },
      );
      await run.accepted;
      for (const ev of capturedEvents()) onEvent(ev.type, ev.payload);
      await run.done;
      expect(dropped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Stop landing DURING the invalidation still takes the turn", async () => {
    // `finalized` is set LAST on purpose. Setting it first made a concurrent `/abort` a
    // no-op — forceSettle returns early on `finalized` — so the abort answered, Convex
    // finalized, and the next send could drain while the clear was still in flight; a
    // late clear could then wipe THAT turn's binding.
    vi.useFakeTimers();
    try {
      const finals: string[] = [];
      const writer = {
        startAssistant: async () => "msg-1",
        appendDelta: async () => {},
        setSnapshot: async () => true,
        addPart: async () => {},
        addToolPart: async () => {},
        setPhase: () => {},
        finalize: async (_id: string, status: string) => {
          finals.push(status);
        },
        reportSessionMeta: async () => {},
        heartbeat: async () => {},
        upsertSubAgent: async () => {},
        getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      } as unknown as ConvexWriter;
      let releaseClear!: () => void;
      const clearing = new Promise<void>((res) => {
        releaseClear = res;
      });
      const run = runHermesWsTurn(
        {
          client: fakeWsClient({}),
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
          onSessionUntrusted: () => clearing,
        },
        () => () => {},
      );
      await run.accepted;
      await vi.advanceTimersByTimeAsync(240_000 + 1_000);
      // The invalidation is in flight and the turn is NOT finalized yet — a Stop can
      // still take it, which is the whole point of the ordering.
      run.forceSettle(true);
      releaseClear();
      await run.done;
      // The user's abort wins; the timeout's own terminal stands down.
      expect(finals).toEqual(["aborted"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a normal turn is untouched — no timer fires, no cause invented", async () => {
    vi.useFakeTimers();
    try {
      const { writer, calls } = spyWriter();
      let onEvent!: (type: string, payload: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client: fakeWsClient({}),
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "hello",
        },
        (_sid, cb) => {
          onEvent = cb;
          return () => {};
        },
      );
      await run.accepted;
      for (const ev of capturedEvents()) onEvent(ev.type, ev.payload);
      await run.done;
      const detail = calls.find(([n]) => n === "finalizeDetail")?.[1] as
        | { status?: string; errorKind?: string }
        | undefined;
      expect(detail?.status).toBe("complete");
      expect(detail?.errorKind ?? null).toBeNull();
      // The deadline must not fire on a settled turn. Counting timers would count the
      // pre-existing late-child grace timer too (2 min, deliberate), so the check is
      // behavioural: long past the budget, nothing else is written.
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(240_000 * 3);
      expect(calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
