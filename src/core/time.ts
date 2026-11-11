import type { CalendarAgendaSpan, CalendarRange, CalendarView, ISODate, ISODateTime, Weekday } from "./types.js";
import {
  addPlainDays,
  addPlainMonths,
  addPlainYears,
  comparePlain,
  formatPlainDate,
  instantToPlain,
  parsePlainDate,
  parsePlainDateTime,
  plainDaysBetween,
  plainToInstant,
  systemTimeZone,
  weekdayOf,
  type PlainDateTimeParts,
} from "./temporal.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;

export interface CalendarClock {
  now(): Date;
}

export const systemClock: CalendarClock = Object.freeze({ now: () => new Date() });

export function toDate(value: ISODateTime | Date, timeZone?: string): Date {
  if (value instanceof Date) return checkedDate(value);
  if (timeZone && DATE_RE.test(value)) return new Date(plainToInstant(parsePlainDate(value), timeZone, "compatible"));
  if (timeZone && LOCAL_RE.test(value)) return new Date(plainToInstant(parsePlainDateTime(value), timeZone, "compatible"));
  return checkedDate(new Date(value));
}

/** Parse an absolute ISO date-time with an explicit UTC/offset suffix. */
export function parseAbsoluteDateTime(value: unknown, label = "Date-time"): Date {
  if (typeof value !== "string" || !hasExplicitOffset(value)) {
    throw new RangeError(`${label} must be an absolute ISO date-time`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid absolute ISO date-time`);
  return date;
}

export function toIso(value: ISODateTime | Date, timeZone?: string): ISODateTime {
  return toDate(value, timeZone).toISOString();
}

export function addMinutes(value: ISODateTime | Date, minutes: number): Date {
  if (!Number.isFinite(minutes)) throw new RangeError("minutes must be finite");
  return new Date(toDate(value).getTime() + minutes * MINUTE_MS);
}

/** Calendar-day arithmetic. When timeZone is supplied, wall-clock fields are preserved across DST. */
export function addDays(value: ISODateTime | Date, days: number, timeZone?: string): Date {
  if (!Number.isInteger(days)) throw new RangeError("days must be an integer");
  if (!timeZone) {
    const date = toDate(value);
    date.setDate(date.getDate() + days);
    return date;
  }
  const start = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
  return new Date(plainToInstant(addPlainDays(start, days), timeZone, "compatible"));
}

export function addMonths(value: ISODateTime | Date, months: number, timeZone?: string): Date {
  if (!Number.isInteger(months)) throw new RangeError("months must be an integer");
  if (!timeZone) {
    const date = toDate(value);
    const originalDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(originalDay, last));
    return date;
  }
  const start = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
  const next = addPlainMonths(start, months, "constrain");
  if (!next) throw new RangeError("Invalid month arithmetic");
  return new Date(plainToInstant(next, timeZone, "compatible"));
}

export function addYears(value: ISODateTime | Date, years: number, timeZone?: string): Date {
  if (!Number.isInteger(years)) throw new RangeError("years must be an integer");
  if (!timeZone) {
    const date = toDate(value);
    const month = date.getMonth();
    date.setFullYear(date.getFullYear() + years);
    if (date.getMonth() !== month) date.setDate(0);
    return date;
  }
  const start = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
  const next = addPlainYears(start, years, "constrain");
  if (!next) throw new RangeError("Invalid year arithmetic");
  return new Date(plainToInstant(next, timeZone, "compatible"));
}

export function startOfDay(value: ISODateTime | Date, timeZone?: string): Date {
  if (!timeZone) {
    const date = toDate(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  const plain = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
  return new Date(plainToInstant({ ...plain, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone, "compatible"));
}

export function endOfDay(value: ISODateTime | Date, timeZone?: string): Date {
  const start = startOfDay(value, timeZone);
  return addDays(start, 1, timeZone);
}

export function startOfWeek(value: ISODateTime | Date, weekStartsOn: Weekday = 1, timeZone?: string): Date {
  const date = startOfDay(value, timeZone);
  const weekday = timeZone ? weekdayFromInstant(date, timeZone) : date.getDay() as Weekday;
  const delta = (weekday - weekStartsOn + 7) % 7;
  return addDays(date, -delta, timeZone);
}

export interface CalendarWeekIdentity {
  readonly weekYear: number;
  readonly weekNumber: number;
  readonly weekStart: ISODate;
}

function civilDateParts(value: ISODateTime | Date, timeZone?: string): PlainDateTimeParts {
  if (typeof value === "string" && DATE_RE.test(value)) return parsePlainDate(value);
  if (timeZone) {
    const parts = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
    return { ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 };
  }
  const date = toDate(value);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

function firstWeekStartOfYear(
  year: number,
  weekStartsOn: Weekday,
  minimumDaysInFirstWeek: number,
): PlainDateTimeParts {
  const januaryFirst: PlainDateTimeParts = {
    year,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
  const leadingDays = (weekdayOf(januaryFirst) - weekStartsOn + 7) % 7;
  const containingWeekStart = addPlainDays(januaryFirst, -leadingDays);
  const daysOfNewYearInContainingWeek = 7 - leadingDays;
  return daysOfNewYearInContainingWeek >= minimumDaysInFirstWeek
    ? containingWeekStart
    : addPlainDays(containingWeekStart, 7);
}

/**
 * Resolve the civil week identity for a displayed date.
 *
 * Week 1 is the first displayed week containing at least
 * minimumDaysInFirstWeek days of the new year.
 */
export function weekOfYear(
  value: ISODateTime | Date,
  weekStartsOn: Weekday = 1,
  minimumDaysInFirstWeek = 4,
  timeZone?: string,
): CalendarWeekIdentity {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("weekStartsOn must be an integer from 0 through 6");
  }
  if (!Number.isInteger(minimumDaysInFirstWeek) || minimumDaysInFirstWeek < 1 || minimumDaysInFirstWeek > 7) {
    throw new RangeError("minimumDaysInFirstWeek must be an integer from 1 through 7");
  }

  const date = civilDateParts(value, timeZone);
  const offset = (weekdayOf(date) - weekStartsOn + 7) % 7;
  const weekStart = addPlainDays(date, -offset);
  const currentFirst = firstWeekStartOfYear(date.year, weekStartsOn, minimumDaysInFirstWeek);
  const nextFirst = firstWeekStartOfYear(date.year + 1, weekStartsOn, minimumDaysInFirstWeek);

  let weekYear = date.year;
  let firstWeekStart = currentFirst;
  if (comparePlain(weekStart, currentFirst) < 0) {
    weekYear -= 1;
    firstWeekStart = firstWeekStartOfYear(weekYear, weekStartsOn, minimumDaysInFirstWeek);
  } else if (comparePlain(weekStart, nextFirst) >= 0) {
    weekYear += 1;
    firstWeekStart = nextFirst;
  }

  return Object.freeze({
    weekYear,
    weekNumber: Math.floor(plainDaysBetween(firstWeekStart, weekStart) / 7) + 1,
    weekStart: formatPlainDate(weekStart),
  });
}

export function startOfMonth(value: ISODateTime | Date, timeZone?: string): Date {
  if (!timeZone) {
    const date = startOfDay(value);
    date.setDate(1);
    return date;
  }
  const plain = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
  return new Date(plainToInstant({ ...plain, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone, "compatible"));
}

export function startOfYear(value: ISODateTime | Date, timeZone?: string): Date {
  if (!timeZone) {
    const date = startOfDay(value);
    date.setMonth(0, 1);
    return date;
  }
  const plain = instantToPlain(toDate(value, timeZone).getTime(), timeZone);
  return new Date(plainToInstant({ ...plain, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone, "compatible"));
}

export function minutesBetween(start: ISODateTime | Date, end: ISODateTime | Date): number {
  return (toDate(end).getTime() - toDate(start).getTime()) / MINUTE_MS;
}

export function daysBetween(start: ISODateTime | Date, end: ISODateTime | Date, timeZone?: string): number {
  if (!timeZone) return (startOfDay(end).getTime() - startOfDay(start).getTime()) / DAY_MS;
  const a = instantToPlain(toDate(start, timeZone).getTime(), timeZone);
  const b = instantToPlain(toDate(end, timeZone).getTime(), timeZone);
  return (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS;
}

export function clampDate(date: Date, min: Date, max: Date): Date {
  return new Date(Math.min(Math.max(date.getTime(), min.getTime()), max.getTime()));
}

export function overlaps(aStart: ISODateTime | Date, aEnd: ISODateTime | Date, bStart: ISODateTime | Date, bEnd: ISODateTime | Date): boolean {
  return toDate(aStart).getTime() < toDate(bEnd).getTime() && toDate(aEnd).getTime() > toDate(bStart).getTime();
}


/** Half-open range intersection for either an interval or a true zero-duration point. */
export function intersectsRange(
  start: ISODateTime | Date,
  end: ISODateTime | Date,
  rangeStart: ISODateTime | Date,
  rangeEnd: ISODateTime | Date,
  point = false,
): boolean {
  const startMs = toDate(start).getTime();
  const endMs = toDate(end).getTime();
  const rangeStartMs = toDate(rangeStart).getTime();
  const rangeEndMs = toDate(rangeEnd).getTime();
  return point
    ? startMs === endMs && startMs >= rangeStartMs && startMs < rangeEndMs
    : startMs < rangeEndMs && endMs > rangeStartMs;
}

export function contains(range: CalendarRange, value: ISODateTime | Date): boolean {
  const time = toDate(value).getTime();
  return time >= toDate(range.start).getTime() && time < toDate(range.end).getTime();
}

export function snapDate(value: ISODateTime | Date, slotMinutes: number, mode: "round" | "floor" | "ceil" = "round"): Date {
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > 1440) throw new RangeError("Invalid slotMinutes");
  const date = toDate(value);
  const unit = slotMinutes * MINUTE_MS;
  const method = mode === "floor" ? Math.floor : mode === "ceil" ? Math.ceil : Math.round;
  return new Date(method(date.getTime() / unit) * unit);
}

export function rangeForView(
  anchor: ISODateTime | Date,
  view: CalendarView,
  weekStartsOn: Weekday = 1,
  timeZone?: string,
  agendaSpan: CalendarAgendaSpan = "30-days",
): CalendarRange {
  const zone = timeZone;
  const date = toDate(anchor, zone);
  let start: Date;
  let end: Date;
  if (view === "month") {
    start = startOfWeek(startOfMonth(date, zone), weekStartsOn, zone);
    const monthStart = startOfMonth(date, zone);
    const nextMonth = addMonths(monthStart, 1, zone);
    end = startOfWeek(nextMonth, weekStartsOn, zone);
    if (end.getTime() <= nextMonth.getTime()) end = addDays(end, 7, zone);
  } else if (view === "week") {
    start = startOfWeek(date, weekStartsOn, zone);
    end = addDays(start, 7, zone);
  } else if (view === "year") {
    start = startOfYear(date, zone);
    end = addYears(start, 1, zone);
  } else if (view === "agenda") {
    if (agendaSpan === "week") {
      start = startOfWeek(date, weekStartsOn, zone);
      end = addDays(start, 7, zone);
    } else if (agendaSpan === "month") {
      start = startOfMonth(date, zone);
      end = addMonths(start, 1, zone);
    } else {
      start = startOfDay(date, zone);
      end = addDays(start, agendaSpan === "day" ? 1 : 30, zone);
    }
  } else {
    start = startOfDay(date, zone);
    end = addDays(start, 1, zone);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export function dateKey(value: ISODateTime | Date, timeZone?: string): string {
  if (timeZone) return formatPlainDate(instantToPlain(toDate(value, timeZone).getTime(), timeZone));
  const date = toDate(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dayBoundaryStart(value: ISODateTime | Date, boundaryHour: number, timeZone?: string): Date {
  if (!Number.isInteger(boundaryHour) || boundaryHour < 0 || boundaryHour > 23) throw new RangeError("Invalid day boundary");
  if (!timeZone) {
    const date = toDate(value);
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), boundaryHour, 0, 0, 0);
    if (date.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
    return start;
  }
  const instant = toDate(value, timeZone).getTime();
  const plain = instantToPlain(instant, timeZone);
  let boundary: PlainDateTimeParts = { ...plain, hour: boundaryHour, minute: 0, second: 0, millisecond: 0 };
  let resolved = plainToInstant(boundary, timeZone, "compatible");
  if (instant < resolved) {
    boundary = addPlainDays(boundary, -1);
    resolved = plainToInstant(boundary, timeZone, "compatible");
  }
  return new Date(resolved);
}

export function resolvedTimeZone(timeZone?: string): string {
  return timeZone ?? systemTimeZone();
}

export function hasExplicitOffset(value: string): boolean {
  return OFFSET_RE.test(value);
}

function weekdayFromInstant(value: Date, timeZone: string): Weekday {
  const p = instantToPlain(value.getTime(), timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() as Weekday;
}

function checkedDate(value: Date): Date {
  const date = new Date(value.getTime());
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date-time: ${String(value)}`);
  return date;
}
