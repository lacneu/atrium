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
  createLayerTracker,
  createFocusHistory,
  focusPlaced,
  installFocusHistory,
  keyedTwin,
  nearestSurvivingControl,
  openerFor,
  openerOf,
  openingOf,
  openWithin,
  pruneDetached,
  regionsOf,
  returnFocusOrder,
  triggerOpening,
  type FocusHistory,
  type FocusSource,
  type Opening,
  type OpenLayers,
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
      case "[data-select-of]":
      case "[data-select-trigger]":
      case "[data-focus-key]":
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

  test("the newest control gone since stays the opener — never an older, stale one", () => {
    const p = page();
    const d = dialog(p.doc);
    p.row.remove();
    expect(openerFor(d.content as unknown as Element, asEntries(p.newChat, p.row), asDoc(p.doc))).toBe(p.row);
  });

  test("the opening keeps the page around the opener, and its focus key", () => {
    const p = page();
    const d = dialog(p.doc);
    const opening = captureOpening(d.content as unknown as Element, historyOf(p.subfolder, d.input), asDoc(p.doc));
    expect(opening).toEqual({ origin: p.subfolder, regions: [p.bar, p.view], key: null });
    p.newChat.attrs.set("data-focus-key", "sidebar:new-chat");
    const keyed = captureOpening(d.content as unknown as Element, historyOf(p.newChat, d.input), asDoc(p.doc));
    expect(keyed.key).toBe("sidebar:new-chat");
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

  test("the order: the opener, its twin, the view's fallbacks, then the nearest surviving control", () => {
    const p = page();
    const opening: Opening = { origin: asEl(p.subfolder), regions: regionsOf(asEl(p.subfolder)), key: null };
    expect(returnFocusOrder(opening, asEls(p.row), asDoc(p.doc))).toEqual(asEls(p.subfolder, null, p.row, p.subfolder));
    expect(returnFocusOrder(null, asEls(p.row), asDoc(p.doc))).toEqual(asEls(p.row));
  });
});

describe("the layout switched while the layer was open: the opener's twin (lot 17)", () => {
  /** The drawer's sidebar and the column's: one opener rendered in each layout,
   *  the same focus key on both. */
  function twoLayouts() {
    const p = page();
    const drawer = p.doc.body.add("div", { role: "dialog", "data-state": "open" });
    const drawerNewChat = drawer.add("button", { "data-focus-key": "sidebar:new-chat" });
    return { ...p, drawer, drawerNewChat };
  }

  test("the drawer gone with its button, the column's twin takes the focus — before the fallbacks", () => {
    const p = twoLayouts();
    const picker = dialog(p.doc);
    const opening = captureOpening(picker.content as unknown as Element, historyOf(p.drawerNewChat, picker.input), asDoc(p.doc));
    expect(opening.origin).toBe(p.drawerNewChat);
    expect(opening.key).toBe("sidebar:new-chat");
    // Wider than the drawer layout: the drawer leaves, the column renders its own.
    p.drawer.remove();
    const columnNewChat = p.sidebar.add("button", { "data-focus-key": "sidebar:new-chat" });
    picker.content.remove();
    closeLayerFocus(new FakeEvent(), picker.content as unknown as Element, opening, () => asEls(p.row), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(columnNewChat);
  });

  test("no twin in the new layout: the view's fallbacks, as before", () => {
    const p = twoLayouts();
    const picker = dialog(p.doc);
    const opening = captureOpening(picker.content as unknown as Element, historyOf(p.drawerNewChat, picker.input), asDoc(p.doc));
    p.drawer.remove();
    picker.content.remove();
    closeLayerFocus(new FakeEvent(), picker.content as unknown as Element, opening, () => asEls(p.row), asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.row);
  });

  test("a twin that cannot take the focus is passed over; a control of another key is not a twin", () => {
    const p = twoLayouts();
    const hidden = p.sidebar.add("button", { "data-focus-key": "sidebar:new-chat" });
    hidden.displayed = false;
    p.sidebar.add("button", { "data-focus-key": "sidebar:new-folder" });
    p.drawer.remove();
    expect(keyedTwin("sidebar:new-chat", asDoc(p.doc))).toBeNull();
    const shown = p.view.add("button", { "data-focus-key": "sidebar:new-chat" });
    expect(keyedTwin("sidebar:new-chat", asDoc(p.doc))).toBe(shown);
    expect(keyedTwin(null, asDoc(p.doc))).toBeNull();
  });

  test("the opener still there keeps the focus: its twin is only for when it is gone", () => {
    const p = twoLayouts();
    p.sidebar.add("button", { "data-focus-key": "sidebar:new-chat" });
    const picker = dialog(p.doc);
    const opening = captureOpening(picker.content as unknown as Element, historyOf(p.drawerNewChat, picker.input), asDoc(p.doc));
    picker.content.remove();
    closeLayerFocus(new FakeEvent(), picker.content as unknown as Element, opening, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(p.drawerNewChat);
  });

  test("a menu's trigger read as the menu mounts keeps its key: its twin after a switch", () => {
    const p = page();
    p.pageMenu.attrs.set("data-focus-key", "sidebar:folder-menu:p1");
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    const opening = triggerOpening(menu as unknown as Element, asDoc(p.doc));
    expect(opening.key).toBe("sidebar:folder-menu:p1");
    p.bar.remove();
    menu.remove();
    const twin = p.sidebar.add("button", { "data-focus-key": "sidebar:folder-menu:p1" });
    closeLayerOfKind("menu", new FakeEvent(), menu as unknown as Element, opening, false, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(twin);
  });
});

/** A content Radix renders where React cannot reach the document: a closed
 *  Select's items, portaled into a DocumentFragment. */
function fragmentNode(doc: FakeDoc): FakeEl {
  const fragment = new FakeEl(doc, "#document-fragment");
  return fragment.add("div");
}

describe("layers closing together: the innermost decides (lot 17)", () => {
  /** The drawer (a sheet) opened from the top bar's toggle, with a folder's ⋯ in
   *  its sidebar; the folder's menu opened from that ⋯. Each content has its
   *  tracker, as the shared contents do, on a registry of their own. */
  function drawerWithMenu() {
    const p = page();
    const open: OpenLayers = new Map();
    const toggle = p.doc.body.add("button");
    toggle.focus();
    const history = historyOf(toggle);
    const drawer = p.doc.body.add("div", { role: "dialog", "data-state": "open" });
    const folderMenu = drawer.add("button", { id: "folder-menu-d", "data-focus-key": "sidebar:folder-menu:p1" });
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "folder-menu-d" });
    const drawerTracker = createLayerTracker("dialog", open, history, asDoc(p.doc));
    const menuTracker = createLayerTracker("menu", open, history, asDoc(p.doc));
    drawerTracker.attach(drawer as unknown as Element);
    menuTracker.attach(menu as unknown as Element);
    return { ...p, open, toggle, drawer, folderMenu, menu, drawerTracker, menuTracker };
  }

  /** Wider than the drawer layout, in React's order: the removed tree's refs are
   *  detached from its root down (the drawer, then the menu), then its nodes leave
   *  the page; the column renders its own folder ⋯. */
  function switchLayout(p: ReturnType<typeof drawerWithMenu>, menuToo = true) {
    p.drawerTracker.attach(null);
    if (menuToo) p.menuTracker.attach(null);
    p.drawer.remove();
    if (menuToo) p.menu.remove();
    p.doc.activeElement = p.doc.body;
    return p.sidebar.add("button", { "data-focus-key": "sidebar:folder-menu:p1" });
  }

  const drawerFallbacks = (p: ReturnType<typeof drawerWithMenu>) => () => asEls(p.toggle);

  test("the drawer closes first (React cleans a removed tree from its root): the menu's trigger twin — not the toggle", () => {
    const p = drawerWithMenu();
    const twin = switchLayout(p);
    const drawerClosed = new FakeEvent();
    p.drawerTracker.close(drawerClosed, drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(twin);
    expect(drawerClosed.defaultPrevented).toBe(true);
    // Then the menu: the guard keeps the twin — nothing moves it again.
    const menuClosed = new FakeEvent();
    p.menuTracker.close(menuClosed, undefined);
    expect(p.doc.activeElement).toBe(twin);
    expect(menuClosed.defaultPrevented).toBe(true);
    expect(p.toggle.focusCalls).toBe(1);
  });

  test("in the other order, the same place: the menu's rule, then the drawer's guard", () => {
    const p = drawerWithMenu();
    const twin = switchLayout(p);
    p.menuTracker.close(new FakeEvent(), undefined);
    expect(p.doc.activeElement).toBe(twin);
    p.drawerTracker.close(new FakeEvent(), drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(twin);
  });

  test("témoin: the menu closed before the switch — the drawer's own rule, its toggle", () => {
    const p = drawerWithMenu();
    p.menuTracker.attach(null);
    p.menu.remove();
    p.menuTracker.close(new FakeEvent(), undefined);
    switchLayout(p, false);
    expect(openWithin(p.drawer as unknown as Element, p.open)).toEqual([]);
    p.drawerTracker.close(new FakeEvent(), drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(p.toggle);
  });

  test("no twin of the menu's trigger: the drawer's own rule follows", () => {
    const p = drawerWithMenu();
    p.drawerTracker.attach(null);
    p.menuTracker.attach(null);
    p.drawer.remove();
    p.menu.remove();
    p.drawerTracker.close(new FakeEvent(), drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(p.toggle);
  });

  test("a layer opened from the drawer but still on the page (the agent picker) is not closing: the guard keeps the focus in it", () => {
    const p = drawerWithMenu();
    const drawerNewChat = p.drawer.add("button", { "data-focus-key": "sidebar:new-chat" });
    const picker = dialog(p.doc);
    const pickerTracker = createLayerTracker("dialog", p.open, historyOf(drawerNewChat, picker.input), asDoc(p.doc));
    pickerTracker.attach(picker.content as unknown as Element);
    picker.input.focus();
    p.drawerTracker.attach(null);
    p.drawer.remove();
    const event = new FakeEvent();
    p.drawerTracker.close(event, drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(picker.input);
    expect(event.defaultPrevented).toBe(true);
    expect(p.open.has(picker.content as unknown as Element)).toBe(true);
  });

  test("a layer opened from the drawer that stays open (owned elsewhere), the focus on the page: the drawer's own rule — not that layer's opener", () => {
    const p = drawerWithMenu();
    p.menuTracker.attach(null);
    p.menu.remove();
    p.menuTracker.close(new FakeEvent(), undefined);
    const chip = p.drawer.add("button", { "data-popover-trigger": "«k1»", "data-focus-key": "chip-k1" });
    const popover = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«k1»" });
    const popoverTracker = createLayerTracker("popover", p.open, historyOf(), asDoc(p.doc));
    popoverTracker.attach(popover as unknown as Element);
    const chipTwin = p.sidebar.add("button", { "data-focus-key": "chip-k1" });
    p.drawerTracker.attach(null);
    p.drawer.remove();
    p.doc.activeElement = p.doc.body;
    p.drawerTracker.close(new FakeEvent(), drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(p.toggle);
    expect(chipTwin.focusCalls).toBe(0);
    expect(chip.focusCalls).toBe(0);
  });

  test("the layers read as the drawer leaves, not as it closes: one opened from elsewhere is not among them", () => {
    const p = drawerWithMenu();
    const elsewhere = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    const elsewhereTracker = createLayerTracker("menu", p.open, historyOf(), asDoc(p.doc));
    elsewhereTracker.attach(elsewhere as unknown as Element);
    expect(openWithin(p.drawer as unknown as Element, p.open).map((e) => e.node)).toEqual([p.menu]);
  });

  test("a chain — a menu opened from a popover opened in the drawer —: innermost first, then outward", () => {
    const p = drawerWithMenu();
    p.menuTracker.attach(null);
    p.menu.remove();
    p.menuTracker.close(new FakeEvent(), undefined);
    const chip = p.drawer.add("button", { "data-popover-trigger": "«c1»", "data-focus-key": "chip" });
    const popover = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«c1»" });
    const more = popover.add("button", { id: "more", "data-focus-key": "more" });
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "more" });
    const popoverTracker = createLayerTracker("popover", p.open, historyOf(), asDoc(p.doc));
    const menuTracker = createLayerTracker("menu", p.open, historyOf(), asDoc(p.doc));
    popoverTracker.attach(popover as unknown as Element);
    menuTracker.attach(menu as unknown as Element);
    menu.add("div", { role: "menuitem", tabindex: "-1" }).focus();
    expect(openWithin(p.drawer as unknown as Element, p.open).map((e) => e.node)).toEqual([menu, popover]);
    // Only the chip has a twin in the column: the menu's trigger has none.
    p.drawerTracker.attach(null);
    popoverTracker.attach(null);
    menuTracker.attach(null);
    p.drawer.remove();
    popover.remove();
    menu.remove();
    const chipTwin = p.sidebar.add("button", { "data-focus-key": "chip" });
    p.drawerTracker.close(new FakeEvent(), drawerFallbacks(p));
    expect(p.doc.activeElement).toBe(chipTwin);
    expect(more.focusCalls).toBe(0);
  });
});

describe("the registry holds only what is on the page (lot 18)", () => {
  function select() {
    const p = page();
    const open: OpenLayers = new Map();
    const trigger = p.bar.add("button", { "data-select-trigger": "«s1»" });
    const tracker = createLayerTracker("menu", open, historyOf(), asDoc(p.doc));
    const content = () => p.doc.body.add("div", { role: "listbox", "data-select-of": "«s1»" });
    return { ...p, open, trigger, tracker, content };
  }

  test("a node outside the document is never an open layer — a closed Select's items, in a DocumentFragment", () => {
    const p = select();
    for (let i = 0; i < 100; i++) {
      p.tracker.attach(fragmentNode(p.doc) as unknown as Element);
      expect(p.open.size).toBe(0);
      p.tracker.attach(null);
    }
    expect(p.open.size).toBe(0);
  });

  test("a node leaves the registry as React detaches it — before its close, which still runs the rule", () => {
    const p = select();
    const listbox = p.content();
    p.tracker.attach(listbox as unknown as Element);
    expect([...p.open.keys()]).toEqual([listbox]);
    p.tracker.attach(null);
    expect(p.open.size).toBe(0);
    listbox.remove();
    const event = new FakeEvent();
    p.tracker.close(event, undefined);
    expect(p.doc.activeElement).toBe(p.trigger);
    expect(event.defaultPrevented).toBe(true);
  });

  test("reopened before the old close ran: the new content stays registered, the old one is gone, the old close keeps the focus in the new one", () => {
    const p = select();
    const a = p.content();
    p.tracker.attach(a as unknown as Element);
    p.tracker.attach(null);
    a.remove();
    const b = p.content();
    const option = b.add("div", { role: "option", tabindex: "-1" });
    p.tracker.attach(b as unknown as Element);
    option.focus();
    expect([...p.open.keys()]).toEqual([b]);
    const late = new FakeEvent();
    p.tracker.close(late, undefined);
    expect(p.doc.activeElement).toBe(option);
    expect(late.defaultPrevented).toBe(true);
    expect([...p.open.keys()]).toEqual([b]);
    // Its own close, later: the rule for b — and nothing left.
    p.tracker.attach(null);
    b.remove();
    p.tracker.close(new FakeEvent(), undefined);
    expect(p.doc.activeElement).toBe(p.trigger);
    expect(p.open.size).toBe(0);
  });

  // Measured in the browser on the app's own Select: while open, its content got
  // the ref with null then with itself six times (Radix composes a new ref at each
  // render of SelectContentImpl); taking each null for a close queued six closes,
  // and the real one was mistaken for a late one — the focus fell on the page.
  test("the ref going to null then to the same node, render after render, is no close: the real close runs the rule", () => {
    const p = select();
    const listbox = p.content();
    const option = listbox.add("div", { role: "option", tabindex: "-1" });
    p.tracker.attach(listbox as unknown as Element);
    option.focus();
    for (let i = 0; i < 6; i++) {
      p.tracker.attach(null);
      expect(p.open.size).toBe(0);
      p.tracker.attach(listbox as unknown as Element);
      expect([...p.open.keys()]).toEqual([listbox]);
    }
    listbox.remove();
    const event = new FakeEvent();
    p.tracker.close(event, undefined);
    expect(p.doc.activeElement).toBe(p.trigger);
    expect(event.defaultPrevented).toBe(true);
    expect(p.open.size).toBe(0);
  });

  test("a null is no close: nothing is left waiting by the churn — the next content closes back to its own opener", () => {
    const p = page();
    const open: OpenLayers = new Map();
    const history = createFocusHistory();
    history.record(p.subfolder as unknown as Element);
    const tracker = createLayerTracker("dialog", open, history, asDoc(p.doc));
    const a = dialog(p.doc);
    tracker.attach(a.content as unknown as Element);
    a.input.focus();
    for (let i = 0; i < 3; i++) {
      tracker.attach(null);
      tracker.attach(a.content as unknown as Element);
    }
    a.content.remove();
    tracker.close(new FakeEvent(), undefined);
    expect(p.doc.activeElement).toBe(p.subfolder);
    // Opened again, from another control: its close goes back there.
    history.record(p.row as unknown as Element);
    const b = dialog(p.doc);
    tracker.attach(b.content as unknown as Element);
    b.input.focus();
    b.content.remove();
    tracker.close(new FakeEvent(), undefined);
    expect(p.doc.activeElement).toBe(p.row);
  });

  test("a Select's content leaves the page without its detach (React never calls its ref with null): its close still runs the rule, and nothing is left", () => {
    const p = select();
    const listbox = p.content();
    p.tracker.attach(listbox as unknown as Element);
    listbox.remove();
    pruneDetached(p.open);
    expect(p.open.size).toBe(0);
    const event = new FakeEvent();
    p.tracker.close(event, undefined);
    expect(p.doc.activeElement).toBe(p.trigger);
    expect(event.defaultPrevented).toBe(true);
    // Reopened: a fresh entry, and only it.
    const again = p.content();
    p.tracker.attach(again as unknown as Element);
    expect([...p.open.keys()]).toEqual([again]);
  });

  test("an entry whose node left the document is dropped — by the watch on the page, any attach, any close", () => {
    const p = select();
    const listbox = p.content();
    p.tracker.attach(listbox as unknown as Element);
    listbox.remove();
    const other = createLayerTracker("menu", p.open, historyOf(), asDoc(p.doc));
    other.close(new FakeEvent(), undefined);
    expect(p.open.size).toBe(0);
  });

  test("reopened, its new content not focused yet: the old close does not send the focus to the trigger", () => {
    const p = select();
    const a = p.content();
    p.tracker.attach(a as unknown as Element);
    a.remove();
    const b = p.content();
    p.tracker.attach(b as unknown as Element);
    p.doc.activeElement = p.doc.body;
    const late = new FakeEvent();
    p.tracker.close(late, () => asEls(p.row));
    expect(p.trigger.focusCalls).toBe(0);
    expect(p.row.focusCalls).toBe(0);
    expect(late.defaultPrevented).toBe(true);
    expect([...p.open.keys()]).toEqual([b]);
  });

  test("a registered node already gone from the document never counts among the layers opened from inside another", () => {
    const p = select();
    const dialogNode = p.doc.body.add("div", { role: "dialog" });
    const inside = dialogNode.add("button", { "data-select-trigger": "«s2»" });
    const gone = p.doc.body.add("div", { role: "listbox", "data-select-of": "«s2»" });
    p.open.set(gone as unknown as Element, openingOf(asEl(inside)));
    expect(openWithin(dialogNode as unknown as Element, p.open).map((e) => e.node)).toEqual([gone]);
    gone.remove();
    expect(openWithin(dialogNode as unknown as Element, p.open)).toEqual([]);
  });

  test("a node replaced without a detach between: the old one leaves at once", () => {
    const p = select();
    const a = p.content();
    const b = p.content();
    p.tracker.attach(a as unknown as Element);
    p.tracker.attach(b as unknown as Element);
    expect([...p.open.keys()]).toEqual([b]);
  });

  test("a close with no content gone (Radix reporting one still there): any focus stays, none moves", () => {
    const p = select();
    const listbox = p.content();
    const option = listbox.add("div", { role: "option", tabindex: "-1" });
    p.tracker.attach(listbox as unknown as Element);
    option.focus();
    const spurious = new FakeEvent();
    p.tracker.close(spurious, () => asEls(p.row));
    expect(p.doc.activeElement).toBe(option);
    expect(spurious.defaultPrevented).toBe(true);
    expect(p.trigger.focusCalls).toBe(0);
    expect(p.open.has(listbox as unknown as Element)).toBe(true);
  });

  test("100 contents opened and closed leave nothing behind; a node gone without its detach is dropped at the next attach", () => {
    const p = select();
    for (let i = 0; i < 100; i++) {
      const c = p.content();
      p.tracker.attach(c as unknown as Element);
      p.tracker.attach(null);
      c.remove();
      p.tracker.close(new FakeEvent(), undefined);
    }
    expect(p.open.size).toBe(0);
    const stray = p.doc.body.add("div");
    p.open.set(stray as unknown as Element, openingOf(null));
    stray.remove();
    p.tracker.attach(p.content() as unknown as Element);
    expect(p.open.has(stray as unknown as Element)).toBe(false);
  });

  test("a popover dismissed from outside keeps that through its detach, for its own close only", () => {
    const p = page();
    const open: OpenLayers = new Map();
    const chip = p.bar.add("button", { "data-popover-trigger": "«r7»" });
    const tracker = createLayerTracker("popover", open, historyOf(), asDoc(p.doc));
    const first = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«r7»" });
    tracker.attach(first as unknown as Element);
    tracker.interactedOutside();
    tracker.attach(null);
    first.remove();
    tracker.close(new FakeEvent(), undefined);
    expect(chip.focusCalls).toBe(0);
    const second = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«r7»" });
    tracker.attach(second as unknown as Element);
    tracker.attach(null);
    second.remove();
    tracker.close(new FakeEvent(), undefined);
    expect(p.doc.activeElement).toBe(chip);
  });
});

// THE REAL CYCLE, AS INSTALLED. The tests above replay what React and Radix do;
// these pin that they do it, in the installed code — a new version that changes
// the cycle fails here first. (The repository has no DOM to run Radix in; the
// browser proof of lot 18 runs it in the app itself.)
describe("the cycle the tracker relies on, read from the installed React and Radix", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), "node_modules", rel), "utf-8");

  test("Radix Select: a closed content renders its items into a DocumentFragment, without the app's ref; an open one takes it, inside a FocusScope that reports the close", () => {
    const src = read("@radix-ui/react-select/dist/index.mjs");
    expect(src).toMatch(/present \? \/\* @__PURE__ \*\/ jsx\(SelectContentImpl, \{ \.\.\.contentProps, ref: forwardedRef \}\) : \/\* @__PURE__ \*\/ jsx\(SelectContentFragment, \{ \.\.\.contentProps, fragment \}\)/);
    expect(src).toMatch(/setFragment\(new DocumentFragment\(\)\)/);
    expect(src).toMatch(/ReactDOM\.createPortal\([\s\S]{0,400}?jsx\("div", \{ ref: forwardedRef, children \}\)[\s\S]{0,40}?fragment\s*\)/);
    expect(src).toMatch(/onUnmountAutoFocus: composeEventHandlers\(onCloseAutoFocus,/);
  });

  test("Radix Presence: the element it renders gets its own ref composed with the element's — none for the fragment", () => {
    const src = read("@radix-ui/react-presence/dist/index.mjs");
    expect(src).toMatch(/const ref = use(?:Stable)?ComposedRefs\(presence\.ref, getElementRef\(child\)\);/);
    expect(src).toMatch(/React2?\.cloneElement\(child, \{ ref \}\)/);
  });

  test("Radix Presence: its composed ref reads the refs of the element rendered NOW — a Select's content, swapped for the fragment, never gets null", () => {
    const src = read("@radix-ui/react-presence/dist/index.mjs");
    const at = src.indexOf("function useStableComposedRefs(");
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/refsRef\.current = refs;/);
    expect(body).toMatch(/const currentRefs = refsRef\.current;/);
    expect(body).toMatch(/setRef\(currentRefs\[i\], null\)/);
  });

  test("Radix FocusScope: the close is reported by a timer after the content left — later than the next opening may be", () => {
    const src = read("@radix-ui/react-focus-scope/dist/index.mjs");
    expect(src).toMatch(/return \(\) => \{\s*container\.removeEventListener\(AUTOFOCUS_ON_MOUNT, onMountAutoFocus\);\s*setTimeout\(\(\) => \{\s*const unmountEvent = new CustomEvent\(AUTOFOCUS_ON_UNMOUNT, EVENT_OPTIONS\);/);
  });

  test("React: a removed tree's refs are detached from its root down, before its nodes leave the page", () => {
    const src = read("react-dom/cjs/react-dom-client.development.js");
    const at = src.indexOf("function commitDeletionEffectsOnFiber(");
    const body = src.slice(at, at + 3000);
    const detach = body.indexOf("safelyDetachRef(deletedFiber, nearestMountedAncestor)");
    const children = body.indexOf("recursivelyTraverseDeletionEffects(", detach);
    const remove = body.indexOf("removeChild(", children);
    expect(detach).toBeGreaterThan(0);
    expect(children).toBeGreaterThan(detach);
    expect(remove).toBeGreaterThan(children);
  });
});

describe("selects: their trigger by the shared Select's pair (lot 17)", () => {
  test("a select closes back to its trigger; an item inside one stands for it", () => {
    const p = page();
    const trigger = p.bar.add("button", { "data-select-trigger": "«s1»" });
    const list = p.doc.body.add("div", { role: "listbox", "data-select-of": "«s1»" });
    const option = list.add("div", { role: "option", tabindex: "-1" });
    expect(openerOf(option as unknown as Element, asDoc(p.doc))).toBe(trigger);
    const opening = triggerOpening(list as unknown as Element, asDoc(p.doc));
    list.remove();
    closeLayerOfKind("menu", new FakeEvent(), list as unknown as Element, opening, false, undefined, asDoc(p.doc));
    expect(p.doc.activeElement).toBe(trigger);
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

  test("one tracker for the content's life; its attach is the ref — the same function at every render", () => {
    const body = text(hook);
    expect(body).toMatch(/const \[tracker\] = useState\(\(\) => createLayerTracker\(kind\)\);/);
    expect(body).toMatch(/ref: tracker\.attach,/);
  });

  test("the page is watched from the first open layer on: its top level, where Radix portals every layer", () => {
    const tracker = (() => {
      let found: ts.FunctionDeclaration | undefined;
      const visit = (n: ts.Node) => {
        if (ts.isFunctionDeclaration(n) && n.name?.text === "createLayerTracker") found = n;
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return found!;
    })();
    expect(text(tracker)).toMatch(/open\.set\(node, opening\);\s*watchRegistry\(open, doc\);/);
    const watch = sf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === "watchRegistry")!;
    expect(text(watch)).toMatch(/new MutationObserver\(\(\) => pruneDetached\(open\)\)\.observe\(doc\.body, \{ childList: true \}\);/);
  });

  test("its close is the tracker's, with the view's fallbacks of this render", () => {
    expect(text(hook)).toMatch(/onCloseAutoFocus: \(event\) => tracker\.close\(event, returnFocus\),/);
  });

  test("an interaction outside counts once the view's own handler let it through", () => {
    expect(text(hook)).toMatch(/onInteractOutside\?\.\(event\);\s*if \(!event\.defaultPrevented\) tracker\.interactedOutside\(\);/);
  });
});
