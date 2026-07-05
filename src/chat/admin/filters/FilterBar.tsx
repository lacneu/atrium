import { useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { TimeRangePicker } from "./TimeRangePicker";
import type { TimeRange } from "./types";

// Generic filter row that sits ABOVE the DataTableShell/table: a debounced
// search Input (the `q` clause), a `children` slot for the resource's quick
// <Select> filters, an optional TimeRangePicker, and a reset-filters clear.
// Token-styled; reusable across every admin tab.

const DEBOUNCE_MS = 250;

export function FilterBar({
  q,
  onQChange,
  searchPlaceholder = m.filterbar_search_placeholder(),
  children,
  timeRange,
  onTimeRangeChange,
  onReset,
  canReset = true,
}: {
  /** Committed (debounced) search value owned by the parent. */
  q: string;
  /** Called with the DEBOUNCED value (safe to feed straight into a query arg). */
  onQChange: (q: string) => void;
  searchPlaceholder?: string;
  /** Quick <Select> filters for this resource. */
  children?: ReactNode;
  /** When provided, a TimeRangePicker is rendered. */
  timeRange?: TimeRange;
  onTimeRangeChange?: (range: TimeRange) => void;
  /** Clear every filter to its default (parent-owned). */
  onReset: () => void;
  /** Disable the reset button when nothing is active. */
  canReset?: boolean;
}) {
  // The input stays fully responsive (its own local state); only the COMMITTED
  // value that enters the query arg is debounced, so typing never lags but the
  // subscription only re-keys after the user pauses.
  const [draft, setDraft] = useState(q);

  // Keep the local draft in sync if the parent resets `q` externally (e.g. the
  // reset button), without clobbering active typing of the same value.
  useEffect(() => {
    setDraft(q);
  }, [q]);

  const timer = useRef<number | null>(null);
  function onInput(value: string) {
    setDraft(value);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onQChange(value), DEBOUNCE_MS);
  }
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Cancel any pending debounced commit before resetting, so a stale
  // onQChange(oldDraft) can't fire after the parent has cleared the filters.
  function handleReset() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    onReset();
  }

  return (
    <div className="oc-filterbar">
      <div className="oc-filterbar__search">
        <Search className="oc-filterbar__search-icon" aria-hidden />
        <Input
          value={draft}
          onChange={(e) => onInput(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
      </div>
      {children ? (
        <div className="oc-filterbar__quick">{children}</div>
      ) : null}
      {timeRange && onTimeRangeChange ? (
        <TimeRangePicker value={timeRange} onChange={onTimeRangeChange} />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="oc-filterbar__reset"
        onClick={handleReset}
        disabled={!canReset}
      >
        <RotateCcw />
        {m.filterbar_reset()}
      </Button>
    </div>
  );
}
