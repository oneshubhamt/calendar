import type {
  CalendarBackgroundRange,
  CalendarOccurrence,
  CalendarRange,
} from "../../core/types.js";
import {
  layoutBackgroundDay,
  layoutTimedDay,
  type BackgroundLayoutItem,
  type TimedLayoutItem,
} from "../../core/layout.js";
import { addDays, dateKey, startOfDay, toDate } from "../../core/time.js";
import { parseAbsoluteDateTime } from "../../core/time.js";
import {
  flattenCalendarResources,
  validateCalendarResourceAssignments,
} from "./mechanics.js";
import type { CalendarResourceAvailabilityRange } from "./availability.js";
import type {
  CalendarResource,
  CalendarResourceAssignment,
  CalendarResourceAssignmentVersion,
  CalendarResourceId,
} from "./types.js";

export interface CalendarResourceTimeGridLayoutOptions {
  readonly timeZone: string;
  readonly collapsedResourceIds?: readonly CalendarResourceId[] | undefined;
  readonly startMinute?: number | undefined;
  readonly endMinute?: number | undefined;
  /** Defensive rendering bound. Defaults to 31 and may be raised up to 366. */
  readonly maxDays?: number | undefined;
  readonly availability?: readonly CalendarResourceAvailabilityRange[] | undefined;
}

export interface CalendarResourceTimeGridColumn {
  readonly resource: CalendarResource;
  readonly resourceId: CalendarResourceId;
  readonly resourceDepth: number;
  readonly day: Date;
  readonly dayKey: string;
  readonly dayIndex: number;
  readonly resourceIndex: number;
  readonly columnIndex: number;
}

export interface CalendarResourceTimeGridLayoutItem extends TimedLayoutItem {
  readonly resource: CalendarResource;
  readonly resourceId: CalendarResourceId;
  readonly occurrenceId: string;
  readonly renderId: string;
  readonly day: Date;
  readonly dayKey: string;
  readonly dayIndex: number;
  readonly resourceIndex: number;
  readonly columnIndex: number;
  readonly startsInDay: boolean;
  readonly endsInDay: boolean;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

export interface CalendarResourceTimeGridAllDayItem {
  readonly occurrence: CalendarOccurrence;
  readonly resource: CalendarResource;
  readonly occurrenceId: string;
  readonly resourceId: CalendarResourceId;
  readonly renderId: string;
  readonly day: Date;
  readonly dayKey: string;
  readonly dayIndex: number;
  readonly resourceIndex: number;
  readonly columnIndex: number;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

export interface CalendarResourceTimeGridAvailabilityLayout extends BackgroundLayoutItem {
  readonly availability: CalendarResourceAvailabilityRange;
  readonly resourceId: CalendarResourceId;
  readonly dayKey: string;
  readonly columnIndex: number;
}

export interface CalendarResourceTimeGridLayout {
  readonly columns: readonly CalendarResourceTimeGridColumn[];
  readonly timed: readonly CalendarResourceTimeGridLayoutItem[];
  readonly allDay: readonly CalendarResourceTimeGridAllDayItem[];
  readonly availability: readonly CalendarResourceTimeGridAvailabilityLayout[];
  readonly startMinute: number;
  readonly endMinute: number;
}

function visibleWindow(options: CalendarResourceTimeGridLayoutOptions): { start: number; end: number } {
  const start = options.startMinute ?? 0;
  const end = options.endMinute ?? 1440;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1440 || end <= start) {
    throw new RangeError("Resource TimeGrid visible minutes must satisfy 0 <= start < end <= 1440");
  }
  return { start, end };
}

function localDays(
  range: CalendarRange,
  timeZone: string,
  maxDays: number,
): readonly Date[] {
  const rangeStart = parseAbsoluteDateTime(range?.start, "Resource TimeGrid range start");
  const rangeEnd = parseAbsoluteDateTime(range?.end, "Resource TimeGrid range end");
  if (rangeEnd.getTime() <= rangeStart.getTime()) throw new RangeError("Resource TimeGrid range must end after it starts");
  const days: Date[] = [];
  let day = startOfDay(rangeStart, timeZone);
  while (day.getTime() < rangeEnd.getTime()) {
    const next = addDays(day, 1, timeZone);
    if (next.getTime() > rangeStart.getTime()) days.push(day);
    if (days.length > maxDays) throw new RangeError(`Resource TimeGrid range exceeds ${maxDays} local days`);
    day = next;
  }
  return days;
}

function renderIdentity(occurrenceId: string, resourceId: CalendarResourceId, dayKeyValue: string): string {
  return JSON.stringify([occurrenceId, resourceId, dayKeyValue]);
}

function clippedTimed(
  item: TimedLayoutItem,
  startMinute: number,
  endMinute: number,
): Pick<TimedLayoutItem, "topMinutes" | "heightMinutes"> | undefined {
  if (item.temporalForm === "point") {
    return item.topMinutes >= startMinute && item.topMinutes < endMinute
      ? { topMinutes: item.topMinutes, heightMinutes: 0 }
      : undefined;
  }
  const top = Math.max(startMinute, item.topMinutes);
  const bottom = Math.min(endMinute, item.topMinutes + item.heightMinutes);
  return bottom > top ? { topMinutes: top, heightMinutes: bottom - top } : undefined;
}

/**
 * Vertical resources-as-columns geometry. Resource Scheduler owns hierarchy and
 * assignments; ordinary Calendar timed/background layout remains authoritative
 * for civil/DST coordinates, clipping and overlap lanes.
 */
export function layoutResourceTimeGrid(
  resources: readonly CalendarResource[],
  occurrences: readonly CalendarOccurrence[],
  assignments: readonly CalendarResourceAssignment[],
  range: CalendarRange,
  options: CalendarResourceTimeGridLayoutOptions,
): CalendarResourceTimeGridLayout {
  if (!options || typeof options.timeZone !== "string" || !options.timeZone.trim()) {
    throw new TypeError("Resource TimeGrid timeZone is required");
  }
  // Eagerly validates the IANA zone without introducing a second timezone validator.
  new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone }).format(new Date(0));
  const maxDays = options.maxDays ?? 31;
  if (!Number.isSafeInteger(maxDays) || maxDays < 1 || maxDays > 366) {
    throw new RangeError("Resource TimeGrid maxDays must be an integer from 1 to 366");
  }
  const visible = visibleWindow(options);
  const days = localDays(range, options.timeZone, maxDays);
  const rows = flattenCalendarResources(resources, options.collapsedResourceIds ?? [])
    .filter(row => row.acceptsAssignments);
  const normalized = validateCalendarResourceAssignments(resources, occurrences, assignments);
  const occurrenceById = new Map(occurrences.map(occurrence => [occurrence.occurrenceId, occurrence] as const));
  const assignmentByOccurrence = new Map(normalized.map(assignment => [assignment.occurrenceId, assignment] as const));

  const columns: CalendarResourceTimeGridColumn[] = [];
  for (const [dayIndex, day] of days.entries()) {
    for (const [resourceIndex, row] of rows.entries()) {
      columns.push(Object.freeze({
        resource: row.resource,
        resourceId: row.resource.id,
        resourceDepth: row.depth,
        day: new Date(day.getTime()),
        dayKey: dateKey(day, options.timeZone),
        dayIndex,
        resourceIndex,
        columnIndex: columns.length,
      }));
    }
  }

  const timed: CalendarResourceTimeGridLayoutItem[] = [];
  const allDay: CalendarResourceTimeGridAllDayItem[] = [];
  const availability: CalendarResourceTimeGridAvailabilityLayout[] = [];

  for (const column of columns) {
    const assigned: CalendarOccurrence[] = [];
    for (const assignment of normalized) {
      if (!assignment.resourceIds.includes(column.resourceId)) continue;
      const occurrence = occurrenceById.get(assignment.occurrenceId);
      if (occurrence) assigned.push(occurrence);
    }

    for (const item of layoutTimedDay(assigned, column.day, options.timeZone)) {
      const clipped = clippedTimed(item, visible.start, visible.end);
      if (!clipped) continue;
      const occurrence = item.occurrence;
      const assignment = assignmentByOccurrence.get(occurrence.occurrenceId);
      const dayStart = startOfDay(column.day, options.timeZone);
      const dayEnd = addDays(dayStart, 1, options.timeZone);
      const start = toDate(occurrence.start, options.timeZone).getTime();
      const end = toDate(occurrence.end, options.timeZone).getTime();
      timed.push(Object.freeze({
        ...item,
        ...clipped,
        resource: column.resource,
        resourceId: column.resourceId,
        occurrenceId: occurrence.occurrenceId,
        renderId: renderIdentity(occurrence.occurrenceId, column.resourceId, column.dayKey),
        day: new Date(column.day.getTime()),
        dayKey: column.dayKey,
        dayIndex: column.dayIndex,
        resourceIndex: column.resourceIndex,
        columnIndex: column.columnIndex,
        startsInDay: start >= dayStart.getTime() && start < dayEnd.getTime(),
        endsInDay: end > dayStart.getTime() && end <= dayEnd.getTime(),
        ...(assignment?.version === undefined ? {} : { assignmentVersion: assignment.version }),
      }));
    }

    const dayStart = startOfDay(column.day, options.timeZone);
    const dayEnd = addDays(dayStart, 1, options.timeZone);
    for (const occurrence of assigned) {
      if (!occurrence.allDay && occurrence.precision !== "date") continue;
      const start = toDate(occurrence.start, options.timeZone).getTime();
      const end = toDate(occurrence.end, options.timeZone).getTime();
      if (!(start < dayEnd.getTime() && end > dayStart.getTime())) continue;
      const assignment = assignmentByOccurrence.get(occurrence.occurrenceId);
      allDay.push(Object.freeze({
        occurrence,
        resource: column.resource,
        occurrenceId: occurrence.occurrenceId,
        resourceId: column.resourceId,
        renderId: renderIdentity(occurrence.occurrenceId, column.resourceId, column.dayKey),
        day: new Date(column.day.getTime()),
        dayKey: column.dayKey,
        dayIndex: column.dayIndex,
        resourceIndex: column.resourceIndex,
        columnIndex: column.columnIndex,
        ...(assignment?.version === undefined ? {} : { assignmentVersion: assignment.version }),
      }));
    }

    const backgrounds = (options.availability ?? []).filter(item => item.resourceId === column.resourceId);
    for (const item of layoutBackgroundDay(
      backgrounds as readonly CalendarBackgroundRange[],
      column.day,
      { timeZone: options.timeZone, startMinute: visible.start, endMinute: visible.end },
    )) {
      const source = backgrounds.find(candidate => candidate.id === item.range.id);
      if (!source) throw new Error("Resource TimeGrid availability projection became inconsistent");
      availability.push(Object.freeze({
        ...item,
        availability: source,
        resourceId: column.resourceId,
        dayKey: column.dayKey,
        columnIndex: column.columnIndex,
      }));
    }
  }

  return Object.freeze({
    columns: Object.freeze(columns),
    timed: Object.freeze(timed),
    allDay: Object.freeze(allDay),
    availability: Object.freeze(availability),
    startMinute: visible.start,
    endMinute: visible.end,
  });
}
