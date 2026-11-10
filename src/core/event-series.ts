import type {
  CalendarItem,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarRange,
  CalendarRecurrence,
  CalendarTemporalKind,
  ISODateTime,
  RecurrenceException,
} from "./types.js";
import {
  expandTemporalSeries,
  resolveTemporalSeriesAnchor,
  temporalSeriesIdentityAtOrdinal,
  temporalSeriesOrdinal,
  type CalendarResolvedTemporalRange,
  type RecurrenceExpansionOptions,
} from "./recurrence.js";
import { hasExplicitOffset, resolvedTimeZone, toDate } from "./time.js";
import {
  addPlainMinutes,
  formatPlainDate,
  formatPlainDateTime,
  instantToPlain,
  parsePlainDate,
  parsePlainDateTime,
  plainMinutesBetween,
  plainToInstant,
  type PlainDateTimeParts,
} from "./temporal.js";

/** Structural equality for Calendar event recurrence definitions used by command and editor paths. */
export function sameRecurrence(a: CalendarRecurrence | undefined, b: CalendarRecurrence | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function occurrenceIdentityAtOrdinal(
  item: CalendarItem,
  ordinal: number,
  options: RecurrenceExpansionOptions = {},
): string {
  return temporalSeriesIdentityAtOrdinal(item, item.recurrence?.rule, ordinal, options);
}

export function recurrenceOrdinal(
  item: CalendarItem,
  originalStart: ISODateTime | Date,
  options: RecurrenceExpansionOptions = {},
): number {
  return temporalSeriesOrdinal(item, item.recurrence?.rule, originalStart, options);
}

export function occurrenceFromItem(item: CalendarItem, options: RecurrenceExpansionOptions = {}): CalendarOccurrence {
  return occurrenceFromResolved(item, resolveTemporalSeriesAnchor(item, options), undefined);
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

function displayZoneFor(item: CalendarItem, options: RecurrenceExpansionOptions): string {
  const viewer = resolvedTimeZone(options.timeZone);
  return item.temporal?.kind === "zoned" ? item.temporal.timeZone ?? viewer : viewer;
}

function displayPlain(value: ISODateTime, zone: string): PlainDateTimeParts {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parsePlainDate(value);
  return hasExplicitOffset(value) ? instantToPlain(toDate(value).getTime(), zone) : parsePlainDateTime(value);
}

function targetTemporalKind(item: CalendarItem, patch: CalendarItemPatch): CalendarTemporalKind {
  if (patch.temporal && patch.temporal !== null) return patch.temporal.kind;
  if (patch.temporal === null) {
    const value = patch.start ?? item.start;
    if (patch.allDay || patch.precision === "date" || /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    return hasExplicitOffset(value) ? "instant" : "floating";
  }
  return item.temporal?.kind ?? (item.allDay || item.precision === "date" ? "date" : hasExplicitOffset(item.start) ? "instant" : "floating");
}

function serializeProjectedPlain(
  plain: PlainDateTimeParts,
  kind: CalendarTemporalKind,
  targetZone: string,
  disambiguation: "compatible" | "earlier" | "later" | "reject",
): ISODateTime {
  if (kind === "date") return formatPlainDate(plain);
  if (kind === "floating" || kind === "zoned") return formatPlainDateTime(plain);
  return new Date(plainToInstant(plain, targetZone, disambiguation)).toISOString();
}

/** Project an edited Calendar occurrence back into its source event series anchor. */
export function projectOccurrencePatchToSeries(
  item: CalendarItem,
  occurrence: CalendarOccurrence,
  patch: CalendarItemPatch,
  options: RecurrenceExpansionOptions = {},
): CalendarItemPatch {
  const viewerZone = resolvedTimeZone(options.timeZone);
  const sourceDisplayZone = displayZoneFor(item, options);
  const targetKind = targetTemporalKind(item, patch);
  const targetZone = targetKind === "zoned"
    ? patch.temporal && patch.temporal !== null && patch.temporal.kind === "zoned"
      ? patch.temporal.timeZone ?? sourceDisplayZone
      : item.temporal?.timeZone ?? sourceDisplayZone
    : viewerZone;
  const patchInputZone = item.temporal?.kind === "zoned" ? sourceDisplayZone : targetZone;
  const disambiguation = patch.temporal && patch.temporal !== null
    ? patch.temporal.disambiguation ?? item.temporal?.disambiguation ?? "compatible"
    : item.temporal?.disambiguation ?? "compatible";

  const anchorStartPlain = displayPlain(item.start, sourceDisplayZone);
  const anchorEndPlain = displayPlain(item.end, sourceDisplayZone);
  const occurrenceStartPlain = instantToPlain(toDate(occurrence.start).getTime(), sourceDisplayZone);
  const occurrenceEndPlain = instantToPlain(toDate(occurrence.end).getTime(), sourceDisplayZone);

  let startPlain = anchorStartPlain;
  let endPlain = anchorEndPlain;
  if (patch.start !== undefined) {
    const desiredStartPlain = displayPlain(patch.start, patchInputZone);
    const delta = plainMinutesBetween(occurrenceStartPlain, desiredStartPlain);
    startPlain = addPlainMinutes(anchorStartPlain, delta);
    if (patch.end === undefined) endPlain = addPlainMinutes(anchorEndPlain, delta);
  }
  if (patch.end !== undefined) {
    const desiredEndPlain = displayPlain(patch.end, patchInputZone);
    const delta = plainMinutesBetween(occurrenceEndPlain, desiredEndPlain);
    endPlain = addPlainMinutes(anchorEndPlain, delta);
  }

  return {
    ...patch,
    ...(patch.start !== undefined ? { start: serializeProjectedPlain(startPlain, targetKind, targetZone, disambiguation) } : {}),
    ...(patch.end !== undefined || patch.start !== undefined ? { end: serializeProjectedPlain(endPlain, targetKind, targetZone, disambiguation) } : {}),
  };
}

/** Preserve Calendar event exception meaning when a whole event series is edited. */
export function rebaseRecurrenceExceptions(
  previous: CalendarItem,
  next: CalendarItem,
  options: RecurrenceExpansionOptions = {},
): CalendarRecurrence | undefined {
  if (!next.recurrence) return undefined;
  if (!previous.recurrence?.exceptions?.length) return next.recurrence;
  const rebased: RecurrenceException[] = [];
  for (const exception of previous.recurrence.exceptions) {
    try {
      const ordinal = temporalSeriesOrdinal(previous, previous.recurrence.rule, exception.originalStart, options);
      const originalStart = temporalSeriesIdentityAtOrdinal(next, next.recurrence.rule, ordinal, options);
      rebased.push({ ...exception, originalStart });
    } catch {
      // The edited rule no longer has a corresponding occurrence; dropping the orphan is safer than misapplying it.
    }
  }
  return { ...next.recurrence, ...(rebased.length ? { exceptions: rebased } : { exceptions: undefined }) };
}
