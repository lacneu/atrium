import { describe, expect, test } from "vitest";
import {
  buildFlushBatch,
  collectNewSamples,
  skewFromPing,
  type ClientSample,
  type StreamRow,
} from "./deliveryRecorder";

describe("skewFromPing", () => {
  test("estimates serverClock - clientClock with the symmetric-RTT midpoint", () => {
    // sent at 1000, received at 1020 (RTT 20 -> midpoint clientClock 1010); the
    // server stamped 1500 at receipt -> offset 1500 - 1010 = 490.
    expect(skewFromPing(1000, 1500, 1020)).toBe(490);
  });

  test("a server behind the client yields a negative skew", () => {
    // client midpoint 1010, server stamped 900 -> skew -110.
    expect(skewFromPing(1000, 900, 1020)).toBe(-110);
  });
});

describe("collectNewSamples", () => {
  const rows = (...ids: (string | undefined)[]): StreamRow[] =>
    ids.map((recTimingId, i) => ({ messageId: `m${i}`, text: "x", recTimingId }));

  test("stamps t4 + skew only for unseen recTimingIds", () => {
    const seen = new Set<string>(["a"]);
    const out = collectNewSamples(rows("a", "b", "c"), seen, 5000, 42);
    expect(out).toEqual([
      { timingId: "b", t4: 5000, clientSkew: 42 },
      { timingId: "c", t4: 5000, clientSkew: 42 },
    ]);
  });

  test("rows without a recTimingId (not recording) yield nothing", () => {
    expect(collectNewSamples(rows(undefined, undefined), new Set(), 1, 0)).toEqual(
      [],
    );
  });

  test("an already-seen id is not re-sampled (dedup)", () => {
    const seen = new Set<string>(["a", "b"]);
    expect(collectNewSamples(rows("a", "b"), seen, 1, undefined)).toEqual([]);
  });

  test("skew may be undefined before calibration completes", () => {
    const out = collectNewSamples(rows("z"), new Set(), 7, undefined);
    expect(out).toEqual([{ timingId: "z", t4: 7, clientSkew: undefined }]);
  });
});

describe("buildFlushBatch", () => {
  const q = (...s: ClientSample[]): ClientSample[] => s;

  test("HOLDS (returns null) while skew is undefined — never flush uncorrected", () => {
    expect(buildFlushBatch(q({ timingId: "a", t4: 1 }), undefined)).toBeNull();
  });

  test("returns null for an empty queue", () => {
    expect(buildFlushBatch([], 50)).toBeNull();
  });

  test("once calibrated, back-fills the resolved skew onto every held sample", () => {
    const out = buildFlushBatch(
      q(
        { timingId: "a", t4: 1, clientSkew: undefined },
        { timingId: "b", t4: 2, clientSkew: 50 },
      ),
      50,
    );
    expect(out).toEqual([
      { timingId: "a", t4: 1, clientSkew: 50 }, // was undefined -> back-filled
      { timingId: "b", t4: 2, clientSkew: 50 }, // already set -> kept
    ]);
  });
});
