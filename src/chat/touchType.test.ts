/// <reference types="vite/client" />
//
// Lot 7 (2026-11): type and targets for a finger. Each rule here is DERIVED from the
// sources, so a stylesheet or a component added tomorrow is held to it too.
//
// 1. Fields at 16 px where touch is used — below that, iOS and iPadOS zoom the page
//    on focus. Every class a component puts on an <input>, <textarea> or <select>
//    and styles below 16 px must be raised by the touch rule.
// 2. No text under 12 px (the qualifier size of the 14/12 scale), except glyphs set
//    in a fixed shape (initials in a circle, a count in a bubble).
// 3. Menu and list items a finger's height on a coarse pointer; the shared Button's
//    tap zone grown like `.oc-hit`'s — without moving a Button placed by a utility.
// 4. Keyboard hints hidden where the primary pointer is a finger (lot 9, C1).
// 5. The sidebar's rows a finger's height where the primary pointer is a finger
//    (lot 10), their zones grown with them; dense under a mouse.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

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

function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
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

// ---- FIELDS (G4; lot 19) ------------------------------------------------------
//
// Lot 19: the search palette's field (15.2 px) was missed — the inventory read the
// fields with a regex that stopped at the `>` of `=>` in `onChange={(e) => …}`,
// before the className. The fields are now found by the TypeScript syntax tree,
// every one, their classes read from literals, constants, conditions, `cn()`
// arguments and template parts (a className the guard cannot read fails it), and
// each field gets the cascade computed: under touch, every rule that styles it
// under 16 px must lose to the floor.

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

type Field = { at: string; element: string; classes: string[]; inlineFont: string | null };

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
        const type = attr("type")?.initializer;
        const element = FIELD_TAGS[n.tagName.getText(sf)];
        if (!(element === "input" && type !== undefined && ts.isStringLiteralLike(type) && NOT_TEXT.has(type.text))) {
          const classes = strings(attr("className")?.initializer, at).join(" ").split(/\s+/).filter(Boolean);
          const style = attr("style")?.initializer?.getText(sf) ?? "";
          out.push({ at, element, classes: [...new Set(classes)], inlineFont: /fontSize/.test(style) ? style : null });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The comma-separated parts of a selector list, parentheses kept whole. */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of list) {
    if (ch === "," && depth === 0) {
      out.push(part.trim());
      part = "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    part += ch;
  }
  if (part.trim() !== "") out.push(part.trim());
  return out;
}

/** A selector's specificity [ids, classes/attributes/pseudo-classes, elements];
 *  `:where()` counts nothing, `:not()`/`:is()`/`:has()` their heaviest argument. */
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
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
  rest = rest.replace(/\.[\w-]+/g, () => (total[1]++, " "));
  rest = rest.replace(/:[\w-]+/g, () => (total[1]++, " "));
  for (const m of rest.matchAll(/(^|[\s>+~])([a-zA-Z][\w-]*)/g)) if (m[2] !== "") total[2]++;
  return total;
}
const heavier = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/** Could the selector's subject (its last compound) be `field`? Its tag and its
 *  classes are read; an attribute or a pseudo-class is taken as matching. */
function subjectMatches(selector: string, field: Field): boolean {
  const subject = selector.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? "";
  const base = subject.replace(/:(where|not|is)\([^()]*\)/g, "").replace(/\[[^\]]*\]/g, "").replace(/::?[\w-]+/g, "");
  const tag = /^[a-zA-Z][\w-]*/.exec(base)?.[0];
  if (tag !== undefined && tag !== field.element) return false;
  const classes = [...base.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (tag === undefined && classes.length === 0) return false;
  return classes.every((c) => field.classes.includes(c));
}

/** A font size under 16 px: px and rem below 16, a relative size below 1. */
function smallFont(body: string): string | null {
  const m = /font-size:\s*([^;]+)/.exec(body);
  if (m === null) return null;
  const value = m[1].trim();
  const px = /^([0-9.]+)(px|rem)$/.exec(value);
  if (px !== null) return parseFloat(px[1]) * (px[2] === "rem" ? 16 : 1) < 16 ? value : null;
  const rel = /^([0-9.]+)(em|%)$/.exec(value);
  if (rel !== null) return parseFloat(rel[1]) / (rel[2] === "%" ? 100 : 1) < 1 ? value : null;
  return /^(smaller|x-small|small|xx-small)$/.test(value) ? value : null;
}

/** A rule that cannot apply where a finger is the pointer. */
const fineOnly = (media: string | null) => media !== null && /\(hover:\s*hover\)|\(pointer:\s*fine\)/.test(media) && !/coarse|hover:\s*none/.test(media);

describe("fields at 16 px where touch is used (G4; lot 19)", () => {
  const FIELDS = fieldInventory();
  const touchRule = ALL_RULES.find((r) => isTouch(r.media) && /font-size:\s*max\(16px,\s*1em\)/.test(r.body));
  const raises = touchRule === undefined ? [] : splitList(touchRule.selector);

  test("the touch rule raises every text field, at no weight of its own", () => {
    expect(touchRule, "no 16 px touch rule").toBeDefined();
    expect(touchRule!.selector).toContain(":where(");
    for (const el of ["input:not(", "textarea", "select"]) {
      expect(touchRule!.selector).toContain(el);
    }
  });

  test("the fields are read from the syntax tree, every one — the search field among them", () => {
    expect(FIELDS.length).toBeGreaterThan(80);
    expect(FIELDS.map((f) => f.classes.join(" "))).toContain("oc-search-palette__field");
  });

  test("under touch, every rule that styles a field under 16 px loses to the floor", () => {
    const offenders: string[] = [];
    for (const field of FIELDS) {
      for (const rule of ALL_RULES) {
        if (rule.layer !== null || fineOnly(rule.media) || rule === touchRule) continue;
        const size = smallFont(rule.body);
        if (size === null) continue;
        for (const sel of splitList(rule.selector)) {
          if (!subjectMatches(sel, field)) continue;
          const beaten = raises.some((raise) => subjectMatches(raise, field) && heavier(specificity(raise), specificity(sel)));
          if (!beaten) offenders.push(`${field.at} <${field.element} class="${field.classes.join(" ")}">: ${sel} { font-size: ${size} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no field sets its font size inline", () => {
    expect(FIELDS.filter((f) => f.inlineFont !== null).map((f) => `${f.at}: ${f.inlineFont}`)).toEqual([]);
  });

  test("the computation sees the pattern: the fields styled small are found, each raised by a heavier selector", () => {
    const small = new Set<string>();
    for (const field of FIELDS) {
      for (const rule of ALL_RULES) {
        if (rule.layer !== null || fineOnly(rule.media) || rule === touchRule || smallFont(rule.body) === null) continue;
        if (splitList(rule.selector).some((sel) => subjectMatches(sel, field))) field.classes.forEach((c) => small.add(c));
      }
    }
    for (const c of ["oc-injcard__text", "oc-areq__input", "oc-search-palette__field"]) expect([...small]).toContain(c);
    expect(specificity(".oc-search-palette__field.oc-search-palette__field")).toEqual([0, 2, 0]);
    expect(specificity(':where(input:not([type="checkbox"]), textarea)')).toEqual([0, 0, 0]);
    expect(specificity('[data-slot="dialog-content"].oc-afiles__editor')).toEqual([0, 2, 0]);
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
