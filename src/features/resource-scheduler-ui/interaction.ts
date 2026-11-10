import type {
  CalendarOccurrence,
  CalendarOverlapDisambiguation,
} from "../../core/types.js";
import { shiftCivilMinutes } from "../../core/civil-timeline.js";
import { resizeInterval, type CalendarResizeEdge } from "../../core/interaction.js";

export interface CalendarResourceInteractionTimes {
  readonly start: string;
  readonly end: string;
}

function instant(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

export function snapResourceInteractionMinutes(rawMinutes: number, snapMinutes: number): number {
  if (!Number.isFinite(rawMinutes)) throw new RangeError("Interaction delta must be finite");
  if (!Number.isFinite(snapMinutes) || snapMinutes <= 0) throw new RangeError("Interaction snap minutes must be positive and finite");
  return Math.round(rawMinutes / snapMinutes) * snapMinutes;
}

/** Move an occurrence by civil wall-clock minutes. DST gaps are non-targetable. */
export function moveResourceOccurrenceByCivilMinutes(
  occurrence: CalendarOccurrence,
  deltaMinutes: number,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): CalendarResourceInteractionTimes | null {
  const start = instant(occurrence.start, "Occurrence start");
  const end = instant(occurrence.end, "Occurrence end");
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
export function resizeResourceOccurrenceByCivilMinutes(
  occurrence: CalendarOccurrence,
  edge: CalendarResizeEdge,
  deltaMinutes: number,
  minimumMinutes: number,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): CalendarResourceInteractionTimes | null {
  if (occurrence.temporalForm === "point") return null;
  const start = instant(occurrence.start, "Occurrence start");
  const end = instant(occurrence.end, "Occurrence end");
  const base = edge === "start" ? start : end;
  const target = shiftCivilMinutes(base, deltaMinutes, timeZone, overlap);
  if (!target) return null;
  const resized = resizeInterval(start, end, target, edge, minimumMinutes);
  return { start: resized.start.toISOString(), end: resized.end.toISOString() };
}
