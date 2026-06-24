// Anonymized real-world provenance fixture, captured from production (a LightRAG
// "hybrid" turn, admin@ataraxis chat, 2026-06-23) and used by the unit tests so the
// "documents show no score / no excerpt" shape is pinned against regression.
//
// What the real turn produced (and this reproduces):
//  - FOUR source DOCUMENTS surfaced as bare attribution — `file_name` only, NO `score`,
//    NO `text`. This is BY DESIGN for a retriever that SYNTHESIZES (PROVENANCE_CONTRACT
//    §"retrieval that SYNTHESIZES"): LightRAG attributes the graph context to source
//    files but does not carry a per-reference score, and the retrieved chunk text is
//    deliberately never copied (it is not the injected text — anti-leak).
//  - ONE synthesized CONTEXT blob (`context: true`) carrying the injected,
//    post-truncation excerpt — the ONLY item with `text`.
//  - a separate hindsight MEMORY report (two recalled items).
//
// Everything identifying is ANONYMIZED (fake gdrive ids, neutral knowledge-graph text).
// The SHAPE is the contract under test, not the content.

/** A documents-group LightRAG report: 4 bare attribution documents + 1 context blob. */
export const ANON_LIGHTRAG_DOCUMENTS_PART = {
  kind: "provenance" as const,
  v: 1,
  pluginId: "openclaw-knowledge",
  source: "knowledge",
  group: "documents" as const,
  injected: { chars: 3818, position: "system_append", truncated: true },
  retrieval: { route: "lightrag", lightragMode: "hybrid" },
  items: [
    { file_name: "gdrive/a1b2c3d4e5f60718293a4b5c6d7e8f90", type: "hybrid" },
    { file_name: "gdrive/0f1e2d3c4b5a69788796a5b4c3d2e1f0", type: "hybrid" },
    { file_name: "gdrive/11223344556677889900112233445566", type: "hybrid" },
    { file_name: "gdrive/99aabbccddeeff00112233445566778899", type: "hybrid" },
    {
      id: "lightrag-context",
      type: "hybrid",
      context: true,
      text:
        'Knowledge Graph Data (Entity): ```json {"entity": "Sample Concept", "type": ' +
        '"concept", "description": "An anonymized knowledge-graph entity standing in for ' +
        'the injected, post-truncation context excerpt."}```',
    },
  ],
};

/** A memory-group hindsight report: two recalled items (no openable source file). */
export const ANON_HINDSIGHT_MEMORY_PART = {
  kind: "provenance" as const,
  v: 1,
  pluginId: "openclaw-hindsight",
  source: "hindsight",
  group: "memory" as const,
  retrieval: { route: "hindsight" },
  items: [
    { id: "mem-1", type: "recall", score: 0.81 },
    { id: "mem-2", type: "recall", score: 0.74 },
  ],
};

/** The full anonymized turn: both reports, in the order the bridge appended them. */
export const ANON_PROVENANCE_PARTS = [
  ANON_LIGHTRAG_DOCUMENTS_PART,
  ANON_HINDSIGHT_MEMORY_PART,
];
