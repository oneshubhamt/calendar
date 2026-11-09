import type { ISODate, ISODateTime, TemporalDisambiguation } from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface PlainDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export interface TemporalProviderLike {
  readonly Now?: { readonly timeZoneId?: () => string };
  readonly PlainDateTime?: { readonly from: (value: string | Record<string, unknown>) => unknown };
  readonly ZonedDateTime?: { readonly from: (value: Record<string, unknown>, options?: { disambiguation?: TemporalDisambiguation }) => unknown };
  readonly Instant?: { readonly fromEpochMilliseconds: (value: number) => unknown };
}

let installedTemporal: TemporalProviderLike | null | undefined;

export function installTemporalProvider(provider: TemporalProviderLike | null): void {
  installedTemporal = provider;
}

export function temporalProvider(): TemporalProviderLike | null {
  if (installedTemporal !== undefined) return installedTemporal;
  const candidate = (globalThis as { Temporal?: TemporalProviderLike }).Temporal;
  installedTemporal = candidate ?? null;
  return installedTemporal;
}

export function systemTimeZone(): string {
  const provider = temporalProvider();
  const native = provider?.Now?.timeZoneId?.();
  if (native) return native;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function assertTimeZone(timeZone: string): string {
  if (!timeZone) throw new RangeError("timeZone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

export function parsePlainDate(value: ISODate | string): PlainDateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid ISO date: ${value}`);
  return validatePlain({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0, millisecond: 0 });
}

export function parsePlainDateTime(value: ISODateTime | string): PlainDateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw new RangeError(`Invalid floating/local date-time: ${value}`);
  return validatePlain({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]),
    second: Number(match[6] ?? 0), millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
  });
}

export function formatPlainDate(parts: PlainDateTimeParts): ISODate {
  const p = validatePlain(parts);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatPlainDateTime(parts: PlainDateTimeParts): ISODateTime {
  const p = validatePlain(parts);
  const base = `${formatPlainDate(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  return p.millisecond ? `${base}.${pad(p.millisecond, 3)}` : base;
}

export function comparePlain(a: PlainDateTimeParts, b: PlainDateTimeParts): number {
  return plainScalar(a) - plainScalar(b);
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new RangeError("Invalid year/month");
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayOf(parts: PlainDateTimeParts): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const p = validatePlain(parts);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export function addPlainDays(parts: PlainDateTimeParts, days: number): PlainDateTimeParts {
  if (!Number.isInteger(days)) throw new RangeError("days must be an integer");
  const p = validatePlain(parts);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days, p.hour, p.minute, p.second, p.millisecond));
  return fromUtcDate(date);
}

export function addPlainMinutes(parts: PlainDateTimeParts, minutes: number): PlainDateTimeParts {
  if (!Number.isFinite(minutes)) throw new RangeError("minutes must be finite");
  const date = new Date(plainScalar(parts) + minutes * MINUTE_MS);
  return fromUtcDate(date);
}

export function addPlainMonths(parts: PlainDateTimeParts, months: number, overflow: "constrain" | "reject" = "constrain"): PlainDateTimeParts | null {
  if (!Number.isInteger(months)) throw new RangeError("months must be an integer");
  const p = validatePlain(parts);
  const absolute = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(absolute / 12);
  const month = ((absolute % 12) + 12) % 12 + 1;
  const last = daysInMonth(year, month);
  if (p.day > last && overflow === "reject") return null;
  return { ...p, year, month, day: Math.min(p.day, last) };
}

export function addPlainYears(parts: PlainDateTimeParts, years: number, overflow: "constrain" | "reject" = "constrain"): PlainDateTimeParts | null {
  if (!Number.isInteger(years)) throw new RangeError("years must be an integer");
  const p = validatePlain(parts);
  const year = p.year + years;
  const last = daysInMonth(year, p.month);
  if (p.day > last && overflow === "reject") return null;
  return { ...p, year, day: Math.min(p.day, last) };
}

export function instantToPlain(epochMilliseconds: number, timeZone: string): PlainDateTimeParts {
  assertTimeZone(timeZone);
  const provider = temporalProvider();
  if (provider?.Instant?.fromEpochMilliseconds) {
    try {
      const instant = provider.Instant.fromEpochMilliseconds(epochMilliseconds) as { toZonedDateTimeISO?: (zone: string) => Record<string, number> };
      const zoned = instant.toZonedDateTimeISO?.(timeZone);
      if (zoned) return validatePlain({
        year: Number(zoned.year), month: Number(zoned.month), day: Number(zoned.day), hour: Number(zoned.hour), minute: Number(zoned.minute),
        second: Number(zoned.second), millisecond: Number(zoned.millisecond),
      });
    } catch {
      // Fall through to the Intl implementation.
    }
  }
  return intlParts(epochMilliseconds, timeZone);
}

export function plainToInstant(parts: PlainDateTimeParts, timeZone: string, disambiguation: TemporalDisambiguation = "compatible"): number {
  const p = validatePlain(parts);
  assertTimeZone(timeZone);
  const provider = temporalProvider();
  if (provider?.ZonedDateTime?.from) {
    try {
      const zoned = provider.ZonedDateTime.from({ ...p, timeZone }, { disambiguation }) as { epochMilliseconds?: number | bigint };
      const value = zoned.epochMilliseconds;
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);
    } catch (error) {
      if (disambiguation === "reject") throw error;
    }
  }
  return intlPlainToInstant(p, timeZone, disambiguation);
}

/** Resolve a recurring local wall time. Non-existent local times are invalid; overlaps use the first occurrence. */
export function recurrencePlainToInstant(parts: PlainDateTimeParts, timeZone: string): number | null {
  try {
    const epoch = plainToInstant(parts, timeZone, "earlier");
    return samePlain(instantToPlain(epoch, timeZone), parts) ? epoch : null;
  } catch {
    return null;
  }
}

export function plainMinutesBetween(start: PlainDateTimeParts, end: PlainDateTimeParts): number {
  return (plainScalar(end) - plainScalar(start)) / MINUTE_MS;
}

export function plainDaysBetween(start: PlainDateTimeParts, end: PlainDateTimeParts): number {
  const a = Date.UTC(start.year, start.month - 1, start.day);
  const b = Date.UTC(end.year, end.month - 1, end.day);
  return (b - a) / DAY_MS;
}

function validatePlain(parts: PlainDateTimeParts): PlainDateTimeParts {
  const { year, month, day, hour, minute, second, millisecond } = parts;
  if (![year, month, day, hour, minute, second, millisecond].every(Number.isInteger)) throw new RangeError("Plain date-time fields must be integers");
  if (month < 1 || month > 12 || day < 1 || day > daysInMonthRaw(year, month) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999) {
    throw new RangeError("Invalid plain date-time");
  }
  return { year, month, day, hour, minute, second, millisecond };
}

function daysInMonthRaw(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function plainScalar(parts: PlainDateTimeParts): number {
  const p = validatePlain(parts);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);
}

function fromUtcDate(date: Date): PlainDateTimeParts {
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(), millisecond: date.getUTCMilliseconds(),
  };
}

function intlParts(epochMilliseconds: number, timeZone: string): PlainDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(epochMilliseconds))) if (part.type !== "literal") values[part.type] = Number(part.value);
  return validatePlain({
    year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second!,
    millisecond: ((epochMilliseconds % 1000) + 1000) % 1000,
  });
}

function offsetMinutesAt(epochMilliseconds: number, timeZone: string): number {
  const parts = intlParts(epochMilliseconds, timeZone);
  const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  const epochSecond = Math.trunc(epochMilliseconds / 1000) * 1000;
  return (representedUtc - epochSecond) / MINUTE_MS;
}

function possibleInstants(parts: PlainDateTimeParts, timeZone: string): number[] {
  const naive = plainScalar(parts);
  const probes = [naive, naive - DAY_MS, naive + DAY_MS, naive - 180 * DAY_MS, naive + 180 * DAY_MS, naive - 365 * DAY_MS, naive + 365 * DAY_MS];
  const offsets = [...new Set(probes.map(probe => offsetMinutesAt(probe, timeZone)))];
  const matches = offsets
    .map(offset => naive - offset * MINUTE_MS)
    .filter(epoch => samePlain(intlParts(epoch, timeZone), parts))
    .sort((a, b) => a - b);
  return [...new Set(matches)];
}

function intlPlainToInstant(parts: PlainDateTimeParts, timeZone: string, disambiguation: TemporalDisambiguation): number {
  const matches = possibleInstants(parts, timeZone);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    if (disambiguation === "reject") throw new RangeError("Ambiguous local date-time");
    return disambiguation === "later" ? matches[matches.length - 1]! : matches[0]!;
  }
  if (disambiguation === "reject") throw new RangeError("Non-existent local date-time");

  const naive = plainScalar(parts);
  const beforeOffset = offsetMinutesAt(naive - DAY_MS, timeZone);
  const afterOffset = offsetMinutesAt(naive + DAY_MS, timeZone);
  const beforeCandidate = naive - beforeOffset * MINUTE_MS;
  const afterCandidate = naive - afterOffset * MINUTE_MS;
  if (disambiguation === "earlier") return Math.min(beforeCandidate, afterCandidate);
  if (disambiguation === "later") return Math.max(beforeCandidate, afterCandidate);
  // RFC 5545 explicit local date-times use the UTC offset before a forward gap.
  return beforeCandidate;
}

function samePlain(a: PlainDateTimeParts, b: PlainDateTimeParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second && a.millisecond === b.millisecond;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
