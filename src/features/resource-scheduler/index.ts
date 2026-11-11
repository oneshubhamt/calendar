export type {
  CalendarResourceId,
  CalendarResourceDisplay,
  CalendarResource,
  CalendarResourceProvider,
  CalendarResourceAssignmentVersion,
  CalendarResourceAssignment,
  CalendarResourceAssignmentProvider,
  CalendarResourceCapabilities,
  CalendarResourceCapabilityProvider,
  CalendarResourcePlacementContext,
  CalendarResourcePlacementGuard,
  CalendarResourcePlacementChange,
  CalendarResourceMutationPort,
} from "./types.js";

export { validateCalendarResources, flattenCalendarResources, validateCalendarResourceAssignments, associateCalendarResources } from "./mechanics.js";
export type { CalendarResourceRow, CalendarResourceAssociation } from "./mechanics.js";

export { layoutResourceTimeline } from "./timeline-layout.js";
export type { CalendarResourceTimelineLayoutItem, CalendarResourceTimelineLayoutOptions } from "./timeline-layout.js";

export { evaluateCalendarResourcePlacement, executeCalendarResourcePlacement, replaceCalendarResourceAssignment } from "./placement.js";
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

export {
  expandResourceAvailabilityDefinitions,
  createResourceAvailabilityProvider,
  createResourceAvailabilityPlacementGuard,
} from "./availability.js";
export type {
  CalendarResourceAvailabilityState,
  CalendarResourceAvailabilityExceptionReplacement,
  CalendarResourceAvailabilityRecurrence,
  CalendarResourceAvailabilityDefinition,
  CalendarResourceAvailabilityRange,
  CalendarResourceAvailabilityProvider,
  CalendarResourceAvailabilityProviderOptions,
  CalendarResourceAvailabilityPlacementGuardOptions,
} from "./availability.js";

export { executeCalendarResourceInteraction } from "./interaction-execution.js";
export type {
  CalendarResourceInteractionMode,
  CalendarResourceInteractionCandidate,
  CalendarResourceInteractionExecutionOptions,
  CalendarResourceInteractionExecution,
} from "./interaction-execution.js";

export { layoutResourceTimeGrid } from "./time-grid-layout.js";
export type {
  CalendarResourceTimeGridLayoutOptions,
  CalendarResourceTimeGridColumn,
  CalendarResourceTimeGridLayoutItem,
  CalendarResourceTimeGridAllDayItem,
  CalendarResourceTimeGridAvailabilityLayout,
  CalendarResourceTimeGridLayout,
} from "./time-grid-layout.js";
