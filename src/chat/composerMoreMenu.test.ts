// The composer's "More" menu SHOWS what it holds in its own order (2026-11):
// the one-line actions first, as they sit in the bar, then the two settings
// sections at the bottom. Listed in LEAVING order (composerFit.ts OVERFLOW_ORDER),
// a phone's most used controls — the last to leave the bar — landed under the five
// permission modes, a scroll away.
//
// Rendered rather than grepped: the popover is stubbed to render its content in
// place (Radix portals render nothing on the server), and the order is read off
// the markup the menu really emits.

import { createElement as h, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => h(Fragment, null, children),
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) =>
    h("div", { "data-probe": "more-content" }, children),
}));

import { ComposerMoreMenu } from "./ComposerMoreMenu";
import { OVERFLOW_ORDER, type OverflowKey } from "./composerFit";
import { m } from "@/paraglide/messages.js";

const PERMISSION_MARKER = "permission-section-probe";

function renderMenu(moved: readonly OverflowKey[]): string {
  const html = renderToStaticMarkup(
    h(ComposerMoreMenu, {
      open: true,
      onOpenChange: () => undefined,
      // A Set iterates in insertion order: built in LEAVING order, as the bar does.
      moved: new Set(moved),
      hold: { held: false, disabled: false, onHold: () => undefined, onRelease: () => undefined },
      expand: { expanded: false, onToggle: () => undefined },
      tools: { shown: false, onToggle: () => undefined },
      onManageConversation: () => undefined,
      onDictate: () => undefined,
      permission: h("span", null, PERMISSION_MARKER),
      talkSettingsSlot: () => undefined,
      talkStartSlot: () => undefined,
    }),
  );
  const start = html.indexOf('data-probe="more-content"');
  expect(start, "the menu's content was not rendered").toBeGreaterThan(-1);
  return html.slice(start);
}

/** Where each entry sits in the rendered content (-1 when absent). */
function positions(html: string): Record<OverflowKey, number> {
  return {
    tools: html.indexOf(`>${m.chat_tools()}`),
    "room-settings": html.indexOf(`>${m.conversation_manage()}`),
    hold: html.indexOf(`>${m.chat_composer_detach()}`),
    expand: html.indexOf(`>${m.chat_composer_expand()}`),
    mic: html.indexOf(`>${m.chat_mic_start()}`),
    // Talk renders its start entry into this empty slot (it owns the call).
    talk: html.indexOf("<div></div>"),
    perm: html.indexOf(PERMISSION_MARKER),
    "talk-settings": html.indexOf(`aria-label="${m.chat_composer_more_talk()}"`),
  };
}

function shownOrder(html: string, moved: readonly OverflowKey[]): OverflowKey[] {
  const at = positions(html);
  for (const key of moved) expect(at[key], `${key} is not in the menu`).toBeGreaterThan(-1);
  return [...moved].sort((a, b) => at[a] - at[b]);
}

describe("the More menu shows its one-line actions first, its sections last", () => {
  test("everything moved (a phone): the bar's order, then permissions, then Talk's settings", () => {
    const html = renderMenu(OVERFLOW_ORDER);
    expect(shownOrder(html, OVERFLOW_ORDER)).toEqual([
      "tools",
      "room-settings",
      "hold",
      "expand",
      "mic",
      "talk",
      "perm",
      "talk-settings",
    ]);
  });

  test("the first four only (a tablet): detach and full page above the two sections", () => {
    const moved = OVERFLOW_ORDER.slice(0, 4);
    expect(moved).toEqual(["hold", "expand", "talk-settings", "perm"]);
    expect(shownOrder(renderMenu(moved), moved)).toEqual([
      "hold",
      "expand",
      "perm",
      "talk-settings",
    ]);
  });

  test("a control still in the bar is not listed", () => {
    const html = renderMenu(["hold", "expand"]);
    const at = positions(html);
    expect(at.hold).toBeGreaterThan(-1);
    expect(at.tools).toBe(-1);
    expect(at.perm).toBe(-1);
    expect(at["talk-settings"]).toBe(-1);
  });
});
