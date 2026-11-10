import type {
  CalendarItem, CalendarItemKind, CalendarOwnership, CalendarRecurrence, CalendarReminder, CalendarTemporalKind, EditPolicy,
  ISODateTime, RecurrenceByDay, RecurrenceException, RecurrenceRule, Weekday,
} from "../core/types.js";
import {
  formatPlainDate, formatPlainDateTime, instantToPlain, parsePlainDate, parsePlainDateTime,
  type PlainDateTimeParts,
} from "../core/temporal.js";
import { calendarInteropMetadata, linkedExternalMetadata, type ExternalEventIdentity } from "./sync.js";

const WEEKDAY_TO_ICS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const ICS_TO_WEEKDAY = new Map<string, Weekday>(WEEKDAY_TO_ICS.map((value, index) => [value, index as Weekday]));

export interface IcsExportOptions {
  readonly productId?: string;
  readonly calendarName?: string;
  readonly uidDomain?: string;
  readonly now?: ISODateTime;
}

export interface IcsImportOptions {
  readonly calendarId: string;
  readonly sourceId?: string;
  readonly defaultTimeZone?: string;
  readonly defaultKind?: CalendarItemKind;
  readonly ownership?: CalendarOwnership;
  readonly editPolicy?: EditPolicy;
  /** Legacy convenience. Prefer editPolicy. */
  readonly readOnly?: boolean;
}

export interface IcsImportWarning { readonly uid?: string; readonly message: string; }
export interface IcsImportResult {
  readonly items: readonly CalendarItem[];
  readonly warnings: readonly IcsImportWarning[];
  readonly calendarName?: string | undefined;
}

interface ParsedProperty { readonly name: string; readonly params: Readonly<Record<string, string>>; readonly value: string; }
interface ParsedEvent { readonly properties: readonly ParsedProperty[]; readonly alarms: readonly ParsedProperty[][]; }

export function exportIcs(items: readonly CalendarItem[], options: IcsExportOptions = {}): string {
  const now = options.now ?? new Date().toISOString();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeText(options.productId ?? "-//Calendar//EN")}`,
    "CALSCALE:GREGORIAN",
  ];
  if (options.calendarName) lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`);
  for (const item of items) lines.push(...serializeItem(item, now, options.uidDomain ?? "calendar.local"));
  lines.push("END:VCALENDAR");
  return foldLines(lines).join("\r\n") + "\r\n";
}

export function importIcs(text: string, options: IcsImportOptions): IcsImportResult {
  const properties = unfoldLines(text).map(parseProperty).filter((value): value is ParsedProperty => Boolean(value));
  const calendarName = properties.find(property => property.name === "X-WR-CALNAME")?.value;
  const parsedEvents = parseEvents(unfoldLines(text));
  const warnings: IcsImportWarning[] = [];
  const masters = new Map<string, ParsedEvent>();
  const detached = new Map<string, ParsedEvent[]>();
  for (const event of parsedEvents) {
    const uid = valueOf(event, "UID");
    if (!uid) { warnings.push({ message: "Skipped VEVENT without UID." }); continue; }
    if (propertyOf(event, "RECURRENCE-ID")) {
      const list = detached.get(uid) ?? [];
      list.push(event); detached.set(uid, list);
    } else masters.set(uid, event);
  }
  const items: CalendarItem[] = [];
  for (const [uid, event] of masters) {
    try {
      const item = parsedEventToItem(event, uid, options);
      const exceptions: RecurrenceException[] = [...(item.recurrence?.exceptions ?? [])];
      for (const exceptionEvent of detached.get(uid) ?? []) {
        const recurrenceId = propertyOf(exceptionEvent, "RECURRENCE-ID");
        if (!recurrenceId) continue;
        const originalStart = parseIcsDateValue(recurrenceId, options.defaultTimeZone).value;
        if ((valueOf(exceptionEvent, "STATUS") ?? "").toUpperCase() === "CANCELLED") exceptions.push({ originalStart, cancelled: true });
        else {
          const replacementItem = parsedEventToItem(exceptionEvent, uid, options, true);
          exceptions.push({ originalStart, replacement: {
            title: replacementItem.title,
            ...(replacementItem.description !== undefined ? { description: replacementItem.description } : {}),
            ...(replacementItem.location !== undefined ? { location: replacementItem.location } : {}),
            start: replacementItem.start, end: replacementItem.end, allDay: replacementItem.allDay,
            precision: replacementItem.precision, temporal: replacementItem.temporal,
            kind: replacementItem.kind,
          } });
        }
      }
      items.push(item.recurrence ? { ...item, recurrence: { ...item.recurrence, ...(exceptions.length ? { exceptions } : {}) } } : item);
    } catch (error) {
      warnings.push({ uid, message: error instanceof Error ? error.message : "Invalid VEVENT." });
    }
  }
  // A detached instance without its master is still useful as a standalone event.
  for (const [uid, events] of detached) if (!masters.has(uid)) for (const event of events) {
    try { items.push(parsedEventToItem(event, `${uid}:${valueOf(event, "RECURRENCE-ID") ?? "detached"}`, options, true)); }
    catch (error) { warnings.push({ uid, message: error instanceof Error ? error.message : "Invalid detached VEVENT." }); }
  }
  return { items, warnings, ...(calendarName ? { calendarName: unescapeText(calendarName) } : {}) };
}

export function icsIdentity(item: CalendarItem, connectionId = "ics-import"): ExternalEventIdentity | null {
  const interop = calendarInteropMetadata(item);
  const uid = interop?.iCalUid ?? "";
  if (!uid) return null;
  return {
    provider: interop?.provider ?? "ics", connectionId: interop?.connectionId ?? connectionId,
    externalCalendarId: interop?.externalCalendarId ?? item.calendarId, eventId: interop?.eventId ?? uid, iCalUid: uid,
    ...(interop?.sequence !== undefined ? { sequence: interop.sequence } : {}),
  };
}

function serializeItem(item: CalendarItem, dtstamp: string, uidDomain: string): string[] {
  const interop = calendarInteropMetadata(item);
  const uid = String(interop?.iCalUid ?? `${safeUid(item.id)}@${uidDomain}`);
  const lines = ["BEGIN:VEVENT", `UID:${escapeText(uid)}`, `DTSTAMP:${utcBasic(dtstamp)}`];
  const sequence = Number(interop?.sequence ?? 0);
  if (Number.isInteger(sequence) && sequence > 0) lines.push(`SEQUENCE:${sequence}`);
  lines.push(...serializeStartEnd(item));
  lines.push(`SUMMARY:${escapeText(item.title)}`);
  if (item.description) lines.push(`DESCRIPTION:${escapeText(item.description)}`);
  if (item.location) lines.push(`LOCATION:${escapeText(item.location)}`);
  const category = String(item.metadata?.category ?? "").trim();
  if (category) lines.push(`CATEGORIES:${escapeText(category)}`);
  if (item.recurrence) {
    lines.push(`RRULE:${serializeRRule(item.recurrence.rule, item)}`);
    const cancelled = item.recurrence.exceptions?.filter(value => value.cancelled).map(value => value.originalStart) ?? [];
    if (cancelled.length) lines.push(...serializeExdates(cancelled, item));
  }
  lines.push(...serializeExternalAlarms(item));
  lines.push("END:VEVENT");
  const out = [...lines];
  // Replacement exceptions are encoded as detached VEVENTs keyed by UID + RECURRENCE-ID.
  for (const exception of item.recurrence?.exceptions ?? []) if (!exception.cancelled && exception.replacement) {
    const occurrence = { ...item, ...cleanPatch(exception.replacement as unknown as Record<string, unknown>), recurrence: undefined } as CalendarItem;
    out.push("BEGIN:VEVENT", `UID:${escapeText(uid)}`, `DTSTAMP:${utcBasic(dtstamp)}`, recurrenceIdLine(exception.originalStart, item), ...serializeStartEnd(occurrence), `SUMMARY:${escapeText(occurrence.title)}`);
    if (occurrence.description) out.push(`DESCRIPTION:${escapeText(occurrence.description)}`);
    if (occurrence.location) out.push(`LOCATION:${escapeText(occurrence.location)}`);
    out.push(...serializeExternalAlarms(occurrence));
    out.push("END:VEVENT");
  }
  return out;
}

function serializeExternalAlarms(item: CalendarItem): string[] {
  const lines: string[] = [];
  for (const reminder of item.reminders ?? []) {
    if (reminder.enabled === false || reminder.channel !== "external") continue;
    const minutes = Math.max(0, Math.round(reminder.minutesBefore));
    const trigger = minutes === 0 ? "PT0M" : `-PT${minutes}M`;
    lines.push("BEGIN:VALARM", `TRIGGER:${trigger}`, "ACTION:DISPLAY", `DESCRIPTION:${escapeText(item.title)}`, "END:VALARM");
  }
  return lines;
}

function parsedEventToItem(event: ParsedEvent, uid: string, options: IcsImportOptions, detached = false): CalendarItem {
  const startProperty = propertyOf(event, "DTSTART");
  if (!startProperty) throw new Error("VEVENT is missing DTSTART.");
  const start = parseIcsDateValue(startProperty, options.defaultTimeZone);
  const endProperty = propertyOf(event, "DTEND");
  const duration = propertyOf(event, "DURATION")?.value;
  const end = endProperty ? parseIcsDateValue(endProperty, options.defaultTimeZone) : defaultEnd(start, duration);
  const title = unescapeText(valueOf(event, "SUMMARY") ?? "Untitled event");
  const description = valueOf(event, "DESCRIPTION");
  const location = valueOf(event, "LOCATION");
  const categories = valueOf(event, "CATEGORIES");
  const sequence = Number(valueOf(event, "SEQUENCE") ?? 0);
  const identity: ExternalEventIdentity = {
    provider: "ics", connectionId: options.sourceId ?? "ics-import", externalCalendarId: options.calendarId,
    eventId: uid, iCalUid: uid, ...(Number.isInteger(sequence) ? { sequence } : {}),
  };
  const ruleProperty = propertyOf(event, "RRULE");
  const exdates = propertiesOf(event, "EXDATE").flatMap(property => property.value.split(",").map(value => parseIcsDateValue({ ...property, value }, options.defaultTimeZone).value));
  const recurrence = ruleProperty && !detached ? {
    rule: parseRRule(ruleProperty.value, start.kind, start.timeZone),
    ...(exdates.length ? { exceptions: exdates.map(originalStart => ({ originalStart, cancelled: true })) } : {}),
  } satisfies CalendarRecurrence : undefined;
  const resolvedEditPolicy = options.editPolicy ?? (options.readOnly === false ? "full" : "readonly");
  const reminders: CalendarReminder[] = event.alarms.flatMap((alarm, index) => {
    const trigger = alarm.find(property => property.name === "TRIGGER")?.value;
    const minutes = trigger ? relativeTriggerMinutes(trigger) : null;
    return minutes === null ? [] : [{ id: `ics-alarm-${index + 1}`, minutesBefore: minutes, channel: (resolvedEditPolicy === "full" ? "browser" : "external") as CalendarReminder["channel"] }];
  });
  const category = categories ? unescapeText(categories.split(",")[0] ?? "") : "";
  const metadata = { ...linkedExternalMetadata(identity, { fingerprint: fingerprintCalendarItemPlaceholder(uid, sequence) }), ...(category ? { category } : {}) };
  return {
    id: `ics:${stableHash(`${options.calendarId}|${uid}`)}`,
    calendarId: options.calendarId,
    title,
    ...(description !== undefined ? { description: unescapeText(description) } : {}),
    ...(location !== undefined ? { location: unescapeText(location) } : {}),
    start: start.value, end: end.value,
    allDay: start.kind === "date", precision: start.kind === "date" ? "date" : "minute",
    temporal: temporalSpec(start.kind, start.timeZone),
    kind: options.defaultKind ?? "event",
    ownership: options.ownership ?? "external",
    editPolicy: resolvedEditPolicy,
    ...(recurrence ? { recurrence } : {}),
    ...(reminders.length ? { reminders } : {}),
    metadata,
  };
}

function parseEvents(lines: readonly string[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let event: ParsedProperty[] | null = null;
  let alarm: ParsedProperty[] | null = null;
  const alarms: ParsedProperty[][] = [];
  for (const raw of lines) {
    const upper = raw.toUpperCase();
    if (upper === "BEGIN:VEVENT") { event = []; alarms.length = 0; continue; }
    if (!event) continue;
    if (upper === "BEGIN:VALARM") { alarm = []; continue; }
    if (upper === "END:VALARM") { if (alarm) alarms.push(alarm); alarm = null; continue; }
    if (upper === "END:VEVENT") { events.push({ properties: event, alarms: alarms.map(value => [...value]) }); event = null; alarm = null; continue; }
    const property = parseProperty(raw);
    if (property) (alarm ?? event).push(property);
  }
  return events;
}

function parseProperty(line: string): ParsedProperty | null {
  const colon = findUnquotedColon(line);
  if (colon < 1) return null;
  const left = line.slice(0, colon).split(";");
  const name = (left.shift() ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const part of left) {
    const equals = part.indexOf("=");
    if (equals > 0) params[part.slice(0, equals).toUpperCase()] = stripQuotes(part.slice(equals + 1));
  }
  return { name, params, value: line.slice(colon + 1) };
}

function parseIcsDateValue(property: ParsedProperty, defaultTimeZone = "UTC"): { value: string; kind: CalendarTemporalKind; timeZone?: string } {
  const raw = property.value.trim();
  if (property.params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(raw)) {
    const plain = parseBasicDate(raw);
    return { value: formatPlainDate(plain), kind: "date" };
  }
  const plain = parseBasicDateTime(raw.replace(/Z$/i, ""));
  if (/Z$/i.test(raw)) return { value: new Date(Date.UTC(plain.year, plain.month - 1, plain.day, plain.hour, plain.minute, plain.second)).toISOString(), kind: "instant" };
  const tzid = property.params.TZID;
  if (tzid) return { value: formatPlainDateTime(plain), kind: "zoned", timeZone: tzid };
  return { value: formatPlainDateTime(plain), kind: defaultTimeZone === "floating" ? "floating" : "floating" };
}

function defaultEnd(start: ReturnType<typeof parseIcsDateValue>, duration?: string): ReturnType<typeof parseIcsDateValue> {
  const minutes = duration ? parseDurationMinutes(duration) : start.kind === "date" ? 1440 : 60;
  if (start.kind === "date") {
    const date = parsePlainDate(start.value);
    const next = new Date(Date.UTC(date.year, date.month - 1, date.day + Math.max(1, Math.round(minutes / 1440))));
    return { value: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`, kind: "date" };
  }
  const plain = parsePlainDateTime(start.value);
  const next = new Date(Date.UTC(plain.year, plain.month - 1, plain.day, plain.hour, plain.minute + minutes, plain.second));
  return { value: formatPlainDateTime({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: next.getUTCHours(), minute: next.getUTCMinutes(), second: next.getUTCSeconds(), millisecond: 0 }), kind: start.kind, ...(start.timeZone ? { timeZone: start.timeZone } : {}) };
}

export function parseRRule(value: string, startKind: CalendarTemporalKind = "instant", startTimeZone?: string): RecurrenceRule {
  const start = { value: "", kind: startKind, ...(startTimeZone ? { timeZone: startTimeZone } : {}) } as ReturnType<typeof parseIcsDateValue>;
  const parts = Object.fromEntries(value.split(";").map(part => { const [key, ...rest] = part.split("="); return [key?.toUpperCase() ?? "", rest.join("=")]; }));
  const frequencyMap = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" } as const;
  const frequency = frequencyMap[parts.FREQ as keyof typeof frequencyMap];
  if (!frequency) throw new Error(`Unsupported RRULE frequency: ${parts.FREQ ?? ""}`);
  const rule: RecurrenceRule = {
    frequency,
    ...(positiveInt(parts.INTERVAL) ? { interval: positiveInt(parts.INTERVAL)! } : {}),
    ...(positiveInt(parts.COUNT) ? { count: positiveInt(parts.COUNT)! } : {}),
    ...(parts.UNTIL ? { until: parseUntil(parts.UNTIL, start) } : {}),
    ...(parts.BYDAY ? { byDay: parts.BYDAY.split(",").map(parseByDay) } : {}),
    ...(parts.BYMONTHDAY ? { byMonthDay: parts.BYMONTHDAY.split(",").map(Number).filter(Number.isInteger) } : {}),
    ...(parts.BYMONTH ? { byMonth: parts.BYMONTH.split(",").map(Number).filter(Number.isInteger) } : {}),
    ...(parts.BYSETPOS ? { bySetPosition: parts.BYSETPOS.split(",").map(Number).filter(Number.isInteger) } : {}),
    ...(parts.WKST && ICS_TO_WEEKDAY.has(parts.WKST) ? { weekStartsOn: ICS_TO_WEEKDAY.get(parts.WKST)! } : {}),
  };
  return rule;
}

export function serializeRRule(rule: RecurrenceRule, item: CalendarItem): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
  if ((rule.interval ?? 1) !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${serializeUntil(rule.until, item)}`);
  const byDay: readonly RecurrenceByDay[] | undefined = rule.byDay;
  if (byDay?.length) parts.push(`BYDAY=${byDay.map(entry => `${entry.ordinal ?? ""}${WEEKDAY_TO_ICS[entry.weekday]}`).join(",")}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.bySetPosition?.length) parts.push(`BYSETPOS=${rule.bySetPosition.join(",")}`);
  if (rule.weekStartsOn !== undefined) parts.push(`WKST=${WEEKDAY_TO_ICS[rule.weekStartsOn]}`);
  return parts.join(";");
}

function serializeStartEnd(item: CalendarItem): string[] {
  const kind = item.temporal?.kind ?? (item.allDay || item.precision === "date" ? "date" : /(?:Z|[+-]\d\d:\d\d)$/.test(item.start) ? "instant" : "floating");
  if (kind === "date") return [`DTSTART;VALUE=DATE:${basicDate(item.start)}`, `DTEND;VALUE=DATE:${basicDate(item.end)}`];
  if (kind === "zoned") {
    const zone = item.temporal?.timeZone;
    if (!zone) throw new Error(`Zoned item ${item.id} is missing a time zone.`);
    return [`DTSTART;TZID=${escapeParam(zone)}:${basicDateTime(item.start, zone)}`, `DTEND;TZID=${escapeParam(zone)}:${basicDateTime(item.end, zone)}`];
  }
  if (kind === "floating") return [`DTSTART:${basicFloating(item.start)}`, `DTEND:${basicFloating(item.end)}`];
  return [`DTSTART:${utcBasic(item.start)}`, `DTEND:${utcBasic(item.end)}`];
}

function serializeExdates(values: readonly string[], item: CalendarItem): string[] {
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : "instant");
  if (kind === "date") return [`EXDATE;VALUE=DATE:${values.map(basicDate).join(",")}`];
  if (kind === "zoned") return [`EXDATE;TZID=${escapeParam(item.temporal?.timeZone ?? "UTC")}:${values.map(value => basicDateTime(value, item.temporal?.timeZone ?? "UTC")).join(",")}`];
  if (kind === "floating") return [`EXDATE:${values.map(basicFloating).join(",")}`];
  return [`EXDATE:${values.map(utcBasic).join(",")}`];
}

function recurrenceIdLine(value: string, item: CalendarItem): string {
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : "instant");
  if (kind === "date") return `RECURRENCE-ID;VALUE=DATE:${basicDate(value)}`;
  if (kind === "zoned") return `RECURRENCE-ID;TZID=${escapeParam(item.temporal?.timeZone ?? "UTC")}:${basicDateTime(value, item.temporal?.timeZone ?? "UTC")}`;
  if (kind === "floating") return `RECURRENCE-ID:${basicFloating(value)}`;
  return `RECURRENCE-ID:${utcBasic(value)}`;
}

function propertyOf(event: ParsedEvent, name: string): ParsedProperty | undefined { return event.properties.find(property => property.name === name); }
function propertiesOf(event: ParsedEvent, name: string): readonly ParsedProperty[] { return event.properties.filter(property => property.name === name); }
function valueOf(event: ParsedEvent, name: string): string | undefined { return propertyOf(event, name)?.value; }
function temporalSpec(kind: CalendarTemporalKind, timeZone?: string) { return kind === "zoned" ? { kind, timeZone: timeZone ?? "UTC" } as const : { kind } as const; }

function unfoldLines(text: string): string[] { return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n").map(line => line.replace(/\r$/, "")).filter(Boolean); }
function foldLines(lines: readonly string[]): string[] { return lines.flatMap(line => foldLine(line)); }
function foldLine(line: string): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return [line];
  const out: string[] = []; let current = "";
  for (const char of line) {
    const candidate = current + char;
    if (encoder.encode(candidate).length > (out.length ? 74 : 75)) { out.push((out.length ? " " : "") + current); current = char; }
    else current = candidate;
  }
  if (current) out.push((out.length ? " " : "") + current);
  return out;
}
function escapeText(value: string): string { return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,"); }
function unescapeText(value: string): string { return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\"); }
function escapeParam(value: string): string { return value.replace(/[;,:"]/g, ""); }
function stripQuotes(value: string): string { return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value; }
function findUnquotedColon(value: string): number { let quoted = false; for (let i = 0; i < value.length; i++) { if (value[i] === '"') quoted = !quoted; else if (value[i] === ":" && !quoted) return i; } return -1; }
function basicDate(value: string): string { return value.slice(0, 10).replace(/-/g, ""); }
function basicFloating(value: string): string { const p = parsePlainDateTime(value.slice(0, 19)); return `${basicFromParts(p)}`; }
function basicDateTime(value: string, timeZone: string): string { const p = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? instantToPlain(Date.parse(value), timeZone) : parsePlainDateTime(value.slice(0, 19)); return basicFromParts(p); }
function basicFromParts(p: PlainDateTimeParts): string { return `${String(p.year).padStart(4, "0")}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}${String(p.minute).padStart(2, "0")}${String(p.second).padStart(2, "0")}`; }
function utcBasic(value: string): string { const d = new Date(value); if (!Number.isFinite(d.getTime())) throw new Error(`Invalid instant: ${value}`); return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function parseBasicDate(value: string): PlainDateTimeParts { if (!/^\d{8}$/.test(value)) throw new Error(`Invalid iCalendar DATE: ${value}`); return parsePlainDate(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`); }
function parseBasicDateTime(value: string): PlainDateTimeParts { if (!/^\d{8}T\d{6}$/.test(value)) throw new Error(`Invalid iCalendar DATE-TIME: ${value}`); return parsePlainDateTime(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}`); }
function parseByDay(value: string): RecurrenceByDay { const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value.toUpperCase()); if (!match) throw new Error(`Unsupported BYDAY value: ${value}`); const weekday = ICS_TO_WEEKDAY.get(match[2]!)!; return match[1] ? { weekday, ordinal: Number(match[1]) } : { weekday }; }
function positiveInt(value: string | undefined): number | null { if (!value) return null; const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function parseUntil(value: string, start: ReturnType<typeof parseIcsDateValue>): string { return parseIcsDateValue({ name: "UNTIL", params: start.kind === "date" ? { VALUE: "DATE" } : {}, value }, start.timeZone).value; }
function serializeUntil(value: string, item: CalendarItem): string { return item.temporal?.kind === "date" || item.allDay ? basicDate(value) : item.temporal?.kind === "floating" ? basicFloating(value) : item.temporal?.kind === "zoned" && !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? basicFloating(value) : utcBasic(value); }
function parseDurationMinutes(value: string): number { const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value); if (!match) throw new Error(`Unsupported duration: ${value}`); return Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) + Math.ceil(Number(match[4] ?? 0) / 60); }
function relativeTriggerMinutes(value: string): number | null { const negative = value.startsWith("-"); const clean = value.replace(/^[+-]/, ""); try { const minutes = parseDurationMinutes(clean); return negative ? minutes : 0; } catch { return null; } }
function safeUid(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180) || stableHash(value); }
function stableHash(value: string): string { let hash = 2166136261; for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
function fingerprintCalendarItemPlaceholder(uid: string, sequence: number): string { return `${uid}:${sequence}`; }
function cleanPatch(patch: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null && value !== undefined)); }
