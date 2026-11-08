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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import { cn } from "@/lib/utils";
import { popoverContentClassName } from "./popover";
import { dialogContentClassName } from "./dialog";
import { alertDialogContentClassName } from "./alert-dialog";

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
    ["prompts (ConfirmDialog renders a DialogContent)", ""],
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

// EVERY KIND OF LAYER, NOT ONLY THE DIALOG (lot 17). The confirmations were counted
// as "dialogs" here — they render an AlertDialogContent, which had neither the cap
// nor the scroll: the iOS keyboard their type-to-confirm field opens covered their
// buttons. Each kind is now composed as its call sites compose it.
describe("alert dialog content (the confirmations): never taller than the visible screen", () => {
  test("ConfirmDialog renders an AlertDialogContent for a confirmation, a DialogContent for a prompt", () => {
    const file = join(process.cwd(), "src/components/ConfirmDialog.tsx");
    const text = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const tags: Array<[string, string]> = [];
    const visit = (n: ts.Node) => {
      if (ts.isConditionalExpression(n) && /^is(Confirm|Prompt)$/.test(n.condition.getText(sf))) {
        const inner = n.whenTrue.getText(sf);
        tags.push([n.condition.getText(sf), /<(AlertDialogContent|DialogContent)\b/.exec(inner)?.[1] ?? ""]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(tags).toEqual([
      ["isConfirm", "AlertDialogContent"],
      ["isPrompt", "DialogContent"],
    ]);
    // …with no class of its own that could drop the cap.
    expect(text).not.toMatch(/<AlertDialogContent[^>]*className=/);
  });

  test.each([
    ["confirmations, type-to-confirm included (ConfirmDialog)", ""],
    ["a cron's deletion (ScheduledTab)", ""],
  ])("%s keeps the cap and the scroll", (_where, callerClasses) => {
    const out = classes(alertDialogContentClassName, callerClasses);
    expect(out).toContain(DIALOG_CAP);
    expect(out).toContain("overflow-y-auto");
  });
});

describe("sheet content: scrolls inside its bounded height", () => {
  test("every sheet keeps the scroll, whatever its own class", () => {
    const file = join(process.cwd(), "src/components/ui/sheet.tsx");
    const text = readFileSync(file, "utf-8");
    const base = /data-slot="sheet-content"[\s\S]*?cn\(\s*"([^"]+)"/.exec(text)?.[1] ?? "";
    for (const own of ["oc-drawer", "oc-spanel", "oc-areq-panel", "oc-sources-panel-sheet", "oc-spanel oc-convpanel"]) {
      expect(classes(base, own), own).toContain("overflow-y-auto");
    }
  });
});

describe("the reply's menu (assistant-ui): capped like every menu", () => {
  test("its wrapper caps it to the room Radix measured, and it keeps its scroll", () => {
    const wrapper = readFileSync(join(process.cwd(), "src/components/ui/action-bar-more.tsx"), "utf-8");
    const cap = /cn\("([^"]+)", className\)/.exec(wrapper)?.[1] ?? "";
    expect(cap).toBe("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(wrapper).toContain('data-slot="dropdown-menu-content"');
    const chat = readFileSync(join(process.cwd(), "src/chat/ConvexChat.tsx"), "utf-8");
    const own = /const MSG_MENU_CONTENT_CLS =\s*"([^"]+)"/.exec(chat)?.[1] ?? "";
    const out = classes(cap, own);
    expect(out).toContain(cap);
    expect(out).toContain("overflow-y-auto");
  });
});
