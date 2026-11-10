import type {
  CalendarRange,
  CalendarTemporalForm,
  CalendarTemporalKind,
  CalendarTemporalSpec,
  ISODateTime,
  RecurrenceByDay,
  RecurrenceRule,
  TemporalPrecision,
  Weekday,
} from "./types.js";
import { hasExplicitOffset, intersectsRange, resolvedTimeZone, toDate } from "./time.js";
import {
  addPlainDays,
  addPlainMinutes,
  addPlainMonths,
  comparePlain,
  daysInMonth,
  formatPlainDate,
  formatPlainDateTime,
  instantToPlain,
  parsePlainDate,
  parsePlainDateTime,
  plainDaysBetween,
  plainMinutesBetween,
  plainToInstant,
  recurrencePlainToInstant,
  weekdayOf,
  type PlainDateTimeParts,
} from "./temporal.js";

const MAX_OCCURRENCES = 20_000;

export interface RecurrenceExpansionOptions {
  readonly timeZone?: string | undefined;
}

/** Generic temporal-series input for recurrence resolution. It contains no event semantics. */
export interface CalendarTemporalSeries {
  readonly id: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly precision?: TemporalPrecision | undefined;
  readonly temporal?: CalendarTemporalSpec | undefined;
  readonly temporalForm?: CalendarTemporalForm | undefined;
}

export interface CalendarTemporalSeriesPatch {
  readonly start?: ISODateTime;
  readonly end?: ISODateTime;
}


export interface CalendarTemporalSeriesEditPatch extends CalendarTemporalSeriesPatch {
  readonly allDay?: boolean | undefined;
  readonly precision?: TemporalPrecision | undefined;
  readonly temporal?: CalendarTemporalSpec | null | undefined;
  readonly temporalForm?: CalendarTemporalForm | undefined;
}

export interface CalendarResolvedTemporalPlacement {
  readonly start: ISODateTime;
  readonly end: ISODateTime;
}

export interface CalendarTemporalSeriesException<TPatch extends CalendarTemporalSeriesPatch = CalendarTemporalSeriesPatch> {
  readonly originalStart: ISODateTime;
  readonly cancelled?: boolean;
  readonly replacement?: TPatch;
}

export interface CalendarTemporalSeriesRecurrence<TPatch extends CalendarTemporalSeriesPatch = CalendarTemporalSeriesPatch> {
  readonly rule: RecurrenceRule;
  readonly exceptions?: readonly CalendarTemporalSeriesException<TPatch>[];
}

export interface CalendarResolvedTemporalRange<TPatch extends CalendarTemporalSeriesPatch = CalendarTemporalSeriesPatch> {
  readonly originalStart: ISODateTime;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly recurring: boolean;
  readonly exception?: CalendarTemporalSeriesException<TPatch> | undefined;
}

interface TemporalContext {
  readonly kind: CalendarTemporalKind;
  readonly timeZone: string;
  readonly startPlain: PlainDateTimeParts;
  readonly endPlain: PlainDateTimeParts;
  readonly elapsedDurationMs: number;
  readonly wallDurationMinutes: number;
  readonly dateDurationDays: number;
  readonly point: boolean;
}

interface ResolvedCandidate {
  readonly plain: PlainDateTimeParts;
  readonly identity: string;
  readonly startEpochMs: number;
  readonly endEpochMs: number;
}

export function validateRecurrenceRule(rule: RecurrenceRule): void {
  if (rule.interval !== undefined && (!Number.isInteger(rule.interval) || rule.interval < 1)) throw new RangeError("Recurrence interval must be a positive integer");
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_OCCURRENCES)) throw new RangeError("Recurrence count must be a positive integer within the calendar limit");
  if (rule.byMonthDay?.some(day => !Number.isInteger(day) || day === 0 || day < -31 || day > 31)) throw new RangeError("Invalid BYMONTHDAY value");
  if (rule.byMonth?.some(month => !Number.isInteger(month) || month < 1 || month > 12)) throw new RangeError("Invalid BYMONTH value");
  if (rule.bySetPosition?.some(position => !Number.isInteger(position) || position === 0 || position < -366 || position > 366)) throw new RangeError("Invalid BYSETPOS value");
  if (rule.bySetPosition?.length && !(rule.byMonthDay?.length || rule.byMonth?.length || rule.byWeekday?.length || rule.byDay?.length)) throw new RangeError("BYSETPOS requires another BY rule");
  if (rule.byDay?.some(entry => entry.ordinal !== undefined && (!Number.isInteger(entry.ordinal) || entry.ordinal === 0 || entry.ordinal < -53 || entry.ordinal > 53))) throw new RangeError("Invalid ordinal BYDAY value");
  if ((rule.frequency === "daily" || rule.frequency === "weekly") && rule.byDay?.some(entry => entry.ordinal !== undefined)) throw new RangeError("Ordinal BYDAY is supported only for monthly/yearly recurrence");
}


/** Structural equality for recurrence definitions independent of the consumer's exception payload. */
export function sameRecurrence<
  TLeft extends CalendarTemporalSeriesPatch,
  TRight extends CalendarTemporalSeriesPatch,
>(
  a: CalendarTemporalSeriesRecurrence<TLeft> | undefined,
  b: CalendarTemporalSeriesRecurrence<TRight> | null | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Project an edited resolved placement back to a temporal series anchor while preserving temporal representation. */
export function projectTemporalPatchToSeries<TPatch extends CalendarTemporalSeriesEditPatch>(
  series: CalendarTemporalSeries,
  resolved: CalendarResolvedTemporalPlacement,
  patch: TPatch,
  options: RecurrenceExpansionOptions = {},
): TPatch {
  const viewerZone = resolvedTimeZone(options.timeZone);
  const sourceDisplayZone = displayZoneFor(series, options);
  const targetKind = targetTemporalKind(series, patch);
  const targetZone = targetKind === "zoned"
    ? patch.temporal && patch.temporal !== null && patch.temporal.kind === "zoned"
      ? patch.temporal.timeZone ?? sourceDisplayZone
      : series.temporal?.timeZone ?? sourceDisplayZone
    : viewerZone;
  const patchInputZone = series.temporal?.kind === "zoned" ? sourceDisplayZone : targetZone;
  const disambiguation = patch.temporal && patch.temporal !== null
    ? patch.temporal.disambiguation ?? series.temporal?.disambiguation ?? "compatible"
    : series.temporal?.disambiguation ?? "compatible";

  const anchorStartPlain = displayPlain(series.start, sourceDisplayZone);
  const anchorEndPlain = displayPlain(series.end, sourceDisplayZone);
  const resolvedStartPlain = instantToPlain(toDate(resolved.start).getTime(), sourceDisplayZone);
  const resolvedEndPlain = instantToPlain(toDate(resolved.end).getTime(), sourceDisplayZone);

  let startPlain = anchorStartPlain;
  let endPlain = anchorEndPlain;
  if (patch.start !== undefined) {
    const desiredStartPlain = displayPlain(patch.start, patchInputZone);
    const delta = plainMinutesBetween(resolvedStartPlain, desiredStartPlain);
    startPlain = addPlainMinutes(anchorStartPlain, delta);
    if (patch.end === undefined) endPlain = addPlainMinutes(anchorEndPlain, delta);
  }
  if (patch.end !== undefined) {
    const desiredEndPlain = displayPlain(patch.end, patchInputZone);
    const delta = plainMinutesBetween(resolvedEndPlain, desiredEndPlain);
    endPlain = addPlainMinutes(anchorEndPlain, delta);
  }

  return {
    ...patch,
    ...(patch.start !== undefined ? { start: serializeProjectedPlain(startPlain, targetKind, targetZone, disambiguation) } : {}),
    ...(patch.end !== undefined || patch.start !== undefined ? { end: serializeProjectedPlain(endPlain, targetKind, targetZone, disambiguation) } : {}),
  };
}

/** Rebase generic recurrence exceptions by temporal occurrence ordinal after a series rule/anchor edit. */
export function rebaseTemporalSeriesExceptions<TPatch extends CalendarTemporalSeriesPatch>(
  previous: CalendarTemporalSeries,
  previousRecurrence: CalendarTemporalSeriesRecurrence<TPatch> | undefined,
  next: CalendarTemporalSeries,
  nextRecurrence: CalendarTemporalSeriesRecurrence<TPatch> | undefined,
  options: RecurrenceExpansionOptions = {},
): CalendarTemporalSeriesRecurrence<TPatch> | undefined {
  if (!nextRecurrence) return undefined;
  if (!previousRecurrence?.exceptions?.length) return nextRecurrence;
  const rebased: CalendarTemporalSeriesException<TPatch>[] = [];
  for (const exception of previousRecurrence.exceptions) {
    try {
      const ordinal = temporalSeriesOrdinal(previous, previousRecurrence.rule, exception.originalStart, options);
      const originalStart = temporalSeriesIdentityAtOrdinal(next, nextRecurrence.rule, ordinal, options);
      rebased.push({ ...exception, originalStart });
    } catch {
      // The edited rule no longer has a corresponding occurrence; dropping the orphan is safer than misapplying it.
    }
  }
  return { ...nextRecurrence, ...(rebased.length ? { exceptions: rebased } : { exceptions: undefined }) };
}

export function resolveTemporalSeriesAnchor(
  series: CalendarTemporalSeries,
  rule?: RecurrenceRule,
  options: RecurrenceExpansionOptions = {},
): CalendarResolvedTemporalRange {
  if (rule) validateRecurrenceRule(rule);
  const candidate = resolveAnchor(series, contextFor(series, options));
  return {
    originalStart: candidate.identity,
    start: new Date(candidate.startEpochMs).toISOString(),
    end: new Date(candidate.endEpochMs).toISOString(),
    recurring: Boolean(rule),
  };
}

export function temporalSeriesIdentityAtOrdinal(
  series: CalendarTemporalSeries,
  rule: RecurrenceRule | undefined,
  ordinal: number,
  options: RecurrenceExpansionOptions = {},
): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new RangeError("ordinal must be a positive integer");
  if (!rule && ordinal !== 1) throw new RangeError("Non-recurring temporal series has only one occurrence");
  let index = 0;
  for (const candidate of resolvedCandidates(series, rule, options)) {
    index += 1;
    if (index === ordinal) return candidate.identity;
    if (index >= (rule?.count ?? MAX_OCCURRENCES)) break;
  }
  throw new RangeError(`Temporal series ${series.id} has no occurrence ${ordinal}`);
}

export function temporalSeriesOrdinal(
  series: CalendarTemporalSeries,
  rule: RecurrenceRule | undefined,
  originalStart: ISODateTime | Date,
  options: RecurrenceExpansionOptions = {},
): number {
  if (!rule) return 1;
  validateRecurrenceRule(rule);
  const target = canonicalIdentity(series, originalStart, options);
  let ordinal = 0;
  for (const candidate of resolvedCandidates(series, rule, options)) {
    ordinal += 1;
    if (candidate.identity === target) return ordinal;
    if (ordinal >= (rule.count ?? MAX_OCCURRENCES)) break;
  }
  throw new Error(`Occurrence ${String(originalStart)} is not part of temporal series ${series.id}`);
}

/**
 * Expand a generic temporal series into resolved absolute ranges.
 * Candidate generation, timezone/DST handling and temporal exception geometry are shared by all consumers.
 * The caller owns semantic fields and maps the resolved ranges into its own domain objects.
 */
export function expandTemporalSeries<TPatch extends CalendarTemporalSeriesPatch = CalendarTemporalSeriesPatch>(
  series: CalendarTemporalSeries,
  recurrence: CalendarTemporalSeriesRecurrence<TPatch> | undefined,
  range: CalendarRange,
  options: RecurrenceExpansionOptions = {},
): CalendarResolvedTemporalRange<TPatch>[] {
  const rangeStart = toDate(range.start).getTime();
  const rangeEnd = toDate(range.end).getTime();
  if (rangeEnd <= rangeStart) throw new RangeError("Calendar range end must be after start");
  if (recurrence) validateRecurrenceRule(recurrence.rule);

  const exceptions = new Map<string, CalendarTemporalSeriesException<TPatch>>();
  for (const exception of recurrence?.exceptions ?? []) {
    const identity = canonicalIdentity(series, exception.originalStart, options);
    if (exceptions.has(identity)) throw new Error(`Temporal series ${series.id} has duplicate recurrence exception ${exception.originalStart}`);
    if (exception.cancelled && exception.replacement) throw new Error(`Temporal series ${series.id} recurrence exception cannot be cancelled and replaced`);
    exceptions.set(identity, exception);
  }

  const out: CalendarResolvedTemporalRange<TPatch>[] = [];
  const remainingExceptions = new Set(exceptions.keys());
  for (const candidate of resolvedCandidates(series, recurrence?.rule, options)) {
    const exception = exceptions.get(candidate.identity);
    remainingExceptions.delete(candidate.identity);
    if (!exception?.cancelled) {
      const patch = exception?.replacement;
      const startEpoch = patch?.start !== undefined ? patchInstant(series, patch.start, options) : candidate.startEpochMs;
      const endEpoch = patch?.end !== undefined
        ? patchInstant(series, patch.end, options)
        : patch?.start !== undefined
          ? startEpoch + (candidate.endEpochMs - candidate.startEpochMs)
          : candidate.endEpochMs;
      if (series.temporalForm === "point" ? startEpoch !== endEpoch : endEpoch <= startEpoch) {
        throw new RangeError(`Temporal series ${series.id} exception produces invalid chronology`);
      }
      const start = new Date(startEpoch).toISOString();
      const end = new Date(endEpoch).toISOString();
      if (intersectsRange(start, end, range.start, range.end, series.temporalForm === "point")) {
        out.push({
          originalStart: candidate.identity,
          start,
          end,
          recurring: Boolean(recurrence),
          ...(exception ? { exception } : {}),
        });
      }
    }
    if (candidate.startEpochMs >= rangeEnd && remainingExceptions.size === 0) break;
  }
  return out;
}

function* resolvedCandidates(
  series: CalendarTemporalSeries,
  rule: RecurrenceRule | undefined,
  options: RecurrenceExpansionOptions,
): Generator<ResolvedCandidate> {
  const ctx = contextFor(series, options);
  const anchor = resolveAnchor(series, ctx);
  yield anchor;
  if (!rule) return;
  const until = rule.until;
  let yielded = 1;
  for (const plain of recurrencePlainCandidates(ctx.startPlain, rule)) {
    if (comparePlain(plain, ctx.startPlain) <= 0) continue;
    const resolved = resolveCandidate(series, ctx, plain, false);
    if (!resolved) continue; // RFC 5545: nonexistent recurring local times are ignored and do not count.
    if (!withinUntil(series, resolved, until, options)) return;
    yield resolved;
    yielded += 1;
    if (yielded >= (rule.count ?? MAX_OCCURRENCES)) return;
  }
}

function* recurrencePlainCandidates(anchor: PlainDateTimeParts, rule: RecurrenceRule): Generator<PlainDateTimeParts> {
  const interval = rule.interval ?? 1;
  for (let period = 0; period < MAX_OCCURRENCES; period += 1) {
    let set: PlainDateTimeParts[];
    if (rule.frequency === "daily") set = dailySet(anchor, rule, period * interval);
    else if (rule.frequency === "weekly") set = weeklySet(anchor, rule, period * interval);
    else if (rule.frequency === "monthly") set = monthlySet(anchor, rule, period * interval);
    else set = yearlySet(anchor, rule, period * interval);
    set = applySetPosition(uniqueSorted(set), rule.bySetPosition);
    for (const candidate of set) yield candidate;
  }
}

function dailySet(anchor: PlainDateTimeParts, rule: RecurrenceRule, dayOffset: number): PlainDateTimeParts[] {
  const candidate = addPlainDays(anchor, dayOffset);
  return matchesGeneral(candidate, rule) ? [candidate] : [];
}

function weeklySet(anchor: PlainDateTimeParts, rule: RecurrenceRule, weekOffset: number): PlainDateTimeParts[] {
  const weekStartsOn = rule.weekStartsOn ?? 1;
  const anchorWeekday = weekdayOf(anchor);
  const base = addPlainDays(anchor, -((anchorWeekday - weekStartsOn + 7) % 7) + weekOffset * 7);
  const days = simpleByDays(rule).length ? simpleByDays(rule).map(entry => entry.weekday) : [anchorWeekday];
  return [...new Set(days)]
    .sort((a, b) => ((a - weekStartsOn + 7) % 7) - ((b - weekStartsOn + 7) % 7))
    .map(weekday => addPlainDays(base, (weekday - weekStartsOn + 7) % 7))
    .filter(candidate => matchesGeneral(candidate, { ...rule, byDay: undefined, byWeekday: undefined }));
}

function monthlySet(anchor: PlainDateTimeParts, rule: RecurrenceRule, monthOffset: number): PlainDateTimeParts[] {
  const first = addPlainMonths({ ...anchor, day: 1 }, monthOffset, "reject");
  if (!first || (rule.byMonth?.length && !rule.byMonth.includes(first.month))) return [];
  return monthCandidates(first.year, first.month, anchor, rule);
}

function yearlySet(anchor: PlainDateTimeParts, rule: RecurrenceRule, yearOffset: number): PlainDateTimeParts[] {
  const year = anchor.year + yearOffset;
  const months = rule.byMonth?.length ? [...new Set(rule.byMonth)].sort((a, b) => a - b) : [anchor.month];
  return months.flatMap(month => monthCandidates(year, month, anchor, rule));
}

function monthCandidates(year: number, month: number, anchor: PlainDateTimeParts, rule: RecurrenceRule): PlainDateTimeParts[] {
  const last = daysInMonth(year, month);
  const byDays = combinedByDays(rule);
  let days: number[];
  if (rule.byMonthDay?.length) {
    days = rule.byMonthDay.map(value => value > 0 ? value : last + value + 1).filter(day => day >= 1 && day <= last);
  } else if (byDays.length) {
    days = [];
    for (const entry of byDays) {
      if (entry.ordinal === undefined) {
        for (let day = 1; day <= last; day += 1) {
          const candidate = withDate(anchor, year, month, day);
          if (weekdayOf(candidate) === entry.weekday) days.push(day);
        }
      } else {
        const selected = ordinalWeekdayOfMonth(year, month, entry.weekday, entry.ordinal);
        if (selected !== null) days.push(selected);
      }
    }
  } else {
    days = anchor.day <= last ? [anchor.day] : [];
  }
  const candidates = [...new Set(days)].sort((a, b) => a - b).map(day => withDate(anchor, year, month, day));
  if (!rule.byMonthDay?.length || !byDays.length) return candidates;
  return candidates.filter(candidate => byDays.some(entry => byDayMatchesMonth(candidate, entry)));
}

function matchesGeneral(candidate: PlainDateTimeParts, rule: RecurrenceRule): boolean {
  if (rule.byMonth?.length && !rule.byMonth.includes(candidate.month)) return false;
  if (rule.byMonthDay?.length) {
    const last = daysInMonth(candidate.year, candidate.month);
    if (!rule.byMonthDay.some(value => candidate.day === (value > 0 ? value : last + value + 1))) return false;
  }
  const days = simpleByDays(rule);
  return !days.length || days.some(entry => entry.weekday === weekdayOf(candidate));
}

function combinedByDays(rule: RecurrenceRule): RecurrenceByDay[] {
  if (rule.byDay?.length) return [...rule.byDay];
  return (rule.byWeekday ?? []).map(weekday => ({ weekday }));
}

function simpleByDays(rule: RecurrenceRule): RecurrenceByDay[] {
  return combinedByDays(rule).filter(entry => entry.ordinal === undefined);
}

function byDayMatchesMonth(candidate: PlainDateTimeParts, entry: RecurrenceByDay): boolean {
  if (weekdayOf(candidate) !== entry.weekday) return false;
  if (entry.ordinal === undefined) return true;
  return ordinalWeekdayOfMonth(candidate.year, candidate.month, entry.weekday, entry.ordinal) === candidate.day;
}

function ordinalWeekdayOfMonth(year: number, month: number, weekday: Weekday, ordinal: number): number | null {
  const last = daysInMonth(year, month);
  const matching: number[] = [];
  for (let day = 1; day <= last; day += 1) {
    if (weekdayOf({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 }) === weekday) matching.push(day);
  }
  const index = ordinal > 0 ? ordinal - 1 : matching.length + ordinal;
  return matching[index] ?? null;
}

function applySetPosition(set: PlainDateTimeParts[], positions: readonly number[] | undefined): PlainDateTimeParts[] {
  if (!positions?.length) return set;
  const out: PlainDateTimeParts[] = [];
  for (const position of positions) {
    const index = position > 0 ? position - 1 : set.length + position;
    const item = set[index];
    if (item) out.push(item);
  }
  return uniqueSorted(out);
}

function uniqueSorted(values: PlainDateTimeParts[]): PlainDateTimeParts[] {
  const map = new Map(values.map(value => [formatPlainDateTime(value), value]));
  return [...map.values()].sort(comparePlain);
}

function displayZoneFor(series: CalendarTemporalSeries, options: RecurrenceExpansionOptions): string {
  const viewer = resolvedTimeZone(options.timeZone);
  return series.temporal?.kind === "zoned" ? series.temporal.timeZone ?? viewer : viewer;
}

function displayPlain(value: ISODateTime, zone: string): PlainDateTimeParts {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parsePlainDate(value);
  return hasExplicitOffset(value) ? instantToPlain(toDate(value).getTime(), zone) : parsePlainDateTime(value);
}

function targetTemporalKind(series: CalendarTemporalSeries, patch: CalendarTemporalSeriesEditPatch): CalendarTemporalKind {
  if (patch.temporal && patch.temporal !== null) return patch.temporal.kind;
  if (patch.temporal === null) {
    const value = patch.start ?? series.start;
    if (patch.allDay || patch.precision === "date" || /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    return hasExplicitOffset(value) ? "instant" : "floating";
  }
  return series.temporal?.kind ?? (series.allDay || series.precision === "date" ? "date" : hasExplicitOffset(series.start) ? "instant" : "floating");
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

function contextFor(series: CalendarTemporalSeries, options: RecurrenceExpansionOptions): TemporalContext {
  if (typeof series.id !== "string" || !series.id.trim()) throw new Error("Temporal series id is required");
  const viewerZone = resolvedTimeZone(options.timeZone);
  const explicitKind = series.temporal?.kind;
  const kind: CalendarTemporalKind = explicitKind ?? (series.allDay || series.precision === "date" ? "date" : hasExplicitOffset(series.start) ? "instant" : "floating");
  const zone = kind === "instant" ? "UTC" : kind === "zoned" ? series.temporal?.timeZone ?? viewerZone : viewerZone;
  if (kind === "zoned" && !series.temporal?.timeZone) throw new RangeError(`Zoned temporal series ${series.id} requires temporal.timeZone`);
  const startPlain = sourcePlain(series.start, kind, zone, viewerZone);
  const endPlain = sourcePlain(series.end, kind, zone, viewerZone);
  const elapsedDurationMs = sourceInstant(series.end, kind, zone, viewerZone) - sourceInstant(series.start, kind, zone, viewerZone);
  const wallDurationMinutes = plainMinutesBetween(startPlain, endPlain);
  const rawDateDurationDays = plainDaysBetween(startPlain, endPlain);
  const point = series.temporalForm === "point";
  if (point) {
    if (kind === "date" || series.allDay || series.precision === "date") throw new RangeError(`Temporal series ${series.id} point temporal form cannot be date-only or all-day`);
    if (wallDurationMinutes !== 0 || elapsedDurationMs !== 0) throw new RangeError(`Temporal series ${series.id} point temporal form requires start and end to be identical`);
  } else if (kind === "date") {
    if (rawDateDurationDays <= 0) throw new RangeError(`Temporal series ${series.id} must end after it starts`);
  } else if (wallDurationMinutes <= 0 && elapsedDurationMs <= 0) {
    throw new RangeError(`Temporal series ${series.id} must end after it starts`);
  }
  return {
    kind,
    timeZone: zone,
    startPlain,
    endPlain,
    elapsedDurationMs,
    wallDurationMinutes,
    dateDurationDays: Math.max(1, rawDateDurationDays),
    point,
  };
}

function resolveAnchor(series: CalendarTemporalSeries, ctx: TemporalContext): ResolvedCandidate {
  return resolveCandidate(series, ctx, ctx.startPlain, true)!;
}

function resolveCandidate(series: CalendarTemporalSeries, ctx: TemporalContext, plain: PlainDateTimeParts, anchor: boolean): ResolvedCandidate | null {
  let startEpochMs: number;
  if (ctx.kind === "instant") startEpochMs = Date.UTC(plain.year, plain.month - 1, plain.day, plain.hour, plain.minute, plain.second, plain.millisecond);
  else if (ctx.kind === "date") startEpochMs = plainToInstant({ ...plain, hour: 0, minute: 0, second: 0, millisecond: 0 }, ctx.timeZone, "compatible");
  else if (anchor) startEpochMs = plainToInstant(plain, ctx.timeZone, series.temporal?.disambiguation ?? "compatible");
  else {
    const recurrenceEpoch = recurrencePlainToInstant(plain, ctx.timeZone);
    if (recurrenceEpoch === null) return null;
    startEpochMs = recurrenceEpoch;
  }

  let endEpochMs: number;
  if (ctx.point) endEpochMs = startEpochMs;
  else if (ctx.kind === "instant") endEpochMs = startEpochMs + ctx.elapsedDurationMs;
  else if (ctx.kind === "date") {
    const endPlain = addPlainDays({ ...plain, hour: 0, minute: 0, second: 0, millisecond: 0 }, ctx.dateDurationDays);
    endEpochMs = plainToInstant(endPlain, ctx.timeZone, "compatible");
  } else {
    const endPlain = addPlainMinutes(plain, ctx.wallDurationMinutes);
    endEpochMs = plainToInstant(endPlain, ctx.timeZone, series.temporal?.disambiguation ?? "compatible");
  }
  return { plain, identity: identityForPlain(plain, ctx.kind), startEpochMs, endEpochMs };
}

function withinUntil(series: CalendarTemporalSeries, candidate: ResolvedCandidate, until: string | undefined, options: RecurrenceExpansionOptions): boolean {
  if (!until) return true;
  const ctx = contextFor(series, options);
  if (ctx.kind === "instant" || (ctx.kind === "zoned" && hasExplicitOffset(until))) return candidate.startEpochMs <= toDate(until).getTime();
  const untilPlain = ctx.kind === "date" ? parsePlainDate(until.slice(0, 10)) : parseTemporalPlain(until, ctx.timeZone);
  return comparePlain(candidate.plain, untilPlain) <= 0;
}

function sourcePlain(value: string, kind: CalendarTemporalKind, zone: string, viewerZone: string): PlainDateTimeParts {
  if (kind === "date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parsePlainDate(value);
    return instantToPlain(toDate(value).getTime(), viewerZone);
  }
  if (kind === "instant") return instantToPlain(toDate(value).getTime(), "UTC");
  if (hasExplicitOffset(value)) return instantToPlain(toDate(value).getTime(), zone);
  return parsePlainDateTime(value);
}

function sourceInstant(value: string, kind: CalendarTemporalKind, zone: string, viewerZone: string): number {
  if (kind === "instant") return toDate(value).getTime();
  const plain = sourcePlain(value, kind, zone, viewerZone);
  return plainToInstant(plain, kind === "date" ? viewerZone : zone, "compatible");
}

function patchInstant(series: CalendarTemporalSeries, value: string, options: RecurrenceExpansionOptions): number {
  if (hasExplicitOffset(value)) return toDate(value).getTime();
  const ctx = contextFor(series, options);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return plainToInstant(parsePlainDate(value), ctx.timeZone, "compatible");
  return plainToInstant(parsePlainDateTime(value), ctx.timeZone, series.temporal?.disambiguation ?? "compatible");
}

function canonicalIdentity(series: CalendarTemporalSeries, value: ISODateTime | Date, options: RecurrenceExpansionOptions): string {
  const ctx = contextFor(series, options);
  if (value instanceof Date) {
    const plain = instantToPlain(value.getTime(), ctx.timeZone);
    return ctx.kind === "instant" ? value.toISOString() : identityForPlain(plain, ctx.kind);
  }
  if (ctx.kind === "instant") return toDate(value).toISOString();
  if (ctx.kind === "date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return formatPlainDate(instantToPlain(toDate(value).getTime(), ctx.timeZone));
  }
  if (!hasExplicitOffset(value)) return formatPlainDateTime(parsePlainDateTime(value));
  return formatPlainDateTime(instantToPlain(toDate(value).getTime(), ctx.timeZone));
}

function identityForPlain(plain: PlainDateTimeParts, kind: CalendarTemporalKind): string {
  if (kind === "date") return formatPlainDate(plain);
  if (kind === "instant") return new Date(Date.UTC(plain.year, plain.month - 1, plain.day, plain.hour, plain.minute, plain.second, plain.millisecond)).toISOString();
  return formatPlainDateTime(plain);
}

function parseTemporalPlain(value: string, timeZone: string): PlainDateTimeParts {
  return hasExplicitOffset(value) ? instantToPlain(toDate(value).getTime(), timeZone) : parsePlainDateTime(value);
}

function withDate(anchor: PlainDateTimeParts, year: number, month: number, day: number): PlainDateTimeParts {
  return { ...anchor, year, month, day };
}
