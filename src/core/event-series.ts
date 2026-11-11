import type {
  CalendarItem,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarRange,
} from "./types.js";
import {
  expandTemporalSeries,
  resolveTemporalSeriesAnchor,
  type CalendarResolvedTemporalRange,
  type RecurrenceExpansionOptions,
} from "./recurrence.js";
import { toDate } from "./time.js";

/**
 * Calendar-event adapter over the generic temporal recurrence engine.
 * It contains no recurrence generation, recurrence identity or temporal edit-projection logic.
 */
export function occurrenceFromItem(item: CalendarItem, options: RecurrenceExpansionOptions = {}): CalendarOccurrence {
  return occurrenceFromResolved(item, resolveTemporalSeriesAnchor(item, item.recurrence?.rule, options), undefined);
}

export function expandItem(
  item: CalendarItem,
  range: CalendarRange,
  options: RecurrenceExpansionOptions = {},
): CalendarOccurrence[] {
  return expandTemporalSeries<CalendarItemPatch>(item, item.recurrence, range, options)
    .map(resolved => occurrenceFromResolved(item, resolved, resolved.exception?.replacement));
}

export function expandItems(
  items: readonly CalendarItem[],
  range: CalendarRange,
  options: RecurrenceExpansionOptions = {},
): CalendarOccurrence[] {
  return items.flatMap(item => expandItem(item, range, options)).sort((a, b) =>
    toDate(a.start).getTime() - toDate(b.start).getTime()
    || toDate(a.end).getTime() - toDate(b.end).getTime()
    || a.title.localeCompare(b.title),
  );
}

function occurrenceFromResolved(
  item: CalendarItem,
  resolved: Pick<CalendarResolvedTemporalRange, "originalStart" | "start" | "end" | "recurring">,
  patch: CalendarItemPatch | undefined,
): CalendarOccurrence {
  const metadata = patch?.metadata === null ? undefined : patch?.metadata ?? item.metadata;
  const display = patch?.display === null ? undefined : patch?.display ?? item.display;
  const description = patch?.description === null ? undefined : patch?.description ?? item.description;
  const location = patch?.location === null ? undefined : patch?.location ?? item.location;
  const temporal = patch?.temporal === null ? undefined : patch?.temporal ?? item.temporal;
  const reminders = patch?.reminders === null ? undefined : patch?.reminders ?? item.reminders;
  const occurrenceId = item.recurrence
    ? `series:${item.seriesId ?? item.id}@${resolved.originalStart}`
    : `item:${item.id}`;

  return {
    calendarId: patch?.calendarId ?? item.calendarId,
    title: patch?.title ?? item.title,
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    start: resolved.start,
    end: resolved.end,
    allDay: patch?.allDay ?? item.allDay,
    precision: patch?.precision ?? item.precision,
    ...(temporal !== undefined ? { temporal } : {}),
    ...((patch?.temporalForm ?? item.temporalForm) !== undefined ? { temporalForm: patch?.temporalForm ?? item.temporalForm } : {}),
    kind: patch?.kind ?? item.kind,
    ownership: item.ownership,
    editPolicy: patch?.editPolicy ?? item.editPolicy,
    ...(item.seriesId !== undefined ? { seriesId: item.seriesId } : {}),
    ...(reminders !== undefined ? { reminders } : {}),
    ...(display !== undefined ? { display } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    occurrenceId,
    sourceItemId: item.id,
    originalStart: resolved.originalStart,
    recurring: resolved.recurring,
  };
}
