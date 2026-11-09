import type { CalendarOccurrence, CalendarRange, ISODateTime } from "./types.js";
import { dateKey, startOfDay, toDate } from "./time.js";

export interface TimedLayoutItem {
  readonly occurrence: CalendarOccurrence;
  readonly topMinutes: number;
  readonly heightMinutes: number;
  readonly column: number;
  readonly columnCount: number;
  readonly columnSpan: number;
}

interface ClusterItem {
  readonly occurrence: CalendarOccurrence;
  readonly start: number;
  readonly end: number;
  readonly topMinutes: number;
  readonly heightMinutes: number;
  column: number;
}

function isTimed(item: CalendarOccurrence): boolean {
  return !item.allDay && item.precision !== "date";
}

function overlaps(a: ClusterItem, b: ClusterItem): boolean {
  return a.start < b.end && a.end > b.start;
}

function layoutCluster(cluster: ClusterItem[]): TimedLayoutItem[] {
  const columnEnds: number[] = [];
  for (const item of cluster) {
    let column = columnEnds.findIndex(end => end <= item.start);
    if (column < 0) column = columnEnds.length;
    item.column = column;
    columnEnds[column] = item.end;
  }
  const columnCount = Math.max(1, columnEnds.length);
  const byColumn = Array.from({ length: columnCount }, () => [] as ClusterItem[]);
  for (const item of cluster) byColumn[item.column]!.push(item);

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
    };
  });
}

export function layoutTimedDay(items: readonly CalendarOccurrence[], day: ISODateTime | Date, timeZone?: string): TimedLayoutItem[] {
  const dayStart = startOfDay(day, timeZone);
  const dayEnd = timeZone ? new Date(startOfDay(new Date(dayStart.getTime() + 36 * 60 * 60_000), timeZone).getTime()) : new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
  const relevant: ClusterItem[] = items
    .filter(isTimed)
    .filter(item => toDate(item.start).getTime() < dayEnd.getTime() && toDate(item.end).getTime() > dayStart.getTime())
    .map(occurrence => {
      const start = Math.max(dayStart.getTime(), toDate(occurrence.start).getTime());
      const end = Math.min(dayEnd.getTime(), toDate(occurrence.end).getTime());
      return {
        occurrence,
        start,
        end,
        topMinutes: (start - dayStart.getTime()) / 60_000,
        heightMinutes: Math.max(1, (end - start) / 60_000),
        column: 0,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end || a.occurrence.title.localeCompare(b.occurrence.title));

  const result: TimedLayoutItem[] = [];
  let cluster: ClusterItem[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (!cluster.length) return;
    result.push(...layoutCluster(cluster));
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const item of relevant) {
    if (cluster.length && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return result;
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
