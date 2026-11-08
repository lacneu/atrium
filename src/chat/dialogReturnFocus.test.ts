// THE VIEWS WHOSE OPENER CAN DISAPPEAR NAME A CONTROL THAT STAYS (lot 15).
//
// Every dialog gives the focus back to the control that opened it (the shared
// contents, components/ui/dialogFocusReturn.test.ts). Some openers can be gone by
// the time their dialog closes, and their view names where the focus goes then:
//   - the project page's "New subfolder" and "New chat here" go into its ⋯ when
//     the bar has no room: the prompt and the agent picker fall back to that ⋯;
//   - a calendar occurrence is a different button in month and in agenda, swapped
//     by the calendar itself with its width: both carry the occurrence's focus key,
//     and the rule finds the one now shown (lot 17); the cron editor falls back to
//     the toolbar's current mode when that view does not show it;
//   - the sidebar is rendered in the drawer or in the column, a whole new tree when
//     the layout switches: every layer opener in it carries a focus key (lot 17);
//     so do those of the side panels, a column beside the thread or a sheet over it;
//   - the composer's room chevron goes into More with the width: the conversation
//     panel falls back to the chevron, More, then the field.
// The wiring is read from the syntax tree; the calendar's choice runs on fakes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { calendarEventKey, calendarReturnFocus } from "./admin/CalendarView";

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

describe("calendar: the same occurrence by its focus key, then the toolbar", () => {
  const tab = parse("chat/admin/ScheduledTab.tsx");
  const cal = parse("chat/admin/CalendarView.tsx");

  test("every occurrence button, in month and in agenda, carries its occurrence's focus key", () => {
    const buttons = openings(cal).filter((o) => /onEventClick\b[^]*\(ev\)/.test(attrText(o, "onClick") ?? ""));
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(attrText(b, "data-focus-key")).toBe("{calendarEventKey(ev.id)}");
    expect(calendarEventKey("olivier\u0000job:1")).toBe("cal-event:olivier\u0000job:1");
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
    expect(fn?.body.getText()).toBe("editFromEvent.current === null ? [] : calendarReturnFocus()");
  });
});

// ---- OPENERS RENDERED IN TWO LAYOUTS (lot 17) -------------------------------------
//
// The sidebar body is ONE tree rendered in the drawer (drawer layout) or in the
// column (desktop): crossing the threshold mounts a new one. A layer opened from
// it outlives the button it was opened from — the agent picker of "New chat", the
// shared prompt of "New folder" — or closes with the tree — a row's menu, the
// sheets it opens: the innermost of those decides (lib/returnFocus, closingWithin).
// Either way each such opener carries a focus key, the same in both layouts,
// unique among them: the rule finds the live twin. Inventory of the app's other
// layouts:
//   - the side panels (sources, sub-agent, cron, document): a column of the dock
//     or, short of room, a sheet of the chat — keyed below;
//   - the calendar's month and agenda: the occurrences, keyed above;
//   - the composer's bar and its More, the project bar and its ⋯: the twin of a
//     hidden control exists only inside a closed menu — their views name fallbacks
//     (composerOverlayFocus.test.ts, the project page above);
//   - the project's columns and one level: a parent column dropped has no twin —
//     the nearest surviving part of the page;
//   - the top bar, the chat header, the tables stacked or not, the sidebar's
//     compact top: the same elements in both — nothing remounts.
describe("every layer opener of the sidebar carries a focus key, in both layouts", () => {
  const sidebar = parse("chat/ChatSidebar.tsx");

  /** The openers: a menu's trigger (its child element), and every control whose
   *  click opens a layer — the agent picker, a prompt, a dialog's state. */
  function openers(): ts.JsxOpeningLikeElement[] {
    const triggers = find(sidebar, ts.isJsxElement)
      .filter((e) => /^(DropdownMenu|Popover)Trigger$/.test(e.openingElement.tagName.getText()))
      .map((e) => openings(e).find((o) => o !== e.openingElement)!);
    const clicks = openings(sidebar).filter((o) =>
      /\b(prompt|confirm|onNewChat)\b|set\w*Open\(true\)/.test(attrText(o, "onClick") ?? ""),
    );
    return [...triggers, ...clicks];
  }

  test("the openers are all found: New chat, New folder, hidden folders, a folder's and a chat's menu", () => {
    const keys = openers().map((o) => attrText(o, "data-focus-key"));
    expect(keys).toEqual(
      expect.arrayContaining([
        '"sidebar:new-chat"',
        '"sidebar:new-folder"',
        '"sidebar:hidden-folders"',
        "{`sidebar:folder-menu:${projectId}`}",
        "{`sidebar:chat-menu:${chat._id}`}",
      ]),
    );
    expect(openers().length).toBe(5);
  });

  test("each carries one, and no two openers share it", () => {
    const keys = openers().map((o) => attrText(o, "data-focus-key"));
    expect(keys.every((k) => k !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the sidebar is the same tree in the drawer and in the column (one body, two parents)", () => {
    const router = parse("router.tsx");
    const uses = find(router, ts.isJsxExpression).filter((e) => e.expression?.getText() === "sidebarBody");
    expect(uses.length).toBe(2);
    const parents = uses.map((u) => (u.parent as ts.JsxElement).openingElement);
    expect(parents.map((o) => attrText(o, "className"))).toEqual([
      '"oc-sidebar-col oc-sidebar-col--drawer"',
      '"oc-sidebar-col"',
    ]);
  });
});

describe("every layer opener of the side panels carries a focus key, column or sheet", () => {
  const PANELS = ["SourcesPanelContent", "SubAgentPanelContent", "CronDetailContent", "DocumentViewerContent"];

  test("each panel is one content with two parents: the dock's column, the chat's sheet", () => {
    const dock = openings(parse("chat/PinnedPanelDock.tsx")).map((o) => o.tagName.getText());
    const chat = parse("chat/ConvexChat.tsx");
    const inSheet = find(chat, ts.isJsxElement)
      .filter((e) => e.openingElement.tagName.getText() === "SheetContent")
      .flatMap((e) => openings(e).map((o) => o.tagName.getText()));
    for (const panel of PANELS) {
      expect(dock, `${panel} in the dock`).toContain(panel);
      expect(inSheet, `${panel} in a sheet`).toContain(panel);
    }
  });

  /** The layers each panel renders — a menu, a dialog of its own (a component
   *  named …Dialog or …Sheet too) — and the state setters that open its dialogs.
   *  A layer added to a panel fails the next test until it is listed here, its
   *  opener keyed. */
  const PANEL_LAYERS: Record<string, { layers: string[]; setters: string[] }> = {
    "chat/SubAgentPanel.tsx": { layers: ["DropdownMenu", "SubAgentReportDialog"], setters: ["setReportTarget"] },
    "chat/CronDetailPanel.tsx": { layers: ["AlertDialog"], setters: ["setConfirmDelete"] },
    "chat/SourcesActivity.tsx": { layers: [], setters: [] },
    "chat/DocumentViewer.tsx": { layers: [], setters: [] },
  };
  const LAYER_TAG = /^(Dialog|AlertDialog|Sheet|Popover|DropdownMenu|Select)$|\w(Dialog|Sheet)$/;

  test.each(Object.entries(PANEL_LAYERS))("%s renders exactly the layers listed", (rel, { layers }) => {
    const tags = find(parse(rel), ts.isJsxElement)
      .map((e) => e.openingElement.tagName.getText())
      .concat(find(parse(rel), ts.isJsxSelfClosingElement).map((e) => e.tagName.getText()))
      .filter((t) => LAYER_TAG.test(t));
    expect([...new Set(tags)].sort()).toEqual([...layers].sort());
  });

  /** A panel's layer openers: a menu's trigger (its child), a control whose click
   *  calls a setter that opens one of its dialogs. */
  function openers(rel: string): ts.JsxOpeningLikeElement[] {
    const sf = parse(rel);
    const triggers = find(sf, ts.isJsxElement)
      .filter((e) => /^(DropdownMenu|Popover)Trigger$/.test(e.openingElement.tagName.getText()))
      .map((e) => openings(e).find((o) => o !== e.openingElement)!);
    const setters = PANEL_LAYERS[rel].setters;
    const clicks = openings(sf).filter((o) =>
      setters.some((set) => new RegExp(`\\b${set}\\(`).test(attrText(o, "onClick") ?? "")),
    );
    return [...triggers, ...clicks];
  }

  test("the sub-agent's export menu and report, the cron's deletion: keyed by their panel", () => {
    expect(openers("chat/SubAgentPanel.tsx").map((o) => attrText(o, "data-focus-key"))).toEqual([
      "{`subagent:export:${panelKey}`}",
      "{`subagent:report:${childKey}`}",
    ]);
    expect(openers("chat/CronDetailPanel.tsx").map((o) => attrText(o, "data-focus-key"))).toEqual([
      '{`cron-panel:delete:${instanceName}:${jobId ?? ""}`}',
    ]);
  });

  test("each dialog setter is the one its dialog is bound to", () => {
    const sub = openings(parse("chat/SubAgentPanel.tsx")).find((o) => o.tagName.getText() === "SubAgentReportDialog");
    expect(attrText(sub!, "target")).toBe("{reportTarget}");
    const cron = openings(parse("chat/CronDetailPanel.tsx")).find((o) => o.tagName.getText() === "AlertDialog");
    expect(attrText(cron!, "open")).toBe("{confirmDelete}");
    expect(attrText(cron!, "onOpenChange")).toBe("{setConfirmDelete}");
  });
});

describe("mobile drawer: back to its toggle when its opener is gone (lot 16)", () => {
  test("the toggle is a fallback of the rule, not a handler that ran before its guard", () => {
    const sf = parse("router.tsx");
    const content = openings(sf).find(
      (o) => o.tagName.getText() === "SheetContent" && /oc-drawer/.test(attrText(o, "className") ?? ""),
    );
    expect(content, "no drawer").toBeDefined();
    expect(attr(content!, "onCloseAutoFocus")).toBeUndefined();
    expect(attrText(content!, "returnFocus")).toBe("{() => [sidebarToggleRef.current]}");
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
  constructor(readonly name: string) {}
}
class FakeCal {
  constructor(
    readonly pressed: FakeNode | null,
    readonly firstHeadButton: FakeNode | null,
  ) {}
  querySelector(sel: string): FakeNode | null {
    if (sel === '.oc-cal__modes [aria-pressed="true"]') return this.pressed;
    if (sel === ".oc-cal__head button") return this.firstHeadButton;
    throw new Error(sel);
  }
}
const docWith = (root: FakeCal | null) =>
  ({ querySelector: (sel: string) => (sel === ".oc-cal" ? root : null) }) as unknown as Pick<Document, "querySelector">;

describe("calendarReturnFocus — once the occurrence is in neither view", () => {
  const agenda = new FakeNode("Agenda (pressed)");
  const prev = new FakeNode("previous");

  test("the toolbar's current mode", () => {
    expect(calendarReturnFocus(docWith(new FakeCal(agenda, prev)))).toEqual([agenda]);
  });

  test("no mode pressed: the toolbar's first control", () => {
    expect(calendarReturnFocus(docWith(new FakeCal(null, prev)))).toEqual([prev]);
  });

  test("no calendar on the page: nothing", () => {
    expect(calendarReturnFocus(docWith(null))).toEqual([]);
  });
});
