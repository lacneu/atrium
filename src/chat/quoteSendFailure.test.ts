// What a rejected send does with the passages it already consumed.
//
// `sendMessage` empties the store BEFORE the mutation, so a rejection it cannot
// interpret costs the user a selection they deliberately assembled. Two
// questions decide the outcome, and both are answered from the server's own
// message: which anchors are stale, and whether re-sending would fail again.

import { describe, expect, test } from "vitest";
import {
  goneQuoteTargets,
  quotesRejectedOutright,
} from "./useConvexChatRuntime";

describe("reading a rejected send", () => {
  test("a stale anchor is NAMED, so only that passage is dropped", () => {
    const e = new Error("Invalid: quote target gone [msg_abc123]");
    expect([...goneQuoteTargets(e)]).toEqual(["msg_abc123"]);
    // ...and the turn is retryable, so the rest go back in the composer.
    expect(quotesRejectedOutright(e)).toBe(false);
  });

  test("SEVERAL stale anchors are all named", () => {
    const e = new Error(
      "Invalid: quote target gone [a] and Invalid: quote target gone [b]",
    );
    expect([...goneQuoteTargets(e)].sort()).toEqual(["a", "b"]);
  });

  test("a rejection that re-sending would hit again keeps nothing", () => {
    // Restaging these would wedge every retry behind the same refusal.
    for (const message of [
      "Invalid: quoted message is not an assistant reply",
      "Invalid: quoted message not in this chat",
      "Invalid: quote shape (empty or malformed excerpt)",
      "Invalid: too many quotes in one turn",
      "Invalid: quoted excerpts exceed the per-turn budget",
    ]) {
      expect(quotesRejectedOutright(new Error(message))).toBe(true);
      expect(goneQuoteTargets(new Error(message)).size).toBe(0);
    }
  });

  test("an unrelated failure keeps the selection", () => {
    // A dropped connection is not the user's fault and must not cost them
    // anything: nothing is named, and nothing is a quote rejection.
    const e = new Error("Network request failed");
    expect(goneQuoteTargets(e).size).toBe(0);
    expect(quotesRejectedOutright(e)).toBe(false);
  });
});
