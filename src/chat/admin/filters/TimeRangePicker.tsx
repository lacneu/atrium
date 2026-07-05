import { useEffect, useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Clock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import {
  RELATIVE_PRESETS,
  localInputToMs,
  msToLocalInput,
  rangeLabel,
  resolveRange,
  type TimeRange,
} from "./types";

// Grafana-style time-range picker: a popover with an Absolute panel (From/To
// `datetime-local`) on the left and a searchable Relative quick list on the
// right. The trigger button shows the human range label. Emits a `TimeRange`;
// resolving to epoch ms is the caller's job (via useResolvedRange) so relative
// ranges stay live.
//
// Built on radix-ui's Popover (the project imports primitives from the unified
// `radix-ui` package — see ui/select.tsx). Styled to match SelectContent's
// popover (token-driven, no hex) so it reads as house style.

/**
 * Resolve a TimeRange to live epoch-ms bounds for a Convex query arg.
 *
 * The load-bearing detail: Convex keys a subscription on the SERIALIZED arg
 * VALUES. If we returned `Date.now()`-based bounds every render, the values
 * would change each render -> a new subscription each render -> perpetual
 * loading flicker. So a relative range re-resolves on a fixed INTERVAL (not per
 * render); an absolute range is fixed and never ticks. The returned numbers are
 * therefore stable between ticks -> the subscription is stable -> live but not
 * thrashing.
 */
export function useResolvedRange(range: TimeRange): { from: number; to: number } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (range.kind !== "relative") return; // absolute = fixed, never re-resolve
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, [range.kind]);
  // `tick` is an intentional dep: it forces a re-resolve to NOW on each interval.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const { from, to } = resolveRange(range);
    // SNAP relative bounds to the minute so the 30s tick only changes the arg
    // VALUES once per minute (not every tick) — Convex keys its subscription on
    // the serialized values, so identical-between-ticks values dedupe the
    // subscription and the table never flickers to "loading" mid-tick. Absolute
    // bounds are already fixed and pass through unchanged.
    if (range.kind === "absolute") return { from, to };
    return { from: snapToMinute(from), to: snapToMinute(to) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, tick]);
}

/** Floor an epoch-ms instant to the start of its minute. */
function snapToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

export function TimeRangePicker({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Absolute-panel draft inputs, seeded from the current value each time the
  // popover opens (so editing starts from what is currently applied).
  const resolved = resolveRange(value);
  const [fromDraft, setFromDraft] = useState(() => msToLocalInput(resolved.from));
  const [toDraft, setToDraft] = useState(() => msToLocalInput(resolved.to));

  function onOpenChange(next: boolean) {
    if (next) {
      const r = resolveRange(value);
      setFromDraft(msToLocalInput(r.from));
      setToDraft(msToLocalInput(r.to));
      setSearch("");
    }
    setOpen(next);
  }

  function pickRelative(from: string) {
    onChange({ kind: "relative", from, to: "now" });
    setOpen(false);
  }

  function applyAbsolute() {
    const from = localInputToMs(fromDraft);
    const to = localInputToMs(toDraft);
    if (from === null || to === null) return; // both required; ignore otherwise
    onChange({ kind: "absolute", from, to });
    setOpen(false);
  }

  const filteredPresets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") return RELATIVE_PRESETS;
    return RELATIVE_PRESETS.filter(
      (p) =>
        p.label.toLowerCase().includes(needle) ||
        p.from.toLowerCase().includes(needle),
    );
  }, [search]);

  const absoluteValid =
    localInputToMs(fromDraft) !== null && localInputToMs(toDraft) !== null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="outline" size="sm" className="oc-timerange__trigger">
          <Clock />
          {rangeLabel(value)}
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className="oc-timerange__panel z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <div className="oc-timerange__cols">
            {/* Absolute panel (left) */}
            <div className="oc-timerange__absolute">
              <div className="oc-timerange__section-title">
                {m.timerange_absolute()}
              </div>
              <label className="oc-field">
                <span className="oc-field__label">{m.timerange_from()}</span>
                <Input
                  type="datetime-local"
                  value={fromDraft}
                  onChange={(e) => setFromDraft(e.target.value)}
                />
              </label>
              <label className="oc-field">
                <span className="oc-field__label">{m.timerange_to()}</span>
                <Input
                  type="datetime-local"
                  value={toDraft}
                  onChange={(e) => setToDraft(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                className="oc-timerange__apply"
                disabled={!absoluteValid}
                onClick={applyAbsolute}
              >
                {m.timerange_apply()}
              </Button>
            </div>

            {/* Relative quick list (right) */}
            <div className="oc-timerange__relative">
              <div className="oc-timerange__search">
                <Search className="oc-timerange__search-icon" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={m.timerange_search_placeholder()}
                  aria-label={m.timerange_search_aria()}
                />
              </div>
              <ul className="oc-timerange__list">
                {filteredPresets.length === 0 ? (
                  <li className="oc-timerange__empty">{m.timerange_empty()}</li>
                ) : (
                  filteredPresets.map((p) => {
                    const active =
                      value.kind === "relative" &&
                      value.from === p.from &&
                      value.to === "now";
                    return (
                      <li key={p.from}>
                        <button
                          type="button"
                          className={
                            "oc-timerange__option" +
                            (active ? " is-active" : "")
                          }
                          onClick={() => pickRelative(p.from)}
                        >
                          {p.label}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
