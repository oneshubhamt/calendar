import type { CalendarRange, Weekday } from "../core/types.js";
import { groupAllDayBackgroundRangesByDay, groupByDay } from "../core/layout.js";
import { addDays, dateKey, startOfDay, toDate, weekOfYear } from "../core/time.js";
import { instantToPlain } from "../core/temporal.js";
import { isDateLikeOccurrence } from "./occurrence-form.js";
import {
  backgroundAriaSuffix,
  dayLevelBackgroundLayer,
  el,
  sameLocalDay,
} from "./render-primitives.js";
import type { CalendarStaticRenderActions, CalendarStaticRenderModel } from "./view-renderer.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CalendarMonthPanelOptions {
  readonly monthStart: Date;
  readonly range: CalendarRange;
}

function weekdayOrder(weekStartsOn: Weekday): readonly Weekday[] {
  return Array.from({ length: 7 }, (_, index) => ((weekStartsOn + index) % 7) as Weekday);
}

function weekNumberCell(
  date: Date,
  model: CalendarStaticRenderModel,
): HTMLElement {
  const numbering = model.weekNumbering;
  if (!numbering) throw new Error("Week-number rendering requires resolved numbering");
  const identity = weekOfYear(
    date,
    model.weekStartsOn,
    numbering.minimumDaysInFirstWeek,
    model.timeZone,
  );
  const cell = el("abbr", "dc-week-number", String(identity.weekNumber));
  const label = `Week ${identity.weekNumber} of ${identity.weekYear}`;
  cell.title = label;
  cell.setAttribute("aria-label", label);
  cell.dataset.weekNumber = String(identity.weekNumber);
  cell.dataset.weekYear = String(identity.weekYear);
  return cell;
}

/**
 * Shared detailed Month surface. It owns every day-cell behavior so ordinary Month
 * and future Multi-Month panels cannot drift into separate implementations.
 */
export function renderMonthPanel(
  model: CalendarStaticRenderModel,
  actions: CalendarStaticRenderActions,
  options: CalendarMonthPanelOptions,
): HTMLElement {
  const wrapper = el("div", "dc-month-panel");
  const header = el("div", "dc-weekdays");
  const grid = el("div", "dc-month-grid");
  const showWeekNumbers = Boolean(model.weekNumbering);

  if (showWeekNumbers) {
    header.classList.add("has-week-numbers");
    grid.classList.add("has-week-numbers");
    const weekHeading = el("abbr", "dc-week-number-heading", "Wk");
    weekHeading.title = "Week number";
    weekHeading.setAttribute("aria-label", "Week number");
    header.append(weekHeading);
  }
  for (const weekday of weekdayOrder(model.weekStartsOn)) {
    header.append(el("div", "dc-weekday", DAY_NAMES[weekday]));
  }

  const buckets = groupByDay(model.occurrences, model.timeZone, options.range);
  const backgroundBuckets = groupAllDayBackgroundRangesByDay(model.backgroundRanges, model.timeZone, options.range);
  const start = toDate(options.range.start);
  const end = toDate(options.range.end);
  const monthParts = instantToPlain(options.monthStart.getTime(), model.timeZone);
  let dayIndex = 0;

  for (let cursor = new Date(start); cursor < end; cursor = addDays(cursor, 1, model.timeZone)) {
    const date = new Date(cursor);
    if (showWeekNumbers && dayIndex % 7 === 0) grid.append(weekNumberCell(date, model));

    const parts = instantToPlain(date.getTime(), model.timeZone);
    const cell = el("div", "dc-day-cell");
    const inBounds = actions.dateInNavigationBounds(date);
    cell.tabIndex = inBounds ? 0 : -1;
    cell.setAttribute("role", "group");
    const dayBackgrounds = backgroundBuckets.get(dateKey(date, model.timeZone)) ?? [];
    const dayLabel = new Intl.DateTimeFormat(model.locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: model.timeZone,
    }).format(date);
    cell.setAttribute("aria-label", `${dayLabel}${backgroundAriaSuffix(dayBackgrounds)}`);
    cell.classList.toggle("is-outside", parts.month !== monthParts.month);
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
      more.setAttribute(
        "aria-label",
        `Show all ${rows.length} events on ${new Intl.DateTimeFormat(model.locale, {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: model.timeZone,
        }).format(date)}`,
      );
      more.addEventListener("click", event => {
        event.stopPropagation();
        actions.openMonthOverflow(date, rows);
      });
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

    if (inBounds) {
      actions.bindExternalDropTarget(cell, () => {
        const startAt = startOfDay(date, model.timeZone);
        return {
          start: startAt.toISOString(),
          end: addDays(startAt, 1, model.timeZone).toISOString(),
          allDay: true,
        };
      });
    }

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
    dayIndex += 1;
  }

  wrapper.append(header, grid);
  return wrapper;
}
