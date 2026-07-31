/// <reference types="vite/client" />
//
// Every shadcn overlay must be raised with the others (2026-07-31).
//
// THE DEFECT THIS GUARDS. Opening the composer in full-page mode and clicking the
// agent selector did nothing visible. The popover was in fact OPEN, with real
// geometry — it was painted underneath: shadcn ships `z-50` on its overlays while
// the app's own fixed panels had been given 60, 61 and 70 as they were added, each
// picking a number bigger than the last with nobody writing the order down.
//
// THE DEFECT THIS TEST ITSELF CAUGHT. The first fix listed the affected `data-slot`
// values BY HAND, typed from six component files chosen by eye, and omitted
// `alert-dialog` — whose confirmation opens INSIDE an already-raised dialog, so it
// would have stayed buried exactly like the popover. A list maintained by hand is
// the failure mode; this derives it from the components themselves, so a shadcn
// component added or regenerated tomorrow cannot quietly reintroduce the bug.
//
// It reads FILES rather than the DOM on purpose: `z-50` is a Tailwind utility in
// `.tsx`, not a declaration in the stylesheet, so a guard that parsed the CSS alone
// would inspect the half of the system that is not the problem.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const UI_DIR = join(process.cwd(), "src/components/ui");
const CSS = readFileSync(
  join(process.cwd(), "src/chat/convexChat.css"),
  "utf-8",
);

/**
 * Every `data-slot` in `src/components/ui/**` whose element also carries the `z-50`
 * utility — i.e. every surface shadcn intends to float.
 *
 * The association is positional: in these components `data-slot` always precedes
 * `className` on the same element, so each `z-50` belongs to the nearest `data-slot`
 * before it. If that ever stops holding, this test reports the wrong slot name and
 * fails loudly — which is the safe direction for a guard.
 */
function floatingSlots(): string[] {
  const slots = new Set<string>();
  for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".tsx"))) {
    const src = readFileSync(join(UI_DIR, file), "utf-8");
    for (const match of src.matchAll(/z-50/g)) {
      const before = src.slice(0, match.index);
      const slot = [...before.matchAll(/data-slot="([a-z-]+)"/g)].pop();
      if (slot) slots.add(slot[1]);
    }
  }
  return [...slots].sort();
}

describe("the shared overlay layer covers every floating shadcn surface", () => {
  test("the components DO ship z-50 — the premise still holds", () => {
    // If shadcn ever stops shipping `z-50`, the override below becomes dead weight
    // and this whole guard is measuring nothing. Fail here rather than pass hollow.
    expect(floatingSlots().length).toBeGreaterThan(0);
  });

  test("each one is raised by the app's layer rule", () => {
    const missing = floatingSlots().filter(
      (slot) => !CSS.includes(`[data-slot="${slot}"]`),
    );
    expect(
      missing,
      "these shadcn surfaces still compute to z-50 and will paint UNDER the " +
        "composer's focus panel (61) and the detached composer (70)",
    ).toEqual([]);
  });

  test("the overlay layer sits above every app panel and below the toast", () => {
    // The ordering claim the scale exists to make. A panel added above the overlay
    // layer would re-bury menus opened from it — the original defect, one surface
    // over.
    const layer = (name: string): number => {
      const found = CSS.match(new RegExp(`--oc-layer-${name}:\\s*(\\d+)`));
      expect(found, `--oc-layer-${name} is missing from the scale`).not.toBeNull();
      return Number(found![1]);
    };
    const overlay = layer("overlay");
    for (const panel of [
      "sidebar-backdrop",
      "sidebar-drawer",
      "focus-backdrop",
      "focus-panel",
      "detached-composer",
    ]) {
      expect(layer(panel), `${panel} must stay below the overlays`).toBeLessThan(
        overlay,
      );
    }
    // A toast must stay readable over an open menu; the lightbox is the deliberate
    // full takeover.
    expect(layer("toast")).toBeGreaterThan(overlay);
    expect(layer("lightbox")).toBeGreaterThan(layer("toast"));
  });

  test("no APP component floats on a raw z-50, outside the layer entirely", () => {
    // Matches BOTH spellings: Tailwind's named `z-50` and its arbitrary form
    // `z-[50]`, which compiles to the same `z-index: 50` and would otherwise walk
    // straight past a guard that only knew the first (codex pass 3).
    // The second way to be buried, and the one the first guard missed: an overlay
    // built from RAW Radix parts (the message "more actions" menu, the admin
    // time-range panel) carries `z-50` in its own className and no shadcn
    // `data-slot`, so the rule above never reaches it. Scanning only
    // `src/components/ui` declared victory while two menus stayed at 50.
    // App code joins the layer by class (`oc-overlay-layer`) instead.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full.endsWith("components/ui")) continue; // regenerable; data-slot rule
          walk(full);
        } else if (entry.name.endsWith(".tsx")) {
          const src = readFileSync(full, "utf-8");
          if (/\bz-50\b/.test(src) || /\bz-\[\d+\]/.test(src)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(
      offenders.map((f) => f.replace(`${process.cwd()}/`, "")),
      "use the `oc-overlay-layer` class instead of a raw `z-50` utility",
    ).toEqual([]);
  });

  test("no bare z-index above the sidebar layer, in ANY app stylesheet", () => {
    // Bare numbers are how the scale drifted in the first place: each new panel
    // picked one larger than the last, and the shared overlays were never in the
    // comparison. Low values (stacking-context fixes inside a card) are not layers
    // and are left alone.
    //
    // EVERY stylesheet under `src`, not just this one: the layer scale is an
    // application-wide claim, and a panel declared in another sheet paints on the
    // same screen. Checking one file would have been the same too-narrow scan that
    // let two raw-Radix menus stay at 50.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".css")) {
          for (const m of readFileSync(full, "utf-8").matchAll(
            /z-index:\s*(\d+)\s*;/g,
          )) {
            if (Number(m[1]) > 5) {
              offenders.push(`${full.replace(`${process.cwd()}/`, "")}: ${m[1]}`);
            }
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(
      offenders,
      "declare a --oc-layer-* variable in the scale instead of a bare number",
    ).toEqual([]);
  });
});
