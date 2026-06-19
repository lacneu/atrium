import { describe, expect, test } from "vitest";
import {
  ALL,
  EMPTY_CONN_FILTERS,
  distinctInstances,
  distinctStates,
  distinctVersions,
  filterConnections,
  hasActiveConnFilters,
  sortConnections,
  type ConnFields,
} from "./connectionsTableView";

// The live bench has 3 connections, all "connected", all 2026.6.5 — sorting and
// filtering would look right there while never exercising a branch. These fixtures
// vary state/version/instance/last-OK ON PURPOSE so every branch FAILS if it
// regresses (e.g. lexical version sort, nulls-first, a no-op filter).

function row(p: Partial<ConnFields>): ConnFields {
  return {
    targetLabel: "olivier/alice",
    state: "connected",
    instanceName: "primary",
    instanceLabel: "Primary",
    gatewayHost: "127.0.0.1:18790",
    gatewayVersion: "2026.6.5",
    okCount: 1,
    errorCount: 0,
    attempts: 1,
    lastOkAt: 1000,
    ...p,
  };
}

const labels = (rows: ConnFields[]) => rows.map((r) => r.targetLabel);

describe("sortConnections — version column is VERSION-aware, not lexical", () => {
  const rows = [
    row({ targetLabel: "a", gatewayVersion: "2026.6.5" }),
    row({ targetLabel: "b", gatewayVersion: "2026.6.10" }),
    row({ targetLabel: "c", gatewayVersion: "2026.6.9" }),
  ];

  test("asc orders 6.5 < 6.9 < 6.10 (lexical would wrongly put 6.10 first)", () => {
    expect(labels(sortConnections(rows, { key: "version", dir: "asc" }))).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  test("desc reverses the real order: 6.10 > 6.9 > 6.5", () => {
    expect(labels(sortConnections(rows, { key: "version", dir: "desc" }))).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("sortConnections — missing values pin LAST in both directions", () => {
  const rows = [
    row({ targetLabel: "withVer", gatewayVersion: "2026.6.5" }),
    row({ targetLabel: "noVer", gatewayVersion: null }),
  ];
  test("null version is last ascending", () => {
    expect(labels(sortConnections(rows, { key: "version", dir: "asc" }))).toEqual([
      "withVer",
      "noVer",
    ]);
  });
  test("null version is STILL last descending (not flipped to the top)", () => {
    expect(labels(sortConnections(rows, { key: "version", dir: "desc" }))).toEqual([
      "withVer",
      "noVer",
    ]);
  });

  test("never-OK (lastOkAt null) pins last both ways", () => {
    const r = [
      row({ targetLabel: "ok", lastOkAt: 5000 }),
      row({ targetLabel: "never", lastOkAt: null }),
    ];
    expect(labels(sortConnections(r, { key: "lastOk", dir: "asc" }))).toEqual([
      "ok",
      "never",
    ]);
    expect(labels(sortConnections(r, { key: "lastOk", dir: "desc" }))).toEqual([
      "ok",
      "never",
    ]);
  });
});

describe("sortConnections — other columns", () => {
  test("state uses the intentional order (connected < error < idle), not alpha", () => {
    const rows = [
      row({ targetLabel: "i", state: "idle" }),
      row({ targetLabel: "e", state: "error" }),
      row({ targetLabel: "c", state: "connected" }),
    ];
    expect(labels(sortConnections(rows, { key: "state", dir: "asc" }))).toEqual([
      "c",
      "e",
      "i",
    ]);
  });

  test("lastOk sorts numerically (asc = oldest first)", () => {
    const rows = [
      row({ targetLabel: "new", lastOkAt: 3000 }),
      row({ targetLabel: "old", lastOkAt: 1000 }),
    ];
    expect(labels(sortConnections(rows, { key: "lastOk", dir: "asc" }))).toEqual([
      "old",
      "new",
    ]);
  });

  test("no sort returns the rows unchanged (same reference order)", () => {
    const rows = [row({ targetLabel: "z" }), row({ targetLabel: "a" })];
    expect(labels(sortConnections(rows, null))).toEqual(["z", "a"]);
  });
});

describe("filterConnections", () => {
  const rows = [
    row({ targetLabel: "olivier/alice", gatewayHost: "127.0.0.1:18790", state: "connected", instanceName: "primary", gatewayVersion: "2026.6.5" }),
    row({ targetLabel: "jerome/bob", gatewayHost: "127.0.0.1:18890", state: "error", instanceName: "beta", gatewayVersion: "2026.6.9" }),
  ];

  test("q matches the target (case-insensitive)", () => {
    expect(labels(filterConnections(rows, { ...EMPTY_CONN_FILTERS, q: "JEROME" }))).toEqual([
      "jerome/bob",
    ]);
  });

  test("q ALSO matches the host (a port number)", () => {
    expect(labels(filterConnections(rows, { ...EMPTY_CONN_FILTERS, q: "18890" }))).toEqual([
      "jerome/bob",
    ]);
  });

  test("state filter narrows to an exact state", () => {
    expect(labels(filterConnections(rows, { ...EMPTY_CONN_FILTERS, state: "error" }))).toEqual([
      "jerome/bob",
    ]);
  });

  test("instance filter matches by NAME (not label)", () => {
    expect(labels(filterConnections(rows, { ...EMPTY_CONN_FILTERS, instance: "primary" }))).toEqual([
      "olivier/alice",
    ]);
  });

  test("version filter narrows to an exact version", () => {
    expect(labels(filterConnections(rows, { ...EMPTY_CONN_FILTERS, version: "2026.6.9" }))).toEqual([
      "jerome/bob",
    ]);
  });

  test("empty filters keep every row (a no-op filter is a real regression risk)", () => {
    expect(filterConnections(rows, EMPTY_CONN_FILTERS)).toHaveLength(2);
  });
});

describe("hasActiveConnFilters", () => {
  test("empty → false; any set field → true", () => {
    expect(hasActiveConnFilters(EMPTY_CONN_FILTERS)).toBe(false);
    expect(hasActiveConnFilters({ ...EMPTY_CONN_FILTERS, q: "x" })).toBe(true);
    expect(hasActiveConnFilters({ ...EMPTY_CONN_FILTERS, state: "error" })).toBe(true);
    expect(hasActiveConnFilters({ ...EMPTY_CONN_FILTERS, instance: "beta" })).toBe(true);
    expect(hasActiveConnFilters({ ...EMPTY_CONN_FILTERS, version: "2026.6.5" })).toBe(true);
  });
  test("whitespace-only q is NOT active", () => {
    expect(hasActiveConnFilters({ ...EMPTY_CONN_FILTERS, q: "   " })).toBe(false);
  });
});

describe("distinct option lists", () => {
  const rows = [
    row({ state: "error", instanceName: "beta", instanceLabel: "Beta", gatewayVersion: "2026.6.10" }),
    row({ state: "connected", instanceName: "primary", instanceLabel: "Primary", gatewayVersion: "2026.6.5" }),
    row({ state: "connected", instanceName: "primary", instanceLabel: "Primary", gatewayVersion: null }),
  ];

  test("distinctStates is deduped and in intentional order", () => {
    expect(distinctStates(rows)).toEqual(["connected", "error"]);
  });

  test("distinctInstances dedupes by name, sorted by label", () => {
    expect(distinctInstances(rows)).toEqual([
      { name: "beta", label: "Beta" },
      { name: "primary", label: "Primary" },
    ]);
  });

  test("distinctVersions excludes null and is version-sorted", () => {
    expect(distinctVersions(rows)).toEqual(["2026.6.5", "2026.6.10"]);
  });
});

test("ALL sentinel is the documented radix empty-value stand-in", () => {
  expect(ALL).toBe("__all__");
});
