// THE VIEWS WHOSE OPENER CAN DISAPPEAR NAME A CONTROL THAT STAYS (lot 15).
//
// Every dialog gives the focus back to the control that opened it (the shared
// contents, components/ui/dialogFocusReturn.test.ts). Some openers can be gone by
// the time their dialog closes, and their view names where the focus goes then:
//   - the project page's "New subfolder" and "New chat here" go into its ⋯ when
//     the bar has no room: the prompt and the agent picker fall back to that ⋯;
//   - a calendar occurrence is a different button in month and in agenda, swapped
//     by the calendar itself with its width: the cron editor falls back to the same
//     occurrence in the view now shown, then to the toolbar's current mode;
//   - the composer's room chevron goes into More with the width: the conversation
//     panel falls back to the chevron, More, then the field.
// The wiring is read from the syntax tree; the calendar's choice runs on fakes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { calendarReturnFocus } from "./admin/CalendarView";

const SRC = join(process.cwd(), "src");

function parse(rel: string): ts.SourceFile {
  const file = join(SRC, rel);
  return ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function find<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const openings = (root: ts.Node) =>
  find(root, (n): n is ts.JsxOpeningLikeElement => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));
const attr = (o: ts.JsxOpeningLikeElement, name: string) =>
  o.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
const attrText = (o: ts.JsxOpeningLikeElement, name: string) => attr(o, name)?.initializer?.getText();

/** The arrow function or function held by `const <name> = …`. */
function constFn(sf: ts.SourceFile, name: string): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const decl = find(sf, ts.isVariableDeclaration).find((d) => d.name.getText() === name);
  const init = decl?.initializer;
  return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
}

describe("the shared confirm and prompt pass the caller's fallbacks on", () => {
  const sf = parse("components/ConfirmDialog.tsx");
  test.each(["AlertDialogContent", "DialogContent"])("%s", (tag) => {
    const content = openings(sf).find((o) => o.tagName.getText() === tag);
    expect(content, `no ${tag}`).toBeDefined();
    expect(attrText(content!, "returnFocus")).toBe("{req.opts.returnFocus}");
  });
});

describe("project page: the new-item dialogs fall back to the page's ⋯", () => {
  const sf = parse("chat/ProjectPage.tsx");

  test("the fallback is the ⋯ trigger of the page's menu", () => {
    const back = constFn(sf, "backToPageMenu");
    expect(back?.body.getText()).toBe("[pageMenuRef.current]");
    const trigger = openings(sf).find((o) => attrText(o, "ref") === "{pageMenuRef}");
    expect(trigger, "pageMenuRef is on no element").toBeDefined();
    expect(attrText(trigger!, "aria-label")).toBe("{m.sidebar_project_actions()}");
    const wrapper = trigger!.parent.parent;
    expect(ts.isJsxElement(wrapper) && wrapper.openingElement.tagName.getText()).toBe("DropdownMenuTrigger");
  });

  test("the subfolder prompt names it", () => {
    const fn = constFn(sf, "newSubfolder");
    const call = fn && find(fn, ts.isCallExpression).find((c) => c.expression.getText() === "prompt");
    expect(call, "newSubfolder asks no prompt").toBeDefined();
    const opts = call!.arguments[0];
    expect(opts !== undefined && ts.isObjectLiteralExpression(opts)).toBe(true);
    const prop = (opts as ts.ObjectLiteralExpression).properties.find((p) => p.name?.getText() === "returnFocus");
    expect(prop !== undefined && ts.isPropertyAssignment(prop) && prop.initializer.getText()).toBe("backToPageMenu");
  });

  test("the agent picker of the new chat names it", () => {
    const call = find(sf, ts.isCallExpression).find((c) => c.expression.getText() === "useStartNewChat");
    expect(call?.arguments[1]?.getText()).toBe("backToPageMenu");
    const hook = parse("chat/useStartNewChat.tsx");
    const picker = openings(hook).find((o) => o.tagName.getText() === "AgentPickerDialog");
    expect(attrText(picker!, "returnFocus")).toBe("{returnFocus}");
    const dialog = parse("chat/AgentPicker.tsx");
    const content = openings(dialog).find((o) => o.tagName.getText() === "DialogContent");
    expect(attrText(content!, "returnFocus")).toBe("{returnFocus}");
  });
});

describe("calendar: the cron editor falls back to the same occurrence, then the toolbar", () => {
  const tab = parse("chat/admin/ScheduledTab.tsx");
  const cal = parse("chat/admin/CalendarView.tsx");

  test("every occurrence button, in month and in agenda, carries its occurrence", () => {
    const buttons = openings(cal).filter((o) => /onEventClick\b[^]*\(ev\)/.test(attrText(o, "onClick") ?? ""));
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(attrText(b, "data-cal-event")).toBe("{ev.id}");
  });

  test("the editor remembers the occurrence it was opened from — and only then", () => {
    const click = constFn(tab, "onCalendarEventClick");
    const sets = click && find(click, ts.isBinaryExpression).filter((b) => b.left.getText() === "editFromEvent.current");
    expect(sets?.map((s) => s.right.getText())).toEqual(["ev.id"]);
    // Opened from the list, the editor has no occurrence to fall back to: the
    // handler around that call forgets it first.
    const opens = find(tab, ts.isCallExpression).filter((c) => c.expression.getText() === "openEdit");
    expect(opens.length).toBe(2);
    const fromList = opens.find((c) => c.getText() === "openEdit(g.instanceName, j)");
    let handler: ts.Node | undefined = fromList;
    while (handler !== undefined && !ts.isArrowFunction(handler)) handler = handler.parent;
    expect(handler, "the list's edit call is in no handler").toBeDefined();
    const body = (handler as ts.ArrowFunction).body;
    expect(ts.isBlock(body)).toBe(true);
    expect((body as ts.Block).statements.map((s) => s.getText())).toEqual([
      "editFromEvent.current = null;",
      "void openEdit(g.instanceName, j);",
    ]);
  });

  test("the editor's content names the calendar's fallbacks", () => {
    const content = openings(tab).find(
      (o) => o.tagName.getText() === "DialogContent" && attrText(o, "className") === '"oc-cronedit"',
    );
    expect(content, "no cron editor content").toBeDefined();
    expect(attrText(content!, "returnFocus")).toBe("{editReturnFocus}");
    const fn = constFn(tab, "editReturnFocus");
    const call = fn && find(fn, ts.isCallExpression).find((c) => c.expression.getText() === "calendarReturnFocus");
    expect(call?.arguments.map((a) => a.getText())).toEqual(["editFromEvent.current"]);
  });
});

describe("conversation panel: back to the composer's chevron, More, the field", () => {
  test("the sheet names them, in that order", () => {
    const sf = parse("chat/ConversationPanel.tsx");
    const content = openings(sf).find(
      (o) => o.tagName.getText() === "SheetContent" && /oc-convpanel/.test(attrText(o, "className") ?? ""),
    );
    expect(content, "no conversation panel").toBeDefined();
    expect(attrText(content!, "returnFocus")).toBe("{returnFocus}");
    const fn = constFn(sf, "returnFocus");
    const list = fn && find(fn, ts.isArrayLiteralExpression).at(-1);
    expect(list?.elements.map((e) => e.getText())).toEqual(['barControl(bar, "room-settings")', "more", "field"]);
  });
});

// A fake calendar: just what calendarReturnFocus reads.
class FakeNode {
  constructor(
    readonly name: string,
    readonly attrs: Record<string, string> = {},
  ) {}
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
}
class FakeCal {
  constructor(
    readonly events: FakeNode[],
    readonly pressed: FakeNode | null,
    readonly firstHeadButton: FakeNode | null,
  ) {}
  querySelectorAll(sel: string): FakeNode[] {
    if (sel !== "[data-cal-event]") throw new Error(sel);
    return this.events;
  }
  querySelector(sel: string): FakeNode | null {
    if (sel === '.oc-cal__modes [aria-pressed="true"]') return this.pressed;
    if (sel === ".oc-cal__head button") return this.firstHeadButton;
    throw new Error(sel);
  }
}
const docWith = (root: FakeCal | null) =>
  ({ querySelector: (sel: string) => (sel === ".oc-cal" ? root : null) }) as unknown as Pick<Document, "querySelector">;

describe("calendarReturnFocus", () => {
  // Real ids join the instance and the job with a NUL: no selector is built from them.
  const id = "olivier\u0000job_7f3a2c:1794207600000";
  const agendaRow = new FakeNode("agenda row", { "data-cal-event": id });
  const other = new FakeNode("other", { "data-cal-event": "olivier\u0000job_91b0:1794207600000" });
  const agenda = new FakeNode("Agenda (pressed)");
  const prev = new FakeNode("previous");

  test("the same occurrence in the view now shown, then the current mode", () => {
    const cal = new FakeCal([other, agendaRow], agenda, prev);
    expect(calendarReturnFocus(id, docWith(cal))).toEqual([agendaRow, agenda]);
  });

  test("an occurrence the new view does not show (past, out of the agenda): the current mode", () => {
    const cal = new FakeCal([other], agenda, prev);
    expect(calendarReturnFocus(id, docWith(cal))).toEqual([null, agenda]);
  });

  test("no mode pressed: the toolbar's first control", () => {
    const cal = new FakeCal([agendaRow], null, prev);
    expect(calendarReturnFocus(id, docWith(cal))).toEqual([agendaRow, prev]);
  });

  test("no calendar on the page: nothing", () => {
    expect(calendarReturnFocus(id, docWith(null))).toEqual([]);
  });
});
