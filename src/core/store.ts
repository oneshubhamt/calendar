import type { CalendarBackgroundRange, CalendarEventFields, CalendarItem, CalendarItemId, CalendarItemPatch, CalendarOccurrence, CalendarRepository, CalendarSnapshot, CalendarSource, CalendarSourcePatch } from "./types.js";
import { occurrenceFromItem, validateRecurrenceRule } from "./recurrence.js";
import { parsePlainDate } from "./temporal.js";
import { hasExplicitOffset } from "./time.js";

const EDIT_POLICIES = new Set(["full", "schedule-only", "readonly", "generated"]);
const TEMPORAL_KINDS = new Set(["instant", "zoned", "floating", "date"]);
const TEMPORAL_FORMS = new Set(["interval", "point"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

const METADATA_MAX_DEPTH = 16;
const METADATA_MAX_NODES = 20_000;
const METADATA_MAX_STRING_LENGTH = 262_144;
const METADATA_MAX_KEY_LENGTH = 512;

/** Runtime counterpart of CalendarMetadata: bounded, acyclic JSON-like data. */
function assertJsonLike(value: unknown, label: string, requireObject: boolean, allowUndefinedProperties: boolean): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number, path: string, allowUndefined: boolean): void => {
    nodes += 1;
    if (nodes > METADATA_MAX_NODES) throw new Error(`${label} exceeds the metadata size limit`);
    if (depth > METADATA_MAX_DEPTH) throw new Error(`${label} exceeds the metadata depth limit`);
    if (current === undefined) {
      if (allowUndefined) return;
      throw new Error(`${path} contains undefined`);
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${path} contains a non-finite number`);
      return;
    }
    if (typeof current === "string") {
      if (current.length > METADATA_MAX_STRING_LENGTH) throw new Error(`${path} contains an oversized string`);
      return;
    }
    if (typeof current !== "object") throw new Error(`${path} is not JSON-like data`);
    if (seen.has(current)) throw new Error(`${label} contains a cycle`);
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) visit(current[index], depth + 1, `${path}[${index}]`, false);
      seen.delete(current);
      return;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (key.length > METADATA_MAX_KEY_LENGTH) throw new Error(`${path} contains an oversized key`);
      visit(entry, depth + 1, `${path}.${key}`, allowUndefinedProperties);
    }
    seen.delete(current);
  };
  if (requireObject && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${label} must be an object`);
  visit(value, 0, label, false);
}

function assertMetadata(value: unknown, label: string): void {
  assertJsonLike(value, label, true, true);
}

function assertSourceIntegrity(source: CalendarSource): void {
  const raw = record(source, "Calendar source");
  requiredText(raw.id, "Calendar source id");
  requiredText(raw.title, `Calendar source ${String(raw.id)} title`);
  if (typeof raw.visible !== "boolean") throw new Error(`Calendar source ${String(raw.id)} visibility is invalid`);
  if (raw.sourceType !== undefined && (typeof raw.sourceType !== "string" || !raw.sourceType.trim() || raw.sourceType.length > 120)) throw new Error(`Calendar source ${String(raw.id)} type is invalid`);
  if (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean") throw new Error(`Calendar source ${String(raw.id)} readOnly flag is invalid`);
  if (raw.allowCreate !== undefined && typeof raw.allowCreate !== "boolean") throw new Error(`Calendar source ${String(raw.id)} allowCreate flag is invalid`);
  if (raw.removable !== undefined && typeof raw.removable !== "boolean") throw new Error(`Calendar source ${String(raw.id)} removable flag is invalid`);
  if (raw.metadata !== undefined) assertMetadata(raw.metadata, `Calendar source ${String(raw.id)} metadata`);
}

function assertItemIntegrity(item: CalendarItem): void {
  const raw = record(item, "Calendar item");
  const id = requiredText(raw.id, "Calendar item id");
  const label = `Calendar item ${id}`;
  assertEventFieldsIntegrity(item, raw, label);
  const point = item.temporalForm === "point";
  if (item.temporal?.kind === "date" || item.allDay || item.precision === "date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(item.start) && /^\d{4}-\d{2}-\d{2}$/.test(item.end)) {
      const start = parsePlainDate(item.start);
      const end = parsePlainDate(item.end);
      const startDay = Date.UTC(start.year, start.month - 1, start.day);
      const endDay = Date.UTC(end.year, end.month - 1, end.day);
      if (endDay <= startDay) throw new Error(`${label} must end after it starts`);
    } else {
      const startMs = Date.parse(item.start), endMs = Date.parse(item.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error(`${label} must end after it starts`);
    }
  } else {
    occurrenceFromItem(item, { timeZone: item.temporal?.timeZone ?? "UTC" });
  }
  if (point && item.temporal?.kind === "date") throw new Error(`${label} point temporal form cannot be date-only or all-day`);
  if (item.recurrence) {
    validateRecurrenceRule(item.recurrence.rule);
    const exceptionIds = new Set<string>();
    for (const exception of item.recurrence.exceptions ?? []) {
      requiredText(exception.originalStart, `${label} recurrence exception originalStart`);
      if (exceptionIds.has(exception.originalStart)) throw new Error(`${label} has duplicate recurrence exception ${exception.originalStart}`);
      exceptionIds.add(exception.originalStart);
      if (exception.cancelled && exception.replacement) throw new Error(`${label} recurrence exception cannot be cancelled and replaced`);
      if (exception.replacement) {
        const replacement = { ...applyCalendarItemPatch(item, exception.replacement), recurrence: undefined } as CalendarItem;
        assertItemIntegrity(replacement);
      }
    }
  }
}

export function assertCalendarStateIntegrity(sources: readonly CalendarSource[], items: readonly CalendarItem[]): void {
  if (!Array.isArray(sources) || !Array.isArray(items)) throw new Error("Calendar state collections are invalid");
  const sourceIds = new Set<string>();
  for (const source of sources) {
    assertSourceIntegrity(source);
    if (sourceIds.has(source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
    sourceIds.add(source.id);
  }
  const itemIds = new Set<string>();
  for (const item of items) {
    assertItemIntegrity(item);
    if (itemIds.has(item.id)) throw new Error(`Duplicate calendar item: ${item.id}`);
    itemIds.add(item.id);
    if (!sourceIds.has(item.calendarId)) throw new Error(`Unknown calendar source: ${item.calendarId}`);
  }
}


/** Validate the event payload shared by items and resolved occurrences. */
function assertEventFieldsIntegrity(value: CalendarEventFields, raw: Record<string, unknown>, label: string): void {
  requiredText(raw.calendarId, `${label} calendar id`);
  requiredText(raw.title, `${label} title`);
  requiredText(raw.start, `${label} start`);
  requiredText(raw.end, `${label} end`);
  const kind = requiredText(raw.kind, `${label} kind`);
  const ownership = requiredText(raw.ownership, `${label} ownership`);
  if (kind.length > 120) throw new Error(`${label} kind is too long`);
  if (ownership.length > 120) throw new Error(`${label} ownership is too long`);
  if (!EDIT_POLICIES.has(String(raw.editPolicy))) throw new Error(`${label} edit policy is invalid`);
  if (raw.metadata !== undefined) assertMetadata(raw.metadata, `${label} metadata`);
  if (raw.temporalForm !== undefined && !TEMPORAL_FORMS.has(String(raw.temporalForm))) throw new Error(`${label} temporal form is invalid`);
  if (value.temporal) {
    if (!TEMPORAL_KINDS.has(value.temporal.kind)) throw new Error(`${label} temporal kind is invalid`);
    if (value.temporal.kind === "zoned" && !value.temporal.timeZone) throw new Error(`${label} zoned time requires a time zone`);
  }
  if (value.temporalForm === "point" && (value.temporal?.kind === "date" || value.allDay || value.precision === "date")) {
    throw new Error(`${label} point temporal form cannot be date-only or all-day`);
  }
  const reminderIds = new Set<string>();
  for (const reminder of value.reminders ?? []) {
    requiredText(reminder.id, `${label} reminder id`);
    if (reminderIds.has(reminder.id)) throw new Error(`${label} has duplicate reminder ${reminder.id}`);
    reminderIds.add(reminder.id);
    if (!Number.isFinite(reminder.minutesBefore) || reminder.minutesBefore < 0) throw new Error(`${label} reminder offset is invalid`);
    if (typeof reminder.channel !== "string" || !reminder.channel.trim() || reminder.channel.length > 120) throw new Error(`${label} reminder channel is invalid`);
    if (reminder.enabled !== undefined && typeof reminder.enabled !== "boolean") throw new Error(`${label} reminder enabled flag is invalid`);
  }
}

function assertAbsoluteInstant(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!hasExplicitOffset(text) || !Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an absolute ISO date-time`);
  return text;
}

/** Validate already-resolved occurrence identity/chronology without requiring a persisted backing CalendarItem. */
export function assertCalendarOccurrenceIntegrity(sources: readonly CalendarSource[], occurrences: readonly CalendarOccurrence[]): void {
  if (!Array.isArray(sources) || !Array.isArray(occurrences)) throw new Error("Calendar occurrence collections are invalid");
  const sourceIds = new Set<string>();
  for (const source of sources) {
    assertSourceIntegrity(source);
    if (sourceIds.has(source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
    sourceIds.add(source.id);
  }
  const occurrenceIds = new Set<string>();
  for (const occurrence of occurrences) {
    const raw = record(occurrence, "Calendar occurrence");
    const occurrenceId = requiredText(raw.occurrenceId, "Calendar occurrence id");
    const label = `Calendar occurrence ${occurrenceId}`;
    if (raw.id !== undefined) throw new Error(`${label} must use sourceItemId rather than a redundant item id`);
    requiredText(raw.sourceItemId, `${label} source item id`);
    const start = assertAbsoluteInstant(raw.start, `${label} start`);
    const end = assertAbsoluteInstant(raw.end, `${label} end`);
    assertAbsoluteInstant(raw.originalStart, `${label} original start`);
    if (raw.recurrence !== undefined) throw new Error(`${label} must already be recurrence-expanded`);
    if (typeof raw.recurring !== "boolean") throw new Error(`${label} recurring flag is invalid`);
    if (raw.projectionIdentity !== undefined) assertJsonLike(raw.projectionIdentity, `${label} projection identity`, false, false);
    assertEventFieldsIntegrity(occurrence, raw, label);
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (occurrence.temporalForm === "point") {
      if (startMs !== endMs) throw new Error(`${label} point temporal form requires start and end to be identical`);
    } else if (endMs <= startMs) {
      throw new Error(`${label} must end after it starts`);
    }
    if (!sourceIds.has(occurrence.calendarId)) throw new Error(`Unknown calendar source: ${occurrence.calendarId}`);
    if (occurrenceIds.has(occurrenceId)) throw new Error(`Duplicate calendar occurrence: ${occurrenceId}`);
    occurrenceIds.add(occurrenceId);
  }
}


/** Validate passive, already-resolved background ranges without treating them as calendar events. */
export function assertCalendarBackgroundRangeIntegrity(
  sources: readonly CalendarSource[],
  ranges: readonly CalendarBackgroundRange[],
): void {
  if (!Array.isArray(sources) || !Array.isArray(ranges)) throw new Error("Calendar background range collections are invalid");
  const sourceIds = new Set<string>();
  for (const source of sources) {
    assertSourceIntegrity(source);
    if (sourceIds.has(source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
    sourceIds.add(source.id);
  }

  const rangeIds = new Set<string>();
  for (const range of ranges) {
    const raw = record(range, "Calendar background range");
    const id = requiredText(raw.id, "Calendar background range id");
    const label = `Calendar background range ${id}`;
    const start = assertAbsoluteInstant(raw.start, `${label} start`);
    const end = assertAbsoluteInstant(raw.end, `${label} end`);
    if (Date.parse(end) <= Date.parse(start)) throw new Error(`${label} must end after it starts`);

    if (raw.allDay !== undefined && typeof raw.allDay !== "boolean") throw new Error(`${label} allDay flag is invalid`);
    if (raw.calendarId !== undefined) {
      const calendarId = requiredText(raw.calendarId, `${label} calendar id`);
      if (!sourceIds.has(calendarId)) throw new Error(`Unknown calendar source: ${calendarId}`);
    }
    if (raw.label !== undefined) {
      if (typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 2048) throw new Error(`${label} label is invalid`);
    }
    if (raw.metadata !== undefined) assertMetadata(raw.metadata, `${label} metadata`);

    if (rangeIds.has(id)) throw new Error(`Duplicate calendar background range: ${id}`);
    rangeIds.add(id);
  }
}

export function applyCalendarItemPatch(item: CalendarItem, patch: CalendarItemPatch): CalendarItem {
  const description = patch.description === null ? undefined : patch.description ?? item.description;
  const location = patch.location === null ? undefined : patch.location ?? item.location;
  const recurrence = patch.recurrence === null ? undefined : patch.recurrence ?? item.recurrence;
  const temporal = patch.temporal === null ? undefined : patch.temporal ?? item.temporal;
  const display = patch.display === null ? undefined : patch.display ?? item.display;
  const metadata = patch.metadata === null ? undefined : patch.metadata ?? item.metadata;
  const reminders = patch.reminders === null ? undefined : patch.reminders ?? item.reminders;
  return {
    ...item,
    ...(patch.calendarId !== undefined ? { calendarId: patch.calendarId } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(description !== undefined ? { description } : { description: undefined }),
    ...(location !== undefined ? { location } : { location: undefined }),
    ...(patch.start !== undefined ? { start: patch.start } : {}),
    ...(patch.end !== undefined ? { end: patch.end } : {}),
    ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
    ...(patch.precision !== undefined ? { precision: patch.precision } : {}),
    ...(temporal !== undefined ? { temporal } : { temporal: undefined }),
    ...(patch.temporalForm !== undefined ? { temporalForm: patch.temporalForm } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.editPolicy !== undefined ? { editPolicy: patch.editPolicy } : {}),
    ...(recurrence !== undefined ? { recurrence } : { recurrence: undefined }),
    ...(reminders !== undefined ? { reminders } : { reminders: undefined }),
    ...(display !== undefined ? { display } : { display: undefined }),
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  } as CalendarItem;
}

export function applyCalendarSourcePatch(source: CalendarSource, patch: CalendarSourcePatch): CalendarSource {
  const display = patch.display === null ? undefined : patch.display ?? source.display;
  const metadata = patch.metadata === null ? undefined : patch.metadata ?? source.metadata;
  return {
    ...source,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
    ...(display !== undefined ? { display } : { display: undefined }),
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  };
}

export class MemoryCalendarRepository implements CalendarRepository {
  private items: CalendarItem[];
  private sources: CalendarSource[];
  private revision = 0;
  private readonly listeners = new Set<(snapshot: CalendarSnapshot) => void>();

  public constructor(initialSources: readonly CalendarSource[], initialItems: readonly CalendarItem[] = []) {
    assertCalendarStateIntegrity(initialSources, initialItems);
    this.sources = [...initialSources];
    this.items = [...initialItems];
  }

  public read(): CalendarSnapshot {
    return { sources: this.sources, items: this.items, revision: this.revision };
  }

  public create(item: CalendarItem): void {
    const next = [...this.items, item];
    assertCalendarStateIntegrity(this.sources, next);
    this.items = next; this.changed();
  }

  public update(id: CalendarItemId, patch: CalendarItemPatch): void {
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Calendar item not found: ${id}`);
    const updated = applyCalendarItemPatch(this.items[index]!, patch);
    const next = this.items.map((item, i) => i === index ? updated : item);
    assertCalendarStateIntegrity(this.sources, next);
    this.items = next; this.changed();
  }

  public remove(id: CalendarItemId): void {
    const next = this.items.filter(item => item.id !== id);
    if (next.length === this.items.length) throw new Error(`Calendar item not found: ${id}`);
    this.items = next; this.changed();
  }

  public replace(items: readonly CalendarItem[]): void { assertCalendarStateIntegrity(this.sources, items); this.items = [...items]; this.changed(); }

  public createSource(source: CalendarSource): void {
    const next = [...this.sources, source];
    assertCalendarStateIntegrity(next, this.items);
    this.sources = next; this.changed();
  }

  public updateSource(id: string, patch: CalendarSourcePatch): void {
    const index = this.sources.findIndex(source => source.id === id);
    if (index < 0) throw new Error(`Calendar source not found: ${id}`);
    const next = this.sources.map((source, i) => i === index ? applyCalendarSourcePatch(source, patch) : source);
    assertCalendarStateIntegrity(next, this.items);
    this.sources = next; this.changed();
  }

  public removeSource(id: string): void {
    const source = this.sources.find(row => row.id === id);
    if (!source) throw new Error(`Calendar source not found: ${id}`);
    if (source.removable !== true) throw new Error("Calendar source is not removable");
    if (this.items.some(item => item.calendarId === id)) throw new Error("Move or delete events from this calendar before removing it");
    this.sources = this.sources.filter(row => row.id !== id); this.changed();
  }

  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.revision += 1; const snapshot = this.read(); for (const listener of this.listeners) listener(snapshot); }
}
