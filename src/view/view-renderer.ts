import type {
  CalendarAgendaSpan,
  CalendarBackgroundRange,
  CalendarOccurrence,
  CalendarRange,
  CalendarView,
  Weekday,
} from "../core/types.js";

import type { CalendarSelection } from "./types.js";
import type { ResolvedCalendarOccurrencePresentation } from "./presentation.js";
import type { ResolvedCalendarWeekNumbering } from "./week-numbering.js";
import { groupAgendaByDay, groupByDay } from "../core/layout.js";
import { addDays, addMonths, dateKey, rangeForView, toDate } from "../core/time.js";
import { instantToPlain } from "../core/temporal.js";
import { renderMonthPanel } from "./month-panel.js";
import {
  el,
  formatDateTime,
  formatTime,
  sameLocalDay,
} from "./render-primitives.js";

export {
  backgroundAriaSuffix,
  dayLevelBackgroundLayer,
  el,
  formatDateTime,
  formatTime,
  humanizeKind,
  sameLocalDay,
} from "./render-primitives.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CalendarStaticRenderModel {
  readonly locale: string;
  readonly timeZone: string;
  readonly weekStartsOn: Weekday;
  readonly weekNumbering?: ResolvedCalendarWeekNumbering | undefined;
  readonly anchor: Date;
  readonly visibleRange: CalendarRange;
  readonly agendaSpan: CalendarAgendaSpan;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly backgroundRanges: readonly CalendarBackgroundRange[];
  readonly now: Date;
}

export interface CalendarStaticRenderActions {
  dateInNavigationBounds(date: Date): boolean;
  monthInNavigationBounds(firstDateKey: string, lastDateKey: string): boolean;
  openDay(date: Date): void;
  openMonth(monthStart: Date, firstDateKey: string): void;
  monthEvent(occurrence: CalendarOccurrence, allowDrag?: boolean, bindInteractions?: boolean): HTMLElement;
  openMonthOverflow(date: Date, rows: readonly CalendarOccurrence[]): void;
  applyBackgroundPresentation(element: HTMLElement, range: CalendarBackgroundRange): void;
  dragOccurrenceFromTransfer(dataTransfer: DataTransfer | null): CalendarOccurrence | undefined;
  canMoveOccurrence(occurrence: CalendarOccurrence): boolean;
  moveToDay(occurrence: CalendarOccurrence, day: Date, allDay: boolean): Promise<void>;
  canCreateItems(): boolean;
  createFromSelection(selection: CalendarSelection): Promise<void>;
  bindExternalDropTarget(
    element: HTMLElement,
    resolveSelection: (event: DragEvent) => CalendarSelection | undefined,
  ): void;
  addonEmptyMessage(): string | undefined;
  agendaSummaries(date: string, occurrences: readonly CalendarOccurrence[]): readonly string[];
  occurrencePresentation(occurrence: CalendarOccurrence): ResolvedCalendarOccurrencePresentation;
  applyOccurrencePresentation(element: HTMLElement, occurrence: CalendarOccurrence): void;
}

export function periodTitle(
  model: Pick<CalendarStaticRenderModel, "locale" | "timeZone" | "anchor" | "visibleRange" | "agendaSpan"> & { readonly view: CalendarView },
): string {
  if (model.view === "year") return new Intl.DateTimeFormat(model.locale, { year: "numeric", timeZone: model.timeZone }).format(model.anchor);
  if (model.view === "month" || (model.view === "agenda" && model.agendaSpan === "month")) {
    return new Intl.DateTimeFormat(model.locale, { month: "long", year: "numeric", timeZone: model.timeZone }).format(model.anchor);
  }
  if (model.view === "day" || (model.view === "agenda" && model.agendaSpan === "day")) {
    return new Intl.DateTimeFormat(model.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: model.timeZone }).format(model.anchor);
  }
  const start = toDate(model.visibleRange.start);
  const end = new Date(toDate(model.visibleRange.end).getTime() - 1);
  return `${new Intl.DateTimeFormat(model.locale, { day: "numeric", month: "short", timeZone: model.timeZone }).format(start)} – ${new Intl.DateTimeFormat(model.locale, { day: "numeric", month: "short", year: "numeric", timeZone: model.timeZone }).format(end)}`;
}

export function renderYearView(model: CalendarStaticRenderModel, actions: CalendarStaticRenderActions): HTMLElement {
  const grid = el("div", "dc-year-grid");
  const buckets = groupByDay(model.occurrences, model.timeZone, model.visibleRange);
  const yearStart = new Date(model.anchor);
  yearStart.setTime(toDate(rangeForView(model.anchor, "year", model.weekStartsOn, model.timeZone).start).getTime());

  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const monthStart = addMonths(yearStart, monthIndex, model.timeZone);
    const month = el("section", "dc-year-month");
    const heading = el("button", "dc-year-month-title", new Intl.DateTimeFormat(model.locale, { month: "long", timeZone: model.timeZone }).format(monthStart));
    heading.type = "button";
    const monthEnd = addMonths(monthStart, 1, model.timeZone);
    const monthFirstKey = dateKey(monthStart, model.timeZone);
    const monthLastKey = dateKey(addDays(monthEnd, -1, model.timeZone), model.timeZone);
    const monthInBounds = actions.monthInNavigationBounds(monthFirstKey, monthLastKey);
    heading.disabled = !monthInBounds;
    heading.addEventListener("click", () => {
      if (monthInBounds) actions.openMonth(monthStart, monthFirstKey);
    });
    month.append(heading);
    const weekdays = el("div", "dc-year-weekdays");
    for (const weekday of weekdayOrder(model.weekStartsOn)) weekdays.append(el("span", undefined, DAY_NAMES[weekday]!.slice(0, 1)));
    month.append(weekdays);
    const days = el("div", "dc-year-days");
    const monthRange = rangeForView(monthStart, "month", model.weekStartsOn, model.timeZone);
    for (let cursor = toDate(monthRange.start); cursor < toDate(monthRange.end); cursor = addDays(cursor, 1, model.timeZone)) {
      const day = new Date(cursor);
      const parts = instantToPlain(day.getTime(), model.timeZone);
      const monthParts = instantToPlain(monthStart.getTime(), model.timeZone);
      const outside = parts.month !== monthParts.month;
      const button = el("button", "dc-year-day") as HTMLButtonElement;
      button.type = "button";
      button.dataset.calendarDate = day.toISOString();
      button.classList.toggle("is-outside", outside);
      button.classList.toggle("is-today", sameLocalDay(day, model.now, model.timeZone));
      const inBounds = actions.dateInNavigationBounds(day);
      button.classList.toggle("is-out-of-bounds", !inBounds);
      button.disabled = !outside && !inBounds;
      if (outside) {
        button.tabIndex = -1;
        button.setAttribute("aria-hidden", "true");
      } else {
        const bucket = buckets.get(dateKey(day, model.timeZone));
        const count = (bucket?.allDay.length ?? 0) + (bucket?.timed.length ?? 0);
        button.append(el("span", "dc-year-day-number", String(parts.day)));
        if (count) button.append(el("span", "dc-year-event-count", count > 9 ? "9+" : String(count)));
        button.setAttribute("aria-label", `${new Intl.DateTimeFormat(model.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: model.timeZone }).format(day)}${count ? `, ${count} event${count === 1 ? "" : "s"}` : ", no events"}`);
        button.addEventListener("click", () => actions.openDay(day));
      }
      days.append(button);
    }
    month.append(days);
    grid.append(month);
  }
  return grid;
}

export function renderMonthView(model: CalendarStaticRenderModel, actions: CalendarStaticRenderActions): HTMLElement {
  return renderMonthPanel(model, actions, {
    monthStart: model.anchor,
    range: model.visibleRange,
  });
}

export function renderAgendaView(model: CalendarStaticRenderModel, actions: CalendarStaticRenderActions): HTMLElement {
  const container = el("div", "dc-agenda");
  const groups = groupAgendaByDay(model.occurrences, model.visibleRange, model.timeZone);
  if (!groups.length) {
    container.append(el("div", "dc-empty", actions.addonEmptyMessage() ?? "Nothing scheduled in this range."));
    return container;
  }
  for (const group of groups) {
    const date = toDate(group.date, model.timeZone);
    const section = el("section", "dc-agenda-day");
    const heading = el("div", "dc-agenda-heading");
    heading.append(el("span", undefined, new Intl.DateTimeFormat(model.locale, { weekday: "long", day: "numeric", month: "long", timeZone: model.timeZone }).format(date)));
    const summaries = actions.agendaSummaries(group.date, group.occurrences);
    if (summaries.length) heading.append(el("span", "dc-agenda-totals", summaries.join(" · ")));
    section.append(heading);
    const rows = [...group.occurrences].sort((a, b) => {
      const aOrder = actions.occurrencePresentation(a).agendaOrder;
      const bOrder = actions.occurrencePresentation(b).agendaOrder;
      return aOrder - bOrder || toDate(a.start).getTime() - toDate(b.start).getTime() || a.title.localeCompare(b.title);
    });
    for (const occurrence of rows) {
      const row = el("div", "dc-agenda-row");
      row.dataset.kind = occurrence.kind;
      row.dataset.emphasis = occurrence.display?.emphasis ?? "normal";
      actions.applyOccurrencePresentation(row, occurrence);
      const startsBeforeDay = dateKey(occurrence.start, model.timeZone) < group.date;
      const endsAfterDay = dateKey(new Date(toDate(occurrence.end).getTime() - 1), model.timeZone) > group.date;
      const time = occurrence.allDay || occurrence.precision === "date"
        ? "All day"
        : startsBeforeDay && endsAfterDay
          ? "Continues →"
          : startsBeforeDay
            ? `Continues · until ${formatTime(toDate(occurrence.end), model.locale, model.timeZone)}`
            : endsAfterDay
              ? `${formatTime(toDate(occurrence.start), model.locale, model.timeZone)} →`
              : formatTime(toDate(occurrence.start), model.locale, model.timeZone);
      row.append(el("div", "dc-agenda-time", time));
      const detailWrap = el("div", "dc-agenda-detail");
      const detail = actions.monthEvent(occurrence);
      detail.classList.add("dc-agenda-event");
      detailWrap.append(detail);
      const presentation = actions.occurrencePresentation(occurrence);
      const meta = presentation.agendaMeta.join(" · ");
      if (meta) detailWrap.append(el("div", "dc-agenda-meta", meta));
      row.append(detailWrap);
      section.append(row);
    }
    container.append(section);
  }
  return container;
}
