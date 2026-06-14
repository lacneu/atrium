import { describe, expect, test } from "vitest";
import type { ProvenancePartView } from "./convexTypes";
import {
  groupLabel,
  itemMeta,
  itemTitle,
  orderedParts,
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
