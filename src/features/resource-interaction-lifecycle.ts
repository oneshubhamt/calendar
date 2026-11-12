import type { CalendarOccurrence } from "../core/types.js";
import {
  executeCalendarResourceInteraction,
  type CalendarResource,
  type CalendarResourceAssignment,
  type CalendarResourceId,
  type CalendarResourceInteractionCandidate,
  type CalendarResourceInteractionExecutionOptions,
  type CalendarResourceInteractionMode,
  type CalendarResourcePlacementExecutionResult,
  type CalendarResourcePlacementRequest,
} from "./resource-scheduler/index.js";

export interface CalendarResourceInteractionLifecycleOptions<TProjection> {
  readonly resources: readonly CalendarResource[];
  readonly occurrence: CalendarOccurrence;
  readonly sourceResourceId: CalendarResourceId;
  readonly assignment: CalendarResourceAssignment;
  readonly mode: CalendarResourceInteractionMode;
  readonly candidate: CalendarResourceInteractionCandidate;
  readonly timeZone: string;
  readonly executionOptions: CalendarResourceInteractionExecutionOptions;
  readonly isPending: () => boolean;
  readonly setPending: (pending: boolean) => void;
  readonly onResult?: ((
    result: CalendarResourcePlacementExecutionResult,
    request: CalendarResourcePlacementRequest,
  ) => void) | undefined;
  readonly refreshProjection?: (() => TProjection | void | Promise<TProjection | void>) | undefined;
  readonly applyProjection: (projection: TProjection) => void;
  readonly announce: (message: string) => void;
  readonly reportError: (error: unknown) => void;
  readonly restoreFocus: (result: CalendarResourcePlacementExecutionResult | undefined) => void;
}

function resultAnnouncement(
  result: CalendarResourcePlacementExecutionResult,
  occurrence: CalendarOccurrence,
): string {
  if (result.status === "committed") return `${occurrence.title} changed.`;
  if (result.status === "stale") return `${occurrence.title} changed elsewhere; refreshing authoritative data.`;
  if (result.status === "warning" || result.status === "prevented") return result.evaluation.messages.join(" ");
  return `${occurrence.title} is already in that position.`;
}

/**
 * Orientation-neutral UI lifecycle after pointer/keyboard geometry has produced
 * one resource interaction candidate. Surfaces retain geometry, rendering and
 * focus targeting; this helper owns pending state, execution/result callbacks,
 * authoritative reprojection and consistent failure semantics.
 */
export async function runCalendarResourceInteractionLifecycle<TProjection>(
  options: CalendarResourceInteractionLifecycleOptions<TProjection>,
): Promise<CalendarResourcePlacementExecutionResult | undefined> {
  if (options.isPending()) return undefined;

  options.setPending(true);
  let result: CalendarResourcePlacementExecutionResult | undefined;
  try {
    const execution = await executeCalendarResourceInteraction(
      options.resources,
      options.occurrence,
      options.sourceResourceId,
      options.assignment,
      options.mode,
      options.candidate,
      options.timeZone,
      options.executionOptions,
    );
    if (execution.status === "cancelled" || !execution.result || !execution.request) return undefined;

    result = execution.result;
    try {
      options.onResult?.(result, execution.request);
    } catch (error) {
      options.reportError(error);
    }
    options.announce(resultAnnouncement(result, options.occurrence));

    if (result.status === "committed" || result.status === "stale") {
      try {
        const projection = await options.refreshProjection?.();
        if (projection !== undefined) options.applyProjection(projection);
      } catch (error) {
        options.reportError(error);
        if (result.status === "committed") {
          options.announce(`${options.occurrence.title} changed, but authoritative refresh failed.`);
        }
      }
    }
    return result;
  } catch (error) {
    options.reportError(error);
    options.announce(`${options.occurrence.title} was not changed.`);
    return undefined;
  } finally {
    options.setPending(false);
    options.restoreFocus(result);
  }
}
