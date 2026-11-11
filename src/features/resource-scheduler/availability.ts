import type {
  CalendarBackgroundDisplay,
  CalendarMetadata,
  CalendarPlacementDecision,
  CalendarRange,
  CalendarTemporalSpec,
  ISODateTime,
  RecurrenceRule,
} from "../../core/types.js";
import type {
  CalendarTemporalSeriesException,
  CalendarTemporalSeriesPatch,
  CalendarTemporalSeriesRecurrence,
} from "../../core/recurrence.js";
import {
  createAvailabilityPlacementGuard,
  expandAvailabilityDefinitions,
  type CalendarAvailabilityDefinition,
  type CalendarAvailabilityExpansionOptions,
  type CalendarAvailabilityPlacementPolicy,
  type CalendarAvailabilityState,
} from "../availability.js";
import { validateCalendarResources } from "./mechanics.js";
import type {
  CalendarResource,
  CalendarResourceId,
  CalendarResourcePlacementGuard,
} from "./types.js";

export type CalendarResourceAvailabilityState = CalendarAvailabilityState;

export interface CalendarResourceAvailabilityExceptionReplacement extends CalendarTemporalSeriesPatch {
  readonly state?: CalendarAvailabilityState | undefined;
  readonly label?: string | undefined;
  readonly display?: CalendarBackgroundDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarResourceAvailabilityRecurrence
  extends CalendarTemporalSeriesRecurrence<CalendarResourceAvailabilityExceptionReplacement> {
  readonly rule: RecurrenceRule;
  readonly exceptions?: readonly CalendarTemporalSeriesException<CalendarResourceAvailabilityExceptionReplacement>[] | undefined;
}

/**
 * Resource-scoped availability. Resource identity remains an optional Resource
 * Scheduler concern and never enters core Calendar availability or event storage.
 */
export interface CalendarResourceAvailabilityDefinition {
  readonly id: string;
  readonly resourceIds: readonly CalendarResourceId[];
  readonly state: CalendarAvailabilityState;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly temporal?: CalendarTemporalSpec | undefined;
  readonly recurrence?: CalendarResourceAvailabilityRecurrence | undefined;
  readonly label?: string | undefined;
  readonly display?: CalendarBackgroundDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarResourceAvailabilityRange {
  readonly id: string;
  readonly definitionId: string;
  readonly resourceId: CalendarResourceId;
  readonly state: CalendarAvailabilityState;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly label?: string | undefined;
  readonly display?: CalendarBackgroundDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarResourceAvailabilityProvider {
  readonly id: string;
  projectAvailability(
    range: CalendarRange,
    resources: readonly CalendarResource[],
  ): readonly CalendarResourceAvailabilityRange[];
  subscribe?(listener: () => void): () => void;
}

export interface CalendarResourceAvailabilityProviderOptions extends CalendarAvailabilityExpansionOptions {
  readonly id: string;
  readonly definitions: () => readonly CalendarResourceAvailabilityDefinition[];
  readonly subscribe?: ((listener: () => void) => () => void) | undefined;
}

export interface CalendarResourceAvailabilityPlacementGuardOptions extends CalendarAvailabilityExpansionOptions {
  readonly id: string;
  /** Authoritative resources are read at evaluation time; no hierarchy is copied into the guard. */
  readonly resources: () => readonly CalendarResource[];
  readonly definitions: () => readonly CalendarResourceAvailabilityDefinition[];
  readonly policy: CalendarAvailabilityPlacementPolicy;
  readonly mode: "warn" | "prevent";
  readonly message?: string | undefined;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function definitionResourceMap(
  resources: readonly CalendarResource[],
  definitions: readonly CalendarResourceAvailabilityDefinition[],
): ReadonlyMap<string, readonly CalendarResourceId[]> {
  validateCalendarResources(resources);
  if (!Array.isArray(definitions)) throw new Error("Resource availability definitions must be an array");
  const resourceById = new Map(resources.map(resource => [resource.id, resource] as const));
  const definitionIds = new Set<string>();
  const result = new Map<string, readonly CalendarResourceId[]>();

  for (const definition of definitions) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error("Resource availability definition must be an object");
    }
    const id = requiredText(definition.id, "Resource availability definition id");
    if (definitionIds.has(id)) throw new Error(`Duplicate resource availability definition: ${id}`);
    definitionIds.add(id);
    if (!Array.isArray(definition.resourceIds) || definition.resourceIds.length === 0) {
      throw new Error(`Resource availability definition ${id} resourceIds must be a non-empty array`);
    }
    const seen = new Set<string>();
    const ids: CalendarResourceId[] = [];
    for (const rawResourceId of definition.resourceIds) {
      const resourceId = requiredText(rawResourceId, `Resource availability definition ${id} resource id`);
      if (seen.has(resourceId)) throw new Error(`Duplicate resource ${resourceId} in resource availability definition ${id}`);
      seen.add(resourceId);
      const resource = resourceById.get(resourceId);
      if (!resource) throw new Error(`Unknown resource in resource availability definition ${id}: ${resourceId}`);
      if (resource.acceptsAssignments !== true) {
        throw new Error(`Resource ${resourceId} does not accept assignments`);
      }
      ids.push(resourceId);
    }
    result.set(id, Object.freeze(ids));
  }
  return result;
}

function asCalendarDefinition(definition: CalendarResourceAvailabilityDefinition, calendarId?: string): CalendarAvailabilityDefinition {
  return {
    id: definition.id,
    state: definition.state,
    start: definition.start,
    end: definition.end,
    ...(definition.allDay === undefined ? {} : { allDay: definition.allDay }),
    ...(definition.temporal === undefined ? {} : { temporal: definition.temporal }),
    ...(definition.recurrence === undefined ? {} : { recurrence: definition.recurrence }),
    ...(calendarId === undefined ? {} : { calendarId }),
    ...(definition.label === undefined ? {} : { label: definition.label }),
    ...(definition.display === undefined ? {} : { display: definition.display }),
    ...(definition.metadata === undefined ? {} : { metadata: definition.metadata }),
  };
}

function availabilityMarker(metadata: CalendarMetadata | undefined): {
  readonly definitionId: string;
  readonly state: CalendarAvailabilityState;
} {
  const marker = metadata?.calendarAvailability;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error("Resource availability expansion lost its availability marker");
  }
  const definitionId = (marker as { readonly definitionId?: unknown }).definitionId;
  const state = (marker as { readonly state?: unknown }).state;
  if (typeof definitionId !== "string" || (state !== "available" && state !== "unavailable")) {
    throw new Error("Resource availability expansion produced an invalid availability marker");
  }
  return { definitionId, state };
}

function resourceMetadata(
  metadata: CalendarMetadata | undefined,
  definitionId: string,
  resourceId: CalendarResourceId,
  state: CalendarAvailabilityState,
): CalendarMetadata {
  const { calendarAvailability: _calendarAvailability, ...rest } = metadata ?? {};
  return {
    ...rest,
    calendarResourceAvailability: { definitionId, resourceId, state },
  };
}

export function expandResourceAvailabilityDefinitions(
  resources: readonly CalendarResource[],
  definitions: readonly CalendarResourceAvailabilityDefinition[],
  range: CalendarRange,
  options: CalendarAvailabilityExpansionOptions,
): readonly CalendarResourceAvailabilityRange[] {
  const resourcesByDefinition = definitionResourceMap(resources, definitions);
  const expanded = expandAvailabilityDefinitions(
    definitions.map(definition => asCalendarDefinition(definition)),
    range,
    options,
  );

  return Object.freeze(expanded.flatMap(item => {
    const marker = availabilityMarker(item.metadata);
    const resourceIds = resourcesByDefinition.get(marker.definitionId);
    if (!resourceIds) throw new Error(`Unknown expanded resource availability definition: ${marker.definitionId}`);
    return resourceIds.map(resourceId => Object.freeze({
      id: JSON.stringify([item.id, resourceId]),
      definitionId: marker.definitionId,
      resourceId,
      state: marker.state,
      start: item.start,
      end: item.end,
      ...(item.allDay === undefined ? {} : { allDay: item.allDay }),
      ...(item.label === undefined ? {} : { label: item.label }),
      ...(item.display === undefined ? {} : { display: item.display }),
      metadata: resourceMetadata(item.metadata, marker.definitionId, resourceId, marker.state),
    }));
  }));
}

export function createResourceAvailabilityProvider(
  options: CalendarResourceAvailabilityProviderOptions,
): CalendarResourceAvailabilityProvider {
  const id = requiredText(options.id, "Resource availability provider id");
  requiredText(options.timeZone, "Resource availability provider time zone");
  if (typeof options.definitions !== "function") throw new Error("Resource availability provider definitions must be a function");
  if (options.subscribe !== undefined && typeof options.subscribe !== "function") {
    throw new Error("Resource availability provider subscribe must be a function");
  }
  return {
    id,
    projectAvailability(range, resources) {
      return expandResourceAvailabilityDefinitions(resources, options.definitions(), range, { timeZone: options.timeZone });
    },
    ...(options.subscribe ? { subscribe: options.subscribe } : {}),
  };
}

function resourceScopedCalendarDefinitions(
  resources: readonly CalendarResource[],
  definitions: readonly CalendarResourceAvailabilityDefinition[],
): readonly CalendarAvailabilityDefinition[] {
  definitionResourceMap(resources, definitions);
  return definitions.flatMap(definition => definition.resourceIds.map(resourceId => ({
    ...asCalendarDefinition(definition, resourceId),
    // Generic availability requires globally unique definition IDs.
    id: JSON.stringify([definition.id, resourceId]),
  })));
}

/**
 * Explicit adapter from resource availability into the existing resource guard
 * chain. Visual resource availability remains passive unless this guard is installed.
 */
export function createResourceAvailabilityPlacementGuard(
  options: CalendarResourceAvailabilityPlacementGuardOptions,
): CalendarResourcePlacementGuard {
  const id = requiredText(options.id, "Resource availability placement guard id");
  requiredText(options.timeZone, "Resource availability placement guard time zone");
  if (typeof options.resources !== "function") throw new Error("Resource availability resources must be a function");
  if (typeof options.definitions !== "function") throw new Error("Resource availability definitions must be a function");

  const genericGuard = createAvailabilityPlacementGuard({
    id: `${id}:calendar-adapter`,
    timeZone: options.timeZone,
    definitions: () => resourceScopedCalendarDefinitions(options.resources(), options.definitions()),
    policy: options.policy,
    mode: options.mode,
    ...(options.message === undefined ? {} : { message: options.message }),
  });

  return {
    id,
    async evaluate(context): Promise<CalendarPlacementDecision> {
      if (!context.toResourceIds.length) return { mode: "allow" };
      let resources: readonly CalendarResource[];
      try {
        resources = validateCalendarResources(options.resources());
        // Validate all definitions/resources before considering any one target.
        resourceScopedCalendarDefinitions(resources, options.definitions());
      } catch {
        return { mode: "prevent", message: "Resource availability policy could not be evaluated." };
      }
      const resourceById = new Map(resources.map(resource => [resource.id, resource] as const));
      let warning: string | undefined;

      for (const resourceId of context.toResourceIds) {
        const resource = resourceById.get(resourceId);
        if (!resource || resource.acceptsAssignments !== true) {
          return { mode: "prevent", message: "Resource availability policy could not be evaluated." };
        }
        let decision: CalendarPlacementDecision;
        try {
          decision = await genericGuard.evaluate({
            start: context.start,
            end: context.end,
            allDay: Boolean(context.occurrence.allDay || context.occurrence.precision === "date"),
            action: context.action,
            timeZone: options.timeZone,
            calendarId: resourceId,
            occurrence: context.occurrence,
          });
        } catch {
          return { mode: "prevent", message: "Resource availability policy could not be evaluated." };
        }
        if (decision.mode === "prevent") {
          return {
            mode: "prevent",
            message: decision.message ? `${resource.title}: ${decision.message}` : `${resource.title} is unavailable.`,
          };
        }
        if (decision.mode === "warn" && warning === undefined) {
          warning = decision.message ? `${resource.title}: ${decision.message}` : `${resource.title} may be unavailable.`;
        }
      }
      return warning ? { mode: "warn", message: warning } : { mode: "allow" };
    },
  };
}
