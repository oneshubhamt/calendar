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

/** Generic metadata envelope. Calendar mechanics assign no domain meaning to its keys. */
export interface CalendarMetadata {
  readonly [key: string]: CalendarMetadataValue | undefined;
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

export interface CalendarItem {
  readonly id: CalendarItemId;
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean | undefined;
  readonly precision?: TemporalPrecision | undefined;
  readonly temporal?: CalendarTemporalSpec | undefined;
  readonly kind: CalendarItemKind;
  readonly ownership: CalendarOwnership;
  readonly editPolicy: EditPolicy;
  readonly seriesId?: CalendarSeriesId | undefined;
  readonly recurrence?: CalendarRecurrence | undefined;
  readonly reminders?: readonly CalendarReminder[] | undefined;
  readonly display?: CalendarDisplay | undefined;
  readonly metadata?: CalendarMetadata | undefined;
  readonly createdAt?: ISODateTime | undefined;
  readonly updatedAt?: ISODateTime | undefined;
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
  readonly kind?: CalendarItemKind;
  readonly editPolicy?: EditPolicy;
  readonly recurrence?: CalendarRecurrence | null;
  readonly reminders?: readonly CalendarReminder[] | null;
  readonly display?: CalendarDisplay | null;
  readonly metadata?: CalendarMetadata | null;
}

export interface CalendarOccurrence extends Omit<CalendarItem, "recurrence"> {
  readonly occurrenceId: OccurrenceId;
  readonly sourceItemId: CalendarItemId;
  readonly originalStart: ISODateTime;
  readonly recurring: boolean;
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

export interface CalendarCommandHandler {
  execute(command: CalendarCommand, context: CalendarCommandContext): Promise<void> | void;
  undo?(): Promise<boolean> | boolean;
  redo?(): Promise<boolean> | boolean;
  historyState?(): CalendarHistoryState;
}
