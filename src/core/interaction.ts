import type {
  CalendarCollisionPolicy,
  CalendarItemPatch,
  CalendarNavigationBounds,
  CalendarOccurrence,
  CalendarOverlapDisambiguation,
  CalendarPlacementContext,
  CalendarPlacementGuard,
  CalendarPlacementGuardMode,
  CalendarSnapPolicy,
  CalendarSnapStrategy,
} from "./types.js";
import { shiftCivilMinutes } from "./civil-timeline.js";
import { addDays, dateKey, parseAbsoluteDateTime, snapDate, startOfDay, toDate } from "./time.js";

export const DEFAULT_SNAP_POLICY: Required<CalendarSnapPolicy> = Object.freeze({
  selection: "round",
  move: "round",
  resize: "round",
  keyboardStepMinutes: 15,
});

export const DEFAULT_COLLISION_POLICY: CalendarCollisionPolicy = Object.freeze({
  mode: "allow",
  includeAllDay: false,
});

function assertSnapSlotMinutes(slotMinutes: number): void {
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > 1_440) {
    throw new RangeError("slotMinutes must be an integer from 1 to 1440");
  }
}

export function normalizeSnapPolicy(policy: CalendarSnapPolicy | undefined, slotMinutes: number): Required<CalendarSnapPolicy> {
  assertSnapSlotMinutes(slotMinutes);
  const configuredStep = policy?.keyboardStepMinutes ?? slotMinutes;
  if (!Number.isFinite(configuredStep) || configuredStep <= 0) {
    throw new RangeError("keyboardStepMinutes must be positive and finite");
  }
  const keyboardStepMinutes = Math.max(1, Math.round(configuredStep));
  return Object.freeze({
    selection: policy?.selection ?? DEFAULT_SNAP_POLICY.selection,
    move: policy?.move ?? DEFAULT_SNAP_POLICY.move,
    resize: policy?.resize ?? DEFAULT_SNAP_POLICY.resize,
    keyboardStepMinutes,
  });
}

/** Snap a minute-valued coordinate/delta using the generic Calendar snap strategy. */
export function snapMinuteCoordinate(value: number, slotMinutes: number, strategy: CalendarSnapStrategy): number {
  if (!Number.isFinite(value)) throw new RangeError("minute coordinate must be finite");
  assertSnapSlotMinutes(slotMinutes);
  if (!["none", "floor", "round", "ceil"].includes(strategy)) throw new RangeError("snap strategy is invalid");
  if (strategy === "none") return value;
  const units = value / slotMinutes;
  const rounded = strategy === "floor" ? Math.floor(units) : strategy === "ceil" ? Math.ceil(units) : Math.round(units);
  return rounded * slotMinutes;
}

export function snapWithPolicy(value: Date, slotMinutes: number, strategy: CalendarSnapStrategy): Date {
  return strategy === "none" ? new Date(value.getTime()) : snapDate(value, slotMinutes, strategy);
}

export interface CalendarOccurrenceInteractionTimes {
  readonly start: string;
  readonly end: string;
}

/** Move an occurrence by civil wall-clock minutes. DST gaps are non-targetable. */
export function moveOccurrenceByCivilMinutes(
  occurrence: CalendarOccurrence,
  deltaMinutes: number,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): CalendarOccurrenceInteractionTimes | null {
  if (!Number.isFinite(deltaMinutes)) throw new RangeError("Move delta must be finite");
  const start = parseAbsoluteDateTime(occurrence.start, "Occurrence start");
  const end = parseAbsoluteDateTime(occurrence.end, "Occurrence end");
  const shiftedStart = shiftCivilMinutes(start, deltaMinutes, timeZone, overlap);
  if (!shiftedStart) return null;
  if (occurrence.temporalForm === "point") {
    const value = shiftedStart.toISOString();
    return { start: value, end: value };
  }
  const shiftedEnd = shiftCivilMinutes(end, deltaMinutes, timeZone, overlap);
  return shiftedEnd ? { start: shiftedStart.toISOString(), end: shiftedEnd.toISOString() } : null;
}

/** Resize one temporal edge in civil wall-clock minutes while preventing inversion. */
export function resizeOccurrenceByCivilMinutes(
  occurrence: CalendarOccurrence,
  edge: CalendarResizeEdge,
  deltaMinutes: number,
  minimumMinutes: number,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): CalendarOccurrenceInteractionTimes | null {
  if (!Number.isFinite(deltaMinutes)) throw new RangeError("Resize delta must be finite");
  if (!Number.isFinite(minimumMinutes) || minimumMinutes <= 0) throw new RangeError("Minimum duration must be positive and finite");
  if (occurrence.temporalForm === "point") return null;
  const start = parseAbsoluteDateTime(occurrence.start, "Occurrence start");
  const end = parseAbsoluteDateTime(occurrence.end, "Occurrence end");
  const base = edge === "start" ? start : end;
  const target = shiftCivilMinutes(base, deltaMinutes, timeZone, overlap);
  if (!target) return null;
  const resized = resizeInterval(start, end, target, edge, minimumMinutes);
  return { start: resized.start.toISOString(), end: resized.end.toISOString() };
}

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  const aStartMs = aStart.getTime(), aEndMs = aEnd.getTime();
  const bStartMs = bStart.getTime(), bEndMs = bEnd.getTime();
  if (aEndMs <= aStartMs || bEndMs <= bStartMs) return false;
  return aStartMs < bEndMs && aEndMs > bStartMs;
}

export interface PlacementCollision {
  readonly occurrence: CalendarOccurrence;
}


export interface CalendarPlacementGuardEvaluation {
  readonly mode: CalendarPlacementGuardMode;
  readonly messages: readonly string[];
}

/**
 * Evaluate generic placement policies in declaration order.
 * Prevent dominates warn, warn dominates allow. Guard failures and malformed runtime
 * results fail closed because Calendar cannot safely assume policy approval.
 */
export async function evaluatePlacementGuards(
  guards: readonly CalendarPlacementGuard[] | undefined,
  context: CalendarPlacementContext,
): Promise<CalendarPlacementGuardEvaluation> {
  if (!guards?.length) return { mode: "allow", messages: [] };

  const ids = new Set<string>();
  const warnings: string[] = [];
  for (const guard of guards) {
    const id = typeof guard?.id === "string" ? guard.id.trim() : "";
    if (!id || ids.has(id) || typeof guard?.evaluate !== "function") {
      return { mode: "prevent", messages: ["Scheduling policy could not be evaluated."] };
    }
    ids.add(id);

    let decision;
    try {
      decision = await guard.evaluate(context);
    } catch {
      return { mode: "prevent", messages: ["Scheduling policy could not be evaluated."] };
    }
    if (!decision || !["allow", "warn", "prevent"].includes(String(decision.mode))) {
      return { mode: "prevent", messages: ["Scheduling policy could not be evaluated."] };
    }
    if (decision.message !== undefined && (typeof decision.message !== "string" || !decision.message.trim() || decision.message.length > 2_048)) {
      return { mode: "prevent", messages: ["Scheduling policy could not be evaluated."] };
    }
    const message = decision.message?.trim();
    if (decision.mode === "prevent") return { mode: "prevent", messages: [message ?? "This placement is not allowed."] };
    if (decision.mode === "warn") warnings.push(message ?? "This placement may violate a scheduling policy.");
  }
  return warnings.length ? { mode: "warn", messages: warnings } : { mode: "allow", messages: [] };
}



export interface CalendarPlacementEvaluation {
  readonly mode: CalendarPlacementGuardMode;
  readonly messages: readonly string[];
  readonly collisions: readonly PlacementCollision[];
}

export interface CalendarPlacementEvaluationOptions {
  readonly navigationBounds?: CalendarNavigationBounds | undefined;
  readonly guards?: readonly CalendarPlacementGuard[] | undefined;
  readonly collisionPolicy?: CalendarCollisionPolicy | undefined;
  /**
   * Lazy event-only occurrence source used only when collision policy requires it.
   * Consumers decide how occurrences are queried; placement semantics stay centralized here.
   */
  readonly loadCollisionOccurrences?: (
    context: CalendarPlacementContext,
  ) => Promise<readonly CalendarOccurrence[]> | readonly CalendarOccurrence[];
}

export function placementInNavigationBounds(
  start: Date,
  end: Date,
  bounds: CalendarNavigationBounds | undefined,
  timeZone: string,
): boolean {
  const min = bounds?.min ? startOfDay(bounds.min, timeZone).getTime() : Number.NEGATIVE_INFINITY;
  const maxExclusive = bounds?.max ? addDays(startOfDay(bounds.max, timeZone), 1, timeZone).getTime() : Number.POSITIVE_INFINITY;
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (startMs === endMs) return startMs >= min && startMs < maxExclusive;
  return endMs > startMs && startMs >= min && endMs <= maxExclusive;
}

/**
 * Canonical temporal placement evaluation shared by Calendar-owned scheduling surfaces.
 * DOM confirmation/announcement remains a presentation responsibility of the caller.
 */
export async function evaluateCalendarPlacement(
  context: CalendarPlacementContext,
  options: CalendarPlacementEvaluationOptions = {},
): Promise<CalendarPlacementEvaluation> {
  const start = toDate(context.start);
  const end = toDate(context.end);
  if (!placementInNavigationBounds(start, end, options.navigationBounds, context.timeZone)) {
    return {
      mode: "prevent",
      messages: ["This placement is outside the allowed calendar date range."],
      collisions: [],
    };
  }

  const guardEvaluation = await evaluatePlacementGuards(options.guards, context);
  if (guardEvaluation.mode === "prevent") {
    return { ...guardEvaluation, collisions: [] };
  }

  const warnings = [...guardEvaluation.messages];
  const collisionPolicy = options.collisionPolicy ?? DEFAULT_COLLISION_POLICY;
  let collisions: readonly PlacementCollision[] = [];
  if (collisionPolicy.mode !== "allow") {
    if (!options.loadCollisionOccurrences) {
      return {
        mode: "prevent",
        messages: ["Scheduling conflicts could not be evaluated."],
        collisions: [],
      };
    }

    let occurrences: readonly CalendarOccurrence[];
    try {
      occurrences = await options.loadCollisionOccurrences(context);
    } catch {
      return {
        mode: "prevent",
        messages: ["Scheduling conflicts could not be evaluated."],
        collisions: [],
      };
    }

    collisions = placementCollisions(
      occurrences,
      start,
      end,
      context.allDay,
      collisionPolicy,
      context.occurrence?.occurrenceId,
    );
    if (collisions.length) {
      const names = [...new Set(collisions.map(row => row.occurrence.title))];
      const summary = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
      if (collisionPolicy.mode === "prevent") {
        return {
          mode: "prevent",
          messages: [`This placement overlaps ${summary}.`],
          collisions,
        };
      }
      warnings.push(`It overlaps ${summary}.`);
    }
  }

  return {
    mode: warnings.length ? "warn" : "allow",
    messages: warnings,
    collisions,
  };
}

export function placementCollisions(
  occurrences: readonly CalendarOccurrence[],
  start: Date,
  end: Date,
  allDay: boolean,
  policy: CalendarCollisionPolicy | undefined,
  ignoreOccurrenceId?: string,
): readonly PlacementCollision[] {
  const effective = policy ?? DEFAULT_COLLISION_POLICY;
  if (effective.mode === "allow") return [];
  return occurrences
    .filter(occurrence => occurrence.occurrenceId !== ignoreOccurrenceId)
    .filter(occurrence => effective.includeAllDay || (!allDay && !occurrence.allDay && occurrence.precision !== "date"))
    .filter(occurrence => intervalsOverlap(start, end, toDate(occurrence.start), toDate(occurrence.end)))
    .map(occurrence => ({ occurrence }));
}

/** Canonical scheduling fields when an interaction converts between timed and all-day representations. */
export function placementTimePatch(
  start: Date,
  end: Date,
  allDay: boolean,
  timeZone: string,
): Pick<CalendarItemPatch, "start" | "end" | "allDay" | "precision" | "temporal"> {
  if (end.getTime() <= start.getTime()) throw new RangeError("Placement end must be after start");
  if (allDay) return {
    start: dateKey(start, timeZone),
    end: dateKey(end, timeZone),
    allDay: true,
    precision: "date",
    temporal: { kind: "date" },
  };
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: false,
    precision: "minute",
    temporal: { kind: "instant" },
  };
}

export type CalendarResizeEdge = "start" | "end";

export interface CalendarResizePreview {
  readonly offsetMinutes: number;
  readonly heightMinutes: number;
}

/** Geometry for a time-grid resize preview where one CSS pixel represents one minute. */
export function resizePreview(
  durationMinutes: number,
  deltaMinutes: number,
  edge: CalendarResizeEdge,
  minimumMinutes: number,
): CalendarResizePreview {
  const minimum = Math.max(1, minimumMinutes);
  const duration = Math.max(minimum, durationMinutes);
  if (edge === "end") return { offsetMinutes: 0, heightMinutes: Math.max(minimum, duration + deltaMinutes) };
  const applied = Math.min(deltaMinutes, duration - minimum);
  return { offsetMinutes: applied, heightMinutes: duration - applied };
}

/** Resolve an absolute resize target while preventing an inverted/zero-length interval. */
export function resizeInterval(
  start: Date,
  end: Date,
  target: Date,
  edge: CalendarResizeEdge,
  minimumMinutes: number,
): { readonly start: Date; readonly end: Date } {
  const minimumMs = Math.max(1, minimumMinutes) * 60_000;
  if (edge === "start") {
    const latest = end.getTime() - minimumMs;
    return { start: new Date(Math.min(target.getTime(), latest)), end: new Date(end) };
  }
  const earliest = start.getTime() + minimumMs;
  return { start: new Date(start), end: new Date(Math.max(target.getTime(), earliest)) };
}
