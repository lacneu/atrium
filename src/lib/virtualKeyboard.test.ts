// The height the iOS keyboard covers (virtualKeyboard.ts) — what the shell, the
// full-page prompt and the dialogs subtract so their bottom stays in sight.
import { describe, expect, test } from "vitest";
import {
  installKeyboardInset,
  keyboardInset,
  visibleBottomInset,
  visibleLeftInset,
  visibleRect,
  visibleTopInset,
} from "./virtualKeyboard";

describe("keyboardInset", () => {
  test("iOS, keyboard open: the layout keeps its height, the visual one shrinks", () => {
    // iPhone 15 portrait: 844 px layout, a 336 px keyboard.
    expect(keyboardInset(844, 508, 0, 1)).toBe(336);
  });
  test("the page scrolled under the keyboard (offsetTop) is not counted twice", () => {
    expect(keyboardInset(844, 508, 120, 1)).toBe(216);
  });
  test("Android with resizes-content, or no keyboard: nothing to subtract", () => {
    expect(keyboardInset(508, 508, 0, 1)).toBe(0);
    expect(keyboardInset(844, 844, 0, 1)).toBe(0);
  });
  test("a pinch-zoomed page is the reader zooming, not a keyboard", () => {
    expect(keyboardInset(844, 422, 0, 2)).toBe(0);
  });
  test("never negative (rounding, browser bars)", () => {
    expect(keyboardInset(844, 846, 0, 1)).toBe(0);
  });
});

// Lot 19: what is on screen is a rectangle — iOS scrolls the visual viewport down
// to reveal a field (offsetTop). The case of the review: an 844 px layout, 508 px
// on screen from 120 px down: 216 px of keyboard at the bottom, 120 px out of
// sight at the top.
describe("visibleTopInset", () => {
  test("the visual viewport scrolled down to reveal a field: its offset is the top inset", () => {
    expect(visibleTopInset(120, 1)).toBe(120);
    expect(keyboardInset(844, 508, 120, 1)).toBe(216);
  });
  test("not scrolled, or rounding below zero: nothing hidden at the top", () => {
    expect(visibleTopInset(0, 1)).toBe(0);
    expect(visibleTopInset(-0.4, 1)).toBe(0);
  });
  test("a pinch-zoomed page: the reader pans, nothing to fit — 0, like the keyboard", () => {
    expect(visibleTopInset(300, 2)).toBe(0);
    expect(keyboardInset(844, 300, 300, 2)).toBe(0);
  });
});

// Lot 25: the left edge too — a page wider than the screen (the chat page from the
// text scale xl at 360 px) is panned sideways, and a dialog centred on the layout
// viewport would sit off what is shown.
describe("visibleLeftInset", () => {
  test("a page panned sideways: its offset is the left inset", () => {
    expect(visibleLeftInset(48, 1)).toBe(48);
    expect(visibleLeftInset(47.6, 1)).toBe(48);
  });
  test("not panned, or rounding below zero: nothing hidden on the left", () => {
    expect(visibleLeftInset(0, 1)).toBe(0);
    expect(visibleLeftInset(-0.4, 1)).toBe(0);
  });
  test("a pinch-zoomed page: the reader pans, nothing to fit — 0, like the top", () => {
    expect(visibleLeftInset(200, 2)).toBe(0);
  });
});

describe("installKeyboardInset", () => {
  test("writes --oc-kb from the visual viewport and follows its resizes", () => {
    const listeners: Record<string, () => void> = {};
    const props = new Map<string, string>();
    const vv = {
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener: (k: string, f: () => void) => (listeners[k] = f),
      removeEventListener: (k: string) => delete listeners[k],
    };
    const win = {
      innerHeight: 844,
      visualViewport: vv,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getComputedStyle: () => ({ fontSize: "16px" }),
      document: {
        body: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        documentElement: {
          clientHeight: 844,
          style: {
            setProperty: (k: string, v: string) => props.set(k, v),
            removeProperty: (k: string) => props.delete(k),
          },
        },
      },
    } as unknown as Window & typeof globalThis;
    const undo = installKeyboardInset(win);
    expect(props.get("--oc-kb")).toBe("0px");
    expect(props.get("--oc-vv-top")).toBe("0px");
    vv.height = 508;
    listeners.resize();
    expect(props.get("--oc-kb")).toBe("336px");
    // iOS scrolls the visual viewport to reveal a field: both edges follow.
    vv.offsetTop = 120;
    listeners.scroll();
    expect(props.get("--oc-kb")).toBe("216px");
    expect(props.get("--oc-vv-top")).toBe("120px");
    // Scrolled further while the keyboard stays: only the top moves — written too.
    vv.offsetTop = 200;
    vv.height = 428;
    listeners.scroll();
    expect(props.get("--oc-kb")).toBe("216px");
    expect(props.get("--oc-vv-top")).toBe("200px");
    expect(props.get("--oc-vv-left")).toBe("0px");
    // A page wider than the screen, panned sideways: only the left edge moves.
    vv.offsetLeft = 48;
    listeners.scroll();
    expect(props.get("--oc-vv-left")).toBe("48px");
    expect(props.get("--oc-vv-top")).toBe("200px");
    undo();
    expect(props.has("--oc-kb")).toBe(false);
    expect(props.has("--oc-vv-top")).toBe(false);
    expect(props.has("--oc-vv-left")).toBe(false);
    expect(Object.keys(listeners)).toEqual([]);
  });
  test("no visualViewport (old browser): nothing installed", () => {
    const win = { visualViewport: null } as unknown as Window & typeof globalThis;
    expect(() => installKeyboardInset(win)()).not.toThrow();
  });
});

// Lot 26: a page wider than the screen grows Chrome's LAYOUT viewport (442 x 909
// for a 360 x 740 phone), never the initial containing block (`clientHeight` 740).
// Read off the layout viewport, the keyboard was 169 px with none open — 1 030 px
// with a long account name under the largest text scale, the shell shrunk to
// nothing. The keyboard comes from the initial containing block; what lies below
// what is shown in the layout viewport — where a fixed layer's bottom edge goes — is
// a height of its own.
describe("a page wider than the screen is no keyboard", () => {
  test("no keyboard on a widened page: 0, whatever the layout viewport", () => {
    expect(keyboardInset(740, 740, 0, 1)).toBe(0);
    expect(visibleBottomInset(909, 740, 0, 1)).toBe(169);
  });
  test("a keyboard on a widened page: its own height, and the layers stand above both", () => {
    expect(keyboardInset(740, 404, 0, 1)).toBe(336);
    expect(visibleBottomInset(909, 404, 0, 1)).toBe(505);
  });
  test("iOS, lot 19: the visual viewport scrolled down to reveal a field, keyboard open", () => {
    // An 844 px screen, 508 px shown from 120 px down: 216 px of keyboard at the
    // bottom, and the layers' bottom edge as far up.
    expect(keyboardInset(844, 508, 120, 1)).toBe(216);
    expect(visibleBottomInset(844, 508, 120, 1)).toBe(216);
    expect(visibleTopInset(120, 1)).toBe(120);
  });
  test("Android resizes the layout with its keyboard: nothing below what is shown", () => {
    expect(keyboardInset(404, 404, 0, 1)).toBe(0);
    expect(visibleBottomInset(404, 404, 0, 1)).toBe(0);
  });
  test("a zoomed page is the reader zooming: nothing to stand off", () => {
    expect(visibleBottomInset(909, 300, 200, 2)).toBe(0);
  });
});

/** A window to install the inset on: its geometry, and every listener, observer
 *  and timer it is given, to fire by hand. */
function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const docListeners = new Map<string, () => void>();
  const vvListeners = new Map<string, () => void>();
  const props = new Map<string, string>();
  const timers: Array<() => void> = [];
  let fontSize = "16px";
  let mutation: (() => void) | null = null;
  let resize: (() => void) | null = null;
  const observed: unknown[] = [];
  const appended: Array<{ remove: () => void; style: Record<string, string>; attrs: Map<string, string> }> = [];
  const disconnected: string[] = [];
  const vv = {
    width: 360,
    height: 740,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: (k: string, f: () => void) => vvListeners.set(k, f),
    removeEventListener: (k: string) => vvListeners.delete(k),
  };
  const root = {
    clientWidth: 360,
    clientHeight: 740,
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
  };
  const win = {
    innerWidth: 360,
    innerHeight: 740,
    visualViewport: vv,
    addEventListener: (k: string, f: () => void) => listeners.set(k, f),
    removeEventListener: (k: string) => listeners.delete(k),
    setTimeout: (f: () => void) => timers.push(f),
    getComputedStyle: () => ({ fontSize }),
    MutationObserver: class {
      constructor(cb: () => void) {
        mutation = cb;
      }
      observe(target: unknown) {
        observed.push(target);
      }
      disconnect() {
        disconnected.push("mutation");
      }
    },
    ResizeObserver: class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(target: unknown) {
        observed.push(target);
        // Only an observed element's size reaches the callback.
        resize = this.cb;
      }
      disconnect() {
        disconnected.push("resize");
      }
    },
    document: {
      documentElement: root,
      addEventListener: (k: string, f: () => void) => docListeners.set(k, f),
      removeEventListener: (k: string) => docListeners.delete(k),
      createElement: () => {
        const attrs = new Map<string, string>();
        const el = {
          style: {} as Record<string, string>,
          attrs,
          setAttribute: (k: string, v: string) => attrs.set(k, v),
          remove: () => {
            const i = appended.indexOf(el);
            if (i >= 0) appended.splice(i, 1);
          },
        };
        return el;
      },
      body: {
        appendChild: (el: (typeof appended)[number]) => appended.push(el),
      },
    },
  };
  return {
    win: win as unknown as Window & typeof globalThis,
    raw: win,
    vv,
    root,
    props,
    listeners,
    docListeners,
    vvListeners,
    timers,
    observed,
    appended,
    disconnected,
    setFontSize: (f: string) => {
      fontSize = f;
    },
    fireMutation: () => mutation?.(),
    fireResize: () => resize?.(),
  };
}

describe("installKeyboardInset, lot 26: two heights, never stale", () => {
  test("a widened page without a keyboard: no keyboard, the layers' bottom above the grown viewport", () => {
    const w = fakeWindow();
    w.raw.innerWidth = 442;
    w.raw.innerHeight = 909;
    installKeyboardInset(w.win);
    expect(w.props.get("--oc-kb")).toBe("0px");
    expect(w.props.get("--oc-vv-bottom")).toBe("169px");
  });

  test("iOS, lot 19: a keyboard, the visual viewport scrolled down — both heights the keyboard's", () => {
    const w = fakeWindow();
    w.root.clientHeight = 844;
    w.raw.innerHeight = 844;
    installKeyboardInset(w.win);
    w.vv.height = 508;
    w.vv.offsetTop = 120;
    w.vvListeners.get("scroll")!();
    expect(w.props.get("--oc-kb")).toBe("216px");
    expect(w.props.get("--oc-vv-bottom")).toBe("216px");
    expect(w.props.get("--oc-vv-top")).toBe("120px");
  });

  test("the page widens and narrows with no event of its own: the sentinel's size reads it again", () => {
    const w = fakeWindow();
    installKeyboardInset(w.win);
    // The sentinel spans the layout viewport and is the one element observed for size.
    expect(w.appended).toHaveLength(1);
    expect(w.observed).toContain(w.appended[0]);
    expect(w.appended[0].style).toMatchObject({ position: "fixed", inset: "0", visibility: "hidden", pointerEvents: "none" });
    expect(w.appended[0].attrs.get("aria-hidden")).toBe("true");
    w.raw.innerHeight = 909;
    w.fireResize();
    expect(w.props.get("--oc-vv-bottom")).toBe("169px");
    expect(w.props.get("--oc-kb")).toBe("0px");
    // Back to the screen's width: never left at the old value.
    w.raw.innerHeight = 740;
    w.fireResize();
    expect(w.props.get("--oc-vv-bottom")).toBe("0px");
  });

  test("a resize, a focus moving in or out: read again", () => {
    const w = fakeWindow();
    installKeyboardInset(w.win);
    w.raw.innerHeight = 909;
    w.listeners.get("resize")!();
    expect(w.props.get("--oc-vv-bottom")).toBe("169px");
    w.raw.innerHeight = 800;
    w.docListeners.get("focusin")!();
    expect(w.props.get("--oc-vv-bottom")).toBe("60px");
    w.raw.innerHeight = 740;
    w.docListeners.get("focusout")!();
    expect(w.props.get("--oc-vv-bottom")).toBe("0px");
  });

  test("the text scale changes: read now, and once more when the page has settled", () => {
    const w = fakeWindow();
    installKeyboardInset(w.win);
    // The inset's own writes land on the root's style too: no font size change, no read.
    w.raw.innerHeight = 909;
    w.fireMutation();
    expect(w.props.get("--oc-vv-bottom")).toBe("0px");
    expect(w.timers).toHaveLength(0);
    // The root's font size changes: read at once…
    w.setFontSize("24px");
    w.fireMutation();
    expect(w.props.get("--oc-vv-bottom")).toBe("169px");
    // …and again after the measured bars have shed detail (the page narrowed back).
    expect(w.timers).toHaveLength(1);
    w.raw.innerHeight = 740;
    w.timers[0]();
    expect(w.props.get("--oc-vv-bottom")).toBe("0px");
  });

  test("undo: every listener, both observers and the sentinel go, every property is removed", () => {
    const w = fakeWindow();
    const undo = installKeyboardInset(w.win);
    undo();
    expect([...w.listeners.keys()]).toEqual([]);
    expect([...w.docListeners.keys()]).toEqual([]);
    expect([...w.vvListeners.keys()]).toEqual([]);
    expect(w.disconnected.sort()).toEqual(["mutation", "resize"]);
    expect(w.appended).toHaveLength(0);
    for (const k of ["--oc-kb", "--oc-vv-top", "--oc-vv-left", "--oc-vv-bottom"]) {
      expect(w.props.has(k), k).toBe(false);
    }
  });
});

describe("visibleRect (lot 26): what is shown, where a fixed box is placed", () => {
  test("the visual viewport, panned or not", () => {
    const w = fakeWindow();
    expect(visibleRect(w.win)).toEqual({ x: 0, y: 0, w: 360, h: 740 });
    w.vv.offsetLeft = 82.4;
    w.vv.offsetTop = 30;
    expect(visibleRect(w.win)).toEqual({ x: 82, y: 30, w: 360, h: 740 });
  });
  test("a reader zooming in: the screen, nothing chases the zoom", () => {
    const w = fakeWindow();
    w.vv.scale = 2;
    w.vv.width = 180;
    w.vv.height = 370;
    w.vv.offsetLeft = 100;
    expect(visibleRect(w.win)).toEqual({ x: 0, y: 0, w: 360, h: 740 });
  });
});

describe("the layout viewport's height, to the fraction (lot 26)", () => {
  test("rounded up: a bottom edge stands at what is shown or above, never below", () => {
    expect(visibleBottomInset(909.3, 740, 0, 1)).toBe(170);
    expect(visibleBottomInset(909, 740, 0, 1)).toBe(169);
  });
  test("read off the sentinel's box, not the rounded innerHeight", () => {
    const w = fakeWindow();
    w.raw.innerHeight = 909;
    // The sentinel the inset appends spans the layout viewport: 909.67 px tall.
    const create = w.raw.document.createElement;
    w.raw.document.createElement = () => Object.assign(create(), { getBoundingClientRect: () => ({ height: 909.67 }) });
    installKeyboardInset(w.win);
    expect(w.props.get("--oc-vv-bottom")).toBe("170px");
  });
});
