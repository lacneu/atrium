// Convex's allowlist must cover exactly what the bridge mints, and neither side
// may drift quietly: a cause the bridge adds would reach storage as
// `unclassified` — honest, but the gap again, since the whole point of the field
// is that a red turn can still be named a day later.
//
// The bridge owns the vocabulary as a TYPE (`bridge/src/core/finalize-causes.ts`),
// so its own call sites are checked by the compiler. The first version of this
// test tried to rediscover the vocabulary by walking the bridge's call sites with
// the TypeScript AST, and it was wrong within the hour: the causes reach
// `finalize` through several shapes, a positional rule saw ten of twenty-one, and
// it missed `side_result_error` and the three connection codes entirely. Reading
// ONE exported declaration is mechanical and cannot be fooled that way.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CONVEX_MINTED_CAUSES, FINALIZE_CAUSES } from "./lib/finalizeCause";

const DECLARATION = new URL(
  "../bridge/src/core/finalize-causes.ts",
  import.meta.url,
).pathname;

/** The members of the bridge's `FINALIZE_CAUSES` array literal. */
function bridgeVocabulary(): string[] {
  const source = readFileSync(DECLARATION, "utf8");
  const sf = ts.createSourceFile(
    DECLARATION,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let members: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "FINALIZE_CAUSES" &&
      node.initializer !== undefined
    ) {
      // `[...] as const satisfies readonly FinalizeCause[]` — unwrap both.
      let init: ts.Node = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) {
        init = init.expression;
      }
      if (ts.isArrayLiteralExpression(init)) {
        members = init.elements
          .filter(ts.isStringLiteral)
          .map((e) => e.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (members === null) {
    throw new Error("FINALIZE_CAUSES not found in the bridge declaration");
  }
  return members;
}

describe("the finalize-cause vocabulary is one vocabulary", () => {
  const bridge = bridgeVocabulary();

  test("the parse found the real declaration (a silent zero would pass for ever)", () => {
    // The failure mode of every derived check: a walk that matches nothing makes
    // the comparison below vacuously true.
    expect(bridge.length).toBeGreaterThanOrEqual(15);
    expect(bridge).toContain("gateway_final");
    expect(new Set(bridge).size, "the bridge list has a duplicate").toBe(
      bridge.length,
    );
    // A cause Convex mints itself must NOT also be claimed by the bridge: two
    // writers for one word is how a verdict stops meaning one thing.
    for (const own of CONVEX_MINTED_CAUSES) {
      expect(bridge, `${own} is minted on both sides`).not.toContain(own);
      expect(FINALIZE_CAUSES.has(own), `${own} must be storable`).toBe(true);
    }
  });

  test("Convex knows every cause the bridge can send", () => {
    const unknown = bridge.filter((cause) => !FINALIZE_CAUSES.has(cause));
    expect(
      unknown,
      "add these to convex/lib/finalizeCause.ts, or they store as `unclassified`",
    ).toEqual([]);
  });

  test("…and claims none the bridge cannot", () => {
    // A stale entry is inert, but it is how a vocabulary rots: a name kept here
    // long after its site is gone reads as something we can still receive.
    const stale = [...FINALIZE_CAUSES].filter(
      (c) => !bridge.includes(c) && !CONVEX_MINTED_CAUSES.has(c),
    );
    expect(stale, "these no longer exist on the bridge side").toEqual([]);
  });
});
