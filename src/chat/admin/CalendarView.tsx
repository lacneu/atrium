// Generic calendar surface (month + year) — SOURCE-AGNOSTIC: it renders
// whatever CalendarEvents it is given and knows nothing about crons (or the
// future user-calendar / Twenty sources). The host owns data loading, the
// mode/cursor state and click resolution.

import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { Button } from "@/components/ui/button";
import { monthGrid } from "./cronView";
import {
  dayKeyOf,
  groupByDay,
  monthDensity,
  weekdayInitials,
  type CalendarEvent,
} from "./calendarData";
import "./confTabs.css";

export type CalendarMode = "month" | "year";
export type CalendarCursor = { year: number; month: number };

const DAY_EVENT_CAP = 3;

export function CalendarView({
  events,
  mode,
  cursor,
  onModeChange,
  onCursorChange,
  onEventClick,
  footnote,
}: {
  events: CalendarEvent[];
  mode: CalendarMode;
  cursor: CalendarCursor;
  onModeChange: (mode: CalendarMode) => void;
  onCursorChange: (cursor: CalendarCursor) => void;
  onEventClick?: (event: CalendarEvent) => void;
  /** Host-provided caveat line (e.g. the estimation note of the cron source). */
  footnote?: string;
}) {
  const locale = getLocale();
  const byDay = useMemo(() => groupByDay(events), [events]);
  const weekdays = useMemo(() => weekdayInitials(locale), [locale]);
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }),
    [locale],
  );
  const monthShortFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long" }),
    [locale],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale],
  );
  const now = new Date();

  const shift = (delta: number) => {
    if (mode === "year") {
      onCursorChange({ year: cursor.year + delta, month: cursor.month });
      return;
    }
    const d = new Date(cursor.year, cursor.month + delta, 1);
    onCursorChange({ year: d.getFullYear(), month: d.getMonth() });
  };

  const title =
    mode === "year"
      ? String(cursor.year)
      : monthFmt.format(new Date(cursor.year, cursor.month, 1));

  return (
    <div className="oc-cal">
      <div className="oc-cal__head">
        <div className="oc-cal__nav">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.cal_prev()}
            onClick={() => shift(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.cal_next()}
            onClick={() => shift(1)}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onCursorChange({ year: now.getFullYear(), month: now.getMonth() })
            }
          >
            {m.cal_today()}
          </Button>
        </div>
        <span className="oc-cal__title">{title}</span>
        <div className="oc-cal__modes" role="group">
          <Button
            variant={mode === "month" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={mode === "month"}
            onClick={() => onModeChange("month")}
          >
            {m.cal_mode_month()}
          </Button>
          <Button
            variant={mode === "year" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={mode === "year"}
            onClick={() => onModeChange("year")}
          >
            {m.cal_mode_year()}
          </Button>
        </div>
      </div>

      {mode === "month" ? (
        <MonthGrid
          cursor={cursor}
          byDay={byDay}
          weekdays={weekdays}
          timeFmt={timeFmt}
          now={now}
          onEventClick={onEventClick}
        />
      ) : (
        <YearGrid
          year={cursor.year}
          byDay={byDay}
          monthShortFmt={monthShortFmt}
          now={now}
          onOpenMonth={(month) => {
            onCursorChange({ year: cursor.year, month });
            onModeChange("month");
          }}
        />
      )}

      {footnote ? <p className="oc-cal__footnote">{footnote}</p> : null}
    </div>
  );
}

function MonthGrid({
  cursor,
  byDay,
  weekdays,
  timeFmt,
  now,
  onEventClick,
}: {
  cursor: CalendarCursor;
  byDay: Map<string, CalendarEvent[]>;
  weekdays: string[];
  timeFmt: Intl.DateTimeFormat;
  now: Date;
  onEventClick?: (event: CalendarEvent) => void;
}) {
  const cells = monthGrid(cursor.year, cursor.month);
  return (
    <div className="oc-cal__month">
      {weekdays.map((w, i) => (
        <span key={i} className="oc-cal__wd">
          {w}
        </span>
      ))}
      {cells.map((c, i) => {
        const list = byDay.get(dayKeyOf(c.year, c.month, c.day)) ?? [];
        const isToday =
          now.getFullYear() === c.year &&
          now.getMonth() === c.month &&
          now.getDate() === c.day;
        return (
          <div
            key={i}
            className={
              "oc-cal__day" +
              (c.inMonth ? "" : " oc-cal__day--out") +
              (isToday ? " oc-cal__day--today" : "")
            }
          >
            <span className="oc-cal__daynum">{c.day}</span>
            {list.slice(0, DAY_EVENT_CAP).map((ev) => (
              <button
                type="button"
                key={ev.id}
                className={
                  "oc-cal__event" +
                  (ev.muted ? " oc-cal__event--muted" : "") +
                  (ev.exact ? " oc-cal__event--exact" : "")
                }
                style={
                  ev.color
                    ? ({ "--cal-ev": ev.color } as React.CSSProperties)
                    : undefined
                }
                title={`${timeFmt.format(ev.atMs)} ${ev.title}`}
                onClick={onEventClick ? () => onEventClick(ev) : undefined}
              >
                <span className="oc-cal__evdot" aria-hidden />
                <span className="oc-cal__evtime">{timeFmt.format(ev.atMs)}</span>
                <span className="oc-cal__evtitle">{ev.title}</span>
              </button>
            ))}
            {list.length > DAY_EVENT_CAP ? (
              <span className="oc-cal__more">
                {m.cal_more({ count: list.length - DAY_EVENT_CAP })}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function YearGrid({
  year,
  byDay,
  monthShortFmt,
  now,
  onOpenMonth,
}: {
  year: number;
  byDay: Map<string, CalendarEvent[]>;
  monthShortFmt: Intl.DateTimeFormat;
  now: Date;
  onOpenMonth: (month: number) => void;
}) {
  return (
    <div className="oc-cal__year">
      {Array.from({ length: 12 }, (_, month) => {
        const density = monthDensity(byDay, year, month);
        const cells = monthGrid(year, month);
        return (
          <button
            type="button"
            key={month}
            className="oc-cal__mini"
            onClick={() => onOpenMonth(month)}
          >
            <span className="oc-cal__mininame">
              {monthShortFmt.format(new Date(year, month, 1))}
            </span>
            <span className="oc-cal__minigrid" aria-hidden>
              {cells.map((c, i) => {
                const count = c.inMonth ? (density.get(c.day) ?? 0) : 0;
                const isToday =
                  c.inMonth &&
                  now.getFullYear() === c.year &&
                  now.getMonth() === c.month &&
                  now.getDate() === c.day;
                return (
                  <span
                    key={i}
                    className={
                      "oc-cal__minidot" +
                      (!c.inMonth ? " is-out" : "") +
                      (count === 1 ? " has-one" : "") +
                      (count > 1 ? " has-many" : "") +
                      (isToday ? " is-today" : "")
                    }
                  />
                );
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
