// Shared, reusable filter model across the admin lists AND the key-authed
// /api/v1 surface (see docs/FILTERS_SPEC.md). ONE validator + ONE pure matcher,
// so the UI, the Convex queries, and the HTTP routes all agree on the shape.
//
// Boundedness (load-bearing): `applyFilter` is a pure in-memory pass over an
// ALREADY-BOUNDED window of rows (the queries read at most their existing MAX
// cap before filtering, then slice to `limit` AFTER). It never widens a scan and
// never touches the db. A time range whose `from` is older than the bounded
// recent window therefore returns PARTIAL results — the full firehose lives in
// Opik/Langfuse, not here.
//
// D2 (PHI): the matcher operates ONLY over the VIEW object each query is about
// to return. Those views already expose redacted metadata only (traceEvents are
// redacted by design; audit views carry resolved labels + the action/resource,
// never message text). `q`/`advanced` therefore can never surface a field the
// view does not already expose.

import { v, Infer } from "convex/values";

/** Comparison operator for an advanced predicate. */
export type Op = "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte";

const opValidator = v.union(
  v.literal("eq"),
  v.literal("neq"),
  v.literal("contains"),
  v.literal("gt"),
  v.literal("gte"),
  v.literal("lt"),
  v.literal("lte"),
);

/**
 * The shared Filter validator — a SUPERSET of every resource's keys; all
 * optional. A given query applies only the subset its `cfg` declares (extra keys
 * present in the arg are simply ignored for that resource). Add new keys here so
 * the single validator stays the source of truth for UI + API + queries.
 *
 * `correlationId` is intentionally NOT here: it drives a dedicated index path
 * (by_correlation) and stays a separate query arg.
 */
export const filterValidator = v.object({
  // Free-text, case-insensitive substring over the resource's searchFields.
  q: v.optional(v.string()),
  // Inclusive epoch-ms time range on the resource's time field.
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  // Structured "quick" field filters (per-resource subset; all ANDed):
  kind: v.optional(v.string()),
  status: v.optional(v.number()),
  statusClass: v.optional(
    v.union(v.literal("2xx"), v.literal("4xx"), v.literal("5xx")),
  ),
  direction: v.optional(v.string()),
  principalType: v.optional(v.string()),
  roleKey: v.optional(v.string()),
  severity: v.optional(v.string()),
  source: v.optional(v.string()),
  anomalyStatus: v.optional(v.string()),
  action: v.optional(v.string()),
  impersonated: v.optional(v.boolean()),
  resource: v.optional(v.string()),
  role: v.optional(v.string()),
  mode: v.optional(v.string()),
  disabled: v.optional(v.boolean()),
  // Advanced predicate builder (Traces + Audit), ANDed, evaluated in-memory.
  // NOT exposed over HTTP — the structured params + q cover practical agent use.
  advanced: v.optional(
    v.array(
      v.object({
        field: v.string(),
        op: opValidator,
        value: v.union(v.string(), v.number(), v.boolean()),
      }),
    ),
  ),
});

/** The Filter shape, derived from the validator (cannot drift). */
export type Filter = Infer<typeof filterValidator>;

/** A row the matcher can read: a plain record of primitive-ish values. */
type Row = Record<string, unknown>;

/**
 * How one structured filter KEY maps onto a resource's VIEW field + how to
 * compare it. Several keys do NOT share the view field name, and the SAME key
 * maps differently per resource:
 *   - `statusClass` -> `status` (number) with HTTP-class range logic (traces)
 *   - `anomalyStatus` -> `status` (anomalies)
 *   - `role` -> `roleKey` for service accounts, but `role` -> `role` for users
 * A bare list of allowed keys cannot express this, so each resource declares an
 * explicit key->field map.
 */
type StructuredKind = "string" | "number" | "bool" | "statusClass";
type StructuredSpec = { field: string; kind: StructuredKind };

/** Per-resource filter configuration. */
export type FilterConfig = {
  /** View fields the `q` substring searches (case-insensitive). */
  searchFields: string[];
  /** The view's numeric epoch-ms time field, if the resource is time-ranged. */
  timeField?: string;
  /** Allowed structured filter keys -> their view field + comparison kind. */
  structured: Partial<Record<keyof Filter, StructuredSpec>>;
  /** Whether the advanced predicate list applies to this resource. */
  advanced?: boolean;
};

/** Lowercased string form of a value for case-insensitive substring search. */
function asSearchText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).toLowerCase();
}

/** Does any of the row's searchFields contain `q` (case-insensitive)? */
function matchesQuery(row: Row, q: string, searchFields: string[]): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  for (const field of searchFields) {
    if (asSearchText(row[field]).includes(needle)) return true;
  }
  return false;
}

/** HTTP status-class membership: 2xx -> [200,300), 4xx, 5xx. */
function matchesStatusClass(
  status: unknown,
  cls: "2xx" | "4xx" | "5xx",
): boolean {
  if (typeof status !== "number") return false;
  switch (cls) {
    case "2xx":
      return status >= 200 && status <= 299;
    case "4xx":
      return status >= 400 && status <= 499;
    case "5xx":
      return status >= 500 && status <= 599;
    default:
      return false;
  }
}

/** Evaluate one structured filter key against the row. */
function matchesStructured(
  row: Row,
  spec: StructuredSpec,
  filterValue: unknown,
): boolean {
  const actual = row[spec.field];
  switch (spec.kind) {
    case "statusClass":
      return matchesStatusClass(
        actual,
        filterValue as "2xx" | "4xx" | "5xx",
      );
    case "number":
      return typeof actual === "number" && actual === filterValue;
    case "bool":
      // Treat an absent boolean view field as `false` (e.g. disabled flags).
      return (actual ?? false) === filterValue;
    case "string":
    default:
      return actual === filterValue;
  }
}

/** Evaluate one advanced predicate against the row. */
function matchesPredicate(
  row: Row,
  pred: { field: string; op: Op; value: string | number | boolean },
): boolean {
  const actual = row[pred.field];
  const present = actual !== undefined && actual !== null;
  switch (pred.op) {
    case "eq":
      // Absent field never equals a provided value.
      return present && actual === pred.value;
    case "neq":
      // Absent field is considered "not equal" (no value to match).
      return !present || actual !== pred.value;
    case "contains":
      // Stringify both sides for a case-insensitive substring test.
      return present
        ? asSearchText(actual).includes(String(pred.value).toLowerCase())
        : false;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (!present) return false;
      // Numeric compare when both sides are numbers; else lexical string compare.
      if (typeof actual === "number" && typeof pred.value === "number") {
        return compare(actual, pred.value, pred.op);
      }
      return compare(String(actual), String(pred.value), pred.op);
    }
    default:
      return false;
  }
}

/** Ordered comparison shared by the numeric + lexical paths. */
function compare<T extends number | string>(a: T, b: T, op: Op): boolean {
  switch (op) {
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

/**
 * Does a single VIEW row satisfy the filter for this resource? All active
 * clauses are ANDed: `q`, the time range on `cfg.timeField`, every declared
 * structured key present in the filter, and (when `cfg.advanced`) every advanced
 * predicate. Keys in the filter that the resource does NOT declare are ignored.
 */
export function matchesFilter(
  row: Row,
  filter: Filter,
  cfg: FilterConfig,
): boolean {
  // q — case-insensitive substring over the resource's search fields.
  if (filter.q !== undefined && !matchesQuery(row, filter.q, cfg.searchFields)) {
    return false;
  }

  // Time range (inclusive) on the resource's numeric time field.
  if (cfg.timeField !== undefined) {
    const at = row[cfg.timeField];
    if (typeof at === "number") {
      if (filter.from !== undefined && at < filter.from) return false;
      if (filter.to !== undefined && at > filter.to) return false;
    } else if (filter.from !== undefined || filter.to !== undefined) {
      // A time bound was requested but the row has no comparable time -> drop.
      return false;
    }
  }

  // Structured equality (incl. statusClass range + bool flags).
  for (const [key, spec] of Object.entries(cfg.structured) as Array<
    [keyof Filter, StructuredSpec]
  >) {
    const filterValue = filter[key];
    if (filterValue === undefined) continue;
    if (!matchesStructured(row, spec, filterValue)) return false;
  }

  // Advanced predicate list (Traces + Audit only).
  if (cfg.advanced && filter.advanced !== undefined) {
    for (const pred of filter.advanced) {
      if (!matchesPredicate(row, pred)) return false;
    }
  }

  return true;
}

/**
 * Filter an array of VIEW rows in place-order. Pure; bounded by the caller's
 * already-bounded input (apply BEFORE the `limit` slice so `limit` caps the
 * FILTERED set). Returns the same rows that pass `matchesFilter`.
 */
export function applyFilter<T extends Row>(
  rows: T[],
  filter: Filter | undefined,
  cfg: FilterConfig,
): T[] {
  if (filter === undefined) return rows;
  return rows.filter((row) => matchesFilter(row, filter, cfg));
}
