// A BUBBLE READ THROUGH A SWAPPED THREAD STORE (0.103.1). Switching conversation while a
// turn streams made assistant-ui throw "useClientLookup: Index 11 out of bounds (length:
// 1)" from a bubble of the conversation being left (prod: the "Une erreur est survenue"
// page instead of the conversation clicked; reproduced locally on 0.103.0 AND 0.102.1).
// Each bubble now sits behind TornMessageBoundary: a torn read hides that bubble for a
// moment instead of taking the page down; any other error still reaches the route
// boundary. The boundary is driven here through React's own error-boundary protocol
// (getDerivedStateFromError → render → componentDidCatch), state applied synchronously.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  TORN_RETRY_LIMIT,
  TornMessageBoundary,
  isTornLookupError,
  tornDecision,
} from "./TornMessageBoundary";

const torn = () => new Error("useClientLookup: Index 11 out of bounds (length: 1)");

/** A mounted boundary whose setState applies at once (what React does between renders). */
function mount() {
  const child = createElement("span", null, "bulle");
  const b = new TornMessageBoundary({ children: child });
  (b as unknown as { updater: unknown }).updater = {
    isMounted: () => true,
    enqueueSetState: (inst: TornMessageBoundary, partial: unknown) => {
      const next =
        typeof partial === "function"
          ? (partial as (s: typeof inst.state) => object)(inst.state)
          : (partial as object);
      const prev = inst.state;
      inst.state = { ...inst.state, ...next };
      inst.componentDidUpdate?.(inst.props, prev);
    },
    enqueueReplaceState: () => {},
    enqueueForceUpdate: () => {},
  };
  /** React catching `error` thrown below: derive state, render, then commit the catch. */
  const throwBelow = (error: unknown) => {
    b.state = { ...b.state, ...TornMessageBoundary.getDerivedStateFromError(error) };
    const out = b.render(); // throws when the boundary lets it through
    b.componentDidCatch(error);
    return out;
  };
  return { b, child, throwBelow };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("which errors are a torn read", () => {
  it("recognizes assistant-ui's two lookup failures, and nothing else", () => {
    expect(isTornLookupError(torn())).toBe(true);
    expect(isTornLookupError(new Error('useClientLookup: Key "p3" not found'))).toBe(true);
    expect(isTornLookupError(new Error("Forbidden: chat not owned by user"))).toBe(false);
    expect(isTornLookupError("useClientLookup: Index 1 out of bounds")).toBe(false);
    expect(tornDecision(torn(), 1)).toBe("retry");
    expect(tornDecision(new TypeError("x is undefined"), 1)).toBe("rethrow");
  });
});

describe("a bubble that read a store swapped under it", () => {
  it("renders nothing for that moment instead of taking the page down", () => {
    const { throwBelow } = mount();
    let out: unknown = "unset";
    expect(() => {
      out = throwBelow(torn());
    }).not.toThrow();
    expect(out).toBeNull();
  });

  it("comes back on its own when the store holds it again", () => {
    const { b, child, throwBelow } = mount();
    expect(throwBelow(torn())).toBeNull();
    vi.runOnlyPendingTimers();
    expect(b.state.error).toBeNull();
    expect(b.render()).toBe(child);
  });

  it("forgets past tears once the bubble renders again for a while", () => {
    const { b, throwBelow } = mount();
    throwBelow(torn());
    vi.runOnlyPendingTimers(); // retry renders
    vi.advanceTimersByTime(1_000);
    expect(b.state.tears).toBe(0);
  });

  it("lets a read that keeps failing through to the route boundary (bounded)", () => {
    const { b, throwBelow } = mount();
    // Every retry tears again: hidden and retried up to the budget…
    for (let i = 0; i < TORN_RETRY_LIMIT; i++) {
      expect(throwBelow(torn())).toBeNull();
      vi.runOnlyPendingTimers();
    }
    // …then the next tear is counted past it: no retry, and the render that follows
    // rethrows to the route boundary instead of hiding the bubble for ever.
    expect(throwBelow(torn())).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => b.render()).toThrow(/out of bounds/);
  });

  it("never swallows any other error", () => {
    const { throwBelow } = mount();
    expect(() => throwBelow(new Error("Forbidden: chat not owned by user"))).toThrow(/Forbidden/);
  });

  it("stops retrying once the bubble is gone (unmounted)", () => {
    const { b, throwBelow } = mount();
    throwBelow(torn());
    b.componentWillUnmount();
    vi.runAllTimers();
    expect(b.state.error).not.toBeNull();
  });
});
