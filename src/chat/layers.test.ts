// @vitest-environment node
//
// EVERY LAYER OF THE APP, WITH ITS REAL FOOT, IN EVERY STYLESHEET THE APP LOADS (lot 29).
//
// The layers are read from the components (the TypeScript AST of src/): each dialog,
// confirmation and sheet, each popover, menu, select and tooltip, its class as the
// caller writes it (each branch of a conditional), and — for the first three — its
// footer. Then a real Chrome lays them out with every stylesheet the app loads
// (browserProbe.testkit.ts):
//
// - A RULE ON A SHARED SLOT NEVER BEATS WHAT A CALLER ASKS ON THE SAME PROPERTY. Lot 28
//   set the dialog's vertical padding on its slot, unlayered: it beat the search
//   palette's `p-0`, and the palette took 20 px it had refused. For every caller, what
//   its own classes declare (read from the stylesheet's rules, not guessed from what
//   moves) is what it gets — and the palette's padding, measured, is 0.
// - A LAYER'S ACTIONS ARE IN ITS FOOTER, and the footer stays in view: at every keyboard
//   of the grid over a phone held both ways, every text scale, a layer whose content runs
//   long shows its whole footer above its floor, a floor that is no more than the
//   footer and the layer's own chrome; under it (24 px shown), the footer's foot is
//   where the layer's scroll ends. The agent-file editor kept its "Save" in a house
//   foot that scrolled away with the source, at a height set by a stylesheet the guard
//   did not read.
// - A FOOTER FITS ITS LAYER'S WIDTH (lot 31), in this platform's font and in a wider one
//   that is the same everywhere: the guards load no web font, and what a font does to
//   a layout is what the platform's does (SF on a Mac, DejaVu Sans under Linux).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { cn } from "@/lib/utils";
import { appCss, chromeOrFail, ROOT, runChrome, scriptData } from "./browserProbe.testkit";

const SRC = join(ROOT, "src");
const UI = join(SRC, "components", "ui");
const CONTENTS = {
  DialogContent: "dialog",
  AlertDialogContent: "alert-dialog",
  SheetContent: "sheet",
  PopoverContent: "popover",
  DropdownMenuContent: "dropdown-menu",
  SelectContent: "select",
  TooltipContent: "tooltip",
} as const;
type ContentName = keyof typeof CONTENTS;
const LAYERS: ReadonlySet<string> = new Set(["DialogContent", "AlertDialogContent", "SheetContent"]);
const FOOTERS: Record<string, string> = { DialogFooter: "dialog", AlertDialogFooter: "alert-dialog", SheetFooter: "sheet" };
// A foot that is not a footer, kept for what it is (nothing here is an action).
const HOUSE_FEET_ALLOWED: Record<string, string> = {
  "oc-search-palette__footer": "the search palette's keyboard hints: no action",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) {
      if (e !== "paraglide" && f !== UI) sources(f, out);
    } else if (/\.tsx$/.test(e) && !/\.test\.tsx$/.test(e)) out.push(f);
  }
  return out;
}

/** The strings an expression can be: each branch of a conditional, each literal of a
 *  cn() call, the parts of a template; null when it is not static. */
function variants(node: ts.Node | undefined): string[] | null {
  if (node === undefined) return [""];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isJsxExpression(node)) return variants(node.expression);
  if (ts.isParenthesizedExpression(node)) return variants(node.expression);
  if (ts.isConditionalExpression(node)) {
    const a = variants(node.whenTrue);
    const b = variants(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const r = variants(node.right);
    return r ? ["", ...r] : null;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cn") {
    let acc = [""];
    for (const a of node.arguments) {
      const v = variants(a);
      if (!v) return null;
      acc = acc.flatMap((x) => v.map((y) => `${x} ${y}`.trim()));
    }
    return acc;
  }
  if (ts.isTemplateExpression(node)) {
    let acc = [node.head.text];
    for (const span of node.templateSpans) {
      const v = variants(span.expression);
      if (!v) return null;
      acc = acc.flatMap((x) => v.map((y) => x + y + span.literal.text));
    }
    return acc;
  }
  return null;
}

const tagOf = (n: ts.Node): ts.JsxTagNameExpression | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName : ts.isJsxSelfClosingElement(n) ? n.tagName : null;
function attrsOf(n: ts.Node, sf: ts.SourceFile): Record<string, ts.JsxAttributeValue | undefined> {
  const o = ts.isJsxElement(n) ? n.openingElement : (n as ts.JsxSelfClosingElement);
  const out: Record<string, ts.JsxAttributeValue | undefined> = {};
  for (const p of o.attributes.properties) if (ts.isJsxAttribute(p)) out[p.name.getText(sf)] = p.initializer;
  return out;
}

type Layer = {
  where: string;
  component: ContentName;
  slot: string;
  side: string;
  classes: string[] | null;
  footer: { component: string; classes: string[] } | null;
  houseFeet: string[];
};

/** Every layer content the components render, its class variants and its foot. */
function inventory(): Layer[] {
  const out: Layer[] = [];
  for (const file of sources(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node): void => {
      const tag = tagOf(n);
      if (tag && ts.isIdentifier(tag) && tag.text in CONTENTS) {
        const name = tag.text as ContentName;
        const attrs = attrsOf(n, sf);
        const side = attrs.side ? (variants(attrs.side)?.[0] ?? "right") : name === "SheetContent" ? "right" : "bottom";
        const layer: Layer = {
          where: `${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
          component: name,
          slot: `${CONTENTS[name]}-content`,
          side,
          classes: variants(attrs.className),
          footer: null,
          houseFeet: [],
        };
        const inner = (m: ts.Node, inFooter: boolean): void => {
          const t = tagOf(m);
          if (t && ts.isIdentifier(t) && t.text in CONTENTS) {
            visit(m); // a nested layer is its own
            return;
          }
          let footer = inFooter;
          if (t) {
            const tname = t.getText(sf);
            const a = attrsOf(m, sf);
            if (tname in FOOTERS) {
              footer = true;
              if (layer.footer === null) layer.footer = { component: tname, classes: variants(a.className) ?? [""] };
            } else if (!inFooter && a.className && /(?:foot|actions)\b/.test(a.className.getText(sf))) {
              layer.houseFeet.push(...(variants(a.className) ?? [a.className.getText(sf)]));
            }
          }
          ts.forEachChild(m, (c) => inner(c, footer));
        };
        if (LAYERS.has(name)) ts.forEachChild(n, (c) => inner(c, false));
        else ts.forEachChild(n, visit);
        out.push(layer);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** A shared component's cn() arguments for the element of `slot`, the caller's
 *  `className` among them. */
function recipe(file: string, slot: string): Array<{ s: string } | { caller: true }> {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts: Record<string, string> = {};
  let found: Array<{ s: string } | { caller: true }> | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteral(n.initializer)) {
      consts[n.name.text] = n.initializer.text;
    }
    if (found === null && (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) {
      const a: Record<string, ts.JsxAttributeValue | undefined> = {};
      for (const p of n.attributes.properties) if (ts.isJsxAttribute(p)) a[p.name.getText(sf)] = p.initializer;
      const ds = a["data-slot"];
      const cls = a.className;
      if (ds && ts.isStringLiteral(ds) && ds.text === slot && cls && ts.isJsxExpression(cls) && cls.expression && ts.isCallExpression(cls.expression)) {
        found = cls.expression.arguments.flatMap((arg): Array<{ s: string } | { caller: true }> => {
          if (ts.isStringLiteral(arg)) return [{ s: arg.text }];
          if (ts.isIdentifier(arg)) return arg.text === "className" ? [{ caller: true }] : [{ s: `\u0000${arg.text}` }];
          return [];
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (found === null) throw new Error(`${relative(ROOT, file)}: no element for ${slot}`);
  return (found as Array<{ s: string } | { caller: true }>).map((r) =>
    "s" in r && r.s.startsWith("\u0000") ? { s: consts[r.s.slice(1)] ?? "" } : r,
  );
}
const UI_FILE: Record<string, string> = {
  dialog: "dialog.tsx",
  "alert-dialog": "alert-dialog.tsx",
  sheet: "sheet.tsx",
  popover: "popover.tsx",
  "dropdown-menu": "dropdown-menu.tsx",
  select: "select.tsx",
  tooltip: "tooltip.tsx",
};
function classOf(slot: string, caller: string): { merged: string; base: string } {
  const kind = slot.replace(/-(content|header|footer|title|description)$/, "");
  const parts = recipe(join(UI, UI_FILE[kind]), slot);
  return {
    merged: cn(...parts.map((p) => ("caller" in p ? caller : p.s))),
    base: cn(...parts.filter((p): p is { s: string } => "s" in p).map((p) => p.s)),
  };
}

const LAYER_LIST = inventory();

describe("the layers, as the components render them (lot 29)", () => {
  test("every layer is found, its class readable", () => {
    expect(LAYER_LIST.filter((l) => LAYERS.has(l.component)).length).toBeGreaterThanOrEqual(38);
    expect(LAYER_LIST.filter((l) => l.classes === null).map((l) => l.where)).toEqual([]);
  });
  test("a layer's actions are in its footer: no house foot", () => {
    const house = LAYER_LIST.flatMap((l) =>
      l.houseFeet
        .flatMap((c) => c.split(/\s+/))
        .filter((c) => /(?:foot|actions)$/.test(c) && !(c in HOUSE_FEET_ALLOWED))
        .map((c) => `${l.where} ${l.component}: ${c}`),
    );
    expect(house).toEqual([]);
  });
});

// ── The slot rules against their callers ─────────────────────────────────────────

type SweepCase = { where: string; component: string; slot: string; side: string; caller: string; merged: string; base: string };
type SweepRow = { screen: string; where: string; component: string; caller: string; overridden: Array<{ prop: string; asked: string; got: string }>; padding: [string, string]; width: string };

const SWEEP_SCRIPT = String.raw`
const out = [];
for (const [w, h] of [[740, 360], [1280, 800]]) {
  const f = document.createElement("iframe");
  f.style.cssText = "border:0;position:absolute;left:0;top:0;width:" + w + "px;height:" + h + "px";
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write('<!doctype html><html lang="fr"><head><style>' + DATA.css + '</style><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body></body></html>');
  d.close();
  const win = f.contentWindow;
  const make = (slot, side, cls) => {
    const el = d.createElement("div");
    el.setAttribute("data-slot", slot);
    el.setAttribute("data-side", side);
    el.setAttribute("data-state", "open");
    el.setAttribute("data-align", "center");
    el.className = cls;
    d.body.appendChild(el);
    return el;
  };
  const styleOf = (el) => { const cs = win.getComputedStyle(el); const o = {}; for (let i = 0; i < cs.length; i++) o[cs[i]] = cs.getPropertyValue(cs[i]); return o; };
  // Every style rule with the conditions it sits under: what a caller's classes DECLARE.
  const rules = [];
  const collect = (list, conds, parent) => {
    for (const r of list) {
      if (r instanceof win.CSSStyleRule) {
        const sel = parent ? r.selectorText.replace(/&/g, ":is(" + parent + ")") : r.selectorText;
        rules.push({ sel, conds, props: [...r.style] });
        if (r.cssRules && r.cssRules.length) collect(r.cssRules, conds, sel);
      } else if (r instanceof win.CSSMediaRule) collect(r.cssRules, [...conds, () => win.matchMedia(r.conditionText).matches], parent);
      else if (r instanceof win.CSSSupportsRule) collect(r.cssRules, [...conds, () => win.CSS.supports(r.conditionText)], parent);
      else if (r instanceof win.CSSContainerRule) continue;
      else if (r.cssRules) collect(r.cssRules, conds, parent);
    }
  };
  for (const s of d.styleSheets) collect(s.cssRules, [], null);
  const matching = (el) => rules.filter((r) => { try { return el.matches(r.sel) && r.conds.every((c) => c()); } catch { return false; } });
  for (const c of DATA.cases) {
    // As rendered, and under a slot no rule names: what the caller's classes give alone.
    const real = make(c.slot, c.side, c.merged);
    const A = styleOf(real);
    const padding = [A["padding-top"], A["padding-bottom"]];
    const width = A["width"];
    real.remove();
    const probe = make(c.slot + "-probe", c.side, c.merged);
    const B = styleOf(probe);
    const base = make(c.slot + "-probe", c.side, c.base);
    const baseSel = new Set(matching(base).map((r) => r.sel));
    const own = matching(probe).filter((r) => !baseSel.has(r.sel));
    probe.remove();
    base.remove();
    const asked = [...new Set(own.flatMap((r) => r.props))];
    const overridden = asked.filter((k) => A[k] !== undefined && A[k] !== B[k]).map((k) => ({ prop: k, asked: B[k], got: A[k] }));
    out.push({ screen: w + "x" + h, where: c.where, component: c.component, caller: c.caller, overridden, padding, width });
  }
  f.remove();
}
document.getElementById("out").textContent = JSON.stringify(out);
`;

// ── Every layer laid out with its foot ───────────────────────────────────────────

const SCALES = { sm: "87.5%", md: "", lg: "112.5%", xl: "125%", "2xl": "137.5%", "3xl": "150%" } as const;
const KEYBOARDS = [0, 160, 200, 220, 260] as const;
const LIMIT_KB = 336;
const SCREENS: Array<[number, number]> = [
  [740, 360],
  [360, 740],
];

type LayerCase = { where: string; component: string; caller: string; html: string; hasFooter: boolean };
type LayerCell = { where: string; caller: string; screen: string; scale: string; kb: number; shown: number; box: [number, number]; footer: { whole: boolean; seen: number; height: number; bottom: number } | null };
type LayerFloor = { where: string; caller: string; screen: string; scale: string; floor: number | null; bound: number };
// How far a layer's footer runs past its width, in one of the fonts.
type LayerFit = { where: string; caller: string; screen: string; scale: string; font: string; over: number };
type LayerOut = { cells: LayerCell[]; floors: LayerFloor[]; limit: LayerCell[]; fits: LayerFit[]; errors: string[] };

// The fonts a footer must fit its width in: this platform's (the app's own stack), and one
// as wide on every platform — monospace's glyphs, 0.6 em each, wider than a UI font's —,
// set through the app's own token (charts set it so). Twice named: the generic alone would
// shrink the root's font size (the monospace quirk).
const FONTS: Array<[string, string | null]> = [
  ["this platform's font", null],
  ["text as wide as monospace", "monospace, monospace"],
];

const LAYER_SCRIPT = String.raw`
const cells = [], floors = [], limit = [], fits = [], errors = [];
function seen(w, el, shownBottom) {
  const r = el.getBoundingClientRect();
  let top = Math.max(r.top, 0), bottom = Math.min(r.bottom, shownBottom);
  for (let p = el.parentElement; p && p !== w.document.documentElement; p = p.parentElement) {
    const cs = w.getComputedStyle(p);
    if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
      const pr = p.getBoundingClientRect();
      top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom);
    }
    if (cs.position === "fixed") break;
  }
  const s = Math.max(0, bottom - top);
  return { top: r.top, bottom: r.bottom, height: r.height, seen: s, whole: r.height > 0 && s >= r.height - 0.5 };
}
function setKeyboard(w, kb) {
  const root = w.document.documentElement;
  root.style.setProperty("--oc-kb", kb + "px");
  root.style.setProperty("--oc-vv-bottom", kb + "px");
  root.style.setProperty("--oc-vv-top", "0px");
  root.style.setProperty("--oc-vv-left", "0px");
  void root.offsetHeight;
}
function px(w, v) { const d = w.document.createElement("div"); d.style.cssText = "position:absolute;visibility:hidden;height:" + v; w.document.body.appendChild(d); const h = d.getBoundingClientRect().height; d.remove(); return h; }
function measure(w, c, screen, kb, scale) {
  setKeyboard(w, kb);
  const shown = screen[1] - kb;
  const layer = w.document.querySelector("[data-slot$='-content']");
  const r = layer.getBoundingClientRect();
  const foot = layer.querySelector("[data-slot$='-footer']");
  let footer = null;
  if (foot) {
    // Whole: every control in it is. Seen, and its foot: the footer itself (under the
    // floor, what is kept is its foot, padding included, as lot 28 measured it).
    const buttons = [...foot.querySelectorAll("button")].map((b) => seen(w, b, shown));
    const own = seen(w, foot, shown);
    footer = { whole: buttons.every((b) => b.whole), seen: own.seen, height: own.height, bottom: own.bottom };
  }
  return { where: c.where, caller: c.caller, screen: screen.join("x"), scale, kb, shown, box: [r.top, r.bottom], footer };
}
for (const c of DATA.cases) {
  for (const screen of DATA.screens) {
    try {
      const frame = document.createElement("iframe");
      frame.style.cssText = "border:0;position:absolute;left:0;top:0;width:" + screen[0] + "px;height:" + screen[1] + "px";
      document.body.appendChild(frame);
      const d = frame.contentDocument;
      d.open();
      d.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>' + DATA.css + '</style><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body>' + c.html + '</body></html>');
      d.close();
      const w = frame.contentWindow;
      for (const [scale, size] of Object.entries(DATA.scales)) {
        d.documentElement.style.fontSize = size;
        for (const kb of DATA.kbs) cells.push(measure(w, c, screen, kb, scale));
        if (c.hasFooter) {
          setKeyboard(w, 0);
          const foot = d.querySelector("[data-slot$='-footer']");
          const layer = d.querySelector("[data-slot$='-content']");
          const rects = [...foot.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
          const cs = w.getComputedStyle(layer);
          const bound = Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top)) + 2 * px(w, "0.5rem") + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + 2;
          let floor = null;
          if (measure(w, c, screen, 0, scale).footer.whole) {
            let lo = 0, hi = screen[1];
            while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (measure(w, c, screen, screen[1] - mid, scale).footer.whole) hi = mid; else lo = mid; }
            floor = hi;
          }
          floors.push({ where: c.where, caller: c.caller, screen: screen.join("x"), scale, floor, bound });
          setKeyboard(w, Math.max(0, screen[1] - 24));
          layer.scrollTo({ top: layer.scrollHeight, behavior: "instant" });
          limit.push(measure(w, c, screen, Math.max(0, screen[1] - 24), scale));
          layer.scrollTo({ top: 0, behavior: "instant" });
          setKeyboard(w, 0);
          for (const [font, stack] of DATA.fonts) {
            if (stack === null) d.documentElement.style.removeProperty("--ui-font-sans");
            else d.documentElement.style.setProperty("--ui-font-sans", stack);
            fits.push({ where: c.where, caller: c.caller, screen: screen.join("x"), scale, font, over: foot.scrollWidth - foot.clientWidth });
          }
          d.documentElement.style.removeProperty("--ui-font-sans");
        }
      }
      frame.remove();
    } catch (e) { errors.push(c.where + " " + screen.join("x") + ": " + String(e && e.stack || e)); }
  }
}
document.getElementById("out").textContent = JSON.stringify({ cells, floors, limit, fits, errors });
`;

/** A layer as its component renders it: its content, its header, a body long enough to
 *  scroll, its footer (with two of the buttons the app's Button renders) when it has one. */
function layerHtml(l: Layer, caller: string): string {
  const kind = l.slot.replace(/-content$/, "");
  const content = classOf(l.slot, caller).merged;
  const header = classOf(`${kind}-header`, "").merged;
  const button = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2.5 text-sm font-medium whitespace-nowrap";
  const body = Array.from({ length: 30 }, () => "<p>Le contenu de la couche, assez long pour la faire defiler sous son pied.</p>").join("");
  const footer = l.footer
    ? `<div data-slot="${kind}-footer" class="${classOf(`${kind}-footer`, l.footer.classes[0] ?? "").merged}"><button type="button" class="${button}">Annuler</button><button type="button" class="${button}">Confirmer</button></div>`
    : "";
  return `<div role="dialog" data-slot="${l.slot}" data-state="open" data-side="${l.side}" class="${content}"><div data-slot="${kind}-header" class="${header}"><h2>Titre de la couche</h2><p>Une description de la couche, sur une ligne ou deux.</p></div><div class="oc-layer-probe-body">${body}</div>${footer}</div>`;
}

const chrome = chromeOrFail("layers.test.ts");

describe.skipIf(chrome === null)("every layer in every stylesheet the app loads — laid out by Chrome (lot 29)", () => {
  const ready = (async () => {
    const css = await appCss();
    const sweepCases: SweepCase[] = LAYER_LIST.flatMap((l) =>
      (l.classes ?? []).map((caller) => {
        const { merged, base } = classOf(l.slot, caller);
        return { where: l.where, component: l.component, slot: l.slot, side: l.side, caller, merged, base };
      }),
    );
    const layerCases: LayerCase[] = LAYER_LIST.filter((l) => LAYERS.has(l.component)).flatMap((l) =>
      [...new Set(l.classes ?? [])].map((caller) => ({ where: l.where, component: l.component, caller, html: layerHtml(l, caller), hasFooter: l.footer !== null })),
    );
    const sweepPage = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre><script>const DATA = ${scriptData({ css, cases: sweepCases })};${SWEEP_SCRIPT}</script></body></html>`;
    const layerPage = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre><script>const DATA = ${scriptData({ css, cases: layerCases, screens: SCREENS, scales: SCALES, kbs: KEYBOARDS, limitKb: LIMIT_KB, fonts: FONTS })};${LAYER_SCRIPT}</script></body></html>`;
    return {
      sweep: await runChrome<SweepRow[]>(chrome!, sweepPage),
      layers: await runChrome<LayerOut>(chrome!, layerPage, { budgetMs: 60000 }),
      layerCases,
    };
  })();

  test("a rule on a shared slot never beats what a caller asks on the same property", async () => {
    const { sweep } = await ready;
    expect(sweep.length).toBeGreaterThan(80);
    const bad = sweep
      .filter((r) => r.overridden.length > 0)
      .map((r) => `${r.screen} ${r.where} ${r.component} "${r.caller}": ${r.overridden.map((o) => `${o.prop} asked ${o.asked}, got ${o.got}`).join("; ")}`);
    expect(bad).toEqual([]);
  }, 240_000);

  test("the search palette, measured: no vertical padding with its p-0", async () => {
    const { sweep } = await ready;
    const palette = sweep.filter((r) => r.where.startsWith("src/chat/GlobalSearch.tsx") && r.component === "DialogContent");
    expect(palette.length).toBe(2);
    for (const r of palette) expect(r.padding, r.screen).toEqual(["0px", "0px"]);
  }, 240_000);

  // A caller may also ask through the slot itself (a rule as specific as the shared one,
  // `.view[data-slot="..."]`): what the sweep cannot tell from the shared rules, measured.
  test("the requests panel, measured: its 30rem within what is shown, not the side sheets' 75 %", async () => {
    const { sweep } = await ready;
    const panel = sweep.filter((r) => r.where.startsWith("src/chat/AgentRequests.tsx") && r.component === "SheetContent");
    expect(panel.length).toBe(2);
    for (const r of panel) expect(r.width, r.screen).toBe("480px");
  }, 240_000);

  test("the browser laid out every layer", async () => {
    const { layers, layerCases } = await ready;
    expect(layers.errors).toEqual([]);
    expect(layers.cells.length).toBe(layerCases.length * SCREENS.length * Object.keys(SCALES).length * KEYBOARDS.length);
  }, 240_000);

  test("every layer stays within what is shown, at every keyboard", async () => {
    const { layers } = await ready;
    const bad = layers.cells
      .filter((c) => c.box[0] < -0.5 || c.box[1] > c.shown + 0.5)
      .map((c) => `${c.where} "${c.caller}" ${c.screen} ${c.scale} keyboard ${c.kb}: ${c.box[0].toFixed(1)}-${c.box[1].toFixed(1)} for ${c.shown} shown`);
    expect(bad).toEqual([]);
  }, 240_000);

  test("a layer's floor is its footer and its own chrome; above it, the footer is whole", async () => {
    const { layers } = await ready;
    const over = layers.floors
      .filter((f) => f.floor === null || f.floor > f.bound)
      .map((f) => `${f.where} "${f.caller}" ${f.screen} ${f.scale}: floor ${f.floor ?? "never met"} > ${f.bound.toFixed(1)}`);
    expect(over).toEqual([]);
    const floor = new Map(layers.floors.map((f) => [`${f.where}|${f.caller}|${f.screen}|${f.scale}`, f.floor ?? Infinity]));
    const cut = layers.cells
      .filter((c) => c.footer !== null && c.shown >= floor.get(`${c.where}|${c.caller}|${c.screen}|${c.scale}`)! && !c.footer.whole)
      .map((c) => `${c.where} "${c.caller}" ${c.screen} ${c.scale} keyboard ${c.kb}: footer ${c.footer!.seen.toFixed(1)}/${c.footer!.height.toFixed(1)}, a control cut`);
    expect(cut).toEqual([]);
  }, 240_000);

  test("under its floor (24 px shown), the footer's foot is where the layer's scroll ends", async () => {
    const { layers } = await ready;
    const bad = layers.limit
      .filter((c) => !c.footer || c.footer.seen <= 0 || c.footer.bottom > c.shown + 0.5)
      .map((c) => `${c.where} "${c.caller}" ${c.screen} ${c.scale}: footer ${c.footer ? `${c.footer.seen.toFixed(1)} seen, foot at ${c.footer.bottom.toFixed(1)}` : "none"} for ${c.shown} shown`);
    expect(bad).toEqual([]);
  }, 240_000);

  // A FOOTER FITS ITS LAYER'S WIDTH (lot 31): its controls wrap rather than run past it,
  // in this platform's font and in a wider one, the same on every platform. Under Linux
  // (DejaVu Sans, its scrollbars taking room) the agent-file editor's row of controls ran
  // 3 px past its width at the largest text scale, and the scrollbar that this opened took
  // 15 of the 24 px shown: the dialog's foot went out of view.
  test("a layer's footer fits its width — its controls wrap rather than run past it — in this platform's font and in text as wide as monospace (lot 31)", async () => {
    const { layers, layerCases } = await ready;
    expect(layers.fits.length).toBe(layerCases.filter((c) => c.hasFooter).length * SCREENS.length * Object.keys(SCALES).length * FONTS.length);
    const bad = layers.fits
      .filter((f) => f.over > 0.5)
      .map((f) => `${f.where} "${f.caller}" ${f.screen} ${f.scale}, ${f.font}: ${f.over.toFixed(1)} px past its width`);
    expect(bad).toEqual([]);
  }, 240_000);
});
