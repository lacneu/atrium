/**
 * The FIDELITY gate (W11/G4): promotion may change what a capture says, never what
 * Atrium makes of it.
 *
 * This guard exists because fourteen review passes over the anonymiser missed three
 * promotion defects that it found on its first run — a version marker renamed
 * (`announce:v1:` → announced children never settled), session keys masked inside a tool
 * result (the `awaiting_subagents` phase never fired) and item-stream tool names masked
 * (plan advances never counted). Each was invisible in the fixture: the corpus replayed
 * green while covering less than it claimed.
 */

import { describe, expect, it } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { consumedReadings, fidelityDiff, loadRunManager } from "../scripts/lib/replay-fidelity.mjs";
// @ts-expect-error — plain .mjs script, no types (it runs under node, not tsc)
import { parseEntries, promoteSlice } from "../scripts/promote-capture.mjs";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { knownKeysFromCoverage } from "../scripts/lib/anonymize-capture.mjs";
import { readFileSync } from "node:fs";
import { asyncTaskStartFromTool, taskChildKey } from "../src/core/async-task.js";
import { cronPartFromTool, isCronTool, printableCronSchedule } from "../src/core/cron-part.js";
import { MAX_PROVENANCE_ITEMS, MAX_PROVENANCE_PARTS_PER_TURN, isProvenanceStream, parseProvenanceFrame, parseProvenanceReport } from "../src/core/provenance.js";

// The RunManager comes from SOURCE here. `loadRunManager` reads the compiled bridge
// because the PROMOTER runs from a checkout with a build; `dist/` is gitignored and the
// bridge CI job runs typecheck + test only, so a test that needed it would fail on every
// clean checkout (raised in review — reproduced by moving `dist` aside).

const KEY = "agent:alice:atrium:chat:u-x:turn-y";
const RUN = "webchat-r1";

/** A minimal but REAL capture: an ack, a tool call and a final. */
function capture(toolName: string): { receivedAt: number; frame: unknown }[] {
  return [
    { receivedAt: 0, frame: { type: "res", payload: { runId: RUN } } },
    {
      receivedAt: 10,
      frame: {
        event: "agent",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          stream: "tool",
          seq: 1,
          data: { name: toolName, phase: "start", toolCallId: "c1", args: {} },
        },
      },
    },
    {
      receivedAt: 20,
      frame: {
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          seq: 2,
          state: "final",
          message: { content: [{ type: "text", text: "fini" }] },
        },
      },
    },
  ];
}

describe("replay fidelity", () => {
  it("sees no difference when promotion preserved the reading", async () => {
    const diffs = await fidelityDiff(RunManager, capture("exec"), capture("exec"));
    expect(diffs).toEqual([]);
  });

  it("REPORTS a difference when a masked path kills the media reading", async () => {
    // The real shape of a promotion defect: the frame still parses, the fixture still
    // looks healthy, and one reading is simply gone. (A CONSISTENT rename is not a
    // difference — the replay derives the session from the capture, which is why a
    // pseudonymised corpus is faithful in the first place.)
    const withMedia = capture("exec").map((e, i) =>
      i === 1
        ? {
            ...e,
            frame: {
              event: "agent",
              payload: {
                runId: RUN,
                sessionKey: KEY,
                stream: "assistant",
                seq: 1,
                data: {
                  mediaUrls: ["/home/node/.openclaw/media/outbound/a.png"],
                  text: "voila",
                },
              },
            },
          }
        : e,
    );
    const masked = JSON.parse(
      JSON.stringify(withMedia).replace(
        "/home/node/.openclaw/media/outbound/a.png",
        "/xxxx/xxxx/.xxxxxxxx/xxxxx/xxxxxxxx/x.xxx",
      ),
    ) as typeof withMedia;
    const clean = await fidelityDiff(RunManager, withMedia, withMedia);
    expect(clean, "identical input, no difference").toEqual([]);
    const diffs = await fidelityDiff(RunManager, withMedia, masked);
    expect(diffs.join(" "), "the lost media delivery must be reported").toContain("addMedia");
  });

  it("REFUSES to load without a build, instead of skipping the check", async () => {
    await expect(loadRunManager("/nonexistent/bridge")).rejects.toThrow(/npm run build/);
  });
});

describe("the gate compares ORDER, not just counts", () => {
  it("a permuted write sequence is a difference", async () => {
    // Write order is semantic: a card updated after a finalize is a different reading
    // from the same card updated before it. Comparing frequencies alone accepted any
    // permutation of the same calls.
    // Two captures with the same writes in a different order: a tool card before vs after
    // the final. The frames themselves carry the order.
    const toolFrame = (seq: number) => ({
      receivedAt: seq * 10,
      frame: {
        event: "agent",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          stream: "tool",
          seq,
          data: { name: "exec", phase: "start", toolCallId: `c${seq}`, args: {} },
        },
      },
    });
    const finalFrame = (seq: number) => ({
      receivedAt: seq * 10,
      frame: {
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: KEY,
          seq,
          state: "final",
          message: { content: [{ type: "text", text: "fini" }] },
        },
      },
    });
    const ack = { receivedAt: 0, frame: { type: "res", payload: { runId: RUN } } };
    const toolFirst = [ack, toolFrame(1), finalFrame(2)];
    const finalFirst = [ack, finalFrame(1), toolFrame(2)];
    const diffs = await fidelityDiff(RunManager, toolFirst, finalFirst);
    expect(diffs.length, "a reordered reading must not pass").toBeGreaterThan(0);
  });
});

// ── Defect 13: the gate compares what a card SAYS structurally, not just that it exists ──
describe("the gate sees a degraded reading that still writes the same card", () => {
  /** An ack, one agent event, a final. */
  const around = (stream: string, data: unknown) => [
    { receivedAt: 0, frame: { type: "res", payload: { runId: RUN } } },
    { receivedAt: 10, frame: { event: "agent", payload: { runId: RUN, sessionKey: KEY, stream, seq: 1, data } } },
    {
      receivedAt: 20,
      frame: { event: "chat", payload: { runId: RUN, sessionKey: KEY, seq: 2, state: "final", message: { content: [{ type: "text", text: "ok" }] } } },
    },
  ];
  const cron = (schedule: unknown) => ({
    name: "automations",
    phase: "result",
    toolCallId: "c1",
    args: { action: "add", job: { name: "n", schedule } },
    result: { details: { id: "j1", name: "n" } },
  });

  it("a cron card whose schedule lost its branch is a difference", async () => {
    // What promotion did before defect 13: `{kind:"cron", expr}` with `expr` masked as a key
    // printed the bare kind instead of `cron <expr>` — a schedule was still set.
    const diffs = await fidelityDiff(
      RunManager,
      around("tool", cron({ kind: "cron", expr: "0 5 1 1 *" })),
      around("tool", cron({ kind: "xxxx" })),
    );
    expect(diffs.join("\n")).toMatch(/addCronPart:.*schedule=cron:0 0 0 0 \*: raw 1, promoted 0/);
  });

  it("a provenance report that lost an item leaf is a difference", async () => {
    const report = (item: Record<string, unknown>) => ({ v: 1, pluginId: "p", source: "knowledge", kind: "documents", items: [item] });
    const diffs = await fidelityDiff(
      RunManager,
      around("p.provenance", report({ file_name: "a.pdf", collection: "c" })),
      around("p.provenance", report({ file_name: "a.pdf" })),
    );
    expect(diffs.join("\n")).toMatch(/addProvenancePart:documents:v1:.*:items=collection\+file_name:injected=-:retrieval=-: raw 1, promoted 0/);
  });

  it("a task that lost its declared timeout is a difference", async () => {
    const task = (details: Record<string, unknown>) => ({ name: "image_generate", phase: "result", toolCallId: "c1", result: { details } });
    const diffs = await fidelityDiff(
      RunManager,
      around("tool", task({ async: true, taskId: "t1", timeoutMs: 300_000 })),
      around("tool", task({ async: true, taskId: "t1" })),
    );
    expect(diffs.join("\n")).toMatch(/upsertSubAgent:task\/running\/declared-timeout=300000: raw 1, promoted 0/);
    // …and a CHANGED bound is a different deadline, not the same reading (codex).
    const changed = await fidelityDiff(
      RunManager,
      around("tool", task({ async: true, taskId: "t1", timeoutMs: 300_000 })),
      around("tool", task({ async: true, taskId: "t1", timeoutMs: 1 })),
    );
    expect(changed.join("\n")).toMatch(/declared-timeout=300000: raw 1, promoted 0/);
  });

  it("a cron card that lost its time zone, or whose bare kind was masked, is a difference", async () => {
    const noTz = await fidelityDiff(
      RunManager,
      around("tool", cron({ kind: "cron", expr: "0 5 1 1 *", tz: "UTC" })),
      around("tool", cron({ kind: "cron", expr: "0 5 1 1 *" })),
    );
    expect(noTz.join("\n")).toMatch(/schedule=cron:0 0 0 0 \* \(XXX\): raw 1, promoted 0/);
    // A parenthesised EXPRESSION is no time zone: losing the zone must still be seen (codex).
    const parenthesised = await fidelityDiff(
      RunManager,
      around("tool", cron({ kind: "cron", expr: "0 5 * * * (note)", tz: "UTC" })),
      around("tool", cron({ kind: "cron", expr: "0 5 * * * (note)" })),
    );
    expect(parenthesised.join("\n")).toMatch(/schedule=cron:0 0 \* \* \* \(xxxx\) \(XXX\): raw 1, promoted 0/);
    const maskedKind = await fidelityDiff(
      RunManager,
      around("tool", cron({ kind: "on-exit", command: "x" })),
      around("tool", cron({ kind: "xx-xxxx", command: "x" })),
    );
    expect(maskedKind.join("\n")).toMatch(/schedule=kind:on-exit: raw 1, promoted 0/);
  });

  it("a provenance report whose truncated flag flipped is a difference", async () => {
    const report = (truncated: boolean) => ({ v: 1, pluginId: "p", source: "knowledge", kind: "documents", injected: { chars: 1, truncated }, items: [{ file_name: "a.pdf" }] });
    const diffs = await fidelityDiff(RunManager, around("p.provenance", report(true)), around("p.provenance", report(false)));
    expect(diffs.join("\n")).toMatch(/:truncated=true:retrieval=-: raw 1, promoted 0/);
  });

  it("a turn that lost its failure class is a difference", async () => {
    const lifecycleError = (data: Record<string, unknown>) => [
      { receivedAt: 0, frame: { type: "res", payload: { runId: RUN } } },
      { receivedAt: 10, frame: { event: "agent", payload: { runId: RUN, sessionKey: KEY, stream: "lifecycle", seq: 1, data } } },
    ];
    const diffs = await fidelityDiff(
      RunManager,
      lifecycleError({ phase: "error", error: "boom", errorKind: "context_length" }),
      lifecycleError({ phase: "error", error: "boom" }),
    );
    expect(diffs.join("\n")).toMatch(/finalize:error:context_length: raw 1, promoted 0/);
    // …and the NESTED form the normalizer reads first (`data.error.errorKind`).
    const nested = await fidelityDiff(
      RunManager,
      lifecycleError({ phase: "error", error: { message: "boom", errorKind: "context_length" } }),
      lifecycleError({ phase: "error", error: { message: "boom" } }),
    );
    expect(nested.join("\n")).toMatch(/finalize:error:context_length: raw 1, promoted 0/);
  });
});

// ── Defect 13, end to end: promoteSlice + the real normalizer coalescing start/result frames ──
describe("a promoted cron capture reads the same through the REAL coalescing", () => {
  const vocabulary = (): Set<string> => {
    const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
    const snap = read("../protocol/openclaw/2026.9.4/session-event-snapshot.json");
    return knownKeysFromCoverage(read("../protocol/openclaw/coverage/2026.9.4.json"), Array.isArray(snap) ? snap : snap.fields);
  };
  const READERS = { isProvenanceStream, parseProvenanceFrame, parseProvenanceReport, MAX_PROVENANCE_ITEMS, asyncTaskStartFromTool, isCronTool, cronPartFromTool, printableCronSchedule, taskChildKey };
  const T = 1_785_204_000_000;
  const env = (dt: number, frame: unknown) => JSON.stringify({ receivedAt: T + dt, frame });
  const tool = (seq: number, phase: string, extra: Record<string, unknown>) => ({
    type: "event",
    event: "agent",
    payload: { runId: RUN, sessionKey: KEY, stream: "tool", seq, data: { name: "automations", phase, toolCallId: "c1", ...extra } },
  });
  const slice = (args: unknown, result: unknown | null) =>
    [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, tool(1, "start", { args })),
      ...(result === null ? [] : [env(10, tool(2, "result", { result }))]),
      // A real sentence: a bare "ok" is a private ack to the normalizer, and its mask is not —
      // a difference about the text, not about the cron card this suite measures.
      env(20, { type: "event", event: "chat", payload: { runId: RUN, sessionKey: KEY, seq: 3, state: "final", message: { content: [{ type: "text", text: "Le job est planifie." }] } } }),
    ].join("\n");
  const faithful = async (raw: string) => {
    // Exactly as the promoter: what the stack consumes from the raw replay decides what is kept.
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    const promoted = promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] };
    return fidelityDiff(RunManager, parseEntries(raw), promoted.lines.map((l) => JSON.parse(l)));
  };

  it("string schedule, result-over-input precedence and a job parsed from text all promote faithfully", async () => {
    const job = (schedule: unknown) => JSON.stringify({ id: "j1", name: "n", schedule });
    const cases: Array<[unknown, unknown]> = [
      [{ action: "add" }, { details: { id: "j1", name: "n", schedule: "cron 30 9 * * 1" } }],
      [{ action: "add", job: { schedule: { kind: "on-exit", command: "x" } } }, { details: { id: "j1", schedule: { kind: "stream", command: ["x"] } } }],
      [{ action: "add" }, { content: [{ type: "text", text: job({ kind: "on-exit", command: "x" }) }] }],
      [{ action: "update", jobId: "j1", patch: { schedule: { kind: "cron", expr: "0 5 * * *", tz: "UTC" } } }, { details: { id: "j1" } }],
    ];
    for (const [args, result] of cases) {
      const raw = slice(args, result);
      expect(await faithful(raw), raw).toEqual([]);
      // EACH case really writes the card: dropping its result must lose it, or `[]` above
      // would hold for a case that had stopped exercising the cron reader (codex).
      const lost = await fidelityDiff(RunManager, parseEntries(raw), parseEntries(slice(args, null)));
      expect(lost.join("\n"), raw).toMatch(/addCronPart:.*: raw 1, promoted 0/);
    }
  });

  it("a foreign-run start interleaved before the admitted result promotes faithfully, and only the admitted schedule is kept", async () => {
    const start = (runId: string, seq: number, kind: string) => ({
      type: "event",
      event: "agent",
      payload: { runId, sessionKey: KEY, stream: "tool", seq, data: { name: "automations", phase: "start", toolCallId: "c1", args: { action: "add", job: { schedule: { kind, command: "x" } } } } },
    });
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, start(RUN, 1, "on-exit")),
      env(6, start("webchat-other", 2, "stream")),
      env(10, tool(3, "result", { result: { details: { id: "j1" } } })),
      env(20, { type: "event", event: "chat", payload: { runId: RUN, sessionKey: KEY, seq: 4, state: "final", message: { content: [{ type: "text", text: "Le job est planifie." }] } } }),
    ].join("\n");
    expect(await faithful(raw)).toEqual([]);
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    const promoted = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines.join("\n");
    expect(promoted).toContain('"kind":"on-exit"');
    expect(promoted).not.toContain('"kind":"stream"');
  });

  it("a lifecycle error classified by its NESTED errorKind promotes faithfully", async () => {
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(10, { type: "event", event: "agent", payload: { runId: RUN, sessionKey: KEY, stream: "lifecycle", seq: 1, data: { phase: "error", error: { message: "Martin overflow", errorKind: "context_length" } } } }),
    ].join("\n");
    expect(await faithful(raw)).toEqual([]);
  });

  it("a refused error carrying the class the admitted terminal closed with does not keep it", async () => {
    const lifecycle = (runId: string, seq: number, data: unknown) => ({ type: "event", event: "agent", payload: { runId, sessionKey: KEY, stream: "lifecycle", seq, data } });
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, lifecycle(RUN, 1, { phase: "start" })),
      env(6, lifecycle("webchat-other", 2, { phase: "error", error: { errorKind: "context_length" } })),
      // Nested, not root: a root `errorKind` is kept everywhere and would prove no attribution.
      env(10, lifecycle(RUN, 3, { phase: "error", error: { message: "own boom", errorKind: "context_length" } })),
    ].join("\n");
    expect(await faithful(raw)).toEqual([]);
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[2], "the refused frame").not.toContain('"errorKind":"context_length"');
    expect(lines[3], "the admitted terminal").toContain('"errorKind":"context_length"');
  });

  it("an announce BUFFERED during the turn and re-fed at its terminal keeps its own failure class", async () => {
    // The manager stashes the announce while the turn is active and replays it with `this.feed`
    // once the turn's terminal lands: its finalize belongs to the announce's error (entry 3), not
    // to the frame whose feed triggered the replay (entry 4) — codex.
    const ANNOUNCE = "announce:v1:agent:alice:subagent:5b0f9680-7a29-427a-ace0-02a9eb10f573:a40575b2-6ddd-4b8f-85aa-351e1a26c2b7";
    const lifecycle = (runId: string, seq: number, data: unknown) => ({ type: "event", event: "agent", payload: { runId, sessionKey: KEY, stream: "lifecycle", seq, data } });
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, lifecycle(RUN, 1, { phase: "start" })),
      env(6, lifecycle(ANNOUNCE, 2, { phase: "start" })),
      // DISTINCT classes: equal ones could not show that each frame keeps its own (codex).
      env(7, lifecycle(ANNOUNCE, 3, { phase: "error", error: { message: "announce throttled", errorKind: "rate_limit" } })),
      env(10, lifecycle(RUN, 4, { phase: "error", error: { message: "own overflow", errorKind: "context_length" } })),
    ].join("\n");
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    expect((consumed as { errorReads: unknown[] }).errorReads).toEqual([
      { entry: 4, errorKind: "context_length" },
      { entry: 3, errorKind: "rate_limit" },
    ]);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[3], "the announce's error keeps its class").toContain('"errorKind":"rate_limit"');
    expect(lines[3]).not.toContain('"errorKind":"context_length"');
    expect(lines[4], "the turn's error keeps its class").toContain('"errorKind":"context_length"');
    expect(lines[4]).not.toContain('"errorKind":"rate_limit"');
  });

  const report = (runId: string, sessionKey: string, seq: number) => ({
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey,
      stream: "provenance-probe.provenance",
      seq,
      data: { v: 1, pluginId: "provenance-probe", source: "knowledge", kind: "documents", items: [{ file_name: "a.pdf", collection: "c" }] },
    },
  });
  const finalFrame = (seq: number) => ({ type: "event", event: "chat", payload: { runId: RUN, sessionKey: KEY, seq, state: "final", message: { content: [{ type: "text", text: "Le job est planifie." }] } } });

  it("an IDENTICAL report of another run earlier in the capture does not take the consumed one's credit", async () => {
    // Measured on a real capture (announce-reverse-hold, 2026-09-15): the probe's identical report of
    // a sub-agent run came first, took the content-counted credit, and the turn's own report was
    // masked — the gate refused the promotion.
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, report("child-run", "agent:alice:subagent:x", 1)),
      env(6, report(RUN, KEY, 2)),
      env(20, finalFrame(3)),
    ].join("\n");
    expect(await faithful(raw)).toEqual([]);
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[1], "the other run's report").not.toContain('"v":1');
    expect(lines[2], "the turn's report").toContain('"v":1');
  });

  it("a report that raced the ack, flushed while the turn opens, is attributed to the acked run", async () => {
    const raw = [env(0, report(RUN, KEY, 1)), env(5, { type: "res", payload: { runId: RUN } }), env(20, finalFrame(2))].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: Array<{ run: string }> };
    expect(consumed.provenanceReads.map((read) => read.run)).toEqual([RUN]);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[0]).toContain('"v":1');
  });

  it("a CHAT event carrying the same report never takes the credit of the agent report the stack reads", async () => {
    // Run and content alone let a frame the reader never admits claim the read (codex).
    const asChat = { ...report(RUN, KEY, 1), event: "chat" };
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, asChat),
      env(6, report(RUN, KEY, 2)),
      env(20, finalFrame(3)),
    ].join("\n");
    expect(await faithful(raw)).toEqual([]);
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[1], "the chat event").not.toContain('"v":1');
    expect(lines[2], "the agent report").toContain('"v":1');
  });

  it("a CHAT event racing the ack with the same report never claims the agent report the stash flushes", async () => {
    // Here the read is attributed by RUN (written while the turn opens), so only the reader's
    // admission — an agent event of the session, `parseProvenanceFrame` — tells the two frames apart.
    const asChat = { ...report(RUN, KEY, 1), event: "chat" };
    const raw = [env(0, asChat), env(1, report(RUN, KEY, 2)), env(5, { type: "res", payload: { runId: RUN } }), env(20, finalFrame(3))].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: Array<{ run?: string }> };
    expect(consumed.provenanceReads.map((read) => read.run)).toEqual([RUN]);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[0], "the chat event").not.toContain('"v":1');
    expect(lines[1], "the stashed agent report").toContain('"v":1');
  });

  it("an announce report written while a RUNID-LESS frame is fed is attributed to ITS OWN frame and kept", async () => {
    // Measured on the real RunManager: the parent turn is over, the announce's report is stashed, and
    // a visible assistant frame of the session with `runId: ""` opens the announce bubble — the part is
    // written during THAT feed. Naming it after the fed frame recorded `run: ""` and masked the read
    // (codex). The manager re-feeds the stashed report through the normalizer, whose part names its
    // frame by reference: the read is exact.
    const ANNOUNCE = "announce:v1:agent:alice:subagent:5b0f9680-7a29-427a-ace0-02a9eb10f573:a40575b2-6ddd-4b8f-85aa-351e1a26c2b7";
    const agentFrame = (runId: string, seq: number, stream: string, data: unknown) => ({ type: "event", event: "agent", payload: { runId, sessionKey: KEY, stream, seq, data } });
    const chatFinal = (runId: string, seq: number, text: string) => ({ type: "event", event: "chat", payload: { runId, sessionKey: KEY, seq, state: "final", message: { content: [{ type: "text", text }] } } });
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(10, agentFrame(RUN, 1, "lifecycle", { phase: "start" })),
      env(20, chatFinal(RUN, 2, "Le job est planifie.")),
      env(30, agentFrame(RUN, 3, "lifecycle", { phase: "end" })),
      env(40, report(ANNOUNCE, KEY, 4)),
      env(50, agentFrame("", 5, "assistant", { text: "Annonce visible." })),
      env(60, chatFinal(ANNOUNCE, 6, "Annonce visible.")),
    ].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: Array<{ run?: string | null; entry?: number }> };
    expect(consumed.provenanceReads).toEqual([{ entry: 4, part: expect.any(String) }]);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[4]).toContain('"v":1');
  });

  it("a `res` frame shaped like the announce's report never claims the stashed report the stack reads", async () => {
    // The reader drops `res` frames and `parseProvenanceFrame` requires `type: "event"`, so this
    // pseudo report is read by nobody; a restated admission without that check let it claim (codex).
    const ANNOUNCE = "announce:v1:agent:alice:subagent:5b0f9680-7a29-427a-ace0-02a9eb10f573:a40575b2-6ddd-4b8f-85aa-351e1a26c2b7";
    const agentFrame = (runId: string, seq: number, stream: string, data: unknown) => ({ type: "event", event: "agent", payload: { runId, sessionKey: KEY, stream, seq, data } });
    const chatFinal = (runId: string, seq: number, text: string) => ({ type: "event", event: "chat", payload: { runId, sessionKey: KEY, seq, state: "final", message: { content: [{ type: "text", text }] } } });
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(10, agentFrame(RUN, 1, "lifecycle", { phase: "start" })),
      env(20, chatFinal(RUN, 2, "Le job est planifie.")),
      env(30, agentFrame(RUN, 3, "lifecycle", { phase: "end" })),
      env(35, { ...report(ANNOUNCE, KEY, 4), type: "res" }),
      env(40, report(ANNOUNCE, KEY, 5)),
      env(50, agentFrame(ANNOUNCE, 6, "assistant", { text: "Annonce visible." })),
      env(60, chatFinal(ANNOUNCE, 7, "Annonce visible.")),
    ].join("\n");
    expect(await faithful(raw)).toEqual([]);
    const consumed = await consumedReadings(RunManager, parseEntries(raw), READERS);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[4], "the pseudo report").not.toContain('"v":1');
    expect(lines[5], "the stashed report").toContain('"v":1');
  });

  it("a non-event frame that RACED the ack is read when the turn opens — and keeps its values", async () => {
    // Measured: the stash refuses it (`type` is not "event"), but the manager replays raced frames
    // straight into the normalizer, which drops only `res` — the stack writes BOTH reports.
    const raced = { ...report(RUN, KEY, 1), type: "req" };
    const raw = [env(0, raced), env(1, report(RUN, KEY, 2)), env(5, { type: "res", payload: { runId: RUN } }), env(20, finalFrame(3))].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: unknown[] };
    expect(consumed.provenanceReads).toHaveLength(2);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[0]).toContain('"v":1');
    expect(lines[1]).toContain('"v":1');
  });

  it("a raced non-event frame whose part the per-turn cap drops never claims the identical stashed report", async () => {
    // Codex's counter-example: eight distinct reports race the ack and are stashed; a `type: "req"` frame
    // before them carries a copy of one. At turn start the eight stashed parts are written first, then
    // the raced `req` frame is replayed into the normalizer — its part is REFUSED by the sink's cap
    // (MAX_PROVENANCE_PARTS_PER_TURN), so it has no exact read. Only `parseProvenanceFrame`'s
    // `type: "event"` keeps it from claiming the stashed copy's read; the gate cannot see the swap.
    const reportOf = (file: string, seq: number, type = "event") => ({
      type,
      event: "agent",
      payload: {
        runId: RUN,
        sessionKey: KEY,
        stream: "provenance-probe.provenance",
        seq,
        data: { v: 1, pluginId: "provenance-probe", source: "knowledge", kind: "documents", items: [{ file_name: file, collection: "c" }] },
      },
    });
    // Names of DIFFERENT LENGTHS: masking keeps the length but zeroes digits, so `doc-0.pdf` … `doc-7.pdf`
    // promote to eight identical reports that the stash de-duplicates into one — a different reading the
    // gate refuses, and not the attribution this test is about.
    const files = Array.from({ length: MAX_PROVENANCE_PARTS_PER_TURN }, (_, i) => `d${"x".repeat(i)}.pdf`);
    const raw = [
      env(0, reportOf(files[0]!, 1, "req")),
      ...files.map((file, i) => env(1 + i, reportOf(file, 2 + i))),
      env(20, { type: "res", payload: { runId: RUN } }),
      env(30, finalFrame(20)),
    ].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: unknown[] };
    expect(consumed.provenanceReads, "the cap: eight parts written").toHaveLength(MAX_PROVENANCE_PARTS_PER_TURN);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[0], "the raced req frame, never written").not.toContain('"v":1');
    expect(lines[1], "the stashed copy that was written").toContain('"v":1');
  });

  it("a report WITHOUT a runId, read as it arrives in the turn, is attributed to its own entry and kept", async () => {
    const { runId: _none, ...payload } = report(RUN, KEY, 2).payload;
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, { type: "event", event: "agent", payload: { runId: RUN, sessionKey: KEY, stream: "lifecycle", seq: 1, data: { phase: "start" } } }),
      env(6, { type: "event", event: "agent", payload }),
      env(20, finalFrame(3)),
    ].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: Array<{ entry?: number }> };
    expect(consumed.provenanceReads, "the stack reads it").toHaveLength(1);
    expect(consumed.provenanceReads[0]!.entry).toBe(2);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[2]).toContain('"v":1');
  });

  it("an ANNOUNCE's report stashed during the turn, read when the announce opens, is kept", async () => {
    const ANNOUNCE = "announce:v1:agent:alice:subagent:5b0f9680-7a29-427a-ace0-02a9eb10f573:a40575b2-6ddd-4b8f-85aa-351e1a26c2b7";
    const agentFrame = (runId: string, seq: number, stream: string, data: unknown) => ({ type: "event", event: "agent", payload: { runId, sessionKey: KEY, stream, seq, data } });
    const chatFinal = (runId: string, seq: number, text: string) => ({ type: "event", event: "chat", payload: { runId, sessionKey: KEY, seq, state: "final", message: { content: [{ type: "text", text }] } } });
    const raw = [
      env(0, { type: "res", payload: { runId: RUN } }),
      env(5, agentFrame(RUN, 1, "lifecycle", { phase: "start" })),
      env(6, report(ANNOUNCE, KEY, 2)),
      env(7, agentFrame(ANNOUNCE, 3, "lifecycle", { phase: "start" })),
      env(8, agentFrame(ANNOUNCE, 4, "assistant", { text: "Le sous-agent a termine." })),
      env(9, agentFrame(ANNOUNCE, 5, "lifecycle", { phase: "end" })),
      env(10, chatFinal(ANNOUNCE, 6, "Le sous-agent a termine.")),
      env(15, agentFrame(RUN, 7, "lifecycle", { phase: "end" })),
      env(16, chatFinal(RUN, 8, "Le job est planifie.")),
    ].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: unknown[] };
    expect(consumed.provenanceReads, "the stack reads the announce's report").toHaveLength(1);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[2]).toContain('"v":1');
  });

  it("ONE consumed report keeps its values on ONE frame: an identical duplicate of the same run stays masked", async () => {
    // Two identical reports race the ack: the manager stashes the first and drops the duplicate by
    // signature (run-manager.ts pendingProvenance), so the stack reads ONE. One reading, one claim.
    const raw = [
      env(0, report(RUN, KEY, 1)),
      env(1, report(RUN, KEY, 2)),
      env(5, { type: "res", payload: { runId: RUN } }),
      env(20, finalFrame(3)),
    ].join("\n");
    const consumed = (await consumedReadings(RunManager, parseEntries(raw), READERS)) as { provenanceReads: unknown[] };
    expect(consumed.provenanceReads).toHaveLength(1);
    expect(await faithful(raw)).toEqual([]);
    const lines = (promoteSlice(raw, vocabulary(), READERS, consumed) as { lines: string[] }).lines;
    expect(lines[0], "the read report").toContain('"v":1');
    expect(lines[1], "its duplicate").not.toContain('"v":1');
  });

  it("…and the comparison is not vacuous: the card really is written", async () => {
    const withCard = slice({ action: "add" }, { details: { id: "j1", name: "n", schedule: { kind: "on-exit", command: "x" } } });
    const withoutResult = slice({ action: "add" }, null);
    const diffs = await fidelityDiff(RunManager, parseEntries(withCard), parseEntries(withoutResult));
    expect(diffs.join("\n")).toMatch(/addCronPart:.*schedule=kind:on-exit: raw 1, promoted 0/);
  });
});
