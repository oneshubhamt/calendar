import type {
  CalendarCustomViewPlugin,
  CalendarCustomViewRenderContext,
  CalendarViewNavigationContext,
  CalendarViewTitleContext,
} from "./types.js";
import { addMonths, dateKey, rangeForView, startOfMonth } from "../core/time.js";

export type CalendarMultiMonthColumns = "auto" | 1 | 2 | 3 | 4 | 5 | 6;

export interface CalendarMultiMonthViewOptions {
  /** Stable custom-view id. Defaults to "multi-month". */
  readonly id?: string | undefined;
  /** View-switcher label. Defaults to "Multi-month". */
  readonly label?: string | undefined;
  /** Number of detailed month panels. Must be an integer from 2 through 12. */
  readonly months: number;
  /** Preferred desktop column count; responsive wrapping may use fewer columns. */
  readonly columns?: CalendarMultiMonthColumns | undefined;
  /** Months moved by previous/next navigation. Defaults to the displayed month count. */
  readonly stepMonths?: number | undefined;
}

const OPTION_KEYS = new Set(["id", "label", "months", "columns", "stepMonths"]);

function integerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function normalizeOptions(options: CalendarMultiMonthViewOptions): Readonly<{
  id: string;
  label: string;
  months: number;
  columns: CalendarMultiMonthColumns;
  stepMonths: number;
}> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Multi-Month options must be an object");
  }
  if (Object.keys(options).some(key => !OPTION_KEYS.has(key))) {
    throw new TypeError("Multi-Month options contain an unexpected field");
  }
  const months = integerInRange(options.months, "Multi-Month months", 2, 12);
  const columns = options.columns ?? "auto";
  if (columns !== "auto") integerInRange(columns, "Multi-Month columns", 1, 6);
  const stepMonths = integerInRange(options.stepMonths ?? months, "Multi-Month stepMonths", 1, 12);
  return Object.freeze({
    id: options.id ?? "multi-month",
    label: options.label ?? "Multi-month",
    months,
    columns,
    stepMonths,
  });
}

function firstDisplayedMonth(context: CalendarViewNavigationContext): Date {
  return startOfMonth(context.anchor, context.timeZone);
}

function monthTitle(date: Date, context: Pick<CalendarViewNavigationContext, "locale" | "timeZone">): string {
  return new Intl.DateTimeFormat(context.locale, {
    month: "long",
    year: "numeric",
    timeZone: context.timeZone,
  }).format(date);
}

function multiMonthTitle(
  context: CalendarViewTitleContext,
  months: number,
): string {
  const first = firstDisplayedMonth(context);
  const last = addMonths(first, months - 1, context.timeZone);
  const firstYear = new Intl.DateTimeFormat(context.locale, {
    year: "numeric",
    timeZone: context.timeZone,
  }).format(first);
  const lastYear = new Intl.DateTimeFormat(context.locale, {
    year: "numeric",
    timeZone: context.timeZone,
  }).format(last);
  if (firstYear === lastYear) {
    const firstMonth = new Intl.DateTimeFormat(context.locale, {
      month: "long",
      timeZone: context.timeZone,
    }).format(first);
    return `${firstMonth} – ${monthTitle(last, context)}`;
  }
  return `${monthTitle(first, context)} – ${monthTitle(last, context)}`;
}

function renderMultiMonth(
  context: CalendarCustomViewRenderContext,
  months: number,
  columns: CalendarMultiMonthColumns,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "dc-multi-month";
  root.dataset.monthCount = String(months);
  root.dataset.columns = String(columns);
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", multiMonthTitle(context, months));
  root.style.display = "flex";
  root.style.flexWrap = "wrap";
  root.style.alignItems = "flex-start";
  root.style.gap = "12px";
  root.style.padding = "12px";
  root.style.background = "var(--dc-soft)";

  const first = firstDisplayedMonth(context);
  const columnTarget = columns === "auto" ? undefined : columns;
  const basis = columnTarget === undefined
    ? "340px"
    : `calc((100% - ${(columnTarget - 1) * 12}px) / ${columnTarget})`;

  for (let index = 0; index < months; index += 1) {
    const monthStart = addMonths(first, index, context.timeZone);
    const section = document.createElement("section");
    section.className = "dc-multi-month-section";
    section.dataset.calendarMonth = dateKey(monthStart, context.timeZone).slice(0, 7);
    section.style.flex = `1 1 ${basis}`;
    section.style.minWidth = "min(100%, 320px)";
    section.style.overflow = "hidden";
    section.style.border = "1px solid var(--dc-border)";
    section.style.borderRadius = "10px";
    section.style.background = "var(--dc-bg)";

    const title = monthTitle(monthStart, context);
    const heading = document.createElement("h2");
    heading.className = "dc-multi-month-title";
    heading.textContent = title;
    heading.style.margin = "0";
    heading.style.padding = "10px 12px";
    heading.style.borderBottom = "1px solid var(--dc-border)";
    heading.style.font = "inherit";
    heading.style.fontWeight = "700";
    heading.style.fontSize = "14px";
    section.setAttribute("aria-label", title);

    const panel = context.renderers.monthPanel(monthStart);
    panel.style.minWidth = "0";
    section.append(heading, panel);
    root.append(section);
  }
  return root;
}

/**
 * Create the optional detailed Multi-Month custom view.
 *
 * The view performs composition only: every detailed month is rendered by
 * Calendar's canonical Month panel through the bounded custom-view render port.
 */
export function createMultiMonthView(options: CalendarMultiMonthViewOptions): CalendarCustomViewPlugin {
  const resolved = normalizeOptions(options);
  return Object.freeze({
    id: resolved.id,
    label: resolved.label,
    includeBackgroundRanges: true,
    range(context) {
      const first = firstDisplayedMonth(context);
      const last = addMonths(first, resolved.months - 1, context.timeZone);
      const firstRange = rangeForView(first, "month", context.weekStartsOn, context.timeZone);
      const lastRange = rangeForView(last, "month", context.weekStartsOn, context.timeZone);
      return Object.freeze({ start: firstRange.start, end: lastRange.end });
    },
    shiftAnchor(context, direction) {
      return addMonths(firstDisplayedMonth(context), direction * resolved.stepMonths, context.timeZone);
    },
    title(context) {
      return multiMonthTitle(context, resolved.months);
    },
    render(context) {
      return renderMultiMonth(context, resolved.months, resolved.columns);
    },
  });
}
