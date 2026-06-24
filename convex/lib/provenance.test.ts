import { describe, expect, test } from "vitest";
import {
  isFindableDocumentItem,
  provenanceItemKind,
  provenancePartStructure,
} from "./provenance";
import {
  ANON_HINDSIGHT_MEMORY_PART,
  ANON_LIGHTRAG_DOCUMENTS_PART,
} from "./provenance.fixtures";

// The ONE classification rule shared by the Sources UI and the server attach gate.
// If this drifts, the UI and the trust boundary disagree on what is attachable.

describe("provenanceItemKind", () => {
  test("memory group → memory (regardless of fields)", () => {
    expect(provenanceItemKind({ id: "m1" }, "memory")).toBe("memory");
    expect(provenanceItemKind({ file_name: "x.md" }, "memory")).toBe("memory");
  });

  test("documents + file_name → document (findable)", () => {
    expect(provenanceItemKind({ file_name: "guide.md" }, "documents")).toBe("document");
    expect(isFindableDocumentItem({ file_name: "guide.md" }, "documents")).toBe(true);
  });

  test("documents + explicit context:true → context (even with a file_name)", () => {
    expect(
      provenanceItemKind({ file_name: "blob", context: true }, "documents"),
    ).toBe("context");
    expect(
      isFindableDocumentItem({ file_name: "blob", context: true }, "documents"),
    ).toBe(false);
  });

  test("documents + no file_name → context (backward-compat inference)", () => {
    // The pre-`context` LightRAG blob: { id: "lightrag-context", type: "hybrid" }.
    expect(provenanceItemKind({}, "documents")).toBe("context");
    expect(isFindableDocumentItem({}, "documents")).toBe(false);
  });

  test("a `context:false` documents item with a file_name stays a document", () => {
    expect(
      provenanceItemKind({ file_name: "real.pdf", context: false }, "documents"),
    ).toBe("document");
  });
});

describe("provenancePartStructure (SOC2 diagnostic shape)", () => {
  test("the real LightRAG-hybrid turn: bare documents + one context excerpt", () => {
    const s = provenancePartStructure(ANON_LIGHTRAG_DOCUMENTS_PART);
    expect(s.group).toBe("documents");
    expect(s.source).toBe("knowledge");
    expect(s.retrievalRoute).toBe("lightrag");
    expect(s.itemCount).toBe(5);
    expect(s.truncated).toBe(true);
    // hasExcerpts is part-level: the ONE context blob carried text.
    expect(s.hasExcerpts).toBe(true);
    // THE bug signature this fixture pins: the 4 documents are findable but carry no
    // score (LightRAG attribution is file_name-only) — so the Sources panel shows no
    // relevance bar / excerpt for them, and an operator can see exactly that here.
    const docs = s.items.filter((i) => i.kind === "document");
    expect(docs).toHaveLength(4);
    expect(docs.every((i) => i.hasFileName && !i.hasScore)).toBe(true);
    const ctx = s.items.filter((i) => i.kind === "context");
    expect(ctx).toEqual([{ kind: "context", hasFileName: false, hasScore: false }]);
  });

  test("a memory report: items classify as memory; route unknown folds to 'other'", () => {
    const s = provenancePartStructure(ANON_HINDSIGHT_MEMORY_PART);
    expect(s.group).toBe("memory");
    expect(s.source).toBe("hindsight");
    expect(s.retrievalRoute).toBe("other"); // "hindsight" is not a known RETRIEVAL route
    expect(s.items).toEqual([
      { kind: "memory", hasFileName: false, hasScore: true },
      { kind: "memory", hasFileName: false, hasScore: true },
    ]);
  });

  test("an unknown emitter source folds to 'other' (no raw free-text passthrough)", () => {
    const s = provenancePartStructure({
      source: "evil-plugin\nINJECTED",
      group: "documents",
      items: [{ file_name: "x.pdf", score: 0.5 }],
    });
    expect(s.source).toBe("other");
  });

  test("SOC2: the structure carries NO file_name / text / score VALUES", () => {
    // Sentinel content planted in the part — none of it may appear in the structure.
    const planted = provenancePartStructure({
      source: "knowledge",
      group: "documents",
      retrieval: { route: "lightrag" },
      items: [
        { file_name: "gdrive/SECRET_FILE_ID_42", score: 0.9123, type: "hybrid" },
        { id: "lightrag-context", context: true, text: "SECRET_INJECTED_TEXT" },
      ],
    });
    const serialized = JSON.stringify(planted);
    expect(serialized).not.toContain("SECRET_FILE_ID_42");
    expect(serialized).not.toContain("SECRET_INJECTED_TEXT");
    expect(serialized).not.toContain("0.9123");
    expect(serialized).not.toContain("hybrid"); // raw emitter `type` is never reflected
    // But the structural signal IS present.
    expect(planted.items[0]).toEqual({
      kind: "document",
      hasFileName: true,
      hasScore: true,
    });
  });
});
