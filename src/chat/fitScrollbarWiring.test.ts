// WIRING of the measured views that bring their own scrollbar (lot 11).
//
// The calendar's grid and agenda, and the project page's columns and one-level
// view, differ in HEIGHT inside a scroller: the taller view brings the scroller's
// scrollbar, which — where scrollbars take room (Windows, or macOS set to always
// show them) — takes width from the view, which then gives way to the other, which
// takes the scrollbar away, and so on every frame. Seen live: 81 swaps on the
// calendar, 18 on the project page, in seconds.
//
// The two halves of the fix are checked here: each decision is given the band
// (decided purely in calendarFit/projectPageView tests), read from the SYNTAX TREE
// (TypeScript's parser: a comment or a string cannot fake it); and each scroller
// keeps its scrollbar's room, read from its stylesheet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();

function parse(file: string): ts.SourceFile {
  const text = readFileSync(join(ROOT, file), "utf-8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The `useFitLevel` calls whose measure calls `measureFn`. */
function fitCalls(sf: ts.SourceFile, measureFn: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useFitLevel") {
      const measure = n.arguments[0];
      let calls = false;
      const scan = (m: ts.Node) => {
        if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === measureFn) {
          calls = true;
        }
        ts.forEachChild(m, scan);
      };
      if (measure) scan(measure);
      if (calls) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The `hysteresis` option a `useFitLevel` call passes, as source text. */
function band(call: ts.CallExpression): string | undefined {
  const options = call.arguments[3];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const prop = options.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "hysteresis",
  );
  return prop?.initializer.getText();
}

function ruleBody(file: string, selector: string): string {
  const css = readFileSync(join(ROOT, file), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("a view that brings its own scrollbar never swaps forever", () => {
  test("the calendar's grid/agenda decision is given the band", () => {
    const calls = fitCalls(parse("src/chat/admin/CalendarView.tsx"), "monthGridFit");
    expect(calls).toHaveLength(1);
    expect(band(calls[0])).toBe("SCROLLBAR_HYSTERESIS");
  });

  test("the project page's columns/one-level decision too", () => {
    const calls = fitCalls(parse("src/chat/ProjectPage.tsx"), "projectColumnsFit");
    expect(calls).toHaveLength(1);
    expect(band(calls[0])).toBe("SCROLLBAR_HYSTERESIS");
  });

  test("and its action bar, which wraps under the title when wider", () => {
    const calls = fitCalls(parse("src/chat/ProjectPage.tsx"), "measureCloneWidths");
    expect(calls).toHaveLength(1);
    expect(band(calls[0])).toBe("SCROLLBAR_HYSTERESIS");
  });

  test("the settings page keeps its scrollbar's room, scrolling or not", () => {
    expect(ruleBody("src/chat/convexChat.css", ".oc-admin__body")).toMatch(/scrollbar-gutter:\s*stable/);
  });

  test("so does the project page", () => {
    expect(ruleBody("src/chat/projectPage.css", ".oc-projpage")).toMatch(/scrollbar-gutter:\s*stable/);
  });
});
