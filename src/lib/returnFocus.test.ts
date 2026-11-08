// Where the focus goes when a layer closes (lots 15-16).
//
// Two defects shaped this rule, both measured in a browser before they were fixed:
//   - lot 15: no dialog of the app has a Radix trigger, the only place Radix gives
//     the focus back to — every dialog dropped it on the page as it closed;
//   - lot 16: the opener was read from Radix's `onOpenAutoFocus`, which Radix skips
//     when an `autoFocus` field already took the focus (the agent picker's search):
//     the opener was lost. And a view's own close handler ran before the guard: the
//     drawer and the block picker took back a focus the user had just moved.
// So the opener is read from the page's focus history, whatever the dialog's own
// fields did, and the guard comes before everything — the views only add
// fallbacks. Tested here on a small fake page: its focus() fails silently where
// the browser's does (an element gone, hidden, disabled), and its active element
// falls back to the body when the focused element leaves the page.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  captureOpening,
  closeLayerFocus,
  closeLayerOfKind,
  createFocusHistory,
  focusPlaced,
  installFocusHistory,
  nearestSurvivingControl,
  openerFor,
  openerOf,
  regionsOf,
  returnFocusOrder,
  triggerOpening,
  type FocusHistory,
  type FocusSource,
  type Opening,
} from "./returnFocus";

const NATURAL = new Set(["button", "input", "select", "textarea"]);

type Listener = (event: FocusEvent) => void;

class FakeDoc {
  readonly documentElement: FakeEl;
  readonly body: FakeEl;
  activeElement: FakeEl | null;
  readonly listeners = new Map<string, Listener[]>();
  constructor() {
    this.documentElement = new FakeEl(this, "html");
    this.body = this.documentElement.add("body");
    this.activeElement = this.body;
  }
  getElementById(id: string): FakeEl | null {
    return this.documentElement.descendants().find((e) => e.attrs.get("id") === id) ?? null;
  }
  querySelectorAll(selectors: string): FakeEl[] {
    return this.documentElement.querySelectorAll(selectors);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  fire(type: "focusin" | "focusout", target: FakeEl, relatedTarget: FakeEl | null): void {
    for (const l of this.listeners.get(type) ?? []) l({ target, relatedTarget } as unknown as FocusEvent);
  }
}

class FakeEl {
  parentElement: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  displayed = true;
  disabled = false;
  focusCalls = 0;

  constructor(
    readonly ownerDocument: FakeDoc,
    readonly tag: string,
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }

  add(tag: string, attrs: Record<string, string> = {}): FakeEl {
    const child = new FakeEl(this.ownerDocument, tag, attrs);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /** Leaves the page; a focus it held falls back to the body, as in a browser. */
  remove(): void {
    const parent = this.parentElement;
    if (parent !== null) parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
    const doc = this.ownerDocument;
    if (doc.activeElement !== null && !doc.activeElement.isConnected) doc.activeElement = doc.body;
  }

  get isConnected(): boolean {
    let el: FakeEl = this;
    while (el.parentElement !== null) el = el.parentElement;
    return el === this.ownerDocument.documentElement;
  }

  descendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  get tabIndex(): number {
    const own = this.attrs.get("tabindex");
    if (own !== undefined) return Number(own);
    return NATURAL.has(this.tag) || (this.tag === "a" && this.attrs.has("href")) ? 0 : -1;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  private matchesOne(selector: string): boolean {
    switch (selector) {
      case '[role="menu"]':
        return this.attrs.get("role") === "menu";
      case '[role="alertdialog"]':
        return this.attrs.get("role") === "alertdialog";
      case '[role="dialog"]':
        return this.attrs.get("role") === "dialog";
      case '[role="dialog"]:not([data-popover-of])':
        return this.attrs.get("role") === "dialog" && !this.attrs.has("data-popover-of");
      case "[data-popover-of]":
      case "[data-popover-trigger]":
        return this.attrs.has(selector.slice(1, -1));
      case "[inert]":
        return this.attrs.has("inert");
      case ":disabled":
        return this.disabled;
      case '[aria-disabled="true"]':
        return this.attrs.get("aria-disabled") === "true";
      case "[href]":
        return this.attrs.has("href");
      case "[tabindex]:not([tabindex='-1'])":
        return this.attrs.has("tabindex") && this.attrs.get("tabindex") !== "-1";
      case "button":
      case "input":
      case "select":
      case "textarea":
      case "main":
      case "aside":
        return this.tag === selector;
      default:
        throw new Error(`fake page: unsupported selector ${selector}`);
    }
  }

  matches(selectors: string): boolean {
    return selectors.split(",").some((s) => this.matchesOne(s.trim()));
  }

  closest(selectors: string): FakeEl | null {
    for (let el: FakeEl | null = this; el !== null; el = el.parentElement) {
      if (el.matches(selectors)) return el;
    }
    return null;
  }

  contains(other: FakeEl | null): boolean {
    for (let el = other; el !== null; el = el.parentElement) if (el === this) return true;
    return false;
  }

  querySelectorAll(selectors: string): FakeEl[] {
    return this.descendants().filter((e) => e.matches(selectors));
  }

  /** On the page and drawn: no `display: none` on it or above it. */
  private get rendered(): boolean {
    if (!this.isConnected) return false;
    for (let el: FakeEl | null = this; el !== null; el = el.parentElement) {
      if (!el.displayed) return false;
    }
    return true;
  }
  getClientRects(): { length: number } {
    return { length: this.rendered ? 1 : 0 };
  }
  checkVisibility(): boolean {
    return this.rendered;
  }
  addEventListener(): void {}

  /** Fails silently where the browser's does. */
  focus(): void {
    this.focusCalls += 1;
    if (!this.rendered || this.disabled || this.closest("[inert]") !== null) return;
    if (this.tabIndex < 0 && !this.attrs.has("tabindex")) return;
    this.ownerDocument.activeElement = this;
  }
}

const asDoc = (d: FakeDoc) => d as unknown as Document;
const asEl = (e: FakeEl | null) => e as unknown as HTMLElement | null;
const asEls = (...es: (FakeEl | null)[]) => es as unknown as (HTMLElement | null)[];
const asEntries = (...es: (FakeEl | null)[]) => es as unknown as (Element | null)[];

/** A page: the sidebar and its "New chat"; the routed view in `main` — a bar with
 *  "New subfolder" and its ⋯ (a menu trigger), a list; the composer's field. */
function page() {
  const doc = new FakeDoc();
  const sidebar = doc.body.add("aside");
  const newChat = sidebar.add("button");
  const main = doc.body.add("main");
  const view = main.add("div");
  const bar = view.add("div");
  const subfolder = bar.add("button");
  const pageMenu = bar.add("button", { id: "page-menu", "aria-haspopup": "menu" });
  const list = view.add("div");
  const row = list.add("button");
  const field = view.add("textarea");
  return { doc, sidebar, newChat, main, view, bar, subfolder, pageMenu, list, row, field };
}

/** A dialog's content, mounted on the body (a portal), with its own field. */
function dialog(doc: FakeDoc, attrs: Record<string, string> = {}) {
  const content = doc.body.add("div", { role: "dialog", "data-state": "open", ...attrs });
  const input = content.add("input");
  return { content, input };
}

/** The history a page's focus moves leave, newest last. */
function historyOf(...entries: (FakeEl | null)[]): FocusHistory {
  const h = createFocusHistory();
  for (const e of entries) h.record(e as unknown as Element | null);
  return h;
}

class FakeEvent {
  defaultPrevented = false;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

describe("the focus history (installed once for the page, main.tsx)", () => {
  function installed() {
    const p = page();
    const history = createFocusHistory();
    const tasks: Array<() => void> = [];
    const uninstall = installFocusHistory(p.doc as unknown as FocusSource, history, (t) => tasks.push(t));
    const flush = () => tasks.splice(0).forEach((t) => t());
    return { ...p, history, uninstall, flush };
  }

  test("every element that takes the focus, in order", () => {
    const p = installed();
    p.doc.fire("focusin", p.newChat, null);
    p.doc.fire("focusin", p.row, p.newChat);
    expect(p.history.entries()).toEqual([p.newChat, p.row]);
  });

  test("a focus that leaves for nowhere — a click on the page's background", () => {
    const p = installed();
    p.doc.fire("focusin", p.row, null);
    p.doc.activeElement = p.doc.body;
    p.doc.fire("focusout", p.row, null);
    p.flush();
    expect(p.history.entries()).toEqual([p.row, null]);
  });

  test("an element leaving the page while focused is not a choice: not recorded", () => {
    const p = installed();
    p.doc.fire("focusin", p.row, null);
    p.doc.fire("focusout", p.row, null);
    p.row.remove();
    p.flush();
    expect(p.history.entries()).toEqual([p.row]);
  });

  test("the window losing the focus is not either: the page keeps its active element", () => {
    const p = installed();
    p.doc.fire("focusin", p.row, null);
    p.doc.activeElement = p.row;
    p.doc.fire("focusout", p.row, null);
    p.flush();
    expect(p.history.entries()).toEqual([p.row]);
  });

  test("a focus moving to another element is its focusin, nothing else", () => {
    const p = installed();
    p.doc.fire("focusout", p.row, p.field);
    p.flush();
    expect(p.history.entries()).toEqual([]);
  });

  test("uninstalled, it records nothing; it keeps only the newest moves", () => {
    const p = installed();
    p.uninstall();
    p.doc.fire("focusin", p.row, null);
    expect(p.history.entries()).toEqual([]);
    const h = createFocusHistory(3);
    for (const e of [p.row, p.field, p.newChat, p.subfolder]) h.record(e as unknown as Element);
    expect(h.entries()).toEqual([p.field, p.newChat, p.subfolder]);
  });
});

describe("a dialog's opener, read from the history as its content mounts", () => {
  test("its own autoFocus field took the focus first: passed over — the button is the opener", () => {
    const p = page();
    const d = dialog(p.doc);
    // React focuses the field during its commit, before Radix looks — and before or
    // after the content's ref: the order does not matter, the field is inside.
    expect(openerFor(d.content as unknown as Element, asEntries(p.newChat, d.input), asDoc(p.doc))).toBe(p.newChat);
    expect(openerFor(d.content as unknown as Element, asEntries(p.newChat), asDoc(p.doc))).toBe(p.newChat);
  });

  test("the focus was nowhere when it opened: no opener", () => {
    const p = page();
    const d = dialog(p.doc);
    expect(openerFor(d.content as unknown as Element, asEntries(p.row, null, d.input), asDoc(p.doc))).toBeNull();
  });

  test("an item of a menu stands for the menu's trigger, even once the menu left the page", () => {
    const p = page();
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    const item = menu.add("div", { role: "menuitem", tabindex: "-1" });
    const d = dialog(p.doc);
    menu.remove();
    expect(openerFor(d.content as unknown as Element, asEntries(p.pageMenu, menu, item, d.input), asDoc(p.doc))).toBe(p.pageMenu);
  });

  test("an item of a popover stands for the popover's trigger (the shared Popover's pair)", () => {
    const p = page();
    const chip = p.bar.add("button", { "data-popover-trigger": "«r7»" });
    // The popover closes as the sheet opens (Radix marks it closed), and its trigger
    // may never have held the focus (a pointer that did not focus it): the item is
    // still read as that trigger, not passed over as a closing dialog.
    const popover = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«r7»", "data-state": "closed" });
    const footer = popover.add("button");
    const sheet = dialog(p.doc);
    expect(openerFor(sheet.content as unknown as Element, asEntries(p.row, footer, sheet.input), asDoc(p.doc))).toBe(chip);
  });

  test("opened from inside another dialog still open: that dialog's control", () => {
    const p = page();
    const outer = dialog(p.doc);
    const remove = outer.content.add("button");
    const confirm = dialog(p.doc, { role: "alertdialog" });
    expect(
      openerFor(confirm.content as unknown as Element, asEntries(p.newChat, outer.input, remove, confirm.input), asDoc(p.doc)),
    ).toBe(remove);
  });

  test("opened as another dialog closes: that dialog's moves are passed over, its opener is this one's", () => {
    const p = page();
    const first = dialog(p.doc);
    const next = first.content.add("button");
    first.content.attrs.set("data-state", "closed");
    const second = dialog(p.doc);
    expect(openerFor(second.content as unknown as Element, asEntries(p.row, first.input, next, second.input), asDoc(p.doc))).toBe(p.row);
    first.content.remove();
    expect(openerFor(second.content as unknown as Element, asEntries(p.row, first.input, next, second.input), asDoc(p.doc))).toBe(p.row);
  });

  test("the newest control gone since: no opener (not an older, stale one)", () => {
    const p = page();
    const d = dialog(p.doc);
    p.row.remove();
    expect(openerFor(d.content as unknown as Element, asEntries(p.newChat, p.row), asDoc(p.doc))).toBeNull();
  });

  test("the opening keeps the page around the opener", () => {
    const p = page();
    const d = dialog(p.doc);
    const opening = captureOpening(d.content as unknown as Element, historyOf(p.subfolder, d.input), asDoc(p.doc));
    expect(opening).toEqual({ origin: p.subfolder, regions: [p.bar, p.view] });
  });
});

describe("closing: the guard comes first — then the rule", () => {
  function opened() {
    const p = page();
    const d = dialog(p.doc);
    const opening = captureOpening(d.content as unknown as Element, historyOf(p.subfolder, d.input), asDoc(p.doc));
    d.input.focus();
    return { ...p, d, opening };
  }

  test("a focus moved outside the layer during its exit stays — the view's fallbacks are not even read", () => {
    const p = opened();
    p.field.focus();
    p.d.content.remove();
    let read = 0;
    const event = new FakeEvent();
    closeLayerFocus(event, p.d.content as unknown as Element, p.opening, () => {
      read += 1;
      return asEls(p.pageMenu);
    }, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.field);
    expect(event.defaultPrevented).toBe(true);
    expect(read).toBe(0);
    expect(p.subfolder.focusCalls).toBe(0);
  });

  test("témoin: the focus left with the layer — back to the opener", () => {
    const p = opened();
    p.d.content.remove();
    const event = new FakeEvent();
    closeLayerFocus(event, p.d.content as unknown as Element, p.opening, () => asEls(p.pageMenu), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.subfolder);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a focus still inside the closing layer is not placed: the rule runs", () => {
    const p = opened();
    expect(focusPlaced(p.d.content as unknown as Element, asDoc(p.doc))).toBe(false);
    const event = new FakeEvent();
    closeLayerFocus(event, p.d.content as unknown as Element, p.opening, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.subfolder);
  });

  test("the opener hidden meanwhile (into ⋯): the view's fallbacks, in order, past those that cannot", () => {
    const p = opened();
    p.d.content.remove();
    p.subfolder.displayed = false;
    p.row.disabled = true;
    const event = new FakeEvent();
    closeLayerFocus(event, p.d.content as unknown as Element, p.opening, () => asEls(null, p.row, p.pageMenu), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.pageMenu);
  });

  test("the opener gone, no fallback: the first control left in its part of the view", () => {
    const p = opened();
    p.d.content.remove();
    p.subfolder.remove();
    closeLayerFocus(new FakeEvent(), p.d.content as unknown as Element, p.opening, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.pageMenu);
  });

  test("never into another view: the routed view replaced, its main is not searched", () => {
    const p = opened();
    p.d.content.remove();
    p.view.remove();
    const next = p.main.add("div").add("button");
    const event = new FakeEvent();
    closeLayerFocus(event, p.d.content as unknown as Element, p.opening, undefined, asDoc(p.doc));
    expect(event.defaultPrevented).toBe(false);
    expect(p.doc.activeElement).toBe(p.doc.body);
    expect(next.focusCalls).toBe(0);
    expect(p.newChat.focusCalls).toBe(0);
  });

  test("the order: the opener, the view's fallbacks, then the nearest surviving control", () => {
    const p = page();
    const opening: Opening = { origin: asEl(p.subfolder), regions: regionsOf(asEl(p.subfolder)) };
    expect(returnFocusOrder(opening, asEls(p.row))).toEqual(asEls(p.subfolder, p.row, p.subfolder));
    expect(returnFocusOrder(null, asEls(p.row))).toEqual(asEls(p.row));
  });
});

describe("popovers and menus: their trigger is the opener", () => {
  test("a menu's trigger, by the label Radix gives it — read after the menu left", () => {
    const p = page();
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    menu.remove();
    expect(triggerOpening(menu as unknown as Element, asDoc(p.doc)).origin).toBe(p.pageMenu);
  });

  test("a menu closes with the focus lost: back to its trigger; hidden, to the view's fallbacks", () => {
    const p = page();
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    menu.remove();
    const event = new FakeEvent();
    closeLayerOfKind("menu", event, menu as unknown as Element, null, false, () => asEls(p.field), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.pageMenu);
    p.doc.activeElement = p.doc.body;
    p.pageMenu.displayed = false;
    closeLayerOfKind("menu", new FakeEvent(), menu as unknown as Element, null, false, () => asEls(p.field), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.field);
  });

  test("a menu closes with the focus moved to the composer: it stays (Radix kept from its trigger)", () => {
    const p = page();
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    p.field.focus();
    menu.remove();
    const event = new FakeEvent();
    closeLayerOfKind("menu", event, menu as unknown as Element, null, false, () => asEls(p.row), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.field);
    expect(event.defaultPrevented).toBe(true);
    expect(p.pageMenu.focusCalls).toBe(0);
  });

  test("a popover's trigger, by its pair", () => {
    const p = page();
    const chip = p.bar.add("button", { "data-popover-trigger": "«r7»" });
    const popover = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«r7»" });
    popover.remove();
    closeLayerOfKind("popover", new FakeEvent(), popover as unknown as Element, null, false, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(chip);
  });

  test("a popover dismissed by an interaction outside leaves the focus where it went", () => {
    const p = page();
    const chip = p.bar.add("button", { "data-popover-trigger": "«r7»" });
    const popover = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«r7»" });
    popover.remove();
    const nowhere = new FakeEvent();
    closeLayerOfKind("popover", nowhere, popover as unknown as Element, null, true, () => asEls(p.field), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.doc.body);
    expect(nowhere.defaultPrevented).toBe(false);
    expect(chip.focusCalls).toBe(0);
    p.row.focus();
    const elsewhere = new FakeEvent();
    closeLayerOfKind("popover", elsewhere, popover as unknown as Element, null, true, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.row);
    expect(elsewhere.defaultPrevented).toBe(true);
  });

  test("a dialog gives the focus back from its captured opening, not from a trigger", () => {
    const p = page();
    const d = dialog(p.doc, { "aria-labelledby": "page-menu" });
    const opening = captureOpening(d.content as unknown as Element, historyOf(p.newChat, d.input), asDoc(p.doc));
    d.content.remove();
    closeLayerOfKind("dialog", new FakeEvent(), d.content as unknown as Element, opening, true, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.newChat);
  });
});

describe("the parts of the page around the opener", () => {
  test("nearest first, up to — not including — the view's main, a sidebar, the body", () => {
    const p = page();
    expect(regionsOf(asEl(p.subfolder))).toEqual([p.bar, p.view]);
    expect(regionsOf(asEl(p.newChat))).toEqual([]);
    const portal = p.doc.body.add("div").add("div");
    const inPortal = portal.add("button");
    expect(regionsOf(asEl(inPortal))).toEqual([portal, portal.parentElement]);
    expect(regionsOf(null)).toEqual([]);
  });

  test("a part gone is passed over; a hidden or disabled control in a part still there too", () => {
    const p = page();
    const regions = regionsOf(asEl(p.subfolder));
    p.subfolder.displayed = false;
    expect(nearestSurvivingControl(regions)).toBe(p.pageMenu);
    p.bar.remove();
    expect(nearestSurvivingControl(regions)).toBe(p.row);
    p.row.disabled = true;
    expect(nearestSurvivingControl(regions)).toBe(p.field);
  });

  test("an element outside any menu stands for itself; a submenu chain goes up to the first trigger", () => {
    const p = page();
    expect(openerOf(p.row as unknown as Element, asDoc(p.doc))).toBe(p.row);
    expect(openerOf(null, asDoc(p.doc))).toBeNull();
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    menu.add("div", { role: "menuitem", id: "sub-trigger", tabindex: "-1" });
    const submenu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "sub-trigger" });
    const deep = submenu.add("div", { role: "menuitem", tabindex: "-1" });
    expect(openerOf(deep as unknown as Element, asDoc(p.doc))).toBe(p.pageMenu);
    const label = menu.add("span", { id: "inner-label" });
    menu.attrs.set("aria-labelledby", "inner-label");
    expect(label.isConnected).toBe(true);
    const item = menu.add("div", { role: "menuitem" });
    expect(openerOf(item as unknown as Element, asDoc(p.doc))).toBe(item);
  });
});

describe("the hook the shared contents use (read from the syntax tree: it needs React)", () => {
  const file = join(process.cwd(), "src/lib/returnFocus.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hook = (() => {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "useLayerFocus") found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found!;
  })();
  const text = (n: ts.Node) => n.getText(sf);

  test("its ref reads a dialog's opening as the content mounts — once per content", () => {
    const body = text(hook);
    expect(body).toMatch(/if \(el === null \|\| el === node\.current\) return;/);
    expect(body).toMatch(/opening\.current = kind === "dialog" \? captureOpening\(el\) : null;/);
  });

  test("its close runs the rule of its kind with what it noted, then forgets it", () => {
    const body = text(hook);
    expect(body).toMatch(
      /closeLayerOfKind\(kind, event, node\.current, opening\.current, outside\.current, returnFocus\);\s*node\.current = null;\s*opening\.current = null;\s*outside\.current = false;/,
    );
  });

  test("an interaction outside counts once the view's own handler let it through", () => {
    expect(text(hook)).toMatch(/onInteractOutside\?\.\(event\);\s*if \(!event\.defaultPrevented\) outside\.current = true;/);
  });
});
