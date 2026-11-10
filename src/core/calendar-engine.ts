import type {
  CalendarBackgroundProjectionProvider,
  CalendarBackgroundRange,
  CalendarOccurrence,
  CalendarOccurrenceProjectionProvider,
  CalendarProjectionProvider,
  CalendarRange,
  CalendarEngineRepository,
  CalendarSnapshot, CalendarSource, CalendarSourcePatch,
} from "./types.js";
import { expandItems } from "./event-series.js";
import { sortOccurrences } from "./layout.js";
import { assertCalendarBackgroundRangeIntegrity, assertCalendarOccurrenceIntegrity, assertCalendarStateIntegrity } from "./store.js";
import { intersectsRange, parseAbsoluteDateTime, toDate } from "./time.js";

export interface CalendarQueryResult {
  readonly range: CalendarRange;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly backgroundRanges: readonly CalendarBackgroundRange[];
  /** Durable repository concurrency token captured when the query began. */
  readonly repositoryRevision: number;
  /** Combined engine invalidation generation captured when the query began. */
  readonly generation: number;
}

export interface CalendarEngineInvalidation {
  readonly repositoryRevision: number;
  readonly generation: number;
}

export interface CalendarQueryOptions {
  readonly visibleSourceIds?: ReadonlySet<string>;
  readonly timeZone?: string | undefined;
  /** Host/feature-neutral occurrence predicate applied after recurrence expansion/projection. */
  readonly predicate?: ((occurrence: CalendarOccurrence) => boolean) | undefined;
  /** False for event-only queries such as collision checks; passive providers are then not invoked at all. */
  readonly includeBackgroundRanges?: boolean | undefined;
}


function canonicalAbsolute(value: string, label: string): string {
  return parseAbsoluteDateTime(value, label).toISOString();
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

function normalizeProjectedBackgroundRange(range: CalendarBackgroundRange): CalendarBackgroundRange {
  return {
    ...range,
    start: canonicalAbsolute(range.start, `Calendar background range ${range.id} start`),
    end: canonicalAbsolute(range.end, `Calendar background range ${range.id} end`),
  };
}

function assertRange(range: CalendarRange): void {
  if (toDate(range.end).getTime() <= toDate(range.start).getTime()) throw new RangeError("Calendar range end must be after start");
}

export class CalendarEngine {
  private generationValue = 0;
  private readonly invalidationListeners = new Set<(invalidation: CalendarEngineInvalidation) => void>();
  private inputUnsubscribers: Array<() => void> = [];

  public constructor(
    private readonly repository: CalendarEngineRepository,
    private readonly projections: readonly CalendarProjectionProvider[] = [],
    private readonly occurrenceProjections: readonly CalendarOccurrenceProjectionProvider[] = [],
    private readonly backgroundProjections: readonly CalendarBackgroundProjectionProvider[] = [],
  ) {}

  public snapshot(): CalendarSnapshot { return this.repository.read(); }
  public generation(): number { return this.generationValue; }

  /**
   * Observe the combined repository/projection invalidation stream. Upstream inputs are
   * subscribed once per engine and fanned out, so one source invalidation advances one generation.
   */
  public subscribe(listener: (invalidation: CalendarEngineInvalidation) => void): () => void {
    this.invalidationListeners.add(listener);
    if (this.invalidationListeners.size === 1) {
      try {
        this.attachInputs();
      } catch (error) {
        this.invalidationListeners.delete(listener);
        throw error;
      }
    }
    return () => {
      this.invalidationListeners.delete(listener);
      if (this.invalidationListeners.size === 0) this.detachInputs();
    };
  }

  private attachInputs(): void {
    const unsubscribers: Array<() => void> = [];
    try {
      if (this.repository.subscribe) {
        unsubscribers.push(this.repository.subscribe(snapshot => this.publishInvalidation(snapshot.revision)));
      }
      for (const projection of [...this.projections, ...this.occurrenceProjections, ...this.backgroundProjections]) {
        if (projection.subscribe) {
          unsubscribers.push(projection.subscribe(() => this.publishInvalidation(this.repository.read().revision)));
        }
      }
      this.inputUnsubscribers = unsubscribers;
    } catch (error) {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      throw error;
    }
  }

  private detachInputs(): void {
    for (const unsubscribe of this.inputUnsubscribers.splice(0)) unsubscribe();
  }

  private publishInvalidation(repositoryRevision: number): void {
    this.generationValue += 1;
    const invalidation: CalendarEngineInvalidation = Object.freeze({
      repositoryRevision,
      generation: this.generationValue,
    });
    for (const listener of this.invalidationListeners) listener(invalidation);
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
    const generation = this.generationValue;
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

    let backgroundRanges: readonly CalendarBackgroundRange[] = [];
    if (options.includeBackgroundRanges !== false) {
      const projectedBackgroundRanges = (await Promise.all(this.backgroundProjections.map(provider => provider.projectBackgroundRanges(range))))
        .flat()
        .map(normalizeProjectedBackgroundRange);
      assertCalendarBackgroundRangeIntegrity(snapshot.sources, projectedBackgroundRanges);
      backgroundRanges = projectedBackgroundRanges
        .filter(background => (background.calendarId === undefined || visible.has(background.calendarId))
          && intersectsRange(background.start, background.end, range.start, range.end, false))
        .sort((left, right) =>
          toDate(left.start).getTime() - toDate(right.start).getTime()
          || toDate(left.end).getTime() - toDate(right.end).getTime()
          || left.id.localeCompare(right.id));
    }

    return {
      range,
      occurrences: options.predicate ? occurrences.filter(options.predicate) : occurrences,
      backgroundRanges,
      repositoryRevision: snapshot.revision,
      generation,
    };
  }
}
