// Generic calendar surface (agenda + month + year) — SOURCE-AGNOSTIC: it renders
// whatever CalendarEvents it is given and knows nothing about crons (or the
// future user-calendar / Twenty sources). The host owns data loading, the
// mode/cursor state and click resolution. With no mode chosen it opens on the
// month grid where the grid fits, on the agenda where it does not (calendarFit.ts:
// measured on a hidden chip, never a fixed width). The agenda opens on today, its
// head kept at the top of the page while the days scroll under it.

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { Button } from "@/components/ui/button";
import { SCROLLBAR_HYSTERESIS, useFitLevel } from "@/lib/useFitLevel";
import { monthGrid } from "./cronView";
import { agendaAnchorDay, monthGridFit } from "./calendarFit";
import {
  dayKeyOf,
  groupByDay,
  monthDensity,
  weekdayInitials,
  type CalendarEvent,
} from "./calendarData";
import "./confTabs.css";

export type CalendarMode = "agenda" | "month" | "year";
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
  /** null = not chosen: the month grid where it fits, the agenda where not. */
  mode: CalendarMode | null;
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
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }),
    [locale],
  );
  const now = new Date();
  // The locale's widest time, in a hidden chip of the grid's own type: the width a
  // day column needs, measured (calendarFit.ts).
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  // Bumped by "Today": the agenda brings today back under the head even when the
  // month shown already is the current one.
  const [todayTick, setTodayTick] = useState(0);
  const fitLevel = useFitLevel(
    () => {
      const root = rootRef.current;
      const chip = chipRef.current;
      if (root === null || chip === null) return null;
      return monthGridFit(root.clientWidth, chip.getBoundingClientRect().width);
    },
    () => [rootRef.current],
    [locale],
    // The grid and the agenda differ in height — an empty or light month is
    // taller as a grid — so the grid can bring the scrollbar that takes its width
    // away: the band keeps that from swapping them every frame (lot 11).
    { hysteresis: SCROLLBAR_HYSTERESIS },
  );
  const shown: CalendarMode = mode ?? (fitLevel === 0 ? "month" : "agenda");

  const shift = (delta: number) => {
    if (shown === "year") {
      onCursorChange({ year: cursor.year + delta, month: cursor.month });
      return;
    }
    const d = new Date(cursor.year, cursor.month + delta, 1);
    onCursorChange({ year: d.getFullYear(), month: d.getMonth() });
  };

  const title =
    shown === "year"
      ? String(cursor.year)
      : monthFmt.format(new Date(cursor.year, cursor.month, 1));

  return (
    <div ref={rootRef} className="oc-cal" data-mode={shown}>
      <span ref={chipRef} className="oc-cal__event oc-cal__chipmeasure" aria-hidden>
        <span className="oc-cal__evdot" />
        <span className="oc-cal__evtime">
          {timeFmt.format(new Date(2000, 0, 1, 23, 59))}
        </span>
      </span>
      <div ref={headRef} className="oc-cal__head">
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
            onClick={() => {
              onCursorChange({ year: now.getFullYear(), month: now.getMonth() });
              setTodayTick((t) => t + 1);
            }}
          >
            {m.cal_today()}
          </Button>
        </div>
        <span className="oc-cal__title">{title}</span>
        <div className="oc-cal__modes" role="group">
          <Button
            variant={shown === "agenda" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={shown === "agenda"}
            onClick={() => onModeChange("agenda")}
          >
            {m.cal_mode_agenda()}
          </Button>
          <Button
            variant={shown === "month" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={shown === "month"}
            onClick={() => onModeChange("month")}
          >
            {m.cal_mode_month()}
          </Button>
          <Button
            variant={shown === "year" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={shown === "year"}
            onClick={() => onModeChange("year")}
          >
            {m.cal_mode_year()}
          </Button>
        </div>
      </div>

      {shown === "agenda" ? (
        <AgendaList
          cursor={cursor}
          byDay={byDay}
          dayFmt={dayFmt}
          timeFmt={timeFmt}
          now={now}
          onEventClick={onEventClick}
          anchorKey={`${cursor.year}-${cursor.month}-${todayTick}`}
          headRef={headRef}
        />
      ) : shown === "month" ? (
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

/** Scrolls the nearest scrolling ancestor of `target` — that one only:
 *  scrollIntoView would move clipped ancestors too — so it sits right under the
 *  calendar's sticky head, whose band ends with its own padding. */
function scrollUnderHead(target: HTMLElement, head: HTMLElement | null) {
  let scroller = target.parentElement;
  while (scroller !== null) {
    const overflow = getComputedStyle(scroller).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      scroller.scrollHeight > scroller.clientHeight
    ) {
      break;
    }
    scroller = scroller.parentElement;
  }
  if (scroller === null) return;
  const port = scroller.getBoundingClientRect().top + scroller.clientTop;
  const under = head?.getBoundingClientRect().height ?? 0;
  scroller.scrollTop += Math.floor(target.getBoundingClientRect().top - port - under);
}

/** The month as a list: each day that has occurrences, then one full-width row
 *  per occurrence — time, title — a finger's height each. It opens on today
 *  (calendarFit.ts, agendaAnchorDay), once per opening: the live list updating
 *  under the reader never scrolls it. */
function AgendaList({
  cursor,
  byDay,
  dayFmt,
  timeFmt,
  now,
  onEventClick,
  anchorKey,
  headRef,
}: {
  cursor: CalendarCursor;
  byDay: Map<string, CalendarEvent[]>;
  dayFmt: Intl.DateTimeFormat;
  timeFmt: Intl.DateTimeFormat;
  now: Date;
  onEventClick?: (event: CalendarEvent) => void;
  /** Changes on each opening: the month shown, or "Today" pressed. */
  anchorKey: string;
  headRef: RefObject<HTMLDivElement | null>;
}) {
  const days = monthGrid(cursor.year, cursor.month)
    .filter((c) => c.inMonth)
    .map((c) => ({ c, list: byDay.get(dayKeyOf(c.year, c.month, c.day)) ?? [] }))
    .filter(({ list }) => list.length > 0);
  const today =
    now.getFullYear() === cursor.year && now.getMonth() === cursor.month
      ? now.getDate()
      : null;
  const anchorDay = agendaAnchorDay(
    days.map(({ c }) => c.day),
    today,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const anchoredFor = useRef<string | null>(null);
  const firstDay = days.length > 0 ? days[0].c.day : null;
  useLayoutEffect(() => {
    // Nothing loaded yet: wait for the days, the opening is not spent.
    if (anchorDay === null || anchoredFor.current === anchorKey) return;
    anchoredFor.current = anchorKey;
    const section = listRef.current?.querySelector<HTMLElement>(
      `[data-day="${anchorDay}"]`,
    );
    const head = headRef.current;
    if (!section) return;
    // The list's first day already in view below the head: the page stays put
    // (the filters above it stay in view too).
    if (
      anchorDay === firstDay &&
      head !== null &&
      section.getBoundingClientRect().top >= head.getBoundingClientRect().bottom
    ) {
      return;
    }
    scrollUnderHead(section, head);
  }, [anchorKey, anchorDay, firstDay, headRef]);
  if (days.length === 0) {
    return <p className="oc-cal__agendaempty">{m.cal_agenda_empty()}</p>;
  }
  return (
    <div ref={listRef} className="oc-cal__agenda">
      {days.map(({ c, list }) => {
        const isToday =
          now.getFullYear() === c.year &&
          now.getMonth() === c.month &&
          now.getDate() === c.day;
        return (
          <section key={c.day} className="oc-cal__agendaday" data-day={c.day}>
            <h4
              className={
                "oc-cal__agendadate" + (isToday ? " oc-cal__agendadate--today" : "")
              }
            >
              {dayFmt.format(new Date(c.year, c.month, c.day))}
            </h4>
            {list.map((ev) => {
              const body = (
                <>
                  <span className="oc-cal__evdot" aria-hidden />
                  <span className="oc-cal__evtime">{timeFmt.format(ev.atMs)}</span>
                  <span className="oc-cal__evtitle">{ev.title}</span>
                </>
              );
              const className =
                "oc-cal__agendaitem" +
                (ev.muted ? " oc-cal__event--muted" : "") +
                (ev.exact ? " oc-cal__event--exact" : "");
              const style = ev.color
                ? ({ "--cal-ev": ev.color } as React.CSSProperties)
                : undefined;
              return onEventClick ? (
                <Button
                  type="button"
                  variant="ghost"
                  key={ev.id}
                  className={`${className} h-auto min-h-11 w-full justify-start font-normal`}
                  style={style}
                  onClick={() => onEventClick(ev)}
                >
                  {body}
                </Button>
              ) : (
                <div key={ev.id} className={className} style={style}>
                  {body}
                </div>
              );
            })}
          </section>
        );
      })}
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
