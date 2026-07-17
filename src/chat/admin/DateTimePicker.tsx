// A chart-themed date+time picker — the shadcn-consistent replacement for the
// native `datetime-local` input in the cron editor (the native calendar popup
// is OS-rendered and cannot take chart colors). Reads/writes the SAME
// "yyyy-MM-ddTHH:mm" value the editor already uses, so the save path is
// unchanged. Popover + pure calendar grid (monthGrid) + hour/minute selects.

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getLocale } from "@/paraglide/runtime.js";
import "./confTabs.css";
import { monthGrid, parseDatetimeLocal, toDatetimeLocal } from "./cronView";

// Monday-first narrow weekday initials for the active locale (2024-01-01 is a
// Monday), so the calendar header follows the UI language instead of hardcoded
// French initials.
function localeWeekdays(locale: string): string[] {
  try {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(2024, 0, 1 + i)),
    );
  } catch {
    return ["M", "T", "W", "T", "F", "S", "S"];
  }
}

export function DateTimePicker({
  value,
  onChange,
}: {
  value: string; // "yyyy-MM-ddTHH:mm" or ""
  onChange: (v: string) => void;
}) {
  const parsed = parseDatetimeLocal(value);
  const today = useMemo(() => new Date(), []);
  // The month the calendar is showing (from the value, else the current month).
  const [view, setView] = useState<{ year: number; month: number }>(() => ({
    year: parsed?.year ?? today.getFullYear(),
    month: parsed?.month ?? today.getMonth(),
  }));
  const [open, setOpen] = useState(false);

  const weekdays = useMemo(() => localeWeekdays(getLocale()), []);
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(getLocale(), { month: "long", year: "numeric" }),
    [],
  );
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

  const cells = monthGrid(view.year, view.month);
  const hour = parsed?.hour ?? 9;
  const minute = parsed?.minute ?? 0;

  const emit = (
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
  ) => onChange(toDatetimeLocal(y, mo, d, h, mi));

  const pickDay = (y: number, mo: number, d: number) => {
    setView({ year: y, month: mo });
    emit(y, mo, d, hour, minute);
  };

  const shiftMonth = (delta: number) => {
    const d = new Date(view.year, view.month + delta, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  const label =
    parsed !== null
      ? dateFmt.format(
          new Date(parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute),
        )
      : m.cron_at_placeholder();

  return (
    // modal: same Dialog scroll-lock rationale as TimezoneCombobox — without
    // it the month-navigation popover ignores wheel/scroll interactions.
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="oc-dtp__trigger" aria-label={m.cron_at_label()}>
          <CalendarDays size={14} aria-hidden className="oc-dtp__icon" />
          <span className={parsed === null ? "oc-dtp__placeholder" : undefined}>
            {label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="oc-dtp__pop">
        <div className="oc-dtp__head">
          <button
            type="button"
            className="oc-dtp__nav"
            aria-label={m.cron_at_prev_month()}
            onClick={() => shiftMonth(-1)}
          >
            <ChevronLeft size={15} aria-hidden />
          </button>
          <span className="oc-dtp__month">{monthFmt.format(new Date(view.year, view.month, 1))}</span>
          <button
            type="button"
            className="oc-dtp__nav"
            aria-label={m.cron_at_next_month()}
            onClick={() => shiftMonth(1)}
          >
            <ChevronRight size={15} aria-hidden />
          </button>
        </div>
        <div className="oc-dtp__grid">
          {weekdays.map((w, i) => (
            <span key={i} className="oc-dtp__wd">
              {w}
            </span>
          ))}
          {cells.map((c, i) => {
            const selected =
              parsed !== null &&
              parsed.year === c.year &&
              parsed.month === c.month &&
              parsed.day === c.day;
            const isToday =
              today.getFullYear() === c.year &&
              today.getMonth() === c.month &&
              today.getDate() === c.day;
            return (
              <button
                type="button"
                key={i}
                className={
                  "oc-dtp__day" +
                  (c.inMonth ? "" : " oc-dtp__day--out") +
                  (selected ? " oc-dtp__day--sel" : "") +
                  (isToday && !selected ? " oc-dtp__day--today" : "")
                }
                onClick={() => pickDay(c.year, c.month, c.day)}
              >
                {c.day}
              </button>
            );
          })}
        </div>
        <div className="oc-dtp__time">
          <Select
            value={String(hour)}
            onValueChange={(v) =>
              emit(view.year, view.month, parsed?.day ?? today.getDate(), Number(v), minute)
            }
          >
            <SelectTrigger size="sm" aria-label={m.cron_at_hour()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="oc-dtp__timeopts">
              {Array.from({ length: 24 }, (_, h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="oc-dtp__colon">:</span>
          <Select
            value={String(minute)}
            onValueChange={(v) =>
              emit(view.year, view.month, parsed?.day ?? today.getDate(), hour, Number(v))
            }
          >
            <SelectTrigger size="sm" aria-label={m.cron_at_minute()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="oc-dtp__timeopts">
              {Array.from({ length: 60 }, (_, mi) => (
                <SelectItem key={mi} value={String(mi)}>
                  {String(mi).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
}
