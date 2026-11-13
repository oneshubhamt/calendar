import type {
  CalendarOccurrence,
  CalendarSource,
  SeriesEditScope,
} from "../../core/types.js";
import {
  executeCalendarResourcePlacement,
  type CalendarResourcePlacementExecutionOptions,
  type CalendarResourcePlacementExecutionResult,
  type CalendarResourcePlacementRequest,
} from "./placement.js";
import type {
  CalendarResource,
  CalendarResourceAssignment,
  CalendarResourceId,
} from "./types.js";

export type CalendarResourceInteractionMode = "move" | "resize-start" | "resize-end";

export interface CalendarResourceInteractionCandidate {
  readonly start: string;
  readonly end: string;
  readonly targetResourceId: CalendarResourceId;
  readonly toResourceIds: readonly CalendarResourceId[];
}

export interface CalendarResourceInteractionExecutionOptions
  extends Omit<CalendarResourcePlacementExecutionOptions, "source" | "acceptWarnings"> {
  readonly sourceForOccurrence?: ((occurrence: CalendarOccurrence) => CalendarSource | undefined) | undefined;
  readonly resolveScope?: ((
    occurrence: CalendarOccurrence,
    action: CalendarResourcePlacementRequest["action"],
  ) => SeriesEditScope | null | Promise<SeriesEditScope | null>) | undefined;
  readonly confirmWarnings?: ((
    messages: readonly string[],
    request: CalendarResourcePlacementRequest,
  ) => boolean | Promise<boolean>) | undefined;
}

export interface CalendarResourceInteractionExecution {
  readonly status: "cancelled" | "executed";
  readonly request?: CalendarResourcePlacementRequest | undefined;
  readonly result?: CalendarResourcePlacementExecutionResult | undefined;
}

function actionFor(
  mode: CalendarResourceInteractionMode,
  occurrence: CalendarOccurrence,
  sourceResourceId: CalendarResourceId,
  candidate: CalendarResourceInteractionCandidate,
): CalendarResourcePlacementRequest["action"] {
  if (mode !== "move") return mode;
  const timeChanged = Date.parse(candidate.start) !== Date.parse(occurrence.start)
    || Date.parse(candidate.end) !== Date.parse(occurrence.end);
  if (candidate.targetResourceId === sourceResourceId) return "move";
  return timeChanged ? "resource-time-move" : "resource-reassign";
}

/**
 * Orientation-neutral resource interaction execution. DOM surfaces own pointer/
 * keyboard geometry and refresh/focus state; this helper owns recurrence scope,
 * warning acknowledgement and the single atomic resource/time commit path.
 */
export async function executeCalendarResourceInteraction(
  resources: readonly CalendarResource[],
  occurrence: CalendarOccurrence,
  sourceResourceId: CalendarResourceId,
  assignment: CalendarResourceAssignment,
  mode: CalendarResourceInteractionMode,
  candidate: CalendarResourceInteractionCandidate,
  timeZone: string,
  options: CalendarResourceInteractionExecutionOptions,
): Promise<CalendarResourceInteractionExecution> {
  const action = actionFor(mode, occurrence, sourceResourceId, candidate);
  let scope: SeriesEditScope | null = "this";
  if (occurrence.recurring && options.resolveScope) {
    scope = await options.resolveScope(occurrence, action);
  }
  if (scope === null) return { status: "cancelled" };
  if (!["this", "this-and-following", "all"].includes(scope)) {
    throw new Error("Resource scheduling interaction returned an invalid recurrence scope");
  }

  const request: CalendarResourcePlacementRequest = {
    occurrence,
    sourceResourceId,
    targetResourceId: candidate.targetResourceId,
    fromResourceIds: assignment.resourceIds,
    toResourceIds: candidate.toResourceIds,
    start: candidate.start,
    end: candidate.end,
    scope,
    timeZone,
    action,
    ...(assignment.version === undefined ? {} : { assignmentVersion: assignment.version }),
  };
  const executionOptions = (acceptWarnings: boolean): CalendarResourcePlacementExecutionOptions => ({
    mutationPort: options.mutationPort,
    ...(options.occurrenceCapabilityProvider === undefined ? {} : { occurrenceCapabilityProvider: options.occurrenceCapabilityProvider }),
    ...(options.resourceCapabilityProvider === undefined ? {} : { resourceCapabilityProvider: options.resourceCapabilityProvider }),
    ...(options.temporal === undefined ? {} : { temporal: options.temporal }),
    ...(options.resourceGuards === undefined ? {} : { resourceGuards: options.resourceGuards }),
    ...(options.resourceCollisionPolicy === undefined ? {} : { resourceCollisionPolicy: options.resourceCollisionPolicy }),
    ...(options.loadResourceCollisionProjection === undefined ? {} : { loadResourceCollisionProjection: options.loadResourceCollisionProjection }),
    ...(options.sourceForOccurrence === undefined ? {} : { source: options.sourceForOccurrence(occurrence) }),
    acceptWarnings,
  });

  let result = await executeCalendarResourcePlacement(resources, request, executionOptions(false));
  if (result.status === "warning" && options.confirmWarnings) {
    const accepted = await options.confirmWarnings(result.evaluation.messages, request);
    if (accepted) result = await executeCalendarResourcePlacement(resources, request, executionOptions(true));
  }
  return { status: "executed", request, result };
}
