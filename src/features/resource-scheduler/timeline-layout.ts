import type {
  CalendarOccurrence,
  CalendarRange,
} from "../../core/types.js";
import { civilMinuteOfInstant } from "../../core/civil-timeline.js";
import { hasExplicitOffset } from "../../core/time.js";
import {
  flattenCalendarResources,
  validateCalendarResourceAssignments,
  type CalendarResourceRow,
} from "./mechanics.js";
import type {
  CalendarResource,
  CalendarResourceAssignment,
  CalendarResourceAssignmentVersion,
  CalendarResourceId,
} from "./index.js";

const MINUTE_MS = 60_000;

export interface CalendarResourceTimelineLayoutOptions {
  /** Civil wall-clock geometry. Omit for absolute elapsed-minute geometry. */
  readonly timeZone?: string | undefined;
  /** Caller-owned visibility state; it is never persisted by Resource Scheduler. */
  readonly collapsedResourceIds?: readonly CalendarResourceId[] | undefined;
}

export interface CalendarResourceTimelineLayoutItem {
  readonly occurrence: CalendarOccurrence;
  readonly resource: CalendarResource;
  readonly occurrenceId: string;
  readonly resourceId: CalendarResourceId;
  /** Collision-safe stable identity for this occurrence/resource rendering. */
  readonly renderId: string;
  /** Zero-based visible row after deterministic hierarchy flattening/collapse. */
  readonly resourceRow: number;
  /** Horizontal civil/elapsed minute coordinate relative to the requested range. */
  readonly xMinutes: number;
  /** Zero for a point occurrence; positive for an interval. */
  readonly widthMinutes: number;
  readonly temporalForm: "interval" | "point";
  /** Visual-only lane within this resource row; never a scheduling permission/collision decision. */
  readonly lane: number;
  readonly laneCount: number;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

interface PreparedOccurrence {
  readonly occurrence: CalendarOccurrence;
  readonly start: number;
  readonly end: number;
  readonly point: boolean;
}

interface PreparedLayout extends Omit<CalendarResourceTimelineLayoutItem, "lane" | "laneCount"> {
  readonly start: number;
  readonly end: number;
  readonly point: boolean;
}

function absoluteInstant(value: unknown, label: string): number {
  if (typeof value !== "string" || !hasExplicitOffset(value)) {
    throw new Error(`${label} must be an absolute ISO date-time`);
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error(`${label} must be a valid absolute ISO date-time`);
  return instant;
}

function prepareOccurrence(occurrence: CalendarOccurrence): PreparedOccurrence {
  if (!occurrence || typeof occurrence !== "object" || Array.isArray(occurrence)) {
    throw new Error("Resource timeline occurrence must be an object");
  }
  const raw = occurrence as unknown as Record<string, unknown>;
  if (raw.recurrence !== undefined) throw new Error(`Resource timeline occurrence ${occurrence.occurrenceId} must already be recurrence-expanded`);
  if (occurrence.temporalForm !== undefined && occurrence.temporalForm !== "interval" && occurrence.temporalForm !== "point") {
    throw new Error(`Resource timeline occurrence ${occurrence.occurrenceId} temporal form is invalid`);
  }
  const start = absoluteInstant(occurrence.start, `Resource timeline occurrence ${occurrence.occurrenceId} start`);
  const end = absoluteInstant(occurrence.end, `Resource timeline occurrence ${occurrence.occurrenceId} end`);
  const point = occurrence.temporalForm === "point";
  if (point ? start !== end : end <= start) {
    throw new Error(point
      ? `Resource timeline occurrence ${occurrence.occurrenceId} point requires identical start and end`
      : `Resource timeline occurrence ${occurrence.occurrenceId} must end after it starts`);
  }
  return { occurrence, start, end, point };
}

function renderIdentity(occurrenceId: string, resourceId: CalendarResourceId): string {
  return JSON.stringify([occurrenceId, resourceId]);
}

function visualOverlap(left: PreparedLayout, right: PreparedLayout): boolean {
  const leftEnd = left.xMinutes + left.widthMinutes;
  const rightEnd = right.xMinutes + right.widthMinutes;
  if (left.point && right.point) return left.xMinutes === right.xMinutes;
  if (left.point) return right.xMinutes <= left.xMinutes && left.xMinutes < rightEnd;
  if (right.point) return left.xMinutes <= right.xMinutes && right.xMinutes < leftEnd;
  return left.xMinutes < rightEnd && leftEnd > right.xMinutes;
}

function laneCluster(cluster: readonly PreparedLayout[]): CalendarResourceTimelineLayoutItem[] {
  const lanes: PreparedLayout[][] = [];
  const placed: Array<{ readonly item: PreparedLayout; readonly lane: number }> = [];
  for (const item of cluster) {
    let lane = lanes.findIndex(existing => existing.every(other => !visualOverlap(item, other)));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane]!.push(item);
    placed.push({ item, lane });
  }
  const laneCount = Math.max(1, lanes.length);
  return placed.map(({ item, lane }) => {
    const { start: _start, end: _end, point: _point, ...publicItem } = item;
    return { ...publicItem, lane, laneCount };
  });
}

function assignLanes(items: readonly PreparedLayout[]): CalendarResourceTimelineLayoutItem[] {
  const byRow = new Map<number, PreparedLayout[]>();
  for (const item of items) {
    const row = byRow.get(item.resourceRow) ?? [];
    row.push(item);
    byRow.set(item.resourceRow, row);
  }
  const result: CalendarResourceTimelineLayoutItem[] = [];
  for (const [resourceRow, row] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    void resourceRow;
    row.sort((a, b) =>
      a.xMinutes - b.xMinutes
      || Number(a.point) - Number(b.point)
      || b.widthMinutes - a.widthMinutes
      || a.start - b.start
      || a.renderId.localeCompare(b.renderId));
    let cluster: PreparedLayout[] = [];
    const flush = (): void => {
      if (!cluster.length) return;
      result.push(...laneCluster(cluster));
      cluster = [];
    };
    for (const item of row) {
      if (cluster.length && !cluster.some(other => visualOverlap(item, other))) flush();
      cluster.push(item);
    }
    flush();
  }
  return result.sort((a, b) =>
    a.resourceRow - b.resourceRow
    || a.xMinutes - b.xMinutes
    || a.lane - b.lane
    || a.renderId.localeCompare(b.renderId));
}

function visibleRows(
  resources: readonly CalendarResource[],
  collapsedResourceIds: readonly CalendarResourceId[] | undefined,
): readonly CalendarResourceRow[] {
  return flattenCalendarResources(resources, collapsedResourceIds ?? []);
}

/**
 * Headless horizontal Resource Timeline geometry.
 *
 * Inputs are already-expanded Calendar occurrences plus host-authoritative resource
 * assignments. Absolute instants are clipped to the requested range first. When a
 * time zone is supplied, horizontal coordinates use Calendar's existing civil
 * wall-clock mapping, including DST gaps/overlaps; otherwise elapsed minutes are used.
 * Lanes are presentation-only and never imply collision policy or mutation authority.
 */
export function layoutResourceTimeline(
  resources: readonly CalendarResource[],
  occurrences: readonly CalendarOccurrence[],
  assignments: readonly CalendarResourceAssignment[],
  range: CalendarRange,
  options: CalendarResourceTimelineLayoutOptions = {},
): readonly CalendarResourceTimelineLayoutItem[] {
  const rangeStart = absoluteInstant(range?.start, "Resource timeline range start");
  const rangeEnd = absoluteInstant(range?.end, "Resource timeline range end");
  if (rangeEnd <= rangeStart) throw new Error("Resource timeline range must end after it starts");
  if (options.timeZone !== undefined && (typeof options.timeZone !== "string" || !options.timeZone.trim())) {
    throw new Error("Resource timeline time zone must be a non-empty string");
  }

  const normalizedAssignments = validateCalendarResourceAssignments(resources, occurrences, assignments);
  const rows = visibleRows(resources, options.collapsedResourceIds);
  const rowByResource = new Map(rows.map(row => [row.resource.id, row.index]));
  const resourceById = new Map(resources.map(resource => [resource.id, resource]));
  const preparedByOccurrence = new Map<string, PreparedOccurrence>();
  for (const occurrence of occurrences) {
    const prepared = prepareOccurrence(occurrence);
    preparedByOccurrence.set(occurrence.occurrenceId, prepared);
  }

  const origin = new Date(rangeStart);
  const originCivil = options.timeZone === undefined
    ? 0
    : civilMinuteOfInstant(rangeStart, origin, options.timeZone);
  const coordinate = (instant: number): number => options.timeZone === undefined
    ? (instant - rangeStart) / MINUTE_MS
    : civilMinuteOfInstant(instant, origin, options.timeZone) - originCivil;
  const rangeCivilWidth = coordinate(rangeEnd);
  const rangeElapsedWidth = (rangeEnd - rangeStart) / MINUTE_MS;
  const rangeWidth = rangeCivilWidth > 0 ? rangeCivilWidth : rangeElapsedWidth;

  const preparedLayouts: PreparedLayout[] = [];
  for (const assignment of normalizedAssignments) {
    const prepared = preparedByOccurrence.get(assignment.occurrenceId)!;
    const relevant = prepared.point
      ? prepared.start >= rangeStart && prepared.start < rangeEnd
      : prepared.start < rangeEnd && prepared.end > rangeStart;
    if (!relevant) continue;

    const clippedStart = prepared.point ? prepared.start : Math.max(rangeStart, prepared.start);
    const clippedEnd = prepared.point ? prepared.end : Math.min(rangeEnd, prepared.end);
    const rawX = coordinate(clippedStart);
    const rawEnd = coordinate(clippedEnd);
    const civilWidth = rawEnd - rawX;
    const elapsedWidth = (clippedEnd - clippedStart) / MINUTE_MS;
    const rawWidth = prepared.point ? 0 : Math.max(1, civilWidth > 0 ? civilWidth : elapsedWidth);
    const xMinutes = Math.min(rangeWidth, Math.max(0, rawX));
    let widthMinutes = 0;
    if (!prepared.point) {
      const visibleRight = Math.min(rangeWidth, rawX + rawWidth);
      const visibleWidth = visibleRight - xMinutes;
      widthMinutes = visibleWidth > 0
        ? visibleWidth
        : Math.min(Math.max(1, elapsedWidth), Math.max(1, rangeWidth - xMinutes));
    }

    for (const resourceId of assignment.resourceIds) {
      const resourceRow = rowByResource.get(resourceId);
      if (resourceRow === undefined) continue;
      const resource = resourceById.get(resourceId)!;
      preparedLayouts.push({
        occurrence: prepared.occurrence,
        resource,
        occurrenceId: assignment.occurrenceId,
        resourceId,
        renderId: renderIdentity(assignment.occurrenceId, resourceId),
        resourceRow,
        xMinutes,
        widthMinutes,
        temporalForm: prepared.point ? "point" : "interval",
        ...(assignment.version === undefined ? {} : { assignmentVersion: assignment.version }),
        start: clippedStart,
        end: clippedEnd,
        point: prepared.point,
      });
    }
  }

  return assignLanes(preparedLayouts);
}
