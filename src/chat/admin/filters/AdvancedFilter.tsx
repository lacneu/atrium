import { useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { coercePredicateValue, type Op, type Predicate } from "./types";
import { m } from "@/paraglide/messages.js";

// Collapsible advanced-filter predicate builder (Traces + Audit). Each row is a
// field <Select> (resource-provided list) + op <Select> + value <Input>. Rows
// are ANDed. On every change it emits the FULLY-COERCED predicate list (number/
// bool/string) so the backend's typed comparisons behave (see
// coercePredicateValue). A row with an empty field or value is dropped from the
// emitted list (still editable in the UI) so a half-built row never filters out
// everything.

/** A field option for the builder's field <Select>. */
export type AdvancedField = { value: string; label: string };

const OPS: { value: Op; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "contains", label: m.advfilter_op_contains() },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
];

// Local draft row: the value is always the raw string the user typed; it is
// coerced only when emitted upward.
type DraftRow = { id: number; field: string; op: Op; value: string };

let nextId = 1;
function newRow(): DraftRow {
  return { id: nextId++, field: "", op: "eq", value: "" };
}

// Build the initial draft rows from a seed predicate list (e.g. restored from
// the URL on refresh). The predicate `value` is already a typed primitive, so
// stringify it for the value <Input>. An empty seed yields no rows.
function seedRows(seed: Predicate[]): DraftRow[] {
  return seed.map((p) => ({
    id: nextId++,
    field: p.field,
    op: p.op,
    value: String(p.value),
  }));
}

export function AdvancedFilter({
  fields,
  seed,
  onChange,
}: {
  fields: AdvancedField[];
  /**
   * Optional initial predicate list (e.g. restored from the URL). Seeds the
   * builder ONCE on mount so a deep-linked/refreshed advanced filter shows its
   * rows. Subsequent edits are owned by local draft state — `seed` is not a
   * controlled value (intentional: the builder keeps half-built rows the URL
   * never sees).
   */
  seed?: Predicate[];
  /** Emits the coerced, ANDed predicate list (complete rows only). */
  onChange: (predicates: Predicate[]) => void;
}) {
  // Seed only on the first render (ref guard) — never re-clobber local edits
  // when the parent re-renders with the same (or echoed) predicate list.
  const seedRef = useRef(seed);
  const hasSeed = Boolean(seedRef.current && seedRef.current.length > 0);
  // Auto-expand when seeded so a restored/deep-linked advanced filter is visible.
  const [open, setOpen] = useState(hasSeed);
  const [rows, setRows] = useState<DraftRow[]>(() =>
    hasSeed ? seedRows(seedRef.current!) : [],
  );

  function emit(next: DraftRow[]) {
    const predicates: Predicate[] = next
      .filter((r) => r.field !== "" && r.value !== "")
      .map((r) => ({
        field: r.field,
        op: r.op,
        value: coercePredicateValue(r.value),
      }));
    onChange(predicates);
  }

  // Compute `next` from the current `rows` closure, then set + emit OUTSIDE the
  // updater: a state updater must be pure (no parent setState inside it, which
  // would double-fire `onChange` under StrictMode). Adding a row never changes
  // the emitted predicates (it has no field/value yet), so addRow needn't emit.
  function patch(id: number, partial: Partial<DraftRow>) {
    const next = rows.map((r) => (r.id === id ? { ...r, ...partial } : r));
    setRows(next);
    emit(next);
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(id: number) {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next);
  }

  const activeCount = rows.filter(
    (r) => r.field !== "" && r.value !== "",
  ).length;

  return (
    <div className="oc-advfilter">
      <button
        type="button"
        className="oc-advfilter__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown
          className={"oc-advfilter__chevron" + (open ? " is-open" : "")}
          aria-hidden
        />
        {m.advfilter_toggle()}
        {activeCount > 0 ? (
          <span className="oc-advfilter__count">{activeCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="oc-advfilter__body">
          {rows.length === 0 ? (
            <p className="oc-admin__hint">{m.advfilter_empty_state()}</p>
          ) : (
            <ul className="oc-advfilter__rows">
              {rows.map((row) => (
                <li key={row.id} className="oc-advfilter__row">
                  <Select
                    value={row.field || undefined}
                    onValueChange={(v) => patch(row.id, { field: v })}
                  >
                    <SelectTrigger size="sm" className="w-40">
                      <SelectValue placeholder={m.advfilter_field_placeholder()} />
                    </SelectTrigger>
                    <SelectContent>
                      {fields.map((f) => (
                        <SelectItem key={f.value} value={f.value}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={row.op}
                    onValueChange={(v) => patch(row.id, { op: v as Op })}
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="oc-advfilter__value"
                    value={row.value}
                    onChange={(e) => patch(row.id, { value: e.target.value })}
                    placeholder={m.advfilter_value_placeholder()}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.advfilter_remove_condition()}
                    onClick={() => removeRow(row.id)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="outline"
            size="sm"
            className="oc-advfilter__add"
            onClick={addRow}
          >
            <Plus />
            {m.advfilter_add_condition()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
