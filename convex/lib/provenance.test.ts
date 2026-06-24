import { describe, expect, test } from "vitest";
import {
  isFindableDocumentItem,
  provenanceItemKind,
} from "./provenance";

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
