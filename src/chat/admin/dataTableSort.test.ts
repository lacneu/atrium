/// <reference types="vite/client" />
//
// DataTableShell sorting. The click → 3-state → reorder is React (live-checked);
// this pins the comparator: type handling, numeric-aware strings, null-LAST in
// BOTH directions, stability, no-mutation.

import { describe, expect, test } from "vitest";
import { compareSortValues, sortRows } from "./dataTableSort";

const ids = <T extends { id: number }>(rows: T[]) => rows.map((r) => r.id);

describe("compareSortValues", () => {
  test("numbers compare numerically", () => {
    expect(Math.sign(compareSortValues(2, 10))).toBe(-1);
    expect(Math.sign(compareSortValues(10, 2))).toBe(1);
  });
  test("strings are numeric-aware + case-insensitive", () => {
    expect(Math.sign(compareSortValues("v2", "v10"))).toBe(-1); // not "v10"<"v2"
    expect(compareSortValues("alice", "ALICE")).toBe(0);
  });
  test("booleans: false < true", () => {
    expect(Math.sign(compareSortValues(false, true))).toBe(-1);
  });
});

describe("sortRows", () => {
  const rows = [
    { id: 1, n: 30, s: "Carol", at: 300 },
    { id: 2, n: 10, s: "alice", at: 100 },
    { id: 3, n: 20, s: "Bob", at: 200 },
  ];

  test("ascending by number", () => {
    expect(ids(sortRows(rows, (r) => r.n, "asc"))).toEqual([2, 3, 1]);
  });
  test("descending by number", () => {
    expect(ids(sortRows(rows, (r) => r.n, "desc"))).toEqual([1, 3, 2]);
  });
  test("ascending by string (case-insensitive)", () => {
    expect(ids(sortRows(rows, (r) => r.s, "asc"))).toEqual([2, 3, 1]); // alice,Bob,Carol
  });
  test("sorts by the underlying datum, not a formatted label", () => {
    // `at` are timestamps; sorting them as numbers (not as display strings).
    expect(ids(sortRows(rows, (r) => r.at, "desc"))).toEqual([1, 3, 2]);
  });

  test("null/undefined sort LAST in ascending", () => {
    const r = [{ id: 1, v: "b" }, { id: 2, v: null }, { id: 3, v: "a" }];
    expect(ids(sortRows(r, (x) => x.v, "asc"))).toEqual([3, 1, 2]);
  });
  test("null/undefined still sort LAST in descending (not flipped to top)", () => {
    const r = [{ id: 1, v: "b" }, { id: 2, v: null }, { id: 3, v: "a" }];
    expect(ids(sortRows(r, (x) => x.v, "desc"))).toEqual([1, 3, 2]);
  });

  test("is stable for ties (preserves incoming order)", () => {
    const r = [
      { id: 1, g: "x" },
      { id: 2, g: "x" },
      { id: 3, g: "x" },
    ];
    expect(ids(sortRows(r, (x) => x.g, "asc"))).toEqual([1, 2, 3]);
    expect(ids(sortRows(r, (x) => x.g, "desc"))).toEqual([1, 2, 3]);
  });

  test("does not mutate the input array", () => {
    const r = [{ id: 3 }, { id: 1 }, { id: 2 }];
    const copy = [...r];
    sortRows(r, (x) => x.id, "asc");
    expect(r).toEqual(copy);
  });
});
