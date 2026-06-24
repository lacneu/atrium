// @vitest-environment node
//
// Conformance test: the canonical provenance/v1 JSON Schema (the third-party
// plugin contract) agrees with the shared classification helper. ajv runs in a
// NODE env (it codegens via `new Function`, blocked in the default edge-runtime).
import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import schema from "../../docs/provenance/provenance.v1.schema.json";
import { provenanceItemKind } from "./provenance";

// draft 2020-12 (the schema's $schema) needs the 2020 ajv build.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const report = (over: Record<string, unknown> = {}) => ({
  v: 1,
  source: "knowledge",
  kind: "documents",
  items: [{ file_name: "guide.md" }],
  ...over,
});

describe("provenance.v1 schema — valid reports", () => {
  test("a documents report with a findable document + a context blob", () => {
    const r = report({
      retrieval: { route: "lightrag", lightrag: { mode: "hybrid" } },
      items: [
        { file_name: "ataraxis/notes.md", type: "hybrid" },
        { id: "lightrag-context", type: "hybrid", context: true, text: "graph…" },
      ],
    });
    expect(validate(r)).toBe(true);
  });

  test("a memory report", () => {
    expect(
      validate({ v: 1, source: "hindsight", kind: "memory", items: [{ id: "m1" }] }),
    ).toBe(true);
  });
});

describe("provenance.v1 schema — rejected reports", () => {
  test("wrong version", () => expect(validate(report({ v: 2 }))).toBe(false));
  test("missing items", () => {
    const r = report();
    delete (r as Record<string, unknown>).items;
    expect(validate(r)).toBe(false);
  });
  test("bad kind", () => expect(validate(report({ kind: "graph" }))).toBe(false));
  test("empty source (bridge drops it)", () =>
    expect(validate(report({ source: "" }))).toBe(false));
  test("over the 24-item cap", () =>
    expect(validate(report({ items: Array.from({ length: 25 }, () => ({ file_name: "a" })) }))).toBe(false));
  // The schema must match the bridge's acceptance: the bridge drops a report with no
  // citable item, so a "conformant" plugin can't pass here yet be silently dropped.
  test("empty items array", () => expect(validate(report({ items: [] }))).toBe(false));
  test("an item with no recognized field", () =>
    expect(validate(report({ items: [{ foo: "bar" }] }))).toBe(false));
  test("item text over 2000 chars", () =>
    expect(validate(report({ items: [{ file_name: "a", text: "x".repeat(2001) }] }))).toBe(false));
  test("context other than literal true", () =>
    expect(validate(report({ items: [{ file_name: "a", context: "yes" }] }))).toBe(false));
  test("an item whose ONLY field is an empty string (bridge drops it → rejected)", () => {
    expect(validate(report({ items: [{ id: "" }] }))).toBe(false);
    expect(validate(report({ items: [{ file_name: "" }] }))).toBe(false);
  });
});

describe("provenance.v1 schema — accepts what the bridge keeps", () => {
  test("an empty non-citable string is fine WHEN another field is citable", () => {
    // The bridge drops the empty `text` but keeps the item (file_name citable), so
    // the schema must NOT reject it — minLength lives in the anyOf branches only.
    expect(validate(report({ items: [{ file_name: "a.md", text: "" }] }))).toBe(true);
  });
});

describe("schema ↔ provenanceItemKind agree", () => {
  // Every item the schema accepts in a documents report classifies as exactly one of
  // document/context per the shared helper — the contract the UI + server enforce.
  test("document / explicit context / inferred context", () => {
    expect(provenanceItemKind({ file_name: "a.md" }, "documents")).toBe("document");
    expect(provenanceItemKind({ id: "blob", context: true }, "documents")).toBe("context");
    expect(provenanceItemKind({ id: "blob" }, "documents")).toBe("context");
  });
});
