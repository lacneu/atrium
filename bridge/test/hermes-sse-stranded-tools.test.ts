/// <reference types="vitest" />
//
// No eternal spinner on the REST transport (lot 44 — G-49).
//
// A tool whose `tool.completed` never arrived — a lost frame, a run that ended mid-call, an
// error terminal — left its card RUNNING forever on the SSE path. Beyond the spinner it
// wedges the composer's hold-the-send until the 20-minute reaper. The WS path grew this
// guard (`closeOpenTools` on every terminal); this one never did.
//
// Also pinned: `tool.failed` closes a card. That is forward-compat rather than a live fix —
// the REST layer's own allowlist forwards the name (`api_server.py:2567`) while nothing
// emits it today — and it is asserted so the spinner cannot return the day something does.

import { describe, expect, it } from "vitest";
import { HermesNormalizer } from "../src/providers/hermes/normalizer.js";

type Ev = { type: string; name?: string; phase?: string; toolCallId?: string };

const sse = (event: string, data: unknown) => ({
  event,
  data: JSON.stringify(data),
});

function toolEvents(evs: Ev[]): Ev[] {
  return evs.filter((e) => e.type === "tool.status");
}

describe("a terminal closes every card it left open", () => {
  it("a clean `done` settles a tool that never completed", () => {
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    const out = norm.feed(sse("done", {})) as Ev[];
    const closed = toolEvents(out);
    expect(closed, "the card used to spin forever").toHaveLength(1);
    expect(closed[0]!.phase).toBe("completed");
    expect(closed[0]!.name).toBe("exec");
  });

  it("an ERROR terminal closes them too", () => {
    // The likeliest shape: the run died mid-call, so the completion never came.
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    norm.feed(sse("tool.started", { tool_name: "read_file" }));
    const out = norm.feed(sse("error", { message: "boom" })) as Ev[];
    expect(toolEvents(out).map((e) => e.name).sort()).toEqual([
      "exec",
      "read_file",
    ]);
  });

  it("the stranded cards precede the terminal pair", () => {
    // Order matters: applied after the final, they would land on a message the client
    // already considers finished.
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    const out = norm.feed(sse("done", {})) as Ev[];
    const iTool = out.findIndex((e) => e.type === "tool.status");
    const iFinal = out.findIndex((e) => e.type === "message.final");
    expect(iTool).toBeGreaterThanOrEqual(0);
    expect(iTool).toBeLessThan(iFinal);
  });

  it("a tool that DID complete is not closed twice", () => {
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    norm.feed(sse("tool.completed", { tool_name: "exec" }));
    const out = norm.feed(sse("done", {})) as Ev[];
    expect(toolEvents(out)).toEqual([]);
  });

  it("`tool.failed` closes a card as a completion does", () => {
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    const out = norm.feed(sse("tool.failed", { tool_name: "exec" })) as Ev[];
    expect(toolEvents(out)).toHaveLength(1);
    // …and the terminal then has nothing left to strand.
    expect(toolEvents(norm.feed(sse("done", {})) as Ev[])).toEqual([]);
  });

  it("a turn with no tools adds nothing", () => {
    const norm = new HermesNormalizer();
    const out = norm.feed(sse("done", {})) as Ev[];
    expect(toolEvents(out)).toEqual([]);
  });
});

describe("the /reset terminal is a terminal too", () => {
  it("abortTurn closes the open cards, before its pair", () => {
    // `abortTurn` is what a `/reset` mid-stream settles the row with. It returned its
    // terminal pair while leaving every card RUNNING, so the spinner survived the very
    // guard this lot added — one terminal over (raised in review).
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    const out = norm.abortTurn() as Ev[];
    const closed = toolEvents(out);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.phase).toBe("completed");
    const iTool = out.findIndex((e) => e.type === "tool.status");
    const iFinal = out.findIndex((e) => e.type === "message.final");
    expect(iTool).toBeLessThan(iFinal);
  });

  it("…and does not close a card twice", () => {
    const norm = new HermesNormalizer();
    norm.feed(sse("tool.started", { tool_name: "exec" }));
    norm.feed(sse("tool.completed", { tool_name: "exec" }));
    expect(toolEvents(norm.abortTurn() as Ev[])).toEqual([]);
  });
});
