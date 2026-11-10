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
import { groupAgendaByDay, groupAllDayBackgroundRangesByDay, groupByDay } from "../core/layout.js";
import { addDays, addMonths, dateKey, rangeForView, startOfDay, toDate } from "../core/time.js";
import { instantToPlain } from "../core/temporal.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CalendarStaticRenderModel {
  readonly locale: string;
  readonly timeZone: string;
  readonly weekStartsOn: Weekday;
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
  addonEmptyMessage(): string | undefined;
  agendaSummaries(date: string, occurrences: readonly CalendarOccurrence[]): readonly string[];
  occurrencePresentation(occurrence: CalendarOccurrence): ResolvedCalendarOccurrencePresentation;
  applyOccurrencePresentation(element: HTMLElement, occurrence: CalendarOccurrence): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return dateKey(a, timeZone) === dateKey(b, timeZone);
}

export function formatTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

export function formatDateTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone,
  }).format(date);
}

export function humanizeKind(value: string): string {
  const text = value.replace(/[-_]+/gu, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Event";
}

export function backgroundAriaSuffix(ranges: readonly CalendarBackgroundRange[]): string {
  const labels = [...new Set(ranges.map(range => range.label?.trim()).filter((label): label is string => Boolean(label)))].slice(0, 8);
  return labels.length ? `. Background: ${labels.join(", ")}` : "";
}

export function dayLevelBackgroundLayer(
  ranges: readonly CalendarBackgroundRange[],
  applyPresentation: (element: HTMLElement, range: CalendarBackgroundRange) => void,
): HTMLElement {
  const layer = el("div", "dc-day-background-layer");
  layer.setAttribute("aria-hidden", "true");
  for (const [index, range] of ranges.entries()) {
    const background = el("div", "dc-day-background-range");
    background.dataset.backgroundRangeId = range.id;
    background.style.zIndex = String(index);
    applyPresentation(background, range);
    layer.append(background);
  }
  return layer;
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
  const wrapper = el("div");
  const header = el("div", "dc-weekdays");
  for (const weekday of weekdayOrder(model.weekStartsOn)) header.append(el("div", "dc-weekday", DAY_NAMES[weekday]));
  const grid = el("div", "dc-month-grid");
  const buckets = groupByDay(model.occurrences, model.timeZone, model.visibleRange);
  const backgroundBuckets = groupAllDayBackgroundRangesByDay(model.backgroundRanges, model.timeZone, model.visibleRange);
  const start = toDate(model.visibleRange.start);
  const end = toDate(model.visibleRange.end);
  const anchorParts = instantToPlain(model.anchor.getTime(), model.timeZone);
  for (let cursor = new Date(start); cursor < end; cursor = addDays(cursor, 1, model.timeZone)) {
    const date = new Date(cursor);
    const parts = instantToPlain(date.getTime(), model.timeZone);
    const cell = el("div", "dc-day-cell");
    const inBounds = actions.dateInNavigationBounds(date);
    cell.tabIndex = inBounds ? 0 : -1;
    cell.setAttribute("role", "group");
    const dayBackgrounds = backgroundBuckets.get(dateKey(date, model.timeZone)) ?? [];
    const dayLabel = new Intl.DateTimeFormat(model.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: model.timeZone }).format(date);
    cell.setAttribute("aria-label", `${dayLabel}${backgroundAriaSuffix(dayBackgrounds)}`);
    cell.classList.toggle("is-outside", parts.month !== anchorParts.month);
    cell.classList.toggle("is-today", sameLocalDay(date, model.now, model.timeZone));
    cell.classList.toggle("is-out-of-bounds", !inBounds);
    if (!inBounds) cell.setAttribute("aria-disabled", "true");
    cell.dataset.date = date.toISOString();
    cell.dataset.calendarDate = date.toISOString();
    const number = el("button", "dc-day-number", String(parts.day));
    number.type = "button";
    number.disabled = !inBounds;
    number.addEventListener("click", () => actions.openDay(date));
    const events = el("div", "dc-month-events");
    const bucket = buckets.get(dateKey(date, model.timeZone));
    const rows = [...(bucket?.allDay ?? []), ...(bucket?.timed ?? [])];
    for (const occurrence of rows.slice(0, 4)) events.append(actions.monthEvent(occurrence));
    if (rows.length > 4) {
      const more = el("button", "dc-more", `+${rows.length - 4} more`) as HTMLButtonElement;
      more.type = "button";
      more.setAttribute("aria-label", `Show all ${rows.length} events on ${new Intl.DateTimeFormat(model.locale, { day: "numeric", month: "long", year: "numeric", timeZone: model.timeZone }).format(date)}`);
      more.addEventListener("click", event => { event.stopPropagation(); actions.openMonthOverflow(date, rows); });
      events.append(more);
    }
    if (inBounds && dayBackgrounds.length) {
      cell.append(dayLevelBackgroundLayer(dayBackgrounds, actions.applyBackgroundPresentation));
    }
    cell.append(number, events);
    cell.addEventListener("dragover", event => {
      if (inBounds && actions.dragOccurrenceFromTransfer(event.dataTransfer)) event.preventDefault();
    });
    cell.addEventListener("drop", event => {
      const occurrence = actions.dragOccurrenceFromTransfer(event.dataTransfer);
      if (!inBounds || !occurrence || !actions.canMoveOccurrence(occurrence)) return;
      event.preventDefault();
      void actions.moveToDay(occurrence, date, isDateLikeOccurrence(occurrence));
    });
    if (inBounds && actions.canCreateItems()) {
      cell.addEventListener("dblclick", event => {
        if ((event.target as Element).closest(".dc-event,.dc-day-number")) return;
        const startAt = startOfDay(date, model.timeZone);
        void actions.createFromSelection({
          start: startAt.toISOString(),
          end: addDays(startAt, 1, model.timeZone).toISOString(),
          allDay: true,
        });
      });
    }
    grid.append(cell);
  }
  wrapper.append(header, grid);
  return wrapper;
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

function weekdayOrder(weekStartsOn: Weekday): readonly Weekday[] {
  return Array.from({ length: 7 }, (_, index) => ((weekStartsOn + index) % 7) as Weekday);
}

export function isDateLikeOccurrence(occurrence: CalendarOccurrence): boolean {
  return Boolean(occurrence.allDay || occurrence.precision === "date" || occurrence.temporal?.kind === "date");
}
