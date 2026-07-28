/**
 * The C4 reservation has to survive the TRIP, not just the registry (W9).
 *
 * The bridge reserves room for its own findings — a reader exception is scarcer and more
 * serious than field drift — and Convex keeps a bounded PREFIX of the reported list. Two
 * halves of one guarantee, in two repositories' worth of code, each pinned by its own
 * tests. Pinning them separately is how the guarantee broke in the first place: the
 * sensor shapes were appended LAST, so a saturated registry pushed the exception off the
 * end and Convex turned it back into an anonymous `driftTruncated` tick.
 *
 * This test is the seam. It runs the REAL registry into the REAL boundary function —
 * `convex/lib/compat.ts` is dependency-free by construction, so the bridge can import it
 * without dragging a Convex runtime along.
 *
 * The direction matters: the bridge imports the boundary, not the other way round.
 * Importing bridge sources from the root test suite pulled them into a tsconfig with an
 * older `lib` and turned the root typecheck red on `Object.hasOwn` — a gate broken by the
 * test meant to protect it.
 */

import { describe, expect, it, afterEach } from "vitest";

import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";

/** Loaded through a NON-LITERAL specifier on purpose. A static import pulls the file into
 *  this package's tsconfig program, whose `rootDir` is `bridge/` — `tsc -p .` then fails
 *  with TS6059 on a file it has no business compiling. Vitest resolves it either way, and
 *  what this test asserts is behaviour, not types. */
type Bounded = {
  drift: { shape: string; count: number }[];
  driftOverflow: number;
  driftTruncated: number;
} | null;
const COMPAT = "../../convex/lib/compat.ts";
const { boundProtocolInfo, foldProtocolInfo } = (await import(COMPAT)) as {
  boundProtocolInfo: (raw: unknown) => Bounded;
  foldProtocolInfo: (parts: Bounded[]) => Bounded;
};

afterEach(() => protocolDrift.resetForTests());

const EXCEPTION = "«exception».TypeError@feed.chat.delta";

function saturateWithFieldDrift(n: number): void {
  for (let i = 0; i < n; i++) {
    protocolDrift.observe({
      type: "event",
      event: "chat",
      payload: { state: "delta", runId: "r", sessionKey: "s", [`novel_${i}`]: 1 },
    });
  }
}

describe("a reader exception reaches the operator through the whole chain", () => {
  it("survives a registry saturated with unknown fields", () => {
    saturateWithFieldDrift(300);
    protocolDrift.observeException(
      { type: "event", event: "chat", payload: { state: "delta" } },
      new TypeError("unreadable"),
      "feed",
    );
    const bounded = boundProtocolInfo({
      vendoredVersion: "2026.7.1",
      drift: protocolDrift.report(),
      driftOverflow: protocolDrift.overflowCount(),
      driftTruncated: 0,
    });
    expect(bounded?.drift.map((d) => d.shape)).toContain(EXCEPTION);
    // …and the truncation is still NAMED, not silent: the operator is told the list is
    // short, which is the whole point of the two loss counters.
    expect((bounded?.driftTruncated ?? 0) + (bounded?.driftOverflow ?? 0)).toBeGreaterThan(0);
  });

  it("survives even when every field shape is far more frequent", () => {
    // Ordering by count alone would bury it: a reader exception is a count of 1 on the
    // day it matters most.
    saturateWithFieldDrift(150);
    for (let i = 0; i < 200; i++) {
      protocolDrift.observe({
        type: "event",
        event: "chat",
        payload: { state: "delta", runId: "r", sessionKey: "s", novel_0: 1 },
      });
    }
    protocolDrift.observeException(
      { type: "event", event: "chat", payload: { state: "delta" } },
      new TypeError("unreadable"),
      "feed",
    );
    const bounded = boundProtocolInfo({
      vendoredVersion: "2026.7.1",
      drift: protocolDrift.report(),
      driftOverflow: protocolDrift.overflowCount(),
      driftTruncated: 0,
    });
    expect(bounded?.drift[0]?.shape).toBe(EXCEPTION);
  });
});

describe("…and through the MULTI-BRIDGE fold, which is the path the poller uses", () => {
  it("a lone exception on one bridge outranks a hundred frequent drifts on another", () => {
    // The seam above covers ONE bridge. `foldProtocolInfo` re-sorts the union of all of
    // them, and it re-sorted by count alone — so a bridge reporting a single unreadable
    // frame lost its place to another bridge's hundred ordinary field drifts, and the
    // bound at the end of the fold turned it back into an anonymous number.
    const noisy = boundProtocolInfo({
      vendoredVersion: "2026.7.1",
      drift: Array.from({ length: 100 }, (_, i) => ({ shape: `chat.delta.f${i}`, count: 2 })),
      driftOverflow: 0,
      driftTruncated: 0,
    });
    const quiet = boundProtocolInfo({
      vendoredVersion: "2026.7.1",
      drift: [{ shape: EXCEPTION, count: 1 }],
      driftOverflow: 0,
      driftTruncated: 0,
    });
    const folded = foldProtocolInfo([noisy, quiet]);
    expect(folded?.drift[0]?.shape).toBe(EXCEPTION);
    expect(folded?.drift.map((d) => d.shape)).toContain(EXCEPTION);
  });
});

describe("…and at the FIRST bound, which runs before any fold", () => {
  it("the RAW cap stays a plain prefix, and the reason is written down", () => {
    // Rescuing a sensor shape sitting past the raw cap was implemented and reverted: it
    // would have made every poll walk the whole array, which is the DoS guard the Convex
    // suite pins. And against a bridge divergent enough to bury its own exception past
    // 800 entries, priority buys nothing — such a bridge can simply omit it. An HONEST
    // bridge sends ~130 entries, sensor-first. This test states the boundary rather than
    // pretending it does not exist.
    const bounded = boundProtocolInfo({
      vendoredVersion: "2026.7.1",
      drift: [
        ...Array.from({ length: 900 }, (_, i) => ({ shape: `chat.delta.f${i}`, count: 5 })),
        { shape: EXCEPTION, count: 1 },
      ],
      driftOverflow: 0,
      driftTruncated: 0,
    });
    expect(bounded?.drift.map((d) => d.shape)).not.toContain(EXCEPTION);
    // …and the loss is NAMED, which is the guarantee that does hold at every bound.
    expect(bounded?.driftTruncated ?? 0).toBeGreaterThan(0);
  });

  it("an exception sent LAST by a bridge is still kept", () => {
    // This boundary must not lean on the bridge having sorted correctly — not trusting
    // the bridge is the rule everywhere else here, and a seam that only passes because
    // our own bridge behaves is a seam that pins nothing.
    const bounded = boundProtocolInfo({
      vendoredVersion: "2026.7.1",
      drift: [
        ...Array.from({ length: 300 }, (_, i) => ({ shape: `chat.delta.f${i}`, count: 5 })),
        { shape: EXCEPTION, count: 1 },
      ],
      driftOverflow: 0,
      driftTruncated: 0,
    });
    expect(bounded?.drift[0]?.shape).toBe(EXCEPTION);
  });
});
