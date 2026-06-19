// Sorting for the shared DataTableShell — built into the table so EVERY admin
// list gets consistent, sortable columns (part of the design system). A column
// opts in by declaring a `sort` accessor that returns the UNDERLYING comparable
// value (e.g. a timestamp, not the formatted date string).

export type SortValue = string | number | boolean | null | undefined;
export type SortDir = "asc" | "desc";

// Compare two NON-null values. Numbers numeric; booleans false < true; strings
// locale-aware + numeric-aware ("v2" < "v10") + case-insensitive.
export function compareSortValues(
  a: NonNullable<SortValue>,
  b: NonNullable<SortValue>,
): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

// Stable sort by an accessor + direction. `null`/`undefined` ALWAYS sort last,
// in BOTH directions (the direction flip applies only to the non-null compare).
// Never mutates the input — so clearing the sort returns the original order.
export function sortRows<T>(
  rows: readonly T[],
  accessor: (row: T) => SortValue,
  dir: SortDir,
): T[] {
  return [...rows].sort((x, y) => {
    const a = accessor(x);
    const b = accessor(y);
    const an = a == null;
    const bn = b == null;
    if (an || bn) return an && bn ? 0 : an ? 1 : -1;
    const c = compareSortValues(a, b);
    return dir === "asc" ? c : -c;
  });
}
