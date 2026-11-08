// EVERY DIALOG GIVES THE FOCUS BACK WHERE IT WAS OPENED FROM (lot 15).
//
// No dialog of the app has a Radix trigger, the only place Radix gives the focus
// back to as a dialog closes: the focus fell on the page — measured in the browser
// on the shared prompt, the cron editor, a menu's dialog and a delete confirmation,
// with the opener still there or not. The rule (lib/returnFocus) is applied once,
// by the three shared contents every dialog is built from; read here from the
// syntax tree: each content routes BOTH auto-focus events through it, after the
// caller's props so none can bypass it unknowingly, and no dialog of the app is
// built from the Radix primitives directly. A dialog opened from an item of a
// menu or a popover finds the layer's trigger; Radix labels a menu by its trigger,
// and the shared Popover pairs its content with its trigger — every popover of the
// app is that one.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const SRC = join(process.cwd(), "src");
const UI = join(SRC, "components/ui");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function find<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "paraglide") walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

const CONTENTS = [
  ["dialog.tsx", "DialogContent", "DialogPrimitive.Content"],
  ["alert-dialog.tsx", "AlertDialogContent", "AlertDialogPrimitive.Content"],
  ["sheet.tsx", "SheetContent", "SheetPrimitive.Content"],
] as const;

describe("the shared dialog contents give the focus back by one rule (lot 15)", () => {
  test.each(CONTENTS)("%s — %s", (file, name, primitive) => {
    const sf = parse(join(UI, file));
    const fn = find(sf, ts.isFunctionDeclaration).find((f) => f.name?.getText() === name);
    expect(fn, `${file}: no ${name}`).toBeDefined();

    // The view's own handlers and fallbacks are taken out of the props…
    const pattern = fn!.parameters[0]?.name;
    expect(pattern !== undefined && ts.isObjectBindingPattern(pattern)).toBe(true);
    const taken = (pattern as ts.ObjectBindingPattern).elements.map((e) => e.name.getText());
    expect(taken).toEqual(expect.arrayContaining(["returnFocus", "onOpenAutoFocus", "onCloseAutoFocus"]));

    // …handed to the rule…
    const call = find(fn!, ts.isCallExpression).find((c) => c.expression.getText() === "useFocusReturn");
    expect(call, `${file}: ${name} does not call useFocusReturn`).toBeDefined();
    expect(call!.arguments.map((a) => a.getText())).toEqual([
      "returnFocus",
      "onOpenAutoFocus",
      "onCloseAutoFocus",
    ]);
    const holder = call!.parent;
    expect(ts.isVariableDeclaration(holder)).toBe(true);
    const focus = (holder as ts.VariableDeclaration).name.getText();

    // …and the primitive gets both of its handlers, AFTER the props spread.
    const opening = find(fn!, (n): n is ts.JsxOpeningLikeElement =>
      ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n),
    ).find((o) => o.tagName.getText() === primitive);
    expect(opening, `${file}: no ${primitive}`).toBeDefined();
    const props = opening!.attributes.properties;
    const spread = props.findIndex((p) => ts.isJsxSpreadAttribute(p));
    expect(spread).toBeGreaterThanOrEqual(0);
    for (const handler of ["onOpenAutoFocus", "onCloseAutoFocus"]) {
      const at = props.findIndex((p) => ts.isJsxAttribute(p) && p.name.getText() === handler);
      expect(at, `${file}: ${handler} missing`).toBeGreaterThanOrEqual(0);
      expect(at, `${file}: ${handler} before the props spread`).toBeGreaterThan(spread);
      const value = (props[at] as ts.JsxAttribute).initializer?.getText();
      expect(value).toBe(`{${focus}.${handler}}`);
    }
  });

  test("no dialog of the app is built from the Radix primitives directly", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(UI)) continue;
      const sf = parse(file);
      for (const imp of find(sf, ts.isImportDeclaration)) {
        const from = (imp.moduleSpecifier as ts.StringLiteral).text;
        if (/^@radix-ui\/react-(alert-)?dialog$/.test(from)) {
          offenders.push(`${relative(process.cwd(), file)}: ${from}`);
          continue;
        }
        if (from !== "radix-ui") continue;
        const named = imp.importClause?.namedBindings;
        if (named === undefined || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
          const imported = (el.propertyName ?? el.name).getText();
          if (imported === "Dialog" || imported === "AlertDialog") {
            offenders.push(`${relative(process.cwd(), file)}: ${imported} from radix-ui`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a popover's content and trigger carry the same pair, from the shared Popover", () => {
    const sf = parse(join(UI, "popover.tsx"));
    const fn = (name: string) => find(sf, ts.isFunctionDeclaration).find((f) => f.name?.getText() === name);
    const root = fn("Popover");
    const useId = root && find(root, ts.isCallExpression).find((c) => c.expression.getText() === "React.useId");
    expect(useId, "the Popover makes no pair").toBeDefined();
    const provider = root && find(root, ts.isJsxOpeningElement).find((o) => o.tagName.getText() === "PopoverPair.Provider");
    expect(provider?.attributes.getText()).toMatch(/value=\{pair\}/);
    for (const [name, primitive, stamp] of [
      ["PopoverTrigger", "PopoverPrimitive.Trigger", "data-popover-trigger"],
      ["PopoverContent", "PopoverPrimitive.Content", "data-popover-of"],
    ] as const) {
      const f = fn(name);
      const read = f && find(f, ts.isCallExpression).find((c) => c.getText() === "React.useContext(PopoverPair)");
      expect(read, `${name} reads no pair`).toBeDefined();
      const held = (read!.parent as ts.VariableDeclaration).name.getText();
      const el = find(f!, (n): n is ts.JsxOpeningLikeElement =>
        ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n),
      ).find((o) => o.tagName.getText() === primitive);
      const a = el?.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === stamp,
      );
      expect(a?.initializer?.getText(), `${name}: no ${stamp}`).toBe(`{${held}}`);
    }
  });

  test("every popover of the app is the shared one — its items open dialogs that must find it", () => {
    // The time-range filter builds its own (a date form, it opens no dialog).
    const ALLOWED = new Set(["src/chat/admin/filters/TimeRangePicker.tsx"]);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(UI)) continue;
      const where = relative(process.cwd(), file);
      for (const imp of find(parse(file), ts.isImportDeclaration)) {
        const from = (imp.moduleSpecifier as ts.StringLiteral).text;
        const named = imp.importClause?.namedBindings;
        const popover =
          from === "@radix-ui/react-popover" ||
          (from === "radix-ui" &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.some((e) => (e.propertyName ?? e.name).getText() === "Popover"));
        if (popover && !ALLOWED.has(where)) offenders.push(where);
      }
    }
    expect(offenders).toEqual([]);
    for (const allowed of ALLOWED) {
      expect(readFileSync(join(process.cwd(), allowed), "utf-8")).not.toMatch(/\b(Dialog|Sheet|confirm|prompt)\b/);
    }
  });

  test("the guard reads the imports it means to forbid", () => {
    // The walk must actually reach the three wrappers' kind of import: they are the
    // only files allowed to have it.
    const wrappers = CONTENTS.map(([file]) => parse(join(UI, file)));
    for (const sf of wrappers) {
      const imp = find(sf, ts.isImportDeclaration).find(
        (i) => (i.moduleSpecifier as ts.StringLiteral).text === "radix-ui",
      );
      expect(imp?.importClause?.namedBindings?.getText()).toMatch(/\b(Alert)?Dialog as /);
    }
    expect(walk(SRC).filter((f) => f.startsWith(UI)).length).toBeGreaterThanOrEqual(3);
  });
});
