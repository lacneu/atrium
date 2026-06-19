// Pure sort/filter logic for the Bridge tab's "Connexions" table — extracted from
// the component so column sorting + per-column filtering are UNIT-TESTED without a
// DOM (the live bench has too few/uniform connections to exercise these branches).
// The table itself is bespoke (not DataTableShell): sort is CLIENT-side over a tiny
// fixed array, which would be the wrong abstraction to bake into the shared shell.

import { compareVersions } from "../../../convex/lib/compat";

/** "Select all" sentinel for the quick <Select> filters (radix has no empty value);
 *  same convention as TracesTab. */
export const ALL = "__all__";

/** The minimal connection shape the table sorts + filters on. The component's row
 *  view carries more (the raw target, for the error sub-row) and structurally
 *  satisfies this — so the helpers stay pure and testable with tiny fixtures. */
export type ConnFields = {
  targetLabel: string; // `${canonical}/${agentId}`
  state: string; // connected | error | idle
  instanceName: string | null;
  instanceLabel: string | null;
  gatewayHost: string;
  gatewayVersion: string | null;
  okCount: number;
  errorCount: number;
  attempts: number;
  lastOkAt: number | null;
};

/** Columns the table can sort on (stats is a composite cell → not sortable). */
export type ConnSortKey =
  | "target"
  | "state"
  | "instance"
  | "host"
  | "version"
  | "lastOk";
export type SortDir = "asc" | "desc";
export type ConnSort = { key: ConnSortKey; dir: SortDir };

export type ConnFilters = {
  q: string; // free-text over target + host
  state: string; // ALL or an exact state
  instance: string; // ALL or an exact instanceName
  version: string; // ALL or an exact gatewayVersion
};

export const EMPTY_CONN_FILTERS: ConnFilters = {
  q: "",
  state: ALL,
  instance: ALL,
  version: ALL,
};

/** Intentional sort order for the state column (connected first, then error, then
 *  idle/anything else) — more useful than alphabetical for an operator. */
const STATE_ORDER: Record<string, number> = { connected: 0, error: 1, idle: 2 };

export function hasActiveConnFilters(f: ConnFilters): boolean {
  return (
    f.q.trim() !== "" ||
    f.state !== ALL ||
    f.instance !== ALL ||
    f.version !== ALL
  );
}

export function filterConnections<T extends ConnFields>(
  rows: T[],
  f: ConnFilters,
): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !`${r.targetLabel} ${r.gatewayHost}`.toLowerCase().includes(q)) {
      return false;
    }
    if (f.state !== ALL && r.state !== f.state) return false;
    if (f.instance !== ALL && (r.instanceName ?? "") !== f.instance) return false;
    if (f.version !== ALL && (r.gatewayVersion ?? "") !== f.version) return false;
    return true;
  });
}

/** Numeric-aware string compare (host:port, names). */
function strCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Is this row's value for `key` absent (→ always sorts LAST, regardless of dir)? */
function isNullForKey(key: ConnSortKey, r: ConnFields): boolean {
  if (key === "version") return r.gatewayVersion === null;
  if (key === "lastOk") return r.lastOkAt === null;
  return false;
}

/** Compare two NON-null rows on `key` (ascending sense). */
function cmpNonNull(key: ConnSortKey, a: ConnFields, b: ConnFields): number {
  switch (key) {
    case "state":
      return (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99);
    case "instance":
      return strCmp(
        a.instanceLabel ?? a.instanceName ?? "",
        b.instanceLabel ?? b.instanceName ?? "",
      );
    case "host":
      return strCmp(a.gatewayHost, b.gatewayHost);
    case "version": {
      // Version-aware (NOT lexical: "2026.6.10" must sort AFTER "2026.6.5").
      const va = a.gatewayVersion as string;
      const vb = b.gatewayVersion as string;
      return compareVersions(va, vb) ?? strCmp(va, vb);
    }
    case "lastOk":
      return (a.lastOkAt as number) - (b.lastOkAt as number);
    case "target":
    default:
      return strCmp(a.targetLabel, b.targetLabel);
  }
}

/** Sort a copy of `rows` by `sort`. Missing values (null version / never-OK) are
 *  pinned LAST in BOTH directions; the direction only flips the real comparison. */
export function sortConnections<T extends ConnFields>(
  rows: T[],
  sort: ConnSort | null,
): T[] {
  if (!sort) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const an = isNullForKey(sort.key, a);
    const bn = isNullForKey(sort.key, b);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return sign * cmpNonNull(sort.key, a, b);
  });
}

/** Distinct states present (for the state <Select>), in the intentional order. */
export function distinctStates<T extends ConnFields>(rows: T[]): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add(r.state);
  return [...set].sort(
    (a, b) => (STATE_ORDER[a] ?? 99) - (STATE_ORDER[b] ?? 99),
  );
}

/** Distinct instances present (value = name, display = label), sorted by label. */
export function distinctInstances<T extends ConnFields>(
  rows: T[],
): { name: string; label: string }[] {
  const byName = new Map<string, string>();
  for (const r of rows) {
    if (r.instanceName === null) continue;
    if (!byName.has(r.instanceName)) {
      byName.set(r.instanceName, r.instanceLabel ?? r.instanceName);
    }
  }
  return [...byName.entries()]
    .map(([name, label]) => ({ name, label }))
    .sort((a, b) => strCmp(a.label, b.label));
}

/** Distinct gateway versions present (non-null), newest-aware order. */
export function distinctVersions<T extends ConnFields>(rows: T[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.gatewayVersion !== null) set.add(r.gatewayVersion);
  return [...set].sort((a, b) => compareVersions(a, b) ?? strCmp(a, b));
}
