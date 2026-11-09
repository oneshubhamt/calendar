import type { CalendarTemporalKind, RecurrenceByDay, RecurrenceRule, Weekday } from "../core/types.js";
import { validateRecurrenceRule } from "../core/recurrence.js";
import { formatPlainDateTime, parsePlainDate, plainToInstant } from "../core/temporal.js";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const CODE_TO_WEEKDAY = new Map<string, Weekday>(WEEKDAY_CODES.map((code, index) => [code, index as Weekday]));

export function recurrenceUntilFromEditor(dateValue: string, temporalKind: CalendarTemporalKind, timeZone: string): string {
  const date = parsePlainDate(dateValue);
  if (temporalKind === "date") return dateValue;
  const endOfDate = { ...date, hour: 23, minute: 59, second: 0, millisecond: 0 };
  if (temporalKind === "zoned" || temporalKind === "floating") return formatPlainDateTime(endOfDate);
  return new Date(plainToInstant(endOfDate, timeZone, "compatible")).toISOString();
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

export function formatRecurrenceIntegerList(values: readonly number[] | undefined): string {
  return values?.join(", ") ?? "";
}

export function parseRecurrenceIntegerList(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
  allowZero = false,
): readonly number[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const values = trimmed.split(/[\s,]+/u).filter(Boolean).map(token => Number(token));
  if (!values.length || values.some(number => !Number.isInteger(number) || number < minimum || number > maximum || (!allowZero && number === 0))) {
    throw new RangeError(`${label} must contain whole numbers from ${minimum} to ${maximum}${allowZero ? "" : ", excluding 0"}`);
  }
  return uniqueNumbers(values);
}

export function formatRecurrenceByDay(values: readonly RecurrenceByDay[] | undefined): string {
  if (!values?.length) return "";
  return values.map(value => `${value.ordinal ?? ""}${WEEKDAY_CODES[value.weekday]}`).join(", ");
}

export function parseRecurrenceByDay(value: string): readonly RecurrenceByDay[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const result: RecurrenceByDay[] = [];
  const seen = new Set<string>();
  for (const raw of trimmed.split(/[\s,]+/u).filter(Boolean)) {
    const token = raw.toUpperCase();
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/u.exec(token);
    if (!match) throw new RangeError("Weekday rules use RFC-style values such as MO, WE, 2TU or -1FR");
    const weekday = CODE_TO_WEEKDAY.get(match[2]!);
    if (weekday === undefined) throw new RangeError(`Unknown weekday ${match[2]}`);
    const ordinal = match[1] === undefined ? undefined : Number(match[1]);
    if (ordinal !== undefined && (!Number.isInteger(ordinal) || ordinal === 0 || ordinal < -53 || ordinal > 53)) {
      throw new RangeError("Weekday ordinals must be whole numbers from -53 to 53, excluding 0");
    }
    const key = `${ordinal ?? ""}:${weekday}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ordinal === undefined ? { weekday } : { weekday, ordinal });
  }
  return result;
}

export interface RecurrenceAdvancedFields {
  readonly byMonthDay: string;
  readonly byMonth: string;
  readonly byDay: string;
  readonly bySetPosition: string;
}

export function recurrenceAdvancedFields(rule: RecurrenceRule | undefined): RecurrenceAdvancedFields {
  const advancedByDay = rule?.frequency === "weekly"
    ? undefined
    : rule?.byDay ?? rule?.byWeekday?.map(weekday => ({ weekday }));
  return {
    byMonthDay: formatRecurrenceIntegerList(rule?.byMonthDay),
    byMonth: formatRecurrenceIntegerList(rule?.byMonth),
    byDay: formatRecurrenceByDay(advancedByDay),
    bySetPosition: formatRecurrenceIntegerList(rule?.bySetPosition),
  };
}

export function recurrenceAdvancedRulePatch(fields: RecurrenceAdvancedFields): Pick<RecurrenceRule, "byMonthDay" | "byMonth" | "byDay" | "bySetPosition"> {
  return {
    byMonthDay: parseRecurrenceIntegerList(fields.byMonthDay, "Month days", -31, 31),
    byMonth: parseRecurrenceIntegerList(fields.byMonth, "Months", 1, 12),
    byDay: parseRecurrenceByDay(fields.byDay),
    bySetPosition: parseRecurrenceIntegerList(fields.bySetPosition, "Set positions", -366, 366),
  };
}

export interface RecurrenceRuleEditorInput {
  readonly frequency: RecurrenceRule["frequency"];
  readonly interval: number;
  readonly weekStartsOn: Weekday;
  readonly checkedWeekdays: readonly Weekday[];
  readonly startMonth: number;
  readonly startMonthDay: number;
  readonly advanced: RecurrenceAdvancedFields;
  readonly count?: number | undefined;
  readonly until?: string | undefined;
}

/** Convert the editor's simple + advanced controls into the canonical recurrence rule. */
export function recurrenceRuleFromEditor(input: RecurrenceRuleEditorInput): RecurrenceRule {
  const advanced = recurrenceAdvancedRulePatch(input.advanced);
  const hasAdvancedDayRule = Boolean(advanced.byDay?.length);
  const hasAdvancedMonthDay = Boolean(advanced.byMonthDay?.length);
  const hasAdvancedMonth = Boolean(advanced.byMonth?.length);
  if (advanced.bySetPosition?.length && !hasAdvancedDayRule && !hasAdvancedMonthDay && !hasAdvancedMonth) {
    throw new RangeError("BYSETPOS requires another advanced recurrence filter");
  }
  const checkedWeekdays = [...new Set(input.checkedWeekdays)];
  const rule: RecurrenceRule = {
    frequency: input.frequency,
    interval: Math.max(1, Math.round(input.interval) || 1),
    ...advanced,
    ...(input.frequency === "weekly" && !hasAdvancedDayRule ? { byWeekday: checkedWeekdays.length ? checkedWeekdays : undefined } : {}),
    ...(input.frequency === "monthly" && !hasAdvancedDayRule && !hasAdvancedMonthDay ? { byMonthDay: [input.startMonthDay] } : {}),
    ...(input.frequency === "yearly" && !hasAdvancedDayRule && !hasAdvancedMonthDay ? { byMonthDay: [input.startMonthDay] } : {}),
    ...(input.frequency === "yearly" && !hasAdvancedMonth ? { byMonth: [input.startMonth] } : {}),
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    weekStartsOn: input.weekStartsOn,
  };
  validateRecurrenceRule(rule);
  return rule;
}
