export type CalendarId = string;
export type CalendarItemId = string;
export type CalendarSeriesId = string;
export type OccurrenceId = string;
export type ISODate = string;
export type ISODateTime = string;

export type CalendarView = "month" | "week" | "day" | "year" | "agenda";
export type CalendarAgendaSpan = "day" | "week" | "month" | "30-days";
/** Host-extensible semantic type. Core logic treats kinds as opaque identifiers. */
export type CalendarItemKind = string;

/** Host-extensible provenance/ownership tag. Mutation authority is governed by editPolicy. */
export type CalendarOwnership = string;

export type EditPolicy = "full" | "schedule-only" | "readonly" | "generated";
export type TemporalPrecision = "date" | "minute";
/** Interval is the default. Point represents a true zero-duration instant and must use start === end. */
export type CalendarTemporalForm = "interval" | "point";
export type CalendarTemporalKind = "instant" | "zoned" | "floating" | "date";
/** Host-extensible delivery channel. Built-ins use in-app, browser and external. */
export type CalendarReminderChannel = string;

export interface CalendarReminder {
  readonly id: string;
  /** Minutes before the event start. Zero means at start. */
  readonly minutesBefore: number;
  readonly channel: CalendarReminderChannel;
  readonly enabled?: boolean | undefined;
}
export type TemporalDisambiguation = "compatible" | "earlier" | "later" | "reject";
/** Explicit interaction policy for duplicated local times during a fall-back transition. */
export type CalendarOverlapDisambiguation = "earlier" | "later";

export interface CalendarTemporalSpec {
  readonly kind: CalendarTemporalKind;
  readonly timeZone?: string | undefined;
  readonly disambiguation?: TemporalDisambiguation | undefined;
}
export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CalendarRange {
  readonly start: ISODateTime;
  readonly end: ISODateTime;
}

export interface CalendarDisplay {
  readonly color?: string | undefined;
  readonly textColor?: string | undefined;
  readonly icon?: string | undefined;
  readonly className?: string | undefined;
  readonly dimmed?: boolean | undefined;
  readonly emphasis?: "normal" | "strong" | "critical" | undefined;
}

export type CalendarMetadataScalar = string | number | boolean | null;
export type CalendarMetadataValue = CalendarMetadataScalar | readonly CalendarMetadataValue[] | { readonly [key: string]: CalendarMetadataValue };
/** Opaque host/provider identity payload. Calendar validates JSON-like shape but assigns no semantics to its contents. */
export type CalendarOpaqueIdentity = CalendarMetadataValue;

/** Generic metadata envelope. Calendar mechanics assign no domain meaning to its keys. */
export interface CalendarMetadata {
  readonly [key: string]: CalendarMetadataValue | undefined;
}

/**
 * Passive, already-resolved temporal context rendered behind ordinary calendar events.
 * Background ranges are not events and carry no scheduling/availability semantics by themselves.
 */
export interface CalendarBackgroundRange {
  /** Stable identity within the Calendar query result. */
  readonly id: string;
  /** Absolute ISO date-time at the resolved projection boundary. */
  readonly start: ISODateTime;
  /** Absolute ISO date-time; must be strictly after start. */
  readonly end: ISODateTime;
  /** Explicit day-level semantics for views that can truthfully represent full-day backgrounds. */
  readonly allDay?: boolean | undefined;
  /** Optional Calendar source association. Associated ranges follow that source's visibility. */
  readonly calendarId?: CalendarId | undefined;
  /** Optional generic text for later presentation/accessibility; Calendar assigns no domain meaning. */
  readonly label?: string | undefined;
  /** Opaque bounded JSON-like host data. */
  readonly metadata?: CalendarMetadata | undefined;
}

export interface RecurrenceByDay {
  readonly weekday: Weekday;
  readonly ordinal?: number | undefined;
}

export interface RecurrenceRule {
  readonly frequency: RecurrenceFrequency;
  readonly interval?: number | undefined;
  /** Legacy/simple BYDAY form. Prefer byDay for ordinal weekdays. */
  readonly byWeekday?: readonly Weekday[] | undefined;
  readonly byDay?: readonly RecurrenceByDay[] | undefined;
  readonly byMonthDay?: readonly number[] | undefined;
  readonly byMonth?: readonly number[] | undefined;
  readonly bySetPosition?: readonly number[] | undefined;
  readonly count?: number | undefined;
  readonly until?: ISODateTime | undefined;
  readonly weekStartsOn?: Weekday | undefined;
}

export interface RecurrenceException {
  readonly originalStart: ISODateTime;
  readonly cancelled?: boolean;
  readonly replacement?: CalendarItemPatch;
}

export interface CalendarRecurrence {
  readonly rule: RecurrenceRule;
  readonly exceptions?: readonly RecurrenceException[] | undefined;
}

/** Shared event payload. CalendarItem and CalendarOccurrence add their own distinct identities. */
export interface CalendarEventFields {
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  /** Calendar items may use their declared temporal representation; resolved occurrences always use absolute instants. */
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly precision?: TemporalPrecision | undefined;
  readonly temporal?: CalendarTemporalSpec | undefined;
  /** Generic temporal geometry. Omitted means interval; point means a true zero-duration instant. */
  readonly temporalForm?: CalendarTemporalForm | undefined;
  readonly kind: CalendarItemKind;
  readonly ownership: CalendarOwnership;
  readonly editPolicy: EditPolicy;
  readonly seriesId?: CalendarSeriesId | undefined;
  readonly reminders?: readonly CalendarReminder[] | undefined;
  readonly display?: CalendarDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
  readonly createdAt?: ISODateTime | undefined;
  readonly updatedAt?: ISODateTime | undefined;
}

export interface CalendarItem extends CalendarEventFields {
  readonly id: CalendarItemId;
  readonly recurrence?: CalendarRecurrence | undefined;
}

export interface CalendarItemPatch {
  readonly calendarId?: CalendarId;
  readonly title?: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly start?: ISODateTime;
  readonly end?: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly precision?: TemporalPrecision | undefined;
  readonly temporal?: CalendarTemporalSpec | null | undefined;
  readonly temporalForm?: CalendarTemporalForm | undefined;
  readonly kind?: CalendarItemKind;
  readonly editPolicy?: EditPolicy;
  readonly recurrence?: CalendarRecurrence | null;
  readonly reminders?: readonly CalendarReminder[] | null;
  readonly display?: CalendarDisplay | null;
  readonly metadata?: CalendarMetadata | null;
}

export interface CalendarOccurrence extends CalendarEventFields {
  /** Stable identity of this resolved occurrence. It must not change merely because a one-off occurrence moves. */
  readonly occurrenceId: OccurrenceId;
  /** Stable identity of the authoritative source record represented by this occurrence. */
  readonly sourceItemId: CalendarItemId;
  /**
   * Calendar recurrence anchor used by Calendar-owned recurrence mechanics. Host occurrence projections
   * must provide an absolute instant here and carry any host-local recurrence key in projectionIdentity.
   */
  readonly originalStart: ISODateTime;
  readonly recurring: boolean;
  /** Optional provider-owned occurrence/recurrence identity carried opaquely through Calendar. */
  readonly projectionIdentity?: CalendarOpaqueIdentity | undefined;
}

export interface CalendarSource {
  readonly id: CalendarId;
  readonly title: string;
  readonly visible: boolean;
  /** Host-extensible source classification. Core logic treats it as metadata only. */
  readonly sourceType?: string | undefined;
  /** Blocks user/calendar commands that mutate items in this source. Storage/sync adapters may still write through their own trusted path. */
  readonly readOnly?: boolean;
  /** False when user/calendar commands must not create or move items into this source. */
  readonly allowCreate?: boolean;
  /** False when source-management UI/repositories must not remove this source. */
  readonly removable?: boolean;
  readonly display?: CalendarDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarSourcePatch {
  readonly title?: string;
  readonly visible?: boolean;
  readonly display?: CalendarDisplay | null;
  readonly metadata?: CalendarMetadata | null;
}

export interface CalendarSnapshot {
  readonly sources: readonly CalendarSource[];
  readonly items: readonly CalendarItem[];
  readonly revision: number;
}

export interface CalendarSnapshotProvider {
  read(): CalendarSnapshot;
  subscribe?(listener: (snapshot: CalendarSnapshot) => void): () => void;
}

export interface CalendarSourceManager {
  createSource(source: CalendarSource): Promise<void> | void;
  updateSource(id: CalendarId, patch: CalendarSourcePatch): Promise<void> | void;
  removeSource(id: CalendarId): Promise<void> | void;
}

/** Mutable local repository. Hosts that only project/read data can implement CalendarSnapshotProvider instead. */
export interface CalendarRepository extends CalendarSnapshotProvider {
  create(item: CalendarItem): Promise<void> | void;
  update(id: CalendarItemId, patch: CalendarItemPatch): Promise<void> | void;
  remove(id: CalendarItemId): Promise<void> | void;
  replace(items: readonly CalendarItem[]): Promise<void> | void;
  createSource?(source: CalendarSource): Promise<void> | void;
  updateSource?(id: CalendarId, patch: CalendarSourcePatch): Promise<void> | void;
  removeSource?(id: CalendarId): Promise<void> | void;
}

export type CalendarEngineRepository = CalendarSnapshotProvider & Partial<CalendarSourceManager>;

export interface CalendarProjectionProvider {
  readonly id: string;
  project(range: CalendarRange): Promise<readonly CalendarItem[]> | readonly CalendarItem[];
  /** Optional invalidation signal for host-owned data projected into the calendar. */
  subscribe?(listener: () => void): () => void;
}

/** Host projection boundary for already-expanded occurrences. Calendar never applies recurrence expansion to these values. start/end/originalStart must be absolute ISO date-times; host-local recurrence identity belongs in projectionIdentity. */
export interface CalendarOccurrenceProjectionProvider {
  readonly id: string;
  projectOccurrences(range: CalendarRange): Promise<readonly CalendarOccurrence[]> | readonly CalendarOccurrence[];
  /** Optional invalidation signal for authoritative host occurrence data. */
  subscribe?(listener: () => void): () => void;
}

/**
 * Host/feature projection boundary for passive, already-expanded temporal background ranges.
 * Calendar does not recurrence-expand these values or infer availability/constraint semantics from them.
 */
export interface CalendarBackgroundProjectionProvider {
  readonly id: string;
  projectBackgroundRanges(range: CalendarRange): Promise<readonly CalendarBackgroundRange[]> | readonly CalendarBackgroundRange[];
  /** Optional invalidation signal for authoritative background data. */
  subscribe?(listener: () => void): () => void;
}

export type CalendarOccurrenceCommandPath = "default" | "trusted-host";

/**
 * Fine-grained occurrence authority. Omitted fields inherit Calendar's fail-closed item/source baseline.
 * A provider using the default command path may only narrow that baseline. A trusted-host path may
 * explicitly grant an operation because execution is routed to the host rather than Calendar storage.
 */
export interface CalendarOccurrenceCapabilities {
  readonly commandPath?: CalendarOccurrenceCommandPath | undefined;
  readonly canMove?: boolean | undefined;
  readonly canMoveBetweenAllDayAndTimed?: boolean | undefined;
  readonly canResizeStart?: boolean | undefined;
  readonly canResizeEnd?: boolean | undefined;
  readonly canOpen?: boolean | undefined;
  readonly canEdit?: boolean | undefined;
  readonly canDelete?: boolean | undefined;
  readonly canChangeRecurrence?: boolean | undefined;
  readonly canInvokeActions?: boolean | undefined;
}

/** Optional host/provider authority overlay for an occurrence. */
export interface CalendarOccurrenceCapabilityProvider {
  capabilities(occurrence: CalendarOccurrence): CalendarOccurrenceCapabilities | undefined;
}

export type SeriesEditScope = "this" | "this-and-following" | "all";
export type CalendarSnapStrategy = "none" | "floor" | "round" | "ceil";
export type CalendarCollisionMode = "allow" | "warn" | "prevent";

export interface CalendarSnapPolicy {
  readonly selection?: CalendarSnapStrategy;
  readonly move?: CalendarSnapStrategy;
  readonly resize?: CalendarSnapStrategy;
  readonly keyboardStepMinutes?: number;
}

export interface CalendarCollisionPolicy {
  readonly mode: CalendarCollisionMode;
  readonly includeAllDay?: boolean;
}

export interface CalendarHistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface CalendarCommandContext {
  readonly now: ISODateTime;
  readonly occurrence?: CalendarOccurrence;
  readonly occurrenceId?: OccurrenceId | undefined;
  readonly sourceItemId?: CalendarItemId | undefined;
  readonly projectionIdentity?: CalendarOpaqueIdentity | undefined;
  readonly seriesScope?: SeriesEditScope | undefined;
  readonly timeZone?: string | undefined;
}

export type CalendarCommand =
  | { readonly type: "create"; readonly item: CalendarItem }
  | { readonly type: "update"; readonly id: CalendarItemId; readonly patch: CalendarItemPatch }
  | { readonly type: "remove"; readonly id: CalendarItemId }
  | {
      readonly type: "update-occurrence";
      readonly occurrence: CalendarOccurrence;
      readonly patch: CalendarItemPatch;
      readonly scope: SeriesEditScope;
    }
  | {
      readonly type: "move-occurrence";
      readonly occurrence: CalendarOccurrence;
      readonly start: ISODateTime;
      readonly end: ISODateTime;
      readonly scope: SeriesEditScope;
    }
  | {
      readonly type: "resize-occurrence";
      readonly occurrence: CalendarOccurrence;
      readonly start: ISODateTime;
      readonly end: ISODateTime;
      readonly scope: SeriesEditScope;
    }
  | {
      readonly type: "cancel-occurrence";
      readonly occurrence: CalendarOccurrence;
      readonly scope: SeriesEditScope;
    };

export type CalendarOccurrenceCommand = Extract<CalendarCommand, { readonly occurrence: CalendarOccurrence }>;

export interface CalendarCommandHandler {
  execute(command: CalendarCommand, context: CalendarCommandContext): Promise<void> | void;
  undo?(): Promise<boolean> | boolean;
  redo?(): Promise<boolean> | boolean;
  historyState?(): CalendarHistoryState;
}
