import { describe, expect, test } from "vitest";
import type { ProvenancePartView } from "./convexTypes";
import {
  groupLabel,
  isDocumentEntry,
  itemMeta,
  itemTitle,
  orderedParts,
  sourceEntries,
  sourceMatchesQuery,
  summarizeProvenance,
  summaryLabel,
} from "./sourcesView";

// Pure projections for the Sources affordance. Every parameterized i18n
// branch is exercised (GC-P5 lesson: parity/tsc alone do not verify them).

const memoryPart = (items: ProvenancePartView["items"]): ProvenancePartView => ({
  kind: "provenance",
  v: 1,
  pluginId: "hindsight-openclaw",
  source: "hindsight",
  group: "memory",
  items,
});

const documentsPart = (
  items: ProvenancePartView["items"],
): ProvenancePartView => ({
  kind: "provenance",
  v: 1,
  pluginId: "openclaw-knowledge",
  source: "knowledge",
  group: "documents",
  items,
});

describe("summarizeProvenance", () => {
  test("counts items per group across parts", () => {
    expect(
      summarizeProvenance([
        memoryPart([{ id: "m1" }, { id: "m2" }]),
        documentsPart([{ file_name: "a.pdf" }]),
        memoryPart([{ id: "m3" }]),
      ]),
    ).toEqual({ memory: 3, documents: 1 });
  });

  test("no parts -> zero counts (the component renders nothing)", () => {
    expect(summarizeProvenance([])).toEqual({ memory: 0, documents: 0 });
  });
});

describe("summaryLabel (every plural branch)", () => {
  test("singular memory only", () => {
    expect(summaryLabel({ memory: 1, documents: 0 })).toBe("1 souvenir");
  });
  test("plural memory only", () => {
    expect(summaryLabel({ memory: 3, documents: 0 })).toBe("3 souvenirs");
  });
  test("singular documents only", () => {
    expect(summaryLabel({ memory: 0, documents: 1 })).toBe("1 document");
  });
  test("plural documents only", () => {
    expect(summaryLabel({ memory: 0, documents: 4 })).toBe("4 documents");
  });
  test("both groups joined with a separator", () => {
    expect(summaryLabel({ memory: 2, documents: 1 })).toBe(
      "2 souvenirs · 1 document",
    );
  });
});

describe("itemTitle / itemMeta", () => {
  test("title precedence: file_name > id > type > untitled", () => {
    expect(itemTitle({ file_name: "a.pdf", id: "x", type: "world" })).toBe(
      "a.pdf",
    );
    expect(itemTitle({ id: "mem_1", type: "world" })).toBe("mem_1");
    expect(itemTitle({ type: "observation" })).toBe("observation");
    expect(itemTitle({})).toBe("(sans titre)");
  });

  test("meta chips: type/date/collection/score; score formatted 2 decimals", () => {
    expect(
      itemMeta({
        id: "m1",
        type: "observation",
        date: "2026-06-01",
        collection: "knowledge_bench",
        score: 0.9123,
      }),
    ).toEqual(["observation", "2026-06-01", "knowledge_bench", "score 0.91"]);
  });

  test("type chip is suppressed when it IS the title (memory item w/o id)", () => {
    expect(itemMeta({ type: "observation" })).toEqual([]);
  });

  test("absent fields produce no chips", () => {
    expect(itemMeta({ id: "m1" })).toEqual([]);
  });
});

describe("orderedParts / groupLabel", () => {
  test("memory groups render before documents", () => {
    const ordered = orderedParts([
      documentsPart([{ file_name: "a.pdf" }]),
      memoryPart([{ id: "m1" }]),
    ]);
    expect(ordered.map((p) => p.group)).toEqual(["memory", "documents"]);
  });

  test("group labels (both branches)", () => {
    expect(groupLabel("memory")).toBe("Mémoire conversationnelle");
    expect(groupLabel("documents")).toBe("Documents");
  });
});

describe("sourceEntries (side-panel flatten)", () => {
  test("flattens ONE group into entries, best score first, with stable keys", () => {
    const parts = [
      documentsPart([
        { file_name: "faq.md", score: 0.72, text: "Q/R" },
        { file_name: "guide.md", score: 0.87, text: "Le déploiement…" },
      ]),
      memoryPart([{ id: "mem-1", type: "observation", score: 0.6, text: "x" }]),
    ];
    const docs = sourceEntries(parts, "documents");
    expect(docs.map((e) => e.item.file_name)).toEqual(["guide.md", "faq.md"]); // score desc
    expect(docs.every((e) => e.group === "documents")).toBe(true);
    // Keys are unique + stable.
    expect(new Set(docs.map((e) => e.key)).size).toBe(2);
    // The other group is NOT included.
    expect(sourceEntries(parts, "memory").map((e) => e.item.id)).toEqual(["mem-1"]);
  });

  test("entries from two DISTINCT same-group reports all appear (pgvector + lightrag)", () => {
    const pgvector = documentsPart([{ file_name: "guide.md", score: 0.87 }]);
    const lightrag = documentsPart([{ id: "lightrag-context", type: "graph", score: 0.5 }]);
    const entries = sourceEntries([pgvector, lightrag], "documents");
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.key)).size).toBe(2); // no key collision
  });
});

describe("sourceMatchesQuery", () => {
  const [entry] = sourceEntries(
    [documentsPart([{ file_name: "guide-deploiement.md", score: 0.87, text: "Projet Hélios" }])],
    "documents",
  );
  test("empty query matches everything", () => {
    expect(sourceMatchesQuery(entry, "")).toBe(true);
    expect(sourceMatchesQuery(entry, "   ")).toBe(true);
  });
  test("matches on title, excerpt, and meta — case-insensitive", () => {
    expect(sourceMatchesQuery(entry, "DEPLOIEMENT")).toBe(true); // title
    expect(sourceMatchesQuery(entry, "hélios")).toBe(true); // excerpt
    expect(sourceMatchesQuery(entry, "0.87")).toBe(true); // score chip
  });
  test("returns false when nothing matches", () => {
    expect(sourceMatchesQuery(entry, "zzz-absent")).toBe(false);
  });
});

describe("isDocumentEntry", () => {
  test("true for documents, false for memory (asymmetric origin slot)", () => {
    const [doc] = sourceEntries([documentsPart([{ file_name: "a.md" }])], "documents");
    const [mem] = sourceEntries([memoryPart([{ id: "m1", text: "x" }])], "memory");
    expect(isDocumentEntry(doc)).toBe(true);
    expect(isDocumentEntry(mem)).toBe(false);
  });
});

describe("LightRAG reference items (3.2.8: file_name + type, no text/score)", () => {
  test("a reference-shaped item renders cleanly (title=file, one type chip, no excerpt/score)", () => {
    // 3.2.8 emits source-attribution items: { file_name: <path>, type: <mode> }
    // — NO text, NO score. The card must show title + a type chip and nothing
    // broken (no relevance bar, no excerpt, no "Voir plus").
    const ref = documentsPart([{ file_name: "rapport-q3.pdf", type: "hybrid" }]);
    const [entry] = sourceEntries([ref], "documents");
    expect(itemTitle(entry.item)).toBe("rapport-q3.pdf");
    expect(itemMeta(entry.item)).toEqual(["hybrid"]); // type only; no date/collection/score
    expect(entry.item.text).toBeUndefined(); // → no excerpt / no "Voir plus"
    expect(entry.item.score).toBeUndefined(); // → no relevance bar
    expect(isDocumentEntry(entry)).toBe(true); // → reserved "origine" slot (L2 target)
  });
});
