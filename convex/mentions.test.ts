import { describe, expect, test } from "vitest";

import {
  MAX_MENTIONS,
  prependedLength,
  rejectMentionSpans,
  shiftMentionSpans,
} from "./lib/mentions";

// These rules are the GATEWAY's, mirrored on Atrium's side of the wire. Upstream
// rejects the whole send when spans do not re-anchor on the text, so a mention
// Atrium accepts and the gateway refuses costs somebody their turn. Every case
// below is a way that can happen.

const at = (text: string, token: string) => {
  const start = text.indexOf(token);
  return { start, end: start + token.length };
};

describe("a span that names somebody", () => {
  test("accepts an ordinary mention", () => {
    const text = "bonjour @alice, peux-tu regarder ?";
    expect(rejectMentionSpans(text, [at(text, "@alice")])).toBeNull();
  });

  test("accepts several, in order and disjoint", () => {
    const text = "@alice et @bob, avis ?";
    expect(
      rejectMentionSpans(text, [at(text, "@alice"), at(text, "@bob")]),
    ).toBeNull();
  });

  test("refuses more than the gateway will carry", () => {
    const text = "@a ".repeat(MAX_MENTIONS + 1);
    const spans = [...text.matchAll(/@a/g)].map((m) => ({
      start: m.index!,
      end: m.index! + 2,
    }));
    expect(rejectMentionSpans(text, spans)).toBe("too_many");
  });
});

describe("a span that would cost the sender their turn", () => {
  test("refuses a span past the end of the text", () => {
    expect(rejectMentionSpans("court", [{ start: 0, end: 99 }])).toBe("out_of_bounds");
    expect(rejectMentionSpans("court", [{ start: -1, end: 2 }])).toBe("out_of_bounds");
  });

  test("refuses an empty or inverted span", () => {
    expect(rejectMentionSpans("@alice", [{ start: 3, end: 3 }])).toBe("empty_span");
    expect(rejectMentionSpans("@alice", [{ start: 4, end: 2 }])).toBe("empty_span");
  });

  test("refuses spans that overlap, and spans out of order", () => {
    const text = "@alice @bob";
    expect(
      rejectMentionSpans(text, [
        { start: 0, end: 8 },
        { start: 7, end: 11 },
      ]),
    ).toBe("overlapping");
    // Upstream walks them once, in order: a later span first re-anchors against
    // the wrong offset and the whole send is refused.
    expect(
      rejectMentionSpans(text, [at(text, "@bob"), at(text, "@alice")]),
    ).toBe("overlapping");
  });

  test("refuses a span that does not start at the @", () => {
    const text = "bonjour @alice";
    expect(rejectMentionSpans(text, [{ start: 0, end: 7 }])).toBe(
      "not_a_mention_token",
    );
  });

  test("refuses a control character inside the token", () => {
    const text = "@ali\nce";
    expect(rejectMentionSpans(text, [{ start: 0, end: text.length }])).toBe(
      "control_character",
    );
  });

  test("refuses a span that cuts a character in half", () => {
    // An emoji is two UTF-16 code units. Ending between them leaves a lone half
    // that no renderer and no normalizer can put back together.
    const text = "@a🙂b";
    expect(rejectMentionSpans(text, [{ start: 0, end: 3 }])).toBe(
      "splits_a_character",
    );
    // The same span extended past the pair is fine.
    expect(rejectMentionSpans(text, [{ start: 0, end: 4 }])).toBeNull();
  });

  test("counts UTF-16 code units, like both sides of the wire", () => {
    // "🙂" is length 2 in JavaScript AND in the gateway's normalizer. A test that
    // counted code POINTS would place this span one unit short.
    const text = "🙂 @alice";
    const span = at(text, "@alice");
    expect(span.start).toBe(3);
    expect(rejectMentionSpans(text, [span])).toBeNull();
  });
});

describe("a prefix the sender never typed", () => {
  test("shifts every span by exactly the prefix length", () => {
    // The bridge prepends conversation history when it re-hydrates. Unshifted
    // offsets would point into the history and the gateway would refuse the send.
    const typed = "bonjour @alice";
    const history = "…contexte…\n\n";
    const shifted = shiftMentionSpans([at(typed, "@alice")], history.length);
    const sent = history + typed;
    expect(rejectMentionSpans(sent, shifted)).toBeNull();
    expect(sent.slice(shifted[0]!.start, shifted[0]!.end)).toBe("@alice");
  });

  test("a zero prefix leaves the spans untouched", () => {
    const spans = [{ start: 3, end: 9 }];
    expect(shiftMentionSpans(spans, 0)).toEqual(spans);
  });

  test("carries the rest of the span's fields through", () => {
    const spans = [{ start: 0, end: 6, userId: "u1" }];
    expect(shiftMentionSpans(spans, 5)).toEqual([{ start: 5, end: 11, userId: "u1" }]);
  });
});

describe("measuring a preamble that was composed, not passed", () => {
  test("reports the prepended length", () => {
    const typed = "bonjour @alice";
    const composed = `> citation\n\n${typed}`;
    expect(prependedLength(typed, composed)).toBe(composed.length - typed.length);
  });

  test("zero when nothing was composed", () => {
    expect(prependedLength("x", "x")).toBe(0);
  });

  test("REFUSES to measure anything that is not a prepend", () => {
    // A composition that also changed the tail cannot be compensated by a shift.
    // Answering with a difference anyway would move the spans somewhere arbitrary
    // and the gateway would refuse the whole send.
    expect(prependedLength("bonjour", "bonjour !")).toBeNull();
    expect(prependedLength("bonjour", "salut")).toBeNull();
    expect(prependedLength("bonjour", "")).toBeNull();
  });

  test("composes with the shift to land on the same token", () => {
    const typed = "voir @alice";
    const composed = `> extrait\n\n${typed}`;
    const prefix = prependedLength(typed, composed)!;
    const start = typed.indexOf("@alice");
    const [shifted] = shiftMentionSpans([{ start, end: start + 6 }], prefix);
    expect(composed.slice(shifted!.start, shifted!.end)).toBe("@alice");
    expect(rejectMentionSpans(composed, [shifted!])).toBeNull();
  });
});
