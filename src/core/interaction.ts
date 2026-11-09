import type {
  CalendarCollisionPolicy,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarSnapPolicy,
  CalendarSnapStrategy,
} from "./types.js";
import { dateKey, snapDate, toDate } from "./time.js";

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

export function normalizeSnapPolicy(policy: CalendarSnapPolicy | undefined, slotMinutes: number): Required<CalendarSnapPolicy> {
  const keyboardStepMinutes = Math.max(1, Math.round(policy?.keyboardStepMinutes ?? slotMinutes));
  return Object.freeze({
    selection: policy?.selection ?? DEFAULT_SNAP_POLICY.selection,
    move: policy?.move ?? DEFAULT_SNAP_POLICY.move,
    resize: policy?.resize ?? DEFAULT_SNAP_POLICY.resize,
    keyboardStepMinutes,
  });
}

export function snapWithPolicy(value: Date, slotMinutes: number, strategy: CalendarSnapStrategy): Date {
  return strategy === "none" ? new Date(value.getTime()) : snapDate(value, slotMinutes, strategy);
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
