import type { CalendarRange, ISODate } from "../core/types.js";
import { addDays, dateKey, startOfDay, toDate } from "../core/time.js";
import { parsePlainDate } from "../core/temporal.js";
import type { CalendarNavigationBounds } from "./types.js";

export interface ResolvedCalendarNavigationBounds {
  readonly min?: ISODate;
  readonly max?: ISODate;
}

export function resolveNavigationBounds(bounds: CalendarNavigationBounds | undefined): ResolvedCalendarNavigationBounds {
  if (!bounds) return {};
  const min = bounds.min?.trim();
  const max = bounds.max?.trim();
  if (min) parsePlainDate(min);
  if (max) parsePlainDate(max);
  if (min && max && min > max) throw new RangeError("Calendar navigation minimum date must not be after maximum date");
  return { ...(min ? { min } : {}), ...(max ? { max } : {}) };
}

export function navigationDateInBounds(value: Date | string, bounds: ResolvedCalendarNavigationBounds, timeZone: string): boolean {
  const key = dateKey(value, timeZone);
  return (!bounds.min || key >= bounds.min) && (!bounds.max || key <= bounds.max);
}

export function clampNavigationDate(value: Date | string, bounds: ResolvedCalendarNavigationBounds, timeZone: string): Date {
  const date = toDate(value, timeZone);
  const key = dateKey(date, timeZone);
  if (bounds.min && key < bounds.min) return toDate(bounds.min, timeZone);
  if (bounds.max && key > bounds.max) return toDate(bounds.max, timeZone);
  return date;
}

export function placementInNavigationBounds(
  start: Date,
  end: Date,
  bounds: ResolvedCalendarNavigationBounds,
  timeZone: string,
): boolean {
  const min = bounds.min ? startOfDay(bounds.min, timeZone).getTime() : Number.NEGATIVE_INFINITY;
  const maxExclusive = bounds.max ? addDays(startOfDay(bounds.max, timeZone), 1, timeZone).getTime() : Number.POSITIVE_INFINITY;
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (startMs === endMs) return startMs >= min && startMs < maxExclusive;
  return endMs > startMs && startMs >= min && endMs <= maxExclusive;
}

/** Intersect an engine projection query with inclusive local-date navigation bounds without changing view geometry. */
export function boundProjectionRange(range: CalendarRange, bounds: ResolvedCalendarNavigationBounds, timeZone: string): CalendarRange {
  let start = toDate(range.start).getTime();
  let end = toDate(range.end).getTime();
  if (bounds.min) start = Math.max(start, startOfDay(bounds.min, timeZone).getTime());
  if (bounds.max) end = Math.min(end, addDays(startOfDay(bounds.max, timeZone), 1, timeZone).getTime());
  if (start >= end) throw new RangeError("Calendar visible range does not intersect navigation bounds");
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
