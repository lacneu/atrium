import { describe, expect, test } from "vitest";
import { sweepView, type SweepRow } from "./blobSweepView";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR;

function row(over: Partial<SweepRow>): SweepRow {
  return {
    _id: "s1" as SweepRow["_id"],
    mode: "dryRun",
    status: "done",
    stale: false,
    phase: "blobs",
    minAgeDays: 7,
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - HOUR,
    applicableUntil: NOW + 23 * HOUR,
    confirms: null,
    partsChecked: 10,
    mirrorMissing: 0,
    blobsScanned: 5,
    referenced: 3,
    importing: 0,
    orphans: { count: 2, bytes: 20 },
    byOrigin: {},
    byType: {},
    deleted: { count: 0, bytes: 0 },
    sampleIds: [],
    refusal: null,
    ...over,
  };
}

describe("sweepView: when the apply is offered", () => {
  test("a fresh, complete dry run with orphans can be applied", () => {
    const v = sweepView([row({})], NOW);
    expect(v.applyBlock).toBeNull();
    expect(v.report?._id).toBe("s1");
  });

  test("never while a sweep runs; a dead chain does not count as running", () => {
    const running = row({ _id: "s2" as SweepRow["_id"], status: "running", startedAt: NOW });
    expect(sweepView([running, row({})], NOW).applyBlock).toBe("running");
    expect(sweepView([{ ...running, stale: true }, row({})], NOW).applyBlock).toBeNull();
  });

  test("not past the report's 24 hours, not with a mirror gap, not with nothing to delete", () => {
    expect(sweepView([row({ applicableUntil: NOW })], NOW).applyBlock).toBe("expired");
    expect(sweepView([row({ mirrorMissing: 1 })], NOW).applyBlock).toBe("mirror");
    expect(sweepView([row({ orphans: { count: 0, bytes: 0 } })], NOW).applyBlock).toBe("nothing");
    expect(sweepView([], NOW).applyBlock).toBe("no_report");
  });

  test("a report already applied is not offered again", () => {
    const applied = row({
      _id: "s3" as SweepRow["_id"],
      mode: "apply",
      startedAt: NOW - HOUR / 2,
      applicableUntil: null,
    });
    const v = sweepView([applied, row({})], NOW);
    expect(v.lastApply?._id).toBe("s3");
    expect(v.applyBlock).toBe("no_report");
  });
});
