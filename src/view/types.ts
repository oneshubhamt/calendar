import type { CalendarExternalDropDecoder } from "./external-drop.js";
import type { CalendarClock } from "../core/time.js";
import type {
  CalendarAgendaSpan,
  CalendarBackgroundRange,
  CalendarCommand,
  CalendarCommandHandler,
  CalendarDisplay,
  CalendarId,
  CalendarItem,
  CalendarItemId,
  CalendarItemKind,
  CalendarItemPatch,
  CalendarNavigationBounds,
  CalendarOccurrence,
  CalendarOccurrenceCapabilityProvider,
  CalendarOverlapDisambiguation,
  CalendarPlacementGuard,
  CalendarOwnership,
  CalendarRange,
  CalendarRecurrence,
  CalendarReminder,
  CalendarReminderChannel,
  CalendarSource,
  CalendarTemporalForm,
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

export type CalendarUiViewId = CalendarView | (string & Record<never, never>);

export interface CalendarViewNavigationContext {
  readonly anchor: Date;
  readonly locale: string;
  readonly timeZone: string;
  readonly weekStartsOn: Weekday;
  readonly agendaSpan: CalendarAgendaSpan;
}

export interface CalendarViewTitleContext extends CalendarViewNavigationContext {
  readonly visibleRange: CalendarRange;
}

export interface CalendarCustomViewActionPort {
  canCreateItems(): boolean;
  canOpenOccurrence(occurrence: CalendarOccurrence): boolean;
  canMoveOccurrence(occurrence: CalendarOccurrence): boolean;
  canResizeOccurrence(occurrence: CalendarOccurrence, edge: "start" | "end"): boolean;
  isOccurrencePending(occurrence: CalendarOccurrence): boolean;
  /** Safe resolved visual presentation; never returns host DOM or HTML. */
  occurrencePresentation(occurrence: CalendarOccurrence): CalendarCustomViewOccurrencePresentation;
  openOccurrence(occurrence: CalendarOccurrence): Promise<void>;
  createFromSelection(selection: CalendarSelection): Promise<void>;
  /** True only when this DataTransfer advertises a supported external-drop MIME type and Calendar can create. */
  canAcceptExternalDrop(dataTransfer: DataTransfer | null): boolean;
  /** Decode synchronously, then create through Calendar's canonical source/placement/command path. */
  dropExternal(dataTransfer: DataTransfer | null, selection: CalendarSelection): Promise<boolean>;
  /** Shared Calendar dragenter/dragover/drop lifecycle for custom/bundled view targets. */
  bindExternalDropTarget(
    element: HTMLElement,
    resolveSelection: (event: DragEvent) => CalendarSelection | undefined,
  ): () => void;
  /**
   * Move an occurrence to a new start instant. Calendar preserves ordinary duration,
   * uses one hour when converting a date-like occurrence to timed form, and preserves
   * day span when moving to all-day form.
   */
  moveOccurrence(
    occurrence: CalendarOccurrence,
    start: ISODateTime,
    options?: { readonly allDay?: boolean | undefined },
  ): Promise<boolean>;
  /** Resize one edge through Calendar's existing snapping, placement and command lifecycle. */
  resizeOccurrence(
    occurrence: CalendarOccurrence,
    edge: "start" | "end",
    target: ISODateTime,
  ): Promise<boolean>;
  goTo(value: ISODateTime | Date): void;
  setView(view: CalendarUiViewId): void;
  announce(message: string): void;
}

export interface CalendarCustomViewRenderContext extends CalendarViewTitleContext {
  readonly viewId: CalendarUiViewId;
  readonly sources: readonly CalendarSource[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly backgroundRanges: readonly CalendarBackgroundRange[];
  readonly now: Date;
  readonly actions: CalendarCustomViewActionPort;
}

/**
 * Generic DOM custom-view plugin. It receives projected/query data and a bounded
 * Calendar action port, never repository, storage or interoperability internals.
 */
export interface CalendarCustomViewPlugin {
  readonly id: string;
  readonly label: string;
  range(context: CalendarViewNavigationContext): CalendarRange;
  shiftAnchor(context: CalendarViewNavigationContext, direction: 1 | -1): Date;
  title(context: CalendarViewTitleContext): string;
  readonly includeBackgroundRanges?: boolean | undefined;
  render(context: CalendarCustomViewRenderContext): HTMLElement;
}

/** Host-defined occurrence action. `kind` and `state` are presentation metadata only and intentionally open-ended. */
export interface CalendarSourceAction {
  /** Stable action identity within one occurrence. Duplicate IDs fail closed. */
  readonly id: string;
  readonly label: string;
  /** Optional safe text icon/glyph rendered by Calendar; arbitrary host DOM/HTML is never accepted. */
  readonly icon?: string;
  readonly kind?: string;
  readonly primary?: boolean;
  readonly danger?: boolean;
  /** Opts this action into compact in-card rendering; existing actions remain menu/detail-only by default. */
  readonly inline?: boolean;
  readonly accessibleLabel?: string;
  readonly state?: string;
  readonly pressed?: boolean;
  readonly enabled?: boolean;
  readonly pending?: boolean;
}

export interface CalendarSourceActionPort {
  actions(occurrence: CalendarOccurrence): readonly CalendarSourceAction[];
  execute(actionId: string, occurrence: CalendarOccurrence): Promise<void> | void;
}

export interface CalendarUiCallbacks {
  /** Return true when the host handled creation and the built-in editor must not open. Custom editors can validate their final draft through placement.canPlaceDraft(). */
  readonly handleCreate?: (selection: CalendarSelection, placement: CalendarPlacementValidationPort) => boolean | Promise<boolean>;
  /** Return true when the host handled opening/details and the built-in details dialog must not open. */
  readonly handleOpen?: (occurrence: CalendarOccurrence) => boolean | Promise<boolean>;
  /** Return true when the host handled editing and the built-in editor must not open. Custom editors can validate their final draft through placement.canPlaceDraft(). */
  readonly handleEdit?: (occurrence: CalendarOccurrence, placement: CalendarPlacementValidationPort) => boolean | Promise<boolean>;
  readonly onCreate?: (selection: CalendarSelection) => void;
  readonly onOpen?: (occurrence: CalendarOccurrence) => void;
  readonly onCommand?: (command: CalendarCommand) => void;
  readonly onRangeChange?: (range: CalendarRange, view: CalendarUiViewId) => void;
  readonly onViewChange?: (view: CalendarUiViewId) => void;
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
  readonly temporalForm?: CalendarTemporalForm;
  readonly kind: CalendarItemKind;
  readonly ownership?: CalendarOwnership;
  readonly editPolicy?: EditPolicy;
  readonly recurrence?: CalendarRecurrence;
  readonly reminders?: readonly CalendarReminder[];
  readonly display?: CalendarDisplay;
  readonly metadata?: CalendarItem["metadata"];
}

export interface CalendarPlacementValidationPort {
  canPlaceDraft(draft: CalendarCreateDraft, original?: CalendarOccurrence, action?: string): Promise<boolean>;
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

/** Safe text-only content for a Calendar-owned presentation slot. Calendar never accepts host HTML/DOM here. */
export interface CalendarPresentationText {
  readonly text: string;
  readonly accessibleLabel?: string;
}

export type CalendarPresentationContent = string | CalendarPresentationText;

export interface CalendarPresentationBadge {
  readonly label: string;
  readonly accessibleLabel?: string;
}

export interface CalendarOccurrencePresentation {
  /** Host class tokens; Calendar-reserved `dc-*` and `is-*` namespaces fail closed. */
  readonly classNames?: readonly string[];
  /** Host decoration data. CamelCase keys are emitted only in the dedicated `data-host-*` namespace; malformed runtime keys fail closed. */
  readonly data?: Readonly<Record<string, string>>;
  readonly agendaMeta?: string;
  readonly agendaOrder?: number;
  readonly detailRows?: readonly CalendarDetailRow[];
  /** Complete accessible label override for the occurrence's primary Calendar-owned interaction target. */
  readonly accessibleLabel?: string;
  /** Optional safe text icon/glyph. Overrides CalendarDisplay.icon for this occurrence presentation. */
  readonly icon?: CalendarPresentationContent;
  readonly leading?: CalendarPresentationContent;
  readonly title?: CalendarPresentationContent;
  readonly subtitle?: CalendarPresentationContent;
  readonly trailing?: CalendarPresentationContent;
  readonly badges?: readonly CalendarPresentationBadge[];
}

export interface CalendarCustomViewOccurrencePresentation {
  readonly classNames: readonly string[];
  readonly data: Readonly<Record<string, string>>;
  readonly accessibleLabel?: string | undefined;
  readonly icon?: CalendarPresentationContent | undefined;
  readonly leading?: CalendarPresentationContent | undefined;
  readonly title?: CalendarPresentationContent | undefined;
  readonly subtitle?: CalendarPresentationContent | undefined;
  readonly trailing?: CalendarPresentationContent | undefined;
  readonly badges: readonly CalendarPresentationBadge[];
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
  /** Cosmetic-only CSS for extension-provided presentation classes. Geometry declarations and !important fail closed. */
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
export interface CalendarUiAddonContext extends CalendarPlacementValidationPort {
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
  /** Canonical Calendar authority check for add-ons that expose move affordances. */
  canMoveOccurrence(occurrence: CalendarOccurrence): boolean;
  refresh(): Promise<void>;
  announce(message: string): void;
  createSource(source: CalendarSource): Promise<void>;
  createDraft(draft: CalendarCreateDraft, purpose: CalendarItemFactoryInput["purpose"], original?: CalendarOccurrence): Promise<CalendarItem | null>;
  patchOccurrence(occurrence: CalendarOccurrence, patch: CalendarItemPatch, label?: string): Promise<boolean>;
}

/** Optional DOM feature. Base view knows only these generic contribution hooks. */
export interface CalendarUiAddon {
  readonly id: string;
  /** CSS for add-on-owned DOM. !important is rejected; targeting Calendar-owned geometry is outside the supported contract. */
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

export interface CalendarUiChromeOptions {
  /** Show Calendar-owned toolbar chrome. When false, its child controls are not mounted. */
  readonly toolbar?: boolean;
  readonly dateNavigation?: boolean;
  readonly viewSwitcher?: boolean;
  readonly sourceControls?: boolean;
  readonly createControls?: boolean;
}

export interface CalendarUiOptions {
  /** Semantic clock for now/today behavior and deterministic hosts/tests. Interaction throttling remains wall-clock based. */
  readonly clock?: CalendarClock;
  readonly locale?: string;
  readonly timeZone?: string | undefined;
  /** Optional reference IANA zone shown as a second time scale in day/week views only. Primary geometry remains unchanged. */
  readonly secondaryTimeZone?: string | undefined;
  /** Explicitly chooses which real instant a repeated fall-back wall time targets. Spring-forward gaps remain non-targetable. */
  readonly dstOverlapDisambiguation?: CalendarOverlapDisambiguation | undefined;
  readonly defaultCalendarId?: CalendarId;
  readonly commandHandler?: CalendarCommandHandler;
  /** Fine-grained per-occurrence authority overlay. Default-path results may only narrow Calendar policy. */
  readonly occurrenceCapabilities?: CalendarOccurrenceCapabilityProvider;
  /** Explicit trusted host command path for occurrences whose capability result selects `trusted-host`. */
  readonly trustedHostCommandHandler?: CalendarCommandHandler;
  readonly weekStartsOn?: Weekday | undefined;
  readonly initialView?: CalendarUiViewId;
  /** Explicit custom views. IDs must be unique and may not reuse built-in view IDs. */
  readonly customViews?: readonly CalendarCustomViewPlugin[];
  readonly initialAgendaSpan?: CalendarAgendaSpan;
  readonly initialDate?: ISODateTime;
  /** Calendar-owned chrome is independently suppressible for embedded hosts; every control defaults to visible. */
  readonly chrome?: CalendarUiChromeOptions;
  /** Inclusive local-date bounds. Programmatic navigation is clamped and placements outside the range fail closed. */
  readonly navigationBounds?: CalendarNavigationBounds;
  readonly slotMinutes?: 5 | 10 | 15 | 20 | 30 | 60;
  readonly snapPolicy?: import("../core/types.js").CalendarSnapPolicy;
  readonly collisionPolicy?: import("../core/types.js").CalendarCollisionPolicy;
  /** Optional generic scheduling policies. Background visualization remains non-enforcing unless a guard is supplied. */
  readonly placementGuards?: readonly CalendarPlacementGuard[];
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
  /** Optional host-owned external drag formats. Calendar's standard MIME format is always supported. */
  readonly externalDropDecoder?: CalendarExternalDropDecoder;
  readonly extensions?: readonly CalendarUiExtension[];
  readonly addons?: readonly CalendarUiAddon[];
  readonly allowCreate?: boolean;
  readonly allowDrag?: boolean;
  readonly allowResize?: boolean;
  readonly showNowIndicator?: boolean;
  /** Host occurrence actions; actions opt into compact card rendering with `inline: true`. */
  readonly sourceActions?: CalendarSourceActionPort;
  readonly callbacks?: CalendarUiCallbacks;
}
