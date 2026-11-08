// Where a dialog gives the focus back when it closes (lot 15).
//
// No dialog of the app has a Radix trigger, and Radix only ever tries that trigger:
// the focus fell on the page as every dialog closed — measured in the browser on
// the shared prompt, the cron editor, a menu's dialog, a delete confirmation —, and
// so also once the view had hidden or replaced the opener meanwhile. The rule is
// tested here on a small fake page: its focus() fails silently where the browser's
// does (an element gone, hidden, disabled), and its active element falls back to
// the body when the focused element leaves the page, as the browser's does.

import { describe, expect, test } from "vitest";
import {
  captureOpening,
  closeAutoFocus,
  giveFocusBack,
  nearestSurvivingControl,
  openAutoFocus,
  openerOf,
  regionsOf,
  returnFocusOrder,
  type Opening,
} from "./returnFocus";

const NATURAL = new Set(["button", "input", "select", "textarea"]);

class FakeDoc {
  readonly documentElement: FakeEl;
  readonly body: FakeEl;
  activeElement: FakeEl | null;
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

/** The project page of the defect, in the routed `main`: a bar with "New
 *  subfolder" and its ⋯, a list; the sidebar beside it. */
function projectPage() {
  const doc = new FakeDoc();
  const sidebar = doc.body.add("aside");
  const sidebarRow = sidebar.add("button");
  const main = doc.body.add("main");
  const page = main.add("div");
  const bar = page.add("div");
  const subfolder = bar.add("button");
  const pageMenu = bar.add("button", { id: "page-menu", "aria-haspopup": "menu" });
  const list = page.add("div");
  const row = list.add("button");
  return { doc, sidebar, sidebarRow, main, page, bar, subfolder, pageMenu, list, row };
}

/** A dialog takes the focus (its field), then leaves the page: the focus is on the body. */
function openAndClose(doc: FakeDoc): void {
  const content = doc.body.add("div", { role: "dialog" });
  const field = content.add("input");
  field.focus();
  expect(doc.activeElement).toBe(field);
  content.remove();
  expect(doc.activeElement).toBe(doc.body);
}

class FakeEvent {
  defaultPrevented = false;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

describe("the focus goes back where the dialog was opened from", () => {
  test("témoin: the opener still there takes it back", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    expect(opening.origin).toBe(asEl(p.subfolder));
    openAndClose(p.doc);
    expect(giveFocusBack(opening, asEls(p.pageMenu), asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.subfolder);
  });

  test("the opener hidden meanwhile (the action went into ⋯): the view's ⋯", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.subfolder.displayed = false;
    expect(giveFocusBack(opening, asEls(p.pageMenu), asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.pageMenu);
  });

  test("the fallbacks are offered in their order, past those that cannot take it", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.subfolder.remove();
    p.pageMenu.disabled = true;
    expect(giveFocusBack(opening, asEls(null, p.pageMenu, p.row), asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.row);
  });

  test("the opener gone, no fallback: the first control left in its part of the page", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.subfolder.remove();
    expect(giveFocusBack(opening, [], asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.pageMenu);
  });

  test("its whole part gone: the nearest part around it still there", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.bar.remove();
    expect(giveFocusBack(opening, [], asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.row);
  });

  test("nothing left that takes it: false — Radix's own default stays", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.page.remove();
    expect(giveFocusBack(opening, asEls(p.pageMenu), asDoc(p.doc))).toBe(false);
    expect(p.doc.activeElement).toBe(p.doc.body);
  });

  test("never into another view: the routed page replaced, its main is not searched", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.page.remove();
    const next = p.main.add("div").add("button");
    expect(giveFocusBack(opening, [], asDoc(p.doc))).toBe(false);
    expect(p.doc.activeElement).toBe(p.doc.body);
    expect(next.focusCalls).toBe(0);
    expect(p.sidebarRow.focusCalls).toBe(0);
  });

  test("a focus the view placed elsewhere as the dialog closed is left there", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.row.focus();
    const calls = p.subfolder.focusCalls;
    expect(giveFocusBack(opening, asEls(p.pageMenu), asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.row);
    expect(p.subfolder.focusCalls).toBe(calls);
  });

  test("the focus nowhere when it opened (a shortcut): only the view's fallbacks", () => {
    const p = projectPage();
    const opening = captureOpening(asDoc(p.doc));
    expect(opening).toEqual({ origin: null, regions: [] });
    openAndClose(p.doc);
    expect(giveFocusBack(opening, asEls(p.pageMenu), asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(p.pageMenu);
  });

  test("the order: the opener, the view's fallbacks, then the nearest surviving control", () => {
    const p = projectPage();
    const opening: Opening = {
      origin: asEl(p.subfolder),
      regions: regionsOf(asEl(p.subfolder)),
    };
    expect(returnFocusOrder(opening, asEls(p.row))).toEqual(asEls(p.subfolder, p.row, p.subfolder));
    expect(returnFocusOrder(null, asEls(p.row))).toEqual(asEls(p.row));
  });
});

describe("a menu or popover item stands for its trigger — the item leaves with its layer", () => {
  function withMenu() {
    const p = projectPage();
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "page-menu" });
    const item = menu.add("div", { role: "menuitem", tabindex: "-1" });
    return { ...p, menu, item };
  }

  test("the opening is the trigger, and the focus goes back to it", () => {
    const m = withMenu();
    m.item.focus();
    const opening = captureOpening(asDoc(m.doc));
    expect(opening.origin).toBe(asEl(m.pageMenu));
    expect(opening.regions[0]).toBe(m.bar);
    m.menu.remove();
    openAndClose(m.doc);
    expect(giveFocusBack(opening, [], asDoc(m.doc))).toBe(true);
    expect(m.doc.activeElement).toBe(m.pageMenu);
  });

  test("up through a submenu, to the trigger of the first menu", () => {
    const m = withMenu();
    const sub = m.menu.add("div", { role: "menuitem", id: "sub-trigger", tabindex: "-1" });
    const submenu = m.doc.body.add("div", { role: "menu", "aria-labelledby": "sub-trigger" });
    const deep = submenu.add("div", { role: "menuitem", tabindex: "-1" });
    expect(sub.isConnected).toBe(true);
    expect(openerOf(deep as unknown as Element, asDoc(m.doc))).toBe(m.pageMenu);
  });

  test("a menu labelled by nothing outside it: the item stands for itself", () => {
    const m = withMenu();
    m.menu.attrs.set("aria-labelledby", "nowhere");
    expect(openerOf(m.item as unknown as Element, asDoc(m.doc))).toBe(m.item);
    const label = m.menu.add("span", { id: "inner-label" });
    m.menu.attrs.set("aria-labelledby", "inner-label");
    expect(label.isConnected).toBe(true);
    expect(openerOf(m.item as unknown as Element, asDoc(m.doc))).toBe(m.item);
  });

  test("a popover's item stands for the popover's trigger, by the pair the shared Popover stamps", () => {
    const p = projectPage();
    const chip = p.bar.add("button", { "data-popover-trigger": "«r7»" });
    p.bar.add("button", { "data-popover-trigger": "«r8»" });
    const popover = p.doc.body.add("div", { role: "dialog", "data-popover-of": "«r7»" });
    const footer = popover.add("button");
    footer.focus();
    const opening = captureOpening(asDoc(p.doc));
    expect(opening.origin).toBe(asEl(chip));
    popover.remove();
    openAndClose(p.doc);
    expect(giveFocusBack(opening, [], asDoc(p.doc))).toBe(true);
    expect(p.doc.activeElement).toBe(chip);
  });

  test("a menu inside a popover: up to the popover's trigger", () => {
    const p = projectPage();
    const chip = p.bar.add("button", { "data-popover-trigger": "«r9»" });
    const popover = p.doc.body.add("div", { "data-popover-of": "«r9»" });
    popover.add("button", { id: "inner-menu-trigger" });
    const menu = p.doc.body.add("div", { role: "menu", "aria-labelledby": "inner-menu-trigger" });
    const item = menu.add("div", { role: "menuitem", tabindex: "-1" });
    expect(openerOf(item as unknown as Element, asDoc(p.doc))).toBe(chip);
  });

  test("a popover whose trigger is not on the page: the item stands for itself", () => {
    const p = projectPage();
    const popover = p.doc.body.add("div", { "data-popover-of": "«gone»" });
    const footer = popover.add("button");
    expect(openerOf(footer as unknown as Element, asDoc(p.doc))).toBe(footer);
  });

  test("an element outside any menu stands for itself", () => {
    const p = projectPage();
    expect(openerOf(p.row as unknown as Element, asDoc(p.doc))).toBe(p.row);
    expect(openerOf(null, asDoc(p.doc))).toBeNull();
  });
});

describe("the parts of the page around the opener", () => {
  test("nearest first, up to — not including — the view's main, a sidebar, the body", () => {
    const p = projectPage();
    expect(regionsOf(asEl(p.subfolder))).toEqual([p.bar, p.page]);
    expect(regionsOf(asEl(p.sidebarRow))).toEqual([]);
    const portal = p.doc.body.add("div").add("div");
    const inPortal = portal.add("button");
    expect(regionsOf(asEl(inPortal))).toEqual([portal, portal.parentElement]);
    expect(regionsOf(null)).toEqual([]);
  });

  test("a part gone is passed over; a hidden control in a part still there too", () => {
    const p = projectPage();
    const regions = regionsOf(asEl(p.subfolder));
    p.subfolder.displayed = false;
    expect(nearestSurvivingControl(regions)).toBe(p.pageMenu);
    p.bar.remove();
    expect(nearestSurvivingControl(regions)).toBe(p.row);
    p.row.disabled = true;
    expect(nearestSurvivingControl(regions)).toBeNull();
  });
});

describe("the auto-focus handlers of the shared dialog contents", () => {
  test("opening: read before the view's own handler moves the focus", () => {
    const p = projectPage();
    p.subfolder.focus();
    const field = p.doc.body.add("input");
    const opening = openAutoFocus(new FakeEvent(), () => field.focus(), asDoc(p.doc));
    expect(opening.origin).toBe(asEl(p.subfolder));
    expect(p.doc.activeElement).toBe(field);
  });

  test("closing: a view handler that placed the focus itself is not overridden", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    const event = new FakeEvent();
    closeAutoFocus(event, opening, (e) => e.preventDefault(), undefined, asDoc(p.doc));
    expect(event.defaultPrevented).toBe(true);
    expect(p.doc.activeElement).toBe(p.doc.body);
  });

  test("closing: otherwise the rule, and Radix kept from moving it again", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.subfolder.displayed = false;
    const event = new FakeEvent();
    let ownCalled = false;
    closeAutoFocus(
      event,
      opening,
      () => {
        ownCalled = true;
      },
      () => asEls(p.pageMenu),
      asDoc(p.doc),
    );
    expect(ownCalled).toBe(true);
    expect(p.doc.activeElement).toBe(p.pageMenu);
    expect(event.defaultPrevented).toBe(true);
  });

  test("closing: nothing took it — Radix's default is left to run", () => {
    const p = projectPage();
    p.subfolder.focus();
    const opening = captureOpening(asDoc(p.doc));
    openAndClose(p.doc);
    p.page.remove();
    const event = new FakeEvent();
    closeAutoFocus(event, opening, undefined, () => asEls(p.pageMenu), asDoc(p.doc));
    expect(event.defaultPrevented).toBe(false);
  });
});
