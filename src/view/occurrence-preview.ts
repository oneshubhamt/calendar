import type { CalendarItemPatch, CalendarOccurrence, CalendarOccurrenceCommand } from "../core/types.js";
import { toDate } from "../core/time.js";

export interface PendingOccurrencePreview {
  readonly patch: CalendarItemPatch;
}

/** Temporal projection of an in-flight host command. The authoritative occurrence remains untouched. */
export function previewPatchForCommand(command: CalendarOccurrenceCommand): CalendarItemPatch | undefined {
  if (command.type === "move-occurrence" || command.type === "resize-occurrence") {
    return { start: command.start, end: command.end };
  }
  if (command.type !== "update-occurrence") return undefined;
  const patch = command.patch;
  return patch.start === undefined
    && patch.end === undefined
    && patch.allDay === undefined
    && patch.precision === undefined
    && patch.temporal === undefined
    && patch.temporalForm === undefined
    ? undefined
    : patch;
}

/** Overlay tentative host geometry for rendering only; never writes Calendar or host persistence. */
export function occurrenceWithPreview(
  occurrence: CalendarOccurrence,
  preview: PendingOccurrencePreview | undefined,
  timeZone: string,
): CalendarOccurrence {
  if (!preview) return occurrence;
  const patch = preview.patch;
  const start = patch.start !== undefined ? toDate(patch.start, timeZone).toISOString() : occurrence.start;
  const end = patch.end !== undefined ? toDate(patch.end, timeZone).toISOString() : occurrence.end;
  return {
    ...occurrence,
    start,
    end,
    ...(patch.calendarId !== undefined ? { calendarId: patch.calendarId } : {}),
    ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
    ...(patch.precision !== undefined ? { precision: patch.precision } : {}),
    ...(patch.temporal !== undefined && patch.temporal !== null ? { temporal: patch.temporal } : {}),
    ...(patch.temporalForm !== undefined ? { temporalForm: patch.temporalForm } : {}),
  };
}
