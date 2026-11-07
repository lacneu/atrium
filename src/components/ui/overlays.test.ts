// Popovers and dialogs never run off the screen.
//
// THE DEFECT THIS GUARDS (responsive audit, B3/B4). Neither content had a height
// cap: the session-settings popover ended 26 px below a 740 px phone screen and
// 404 px below a landscape one; the report dialog started 20 px above a 360 px
// landscape screen. Nothing scrolled, so their last rows were unreachable.
//
// The invariant: the cap and the scroll survive what call sites pass — widths,
// paddings, max-widths — because tailwind-merge resolves conflicts in the caller's
// favour and silently drops the loser. Both contents render in a portal (nothing
// to render without a DOM), so the composition itself is what is asserted: the
// exact `cn()` the components run, with the classes real call sites pass.

import { describe, expect, test } from "vitest";

import { cn } from "@/lib/utils";
import { popoverContentClassName } from "./popover";
import { dialogContentClassName } from "./dialog";

const POPOVER_CAP = "max-h-(--radix-popover-content-available-height)";
const DIALOG_CAP = "max-h-[calc(100dvh-2rem)]";

function classes(...parts: string[]): string[] {
  return cn(...parts).split(/\s+/);
}

describe("popover content: capped to the room Radix measured, scrolling inside", () => {
  test.each([
    ["session settings (ConvexChat)", "oc-spanel-pop w-80 p-2"],
    ["composer agent picker (ConvexChat)", "oc-composer__agent-pop p-0"],
    ["timezone combobox (admin)", "oc-tzcombo__pop p-0"],
    ["date-time picker (admin)", "oc-dtp__pop"],
  ])("%s keeps the cap and the scroll", (_where, callerClasses) => {
    const out = classes(popoverContentClassName, callerClasses);
    expect(out).toContain(POPOVER_CAP);
    expect(out).toContain("overflow-y-auto");
  });

  test("a caller's width replaces the default width, not the cap", () => {
    const out = classes(popoverContentClassName, "w-80");
    expect(out).toContain("w-80");
    expect(out).not.toContain("w-72");
    expect(out).toContain(POPOVER_CAP);
  });
});

describe("dialog content: never taller than the visible screen", () => {
  test.each([
    ["report a problem (FeedbackDialog)", "sm:max-w-md"],
    ["trace detail (TracesTab)", "max-w-lg"],
    ["agents of an instance (InstancesTab)", "oc-access"],
    ["confirmations and prompts (ConfirmDialog)", ""],
  ])("%s keeps the cap and the scroll", (_where, callerClasses) => {
    const out = classes(dialogContentClassName, callerClasses);
    expect(out).toContain(DIALOG_CAP);
    expect(out).toContain("overflow-y-auto");
  });

  test("a caller that manages its own overflow keeps it (the search palette)", () => {
    // Its list scrolls inside; the palette itself clips. Its `overflow-hidden`
    // replaces the default scroll — and the height cap stays.
    const out = classes(
      dialogContentClassName,
      "oc-search-palette top-[12vh] translate-y-0 max-w-xl gap-0 overflow-hidden p-0",
    );
    expect(out).toContain("overflow-hidden");
    expect(out).not.toContain("overflow-y-auto");
    expect(out).toContain(DIALOG_CAP);
  });

  test("an explicit height from the caller wins over the default cap", () => {
    // NOT `max-h-none`: tailwind-merge 3.6 does not know it and would keep both
    // (no caller uses it today). To lift the cap, a call site sets its own height
    // in its CSS class — unlayered CSS wins over these utilities, as the
    // full-screen agent-file editor already does.
    const out = classes(dialogContentClassName, "max-h-[90vh]");
    expect(out).toContain("max-h-[90vh]");
    expect(out).not.toContain(DIALOG_CAP);
  });
});
