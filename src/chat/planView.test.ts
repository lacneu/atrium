import { describe, expect, test } from "vitest";
import { resolveCurrentPlan } from "./planView";

const STEPS = [{ step: "a", status: "pending" }];
const OTHER = [{ step: "b", status: "pending" }];

describe("resolveCurrentPlan (a cleared card hides the checklist — codex P2)", () => {
  test("the newest plan is the truth", () => {
    expect(resolveCurrentPlan([{ steps: [] }, { steps: STEPS }])?.steps).toBe(STEPS);
  });
  test("an EMPTY newest plan hides the previous checklist", () => {
    expect(resolveCurrentPlan([{ steps: STEPS }, { steps: [] }])).toBeNull();
  });
  test("no plan at all", () => {
    expect(resolveCurrentPlan([])).toBeNull();
  });
});

describe("resolveCurrentPlan orders by CAUSE (the replayed clear window)", () => {
  test("a clear that replays AFTER a newer plan does not hide it", () => {
    // The window convex/stream.ts `clearPlanPart` could not close: the clear's
    // first write was lost, another run posted a plan, the clear was retried —
    // so the tombstone lands LAST while carrying the OLDER stamp.
    expect(
      resolveCurrentPlan([
        { steps: STEPS, stamp: 100 },
        { steps: [], stamp: 90 },
      ])?.steps,
    ).toBe(STEPS);
  });
  test("a clear caused AFTER the plan still hides it", () => {
    expect(
      resolveCurrentPlan([
        { steps: STEPS, stamp: 90 },
        { steps: [], stamp: 100 },
      ]),
    ).toBeNull();
  });
  test("the newest CAUSE wins even when it arrived first", () => {
    expect(
      resolveCurrentPlan([
        { steps: STEPS, stamp: 200 },
        { steps: OTHER, stamp: 100 },
      ])?.steps,
    ).toBe(STEPS);
  });
  test("STATED LIMIT: equal stamps fall back to insertion order", () => {
    // Millisecond resolution: two causes inside one millisecond compare equal and
    // the last row wins — the ordering this rule replaces. Pinned so the limit is
    // a decision with a test, not an accident (codex).
    expect(
      resolveCurrentPlan([
        { steps: STEPS, stamp: 100 },
        { steps: [], stamp: 100 },
      ]),
    ).toBeNull();
  });
  test("unstamped history keeps insertion order", () => {
    expect(
      resolveCurrentPlan([{ steps: STEPS }, { steps: OTHER }])?.steps,
    ).toBe(OTHER);
  });
  test("an unstamped part written AFTER a stamped one still wins", () => {
    // Mixed deployment: an older bridge posts a plan after a new bridge's
    // clear. It inherits the clear's stamp and keeps its later position.
    expect(
      resolveCurrentPlan([{ steps: [], stamp: 100 }, { steps: STEPS }])?.steps,
    ).toBe(STEPS);
  });
  test("an unstamped part is dated by the GREATEST stamp before it, not the last one", () => {
    // A clear that LOST (parked after the plan it could not hide) must not drag
    // the unstamped row an older bridge writes next below that plan: the fallback
    // for an unstamped part is arrival order, and it arrived last (codex).
    expect(
      resolveCurrentPlan([
        { steps: STEPS, stamp: 200 },
        { steps: [], stamp: 100 },
        { steps: OTHER },
      ])?.steps,
    ).toBe(OTHER);
  });
  test("a stamped clear supersedes unstamped history", () => {
    expect(
      resolveCurrentPlan([{ steps: STEPS }, { steps: [], stamp: 100 }]),
    ).toBeNull();
  });
});
