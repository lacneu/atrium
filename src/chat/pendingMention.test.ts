import { beforeEach, describe, expect, test } from "vitest";

import {
  clearPendingMentions,
  peekPendingMentions,
  resolveMentionSpans,
  restorePendingMentions,
  stagePendingMention,
  takePendingMentions,
} from "./pendingMention";

// The staged thing is a TOKEN, not a span: a span captured when somebody is
// picked drifts on the very next keystroke. The spans are located in the final
// text at send time, which is also what makes "I deleted @alice from the box"
// mean "I did not mention alice".

beforeEach(() => {
  clearPendingMentions("c1");
  clearPendingMentions("c2");
});

describe("staging people per conversation", () => {
  test("keeps one entry per person, and per chat", () => {
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    stagePendingMention("c2", { userId: "u2", token: "@bob" });
    expect(peekPendingMentions("c1")).toHaveLength(1);
    expect(peekPendingMentions("c2")).toHaveLength(1);
  });

  test("take reads AND clears, so one send consumes them once", () => {
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    expect(takePendingMentions("c1")).toHaveLength(1);
    expect(takePendingMentions("c1")).toHaveLength(0);
  });

  test("a failed send can put them back without duplicating", () => {
    stagePendingMention("c1", { userId: "u1", token: "@alice" });
    const taken = takePendingMentions("c1");
    stagePendingMention("c1", { userId: "u2", token: "@bob" });
    restorePendingMentions("c1", taken);
    expect(peekPendingMentions("c1").map((m) => m.userId).sort()).toEqual(["u1", "u2"]);
    restorePendingMentions("c1", taken);
    expect(peekPendingMentions("c1")).toHaveLength(2);
  });
});

describe("locating the tokens in the text actually sent", () => {
  test("finds the span wherever the person moved it", () => {
    const text = "bonjour, @alice peux-tu voir ?";
    const spans = resolveMentionSpans(text, [{ userId: "u1", token: "@alice" }]);
    expect(spans).toEqual([{ userId: "u1", start: 9, end: 15 }]);
    expect(text.slice(9, 15)).toBe("@alice");
  });

  test("drops a token the person deleted", () => {
    // Deleting "@alice" from the box IS un-mentioning her.
    expect(
      resolveMentionSpans("plus personne", [{ userId: "u1", token: "@alice" }]),
    ).toEqual([]);
  });

  test("returns spans in TEXT order, whatever order they were picked in", () => {
    // The gateway walks the list once, in order; an out-of-order pair makes it
    // refuse the whole send.
    const text = "@bob puis @alice";
    const spans = resolveMentionSpans(text, [
      { userId: "u1", token: "@alice" },
      { userId: "u2", token: "@bob" },
    ]);
    expect(spans.map((s) => s.userId)).toEqual(["u2", "u1"]);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
  });

  test("two people whose tokens nest do not claim the same characters", () => {
    // "@ali" is inside "@alice". Both matching at 0 would produce overlapping
    // spans, which upstream refuses.
    const text = "@alice et @ali";
    const spans = resolveMentionSpans(text, [
      { userId: "alice", token: "@alice" },
      { userId: "ali", token: "@ali" },
    ]);
    expect(spans).toHaveLength(2);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("@alice");
    expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe("@ali");
  });

  test("counts UTF-16 code units, like the rest of the chain", () => {
    const text = "🙂 @alice";
    expect(resolveMentionSpans(text, [{ userId: "u1", token: "@alice" }])).toEqual([
      { userId: "u1", start: 3, end: 9 },
    ]);
  });
});
