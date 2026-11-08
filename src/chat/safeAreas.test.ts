/// <reference types="vite/client" />
//
// Lot 8 (2026-11): the virtual keyboard and the safe areas. A desktop browser has
// neither, so these hold the CONTRACT in the sources; what it does on an iPhone or
// an iPad is to be checked on the device (the report lists what).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  test("dialogs shrink and lift for the keyboard; sheets stop at the safe areas", () => {
    expect(ruleBody('[data-slot="dialog-content"]')).toMatch(/max-height:[\s\S]*var\(--oc-kb, 0px\)/);
    expect(ruleBody('[data-slot="dialog-content"]:not(.oc-search-palette)')).toMatch(
      /margin-top:\s*calc\(var\(--oc-kb, 0px\) \/ -2\)/,
    );
    const sheets = ruleBody('[data-slot="sheet-content"][data-side="left"],\n[data-slot="sheet-content"][data-side="right"]');
    expect(sheets).toContain("top: env(safe-area-inset-top)");
  });

  // Lot 11: a dialog's lift sat BEFORE a `margin: 0` in its own rule, which zeroed
  // it. A lift counts only if nothing after it in its rule resets it.
  test("every lift by the keyboard survives its rule: no margin reset after it", () => {
    const lifts = [...CSS.matchAll(/([^{}]+)\{([^{}]*margin-top:\s*calc\(var\(--oc-kb[^{}]*)\}/g)];
    expect(lifts.map((m) => m[1].trim())).toContain('[data-slot="dialog-content"]:not(.oc-search-palette)');
    for (const [, selector, body] of lifts) {
      const after = body.slice(body.lastIndexOf("margin-top: calc(var(--oc-kb"));
      expect(after, selector.trim()).not.toMatch(/(^|[;\s])margin(-top)?\s*:(?!\s*calc\(var\(--oc-kb)/);
    }
  });
});

describe("the full-page prompt keeps its action bar in view (lot 12)", () => {
  // Twice the keyboard defeated a panel CENTRED with a FIXED field: under a
  // landscape keyboard (390 px high, 220 px of keyboard) the panel was 131 px
  // for a 117 px field and a 44 px bar. It is now laid out from its foot.
  const panel = () => ruleBody(".oc-composer--expanded");

  test("anchored by its bottom above the keyboard, never centred", () => {
    expect(panel()).toMatch(/bottom:\s*calc\(var\(--oc-kb, 0px\) \+ var\(--oc-exp-gap\)\)/);
    expect(panel()).not.toMatch(/top:\s*50%/);
    expect(panel()).not.toMatch(/translate\(-50%,\s*-50%\)/);
  });

  test("never shorter than what it cannot give up: the bar and its paddings", () => {
    expect(panel()).toMatch(/height:\s*max\(\s*var\(--oc-exp-floor\)/);
    expect(panel()).toMatch(/--oc-exp-floor:\s*4\.5rem/);
  });

  test("the bar never shrinks; the field alone gives way, scrolling", () => {
    expect(ruleBody(".oc-composer--expanded > .oc-composer__bar,\n.oc-composer--expanded > .oc-composer__exphead")).toMatch(
      /flex-shrink:\s*0/,
    );
    const field = ruleBody(".oc-composer--expanded .oc-composer__input");
    expect(field).toMatch(/min-height:\s*0/);
    expect(field).toMatch(/overflow-y:\s*auto/);
  });

  test("its header folds when the panel itself is very short", () => {
    expect(panel()).toMatch(/container:\s*oc-exp\s*\/\s*size/);
    expect(CSS).toMatch(
      /@container oc-exp \(max-height: [\d.]+rem\)\s*\{\s*\.oc-composer--expanded > \.oc-composer__exphead\s*\{\s*display:\s*none/,
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

describe("the full-page prompt's geometry over the review's grid (lot 12)", () => {
  // The bar is 44 px on touch; the panel's border is 1 px.
  const BAR = 44;
  const BORDER = 1;
  const geometry = (vh: number, kb: number) => {
    const decls = declarations(ruleBody(".oc-composer--expanded"));
    const len = (e: string) => cssLength(e, { vh, kb }, decls);
    const padBottom = values(decls.get("padding") ?? "")[2];
    expect(padBottom, "the panel's padding has no bottom value").toBeDefined();
    const foot = vh - len(decls.get("bottom") ?? "");
    const height = len(decls.get("height") ?? "");
    const barBottom = foot - BORDER - len(padBottom);
    return {
      visible: vh - kb,
      floor: len("var(--oc-exp-floor)"),
      gap: len("var(--oc-exp-gap)"),
      foot,
      height,
      top: foot - height,
      barBottom,
      barTop: barBottom - BAR,
    };
  };
  // 844 = a phone upright, 390 = the same phone sideways, 360 = a short window;
  // no keyboard, a landscape one (220), a portrait one (336), and a tight case
  // where the panel only just fits (300 over 390: 90 px left).
  const GRID = [844, 390, 360].flatMap((vh) => [0, 220, 300, 336].map((kb) => [vh, kb] as const));

  test.each(GRID)("%i px high, %i px of keyboard: the bar's foot is in view, above the keyboard", (vh, kb) => {
    const g = geometry(vh, kb);
    expect(g.foot).toBeLessThanOrEqual(g.visible + 0.001);
    expect(g.barBottom).toBeLessThanOrEqual(g.visible);
    expect(g.barBottom).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThanOrEqual(g.floor);
    if (g.visible >= g.floor) {
      // The whole panel is in view, and the bar inside it.
      expect(g.top).toBeGreaterThanOrEqual(-0.001);
      expect(g.barTop).toBeGreaterThanOrEqual(g.top);
    } else {
      // Not even the floor fits (a keyboard over a phone held sideways): the
      // panel keeps its floor and overflows at the TOP; its foot stays in view.
      expect(g.top).toBeLessThan(0);
    }
  });

  test("the computation agrees with the browser's cascade: the send button's foot as measured", () => {
    // Measured in the browser with --oc-kb set (l12-apres-*-composeur-plein-ecran-
    // grille), rounded there to a tenth of a pixel.
    const measured: [number, number, number][] = [
      [390, 336, 49.4],
      [390, 220, 141.9],
      [360, 336, 19.4],
      [360, 220, 114.7],
    ];
    for (const [vh, kb, foot] of measured) {
      expect(Math.abs(geometry(vh, kb).barBottom - foot), `${vh}/${kb}`).toBeLessThanOrEqual(0.1);
    }
  });

  test("with room to spare it keeps a margin of 5dvh above and below", () => {
    const g = geometry(844, 0);
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
