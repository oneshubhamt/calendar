import type {
  CalendarOccurrence,
  CalendarOccurrenceCapabilities,
  CalendarOccurrenceCapabilityProvider,
  CalendarOccurrenceCommandPath,
  CalendarOccurrenceCommand,
  CalendarCommandContext,
  CalendarSource,
} from "./types.js";

type CalendarBooleanCapabilityKey = Exclude<keyof CalendarOccurrenceCapabilities, "commandPath">;

export type CalendarOccurrenceCapabilityKey = CalendarBooleanCapabilityKey;

export interface CalendarOccurrenceTemporalMutation {
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly afterStart: number;
  readonly afterEnd: number;
  readonly crossesAllDayBoundary?: boolean | undefined;
}

/** Canonical operation authority implied by changing an occurrence's temporal boundaries. */
export function temporalMutationCapabilityRequirements(
  mutation: CalendarOccurrenceTemporalMutation,
): readonly CalendarOccurrenceCapabilityKey[] {
  const { beforeStart, beforeEnd, afterStart, afterEnd } = mutation;
  if (![beforeStart, beforeEnd, afterStart, afterEnd].every(Number.isFinite)) throw new RangeError("Temporal mutation values must be finite");
  if (mutation.crossesAllDayBoundary) return ["canMove", "canMoveBetweenAllDayAndTimed"];

  const startDelta = afterStart - beforeStart;
  const endDelta = afterEnd - beforeEnd;
  if (startDelta === 0 && endDelta === 0) return [];
  if (startDelta === endDelta) return ["canMove"];

  const requirements: CalendarOccurrenceCapabilityKey[] = [];
  if (startDelta !== 0) requirements.push("canResizeStart");
  if (endDelta !== 0) requirements.push("canResizeEnd");
  return requirements;
}

/** Build stable generic context for a command targeting one projected or repository occurrence. */
export function calendarOccurrenceCommandContext(
  command: CalendarOccurrenceCommand,
  now: string,
  timeZone?: string,
): CalendarCommandContext {
  const occurrence = command.occurrence;
  const seriesScope = "scope" in command ? command.scope : undefined;
  return {
    now,
    ...(timeZone !== undefined ? { timeZone } : {}),
    occurrence,
    occurrenceId: occurrence.occurrenceId,
    sourceItemId: occurrence.sourceItemId,
    ...(occurrence.projectionIdentity !== undefined ? { projectionIdentity: occurrence.projectionIdentity } : {}),
    ...(seriesScope !== undefined ? { seriesScope } : {}),
  };
}

export type ResolvedCalendarOccurrenceCapabilities = {
  readonly [K in CalendarBooleanCapabilityKey]-?: boolean;
} & {
  readonly commandPath: CalendarOccurrenceCommandPath;
};

function editableByPolicy(occurrence: CalendarOccurrence): boolean {
  return occurrence.editPolicy !== "readonly" && occurrence.editPolicy !== "generated";
}

/** Calendar's existing item/source authority expressed as operation-level capabilities. */
export function baselineOccurrenceCapabilities(
  occurrence: CalendarOccurrence,
  source: CalendarSource | undefined,
): ResolvedCalendarOccurrenceCapabilities {
  const mutable = editableByPolicy(occurrence) && Boolean(source && !source.readOnly);
  const point = occurrence.temporalForm === "point";
  return {
    commandPath: "default",
    canMove: mutable,
    canMoveBetweenAllDayAndTimed: mutable && !point,
    canResizeStart: mutable && !point,
    canResizeEnd: mutable && !point,
    canOpen: true,
    canEdit: mutable && occurrence.editPolicy === "full",
    canDelete: mutable,
    canChangeRecurrence: mutable && occurrence.editPolicy === "full",
    canInvokeActions: true,
  };
}

const BOOLEAN_CAPABILITIES = [
  "canMove",
  "canMoveBetweenAllDayAndTimed",
  "canResizeStart",
  "canResizeEnd",
  "canOpen",
  "canEdit",
  "canDelete",
  "canChangeRecurrence",
  "canInvokeActions",
] as const satisfies readonly CalendarBooleanCapabilityKey[];

/**
 * Resolve provider authority without weakening Calendar's baseline accidentally.
 * Default-path providers can only narrow. `trusted-host` must explicitly grant a capability to widen it.
 * Malformed runtime values fail closed for the affected operation.
 */
export function resolveOccurrenceCapabilities(
  occurrence: CalendarOccurrence,
  source: CalendarSource | undefined,
  provider?: CalendarOccurrenceCapabilityProvider,
): ResolvedCalendarOccurrenceCapabilities {
  const baseline = baselineOccurrenceCapabilities(occurrence, source);
  let supplied: CalendarOccurrenceCapabilities | undefined;
  try { supplied = provider?.capabilities(occurrence); } catch {
    return {
      commandPath: "default",
      canMove: false, canMoveBetweenAllDayAndTimed: false,
      canResizeStart: false, canResizeEnd: false,
      canOpen: false, canEdit: false, canDelete: false, canChangeRecurrence: false, canInvokeActions: false,
    };
  }
  if (!supplied) return baseline;

  const trusted = supplied.commandPath === "trusted-host";
  const resolved: { -readonly [K in keyof ResolvedCalendarOccurrenceCapabilities]: ResolvedCalendarOccurrenceCapabilities[K] } = {
    ...baseline,
    commandPath: trusted ? "trusted-host" : "default",
  };
  for (const key of BOOLEAN_CAPABILITIES) {
    const value = supplied[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      resolved[key] = false;
      continue;
    }
    resolved[key] = trusted ? value : Boolean(baseline[key] && value);
  }
  if (occurrence.temporalForm === "point") {
    resolved.canResizeStart = false;
    resolved.canResizeEnd = false;
    resolved.canMoveBetweenAllDayAndTimed = false;
  }
  return resolved;
}
