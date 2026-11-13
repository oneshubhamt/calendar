import type {
  CalendarOccurrence,
  CalendarRange,
} from "../../core/types.js";
import {
  layoutHorizontalTimeline,
  type CalendarHorizontalTimelineEntry,
} from "../../core/horizontal-timeline.js";
import { parseAbsoluteDateTime } from "../../core/time.js";
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
} from "./types.js";

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

interface ResourceTimelineEntryValue {
  readonly occurrence: CalendarOccurrence;
  readonly resource: CalendarResource;
  readonly occurrenceId: string;
  readonly resourceId: CalendarResourceId;
  readonly renderId: string;
  readonly resourceRow: number;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

function validateExpandedOccurrence(occurrence: CalendarOccurrence): void {
  if (!occurrence || typeof occurrence !== "object" || Array.isArray(occurrence)) {
    throw new Error("Resource timeline occurrence must be an object");
  }
  const raw = occurrence as unknown as Record<string, unknown>;
  if (raw.recurrence !== undefined) {
    throw new Error(`Resource timeline occurrence ${occurrence.occurrenceId} must already be recurrence-expanded`);
  }
  if (occurrence.temporalForm !== undefined && occurrence.temporalForm !== "interval" && occurrence.temporalForm !== "point") {
    throw new Error(`Resource timeline occurrence ${occurrence.occurrenceId} temporal form is invalid`);
  }
  const start = parseAbsoluteDateTime(occurrence.start, `Resource timeline occurrence ${occurrence.occurrenceId} start`).getTime();
  const end = parseAbsoluteDateTime(occurrence.end, `Resource timeline occurrence ${occurrence.occurrenceId} end`).getTime();
  if (occurrence.temporalForm === "point" ? start !== end : end <= start) {
    throw new Error(occurrence.temporalForm === "point"
      ? `Resource timeline occurrence ${occurrence.occurrenceId} point requires identical start and end`
      : `Resource timeline occurrence ${occurrence.occurrenceId} must end after it starts`);
  }
}

function renderIdentity(occurrenceId: string, resourceId: CalendarResourceId): string {
  return JSON.stringify([occurrenceId, resourceId]);
}

function visibleRows(
  resources: readonly CalendarResource[],
  collapsedResourceIds: readonly CalendarResourceId[] | undefined,
): readonly CalendarResourceRow[] {
  return flattenCalendarResources(resources, collapsedResourceIds ?? []);
}

/**
 * Resource-specific adapter over the generic core horizontal-timeline pipeline.
 * Resource Scheduler owns only hierarchy/assignment expansion; clipping, civil/DST
 * coordinates, point/interval width and overlap lanes are core Calendar mechanics.
 */
export function layoutResourceTimeline(
  resources: readonly CalendarResource[],
  occurrences: readonly CalendarOccurrence[],
  assignments: readonly CalendarResourceAssignment[],
  range: CalendarRange,
  options: CalendarResourceTimelineLayoutOptions = {},
): readonly CalendarResourceTimelineLayoutItem[] {
  for (const occurrence of occurrences) validateExpandedOccurrence(occurrence);

  const normalizedAssignments = validateCalendarResourceAssignments(resources, occurrences, assignments);
  const rows = visibleRows(resources, options.collapsedResourceIds);
  const rowByResource = new Map(rows.map(row => [row.resource.id, row.index]));
  const resourceById = new Map(resources.map(resource => [resource.id, resource]));
  const occurrenceById = new Map(occurrences.map(occurrence => [occurrence.occurrenceId, occurrence]));

  const entries: CalendarHorizontalTimelineEntry<ResourceTimelineEntryValue>[] = [];
  for (const assignment of normalizedAssignments) {
    const occurrence = occurrenceById.get(assignment.occurrenceId);
    if (!occurrence) throw new Error(`Resource timeline occurrence disappeared: ${assignment.occurrenceId}`);
    for (const resourceId of assignment.resourceIds) {
      const resourceRow = rowByResource.get(resourceId);
      if (resourceRow === undefined) continue;
      const resource = resourceById.get(resourceId);
      if (!resource) throw new Error(`Resource timeline resource disappeared: ${resourceId}`);
      const renderId = renderIdentity(assignment.occurrenceId, resourceId);
      entries.push({
        id: renderId,
        start: occurrence.start,
        end: occurrence.end,
        ...(occurrence.temporalForm === undefined ? {} : { temporalForm: occurrence.temporalForm }),
        laneGroup: resourceRow,
        value: {
          occurrence,
          resource,
          occurrenceId: assignment.occurrenceId,
          resourceId,
          renderId,
          resourceRow,
          ...(assignment.version === undefined ? {} : { assignmentVersion: assignment.version }),
        },
      });
    }
  }

  return layoutHorizontalTimeline(entries, range, { timeZone: options.timeZone }).map(layout => ({
    ...layout.value,
    xMinutes: layout.xMinutes,
    widthMinutes: layout.widthMinutes,
    temporalForm: layout.temporalForm,
    lane: layout.lane,
    laneCount: layout.laneCount,
  }));
}
