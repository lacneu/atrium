// WIRING of the block picker's focus on close (lot 11).
//
// The choice is pure and tested in quoteBlocks.test.ts (pickerCloseFocus). What
// that test cannot see is whether the picker still ASKS it, and still takes the
// focus off Radix — which, left alone, drops it on the page once an older reply's
// action bar has unmounted. The picker needs Radix and the DOM to render, so the
// wiring is read from the SYNTAX TREE (TypeScript's parser: comments and strings
// cannot fake a call).

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
  test("on close it asks where, and takes the focus off Radix", () => {
    const attr = find(SF, ts.isJsxAttribute).find((a) => a.name.getText() === "onCloseAutoFocus");
    expect(attr, "no onCloseAutoFocus").toBeDefined();
    expect(callsTo(attr!, "closeFocusTarget")).toHaveLength(1);
    expect(callsTo(attr!, "preventDefault")).toHaveLength(1);
    expect(callsTo(attr!, "focus")).toHaveLength(1);
  });

  test("the answer comes from pickerCloseFocus, told whether the ⋯ is still there", () => {
    const fn = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "closeFocusTarget");
    expect(fn, "no closeFocusTarget").toBeDefined();
    const [ask] = callsTo(fn!, "pickerCloseFocus");
    expect(ask, "closeFocusTarget no longer asks pickerCloseFocus").toBeDefined();
    const arg = ask.arguments[0];
    expect(ts.isObjectLiteralExpression(arg)).toBe(true);
    const keys = (arg as ts.ObjectLiteralExpression).properties.map((p) => p.name?.getText());
    expect(keys).toEqual(expect.arrayContaining(["quotePicked", "composer", "trigger", "message"]));
  });

  test("the reply, not focusable by itself, is made so for that focus", () => {
    const fn = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "closeFocusTarget")!;
    const set = callsTo(fn, "setAttribute").map((c) => c.arguments.map((a) => a.getText()));
    expect(set).toContainEqual(['"tabindex"', '"-1"']);
  });
});
