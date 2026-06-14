// Round-trip + default-on-garbage tests for the per-tab search schemas. These
// prove URL-state persistence WITHOUT a browser: a representative filter state
// encodes → decodes back to a deep-equal object (so refresh/bookmark restore the
// same filters), and a malformed/missing search record degrades to safe defaults
// without throwing (so a hand-edited URL never crashes the route).
//
// The schemas are pure (zod + the framework-free filters/types.ts), so this runs
// under the existing edge-runtime vitest env alongside the Convex tests.

import { describe, it, expect } from "vitest";
import {
  tracesSearchSchema,
  auditSearchSchema,
  anomaliesSearchSchema,
  kpiSearchSchema,
  serviceAccountsSearchSchema,
  usersSearchSchema,
  groupsSearchSchema,
  decodeRange,
  encodeRange,
  encodeAdv,
  parseAdv,
} from "./searchSchemas";
import type { Predicate, TimeRange } from "@/chat/admin/filters/types";

// A schema round-trips a value when parse(value) === value (the schema is
// idempotent over a state it itself can produce). `validateSearch` calls
// `schema.parse(rawSearchRecord)`, so this models exactly the URL → state path.
function roundTrips<T extends Record<string, unknown>>(
  schema: { parse: (v: unknown) => T },
  value: T,
): void {
  expect(schema.parse(value)).toEqual(value);
}

describe("time-range token (de)serialization", () => {
  it("round-trips a relative range as tokens (never resolved epochs)", () => {
    const range: TimeRange = { kind: "relative", from: "now-7d", to: "now" };
    const enc = encodeRange(range);
    expect(enc).toEqual({ from: "now-7d", to: "now" });
    expect(decodeRange(enc.from, enc.to)).toEqual(range);
  });

  it("round-trips an absolute range as epoch-ms strings", () => {
    const range: TimeRange = { kind: "absolute", from: 1_700_000_000_000, to: 1_700_086_400_000 };
    const enc = encodeRange(range);
    expect(enc).toEqual({ from: "1700000000000", to: "1700086400000" });
    expect(decodeRange(enc.from, enc.to)).toEqual(range);
  });

  it("falls back to the default relative range on missing/garbage tokens", () => {
    expect(decodeRange(undefined, undefined)).toEqual({
      kind: "relative",
      from: "now-30d",
      to: "now",
    });
    // A half-numeric pair is NOT absolute → stays relative (degrades, no throw).
    expect(decodeRange("garbage", "123")).toEqual({
      kind: "relative",
      from: "garbage",
      to: "123",
    });
    // Custom defaults (KPI uses now-24h).
    expect(decodeRange(undefined, undefined, "now-24h", "now")).toEqual({
      kind: "relative",
      from: "now-24h",
      to: "now",
    });
  });
});

describe("adv predicate (de)serialization", () => {
  it("round-trips a typed predicate list (string/number/bool values)", () => {
    const preds: Predicate[] = [
      { field: "status", op: "gte", value: 500 },
      { field: "route", op: "contains", value: "/api" },
      { field: "impersonated", op: "eq", value: true },
    ];
    const enc = encodeAdv(preds);
    expect(typeof enc).toBe("string");
    expect(parseAdv(enc)).toEqual(preds);
  });

  it("encodes an empty list as undefined (stays out of the URL)", () => {
    expect(encodeAdv([])).toBeUndefined();
    expect(parseAdv(undefined)).toEqual([]);
  });

  it("drops malformed rows without throwing (robust degradation)", () => {
    // Not JSON.
    expect(parseAdv("{not json")).toEqual([]);
    // Not an array.
    expect(parseAdv(JSON.stringify({ field: "x" }))).toEqual([]);
    // Mixed: only the well-formed row survives.
    const blob = JSON.stringify([
      { field: "status", op: "gte", value: 500 }, // ok
      { field: "", op: "eq", value: 1 }, // empty field → dropped
      { field: "x", op: "bogus", value: 1 }, // bad op → dropped
      { field: "y", op: "eq", value: { nested: true } }, // bad value type → dropped
      { op: "eq", value: 1 }, // missing field → dropped
      "string-row", // not an object → dropped
    ]);
    expect(parseAdv(blob)).toEqual([{ field: "status", op: "gte", value: 500 }]);
  });
});

describe("tracesSearchSchema", () => {
  it("round-trips a full filter state (relative range + adv)", () => {
    const value = tracesSearchSchema.parse({
      q: "boom",
      kind: "http",
      limit: 200,
      statusClass: "5xx" as const,
      principalType: "service" as const,
      direction: "outbound" as const,
      roleKey: "agent",
      from: "now-7d",
      to: "now",
      adv: encodeAdv([{ field: "status", op: "gte", value: 500 }]),
    });
    roundTrips(tracesSearchSchema, value);
    expect(value.limit).toBe(200);
    // adv stays an opaque string in the schema; the component parses it.
    expect(parseAdv(value.adv)).toEqual([{ field: "status", op: "gte", value: 500 }]);
  });

  it("defaults on an empty record (no throw)", () => {
    const v = tracesSearchSchema.parse({});
    expect(v.kind).toBe("all");
    expect(v.limit).toBe(100);
    expect(v.statusClass).toBeUndefined();
    expect(v.q).toBeUndefined();
  });

  it("degrades garbage to safe defaults (no throw)", () => {
    const v = tracesSearchSchema.parse({
      limit: "99999", // not an allowed window → catch 100
      statusClass: "teapot", // not in enum → undefined
      principalType: 42, // wrong type → undefined
      kind: "", // empty allowed (free string)
    });
    expect(v.limit).toBe(100);
    expect(v.statusClass).toBeUndefined();
    expect(v.principalType).toBeUndefined();
  });
});

describe("auditSearchSchema", () => {
  it("round-trips a full filter state", () => {
    const value = auditSearchSchema.parse({
      q: "delete",
      action: "chat.delete",
      impersonated: "yes" as const,
      resource: "chats",
      from: "now-30d",
      to: "now",
      adv: encodeAdv([{ field: "realLabel", op: "contains", value: "alice" }]),
    });
    roundTrips(auditSearchSchema, value);
  });

  it("degrades garbage impersonated to undefined", () => {
    const v = auditSearchSchema.parse({ impersonated: "maybe" });
    expect(v.impersonated).toBeUndefined();
  });
});

describe("anomaliesSearchSchema", () => {
  it("round-trips a full filter state", () => {
    const value = anomaliesSearchSchema.parse({
      q: "heartbeat",
      status: "acknowledged" as const,
      severity: "critical" as const,
      kind: "missed_beat",
      from: "now-30d",
      to: "now",
    });
    roundTrips(anomaliesSearchSchema, value);
  });

  it("defaults status to open and degrades garbage to open", () => {
    expect(anomaliesSearchSchema.parse({}).status).toBe("open");
    expect(anomaliesSearchSchema.parse({ status: "frobnicate" }).status).toBe("open");
    // The explicit "all" token is preserved (→ undefined arg in the component).
    expect(anomaliesSearchSchema.parse({ status: "all" }).status).toBe("all");
  });
});

describe("kpiSearchSchema", () => {
  it("round-trips a range pair", () => {
    const value = kpiSearchSchema.parse({ from: "now-24h", to: "now" });
    roundTrips(kpiSearchSchema, value);
  });

  it("defaults on an empty record", () => {
    expect(kpiSearchSchema.parse({})).toEqual({});
  });
});

describe("serviceAccountsSearchSchema", () => {
  it("round-trips q + status", () => {
    const value = serviceAccountsSearchSchema.parse({ q: "agent", status: "disabled" as const });
    roundTrips(serviceAccountsSearchSchema, value);
  });

  it("degrades garbage status to undefined", () => {
    expect(serviceAccountsSearchSchema.parse({ status: "paused" }).status).toBeUndefined();
  });
});

describe("usersSearchSchema", () => {
  it("round-trips q + role", () => {
    const value = usersSearchSchema.parse({ q: "alice", role: "admin" });
    roundTrips(usersSearchSchema, value);
  });
});

describe("groupsSearchSchema", () => {
  it("round-trips q + mode", () => {
    const value = groupsSearchSchema.parse({ q: "team", mode: "shared" as const });
    roundTrips(groupsSearchSchema, value);
  });

  it("degrades garbage mode to undefined", () => {
    expect(groupsSearchSchema.parse({ mode: "broadcast" }).mode).toBeUndefined();
  });
});
