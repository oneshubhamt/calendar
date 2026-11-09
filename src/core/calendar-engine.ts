import type {
  CalendarOccurrence,
  CalendarOccurrenceProjectionProvider,
  CalendarProjectionProvider,
  CalendarRange,
  CalendarEngineRepository,
  CalendarSnapshot, CalendarSource, CalendarSourcePatch,
} from "./types.js";
import { expandItems } from "./recurrence.js";
import { sortOccurrences } from "./layout.js";
import { assertCalendarOccurrenceIntegrity, assertCalendarStateIntegrity } from "./store.js";
import { hasExplicitOffset, intersectsRange, toDate } from "./time.js";

export interface CalendarQueryResult {
  readonly range: CalendarRange;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly revision: number;
}

export interface CalendarQueryOptions {
  readonly visibleSourceIds?: ReadonlySet<string>;
  readonly timeZone?: string | undefined;
  /** Host/feature-neutral occurrence predicate applied after recurrence expansion/projection. */
  readonly predicate?: ((occurrence: CalendarOccurrence) => boolean) | undefined;
}


function canonicalAbsolute(value: string, label: string): string {
  if (!hasExplicitOffset(value)) throw new Error(`${label} must be an absolute ISO date-time`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be an absolute ISO date-time`);
  return date.toISOString();
}

/** Canonicalize the provider boundary once so all downstream occurrence mechanics consume absolute instants. */
function normalizeProjectedOccurrence(occurrence: CalendarOccurrence): CalendarOccurrence {
  return {
    ...occurrence,
    start: canonicalAbsolute(occurrence.start, `Calendar occurrence ${occurrence.occurrenceId} start`),
    end: canonicalAbsolute(occurrence.end, `Calendar occurrence ${occurrence.occurrenceId} end`),
    originalStart: canonicalAbsolute(occurrence.originalStart, `Calendar occurrence ${occurrence.occurrenceId} original start`),
  };
}

function assertRange(range: CalendarRange): void {
  if (toDate(range.end).getTime() <= toDate(range.start).getTime()) throw new RangeError("Calendar range end must be after start");
}

export class CalendarEngine {
  public constructor(
    private readonly repository: CalendarEngineRepository,
    private readonly projections: readonly CalendarProjectionProvider[] = [],
    private readonly occurrenceProjections: readonly CalendarOccurrenceProjectionProvider[] = [],
  ) {}

  public snapshot(): CalendarSnapshot { return this.repository.read(); }

  /** Observe repository changes and invalidations from either host projection boundary. */
  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void {
    const unsubscribers: Array<() => void> = [];
    if (this.repository.subscribe) unsubscribers.push(this.repository.subscribe(listener));
    for (const projection of [...this.projections, ...this.occurrenceProjections]) {
      if (projection.subscribe) unsubscribers.push(projection.subscribe(() => listener(this.repository.read())));
    }
    return () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); };
  }

  public canManageSources(): boolean {
    return Boolean(this.repository.createSource && this.repository.updateSource && this.repository.removeSource);
  }

  public async createSource(source: CalendarSource): Promise<void> {
    if (!this.repository.createSource) throw new Error("Calendar source management is not supported by this repository");
    await this.repository.createSource(source);
  }

  public async updateSource(id: string, patch: CalendarSourcePatch): Promise<void> {
    if (!this.repository.updateSource) throw new Error("Calendar source management is not supported by this repository");
    await this.repository.updateSource(id, patch);
  }

  public async removeSource(id: string): Promise<void> {
    if (!this.repository.removeSource) throw new Error("Calendar source management is not supported by this repository");
    await this.repository.removeSource(id);
  }

  public async query(range: CalendarRange, options: CalendarQueryOptions = {}): Promise<CalendarQueryResult> {
    assertRange(range);
    const snapshot = this.repository.read();
    assertCalendarStateIntegrity(snapshot.sources, snapshot.items);
    const visible = options.visibleSourceIds ?? new Set(snapshot.sources.filter(source => source.visible).map(source => source.id));

    const projectedItems = (await Promise.all(this.projections.map(provider => provider.project(range)))).flat();
    assertCalendarStateIntegrity(snapshot.sources, [...snapshot.items, ...projectedItems]);
    const itemOccurrences = expandItems(
      [...snapshot.items, ...projectedItems].filter(item => visible.has(item.calendarId)),
      range,
      { timeZone: options.timeZone },
    );

    const projectedOccurrences = (await Promise.all(this.occurrenceProjections.map(provider => provider.projectOccurrences(range))))
      .flat()
      .map(normalizeProjectedOccurrence);
    assertCalendarOccurrenceIntegrity(snapshot.sources, projectedOccurrences);
    const itemOccurrenceIds = new Set(itemOccurrences.map(occurrence => occurrence.occurrenceId));
    for (const occurrence of projectedOccurrences) {
      if (itemOccurrenceIds.has(occurrence.occurrenceId)) throw new Error(`Duplicate calendar occurrence: ${occurrence.occurrenceId}`);
    }
    const visibleProjectedOccurrences = projectedOccurrences.filter(occurrence =>
      visible.has(occurrence.calendarId) && intersectsRange(occurrence.start, occurrence.end, range.start, range.end, occurrence.temporalForm === "point"),
    );

    const occurrences = [...itemOccurrences, ...visibleProjectedOccurrences].sort(sortOccurrences);
    return {
      range,
      occurrences: options.predicate ? occurrences.filter(options.predicate) : occurrences,
      revision: snapshot.revision,
    };
  }
}
