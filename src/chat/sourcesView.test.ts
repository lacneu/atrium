import { describe, expect, test } from "vitest";
import type { ProvenancePartView } from "./convexTypes";
import { ANON_PROVENANCE_PARTS } from "../../convex/lib/provenance.fixtures";
import {
  attachReference,
  entryTitle,
  groupLabel,
  hasProvenance,
  isContextExcerpt,
  isFindableDocument,
  itemMeta,
  itemSubId,
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

describe("document title vs underlying id (3.2.13: show name, keep id)", () => {
  test("itemTitle prefers the human title; itemSubId surfaces the kept file_name", () => {
    const item = {
      file_name: "gdrive/abc123",
      title: "Rapport Q3.docx",
      type: "hybrid",
    };
    expect(itemTitle(item)).toBe("Rapport Q3.docx");
    expect(itemSubId(item)).toBe("gdrive/abc123");
  });

  test("no title → itemTitle falls back to file_name (the gdrive id), no subId line", () => {
    const item = { file_name: "gdrive/abc123", type: "hybrid" };
    expect(itemTitle(item)).toBe("gdrive/abc123");
    expect(itemSubId(item)).toBeUndefined();
  });

  test("the kept gdrive id stays SEARCHABLE even behind a human title", () => {
    const part = documentsPart([
      { file_name: "gdrive/abc123", title: "Rapport Q3.docx", type: "hybrid" },
    ]);
    const [entry] = sourceEntries([part], "documents");
    expect(sourceMatchesQuery(entry, "Rapport")).toBe(true); // by title
    expect(sourceMatchesQuery(entry, "abc123")).toBe(true); // by underlying id
  });

  test("attachReference is the file_name (retrieval key the server allows), NEVER the title", () => {
    // Regression guard: the documentary-attach reference must stay file_name even when
    // a human title is shown — else attachDocuments filters it and fails no_references.
    expect(
      attachReference({ file_name: "gdrive/abc123", title: "Rapport Q3.docx" }),
    ).toBe("gdrive/abc123");
  });

  test("a CONTEXT item with title + file_name is NOT findable (card hides the sub-id)", () => {
    // context:true wins → not an openable/citable document, so the card gates the
    // sub-id line on isFindableDocument and must NOT show file_name as a doc ref.
    const part = documentsPart([
      { id: "lightrag-context", context: true, file_name: "gdrive/x", title: "Blob" },
    ]);
    const [entry] = sourceEntries([part], "documents");
    expect(isContextExcerpt(entry)).toBe(true);
    expect(isFindableDocument(entry)).toBe(false);
  });
});

describe("summarizeProvenance", () => {
  test("counts items per group across parts", () => {
    expect(
      summarizeProvenance([
        memoryPart([{ id: "m1" }, { id: "m2" }]),
        documentsPart([{ file_name: "a.pdf" }]),
        memoryPart([{ id: "m3" }]),
      ]),
    ).toEqual({ memory: 3, documents: 1, context: 0 });
  });

  test("a documents item with NO file_name counts as CONTEXT, not a document", () => {
    // The LightRAG blob: { id: "lightrag-context", type: "hybrid", text: ... } —
    // a synthesized context excerpt, not a findable source. It must NOT inflate the
    // documents count (the prod bug: "DOCUMENTS · 1" naming a non-document).
    expect(
      summarizeProvenance([
        documentsPart([
          { file_name: "real.pdf" },
          { id: "lightrag-context", type: "hybrid", text: "graph…" },
        ]),
      ]),
    ).toEqual({ memory: 0, documents: 1, context: 1 });
  });

  test("no parts -> zero counts (the component renders nothing)", () => {
    expect(summarizeProvenance([])).toEqual({
      memory: 0,
      documents: 0,
      context: 0,
    });
  });
});

describe("hasProvenance (Sources chip visibility)", () => {
  test("true when ANY group is non-empty — including CONTEXT-only", () => {
    // A LightRAG reply with no per-file references is all context: the chip must
    // still show, else the panel (and the context source) is unreachable.
    expect(hasProvenance(summarizeProvenance([
      documentsPart([{ id: "lightrag-context", type: "hybrid", text: "g" }]),
    ]))).toBe(true);
    expect(hasProvenance({ memory: 0, documents: 1, context: 0 })).toBe(true);
    expect(hasProvenance({ memory: 2, documents: 0, context: 0 })).toBe(true);
  });
  test("false only when everything is empty", () => {
    expect(hasProvenance({ memory: 0, documents: 0, context: 0 })).toBe(false);
    expect(hasProvenance(summarizeProvenance([]))).toBe(false);
  });
});

describe("summaryLabel (every plural branch)", () => {
  test("singular memory only", () => {
    expect(summaryLabel({ memory: 1, documents: 0, context: 0 })).toBe("1 souvenir");
  });
  test("plural memory only", () => {
    expect(summaryLabel({ memory: 3, documents: 0, context: 0 })).toBe("3 souvenirs");
  });
  test("singular documents only", () => {
    expect(summaryLabel({ memory: 0, documents: 1, context: 0 })).toBe("1 document");
  });
  test("plural documents only", () => {
    expect(summaryLabel({ memory: 0, documents: 4, context: 0 })).toBe("4 documents");
  });
  test("singular / plural context", () => {
    expect(summaryLabel({ memory: 0, documents: 0, context: 1 })).toBe("1 contexte");
    expect(summaryLabel({ memory: 0, documents: 0, context: 2 })).toBe("2 contextes");
  });
  test("all three groups joined with a separator", () => {
    expect(summaryLabel({ memory: 2, documents: 1, context: 1 })).toBe(
      "2 souvenirs · 1 document · 1 contexte",
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

describe("isFindableDocument / isContextExcerpt / entryTitle", () => {
  test("findable: documents-group item WITH file_name (asymmetric origin slot)", () => {
    const [doc] = sourceEntries([documentsPart([{ file_name: "a.md" }])], "documents");
    const [mem] = sourceEntries([memoryPart([{ id: "m1", text: "x" }])], "memory");
    expect(isFindableDocument(doc)).toBe(true);
    expect(isContextExcerpt(doc)).toBe(false);
    expect(isFindableDocument(mem)).toBe(false); // memory has no file referent
  });

  test("the LightRAG blob (documents-group, NO file_name) is CONTEXT, not findable", () => {
    // The exact prod shape: { id: "lightrag-context", type: "hybrid", text: ... }.
    // It must NOT be findable (no "Source d'origine" → no broken documentary fetch),
    // and entryTitle gives a friendly label instead of the raw "lightrag-context".
    const [blob] = sourceEntries(
      [documentsPart([{ id: "lightrag-context", type: "hybrid", text: "graph…" }])],
      "documents",
    );
    expect(isFindableDocument(blob)).toBe(false); // ← kills the broken attach
    expect(isContextExcerpt(blob)).toBe(true);
    expect(entryTitle(blob)).not.toBe("lightrag-context"); // friendly label
    expect(entryTitle(blob)).toBe("Contexte du graphe de connaissances");
  });

  test("entryTitle of a real document is its file_name (unchanged)", () => {
    const [doc] = sourceEntries(
      [documentsPart([{ file_name: "rapport-q3.pdf", type: "hybrid" }])],
      "documents",
    );
    expect(entryTitle(doc)).toBe("rapport-q3.pdf");
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
    expect(isFindableDocument(entry)).toBe(true); // → reserved "origine" slot (L2 target)
  });

  test("3.2.11: a reference WITH retrieved content + score renders excerpt + relevance bar", () => {
    // The plugin now surfaces the per-document retrieved content as text + a score, so
    // the user sees the source material the RAG pulled (not just the id). The card must
    // render the excerpt and the relevance bar — and the item stays a findable document.
    const ref = documentsPart([
      {
        file_name: "rapport-q3.pdf",
        type: "hybrid",
        text: "Le chiffre d'affaires du T3 a progressé de 12 %.",
        score: 0.87,
      },
    ]);
    const [entry] = sourceEntries([ref], "documents");
    expect(entry.item.text).toBe("Le chiffre d'affaires du T3 a progressé de 12 %.");
    expect(entry.item.score).toBe(0.87);
    expect(isFindableDocument(entry)).toBe(true);
    expect(isContextExcerpt(entry)).toBe(false); // a real findable document, not the blob
  });
});

describe("anonymized production turn (LightRAG hybrid: bare docs + context + memory)", () => {
  // The real shape captured in prod (admin@ataraxis, 2026-06-23), anonymized: 4 bare
  // attribution documents + 1 synthesized context blob + 2 recalled memories. Pins the
  // exact "documents show no score/excerpt, only the context carries text" rendering the
  // user flagged — so a regression in classification or item plumbing fails here.
  const parts = ANON_PROVENANCE_PARTS as unknown as ProvenancePartView[];
  const docEntries = sourceEntries(parts, "documents");

  test("summarizes the real shape: 2 memory · 4 documents · 1 context", () => {
    expect(summarizeProvenance(parts)).toEqual({
      memory: 2,
      documents: 4,
      context: 1,
    });
  });

  test("the 4 LightRAG documents are findable but carry NO score and NO excerpt", () => {
    const docs = docEntries.filter((e) => isFindableDocument(e));
    expect(docs).toHaveLength(4);
    for (const e of docs) {
      expect(e.item.score).toBeUndefined(); // → no relevance bar
      expect(e.item.text).toBeUndefined(); // → no excerpt / no "Voir plus"
      expect(itemMeta(e.item)).toEqual(["hybrid"]); // type chip only
    }
  });

  test("the context blob is a non-findable excerpt that DOES carry text", () => {
    const ctx = docEntries.filter((e) => isContextExcerpt(e));
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.item.text).toBeTruthy();
    expect(isFindableDocument(ctx[0]!)).toBe(false); // not attachable
  });
});
