/// <reference types="vite/client" />
//
// The shared overlays honor `prefers-reduced-motion` (2026-11).
//
// THE DEFECT. Their enter/exit animations come from tw-animate-css, which knows
// nothing of the setting: the navigation drawer moved onto the shared Sheet and
// started sliding again for readers who had asked for less motion, where the
// hand-made drawer it replaced had stopped. The fix is one rule in convexChat.css,
// keyed on the `data-slot` attributes like the overlay layer rule above it.
//
// THE LIST IS DERIVED, not typed: every content and overlay slot of a component in
// `src/components/ui/**` that ships an enter/exit animation must be covered, so a
// component added or regenerated tomorrow cannot quietly bring the motion back.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const UI_DIR = join(process.cwd(), "src/components/ui");
const CSS = readFileSync(join(process.cwd(), "src/chat/convexChat.css"), "utf-8");

/** The content and overlay slots of every animated shared component. */
function animatedSlots(): string[] {
  const slots = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      const src = readFileSync(full, "utf-8");
      if (!/\banimate-(in|out)\b/.test(src)) continue;
      for (const m of src.matchAll(/data-slot="([a-z-]+-(?:content|overlay))"/g)) {
        slots.add(m[1]);
      }
    }
  };
  walk(UI_DIR);
  return [...slots].sort();
}

/** The bodies of every `@media (prefers-reduced-motion: reduce) { … }` block. */
function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  const head = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (const m of css.matchAll(head)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    blocks.push(css.slice(start, i - 1));
  }
  return blocks;
}

describe("the shared overlays stop moving for a reader who asked for less motion", () => {
  test("the premise holds: the shared overlays do animate", () => {
    const slots = animatedSlots();
    expect(slots).toContain("sheet-content");
    expect(slots).toContain("sheet-overlay");
    expect(slots).toContain("dialog-content");
    expect(slots).toContain("popover-content");
    expect(slots).toContain("dropdown-menu-content");
  });

  test("every animated content and overlay is stilled, animations AND transitions", () => {
    const rule = reducedMotionBlocks(CSS).find((b) => b.includes('[data-slot="sheet-content"]'));
    expect(rule, "no reduced-motion rule names the shared overlays").toBeDefined();
    const missing = animatedSlots().filter((slot) => !rule!.includes(`[data-slot="${slot}"]`));
    expect(missing, "these shared overlays still animate under reduced motion").toEqual([]);
    expect(rule).toMatch(/animation:\s*none/);
    // The Sheet slides with a TRANSITION as well as an animation.
    expect(rule).toMatch(/transition:\s*none/);
  });
});
