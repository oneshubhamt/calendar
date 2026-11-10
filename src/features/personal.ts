import type {
  CalendarItem, CalendarItemKind, CalendarItemPatch, CalendarOccurrence,
  CalendarSource, ISODate, ISODateTime, RecurrenceRule,
  CalendarMetadata, CalendarOwnership, EditPolicy,
} from "../core/types.js";
import { addDays, addMinutes, dateKey, hasExplicitOffset, startOfDay, toDate } from "../core/time.js";
import {
  addPlainMinutes,
  formatPlainDateTime,
  instantToPlain,
  parsePlainDateTime,
  plainMinutesBetween,
  plainToInstant,
} from "../core/temporal.js";
export interface CalendarRoutineBlock {
  readonly title: string;
  readonly offsetMinutes: number;
  readonly durationMinutes: number;
  readonly kind?: CalendarItemKind;
  readonly category?: string;
  readonly metadata?: CalendarMetadata;
}

export interface CalendarRoutineTemplate {
  readonly id: string;
  readonly title: string;
  readonly calendarId: string;
  readonly blocks: readonly CalendarRoutineBlock[];
  readonly repeat?: Pick<RecurrenceRule, "frequency" | "interval" | "byDay" | "weekStartsOn">;
  readonly ownership?: CalendarOwnership;
  readonly editPolicy?: EditPolicy;
  readonly metadata?: CalendarMetadata;
}

export interface CalendarPersonalFilter {
  readonly text?: string;
  readonly calendarIds?: ReadonlySet<string>;
  readonly kinds?: ReadonlySet<CalendarItemKind>;
  readonly categories?: ReadonlySet<string>;
  readonly ownership?: ReadonlySet<string>;
  readonly predicate?: (item: CalendarItem | CalendarOccurrence, source?: CalendarSource) => boolean;
}

export interface CalendarQuickCreateResult {
  readonly title: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay: boolean;
  readonly kind: CalendarItemKind;
  readonly category?: string;
}

export interface CalendarQuickCreateOptions {
  readonly defaultKind?: CalendarItemKind;
  readonly kindKeywords?: Readonly<Record<string, CalendarItemKind>>;
}

export interface CalendarPersonalFeaturePort {
  matchesFilter(item: CalendarItem | CalendarOccurrence, filter: CalendarPersonalFilter | undefined, source?: CalendarSource): boolean;
  parseQuickCreate(text: string, now: Date, timeZone: string, options?: CalendarQuickCreateOptions): CalendarQuickCreateResult;
  moveItemToDatePatch(item: CalendarItem | CalendarOccurrence, date: ISODate, timeZone: string): CalendarItemPatch;
  instantiateRoutine(template: CalendarRoutineTemplate, date: ISODate, timeZone: string, now?: ISODateTime): readonly CalendarItem[];
  createCalendarSource(id: string, title: string, category?: string): CalendarSource;
}


export type CalendarFilter = CalendarPersonalFilter;

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function metadataSearchValues(value: unknown, out: string[] = []): string[] {
  if (value === undefined || value === null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") { out.push(String(value)); return out; }
  if (Array.isArray(value)) { for (const entry of value) metadataSearchValues(entry, out); return out; }
  if (typeof value === "object") for (const entry of Object.values(value as Record<string, unknown>)) metadataSearchValues(entry, out);
  return out;
}

export function searchableText(item: CalendarItem | CalendarOccurrence, source?: CalendarSource): string {
  const metadata = item.metadata ? metadataSearchValues(item.metadata) : [];
  const sourceMetadata = source?.metadata ? metadataSearchValues(source.metadata) : [];
  return [item.title, item.description, item.location, source?.title, ...metadata, ...sourceMetadata]
    .map(normalized).filter(Boolean).join(" \u241f ");
}

export function matchesCalendarFilter(
  item: CalendarItem | CalendarOccurrence,
  filter: CalendarFilter | undefined,
  source?: CalendarSource,
): boolean {
  if (!filter) return true;
  if (filter.calendarIds?.size && !filter.calendarIds.has(item.calendarId)) return false;
  if (filter.kinds?.size && !filter.kinds.has(item.kind)) return false;
  if (filter.ownership?.size && !filter.ownership.has(item.ownership)) return false;
  if (filter.categories?.size) {
    const category = normalized(item.metadata?.category ?? source?.metadata?.category);
    if (!category || ![...filter.categories].some(value => normalized(value) === category)) return false;
  }
  const query = normalized(filter.text);
  if (query) {
    const haystack = searchableText(item, source);
    const tokens = query.split(/\s+/u).filter(Boolean);
    if (!tokens.every(token => haystack.includes(token))) return false;
  }
  return filter.predicate?.(item, source) ?? true;
}

function temporalKind(item: CalendarItem | CalendarOccurrence): "instant" | "zoned" | "floating" | "date" {
  return item.temporal?.kind ?? (item.allDay || item.precision === "date" ? "date" : hasExplicitOffset(item.start) ? "instant" : "floating");
}

function plainForSource(value: ISODateTime, item: CalendarItem | CalendarOccurrence, viewerTimeZone: string) {
  const kind = temporalKind(item);
  if (kind === "date") return instantToPlain(toDate(value, viewerTimeZone).getTime(), viewerTimeZone);
  if ((kind === "zoned" || kind === "floating") && !hasExplicitOffset(value)) return parsePlainDateTime(value);
  const zone = kind === "zoned" ? item.temporal?.timeZone ?? viewerTimeZone : viewerTimeZone;
  return instantToPlain(toDate(value).getTime(), zone);
}

function sourceDateTime(parts: ReturnType<typeof parsePlainDateTime>, item: CalendarItem | CalendarOccurrence, viewerTimeZone: string): ISODateTime {
  const kind = temporalKind(item);
  if (kind === "zoned" || kind === "floating") return formatPlainDateTime(parts);
  return new Date(plainToInstant(parts, viewerTimeZone, item.temporal?.disambiguation ?? "compatible")).toISOString();
}

export function moveItemToDatePatch(item: CalendarItem | CalendarOccurrence, date: ISODate, timeZone: string): CalendarItemPatch {
  const kind = temporalKind(item);
  if (kind === "date") {
    const a = toDate(item.start, timeZone);
    const b = toDate(item.end, timeZone);
    const dayCount = Math.max(1, Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86_400_000));
    const target = toDate(date, timeZone);
    return { start: dateKey(target, timeZone), end: dateKey(addDays(target, dayCount, timeZone), timeZone), allDay: true, precision: "date", temporal: { kind: "date" } };
  }

  const startPlain = plainForSource(item.start, item, timeZone);
  const endPlain = plainForSource(item.end, item, timeZone);
  const [year, month, day] = date.split("-").map(Number);
  const targetStart = { ...startPlain, year: year!, month: month!, day: day! };
  const wallMinutes = Math.max(1, plainMinutesBetween(startPlain, endPlain));
  const targetEnd = addPlainMinutes(targetStart, wallMinutes);
  return {
    start: sourceDateTime(targetStart, item, timeZone),
    end: sourceDateTime(targetEnd, item, timeZone),
    temporal: item.temporal ?? { kind },
  };
}

export interface CopyItemOptions {
  readonly calendarId?: string;
  readonly ownership?: CalendarOwnership;
  readonly editPolicy?: EditPolicy;
  readonly kind?: CalendarItemKind;
  readonly metadata?: CalendarMetadata;
}

export function copyItemToDate(
  item: CalendarItem | CalendarOccurrence,
  date: ISODate,
  timeZone: string,
  id: string,
  now = new Date().toISOString(),
  options: CopyItemOptions = {},
): CalendarItem {
  const patch = moveItemToDatePatch(item, date, timeZone);
  const allDay = patch.allDay ?? item.allDay;
  const temporal = patch.temporal === null ? undefined : patch.temporal ?? item.temporal;
  return {
    id,
    calendarId: options.calendarId ?? item.calendarId,
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    ...(item.location ? { location: item.location } : {}),
    start: patch.start ?? item.start,
    end: patch.end ?? item.end,
    ...(allDay !== undefined ? { allDay } : {}),
    ...(patch.precision ?? item.precision ? { precision: patch.precision ?? item.precision } : {}),
    ...(temporal ? { temporal } : {}),
    kind: options.kind ?? item.kind,
    ownership: options.ownership ?? item.ownership,
    editPolicy: options.editPolicy ?? item.editPolicy,
    ...(item.reminders ? { reminders: item.reminders } : {}),
    ...(item.display ? { display: item.display } : {}),
    ...(options.metadata ?? item.metadata ? { metadata: options.metadata ?? item.metadata } : {}),
    createdAt: now,
    updatedAt: now,
  };
}


export type QuickCreateResult = CalendarQuickCreateResult;

const DAY_WORDS: Readonly<Record<string, number>> = Object.freeze({ sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6 });

function nextWeekday(base: Date, weekday: number, timeZone: string): Date {
  const plain = instantToPlain(base.getTime(), timeZone);
  const current = new Date(Date.UTC(plain.year, plain.month - 1, plain.day)).getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(base, delta, timeZone);
}

export type QuickCreateOptions = CalendarQuickCreateOptions;

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Deterministic lightweight quick-create grammar. Calendar core assigns no semantic keyword meanings by default. */
export function parseQuickCreate(text: string, now: Date, timeZone: string, options: QuickCreateOptions = {}): QuickCreateResult {
  let source = text.trim();
  if (!source) throw new Error("Enter an event title.");
  let day = startOfDay(now, timeZone);
  let matchedDay = false;
  if (/\btomorrow\b/i.test(source)) { day = addDays(day, 1, timeZone); source = source.replace(/\btomorrow\b/i, " "); matchedDay = true; }
  else if (/\btoday\b/i.test(source)) { source = source.replace(/\btoday\b/i, " "); matchedDay = true; }
  else {
    for (const [word, weekday] of Object.entries(DAY_WORDS)) {
      const re = new RegExp(`\\b${word}\\b`, "i");
      if (re.test(source)) { day = nextWeekday(day, weekday, timeZone); source = source.replace(re, " "); matchedDay = true; break; }
    }
  }
  const durationMatch = /\b(?:for\s*)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i.exec(source);
  let durationMinutes = 60;
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    durationMinutes = Math.max(5, Math.round(value * (/^h/i.test(durationMatch[2]!) ? 60 : 1)));
    source = source.replace(durationMatch[0], " ");
  }
  const timeMatch = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(source);
  let allDay = !timeMatch && matchedDay;
  let start = day;
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] ?? 0);
    const ampm = normalized(timeMatch[3]);
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new Error("Quick-create time is invalid.");
    const p = instantToPlain(day.getTime(), timeZone);
    start = new Date(plainToInstant({ ...p, hour, minute, second: 0, millisecond: 0 }, timeZone, "compatible"));
    source = source.replace(timeMatch[0], " ");
    allDay = false;
  } else if (!allDay) {
    start = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * (15 * 60_000));
  }
  let kind: CalendarItemKind = options.defaultKind ?? "event";
  for (const [token, mappedKind] of Object.entries(options.kindKeywords ?? {})) {
    const match = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").exec(source);
    if (!match) continue;
    kind = mappedKind; source = source.replace(match[0], " "); break;
  }
  const categoryMatch = /#([\p{L}\p{N}_-]+)/u.exec(source);
  const category = categoryMatch?.[1];
  if (categoryMatch) source = source.replace(categoryMatch[0], " ");
  const title = source.replace(/\s+/gu, " ").replace(/^[-–—:,\s]+|[-–—:,\s]+$/gu, "").trim();
  if (!title) throw new Error("Quick-create needs a title.");
  if (allDay) {
    const date = dateKey(start, timeZone);
    return { title, start: date, end: dateKey(addDays(start, 1, timeZone), timeZone), allDay: true, kind, ...(category ? { category } : {}) };
  }
  return { title, start: start.toISOString(), end: addMinutes(start, durationMinutes).toISOString(), allDay: false, kind, ...(category ? { category } : {}) };
}

export function instantiateRoutine(template: CalendarRoutineTemplate, date: ISODate, timeZone: string, now = new Date().toISOString()): readonly CalendarItem[] {
  const base = startOfDay(toDate(date, timeZone), timeZone);
  return template.blocks.map((block, index) => {
    if (!Number.isFinite(block.offsetMinutes) || !Number.isFinite(block.durationMinutes) || block.durationMinutes <= 0) throw new RangeError("Routine block timing is invalid.");
    const start = addMinutes(base, block.offsetMinutes);
    const end = addMinutes(start, block.durationMinutes);
    const id = `routine:${template.id}:${date}:${index}:${Math.abs(block.offsetMinutes)}`;
    return {
      id, calendarId: template.calendarId, title: block.title, start: start.toISOString(), end: end.toISOString(),
      kind: block.kind ?? "event", ownership: template.ownership ?? "calendar", editPolicy: template.editPolicy ?? "full",
      ...(template.repeat ? { seriesId: id, recurrence: { rule: { ...template.repeat } as RecurrenceRule } } : {}),
      metadata: { ...(template.metadata ?? {}), ...(block.metadata ?? {}), ...(block.category ? { category: block.category } : {}), templateId: template.id, routineId: template.id },
      createdAt: now, updatedAt: now,
    } as CalendarItem;
  });
}

export function personalCalendarSource(id: string, title: string, category?: string): CalendarSource {
  if (!id.trim() || !title.trim()) throw new Error("Calendar id and title are required.");
  return { id: id.trim(), title: title.trim(), visible: true, sourceType: "personal", removable: true, ...(category?.trim() ? { metadata: { category: category.trim() } } : {}) };
}


/** Ready-to-inject implementation for hosts that want the optional personal-calendar conveniences. */
export const PERSONAL_CALENDAR_FEATURE: CalendarPersonalFeaturePort = Object.freeze({
  matchesFilter: matchesCalendarFilter,
  parseQuickCreate,
  moveItemToDatePatch,
  instantiateRoutine,
  createCalendarSource: personalCalendarSource,
});
