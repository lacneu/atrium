// THE UNIT *AND RESOLUTION* OF THE BRIDGE CLOCK, pinned.
//
// `Clock` feeds the normalizer, which stamps every event with it, and the plan
// stamp derived from it is COMPARED across writes (convex/lib/planOrder.ts).
// Neither property below would fail a behavioral test — every one of them
// injects its own increasing clock — and both break production ordering:
//   - milliseconds instead of seconds puts every new plan ~1000x ahead of the
//     rows already written, freezing the first part written after the change as
//     "the current plan" forever;
//   - whole seconds (a `Math.floor`) makes two causes up to a second apart
//     compare EQUAL, and a tie is decided by insertion order — which reopens
//     the retried-clear window for that whole second (codex).
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultClock } from "../src/session.js";

describe("the bridge's default clock", () => {
  it("counts SECONDS, not milliseconds", () => {
    const seconds = defaultClock();
    const ms = Date.now();
    // Within a whisker of ms/1000, and three orders of magnitude below ms.
    expect(Math.abs(seconds - ms / 1000)).toBeLessThan(1);
    expect(seconds).toBeLessThan(ms / 100);
  });

  it("keeps MILLISECOND resolution — two causes 5ms apart differ by exactly that", () => {
    // Driven off a stubbed `Date.now` rather than real elapsed time: the point is
    // the transform, and a wall-clock version could pass a 10ms quantization by
    // luck or fail on a suspended process (codex).
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_788_581_688_000);
    const before = defaultClock();
    now.mockReturnValue(1_788_581_688_005);
    const after = defaultClock();
    // `Math.floor(ms/1000)` gives 0 here; any coarser quantization gives 0 too.
    expect(after - before).toBeCloseTo(0.005, 6);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
