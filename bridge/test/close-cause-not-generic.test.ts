// A CLOSE THAT KNOWS ITS CAUSE MUST NOT REPORT THE GENERIC ONE.
//
// `endTurn(now, status, error, cause, errorKind)` — its fourth argument used to
// feed a trace, so three close paths in `session.ts` computed a precise cause
// (`gateway_restarting`, `connection_saturated`, `connection_lost`) and then
// passed the literal `"external"` anyway. That argument is now the turn's DURABLE
// verdict: writing `external` over a known class would make the record lie about
// the one kind of incident an operator most needs to recognise once the traces
// have expired.
//
// The compiler cannot catch it — `"external"` is a perfectly valid cause — and no
// behavioural test reaches those paths, so this reads the call sites through the
// AST. Not a regex: a cause named inside a comment or a string would fool one, and
// this repo has paid for that lesson.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

const FILE = new URL("../src/session.ts", import.meta.url).pathname;

/** `endTurn(…)` calls whose CAUSE argument is a computed local. */
function closeCalls(): Array<{ line: number; computed: string; passed: string }> {
  const sf = ts.createSourceFile(
    FILE,
    readFileSync(FILE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Array<{ line: number; computed: string; passed: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "endTurn" &&
      node.arguments.length >= 4
    ) {
      const error = node.arguments[2]!;
      const cause = node.arguments[3]!;
      // Only the shape under test: the call computed a cause into a local and
      // passed it as the ERROR. Whatever it passes as the CAUSE must be the same.
      if (ts.isIdentifier(error) && /Cause$/.test(error.text)) {
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          computed: error.text,
          passed: ts.isIdentifier(cause)
            ? cause.text
            : cause.getText(sf).trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("a close reports the cause it computed", () => {
  const calls = closeCalls();

  test("the parse found the close paths (a silent zero would pass for ever)", () => {
    // The failure mode of every derived check: a walk that matches nothing makes
    // the assertion below vacuously true.
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test("none of them replaces it with a generic literal", () => {
    const wrong = calls
      .filter((c) => c.passed !== c.computed)
      .map((c) => `session.ts:${c.line}: computed ${c.computed}, reported ${c.passed}`);
    expect(
      wrong,
      "the durable verdict would name the wrong thing on exactly the incidents that need it",
    ).toEqual([]);
  });
});
