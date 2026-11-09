import type {
  CalendarOccurrence,
  CalendarProjectionProvider,
  CalendarRange,
  CalendarEngineRepository,
  CalendarSnapshot, CalendarSource, CalendarSourcePatch,
} from "./types.js";
import { expandItems } from "./recurrence.js";
import { assertCalendarStateIntegrity } from "./store.js";

export interface CalendarQueryResult {
  readonly range: CalendarRange;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly revision: number;
}

export interface CalendarQueryOptions {
  readonly visibleSourceIds?: ReadonlySet<string>;
  readonly timeZone?: string | undefined;
  /** Host/feature-neutral occurrence predicate applied after recurrence expansion. */
  readonly predicate?: ((occurrence: CalendarOccurrence) => boolean) | undefined;
}

export class CalendarEngine {
  public constructor(
    private readonly repository: CalendarEngineRepository,
    private readonly projections: readonly CalendarProjectionProvider[] = [],
  ) {}

  public snapshot(): CalendarSnapshot { return this.repository.read(); }

  /** Observe both repository changes and invalidations from host-owned projections. */
  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void {
    const unsubscribers: Array<() => void> = [];
    if (this.repository.subscribe) unsubscribers.push(this.repository.subscribe(listener));
    for (const projection of this.projections) {
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
    const snapshot = this.repository.read();
    assertCalendarStateIntegrity(snapshot.sources, snapshot.items);
    const visible = options.visibleSourceIds ?? new Set(snapshot.sources.filter(source => source.visible).map(source => source.id));
    const local = snapshot.items.filter(item => visible.has(item.calendarId));
    const projectedAll = (await Promise.all(this.projections.map(provider => provider.project(range)))).flat();
    assertCalendarStateIntegrity(snapshot.sources, [...snapshot.items, ...projectedAll]);
    const projected = projectedAll.filter(item => visible.has(item.calendarId));
    const occurrences = expandItems([...local, ...projected], range, { timeZone: options.timeZone });
    return { range, occurrences: options.predicate ? occurrences.filter(options.predicate) : occurrences, revision: snapshot.revision };
  }
}
