import type { CalendarOccurrence } from "../../core/types.js";
import { assertCalendarMetadataIntegrity } from "../../core/store.js";
import type {
  CalendarResource, CalendarResourceAssignment, CalendarResourceId,
  CalendarResourceAssignmentVersion,
} from "./types.js";

export interface CalendarResourceRow {
  readonly resource: CalendarResource;
  readonly parentId?: CalendarResourceId | undefined;
  readonly depth: number;
  /** Zero-based deterministic position within the visible flattened hierarchy. */
  readonly index: number;
  readonly acceptsAssignments: boolean;
  readonly hasChildren: boolean;
}

export interface CalendarResourceAssociation {
  readonly occurrence: CalendarOccurrence;
  readonly resource: CalendarResource;
  /** Identity of the rendered occurrence-resource pair, not a Calendar event identity. */
  readonly occurrenceId: string;
  readonly resourceId: CalendarResourceId;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new Error(`${label} must be a non-empty string of at most 2048 characters`);
  }
  return value;
}

function validateDisplay(value: unknown, label: string): void {
  const display = object(value, label);
  for (const [key, entry] of Object.entries(display)) {
    if (!["color", "textColor", "icon", "className"].includes(key)) {
      throw new Error(`${label} has unknown field ${key}`);
    }
    if (typeof entry !== "string" || !entry.trim() || entry.length > 2_048) {
      throw new Error(`${label} ${key} is invalid`);
    }
  }
}

/**
 * Validate a flat hierarchy in two stages: local integrity first, then parent
 * existence and cycle checks. Never mutate host-provided resource objects.
 */
export function validateCalendarResources(resources: readonly CalendarResource[]): readonly CalendarResource[] {
  if (!Array.isArray(resources)) throw new Error("Resources must be an array");
  const byId = new Map<string, CalendarResource>();
  for (const resource of resources) {
    const raw = object(resource, "Resource");
    const id = text(raw.id, "Resource id");
    if (byId.has(id)) throw new Error(`Duplicate resource id: ${id}`);
    text(raw.title, `Resource ${id} title`);
    if (raw.parentId !== undefined) text(raw.parentId, `Resource ${id} parent id`);
    if (raw.order !== undefined && (typeof raw.order !== "number" || !Number.isSafeInteger(raw.order))) {
      throw new Error(`Resource ${id} order must be a safe integer`);
    }
    if (raw.acceptsAssignments !== undefined && typeof raw.acceptsAssignments !== "boolean") {
      throw new Error(`Resource ${id} acceptsAssignments must be boolean`);
    }
    if (raw.display !== undefined) validateDisplay(raw.display, `Resource ${id} display`);
    if (raw.metadata !== undefined) assertCalendarMetadataIntegrity(raw.metadata, `Resource ${id} metadata`);
    byId.set(id, resource);
  }
  for (const resource of resources) {
    if (resource.parentId === undefined) continue;
    if (resource.parentId === resource.id) throw new Error(`Resource ${resource.id} cannot parent itself`);
    if (!byId.has(resource.parentId)) throw new Error(`Missing parent ${resource.parentId} for resource ${resource.id}`);
  }

  const status = new Map<string, 1 | 2>();
  for (const id of byId.keys()) {
    if (status.has(id)) continue;
    let cursor: string | undefined = id;
    const visiting: string[] = [];
    while (cursor !== undefined && !status.has(cursor)) {
      status.set(cursor, 1);
      visiting.push(cursor);
      cursor = byId.get(cursor)?.parentId;
    }
    if (cursor !== undefined && status.get(cursor) === 1) {
      throw new Error(`Resource hierarchy cycle involving ${cursor}`);
    }
    for (const visited of visiting) status.set(visited, 2);
  }
  return resources;
}

function orderedResources(resources: readonly CalendarResource[]): {
  readonly byId: Map<string, CalendarResource>;
  readonly children: Map<string | undefined, CalendarResource[]>;
} {
  validateCalendarResources(resources);
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const children = new Map<string | undefined, CalendarResource[]>();
  for (const resource of resources) {
    const siblings = children.get(resource.parentId) ?? [];
    siblings.push(resource);
    children.set(resource.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) =>
    (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { byId, children };
}

/**
 * Deterministic depth-first hierarchy. Collapsed IDs are caller-controlled UI
 * state; invalid IDs fail closed rather than silently hiding nothing.
 */
export function flattenCalendarResources(
  resources: readonly CalendarResource[],
  collapsedResourceIds: readonly CalendarResourceId[] = [],
): readonly CalendarResourceRow[] {
  const { byId, children } = orderedResources(resources);
  if (!Array.isArray(collapsedResourceIds)) throw new Error("Collapsed resource IDs must be an array");
  const collapsed = new Set<string>();
  for (const id of collapsedResourceIds) {
    text(id, "Collapsed resource id");
    if (!byId.has(id)) throw new Error(`Unknown collapsed resource: ${id}`);
    if (collapsed.has(id)) throw new Error(`Duplicate collapsed resource: ${id}`);
    collapsed.add(id);
  }
  const rows: CalendarResourceRow[] = [];
  const roots = children.get(undefined) ?? [];
  const stack: Array<{ readonly resource: CalendarResource; readonly depth: number }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ resource: roots[index]!, depth: 0 });
  }
  while (stack.length) {
    const current = stack.pop()!;
    const descendants = children.get(current.resource.id) ?? [];
    rows.push({
      resource: current.resource,
      parentId: current.resource.parentId,
      depth: current.depth,
      index: rows.length,
      acceptsAssignments: current.resource.acceptsAssignments === true,
      hasChildren: descendants.length > 0,
    });
    if (collapsed.has(current.resource.id)) continue;
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push({ resource: descendants[index]!, depth: current.depth + 1 });
    }
  }
  return rows;
}

function assertAssignmentVersion(version: unknown, label: string): void {
  // Core metadata checks accept JSON-like data, so wrap the opaque identity
  // in a metadata envelope; this rejects cycles, non-finite values and classes.
  assertCalendarMetadataIntegrity({ version }, label);
}

/**
 * Validate complete assignment records and normalize order. Missing assignment
 * records represent unassigned occurrences; unknown/duplicate records fail.
 * Resource arrays are returned in hierarchy order, not provider arrival order.
 */
export function validateCalendarResourceAssignments(
  resources: readonly CalendarResource[],
  occurrences: readonly CalendarOccurrence[],
  assignments: readonly CalendarResourceAssignment[],
): readonly CalendarResourceAssignment[] {
  const rows = flattenCalendarResources(resources);
  if (!Array.isArray(occurrences) || !Array.isArray(assignments)) {
    throw new Error("Resource occurrence and assignment projections must be arrays");
  }
  const knownOccurrences = new Set<string>();
  for (const occurrence of occurrences) {
    const id = text(object(occurrence, "Occurrence").occurrenceId, "Occurrence id");
    if (knownOccurrences.has(id)) throw new Error(`Duplicate occurrence in resource projection: ${id}`);
    knownOccurrences.add(id);
  }
  const knownResources = new Map(rows.map(row => [row.resource.id, row.index]));
  const resourcesById = new Map(resources.map(resource => [resource.id, resource]));
  const seen = new Set<string>();
  const result: CalendarResourceAssignment[] = [];
  for (const assignment of assignments) {
    const raw = object(assignment, "Resource assignment");
    const id = text(raw.occurrenceId, "Assignment occurrence id");
    if (!knownOccurrences.has(id)) throw new Error(`Unknown occurrence in resource assignment: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate resource assignment record: ${id}`);
    seen.add(id);
    if (!Array.isArray(raw.resourceIds)) throw new Error(`Resource assignment ${id} resourceIds must be an array`);
    const ids = new Set<string>();
    for (const resourceId of raw.resourceIds) {
      text(resourceId, `Assignment ${id} resource id`);
      if (!knownResources.has(resourceId)) throw new Error(`Unknown resource in assignment ${id}: ${resourceId}`);
      if (ids.has(resourceId)) throw new Error(`Duplicate resource in assignment ${id}: ${resourceId}`);
      const resource = resourcesById.get(resourceId);
      if (resource?.acceptsAssignments !== true) throw new Error(`Resource ${resourceId} does not accept assignments`);
      ids.add(resourceId);
    }
    if (raw.version !== undefined) assertAssignmentVersion(raw.version, `Assignment ${id} version`);
    result.push({
      occurrenceId: id,
      resourceIds: [...ids].sort((a,b)=>(knownResources.get(a) ?? 0)-(knownResources.get(b) ?? 0)),
      ...(raw.version === undefined ? {} : { version: assignment.version }),
    });
  }
  result.sort((a,b)=>a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0);
  return result;
}

/** Deterministic occurrence-resource pairs, preserving complete multi-resource associations. */
export function associateCalendarResources(
  resources: readonly CalendarResource[],
  occurrences: readonly CalendarOccurrence[],
  assignments: readonly CalendarResourceAssignment[],
): readonly CalendarResourceAssociation[] {
  const normalized = validateCalendarResourceAssignments(resources, occurrences, assignments);
  const resourcesById = new Map(resources.map(resource => [resource.id, resource]));
  const occurrencesById = new Map(occurrences.map(occurrence => [occurrence.occurrenceId, occurrence]));
  const rows = flattenCalendarResources(resources);
  const rowOrder = new Map(rows.map(row => [row.resource.id, row.index]));
  const result: CalendarResourceAssociation[] = [];
  for (const assignment of normalized) {
    for (const resourceId of assignment.resourceIds) {
      const resource = resourcesById.get(resourceId);
      const occurrence = occurrencesById.get(assignment.occurrenceId);
      if (!resource || !occurrence) throw new Error("Resource association projection became inconsistent");
      result.push({
        occurrence, resource, occurrenceId: assignment.occurrenceId, resourceId,
        ...(assignment.version === undefined ? {} : { assignmentVersion: assignment.version }),
      });
    }
  }
  result.sort((a,b)=>(rowOrder.get(a.resourceId) ?? 0)-(rowOrder.get(b.resourceId) ?? 0)
    || (a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0));
  return result;
}
