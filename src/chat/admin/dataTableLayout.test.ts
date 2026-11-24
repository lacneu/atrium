// An admin table stacks its rows when — and only when — it does not fit
// (dataTableLayout.ts, read by DataTableShell through useFitLevel/pickFitLevel).
// At 360 px the Instances table needed 976 px: it scrolled sideways, its actions
// 600 px off-screen.
import { describe, expect, test } from "vitest";
import { pickFitLevel } from "@/lib/useFitLevel";
import { tableLayoutFit } from "./dataTableLayout";

const TABLE = 0;
const STACKED = 1;
const layout = (available: number, needed: number) =>
  pickFitLevel(tableLayoutFit(available, needed));

describe("an admin table keeps its columns while they fit", () => {
  test("it fits (a tie fits): the table stays — 1280 px leaves Instances 980 for 976", () => {
    expect(layout(980, 976)).toBe(TABLE);
    expect(layout(976, 976)).toBe(TABLE);
  });

  test("one pixel short: the rows stack (the Instances table on a phone)", () => {
    expect(layout(975, 976)).toBe(STACKED);
    expect(layout(296, 976)).toBe(STACKED);
  });

  test("not laid out yet (0): no verdict, the table stays", () => {
    expect(layout(296, 0)).toBe(TABLE);
  });
});
