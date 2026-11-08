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

  // Lot 11: the full-page prompt's lift sat BEFORE a `margin: 0` in its own rule,
  // which zeroed it — the panel shrank but stayed centred on the whole screen, its
  // action bar under the keyboard. A lift counts only if nothing after it resets it.
  test("every lift by the keyboard survives its rule: no margin reset after it", () => {
    const lifts = [...CSS.matchAll(/([^{}]+)\{([^{}]*margin-top:\s*calc\(var\(--oc-kb[^{}]*)\}/g)];
    expect(lifts.map((m) => m[1].trim())).toEqual(
      expect.arrayContaining(['[data-slot="dialog-content"]:not(.oc-search-palette)', ".oc-composer--expanded"]),
    );
    for (const [, selector, body] of lifts) {
      const after = body.slice(body.lastIndexOf("margin-top: calc(var(--oc-kb"));
      expect(after, selector.trim()).not.toMatch(/(^|[;\s])margin(-top)?\s*:(?!\s*calc\(var\(--oc-kb)/);
    }
  });

  test("…nor in a later rule for the same selector", () => {
    const later = [...CSS.matchAll(/\.oc-composer--expanded\s*\{([^{}]*)\}/g)].slice(1);
    for (const [, body] of later) expect(body).not.toMatch(/(^|[;\s])margin(-top)?\s*:/);
  });

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
