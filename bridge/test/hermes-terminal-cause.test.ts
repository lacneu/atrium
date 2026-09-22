// Every Hermes terminal names WHY it closed.
//
// The cause was built on the OpenClaw path first, and a whole provider stayed
// uncovered: each Hermes terminal shipped a `message.final` with no
// `diagnosticFinalizeCause`, so the sink had none to persist and every Hermes turn
// remained permanently unexplainable the moment its traces expired — the exact
// defect the field exists to remove.
//
// A guard, not a memory: the terminals are spread over two files and eight of them
// are built as object literals in place, so the next one added would silently be
// mute. Read through the AST — a regex over the source would be fooled by a
// terminal in a comment, a string, or one split across lines.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const HERMES = new URL("../src/providers/hermes", import.meta.url).pathname;
const FILES = ["normalizer.ts", "ws-turn.ts"];

/** Each `{ type: EVENT_MESSAGE_FINAL, … }` literal, and whether it names a cause. */
function terminals(file: string): Array<{ line: number; named: boolean }> {
  const path = join(HERMES, file);
  const sf = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Array<{ line: number; named: boolean }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      const nameOf = (p: ts.PropertyAssignment): string =>
        ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "";
      const isTerminal = props.some(
        (p) =>
          nameOf(p) === "type" &&
          ts.isIdentifier(p.initializer) &&
          p.initializer.text === "EVENT_MESSAGE_FINAL",
      );
      if (isTerminal) {
        found.push({
          line:
            sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          named: props.some((p) => nameOf(p) === "diagnosticFinalizeCause"),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("a Hermes turn always says why it ended", () => {
  const all = FILES.flatMap((f) =>
    terminals(f).map((t) => ({ ...t, file: f })),
  );

  test("the parse found the terminals (a silent zero would pass for ever)", () => {
    // The failure mode of every derived check: a walk that matches nothing makes
    // the assertion below vacuously true.
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const file of FILES) {
      expect(
        all.some((t) => t.file === file),
        `no terminal found in ${file} — the walk is looking in the wrong place`,
      ).toBe(true);
    }
  });

  test("every one of them carries a cause", () => {
    const mute = all
      .filter((t) => !t.named)
      .map((t) => `${t.file}:${t.line}`);
    expect(
      mute,
      "these terminals ship no diagnosticFinalizeCause — their turns cannot be explained once the traces expire",
    ).toEqual([]);
  });
});
