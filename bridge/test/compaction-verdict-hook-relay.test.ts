// THE COMPACTION STREAM CARRIES TWO UNRELATED THINGS.
//
// `emitCompactionAgentEvent` reports the real outcome
// (`{phase, completed, willRetry, outcome, reason?}`); `onCompactionHookMessages`
// relays whatever a `before_compaction`/`after_compaction` hook printed, and the
// `after` case emits `{phase:"end", completed:true, messages:[…]}`.
//
// Read as a verdict, that relay said "the compaction completed" and CLEARED a standing
// overfull state nothing had verified — a plugin writing one line made Atrium believe a
// session had shrunk, and the next turn paid for it with the overflow it had been
// warned about.
//
// The rule is deliberately ONE function shared by its two readers (the normalizer for a
// compaction during a turn, the run manager for one between turns). The normalizer path
// is exercised in compaction-detection.test.ts; the run manager has no harness here, so
// the rule itself is pinned directly rather than claiming a per-reader proof that does
// not exist.

import { describe, expect, it } from "vitest";
import {
  compactionCompleted,
  compactionFailedForGood,
} from "../src/core/compaction-verdict.js";

/** What upstream's `onCompactionHookMessages` emits for an `after_compaction` hook. */
const hookRelayEnd = { phase: "end", completed: true, messages: ["plugin said this"] };
/** What `emitCompactionAgentEvent` emits for a real completion. */
const realCompletedEnd = {
  phase: "end",
  completed: true,
  willRetry: false,
  outcome: "completed",
};

describe("a hook relay is not a compaction verdict", () => {
  it("does not read as a completion", () => {
    expect(compactionCompleted(hookRelayEnd)).toBe(false);
  });

  it("…and a real completion still does", () => {
    // The guard must not turn a working clear into a verdict nobody can lift.
    expect(compactionCompleted(realCompletedEnd)).toBe(true);
  });

  it("does not read as a failure either", () => {
    // The FIRST version of this passed without the guard: the object had no
    // `completed: false`, which the old rule already rejected on its own — it neutralized
    // nothing (raised in review). The shape below satisfies every clause of the failure
    // rule and is refused ONLY because it carries `messages`.
    expect(
      compactionFailedForGood({
        phase: "end",
        completed: false,
        willRetry: false,
        messages: ["a hook printed this"],
      }),
    ).toBe(false);
    // …and the same shape WITHOUT the relay marker is still a failure.
    expect(
      compactionFailedForGood({ phase: "end", completed: false, willRetry: false }),
    ).toBe(true);
  });

  it("a real failure still does", () => {
    expect(
      compactionFailedForGood({ phase: "end", completed: false, willRetry: false }),
    ).toBe(true);
  });

  it("`messages` is the discriminant, not the presence of text anywhere", () => {
    // A real end legitimately carries a `reason` string; that must not be mistaken for a
    // relay. (The bare positive control it used to duplicate lives above.)
    expect(
      compactionCompleted({
        phase: "end",
        completed: true,
        willRetry: false,
        outcome: "completed",
        reason: "threshold",
      }),
    ).toBe(true);
    // …and an empty `messages` array is still a relay shape: upstream returns early on
    // empty text, so a frame carrying the field at all came from that path.
    expect(
      compactionCompleted({ phase: "end", completed: true, willRetry: false, messages: [] }),
    ).toBe(false);
  });
});
