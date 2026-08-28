/// <reference types="vite/client" />
//
// ONE derivation of "what does this turn quote".
//
// A turn's quotes live in two vintages: the three singular `quoted*` fields
// (rows written when a turn could only quote one passage) and the `quotedRefs`
// array. `convex/lib/quoteReply.ts` reads both and every other file goes through
// it. This ratchet is what keeps that true: a site that reads a raw field again
// answers for one vintage only — which is precisely how an attachment-only
// multi-quote turn would stop counting as content in five predicates at once.
//
// PARSED, not scanned. A first version matched the text `.quotedRefs`, which a
// destructuring (`const { quotedRefs } = row`) or an indexed access
// (`row["quotedRefs"]`) walks straight past — a guard that is quietly blind
// teaches everyone to trust it. The compiler already knows what a read is.

import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { hasQuotes, outboxExcerpts, quotedRefsOf } from "./lib/quoteReply";

/** The derivation itself, the schema that declares the fields, and the import's
 *  reference tables (which name a field as DATA, in a string, not as a read). */
const ALLOWED = ["lib/quoteReply.ts", "schema.ts", "archiveImport.ts"];

const RAW_FIELDS = new Set([
  "quotedExcerpt",
  "quotedMessageId",
  "quotedBlockIndex",
  "quotedExcerpts",
  "quotedRefs",
]);

/**
 * Every READ of a raw quote field, by line.
 *
 * Three shapes count, because all three retrieve the value:
 *   - `row.quotedRefs`            property access
 *   - `row["quotedRefs"]`         indexed access with a literal
 *   - `const { quotedRefs } = row` destructuring in a binding pattern
 *
 * A WRITE does not: `{ quotedRefs: … }` in an insert or a patch names the field
 * without answering for a vintage. Property ASSIGNMENT in an object literal is
 * therefore excluded, and so is a type member declaration.
 */
export function readsRawQuoteField(source: string): number[] {
  const file = ts.createSourceFile(
    "probe.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const hits: number[] = [];
  const at = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      RAW_FIELDS.has(node.name.text)
    ) {
      hits.push(at(node));
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      RAW_FIELDS.has(node.argumentExpression.text)
    ) {
      hits.push(at(node));
    } else if (ts.isBindingElement(node)) {
      // `const { quotedRefs } = row`, `{ quotedRefs: refs }`,
      // `{ "quotedRefs": refs }` and `{ ["quotedRefs"]: refs }` all read the
      // same property — the SOURCE name is what counts, in each of its four
      // spellings. Recognising only the identifier form left two valid ways to
      // walk past the guard.
      const name = node.propertyName ?? node.name;
      const read =
        ts.isIdentifier(name) || ts.isStringLiteralLike(name)
          ? name.text
          : ts.isComputedPropertyName(name) &&
              ts.isStringLiteralLike(name.expression)
            ? name.expression.text
            : null;
      if (read !== null && RAW_FIELDS.has(read)) hits.push(at(node));
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return hits.sort((a, b) => a - b);
}

function convexSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "_generated" || entry.name === "node_modules") continue;
        walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push({
        file: `${prefix}${entry.name}`,
        source: readFileSync(new URL(entry.name, dir), "utf8"),
      });
    }
  };
  walk(new URL(".", import.meta.url), "");
  return out;
}

describe("the quote fields are read in exactly one place", () => {
  test("no convex file outside the derivation reads a raw quoted* field", () => {
    const offenders: string[] = [];
    for (const { file, source } of convexSources()) {
      if (ALLOWED.includes(file)) continue;
      for (const line of readsRawQuoteField(source)) {
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the check SEES the three shapes of a read", () => {
    // Guards the guard: the shapes a text scan walks past.
    expect(readsRawQuoteField("const a = row.quotedRefs;")).toHaveLength(1);
    expect(readsRawQuoteField('const a = row["quotedExcerpt"];')).toHaveLength(1);
    expect(readsRawQuoteField("const { quotedRefs } = row;")).toHaveLength(1);
    expect(readsRawQuoteField("const { quotedRefs: r } = row;")).toHaveLength(1);
    expect(readsRawQuoteField('const { "quotedRefs": r } = row;')).toHaveLength(1);
    expect(readsRawQuoteField('const { ["quotedExcerpt"]: e } = row;')).toHaveLength(1);
    // A WRITE is not a read.
    expect(readsRawQuoteField("db.patch(id, { quotedRefs: x });")).toEqual([]);
    // Nor is a name that merely resembles one.
    expect(readsRawQuoteField("const a = row.quotedRefsCount;")).toEqual([]);
  });
});

describe("the import remaps the CAPPED list, not the raw one", () => {
  // DERIVED FROM THE SOURCE, because the property is a COST: remapping the raw
  // array runs one indexed read per raw element instead of at most
  // QUOTE_MAX_PER_TURN, which past the transaction limits fails every import
  // attempt atomically. Both spellings persist the same rows, so nothing the
  // harness can observe tells them apart — the same reason the pagination
  // ratchet reads the source rather than running the code.
  test("the array remap reads `out`, never the untouched archive row", () => {
    const source = readFileSync(
      new URL("archiveImport.ts", import.meta.url),
      "utf8",
    );
    const file = ts.createSourceFile(
      "archiveImport.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    // What the array remap iterates: `const items = <object>[ref.field]`. The
    // top-level reference table legitimately reads `row[ref.field]` — nothing
    // caps those — so the assertion is on THIS binding, not on the file.
    const initializers: string[] = [];
    const walk = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "items" &&
        node.initializer !== undefined &&
        ts.isElementAccessExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression)
      ) {
        initializers.push(node.initializer.expression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
    expect(initializers).toEqual(["out"]);
  });
});

describe("the derivation answers for BOTH vintages", () => {
  // BEHAVIOURAL, not textual: asserting that the helper's source mentions the
  // old field names would stay green if it read them and threw them away.
  test("a pre-widening row still yields its passage", () => {
    expect(
      quotedRefsOf({
        quotedMessageId: "m1",
        quotedBlockIndex: 3,
        quotedExcerpt: "ancien",
      }),
    ).toEqual([{ messageId: "m1", blockIndex: 3, excerpt: "ancien" }]);
    expect(hasQuotes({ quotedExcerpt: "ancien" })).toBe(true);
    expect(outboxExcerpts({ quotedExcerpt: "ancien" })).toEqual(["ancien"]);
  });

  test("a widened row yields all of its passages", () => {
    expect(
      quotedRefsOf({
        quotedRefs: [
          { messageId: "m1", blockIndex: 0, excerpt: "a" },
          { blockIndex: null, excerpt: "b" },
        ],
      }),
    ).toEqual([
      { messageId: "m1", blockIndex: 0, excerpt: "a" },
      { blockIndex: null, excerpt: "b" },
    ]);
    expect(outboxExcerpts({ quotedExcerpts: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test("a turn quoting nothing yields nothing, whatever the vintage", () => {
    expect(quotedRefsOf({})).toEqual([]);
    expect(quotedRefsOf({ quotedRefs: [] })).toEqual([]);
    expect(outboxExcerpts({})).toEqual([]);
    expect(hasQuotes({})).toBe(false);
  });
});
