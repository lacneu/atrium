import { describe, expect, test } from "vitest";
import { QUOTE_EXCERPT_CAP } from "../../convex/lib/quoteReply";
import {
  QUOTE_MAX_PER_TURN,
  QUOTE_TOTAL_EXCERPT_CAP,
  QUOTE_EXCERPT_CLIENT_MAX,
  addPendingQuote,
  clearPendingQuotes,
  peekPendingQuotes,
  pendingQuoteKey,
  removePendingQuote,
  restorePendingQuotes,
  restorePendingQuotesExcept,
  takePendingQuotes,
} from "./pendingQuote";

const q = (id: string, block: number | null, text: string) => ({
  messageId: id,
  blockIndex: block,
  excerpt: text,
});

describe("pendingQuote store (per-chat keying)", () => {
  test("add/peek/clear are scoped to THEIR chat — no cross-chat leakage", () => {
    addPendingQuote("chatA", q("m1", 2, "x"));
    expect(peekPendingQuotes("chatA").map((p) => p.excerpt)).toEqual(["x"]);
    expect(peekPendingQuotes("chatB")).toEqual([]); // the leak the keying prevents
    clearPendingQuotes("chatA");
    expect(peekPendingQuotes("chatA")).toEqual([]);
  });

  test("a SECOND quote is added, never a replacement", () => {
    // The whole point of the widening: staging a passage while another is
    // staged used to overwrite it, so the user could only ever send one.
    addPendingQuote("chatM", q("m1", 0, "premier"));
    addPendingQuote("chatM", q("m2", 3, "second"));
    expect(peekPendingQuotes("chatM").map((p) => p.excerpt)).toEqual([
      "premier",
      "second",
    ]);
    clearPendingQuotes("chatM");
  });

  test("the SAME block twice stays one passage (double click)", () => {
    addPendingQuote("chatN", q("m1", 0, "un"));
    addPendingQuote("chatN", q("m1", 0, "un"));
    expect(peekPendingQuotes("chatN")).toHaveLength(1);
    // Same message, DIFFERENT block: a distinct passage.
    addPendingQuote("chatN", q("m1", 1, "deux"));
    expect(peekPendingQuotes("chatN")).toHaveLength(2);
    clearPendingQuotes("chatN");
  });

  test("each chip is removable ON ITS OWN, the others survive", () => {
    addPendingQuote("chatR", q("m1", 0, "a"));
    addPendingQuote("chatR", q("m2", 1, "b"));
    addPendingQuote("chatR", q("m3", null, "c"));
    removePendingQuote("chatR", pendingQuoteKey(q("m2", 1, "b")));
    expect(peekPendingQuotes("chatR").map((p) => p.excerpt)).toEqual(["a", "c"]);
    clearPendingQuotes("chatR");
  });

  test("everything the composer ACCEPTS, the server accepts", () => {
    // The bound that matters is the AGREEMENT. A composer that stages more than
    // the server takes fails the send AND loses the selection — the failure
    // reads as a server rejection, which the restage path deliberately refuses
    // to restore. Ten client-max excerpts (2 800 chars) would blow a 1 500-char
    // budget, so the composer must stop first.
    let staged = 0;
    for (let i = 0; i < QUOTE_MAX_PER_TURN * 2; i++) {
      const r = addPendingQuote(
        "chatAgree",
        q(`m${i}`, null, "y".repeat(QUOTE_EXCERPT_CLIENT_MAX)),
      );
      if (r !== "ok") break;
      staged++;
    }
    const total = peekPendingQuotes("chatAgree").reduce(
      (n, p) => n + p.excerpt.length,
      0,
    );
    expect(staged).toBeGreaterThan(0);
    expect(peekPendingQuotes("chatAgree").length).toBeLessThanOrEqual(
      QUOTE_MAX_PER_TURN,
    );
    expect(total).toBeLessThanOrEqual(QUOTE_TOTAL_EXCERPT_CAP);
    // And each excerpt is under the server's per-passage cap, so its trim never
    // shortens what the budget was computed on.
    for (const p of peekPendingQuotes("chatAgree")) {
      expect(p.excerpt.length).toBeLessThanOrEqual(QUOTE_EXCERPT_CAP);
    }
    clearPendingQuotes("chatAgree");
  });

  test("a too-long addition is refused WITH ITS OWN reason", () => {
    // Distinct from the count refusal: the composer says which, or the user
    // deletes chips to fix a problem that was never about the count.
    addPendingQuote("chatB2", q("m1", null, "y".repeat(QUOTE_TOTAL_EXCERPT_CAP)));
    expect(addPendingQuote("chatB2", q("m2", null, "encore"))).toBe("too-long");
    expect(peekPendingQuotes("chatB2")).toHaveLength(1);
    clearPendingQuotes("chatB2");
  });

  test("the count is BOUNDED and the refusal is reported", () => {
    // The composer must be able to say why, instead of letting the send fail.
    for (let i = 0; i < QUOTE_MAX_PER_TURN; i++) {
      expect(addPendingQuote("chatL", q(`m${i}`, null, `e${i}`))).toBe("ok");
    }
    expect(addPendingQuote("chatL", q("over", null, "trop"))).toBe("too-many");
    expect(peekPendingQuotes("chatL")).toHaveLength(QUOTE_MAX_PER_TURN);
    clearPendingQuotes("chatL");
  });

  test("take consumes exactly once (the send path contract)", () => {
    addPendingQuote("chatC", q("m2", null, "y"));
    addPendingQuote("chatC", q("m3", null, "z"));
    expect(takePendingQuotes("chatC").map((p) => p.messageId)).toEqual([
      "m2",
      "m3",
    ]);
    expect(takePendingQuotes("chatC")).toEqual([]);
  });

  test("a failed send loses NOTHING, even if a quote was staged meanwhile", () => {
    // The send path empties the store before the mutation, so whatever it
    // cannot give back is gone for good. An earlier version REFUSED to restore
    // when something had landed during the round trip — which traded one silent
    // loss for another. Both survive, consumed ones first (picked first).
    addPendingQuote("chatD", q("old", 1, "a"));
    const inFlight = takePendingQuotes("chatD");
    addPendingQuote("chatD", q("new", 2, "b"));
    // `restored` counts what CAME BACK, not the size of the result.
    expect(restorePendingQuotes("chatD", inFlight)).toEqual({
      restored: 1,
      dropped: 0,
    });
    expect(peekPendingQuotes("chatD").map((p) => p.messageId)).toEqual([
      "old",
      "new",
    ]);
    clearPendingQuotes("chatD");
  });

  test("restore puts the selection back IN ORDER when nothing landed", () => {
    addPendingQuote("chatE", q("m1", 0, "un"));
    addPendingQuote("chatE", q("m2", 1, "deux"));
    const inFlight = takePendingQuotes("chatE");
    expect(restorePendingQuotes("chatE", inFlight).restored).toBe(2);
    expect(peekPendingQuotes("chatE").map((p) => p.excerpt)).toEqual([
      "un",
      "deux",
    ]);
    clearPendingQuotes("chatE");
  });

  test("an overflowing restore keeps what is ON SCREEN and says what it could not", () => {
    // The eviction must never fall on the passage the user just staged and can
    // see — otherwise the report says a quote "could not be put back" while the
    // one that actually vanished is the new one.
    const full = "y".repeat(QUOTE_TOTAL_EXCERPT_CAP);
    addPendingQuote("chatF", q("consumed", 0, full));
    const inFlight = takePendingQuotes("chatF");
    addPendingQuote("chatF", q("onscreen", 0, full));
    expect(restorePendingQuotes("chatF", inFlight)).toEqual({
      restored: 0,
      dropped: 1,
    });
    expect(peekPendingQuotes("chatF").map((p) => p.messageId)).toEqual([
      "onscreen",
    ]);
    clearPendingQuotes("chatF");
  });

  test("an overflow on the COUNT also spares what is on screen", () => {
    for (let i = 0; i < QUOTE_MAX_PER_TURN; i++) {
      addPendingQuote("chatI", q(`c${i}`, null, `c${i}`));
    }
    const inFlight = takePendingQuotes("chatI");
    addPendingQuote("chatI", q("onscreen", null, "n"));
    const outcome = restorePendingQuotes("chatI", inFlight);
    const left = peekPendingQuotes("chatI");
    expect(left).toHaveLength(QUOTE_MAX_PER_TURN);
    expect(left[left.length - 1]!.messageId).toBe("onscreen");
    expect(outcome.restored + outcome.dropped).toBe(QUOTE_MAX_PER_TURN);
    clearPendingQuotes("chatI");
  });

  test("a restore never DUPLICATES a passage already staged", () => {
    addPendingQuote("chatG", q("m1", 0, "un"));
    const inFlight = takePendingQuotes("chatG");
    addPendingQuote("chatG", q("m1", 0, "un"));
    restorePendingQuotes("chatG", inFlight);
    expect(peekPendingQuotes("chatG")).toHaveLength(1);
    clearPendingQuotes("chatG");
  });

  test("only the STALE anchors are dropped; the rest come back", () => {
    // One regenerated target must not cost the user the whole selection.
    addPendingQuote("chatH", q("alive", 0, "a"));
    addPendingQuote("chatH", q("gone", 1, "b"));
    addPendingQuote("chatH", q("alive2", 2, "c"));
    const inFlight = takePendingQuotes("chatH");
    const outcome = restorePendingQuotesExcept(
      "chatH",
      inFlight,
      new Set(["gone"]),
    );
    expect(outcome).toEqual({ restored: 2, gone: 1, dropped: 0 });
    expect(peekPendingQuotes("chatH").map((p) => p.messageId)).toEqual([
      "alive",
      "alive2",
    ]);
    clearPendingQuotes("chatH");
  });
});
