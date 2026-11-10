import type {
  CalendarCollisionPolicy,
  CalendarOccurrence,
  CalendarOccurrenceCapabilityProvider,
  CalendarPlacementGuardMode,
  CalendarSource,
  SeriesEditScope,
} from "../../core/types.js";
import {
  evaluateCalendarPlacement,
  placementCollisions,
  type CalendarPlacementEvaluation,
  type CalendarPlacementEvaluationOptions,
} from "../../core/interaction.js";
import {
  resolveOccurrenceCapabilities,
  temporalMutationCapabilityRequirements,
  type CalendarOccurrenceCapabilityKey,
} from "../../core/authority.js";
import { CalendarCommandStaleError } from "../../core/commands.js";
import { flattenCalendarResources, validateCalendarResourceAssignments } from "./mechanics.js";
import type {
  CalendarResource,
  CalendarResourceAssignment,
  CalendarResourceAssignmentVersion,
  CalendarResourceCapabilityProvider,
  CalendarResourceId,
  CalendarResourceMutationPort,
  CalendarResourcePlacementChange,
  CalendarResourcePlacementContext,
  CalendarResourcePlacementGuard,
} from "./index.js";

export interface CalendarResourcePlacementRequest extends CalendarResourcePlacementContext {
  readonly scope: SeriesEditScope;
  readonly timeZone: string;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

export interface CalendarResourceCollisionProjection {
  readonly occurrences: readonly CalendarOccurrence[];
  readonly assignments: readonly CalendarResourceAssignment[];
}

export interface CalendarResourcePlacementCollision {
  readonly occurrence: CalendarOccurrence;
  readonly resourceIds: readonly CalendarResourceId[];
}

export interface CalendarResourcePlacementEvaluationOptions {
  readonly source?: CalendarSource | undefined;
  readonly occurrenceCapabilityProvider?: CalendarOccurrenceCapabilityProvider | undefined;
  readonly resourceCapabilityProvider?: CalendarResourceCapabilityProvider | undefined;
  readonly temporal?: CalendarPlacementEvaluationOptions | undefined;
  readonly resourceGuards?: readonly CalendarResourcePlacementGuard[] | undefined;
  readonly resourceCollisionPolicy?: CalendarCollisionPolicy | undefined;
  readonly loadResourceCollisionProjection?: (
    context: CalendarResourcePlacementContext,
  ) => CalendarResourceCollisionProjection | Promise<CalendarResourceCollisionProjection>;
}

export interface CalendarResourcePlacementEvaluation {
  readonly mode: CalendarPlacementGuardMode;
  readonly messages: readonly string[];
  readonly temporal: CalendarPlacementEvaluation;
  readonly resourceCollisions: readonly CalendarResourcePlacementCollision[];
  readonly requiredTemporalCapabilities: readonly CalendarOccurrenceCapabilityKey[];
  readonly requiresResourceReassignment: boolean;
  readonly hasChange: boolean;
  readonly change: CalendarResourcePlacementChange;
}

export interface CalendarResourcePlacementExecutionOptions extends CalendarResourcePlacementEvaluationOptions {
  readonly mutationPort: CalendarResourceMutationPort;
  /** Explicit acknowledgement of warn-level placement decisions. */
  readonly acceptWarnings?: boolean | undefined;
}

export type CalendarResourcePlacementExecutionStatus =
  | "committed"
  | "prevented"
  | "warning"
  | "noop"
  | "stale";

export interface CalendarResourcePlacementExecutionResult {
  readonly status: CalendarResourcePlacementExecutionStatus;
  readonly evaluation: CalendarResourcePlacementEvaluation;
  readonly error?: unknown;
}

interface NormalizedResourceSets {
  readonly from: readonly CalendarResourceId[];
  readonly to: readonly CalendarResourceId[];
  readonly resourceById: ReadonlyMap<CalendarResourceId, CalendarResource>;
}

function invalidTemporalEvaluation(message: string): CalendarPlacementEvaluation {
  return { mode: "prevent", messages: [message], collisions: [] };
}

function preventedEvaluation(
  request: CalendarResourcePlacementRequest,
  message: string,
): CalendarResourcePlacementEvaluation {
  return {
    mode: "prevent",
    messages: [message],
    temporal: invalidTemporalEvaluation(message),
    resourceCollisions: [],
    requiredTemporalCapabilities: [],
    requiresResourceReassignment: false,
    hasChange: false,
    change: {
      occurrence: request.occurrence,
      ...(request.sourceResourceId === undefined ? {} : { sourceResourceId: request.sourceResourceId }),
      ...(request.targetResourceId === undefined ? {} : { targetResourceId: request.targetResourceId }),
      fromResourceIds: request.fromResourceIds,
      toResourceIds: request.toResourceIds,
      start: request.start,
      end: request.end,
      scope: request.scope,
      ...(request.assignmentVersion === undefined ? {} : { assignmentVersion: request.assignmentVersion }),
    },
  };
}

function absoluteInstant(value: unknown, label: string): number {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(value)) {
    throw new Error(`${label} must be an absolute ISO date-time`);
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error(`${label} must be a valid absolute ISO date-time`);
  return instant;
}

function normalizedResourceSets(
  resources: readonly CalendarResource[],
  request: CalendarResourcePlacementRequest,
): NormalizedResourceSets {
  const rows = flattenCalendarResources(resources);
  const resourceById = new Map(rows.map(row => [row.resource.id, row.resource] as const));
  const normalize = (
    ids: readonly CalendarResourceId[],
    label: string,
    version?: CalendarResourceAssignmentVersion | undefined,
  ): readonly CalendarResourceId[] => {
    try {
      const [assignment] = validateCalendarResourceAssignments(
        resources,
        [request.occurrence],
        [{
          occurrenceId: request.occurrence.occurrenceId,
          resourceIds: ids,
          ...(version === undefined ? {} : { version }),
        }],
      );
      return assignment?.resourceIds ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} is invalid`;
      throw new Error(`${label}: ${message}`);
    }
  };

  const from = normalize(request.fromResourceIds, "Current resource assignment", request.assignmentVersion);
  const to = normalize(request.toResourceIds, "Target resource assignment");
  if (request.sourceResourceId !== undefined && !from.includes(request.sourceResourceId)) {
    throw new Error(`Source resource ${request.sourceResourceId} is not in the current assignment`);
  }
  if (request.targetResourceId !== undefined && !to.includes(request.targetResourceId)) {
    throw new Error(`Target resource ${request.targetResourceId} is not in the target assignment`);
  }
  return { from, to, resourceById };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function combineMode(...modes: readonly CalendarPlacementGuardMode[]): CalendarPlacementGuardMode {
  if (modes.includes("prevent")) return "prevent";
  if (modes.includes("warn")) return "warn";
  return "allow";
}

async function evaluateResourceGuards(
  guards: readonly CalendarResourcePlacementGuard[] | undefined,
  context: CalendarResourcePlacementContext,
): Promise<{ readonly mode: CalendarPlacementGuardMode; readonly messages: readonly string[] }> {
  if (!guards?.length) return { mode: "allow", messages: [] };
  const ids = new Set<string>();
  const warnings: string[] = [];
  for (const guard of guards) {
    const id = typeof guard?.id === "string" ? guard.id.trim() : "";
    if (!id || ids.has(id) || typeof guard?.evaluate !== "function") {
      return { mode: "prevent", messages: ["Resource scheduling policy could not be evaluated."] };
    }
    ids.add(id);
    let decision;
    try {
      decision = await guard.evaluate(context);
    } catch {
      return { mode: "prevent", messages: ["Resource scheduling policy could not be evaluated."] };
    }
    if (!decision || !["allow", "warn", "prevent"].includes(String(decision.mode))) {
      return { mode: "prevent", messages: ["Resource scheduling policy could not be evaluated."] };
    }
    if (decision.message !== undefined && (typeof decision.message !== "string" || !decision.message.trim() || decision.message.length > 2_048)) {
      return { mode: "prevent", messages: ["Resource scheduling policy could not be evaluated."] };
    }
    const message = decision.message?.trim();
    if (decision.mode === "prevent") return { mode: "prevent", messages: [message ?? "This resource placement is not allowed."] };
    if (decision.mode === "warn") warnings.push(message ?? "This resource placement may violate a scheduling policy.");
  }
  return warnings.length ? { mode: "warn", messages: warnings } : { mode: "allow", messages: [] };
}

function resourceReassignmentAllowed(
  provider: CalendarResourceCapabilityProvider | undefined,
  occurrence: CalendarOccurrence,
  currentResourceIds: readonly CalendarResourceId[],
): boolean {
  if (!provider) return false;
  try {
    const value = provider.capabilities(occurrence, currentResourceIds)?.canReassign;
    return value === true;
  } catch {
    return false;
  }
}

function collisionMessage(
  collisions: readonly CalendarResourcePlacementCollision[],
  resources: ReadonlyMap<CalendarResourceId, CalendarResource>,
): string {
  const names = [...new Set(collisions.map(row => row.occurrence.title))];
  const resourceIds = [...new Set(collisions.flatMap(row => row.resourceIds))];
  const resourceNames = resourceIds.map(id => resources.get(id)?.title ?? id);
  const eventSummary = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  const resourceSummary = resourceNames.slice(0, 3).join(", ") + (resourceNames.length > 3 ? ` and ${resourceNames.length - 3} more` : "");
  return `Resource conflict with ${eventSummary} on ${resourceSummary}.`;
}

async function evaluateResourceCollisions(
  resources: readonly CalendarResource[],
  request: CalendarResourcePlacementRequest,
  toResourceIds: readonly CalendarResourceId[],
  resourceById: ReadonlyMap<CalendarResourceId, CalendarResource>,
  options: CalendarResourcePlacementEvaluationOptions,
): Promise<{
  readonly mode: CalendarPlacementGuardMode;
  readonly messages: readonly string[];
  readonly collisions: readonly CalendarResourcePlacementCollision[];
}> {
  const policy = options.resourceCollisionPolicy ?? { mode: "allow" as const };
  if (!["allow", "warn", "prevent"].includes(String(policy.mode))
    || (policy.includeAllDay !== undefined && typeof policy.includeAllDay !== "boolean")) {
    return { mode: "prevent", messages: ["Resource conflicts could not be evaluated."], collisions: [] };
  }
  if (policy.mode === "allow" || toResourceIds.length === 0) return { mode: "allow", messages: [], collisions: [] };
  if (!options.loadResourceCollisionProjection) {
    return { mode: "prevent", messages: ["Resource conflicts could not be evaluated."], collisions: [] };
  }

  let projection: CalendarResourceCollisionProjection;
  try {
    projection = await options.loadResourceCollisionProjection({
      occurrence: request.occurrence,
      ...(request.sourceResourceId === undefined ? {} : { sourceResourceId: request.sourceResourceId }),
      ...(request.targetResourceId === undefined ? {} : { targetResourceId: request.targetResourceId }),
      fromResourceIds: request.fromResourceIds,
      toResourceIds: request.toResourceIds,
      start: request.start,
      end: request.end,
      action: request.action,
    });
  } catch {
    return { mode: "prevent", messages: ["Resource conflicts could not be evaluated."], collisions: [] };
  }

  if (!projection || !Array.isArray(projection.occurrences) || !Array.isArray(projection.assignments)) {
    return { mode: "prevent", messages: ["Resource conflicts could not be evaluated."], collisions: [] };
  }

  let collisions: CalendarResourcePlacementCollision[];
  try {
    const assignments = validateCalendarResourceAssignments(
      resources,
      projection.occurrences,
      projection.assignments,
    );
    const target = new Set(toResourceIds);
    const resourcesByOccurrence = new Map(assignments.map(assignment => [assignment.occurrenceId, assignment.resourceIds]));
    const candidates = projection.occurrences.filter(occurrence => {
      const ids = resourcesByOccurrence.get(occurrence.occurrenceId) ?? [];
      return ids.some(id => target.has(id));
    });
    const temporalCollisions = placementCollisions(
      candidates,
      new Date(request.start),
      new Date(request.end),
      Boolean(request.occurrence.allDay || request.occurrence.precision === "date"),
      policy,
      request.occurrence.occurrenceId,
    );
    collisions = temporalCollisions.map(({ occurrence }) => ({
      occurrence,
      resourceIds: (resourcesByOccurrence.get(occurrence.occurrenceId) ?? []).filter(id => target.has(id)),
    }));
  } catch {
    return { mode: "prevent", messages: ["Resource conflicts could not be evaluated."], collisions: [] };
  }
  if (!collisions.length) return { mode: "allow", messages: [], collisions: [] };
  const message = collisionMessage(collisions, resourceById);
  return policy.mode === "prevent"
    ? { mode: "prevent", messages: [message], collisions }
    : { mode: "warn", messages: [message], collisions };
}

function staleError(error: unknown): boolean {
  return error instanceof CalendarCommandStaleError
    || Boolean(error && typeof error === "object" && (error as { readonly code?: unknown }).code === "stale");
}

/**
 * Replace only the resource represented by one rendered occurrence/resource pair.
 * Other assignments are preserved; targeting an already-assigned resource removes
 * the rendered source assignment without creating a duplicate.
 */
export function replaceCalendarResourceAssignment(
  resourceIds: readonly CalendarResourceId[],
  sourceResourceId: CalendarResourceId,
  targetResourceId: CalendarResourceId,
): readonly CalendarResourceId[] {
  if (!Array.isArray(resourceIds)) throw new Error("Resource assignments must be an array");
  if (typeof sourceResourceId !== "string" || !sourceResourceId.trim()) throw new Error("Source resource id is invalid");
  if (typeof targetResourceId !== "string" || !targetResourceId.trim()) throw new Error("Target resource id is invalid");
  const sourceCount = resourceIds.filter(id => id === sourceResourceId).length;
  if (sourceCount !== 1) throw new Error(`Rendered source resource ${sourceResourceId} must occur exactly once in the current assignment`);
  const result: CalendarResourceId[] = [];
  const seen = new Set<CalendarResourceId>();
  for (const id of resourceIds) {
    const next = id === sourceResourceId ? targetResourceId : id;
    if (!seen.has(next)) {
      seen.add(next);
      result.push(next);
    }
  }
  return result;
}

/**
 * Evaluate one proposed resource/time placement without mutating host state.
 * Temporal policy stays canonical in evaluateCalendarPlacement(); resource policy
 * is composed around it and remains strictly scoped to this optional feature.
 */
export async function evaluateCalendarResourcePlacement(
  resources: readonly CalendarResource[],
  request: CalendarResourcePlacementRequest,
  options: CalendarResourcePlacementEvaluationOptions = {},
): Promise<CalendarResourcePlacementEvaluation> {
  if (!["this", "this-and-following", "all"].includes(String(request.scope))) {
    return preventedEvaluation(request, "Resource placement recurrence scope is invalid.");
  }
  let normalized: NormalizedResourceSets;
  try {
    normalized = normalizedResourceSets(resources, request);
  } catch (error) {
    return preventedEvaluation(request, error instanceof Error ? error.message : "Resource assignment is invalid.");
  }

  let beforeStart: number;
  let beforeEnd: number;
  let afterStart: number;
  let afterEnd: number;
  try {
    beforeStart = absoluteInstant(request.occurrence.start, "Occurrence start");
    beforeEnd = absoluteInstant(request.occurrence.end, "Occurrence end");
    afterStart = absoluteInstant(request.start, "Placement start");
    afterEnd = absoluteInstant(request.end, "Placement end");
  } catch (error) {
    return preventedEvaluation(request, error instanceof Error ? error.message : "Resource placement time is invalid.");
  }
  const point = request.occurrence.temporalForm === "point";
  if (point ? afterStart !== afterEnd : afterEnd <= afterStart) {
    return preventedEvaluation(request, point
      ? "Point resource placements require identical start and end."
      : "Resource placement must end after it starts.");
  }
  if (typeof request.timeZone !== "string" || !request.timeZone.trim()) {
    return preventedEvaluation(request, "Resource placement time zone is invalid.");
  }

  const temporalContext = {
    start: new Date(afterStart).toISOString(),
    end: new Date(afterEnd).toISOString(),
    allDay: Boolean(request.occurrence.allDay || request.occurrence.precision === "date"),
    action: request.action,
    timeZone: request.timeZone,
    calendarId: request.occurrence.calendarId,
    occurrence: request.occurrence,
  };
  const temporal = await evaluateCalendarPlacement(temporalContext, options.temporal);
  const canonicalContext: CalendarResourcePlacementContext = {
    occurrence: request.occurrence,
    ...(request.sourceResourceId === undefined ? {} : { sourceResourceId: request.sourceResourceId }),
    ...(request.targetResourceId === undefined ? {} : { targetResourceId: request.targetResourceId }),
    fromResourceIds: normalized.from,
    toResourceIds: normalized.to,
    start: temporalContext.start,
    end: temporalContext.end,
    action: request.action,
  };
  const resourceChanged = !sameIds(normalized.from, normalized.to);
  const requiredTemporalCapabilities = temporalMutationCapabilityRequirements({
    beforeStart, beforeEnd, afterStart, afterEnd,
  });
  const temporalChanged = requiredTemporalCapabilities.length > 0;
  const change: CalendarResourcePlacementChange = {
    occurrence: request.occurrence,
    ...(request.sourceResourceId === undefined ? {} : { sourceResourceId: request.sourceResourceId }),
    ...(request.targetResourceId === undefined ? {} : { targetResourceId: request.targetResourceId }),
    fromResourceIds: normalized.from,
    toResourceIds: normalized.to,
    start: temporalContext.start,
    end: temporalContext.end,
    scope: request.scope,
    ...(request.assignmentVersion === undefined ? {} : { assignmentVersion: request.assignmentVersion }),
  };

  if (temporal.mode === "prevent") {
    return {
      mode: "prevent",
      messages: temporal.messages,
      temporal,
      resourceCollisions: [],
      requiredTemporalCapabilities,
      requiresResourceReassignment: resourceChanged,
      hasChange: temporalChanged || resourceChanged,
      change,
    };
  }

  if (temporalChanged) {
    const capabilities = resolveOccurrenceCapabilities(
      request.occurrence,
      options.source,
      options.occurrenceCapabilityProvider,
    );
    const denied = requiredTemporalCapabilities.filter(capability => capabilities[capability] !== true);
    if (denied.length) {
      return {
        mode: "prevent",
        messages: ["Temporal placement is not authorized for this occurrence."],
        temporal,
        resourceCollisions: [],
        requiredTemporalCapabilities,
        requiresResourceReassignment: resourceChanged,
        hasChange: true,
        change,
      };
    }
  }

  if (resourceChanged && !resourceReassignmentAllowed(options.resourceCapabilityProvider, request.occurrence, normalized.from)) {
    return {
      mode: "prevent",
      messages: ["Resource reassignment is not authorized for this occurrence."],
      temporal,
      resourceCollisions: [],
      requiredTemporalCapabilities,
      requiresResourceReassignment: true,
      hasChange: true,
      change,
    };
  }

  const resourceGuards = await evaluateResourceGuards(options.resourceGuards, canonicalContext);
  if (resourceGuards.mode === "prevent") {
    return {
      mode: "prevent",
      messages: resourceGuards.messages,
      temporal,
      resourceCollisions: [],
      requiredTemporalCapabilities,
      requiresResourceReassignment: resourceChanged,
      hasChange: temporalChanged || resourceChanged,
      change,
    };
  }

  const resourceCollisions = await evaluateResourceCollisions(
    resources, request, normalized.to, normalized.resourceById, options,
  );
  const mode = combineMode(temporal.mode, resourceGuards.mode, resourceCollisions.mode);
  return {
    mode,
    messages: [...temporal.messages, ...resourceGuards.messages, ...resourceCollisions.messages],
    temporal,
    resourceCollisions: resourceCollisions.collisions,
    requiredTemporalCapabilities,
    requiresResourceReassignment: resourceChanged,
    hasChange: temporalChanged || resourceChanged,
    change,
  };
}

/**
 * Re-evaluate at execution time and perform one atomic host commit.
 * Hosts should compare assignmentVersion atomically inside commit() and reject an
 * obsolete version with CalendarCommandStaleError (or any error carrying code="stale").
 * Stale commits are never retried here.
 */
export async function executeCalendarResourcePlacement(
  resources: readonly CalendarResource[],
  request: CalendarResourcePlacementRequest,
  options: CalendarResourcePlacementExecutionOptions,
): Promise<CalendarResourcePlacementExecutionResult> {
  const evaluation = await evaluateCalendarResourcePlacement(resources, request, options);
  if (evaluation.mode === "prevent") return { status: "prevented", evaluation };
  if (evaluation.mode === "warn" && options.acceptWarnings !== true) return { status: "warning", evaluation };
  if (!evaluation.hasChange) return { status: "noop", evaluation };

  try {
    await options.mutationPort.commit(evaluation.change);
  } catch (error) {
    if (staleError(error)) return { status: "stale", evaluation, error };
    throw error;
  }
  return { status: "committed", evaluation };
}
