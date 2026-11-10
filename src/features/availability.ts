import type {
  CalendarBackgroundDisplay,
  CalendarBackgroundProjectionProvider,
  CalendarBackgroundRange,
  CalendarId,
  CalendarMetadata,
  CalendarPlacementGuard,
  CalendarRange,
  CalendarTemporalSpec,
  ISODateTime,
  RecurrenceRule,
} from "../core/types.js";
import {
  expandTemporalSeries,
  type CalendarTemporalSeriesException,
  type CalendarTemporalSeriesPatch,
  type CalendarTemporalSeriesRecurrence,
} from "../core/recurrence.js";
import { assertCalendarMetadataIntegrity } from "../core/store.js";

export type CalendarAvailabilityState = "available" | "unavailable";

export interface CalendarAvailabilityExceptionReplacement extends CalendarTemporalSeriesPatch {
  readonly state?: CalendarAvailabilityState | undefined;
  readonly calendarId?: CalendarId | undefined;
  readonly label?: string | undefined;
  readonly display?: CalendarBackgroundDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarAvailabilityRecurrence extends CalendarTemporalSeriesRecurrence<CalendarAvailabilityExceptionReplacement> {
  readonly rule: RecurrenceRule;
  readonly exceptions?: readonly CalendarTemporalSeriesException<CalendarAvailabilityExceptionReplacement>[];
}

export interface CalendarAvailabilityDefinition {
  readonly id: string;
  readonly state: CalendarAvailabilityState;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly temporal?: CalendarTemporalSpec | undefined;
  readonly recurrence?: CalendarAvailabilityRecurrence | undefined;
  /** Optional association with a real Calendar source; the feature itself owns no source or persistence. */
  readonly calendarId?: CalendarId | undefined;
  readonly label?: string | undefined;
  readonly display?: CalendarBackgroundDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarAvailabilityExpansionOptions {
  /** Viewer/local day zone used for floating and date-only definitions. */
  readonly timeZone: string;
}

export interface CalendarAvailabilityProviderOptions extends CalendarAvailabilityExpansionOptions {
  readonly id: string;
  /** Read authoritative definitions on every projection request; no availability state is copied into Calendar storage. */
  readonly definitions: () => readonly CalendarAvailabilityDefinition[];
  readonly subscribe?: ((listener: () => void) => () => void) | undefined;
}

export type CalendarAvailabilityPlacementPolicy = "exclude-unavailable" | "require-available";

export interface CalendarAvailabilityPlacementGuardOptions extends CalendarAvailabilityExpansionOptions {
  readonly id: string;
  readonly definitions: () => readonly CalendarAvailabilityDefinition[];
  readonly policy: CalendarAvailabilityPlacementPolicy;
  /** Explicit enforcement strength. Availability backgrounds remain non-enforcing unless this guard is installed. */
  readonly mode: "warn" | "prevent";
  readonly message?: string | undefined;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function validateDisplay(display: CalendarBackgroundDisplay | undefined, label: string): void {
  if (display === undefined) return;
  if (!display || typeof display !== "object" || Array.isArray(display)) throw new Error(`${label} display is invalid`);
  for (const key of ["color", "textColor", "className"] as const) {
    const value = display[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 2_048)) {
      throw new Error(`${label} display ${key} is invalid`);
    }
  }
}

function validateSemanticFields(
  value: Pick<CalendarAvailabilityDefinition, "state" | "calendarId" | "label" | "display" | "metadata">,
  label: string,
): void {
  if (value.state !== "available" && value.state !== "unavailable") throw new Error(`${label} state is invalid`);
  if (value.calendarId !== undefined) requiredText(value.calendarId, `${label} calendar id`);
  if (value.label !== undefined) {
    const text = requiredText(value.label, `${label} label`);
    if (text.length > 2_048) throw new Error(`${label} label is invalid`);
  }
  validateDisplay(value.display, label);
  if (value.metadata !== undefined) assertCalendarMetadataIntegrity(value.metadata, `${label} metadata`);
}

function validateDefinition(definition: CalendarAvailabilityDefinition): void {
  const id = requiredText(definition.id, "Availability definition id");
  const label = `Availability definition ${id}`;
  requiredText(definition.start, `${label} start`);
  requiredText(definition.end, `${label} end`);
  validateSemanticFields(definition, label);

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
  if (definition.allDay === true) {
    if (!dateOnly.test(definition.start) || !dateOnly.test(definition.end)) {
      throw new Error(`${label} all-day boundaries must be ISO dates`);
    }
    if (definition.temporal && definition.temporal.kind !== "date") {
      throw new Error(`${label} all-day temporal kind must be date`);
    }
  } else if (dateOnly.test(definition.start) || dateOnly.test(definition.end) || definition.temporal?.kind === "date") {
    throw new Error(`${label} date-only boundaries require allDay: true`);
  }

  for (const exception of definition.recurrence?.exceptions ?? []) {
    requiredText(exception.originalStart, `${label} recurrence exception originalStart`);
    if (exception.cancelled && exception.replacement) throw new Error(`${label} recurrence exception cannot be cancelled and replaced`);
    if (exception.replacement) {
      validateSemanticFields({
        state: exception.replacement.state ?? definition.state,
        calendarId: exception.replacement.calendarId ?? definition.calendarId,
        label: exception.replacement.label ?? definition.label,
        display: exception.replacement.display ?? definition.display,
        metadata: exception.replacement.metadata ?? definition.metadata,
      }, `${label} recurrence replacement`);
    }
  }
}

function backgroundMetadata(metadata: CalendarMetadata | undefined, definitionId: string, state: CalendarAvailabilityState): CalendarMetadata {
  return {
    ...(metadata ?? {}),
    calendarAvailability: { definitionId, state },
  };
}

function occurrenceBackgroundId(definition: CalendarAvailabilityDefinition, originalStart: ISODateTime): string {
  return definition.recurrence ? `${definition.id}@${originalStart}` : definition.id;
}

export function expandAvailabilityDefinitions(
  definitions: readonly CalendarAvailabilityDefinition[],
  range: CalendarRange,
  options: CalendarAvailabilityExpansionOptions,
): readonly CalendarBackgroundRange[] {
  if (!Array.isArray(definitions)) throw new Error("Availability definitions must be an array");
  requiredText(options.timeZone, "Availability expansion time zone");

  const ids = new Set<string>();
  return definitions.flatMap(definition => {
    validateDefinition(definition);
    if (ids.has(definition.id)) throw new Error(`Duplicate availability definition: ${definition.id}`);
    ids.add(definition.id);

    return expandTemporalSeries<CalendarAvailabilityExceptionReplacement>(
      definition,
      definition.recurrence,
      range,
      { timeZone: options.timeZone },
    ).map(resolved => {
      const replacement = resolved.exception?.replacement;
      const state = replacement?.state ?? definition.state;
      const calendarId = replacement?.calendarId ?? definition.calendarId;
      const label = replacement?.label ?? definition.label;
      const display = replacement?.display ?? definition.display;
      const metadata = replacement?.metadata ?? definition.metadata;
      return {
        id: occurrenceBackgroundId(definition, resolved.originalStart),
        start: resolved.start,
        end: resolved.end,
        ...(definition.allDay === true ? { allDay: true } : {}),
        ...(calendarId ? { calendarId } : {}),
        ...(label ? { label } : {}),
        ...(display ? { display } : {}),
        metadata: backgroundMetadata(metadata, definition.id, state),
      };
    });
  });
}

export function createAvailabilityBackgroundProvider(options: CalendarAvailabilityProviderOptions): CalendarBackgroundProjectionProvider {
  const id = requiredText(options.id, "Availability provider id");
  requiredText(options.timeZone, "Availability provider time zone");
  return {
    id,
    projectBackgroundRanges(range: CalendarRange): readonly CalendarBackgroundRange[] {
      return expandAvailabilityDefinitions(options.definitions(), range, { timeZone: options.timeZone });
    },
    ...(options.subscribe ? { subscribe: options.subscribe } : {}),
  };
}

function availabilityState(range: CalendarBackgroundRange): CalendarAvailabilityState | undefined {
  const value = range.metadata?.calendarAvailability;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = (value as { readonly state?: unknown }).state;
  return state === "available" || state === "unavailable" ? state : undefined;
}

function appliesToCalendar(range: CalendarBackgroundRange, calendarId: CalendarId | undefined): boolean {
  return range.calendarId === undefined || (calendarId !== undefined && range.calendarId === calendarId);
}

function overlapsPlacement(range: CalendarBackgroundRange, startMs: number, endMs: number): boolean {
  const rangeStart = Date.parse(range.start);
  const rangeEnd = Date.parse(range.end);
  return endMs === startMs
    ? rangeStart <= startMs && rangeEnd > startMs
    : rangeStart < endMs && rangeEnd > startMs;
}

function fullyCoveredByAvailable(ranges: readonly CalendarBackgroundRange[], startMs: number, endMs: number): boolean {
  const available = ranges
    .filter(range => availabilityState(range) === "available")
    .map(range => [Date.parse(range.start), Date.parse(range.end)] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  if (endMs === startMs) return available.some(([start, end]) => start <= startMs && end > startMs);

  let coveredUntil = startMs;
  for (const [rangeStart, rangeEnd] of available) {
    if (rangeEnd <= coveredUntil) continue;
    if (rangeStart > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, rangeEnd);
    if (coveredUntil >= endMs) return true;
  }
  return false;
}

export function createAvailabilityPlacementGuard(options: CalendarAvailabilityPlacementGuardOptions): CalendarPlacementGuard {
  const id = requiredText(options.id, "Availability placement guard id");
  requiredText(options.timeZone, "Availability placement guard time zone");
  if (options.policy !== "exclude-unavailable" && options.policy !== "require-available") {
    throw new Error("Availability placement guard policy is invalid");
  }
  if (options.mode !== "warn" && options.mode !== "prevent") throw new Error("Availability placement guard mode is invalid");
  if (options.message !== undefined) {
    const message = requiredText(options.message, "Availability placement guard message");
    if (message.length > 2_048) throw new Error("Availability placement guard message is too long");
  }

  return {
    id,
    evaluate(context) {
      const startMs = Date.parse(context.start);
      const endMs = Date.parse(context.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return { mode: "prevent", message: "Availability policy could not evaluate this placement." };
      }
      const queryEnd = endMs === startMs ? new Date(startMs + 1).toISOString() : context.end;
      const ranges = expandAvailabilityDefinitions(
        options.definitions(),
        { start: context.start, end: queryEnd },
        { timeZone: options.timeZone },
      ).filter(range => appliesToCalendar(range, context.calendarId));

      const unavailableOverlap = ranges.some(range =>
        availabilityState(range) === "unavailable" && overlapsPlacement(range, startMs, endMs));
      const allowed = options.policy === "exclude-unavailable"
        ? !unavailableOverlap
        : !unavailableOverlap && fullyCoveredByAvailable(ranges, startMs, endMs);

      if (allowed) return { mode: "allow" };
      return {
        mode: options.mode,
        message: options.message ?? (options.policy === "require-available"
          ? "This placement is outside available time."
          : "This placement overlaps unavailable time."),
      };
    },
  };
}
