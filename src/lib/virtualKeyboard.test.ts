// The height the iOS keyboard covers (virtualKeyboard.ts) — what the shell, the
// full-page prompt and the dialogs subtract so their bottom stays in sight.
import { describe, expect, test } from "vitest";
import { installKeyboardInset, keyboardInset } from "./virtualKeyboard";

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

describe("installKeyboardInset", () => {
  test("writes --oc-kb from the visual viewport and follows its resizes", () => {
    const listeners: Record<string, () => void> = {};
    const props = new Map<string, string>();
    const vv = {
      height: 844,
      offsetTop: 0,
      scale: 1,
      addEventListener: (k: string, f: () => void) => (listeners[k] = f),
      removeEventListener: (k: string) => delete listeners[k],
    };
    const win = {
      innerHeight: 844,
      visualViewport: vv,
      document: {
        documentElement: {
          style: {
            setProperty: (k: string, v: string) => props.set(k, v),
            removeProperty: (k: string) => props.delete(k),
          },
        },
      },
    } as unknown as Window;
    const undo = installKeyboardInset(win);
    expect(props.get("--oc-kb")).toBe("0px");
    vv.height = 508;
    listeners.resize();
    expect(props.get("--oc-kb")).toBe("336px");
    undo();
    expect(props.has("--oc-kb")).toBe(false);
    expect(Object.keys(listeners)).toEqual([]);
  });
  test("no visualViewport (old browser): nothing installed", () => {
    const win = { visualViewport: null } as unknown as Window;
    expect(() => installKeyboardInset(win)()).not.toThrow();
  });
});
