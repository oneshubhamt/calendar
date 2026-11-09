import { addPlainDays, assertTimeZone, instantToPlain, type PlainDateTimeParts } from "../core/temporal.js";
import { civilMinuteResolution } from "../core/civil-timeline.js";

export type CalendarSecondaryTimeScaleTransition = "none" | "gap" | "overlap";

export interface CalendarSecondaryTimeScaleLabel {
  readonly hour: number;
  readonly text: string;
  readonly accessibleLabel: string;
  readonly variesAcrossDays: boolean;
  readonly transition: CalendarSecondaryTimeScaleTransition;
}

export function resolveSecondaryTimeZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) return undefined;
  const value = timeZone.trim();
  if (!value) throw new RangeError("secondaryTimeZone must be a valid IANA time zone");
  return assertTimeZone(value);
}

/**
 * Build secondary-zone labels for primary civil wall-clock hour lines.
 * Geometry remains entirely primary-zone owned. Non-existent primary hours are
 * represented as gaps; repeated primary hours expose both corresponding instants.
 */
export function secondaryTimeScaleLabels(
  days: readonly Date[],
  primaryTimeZone: string,
  secondaryTimeZone: string,
  startHour: number,
  endHour: number,
  locale = "en-US",
): readonly CalendarSecondaryTimeScaleLabel[] {
  assertTimeZone(primaryTimeZone);
  assertTimeZone(secondaryTimeZone);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || startHour >= endHour) {
    throw new RangeError("Time-scale hours must be an integer range within 0..24");
  }
  if (days.length === 0) return [];

  return Array.from({ length: endHour - startHour }, (_, index) => {
    const hour = startHour + index;
    const entries = days.map(day => secondaryEntry(day, hour, primaryTimeZone, secondaryTimeZone, locale));
    const distinct = [...new Set(entries.map(entry => entry.text))];
    const transitions = new Set(entries.map(entry => entry.transition));
    const text = distinct.length <= 2 ? distinct.join(" / ") : `${distinct[0]} … ${distinct[distinct.length - 1]}`;
    const transition: CalendarSecondaryTimeScaleTransition = transitions.has("gap") ? "gap" : transitions.has("overlap") ? "overlap" : "none";
    return {
      hour,
      text,
      accessibleLabel: entries.map(entry => entry.accessibleLabel).join("; "),
      variesAcrossDays: distinct.length > 1 || transition !== "none",
      transition,
    };
  });
}

function secondaryEntry(
  day: Date,
  hour: number,
  primaryTimeZone: string,
  secondaryTimeZone: string,
  locale: string,
): { readonly text: string; readonly accessibleLabel: string; readonly transition: CalendarSecondaryTimeScaleTransition } {
  const primaryDay = instantToPlain(day.getTime(), primaryTimeZone);
  const shiftedDay = addPlainDays({ ...primaryDay, hour: 0, minute: 0, second: 0, millisecond: 0 }, Math.floor(hour / 24));
  const wallHour = ((hour % 24) + 24) % 24;
  const resolved = civilMinuteResolution(day, Math.floor(hour / 24) * 1440 + wallHour * 60, primaryTimeZone).instants;
  const primaryDayLabel = civilDateLabel(shiftedDay, locale);

  if (resolved.length === 0) {
    return {
      text: "— gap",
      accessibleLabel: `${primaryDayLabel} ${pad(wallHour)}:00 does not occur in ${primaryTimeZone} because of a time-zone transition`,
      transition: "gap",
    };
  }

  const secondaryValues = resolved.map(instant => secondaryValue(instant, shiftedDay, secondaryTimeZone, locale));
  const text = secondaryValues.map(value => value.text).join(" / ");
  if (resolved.length > 1) {
    return {
      text,
      accessibleLabel: `${primaryDayLabel} ${pad(wallHour)}:00 occurs twice in ${primaryTimeZone}; the corresponding times in ${secondaryTimeZone} are ${secondaryValues.map(value => value.longText).join(" and ")}`,
      transition: "overlap",
    };
  }
  return {
    text,
    accessibleLabel: `${primaryDayLabel} ${pad(wallHour)}:00 is ${secondaryValues[0]!.longText} in ${secondaryTimeZone}`,
    transition: "none",
  };
}

function secondaryValue(instant: number, primaryDay: PlainDateTimeParts, secondaryTimeZone: string, locale: string): { readonly text: string; readonly longText: string } {
  const secondary = instantToPlain(instant, secondaryTimeZone);
  const dayDelta = civilDayScalar(secondary.year, secondary.month, secondary.day) - civilDayScalar(primaryDay.year, primaryDay.month, primaryDay.day);
  const time = `${pad(secondary.hour)}:${pad(secondary.minute)}`;
  const suffix = dayDelta === 0 ? "" : ` ${dayDelta > 0 ? "+" : ""}${dayDelta}d`;
  return { text: `${time}${suffix}`, longText: `${civilDateLabel(secondary, locale)} ${time}` };
}

function civilDateLabel(parts: PlainDateTimeParts, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

function civilDayScalar(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
