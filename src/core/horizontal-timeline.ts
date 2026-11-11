import type {
  CalendarOverlapDisambiguation,
  CalendarRange,
  ISODateTime,
} from "./types.js";
import { civilMinuteOfInstant, instantAtCivilMinute } from "./civil-timeline.js";
import { parseAbsoluteDateTime } from "./time.js";
import { partitionOverlapLanes } from "./visual-lanes.js";

const MINUTE_MS = 60_000;

export type CalendarHorizontalTimelineGroup = string | number;

export interface CalendarHorizontalTimelineEntry<T> {
  /** Stable render identity within this layout request. */
  readonly id: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly temporalForm?: "interval" | "point" | undefined;
  /** Visual lane partition. Omitted entries share one lane group. */
  readonly laneGroup?: CalendarHorizontalTimelineGroup | undefined;
  readonly value: T;
}

export interface CalendarHorizontalTimelineLayoutItem<T> {
  readonly id: string;
  readonly value: T;
  readonly xMinutes: number;
  readonly widthMinutes: number;
  readonly temporalForm: "interval" | "point";
  readonly lane: number;
  readonly laneCount: number;
  readonly laneGroup?: CalendarHorizontalTimelineGroup | undefined;
  readonly clippedStart: ISODateTime;
  readonly clippedEnd: ISODateTime;
}

export interface CalendarHorizontalTimelineRangeGeometry {
  readonly start: number;
  readonly end: number;
  readonly widthMinutes: number;
  coordinate(instant: Date | number): number;
  /**
   * Resolve a horizontal civil/elapsed-minute coordinate back to an instant.
   * Civil spring-forward gaps are deliberately non-targetable.
   */
  instantAtCoordinate(
    minute: number,
    overlap?: CalendarOverlapDisambiguation | undefined,
  ): Date | null;
}

export interface CalendarHorizontalTimelineLayoutOptions {
  /** Civil wall-clock geometry. Omit for absolute elapsed-minute geometry. */
  readonly timeZone?: string | undefined;
}

interface Prepared<T> {
  readonly entry: CalendarHorizontalTimelineEntry<T>;
  readonly start: number;
  readonly end: number;
  readonly point: boolean;
  readonly xMinutes: number;
  readonly widthMinutes: number;
  readonly clippedStart: number;
  readonly clippedEnd: number;
}

function finiteInstant(value: Date | number, label: string): number {
  const instant = typeof value === "number" ? value : value.getTime();
  if (!Number.isFinite(instant)) throw new RangeError(`${label} must be finite`);
  return instant;
}

/**
 * Shared horizontal temporal basis for Calendar timelines.
 *
 * Geometry is absolute-range clipped first. With a time zone, x coordinates use
 * Calendar civil wall-clock minutes so DST gaps/overlaps match ordinary timed views.
 */
export function resolveHorizontalTimelineRangeGeometry(
  range: CalendarRange,
  timeZone?: string | undefined,
): CalendarHorizontalTimelineRangeGeometry {
  const start = parseAbsoluteDateTime(range?.start, "Horizontal timeline range start").getTime();
  const end = parseAbsoluteDateTime(range?.end, "Horizontal timeline range end").getTime();
  if (end <= start) throw new RangeError("Horizontal timeline range must end after it starts");
  if (timeZone !== undefined && (typeof timeZone !== "string" || !timeZone.trim())) {
    throw new TypeError("Horizontal timeline time zone must be a non-empty string");
  }

  const origin = new Date(start);
  const originCivil = timeZone === undefined ? 0 : civilMinuteOfInstant(start, origin, timeZone);
  const coordinate = (value: Date | number): number => {
    const instant = finiteInstant(value, "Horizontal timeline instant");
    return timeZone === undefined
      ? (instant - start) / MINUTE_MS
      : civilMinuteOfInstant(instant, origin, timeZone) - originCivil;
  };
  const civilWidth = coordinate(end);
  const elapsedWidth = (end - start) / MINUTE_MS;
  const widthMinutes = civilWidth > 0 ? civilWidth : elapsedWidth;

  return Object.freeze({
    start,
    end,
    widthMinutes,
    coordinate,
    instantAtCoordinate(minute: number, overlap: CalendarOverlapDisambiguation = "earlier") {
      if (!Number.isFinite(minute)) throw new RangeError("Horizontal timeline coordinate must be finite");
      if (!["earlier", "later"].includes(overlap)) throw new RangeError("Horizontal timeline overlap policy is invalid");
      return timeZone === undefined
        ? new Date(start + minute * MINUTE_MS)
        : instantAtCivilMinute(origin, originCivil + minute, timeZone, overlap);
    },
  });
}

function visualOverlap<T>(left: Prepared<T>, right: Prepared<T>): boolean {
  const leftEnd = left.xMinutes + left.widthMinutes;
  const rightEnd = right.xMinutes + right.widthMinutes;
  if (left.point && right.point) return left.xMinutes === right.xMinutes;
  if (left.point) return right.xMinutes <= left.xMinutes && left.xMinutes < rightEnd;
  if (right.point) return left.xMinutes <= right.xMinutes && right.xMinutes < leftEnd;
  return left.xMinutes < rightEnd && leftEnd > right.xMinutes;
}

function compareGroup(left: CalendarHorizontalTimelineGroup | undefined, right: CalendarHorizontalTimelineGroup | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

/**
 * Generic clipping, civil/elapsed coordinate, point/interval width and visual-lane
 * pipeline. Lane groups are presentation-only and never imply collision authority.
 */
export function layoutHorizontalTimeline<T>(
  entries: readonly CalendarHorizontalTimelineEntry<T>[],
  range: CalendarRange,
  options: CalendarHorizontalTimelineLayoutOptions = {},
): readonly CalendarHorizontalTimelineLayoutItem<T>[] {
  if (!Array.isArray(entries)) throw new TypeError("Horizontal timeline entries must be an array");
  const geometry = resolveHorizontalTimelineRangeGeometry(range, options.timeZone);
  const seen = new Set<string>();
  const prepared: Prepared<T>[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Horizontal timeline entry must be an object");
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) throw new TypeError("Horizontal timeline entry id must be a non-empty string");
    if (seen.has(entry.id)) throw new Error(`Duplicate horizontal timeline entry id: ${entry.id}`);
    seen.add(entry.id);
    if (entry.temporalForm !== undefined && entry.temporalForm !== "interval" && entry.temporalForm !== "point") {
      throw new Error(`Horizontal timeline entry ${entry.id} temporal form is invalid`);
    }
    if (entry.laneGroup !== undefined
      && typeof entry.laneGroup !== "string"
      && (typeof entry.laneGroup !== "number" || !Number.isFinite(entry.laneGroup))) {
      throw new TypeError(`Horizontal timeline entry ${entry.id} lane group is invalid`);
    }

    const start = parseAbsoluteDateTime(entry.start, `Horizontal timeline entry ${entry.id} start`).getTime();
    const end = parseAbsoluteDateTime(entry.end, `Horizontal timeline entry ${entry.id} end`).getTime();
    const point = entry.temporalForm === "point";
    if (point ? start !== end : end <= start) {
      throw new Error(point
        ? `Horizontal timeline entry ${entry.id} point requires identical start and end`
        : `Horizontal timeline entry ${entry.id} must end after it starts`);
    }
    const relevant = point
      ? start >= geometry.start && start < geometry.end
      : start < geometry.end && end > geometry.start;
    if (!relevant) continue;

    const clippedStart = point ? start : Math.max(geometry.start, start);
    const clippedEnd = point ? end : Math.min(geometry.end, end);
    const rawX = geometry.coordinate(clippedStart);
    const rawEnd = geometry.coordinate(clippedEnd);
    const civilWidth = rawEnd - rawX;
    const elapsedWidth = (clippedEnd - clippedStart) / MINUTE_MS;
    const rawWidth = point ? 0 : (civilWidth > 0 ? civilWidth : elapsedWidth);
    let xMinutes = Math.min(geometry.widthMinutes, Math.max(0, rawX));
    let widthMinutes = 0;
    if (!point) {
      const visibleRight = Math.min(geometry.widthMinutes, Math.max(0, rawX + rawWidth));
      const visibleWidth = visibleRight - xMinutes;
      if (visibleWidth > 0) widthMinutes = visibleWidth;
      else {
        widthMinutes = Math.min(elapsedWidth, geometry.widthMinutes);
        xMinutes = rawX < 0 ? 0 : Math.max(0, geometry.widthMinutes - widthMinutes);
      }
    }
    prepared.push({ entry, start, end, point, xMinutes, widthMinutes, clippedStart, clippedEnd });
  }

  const groups = new Map<CalendarHorizontalTimelineGroup | undefined, Prepared<T>[]>();
  for (const item of prepared) {
    const group = groups.get(item.entry.laneGroup) ?? [];
    group.push(item);
    groups.set(item.entry.laneGroup, group);
  }

  const result: CalendarHorizontalTimelineLayoutItem<T>[] = [];
  for (const [laneGroup, items] of [...groups.entries()].sort((a, b) => compareGroup(a[0], b[0]))) {
    items.sort((a, b) =>
      a.xMinutes - b.xMinutes
      || Number(a.point) - Number(b.point)
      || b.widthMinutes - a.widthMinutes
      || a.start - b.start
      || a.entry.id.localeCompare(b.entry.id));
    for (const cluster of partitionOverlapLanes(items, visualOverlap)) {
      const laneCount = Math.max(1, cluster.lanes.length);
      for (const { item, lane } of cluster.placements) {
        result.push(Object.freeze({
          id: item.entry.id,
          value: item.entry.value,
          xMinutes: item.xMinutes,
          widthMinutes: item.widthMinutes,
          temporalForm: item.point ? "point" : "interval",
          lane,
          laneCount,
          ...(laneGroup === undefined ? {} : { laneGroup }),
          clippedStart: new Date(item.clippedStart).toISOString(),
          clippedEnd: new Date(item.clippedEnd).toISOString(),
        }));
      }
    }
  }

  return Object.freeze(result.sort((a, b) =>
    compareGroup(a.laneGroup, b.laneGroup)
    || a.xMinutes - b.xMinutes
    || a.lane - b.lane
    || a.id.localeCompare(b.id)));
}
