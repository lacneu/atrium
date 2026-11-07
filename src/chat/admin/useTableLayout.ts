// An admin table's layout — its columns, or stacked rows — MEASURED, never guessed:
// the table's narrowest width (a DOM clone at min-content, off-screen) against the
// width its wrapper has. Below it the table would scroll sideways, its last columns
// (the actions) out of sight; stacked, every row reads in place. Shared by
// DataTableShell and the scheduled jobs' list; the stacked styles are
// `.oc-tablefit[data-layout="stacked"]` in convexChat.css.
import { type DependencyList, type RefObject } from "react";
import { useFitLevel } from "@/lib/useFitLevel";
import { measureCloneWidths } from "@/lib/measureClone";
import { tableLayoutFit } from "./dataTableLayout";

export type TableLayout = "table" | "stacked";

/** `wrapRef` holds the table — or several, which then share one layout, decided
 *  by the widest (the scheduled jobs: one table per instance, read as one list);
 *  `deps` are what changes the width they need (rows, columns, sort, language). */
export function useTableLayout(
  wrapRef: RefObject<HTMLElement | null>,
  deps: DependencyList,
): TableLayout {
  const level = useFitLevel(
    () => {
      const wrap = wrapRef.current;
      const tables = wrap ? Array.from(wrap.querySelectorAll<HTMLTableElement>("table")) : [];
      if (!wrap || tables.length === 0) return null;
      let needed = 0;
      for (const table of tables) {
        const [width] = measureCloneWidths(table, [() => undefined], "oc-dt__measure");
        needed = Math.max(needed, width);
      }
      return tableLayoutFit(wrap.clientWidth, needed);
    },
    () => [wrapRef.current],
    deps,
  );
  return level > 0 ? "stacked" : "table";
}
