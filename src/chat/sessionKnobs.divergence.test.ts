/// <reference types="vite/client" />
//
// Two instruments, one window (lot 39 — G-50).
//
// Hermes reports its OWN occupancy (`usage.context_percent`); Atrium derives one from the
// token counts. Recording both was deliberate — when they disagree, the disagreement is
// the finding — but the first cut of this lot stored the gateway's number and rendered
// nothing, so the finding was unreachable (raised in review). These pin the rule the gauge
// now shows.

import { describe, expect, it } from "vitest";
import { contextPercentDivergence } from "./sessionKnobs";

describe("contextPercentDivergence", () => {
  it("stays silent when the two instruments agree", () => {
    // 100/1000 = 10 %, gateway says 12 — inside rounding tolerance. A gauge that cried
    // divergence at every rounding point would train the reader to ignore it.
    expect(
      contextPercentDivergence({
        totalTokens: 100,
        contextTokens: 1000,
        contextPercent: 12,
      }),
    ).toBeNull();
  });

  it("reports a REAL disagreement, with both readings", () => {
    const d = contextPercentDivergence({
      totalTokens: 100,
      contextTokens: 1000,
      contextPercent: 55,
    });
    expect(d).not.toBeNull();
    expect(d!.gateway).toBe(55);
    expect(d!.derived).toBe(10);
    expect(d!.delta).toBe(45);
  });

  it("says nothing when there is nothing to compare", () => {
    // No gateway reading (an OpenClaw chat), or no trustworthy derived one: silence, not a
    // fabricated agreement.
    expect(
      contextPercentDivergence({ totalTokens: 100, contextTokens: 1000 }),
    ).toBeNull();
    expect(contextPercentDivergence({ contextPercent: 40 })).toBeNull();
    expect(contextPercentDivergence(null)).toBeNull();
  });

  it("a STALE token counter cannot manufacture a divergence", () => {
    // `totalTokensFresh: false` makes the derived reading unknown — upstream's own rule,
    // and lot 3's. An unknown side cannot disagree with anything.
    expect(
      contextPercentDivergence({
        totalTokens: 100,
        contextTokens: 1000,
        totalTokensFresh: false,
        contextPercent: 55,
      }),
    ).toBeNull();
  });
});
