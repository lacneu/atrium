// WIRING of every measured fit's observed elements (lot 12).
//
// useFitLevel compares the elements it observes after every commit of the
// component that CALLS it (createTargetWatch): an element remounted by that
// component's own render is seen in the very commit that remounted it. One
// rendered by ANOTHER component — a child remounting its element on its own
// state, the caller not committing — would only be seen at the caller's next
// commit. So every observed ref is attached (`ref={…}`) by the component that
// calls the hook: read from the syntax tree, for every caller in src/.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "paraglide" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
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

/** The refs a call observes: useFitLevel's `() => [a.current, b.current]`, or
 *  useTableLayout's ref argument. */
function observedRefs(call: ts.CallExpression, hook: string): string[] {
  if (hook === "useTableLayout") {
    const [ref] = call.arguments;
    return ref !== undefined && ts.isIdentifier(ref) ? [ref.text] : ["<not an identifier>"];
  }
  const observed = call.arguments[1];
  if (observed === undefined || !ts.isArrowFunction(observed)) return ["<not an arrow>"];
  let body: ts.Node = observed.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isArrayLiteralExpression(body)) return ["<not an array>"];
  return body.elements.map((el) =>
    ts.isPropertyAccessExpression(el) && el.name.text === "current" && ts.isIdentifier(el.expression)
      ? el.expression.text
      : "<not a ref>",
  );
}

/** The component calling the hook: its nearest enclosing function. */
function component(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return n;
  }
  return undefined;
}

/** The refs a component attaches to the elements it renders: `ref={x}`, or a
 *  callback ref that sets `x.current`. */
function attachedRefs(owner: ts.Node): string[] {
  return find(owner, ts.isJsxAttribute)
    .filter((a) => a.name.getText() === "ref")
    .map((a) => a.initializer)
    .filter((i): i is ts.JsxExpression => i !== undefined && ts.isJsxExpression(i))
    .flatMap((i) => {
      const e = i.expression;
      if (e === undefined) return [];
      if (ts.isIdentifier(e)) return [e.text];
      if (!ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) return [];
      return find(e, ts.isBinaryExpression)
        .filter((b) => b.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        .map((b) => b.left)
        .filter(
          (l): l is ts.PropertyAccessExpression =>
            ts.isPropertyAccessExpression(l) && l.name.text === "current" && ts.isIdentifier(l.expression),
        )
        .map((l) => (l.expression as ts.Identifier).text);
    });
}

type Caller = {
  where: string;
  hook: string;
  refs: string[];
  attached: string[];
  call: ts.CallExpression;
  owner: ts.Node | undefined;
};

const CALLERS: Caller[] = walk(SRC).flatMap((file) => {
  const where = relative(process.cwd(), file);
  // The table hook observes the ref it is GIVEN: checked at its own callers.
  if (where.endsWith("useTableLayout.ts")) return [];
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return find(sf, ts.isCallExpression)
    .filter((c) => ts.isIdentifier(c.expression) && ["useFitLevel", "useTableLayout"].includes(c.expression.text))
    .filter((c) => !where.endsWith("useFitLevel.ts")) // the hook's own definition file
    .map((c) => {
      const hook = (c.expression as ts.Identifier).text;
      const owner = component(c);
      const attached = owner === undefined ? [] : attachedRefs(owner);
      const line = sf.getLineAndCharacterOfPosition(c.getStart()).line + 1;
      return { where: `${where}:${line}`, hook, refs: observedRefs(c, hook), attached, call: c, owner };
    });
});

describe("every measured fit observes elements its own component renders (lot 12)", () => {
  test("the callers are all found (the check is not vacuous)", () => {
    expect(CALLERS.length).toBeGreaterThanOrEqual(10);
  });

  test.each(CALLERS.map((c) => [c.where, c] as const))("%s", (_where, c) => {
    for (const ref of c.refs) {
      expect(c.attached, `${c.hook} observes ${ref}, attached elsewhere`).toContain(ref);
    }
  });
});

// WHAT IS MEASURED SITS INSIDE WHAT IS OBSERVED (lot 14). useFitLevel listens to
// the content of the elements it observes (nodes, text, a class), so a fit hears
// a change of what it measures only if the measured elements are those observed,
// or inside them — read from the syntax tree: every ref the measure reads is
// observed, or attached to an element nested in an observed one.
/** The refs a measure reads (`x.current`). */
function measuredRefs(call: ts.CallExpression): string[] {
  const measure = call.arguments[0];
  if (measure === undefined) return [];
  return [
    ...new Set(
      find(measure, ts.isPropertyAccessExpression)
        .filter((p) => p.name.text === "current" && ts.isIdentifier(p.expression))
        .map((p) => (p.expression as ts.Identifier).text),
    ),
  ];
}

/** The JSX element carrying `ref={name}` inside a component, if any. */
function elementWithRef(owner: ts.Node, name: string): ts.JsxElement | ts.JsxSelfClosingElement | undefined {
  const attr = find(owner, ts.isJsxAttribute).find(
    (a) =>
      a.name.getText() === "ref" &&
      a.initializer !== undefined &&
      ts.isJsxExpression(a.initializer) &&
      a.initializer.expression?.getText() === name,
  );
  if (attr === undefined) return undefined;
  const opening = attr.parent.parent; // attributes → opening element
  if (ts.isJsxSelfClosingElement(opening)) return opening;
  return ts.isJsxOpeningElement(opening) ? opening.parent : undefined;
}

/** Whether `node` sits inside a JSX element carrying one of the `refs`. */
function nestedInRefs(node: ts.Node, refs: string[]): boolean {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isJsxElement(n)) {
      const ref = n.openingElement.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "ref",
      );
      const name =
        ref?.initializer !== undefined && ts.isJsxExpression(ref.initializer)
          ? ref.initializer.expression?.getText()
          : undefined;
      if (name !== undefined && refs.includes(name)) return true;
    }
  }
  return false;
}

describe("what a fit measures sits inside what it observes (lot 14)", () => {
  const fits = CALLERS.filter((c) => c.hook === "useFitLevel");

  test("the useFitLevel callers are all read (the check is not vacuous)", () => {
    expect(fits.length).toBeGreaterThanOrEqual(8);
  });

  test.each(fits.map((c) => [c.where, c] as const))("%s", (_where, c) => {
    const measured = measuredRefs(c.call).filter((r) => !c.refs.includes(r));
    for (const ref of measured) {
      const element = c.owner === undefined ? undefined : elementWithRef(c.owner, ref);
      expect(element, `${ref} is measured but attached nowhere in the component`).toBeDefined();
      expect(nestedInRefs(element!, c.refs), `${ref} is measured outside what is observed (${c.refs.join(", ")})`).toBe(true);
    }
  });
});

