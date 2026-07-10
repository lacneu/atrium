/// <reference types="vitest" />
// Hermes WS transport, bound to the LIVE-CAPTURED JSON-RPC exchange
// (test/fixtures/hermes/ws-capture.jsonl — a real WS_PONG turn, 2026-07-06).
// Contract pinned here: prompt.submit ACK = acceptance (chat busy first),
// message.delta streams, thinking.delta NEVER reaches the reply, and
// message.complete finalizes with usage → reportSessionMeta.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
    finalize: async (_id: string, status: string) => {
      calls.push(["finalize", status]);
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
