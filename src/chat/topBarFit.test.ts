// THE TOP BAR FITS THE SCREEN (lot 26). With a real name — "Marie-Christine
// Lefebvre-Dupont", or an e-mail — the account's button never shrank: the page ran
// wider than a 360 px phone at the default text size already (594 px laid out),
// Chrome then laid every fixed layer out against that wider page, and a resize of
// the visual viewport read 481 px of "keyboard" off it, the app shrunk to 259 px.
// The bar sheds detail on what it measures: the brand's label, then the account's
// name for its icon.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { pickFitLevel } from "@/lib/useFitLevel";
import { DRAWER_HEAD_FITS, TOP_BAR_FITS } from "./topBarFit";

const SRC = join(process.cwd(), "src");
const CSS = readFileSync(join(SRC, "chat/convexChat.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the top bar's fit", () => {
  test("three presentations, most detailed first; the drawer's head two", () => {
    expect(TOP_BAR_FITS).toEqual(["full", "logo", "icon"]);
    expect(DRAWER_HEAD_FITS).toEqual(["full", "logo"]);
  });

  // The widths read in the browser at 360 px, an e-mail-length label: the full bar
  // asked 603 px, the logo alone with the name at its floor 342 px (md), 496 px
  // under the largest scale.
  test("a long name at the default size: the logo alone and the name shortened", () => {
    expect(TOP_BAR_FITS[pickFitLevel({ available: 360, required: [603, 342] })]).toBe("logo");
  });
  test("under the largest text scale: the account as its icon", () => {
    expect(TOP_BAR_FITS[pickFitLevel({ available: 360, required: [760, 496] })]).toBe("icon");
  });
  test("everything fits (a computer): the full bar", () => {
    expect(TOP_BAR_FITS[pickFitLevel({ available: 1280, required: [603, 342] })]).toBe("full");
  });
});

describe("the bars render every presentation and show one", () => {
  const router = readFileSync(join(SRC, "router.tsx"), "utf-8");
  /** The body of the function component `name` in router.tsx. */
  const component = (name: string) => {
    const start = router.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const next = router.indexOf("\nfunction ", start + 1);
    return router.slice(start, next < 0 ? undefined : next);
  };

  test.each([
    ["AppTopBar", "TOP_BAR_FITS", "oc-topbar--measure", "barRef", "data-fit={rail ? undefined : fit}"],
    ["PendingTopBar", "TOP_BAR_FITS", "oc-topbar--measure", "barRef", "data-fit={fit}"],
    ["DrawerHead", "DRAWER_HEAD_FITS", "oc-drawer__head--measure", "headRef", "data-fit={fit}"],
  ])("%s measures clones of its own element and wears what it chose", (name, fits, measure, ref, wears) => {
    const body = component(name);
    // Every presentation but the last, set on the clone the measure reads.
    expect(body).toContain(
      `${fits}.slice(0, -1).map((f) => (clone: HTMLElement) => clone.setAttribute("data-fit", f)),\n            "${measure}",`,
    );
    expect(body).toContain(`const ${ref === "headRef" ? "head" : "bar"} = ${ref}.current;`);
    expect(body).toContain(`ref={${ref}}`);
    expect(body).toContain(wears);
  });

  test("the pending account's bar and the drawer's head are those components", () => {
    expect(router).toContain("<PendingTopBar");
    expect(router).toContain("<DrawerHead");
    expect(router).not.toMatch(/<div className="oc-drawer__head">/);
  });

  test("the account's trigger: its icon, its label and its chevron, named by the label", () => {
    const menu = readFileSync(join(SRC, "chat/UserMenu.tsx"), "utf-8");
    const trigger = /className="oc-usermenu__trigger[^"]*"[\s\S]*?<\/Button>/.exec(menu)?.[0] ?? "";
    expect(trigger).toContain("min-w-0 shrink");
    expect(trigger).toContain("aria-label={label}");
    expect(trigger).toContain("title={label}");
    expect(trigger).toContain('className="oc-usermenu__icon"');
    expect(trigger).toContain('<span className="oc-usermenu__label">{label}</span>');
    expect(trigger).toContain('className="oc-usermenu__chev');
  });
});

describe("the stylesheet shows the presentation `data-fit` names", () => {
  /** The declarations of the rule whose selector list holds `selector`. */
  const ruleWith = (selector: string) =>
    [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1].split(",").map((s) => s.trim()).includes(selector))
      .map((m) => m[2].replace(/\s+/g, " "))
      .join(" ");

  test("logo: the brand's label goes where a logo precedes it (a brand without one keeps it)", () => {
    expect(ruleWith('.oc-topbar[data-fit="logo"] .oc-brand__logo + .oc-brand__label')).toContain("display: none");
    expect(ruleWith('.oc-drawer__head[data-fit="logo"] .oc-brand__logo + .oc-brand__label')).toContain("display: none");
  });

  test("icon: the account's label and chevron go, its icon shows", () => {
    expect(ruleWith('.oc-topbar[data-fit="icon"] .oc-usermenu__label')).toContain("display: none");
    expect(ruleWith('.oc-topbar[data-fit="icon"] .oc-usermenu__chev')).toContain("display: none");
    expect(ruleWith(".oc-usermenu__icon")).toContain("display: none");
    expect(ruleWith('.oc-topbar[data-fit="icon"] .oc-usermenu__icon')).toContain("display: block");
  });

  test("every label shortens rather than run past the bar", () => {
    for (const sel of [".oc-brand__label", ".oc-usermenu__label"]) {
      const own = ruleWith(sel);
      for (const d of ["min-width: 0", "overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]) {
        expect(own, `${sel} ${d}`).toContain(d);
      }
    }
  });

  test("the clones are laid out off-screen at their natural width; a shortened label at its floor", () => {
    for (const sel of [".oc-topbar.oc-topbar--measure", ".oc-drawer__head.oc-drawer__head--measure"]) {
      const own = ruleWith(sel);
      for (const d of ["position: absolute", "width: max-content", "visibility: hidden", "pointer-events: none"]) {
        expect(own, `${sel} ${d}`).toContain(d);
      }
    }
    expect(ruleWith('.oc-topbar.oc-topbar--measure[data-fit="logo"] .oc-usermenu__label')).toContain("max-width: 7em");
  });
});
