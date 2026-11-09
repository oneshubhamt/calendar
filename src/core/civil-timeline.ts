import type { CalendarOverlapDisambiguation } from "./types.js";
import { addPlainMinutes, instantToPlain, possibleInstantsForPlain, type PlainDateTimeParts } from "./temporal.js";

const DAY_MS = 86_400_000;

export type CivilMinuteKind = "normal" | "gap" | "overlap";

export interface CivilMinuteResolution {
  readonly kind: CivilMinuteKind;
  readonly instants: readonly number[];
}

/** Resolve an explicit local civil date-time into zero, one or two real instants. */
export function civilDateTimeResolution(parts: PlainDateTimeParts, timeZone: string): CivilMinuteResolution {
  const instants = possibleInstantsForPlain(parts, timeZone);
  if (instants.length === 0) return { kind: "gap", instants };
  if (instants.length > 1) return { kind: "overlap", instants };
  return { kind: "normal", instants };
}

/** Resolve an explicit local civil date-time with deliberate DST gap/overlap semantics. */
export function instantAtCivilDateTime(
  parts: PlainDateTimeParts,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): Date | null {
  const resolution = civilDateTimeResolution(parts, timeZone);
  if (resolution.kind === "gap") return null;
  const instant = resolution.kind === "overlap" && overlap === "later"
    ? resolution.instants[resolution.instants.length - 1]!
    : resolution.instants[0]!;
  return new Date(instant);
}

function dayOrigin(day: Date, timeZone: string): PlainDateTimeParts {
  const parts = instantToPlain(day.getTime(), timeZone);
  return { ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

/** Wall-clock minute coordinate relative to the supplied local civil day. */
export function civilMinuteOfInstant(instant: Date | number, day: Date, timeZone: string): number {
  const epoch = typeof instant === "number" ? instant : instant.getTime();
  if (!Number.isFinite(epoch)) throw new RangeError("Civil timeline instant must be finite");
  const origin = dayOrigin(day, timeZone);
  const value = instantToPlain(epoch, timeZone);
  const originDay = Date.UTC(origin.year, origin.month - 1, origin.day);
  const valueDay = Date.UTC(value.year, value.month - 1, value.day);
  return ((valueDay - originDay) / DAY_MS) * 1440
    + value.hour * 60 + value.minute + value.second / 60 + value.millisecond / 60_000;
}

/** Resolve a primary-zone wall-clock coordinate into zero, one or two real instants. */
export function civilMinuteResolution(day: Date, minuteOfDay: number, timeZone: string): CivilMinuteResolution {
  if (!Number.isFinite(minuteOfDay)) throw new RangeError("Civil timeline minute must be finite");
  const plain = addPlainMinutes(dayOrigin(day, timeZone), minuteOfDay);
  return civilDateTimeResolution(plain, timeZone);
}

/**
 * Map a visible wall-clock coordinate to an instant. Spring-forward gaps are deliberately non-targetable;
 * fall-back overlaps use an explicit earlier/later policy rather than Temporal's implicit compatible rule.
 */
export function instantAtCivilMinute(
  day: Date,
  minuteOfDay: number,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): Date | null {
  const plain = addPlainMinutes(dayOrigin(day, timeZone), minuteOfDay);
  return instantAtCivilDateTime(plain, timeZone, overlap);
}

/** Move an instant by civil wall-clock minutes, preserving explicit DST gap/overlap semantics. */
export function shiftCivilMinutes(
  value: Date,
  minutes: number,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): Date | null {
  if (!Number.isFinite(minutes)) throw new RangeError("Civil timeline delta must be finite");
  const coordinate = civilMinuteOfInstant(value, value, timeZone);
  return instantAtCivilMinute(value, coordinate + minutes, timeZone, overlap);
}
