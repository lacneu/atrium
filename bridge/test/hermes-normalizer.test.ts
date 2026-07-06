// Hermes SSE parser + normalizer, bound to the LIVE-CAPTURED envelope
// (test/fixtures/hermes/chat-stream-error.sse — a real no-model turn on the
// bench, 2026-07-06). The stable contract verified here: every frame carries
// {session_id, run_id, seq, ts}; the error path finalizes as an actionable
// error PAIR (message.final{error} + run.status{error}). The success delta/tool
// NAMES are pruned against a live success capture (HERMES_EVENT_NAMES) — this
// suite pins the STRUCTURE + envelope, which does not change.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SseParser } from "../src/providers/hermes/sse.js";
import { HermesNormalizer } from "../src/providers/hermes/normalizer.js";
import type { BridgeEvent } from "../src/core/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function frames(sse: string) {
  const p = new SseParser();
  return [...p.push(sse), ...p.end()];
}

describe("Hermes SSE parser", () => {
  it("parses the live-captured error stream into named frames with JSON data", () => {
    const sse = readFileSync(
      join(__dirname, "fixtures/hermes/chat-stream-error.sse"),
      "utf8",
    );
    const fs = frames(sse);
    const names = fs.map((f) => f.event);
    expect(names).toEqual(["run.started", "message.started", "error", "done"]);
    // Every frame's data is JSON carrying the uniform envelope.
    for (const f of fs) {
      const d = JSON.parse(f.data);
      expect(typeof d.session_id).toBe("string");
      expect(typeof d.run_id).toBe("string");
      expect(typeof d.seq).toBe("number");
    }
  });

  it("splits frames across arbitrary chunk boundaries (streaming safety)", () => {
    const sse =
      "event: run.started\ndata: {\"run_id\":\"r1\"}\n\nevent: done\ndata: {}\n\n";
    const p = new SseParser();
    const out: string[] = [];
    // Feed one char at a time — the parser must not lose or duplicate a frame.
    for (const ch of sse) for (const f of p.push(ch)) out.push(f.event);
    for (const f of p.end()) out.push(f.event);
    expect(out).toEqual(["run.started", "done"]);
  });

  it("joins multi-line data and strips the single leading space (SSE spec)", () => {
    const fs = frames("event: x\ndata: line1\ndata: line2\n\n");
    expect(fs[0]?.data).toBe("line1\nline2");
  });
});

describe("SSE CRLF split across chunks (codex P2)", () => {
  it("does not fabricate a blank line when a \\r\\n is split between pushes", () => {
    const p = new SseParser();
    const out: string[] = [];
    // "event: run.started\r\n" split right between \r and \n.
    out.push(...p.push("event: run.started\r").map((f) => f.event));
    out.push(...p.push("\ndata: {\"run_id\":\"r\"}\r\n\r\n").map((f) => f.event));
    out.push(...p.end().map((f) => f.event));
    // Exactly ONE frame — the CRLF split must not emit a premature empty frame.
    expect(out).toEqual(["run.started"]);
  });
});

describe("Hermes normalizer — error path (live-captured)", () => {
  it("the real no-model turn finalizes as an actionable error PAIR", () => {
    const sse = readFileSync(
      join(__dirname, "fixtures/hermes/chat-stream-error.sse"),
      "utf8",
    );
    const n = new HermesNormalizer();
    const out: BridgeEvent[] = [];
    for (const f of frames(sse)) out.push(...n.feed(f));
    const final = out.find((e) => e.type === "message.final") as
      | { text?: string; error?: string }
      | undefined;
    const statuses = out.filter((e) => e.type === "run.status") as Array<{
      status?: string;
    }>;
    expect(final?.error).toMatch(/No inference provider configured/);
    expect(statuses.at(-1)?.status).toBe("error");
    expect(n.currentRunId).toBe("run_3c1016a744ef4156974380ba0c409d91");
    expect(n.isFinalized).toBe(true);
  });

  it("run.started emits a streaming run.status (turn opens)", () => {
    const n = new HermesNormalizer();
    const ev = n.feed({ event: "run.started", data: '{"run_id":"r9"}' });
    expect(ev).toEqual([{ type: "run.status", status: "streaming", runId: "r9" }]);
  });
});

describe("Hermes normalizer — SUCCESS path (live capture 2026-07-06, fixture)", () => {
  it("replays the real PONG turn: deltas stream, snapshot lands, run completes, thinking noise dropped", () => {
    const sse = readFileSync(
      join(__dirname, "fixtures/hermes/chat-stream-success.sse"),
      "utf8",
    );
    const n = new HermesNormalizer();
    const out: BridgeEvent[] = [];
    for (const f of frames(sse)) out.push(...n.feed(f));
    // Deltas: "P" + "ONG" streamed.
    const deltas = out
      .filter((e) => e.type === "message.delta")
      .map((e) => (e as unknown as { text: string }).text);
    expect(deltas).toEqual(["P", "ONG"]);
    // assistant.completed -> authoritative snapshot.
    const snap = out.find((e) => e.type === "message.snapshot") as
      | { text?: string }
      | undefined;
    expect(snap?.text).toBe("PONG");
    // run.completed -> final pair, complete, text PONG.
    const final = out.find((e) => e.type === "message.final") as
      | { text?: string; error?: string }
      | undefined;
    expect(final?.text).toBe("PONG");
    expect(final?.error).toBeUndefined();
    const statuses = out.filter((e) => e.type === "run.status") as Array<{
      status?: string;
    }>;
    expect(statuses.at(-1)?.status).toBe("complete");
    // The `_thinking` tool.progress noise must produce NO tool part (its delta
    // mirrors the reply text — surfacing it would duplicate the answer).
    expect(out.filter((e) => e.type === "tool.status")).toEqual([]);
    expect(n.currentRunId).toMatch(/^run_/);
    expect(n.isFinalized).toBe(true);
  });

  it("a REAL tool in tool.progress surfaces exactly ONE start part (no per-token flood)", () => {
    const n = new HermesNormalizer("r");
    const a = n.feed({ event: "tool.progress", data: '{"tool_name":"terminal","delta":"ls"}' });
    const b = n.feed({ event: "tool.progress", data: '{"tool_name":"terminal","delta":" -la"}' });
    expect(a).toEqual([{ type: "tool.status", name: "terminal", phase: "start", runId: "r" }]);
    expect(b).toEqual([]);
  });
});

describe("Hermes normalizer — success path (structure; names pruned live)", () => {
  it("accumulates deltas and finalizes complete on a terminal frame", () => {
    const n = new HermesNormalizer("run-x");
    const out: BridgeEvent[] = [];
    out.push(...n.feed({ event: "run.started", data: '{"run_id":"run-x"}' }));
    out.push(...n.feed({ event: "assistant.delta", data: '{"delta":{"content":"Hel"}}' }));
    out.push(...n.feed({ event: "assistant.delta", data: '{"delta":{"content":"lo"}}' }));
    out.push(...n.feed({ event: "run.completed", data: "{}" }));
    const deltas = out.filter((e) => e.type === "message.delta").map((e) => (e as unknown as { text: string }).text);
    expect(deltas).toEqual(["Hel", "lo"]);
    const final = out.find((e) => e.type === "message.final") as { text?: string };
    expect(final?.text).toBe("Hello"); // accumulated when the terminal carries no text
    const status = out.find((e) => e.type === "run.status" && (e as { status?: string }).status === "complete");
    expect(status).toBeDefined();
  });

  it("a terminal frame carrying its own final text overrides the accumulator", () => {
    const n = new HermesNormalizer("r");
    n.feed({ event: "assistant.delta", data: '{"text":"partial"}' });
    const out = n.feed({
      event: "run.completed",
      data: '{"message":{"content":"Authoritative final."}}',
    });
    const final = out.find((e) => e.type === "message.final") as { text?: string };
    expect(final?.text).toBe("Authoritative final.");
  });

  it("extracts a delta from the OpenAI choices[].delta.content shape (codex P2)", () => {
    const n = new HermesNormalizer("r");
    const out = n.feed({
      event: "assistant.delta",
      data: '{"choices":[{"delta":{"content":"Xy"}}]}',
    });
    expect(out).toEqual([{ type: "message.delta", text: "Xy", runId: "r" }]);
  });

  it("emits tool.status start/completed from tool frames", () => {
    const n = new HermesNormalizer("r");
    const started = n.feed({ event: "tool.started", data: '{"tool":"terminal"}' });
    const done = n.feed({ event: "tool.completed", data: '{"tool":"terminal"}' });
    expect(started).toEqual([{ type: "tool.status", name: "terminal", phase: "start", runId: "r" }]);
    expect(done).toEqual([{ type: "tool.status", name: "terminal", phase: "completed", runId: "r" }]);
  });

  it("an UNKNOWN frame name is ignored, never a terminal (forward-compat)", () => {
    const n = new HermesNormalizer("r");
    // A future/unknown frame (e.g. a Responses-style item event) must not
    // finalize nor crash — the run-level terminal decides.
    expect(n.feed({ event: "response.output_item.done", data: '{"type":"function_call"}' })).toEqual([]);
    expect(n.isFinalized).toBe(false);
    n.feed({ event: "assistant.delta", data: '{"delta":"Final answer."}' });
    const out = n.feed({ event: "run.completed", data: "{}" });
    const final = out.find((e) => e.type === "message.final") as { text?: string };
    expect(final?.text).toBe("Final answer.");
  });

  it("ignores frames after finalize (idempotent terminal)", () => {
    const n = new HermesNormalizer("r");
    n.feed({ event: "done", data: "{}" });
    expect(n.feed({ event: "assistant.delta", data: '{"text":"late"}' })).toEqual([]);
  });

  it("a clean close with only deltas settles complete (done terminal)", () => {
    const n = new HermesNormalizer("r");
    n.feed({ event: "assistant.delta", data: '{"text":"hi"}' });
    const out = n.feed({ event: "done", data: "{}" });
    const final = out.find((e) => e.type === "message.final") as { text?: string; error?: string };
    expect(final?.text).toBe("hi");
    expect(final?.error).toBeUndefined();
  });
});
