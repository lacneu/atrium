import { Fragment, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  MoreVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { sortRows, type SortDir, type SortValue } from "./dataTableSort";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";

// Reusable admin list pattern (the template the user asked for):
//  - "Add" button in the header (opens a right Sheet, owned by the caller)
//  - leading checkbox column + header select-all
//  - bulk toolbar appears when >0 selected (caller supplies bulk actions)
//  - per-row kebab menu, revealed on row hover AND focus-within (a11y)
// Generic over a row type T with a string id.

export type RowAction<T> = {
  label: string;
  onSelect: (row: T) => void;
  variant?: "default" | "destructive";
};

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  // Opt a column into sorting by returning its UNDERLYING comparable value
  // (a timestamp, a number, an enum rank — NOT the formatted cell string).
  // Columns without `sort` (pure actions / non-data) stay unsortable.
  sort?: (row: T) => SortValue;
};

export function DataTableShell<T extends { _id: string }>({
  title,
  rows,
  columns,
  rowActions,
  onAdd,
  addLabel = m.datatable_add(),
  bulkActions,
  emptyHint = m.datatable_empty_hint(),
  isExpanded,
  renderExpanded,
}: {
  title: string;
  rows: T[] | undefined;
  columns: Column<T>[];
  rowActions?: (row: T) => RowAction<T>[];
  onAdd?: () => void;
  addLabel?: string;
  bulkActions?: { label: string; onSelect: (ids: string[]) => void; variant?: "default" | "destructive" }[];
  emptyHint?: string;
  // Optional inline row expansion: when both are provided and isExpanded(row)
  // is true, an extra full-width row is rendered IMMEDIATELY AFTER that row
  // (so the detail card sits under the row it belongs to, not at the bottom).
  isExpanded?: (row: T) => boolean;
  renderExpanded?: (row: T) => ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Sort is a pure render-time slice (CHARTE: every data column is sortable).
  // null = the server's incoming order. 3-state per column: asc -> desc -> none.
  const [sort, setSort] = useState<{ index: number; dir: SortDir } | null>(null);
  const list = rows ?? [];
  const sortCol = sort ? columns[sort.index] : undefined;
  const sortedList =
    sort && sortCol?.sort ? sortRows(list, sortCol.sort, sort.dir) : list;

  function onSortClick(index: number) {
    setSort((prev) => {
      if (!prev || prev.index !== index) return { index, dir: "asc" };
      if (prev.dir === "asc") return { index, dir: "desc" };
      return null; // third click clears -> back to incoming order
    });
  }

  // Total column span for the full-width expansion cell.
  const colCount =
    (bulkActions ? 1 : 0) + columns.length + (rowActions ? 1 : 0);
  const allChecked = list.length > 0 && selected.size === list.length;
  const someChecked = selected.size > 0 && !allChecked;

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(list.map((r) => r._id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="oc-dt">
      <div className="oc-dt__bar">
        <h2 className="oc-dt__title">{title}</h2>
        <div className="oc-dt__bar-actions">
          {selected.size > 0 && bulkActions
            ? bulkActions.map((a) => (
                <Button
                  key={a.label}
                  size="sm"
                  variant={a.variant === "destructive" ? "destructive" : "outline"}
                  onClick={() => {
                    a.onSelect([...selected]);
                    setSelected(new Set());
                  }}
                >
                  {a.variant === "destructive" ? <Trash2 /> : null}
                  {a.label} ({selected.size})
                </Button>
              ))
            : null}
          {onAdd ? (
            <Button size="sm" onClick={onAdd}>
              <Plus /> {addLabel}
            </Button>
          ) : null}
        </div>
      </div>

      {rows === undefined ? (
        <p className="oc-admin__hint">{m.datatable_loading()}</p>
      ) : list.length === 0 ? (
        <p className="oc-admin__hint">{emptyHint}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {bulkActions ? (
                <TableHead className="w-8">
                  <Checkbox
                    aria-label={m.datatable_select_all()}
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
              ) : null}
              {columns.map((c, i) => {
                const active = sort?.index === i;
                if (!c.sort) {
                  return (
                    <TableHead key={c.header} className={c.className}>
                      {c.header}
                    </TableHead>
                  );
                }
                return (
                  <TableHead
                    key={c.header}
                    className={c.className}
                    aria-sort={
                      active
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className="oc-dt__sort"
                      onClick={() => onSortClick(i)}
                      aria-label={m.datatable_sort_by({ column: c.header })}
                    >
                      {c.header}
                      {active ? (
                        sort.dir === "asc" ? (
                          <ChevronUp className="oc-dt__sort-icon" aria-hidden />
                        ) : (
                          <ChevronDown className="oc-dt__sort-icon" aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDown
                          className="oc-dt__sort-icon oc-dt__sort-icon--idle"
                          aria-hidden
                        />
                      )}
                    </button>
                  </TableHead>
                );
              })}
              {rowActions ? <TableHead className="w-8" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedList.map((row) => {
              const actions = rowActions?.(row) ?? [];
              const expanded = isExpanded?.(row) ?? false;
              return (
                <Fragment key={row._id}>
                <TableRow className="group/row">
                  {bulkActions ? (
                    <TableCell>
                      <Checkbox
                        aria-label={m.datatable_select_row()}
                        checked={selected.has(row._id)}
                        onCheckedChange={() => toggleOne(row._id)}
                      />
                    </TableCell>
                  ) : null}
                  {columns.map((c) => (
                    <TableCell key={c.header} className={c.className}>
                      {c.cell(row)}
                    </TableCell>
                  ))}
                  {rowActions ? (
                    <TableCell>
                      {actions.length > 0 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={m.datatable_actions()}
                              // Hidden until row hover OR keyboard focus within the row.
                              className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100"
                            >
                              <MoreVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {actions.map((a, i) => (
                              <div key={a.label}>
                                {a.variant === "destructive" && i > 0 ? (
                                  <DropdownMenuSeparator />
                                ) : null}
                                <DropdownMenuItem
                                  variant={a.variant}
                                  onSelect={() => a.onSelect(row)}
                                >
                                  {a.label}
                                </DropdownMenuItem>
                              </div>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
                {expanded && renderExpanded ? (
                  <TableRow className="oc-dt__expansion">
                    <TableCell colSpan={colCount} className="oc-dt__expansion-cell">
                      {renderExpanded(row)}
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
