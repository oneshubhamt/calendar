import type {
  CalendarMetadata,
  CalendarOccurrence,
  CalendarOpaqueIdentity,
  CalendarPlacementDecision,
  CalendarRange,
  ISODateTime,
  SeriesEditScope,
} from "../../core/types.js";

/** Opaque identifier in the optional resource scheduling dimension. */
export type CalendarResourceId = string;

/** Cosmetic resource presentation only; it carries no scheduling permission. */
export interface CalendarResourceDisplay {
  readonly color?: string | undefined;
  readonly textColor?: string | undefined;
  readonly icon?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Flat resource hierarchy. Direct assignment is permitted only when
 * acceptsAssignments is explicitly true; hierarchy validation is performed by validateCalendarResources().
 */
export interface CalendarResource {
  readonly id: CalendarResourceId;
  readonly title: string;
  readonly parentId?: CalendarResourceId | undefined;
  readonly order?: number | undefined;
  readonly acceptsAssignments?: boolean | undefined;
  readonly display?: CalendarResourceDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

/**
 * Host-owned resource projection for the requested Calendar range.
 * Resource Scheduler does not persist the returned hierarchy.
 */
export interface CalendarResourceProvider {
  readonly id: string;
  projectResources(
    range: CalendarRange,
  ): readonly CalendarResource[] | Promise<readonly CalendarResource[]>;
  subscribe?(listener: () => void): () => void;
}

/** Host-owned optimistic/staleness identity for an occurrence assignment set. */
export type CalendarResourceAssignmentVersion = CalendarOpaqueIdentity;

/** Complete resource association projected for one occurrence. */
export interface CalendarResourceAssignment {
  readonly occurrenceId: string;
  readonly resourceIds: readonly CalendarResourceId[];
  readonly version?: CalendarResourceAssignmentVersion | undefined;
}

/**
 * Batch assignment projection. One call covers the supplied range and occurrence
 * projection; providers should not be invoked once per occurrence.
 */
export interface CalendarResourceAssignmentProvider {
  readonly id: string;
  projectAssignments(
    range: CalendarRange,
    occurrences: readonly CalendarOccurrence[],
  ):
    | readonly CalendarResourceAssignment[]
    | Promise<readonly CalendarResourceAssignment[]>;
  subscribe?(listener: () => void): () => void;
}

/** Resource authority is independent of ordinary temporal occurrence authority. */
export interface CalendarResourceCapabilities {
  readonly canReassign?: boolean | undefined;
}

export interface CalendarResourceCapabilityProvider {
  capabilities(
    occurrence: CalendarOccurrence,
    resourceIds: readonly CalendarResourceId[],
  ): CalendarResourceCapabilities | undefined;
}

/**
 * Resource-specific placement context. Resource concepts deliberately do not
 * enter core CalendarPlacementContext.
 */
export interface CalendarResourcePlacementContext {
  readonly occurrence: CalendarOccurrence;
  readonly sourceResourceId?: CalendarResourceId | undefined;
  readonly targetResourceId?: CalendarResourceId | undefined;
  readonly fromResourceIds: readonly CalendarResourceId[];
  readonly toResourceIds: readonly CalendarResourceId[];
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly action: string;
}

export interface CalendarResourcePlacementGuard {
  readonly id: string;
  evaluate(
    context: CalendarResourcePlacementContext,
  ): CalendarPlacementDecision | Promise<CalendarPlacementDecision>;
}

/**
 * One atomic host mutation. from/to resourceIds always describe the complete
 * assignment set so replacing one rendered resource cannot erase the others.
 */
export interface CalendarResourcePlacementChange {
  readonly occurrence: CalendarOccurrence;
  readonly sourceResourceId?: CalendarResourceId | undefined;
  readonly targetResourceId?: CalendarResourceId | undefined;
  readonly fromResourceIds: readonly CalendarResourceId[];
  readonly toResourceIds: readonly CalendarResourceId[];
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly scope: SeriesEditScope;
  readonly assignmentVersion?: CalendarResourceAssignmentVersion | undefined;
}

/**
 * Host-owned atomic commit boundary. Hosts that use assignmentVersion must compare
 * it against authoritative state inside the same transaction as the write and reject
 * obsolete versions with CalendarCommandStaleError (or an error carrying code="stale").
 */
export interface CalendarResourceMutationPort {
  commit(change: CalendarResourcePlacementChange): Promise<void> | void;
}

export { validateCalendarResources, flattenCalendarResources, validateCalendarResourceAssignments, associateCalendarResources } from "./mechanics.js";
export type { CalendarResourceRow, CalendarResourceAssociation } from "./mechanics.js";

export { layoutResourceTimeline } from "./timeline-layout.js";
export type { CalendarResourceTimelineLayoutItem, CalendarResourceTimelineLayoutOptions } from "./timeline-layout.js";


export { evaluateCalendarResourcePlacement, executeCalendarResourcePlacement } from "./placement.js";
export type {
  CalendarResourceCollisionProjection,
  CalendarResourcePlacementCollision,
  CalendarResourcePlacementRequest,
  CalendarResourcePlacementEvaluationOptions,
  CalendarResourcePlacementEvaluation,
  CalendarResourcePlacementExecutionOptions,
  CalendarResourcePlacementExecutionStatus,
  CalendarResourcePlacementExecutionResult,
} from "./placement.js";
