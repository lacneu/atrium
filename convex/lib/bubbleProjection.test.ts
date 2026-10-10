// THE TRANSCRIPT MAKES THE BUBBLES — the pure planner (transcript redesign phase 4).
//
// Two layers:
//  - truth tables: every rule of lib/bubbleProjection.ts, one case each, plus the three
//    `on` limitations of 0.95.0 stated as rows;
//  - properties over SEEDED worlds (mulberry32: a failure replays from its seed): rows
//    arrive in any order, twice, in several reads, runs end before or after their rows,
//    live bubbles hold anything — and once everything is read and over:
//      I1 every visible assistant row is in exactly one bubble, whose text shows it;
//      I2 no bubble born from rows without a row;
//      I3 one bubble per (run, segment) — never a duplicate;
//      idempotence (planning again over the result changes nothing), and ORDER: the
//      final texts do not depend on the arrival order (two schedules, one result).

import { describe, expect, test } from "vitest";
import {
  composeText,
  MAX_COMPOSED_TEXT_BYTES,
  planProjection,
  segmentKey,
  segmentOf,
  type PlanBubble,
  type PlanRow,
  type ProjectionPlan,
  type ProjectionView,
  type RunFacts,
} from "./bubbleProjection";

const row = (entryId: string, seq: number, over: Partial<PlanRow> = {}): PlanRow => ({
  entryId,
  seq,
  role: "assistant",
  hidden: false,
  visible: true,
  ...over,
});

const bubble = (messageId: string, over: Partial<PlanBubble> = {}): PlanBubble => ({
  messageId,
  exists: true,
  status: "streaming",
  text: "",
  runIds: [],
  rows: [],
  ...over,
});

const settled = (over: Partial<RunFacts> = {}): RunFacts => ({
  settled: true,
  covered: true,
  status: "completed",
  ...over,
});

function view(over: Partial<ProjectionView>): ProjectionView {
  return {
    floorSeq: 0,
    runIds: [],
    rowsOfRun: new Map(),
    steersOfRun: new Map(),
    liveBubbleOf: new Map(),
    bubbles: new Map(),
    runs: new Map(),
    ...over,
  };
}

describe("composeText — the text a bubble's rows make", () => {
  test("seq order whatever the input order; hidden and tool rows show nothing", () => {
    const rows = [
      row("c", 30, { runId: "R", text: "trois" }),
      row("a", 10, { runId: "R", text: "un" }),
      row("h", 15, { runId: "R", text: "NO_REPLY", hidden: true }),
      row("t", 20, { runId: "R", role: "toolresult" }),
      row("b", 25, { runId: "R", text: "  deux  " }),
    ];
    expect(composeText(rows)).toBe("un\n\ndeux\n\ntrois");
    expect(composeText([...rows].reverse())).toBe("un\n\ndeux\n\ntrois");
  });

  test("a duplicated row is shown once", () => {
    expect(composeText([row("a", 1, { text: "x" }), row("a", 1, { text: "x" })])).toBe("x");
  });

  test("a sessions_yield acknowledgment shows only for a run that wrote nothing", () => {
    const silent = [row("y", 5, { runId: "P", visible: false, yieldAck: "Je reviens vers toi." })];
    expect(composeText(silent)).toBe("Je reviens vers toi.");
    const spoke = [...silent, row("t", 6, { runId: "P", text: "Voici." })];
    expect(composeText(spoke)).toBe("Voici.");
    // Per run: the settle run's text does not silence the parent's acknowledgment.
    const chain = [...silent, row("s", 9, { runId: "S", text: "Résultat." })];
    expect(composeText(chain)).toBe("Je reviens vers toi.\n\nRésultat.");
  });
});

describe("segmentOf — a steered user row cuts its run (CU-20)", () => {
  test("rows before the first steer are segment 0, then one segment per steer", () => {
    expect(segmentOf(5, [10, 20])).toBe(0);
    expect(segmentOf(15, [10, 20])).toBe(1);
    expect(segmentOf(25, [10, 20])).toBe(2);
    expect(segmentOf(25, [])).toBe(0);
  });
});

describe("planProjection — truth table", () => {
  test("live bubble of a settled run: rows assigned, text recomposed, bubble settled", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: "réponse" })]]]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { runIds: ["R"], text: "" })]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.assign).toEqual([{ entryId: "a", to: { messageId: "m1" } }]);
    expect(plan.create).toEqual([]);
    expect(plan.rewrite).toEqual([{ messageId: "m1", text: "réponse", settle: "complete" }]);
  });

  test("a run still streaming is left to the live overlay", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: "x" })]]]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { runIds: ["R"] })]]),
        runs: new Map([["R", settled({ settled: false })]]),
      }),
    );
    expect(plan).toEqual({ assign: [], create: [], rewrite: [] });
  });

  test("rows that arrive before any live frame: the bubble is born from them", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([
          ["R", [row("b", 4, { runId: "R", text: "deux" }), row("a", 3, { runId: "R", text: "un" })]],
        ]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.create).toEqual([
      { born: segmentKey("R", 0), runId: "R", segment: 0, firstSeq: 3, text: "un\n\ndeux", status: "complete", inferred: false },
    ]);
    expect(plan.assign.map((a) => a.entryId).sort()).toEqual(["a", "b"]);
  });

  test("no bubble is born for a run with nothing to read, nor for one not covered", () => {
    const toolOnly = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("t", 3, { runId: "R", role: "toolresult" })]]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(toolOnly.create).toEqual([]);
    const uncovered = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 3, { runId: "R", text: "x" })]]]),
        runs: new Map([["R", settled({ covered: false })]]),
      }),
    );
    expect(uncovered.create).toEqual([]);
    // A visible row read by an older bridge carries no text: nothing is born from it.
    const textless = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([
          ["R", [row("a", 3, { runId: "R", text: "x" }), row("b", 4, { runId: "R" })]],
        ]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(textless.create).toEqual([]);
  });

  test("rows at or below the floor are legacy: never placed", () => {
    const plan = planProjection(
      view({
        floorSeq: 10,
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 10, { runId: "R", text: "x" })]]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan).toEqual({ assign: [], create: [], rewrite: [] });
  });

  test("assignment is STICKY: an assigned row stays where it is", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([
          ["R", [row("a", 2, { runId: "R", text: "x", messageId: "old" }), row("b", 3, { runId: "R", text: "y" })]],
        ]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "other"]]),
        bubbles: new Map([
          ["old", bubble("old", { status: "complete", text: "x", runIds: ["R"], rows: [row("a", 2, { runId: "R", text: "x", messageId: "old" })] })],
          ["other", bubble("other")],
        ]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.assign).toEqual([{ entryId: "b", to: { messageId: "old" } }]);
    expect(plan.rewrite).toEqual([{ messageId: "old", text: "x\n\ny" }]);
  });

  test("a deleted bubble is a tombstone: its segment is never re-born", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: "x", messageId: "gone" })]]]),
        bubbles: new Map([["gone", bubble("gone", { exists: false })]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan).toEqual({ assign: [], create: [], rewrite: [] });
  });

  test("an empty composition never erases the live text; the bubble is still settled", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("t", 2, { runId: "R", role: "toolresult" })]]]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { runIds: ["R"], text: "ce que le direct a montré" })]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.rewrite).toEqual([{ messageId: "m1", settle: "complete" }]);
  });

  test("an error or a timeout keeps its live terminal (the gateway's message); an abort settles aborted", () => {
    for (const status of ["error", "timeout"] as const) {
      const plan = planProjection(
        view({
          runIds: ["R"],
          rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: "x" })]]]),
          liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
          bubbles: new Map([["m1", bubble("m1", { runIds: ["R"] })]]),
          runs: new Map([["R", settled({ status })]]),
        }),
      );
      expect(plan.rewrite).toEqual([{ messageId: "m1", text: "x" }]);
    }
    const aborted = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: "x" })]]]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { runIds: ["R"] })]]),
        runs: new Map([["R", settled({ status: "aborted" })]]),
      }),
    );
    expect(aborted.rewrite).toEqual([{ messageId: "m1", text: "x", settle: "aborted" }]);
  });

  test("a bubble showing a run that is not covered (or not over) keeps its live text", () => {
    const plan = planProjection(
      view({
        runIds: ["S"],
        rowsOfRun: new Map([["S", [row("s", 9, { runId: "S", text: "fin" })]]]),
        liveBubbleOf: new Map([[segmentKey("S", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { status: "complete", text: "parent\n\nfin", runIds: ["P", "S"] })]]),
        runs: new Map([
          ["S", settled()],
          ["P", settled({ covered: false })],
        ]),
      }),
    );
    expect(plan.assign).toEqual([{ entryId: "s", to: { messageId: "m1" } }]);
    expect(plan.rewrite).toEqual([]);
  });

  test("a composition over the document bound is never written: no birth, no rewrite (live text stays)", () => {
    const huge = "é".repeat(Math.ceil(MAX_COMPOSED_TEXT_BYTES / 2) + 1); // 2 bytes each in UTF-8
    const born = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: huge })]]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(born.create).toEqual([]);
    const live = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: huge })]]]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { runIds: ["R"], text: "direct" })]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(live.rewrite).toEqual([{ messageId: "m1", settle: "complete" }]);
  });

  test("a bubble holding another scope's rows is settled, never recomposed", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 2, { runId: "R", text: "x" })]]]),
        liveBubbleOf: new Map([[segmentKey("R", 0), "m1"]]),
        bubbles: new Map([["m1", bubble("m1", { runIds: ["R"], text: "direct", uncovered: true })]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.rewrite).toEqual([{ messageId: "m1", settle: "complete" }]);
  });

  test("a steered input cuts the run: each segment has its own bubble (CU-20)", () => {
    const rows = [
      row("a", 2, { runId: "R", text: "avant" }),
      row("b", 6, { runId: "R", text: "après" }),
    ];
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", rows]]),
        steersOfRun: new Map([["R", [4]]]),
        liveBubbleOf: new Map([
          [segmentKey("R", 0), "s0"],
          [segmentKey("R", 1), "s1"],
        ]),
        bubbles: new Map([
          ["s0", bubble("s0", { status: "complete", text: "avant après (direct, avant la coupe)", runIds: ["R"] })],
          ["s1", bubble("s1", { runIds: ["R"], runSegment: 1 } as Partial<PlanBubble>)],
        ]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.rewrite).toEqual([
      { messageId: "s0", text: "avant" },
      { messageId: "s1", text: "après", settle: "complete" },
    ]);
  });

  // ── The three `on` limitations of 0.95.0, as rows ─────────────────────────────────

  test("0.95.0 limitation 1: a yield resumption whose answer went through the message tool", () => {
    // The parent P yielded (no text, an acknowledgment); the settle run S sent its answer
    // with the `message` tool — the gateway's delivery-mirror row of S — then ended with a
    // sentence. The live bubble (P's, merged with S) showed only that sentence.
    const pRows = [
      row("p1", 5, { runId: "P", visible: false }),
      row("p2", 7, { runId: "P", visible: false, yieldAck: "En attente du sous-agent." }),
    ];
    const sRows = [
      row("s1", 20, { runId: "S", text: "BS_PARENT_OK" }), // delivery-mirror
      row("s2", 22, { runId: "S", text: "Terminé." }),
    ];
    const plan = planProjection(
      view({
        runIds: ["S"],
        rowsOfRun: new Map([["S", sRows]]),
        liveBubbleOf: new Map([[segmentKey("S", 0), "m1"]]),
        bubbles: new Map([
          [
            "m1",
            bubble("m1", {
              status: "complete",
              text: "En attente du sous-agent.\n\nTerminé.",
              runIds: ["S", "P"],
              rows: pRows.map((r) => ({ ...r, messageId: "m1" })),
            }),
          ],
        ]),
        runs: new Map([
          ["P", settled({ status: "yielded" })],
          ["S", settled()],
        ]),
      }),
    );
    expect(plan.rewrite).toEqual([
      { messageId: "m1", text: "En attente du sous-agent.\n\nBS_PARENT_OK\n\nTerminé." },
    ]);
  });

  test("0.95.0 limitation 2: an input whose ACK was lost — its answer still gets its bubble", () => {
    // The live overlay forgot the input (no bubble for its run R); the run's rows exist.
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([["R", [row("a", 12, { runId: "R", text: "BS_B_OK" })]]]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.create.map((c) => [c.runId, c.text])).toEqual([["R", "BS_B_OK"]]);
  });

  test("0.95.0 limitation 3: a resumed bubble that repeats part of its answer is recomposed", () => {
    const plan = planProjection(
      view({
        runIds: ["R"],
        rowsOfRun: new Map([
          ["R", [row("a", 2, { runId: "R", text: "Première partie." }), row("b", 3, { runId: "R", text: "Suite." })]],
        ]),
        liveBubbleOf: new Map([[segmentKey("R", 2), "m1"]]),
        steersOfRun: new Map([["R", [1, 1]]]),
        bubbles: new Map([
          ["m1", bubble("m1", { runIds: ["R"], text: "Première partie.\n\nPremière partie.\n\nSuite." })],
        ]),
        runs: new Map([["R", settled()]]),
      }),
    );
    expect(plan.rewrite).toEqual([
      { messageId: "m1", text: "Première partie.\n\nSuite.", settle: "complete" },
    ]);
  });
});

// ── Properties over seeded worlds ──────────────────────────────────────────────────

/** mulberry32 — deterministic, so every failing world replays from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type World = {
  rows: PlanRow[]; // assistant/tool rows, all runs
  steers: Map<string, number[]>;
  runs: string[];
  /** Live bubbles the overlay opened: (run, segment) → its live text and status. */
  live: Array<{ runId: string; segment: number; text: string; status: "streaming" | "complete" }>;
};

function makeWorld(rand: () => number): World {
  const nRuns = 1 + Math.floor(rand() * 4);
  const runs = Array.from({ length: nRuns }, (_, i) => `run${i}`);
  const rows: PlanRow[] = [];
  const steers = new Map<string, number[]>();
  let seq = 1;
  for (const runId of runs) {
    const n = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      if (rand() < 0.2) {
        // A user row steered into this run (the user rows themselves are not planned).
        steers.set(runId, [...(steers.get(runId) ?? []), seq++]);
      }
      const kind = rand();
      if (kind < 0.6) rows.push(row(`${runId}-${i}`, seq++, { runId, text: `T(${runId}#${i})` }));
      else if (kind < 0.75) rows.push(row(`${runId}-${i}`, seq++, { runId, text: "NO_REPLY", hidden: true }));
      else if (kind < 0.9) rows.push(row(`${runId}-${i}`, seq++, { runId, role: "toolresult" }));
      else rows.push(row(`${runId}-${i}`, seq++, { runId, visible: false, yieldAck: `ack-${runId}` }));
    }
  }
  const live: World["live"] = [];
  for (const runId of runs) {
    if (rand() < 0.6) {
      live.push({ runId, segment: 0, text: `LIVE-garbage-${runId}`, status: rand() < 0.5 ? "streaming" : "complete" });
      for (let k = 1; k <= (steers.get(runId)?.length ?? 0); k++) {
        if (rand() < 0.7) live.push({ runId, segment: k, text: `LIVE-${runId}-${k}`, status: "streaming" });
      }
    }
  }
  return { rows, steers, runs, live };
}

type Store = {
  rows: Map<string, PlanRow>;
  bubbles: Map<string, { status: "streaming" | "complete" | "aborted" | "error"; text: string; runId: string; segment: number; born: boolean }>;
  settled: Set<string>;
  nextId: number;
};

function newStore(w: World): Store {
  const s: Store = { rows: new Map(), bubbles: new Map(), settled: new Set(), nextId: 0 };
  for (const l of w.live) {
    s.bubbles.set(`live:${l.runId}:${l.segment}`, {
      status: l.status,
      text: l.text,
      runId: l.runId,
      segment: l.segment,
      born: false,
    });
  }
  return s;
}

/** The in-memory twin of convex/lib/bubbleProjectionStore.ts: load the view, plan,
 *  execute. Returns the plan (for the idempotence check). */
function project(w: World, s: Store, runIds: readonly string[]): ProjectionPlan {
  const rowsOfRun = new Map<string, PlanRow[]>();
  const liveBubbleOf = new Map<string, string>();
  for (const r of s.rows.values()) {
    const list = rowsOfRun.get(r.runId!) ?? [];
    list.push(r);
    rowsOfRun.set(r.runId!, list);
  }
  for (const [id, b] of s.bubbles) liveBubbleOf.set(segmentKey(b.runId, b.segment), id);
  const bubbles = new Map<string, PlanBubble>();
  for (const [id, b] of s.bubbles) {
    bubbles.set(id, {
      messageId: id,
      exists: true,
      status: b.status,
      text: b.text,
      runIds: [b.runId],
      rows: [...s.rows.values()].filter((r) => r.messageId === id),
    });
  }
  const runs = new Map<string, RunFacts>();
  for (const r of w.runs) runs.set(r, { settled: s.settled.has(r), covered: true, status: "completed" });
  const plan = planProjection({
    floorSeq: 0,
    runIds,
    rowsOfRun,
    steersOfRun: w.steers,
    liveBubbleOf,
    bubbles,
    runs,
  });
  const born = new Map<string, string>();
  for (const c of plan.create) {
    const id = `born:${s.nextId++}`;
    born.set(c.born, id);
    s.bubbles.set(id, { status: c.status, text: c.text, runId: c.runId, segment: c.segment, born: true });
  }
  for (const a of plan.assign) {
    const target = "messageId" in a.to ? a.to.messageId : born.get(a.to.born)!;
    const r = s.rows.get(a.entryId)!;
    if (r.messageId === undefined) s.rows.set(a.entryId, { ...r, messageId: target });
  }
  for (const wr of plan.rewrite) {
    const b = s.bubbles.get(wr.messageId)!;
    if (wr.settle !== undefined && b.status === "streaming") b.status = wr.settle;
    if (wr.text !== undefined) b.text = wr.text;
  }
  return plan;
}

/** Deliver the world's rows in a random schedule: shuffled, some twice, in reads of a
 *  random size; runs end at random points; a final full replay (a `reset` page). */
function deliver(w: World, rand: () => number): Store {
  const s = newStore(w);
  const queue = [...w.rows, ...w.rows.filter(() => rand() < 0.3)];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [queue[i], queue[j]] = [queue[j]!, queue[i]!];
  }
  while (queue.length > 0) {
    const batch = queue.splice(0, 1 + Math.floor(rand() * 4));
    for (const r of batch) {
      const stored = s.rows.get(r.entryId);
      // Upsert by entry id: an assignment is a stored fact, never undone by a replay.
      s.rows.set(r.entryId, stored === undefined ? { ...r } : { ...r, messageId: stored.messageId });
    }
    const ended: string[] = [];
    for (const run of w.runs) if (!s.settled.has(run) && rand() < 0.25) ended.push(run);
    for (const run of ended) s.settled.add(run);
    project(w, s, [...new Set([...batch.map((r) => r.runId!), ...ended])]);
  }
  // Everything is over, and a reset re-reads the whole tail.
  for (const run of w.runs) s.settled.add(run);
  project(w, s, w.runs);
  return s;
}

describe("properties over seeded worlds", () => {
  const SEEDS = 400;

  test("I1, I2, I3 and idempotence hold once everything is read and over", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = makeWorld(prng(seed));
      const s = deliver(w, prng(seed * 7919));
      // I1: every visible text row is assigned to exactly one existing bubble that shows it.
      for (const r of w.rows) {
        if (r.role !== "assistant" || r.hidden || r.text === undefined) continue;
        const stored = s.rows.get(r.entryId)!;
        expect(stored.messageId, `seed ${seed}: row ${r.entryId} unplaced`).toBeDefined();
        const b = s.bubbles.get(stored.messageId!)!;
        expect(b.text.includes(r.text), `seed ${seed}: row ${r.entryId} not shown`).toBe(true);
      }
      // I2: a bubble born from rows has at least one row assigned to it.
      for (const [id, b] of s.bubbles) {
        if (!b.born) continue;
        const own = [...s.rows.values()].filter((r) => r.messageId === id);
        expect(own.length, `seed ${seed}: born bubble ${id} without a row`).toBeGreaterThan(0);
      }
      // I3: one bubble per (run, segment).
      const keys = [...s.bubbles.values()].map((b) => segmentKey(b.runId, b.segment));
      expect(new Set(keys).size, `seed ${seed}: duplicate bubble`).toBe(keys.length);
      // Every bubble of an over run is settled (nothing left streaming).
      for (const b of s.bubbles.values()) expect(b.status, `seed ${seed}`).not.toBe("streaming");
      // Idempotence: planning again over the result changes nothing.
      const again = project(w, s, w.runs);
      expect(again, `seed ${seed}: not idempotent`).toEqual({ assign: [], create: [], rewrite: [] });
    }
  });

  test("the result does not depend on the arrival order (seq decides, never time)", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = makeWorld(prng(seed));
      const a = deliver(w, prng(seed * 31 + 1));
      const b = deliver(w, prng(seed * 31 + 2));
      const texts = (s: Store) =>
        new Map(
          [...s.bubbles.values()].map((x) => [segmentKey(x.runId, x.segment), x.text] as const),
        );
      // Bubbles that hold rows show the same text whatever the schedule.
      const ta = texts(a);
      const tb = texts(b);
      for (const [key, text] of ta) {
        if (!text.startsWith("LIVE")) expect(tb.get(key), `seed ${seed}: ${key}`).toBe(text);
      }
    }
  });
});

describe("planProjection — an outcome only INFERRED is marked (codex phase 4 pass 24)", () => {
  for (const [status, inferred] of [["completed", false], ["error", false], ["timeout", false], ["aborted", false], ["yielded", false], ["persisted", true], ["streaming", true]] as const) {
    test(`run ${status}: born ${inferred ? "inferred" : "explicit"}`, () => {
      const plan = planProjection(
        view({
          runIds: ["R"],
          rowsOfRun: new Map([["R", [row("a", 3, { runId: "R", text: "un" })]]]),
          runs: new Map([["R", settled({ status })]]),
        }),
      );
      expect(plan.create[0]?.inferred).toBe(inferred);
    });
  }
});
