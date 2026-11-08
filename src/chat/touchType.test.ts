/// <reference types="vite/client" />
//
// Lot 7 (2026-11): type and targets for a finger. Each rule here is DERIVED from the
// sources, so a stylesheet or a component added tomorrow is held to it too.
//
// 1. Fields at 16 px where touch is used — below that, iOS and iPadOS zoom the page
//    on focus. Under each of the six text scales, every declaration that can win
//    a field's cascade gives it 16 px or more (lot 20: the touch floor is
//    important, and each field's cascade is computed).
// 2. No text under 12 px (the qualifier size of the 14/12 scale), except glyphs set
//    in a fixed shape (initials in a circle, a count in a bubble).
// 3. Menu and list items a finger's height on a coarse pointer; the shared Button's
//    tap zone grown like `.oc-hit`'s — without moving a Button placed by a utility.
// 4. Keyboard hints hidden where the primary pointer is a finger (lot 9, C1).
// 5. The sidebar's rows a finger's height where the primary pointer is a finger
//    (lot 10), their zones grown with them; dense under a mouse.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { FONT_SCALES, FONT_SCALE_CSS, type FontScale } from "@/lib/useFontScale";

const SRC = join(process.cwd(), "src");

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "paraglide" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

type Rule = { selector: string; body: string; media: string | null; layer: string | null };

/** The stylesheet without its comments — read around strings: the `/*` of a glob
 *  (`@source ".../dist/*.js"`) opens no comment (lot 20). */
function stripComments(css: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote !== "") {
      out += ch;
      if (ch === "\\") out += css[++i] ?? "";
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) throw new Error("an unclosed comment");
      out += " ";
      i = end + 1;
    } else out += ch;
  }
  return out;
}

function rules(css: string): Rule[] {
  const src = stripComments(css);
  const out: Rule[] = [];
  const parse = (text: string, media: string | null, layer: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) parse(body, head.slice(6).trim(), layer);
      else if (head.startsWith("@layer")) parse(body, media, head.slice(6).trim());
      else if (!head.startsWith("@")) out.push({ selector: head, body, media, layer });
      i = j;
    }
  };
  parse(src, null, null);
  return out;
}

const ALL_RULES = walk(SRC, ".css").flatMap((f) => rules(readFileSync(f, "utf-8")));
const TSX = walk(SRC, ".tsx").map((f) => readFileSync(f, "utf-8"));

/** A font-size declaration in px (rem at 16 px), or null for relative units. */
function fontPx(body: string): number | null {
  const m = body.match(/font-size:\s*([0-9.]+)(rem|px)\b/);
  if (!m) return null;
  return parseFloat(m[1]) * (m[2] === "rem" ? 16 : 1);
}

const isTouch = (media: string | null) =>
  media !== null && /hover:\s*none|any-pointer:\s*coarse/.test(media);

// ---- FIELDS (G4; lots 19, 20) -------------------------------------------------
//
// Lot 19: the fields are found by the TypeScript syntax tree, every one — a regex
// stopped at the `>` of `=>` in `onChange={(e) => …}` and missed the search field.
// Their classes are read from literals, constants, conditions, `cn()` arguments
// and template parts; a className the guard cannot read fails it.
//
// Lot 20: the floor weighed nothing (`:where`) and raised a list of classes by
// name, so any rule outside the list beat it: the room picker's search took its
// popover's 14 px through `font: inherit`, and the text scale moved every rem — at
// "sm" (a 14 px root) the composer fell to 14 px, the full-page composer's 1.02rem
// to 14.28 px. iOS zoomed, and a zoomed page stops fitting its layers to the
// keyboard. The floor is now `!important`, and the guard computes the cascade each
// field gets under each of the six text scales: every declaration that can still
// win it is evaluated — the `font` shorthand, `inherit`/`initial`/`unset`, rem, em,
// %, `calc()`, `var()`, `min()`, `max()`, `clamp()` — and must give 16 px or more.
// A value or a construct the guard cannot evaluate fails it. Nothing else may carry
// an important size or shrink what iOS reads — no `!` text class, no priority or
// style set from a script, no CSS zoom, no text-size-adjust but 100 % — and the
// parser checks it met every declaration of every stylesheet it reads.

/** The components that render a text field, and its element. */
const FIELD_TAGS: Record<string, string> = {
  input: "input",
  textarea: "textarea",
  select: "select",
  Input: "input",
  "ComposerPrimitive.Input": "textarea",
};
/** Input types that are no text field: iOS does not zoom on them. */
const NOT_TEXT = new Set(["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "image", "hidden"]);

type Field = {
  at: string;
  tag: string;
  element: string;
  type: string | null;
  classes: string[];
  inlineFont: string | null;
  editable?: boolean;
};

function fieldInventory(): Field[] {
  const out: Field[] = [];
  for (const file of walk(SRC, ".tsx")) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const consts = new Map<string, string>();
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isStringLiteralLike(n.initializer)) {
        consts.set(n.name.getText(sf), n.initializer.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const strings = (e: ts.Node | undefined, where: string): string[] => {
      if (e === undefined) return [];
      if (ts.isStringLiteralLike(e)) return [e.text];
      if (ts.isJsxExpression(e) || ts.isParenthesizedExpression(e)) return strings(e.expression, where);
      if (ts.isConditionalExpression(e)) return [...strings(e.whenTrue, where), ...strings(e.whenFalse, where)];
      if (ts.isBinaryExpression(e) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) {
        return [...strings(e.left, where), ...strings(e.right, where)];
      }
      if (ts.isTemplateExpression(e)) {
        return [e.head.text, ...e.templateSpans.flatMap((sp) => [...strings(sp.expression, where), sp.literal.text])];
      }
      if (ts.isCallExpression(e) && /^(cn|clsx|cx)$/.test(e.expression.getText(sf))) return e.arguments.flatMap((a) => strings(a, where));
      if (ts.isIdentifier(e) && consts.has(e.text)) return [consts.get(e.text)!];
      if (ts.isIdentifier(e) && e.text === "className") return []; // a wrapper passing its own prop on
      throw new Error(`${where}: a field's className the guard cannot read: ${e.getText(sf)}`);
    };
    const visit = (n: ts.Node) => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && FIELD_TAGS[n.tagName.getText(sf)]) {
        const attr = (name: string) =>
          n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
        const at = `${file.slice(SRC.length + 1)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        const typeInit = attr("type")?.initializer;
        const type = typeInit !== undefined && ts.isStringLiteralLike(typeInit) ? typeInit.text : null;
        const tag = n.tagName.getText(sf);
        const element = FIELD_TAGS[tag];
        if (!(element === "input" && type !== null && NOT_TEXT.has(type))) {
          const classes = strings(attr("className")?.initializer, at).join(" ").split(/\s+/).filter(Boolean);
          const style = attr("style")?.initializer?.getText(sf) ?? "";
          out.push({ at, tag, element, type, classes: [...new Set(classes)], inlineFont: /fontSize|zoom|textSizeAdjust/.test(style) ? style : null });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // The shared Input renders its own classes with the caller's.
  const base = out.find((f) => f.at.startsWith(join("components", "ui", "input.tsx")));
  return out.map((f) => (f.tag === "Input" && base !== undefined ? { ...f, classes: [...new Set([...base.classes, ...f.classes])] } : f));
}

/** A bare field of each kind the floor must hold: every text input type, the
 *  textarea, the select, an editable element. */
const BARE_FIELDS: Field[] = [
  ...[null, "text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"].map(
    (type): Field => ({ at: `<input type=${type ?? "(none)"}>`, tag: "input", element: "input", type, classes: [], inlineFont: null }),
  ),
  { at: "<textarea>", tag: "textarea", element: "textarea", type: null, classes: [], inlineFont: null },
  { at: "<select>", tag: "select", element: "select", type: null, classes: [], inlineFont: null },
  { at: "<div contenteditable>", tag: "div", element: "div", type: null, classes: [], inlineFont: null, editable: true },
];

/** The comma-separated parts of a selector list, parentheses kept whole. */
function splitList(list: string): string[] {
  return splitTop(list, ",").map((p) => p.trim()).filter((p) => p !== "");
}

/** `text` split at `sep` where it stands outside parentheses, brackets and quotes. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let part = "";
  for (const ch of text) {
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
      out.push(part);
      part = "";
      continue;
    }
    part += ch;
  }
  out.push(part);
  return out;
}

type Spec = [number, number, number];

/** A selector's specificity [ids, classes/attributes/pseudo-classes, elements];
 *  `:where()` counts nothing, `:not()`/`:is()`/`:has()` their heaviest argument. */
function specificity(selector: string): Spec {
  const total: Spec = [0, 0, 0];
  let rest = "";
  for (let i = 0; i < selector.length; ) {
    const fn = /^:(where|not|is|has)\(/.exec(selector.slice(i));
    if (fn === null) {
      rest += selector[i++];
      continue;
    }
    let depth = 1;
    let j = i + fn[0].length;
    for (; j < selector.length && depth > 0; j++) {
      if (selector[j] === "(") depth++;
      else if (selector[j] === ")") depth--;
    }
    if (fn[1] !== "where") {
      const heaviest = splitList(selector.slice(i + fn[0].length, j - 1))
        .map(specificity)
        .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0];
      if (heaviest !== undefined) heaviest.forEach((v, k) => (total[k] += v));
    }
    rest += " ";
    i = j;
  }
  rest = rest.replace(/\[[^\]]*\]/g, () => (total[1]++, " "));
  rest = rest.replace(/::[\w-]+/g, () => (total[2]++, " "));
  rest = rest.replace(/#[\w-]+/g, () => (total[0]++, " "));
  rest = rest.replace(/\.(?:\\.|[\w-])+/g, () => (total[1]++, " "));
  rest = rest.replace(/:[\w-]+/g, () => (total[1]++, " "));
  for (const m of rest.matchAll(/(^|[\s>+~])([a-zA-Z][\w-]*)/g)) if (m[2] !== "") total[2]++;
  return total;
}

// ---- The stylesheets, as the browser gets them: the app's and those it imports.

/** A declaration that sets a font size: `font-size`, the `font` shorthand, `all`. */
type Decl = {
  prop: string;
  value: string;
  important: boolean;
  selector: string;
  media: string[];
  layer: string | null;
  file: string;
  order: number;
  inline?: boolean;
};

type CssModel = {
  decls: Decl[];
  /** Cascade layers in the order they first appear. */
  layers: string[];
  /** Custom properties set at the root (`:root`, `:host`, `@theme`): the last value. */
  tokens: Map<string, string>;
  /** Custom properties also set below the root: their value depends on the place. */
  scoped: Set<string>;
  /** `zoom` and `text-size-adjust`: they scale the text iOS reads, behind its size. */
  scaling: Decl[];
  /** Per file, the declarations the parser met that bear on a size — a size, a zoom,
   *  a text-size adjustment, a custom property — read, or inside a block it skips
   *  (a keyframes): a region it lost would leave them uncounted. */
  seen: Map<string, number>;
};

const COUNTED = /(?:^|[;{}\s])(?:font-size|font|all|zoom|-webkit-text-size-adjust|text-size-adjust|--[\w-]+)\s*:/gi;
const COUNTED_PROP = /^(font-size|font|all|zoom|-webkit-text-size-adjust|text-size-adjust|--[\w-]+)$/i;
const countSizes = (text: string) => [...text.matchAll(COUNTED)].length;
const see = (model: CssModel, file: string, n: number) => model.seen.set(file, (model.seen.get(file) ?? 0) + n);

const SKIPPED_AT = new Set(["keyframes", "font-face", "property", "counter-style", "page", "starting-style", "custom-variant", "variant", "slot", "font-feature-values"]);
const IGNORED_STATEMENTS = new Set(["tailwind", "source", "plugin", "config", "charset", "namespace", "reference", "custom-variant"]);
const CONDITIONAL_AT = new Set(["supports", "container", "scope"]);

/** Where `@import "<spec>"` leads: a relative path, or a package's style export. */
function resolveCss(spec: string, from: string): string {
  if (spec.startsWith(".")) return join(dirname(from), spec);
  const segments = spec.split("/");
  const name = spec.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const sub = spec.slice(name.length);
  const dir = join(process.cwd(), "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
    style?: string;
    exports?: Record<string, string | { style?: string; default?: string }>;
  };
  const entry = pkg.exports?.[sub === "" ? "." : `.${sub}`];
  const target = typeof entry === "string" ? entry : (entry?.style ?? (sub === "" ? pkg.style : undefined));
  if (target === undefined) throw new Error(`${from}: a stylesheet the guard cannot resolve: ${spec}`);
  return join(dir, target);
}

/** The end of a prelude or a statement: the first `{`, `;` or `}` outside strings
 *  and parentheses. */
function scanTo(text: string, from: number): { at: number; ch: string } {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === "{" || ch === ";" || ch === "}")) return { at: i, ch };
  }
  return { at: text.length, ch: "" };
}

/** The index just past the `}` closing the block opened at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  throw new Error("an unclosed block");
}

type Ctx = { file: string; media: string[]; layer: string | null; selector: string | null; root: boolean };

function parseCssFile(file: string, model: CssModel, ctx: Omit<Ctx, "file" | "selector" | "root">): void {
  const text = stripComments(readFileSync(file, "utf-8"));
  model.seen.set(file, model.seen.get(file) ?? 0);
  parseBlock(text, model, { ...ctx, file, selector: null, root: false });
}

function nestSelector(selector: string, parent: string | null): string {
  if (parent === null) return selector;
  return splitList(selector)
    .map((p) => (p.includes("&") ? p.split("&").join(`:is(${parent})`) : `:is(${parent}) ${p}`))
    .join(", ");
}

function seeLayer(model: CssModel, name: string): void {
  if (!model.layers.includes(name)) model.layers.push(name);
}

function parseBlock(text: string, model: CssModel, ctx: Ctx): void {
  let i = 0;
  while (i < text.length) {
    const { at, ch } = scanTo(text, i);
    const prelude = text.slice(i, at).trim();
    if (ch === "{") {
      const end = closing(text, at);
      parseRule(prelude, text.slice(at + 1, end - 1), model, ctx);
      i = end;
      continue;
    }
    if (prelude !== "") parseStatement(prelude, model, ctx);
    i = at + 1;
  }
}

function parseStatement(statement: string, model: CssModel, ctx: Ctx): void {
  const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(statement);
  if (at !== null) {
    const name = at[1].toLowerCase();
    const params = at[2].trim();
    if (name === "import") {
      const spec = /^(?:url\()?\s*["']([^"']+)["']\s*\)?\s*([\s\S]*)$/.exec(params);
      if (spec === null) throw new Error(`${ctx.file}: an import the guard cannot read: ${statement}`);
      let rest = spec[2];
      let layer = ctx.layer;
      const named = /^layer\(([^)]*)\)\s*/.exec(rest);
      if (named !== null) {
        layer = ctx.layer === null ? named[1].trim() : `${ctx.layer}.${named[1].trim()}`;
        rest = rest.slice(named[0].length);
      } else if (/^layer\b/.test(rest)) throw new Error(`${ctx.file}: an anonymous layer import: ${statement}`);
      if (layer !== null) seeLayer(model, layer);
      const media = rest.trim() === "" ? ctx.media : [...ctx.media, rest.trim()];
      parseCssFile(resolveCss(spec[1], ctx.file), model, { media, layer });
      return;
    }
    if (name === "layer") {
      for (const l of params.split(",")) seeLayer(model, ctx.layer === null ? l.trim() : `${ctx.layer}.${l.trim()}`);
      return;
    }
    if (name === "apply") {
      if (ctx.selector === null) throw new Error(`${ctx.file}: @apply outside a rule`);
      for (const token of params.split(/\s+/).filter(Boolean)) {
        const u = textUtility(token, model);
        if (u === null) continue;
        model.decls.push({ prop: "font-size", value: u.value, important: u.important, selector: ctx.selector, media: [...ctx.media, ...u.media], layer: ctx.layer, file: ctx.file, order: model.decls.length });
      }
      return;
    }
    if (IGNORED_STATEMENTS.has(name)) return;
    throw new Error(`${ctx.file}: an at-rule the guard does not know: @${name}`);
  }
  if (ctx.selector === null && !ctx.root) throw new Error(`${ctx.file}: a declaration outside a rule: ${statement.slice(0, 60)}`);
  const colon = statement.indexOf(":");
  if (colon <= 0) throw new Error(`${ctx.file}: a declaration the guard cannot read: ${statement.slice(0, 60)}`);
  const prop = statement.slice(0, colon).trim();
  if (COUNTED_PROP.test(prop)) see(model, ctx.file, 1);
  let value = statement.slice(colon + 1).trim();
  const important = /!\s*important$/i.test(value);
  if (important) value = value.replace(/!\s*important$/i, "").trim();
  if (prop.startsWith("--")) {
    const atRoot = ctx.root || (ctx.selector !== null && splitList(ctx.selector).every((s) => s === ":root" || s === ":host"));
    if (atRoot) model.tokens.set(prop, value);
    else model.scoped.add(prop);
    return;
  }
  const name = prop.toLowerCase();
  if ((name === "font-size" || name === "font" || name === "all") && ctx.selector !== null) {
    model.decls.push({ prop: name, value, important, selector: ctx.selector, media: ctx.media, layer: ctx.layer, file: ctx.file, order: model.decls.length });
  }
  if ((name === "zoom" || /^(-webkit-)?text-size-adjust$/.test(name)) && ctx.selector !== null) {
    model.scaling.push({ prop: name, value, important, selector: ctx.selector, media: ctx.media, layer: ctx.layer, file: ctx.file, order: 0 });
  }
}

function parseRule(prelude: string, body: string, model: CssModel, ctx: Ctx): void {
  const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
  if (at === null) {
    parseBlock(body, model, { ...ctx, selector: nestSelector(prelude, ctx.selector), root: false });
    return;
  }
  const name = at[1].toLowerCase();
  const params = at[2].trim();
  if (name === "media") parseBlock(body, model, { ...ctx, media: [...ctx.media, params] });
  else if (name === "layer") {
    if (params === "") throw new Error(`${ctx.file}: an anonymous layer block`);
    const layer = ctx.layer === null ? params : `${ctx.layer}.${params}`;
    seeLayer(model, layer);
    parseBlock(body, model, { ...ctx, layer });
  } else if (CONDITIONAL_AT.has(name)) parseBlock(body, model, ctx); // may hold: taken as holding
  else if (name === "theme") {
    // Its tokens are the root's; a nested block (a keyframes) is no token.
    let i = 0;
    while (i < body.length) {
      const { at: end, ch } = scanTo(body, i);
      const statement = body.slice(i, end).trim();
      if (ch === "{") {
        const close = closing(body, end);
        see(model, ctx.file, countSizes(body.slice(end, close)));
        i = close;
        continue;
      }
      if (statement !== "") parseStatement(statement, model, { ...ctx, selector: null, root: true });
      i = end + 1;
    }
  } else if (name === "utility") {
    // A Tailwind utility: the class of that name, in the utilities layer.
    seeLayer(model, "utilities");
    parseBlock(body, model, { ...ctx, selector: `.${params.replace(/-\*$/, "-x")}`, layer: "utilities", root: false });
  } else if (SKIPPED_AT.has(name)) see(model, ctx.file, countSizes(body));
  else throw new Error(`${ctx.file}: an at-rule the guard does not know: @${name}`);
}


const textSizes = new WeakMap<CssModel, { count: number; keys: Set<string> }>();
/** Tailwind's font sizes: the `--text-*` tokens of the theme (xs, sm, base, …). */
function TEXT_SIZES(model: CssModel): Set<string> {
  const known = textSizes.get(model);
  if (known !== undefined && known.count === model.tokens.size) return known.keys;
  const keys = new Set([...model.tokens.keys()].filter((k) => /^--text-[\w.]+$/.test(k) && !k.slice(7).includes("--")).map((k) => k.slice(7)));
  textSizes.set(model, { count: model.tokens.size, keys });
  return keys;
}

const BREAKPOINTS: Record<string, string> = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" };
const PSEUDO_ELEMENT_VARIANTS = new Set(["file", "placeholder", "before", "after", "selection", "marker", "first-line", "first-letter", "backdrop", "*", "**"]);

/** A Tailwind class that sets a font size (`text-sm`, `md:text-xs`, `text-[13px]`,
 *  `text-sm!`): the value, its importance, the media its variants add, the weight
 *  its states add. A colour or an alignment (`text-foreground`, `text-left`) and a
 *  pseudo-element's size (`file:text-sm`, `placeholder:…`) are no field's size. */
function textUtility(token: string, model: CssModel): { value: string; important: boolean; media: string[]; spec: Spec } | null {
  const parts = splitTop(token, ":");
  let utility = parts.pop() ?? "";
  let important = false;
  if (utility.startsWith("!")) {
    important = true;
    utility = utility.slice(1);
  }
  if (utility.endsWith("!")) {
    important = true;
    utility = utility.slice(0, -1);
  }
  const m = /^text-(\[[^\]]+\]|\([^)]+\)|[\w.]+)(?:\/[\w.[\]()-]+)?$/.exec(utility);
  if (m === null) return null;
  const key = m[1];
  let value: string;
  if (key.startsWith("[")) {
    const inner = key.slice(1, -1).replace(/_/g, " ");
    if (inner.startsWith("length:")) value = inner.slice(7);
    else if (/^(-?[\d.]+[a-z%]*$|calc\(|min\(|max\(|clamp\(|var\()/.test(inner)) value = inner;
    else return null;
  } else if (key.startsWith("(")) {
    const inner = key.slice(1, -1);
    if (!inner.startsWith("length:")) return null;
    value = `var(${inner.slice(7)})`;
  } else if (TEXT_SIZES(model).has(key)) value = `var(--text-${key})`;
  else return null;
  const media: string[] = [];
  const spec: Spec = [0, 1, 0];
  for (const variant of parts) {
    if (PSEUDO_ELEMENT_VARIANTS.has(variant)) return null;
    const bp = /^(max-)?(sm|md|lg|xl|2xl)$/.exec(variant);
    if (bp !== null) media.push(bp[1] ? `not all and (min-width: ${BREAKPOINTS[bp[2]]})` : `(min-width: ${BREAKPOINTS[bp[2]]})`);
    else {
      if (variant === "hover") media.push("(hover: hover)");
      spec[1]++; // a state, a data-/aria- attribute, a group or a theme: it may hold
    }
  }
  return { value, important, media, spec };
}

/** Every stylesheet of the app, in the order main.tsx loads the first two, with
 *  what each imports in place (Tailwind's theme, preflight and layers, the
 *  animation and shadcn sheets). */
const CSS: CssModel = (() => {
  const model: CssModel = { decls: [], layers: [], tokens: new Map(), scoped: new Set(), scaling: [], seen: new Map() };
  const first = [join(SRC, "index.css"), join(SRC, "chat", "convexChat.css")];
  for (const file of [...first, ...walk(SRC, ".css").filter((f) => !first.includes(f)).sort()]) {
    parseCssFile(file, model, { media: [], layer: null });
  }
  return model;
})();

// ---- A font size, evaluated ----------------------------------------------------

/** The px a font size can take: [least, most]. */
type Interval = [number, number];
type Val = { kind: "number"; n: number } | { kind: "length"; iv: Interval };

const ABSOLUTE_SIZES: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48 };
const ABSOLUTE_UNITS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

/** `var(--x[, fallback])` replaced by the root's value of `--x` — a property also
 *  set below the root, or unknown with no fallback, cannot be evaluated. */
function substituteVars(text: string, model: CssModel, depth = 0): string {
  const at = text.search(/var\(/i);
  if (at === -1) return text;
  if (depth > 8) throw new Error(`custom properties nested too deep: ${text}`);
  let level = 0;
  let end = at + 4;
  for (; end < text.length; end++) {
    if (text[end] === "(") level++;
    else if (text[end] === ")") {
      if (level === 0) break;
      level--;
    }
  }
  const [name, ...fallback] = splitTop(text.slice(at + 4, end), ",");
  const prop = name.trim();
  let value: string;
  if (model.scoped.has(prop)) throw new Error(`${prop} is also set below the root: its value depends on where the field sits`);
  else if (model.tokens.has(prop)) value = model.tokens.get(prop)!;
  else if (fallback.length > 0) value = fallback.join(",").trim();
  else throw new Error(`a custom property the guard cannot resolve: ${prop}`);
  return substituteVars(text.slice(0, at) + value + text.slice(end + 1), model, depth + 1);
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (/^\s/.test(rest)) {
      i++;
      continue;
    }
    const fn = /^[a-zA-Z-]+\(/.exec(rest);
    if (fn !== null) {
      out.push(fn[0].toLowerCase());
      i += fn[0].length;
      continue;
    }
    const prev = out[out.length - 1];
    const signed = prev === undefined || prev.endsWith("(") || ["(", ",", "+", "-", "*", "/"].includes(prev);
    const num = (signed ? /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-zA-Z%]*/ : /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-zA-Z%]*/).exec(rest);
    if (num !== null) {
      out.push(num[0]);
      i += num[0].length;
      continue;
    }
    if ("()+-*/,".includes(rest[0])) {
      out.push(rest[0]);
      i++;
      continue;
    }
    const word = /^[a-zA-Z-]+/.exec(rest);
    if (word !== null) {
      out.push(word[0]);
      i += word[0].length;
      continue;
    }
    throw new Error(`a character the guard cannot read in "${text}": ${rest[0]}`);
  }
  return out;
}

const lo = (x: number) => (Number.isNaN(x) ? -Infinity : x);
const hi = (x: number) => (Number.isNaN(x) ? Infinity : x);
const span = (a: number, b: number): Val => ({ kind: "length", iv: [lo(a), hi(b)] });

function times(v: Val, k: number): Val {
  if (v.kind === "number") return { kind: "number", n: v.n * k };
  const [a, b] = v.iv;
  return k >= 0 ? span(a * k, b * k) : span(b * k, a * k);
}

/** A math expression of lengths and numbers, as CSS reads it inside `calc()`. */
function evaluate(tokens: string[], root: number): Val {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => {
    if (i >= tokens.length) throw new Error(`an expression cut short: ${tokens.join(" ")}`);
    return tokens[i++];
  };
  const dimension = (n: number, unit: string): Val => {
    if (unit === "") return { kind: "number", n };
    if (unit === "rem") return span(n * root, n * root);
    if (unit === "em" || unit === "%") {
      // The parent's size, which may be any: from nothing to anything.
      const k = unit === "%" ? n / 100 : n;
      return k === 0 ? span(0, 0) : times(span(0, Infinity), k);
    }
    if (unit in ABSOLUTE_UNITS) return span(n * ABSOLUTE_UNITS[unit], n * ABSOLUTE_UNITS[unit]);
    throw new Error(`a unit the guard cannot evaluate: ${unit}`);
  };
  const sum = (): Val => {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const w = product();
      if (v.kind !== w.kind) throw new Error(`a number added to a length: ${tokens.join(" ")}`);
      if (v.kind === "number" && w.kind === "number") v = { kind: "number", n: op === "+" ? v.n + w.n : v.n - w.n };
      else if (v.kind === "length" && w.kind === "length") v = op === "+" ? span(v.iv[0] + w.iv[0], v.iv[1] + w.iv[1]) : span(v.iv[0] - w.iv[1], v.iv[1] - w.iv[0]);
    }
    return v;
  };
  const product = (): Val => {
    let v = unary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const w = unary();
      if (op === "*") {
        if (v.kind === "length" && w.kind === "length") throw new Error(`a length times a length: ${tokens.join(" ")}`);
        v = v.kind === "number" ? times(w, v.n) : times(v, (w as { n: number }).n);
      } else {
        if (w.kind !== "number" || w.n === 0) throw new Error(`a division the guard cannot evaluate: ${tokens.join(" ")}`);
        v = times(v, 1 / w.n);
      }
    }
    return v;
  };
  const args = (): Val[] => {
    const out = [sum()];
    while (peek() === ",") {
      next();
      out.push(sum());
    }
    if (next() !== ")") throw new Error(`an unclosed function: ${tokens.join(" ")}`);
    return out;
  };
  const lengths = (vals: Val[], fn: string): Interval[] =>
    vals.map((v) => {
      if (v.kind === "length") return v.iv;
      if (v.n === 0) return [0, 0];
      throw new Error(`${fn}() of a number: ${tokens.join(" ")}`);
    });
  const unary = (): Val => {
    const t = next();
    if (t === "(" || t === "calc(") {
      const v = sum();
      if (next() !== ")") throw new Error(`an unclosed parenthesis: ${tokens.join(" ")}`);
      return v;
    }
    if (t === "min(" || t === "max(") {
      const ivs = lengths(args(), t.slice(0, 3));
      const pick = t === "min(" ? Math.min : Math.max;
      return span(pick(...ivs.map((x) => x[0])), pick(...ivs.map((x) => x[1])));
    }
    if (t === "clamp(") {
      const ivs = lengths(args(), "clamp");
      if (ivs.length !== 3) throw new Error(`clamp() takes three values: ${tokens.join(" ")}`);
      const [a, b, c] = ivs;
      return span(Math.max(a[0], Math.min(b[0], c[0])), Math.max(a[1], Math.min(b[1], c[1])));
    }
    const num = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-zA-Z%]*)$/.exec(t);
    if (num !== null) return dimension(parseFloat(num[1]), num[2].toLowerCase());
    throw new Error(`a term the guard cannot evaluate: ${t}`);
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`a value the guard cannot evaluate: ${tokens.join(" ")}`);
  return v;
}

/** The font size a value gives, in px, under a root of `root` px — the parent at
 *  any size, since a field sits anywhere: `em`, `%`, `inherit` and `unset` follow
 *  it down to nothing. Throws on what it cannot evaluate. */
function fontSizeRange(raw: string, root: number, model: CssModel = CSS): Interval {
  const value = substituteVars(raw.trim(), model);
  const word = value.toLowerCase();
  if (word === "inherit" || word === "unset" || word === "smaller" || word === "larger") return [0, Infinity];
  if (word === "initial") return [16, 16];
  if (word in ABSOLUTE_SIZES) return [ABSOLUTE_SIZES[word], ABSOLUTE_SIZES[word]];
  if (/^[a-z-]+$/.test(word)) throw new Error(`a keyword the guard cannot evaluate: ${value}`);
  const v = evaluate(tokenize(value), root);
  if (v.kind === "length") return v.iv;
  if (v.n === 0) return [0, 0];
  throw new Error(`a number is no font size: ${value}`);
}

const FONT_PREFIX = /^(normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|1000|(ultra-|extra-|semi-)?(condensed|expanded))$/i;

/** The size inside a `font` shorthand (`italic 600 0.875rem/1.4 sans-serif` →
 *  `0.875rem`), or the CSS-wide keyword it is. A system font, or a `var()` before
 *  the size (it may hold any part), cannot be split: it throws. */
function shorthandSize(value: string): string {
  const v = value.trim();
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(v)) return v.toLowerCase();
  if (/^(caption|icon|menu|message-box|small-caption|status-bar|-apple-system[\w-]*|-webkit-[\w-]+)$/i.test(v)) {
    throw new Error(`a system font, of a size the guard cannot know: ${v}`);
  }
  for (const word of splitTop(v.replace(/\s*\/\s*/g, "/"), " ").filter(Boolean)) {
    if (FONT_PREFIX.test(word)) continue;
    if (/var\(/i.test(word)) throw new Error(`a font shorthand through var() the guard cannot split: ${v}`);
    return splitTop(word, "/")[0];
  }
  throw new Error(`a font shorthand without a size: ${v}`);
}

/** The size a declaration sets, as a value `fontSizeRange` reads. */
function declaredSize(d: Decl): string {
  if (d.prop === "font") return shorthandSize(d.value);
  return d.value; // font-size, or `all` (a CSS-wide keyword)
}

// ---- The cascade of one field ---------------------------------------------------

/** The text scales: each one's root size in px — the inline font-size useFontScale
 *  sets on <html>. */
const SCALES: Array<[FontScale, number]> = FONT_SCALES.map((s) => [
  s,
  FONT_SCALE_CSS[s] === "" ? 16 : (16 * parseFloat(FONT_SCALE_CSS[s])) / 100,
]);

/** A media list every touch device meets: one of its alternatives is
 *  `(any-pointer: coarse)` — a phone, a tablet, a tablet with a trackpad. */
const onEveryTouchDevice = (media: string[]) =>
  media.every((m) => splitList(m).some((alt) => /^\(any-pointer:\s*coarse\)$/.test(alt)));

/** The last compound of a selector part: what it styles. */
function subjectOf(part: string): string {
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return part.slice(start).trim();
}

/** Could the selector reach the field? Its subject (last compound) is read: its tag
 *  and — for a normal declaration — its classes; an attribute or a state is taken
 *  as met. An important declaration is matched on the tag alone: a wrapper may
 *  pass any class to a field. A pseudo-element is not the field. */
function mayReach(part: string, field: Field, important: boolean): boolean {
  const subject = subjectOf(part);
  if (/::|:(before|after|placeholder|first-line|first-letter|selection|marker|backdrop)\b/i.test(subject)) return false;
  let base = subject;
  for (let guard = 0; /:(where|is|not|has)\(/.test(base) && guard < 20; guard++) {
    base = base.replace(/:(where|is|not|has)\([^()]*\)/g, "");
  }
  base = base.replace(/\[[^\]]*\]/g, "").replace(/:[\w-]+(\([^()]*\))?/g, "");
  const tag = /^[a-zA-Z][\w-]*/.exec(base)?.[0]?.toLowerCase();
  if (tag !== undefined && tag !== field.element) return false;
  if (important) return true;
  const classes = [...base.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  return classes.every((c) => field.classes.includes(c));
}

/** Does the selector part reach the field whatever its place, its classes and its
 *  state? Its tag (or `[contenteditable]`) and type exclusions only, no combinator. */
function surelyReaches(part: string, field: Field): boolean {
  const p = part.trim();
  const wrap = /^:(where|is)\(([\s\S]*)\)$/.exec(p);
  if (wrap !== null) return splitList(wrap[2]).some((q) => surelyReaches(q, field));
  if (field.editable) return /^\[contenteditable\](:not\(\[contenteditable="false"\]\))?$/.test(p);
  const m = /^([a-z]+)(?::not\(((?:\[type="[\w-]+"\],?\s*)+)\))?$/.exec(p);
  if (m === null || m[1] !== field.element) return false;
  if (m[2] === undefined) return true;
  const excluded = [...m[2].matchAll(/\[type="([\w-]+)"\]/g)].map((x) => x[1]);
  return field.type === null || !excluded.includes(field.type);
}

type Candidate = Decl & { spec: Spec; sure: boolean };

/** Does `a` beat `b` in the cascade? true, false — or null when only the order
 *  of two files could tell. Importance, then the style attribute, then layers (an
 *  important declaration in an earlier layer wins, one in no layer loses), then
 *  specificity, then the order within a file. */
function beats(a: Candidate, b: Candidate, layers: string[]): boolean | null {
  if (a.important !== b.important) return a.important;
  if (Boolean(a.inline) !== Boolean(b.inline)) return Boolean(a.inline);
  if ((a.layer ?? "").includes(".") || (b.layer ?? "").includes(".")) throw new Error(`a nested layer: ${a.layer ?? b.layer}`);
  const la = a.layer === null ? -1 : layers.indexOf(a.layer);
  const lb = b.layer === null ? -1 : layers.indexOf(b.layer);
  if (la !== lb) {
    if (a.important) return la !== -1 && (lb === -1 || la < lb);
    return la === -1 || (lb !== -1 && la > lb);
  }
  for (let k = 0; k < 3; k++) if (a.spec[k] !== b.spec[k]) return a.spec[k] > b.spec[k];
  if (a.file === b.file) return a.order > b.order;
  return null;
}

/** The declarations of a size that can reach the field where touch is used — every
 *  stylesheet's (print aside), the Tailwind classes it carries, its style
 *  attribute — each marked `sure` when it reaches the field whatever its place. */
function candidatesFor(field: Field, model: CssModel, floorImportant = true): Candidate[] {
  const out: Candidate[] = [];
  for (const d of model.decls) {
    if (d.media.some((m) => /^\s*print\s*$/i.test(m))) continue;
    const reach = splitList(d.selector).filter((p) => mayReach(p, field, d.important));
    if (reach.length === 0) continue;
    const sureParts = onEveryTouchDevice(d.media) ? splitList(d.selector).filter((p) => surelyReaches(p, field)) : [];
    const sure = sureParts.length > 0;
    // The weight of the heaviest part that reaches it — for a sure declaration, of
    // a part sure to: the least it weighs wherever the field sits.
    const spec = (sure ? sureParts : reach).map(specificity).sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0];
    out.push({ ...d, important: d.important && (floorImportant || !sure), spec, sure });
  }
  for (const token of field.classes) {
    const u = textUtility(token, model);
    if (u === null) continue;
    out.push({ prop: "font-size", value: u.value, important: u.important, selector: `.${token}`, media: u.media, layer: "utilities", file: "(tailwind)", order: 0, spec: u.spec, sure: false });
  }
  if (field.inlineFont !== null) {
    out.push({ prop: "font-size", value: field.inlineFont, important: false, inline: true, selector: "[style]", media: [], layer: null, file: field.at, order: 0, spec: [0, 0, 0], sure: false });
  }
  return out;
}

/** The declarations that can win the field's cascade: all but those a declaration
 *  that surely reaches it beats. With none sure, the field may get no declaration
 *  at all and inherit its size. */
function contenders(field: Field, model: CssModel, floorImportant = true): { won: Candidate[]; inherits: boolean } {
  const cands = candidatesFor(field, model, floorImportant);
  const sure = cands.filter((c) => c.sure);
  const won = cands.filter((d) => !sure.some((c) => c !== d && beats(c, d, model.layers) === true));
  return { won, inherits: sure.length === 0 };
}

const px = (n: number) => (n === Infinity ? "∞" : n === -Infinity ? "-∞" : `${Math.round(n * 100) / 100}px`);

/** Every field under 16 px in some scale, with the declaration that can put it there. */
function fieldsUnder16(fields: Field[], model: CssModel, floorImportant = true): string[] {
  const offenders: string[] = [];
  for (const field of fields) {
    const { won, inherits } = contenders(field, model, floorImportant);
    const where = `${field.at} <${field.element}${field.classes.length ? ` class="${field.classes.filter((c) => c.startsWith("oc-")).join(" ")}"` : ""}>`;
    if (inherits) offenders.push(`${where}: no declaration surely reaches it — it inherits a size from anywhere`);
    for (const w of won) {
      const decl = `${w.selector.replace(/\s+/g, " ").slice(0, 90)} { ${w.prop}: ${w.value}${w.important ? " !important" : ""} }`;
      for (const [scaleName, root] of SCALES) {
        let range: Interval;
        try {
          range = fontSizeRange(declaredSize(w), root, model);
        } catch (e) {
          offenders.push(`${where}: ${decl} — ${(e as Error).message}`);
          break;
        }
        if (range[0] < 16) offenders.push(`${where} at ${scaleName}: ${decl} → ${px(range[0])} to ${px(range[1])}`);
      }
    }
  }
  return offenders;
}

describe("fields at 16 px where touch is used, under every text scale (G4; lots 19, 20)", () => {
  const FIELDS = fieldInventory();
  // The floor: an important size, in no layer, in a media query every touch device meets.
  const floors = CSS.decls.filter(
    (d) => d.prop === "font-size" && d.important && d.layer === null && d.media.length > 0 && onEveryTouchDevice(d.media),
  );

  test("the parser reads every stylesheet whole: each declaration bearing on a size is met", () => {
    const files = [...CSS.seen.keys()];
    expect(files.some((f) => f.endsWith(join("tailwindcss", "index.css")))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(walk(SRC, ".css").length + 3);
    for (const file of files) {
      expect(CSS.seen.get(file), file).toBe(countSizes(stripComments(readFileSync(file, "utf-8"))));
    }
    // The pattern: a glob's `/*` inside a string opens no comment.
    expect(stripComments('@source "a/*.js"; b { font-size: 1px } /* c */')).toBe('@source "a/*.js"; b { font-size: 1px }  ');
  });

  test("the six text scales, read from useFontScale: a root of 14 to 24 px", () => {
    expect(SCALES).toEqual([["sm", 14], ["md", 16], ["lg", 18], ["xl", 20], ["2xl", 22], ["3xl", 24]]);
  });

  test("the floor: important, on every touch device, on every kind of text field — 16 px at least under each scale", () => {
    expect(floors.length, "no important font-size floor under touch").toBeGreaterThan(0);
    for (const field of BARE_FIELDS) {
      expect(floors.some((f) => splitList(f.selector).some((p) => surelyReaches(p, field))), `the floor misses ${field.at}`).toBe(true);
    }
    for (const f of floors) {
      for (const [scaleName, root] of SCALES) {
        expect(fontSizeRange(f.value, root)[0], `${f.selector.slice(0, 40)} at ${scaleName}`).toBeGreaterThanOrEqual(16);
      }
    }
  });

  test("the fields are read from the syntax tree, every one — the search field and the room picker's among them", () => {
    expect(FIELDS.length).toBeGreaterThan(80);
    expect(FIELDS.some((f) => f.classes.includes("oc-search-palette__field"))).toBe(true);
    expect(FIELDS.some((f) => f.at.startsWith(join("chat", "ConvexChat.tsx")) && f.element === "input" && f.classes.length === 0)).toBe(true);
    expect(FIELDS.find((f) => f.tag === "Input")?.classes).toContain("md:text-sm");
  });

  test("under each scale, every declaration that can win a field's cascade gives it 16 px or more", () => {
    expect(fieldsUnder16([...FIELDS, ...BARE_FIELDS], CSS)).toEqual([]);
  });

  test("the computation sees the pattern: without its importance the floor loses — to `font: inherit`, to a rem under a small scale", () => {
    const lost = fieldsUnder16(FIELDS, CSS, false).join("\n");
    // The room picker's two searches, inheriting their popover's size.
    expect(lost).toMatch(/ConvexChat\.tsx:\d+ <input>.*\.oc-agentlist__search input \{ font: inherit( !important)? \}/);
    // The composer and the held-dictation dock, inheriting theirs.
    expect(lost).toMatch(/class="oc-composer__input">.*\.oc-composer__input \{ font: inherit( !important)? \}/);
    expect(lost).toMatch(/class="oc-detach__input">.*\.oc-detach__input \{ font: inherit( !important)? \}/);
    // The full-page composer: 1.02rem is 14.28 px under "sm", and only there.
    expect(lost).toMatch(/at sm: \.oc-composer--expanded \.oc-composer__input \{ font-size: 1\.02rem( !important)? \} → 14\.28px/);
    expect(lost).not.toMatch(/at md: \.oc-composer--expanded \.oc-composer__input/);
  });

  test("the evaluator reads every shape a size takes — and fails on what it cannot read", () => {
    const at = (v: string, root = 16) => fontSizeRange(v, root);
    expect(at("max(16px, 1em)", 14)).toEqual([16, Infinity]);
    expect(at("1.02rem", 14)[0]).toBeCloseTo(14.28);
    expect(at("inherit")).toEqual([0, Infinity]);
    expect(at("unset")).toEqual([0, Infinity]);
    expect(at("initial")).toEqual([16, 16]);
    expect(at("0.875em")).toEqual([0, Infinity]);
    expect(at("110%")).toEqual([0, Infinity]);
    expect(at("calc(1rem - 2px)", 18)).toEqual([16, 16]);
    expect(at("calc((1rem + 4px) / 2)", 20)).toEqual([12, 12]);
    expect(at("min(1rem, 15px)", 24)).toEqual([15, 15]);
    expect(at("clamp(0.875rem, 1em, 1.25rem)")).toEqual([14, 20]);
    expect(at("var(--text-sm)")).toEqual([14, 14]);
    expect(at("var(--oc-no-such-token, 1.125rem)")).toEqual([18, 18]);
    expect(at("12pt")).toEqual([16, 16]);
    expect(at("small")).toEqual([13, 13]);
    expect(at("smaller")).toEqual([0, Infinity]);
    expect(at("calc(1rem - 1em)")[0]).toBe(-Infinity);
    for (const unknown of ["2vw", "clamp(14px, 4vw, 18px)", "revert", "revert-layer", "var(--oc-no-such-token)", "1ch", "env(safe-area-inset-top)", "round(1.1rem, 1px)"]) {
      expect(() => at(unknown), unknown).toThrow();
    }
    expect(shorthandSize("italic 600 0.875rem/1.4 var(--font-sans)")).toBe("0.875rem");
    expect(shorthandSize("bold 12px / 1 sans-serif")).toBe("12px");
    expect(shorthandSize("inherit")).toBe("inherit");
    expect(shorthandSize("calc(1rem - 1px)/1.5 serif")).toBe("calc(1rem - 1px)");
    for (const unknown of ["var(--font)", "caption", "-apple-system-body"]) expect(() => shorthandSize(unknown), unknown).toThrow();
    expect(textUtility("text-sm!", CSS)).toMatchObject({ value: "var(--text-sm)", important: true, media: [] });
    expect(textUtility("md:!text-xs", CSS)).toMatchObject({ value: "var(--text-xs)", important: true, media: ["(min-width: 48rem)"] });
    expect(textUtility("text-[13px]", CSS)).toMatchObject({ value: "13px", important: false });
    expect(textUtility("text-foreground", CSS)).toBeNull();
    expect(textUtility("file:text-sm", CSS)).toBeNull();
  });

  test("the cascade is computed as the browser computes it", () => {
    const decl = (over: Partial<Candidate>): Candidate => ({
      prop: "font-size", value: "1rem", important: false, selector: "x", media: [], layer: null, file: "a.css", order: 0, spec: [0, 0, 1], sure: false, ...over,
    });
    const layers = ["theme", "base", "components", "utilities"];
    // Importance first, whatever the weight.
    expect(beats(decl({ important: true, spec: [0, 0, 0] }), decl({ spec: [1, 0, 0] }), layers)).toBe(true);
    // Normal: no layer beats a layer, a later layer an earlier one.
    expect(beats(decl({}), decl({ layer: "utilities", spec: [0, 5, 0] }), layers)).toBe(true);
    expect(beats(decl({ layer: "utilities" }), decl({ layer: "base", spec: [0, 5, 0] }), layers)).toBe(true);
    // Important: reversed — a layer beats no layer, an earlier layer a later one.
    expect(beats(decl({ important: true, layer: "utilities" }), decl({ important: true, spec: [0, 5, 0] }), layers)).toBe(true);
    expect(beats(decl({ important: true, layer: "base" }), decl({ important: true, layer: "utilities" }), layers)).toBe(true);
    // The style attribute beats a rule of the same importance, not an important one.
    expect(beats(decl({ inline: true }), decl({ spec: [1, 0, 0] }), layers)).toBe(true);
    expect(beats(decl({ inline: true }), decl({ important: true }), layers)).toBe(false);
    // Same weight: the order within a file decides; across files, nothing can.
    expect(beats(decl({ order: 2 }), decl({ order: 1 }), layers)).toBe(true);
    expect(beats(decl({ file: "b.css" }), decl({}), layers)).toBeNull();
    expect(CSS.layers.slice(0, 4)).toEqual(layers);
  });

  test("nothing scales a field's text behind its size: no CSS zoom, no text-size-adjust but 100 %", () => {
    // iOS decides on the size it draws: a zoom on the field or an ancestor shrinks
    // it whatever its font-size; Tailwind's preflight holds text-size-adjust at 100 %.
    const scaled = CSS.scaling
      .filter((d) => (d.prop === "zoom" ? !/^(1|normal|reset|100%)$/i.test(d.value) : !/^(100%|none|auto)$/i.test(d.value)))
      .map((d) => `${d.file}: ${d.selector} { ${d.prop}: ${d.value} }`);
    expect(scaled).toEqual([]);
    expect(CSS.scaling.some((d) => d.prop === "-webkit-text-size-adjust" && d.value === "100%")).toBe(true);
  });

  test("no field sets its font size inline", () => {
    expect(FIELDS.filter((f) => f.inlineFont !== null).map((f) => `${f.at}: ${f.inlineFont}`)).toEqual([]);
  });

  test("nothing outside the stylesheets can carry an important size: no `!` text class, no priority or style set from a script, no injected sheet, no inline zoom", () => {
    const found: string[] = [];
    for (const file of [...walk(SRC, ".tsx"), ...walk(SRC, ".ts")]) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const where = (n: ts.Node) => `${file.slice(SRC.length + 1)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
      const visit = (n: ts.Node) => {
        if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
          for (const token of n.text.split(/\s+/).filter(Boolean)) {
            if (textUtility(token, CSS)?.important) found.push(`${where(n)}: ${token}`);
          }
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const name = n.expression.name.text;
          if ((name === "setProperty" && n.arguments.length > 2) || name === "insertRule" || name === "replaceSync") found.push(`${where(n)}: ${n.getText(sf).slice(0, 80)}`);
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["setAttribute", "createElement"].includes(n.expression.name.text)) {
          const first = n.arguments[0];
          if (first !== undefined && ts.isStringLiteralLike(first) && first.text.toLowerCase() === "style") found.push(`${where(n)}: ${n.getText(sf).slice(0, 80)}`);
        }
        if (ts.isPropertyAccessExpression(n) && ["cssText", "adoptedStyleSheets", "zoom"].includes(n.name.text)) found.push(`${where(n)}: ${n.getText(sf)}`);
        if (ts.isJsxAttribute(n) && n.name.getText(sf) === "style" && /\bzoom\s*:/.test(n.initializer?.getText(sf) ?? "")) found.push(`${where(n)}: an inline zoom`);
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "style") found.push(`${where(n)}: <style>`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });
});


describe("no text under 12 px (C2), glyphs in a fixed shape excepted", () => {
  // Initials in a fixed circle, a count in a fixed bubble, a page number on a
  // thumbnail, the dev-only switch: the shape sets their size, not the scale.
  const GLYPHS = new Set([
    ".oc-avatar",
    ".oc-avatar--more",
    ".oc-participants__row .oc-avatar",
    ".oc-presence__face .oc-avatar",
    ".oc-convpanel__member .oc-avatar",
    ".oc-convpicker__row .oc-avatar",
    ".oc-agentrow--person .oc-avatar",
    ".oc-msg__avatar",
    ".oc-bell__badge",
    ".oc-access__tabcount",
    ".oc-docviewer__thumbnum",
    ".oc-devfab",
  ]);

  test("every stylesheet: font sizes are 12 px or more", () => {
    const small = ALL_RULES.filter((r) => {
      const px = fontPx(r.body);
      return px !== null && px < 12 && !GLYPHS.has(r.selector.replace(/\s+/g, " "));
    }).map((r) => `${r.selector.replace(/\s+/g, " ").slice(0, 60)} ${fontPx(r.body)}px`);
    expect(small).toEqual([]);
  });
});

describe("targets for a finger (G3)", () => {
  test("menu and list items are 44 px tall on a coarse pointer", () => {
    const rule = ALL_RULES.find(
      (r) => r.media === "(pointer: coarse)" && /min-height:\s*2\.75rem/.test(r.body) && r.selector.includes('[data-slot="dropdown-menu-item"]'),
    );
    expect(rule, "no coarse-pointer rule for menu items").toBeDefined();
    for (const s of ['[data-slot="select-item"]', '[role="menuitem"]', '[role="option"]']) {
      expect(rule!.selector).toContain(s);
    }
  });

  test("the shared Button's tap zone grows where touch is used, at no weight", () => {
    const zone = ALL_RULES.find(
      (r) => isTouch(r.media) && r.selector.includes("[data-variant][data-size]::after"),
    );
    expect(zone, "the shared Button has no tap zone").toBeDefined();
    expect(zone!.body).toMatch(/var\(--oc-hit-w, 2\.75rem\)/);
    expect(zone!.body).toMatch(/var\(--oc-hit-h, 2\.75rem\)/);
    const relative = ALL_RULES.find(
      (r) => isTouch(r.media) && r.selector.startsWith(":where(") && r.selector.includes("[data-variant][data-size]"),
    );
    expect(relative?.body).toMatch(/position:\s*relative/);
  });

  // The zone needs its control positioned, but a Button placed by a Tailwind
  // utility must stay placed: utilities live in a cascade layer, and ANY unlayered
  // rule beats them whatever its weight — the first version of this rule dropped
  // every dialog's and sheet's close button (`absolute top-3 right-3`) into the flow.
  test("the derivation sees the pattern: shared Buttons placed by a utility exist", () => {
    const placed = TSX.flatMap((src) =>
      [...src.matchAll(/<Button\b[^>]*?className="([^"]*\b(?:absolute|fixed|sticky)\b[^"]*)"/gs)].map(
        (m) => m[1],
      ),
    );
    expect(placed).toContain("absolute top-3 right-3");
  });

  test("so the zone's `position: relative` sits in a layer below the utilities", () => {
    const relative = ALL_RULES.find(
      (r) => isTouch(r.media) && r.selector.startsWith(":where(") && r.selector.includes("[data-variant][data-size]"),
    );
    expect(relative?.layer, "unlayered, it overrides `absolute` on the close buttons").toBe("base");
  });
});

describe("keyboard hints hidden where the primary pointer is a finger (C1)", () => {
  // `(pointer: coarse)`, the PRIMARY pointer: a laptop whose touch screen is a second
  // input keeps its hints (`any-pointer` would hide them there too).
  const hidden = ALL_RULES.filter(
    (r) => r.media === "(pointer: coarse)" && /display:\s*none/.test(r.body),
  ).flatMap((r) => r.selector.split(",").map((sel) => sel.trim()));
  const hides = (cls: string) => hidden.some((sel) => sel.startsWith(`.${cls}`));

  test("every <kbd> hint the sources render is hidden, by its own class", () => {
    const kbds = TSX.flatMap((src) =>
      [...src.matchAll(/<kbd\s+className="([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]),
    );
    expect(kbds).toContain("oc-newchat__kbd");
    expect(kbds).toContain("oc-search-trigger__kbd");
    expect(kbds.filter((c) => !hides(c))).toEqual([]);
  });

  test("so are the hints held in a container: the palette's footer, the menu's digits", () => {
    for (const c of ["oc-search-palette__footer", "oc-perm__shortcut"]) {
      expect(hides(c), c).toBe(true);
    }
  });

  // Decided 2026-11 (lot 7): no reordering of the Settings tabs by finger.
  test("the Settings tabs' reorder grips go the same way", () => {
    expect(hides("oc-settings-tabs__grip")).toBe(true);
  });
});

describe("the sidebar's rows a finger's height (lot 10)", () => {
  // Decided 2026-11: chat rows (36 px) and folder heads (24 px) at 44 px where the
  // PRIMARY pointer is a finger; a mouse, and a touch-screen laptop, keep them dense.
  const coarse = (sel: string) =>
    ALL_RULES.filter((r) => r.media === "(pointer: coarse)" && r.selector === sel);
  const anyMedia = (sel: string, re: RegExp) =>
    ALL_RULES.filter((r) => r.selector === sel && re.test(r.body)).map((r) => r.media);

  test("a chat row is 44 px tall and its controls' zones 44 px with it", () => {
    const body = coarse(".oc-chatitem").map((r) => r.body).join("\n");
    expect(body).toMatch(/min-height:\s*2\.75rem/);
    expect(body).toMatch(/--oc-hit-h:\s*2\.75rem/);
  });

  test("a folder's head too", () => {
    const body = coarse(".oc-sidebar__group-head").map((r) => r.body).join("\n");
    expect(body).toMatch(/(?<![-\w])height:\s*2\.75rem/);
    expect(body).toMatch(/--oc-hit-h:\s*2\.75rem/);
  });

  test("only where the primary pointer is a finger: a mouse keeps 24 px heads", () => {
    expect(anyMedia(".oc-chatitem", /min-height:\s*2\.75rem/)).toEqual(["(pointer: coarse)"]);
    expect(anyMedia(".oc-sidebar__group-head", /(?<![-\w])height:\s*2\.75rem/)).toEqual([
      "(pointer: coarse)",
    ]);
    expect(anyMedia(".oc-sidebar__group-head", /(?<![-\w])height:\s*1\.5rem/)).toContain(null);
  });

  test("a touch-screen laptop keeps dense rows, so its zones keep to them", () => {
    const touch = (sel: string) =>
      ALL_RULES.filter((r) => isTouch(r.media) && r.media !== "(pointer: coarse)" && r.selector === sel)
        .map((r) => r.body)
        .join("\n");
    expect(touch(".oc-chatitem")).toMatch(/--oc-hit-h:\s*2\.25rem/);
    expect(touch(".oc-sidebar__group-head")).toMatch(/--oc-hit-h:\s*1\.5rem/);
  });
});
