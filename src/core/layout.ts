import type { CalendarBackgroundRange, CalendarOccurrence, CalendarRange, ISODateTime } from "./types.js";
import { addDays, dateKey, startOfDay, toDate } from "./time.js";
import { civilMinuteOfInstant } from "./civil-timeline.js";

export interface TimedLayoutItem {
  readonly occurrence: CalendarOccurrence;
  readonly topMinutes: number;
  /** Zero for a true point marker; positive for interval blocks. */
  readonly heightMinutes: number;
  readonly column: number;
  readonly columnCount: number;
  readonly columnSpan: number;
  readonly temporalForm: "interval" | "point";
  /** Visual-only lane used when zero/real-duration items share screen pixels without claiming temporal overlap. */
  readonly visualLane: number;
  readonly visualLaneCount: number;
}


export interface BackgroundDayLayoutOptions {
  readonly timeZone?: string | undefined;
  /** First visible civil minute of the day; defaults to 00:00. */
  readonly startMinute?: number | undefined;
  /** Exclusive final visible civil minute of the day; defaults to 24:00. */
  readonly endMinute?: number | undefined;
}

export interface BackgroundLayoutItem {
  readonly range: CalendarBackgroundRange;
  /** Civil wall-clock coordinate within the local day after day/visible-window clipping. */
  readonly topMinutes: number;
  /** Positive civil display height after day/visible-window clipping. */
  readonly heightMinutes: number;
  /** Deterministic back-to-front paint order. Background layout never creates event columns. */
  readonly layer: number;
}

function backgroundVisibleWindow(options: BackgroundDayLayoutOptions): { start: number; end: number } {
  const start = options.startMinute ?? 0;
  const end = options.endMinute ?? 1440;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1440 || end <= start) {
    throw new RangeError("Background layout visible minutes must satisfy 0 <= start < end <= 1440");
  }
  return { start, end };
}

/**
 * Resolve passive background ranges into one day of civil-time geometry.
 *
 * Ranges are clipped first to the real instants belonging to the requested local day, then mapped
 * through the same civil timeline used by timed events. A visible-minute window is applied only
 * after civil mapping, so spring-forward gaps and fall-back overlaps retain Calendar's existing
 * wall-clock geometry. Overlaps remain full-width; deterministic layer order is the only stacking
 * mechanic and has no scheduling/collision meaning.
 */
export function layoutBackgroundDay(
  ranges: readonly CalendarBackgroundRange[],
  day: ISODateTime | Date,
  options: BackgroundDayLayoutOptions = {},
): BackgroundLayoutItem[] {
  const timeZone = options.timeZone;
  const visible = backgroundVisibleWindow(options);
  const dayStart = startOfDay(day, timeZone);
  const dayEnd = timeZone ? addDays(dayStart, 1, timeZone) : new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);

  const layouts = ranges
    .filter(range => toDate(range.start).getTime() < dayEnd.getTime() && toDate(range.end).getTime() > dayStart.getTime())
    .map(range => {
      const start = Math.max(dayStart.getTime(), toDate(range.start).getTime());
      const end = Math.min(dayEnd.getTime(), toDate(range.end).getTime());
      const rawTop = timeZone ? civilMinuteOfInstant(start, dayStart, timeZone) : (start - dayStart.getTime()) / 60_000;
      const rawEnd = timeZone ? civilMinuteOfInstant(end, dayStart, timeZone) : (end - dayStart.getTime()) / 60_000;
      const civilHeight = rawEnd - rawTop;
      const elapsedHeight = (end - start) / 60_000;
      const rawHeight = Math.max(1, civilHeight > 0 ? civilHeight : elapsedHeight);
      const top = Math.max(visible.start, rawTop);
      const bottom = Math.min(visible.end, rawTop + rawHeight);
      return { range, topMinutes: top, heightMinutes: bottom - top };
    })
    .filter(layout => layout.heightMinutes > 0)
    .sort((left, right) =>
      left.topMinutes - right.topMinutes
      || right.heightMinutes - left.heightMinutes
      || left.range.id.localeCompare(right.range.id));

  return layouts.map((layout, layer) => ({ ...layout, layer }));
}


interface ClusterItem {
  readonly occurrence: CalendarOccurrence;
  readonly start: number;
  readonly end: number;
  readonly topMinutes: number;
  readonly heightMinutes: number;
  readonly point: boolean;
  column: number;
}

function isTimed(item: CalendarOccurrence): boolean {
  return !item.allDay && item.precision !== "date";
}

function overlaps(a: ClusterItem, b: ClusterItem): boolean {
  if (a.point && b.point) return a.start === b.start;
  if (a.point) return b.start <= a.start && a.start < b.end;
  if (b.point) return a.start <= b.start && b.start < a.end;
  return a.start < b.end && a.end > b.start;
}

function layoutCluster(cluster: ClusterItem[]): TimedLayoutItem[] {
  const byColumn: ClusterItem[][] = [];
  for (const item of cluster) {
    let column = byColumn.findIndex(existing => existing.every(other => !overlaps(item, other)));
    if (column < 0) {
      column = byColumn.length;
      byColumn.push([]);
    }
    item.column = column;
    byColumn[column]!.push(item);
  }
  const columnCount = Math.max(1, byColumn.length);

  return cluster.map(item => {
    let span = 1;
    for (let column = item.column + 1; column < columnCount; column += 1) {
      if (byColumn[column]!.some(other => overlaps(item, other))) break;
      span += 1;
    }
    return {
      occurrence: item.occurrence,
      topMinutes: item.topMinutes,
      heightMinutes: item.heightMinutes,
      column: item.column,
      columnCount,
      columnSpan: span,
      temporalForm: item.point ? "point" : "interval",
      visualLane: 0,
      visualLaneCount: 1,
    };
  });
}

export function layoutTimedDay(items: readonly CalendarOccurrence[], day: ISODateTime | Date, timeZone?: string): TimedLayoutItem[] {
  const dayStart = startOfDay(day, timeZone);
  const dayEnd = timeZone ? addDays(dayStart, 1, timeZone) : new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
  const relevant: ClusterItem[] = items
    .filter(isTimed)
    .filter(item => {
      const start = toDate(item.start).getTime();
      const end = toDate(item.end).getTime();
      return item.temporalForm === "point"
        ? start === end && start >= dayStart.getTime() && start < dayEnd.getTime()
        : start < dayEnd.getTime() && end > dayStart.getTime();
    })
    .map(occurrence => {
      const point = occurrence.temporalForm === "point";
      const start = point ? toDate(occurrence.start).getTime() : Math.max(dayStart.getTime(), toDate(occurrence.start).getTime());
      const end = point ? start : Math.min(dayEnd.getTime(), toDate(occurrence.end).getTime());
      const topMinutes = timeZone ? civilMinuteOfInstant(start, dayStart, timeZone) : (start - dayStart.getTime()) / 60_000;
      const endMinutes = timeZone ? civilMinuteOfInstant(end, dayStart, timeZone) : (end - dayStart.getTime()) / 60_000;
      const civilHeight = endMinutes - topMinutes;
      const elapsedHeight = (end - start) / 60_000;
      return {
        occurrence,
        start,
        end,
        topMinutes,
        heightMinutes: point ? 0 : Math.max(1, civilHeight > 0 ? civilHeight : elapsedHeight),
        point,
        column: 0,
      };
    })
    .sort((a, b) => a.start - b.start || Number(a.point) - Number(b.point) || b.end - a.end || a.occurrence.title.localeCompare(b.occurrence.title));

  const result: TimedLayoutItem[] = [];
  let cluster: ClusterItem[] = [];
  const flush = () => {
    if (!cluster.length) return;
    result.push(...layoutCluster(cluster));
    cluster = [];
  };

  for (const item of relevant) {
    if (cluster.length && !cluster.some(other => overlaps(item, other))) flush();
    cluster.push(item);
  }
  flush();
  return assignVisualLanes(result);
}

const MIN_VISUAL_EVENT_HEIGHT = 20;

/**
 * Keep screen-space boxes legible when distinct real instants map to nearby/equal civil coordinates
 * (for example close point markers or the two sides of a fall-back overlap). This affects only width,
 * never temporal collision semantics or stored duration.
 */
function assignVisualLanes(items: readonly TimedLayoutItem[]): TimedLayoutItem[] {
  const groups = new Map<string, TimedLayoutItem[]>();
  for (const item of items) {
    const key = `${item.column}:${item.columnCount}:${item.columnSpan}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const updates = new Map<string, { lane: number; count: number }>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.topMinutes - b.topMinutes || a.occurrence.occurrenceId.localeCompare(b.occurrence.occurrenceId));
    let cluster: TimedLayoutItem[] = [];
    let clusterBottom = Number.NEGATIVE_INFINITY;
    const flushVisual = () => {
      if (cluster.length <= 1) {
        const only = cluster[0];
        if (only) updates.set(only.occurrence.occurrenceId, { lane: 0, count: 1 });
      } else {
        cluster.forEach((item, lane) => updates.set(item.occurrence.occurrenceId, { lane, count: cluster.length }));
      }
      cluster = [];
      clusterBottom = Number.NEGATIVE_INFINITY;
    };
    for (const item of sorted) {
      const visualHeight = Math.max(MIN_VISUAL_EVENT_HEIGHT, item.heightMinutes);
      if (cluster.length && item.topMinutes >= clusterBottom) flushVisual();
      cluster.push(item);
      clusterBottom = Math.max(clusterBottom, item.topMinutes + visualHeight);
    }
    flushVisual();
  }

  return items.map(item => {
    const visual = updates.get(item.occurrence.occurrenceId) ?? { lane: 0, count: 1 };
    return { ...item, visualLane: visual.lane, visualLaneCount: visual.count };
  });
}

export interface MonthDayBucket {
  readonly date: string;
  readonly allDay: readonly CalendarOccurrence[];
  readonly timed: readonly CalendarOccurrence[];
}

export function groupByDay(items: readonly CalendarOccurrence[], timeZone?: string, range?: CalendarRange): ReadonlyMap<string, MonthDayBucket> {
  const map = new Map<string, { allDay: CalendarOccurrence[]; timed: CalendarOccurrence[] }>();
  const rangeExactStart = range ? toDate(range.start) : undefined;
  const rangeStart = range ? startOfDay(range.start, timeZone) : undefined;
  const rangeEnd = range ? toDate(range.end) : undefined;
  for (const item of items) {
    const exactStart = toDate(item.start);
    const itemEnd = toDate(item.end);
    if (item.temporalForm === "point") {
      if (rangeExactStart && rangeEnd && (exactStart.getTime() < rangeExactStart.getTime() || exactStart.getTime() >= rangeEnd.getTime())) continue;
      const key = dateKey(exactStart, timeZone);
      const bucket = map.get(key) ?? { allDay: [], timed: [] };
      bucket.timed.push(item);
      map.set(key, bucket);
      continue;
    }
    if (rangeExactStart && rangeEnd && (itemEnd.getTime() <= rangeExactStart.getTime() || exactStart.getTime() >= rangeEnd.getTime())) continue;
    const itemStart = startOfDay(item.start, timeZone);
    let cursor = rangeStart && itemStart.getTime() < rangeStart.getTime() ? rangeStart : itemStart;
    const end = rangeEnd && itemEnd.getTime() > rangeEnd.getTime() ? rangeEnd : itemEnd;
    while (cursor.getTime() < end.getTime()) {
      const key = dateKey(cursor, timeZone);
      const bucket = map.get(key) ?? { allDay: [], timed: [] };
      (item.allDay || item.precision === "date" ? bucket.allDay : bucket.timed).push(item);
      map.set(key, bucket);
      cursor = timeZone ? startOfDay(new Date(cursor.getTime() + 36 * 60 * 60_000), timeZone) : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  }
  return new Map([...map.entries()].map(([date, bucket]) => [date, {
    date,
    allDay: bucket.allDay.sort(sortOccurrences),
    timed: bucket.timed.sort(sortOccurrences),
  }]));
}

export function sortOccurrences(a: CalendarOccurrence, b: CalendarOccurrence): number {
  return toDate(a.start).getTime() - toDate(b.start).getTime() ||
    toDate(a.end).getTime() - toDate(b.end).getTime() ||
    a.title.localeCompare(b.title);
}

export interface AgendaDayGroup {
  readonly date: string;
  readonly occurrences: readonly CalendarOccurrence[];
}

/** Group every occurrence that overlaps each visible calendar day, including carry-in multi-day events. */
export function groupAgendaByDay(items: readonly CalendarOccurrence[], range: { readonly start: ISODateTime; readonly end: ISODateTime }, timeZone?: string): readonly AgendaDayGroup[] {
  const buckets = groupByDay(items, timeZone, range);
  const groups: AgendaDayGroup[] = [];
  for (let day = startOfDay(range.start, timeZone); day < toDate(range.end); day = timeZone ? startOfDay(new Date(day.getTime() + 36 * 60 * 60_000), timeZone) : new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const key = dateKey(day, timeZone);
    const bucket = buckets.get(key);
    const occurrences = [...(bucket?.allDay ?? []), ...(bucket?.timed ?? [])].sort(sortOccurrences);
    if (occurrences.length) groups.push({ date: key, occurrences });
  }
  return groups;
}
