import { describe, expect, test } from "vitest";
import {
  buildFlushBatch,
  collectNewSamples,
  reportToText,
  skewFromPing,
  type ClientSample,
  type DeliveryReport,
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
    expect(buildFlushBatch(q({ timingId: "a", t4: 1 }), undefined, 500)).toBeNull();
  });

  test("returns null for an empty queue", () => {
    expect(buildFlushBatch([], 50, 500)).toBeNull();
  });

  test("once calibrated, back-fills the resolved skew onto every held sample", () => {
    const out = buildFlushBatch(
      q(
        { timingId: "a", t4: 1, clientSkew: undefined },
        { timingId: "b", t4: 2, clientSkew: 50 },
      ),
      50,
      500,
    );
    expect(out).toEqual([
      { timingId: "a", t4: 1, clientSkew: 50 }, // was undefined -> back-filled
      { timingId: "b", t4: 2, clientSkew: 50 }, // already set -> kept
    ]);
  });

  test("caps at `limit` (head of queue) so the server cap can't silently drop the rest", () => {
    const queue = Array.from({ length: 5 }, (_, i) => ({
      timingId: `t${i}`,
      t4: i,
    }));
    const out = buildFlushBatch(queue, 0, 2);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    expect(out!.map((s) => s.timingId)).toEqual(["t0", "t1"]); // head, in order
  });
});

describe("reportToText", () => {
  const seg = (count: number, p50: number | null, p95: number | null, max: number | null) => ({
    count,
    p50,
    p95,
    max,
  });

  test("renders a shareable block with rounded ms and per-segment counts", () => {
    const report: DeliveryReport = {
      sessionId: "sess-1",
      count: 180,
      truncated: false,
      segments: {
        bridge: seg(180, 3, 5, 9),
        A: seg(180, 66.4, 74, 328),
        C: seg(0, null, null, null),
      },
    };
    const text = reportToText(report);
    expect(text).toContain("session sess-1 (180 deltas)");
    expect(text).toContain("bridge internal: p50=3 p95=5 max=9 ms (n=180)");
    expect(text).toContain("A bridge->Convex: p50=66 p95=74 max=328 ms (n=180)");
    expect(text).toContain("C Convex->frontend: p50=— p95=— max=— ms (n=0)");
    expect(text).toContain("B Convex exec: from Convex telemetry"); // B is external
    expect(text).not.toContain("capped"); // not truncated -> no cap note
  });

  test("flags a truncated report (the '+' marker and the cap note)", () => {
    const report: DeliveryReport = {
      sessionId: "sess-1",
      count: 10000,
      truncated: true,
      segments: {
        bridge: seg(10000, 2, 4, 8),
        A: seg(10000, 5, 9, 40),
        C: seg(10000, 90, 100, 120),
      },
    };
    const text = reportToText(report);
    expect(text).toContain("(10000+ deltas)"); // the + marker
    expect(text).toContain("capped at 10000 rows"); // the cap note
  });

  test("handles a no-samples report", () => {
    const report: DeliveryReport = {
      sessionId: null,
      count: 0,
      truncated: false,
      segments: null,
    };
    expect(reportToText(report)).toContain("(no samples)");
  });
});
