import type {
  CalendarItem,
  CalendarRecurrence,
  CalendarReminder,
  CalendarTemporalKind,
} from "../core/types.js";
import { plainToInstant, parsePlainDateTime } from "../core/temporal.js";
import { parseRRule, serializeRRule } from "./ics.js";
import {
  calendarInteropMetadata,
  fingerprintCalendarItem,
  linkedExternalMetadata,
  mergeSyncMetadata,
  type CalendarSyncMode,
  type ExternalEventIdentity,
  type ExternalEventSnapshot,
  type SyncConflictPolicy,
} from "./sync.js";
import { stableHash, temporalSpec } from "./internal.js";
import type { GoogleCalendarEvent, GoogleEventDateTime } from "./google-transport.js";

export interface GoogleCalendarConnection {
  readonly id: string;
  readonly googleCalendarId: string;
  readonly localCalendarId: string;
  readonly mode: CalendarSyncMode;
  readonly conflictPolicy?: SyncConflictPolicy | undefined;
  /** Optional host mapping for pulled events. Defaults remain generic external/event values. */
  readonly importedKind?: CalendarItem["kind"] | undefined;
  readonly importedOwnership?: CalendarItem["ownership"] | undefined;
  readonly importedEditPolicy?: CalendarItem["editPolicy"] | undefined;
  readonly publishPredicate?: ((item: CalendarItem) => boolean) | undefined;
}

export function googleEventSnapshot(event: GoogleCalendarEvent, connection: GoogleCalendarConnection, localId?: string): ExternalEventSnapshot {
  const eventId = event.id ?? event.iCalUID ?? "unknown";
  const identity: ExternalEventIdentity = {
    provider: "google", connectionId: connection.id, externalCalendarId: connection.googleCalendarId, eventId,
    ...(event.iCalUID ? { iCalUid: event.iCalUID } : {}), ...(event.etag ? { etag: event.etag } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.originalStartTime ? { originalStart: googleDateValue(event.originalStartTime).value } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...(event.updated ? { updatedAt: event.updated } : {}),
  };
  if (event.status === "cancelled") return { identity, deleted: true, fingerprint: "<deleted>" };
  const item = googleEventToCalendarItem(event, connection.localCalendarId, connection.id, localId, connection.googleCalendarId, {
    ...(connection.importedKind ? { kind: connection.importedKind } : {}),
    ...(connection.importedOwnership ? { ownership: connection.importedOwnership } : {}),
    editPolicy: connection.mode === "overlay" ? "readonly" : connection.importedEditPolicy ?? "full",
  });
  return { identity, item, deleted: false, fingerprint: fingerprintCalendarItem(item) };
}

export interface GoogleCalendarItemMapping {
  readonly kind?: CalendarItem["kind"];
  readonly ownership?: CalendarItem["ownership"];
  readonly editPolicy?: CalendarItem["editPolicy"];
}

export function googleEventToCalendarItem(event: GoogleCalendarEvent, calendarId: string, connectionId: string, localId?: string, externalCalendarId = calendarId, mapping: GoogleCalendarItemMapping = {}): CalendarItem {
  if (!event.id || !event.start || !event.end) throw new Error("Google event is missing id/start/end.");
  const start = googleDateValue(event.start), end = googleDateValue(event.end);
  const ruleLine = event.recurrence?.find(line => line.toUpperCase().startsWith("RRULE:"));
  const exdates = event.recurrence?.filter(line => line.toUpperCase().startsWith("EXDATE")) ?? [];
  const recurrence: CalendarRecurrence | undefined = ruleLine ? {
    rule: parseRRule(ruleLine.slice(ruleLine.indexOf(":") + 1), start.kind, start.timeZone),
    ...(exdates.length ? { exceptions: exdates.flatMap(line => parseGoogleExdate(line, start)).map(originalStart => ({ originalStart, cancelled: true })) } : {}),
  } : undefined;
  const reminders: CalendarReminder[] = event.reminders?.overrides?.map((reminder, index) => ({ id: `google-${index + 1}`, minutesBefore: reminder.minutes, channel: "external" as const })) ?? [];
  const googleReminderMode = event.reminders?.useDefault === true ? "default" : reminders.length ? "overrides" : "none";
  const identity: ExternalEventIdentity = {
    provider: "google", connectionId, externalCalendarId, eventId: event.id,
    ...(event.iCalUID ? { iCalUid: event.iCalUID } : {}), ...(event.etag ? { etag: event.etag } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...(event.updated ? { updatedAt: event.updated } : {}),
  };
  return {
    id: localId ?? `google:${stableHash(`${connectionId}|${event.id}`)}`,
    calendarId,
    title: event.summary ?? "Untitled event",
    ...(event.description ? { description: event.description } : {}), ...(event.location ? { location: event.location } : {}),
    start: start.value, end: end.value,
    allDay: start.kind === "date", precision: start.kind === "date" ? "date" : "minute", temporal: temporalSpec(start.kind, start.timeZone),
    kind: mapping.kind ?? "event", ownership: mapping.ownership ?? "external", editPolicy: mapping.editPolicy ?? "readonly",
    ...(recurrence ? { recurrence } : {}), ...(reminders.length ? { reminders } : {}),
    metadata: linkedExternalMetadata(identity, { transparency: event.transparency ?? "opaque", reminderMode: googleReminderMode }),
    ...(event.updated ? { updatedAt: event.updated } : {}),
  };
}

export function itemToGoogleEvent(item: CalendarItem): GoogleCalendarEvent {
  const start = itemTimeToGoogle(item.start, item), end = itemTimeToGoogle(item.end, item);
  const recurrence = item.recurrence ? [
    `RRULE:${serializeRRule(item.recurrence.rule, item)}`,
    ...googleExdateLines(item),
  ] : undefined;
  const overrides = (item.reminders ?? []).filter(reminder => reminder.enabled !== false && reminder.channel === "external").slice(0, 5).map(reminder => ({ method: "popup" as const, minutes: Math.max(0, Math.min(40320, Math.round(reminder.minutesBefore))) }));
  const interop = calendarInteropMetadata(item);
  const useGoogleDefaults = interop?.reminderMode === "default" && overrides.length === 0;
  const externalPrivate: Record<string, string> = { calendarItemId: item.id };
  return {
    summary: item.title, ...(item.description ? { description: item.description } : {}), ...(item.location ? { location: item.location } : {}),
    start, end, ...(recurrence?.length ? { recurrence } : {}),
    reminders: overrides.length ? { useDefault: false, overrides } : { useDefault: useGoogleDefaults },
    extendedProperties: { private: externalPrivate },
    ...(interop?.sequence !== undefined ? { sequence: interop.sequence } : {}),
    ...(interop?.transparency === "transparent" || interop?.transparency === "opaque" ? { transparency: interop.transparency } : {}),
  };
}

export function mergePriorExceptions(fresh: CalendarItem, prior: CalendarItem | undefined): CalendarItem {
  if (!fresh.recurrence || !prior?.recurrence?.exceptions?.length) return fresh;
  const freshExceptions = fresh.recurrence.exceptions ?? [];
  const byOriginal = new Map([...prior.recurrence.exceptions, ...freshExceptions].map(exception => [exception.originalStart, exception] as const));
  return { ...fresh, recurrence: { ...fresh.recurrence, exceptions: [...byOriginal.values()] } };
}

export function applyGoogleInstanceChanges(parent: CalendarItem, changes: readonly GoogleCalendarEvent[]): CalendarItem {
  if (!parent.recurrence) return parent;
  const exceptions = new Map((parent.recurrence.exceptions ?? []).map(exception => [exception.originalStart, exception] as const));
  for (const event of changes) {
    if (!event.originalStartTime) continue;
    const originalStart = googleDateValue(event.originalStartTime).value;
    if (event.status === "cancelled") { exceptions.set(originalStart, { originalStart, cancelled: true }); continue; }
    if (!event.start || !event.end) continue;
    const replacement = googleEventToCalendarItem(
      { ...event, id: event.id ?? `${event.recurringEventId}:${originalStart}` },
      parent.calendarId,
      calendarInteropMetadata(parent)?.connectionId ?? "google-instance",
      undefined,
      calendarInteropMetadata(parent)?.externalCalendarId ?? parent.calendarId,
    );
    exceptions.set(originalStart, { originalStart, replacement: {
      title: replacement.title,
      ...(replacement.description !== undefined ? { description: replacement.description } : {}),
      ...(replacement.location !== undefined ? { location: replacement.location } : {}),
      start: replacement.start, end: replacement.end, allDay: replacement.allDay, precision: replacement.precision, temporal: replacement.temporal,
      ...(replacement.reminders !== undefined ? { reminders: replacement.reminders } : {}),
    } });
  }
  return { ...parent, recurrence: { ...parent.recurrence, exceptions: [...exceptions.values()] } };
}

export function googleDateValue(value: GoogleEventDateTime): { value: string; kind: CalendarTemporalKind; timeZone?: string } {
  if (value.date) return { value: value.date, kind: "date" };
  if (!value.dateTime) throw new Error("Google event date-time is missing date/dateTime.");
  if (value.timeZone) return { value: value.dateTime, kind: "zoned", timeZone: value.timeZone };
  return { value: value.dateTime, kind: "instant" };
}

function itemTimeToGoogle(value: string, item: CalendarItem): GoogleEventDateTime {
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? "instant" : "floating");
  if (kind === "date") return { date: value.slice(0, 10) };
  if (kind === "zoned") {
    const timeZone = item.temporal?.timeZone;
    if (!timeZone) throw new Error(`Zoned item ${item.id} is missing a time zone.`);
    if (/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return { dateTime: value, timeZone };
    const epoch = plainToInstant(parsePlainDateTime(value.slice(0, 19)), timeZone, item.temporal?.disambiguation ?? "compatible");
    return { dateTime: new Date(epoch).toISOString(), timeZone };
  }
  if (kind === "floating") return { dateTime: value };
  return { dateTime: new Date(value).toISOString() };
}

function parseGoogleExdate(line: string, start: ReturnType<typeof googleDateValue>): string[] {
  const colon = line.indexOf(":"); if (colon < 0) return [];
  const params = line.slice(0, colon); const values = line.slice(colon + 1).split(",");
  const date = /VALUE=DATE/i.test(params) || start.kind === "date";
  return values.map(value => date ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : basicToIso(value));
}

function googleExdateLines(item: CalendarItem): string[] {
  const cancelled = item.recurrence?.exceptions?.filter(exception => exception.cancelled).map(exception => exception.originalStart) ?? [];
  if (!cancelled.length) return [];
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : "instant");
  if (kind === "date") return [`EXDATE;VALUE=DATE:${cancelled.map(value => value.slice(0, 10).replace(/-/g, "")).join(",")}`];
  if (kind === "zoned") return [`EXDATE;TZID=${item.temporal?.timeZone ?? "UTC"}:${cancelled.map(value => localBasic(value, item.temporal?.timeZone ?? "UTC")).join(",")}`];
  if (kind === "floating") return [`EXDATE:${cancelled.map(localBasicRaw).join(",")}`];
  return [`EXDATE:${cancelled.map(value => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")).join(",")}`];
}

function localBasic(value: string, zone: string): string {
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return localBasicRaw(value);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}T${map.hour}${map.minute}${map.second}`;
}
function localBasicRaw(value: string): string { return value.slice(0, 19).replace(/[-:]/g, ""); }
function basicToIso(value: string): string {
  const z = value.endsWith("Z"); const raw = z ? value.slice(0, -1) : value;
  const iso = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(9,11)}:${raw.slice(11,13)}:${raw.slice(13,15)}`;
  return z ? `${iso}Z` : iso;
}
export function remoteToLocal(remote: ExternalEventSnapshot, connection: GoogleCalendarConnection, localId?: string): CalendarItem {
  if (!remote.item) throw new Error("Remote event has no item.");
  return {
    ...mergeSyncMetadata(remote.item, remote.identity), id: localId ?? remote.item.id, calendarId: connection.localCalendarId,
    kind: connection.importedKind ?? remote.item.kind,
    ownership: connection.importedOwnership ?? remote.item.ownership,
    editPolicy: connection.mode === "overlay" ? "readonly" : connection.importedEditPolicy ?? "full",
  };
}
export function itemPatch(item: CalendarItem) {
  return {
    calendarId: item.calendarId, title: item.title,
    ...(item.description !== undefined ? { description: item.description } : { description: null }),
    ...(item.location !== undefined ? { location: item.location } : { location: null }),
    start: item.start, end: item.end, allDay: item.allDay, precision: item.precision,
    ...(item.temporal !== undefined ? { temporal: item.temporal } : { temporal: null }),
    kind: item.kind, editPolicy: item.editPolicy,
    ...(item.recurrence !== undefined ? { recurrence: item.recurrence } : { recurrence: null }),
    ...(item.reminders !== undefined ? { reminders: item.reminders } : { reminders: null }),
    ...(item.display !== undefined ? { display: item.display } : { display: null }),
    ...(item.metadata !== undefined ? { metadata: item.metadata } : { metadata: null }),
  };
}

export function recurrenceIdentityEqual(item: CalendarItem, left: string, right: string): boolean {
  if (left === right) return true;
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : "instant");
  if (kind === "date") return left.slice(0, 10) === right.slice(0, 10);
  if (kind === "zoned" && item.temporal?.timeZone) {
    try {
      const zone = item.temporal.timeZone;
      const toEpoch = (value: string) => /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : plainToInstant(parsePlainDateTime(value.slice(0, 19)), zone, "compatible");
      return toEpoch(left) === toEpoch(right);
    } catch { return false; }
  }
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(left) && /(?:Z|[+-]\d\d:\d\d)$/.test(right)) return Date.parse(left) === Date.parse(right);
  return left.slice(0, 19) === right.slice(0, 19);
}
