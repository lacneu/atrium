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
  // Lot 17: a select is a Radix layer too (it keeps and gives back the focus), and
  // assistant-ui's reply menu is a Radix menu under another name.
  ["select.tsx", "SelectContent", "SelectPrimitive.Content", "menu"],
  ["action-bar-more.tsx", "ActionBarMoreContent", "ActionBarMorePrimitive.Content", "menu"],
] as const;

describe("the shared layer contents close by the one rule (lots 15-17)", () => {
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

  // Lot 17: the shared Select the same way — Radix links its trigger only while open.
  test.each([
    ["popover.tsx", "Popover", "PopoverPrimitive", "data-popover"],
    ["select.tsx", "Select", "SelectPrimitive", "data-select"],
  ] as const)("a %s content and trigger carry the same pair, from the shared %s", (file, root, primitives, stamp) => {
    const sf = parse(join(UI, file));
    const fn = (name: string) => find(sf, ts.isFunctionDeclaration).find((f) => f.name?.getText() === name);
    const rootFn = fn(root);
    const useId = rootFn && find(rootFn, ts.isCallExpression).find((c) => c.expression.getText() === "React.useId");
    expect(useId, `the ${root} makes no pair`).toBeDefined();
    const provider =
      rootFn && find(rootFn, ts.isJsxOpeningElement).find((o) => o.tagName.getText() === `${root}Pair.Provider`);
    expect(provider?.attributes.getText()).toMatch(/value=\{pair\}/);
    for (const [name, primitive, attr] of [
      [`${root}Trigger`, `${primitives}.Trigger`, `${stamp}-trigger`],
      [`${root}Content`, `${primitives}.Content`, `${stamp}-of`],
    ] as const) {
      const f = fn(name);
      const read = f && find(f, ts.isCallExpression).find((c) => c.getText() === `React.useContext(${root}Pair)`);
      expect(read, `${name} reads no pair`).toBeDefined();
      const held = (read!.parent as ts.VariableDeclaration).name.getText();
      const el = openings(f!).find((o) => o.tagName.getText() === primitive);
      const a = el?.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === attr,
      );
      expect(a?.initializer?.getText(), `${name}: no ${attr}`).toBe(`{${held}}`);
    }
  });

  test("the guards read the files they mean to", () => {
    for (const [file, , primitive] of CONTENTS) {
      const namespace = primitive.split(".")[0];
      const imports = find(parse(join(UI, file)), ts.isImportDeclaration).map((i) =>
        i.importClause?.namedBindings?.getText() ?? "",
      );
      expect(imports.some((names) => new RegExp(`\\b${namespace}\\b`).test(names)), `${file}: ${namespace}`).toBe(true);
    }
    expect(walk(SRC).filter((f) => f.endsWith(".tsx") && !f.startsWith(UI)).length).toBeGreaterThan(50);
  });
});

// ---- EVERY PACKAGE THAT WRAPS RADIX (lot 17) -------------------------------------
//
// The reply menu escaped the rule: assistant-ui renders a Radix menu of its own,
// and the guard above only looked for Radix imported by name. The class is "every
// Radix layer, whoever ships it". So the packages are classified from what they
// depend on, each layer they render is found in their own build, and the app may
// import from them only what is listed here — each entry with its reason.

const NODE_MODULES = join(process.cwd(), "node_modules");

function pkg(name: string): { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(NODE_MODULES, name, "package.json"), "utf-8"));
}
const depsOf = (name: string) => {
  const p = pkg(name);
  return Object.keys({ ...p.dependencies, ...p.peerDependencies });
};

/** Does this package keep and give back the focus — a Radix layer, directly or by
 *  the package it is built on (an alert dialog on the dialog, a dropdown on the menu)? */
function managesFocus(name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const deps = depsOf(name);
  if (deps.includes("@radix-ui/react-focus-scope")) return true;
  return deps.some((d) => d.startsWith("@radix-ui/react-") && d !== "@radix-ui/react-focus-scope" && managesFocus(d, seen));
}

/** The app's dependencies built on Radix — directly, or on another one of them. */
function radixWrappers(): string[] {
  const app = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
  const all = Object.keys({ ...app.dependencies });
  const wraps = (name: string): boolean =>
    name === "radix-ui" ||
    depsOf(name).some((d) => d === "radix-ui" || d.startsWith("@radix-ui/") || (d !== name && all.includes(d) && wraps(d)));
  return all.filter((name) => {
    try {
      return wraps(name);
    } catch {
      return false; // a dependency without a package.json of its own (types only)
    }
  });
}

/** What the app may import from each, outside components/ui — nothing that renders
 *  a layer of its own. */
const RADIX_WRAPPERS: Record<string, { allowed: Record<string, string>; layers: Record<string, string> }> = {
  "radix-ui": {
    // Every Radix part is used through the shared components — none outside them.
    allowed: {},
    layers: {
      Dialog: "dialog.tsx, sheet.tsx",
      AlertDialog: "alert-dialog.tsx",
      Popover: "popover.tsx",
      DropdownMenu: "dropdown-menu.tsx",
      Select: "select.tsx",
    },
  },
  "@assistant-ui/react": {
    allowed: {
      AssistantRuntimeProvider: "the runtime's context: no element",
      ActionBarPrimitive: "the reply's action buttons (copy, reload): buttons, no layer",
      AttachmentPrimitive: "an attachment's chip: name, thumb, remove button, no layer",
      ComposerPrimitive: "the composer's root, field, send and attach: no layer",
      MessagePrimitive: "a message and its parts: no layer",
      ThreadPrimitive: "the thread's viewport and message list: no layer",
      useAttachment: "hook",
      useComposer: "hook",
      useComposerRuntime: "hook",
      useExternalStoreRuntime: "hook",
      useMessage: "hook",
      useThread: "hook",
      useThreadRuntime: "hook",
      useThreadViewportStore: "hook",
      fromThreadMessageLike: "data conversion",
      AppendMessage: "type",
      Attachment: "type",
      AttachmentAdapter: "type",
      CompleteAttachment: "type",
      ExternalStoreAdapter: "type",
      PendingAttachment: "type",
      ThreadMessageLike: "type",
    },
    layers: {
      // Wrapped: its content closes by the rule (CONTENTS above).
      ActionBarMorePrimitive: "action-bar-more.tsx",
      // Not wrapped, so not usable: their layers would close by Radix's default.
      AssistantModalPrimitive: "",
      ThreadListItemMorePrimitive: "",
    },
  },
  "@assistant-ui/react-streamdown": {
    allowed: {
      StreamdownTextPrimitive: "markdown rendering: no layer",
      StreamdownTextComponents: "type",
    },
    layers: {},
  },
};

describe("every package that wraps Radix renders its layers through the rule (lot 17)", () => {
  test("the app's dependencies built on Radix are exactly the classified ones", () => {
    expect(radixWrappers().sort()).toEqual(Object.keys(RADIX_WRAPPERS).sort());
  });

  test("Radix's own layers — the parts that keep and give back the focus — are each wrapped", () => {
    // From the build itself: a part whose package manages the focus is a layer.
    const used = new Set<string>();
    for (const file of walk(UI)) {
      for (const imp of find(parse(file), ts.isImportDeclaration)) {
        if ((imp.moduleSpecifier as ts.StringLiteral).text !== "radix-ui") continue;
        const named = imp.importClause?.namedBindings;
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const el of named.elements) used.add((el.propertyName ?? el.name).getText());
        }
      }
    }
    const kebab = (name: string) => name.replace(/[A-Z]/g, (c, i: number) => (i === 0 ? "" : "-") + c.toLowerCase());
    const focusLayers = [...used].filter((part) => managesFocus(`@radix-ui/react-${kebab(part)}`)).sort();
    expect(focusLayers).toEqual(Object.keys(RADIX_WRAPPERS["radix-ui"].layers).sort());
    // Tooltip, Tabs, Accordion, Checkbox, Slot: no focus of their own to give back.
    expect(managesFocus("@radix-ui/react-tooltip")).toBe(false);
  });

  test("assistant-ui's own layer primitives are each classified — read from its build", () => {
    const dist = join(NODE_MODULES, "@assistant-ui/react/dist/primitives");
    const LAYER = /import\s*\{[^}]*\b(Dialog|AlertDialog|Popover|DropdownMenu|Select|HoverCard|ContextMenu|Menubar|NavigationMenu)\b[^}]*\}\s*from\s*"radix-ui"|@radix-ui\/react-(dialog|alert-dialog|popover|dropdown-menu|menu|select|hover-card|context-menu|menubar|navigation-menu)\b/;
    const layered = readdirSync(dist, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) =>
        readdirSync(join(dist, d.name)).some((f) => f.endsWith(".js") && LAYER.test(readFileSync(join(dist, d.name, f), "utf-8"))),
      )
      .map((d) => `${d.name[0].toUpperCase()}${d.name.slice(1)}Primitive`)
      .sort();
    expect(layered).toEqual(Object.keys(RADIX_WRAPPERS["@assistant-ui/react"].layers).sort());
  });

  test("outside the shared components, only what renders no layer is imported from them", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(UI)) continue;
      for (const imp of find(parse(file), ts.isImportDeclaration)) {
        const from = (imp.moduleSpecifier as ts.StringLiteral).text;
        const known = RADIX_WRAPPERS[from];
        const isRadix = /^@radix-ui\//.test(from);
        if (known === undefined && !isRadix) continue;
        const named = imp.importClause?.namedBindings;
        const names =
          named === undefined
            ? [imp.importClause?.name?.getText() ?? "*"]
            : ts.isNamedImports(named)
              ? named.elements.map((e) => (e.propertyName ?? e.name).getText())
              : ["*"];
        for (const name of names) {
          if (known?.allowed[name] === undefined) offenders.push(`${relative(process.cwd(), file)}: ${name} from ${from}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a wrapped third-party layer is imported only by its wrapper", () => {
    const wrapped = RADIX_WRAPPERS["@assistant-ui/react"].layers;
    for (const [name, wrapper] of Object.entries(wrapped)) {
      const users = walk(SRC).filter((file) =>
        find(parse(file), ts.isImportDeclaration).some(
          (i) =>
            (i.moduleSpecifier as ts.StringLiteral).text === "@assistant-ui/react" &&
            new RegExp(`\\b${name}\\b`).test(i.importClause?.namedBindings?.getText() ?? ""),
        ),
      );
      expect(users.map((f) => relative(UI, f)), name).toEqual(wrapper === "" ? [] : [wrapper]);
    }
  });
});
