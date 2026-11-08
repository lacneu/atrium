// EVERY LAYER GIVES THE FOCUS BACK BY ONE RULE, ITS GUARD FIRST (lots 15-16).
//
// The rule lives in lib/returnFocus. It holds for the whole class only if every
// layer of the app reaches it, and nothing reaches the focus before it:
//   - every layer — dialog, alert dialog, sheet, popover, menu — is built from the
//     shared contents here, never from the Radix primitives (a primitive closes
//     with Radix's own default, which takes back a focus the user moved);
//   - each content routes its close through the rule, after the caller's props,
//     and its props do not even accept a view's own `onCloseAutoFocus`: a view
//     names fallbacks (`returnFocus`), it cannot run before the guard;
//   - a dialog reads its opener from the page's focus history as its content
//     mounts (its `ref`), not from Radix's first focus event, which an `autoFocus`
//     field suppresses — the history is installed once, by main.tsx;
//   - a popover's content and trigger carry the same pair: its items' dialogs
//     find their opener by it.
// Read here from the syntax tree.

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

const openings = (root: ts.Node) =>
  find(root, (n): n is ts.JsxOpeningLikeElement => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));

const CONTENTS = [
  ["dialog.tsx", "DialogContent", "DialogPrimitive.Content", "dialog"],
  ["alert-dialog.tsx", "AlertDialogContent", "AlertDialogPrimitive.Content", "dialog"],
  ["sheet.tsx", "SheetContent", "SheetPrimitive.Content", "dialog"],
  ["popover.tsx", "PopoverContent", "PopoverPrimitive.Content", "popover"],
  ["dropdown-menu.tsx", "DropdownMenuContent", "DropdownMenuPrimitive.Content", "menu"],
] as const;

describe("the shared layer contents close by the one rule (lots 15-16)", () => {
  test.each(CONTENTS)("%s — %s", (file, name, primitive, kind) => {
    const sf = parse(join(UI, file));
    const fn = find(sf, ts.isFunctionDeclaration).find((f) => f.name?.getText() === name);
    expect(fn, `${file}: no ${name}`).toBeDefined();

    // A view cannot hand its own close handler (nor a ref that would replace the
    // opening's) — the props type leaves them out.
    const param = fn!.parameters[0];
    const typeText = param.type?.getText() ?? "";
    expect(typeText).toMatch(/Omit<React\.ComponentProps<typeof \w+\.Content>, "onCloseAutoFocus" \| "ref">/);
    const pattern = param.name;
    expect(ts.isObjectBindingPattern(pattern)).toBe(true);
    const taken = (pattern as ts.ObjectBindingPattern).elements.map((e) => e.name.getText());
    expect(taken).toContain("returnFocus");

    // The rule, for its kind of layer.
    const call = find(fn!, ts.isCallExpression).find((c) => c.expression.getText() === "useLayerFocus");
    expect(call, `${file}: ${name} does not call useLayerFocus`).toBeDefined();
    const args = call!.arguments.map((a) => a.getText());
    expect(args[0]).toBe(`"${kind}"`);
    expect(args[1]).toBe("returnFocus");
    const holder = call!.parent;
    expect(ts.isVariableDeclaration(holder)).toBe(true);
    const focus = (holder as ts.VariableDeclaration).name.getText();

    // The primitive gets the opening's ref and the close handler, AFTER the spread.
    const el = openings(fn!).find((o) => o.tagName.getText() === primitive);
    expect(el, `${file}: no ${primitive}`).toBeDefined();
    const props = el!.attributes.properties;
    const spread = props.findIndex((p) => ts.isJsxSpreadAttribute(p));
    expect(spread).toBeGreaterThanOrEqual(0);
    const wired = kind === "popover" ? ["ref", "onCloseAutoFocus", "onInteractOutside"] : ["ref", "onCloseAutoFocus"];
    for (const handler of wired) {
      const at = props.findIndex((p) => ts.isJsxAttribute(p) && p.name.getText() === handler);
      expect(at, `${file}: ${handler} missing`).toBeGreaterThanOrEqual(0);
      expect(at, `${file}: ${handler} before the props spread`).toBeGreaterThan(spread);
      expect((props[at] as ts.JsxAttribute).initializer?.getText()).toBe(`{${focus}.${handler}}`);
    }
    if (kind === "popover") {
      expect(taken).toContain("onInteractOutside");
      expect(args[2]).toBe("onInteractOutside");
    }
  });

  test("no view of the app hands a layer its own close handler", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(UI) || !file.endsWith(".tsx")) continue;
      for (const a of find(parse(file), ts.isJsxAttribute)) {
        if (a.name.getText() === "onCloseAutoFocus") {
          offenders.push(`${relative(process.cwd(), file)}: ${a.parent.parent.getText().slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no layer of the app is built from the Radix primitives directly", () => {
    const LAYERS = new Set(["Dialog", "AlertDialog", "Popover", "DropdownMenu"]);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(UI)) continue;
      for (const imp of find(parse(file), ts.isImportDeclaration)) {
        const from = (imp.moduleSpecifier as ts.StringLiteral).text;
        if (/^@radix-ui\/react-(alert-dialog|dialog|popover|dropdown-menu)$/.test(from)) {
          offenders.push(`${relative(process.cwd(), file)}: ${from}`);
          continue;
        }
        if (from !== "radix-ui") continue;
        const named = imp.importClause?.namedBindings;
        if (named === undefined || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
          const imported = (el.propertyName ?? el.name).getText();
          if (LAYERS.has(imported)) offenders.push(`${relative(process.cwd(), file)}: ${imported} from radix-ui`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the focus history is installed once, at the page's start (main.tsx)", () => {
    const sf = parse(join(SRC, "main.tsx"));
    const calls = find(sf, ts.isCallExpression).filter((c) => c.expression.getText() === "installFocusHistory");
    expect(calls).toHaveLength(1);
    // A statement of the module itself — not inside a component that could mount twice.
    expect(ts.isExpressionStatement(calls[0].parent) && calls[0].parent.parent === sf).toBe(true);
    const elsewhere = walk(SRC).filter(
      (f) => !f.endsWith("main.tsx") && !f.endsWith("returnFocus.ts") && /\binstallFocusHistory\(/.test(readFileSync(f, "utf-8")),
    );
    expect(elsewhere).toEqual([]);
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
      const el = openings(f!).find((o) => o.tagName.getText() === primitive);
      const a = el?.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === stamp,
      );
      expect(a?.initializer?.getText(), `${name}: no ${stamp}`).toBe(`{${held}}`);
    }
  });

  test("the guards read the files they mean to", () => {
    for (const [file] of CONTENTS) {
      const imp = find(parse(join(UI, file)), ts.isImportDeclaration).find(
        (i) => (i.moduleSpecifier as ts.StringLiteral).text === "radix-ui",
      );
      expect(imp?.importClause?.namedBindings?.getText()).toMatch(/\b(AlertDialog|Dialog|Popover|DropdownMenu) as /);
    }
    expect(walk(SRC).filter((f) => f.endsWith(".tsx") && !f.startsWith(UI)).length).toBeGreaterThan(50);
  });
});
