import type { CalendarResolvedWeekNumbering, CalendarWeekNumbersOptions } from "./types.js";

interface WeekInfoLike {
  readonly minimalDays?: unknown;
}

interface LocaleWithWeekInfo extends Intl.Locale {
  readonly weekInfo?: WeekInfoLike;
  getWeekInfo?(): WeekInfoLike;
}

function localeMinimumDaysInFirstWeek(locale: string): number {
  try {
    const resolved = new Intl.Locale(locale) as LocaleWithWeekInfo;
    const info = typeof resolved.getWeekInfo === "function"
      ? resolved.getWeekInfo()
      : resolved.weekInfo;
    const value = Number(info?.minimalDays);
    if (Number.isInteger(value) && value >= 1 && value <= 7) return value;
  } catch {
    // Deterministic fallback below.
  }
  return 4;
}

export function resolveCalendarWeekNumbering(
  locale: string,
  weekNumbers: boolean | CalendarWeekNumbersOptions | undefined,
): CalendarResolvedWeekNumbering | undefined {
  if (weekNumbers === undefined || weekNumbers === false) return undefined;
  if (weekNumbers !== true && (!weekNumbers || typeof weekNumbers !== "object" || Array.isArray(weekNumbers))) {
    throw new TypeError("weekNumbers must be a boolean or configuration object");
  }
  if (weekNumbers !== true && Object.keys(weekNumbers).some(key => key !== "minimumDaysInFirstWeek")) {
    throw new TypeError("weekNumbers contains an unexpected field");
  }
  const explicit = weekNumbers === true ? undefined : weekNumbers.minimumDaysInFirstWeek;
  if (explicit !== undefined && (!Number.isInteger(explicit) || explicit < 1 || explicit > 7)) {
    throw new RangeError("minimumDaysInFirstWeek must be an integer from 1 through 7");
  }
  return Object.freeze({
    minimumDaysInFirstWeek: explicit ?? localeMinimumDaysInFirstWeek(locale),
  });
}
