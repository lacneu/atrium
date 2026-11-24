// A tab list wider than its row scrolls, it never spills.
//
// THE DEFECT THIS GUARDS (responsive audit, G6). The list was `inline-flex w-fit
// justify-center` with no max width and no overflow: on Settings ▸ Voice at
// 360 px, 478 px of triggers in a 320 px row overflowed BOTH sides, the first
// trigger starting at x=-138 — out of reach of any scroll, since a scroll
// container cannot scroll before its start edge.
//
// Rendered rather than grepped, like select.test.ts: the classes reach the DOM
// through `cn()`, which drops the loser of a conflict.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Tabs, TabsList, TabsTrigger } from "./tabs";

function renderList(listClassName: string, variant?: "default" | "line"): string {
  return renderToStaticMarkup(
    h(
      Tabs,
      { defaultValue: "readaloud" },
      h(
        TabsList,
        { className: listClassName, variant },
        h(TabsTrigger, { value: "readaloud", className: "flex-1 gap-1.5" }, "Read aloud"),
        h(TabsTrigger, { value: "dictation", className: "flex-1 gap-1.5" }, "Dictation"),
        h(TabsTrigger, { value: "talk", className: "flex-1 gap-1.5" }, "Real-time talk"),
      ),
    ),
  );
}

/** The class list of the element carrying `data-slot="<slot>"`, unescaped. */
function classesOf(html: string, slot: string): string[] {
  const el = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`).exec(html);
  if (!el) throw new Error(`no element carries data-slot="${slot}"`);
  const raw = / class="([^"]*)"/.exec(el[0])?.[1] ?? "";
  return raw.replaceAll("&amp;", "&").replaceAll("&quot;", '"').split(/\s+/);
}

describe("tab list containment", () => {
  test("stays inside its row and scrolls horizontally, without a vertical scrollbar", () => {
    const list = classesOf(renderList("w-full"), "tabs-list");
    expect(list).toContain("max-w-full");
    expect(list).toContain("overflow-x-auto");
    // The triggers' hidden underline sits 5 px below them: clipped, not scrolled.
    expect(list).toContain("overflow-y-hidden");
  });

  test("starts at its start edge: centering pushed the first triggers out of reach", () => {
    const list = classesOf(renderList("w-full"), "tabs-list");
    expect(list).toContain("justify-start");
    expect(list).not.toContain("justify-center");
  });

  test("a caller's width replaces the default width, never the containment", () => {
    const list = classesOf(renderList("w-full"), "tabs-list");
    expect(list).toContain("w-full");
    expect(list).not.toContain("w-fit");
    expect(list).toContain("max-w-full");
  });

  // Lot 10: where scrollbars always show (Windows, or macOS set so), the list's
  // scrollbar took its height inside the 32 px row and squashed the triggers.
  test("the scrolling list hides its scrollbar, in every engine", () => {
    const list = classesOf(renderList("w-full"), "tabs-list");
    expect(list).toContain("[scrollbar-width:none]");
    expect(list).toContain("[&::-webkit-scrollbar]:hidden");
  });

  test("the line variant keeps its underline visible (no vertical clip)", () => {
    const list = classesOf(renderList("", "line"), "tabs-list");
    expect(list).toContain("max-w-full");
    expect(list).not.toContain("overflow-y-hidden");
  });
});

// Lot 26: the arrow keys move the focus along the list ahead of its value (Voice's
// list follows the URL), and the trigger they landed on stayed past the edge
// (263-589 px in a 20-340 px list at 360 px under the largest text scale). The
// focused trigger is revealed like the active one — and the settings strip's tab.
describe("the focused tab is brought into view", () => {
  test("the tab list reveals the trigger a focus moved to", () => {
    const tabs = readFileSync(join(process.cwd(), "src/components/ui/tabs.tsx"), "utf-8");
    expect(tabs).toMatch(/addEventListener\("focusin", onFocusIn\)/);
    expect(tabs).toContain(`revealFocusIn(list, e.target, '[data-slot="tabs-trigger"]')`);
    expect(tabs).toMatch(/removeEventListener\("focusin", onFocusIn\)/);
  });
  test("the settings strip reveals the tab a focus moved to", () => {
    const nav = readFileSync(join(process.cwd(), "src/chat/admin/SettingsNav.tsx"), "utf-8");
    expect(nav).toMatch(/bar\.addEventListener\("focusin", onFocusIn\)/);
    expect(nav).toContain(`revealFocusIn(bar, e.target, '[role="tab"]')`);
    expect(nav).toMatch(/bar\.removeEventListener\("focusin", onFocusIn\)/);
  });
});
