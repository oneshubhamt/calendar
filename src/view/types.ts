import type {
  CalendarAgendaSpan,
  CalendarCommand,
  CalendarCommandHandler,
  CalendarDisplay,
  CalendarId,
  CalendarItem,
  CalendarItemId,
  CalendarItemKind,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarOwnership,
  CalendarRange,
  CalendarRecurrence,
  CalendarReminder,
  CalendarReminderChannel,
  CalendarSource,
  CalendarTemporalSpec,
  CalendarView,
  EditPolicy,
  ISODate,
  ISODateTime,
  TemporalPrecision,
  Weekday,
} from "../core/types.js";

export interface CalendarSelection {
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay: boolean;
}

/** Host-defined source action. `kind` is presentation metadata only and is intentionally open-ended. */
export interface CalendarSourceAction {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly primary?: boolean;
}

export interface CalendarSourceActionPort {
  actions(occurrence: CalendarOccurrence): readonly CalendarSourceAction[];
  execute(actionId: string, occurrence: CalendarOccurrence): Promise<void> | void;
}

export interface CalendarUiCallbacks {
  /** Return true when the host handled creation and the built-in editor must not open. */
  readonly handleCreate?: (selection: CalendarSelection) => boolean | Promise<boolean>;
  /** Return true when the host handled opening/details and the built-in details dialog must not open. */
  readonly handleOpen?: (occurrence: CalendarOccurrence) => boolean | Promise<boolean>;
  /** Return true when the host handled editing and the built-in editor must not open. */
  readonly handleEdit?: (occurrence: CalendarOccurrence) => boolean | Promise<boolean>;
  readonly onCreate?: (selection: CalendarSelection) => void;
  readonly onOpen?: (occurrence: CalendarOccurrence) => void;
  readonly onCommand?: (command: CalendarCommand) => void;
  readonly onRangeChange?: (range: CalendarRange, view: CalendarView) => void;
  readonly onViewChange?: (view: CalendarView) => void;
}

export interface CalendarKindOption {
  readonly value: CalendarItemKind;
  readonly label: string;
}

export interface CalendarReminderChannelOption {
  readonly value: CalendarReminderChannel;
  readonly label: string;
}

export interface CalendarCreateDraft {
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly allDay?: boolean;
  readonly precision?: TemporalPrecision;
  readonly temporal?: CalendarTemporalSpec;
  readonly kind: CalendarItemKind;
  readonly ownership?: CalendarOwnership;
  readonly editPolicy?: EditPolicy;
  readonly recurrence?: CalendarRecurrence;
  readonly reminders?: readonly CalendarReminder[];
  readonly display?: CalendarDisplay;
  readonly metadata?: CalendarItem["metadata"];
}

export interface CalendarItemFactoryInput {
  readonly id: CalendarItemId;
  readonly now: ISODateTime;
  readonly purpose: "create" | "quick-create" | "duplicate" | "copy" | string;
  readonly draft: CalendarCreateDraft;
  readonly original?: CalendarOccurrence;
}

export type CalendarItemFactory = (input: CalendarItemFactoryInput) => CalendarItem;

export interface CalendarDetailRow { readonly label: string; readonly value: string; }

export interface CalendarOccurrencePresentation {
  readonly classNames?: readonly string[];
  readonly data?: Readonly<Record<string, string>>;
  readonly agendaMeta?: string;
  readonly agendaOrder?: number;
  readonly detailRows?: readonly CalendarDetailRow[];
}

export interface CalendarAgendaDayPresentation { readonly summary?: string; }

export interface CalendarUiExtensionContext {
  readonly occurrences: readonly CalendarOccurrence[];
  readonly range: CalendarRange;
  readonly timeZone: string;
  readonly now: Date;
}

/** Optional host/feature presentation extension. The calendar view assigns no domain meaning to extension data. */
export interface CalendarUiExtension {
  readonly styles?: string;
  prepare?(context: CalendarUiExtensionContext): void;
  presentOccurrence?(occurrence: CalendarOccurrence): CalendarOccurrencePresentation | undefined;
  presentAgendaDay?(date: ISODate, occurrences: readonly CalendarOccurrence[]): CalendarAgendaDayPresentation | undefined;
}

export interface CalendarUiAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly danger?: boolean;
  run(): Promise<void> | void;
}

/** Narrow capability surface exposed to optional UI add-ons. */
export interface CalendarUiAddonContext {
  readonly host: HTMLElement;
  readonly locale: string;
  readonly timeZone: string;
  readonly visibleRange: CalendarRange;
  readonly anchorDate: ISODate;
  readonly defaultCalendarId: CalendarId;
  readonly sources: readonly CalendarSource[];
  readonly items: readonly CalendarItem[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly kindOptions: readonly CalendarKindOption[];
  canManageSources(): boolean;
  refresh(): Promise<void>;
  announce(message: string): void;
  createSource(source: CalendarSource): Promise<void>;
  createDraft(draft: CalendarCreateDraft, purpose: CalendarItemFactoryInput["purpose"], original?: CalendarOccurrence): Promise<CalendarItem | null>;
  canPlaceDraft(draft: CalendarCreateDraft, original?: CalendarOccurrence, action?: string): Promise<boolean>;
  patchOccurrence(occurrence: CalendarOccurrence, patch: CalendarItemPatch, label?: string): Promise<boolean>;
}

/** Optional DOM feature. Base view knows only these generic contribution hooks. */
export interface CalendarUiAddon {
  readonly id: string;
  readonly styles?: string;
  filterOccurrence?(occurrence: CalendarOccurrence, source: CalendarSource | undefined): boolean;
  mountToolbar?(container: HTMLElement, context: CalendarUiAddonContext): void;
  emptyMessage?(context: CalendarUiAddonContext): string | undefined;
  detailActions?(occurrence: CalendarOccurrence, context: CalendarUiAddonContext): readonly CalendarUiAction[];
  contextActions?(occurrence: CalendarOccurrence, context: CalendarUiAddonContext): readonly CalendarUiAction[];
  sourceMenuActions?(context: CalendarUiAddonContext): readonly CalendarUiAction[];
  onRefresh?(context: CalendarUiAddonContext): void;
  destroy?(): void;
}

export interface CalendarUiOptions {
  readonly locale?: string;
  readonly timeZone?: string | undefined;
  readonly defaultCalendarId?: CalendarId;
  readonly commandHandler?: CalendarCommandHandler;
  readonly weekStartsOn?: Weekday | undefined;
  readonly initialView?: CalendarView;
  readonly initialAgendaSpan?: CalendarAgendaSpan;
  readonly initialDate?: ISODateTime;
  readonly slotMinutes?: 5 | 10 | 15 | 20 | 30 | 60;
  readonly snapPolicy?: import("../core/types.js").CalendarSnapPolicy;
  readonly collisionPolicy?: import("../core/types.js").CalendarCollisionPolicy;
  readonly longPressMs?: number;
  readonly autoScrollEdgePx?: number;
  readonly autoScrollMaxPxPerFrame?: number;
  readonly dayStartHour?: number;
  readonly dayEndHour?: number;
  readonly ariaLabel?: string;
  readonly kindOptions?: readonly CalendarKindOption[];
  readonly reminderChannelOptions?: readonly CalendarReminderChannelOption[];
  readonly defaultOwnership?: CalendarOwnership;
  readonly defaultEditPolicy?: EditPolicy;
  readonly itemFactory?: CalendarItemFactory;
  readonly extensions?: readonly CalendarUiExtension[];
  readonly addons?: readonly CalendarUiAddon[];
  readonly allowCreate?: boolean;
  readonly allowDrag?: boolean;
  readonly allowResize?: boolean;
  readonly showNowIndicator?: boolean;
  readonly sourceActions?: CalendarSourceActionPort;
  readonly callbacks?: CalendarUiCallbacks;
}
