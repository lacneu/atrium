/// <reference types="vite/client" />
//
// Lot 8 (2026-11): the virtual keyboard and the safe areas. A desktop browser has
// neither, so these hold the CONTRACT in the sources; what it does on an iPhone or
// an iPad is to be checked on the device (the report lists what).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "paraglide" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

const CSS = readFileSync(join(SRC, "chat/convexChat.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf("}", at));
}

describe("the page runs edge to edge, and makes room for the keyboard", () => {
  test("the viewport covers the safe areas and lets Android resize for the keyboard", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf-8");
    const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1] ?? "";
    expect(meta).toContain("width=device-width");
    expect(meta).toContain("viewport-fit=cover");
    expect(meta).toContain("interactive-widget=resizes-content");
  });

  test("the shell is the visible height less the iOS keyboard, inside the safe areas", () => {
    const shell = ruleBody(".oc-shell");
    expect(shell).toMatch(/height:\s*calc\(100dvh - var\(--oc-kb, 0px\)\)/);
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(shell).toContain(`env(safe-area-inset-${side})`);
    }
  });

  // Lot 11: a dialog's lift sat BEFORE a `margin: 0` in its own rule, which zeroed
  // it. A lift counts only if nothing after it in its rule resets it.
  test("every lift by the keyboard survives its rule: no margin reset after it", () => {
    // Lot 26: lifted by what lies below what is shown — the keyboard, where the
    // layout viewport is the screen's.
    const LIFT = "margin-top: calc((var(--oc-vv-top, 0px) - var(--oc-vv-bottom, 0px)) / 2)";
    const lifts = [...CSS.matchAll(/([^{}]+)\{([^{}]*margin-top:\s*calc\(\(var\(--oc-vv-top[^{}]*)\}/g)];
    const lifted = lifts.flatMap((m) => m[1].split(",").map((sel) => sel.trim()));
    expect(lifted).toContain('[data-slot="dialog-content"]:not(.oc-search-palette)');
    expect(lifted).toContain('[data-slot="alert-dialog-content"]');
    for (const [, selector, body] of lifts) {
      expect(body, selector.trim()).toContain(LIFT);
      const after = body.slice(body.lastIndexOf(LIFT) + LIFT.length);
      expect(after, selector.trim()).not.toMatch(/(^|[;\s])margin(-top)?\s*:/);
    }
  });
});

// ---- EVERY KIND OF LAYER (lot 17) ----------------------------------------------
//
// The protections were written for the dialog alone: a confirmation (alert dialog)
// kept its natural height centred on the layout viewport — the iOS keyboard opened
// by its type-to-confirm field covered its buttons, a short screen cut it —, the
// sheets ran under the keyboard, a menu opening downwards too. Every kind of layer
// gets the same: its height bounded by the screen less the safe areas and the
// keyboard, scrolling inside, its actions in view. The kinds are derived from the
// components (every `data-slot` of a content or a footer in components/ui), so a
// layer added tomorrow is classified or fails here.

/** The stylesheet's rules, each selector of a list apart (a rule nested in an
 *  at-rule is read as its own). */
function cssRules(): Array<{ selectors: string[]; body: string }> {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((sel) => sel.trim()),
    body: m[2],
  }));
}
/** Every declaration aimed at exactly `selector`, rule after rule. */
const declarationsFor = (selector: string) =>
  cssRules()
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join("\n");

/** Every `data-slot` value ending with `suffix` in the components that float — a
 *  layer is raised above the page (`z-50`, overlayLayer.test.ts): a card's or a
 *  table's footer, an accordion's or tabs' content are not layers. */
function uiSlots(suffix: string): string[] {
  const slots = new Set<string>();
  for (const file of walk(join(SRC, "components/ui"), [".tsx"])) {
    const text = readFileSync(file, "utf-8");
    if (!/\bz-50\b/.test(text)) continue;
    for (const m of text.matchAll(/data-slot="([a-z-]+)"/g)) {
      if (m[1].endsWith(suffix)) slots.add(m[1]);
    }
  }
  return [...slots].sort();
}

/** Centred on the screen: shortened by the keyboard and the safe areas, lifted. */
const CENTRED = ["alert-dialog-content", "dialog-content"];
/** Floating, measured by Radix down to the layout viewport's bottom. */
const FLOATING = ["dropdown-menu-content", "popover-content", "select-content"];
/** A label shown on hover or focus, gone at the next move: nothing to reach in it. */
const EXEMPT = ["tooltip-content"];
const KB = "var(--oc-kb, 0px)";
/** What lies below what is shown in the layout viewport (lot 26): a fixed layer's
 *  bottom edge stands on it — the keyboard's height where the layout viewport is the
 *  screen's, more on a page wider than the screen. */
const BELOW = "var(--oc-vv-bottom, 0px)";

describe("every kind of layer stays in the visible screen (lot 17)", () => {
  test("every layer of the components is one of the kinds below", () => {
    expect(uiSlots("-content")).toEqual([...CENTRED, ...FLOATING, "sheet-content", ...EXEMPT].sort());
  });

  // Lot 18: the bound is ONE variable, the visible height, that every rule sizing a
  // layer composes with (the view rules below).
  test("the room of a layer is the screen less what iOS scrolled out at the top, the keyboard and both safe areas", () => {
    const room = /--oc-layer-room:\s*calc\(([^;]+)\);/.exec(declarationsFor(":root"))?.[1] ?? "";
    expect(room.replace(/\s+/g, " ").trim()).toBe(
      `100dvh - var(--oc-vv-top, 0px) - ${KB} - env(safe-area-inset-top) - env(safe-area-inset-bottom)`,
    );
  });

  test.each(CENTRED)("%s: no taller than the room less a margin, moved to the visible centre", (slot) => {
    const own = declarationsFor(`[data-slot="${slot}"]`);
    expect(own).toMatch(/max-height:\s*calc\(var\(--oc-layer-room\) - 2rem\);/);
    const lifted = cssRules().some(
      (r) =>
        r.selectors.some((sel) => sel.startsWith(`[data-slot="${slot}"]`)) &&
        /margin-top:\s*calc\(\(var\(--oc-vv-top, 0px\) - var\(--oc-vv-bottom, 0px\)\) \/ 2\)/.test(r.body),
    );
    expect(lifted, `${slot} is not lifted`).toBe(true);
  });

  test("sheets stop at the safe areas, below the visible top and above the keyboard, on every side", () => {
    const sides = ["left", "right"].map((side) => declarationsFor(`[data-slot="sheet-content"][data-side="${side}"]`));
    for (const own of sides) {
      expect(own).toContain("top: calc(var(--oc-vv-top, 0px) + env(safe-area-inset-top))");
      expect(own).toContain(`bottom: max(env(safe-area-inset-bottom), ${BELOW})`);
    }
    expect(declarationsFor('[data-slot="sheet-content"][data-side="top"]')).toContain(
      "top: calc(var(--oc-vv-top, 0px) + env(safe-area-inset-top))",
    );
    for (const side of ["top", "bottom"]) {
      const own = declarationsFor(`[data-slot="sheet-content"][data-side="${side}"]`);
      expect(own, side).toMatch(/max-height:\s*var\(--oc-layer-room\);/);
    }
    expect(declarationsFor('[data-slot="sheet-content"][data-side="bottom"]')).toContain(
      `bottom: max(env(safe-area-inset-bottom), ${BELOW})`,
    );
  });

  // Lot 18: Floating UI measures that room on the VISUAL viewport, which the iOS
  // keyboard shrinks. Lot 17 took the keyboard out a second time and kept a floor
  // of 6rem: measured at 740×390 with a 220 px keyboard, a menu 62 px from it was
  // held at 96 px, 26 px under the keyboard.
  test("Floating UI measures the room on the visual viewport (the installed @floating-ui/dom)", () => {
    const src = readFileSync(join(ROOT, "node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs"), "utf-8");
    const at = src.indexOf("function getViewportRect(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toMatch(/const visualViewport = win\.visualViewport;/);
    expect(body).toMatch(/height = visualViewport\.height;/);
  });

  test.each(FLOATING)("%s: capped by its shared content at exactly the room Floating UI measured", (slot) => {
    const name = slot.replace(/-content$/, "");
    const owners = walk(join(SRC, "components/ui"), [".tsx"]).filter((f) =>
      readFileSync(f, "utf-8").includes(`data-slot="${slot}"`),
    );
    expect(owners.length).toBeGreaterThan(0);
    for (const file of owners) {
      expect(readFileSync(file, "utf-8"), file).toContain(`max-h-(--radix-${name}-content-available-height)`);
    }
    // …and no rule of the stylesheet takes the keyboard out of it again, nor holds
    // it above a floor.
    const ownRules = cssRules().filter((r) => r.selectors.some((sel) => sel.includes(`[data-slot="${slot}"]`)));
    for (const r of ownRules) expect(r.body, r.selectors.join(", ")).not.toMatch(/max-height/);
  });

  test("no class takes a custom property in brackets — Tailwind 4 writes it out as an invalid value", () => {
    // `max-h-[--radix-select-content-available-height]` (Tailwind 3's form) became
    // `max-height: --radix-select-content-available-height`: no cap at all, a
    // select opening upwards ran 1 874 px past the top of a 1280×800 window.
    const offenders: string[] = [];
    for (const file of walk(SRC, [".tsx", ".ts"])) {
      for (const m of readFileSync(file, "utf-8").matchAll(/[\w:-]+-\[--[\w-]+\]/g)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("their actions stay in view: every footer sticks to the bottom of what is shown, opaque", () => {
    expect(uiSlots("-footer")).toEqual(["alert-dialog-footer", "dialog-footer", "sheet-footer"]);
    for (const slot of uiSlots("-footer")) {
      const own = declarationsFor(`[data-slot="${slot}"]`);
      expect(own, slot).toContain("position: sticky");
      expect(own, slot).toContain("bottom: 0");
      expect(own, slot).toContain("background: var(--popover)");
    }
  });

  // Measured at 740×360 with a 180 px keyboard: the type-to-confirm field the focus
  // scrolled into view ended under the sticky footer, its buttons stacked over it.
  test.each([...CENTRED, "sheet-content"])("%s: a field scrolled into view stops above the footer", (slot) => {
    expect(declarationsFor(`[data-slot="${slot}"]`)).toMatch(/scroll-padding-bottom:\s*6rem/);
  });
});

// ---- NO VIEW RULE SIZES A LAYER PAST ITS BOUND (lot 18) ------------------------
//
// The shared bound is one rule; a view's rule as specific and later in the cascade
// replaced it: the search palette kept its 70dvh, the access dialog its 85dvh — at
// 390×844 with a 336 px keyboard the palette ran 184 px under the keyboard, a
// notification menu opening upwards 233 px past the room Radix measured. The
// layers are found in the components (every shared content the app renders, with
// its classes), the rules in every stylesheet of the app: a rule that sizes one of
// them composes with its bound — `min(its cap, the bound)` —, or fails here. The
// browser proof of lot 18 renders every such layer and reads its box.

/** The bound a layer of `slot` never exceeds: the visible room, or for a floating
 *  layer the room Floating UI measured for it. */
const boundOf = (slot: string) =>
  FLOATING.includes(slot) ? `var(--radix-${slot.replace(/-content$/, "")}-content-available-height` : "var(--oc-layer-room)";

/** The shared contents: every `…Content` component of components/ui whose file
 *  renders a layer slot — the tag the views write, and its slot. */
function layerTags(): Map<string, string> {
  const tags = new Map<string, string>();
  for (const file of walk(join(SRC, "components/ui"), [".tsx"])) {
    const text = readFileSync(file, "utf-8");
    const slot = [...CENTRED, ...FLOATING, "sheet-content"].find((sl) => text.includes(`data-slot="${sl}"`));
    if (slot === undefined) continue;
    for (const m of text.matchAll(/function ([A-Z]\w*Content)\(/g)) tags.set(m[1], slot);
  }
  return tags;
}

/** Every layer content the app renders, with its slot and its classes: string
 *  literals, string constants of its file, both branches of a condition. */
function layerUses(): Array<{ at: string; slot: string; classes: string[] }> {
  const tags = layerTags();
  const uses: Array<{ at: string; slot: string; classes: string[] }> = [];
  for (const file of walk(SRC, [".tsx"])) {
    if (file.startsWith(join(SRC, "components/ui"))) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const consts = new Map<string, string>();
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isStringLiteralLike(n.initializer)) {
        consts.set(n.name.getText(sf), n.initializer.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const values = (e: ts.Node | undefined): string[] => {
      if (e === undefined) return [""];
      if (ts.isStringLiteralLike(e)) return [e.text];
      if (ts.isJsxExpression(e) || ts.isParenthesizedExpression(e)) return values(e.expression);
      if (ts.isConditionalExpression(e)) return [...values(e.whenTrue), ...values(e.whenFalse)];
      if (ts.isIdentifier(e) && consts.has(e.text)) return [consts.get(e.text)!];
      if (ts.isTemplateExpression(e)) return [[e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(" ")];
      throw new Error(`${file}: a layer's className the guard cannot read: ${e.getText(sf)}`);
    };
    const visit = (n: ts.Node) => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && tags.has(n.tagName.getText(sf))) {
        const cls = n.attributes.properties.find(
          (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === "className",
        );
        const at = `${file.slice(SRC.length + 1)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        for (const v of values(cls?.initializer)) {
          uses.push({ at, slot: tags.get(n.tagName.getText(sf))!, classes: v.split(/\s+/).filter(Boolean) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return uses;
}

/** Every rule of every stylesheet of the app, each selector of a list apart. */
function appCssRules(): Array<{ file: string; selectors: string[]; body: string }> {
  return walk(SRC, [".css"]).flatMap((file) => {
    const text = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      file: file.slice(SRC.length + 1),
      selectors: m[1].split(",").map((sel) => sel.trim()),
      body: m[2],
    }));
  });
}

const ruleDeclarations = (body: string) =>
  body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.includes(":"))
    .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim().replace(/\s+/g, " ")] as const);

describe("no view rule sizes a layer past its bound (lot 18)", () => {
  const uses = layerUses();
  /** A view's class (the app's `oc-` classes) → the slots of the layers it is on. */
  const viewClasses = new Map<string, Set<string>>();
  for (const u of uses) {
    for (const c of u.classes.filter((c) => c.startsWith("oc-"))) {
      viewClasses.set(c, (viewClasses.get(c) ?? new Set()).add(u.slot));
    }
  }
  /** The rules whose subject is a layer carrying a view's class, with its slots. */
  const sizing = appCssRules().flatMap((r) =>
    r.selectors.flatMap((sel) => {
      const subject = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";
      const slots = new Set<string>();
      for (const m of subject.matchAll(/\.(oc-[\w-]+)/g)) for (const sl of viewClasses.get(m[1]) ?? []) slots.add(sl);
      return slots.size === 0 ? [] : [{ ...r, selector: sel, slots: [...slots] }];
    }),
  );

  test("the layers are read from the components, the rules from every stylesheet", () => {
    expect(uses.length).toBeGreaterThan(100);
    const read = sizing.map((r) => r.selector);
    for (const known of [".oc-search-palette", ".oc-access", ".oc-notif", ".oc-dtp__timeopts", ".oc-tzcombo__pop"]) {
      expect(read, known).toContain(known);
    }
    expect(read).toContain('[data-slot="dialog-content"].oc-afiles__editor');
  });

  test("every height a view gives one of its layers is bounded by that layer's bound", () => {
    const offenders: string[] = [];
    for (const r of sizing) {
      for (const [prop, value] of ruleDeclarations(r.body)) {
        const where = `${r.file} ${r.selector} { ${prop}: ${value} }`;
        const bounds = r.slots.map(boundOf);
        const bounded = bounds.every((b) => value.includes(b));
        if (/^max-(height|block-size)$/.test(prop)) {
          if (!(value.startsWith("min(") && bounded) && !(bounds.length === 1 && value.startsWith(bounds[0]))) offenders.push(where);
        } else if (/^(height|block-size)$/.test(prop)) {
          if (!bounded && !/^(auto|fit-content|max-content|min-content)$/.test(value)) offenders.push(where);
        } else if (/^min-(height|block-size)$/.test(prop)) {
          if (!/^(0|0px|auto)$/.test(value) && !(value.startsWith("min(") && bounded)) offenders.push(where);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a view that moves a centred layer bounds it from where it put it, in the same rule", () => {
    const offenders: string[] = [];
    for (const r of sizing.filter((x) => x.slots.some((sl) => CENTRED.includes(sl)))) {
      const decls = new Map(ruleDeclarations(r.body));
      for (const prop of ["top", "bottom", "inset", "inset-block", "inset-block-start", "inset-block-end"]) {
        const value = decls.get(prop);
        if (value === undefined) continue;
        const height = decls.get("max-height") ?? "";
        // Every length that places it, but the visible top the room already
        // counts, is taken out of its height (lot 19: placed from `--oc-vv-top`).
        const placed = [...value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]).filter((v) => v !== "--oc-vv-top");
        if (!height.includes("var(--oc-layer-room)") || placed.length === 0 || !placed.every((v) => height.includes(`var(${v})`))) {
          offenders.push(`${r.file} ${r.selector} { ${prop}: ${value}; max-height: ${height || "—"} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no layer is sized or moved by a utility in its className — the stylesheet holds it, where the rules above read it", () => {
    // tailwind-merge lets a caller's `max-h-*` replace the shared cap (overlays.test.ts).
    const SIZE_OR_PLACE = /^(?:[\w[\]=-]+:)*!?-?(?:h|min-h|max-h|size|top|bottom|inset|inset-y)-/;
    const offenders = uses.flatMap((u) => u.classes.filter((c) => SIZE_OR_PLACE.test(c)).map((c) => `${u.at}: ${c}`));
    expect(offenders).toEqual([]);
  });
});

/** The composer root's element children, in order, from the JSX (lot 13). */
function composerChildren(): string[] {
  const file = join(SRC, "chat/ConvexChat.tsx");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let root: ts.JsxElement | undefined;
  const visit = (n: ts.Node) => {
    if (
      root === undefined &&
      ts.isJsxElement(n) &&
      n.openingElement.tagName.getText() === "ComposerPrimitive.Root"
    ) {
      root = n;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(root, "no ComposerPrimitive.Root").toBeDefined();
  return root!.children.flatMap((child) => {
    if (ts.isJsxText(child) && child.getText().trim() === "") return [];
    if (ts.isJsxExpression(child) && child.expression === undefined) return []; // a comment
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      const opening = ts.isJsxElement(child) ? child.openingElement : child;
      const cls = opening.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "className",
      );
      return [cls?.initializer?.getText().replace(/"/g, "") ?? opening.tagName.getText()];
    }
    return [child.getText().slice(0, 40)];
  });
}

describe("the full-page prompt keeps its action bar whole (lots 12, 13)", () => {
  // Twice the keyboard defeated a panel CENTRED with a FIXED field (lots 11, 12),
  // then a child left beside the field — the people row — kept its height and
  // pushed the bar through the panel's bottom (lot 13).
  const panel = () => ruleBody(".oc-composer--expanded");

  test("anchored by its bottom above the keyboard, never centred", () => {
    // Lot 26: on what lies below what is shown — the keyboard, on these screens.
    expect(panel()).toMatch(/bottom:\s*calc\(var\(--oc-vv-bottom, 0px\) \+ var\(--oc-exp-gap\)\)/);
    expect(panel()).not.toMatch(/top:\s*50%/);
    expect(panel()).not.toMatch(/translate\(-50%,\s*-50%\)/);
  });

  test("two children: ONE region with everything else, then the bar, last", () => {
    expect(composerChildren()).toEqual(["oc-composer__body", "oc-composer__bar"]);
  });

  test("the region gives way entirely and scrolls; the bar never gives way", () => {
    const region = ruleBody(".oc-composer--expanded > .oc-composer__body");
    expect(region).toMatch(/display:\s*flex/);
    expect(region).toMatch(/flex-direction:\s*column/);
    expect(region).toMatch(/flex:\s*1 1 auto/);
    expect(region).toMatch(/min-height:\s*0/);
    expect(region).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody(".oc-composer--expanded > .oc-composer__bar")).toMatch(/flex:\s*none/);
  });

  test("inside the region the field gives way first, down to a line, and scrolls its own text", () => {
    const field = ruleBody(".oc-composer--expanded .oc-composer__input");
    expect(field).toMatch(/flex:\s*1 1 auto/);
    expect(field).toMatch(/min-height:\s*[\d.]+rem/);
    expect(field).toMatch(/overflow-y:\s*auto/);
    // The rest keeps its height: an attachment row squeezed to nothing would hide
    // what is attached — the region scrolls instead.
    expect(ruleBody(".oc-composer--expanded > .oc-composer__body > :not(.oc-composer__input)")).toMatch(
      /flex-shrink:\s*0/,
    );
  });

  test("inline, the region lays out nothing of its own: the card's column as before", () => {
    expect(ruleBody(".oc-composer__body")).toMatch(/display:\s*contents/);
  });

  test("a composer that cannot send still dims each part but the bar — through the region", () => {
    // Inline the region has no box: an opacity on it would dim nothing. Its
    // children are dimmed one by one, as the card's were.
    expect(CSS).toMatch(/\.oc-composer--disabled > \.oc-composer__body > \*,/);
    expect(CSS).not.toMatch(/\.oc-composer--disabled > \*:not\(\.oc-composer__bar\)/);
  });

  test("its header folds when the panel itself is very short", () => {
    expect(panel()).toMatch(/container:\s*oc-exp\s*\/\s*size/);
    expect(CSS).toMatch(
      /@container oc-exp \(max-height: [\d.]+rem\)\s*\{\s*\.oc-composer--expanded > \.oc-composer__body > \.oc-composer__exphead\s*\{\s*display:\s*none/,
    );
  });
});

// The panel's geometry, COMPUTED from its own declarations over the review's grid
// (lot 12): a small evaluator for the CSS math the panel uses — calc, min, max,
// clamp; px, rem, dvh; var() with its fallback — so a formula that reads right
// but lands wrong fails here too. The same grid measured in the browser is in the
// lot's report.
type Decls = Map<string, string>;

/** A rule body's declarations, split on the semicolons outside parentheses. */
function declarations(body: string): Decls {
  const out: Decls = new Map();
  const inner = body.slice(body.indexOf("{") + 1);
  const push = (decl: string) => {
    const colon = decl.indexOf(":");
    if (colon > 0) out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim().replace(/\s+/g, " "));
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === ";" && depth === 0) {
      push(inner.slice(start, i));
      start = i + 1;
    }
  }
  push(inner.slice(start));
  return out;
}

/** The space-separated values of a shorthand, parentheses kept whole. */
function values(shorthand: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let word = "";
  for (const ch of shorthand) {
    if (ch === " " && depth === 0) {
      if (word !== "") out.push(word);
      word = "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    word += ch;
  }
  if (word !== "") out.push(word);
  return out;
}

/** What the screen shows, in layout px: the viewport's height (`vh`), the keyboard
 *  (`kb`, `--oc-kb`), what iOS scrolled out of sight at the top (`top`,
 *  `--oc-vv-top`, lot 19), the safe areas. */
type Screen = { vh: number; kb: number; top?: number; safeTop?: number; safeBottom?: number };

/** A length in px on `env`'s screen. */
function cssLength(expr: string, env: Screen, decls: Decls): number {
  const safe = (text: string) =>
    text.replace(/env\(safe-area-inset-(top|bottom|left|right)\)/g, (_, side: string) =>
      `${side === "top" ? (env.safeTop ?? 0) : side === "bottom" ? (env.safeBottom ?? 0) : 0}px`,
    );
  let src = safe(expr);
  for (let round = 0; /var\(/.test(src); round++, src = safe(src)) {
    expect(round, `unresolved var() in ${expr}`).toBeLessThan(20);
    src = src.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
      if (name === "--oc-kb") return `${env.kb}px`;
      // These screens' layout viewport is the screen's: what lies below what is
      // shown is the keyboard (lot 26 splits the two on a page wider than it).
      if (name === "--oc-vv-bottom") return `${env.kb}px`;
      if (name === "--oc-vv-top") return `${env.top ?? 0}px`;
      const own = decls.get(name);
      if (own !== undefined) return `(${own})`;
      expect(fallback, `no value for ${name}`).toBeDefined();
      return fallback!;
    });
  }
  const tokens = [...src.matchAll(/\d*\.?\d+(?:px|rem|dvh)?|[a-z]+\(|[()+*/,-]/g)].map((m) => m[0]);
  expect(tokens.join(""), `unread characters in ${src}`).toBe(src.replace(/\s+/g, ""));
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + product() : v - product();
    return v;
  };
  const product = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") v = take() === "*" ? v * factor() : v / factor();
    return v;
  };
  const args = (): number[] => {
    const out = [sum()];
    while (peek() === ",") {
      take();
      out.push(sum());
    }
    expect(take()).toBe(")");
    return out;
  };
  const factor = (): number => {
    const tok = take();
    if (tok === "(" || tok === "calc(") return args()[0];
    if (tok === "max(") return Math.max(...args());
    if (tok === "min(") return Math.min(...args());
    if (tok === "clamp(") {
      const [lo, v, hi] = args();
      return Math.max(lo, Math.min(v, hi));
    }
    if (tok === "-") return -factor();
    const [, n, unit] = /^(\d*\.?\d+)(px|rem|dvh)?$/.exec(tok) ?? [];
    expect(n, `not a length: ${tok}`).toBeDefined();
    return unit === "rem" ? Number(n) * 16 : unit === "dvh" ? (Number(n) * env.vh) / 100 : Number(n);
  };
  const v = sum();
  expect(at, `trailing tokens in ${src}`).toBe(tokens.length);
  return v;
}

type FlexItem = { basis: number; grow: number; shrink: number; min: number };

/** A flex item's grow, shrink and basis from its `flex` declaration. */
function flexOf(decl: string | undefined): { grow: number; shrink: number } {
  if (decl === undefined || decl === "none") return { grow: 0, shrink: 0 };
  const [grow, shrink] = decl.split(" ").map(Number);
  return { grow: grow ?? 0, shrink: shrink ?? 1 };
}

/** A single-line flex column of definite inner height, laid out as CSS Flexbox
 *  does it (§9.7, what this panel needs): every item at its basis; short of room,
 *  the shrinkable ones give way in proportion to shrink × basis, never below their
 *  minimum (an item clamped is frozen and the rest shared again); with room left,
 *  the growable ones take it. Items are stacked from the top with the gap; what
 *  still overflows goes past the bottom. */
function flexColumn(inner: number, gap: number, items: FlexItem[]): { top: number; size: number }[] {
  const size = items.map((i) => i.basis);
  const frozen = items.map(() => false);
  const free = () => inner - size.reduce((a, b) => a + b, 0) - gap * (items.length - 1);
  if (free() > 0) {
    const grow = items.reduce((a, i) => a + i.grow, 0);
    if (grow > 0) {
      const room = free();
      items.forEach((i, k) => (size[k] += (room * i.grow) / grow));
    }
  } else {
    for (let round = 0; round < items.length && free() < -1e-9; round++) {
      const weights = items.map((i, k) => (frozen[k] ? 0 : i.shrink * i.basis));
      const total = weights.reduce((a, b) => a + b, 0);
      if (total === 0) break;
      const over = -free();
      items.forEach((i, k) => {
        if (frozen[k] || weights[k] === 0) return;
        size[k] -= (over * weights[k]) / total;
        if (size[k] <= i.min) {
          size[k] = i.min;
          frozen[k] = true;
        }
      });
    }
  }
  let top = 0;
  return size.map((s) => {
    const box = { top, size: s };
    top += s + gap;
    return box;
  });
}

describe("the full-page prompt's geometry over the review's grid (lots 12, 13)", () => {
  // The bar's height on touch, measured in the browser (44 px targets); the rest
  // comes from the declarations: the panel's box from its own rule, the column's
  // gap from the card's, the items' flex from theirs, their order from the JSX.
  const BAR = 44;
  const geometry = (vh: number, kb: number, regionContent: number, shownFrom = 0) => {
    const decls = declarations(ruleBody(".oc-composer--expanded"));
    const len = (e: string) => cssLength(e, { vh, kb, top: shownFrom }, decls);
    const [padTop, , padBottom] = values(decls.get("padding") ?? "");
    expect(padBottom, "the panel's padding has no bottom value").toBeDefined();
    const border = Number(/(\d+)px/.exec(decls.get("border") ?? "")?.[1] ?? NaN);
    expect(border, "the panel's border width").toBeGreaterThan(0);
    const gap = len(declarations(ruleBody(".oc-composer")).get("gap") ?? "");
    const foot = vh - len(decls.get("bottom") ?? "");
    const height = len(decls.get("height") ?? "");
    const top = foot - height;
    const inner = height - 2 * border - len(padTop) - len(padBottom);
    const region = declarations(ruleBody(".oc-composer--expanded > .oc-composer__body"));
    const bar = declarations(ruleBody(".oc-composer--expanded > .oc-composer__bar"));
    const regionMin = region.get("min-height") === "0" ? 0 : regionContent;
    const items: Record<string, FlexItem> = {
      "oc-composer__body": { basis: regionContent, ...flexOf(region.get("flex")), min: regionMin },
      "oc-composer__bar": { basis: BAR, ...flexOf(bar.get("flex")), min: bar.get("flex") === "none" ? BAR : 0 },
    };
    const order = composerChildren();
    const boxes = flexColumn(inner, gap, order.map((c) => items[c]));
    const contentTop = top + border + len(padTop);
    const barBox = boxes[order.indexOf("oc-composer__bar")];
    return {
      visible: vh - kb,
      visibleTop: shownFrom,
      floor: len("var(--oc-exp-floor)"),
      minimum: BAR + gap + 2 * border + len(padTop) + len(padBottom),
      gap: len("var(--oc-exp-gap)"),
      foot,
      top,
      height,
      innerBottom: foot - border - len(padBottom),
      barTop: contentTop + barBox.top,
      barBottom: contentTop + barBox.top + barBox.size,
      barSize: barBox.size,
    };
  };
  // The review's grid: 844 / 740 / 390 / 360 px high; no keyboard, a landscape one
  // (220), the reported one (280), a portrait one (336); the region's content from
  // nothing to far more than any panel (the people row, attachments, a dictation).
  const GRID = [844, 740, 390, 360].flatMap((vh) =>
    [0, 220, 280, 336].flatMap((kb) => [0, 74, 149, 184, 600].map((content) => [vh, kb, content] as const)),
  );

  test.each(GRID)("%i px high, %i px of keyboard, %i px in the region: the bar is whole, in view", (vh, kb, content) => {
    const g = geometry(vh, kb, content);
    expect(g.barSize).toBe(BAR); // never squeezed
    expect(g.barBottom).toBeLessThanOrEqual(g.innerBottom + 0.001); // never past the panel's bottom
    expect(g.barBottom).toBeLessThanOrEqual(g.visible + 0.001); // never under the keyboard
    expect(g.height).toBeGreaterThanOrEqual(g.floor - 0.001);
    if (g.visible >= g.floor) {
      expect(g.top).toBeGreaterThanOrEqual(-0.001); // the whole panel in view
      expect(g.barTop).toBeGreaterThanOrEqual(g.top);
    } else {
      // Under the floor (a keyboard over a phone held sideways): the panel keeps
      // it and overflows at the TOP; the bar's foot stays in view.
      expect(g.top).toBeLessThan(0);
      expect(g.barBottom).toBeGreaterThan(0);
    }
  });

  // Lot 19: iOS scrolled the visual viewport down to reveal a field — what is on
  // screen runs from `top` to the keyboard. The panel stays between the two.
  test.each([
    [844, 216, 120],
    [844, 100, 300],
    [390, 180, 40],
    [740, 150, 90],
  ])("%i px high, %i px of keyboard, %i px scrolled out at the top: the panel between the visible top and the keyboard", (vh, kb, top) => {
    for (const content of [0, 149, 600]) {
      const g = geometry(vh, kb, content, top);
      expect(g.barBottom).toBeLessThanOrEqual(g.visible + 0.001);
      expect(g.top).toBeGreaterThanOrEqual(top - 0.001);
    }
  });

  test("tight on a scrolled screen, its margins are shared evenly between the visible top and the keyboard", () => {
    // 80 px shown from 200 px down a 390 px layout: room for the floor and 10 px
    // above and below — not for 5dvh on each side.
    for (const content of [0, 600]) {
      const g = geometry(390, 110, content, 200);
      expect(g.top - 200).toBeCloseTo(g.visible - g.foot, 3);
      expect(g.top).toBeGreaterThanOrEqual(200 - 0.001);
    }
  });

  test("the floor holds the bar, the gap above it, the smallest paddings and the borders", () => {
    const g = geometry(360, 336, 600);
    expect(g.floor).toBeGreaterThanOrEqual(g.minimum - 0.001);
  });

  test("the computation agrees with the browser: the bar's foot as measured, whatever the content", () => {
    // Measured in the browser with --oc-kb set, on touch, with and without the people
    // row, with four attachments and with a dictation preview — the same foot each
    // time (l13-apres-*-composeur-plancher-*).
    const measured: [number, number, number][] = [
      [360, 220, 114.7],
      [360, 280, 65.4],
      [360, 336, 19.4],
      [390, 220, 141.9],
      [390, 280, 84.6],
      [390, 336, 49.4],
      [740, 280, 409],
      [844, 336, 451.9],
    ];
    for (const [vh, kb, foot] of measured) {
      for (const content of [74, 149, 184]) {
        const g = geometry(vh, kb, content);
        expect(Math.abs(g.barBottom - foot), `${vh}/${kb}/${content}`).toBeLessThanOrEqual(0.1);
      }
    }
  });

  test("with room to spare it keeps a margin of 5dvh above and below", () => {
    const g = geometry(844, 0, 74);
    expect(g.gap).toBeCloseTo(844 * 0.05, 3);
    expect(g.top).toBeCloseTo(g.gap, 3);
  });
});

// ---- THE VISIBLE PART IS A RECTANGLE (lot 19) ---------------------------------
//
// iOS scrolls the visual viewport down the layout one to reveal a field: what is
// on screen runs from `offsetTop` to the keyboard. Measured in the browser with the
// app's own tracker on 844 px, 508 px shown from 120 px down: every dialog was
// 596 px tall from 16 px, 104 px above the visible top, its title and close out of
// sight; every sheet from 0. Each layer's box is computed here from its own rules,
// on screens scrolled or not, with and without safe areas, and held inside.
describe("every layer stays inside the visible rectangle (lot 19)", () => {
  /** [layout height, shown from (offsetTop), shown height, safe top, safe bottom] */
  const SCREENS = [
    [844, 120, 508, 0, 0],
    [844, 120, 508, 47, 34],
    [844, 0, 508, 47, 34],
    [844, 0, 844, 47, 34],
    [390, 40, 170, 0, 21],
    [667, 90, 300, 20, 0],
  ] as const;
  const ROOT = declarations(declarationsFor(":root"));
  const on = (vh: number, top: number, shown: number, safeTop: number, safeBottom: number): Screen => ({
    vh,
    top,
    kb: vh - top - shown,
    safeTop,
    safeBottom,
  });
  /** The visible rectangle a layer must stay in: below the notch at the shown top;
   *  above the keyboard — or above the home bar when there is none. */
  const rect = (s: Screen) => ({
    top: (s.top ?? 0) + (s.safeTop ?? 0),
    bottom: s.vh - s.kb - (s.kb === 0 ? (s.safeBottom ?? 0) : 0),
  });
  const len = (expr: string, s: Screen, own: Decls) => cssLength(expr, s, new Map([...ROOT, ...own]));

  test.each(SCREENS)("%i px, shown from %i px over %i px (safe %i/%i): a dialog or a confirmation taller than the screen", (vh, top, shown, st, sb) => {
    const s = on(vh, top, shown, st, sb);
    for (const slot of CENTRED) {
      const own = declarations(ruleBody(`[data-slot="dialog-content"],\n[data-slot="alert-dialog-content"]`));
      const lift = declarations(ruleBody(`[data-slot="dialog-content"]:not(.oc-search-palette),\n[data-slot="alert-dialog-content"]`));
      // Centred by its components (top 50%, translate −50%), moved by the lift.
      const height = len(own.get("max-height") ?? "", s, own);
      const centre = vh / 2 + len(lift.get("margin-top") ?? "", s, lift);
      expect(centre - height / 2, `${slot} top`).toBeGreaterThanOrEqual(rect(s).top - 0.01);
      expect(centre + height / 2, `${slot} bottom`).toBeLessThanOrEqual(rect(s).bottom + 0.01);
    }
  });

  test.each(SCREENS)("%i px, shown from %i px over %i px (safe %i/%i): the search palette, anchored near the visible top", (vh, top, shown, st, sb) => {
    const s = on(vh, top, shown, st, sb);
    const own = declarations(ruleBody(".oc-search-palette"));
    const at = len(own.get("top") ?? "", s, own);
    const height = len(own.get("max-height") ?? "", s, own);
    expect(at).toBeGreaterThanOrEqual(rect(s).top - 0.01);
    expect(at + height).toBeLessThanOrEqual(rect(s).bottom + 0.01);
  });

  test.each(SCREENS)("%i px, shown from %i px over %i px (safe %i/%i): every sheet, on every side", (vh, top, shown, st, sb) => {
    const s = on(vh, top, shown, st, sb);
    const side = (name: string) => {
      const own = new Map<string, string>();
      for (const r of cssRules()) {
        const ok = r.selectors.includes('[data-slot="sheet-content"]') || r.selectors.includes(`[data-slot="sheet-content"][data-side="${name}"]`);
        if (ok) for (const [k, v] of declarations(r.body)) own.set(k, v);
      }
      return own;
    };
    for (const name of ["left", "right"]) {
      const own = side(name);
      expect(len(own.get("top") ?? "", s, own), `${name} top`).toBeGreaterThanOrEqual(rect(s).top - 0.01);
      expect(vh - len(own.get("bottom") ?? "", s, own), `${name} bottom`).toBeLessThanOrEqual(rect(s).bottom + 0.01);
    }
    const topSheet = side("top");
    const at = len(topSheet.get("top") ?? "", s, topSheet);
    expect(at).toBeGreaterThanOrEqual(rect(s).top - 0.01);
    expect(at + len(topSheet.get("max-height") ?? "", s, topSheet)).toBeLessThanOrEqual(rect(s).bottom + 0.01);
    const bottomSheet = side("bottom");
    const foot = vh - len(bottomSheet.get("bottom") ?? "", s, bottomSheet);
    expect(foot).toBeLessThanOrEqual(rect(s).bottom + 0.01);
    expect(foot - len(bottomSheet.get("max-height") ?? "", s, bottomSheet)).toBeGreaterThanOrEqual(rect(s).top - 0.01);
  });
});

describe("dvh everywhere", () => {
  test("no layout is sized on `vh` any more (it ignores the browser's bars): dvh", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC, [".css", ".tsx", ".ts"])) {
      const src = readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const m of src.matchAll(/(?<![a-z-])\d+(?:\.\d+)?vh\b/g)) {
        offenders.push(`${f.slice(SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- EVERY LAYER STAYS IN THE VISIBLE WIDTH (lot 25) ---------------------------
//
// The width side of lots 17-19. At 360 px under the largest text scale (a 24 px
// root), the composer's "More" menu was `w-80`: 480 px, 128 px past the screen's
// right edge — its help link and the permission states out of reach —, while Radix
// published the 344 px it had (`--radix-popover-content-available-width`) and
// nothing applied it. The bound is the screen as shown: for a floating layer, the
// width Floating UI measured for it on the visual viewport; for a dialog or a sheet,
// `--oc-layer-width` — the width shown less the safe areas. A width written in rem
// or as a `w-*` on a layer goes through `min(its value, the bound)`. The browser
// proof (lot 25) renders every layer the app has under the six text scales at
// 360×740 and 740×360 and reads its box.

/** The width bound of a layer of `slot`. */
const widthBoundOf = (slot: string) =>
  FLOATING.includes(slot) ? `var(--radix-${slot.replace(/-content$/, "")}-content-available-width` : "var(--oc-layer-width)";

describe("every layer stays in the visible width (lot 25)", () => {
  test("the width of a layer is the width shown, less both safe areas — never a page wider than the screen", () => {
    // On a phone `100vw` is the screen's width even when the page runs wider (its
    // layout viewport grows with it, and `100%` with it); on a computer `100%`
    // leaves the scrollbar out. The smaller of the two is what is shown.
    const width = /--oc-layer-width:\s*calc\(([^;]+)\);/.exec(declarationsFor(":root"))?.[1] ?? "";
    expect(width.replace(/\s+/g, " ").trim()).toBe(
      "min(100%, 100vw) - env(safe-area-inset-left) - env(safe-area-inset-right)",
    );
  });

  test.each(FLOATING)("%s: capped by its shared content at the width Floating UI measured, its floor too", (slot) => {
    const name = slot.replace(/-content$/, "");
    const owners = walk(join(SRC, "components/ui"), [".tsx"]).filter((f) =>
      readFileSync(f, "utf-8").includes(`data-slot="${slot}"`),
    );
    expect(owners.length).toBeGreaterThan(0);
    for (const file of owners) {
      // The classes of the element that IS the layer (its `data-slot`), not its children's.
      const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      // The file's string constants, which a className may name (popoverContentClassName).
      const consts = new Map<string, string>();
      const collect = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isStringLiteralLike(n.initializer)) consts.set(n.name.getText(sf), n.initializer.text);
        ts.forEachChild(n, collect);
      };
      collect(sf);
      const classes: string[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          const attrs = n.attributes.properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p));
          if (attrs.some((a) => a.name.getText(sf) === "data-slot" && a.initializer?.getText(sf) === `"${slot}"`)) {
            const text = attrs.find((a) => a.name.getText(sf) === "className")?.initializer?.getText(sf) ?? "";
            const named = [...text.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => consts.get(m[1])).filter((v) => v !== undefined);
            classes.push([text, ...named.map((v) => ` "${v}" `)].join(" "));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      expect(classes.length, file).toBeGreaterThan(0);
      for (const cls of classes) {
        expect(cls, file).toContain(`max-w-(--radix-${name}-content-available-width)`);
        // A floor above the room would win over the cap (min-width beats max-width).
        for (const m of cls.matchAll(/(?<=["\s])min-w-(\[[^\]]*\]|[^\s"]+)/g)) {
          expect(m[0], file).toMatch(new RegExp(`^min-w-\\[min\\([\\w.]+,var\\(--radix-${name}-content-available-width\\)\\)\\]$`));
        }
      }
    }
    // …and no rule of the stylesheet lifts it.
    const ownRules = cssRules().filter((r) => r.selectors.some((sel) => sel.includes(`[data-slot="${slot}"]`)));
    for (const r of ownRules) expect(r.body, r.selectors.join(", ")).not.toMatch(/(^|[;\s])(max-|min-)?width\s*:/);
  });

  // Capped, a layer's content must shrink to it: at 360 px under the largest text
  // scale two rows of the composer's "More" menu were wider than the 344 px it has
  // (the shared button keeps one line) — their ends cut off. They wrap.
  test("inside a capped layer the content shrinks: the More menu's rows wrap their labels", () => {
    const own = declarationsFor(".oc-composer__more-pop .oc-composer__more-item");
    expect(own).toContain("white-space: normal");
    expect(own).toContain("height: auto");
  });

  test("a tooltip too: never wider than the width Floating UI measured for it", () => {
    const tooltip = readFileSync(join(SRC, "components/ui/tooltip.tsx"), "utf-8");
    expect(tooltip).toContain("max-w-[min(20rem,var(--radix-tooltip-content-available-width))]");
    expect(tooltip).not.toMatch(/\bmax-w-xs\b/);
  });

  test.each(CENTRED)("%s: as wide as the width shown less a margin, centred in it", (slot) => {
    const own = declarationsFor(`[data-slot="${slot}"]`);
    expect(own).toMatch(/width:\s*calc\(var\(--oc-layer-width\) - 2rem\);/);
    // Centred on what is shown, between the safe areas — not on a layout viewport
    // the page made wider than the screen, panned or not.
    expect(own.replace(/\s+/g, " ")).toContain(
      "left: calc( var(--oc-vv-left, 0px) + min(50%, 50vw) + (env(safe-area-inset-left) - env(safe-area-inset-right)) / 2 );",
    );
    // The shared class no longer sizes or places it across: the stylesheet does.
    const owner = walk(join(SRC, "components/ui"), [".tsx"]).find((f) => readFileSync(f, "utf-8").includes(`data-slot="${slot}"`))!;
    expect(readFileSync(owner, "utf-8")).not.toMatch(/["\s]w-\[calc\(100%-2rem\)\]|["\s]left-1\/2/);
  });

  test("sheets: no wider than the width shown, their edge at the safe area of what is shown", () => {
    for (const side of ["left", "right"]) {
      expect(declarationsFor(`[data-slot="sheet-content"][data-side="${side}"]`), side).toMatch(
        /width:\s*min\(75%, var\(--oc-layer-width\)\);/,
      );
    }
    const LEFT = "left: calc(var(--oc-vv-left, 0px) + env(safe-area-inset-left))";
    // `right: 0` is the layout viewport's edge: past the screen when the page runs wider.
    const RIGHT = "right: max( env(safe-area-inset-right), calc(100% - 100vw - var(--oc-vv-left, 0px) + env(safe-area-inset-right)) )";
    const flat = (sel: string) => declarationsFor(sel).replace(/\s+/g, " ");
    expect(flat('[data-slot="sheet-content"][data-side="left"]')).toContain(LEFT);
    expect(flat('[data-slot="sheet-content"][data-side="right"]')).toContain(RIGHT);
    for (const side of ["top", "bottom"]) {
      const own = flat(`[data-slot="sheet-content"][data-side="${side}"]`);
      expect(own, side).toContain(LEFT);
      expect(own, side).toContain(RIGHT);
    }
    const sheet = readFileSync(join(SRC, "components/ui/sheet.tsx"), "utf-8");
    expect(sheet).not.toMatch(/data-\[side=(left|right)\]:w-/);
  });

  const uses = layerUses();
  const viewClasses = new Map<string, Set<string>>();
  for (const u of uses) {
    for (const c of u.classes.filter((c) => c.startsWith("oc-"))) {
      viewClasses.set(c, (viewClasses.get(c) ?? new Set()).add(u.slot));
    }
  }
  const sizing = appCssRules().flatMap((r) =>
    r.selectors.flatMap((sel) => {
      const subject = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";
      const slots = new Set<string>();
      for (const m of subject.matchAll(/\.(oc-[\w-]+)/g)) for (const sl of viewClasses.get(m[1]) ?? []) slots.add(sl);
      return slots.size === 0 ? [] : [{ ...r, selector: sel, slots: [...slots] }];
    }),
  );

  test("every width a view gives one of its layers is bounded by that layer's width bound", () => {
    const offenders: string[] = [];
    for (const r of sizing) {
      for (const [prop, value] of ruleDeclarations(r.body)) {
        const where = `${r.file} ${r.selector} { ${prop}: ${value} }`;
        const bounds = r.slots.map(widthBoundOf);
        const bounded = bounds.every((b) => value.includes(b));
        if (/^max-(width|inline-size)$/.test(prop)) {
          // A floating layer's cap IS a max-width: a view's own would replace it. A
          // dialog's or a sheet's bound is its width: a max-width only narrows it.
          const floating = r.slots.some((sl) => FLOATING.includes(sl));
          if (floating && !(value.startsWith("min(") && bounded) && !(bounds.length === 1 && value.startsWith(bounds[0]))) offenders.push(where);
        } else if (/^(width|inline-size)$/.test(prop)) {
          if (!bounded && !/^(auto|fit-content|max-content|min-content)$/.test(value)) offenders.push(where);
        } else if (/^min-(width|inline-size)$/.test(prop)) {
          if (!/^(0|0px|auto)$/.test(value) && !(value.startsWith("min(") && bounded)) offenders.push(where);
        } else if (/^(left|right|inset|inset-inline|inset-inline-start|inset-inline-end)$/.test(prop) && r.slots.some((sl) => !FLOATING.includes(sl))) {
          // A dialog or a sheet is placed across by the shared rules, from the width shown.
          offenders.push(where);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no layer's className lifts its width bound: no max-/min- width, no size, no horizontal placement — a dialog's or a sheet's width is the stylesheet's", () => {
    // A floating layer may take a `w-*`: its shared content's cap (`max-w-(…available-width)`)
    // bounds it — CSS keeps the smaller, `min(its value, the room)`. A `max-w-*` of the
    // view would REPLACE that cap (tailwind-merge); a `min-w-*` would win over it.
    const ACROSS = /^(?:[\w[\]=-]+:)*!?-?(?:min-w|size|left|right|start|end|translate-x|inset-x)-/;
    const offenders = uses.flatMap((u) =>
      u.classes
        .filter((c) => ACROSS.test(c) || (FLOATING.includes(u.slot) && /^(?:[\w[\]=-]+:)*!?max-w-/.test(c)) || (!FLOATING.includes(u.slot) && /^(?:[\w[\]=-]+:)*!?w-/.test(c)))
        .map((c) => `${u.at} (${u.slot}): ${c}`),
    );
    expect(offenders).toEqual([]);
  });
});

// ---- THE BOX ON EVERY SCREEN (lot 25) -------------------------------------------
//
// A desktop browser emulates neither a notch nor a page panned sideways: the
// formulas of the shared rules are computed here, on the screens that matter, and
// each box must lie inside what is shown — from `--oc-vv-left`, the visible width
// wide, less the safe areas.

/** A screen, in px: the layout viewport's width (`100%` of a fixed layer: wider than
 *  the screen when the page is), the screen's (`100vw`), how far it is panned
 *  (`--oc-vv-left`), the safe areas, the root font size. */
type Across = { layout: number; vw: number; left: number; safeL: number; safeR: number; rem: number };

/** A width or a position of the shared rules, in px on `env`. */
function across(expr: string, env: Across): number {
  const rootDecls = new Map(ruleDeclarations(declarationsFor(":root")));
  let src = expr;
  for (let round = 0; /var\(/.test(src); round++) {
    expect(round, `unresolved var() in ${expr}`).toBeLessThan(10);
    src = src.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
      if (name === "--oc-vv-left") return `${env.left}px`;
      const own = rootDecls.get(name);
      if (own !== undefined) return `(${own})`;
      expect(fallback, `no value for ${name}`).toBeDefined();
      return fallback!;
    });
  }
  src = src
    .replace(/env\(safe-area-inset-left\)/g, `${env.safeL}px`)
    .replace(/env\(safe-area-inset-right\)/g, `${env.safeR}px`)
    .replace(/(\d*\.?\d+)%/g, (_, n: string) => `${(Number(n) / 100) * env.layout}`)
    .replace(/(\d*\.?\d+)vw/g, (_, n: string) => `${(Number(n) / 100) * env.vw}`)
    .replace(/(\d*\.?\d+)rem/g, (_, n: string) => `${Number(n) * env.rem}`)
    .replace(/(\d*\.?\d+)px/g, "$1")
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmin\(/g, "Math.min(")
    .replace(/\bmax\(/g, "Math.max(");
  expect(src.replace(/Math\.(min|max)/g, ""), `unread characters in ${expr}`).toMatch(/^[\d.\s()+\-*/,]*$/);
  return Function(`"use strict"; return (${src});`)() as number;
}

const decl = (selector: string, prop: string) =>
  new Map(ruleDeclarations(declarationsFor(selector))).get(prop) ?? "";

describe("every dialog and sheet lies inside what is shown, on every screen (lot 25)", () => {
  const SCREENS: Array<[string, Across]> = [
    ["a phone, the page wider than the screen (442 px laid out, 360 shown, root 24 px)", { layout: 442, vw: 360, left: 0, safeL: 0, safeR: 0, rem: 24 }],
    ["the same, panned 48 px to the right", { layout: 442, vw: 360, left: 48, safeL: 0, safeR: 0, rem: 24 }],
    ["a phone in landscape, its notch and corners (47 px each side)", { layout: 740, vw: 740, left: 0, safeL: 47, safeR: 47, rem: 16 }],
    ["one notch only (47 px on the left)", { layout: 740, vw: 740, left: 0, safeL: 47, safeR: 0, rem: 16 }],
    ["a computer with a 15 px scrollbar", { layout: 1265, vw: 1280, left: 0, safeL: 0, safeR: 0, rem: 16 }],
  ];
  /** What is shown, less the safe areas: [from, to]. */
  const shown = (e: Across) => [e.left + e.safeL, e.left + Math.min(e.layout, e.vw) - e.safeR];

  test.each(SCREENS)("a dialog — %s", (_name, env) => {
    const width = across(decl('[data-slot="dialog-content"]', "width"), env);
    const centre = across(decl('[data-slot="dialog-content"]', "left"), env);
    const [from, to] = shown(env);
    expect(centre - width / 2).toBeGreaterThanOrEqual(from - 0.5);
    expect(centre + width / 2).toBeLessThanOrEqual(to + 0.5);
  });

  test.each(SCREENS)("a sheet on the right — %s", (_name, env) => {
    const width = across(decl('[data-slot="sheet-content"][data-side="right"]', "width"), env);
    const right = across(decl('[data-slot="sheet-content"][data-side="right"]', "right"), env);
    const [from, to] = shown(env);
    expect(env.layout - right).toBeLessThanOrEqual(to + 0.5);
    expect(env.layout - right - width).toBeGreaterThanOrEqual(from - 0.5);
  });

  test.each(SCREENS)("a sheet on the left — %s", (_name, env) => {
    const width = across(decl('[data-slot="sheet-content"][data-side="left"]', "width"), env);
    const left = across(decl('[data-slot="sheet-content"][data-side="left"]', "left"), env);
    const [from, to] = shown(env);
    expect(left).toBeGreaterThanOrEqual(from - 0.5);
    expect(left + width).toBeLessThanOrEqual(to + 0.5);
  });
});

// ---- EVERY FIXED LAYER, AND THE BOTTOM OF WHAT IS SHOWN (lot 26) --------------
//
// A page wider than the screen grows Chrome's LAYOUT viewport — where every fixed
// box is laid out — never the screen: the full-page prompt was centred on it (its
// action bar under the screen), the toasts and the image viewer's buttons sat past
// its edge, a side sheet ran 169 px under the screen. Lot 25 bounded the shared
// layers; every fixed box of the stylesheets is bounded alike, and every bottom
// edge stands on `--oc-vv-bottom` — what lies below what is shown in the layout
// viewport, the keyboard included —, never on the keyboard alone (`--oc-kb`, the
// height the shell and the layers' room give up).

/** How each fixed box of the app's stylesheets keeps to what is shown: a LAYER is
 *  bounded and placed from what is shown; a BACKDROP covers the layout viewport and
 *  holds nothing; the detached composer is placed by script (visibleRect). */
const FIXED_BOXES: Record<string, "layer" | "backdrop" | "script"> = {
  ".oc-toast__viewport": "layer",
  ".oc-devfab": "layer",
  ".oc-lightbox": "layer",
  ".oc-composer--expanded": "layer",
  ".oc-composer__backdrop": "backdrop",
  ".oc-detach": "script",
};

/** The flattened declarations of `selector` in the app's stylesheets. */
const appDeclarations = (selector: string) =>
  new Map(
    appCssRules()
      .filter((r) => r.selectors.includes(selector))
      .flatMap((r) => ruleDeclarations(r.body)),
  );

describe("every fixed box keeps to what is shown (lot 26)", () => {
  test("every fixed box of the stylesheets is accounted for", () => {
    const fixed = new Set<string>();
    for (const r of appCssRules()) {
      if (!ruleDeclarations(r.body).some(([p, v]) => p === "position" && v === "fixed")) continue;
      for (const sel of r.selectors) fixed.add(sel);
    }
    expect([...fixed].sort()).toEqual(Object.keys(FIXED_BOXES).sort());
  });

  const layers = Object.entries(FIXED_BOXES).filter(([, k]) => k === "layer").map(([s]) => s);
  test.each(layers)("%s: placed across from what is shown, its bottom on --oc-vv-bottom, its width within the bound", (sel) => {
    const own = appDeclarations(sel);
    const left = own.get("left") ?? "";
    const right = own.get("right") ?? "";
    // Across: a left edge from `--oc-vv-left`, or a right edge from the screen's
    // right (`100% - 100vw - --oc-vv-left`): never the layout viewport's own edge.
    expect(
      left.includes("var(--oc-vv-left") ||
        right.replace(/\s+/g, "").includes("100%-100vw-var(--oc-vv-left"),
      `${sel} { left: ${left}; right: ${right} }`,
    ).toBe(true);
    const bottom = own.get("bottom");
    if (bottom !== undefined) expect(bottom, sel).toContain("var(--oc-vv-bottom");
    for (const prop of ["width", "max-width", "min-width"]) {
      const v = own.get(prop);
      if (v === undefined || /^(auto|none|0|0px|max-content|min-content|fit-content)$/.test(v)) continue;
      expect(v, `${sel} { ${prop} }`).toContain("var(--oc-layer-width)");
    }
  });

  test("the backdrop covers the layout viewport and holds nothing to reach", () => {
    expect(appDeclarations(".oc-composer__backdrop").get("inset")).toBe("0");
  });

  test("the detached composer: placed on what is shown by script, its floor within the bound", () => {
    expect(appDeclarations(".oc-detach").get("min-width")).toBe("min(300px, var(--oc-layer-width))");
    for (const file of ["chat/HeldDictationDock.tsx", "chat/dictationHold.ts"]) {
      const text = readFileSync(join(SRC, file), "utf-8").replace(/\/\/.*$/gm, "");
      expect(text, file).toContain("visibleRect(");
      // Clamped to what is shown, never to the layout viewport's size.
      expect(text, file).not.toMatch(/\bw:\s*window\.innerWidth/);
      expect(text, file).not.toMatch(/\bh:\s*window\.innerHeight/);
    }
  });

  test("--oc-kb only where the keyboard is meant: no bottom edge, no centring stands on it", () => {
    const offenders: string[] = [];
    for (const r of appCssRules()) {
      for (const [prop, value] of ruleDeclarations(r.body)) {
        if (!value.includes("var(--oc-kb")) continue;
        if (/^(bottom|top|margin-top|margin-bottom|inset|inset-block|inset-block-end)$/.test(prop)) {
          offenders.push(`${r.file} ${r.selectors.join(", ")} { ${prop}: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the shared layers' bottom edges and the dialogs' centring stand on --oc-vv-bottom", () => {
    const flat = (sel: string) => declarationsFor(sel).replace(/\s+/g, " ");
    expect(flat('[data-slot="sheet-content"][data-side="left"]')).toContain(
      "bottom: max(env(safe-area-inset-bottom), var(--oc-vv-bottom, 0px));",
    );
    expect(flat('[data-slot="sheet-content"][data-side="bottom"]')).toContain(
      "bottom: max(env(safe-area-inset-bottom), var(--oc-vv-bottom, 0px));",
    );
    expect(flat('[data-slot="dialog-content"]:not(.oc-search-palette)')).toContain(
      "margin-top: calc((var(--oc-vv-top, 0px) - var(--oc-vv-bottom, 0px)) / 2);",
    );
  });
});

/** A screen, vertically, in px: the layout viewport's height (`100%` of a fixed
 *  box: grown by a page wider than the screen), the screen's (`100dvh`), what is
 *  shown — from `--oc-vv-top`, `--oc-vv-bottom` above the layout viewport's bottom
 *  —, the keyboard, the safe areas, the root font size. */
type Along = { layout: number; dvh: number; top: number; below: number; kb: number; safeT: number; safeB: number; rem: number };

/** A height or a vertical position of the rules, in px on `env`. */
function along(expr: string, env: Along): number {
  const rootDecls = new Map(ruleDeclarations(declarationsFor(":root")));
  const ownVars: Record<string, number> = {
    "--oc-vv-top": env.top,
    "--oc-vv-bottom": env.below,
    "--oc-kb": env.kb,
    "--oc-vv-left": 0,
  };
  let src = expr;
  for (let round = 0; /var\(/.test(src); round++) {
    expect(round, `unresolved var() in ${expr}`).toBeLessThan(10);
    src = src.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
      if (name in ownVars) return `${ownVars[name]}px`;
      const own = rootDecls.get(name);
      if (own !== undefined) return `(${own})`;
      expect(fallback, `no value for ${name}`).toBeDefined();
      return fallback!;
    });
  }
  src = src
    .replace(/env\(safe-area-inset-top\)/g, `${env.safeT}px`)
    .replace(/env\(safe-area-inset-bottom\)/g, `${env.safeB}px`)
    .replace(/(\d*\.?\d+)%/g, (_, n: string) => `${(Number(n) / 100) * env.layout}`)
    .replace(/(\d*\.?\d+)dvh/g, (_, n: string) => `${(Number(n) / 100) * env.dvh}`)
    .replace(/(\d*\.?\d+)rem/g, (_, n: string) => `${Number(n) * env.rem}`)
    .replace(/(\d*\.?\d+)px/g, "$1")
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmin\(/g, "Math.min(")
    .replace(/\bmax\(/g, "Math.max(");
  expect(src.replace(/Math\.(min|max)/g, ""), `unread characters in ${expr}`).toMatch(/^[\d.\s()+\-*/,]*$/);
  return Function(`"use strict"; return (${src});`)() as number;
}

describe("every fixed box lies inside what is shown, top to bottom, on every screen (lot 26)", () => {
  const SCREENS: Array<[string, Along]> = [
    ["a phone, the page wider than the screen (909 px laid out, 740 shown), no keyboard", { layout: 909, dvh: 740, top: 0, below: 169, kb: 0, safeT: 0, safeB: 0, rem: 24 }],
    ["iOS, a keyboard, the visual viewport scrolled down to reveal a field (lot 19)", { layout: 844, dvh: 844, top: 120, below: 216, kb: 216, safeT: 47, safeB: 34, rem: 16 }],
    ["a page wider than the screen and a keyboard", { layout: 909, dvh: 740, top: 0, below: 505, kb: 336, safeT: 0, safeB: 0, rem: 16 }],
    ["a desktop", { layout: 768, dvh: 768, top: 0, below: 0, kb: 0, safeT: 0, safeB: 0, rem: 16 }],
  ];
  /** What is shown, top to bottom, less the safe areas: [from, to]. An open
   *  keyboard covers the bottom safe area (the home bar): the larger of the two. */
  const shownY = (e: Along) => [e.top + e.safeT, e.layout - Math.max(e.below, e.safeB)];

  test.each(SCREENS)("a side sheet — %s", (_name, env) => {
    const top = along(decl('[data-slot="sheet-content"][data-side="left"]', "top"), env);
    const bottom = along(decl('[data-slot="sheet-content"][data-side="left"]', "bottom"), env);
    const [from, to] = shownY(env);
    expect(top).toBeGreaterThanOrEqual(from - 0.5);
    // Its bottom edge at the bottom of what is shown, the safe area kept.
    expect(env.layout - bottom).toBeCloseTo(to, 1);
  });

  test.each(SCREENS)("a dialog, at its tallest — %s", (_name, env) => {
    const room = along("var(--oc-layer-room)", env);
    const height = room - 2 * env.rem;
    // Centred on the layout viewport (`top: 50%`, translated by half its height),
    // moved by its margin.
    const margin = along(decl('[data-slot="dialog-content"]:not(.oc-search-palette)', "margin-top"), env);
    const centre = env.layout / 2 + margin;
    const [from, to] = shownY(env);
    expect(centre - height / 2).toBeGreaterThanOrEqual(from - 0.5);
    expect(centre + height / 2).toBeLessThanOrEqual(to + 0.5);
  });

  test.each(SCREENS)("a toast — %s", (_name, env) => {
    const bottom = along(appDeclarations(".oc-toast__viewport").get("bottom")!, env);
    expect(env.layout - bottom).toBeLessThanOrEqual(shownY(env)[1] + 0.5);
  });

  test.each(SCREENS)("the full-page prompt: its action bar above the bottom of what is shown — %s", (_name, env) => {
    const own = appDeclarations(".oc-composer--expanded");
    const gap = along(own.get("--oc-exp-gap")!.replace(/var\(--oc-exp-floor\)/g, own.get("--oc-exp-floor")!), env);
    const bottom = along(own.get("bottom")!.replace(/var\(--oc-exp-gap\)/g, `${gap}px`), env);
    expect(env.layout - bottom).toBeLessThanOrEqual(env.layout - env.below + 0.5);
  });

  test.each(SCREENS)("the image viewer — %s", (_name, env) => {
    const own = appDeclarations(".oc-lightbox");
    const top = along(own.get("top")!, env);
    const bottom = along(own.get("bottom")!, env);
    expect(top).toBe(env.top);
    expect(env.layout - bottom).toBe(env.layout - env.below);
  });
});

describe("the fixed boxes across, on every screen (lot 26)", () => {
  const SCREENS: Array<[string, Across]> = [
    ["a phone, the page wider than the screen (442 px laid out, 360 shown, root 24 px)", { layout: 442, vw: 360, left: 0, safeL: 0, safeR: 0, rem: 24 }],
    ["the same, panned 82 px to the right", { layout: 442, vw: 360, left: 82, safeL: 0, safeR: 0, rem: 24 }],
    ["a phone in landscape, its notch and corners (47 px each side)", { layout: 740, vw: 740, left: 0, safeL: 47, safeR: 47, rem: 16 }],
    ["a computer with a 15 px scrollbar", { layout: 1265, vw: 1280, left: 0, safeL: 0, safeR: 0, rem: 16 }],
  ];
  const shown = (e: Across) => [e.left + e.safeL, e.left + Math.min(e.layout, e.vw) - e.safeR];

  test.each(SCREENS)("a toast, at its widest — %s", (_name, env) => {
    const own = appDeclarations(".oc-toast__viewport");
    const right = across(own.get("right")!, env);
    const width = across(own.get("max-width")!, env);
    const [from, to] = shown(env);
    expect(env.layout - right).toBeLessThanOrEqual(to + 0.5);
    expect(env.layout - right - width).toBeGreaterThanOrEqual(from - 0.5);
  });

  test.each(SCREENS)("the image viewer — %s", (_name, env) => {
    const own = appDeclarations(".oc-lightbox");
    const left = across(own.get("left")!, env);
    const right = across(own.get("right")!, env);
    const [from, to] = shown(env);
    expect(left).toBeGreaterThanOrEqual(env.left - 0.5);
    expect(left).toBeLessThanOrEqual(from + 0.5);
    expect(env.layout - right).toBeLessThanOrEqual(env.left + Math.min(env.layout, env.vw) + 0.5);
    expect(env.layout - right).toBeGreaterThanOrEqual(to - 0.5);
  });

  test.each(SCREENS)("the full-page prompt — %s", (_name, env) => {
    const own = appDeclarations(".oc-composer--expanded");
    const width = across(own.get("width")!, env);
    const centre = across(own.get("left")!, env);
    const [from, to] = shown(env);
    expect(centre - width / 2).toBeGreaterThanOrEqual(from - 0.5);
    expect(centre + width / 2).toBeLessThanOrEqual(to + 0.5);
  });
});

describe("no grid track wider than its container (lot 26)", () => {
  test("a track's floor is min(its length, 100%), never a length alone", () => {
    // `minmax(15rem, 1fr)` is 360 px under the largest text scale: the KPI cards
    // ran 40 px past a 360 px phone. The floor yields to the container.
    const offenders: string[] = [];
    for (const r of appCssRules()) {
      for (const [prop, value] of ruleDeclarations(r.body)) {
        if (!/^grid-template-(columns|rows)$|^grid-auto-(columns|rows)$/.test(prop)) continue;
        for (const m of value.matchAll(/minmax\(/g)) {
          // The first argument, its own parentheses balanced.
          let depth = 0;
          let floor = "";
          for (const ch of value.slice(m.index + m[0].length)) {
            if (ch === "," && depth === 0) break;
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            floor += ch;
          }
          floor = floor.trim();
          if (/^(0|0px|auto|min-content|max-content)$/.test(floor) || /^min\(.*,\s*100%\)$/.test(floor)) continue;
          offenders.push(`${r.file} ${r.selectors.join(", ")} { ${prop}: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Lot 26, the pages: what the inventory of every route under the six text scales
// at 360 px found running past the screen — the settings body scrolling sideways
// from lg on (chat defaults, voice, bridge, scheduled tasks, instances, trash,
// KPI, integrations, theme), an agent request's title cut in the conversation.
// Each row wraps where its controls do not fit side by side; a control wider than
// its row breaks its label; a floor yields to its container.
describe("the rows found running past a 360 px screen wrap (lot 26)", () => {
  const rule = (file: string, selector: string) =>
    appCssRules()
      .filter((r) => r.file === file && r.selectors.includes(selector))
      .map((r) => r.body.replace(/\s+/g, " "))
      .join(" ");
  test.each([
    ["chat/convexChat.css", ".oc-cdefaults__inline", ["flex-wrap: wrap", "min-width: 0"]],
    ["chat/convexChat.css", ".oc-cdefaults__select", ["max-width: 100%"]],
    ["chat/convexChat.css", ".oc-dt__bar", ["flex-wrap: wrap"]],
    ["chat/convexChat.css", ".oc-dt__bar-actions", ["flex-wrap: wrap", "min-width: 0"]],
    ["chat/convexChat.css", ".oc-bridge-provider__head", ["flex-wrap: wrap"]],
    ["chat/convexChat.css", ".oc-int__section-head", ["flex-wrap: wrap"]],
    ["chat/admin/confTabs.css", ".oc-rdefaults__exhead", ["flex-wrap: wrap"]],
    ["chat/convexChat.css", ".oc-bridge-card__meta > span", ["max-width: 100%"]],
    ["chat/convexChat.css", ".oc-chart-mine__domains-body", ["min-width: min(16rem, 100%)"]],
    ["chat/convexChat.css", ".oc-areq__toggle", ["flex: 1 1 max-content", "min-width: 0"]],
    ["chat/convexChat.css", ".oc-areq__kind", ["min-width: 0", "overflow-wrap: anywhere"]],
  ] as const)("%s %s", (file, selector, wanted) => {
    const own = rule(file, selector);
    for (const w of wanted) expect(own, `${selector} ${w}`).toContain(w);
    // A segment or a title wider than its row breaks: never held on one line.
    if (selector === ".oc-bridge-card__meta > span" || selector === ".oc-areq__kind") {
      expect(own).not.toContain("white-space: nowrap");
    }
  });

  test("the theme showroom's columns yield to the page", () => {
    const own = rule("chat/convexChat.css", ".oc-show__section");
    expect(own).toContain("grid-template-columns: 220px minmax(0, 1fr)");
    expect(own).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  test.each([
    ["chat/admin/ScheduledTab.tsx", 'flexWrap: "wrap"'],
    ["chat/admin/DeliveryRecorderCard.tsx", '<div className="flex flex-wrap items-start justify-between gap-4">\n        <div className="min-w-0">'],
    ["chat/admin/VoiceTab.tsx", '<Badge variant={tts ? "secondary" : "destructive"} className="h-auto shrink whitespace-normal text-left">'],
    ["chat/admin/VoiceTab.tsx", '<Badge variant={stt ? "secondary" : "destructive"} className="h-auto shrink whitespace-normal text-left">'],
    ["chat/admin/BlobSweepCard.tsx", 'className="h-auto min-h-8 shrink whitespace-normal text-left text-destructive"'],
    ["chat/ThemeShowroom.tsx", '<Card className="w-full max-w-80">'],
  ])("%s", (file, wanted) => {
    expect(readFileSync(join(SRC, file), "utf-8")).toContain(wanted);
  });
});

// ---- ONE BASE FOR THE KEYBOARD AND WHAT SUBTRACTS IT (lot 27) -----------------
//
// The shell, the layers' room and the full-page prompt subtract the keyboard from
// `100dvh`; the keyboard was measured against the initial containing block, which
// no dynamic toolbar changes while `100dvh` follows them: iOS, toolbars retracted,
// a keyboard — the shell stood 100 px under it. The inset measures the keyboard
// against a `100dvh` sentinel (virtualKeyboard.test.ts plays the screens); here,
// every height that subtracts it starts from `100dvh` — and nothing else.
describe("one base for the keyboard and every height that subtracts it (lot 27)", () => {
  test("every value that subtracts --oc-kb starts from 100dvh (the safe area it covers aside)", () => {
    const offenders: string[] = [];
    for (const r of appCssRules()) {
      for (const [prop, value] of ruleDeclarations(r.body)) {
        if (!value.includes("var(--oc-kb")) continue;
        // The home bar's safe area, which an open keyboard covers: no viewport base.
        if (!value.replaceAll("env(safe-area-inset-bottom) - var(--oc-kb, 0px)", "").includes("var(--oc-kb")) continue;
        const bases = value.match(/\d*\.?\d+(?:d?vh|svh|lvh|%)/g) ?? [];
        if (!value.includes("100dvh") || bases.some((b) => !/dvh$/.test(b))) {
          offenders.push(`${r.file} ${r.selectors.join(", ")} { ${prop}: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the inset measures the keyboard on a 100dvh sentinel, never on the initial containing block", () => {
    const text = readFileSync(join(SRC, "lib/virtualKeyboard.ts"), "utf-8").replace(/\/\/.*$/gm, "");
    expect(text).toContain("keyboardInset(dynamicHeight(), vv.height, vv.offsetTop, vv.scale)");
    expect(text).toContain('sentinel("data-dvh-sentinel", { top: "0", left: "0", width: "0", height: "100dvh" })');
    expect(text).not.toMatch(/keyboardInset\(\s*root\.clientHeight/);
  });
});

describe("no fixed box's floor above what is shown (lot 27)", () => {
  // `.oc-detach { min-height: min(200px, 100dvh) }`: 100dvh stays the screen's
  // above a keyboard — the 200 px floor beat the 140 px the script gave the panel,
  // its send bar 60 px under the keyboard.
  test("every floor of a fixed box is bounded by what is shown", () => {
    for (const sel of Object.keys(FIXED_BOXES)) {
      const own = appDeclarations(sel);
      const height = own.get("min-height");
      if (height !== undefined && !/^(0|0px|auto)$/.test(height)) {
        expect(height, `${sel} { min-height }`).toContain("var(--oc-layer-room)");
      }
      const width = own.get("min-width");
      if (width !== undefined && !/^(0|0px|auto)$/.test(width)) {
        expect(width, `${sel} { min-width }`).toContain("var(--oc-layer-width)");
      }
    }
  });

  const ROOM_SCREENS: Array<[string, Along]> = [
    ["a phone held sideways, a keyboard: 140 px shown", { layout: 360, dvh: 360, top: 0, below: 220, kb: 220, safeT: 0, safeB: 0, rem: 16 }],
    ["iOS, toolbars retracted, a keyboard, scrolled", { layout: 740, dvh: 740, top: 120, below: 180, kb: 180, safeT: 47, safeB: 34, rem: 16 }],
  ];
  test.each(ROOM_SCREENS)("the detached composer's floor fits what is shown — %s", (_name, env) => {
    const floor = along(appDeclarations(".oc-detach").get("min-height")!, env);
    const shown = env.layout - env.top - env.below;
    expect(floor).toBeLessThanOrEqual(shown + 0.5);
  });
});
