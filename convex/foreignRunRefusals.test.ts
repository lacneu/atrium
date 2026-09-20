import { describe, expect, it } from "vitest";

import {
  classifyForeignRunRefusals,
  costlyForeignRunRefusals,
  FOREIGN_RUN_REFUSAL_REASONS,
} from "./lib/foreignRunRefusals";

/**
 * THE QUESTION THE TOTAL COULD NOT ANSWER.
 *
 * Production, 2026-09-20: a turn finalized `empty_final_timeout` carrying
 * `foreignRunsRefused: 21`. Twenty-one refusals is either a healthy session with
 * twenty sub-agents (every announce chain is refused as this turn's continuation,
 * by design) or twenty-one frames of the user's answer going in the bin. The
 * trace could not say which, and the chat in question had both shapes in it.
 */
describe("foreign-run refusals: the reason is the half that decides", () => {
  it("separates the guard WORKING from frames the turn LOST", () => {
    const by = classifyForeignRunRefusals({
      gateway_initiated: 20,
      no_grace: 1,
    });
    expect(by).toEqual({ gateway_initiated: 20, no_grace: 1 });
    // …and only the second kind is counted as a loss. A reader who sees 21 and
    // panics is reading the wrong number; this is the right one.
    expect(costlyForeignRunRefusals(by)).toBe(1);
  });

  it("an announce storm alone costs NOTHING", () => {
    const by = classifyForeignRunRefusals({ gateway_initiated: 40, heartbeat: 3 });
    expect(costlyForeignRunRefusals(by)).toBe(0);
  });

  it("every reason the normalizer can return is in the vocabulary", () => {
    // Pinned against the normalizer's own literals: a fifth reason added there
    // without being classified here would silently land in `other`, which is the
    // costly bucket — loud, but for the wrong reason.
    expect([...FOREIGN_RUN_REFUSAL_REASONS].sort()).toEqual([
      "compaction_no_replay_signal",
      "gateway_initiated",
      "heartbeat",
      "no_grace",
    ]);
  });

  it("an UNKNOWN reason is counted under `other`, never dropped and never echoed", () => {
    // Dropping it would understate the refusals; keeping its name would write an
    // unreviewed string from the sender into the trace. It also counts as costly:
    // a reason nobody has classified is not evidence that nothing was lost.
    const by = classifyForeignRunRefusals({ some_new_reason: 2, heartbeat: 1 });
    expect(by).toEqual({ other: 2, heartbeat: 1 });
    expect(Object.keys(by ?? {})).not.toContain("some_new_reason");
    expect(costlyForeignRunRefusals(by)).toBe(2);
  });

  it("a count that is not a count is refused, not coerced", () => {
    // A NaN or a float summed into the costly total makes the whole trace
    // unreadable — and `"3"` from a future sender is not three.
    expect(classifyForeignRunRefusals({ no_grace: Number.NaN })).toBeNull();
    expect(classifyForeignRunRefusals({ no_grace: 1.5 })).toBeNull();
    expect(classifyForeignRunRefusals({ no_grace: "3" })).toBeNull();
    expect(classifyForeignRunRefusals({ no_grace: -1 })).toBeNull();
    expect(classifyForeignRunRefusals({ no_grace: 0 })).toBeNull();
  });

  it("nothing measured reads as ABSENT, never as measured-zero", () => {
    // The trace must not claim "no refusals" for a bridge that never sent the
    // field — that is the older-build case, and it is a different fact.
    expect(classifyForeignRunRefusals(undefined)).toBeNull();
    expect(classifyForeignRunRefusals(null)).toBeNull();
    expect(classifyForeignRunRefusals({})).toBeNull();
    expect(classifyForeignRunRefusals([1, 2])).toBeNull();
    expect(classifyForeignRunRefusals("no_grace")).toBeNull();
    expect(costlyForeignRunRefusals(null)).toBe(0);
  });
});
