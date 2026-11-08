// The focus handed back to the first element that REALLY takes it (lot 12).
//
// The tests run without a DOM, so the element below plays the DOM's part where it
// matters: its focus() fails SILENTLY — no error, no return value — on an element
// that has left the page, is disabled, inert or hidden, exactly like the
// browser's. Only the active element tells a focus that took from one that did
// not, and the walk must read it.

import { describe, expect, test } from "vitest";
import { pickerFocusOrder, type PickerFocusCandidate } from "../chat/quoteBlocks";
import { canTakeFocus, focusElement, focusFirst, type FocusCandidate } from "./focusFallback";

class FakeDocument {
  activeElement: unknown = null;
}

type State = {
  connected?: boolean;
  disabled?: boolean;
  inert?: boolean;
  displayed?: boolean;
  visible?: boolean;
  /** Seems able to, but does not end up holding the focus. */
  refuses?: boolean;
  /** Its tabIndex without a tabindex attribute: 0 for a control, -1 for a div. */
  natural?: number;
};

class FakeElement implements FocusCandidate {
  isConnected: boolean;
  disabled: boolean;
  inert: boolean;
  displayed: boolean;
  visible: boolean;
  refuses: boolean;
  focusCalls = 0;
  readonly attrs = new Map<string, string>();
  private readonly natural: number;
  private blurListeners: (() => void)[] = [];
  checkVisibility?: () => boolean = () => this.isConnected && this.displayed && this.visible;

  constructor(
    readonly name: string,
    readonly ownerDocument: FakeDocument,
    s: State = {},
  ) {
    this.isConnected = s.connected ?? true;
    this.disabled = s.disabled ?? false;
    this.inert = s.inert ?? false;
    this.displayed = s.displayed ?? true;
    this.visible = s.visible ?? true;
    this.refuses = s.refuses ?? false;
    this.natural = s.natural ?? 0;
  }

  get tabIndex(): number {
    const own = this.attrs.get("tabindex");
    return own === undefined ? this.natural : Number(own);
  }

  matches(selectors: string): boolean {
    return selectors
      .split(",")
      .map((s) => s.trim())
      .some(
        (s) =>
          (s === ":disabled" && this.disabled) ||
          (s === '[aria-disabled="true"]' && this.attrs.get("aria-disabled") === "true"),
      );
  }

  closest(selectors: string): unknown {
    return selectors === "[inert]" && this.inert ? {} : null;
  }

  getClientRects(): { length: number } {
    return { length: this.isConnected && this.displayed ? 1 : 0 };
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

  addEventListener(_type: "blur", listener: () => void): void {
    this.blurListeners.push(listener);
  }

  /** The DOM's focus(): silently nothing unless the element can be focused. */
  focus(): void {
    this.focusCalls += 1;
    const focusable =
      this.isConnected &&
      !this.disabled &&
      !this.inert &&
      this.displayed &&
      this.visible &&
      !this.refuses &&
      (this.attrs.has("tabindex") || this.natural >= 0);
    if (!focusable || this.ownerDocument.activeElement === this) return;
    const previous = this.ownerDocument.activeElement;
    if (previous instanceof FakeElement) previous.blur();
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    const listeners = this.blurListeners;
    this.blurListeners = [];
    for (const listener of listeners) listener();
  }
}

const page = () => {
  const doc = new FakeDocument();
  return { doc, el: (name: string, s?: State) => new FakeElement(name, doc, s) };
};

describe("what may take the focus (lot 12)", () => {
  const { el } = page();

  test("an element on the page, enabled, rendered and visible may", () => {
    expect(canTakeFocus(el("button"))).toBe(true);
  });

  test("one that has left the page may not", () => {
    expect(canTakeFocus(el("gone", { connected: false }))).toBe(false);
  });

  test("a disabled control may not — the composer of a read-only chat", () => {
    expect(canTakeFocus(el("composer", { disabled: true }))).toBe(false);
  });

  test("one announced as disabled may not, though the browser would focus it", () => {
    const button = el("button");
    button.setAttribute("aria-disabled", "true");
    expect(canTakeFocus(button)).toBe(false);
  });

  test("one inside something inert may not", () => {
    expect(canTakeFocus(el("button", { inert: true }))).toBe(false);
  });

  test("one without a box may not: display none, on it or an ancestor", () => {
    expect(canTakeFocus(el("button", { displayed: false }))).toBe(false);
  });

  test("one hidden by its visibility may not", () => {
    expect(canTakeFocus(el("button", { visible: false }))).toBe(false);
  });

  test("an engine without checkVisibility still passes over an element without a box", () => {
    const button = el("button", { displayed: false });
    button.checkVisibility = undefined;
    expect(canTakeFocus(button)).toBe(false);
  });
});

describe("a tabindex borrowed for one focus", () => {
  test("the reply, not focusable by itself, takes the focus and gives the tabindex back on blur", () => {
    const { el } = page();
    const reply = el("reply", { natural: -1 });
    focusElement(reply);
    expect(reply.ownerDocument.activeElement).toBe(reply);
    expect(reply.attrs.get("tabindex")).toBe("-1");
    el("elsewhere").focus();
    expect(reply.hasAttribute("tabindex")).toBe(false);
  });

  test("a focus that did not take gives the tabindex back at once", () => {
    const { el } = page();
    const reply = el("reply", { natural: -1, refuses: true });
    focusElement(reply);
    expect(reply.ownerDocument.activeElement).toBe(null);
    expect(reply.hasAttribute("tabindex")).toBe(false);
  });

  test("an element focusable by itself borrows nothing, and one with its own tabindex keeps it", () => {
    const { el } = page();
    const button = el("button");
    focusElement(button);
    expect(button.hasAttribute("tabindex")).toBe(false);
    const own = el("own", { natural: -1 });
    own.setAttribute("tabindex", "0");
    focusElement(own);
    el("elsewhere").focus();
    expect(own.attrs.get("tabindex")).toBe("0");
  });
});

describe("the first candidate that REALLY holds the focus", () => {
  test("offered in order: the first that takes it wins, the others are not asked", () => {
    const { el } = page();
    const [a, b] = [el("a"), el("b")];
    expect(focusFirst([a, b])).toBe(a);
    expect(b.focusCalls).toBe(0);
  });

  test("a candidate not found (null, undefined) is passed over", () => {
    const { el } = page();
    const b = el("b");
    expect(focusFirst([null, undefined, b])).toBe(b);
  });

  test("one that cannot take it is not even offered it", () => {
    const { el } = page();
    const disabled = el("composer", { disabled: true });
    const b = el("b");
    expect(focusFirst([disabled, b])).toBe(b);
    expect(disabled.focusCalls).toBe(0);
  });

  test("one that seems able but does not end up holding it is passed over: the active element decides", () => {
    const { el } = page();
    const refuses = el("refuses", { refuses: true });
    const b = el("b");
    expect(focusFirst([refuses, b])).toBe(b);
    expect(refuses.focusCalls).toBe(1);
  });

  test("an engine without checkVisibility: a hidden candidate looks able, the active element still decides", () => {
    const { el } = page();
    const hidden = el("hidden", { visible: false });
    hidden.checkVisibility = undefined;
    expect(canTakeFocus(hidden)).toBe(true);
    const b = el("b");
    expect(focusFirst([hidden, b])).toBe(b);
  });

  test("none: null, the focus left where it was, and no tabindex left behind", () => {
    const { doc, el } = page();
    const before = el("before");
    before.focus();
    const reply = el("reply", { natural: -1, refuses: true });
    expect(focusFirst([el("composer", { disabled: true }), reply])).toBe(null);
    expect(doc.activeElement).toBe(before);
    expect(reply.hasAttribute("tabindex")).toBe(false);
  });

  test("a candidate listed twice is offered the focus once", () => {
    const { el } = page();
    const refuses = el("refuses", { refuses: true });
    expect(focusFirst([refuses, refuses])).toBe(null);
    expect(refuses.focusCalls).toBe(1);
  });
});

describe("the block pickers' one fallback, end to end (lot 12)", () => {
  type Elements = Record<PickerFocusCandidate, FakeElement | null>;
  const close = (quotePicked: boolean, els: Elements) =>
    focusFirst(pickerFocusOrder(quotePicked).map((c) => els[c]))?.name ?? null;
  const chat = (o: { composer?: State; trigger?: State | null; message?: State | null } = {}) => {
    const { el } = page();
    return {
      composer: el("composer", o.composer),
      trigger: o.trigger === null ? null : el("trigger", o.trigger),
      message: o.message === null ? null : el("message", { natural: -1, ...o.message }),
    };
  };

  test("a quote picked goes on to the composer when it can take the focus", () => {
    expect(close(true, chat())).toBe("composer");
  });

  test("a quote picked in a read-only chat: the disabled composer is passed over, the ⋯ takes it", () => {
    expect(close(true, chat({ composer: { disabled: true } }))).toBe("trigger");
  });

  test("…and with the older reply's ⋯ gone with its action bar: the reply itself", () => {
    const els = chat({ composer: { disabled: true }, trigger: null });
    expect(close(true, els)).toBe("message");
    expect(els.message?.attrs.get("tabindex")).toBe("-1");
  });

  test("a bookmark, or Escape: back to the ⋯ — and to the reply when it is gone or hidden", () => {
    expect(close(false, chat())).toBe("trigger");
    expect(close(false, chat({ trigger: null }))).toBe("message");
    expect(close(false, chat({ trigger: { displayed: false } }))).toBe("message");
    expect(close(false, chat({ trigger: { connected: false } }))).toBe("message");
  });

  test("the reply comes before the composer, even an enabled one", () => {
    expect(close(false, chat({ trigger: null }))).toBe("message");
  });

  test("the reply gone too: the composer, when it can take the focus", () => {
    expect(close(false, chat({ trigger: null, message: { connected: false } }))).toBe("composer");
  });

  test("nothing left that can take it: null — the focus is Radix's to place", () => {
    const els = chat({ composer: { disabled: true }, trigger: null, message: { connected: false } });
    expect(close(false, els)).toBe(null);
    expect(close(true, els)).toBe(null);
  });
});
