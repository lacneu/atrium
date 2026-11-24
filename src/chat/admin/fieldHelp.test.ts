// A field's `?` help (FieldLabel.tsx) under a mouse and under a finger (2026-11).
// A Radix tooltip opens on hover or keyboard focus, never on a tap: on a phone the
// help was simply unreachable. Where a finger can be used it is a TOGGLETIP — a
// popover the tap opens and closes.
//
// Rendered rather than grepped: the trigger the help really emits, with the touch
// question answered both ways.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

let touch = false;
vi.mock("@/lib/useMediaQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/useMediaQuery")>()),
  useTouchReveal: () => touch,
}));

import { FieldHelp } from "./FieldLabel";

const render = () => renderToStaticMarkup(h(FieldHelp, { text: "Aide du champ" }));

describe("a field's help opens where the reader can open it", () => {
  test("under a mouse: a tooltip (hover and focus)", () => {
    touch = false;
    const html = render();
    expect(html).toContain('data-slot="tooltip-trigger"');
    expect(html).not.toContain('data-slot="popover-trigger"');
  });

  test("where a finger can be used: a toggletip the tap opens, with a hit zone", () => {
    touch = true;
    const html = render();
    expect(html).toContain('data-slot="popover-trigger"');
    expect(html).not.toContain('data-slot="tooltip-trigger"');
    expect(html).toMatch(/class="oc-field__help oc-hit"/);
    expect(html).toContain('aria-label="Aide du champ"');
  });
});
