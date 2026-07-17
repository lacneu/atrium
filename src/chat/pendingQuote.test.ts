import { describe, expect, test } from "vitest";
import {
  clearPendingQuote,
  peekPendingQuote,
  setPendingQuote,
  takePendingQuote,
} from "./pendingQuote";

describe("pendingQuote store (per-chat keying)", () => {
  test("set/peek/clear are scoped to THEIR chat — no cross-chat leakage", () => {
    setPendingQuote("chatA", { messageId: "m1", blockIndex: 2, excerpt: "x" });
    expect(peekPendingQuote("chatA")?.excerpt).toBe("x");
    expect(peekPendingQuote("chatB")).toBeNull(); // the leak the keying prevents
    clearPendingQuote("chatA");
    expect(peekPendingQuote("chatA")).toBeNull();
  });
  test("take consumes exactly once (the send path contract)", () => {
    setPendingQuote("chatC", { messageId: "m2", blockIndex: null, excerpt: "y" });
    expect(takePendingQuote("chatC")?.messageId).toBe("m2");
    expect(takePendingQuote("chatC")).toBeNull();
  });
  test("failed-send restage must NOT clobber a newer staged quote (peek gate)", () => {
    // The send path: take, fail, then restage ONLY if nothing newer landed.
    setPendingQuote("chatD", { messageId: "old", blockIndex: 1, excerpt: "a" });
    const inFlight = takePendingQuote("chatD");
    setPendingQuote("chatD", { messageId: "new", blockIndex: 2, excerpt: "b" });
    if (inFlight && peekPendingQuote("chatD") === null)
      setPendingQuote("chatD", inFlight);
    expect(peekPendingQuote("chatD")?.messageId).toBe("new");
    clearPendingQuote("chatD");
  });
});
