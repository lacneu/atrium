/// <reference types="vite/client" />
//
// Pure unit tests for lib/filters: q substring, time range, statusClass range,
// impersonated bool, and the advanced predicate ops — all ANDed, over the VIEW
// objects a resource returns.

import { describe, expect, test } from "vitest";
import {
  applyFilter,
  matchesFilter,
  type FilterConfig,
} from "./lib/filters";

// A traces-like config (q + time + statusClass + structured + advanced).
const TRACES_CFG: FilterConfig = {
  searchFields: ["kind", "principalId", "roleKey", "route", "correlationId"],
  timeField: "at",
  structured: {
    kind: { field: "kind", kind: "string" },
    statusClass: { field: "status", kind: "statusClass" },
    principalType: { field: "principalType", kind: "string" },
    direction: { field: "direction", kind: "string" },
    roleKey: { field: "roleKey", kind: "string" },
  },
  advanced: true,
};

// An audit-like config exercising the `impersonated` bool + computed labels.
const AUDIT_CFG: FilterConfig = {
  searchFields: ["action", "realLabel", "targetLabel", "resourceId"],
  timeField: "at",
  structured: {
    action: { field: "action", kind: "string" },
    impersonated: { field: "impersonated", kind: "bool" },
    resource: { field: "resource", kind: "string" },
  },
  advanced: true,
};

function traceRow(over: Record<string, unknown> = {}) {
  return {
    at: 1000,
    kind: "api.call",
    principalType: "service",
    principalId: "sa_abc",
    roleKey: "observer",
    route: "/api/v1/traces",
    status: 200,
    latencyMs: 12,
    correlationId: "corr-1",
    ...over,
  };
}

describe("matchesFilter — q (case-insensitive substring)", () => {
  test("matches over any searchField, case-insensitively", () => {
    const row = traceRow();
    expect(matchesFilter(row, { q: "API.CALL" }, TRACES_CFG)).toBe(true); // kind
    expect(matchesFilter(row, { q: "/api/v1" }, TRACES_CFG)).toBe(true); // route
    expect(matchesFilter(row, { q: "OBSERVER" }, TRACES_CFG)).toBe(true); // roleKey
    expect(matchesFilter(row, { q: "corr-1" }, TRACES_CFG)).toBe(true);
  });

  test("does not match outside the search fields", () => {
    const row = traceRow();
    // latencyMs is NOT a search field, so "12" must not match.
    expect(matchesFilter(row, { q: "12" }, TRACES_CFG)).toBe(false);
    expect(matchesFilter(row, { q: "nope" }, TRACES_CFG)).toBe(false);
  });
});

describe("matchesFilter — time range (inclusive)", () => {
  const row = traceRow({ at: 5000 });
  test("keeps rows within [from, to]", () => {
    expect(matchesFilter(row, { from: 1000, to: 9000 }, TRACES_CFG)).toBe(true);
    expect(matchesFilter(row, { from: 5000 }, TRACES_CFG)).toBe(true); // inclusive
    expect(matchesFilter(row, { to: 5000 }, TRACES_CFG)).toBe(true); // inclusive
  });
  test("drops rows outside the range", () => {
    expect(matchesFilter(row, { from: 6000 }, TRACES_CFG)).toBe(false);
    expect(matchesFilter(row, { to: 4000 }, TRACES_CFG)).toBe(false);
  });
});

describe("matchesFilter — statusClass (HTTP class range)", () => {
  test("2xx / 4xx / 5xx map to the right ranges", () => {
    expect(
      matchesFilter(traceRow({ status: 204 }), { statusClass: "2xx" }, TRACES_CFG),
    ).toBe(true);
    expect(
      matchesFilter(traceRow({ status: 404 }), { statusClass: "4xx" }, TRACES_CFG),
    ).toBe(true);
    expect(
      matchesFilter(traceRow({ status: 503 }), { statusClass: "5xx" }, TRACES_CFG),
    ).toBe(true);
    // 200 is not a 4xx.
    expect(
      matchesFilter(traceRow({ status: 200 }), { statusClass: "4xx" }, TRACES_CFG),
    ).toBe(false);
  });
});

describe("matchesFilter — impersonated bool", () => {
  const base = {
    at: 1000,
    action: "chat.delete",
    realLabel: "admin@x.io",
    targetLabel: "user@x.io",
    impersonated: true,
    resource: "chat",
    resourceId: "chat_1",
  };
  test("filters true / false on the bool field", () => {
    expect(matchesFilter(base, { impersonated: true }, AUDIT_CFG)).toBe(true);
    expect(matchesFilter(base, { impersonated: false }, AUDIT_CFG)).toBe(false);
    expect(
      matchesFilter({ ...base, impersonated: false }, { impersonated: false }, AUDIT_CFG),
    ).toBe(true);
  });
  test("q searches the COMPUTED labels (D2 view boundary)", () => {
    expect(matchesFilter(base, { q: "admin@x" }, AUDIT_CFG)).toBe(true);
    expect(matchesFilter(base, { q: "user@x" }, AUDIT_CFG)).toBe(true);
  });
});

describe("matchesFilter — advanced predicate ops", () => {
  const row = traceRow({ status: 500, latencyMs: 250, kind: "api.call" });
  test("eq / neq", () => {
    expect(
      matchesFilter(row, { advanced: [{ field: "kind", op: "eq", value: "api.call" }] }, TRACES_CFG),
    ).toBe(true);
    expect(
      matchesFilter(row, { advanced: [{ field: "kind", op: "neq", value: "chat.send" }] }, TRACES_CFG),
    ).toBe(true);
    // eq on an absent field -> false; neq on an absent field -> true.
    expect(
      matchesFilter(row, { advanced: [{ field: "missing", op: "eq", value: "x" }] }, TRACES_CFG),
    ).toBe(false);
    expect(
      matchesFilter(row, { advanced: [{ field: "missing", op: "neq", value: "x" }] }, TRACES_CFG),
    ).toBe(true);
  });
  test("contains (stringified, case-insensitive)", () => {
    expect(
      matchesFilter(row, { advanced: [{ field: "route", op: "contains", value: "TRACES" }] }, TRACES_CFG),
    ).toBe(true);
  });
  test("gt / gte / lt / lte (numeric)", () => {
    expect(
      matchesFilter(row, { advanced: [{ field: "latencyMs", op: "gt", value: 100 }] }, TRACES_CFG),
    ).toBe(true);
    expect(
      matchesFilter(row, { advanced: [{ field: "latencyMs", op: "gte", value: 250 }] }, TRACES_CFG),
    ).toBe(true);
    expect(
      matchesFilter(row, { advanced: [{ field: "latencyMs", op: "lt", value: 250 }] }, TRACES_CFG),
    ).toBe(false);
    expect(
      matchesFilter(row, { advanced: [{ field: "latencyMs", op: "lte", value: 250 }] }, TRACES_CFG),
    ).toBe(true);
  });
  test("multiple predicates are ANDed", () => {
    expect(
      matchesFilter(
        row,
        {
          advanced: [
            { field: "kind", op: "eq", value: "api.call" },
            { field: "latencyMs", op: "gt", value: 1000 }, // fails
          ],
        },
        TRACES_CFG,
      ),
    ).toBe(false);
  });
});

describe("matchesFilter — clauses are ANDed; unknown keys ignored", () => {
  test("a non-matching clause fails the whole filter", () => {
    const row = traceRow({ status: 200 });
    expect(
      matchesFilter(row, { q: "api.call", statusClass: "5xx" }, TRACES_CFG),
    ).toBe(false);
  });
  test("a structured key the resource does NOT declare is ignored", () => {
    const row = traceRow();
    // `severity` is not in TRACES_CFG.structured -> ignored, so it still matches.
    expect(matchesFilter(row, { severity: "critical" }, TRACES_CFG)).toBe(true);
  });
});

describe("applyFilter", () => {
  test("filters an array and returns the survivors in order", () => {
    const rows = [
      traceRow({ at: 1, status: 200 }),
      traceRow({ at: 2, status: 404 }),
      traceRow({ at: 3, status: 500 }),
    ];
    const out = applyFilter(rows, { statusClass: "4xx" }, TRACES_CFG);
    expect(out.length).toBe(1);
    expect(out[0]!.status).toBe(404);
  });
  test("undefined filter returns the rows unchanged", () => {
    const rows = [traceRow()];
    expect(applyFilter(rows, undefined, TRACES_CFG)).toBe(rows);
  });
});
