import type { CalendarOccurrence } from "../core/types.js";

export function isPointOccurrence(occurrence: CalendarOccurrence): boolean {
  return occurrence.temporalForm === "point";
}

export function isDateLikeOccurrence(occurrence: CalendarOccurrence): boolean {
  return Boolean(
    occurrence.allDay
    || occurrence.precision === "date"
    || occurrence.temporal?.kind === "date"
  );
}
