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
    const lifts = [...CSS.matchAll(/([^{}]+)\{([^{}]*margin-top:\s*calc\(var\(--oc-kb[^{}]*)\}/g)];
    const lifted = lifts.flatMap((m) => m[1].split(",").map((sel) => sel.trim()));
    expect(lifted).toContain('[data-slot="dialog-content"]:not(.oc-search-palette)');
    expect(lifted).toContain('[data-slot="alert-dialog-content"]');
    for (const [, selector, body] of lifts) {
      const after = body.slice(body.lastIndexOf("margin-top: calc(var(--oc-kb"));
      expect(after, selector.trim()).not.toMatch(/(^|[;\s])margin(-top)?\s*:(?!\s*calc\(var\(--oc-kb)/);
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

describe("every kind of layer stays in the visible screen (lot 17)", () => {
  test("every layer of the components is one of the kinds below", () => {
    expect(uiSlots("-content")).toEqual([...CENTRED, ...FLOATING, "sheet-content", ...EXEMPT].sort());
  });

  test.each(CENTRED)("%s: no taller than the screen less the keyboard and the safe areas, lifted by half", (slot) => {
    const own = declarationsFor(`[data-slot="${slot}"]`);
    const height = /max-height:\s*calc\(([^;]+)\);/.exec(own)?.[1] ?? "";
    expect(height).toContain("100dvh");
    expect(height).toContain(KB);
    expect(height).toContain("env(safe-area-inset-top)");
    expect(height).toContain("env(safe-area-inset-bottom)");
    const lifted = cssRules().some(
      (r) =>
        r.selectors.some((sel) => sel.startsWith(`[data-slot="${slot}"]`)) &&
        /margin-top:\s*calc\(var\(--oc-kb, 0px\) \/ -2\)/.test(r.body),
    );
    expect(lifted, `${slot} is not lifted`).toBe(true);
  });

  test("sheets stop at the safe areas, and above the keyboard, on every side", () => {
    const sides = ["left", "right"].map((side) => declarationsFor(`[data-slot="sheet-content"][data-side="${side}"]`));
    for (const own of sides) {
      expect(own).toContain("top: env(safe-area-inset-top)");
      expect(own).toContain(`bottom: max(env(safe-area-inset-bottom), ${KB})`);
    }
    for (const side of ["top", "bottom"]) {
      const own = declarationsFor(`[data-slot="sheet-content"][data-side="${side}"]`);
      expect(own, side).toMatch(new RegExp(`max-height:\\s*calc\\(\\s*100dvh - ${KB.replace(/[()]/g, "\\$&")}`));
    }
    expect(declarationsFor('[data-slot="sheet-content"][data-side="bottom"]')).toContain(
      `bottom: max(env(safe-area-inset-bottom), ${KB})`,
    );
  });

  test.each(FLOATING)("%s opening downwards stops above the keyboard", (slot) => {
    const own = declarationsFor(`[data-slot="${slot}"][data-side="bottom"]`);
    const name = slot.replace(/-content$/, "");
    expect(own).toMatch(new RegExp(`max-height:\\s*max\\(\\s*6rem,\\s*calc\\(var\\(--radix-${name}-content-available-height\\) - var\\(--oc-kb, 0px\\)\\)\\s*\\)`));
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
    expect(panel()).toMatch(/bottom:\s*calc\(var\(--oc-kb, 0px\) \+ var\(--oc-exp-gap\)\)/);
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

/** A length in px: `vh` is the viewport's height, `kb` the keyboard's (`--oc-kb`). */
function cssLength(expr: string, env: { vh: number; kb: number }, decls: Decls): number {
  let src = expr;
  for (let round = 0; /var\(/.test(src); round++) {
    expect(round, `unresolved var() in ${expr}`).toBeLessThan(20);
    src = src.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
      if (name === "--oc-kb") return `${env.kb}px`;
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
  const geometry = (vh: number, kb: number, regionContent: number) => {
    const decls = declarations(ruleBody(".oc-composer--expanded"));
    const len = (e: string) => cssLength(e, { vh, kb }, decls);
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
