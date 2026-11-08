// WIRING of the block picker's focus on close (lots 11, 12 and 16).
//
// The order is pure and tested in quoteBlocks.test.ts (pickerFocusOrder), the walk
// that offers the focus in that order in src/lib/focusFallback.test.ts
// (focusFirst), the shared rule in src/lib/returnFocus.test.ts. What those tests
// cannot see is whether the picker still goes through them. Since lot 16 it has no
// close handler of its own — one ran before the guard and took back a focus the
// user had moved to the composer during the exit —: it names its fallbacks to the
// shared rule, and a picked quote sends the focus to the composer as the pick's
// outcome, which the rule's guard then keeps. The picker needs Radix and the DOM
// to render, so the wiring is read from the SYNTAX TREE (TypeScript's parser:
// comments and strings cannot fake a call).

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

const candidatesFn = () =>
  find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "pickerCandidates");

describe("the block picker gives the focus back by the shared rule", () => {
  test("no close handler of its own: its fallbacks go to the rule, for both kinds", () => {
    const own = find(SF, ts.isJsxAttribute).filter((a) => a.name.getText() === "onCloseAutoFocus");
    expect(own, "an own onCloseAutoFocus runs before the guard").toHaveLength(0);
    const fallbacks = find(SF, ts.isJsxAttribute).filter((a) => a.name.getText() === "returnFocus");
    expect(fallbacks).toHaveLength(1);
    const [call] = callsTo(fallbacks[0], "pickerCandidates");
    expect(call, "returnFocus no longer reads pickerCandidates").toBeDefined();
    expect(call.arguments.map((a) => a.getText())).toEqual([
      "messageId",
      'picked.current && kind === "quote"',
    ]);
  });

  test("a picked quote: the composer takes the focus as the outcome, once the picker is closed", () => {
    const effect = callsTo(SF, "useEffect").find((c) => /picked\.current/.test(c.getText()) && /focusFirst/.test(c.getText()));
    expect(effect, "no outcome effect").toBeDefined();
    const body = effect!.arguments[0].getText();
    // Only after the close (`open` false), only for a picked quote, only the composer.
    expect(body).toMatch(/if \(open \|\| !picked\.current \|\| kind !== "quote"\) return;/);
    const [walk] = callsTo(effect!, "focusFirst");
    expect(walk.arguments[0].getText()).toBe("[composer]");
    const [read] = callsTo(effect!, "pickerCandidates");
    expect(read.arguments.map((a) => a.getText())).toEqual(["messageId", "true"]);
    expect(effect!.arguments[1]?.getText()).toBe("[open, kind, messageId]");
  });

  test("the focus only moves through the shared walk: no direct .focus() call", () => {
    expect(callsTo(SF, "focus"), "a direct .focus() call bypasses the walk").toHaveLength(0);
    const fn = candidatesFn();
    expect(fn, "no pickerCandidates").toBeDefined();
    expect(callsTo(fn!, "pickerFocusOrder")).toHaveLength(1);
  });

  test("every candidate of the order is resolved: the ⋯, the reply, the composer", () => {
    const table = find(candidatesFn()!, ts.isObjectLiteralExpression)[0];
    const keys = table.properties.map((p) => p.name?.getText());
    expect(keys).toEqual(expect.arrayContaining(["composer", "trigger", "message"]));
  });
});
