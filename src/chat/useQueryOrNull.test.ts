import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useQueryOrNull, valueOrNull } from "./useQueryOrNull";

// A failed follow-up state is "no queue information", never a thrown render (codex phase 6
// pass 5: a query past the read limit used to take the whole conversation down).
describe("valueOrNull", () => {
  it("an error reads as no data", () => {
    expect(valueOrNull(new Error("Read too much data"))).toBeNull();
  });
  it("a value and a pending query pass through", () => {
    expect(valueOrNull({ projection: false })).toEqual({ projection: false });
    expect(valueOrNull(undefined)).toBeUndefined();
  });
});

// The hook itself, RENDERED (0.98.0 prod: every chat page hit the route error boundary).
// `useQueries` resubscribes whenever its queries object changes identity, and that sets
// state during render; an object rebuilt per render loops until React throws "Too many
// re-renders". The fake client answers every watch with a fixed local result; the probe
// re-renders itself once (a render-phase update, as any client re-render would), which is
// where an unstable queries object starts the loop.
function fakeClient(result: unknown): ConvexReactClient {
  return {
    watchQuery: () => ({
      localQueryResult: () => result,
      onUpdate: () => () => {},
      journal: () => undefined,
    }),
  } as unknown as ConvexReactClient;
}

function renderHook(result: unknown, args: { chatId: Id<"chats"> } | "skip"): string {
  function Probe() {
    const [rendered, setRendered] = useState(false);
    if (!rendered) setRendered(true);
    const v = useQueryOrNull(api.followUp.followUpState, args);
    return createElement("span", null, v === undefined ? "loading" : v === null ? "null" : "value");
  }
  return renderToStaticMarkup(
    createElement(ConvexProvider, { client: fakeClient(result), children: createElement(Probe) }),
  );
}

describe("useQueryOrNull (rendered)", () => {
  const chatId = "chat-1" as Id<"chats">;

  it("renders a value without looping", () => {
    expect(renderHook({ projection: false }, { chatId })).toBe("<span>value</span>");
  });
  it("renders a server error as no data, without throwing", () => {
    expect(renderHook(new Error("Read too much data"), { chatId })).toBe("<span>null</span>");
  });
  it("renders a pending query and a skipped one", () => {
    expect(renderHook(undefined, { chatId })).toBe("<span>loading</span>");
    expect(renderHook({ projection: false }, "skip")).toBe("<span>loading</span>");
  });
});
