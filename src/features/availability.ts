import type {
  CalendarBackgroundDisplay,
  CalendarBackgroundProjectionProvider,
  CalendarBackgroundRange,
  CalendarId,
  CalendarItem,
  CalendarMetadata,
  CalendarPlacementGuard,
  CalendarRange,
  CalendarRecurrence,
  CalendarTemporalSpec,
  ISODateTime,
} from "../core/types.js";
import { expandItem } from "../core/recurrence.js";
import { assertCalendarStateIntegrity } from "../core/store.js";

const INTERNAL_SOURCE_ID = "__calendar-availability__";
const INTERNAL_SOURCE = { id: INTERNAL_SOURCE_ID, title: "Availability", visible: true } as const;

export type CalendarAvailabilityState = "available" | "unavailable";

export interface CalendarAvailabilityDefinition {
  readonly id: string;
  readonly state: CalendarAvailabilityState;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly temporal?: CalendarTemporalSpec | undefined;
  readonly recurrence?: CalendarRecurrence | undefined;
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

function definitionItem(definition: CalendarAvailabilityDefinition): CalendarItem {
  const id = requiredText(definition.id, "Availability definition id");
  if (definition.state !== "available" && definition.state !== "unavailable") throw new Error(`Availability definition ${id} state is invalid`);
  requiredText(definition.start, `Availability definition ${id} start`);
  requiredText(definition.end, `Availability definition ${id} end`);
  if (definition.calendarId !== undefined) requiredText(definition.calendarId, `Availability definition ${id} calendar id`);
  if (definition.label !== undefined) requiredText(definition.label, `Availability definition ${id} label`);

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;
  if (definition.allDay === true) {
    if (!dateOnly.test(definition.start) || !dateOnly.test(definition.end)) {
      throw new Error(`Availability definition ${id} all-day boundaries must be ISO dates`);
    }
    if (definition.temporal && definition.temporal.kind !== "date") {
      throw new Error(`Availability definition ${id} all-day temporal kind must be date`);
    }
  } else if (dateOnly.test(definition.start) || dateOnly.test(definition.end) || definition.temporal?.kind === "date") {
    throw new Error(`Availability definition ${id} date-only boundaries require allDay: true`);
  }

  return {
    id,
    calendarId: INTERNAL_SOURCE_ID,
    title: definition.label ?? (definition.state === "available" ? "Available" : "Unavailable"),
    start: definition.start,
    end: definition.end,
    ...(definition.allDay === true ? { allDay: true, precision: "date" as const, temporal: { kind: "date" as const } } : definition.temporal ? { temporal: definition.temporal } : {}),
    kind: `availability-${definition.state}`,
    ownership: "calendar-availability",
    editPolicy: "generated",
    ...(definition.recurrence ? { recurrence: definition.recurrence } : {}),
    ...(definition.display ? { display: definition.display } : {}),
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
  };
}

function backgroundMetadata(definition: CalendarAvailabilityDefinition, occurrence: ReturnType<typeof expandItem>[number]): CalendarMetadata {
  return {
    ...(occurrence.metadata ?? {}),
    calendarAvailability: {
      definitionId: definition.id,
      state: definition.state,
    },
  };
}

function occurrenceBackgroundId(definition: CalendarAvailabilityDefinition, originalStart: ISODateTime): string {
  return definition.recurrence ? `${definition.id}@${originalStart}` : definition.id;
}

function backgroundDisplay(occurrence: ReturnType<typeof expandItem>[number]): CalendarBackgroundDisplay | undefined {
  const display = occurrence.display;
  if (!display) return undefined;
  const background = {
    ...(display.color ? { color: display.color } : {}),
    ...(display.textColor ? { textColor: display.textColor } : {}),
    ...(display.className ? { className: display.className } : {}),
  };
  return Object.keys(background).length ? background : undefined;
}

export function expandAvailabilityDefinitions(
  definitions: readonly CalendarAvailabilityDefinition[],
  range: CalendarRange,
  options: CalendarAvailabilityExpansionOptions,
): readonly CalendarBackgroundRange[] {
  if (!Array.isArray(definitions)) throw new Error("Availability definitions must be an array");
  requiredText(options.timeZone, "Availability expansion time zone");

  const items = definitions.map(definitionItem);
  assertCalendarStateIntegrity([INTERNAL_SOURCE], items);

  return definitions.flatMap((definition, index) => {
    const item = items[index]!;
    const fallbackTitle = definition.label ?? (definition.state === "available" ? "Available" : "Unavailable");
    return expandItem(item, range, { timeZone: options.timeZone }).map(occurrence => {
      const label = definition.label !== undefined || occurrence.title !== fallbackTitle ? occurrence.title : undefined;
      const display = backgroundDisplay(occurrence);
      return {
        id: occurrenceBackgroundId(definition, occurrence.originalStart),
        start: occurrence.start,
        end: occurrence.end,
        ...(occurrence.allDay ? { allDay: true } : {}),
        ...(definition.calendarId ? { calendarId: definition.calendarId } : {}),
        ...(label ? { label } : {}),
        ...(display ? { display } : {}),
        metadata: backgroundMetadata(definition, occurrence),
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
