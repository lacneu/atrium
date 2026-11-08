// THE FOCUS NEVER FALLS ON THE PAGE WHEN A BAR OVERLAY LOSES ITS TRIGGER (lot 14).
//
// The composer's measured bar moves its controls into the "More" menu and back. A
// menu or popover anchored on one of them can close — or shed the item that held
// the focus — when its trigger has just become `display: none`: Radix then tried
// that hidden trigger and the focus fell on the page. Every overlay anchored on a
// movable bar control, and the More menu itself, gives the focus back through
// `restoreComposerFocus` — read from the syntax tree, for every such overlay in
// src/chat; the helper's own choices are tested on fakes below.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import type { FocusCandidate } from "@/lib/focusFallback";
import { barControl, restoreComposerFocus } from "./composerFocus";

const CHAT = join(process.cwd(), "src/chat");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
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

const tag = (e: ts.JsxElement) => e.openingElement.tagName.getText();
const attr = (opening: ts.JsxOpeningLikeElement, name: string) =>
  opening.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );

type Overlay = { where: string; trigger: string; content: ts.JsxElement | undefined };

/** Every Popover / DropdownMenu whose trigger is a movable bar control (it carries
 *  `data-overflow`) or the More button itself. */
const OVERLAYS: Overlay[] = walk(CHAT).flatMap((file) => {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const where = relative(process.cwd(), file);
  return find(sf, ts.isJsxElement)
    .filter((e) => tag(e) === "Popover" || tag(e) === "DropdownMenu")
    .flatMap((root) => {
      const trigger = find(root, ts.isJsxElement).find((e) => /Trigger$/.test(tag(e)));
      if (trigger === undefined) return [];
      const button = find(trigger, ts.isJsxOpeningElement).find((o) => o !== trigger.openingElement);
      if (button === undefined) return [];
      const overflow = attr(button, "data-overflow")?.initializer?.getText().replace(/"/g, "");
      const more = /oc-composer__more\b/.test(attr(button, "className")?.initializer?.getText() ?? "");
      if (overflow === undefined && !more) return [];
      const content = find(root, ts.isJsxElement).find((e) => /Content$/.test(tag(e)));
      return [{ where, trigger: more ? "more" : (overflow ?? "?"), content }];
    });
});

describe("every overlay anchored in the composer's bar gives the focus back safely (lot 14)", () => {
  test("the overlays are all found: More, permissions, Talk settings, the room's settings", () => {
    expect(OVERLAYS.map((o) => o.trigger).sort()).toEqual(["more", "perm", "room-settings", "talk-settings"]);
  });

  test.each(OVERLAYS.map((o) => [o.trigger, o] as const))("%s", (_name, o) => {
    expect(o.content, `${o.where}: no content`).toBeDefined();
    const close = attr(o.content!.openingElement, "onCloseAutoFocus");
    expect(close, `${o.where}: no onCloseAutoFocus`).toBeDefined();
    const calls = find(close!, ts.isCallExpression);
    const restore = calls.find((c) => c.expression.getText() === "restoreComposerFocus");
    expect(restore, `${o.where}: the close does not go through restoreComposerFocus`).toBeDefined();
    // Its own trigger first (Radix's default while it is there), then the fallbacks.
    const list = restore!.arguments[0];
    expect(ts.isArrayLiteralExpression(list)).toBe(true);
    const order = (list as ts.ArrayLiteralExpression).elements.map((e) => e.getText());
    expect(order[0]).toMatch(/[Tt]riggerRef\.current/);
    expect(order[order.length - 1]).toBe("field");
    expect(order.length).toBe(3);
    // …and Radix kept from moving it again only when one candidate took it.
    const guarded = find(close!, ts.isIfStatement).some(
      (i) => i.expression === restore && /preventDefault/.test(i.thenStatement.getText()),
    );
    expect(guarded, `${o.where}: preventDefault not conditioned on the restore`).toBe(true);
  });
});

describe("the More menu follows a control back to the bar (lot 14)", () => {
  const file = join(CHAT, "ComposerMoreMenu.tsx");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  test("every item carries the key of the control it stands for", () => {
    const fn = find(sf, ts.isArrowFunction).find(
      (f) => f.parent !== undefined && ts.isVariableDeclaration(f.parent) && f.parent.name.getText() === "item",
    );
    expect(fn, "no item()").toBeDefined();
    const roots = find(fn!, ts.isReturnStatement)
      .map((r) => r.expression)
      .flatMap((e) => (e !== undefined && ts.isConditionalExpression(e) ? [e.whenTrue, e.whenFalse] : [e]))
      .map((e) => (e !== undefined && ts.isParenthesizedExpression(e) ? e.expression : e))
      .filter((e): e is ts.JsxElement | ts.JsxSelfClosingElement => e !== undefined && (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)));
    expect(roots.length).toBeGreaterThanOrEqual(8);
    for (const root of roots) {
      const opening = ts.isJsxElement(root) ? root.openingElement : root;
      expect(attr(opening, "data-more-key"), root.getText().slice(0, 60)).toBeDefined();
    }
  });

  test("when the focused item leaves the menu, its control takes the focus, then the field", () => {
    const effect = find(sf, ts.isCallExpression).find(
      (c) => c.expression.getText() === "useLayoutEffect" && /restoreComposerFocus/.test(c.getText()),
    );
    expect(effect, "no layout effect restoring the focus").toBeDefined();
    const restore = find(effect!, ts.isCallExpression).find((c) => c.expression.getText() === "restoreComposerFocus")!;
    expect(restore.arguments[0].getText()).toBe("[barControl(bar, key), field]");
    expect(effect!.arguments[1]?.getText()).toBe("[movedKey]");
  });
});

// ---- the helper, on fakes ---------------------------------------------------------

class FakeDoc {
  activeElement: unknown = null;
  body = { isConnected: true };
}

class FakeEl implements FocusCandidate {
  isConnected = true;
  tabIndex: number;
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  constructor(
    readonly ownerDocument: FakeDoc,
    readonly name: string,
    tabIndex = 0,
  ) {
    this.tabIndex = tabIndex;
  }
  matches() {
    return false;
  }
  closest() {
    return null;
  }
  getClientRects() {
    return { length: 1 };
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  addEventListener() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  querySelector(selector: string): FakeEl | null {
    const key = /data-overflow="([^"]+)"/.exec(selector)?.[1];
    if (key !== undefined) return this.children.find((c) => c.attrs.get("data-overflow") === key) ?? null;
    return this.children.find((c) => c.tabIndex >= 0) ?? null;
  }
}

describe("restoreComposerFocus and barControl, on fakes (lot 14)", () => {
  test("a focus already placed by the user is left alone", () => {
    const doc = new FakeDoc();
    const field = new FakeEl(doc, "field");
    const typed = new FakeEl(doc, "elsewhere");
    doc.activeElement = typed;
    expect(restoreComposerFocus([field as unknown as HTMLElement], doc as unknown as Document)).toBe(false);
    expect(doc.activeElement).toBe(typed);
  });

  test("a focus fallen on the page goes to the first candidate that takes it", () => {
    const doc = new FakeDoc();
    doc.activeElement = doc.body;
    const field = new FakeEl(doc, "field");
    expect(restoreComposerFocus([null, field as unknown as HTMLElement], doc as unknown as Document)).toBe(true);
    expect(doc.activeElement).toBe(field);
  });

  test("a More item's control: the control itself, or its first focusable part (a pill)", () => {
    const doc = new FakeDoc();
    const bar = new FakeEl(doc, "bar", -1);
    const hold = new FakeEl(doc, "hold");
    hold.attrs.set("data-overflow", "hold");
    const pill = new FakeEl(doc, "talk pill", -1);
    pill.attrs.set("data-overflow", "talk");
    const start = new FakeEl(doc, "start");
    pill.children.push(start);
    bar.children.push(hold, pill);
    const asBar = bar as unknown as Element;
    expect((barControl(asBar, "hold") as unknown as FakeEl).name).toBe("hold");
    expect((barControl(asBar, "talk") as unknown as FakeEl).name).toBe("start");
    expect(barControl(asBar, "mic")).toBe(null);
    expect(barControl(null, "hold")).toBe(null);
  });
});
