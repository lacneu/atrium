/**
 * Provenance contract (provenance/v1) — bridge half.
 *
 * The report fixtures below are CAPTURED VERBATIM from the live bench
 * (provenance-probe plugin -> gateway agent-event bus -> operator WS,
 * 2026-06-12, OpenClaw 2026.6.1): the gateway scopes plugin streams to
 * `<pluginId>.<suffix>` and stamps pluginId/pluginName into data. Pins:
 *   - parseProvenanceReport: bounds, rejections, field-by-field rebuild
 *   - parseProvenanceFrame: pre-turn admission (sessionKey + runId gates)
 *   - RunManager pipeline: pre-turn stash flushed per-runId at beginTurn,
 *     active-path frames -> addProvenancePart, per-turn cap.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_ITEM_TEXT_CHARS,
  MAX_PART_JSON_CHARS,
  MAX_PROVENANCE_ITEMS,
  MAX_PROVENANCE_PARTS_PER_TURN,
  isProvenanceStream,
  parseProvenanceFrame,
  parseProvenanceReport,
} from "../src/core/provenance.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ProvenancePart,
  ToolPart,
} from "../src/convex-writer.js";

const SESSION_KEY = "agent:main:webchat:chat:prov-user:prov-probe-4";
const RUN_ID =
  "webchat-47806df6f283c5f83c519ebeac8df34b97ba7ea69a20749c724f6f4570e833a0";

// Bench-captured report payloads (gateway-stamped pluginId/pluginName).
const MEMORY_REPORT = {
  v: 1,
  source: "hindsight",
  kind: "memory",
  injected: { chars: 420, position: "system_prepend", truncated: false },
  retrieval: { route: "ALL", bank: "bench::probe::user" },
  items: [
    {
      id: "mem_bench_001",
      type: "observation",
      date: "2026-06-01",
      score: 0.91,
      text: "Bench observation: the user prefers concise answers.",
    },
    {
      id: "mem_bench_002",
      type: "world",
      date: "2026-05-20",
      score: 0.84,
      text: "Bench fact: the validation bench runs a pinned gateway.",
    },
  ],
  pluginId: "provenance-probe",
  pluginName: "Provenance Contract Probe",
};

const DOCUMENTS_REPORT = {
  v: 1,
  source: "knowledge",
  kind: "documents",
  injected: { chars: 1300, position: "system_append", truncated: false },
  retrieval: {
    route: "pgvector",
    collections: ["knowledge_bench"],
    lightrag: { mode: "mix", contextChars: 0 },
  },
  items: [
    {
      file_name: "bench-compliance-report.pdf",
      collection: "knowledge_bench",
      score: 0.93,
      text: "Bench chunk: section 4.2 defines the retention policy.",
    },
  ],
  pluginId: "provenance-probe",
  pluginName: "Provenance Contract Probe",
};

/** The exact operator-WS frame shape captured on the bench. */
function provenanceFrame(data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN_ID,
      stream: "provenance-probe.provenance",
      sessionKey: SESSION_KEY,
      data,
      seq: 1,
      ts: 1781305683716,
      isHeartbeat: false,
      ...overrides,
    },
    seq: 2,
  };
}

describe("isProvenanceStream", () => {
  it("accepts <pluginId>.provenance, rejects everything else", () => {
    expect(isProvenanceStream("provenance-probe.provenance")).toBe(true);
    expect(isProvenanceStream("openclaw-knowledge.provenance")).toBe(true);
    expect(isProvenanceStream(".provenance")).toBe(false); // no plugin id
    expect(isProvenanceStream("provenance")).toBe(false); // host-style bare
    expect(isProvenanceStream("lifecycle")).toBe(false);
    expect(isProvenanceStream("tool")).toBe(false);
    expect(isProvenanceStream(undefined)).toBe(false);
  });
});

describe("parseProvenanceReport (bounded, field-by-field)", () => {
  it("parses the bench-captured memory report", () => {
    const part = parseProvenanceReport(MEMORY_REPORT);
    expect(part).not.toBeNull();
    expect(part).toMatchObject({
      kind: "provenance",
      v: 1,
      pluginId: "provenance-probe",
      source: "hindsight",
      group: "memory",
      injected: { chars: 420, position: "system_prepend", truncated: false },
      retrieval: { route: "ALL", bank: "bench::probe::user" },
    });
    expect(part!.items).toHaveLength(2);
    expect(part!.items[0]).toEqual({
      id: "mem_bench_001",
      type: "observation",
      date: "2026-06-01",
      score: 0.91,
      text: "Bench observation: the user prefers concise answers.",
    });
  });

  it("parses the bench-captured documents report (lightrag mode lifted)", () => {
    const part = parseProvenanceReport(DOCUMENTS_REPORT);
    expect(part).toMatchObject({
      group: "documents",
      source: "knowledge",
      retrieval: {
        route: "pgvector",
        collections: ["knowledge_bench"],
        lightragMode: "mix",
      },
    });
    expect(part!.items[0]!.file_name).toBe("bench-compliance-report.pdf");
  });

  it("rejects off-contract reports (version, identity, group, items)", () => {
    expect(parseProvenanceReport(null)).toBeNull();
    expect(parseProvenanceReport({ ...MEMORY_REPORT, v: 2 })).toBeNull(); // fwd-compat: ignore
    expect(parseProvenanceReport({ ...MEMORY_REPORT, pluginId: "" })).toBeNull();
    expect(parseProvenanceReport({ ...MEMORY_REPORT, source: undefined })).toBeNull();
    expect(parseProvenanceReport({ ...MEMORY_REPORT, kind: "telemetry" })).toBeNull();
    expect(parseProvenanceReport({ ...MEMORY_REPORT, items: [] })).toBeNull();
    expect(parseProvenanceReport({ ...MEMORY_REPORT, items: [{}] })).toBeNull(); // no identifying field
  });

  it("parses the additive `context` flag (true preserved, non-true dropped)", () => {
    const base = { v: 1, pluginId: "p", source: "knowledge", kind: "documents" };
    // The synthesized context excerpt declares context:true (provenance/v1).
    const withCtx = parseProvenanceReport({
      ...base,
      items: [{ id: "lightrag-context", context: true }],
    });
    expect(withCtx!.items[0]!.context).toBe(true);
    // Trust boundary: ONLY a literal true is honored; any other value is dropped.
    const offShape = parseProvenanceReport({
      ...base,
      items: [{ file_name: "a.md", context: "yes" }],
    });
    expect(offShape!.items[0]!.context).toBeUndefined();
  });

  it("BOUNDS: caps items, truncates text, refuses oversized totals", () => {
    const many = {
      ...MEMORY_REPORT,
      items: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` })),
    };
    expect(parseProvenanceReport(many)!.items).toHaveLength(MAX_PROVENANCE_ITEMS);

    const long = {
      ...MEMORY_REPORT,
      items: [{ id: "m1", text: "x".repeat(MAX_ITEM_TEXT_CHARS + 500) }],
    };
    expect(parseProvenanceReport(long)!.items[0]!.text).toHaveLength(
      MAX_ITEM_TEXT_CHARS,
    );

    // 24 items x 2000 chars passes per-field bounds but busts the JSON belt.
    const bloated = {
      ...MEMORY_REPORT,
      items: Array.from({ length: MAX_PROVENANCE_ITEMS }, (_, i) => ({
        id: `m${i}`,
        text: "y".repeat(MAX_ITEM_TEXT_CHARS),
      })),
    };
    expect(JSON.stringify(bloated).length).toBeGreaterThan(MAX_PART_JSON_CHARS);
    expect(parseProvenanceReport(bloated)).toBeNull();
  });

  it("drops unknown fields (rebuild, never spread network data)", () => {
    const part = parseProvenanceReport({
      ...MEMORY_REPORT,
      smuggled: { huge: "payload" },
      items: [{ id: "m1", smuggledToo: "x" }],
    })!;
    expect("smuggled" in part).toBe(false);
    expect("smuggledToo" in part.items[0]!).toBe(false);
  });
});

describe("parseProvenanceFrame (pre-turn admission)", () => {
  it("admits the bench-captured frame with its runId", () => {
    const got = parseProvenanceFrame(provenanceFrame(MEMORY_REPORT), SESSION_KEY);
    expect(got).not.toBeNull();
    expect(got!.runId).toBe(RUN_ID);
    expect(got!.part.group).toBe("memory");
  });

  it("rejects foreign sessions, missing runId, non-provenance streams", () => {
    expect(
      parseProvenanceFrame(provenanceFrame(MEMORY_REPORT), "agent:other:session"),
    ).toBeNull();
    expect(
      parseProvenanceFrame(
        provenanceFrame(MEMORY_REPORT, { runId: undefined }),
        SESSION_KEY,
      ),
    ).toBeNull();
    expect(
      parseProvenanceFrame(
        provenanceFrame(MEMORY_REPORT, { stream: "lifecycle" }),
        SESSION_KEY,
      ),
    ).toBeNull();
    expect(parseProvenanceFrame({ type: "res" }, SESSION_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RunManager pipeline
// ---------------------------------------------------------------------------

type Call =
  | ["startAssistant", string, string | null]
  | ["addProvenancePart", string, ProvenancePart]
  | ["other", string];

class FakeWriter implements ConvexWriter {
  readonly calls: Call[] = [];
  async startAssistant(chatId: string, runId: string | null): Promise<string> {
    this.calls.push(["startAssistant", chatId, runId]);
    return "msg_prov_1";
  }
  async appendDelta(): Promise<void> {
    this.calls.push(["other", "appendDelta"]);
  }
  async setSnapshot(): Promise<void> {
    this.calls.push(["other", "setSnapshot"]);
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {
    this.calls.push(["other", "addToolPart"]);
  }
  async addProvenancePart(messageId: string, part: ProvenancePart): Promise<void> {
    this.calls.push(["addProvenancePart", messageId, part]);
  }
  async addMedia(): Promise<void> {
    this.calls.push(["other", "addMedia"]);
  }
  async noteMediaUndelivered(): Promise<void> {
    this.calls.push(["other", "noteMediaUndelivered"]);
  }
  async finalize(_m: string, _s: FinalizeStatus): Promise<void> {
    this.calls.push(["other", "finalize"]);
  }
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  provenanceParts(): ProvenancePart[] {
    return this.calls
      .filter((c): c is ["addProvenancePart", string, ProvenancePart] =>
        c[0] === "addProvenancePart",
      )
      .map((c) => c[2]);
  }
}

describe("RunManager provenance pipeline", () => {
  it("PRE-TURN race: frames stashed while inactive flush at beginTurn (same runId)", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    // Reports arrive BEFORE the ack -> beginTurn (the prompt-build window).
    await rm.feed(provenanceFrame(MEMORY_REPORT), 1000);
    await rm.feed(provenanceFrame(DOCUMENTS_REPORT), 1000.1);
    expect(writer.provenanceParts()).toHaveLength(0); // nothing yet
    await rm.beginTurn(1000.2, RUN_ID);
    const parts = writer.provenanceParts();
    expect(parts.map((p) => p.group)).toEqual(["memory", "documents"]);
    // startAssistant precedes the parts (the message must exist first).
    expect(writer.calls[0]![0]).toBe("startAssistant");
  });

  it("DE-DUP: the SAME report emitted twice in one turn is stored once", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    // A plugin hook registered twice on a reload emits the identical report 2x.
    await rm.feed(provenanceFrame(MEMORY_REPORT), 1000);
    await rm.feed(provenanceFrame(MEMORY_REPORT), 1000.05); // exact duplicate
    await rm.feed(provenanceFrame(DOCUMENTS_REPORT), 1000.1);
    await rm.feed(provenanceFrame(DOCUMENTS_REPORT), 1000.15); // exact duplicate
    await rm.beginTurn(1000.2, RUN_ID);
    const parts = writer.provenanceParts();
    // Each report stored ONCE — not doubled (the "every source shown twice" bug).
    expect(parts.map((p) => p.group)).toEqual(["memory", "documents"]);
  });

  it("DE-DUP keeps DISTINCT reports of the same group (pgvector vs LightRAG)", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    // Two genuinely-different "documents" reports (different items) must BOTH
    // survive — only EXACT duplicates collapse.
    const pgvector = DOCUMENTS_REPORT;
    const lightrag = {
      ...DOCUMENTS_REPORT,
      items: [{ id: "lightrag-context", type: "graph", text: "Mock KG context." }],
    };
    await rm.feed(provenanceFrame(pgvector), 1000);
    await rm.feed(provenanceFrame(lightrag), 1000.1);
    await rm.beginTurn(1000.2, RUN_ID);
    const parts = writer.provenanceParts();
    expect(parts).toHaveLength(2); // both kept
    expect(parts.every((p) => p.group === "documents")).toBe(true);
  });

  it("PRE-TURN stash from a DIFFERENT run never leaks into this turn", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    await rm.feed(
      provenanceFrame(MEMORY_REPORT, { runId: "webchat-stale-run" }),
      1000,
    );
    await rm.beginTurn(1000.2, RUN_ID);
    expect(writer.provenanceParts()).toHaveLength(0);
  });

  it("DE-DUP is RUN-SCOPED: an identical report from a DIFFERENT run must not suppress this run's", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    // A stale/foreign run stashes a report, then THIS run emits the IDENTICAL one.
    await rm.feed(
      provenanceFrame(MEMORY_REPORT, { runId: "webchat-stale-run" }),
      1000,
    );
    await rm.feed(provenanceFrame(MEMORY_REPORT), 1000.1); // same content, RUN_ID
    await rm.beginTurn(1000.2, RUN_ID);
    // Regression guard: a GLOBAL (non-run-scoped) dedup drops this run's report as a
    // "duplicate" of the foreign one → beginTurn(RUN_ID) then flushes NOTHING and the
    // run loses all its sources despite a valid frame.
    expect(writer.provenanceParts().map((p) => p.group)).toEqual(["memory"]);
  });

  it("ACTIVE path: a provenance frame after beginTurn writes the part", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    await rm.beginTurn(1000, RUN_ID);
    await rm.feed(provenanceFrame(DOCUMENTS_REPORT), 1000.5);
    const parts = writer.provenanceParts();
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "provenance",
      pluginId: "provenance-probe",
      group: "documents",
    });
  });

  it("per-turn cap bounds a misbehaving emitter", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    await rm.beginTurn(1000, RUN_ID);
    for (let i = 0; i < MAX_PROVENANCE_PARTS_PER_TURN + 5; i++) {
      await rm.feed(provenanceFrame(MEMORY_REPORT), 1000 + i);
    }
    expect(writer.provenanceParts()).toHaveLength(MAX_PROVENANCE_PARTS_PER_TURN);
  });

  it("a malformed report frame is dropped without breaking the turn", async () => {
    const writer = new FakeWriter();
    const rm = new RunManager("chat_p", SESSION_KEY, writer);
    await rm.beginTurn(1000, RUN_ID);
    await rm.feed(provenanceFrame({ v: 99, garbage: true }), 1000.5);
    expect(writer.provenanceParts()).toHaveLength(0);
  });
});
