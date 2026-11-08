// WIRING of the block picker's focus on close (lots 11 and 12).
//
// The order is pure and tested in quoteBlocks.test.ts (pickerFocusOrder), the walk
// that offers the focus in that order in src/lib/focusFallback.test.ts
// (focusFirst). What those tests cannot see is whether the picker still goes
// through them — the one fallback, for both kinds — and takes the focus off Radix
// only when the walk placed it. The picker needs Radix and the DOM to render, so
// the wiring is read from the SYNTAX TREE (TypeScript's parser: comments and
// strings cannot fake a call).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const SF = ts.createSourceFile(
  "BlockPicker.tsx",
  readFileSync(join(process.cwd(), "src/chat/BlockPicker.tsx"), "utf-8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function find<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const callsTo = (root: ts.Node, name: string) =>
  find(root, ts.isCallExpression).filter((c) => {
    const e = c.expression;
    return (
      (ts.isIdentifier(e) && e.text === name) ||
      (ts.isPropertyAccessExpression(e) && e.name.text === name)
    );
  });

describe("the block picker gives the focus back somewhere real", () => {
  test("one close handler, for both kinds: it restores the focus, and only then takes it off Radix", () => {
    const attrs = find(SF, ts.isJsxAttribute).filter((a) => a.name.getText() === "onCloseAutoFocus");
    expect(attrs, "one onCloseAutoFocus for both kinds").toHaveLength(1);
    const [attr] = attrs;
    const [restore] = callsTo(attr, "restoreFocus");
    expect(restore, "onCloseAutoFocus no longer calls restoreFocus").toBeDefined();
    const prevent = callsTo(attr, "preventDefault");
    expect(prevent).toHaveLength(1);
    // preventDefault is under an `if` whose condition IS the restore: when no
    // candidate took the focus, Radix keeps its own default.
    const guard = find(attr, ts.isIfStatement).find((i) => i.expression === restore);
    expect(guard, "preventDefault is not conditioned on restoreFocus").toBeDefined();
    expect(guard!.thenStatement.getText()).toContain("preventDefault");
  });

  test("the focus only moves through the shared walk: focusFirst, over pickerFocusOrder", () => {
    const fn = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "restoreFocus");
    expect(fn, "no restoreFocus").toBeDefined();
    const [walk] = callsTo(fn!, "focusFirst");
    expect(walk, "restoreFocus no longer walks with focusFirst").toBeDefined();
    expect(callsTo(walk.arguments[0], "pickerFocusOrder")).toHaveLength(1);
    expect(callsTo(SF, "focus"), "a direct .focus() call bypasses the walk").toHaveLength(0);
  });

  test("every candidate of the order is resolved: the ⋯, the reply, the composer", () => {
    const fn = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "restoreFocus")!;
    const table = find(fn, ts.isObjectLiteralExpression)[0];
    const keys = table.properties.map((p) => p.name?.getText());
    expect(keys).toEqual(expect.arrayContaining(["composer", "trigger", "message"]));
  });
});
