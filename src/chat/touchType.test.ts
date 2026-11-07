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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

describe("fields at 16 px where touch is used (G4)", () => {
  /** The class lists components put on their fields, one per field. */
  function fields(): string[][] {
    const out: string[][] = [];
    for (const src of TSX) {
      for (const m of src.matchAll(/<(input|textarea|select)\b([^>]*?)>/gs)) {
        const cls = m[2].match(/className=\{?["`]([^"`]+)["`]/);
        const list = (cls?.[1].split(/\s+/) ?? []).filter((c) => c.startsWith("oc-"));
        if (list.length > 0) out.push(list);
      }
    }
    return out;
  }
  const styledSmall = (c: string) =>
    ALL_RULES.some(
      (r) =>
        r.media === null &&
        r.selector.split(",").some((s) => s.trim().split(/\s+/).pop()!.startsWith(`.${c}`)) &&
        (fontPx(r.body) ?? 99) < 16,
    );

  const touchRule = ALL_RULES.find(
    (r) => isTouch(r.media) && /font-size:\s*max\(16px,\s*1em\)/.test(r.body),
  );

  test("the touch rule raises every text field, at no weight of its own", () => {
    expect(touchRule, "no 16 px touch rule").toBeDefined();
    expect(touchRule!.selector).toContain(":where(");
    for (const el of ["input:not(", "textarea", "select"]) {
      expect(touchRule!.selector).toContain(el);
    }
  });

  test("the derivation sees the pattern: fields styled under 16 px exist", () => {
    const small = fields().filter((list) => list.some(styledSmall)).flat();
    expect(small).toContain("oc-injcard__text");
    expect(small).toContain("oc-areq__input");
  });

  test("every field styled under 16 px is raised, by one of its classes", () => {
    const missing = fields()
      .filter((list) => list.some(styledSmall))
      .filter((list) => !list.some((c) => touchRule!.selector.includes(`.${c}.${c}`)))
      .map((list) => list.join(" "));
    expect(missing).toEqual([]);
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
