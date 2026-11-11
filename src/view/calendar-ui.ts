import type {
  CalendarAgendaSpan,
  CalendarBackgroundRange,
  CalendarCollisionPolicy,
  CalendarOverlapDisambiguation,
  CalendarId,
  CalendarItem,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarRange,
  CalendarSnapPolicy,
  CalendarSource,
  CalendarView,
  ISODateTime,
  SeriesEditScope,
  Weekday,
} from "../core/types.js";
import type {
  CalendarCreateDraft,
  CalendarCustomViewActionPort,
  CalendarCustomViewPlugin,
  CalendarCustomViewRenderContext,
  CalendarItemFactoryInput,
  CalendarKindOption,
  CalendarPlacementValidationPort,
  CalendarSelection,
  CalendarUiAddonContext,
  CalendarUiChromeOptions,
  CalendarUiOptions,
  CalendarUiViewId,
  CalendarViewNavigationContext,
  CalendarViewTitleContext,
} from "./types.js";
import { CalendarEngine } from "../core/calendar-engine.js";
import { addDays, addMonths, addYears, dateKey, parseAbsoluteDateTime, rangeForView, resolvedTimeZone, startOfDay, systemClock, toDate, type CalendarClock } from "../core/time.js";
import { instantToPlain } from "../core/temporal.js";
import { civilMinuteOfInstant, civilMinuteResolution, instantAtCivilMinute, shiftCivilMinutes } from "../core/civil-timeline.js";
import { resolveSecondaryTimeZone, secondaryTimeScaleLabels } from "./time-zone-scale.js";
import { CalendarTemporalChrome } from "./temporal-chrome.js";
import {
  backgroundAriaSuffix,
  dayLevelBackgroundLayer,
  el,
  formatDateTime,
  formatTime,
  humanizeKind,
  periodTitle as renderPeriodTitle,
  renderAgendaView,
  renderMonthView,
  renderYearView,
  sameLocalDay,
  type CalendarStaticRenderActions,
  type CalendarStaticRenderModel,
} from "./view-renderer.js";
import {
  CalendarGestureController,
  dragResizeEdge,
  snapDragDeltaMinutes,
  type CalendarDragMode,
  type CalendarDragState,
} from "./gesture-controller.js";
import { groupAllDayBackgroundRangesByDay, groupByDay, layoutBackgroundDay, layoutTimedDay } from "../core/layout.js";
import { sameRecurrence } from "../core/recurrence.js";
import { normalizeSnapPolicy, placementInNavigationBounds, placementTimePatch, resizeInterval, snapMinuteCoordinate, type CalendarResizeEdge } from "../core/interaction.js";
import type { ResolvedCalendarOccurrenceCapabilities } from "../core/authority.js";
import { chooseSeriesScope, openEventEditor } from "./event-editor.js";
import { CALENDAR_CSS } from "./styles.js";
import { confirmCalendarAction, requestCalendarDate } from "./dialogs.js";
import {
  CalendarMutationCoordinator,
  mutationCommitted,
} from "./mutation-coordinator.js";
import { hostDataAttributeName, isSafeHostClassName, resolveOccurrencePresentation, type ResolvedCalendarOccurrencePresentation, type ResolvedCalendarSourceAction } from "./presentation.js";
import { calendarHostCss } from "./extension-styles.js";
import { isDateLikeOccurrence, isPointOccurrence } from "./occurrence-form.js";
import {
  boundProjectionRange, clampNavigationDate, navigationDateInBounds, resolveNavigationBounds,
  type ResolvedCalendarNavigationBounds,
} from "./navigation.js";
import { CalendarViewRegistry, type CalendarViewDefinition } from "./view-registry.js";


interface SelectionDragState {
  readonly pointerId: number;
  readonly day: Date;
  readonly column: HTMLElement;
  readonly overlay: HTMLElement;
  readonly startMinute: number;
  readonly startClientY: number;
  currentMinute: number;
  moved: boolean;
}

const NATIVE_DRAG_TYPE = "application/x-calendar-occurrence";

function creatableSource(source: CalendarSource | undefined): boolean {
  return Boolean(source && !source.readOnly && source.allowCreate !== false);
}

function durationMs(occurrence: CalendarOccurrence): number {
  return isPointOccurrence(occurrence) ? 0 : Math.max(1, toDate(occurrence.end).getTime() - toDate(occurrence.start).getTime());
}

function withLocalTime(
  day: Date,
  source: Date,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): Date | null {
  const time = instantToPlain(source.getTime(), timeZone);
  const minute = time.hour * 60 + time.minute + time.second / 60 + time.millisecond / 60_000;
  return instantAtCivilMinute(day, minute, timeZone, overlap);
}

function calendarDaySpan(start: Date, end: Date, timeZone: string): number {
  const a = instantToPlain(start.getTime(), timeZone);
  const b = instantToPlain(end.getTime(), timeZone);
  return Math.max(1, Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000));
}


export class CalendarUi {
  private readonly clock: CalendarClock;
  private readonly locale: string;
  private readonly timeZone: string;
  private readonly secondaryTimeZone: string | undefined;
  private readonly dstOverlapDisambiguation: CalendarOverlapDisambiguation;
  private readonly weekStartsOn: Weekday;
  private readonly slotMinutes: number;
  private readonly snapPolicy: Required<CalendarSnapPolicy>;
  private readonly collisionPolicy: CalendarCollisionPolicy;
  private readonly longPressMs: number;
  private readonly autoScrollEdgePx: number;
  private readonly autoScrollMaxPxPerFrame: number;
  private readonly dayStartHour: number;
  private readonly dayEndHour: number;
  private readonly chrome: Required<CalendarUiChromeOptions>;
  private readonly navigationBounds: ResolvedCalendarNavigationBounds;
  private readonly views: CalendarViewRegistry;
  private agendaSpan: CalendarAgendaSpan;
  private sources: readonly CalendarSource[];
  private readonly sourceVisibility = new Map<string, boolean>();
  private readonly occurrenceIndex = new Map<string, CalendarOccurrence>();
  private readonly defaultCalendarId: string;
  private view: CalendarUiViewId;
  private anchor: Date;
  private visibleRange: CalendarRange;
  private occurrences: readonly CalendarOccurrence[] = [];
  private backgroundRanges: readonly CalendarBackgroundRange[] = [];
  private destroyed = false;
  private selectionDrag: SelectionDragState | null = null;
  private renderGeneration = 0;
  private contextMenu: HTMLElement | null = null;
  private readonly unsubscribeRepository: () => void;
  private readonly mutations: CalendarMutationCoordinator;
  private readonly reportedHostHookErrors = new Set<string>();
  private readonly temporalChrome: CalendarTemporalChrome;
  private readonly gestures: CalendarGestureController;

  public constructor(
    private readonly host: HTMLElement,
    private readonly engine: CalendarEngine,
    private readonly options: CalendarUiOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.locale = options.locale ?? (typeof navigator !== "undefined" ? navigator.language : undefined) ?? "en-US";
    this.timeZone = resolvedTimeZone(options.timeZone);
    this.secondaryTimeZone = resolveSecondaryTimeZone(options.secondaryTimeZone);
    this.dstOverlapDisambiguation = options.dstOverlapDisambiguation ?? "earlier";
    this.weekStartsOn = options.weekStartsOn ?? 1;
    this.slotMinutes = options.slotMinutes ?? 15;
    this.snapPolicy = normalizeSnapPolicy(options.snapPolicy, this.slotMinutes);
    this.collisionPolicy = options.collisionPolicy ?? { mode: "allow", includeAllDay: false };
    this.longPressMs = Math.max(250, options.longPressMs ?? 420);
    this.autoScrollEdgePx = Math.max(20, options.autoScrollEdgePx ?? 56);
    this.autoScrollMaxPxPerFrame = Math.max(2, options.autoScrollMaxPxPerFrame ?? 18);
    this.dayStartHour = options.dayStartHour ?? 0;
    this.dayEndHour = options.dayEndHour ?? 24;
    this.chrome = {
      toolbar: options.chrome?.toolbar ?? true,
      dateNavigation: options.chrome?.dateNavigation ?? true,
      viewSwitcher: options.chrome?.viewSwitcher ?? true,
      sourceControls: options.chrome?.sourceControls ?? true,
      createControls: options.chrome?.createControls ?? true,
    };
    this.navigationBounds = resolveNavigationBounds(options.navigationBounds);
    this.agendaSpan = options.initialAgendaSpan ?? "30-days";
    this.views = new CalendarViewRegistry(this.builtInViewDefinitions(), options.customViews ?? []);
    this.view = options.initialView ?? "week";
    this.views.get(this.view);
    const initialAnchor = options.initialDate ? toDate(options.initialDate, this.timeZone) : this.clock.now();
    this.anchor = clampNavigationDate(initialAnchor, this.navigationBounds, this.timeZone);
    this.visibleRange = this.resolveViewRange();
    this.sources = this.engine.snapshot().sources;
    for (const source of this.sources) this.sourceVisibility.set(source.id, source.visible);
    this.defaultCalendarId = options.defaultCalendarId ?? this.sources.find(source => !source.readOnly && source.allowCreate !== false)?.id ?? this.sources[0]?.id ?? "calendar";
    this.mutations = new CalendarMutationCoordinator({
      engine: this.engine,
      clock: this.clock,
      timeZone: this.timeZone,
      navigationBounds: this.navigationBounds,
      collisionPolicy: this.collisionPolicy,
      placementGuards: this.options.placementGuards,
      commandHandler: this.options.commandHandler,
      trustedHostCommandHandler: this.options.trustedHostCommandHandler,
      occurrenceCapabilities: this.options.occurrenceCapabilities,
      sourceActions: this.options.sourceActions,
      sources: () => this.sources,
      occurrence: occurrenceId => this.occurrenceIndex.get(occurrenceId),
      refresh: () => this.refresh(),
      announce: message => this.announce(message),
      onCommand: command => this.hostHook(
        "Calendar onCommand callback",
        () => this.options.callbacks?.onCommand?.(command),
        undefined,
      ),
      onPendingChange: (occurrenceId, operation, pending) =>
        this.setOccurrencePending(occurrenceId, operation, pending),
      onSettled: () => { if (!this.destroyed) this.render(); },
      confirmPlacementWarning: async messages => await confirmCalendarAction(
        this.host,
        "Scheduling check",
        `${messages.join(" ")} Continue?`,
        "Continue",
      ),
      selectSeriesScope: async (action, allowThisAndFollowing) =>
        await chooseSeriesScope(this.host, action, allowThisAndFollowing),
    });
    this.temporalChrome = new CalendarTemporalChrome({
      host: this.host,
      clock: this.clock,
      timeZone: this.timeZone,
      dayStartHour: this.dayStartHour,
      dayEndHour: this.dayEndHour,
      showNowIndicator: this.options.showNowIndicator !== false,
      onTick: now => this.updateTodayNavigation(now),
    });
    this.gestures = new CalendarGestureController({
      host: this.host,
      slotMinutes: this.slotMinutes,
      snapPolicy: this.snapPolicy,
      longPressMs: this.longPressMs,
      autoScrollEdgePx: this.autoScrollEdgePx,
      autoScrollMaxPxPerFrame: this.autoScrollMaxPxPerFrame,
      setDragging: active => this.setDraggingState(active),
      announce: message => this.announce(message),
      finishDrag: (pointer, drag) => this.finishDrag(pointer, drag),
    });
    this.mountShell();
    this.temporalChrome.start();
    this.unsubscribeRepository = this.engine.subscribe(() => { if (!this.destroyed) this.requestRefresh(); });
    this.requestRefresh();
  }

  private builtInViewDefinitions(): readonly CalendarCustomViewPlugin[] {
    const builtIn = (
      id: CalendarView,
      label: string,
      includeBackgroundRanges: boolean,
      shiftAnchor: CalendarCustomViewPlugin["shiftAnchor"],
      render: CalendarCustomViewPlugin["render"],
    ): CalendarCustomViewPlugin => ({
      id,
      label,
      includeBackgroundRanges,
      range: context => rangeForView(context.anchor, id, context.weekStartsOn, context.timeZone, context.agendaSpan),
      shiftAnchor,
      title: context => renderPeriodTitle({ ...context, view: id }),
      render,
    });

    return [
      builtIn(
        "month",
        "Month",
        true,
        (context, direction) => addMonths(context.anchor, direction, context.timeZone),
        () => this.renderMonth(),
      ),
      builtIn(
        "week",
        "Week",
        true,
        (context, direction) => addDays(context.anchor, 7 * direction, context.timeZone),
        () => this.renderTimeGrid(7),
      ),
      builtIn(
        "day",
        "Day",
        true,
        (context, direction) => addDays(context.anchor, direction, context.timeZone),
        () => this.renderTimeGrid(1),
      ),
      builtIn(
        "year",
        "Year",
        false,
        (context, direction) => addYears(context.anchor, direction, context.timeZone),
        () => this.renderYear(),
      ),
      builtIn(
        "agenda",
        "Agenda",
        false,
        (context, direction) => {
          if (context.agendaSpan === "month") return addMonths(context.anchor, direction, context.timeZone);
          const days = context.agendaSpan === "week" ? 7 : context.agendaSpan === "day" ? 1 : 30;
          return addDays(context.anchor, days * direction, context.timeZone);
        },
        () => this.renderAgenda(),
      ),
    ];
  }

  private activeView(): CalendarViewDefinition {
    return this.views.get(this.view);
  }

  private viewNavigationContext(): CalendarViewNavigationContext {
    return Object.freeze({
      anchor: new Date(this.anchor.getTime()),
      locale: this.locale,
      timeZone: this.timeZone,
      weekStartsOn: this.weekStartsOn,
      agendaSpan: this.agendaSpan,
    });
  }

  private viewTitleContext(): CalendarViewTitleContext {
    return Object.freeze({
      ...this.viewNavigationContext(),
      visibleRange: this.visibleRange,
    });
  }

  private resolveViewRange(): CalendarRange {
    const definition = this.activeView();
    const range = definition.range(this.viewNavigationContext());
    if (!range || typeof range !== "object") throw new TypeError(`Calendar view ${definition.id} range must return a CalendarRange`);
    const start = parseAbsoluteDateTime(range.start, `Calendar view ${definition.id} range start`);
    const end = parseAbsoluteDateTime(range.end, `Calendar view ${definition.id} range end`);
    if (end.getTime() <= start.getTime()) throw new RangeError(`Calendar view ${definition.id} range must end after it starts`);
    return Object.freeze({ start: start.toISOString(), end: end.toISOString() });
  }

  private renderActiveView(): HTMLElement {
    const definition = this.activeView();
    const fallback = el("div", "dc-empty", `${definition.label} view could not be rendered.`);
    const rendered = this.hostHook(
      `Calendar view ${definition.id} render`,
      () => definition.render(this.customViewContext()),
      fallback,
    );
    return rendered instanceof HTMLElement ? rendered : fallback;
  }

  private customViewContext(): CalendarCustomViewRenderContext {
    return Object.freeze({
      ...this.viewTitleContext(),
      viewId: this.view,
      sources: Object.freeze([...this.sources]),
      occurrences: Object.freeze([...this.displayOccurrences()]),
      backgroundRanges: Object.freeze([...this.backgroundRanges]),
      now: this.clock.now(),
      actions: this.customViewActions(),
    });
  }

  private customViewActions(): CalendarCustomViewActionPort {
    const actions: CalendarCustomViewActionPort = {
      canCreateItems: () => this.canCreateItems(),
      canOpenOccurrence: occurrence => this.canOpenOccurrence(occurrence),
      canMoveOccurrence: occurrence => this.canMoveOccurrence(occurrence),
      canResizeOccurrence: (occurrence, edge) => this.canResizeOccurrence(occurrence, edge),
      isOccurrencePending: occurrence => this.isOccurrencePending(occurrence),
      openOccurrence: async occurrence => await this.openDetails(this.authoritativeOccurrence(occurrence)),
      createFromSelection: async selection => await this.createFromSelection(selection),
      moveOccurrence: async (occurrence, start, options) =>
        await this.moveOccurrenceToStart(occurrence, start, options?.allDay === true),
      resizeOccurrence: async (occurrence, edge, target) =>
        await this.resizeOccurrenceToInstant(occurrence, edge, target),
      goTo: value => this.goTo(value),
      setView: view => this.setView(view),
      announce: message => this.announce(message),
    };
    return Object.freeze(actions);
  }

  private requestRefresh(): void {
    void this.refresh().catch(error => this.announce(error instanceof Error ? `Calendar refresh failed: ${error.message}` : "Calendar refresh failed."));
  }

  public async refresh(): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.renderGeneration;
    const snapshot = this.engine.snapshot();
    this.sources = snapshot.sources;
    for (const source of this.sources) if (!this.sourceVisibility.has(source.id)) this.sourceVisibility.set(source.id, source.visible);
    for (const id of [...this.sourceVisibility.keys()]) if (!this.sources.some(source => source.id === id)) this.sourceVisibility.delete(id);
    this.visibleRange = this.resolveViewRange();
    const visibleSourceIds = new Set([...this.sourceVisibility].filter(([, visible]) => visible).map(([id]) => id));
    const sourceById = new Map(this.sources.map(source => [source.id, source] as const));
    const filters = (this.options.addons ?? []).filter(addon => addon.filterOccurrence);
    const projectionRange = boundProjectionRange(this.visibleRange, this.navigationBounds, this.timeZone);
    const result = await this.engine.query(projectionRange, {
      visibleSourceIds,
      timeZone: this.timeZone,
      includeBackgroundRanges: this.activeView().includeBackgroundRanges === true,
      ...(filters.length ? { predicate: (occurrence: CalendarOccurrence) => filters.every(addon => this.hostHook(`Calendar add-on ${addon.id} filter`, () => addon.filterOccurrence?.(occurrence, sourceById.get(occurrence.calendarId)) !== false, true)) } : {}),
    });
    if (this.destroyed || generation !== this.renderGeneration) return;
    this.occurrences = result.occurrences;
    this.backgroundRanges = result.backgroundRanges;
    const extensionContext = { occurrences: this.occurrences, range: this.visibleRange, timeZone: this.timeZone, now: this.clock.now() };
    for (const [index, extension] of (this.options.extensions ?? []).entries()) this.hostHook(`Calendar extension ${index + 1} prepare`, () => extension.prepare?.(extensionContext), undefined);
    for (const addon of this.options.addons ?? []) this.hostHook(`Calendar add-on ${addon.id} refresh`, () => addon.onRefresh?.(this.addonContext()), undefined);
    this.occurrenceIndex.clear();
    for (const occurrence of this.occurrences) this.occurrenceIndex.set(occurrence.occurrenceId, occurrence);
    this.render();
    this.hostHook("Calendar onRangeChange callback", () => this.options.callbacks?.onRangeChange?.(this.visibleRange, this.view), undefined);
  }

  public setView(view: CalendarUiViewId): void {
    this.views.get(view);
    if (this.view === view) return;
    this.view = view;
    this.hostHook("Calendar onViewChange callback", () => this.options.callbacks?.onViewChange?.(view), undefined);
    this.requestRefresh();
  }

  public setAgendaSpan(span: CalendarAgendaSpan): void {
    if (this.agendaSpan === span) return;
    this.agendaSpan = span;
    if (this.view === "agenda") this.requestRefresh();
  }

  public goTo(value: ISODateTime | Date): void {
    this.anchor = clampNavigationDate(value, this.navigationBounds, this.timeZone);
    this.requestRefresh();
  }

  public today(): void {
    const today = this.clock.now();
    if (!this.dateInNavigationBounds(today)) return;
    this.goTo(today);
  }

  public next(): void {
    if (!this.canNavigate(1)) return;
    this.goTo(this.shiftAnchor(1));
  }

  public previous(): void {
    if (!this.canNavigate(-1)) return;
    this.goTo(this.shiftAnchor(-1));
  }

  private shiftAnchor(direction: 1 | -1): Date {
    const definition = this.activeView();
    const shifted = this.hostHook(
      `Calendar view ${definition.id} navigation`,
      () => definition.shiftAnchor(this.viewNavigationContext(), direction),
      this.anchor,
    );
    return toDate(shifted, this.timeZone);
  }

  private dateInNavigationBounds(value: Date | ISODateTime): boolean {
    return navigationDateInBounds(value, this.navigationBounds, this.timeZone);
  }

  private canNavigate(direction: 1 | -1): boolean {
    const target = clampNavigationDate(this.shiftAnchor(direction), this.navigationBounds, this.timeZone);
    return dateKey(target, this.timeZone) !== dateKey(this.anchor, this.timeZone);
  }

  private openDay(value: Date): void {
    if (!this.dateInNavigationBounds(value)) return;
    this.anchor = clampNavigationDate(value, this.navigationBounds, this.timeZone);
    if (this.view === "day") this.requestRefresh();
    else this.setView("day");
  }

  public destroy(): void {
    this.destroyed = true;
    this.gestures.destroy();
    this.temporalChrome.stop();
    this.dismissContextMenu();
    for (const addon of this.options.addons ?? []) this.hostHook(`Calendar add-on ${addon.id} destroy`, () => addon.destroy?.(), undefined);
    this.unsubscribeRepository();
    this.host.replaceChildren();
  }

  /** Mutation controls fail closed when the host has not supplied a command path or source capability. */
  private canCreateItems(): boolean {
    if (this.options.allowCreate === false) return false;
    if (!this.sources.some(source => creatableSource(source))) return false;
    return Boolean(this.options.commandHandler || this.options.callbacks?.handleCreate);
  }

  private authoritativeOccurrence(occurrence: CalendarOccurrence): CalendarOccurrence {
    return this.mutations.authoritativeOccurrence(occurrence);
  }

  private occurrenceCapabilities(occurrence: CalendarOccurrence): ResolvedCalendarOccurrenceCapabilities {
    return this.mutations.capabilities(occurrence);
  }

  private canMoveOccurrence(occurrence: CalendarOccurrence): boolean {
    return this.mutations.canMove(occurrence);
  }

  private canResizeOccurrence(occurrence: CalendarOccurrence, edge: CalendarResizeEdge): boolean {
    return this.mutations.canResize(occurrence, edge);
  }

  private canEditOccurrence(occurrence: CalendarOccurrence): boolean {
    const capabilities = this.occurrenceCapabilities(occurrence);
    const editorAuthority = capabilities.canEdit
      || capabilities.canResizeStart
      || capabilities.canResizeEnd
      || (capabilities.canMove && capabilities.canMoveBetweenAllDayAndTimed)
      || capabilities.canChangeRecurrence
      || (isPointOccurrence(occurrence) && capabilities.canMove);
    return editorAuthority && Boolean(
      this.options.callbacks?.handleEdit || this.mutations.hasCommandPath(occurrence, capabilities),
    );
  }

  /** Semantic fields are governed directly by the canonical occurrence capability resolver. */
  private canEditOccurrenceDetails(
    occurrence: CalendarOccurrence,
    capabilities = this.occurrenceCapabilities(occurrence),
  ): boolean {
    return capabilities.canEdit;
  }

  private canDeleteOccurrence(occurrence: CalendarOccurrence): boolean {
    return this.mutations.canDelete(occurrence);
  }

  private canOpenOccurrence(occurrence: CalendarOccurrence): boolean {
    return this.mutations.canOpen(occurrence);
  }

  private canInvokeActions(occurrence: CalendarOccurrence): boolean {
    return this.mutations.canInvokeActions(occurrence);
  }

  private isOccurrencePending(occurrence: CalendarOccurrence): boolean {
    return this.mutations.isPending(occurrence);
  }

  private canMoveOccurrenceToPlacement(occurrence: CalendarOccurrence, allDay: boolean): boolean {
    return this.mutations.canMoveToPlacement(occurrence, allDay);
  }

  private canDuplicateOccurrence(): boolean {
    return Boolean(this.options.commandHandler) && this.sources.some(source => creatableSource(source));
  }

  private displayOccurrences(): readonly CalendarOccurrence[] {
    return this.mutations.previewOccurrences(this.occurrences);
  }

  private mountShell(): void {
    this.host.replaceChildren();
    const style = el("style");
    const extensionCss = calendarHostCss(
      this.options.extensions ?? [],
      this.options.addons ?? [],
      (kind, index, error) => this.reportHostHookError(`Calendar ${kind} ${index + 1} styles`, error),
    );
    style.textContent = `@layer director-calendar-extension,director-calendar-base;\n@layer director-calendar-base{${CALENDAR_CSS}}\n${extensionCss ? `@layer director-calendar-extension{${extensionCss}}` : ""}`;
    const root = el("section", "dc-root");
    root.tabIndex = -1;
    root.setAttribute("aria-label", this.options.ariaLabel ?? "Calendar");
    const live = el("div", "dc-sr-only");
    live.dataset.role = "status";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    if (this.chrome.toolbar) root.append(this.toolbar());
    root.append(el("div", "dc-body"), live);
    root.addEventListener("keydown", event => this.onKeyDown(event));
    root.addEventListener("click", event => {
      if (!(event.target as Element).closest(".dc-context-menu,.dc-source-menu,.dc-addon-menu,[data-source-toggle],[data-addon-toggle]")) {
        this.dismissContextMenu();
        for (const menu of this.host.querySelectorAll<HTMLElement>(".dc-addon-menu")) menu.remove();
      }
    });
    this.host.append(style, root);
  }

  private toolbar(): HTMLElement {
    const bar = el("div", "dc-toolbar");
    if (this.chrome.createControls && this.canCreateItems()) {
      const create = this.button("+ New", () => void this.createAtAnchor(), "Create event");
      create.classList.add("dc-primary");
      bar.append(create);
    }

    const addonHost = el("div", "dc-toolbar-addons");
    for (const [index, addon] of (this.options.addons ?? []).entries()) {
      const scope = el("div", "dc-addon-scope");
      scope.dataset.calendarAddon = String(index);
      this.hostHook(`Calendar add-on ${addon.id} toolbar`, () => addon.mountToolbar?.(scope, this.addonContext()), undefined);
      if (scope.childNodes.length) addonHost.append(scope);
    }
    if (addonHost.childNodes.length) bar.append(addonHost);

    if (this.chrome.dateNavigation) {
      const today = this.button("Today", () => this.today());
      today.dataset.navigation = "today";
      const jump = this.button("Jump", () => void this.jumpToDate(), "Jump to date");
      jump.dataset.navigation = "jump";
      const previous = this.button("‹", () => this.previous(), "Previous period");
      previous.dataset.navigation = "previous";
      const next = this.button("›", () => this.next(), "Next period");
      next.dataset.navigation = "next";
      bar.append(today, jump, previous, next);
    }

    const undo = this.button("↶", () => void this.undo(), "Undo calendar change");
    undo.dataset.history = "undo";
    const redo = this.button("↷", () => void this.redo(), "Redo calendar change");
    redo.dataset.history = "redo";
    if (this.options.commandHandler?.undo) bar.append(undo);
    if (this.options.commandHandler?.redo) bar.append(redo);

    const title = el("div", "dc-title");
    title.dataset.role = "title";
    bar.append(title);

    if (this.chrome.sourceControls) {
      const sources = this.button("Calendars", () => this.toggleSourceMenu(sources), "Show or hide calendars");
      sources.dataset.sourceToggle = "true";
      bar.append(sources);
    }

    if (this.chrome.viewSwitcher) {
      const agendaSpan = el("select", "dc-input dc-agenda-span") as HTMLSelectElement;
      agendaSpan.dataset.role = "agenda-span";
      agendaSpan.setAttribute("aria-label", "Agenda range");
      for (const [value, label] of [["day", "Day list"], ["week", "Week list"], ["month", "Month list"], ["30-days", "30-day list"]] as const) {
        const option = el("option", undefined, label) as HTMLOptionElement;
        option.value = value;
        option.selected = value === this.agendaSpan;
        agendaSpan.append(option);
      }
      agendaSpan.addEventListener("change", () => this.setAgendaSpan(agendaSpan.value as CalendarAgendaSpan));
      const switcher = el("div", "dc-view-switch");
      switcher.setAttribute("role", "group");
      for (const definition of this.views.entries()) {
        const button = this.button(definition.label, () => this.setView(definition.id));
        button.dataset.view = definition.id;
        switcher.append(button);
      }
      bar.append(agendaSpan, switcher);
    }
    return bar;
  }

  private button(label: string, action: () => void, ariaLabel?: string): HTMLButtonElement {
    const button = el("button", "dc-btn", label);
    button.type = "button";
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", action);
    return button;
  }

  private render(): void {
    const root = this.host.querySelector<HTMLElement>(".dc-root");
    const body = root?.querySelector<HTMLElement>(".dc-body");
    const title = root?.querySelector<HTMLElement>("[data-role='title']");
    if (!root || !body) return;
    if (title) title.textContent = this.periodTitle();
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
      button.classList.toggle("is-active", button.dataset.view === this.view);
      button.setAttribute("aria-pressed", String(button.dataset.view === this.view));
    }
    const previous = root.querySelector<HTMLButtonElement>("[data-navigation='previous']");
    const next = root.querySelector<HTMLButtonElement>("[data-navigation='next']");
    const today = root.querySelector<HTMLButtonElement>("[data-navigation='today']");
    if (previous) previous.disabled = !this.canNavigate(-1);
    if (next) next.disabled = !this.canNavigate(1);
    if (today) today.disabled = !this.dateInNavigationBounds(this.clock.now());
    const agendaSpan = root.querySelector<HTMLSelectElement>("[data-role='agenda-span']");
    if (agendaSpan) { agendaSpan.hidden = this.view !== "agenda"; agendaSpan.value = this.agendaSpan; }
    const history = this.options.commandHandler?.historyState?.();
    const undo = root.querySelector<HTMLButtonElement>("[data-history='undo']");
    const redo = root.querySelector<HTMLButtonElement>("[data-history='redo']");
    if (undo) undo.disabled = !history?.canUndo;
    if (redo) redo.disabled = !history?.canRedo;
    body.replaceChildren();
    body.append(this.renderActiveView());
    this.temporalChrome.refresh();
  }

  private updateTodayNavigation(now: Date): void {
    const today = this.host.querySelector<HTMLButtonElement>("[data-navigation='today']");
    if (today) today.disabled = !this.dateInNavigationBounds(now);
  }

  private periodTitle(): string {
    const definition = this.activeView();
    const title = this.hostHook(
      `Calendar view ${definition.id} title`,
      () => definition.title(this.viewTitleContext()),
      definition.label,
    );
    return typeof title === "string" && title.trim() && title.length <= 4_096 ? title : definition.label;
  }

  private renderYear(): HTMLElement {
    return renderYearView(this.staticRenderModel(), this.staticRenderActions());
  }

  private renderMonth(): HTMLElement {
    return renderMonthView(this.staticRenderModel(), this.staticRenderActions());
  }

  private openMonthOverflow(date: Date, rows: readonly CalendarOccurrence[]): void {
    const dialog = el("dialog", "dc-dialog dc-overflow-dialog") as HTMLDialogElement;
    dialog.setAttribute("aria-label", `Events on ${new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(date)}`);
    const header = el("div", "dc-dialog-header");
    header.append(el("h2", undefined, new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(date)));
    const close = el("button", "dc-icon-btn", "×") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dialog.close());
    header.append(close);
    const body = el("div", "dc-dialog-body dc-overflow-list");
    for (const occurrence of rows) {
      const event = this.monthEvent(occurrence, false, false);
      event.classList.add("dc-overflow-event");
      event.addEventListener("click", eventClick => {
        eventClick.stopPropagation();
        dialog.close();
        void this.openDetails(occurrence);
      });
      event.addEventListener("contextmenu", eventContext => eventContext.preventDefault());
      body.append(event);
    }
    dialog.append(header, body);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    this.host.append(dialog);
    dialog.showModal();
    body.querySelector<HTMLElement>(".dc-event-main")?.focus();
  }

  private monthEvent(occurrence: CalendarOccurrence, allowDrag = true, bindInteractions = true): HTMLElement {
    const event = el("div", "dc-event");
    event.dataset.occurrenceId = occurrence.occurrenceId;
    event.dataset.emphasis = occurrence.display?.emphasis ?? "normal";
    event.dataset.dimmed = String(Boolean(occurrence.display?.dimmed));
    event.dataset.kind = occurrence.kind;
    event.dataset.temporalForm = occurrence.temporalForm ?? "interval";
    event.classList.toggle("is-point", isPointOccurrence(occurrence));
    this.applyOccurrencePresentation(event, occurrence);

    const main = el("button", "dc-occurrence-main dc-event-main");
    main.type = "button";
    main.setAttribute("aria-label", this.occurrenceAriaLabel(occurrence));
    const timeText = !occurrence.allDay && occurrence.precision !== "date" ? formatTime(toDate(occurrence.start), this.locale, this.timeZone) : undefined;
    main.append(this.occurrenceContent(occurrence, timeText));
    event.title = this.presentationTitle(occurrence);
    event.append(main);
    const actions = this.inlineActionBar(occurrence);
    if (actions) event.append(actions);

    if (bindInteractions) this.bindOccurrenceElement(main, occurrence);
    if (bindInteractions && allowDrag && this.options.allowDrag !== false && this.canMoveOccurrence(occurrence)) {
      this.bindNativeDrag(event, occurrence);
      event.addEventListener("pointerdown", pointer => {
        if ((pointer.target as Element).closest(".dc-inline-action")) return;
        if (pointer.pointerType === "touch") this.beginDrag(pointer, occurrence, event, "move");
      });
    }
    return event;
  }

  private renderTimeGrid(dayCount: 1 | 7): HTMLElement {
    const shell = el("div", "dc-time-shell");
    shell.dataset.dayCount = String(dayCount);
    shell.setAttribute("role", "group");
    shell.setAttribute("aria-label", dayCount === 1 ? "Day calendar" : "Week calendar");
    const start = dayCount === 7 ? toDate(this.visibleRange.start) : startOfDay(this.anchor, this.timeZone);
    const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i, this.timeZone));
    const axis = el("div", "dc-time-axis");
    axis.dataset.timeZone = this.timeZone;
    axis.setAttribute("aria-label", `Primary time scale: ${this.timeZone}`);
    for (let hour = this.dayStartHour; hour < this.dayEndHour; hour += 1) {
      const transitions = days.map(day => civilMinuteResolution(day, hour * 60, this.timeZone).kind);
      const gap = transitions.includes("gap");
      const overlap = transitions.includes("overlap");
      const text = `${String(hour).padStart(2, "0")}:00${overlap ? " ×2" : ""}`;
      const label = el("div", "dc-time-axis-label", text);
      label.dataset.transition = gap ? "gap" : overlap ? "overlap" : "none";
      if (gap) label.title = "This local hour contains a time-zone transition gap and cannot be targeted.";
      else if (overlap) label.title = `This local hour occurs twice; interactions target the ${this.dstOverlapDisambiguation} occurrence.`;
      axis.append(label);
    }
    const secondaryAxis = this.secondaryTimeZone ? this.secondaryTimeAxis(days, this.secondaryTimeZone) : null;
    shell.classList.toggle("has-secondary-time-zone", Boolean(secondaryAxis));
    const content = el("div", "dc-time-content");
    const headers = el("div", "dc-day-headers");
    headers.style.gridTemplateColumns = `repeat(${dayCount},minmax(0,1fr))`;
    const allDay = el("div", "dc-all-day");
    allDay.style.gridTemplateColumns = `repeat(${dayCount},minmax(0,1fr))`;
    const grid = el("div", "dc-time-grid");
    grid.style.gridTemplateColumns = `repeat(${dayCount},minmax(0,1fr))`;
    grid.style.minHeight = `${(this.dayEndHour - this.dayStartHour) * 60}px`;
    const buckets = groupByDay(this.displayOccurrences(), this.timeZone, this.visibleRange);
    const backgroundBuckets = groupAllDayBackgroundRangesByDay(this.backgroundRanges, this.timeZone, this.visibleRange);

    for (const day of days) {
      const inBounds = this.dateInNavigationBounds(day);
      const head = el("button", "dc-day-header");
      head.type = "button";
      head.dataset.calendarDate = day.toISOString();
      head.disabled = !inBounds;
      head.classList.toggle("is-out-of-bounds", !inBounds);
      head.append(el("strong", undefined, new Intl.DateTimeFormat(this.locale, { weekday: "short", timeZone: this.timeZone }).format(day)), el("span", undefined, new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "short", timeZone: this.timeZone }).format(day)));
      head.addEventListener("click", () => this.openDay(day));
      headers.append(head);
      const all = el("div", "dc-all-day-col");
      all.dataset.date = day.toISOString();
      all.dataset.calendarDate = day.toISOString();
      all.classList.toggle("is-out-of-bounds", !inBounds);
      if (!inBounds) all.setAttribute("aria-disabled", "true");
      all.setAttribute("role", "group");
      const dayBackgrounds = backgroundBuckets.get(dateKey(day, this.timeZone)) ?? [];
      all.setAttribute("aria-label", `All-day events for ${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(day)}${this.backgroundAriaSuffix(dayBackgrounds)}`);
      if (inBounds && dayBackgrounds.length) all.append(this.dayLevelBackgroundLayer(dayBackgrounds));
      for (const occurrence of buckets.get(dateKey(day, this.timeZone))?.allDay ?? []) all.append(this.monthEvent(occurrence));
      all.addEventListener("dragover", event => {
        const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
        if (inBounds && occurrence && this.canMoveOccurrenceToPlacement(occurrence, true)) event.preventDefault();
      });
      all.addEventListener("drop", event => {
        const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
        if (!inBounds || !occurrence || !this.canMoveOccurrenceToPlacement(occurrence, true)) return;
        event.preventDefault();
        void this.moveToDay(occurrence, day, true);
      });
      if (inBounds && this.canCreateItems()) all.addEventListener("dblclick", () => void this.createFromSelection({ start: startOfDay(day, this.timeZone).toISOString(), end: addDays(startOfDay(day, this.timeZone), 1, this.timeZone).toISOString(), allDay: true }));
      allDay.append(all);
      grid.append(this.timeColumn(day));
    }
    content.append(headers, allDay, grid);
    shell.append(axis);
    if (secondaryAxis) shell.append(secondaryAxis);
    shell.append(content);
    return shell;
  }

  private secondaryTimeAxis(days: readonly Date[], timeZone: string): HTMLElement {
    const axis = el("div", "dc-time-axis dc-secondary-time-axis");
    axis.dataset.timeZone = timeZone;
    axis.setAttribute("aria-label", `Secondary time scale: ${timeZone}`);
    axis.title = timeZone;
    for (const label of secondaryTimeScaleLabels(days, this.timeZone, timeZone, this.dayStartHour, this.dayEndHour, this.locale)) {
      const node = el("div", "dc-time-axis-label dc-secondary-time-axis-label", label.text);
      node.classList.toggle("is-variable", label.variesAcrossDays);
      node.dataset.transition = label.transition;
      node.setAttribute("aria-label", label.accessibleLabel);
      node.title = label.accessibleLabel;
      axis.append(node);
    }
    return axis;
  }

  private backgroundAriaSuffix(ranges: readonly CalendarBackgroundRange[]): string {
    return backgroundAriaSuffix(ranges);
  }

  private dayLevelBackgroundLayer(ranges: readonly CalendarBackgroundRange[]): HTMLElement {
    return dayLevelBackgroundLayer(ranges, (element, range) => this.applyBackgroundPresentation(element, range));
  }

  private backgroundLayer(day: Date): HTMLElement {
    const layer = el("div", "dc-background-layer");
    layer.setAttribute("data-role", "background-ranges");
    const layouts = layoutBackgroundDay(
      this.backgroundRanges.filter(range => range.allDay !== true),
      day,
      {
        timeZone: this.timeZone,
        startMinute: this.dayStartHour * 60,
        endMinute: this.dayEndHour * 60,
      },
    );
    const visibleStart = this.dayStartHour * 60;
    for (const layout of layouts) {
      const range = layout.range;
      const background = el("div", "dc-background-range");
      background.dataset.backgroundRangeId = range.id;
      background.style.top = `${layout.topMinutes - visibleStart}px`;
      background.style.height = `${layout.heightMinutes}px`;
      background.style.zIndex = String(layout.layer);
      this.applyBackgroundPresentation(background, range);
      if (range.label) {
        const label = el("span", "dc-background-range-label", range.label);
        background.append(label);
        background.setAttribute("role", "note");
        background.setAttribute(
          "aria-label",
          `${range.label}. ${formatDateTime(toDate(range.start), this.locale, this.timeZone)} to ${formatDateTime(toDate(range.end), this.locale, this.timeZone)}`,
        );
      } else {
        background.setAttribute("aria-hidden", "true");
      }
      layer.append(background);
    }
    return layer;
  }

  private timeColumn(day: Date): HTMLElement {
    const column = el("div", "dc-time-column");
    const inBounds = this.dateInNavigationBounds(day);
    column.dataset.date = day.toISOString();
    column.dataset.calendarDate = day.toISOString();
    column.classList.toggle("is-out-of-bounds", !inBounds);
    if (!inBounds) column.setAttribute("aria-disabled", "true");
    column.setAttribute("role", "group");
    column.setAttribute("aria-label", `Timed events for ${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(day)}`);
    if (inBounds) column.append(this.backgroundLayer(day));
    const layouts = layoutTimedDay(this.displayOccurrences(), day, this.timeZone);
    for (const layout of layouts) {
      const occurrence = layout.occurrence;
      const event = el("div", "dc-time-event");
      event.setAttribute("role", "group");
      event.dataset.occurrenceId = occurrence.occurrenceId;
      event.dataset.emphasis = occurrence.display?.emphasis ?? "normal";
      event.dataset.dimmed = String(Boolean(occurrence.display?.dimmed));
      event.dataset.kind = occurrence.kind;
      event.dataset.temporalForm = layout.temporalForm;
      event.classList.toggle("dc-time-point", layout.temporalForm === "point");
      this.applyOccurrencePresentation(event, occurrence);
      const startMinute = layout.topMinutes - this.dayStartHour * 60;
      const endMinute = startMinute + layout.heightMinutes;
      if (layout.temporalForm === "point" ? (startMinute < 0 || startMinute >= (this.dayEndHour - this.dayStartHour) * 60) : (endMinute <= 0 || startMinute >= (this.dayEndHour - this.dayStartHour) * 60)) continue;
      const top = Math.max(0, startMinute);
      const height = layout.temporalForm === "point" ? 20 : Math.max(18, Math.min((this.dayEndHour - this.dayStartHour) * 60 - top, layout.heightMinutes));
      const width = 100 / layout.columnCount;
      const baseLeft = layout.column * width;
      const baseRight = (layout.column + layout.columnSpan) * width;
      const baseWidth = baseRight - baseLeft;
      const visualLeft = baseLeft + (baseWidth * layout.visualLane) / layout.visualLaneCount;
      const visualRight = baseLeft + (baseWidth * (layout.visualLane + 1)) / layout.visualLaneCount;
      event.style.top = `${top}px`;
      event.style.height = `${height}px`;
      event.style.left = `calc(${visualLeft}% + 2px)`;
      event.style.right = `calc(${100 - visualRight}% + 2px)`;
      event.style.zIndex = String(2 + layout.column);
      const timeText = isPointOccurrence(occurrence)
        ? formatTime(toDate(occurrence.start), this.locale, this.timeZone)
        : `${formatTime(toDate(occurrence.start), this.locale, this.timeZone)} – ${formatTime(toDate(occurrence.end), this.locale, this.timeZone)}`;
      const main = el("button", "dc-occurrence-main dc-time-event-main");
      main.type = "button";
      main.setAttribute("aria-label", this.occurrenceAriaLabel(occurrence));
      main.append(this.occurrenceContent(occurrence, timeText));
      event.append(main);
      const actions = this.inlineActionBar(occurrence);
      if (actions) event.append(actions);
      this.bindOccurrenceElement(main, occurrence);
      if (this.options.allowDrag !== false && this.canMoveOccurrence(occurrence)) {
        event.addEventListener("pointerdown", pointer => {
          if ((pointer.target as Element).closest(".dc-resize-handle,.dc-inline-action")) return;
          this.beginDrag(pointer, occurrence, event, "move");
        });
      }
      if (this.options.allowResize !== false && this.canResizeOccurrence(occurrence, "start")) {
        const startHandle = el("div", "dc-resize-handle dc-resize-start");
        startHandle.setAttribute("aria-hidden", "true");
        startHandle.addEventListener("pointerdown", pointer => this.beginDrag(pointer, occurrence, event, "resize-start"));
        event.append(startHandle);
      }
      if (this.options.allowResize !== false && this.canResizeOccurrence(occurrence, "end")) {
        const endHandle = el("div", "dc-resize-handle dc-resize-end");
        endHandle.setAttribute("aria-hidden", "true");
        endHandle.addEventListener("pointerdown", pointer => this.beginDrag(pointer, occurrence, event, "resize-end"));
        event.append(endHandle);
      }
      column.append(event);
    }

    column.addEventListener("dragover", event => {
      const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
      if (inBounds && occurrence && this.canMoveOccurrenceToPlacement(occurrence, false)) event.preventDefault();
    });
    column.addEventListener("drop", event => {
      const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
      if (!inBounds || !occurrence || !this.canMoveOccurrenceToPlacement(occurrence, false)) return;
      event.preventDefault();
      const rect = column.getBoundingClientRect();
      const minutes = this.dayStartHour * 60 + Math.max(0, event.clientY - rect.top);
      const target = this.timeAtGridMinute(day, minutes, this.snapPolicy.move, "Move");
      if (!target) return;
      const dateLike = isDateLikeOccurrence(occurrence);
      const end = new Date(target.getTime() + (dateLike ? 60 * 60_000 : durationMs(occurrence)));
      void (async () => {
        if (!await this.allowPlacement(target, end, false, occurrence, "move")) return;
        const patch = dateLike
          ? placementTimePatch(target, end, false, this.timeZone)
          : { start: target.toISOString(), end: end.toISOString(), allDay: false, precision: "minute" as const };
        await this.mutations.issueOccurrencePatch(occurrence, patch, "Move", this.mutations.moveRequirements(occurrence, false), "move");
      })();
    });

    if (inBounds && this.canCreateItems()) {
      column.addEventListener("pointerdown", event => {
        if (event.button !== 0 || (event.target as Element).closest(".dc-time-event")) return;
        if (event.pointerType === "touch") return;
        this.beginRangeSelection(event, day, column);
      });
      column.addEventListener("dblclick", event => {
        if ((event.target as Element).closest(".dc-time-event")) return;
        const rect = column.getBoundingClientRect();
        const minute = this.dayStartHour * 60 + (event.clientY - rect.top);
        const start = this.timeAtGridMinute(day, minute, this.snapPolicy.selection, "Creation");
        if (!start) return;
        void this.createFromSelection({ start: start.toISOString(), end: new Date(start.getTime() + 60 * 60_000).toISOString(), allDay: false });
      });
    }

    return column;
  }

  private bindOccurrenceElement(node: HTMLElement, occurrence: CalendarOccurrence): void {
    const shortcuts: string[] = [];
    if (this.canOpenOccurrence(occurrence)) shortcuts.push("Enter", "Space");
    if (this.canEditOccurrence(occurrence)) shortcuts.push("E");
    if (this.canDeleteOccurrence(occurrence)) shortcuts.push("Delete");
    if (this.canMoveOccurrence(occurrence)) shortcuts.push("Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown");
    if (this.canResizeOccurrence(occurrence, "end")) shortcuts.push("Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown");
    if (shortcuts.length) node.setAttribute("aria-keyshortcuts", shortcuts.join(" "));
    node.addEventListener("click", event => {
      event.stopPropagation();
      if (this.gestures.shouldSuppressOccurrenceClick() || this.isOccurrencePending(occurrence) || !this.canOpenOccurrence(occurrence)) return;
      void this.openDetails(occurrence);
    });
    node.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      this.openContextMenu(occurrence, event.clientX, event.clientY);
    });
    node.addEventListener("keydown", event => {
      if (this.isOccurrencePending(occurrence)) return;
      if (event.altKey && event.key.startsWith("Arrow") && (event.shiftKey ? this.canResizeOccurrence(occurrence, "end") : this.canMoveOccurrence(occurrence))) {
        event.preventDefault();
        event.stopPropagation();
        void this.keyboardTransformOccurrence(occurrence, event.key, event.shiftKey);
      } else if ((event.key === "Enter" || event.key === " ") && this.canOpenOccurrence(occurrence)) { event.preventDefault(); void this.openDetails(occurrence); }
      else if (event.key.toLowerCase() === "e" && this.canEditOccurrence(occurrence)) { event.preventDefault(); void this.editOccurrence(occurrence); }
      else if (event.key === "Delete" && this.canDeleteOccurrence(occurrence)) { event.preventDefault(); void this.deleteOccurrence(occurrence); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && this.canDuplicateOccurrence()) { event.preventDefault(); void this.duplicateOccurrence(occurrence); }
    });
  }

  private bindNativeDrag(node: HTMLElement, occurrence: CalendarOccurrence): void {
    node.draggable = true;
    node.addEventListener("dragstart", event => {
      event.dataTransfer?.setData(NATIVE_DRAG_TYPE, occurrence.occurrenceId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      node.classList.add("is-dragging");
      this.setDraggingState(true);
    });
    node.addEventListener("dragend", () => { node.classList.remove("is-dragging"); this.setDraggingState(false); });
  }

  private dragOccurrenceFromTransfer(dataTransfer: DataTransfer | null): CalendarOccurrence | undefined {
    const id = dataTransfer?.getData(NATIVE_DRAG_TYPE);
    return id ? this.occurrenceIndex.get(id) : undefined;
  }

  private beginDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: CalendarDragMode): void {
    this.gestures.beginDrag(pointer, occurrence, element, mode);
  }

  private async finishDrag(pointer: PointerEvent, drag: CalendarDragState): Promise<void> {
    const body = this.host.querySelector<HTMLElement>(".dc-body");
    const scrollDelta = (body?.scrollTop ?? 0) - drag.scrollStartTop;
    const totalDelta = pointer.clientY - drag.pointerStartY + scrollDelta;

    drag.element.style.pointerEvents = "none";
    const under = document.elementFromPoint(pointer.clientX, pointer.clientY) as HTMLElement | null;
    drag.element.style.pointerEvents = "";

    if (drag.mode !== "move") {
      const edge = dragResizeEdge(drag.mode);
      const targetColumn = under?.closest<HTMLElement>(".dc-time-column");
      let target: Date;
      if (targetColumn?.dataset.date) {
        const day = toDate(targetColumn.dataset.date);
        const rect = targetColumn.getBoundingClientRect();
        const minute = this.dayStartHour * 60 + (pointer.clientY - rect.top);
        const resolved = this.timeAtGridMinute(day, minute, this.snapPolicy.resize, "Resize");
        if (!resolved) return;
        target = resolved;
      } else {
        const delta = snapDragDeltaMinutes(totalDelta, this.slotMinutes, this.snapPolicy.resize);
        if (!delta) return;
        const shifted = shiftCivilMinutes(edge === "start" ? drag.originalStart : drag.originalEnd, delta, this.timeZone, this.dstOverlapDisambiguation);
        if (!shifted) { this.announce("Resize is unavailable because the target local time does not exist."); return; }
        target = shifted;
      }
      const resized = resizeInterval(drag.originalStart, drag.originalEnd, target, edge, this.slotMinutes);
      if (resized.start.getTime() === drag.originalStart.getTime() && resized.end.getTime() === drag.originalEnd.getTime()) return;
      if (!await this.allowPlacement(resized.start, resized.end, false, drag.occurrence, "resize")) return;
      await this.mutations.issueTimedCommand({ type: "resize-occurrence", occurrence: drag.occurrence, start: resized.start.toISOString(), end: resized.end.toISOString(), scope: "this" }, "Resize", [edge === "start" ? "canResizeStart" : "canResizeEnd"]);
      return;
    }

    const monthTarget = under?.closest<HTMLElement>(".dc-day-cell");
    if (monthTarget?.dataset.date) {
      await this.moveToDay(drag.occurrence, toDate(monthTarget.dataset.date), isDateLikeOccurrence(drag.occurrence));
      return;
    }
    const allDayTarget = under?.closest<HTMLElement>(".dc-all-day-col");
    if (allDayTarget?.dataset.date) {
      if (!this.canMoveOccurrenceToPlacement(drag.occurrence, true)) {
        this.announce(`${drag.occurrence.title}: this move is not allowed.`);
        return;
      }
      const day = toDate(allDayTarget.dataset.date);
      const start = startOfDay(day, this.timeZone);
      const days = calendarDaySpan(toDate(drag.occurrence.start), toDate(drag.occurrence.end), this.timeZone);
      const end = addDays(start, days, this.timeZone);
      if (!await this.allowPlacement(start, end, true, drag.occurrence, "move")) return;
      await this.mutations.issueOccurrencePatch(drag.occurrence, placementTimePatch(start, end, true, this.timeZone), "Move", this.mutations.moveRequirements(drag.occurrence, true), "move");
      return;
    }
    const column = under?.closest<HTMLElement>(".dc-time-column");
    if (column?.dataset.date) {
      if (!this.canMoveOccurrenceToPlacement(drag.occurrence, false)) {
        this.announce(`${drag.occurrence.title}: this move is not allowed.`);
        return;
      }
      const day = toDate(column.dataset.date);
      const rect = column.getBoundingClientRect();
      const rawMinute = this.dayStartHour * 60 + (pointer.clientY - rect.top) - drag.grabOffsetMinutes;
      const start = this.timeAtGridMinute(day, rawMinute, this.snapPolicy.move, "Move");
      if (!start) return;
      const dateLike = isDateLikeOccurrence(drag.occurrence);
      const end = new Date(start.getTime() + (dateLike ? 60 * 60_000 : durationMs(drag.occurrence)));
      if (!await this.allowPlacement(start, end, false, drag.occurrence, "move")) return;
      if (dateLike) await this.mutations.issueOccurrencePatch(drag.occurrence, placementTimePatch(start, end, false, this.timeZone), "Move", this.mutations.moveRequirements(drag.occurrence, false), "move");
      else await this.mutations.issueTimedCommand({ type: "move-occurrence", occurrence: drag.occurrence, start: start.toISOString(), end: end.toISOString(), scope: "this" }, "Move", ["canMove"]);
      return;
    }
    const deltaMinutes = snapDragDeltaMinutes(totalDelta, this.slotMinutes, this.snapPolicy.move);
    if (!deltaMinutes) return;
    const start = shiftCivilMinutes(drag.originalStart, deltaMinutes, this.timeZone, this.dstOverlapDisambiguation);
    const end = shiftCivilMinutes(drag.originalEnd, deltaMinutes, this.timeZone, this.dstOverlapDisambiguation);
    if (!start || !end) { this.announce("Move is unavailable because the target local time does not exist."); return; }
    if (!await this.allowPlacement(start, end, false, drag.occurrence, "move")) return;
    await this.mutations.issueTimedCommand({ type: "move-occurrence", occurrence: drag.occurrence, start: start.toISOString(), end: end.toISOString(), scope: "this" }, "Move", ["canMove"]);
  }

  private timeAtGridMinute(
    day: Date,
    minute: number,
    strategy: import("../core/types.js").CalendarSnapStrategy,
    action: string,
  ): Date | null {
    const snapped = snapMinuteCoordinate(minute, this.slotMinutes, strategy);
    const target = instantAtCivilMinute(day, snapped, this.timeZone, this.dstOverlapDisambiguation);
    if (!target) this.announce(`${action} is unavailable because that local time does not exist during the time-zone transition.`);
    return target;
  }

  private beginRangeSelection(pointer: PointerEvent, day: Date, column: HTMLElement): void {
    pointer.preventDefault();
    pointer.stopPropagation();
    const rect = column.getBoundingClientRect();
    const minMinute = this.dayStartHour * 60;
    const maxMinute = this.dayEndHour * 60;
    const rawMinute = Math.min(maxMinute, Math.max(minMinute, minMinute + pointer.clientY - rect.top));
    const startDate = this.timeAtGridMinute(day, rawMinute, this.snapPolicy.selection, "Selection");
    if (!startDate) return;
    const startParts = instantToPlain(startDate.getTime(), this.timeZone);
    const startMinute = Math.min(maxMinute - this.slotMinutes, Math.max(minMinute, startParts.hour * 60 + startParts.minute));
    const overlay = el("div", "dc-selection-range");
    overlay.setAttribute("aria-hidden", "true");
    column.append(overlay);
    try { column.setPointerCapture(pointer.pointerId); } catch { /* no-op */ }
    this.selectionDrag = { pointerId: pointer.pointerId, day, column, overlay, startMinute, startClientY: pointer.clientY, currentMinute: startMinute + this.slotMinutes, moved: false };
    this.renderSelectionRange();
    const move = (event: PointerEvent) => {
      if (!this.selectionDrag || event.pointerId !== this.selectionDrag.pointerId) return;
      event.preventDefault();
      const box = column.getBoundingClientRect();
      if (Math.abs(event.clientY - this.selectionDrag.startClientY) >= 3) this.selectionDrag.moved = true;
      const minute = Math.min(this.dayEndHour * 60, Math.max(this.dayStartHour * 60, this.dayStartHour * 60 + event.clientY - box.top));
      const next = this.timeAtGridMinute(day, minute, this.snapPolicy.selection, "Selection");
      if (!next) return;
      const nextParts = instantToPlain(next.getTime(), this.timeZone);
      const nextMinute = nextParts.hour * 60 + nextParts.minute;
      this.selectionDrag.currentMinute = minute >= this.dayEndHour * 60 - this.slotMinutes / 2
        ? this.dayEndHour * 60
        : Math.min(this.dayEndHour * 60, Math.max(this.dayStartHour * 60, nextMinute));
      this.renderSelectionRange();
    };
    const end = (event: PointerEvent) => {
      if (!this.selectionDrag || event.pointerId !== this.selectionDrag.pointerId) return;
      column.removeEventListener("pointermove", move);
      column.removeEventListener("pointerup", end);
      column.removeEventListener("pointercancel", cancel);
      const selection = this.selectionDrag;
      this.selectionDrag = null;
      selection.overlay.remove();
      const a = Math.min(selection.startMinute, selection.currentMinute);
      let b = Math.max(selection.startMinute, selection.currentMinute);
      if (!selection.moved) b = Math.min(this.dayEndHour * 60, a + 60);
      if (b <= a) b = Math.min(this.dayEndHour * 60, a + this.slotMinutes);
      const start = this.timeAtGridMinute(day, a, "none", "Selection");
      const finish = this.timeAtGridMinute(day, b, "none", "Selection");
      if (!start || !finish) return;
      void this.createFromSelection({ start: start.toISOString(), end: finish.toISOString(), allDay: false });
    };
    const cancel = (event: PointerEvent) => {
      if (!this.selectionDrag || event.pointerId !== this.selectionDrag.pointerId) return;
      column.removeEventListener("pointermove", move);
      column.removeEventListener("pointerup", end);
      column.removeEventListener("pointercancel", cancel);
      this.selectionDrag.overlay.remove();
      this.selectionDrag = null;
    };
    column.addEventListener("pointermove", move);
    column.addEventListener("pointerup", end);
    column.addEventListener("pointercancel", cancel);
  }

  private renderSelectionRange(): void {
    const selection = this.selectionDrag;
    if (!selection) return;
    const start = Math.min(selection.startMinute, selection.currentMinute) - this.dayStartHour * 60;
    const end = Math.max(selection.startMinute, selection.currentMinute) - this.dayStartHour * 60;
    selection.overlay.style.top = `${Math.max(0, start)}px`;
    selection.overlay.style.height = `${Math.max(this.slotMinutes, end - start)}px`;
  }

  private renderAgenda(): HTMLElement {
    return renderAgendaView(this.staticRenderModel(), this.staticRenderActions());
  }

  private staticRenderModel(): CalendarStaticRenderModel {
    return {
      locale: this.locale,
      timeZone: this.timeZone,
      weekStartsOn: this.weekStartsOn,
      anchor: this.anchor,
      visibleRange: this.visibleRange,
      agendaSpan: this.agendaSpan,
      occurrences: this.displayOccurrences(),
      backgroundRanges: this.backgroundRanges,
      now: this.clock.now(),
    };
  }

  private staticRenderActions(): CalendarStaticRenderActions {
    return {
      dateInNavigationBounds: date => this.dateInNavigationBounds(date),
      monthInNavigationBounds: (firstDateKey, lastDateKey) =>
        (!this.navigationBounds.min || lastDateKey >= this.navigationBounds.min)
        && (!this.navigationBounds.max || firstDateKey <= this.navigationBounds.max),
      openDay: date => this.openDay(date),
      openMonth: (monthStart, firstDateKey) => {
        const target = this.navigationBounds.min && firstDateKey < this.navigationBounds.min
          ? toDate(this.navigationBounds.min, this.timeZone)
          : monthStart;
        this.anchor = clampNavigationDate(target, this.navigationBounds, this.timeZone);
        this.setView("month");
      },
      monthEvent: (occurrence, allowDrag = true, bindInteractions = true) => this.monthEvent(occurrence, allowDrag, bindInteractions),
      openMonthOverflow: (date, rows) => this.openMonthOverflow(date, rows),
      applyBackgroundPresentation: (element, range) => this.applyBackgroundPresentation(element, range),
      dragOccurrenceFromTransfer: transfer => this.dragOccurrenceFromTransfer(transfer),
      canMoveOccurrence: occurrence => this.canMoveOccurrence(occurrence),
      moveToDay: (occurrence, day, allDay) => this.moveToDay(occurrence, day, allDay),
      canCreateItems: () => this.canCreateItems(),
      createFromSelection: selection => this.createFromSelection(selection),
      addonEmptyMessage: () => this.addonEmptyMessage(),
      agendaSummaries: (date, occurrences) => (this.options.extensions ?? [])
        .map((extension, index) => this.hostHook(
          `Calendar extension ${index + 1} agenda presentation`,
          () => extension.presentAgendaDay?.(date, occurrences)?.summary,
          undefined,
        ))
        .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 4_096)
        .slice(0, 16),
      occurrencePresentation: occurrence => this.occurrencePresentation(occurrence),
      applyOccurrencePresentation: (element, occurrence) => this.applyOccurrencePresentation(element, occurrence),
    };
  }

  private createCalendarItem(draft: CalendarCreateDraft, purpose: CalendarItemFactoryInput["purpose"], original?: CalendarOccurrence): CalendarItem {
    const now = this.clock.now().toISOString();
    const id = `calendar:${crypto.randomUUID()}`;
    if (this.options.itemFactory) return this.options.itemFactory({ id, now, purpose, draft, ...(original ? { original } : {}) });
    return {
      ...draft, id,
      ownership: draft.ownership ?? this.options.defaultOwnership ?? "calendar",
      editPolicy: draft.editPolicy ?? this.options.defaultEditPolicy ?? "full",
      createdAt: now, updatedAt: now,
    };
  }

  private async createAtAnchor(): Promise<void> {
    const day = startOfDay(this.anchor, this.timeZone);
    const now = this.clock.now();
    let start = this.timeAtGridMinute(day, 9 * 60, "none", "Creation");
    if (sameLocalDay(day, now, this.timeZone)) {
      const proposed = new Date(now.getTime() + 30 * 60_000);
      start = this.timeAtGridMinute(day, civilMinuteOfInstant(proposed, day, this.timeZone), "ceil", "Creation");
    }
    if (!start) return;
    await this.createFromSelection({ start: start.toISOString(), end: new Date(start.getTime() + 60 * 60_000).toISOString(), allDay: false });
  }

  private async createFromSelection(selection: CalendarSelection): Promise<void> {
    const selectionStart = toDate(selection.start);
    const selectionEnd = toDate(selection.end);
    if (!placementInNavigationBounds(selectionStart, selectionEnd, this.navigationBounds, this.timeZone)) {
      this.announce("Creation is outside the allowed calendar date range.");
      return;
    }
    this.hostHook("Calendar onCreate callback", () => this.options.callbacks?.onCreate?.(selection), undefined);
    const createHandler = this.options.callbacks?.handleCreate;
    if (createHandler && await this.hostHookAsync("Calendar handleCreate callback", () => createHandler(selection, this.placementValidationPort()), false)) return;
    if (!this.options.commandHandler) {
      this.announce("Creation was not handled by the host and no built-in command handler is available.");
      return;
    }
    const result = await openEventEditor(this.host, { selection }, this.sources, this.defaultCalendarId, this.weekStartsOn, this.timeZone, this.kindOptions(), this.options.reminderChannelOptions, {}, this.dstOverlapDisambiguation);
    if (!result) return;
    const item = this.createCalendarItem({
      calendarId: result.calendarId,
      title: result.title,
      ...(result.description ? { description: result.description } : {}),
      ...(result.location ? { location: result.location } : {}),
      start: result.start,
      end: result.end,
      allDay: result.allDay,
      precision: result.allDay ? "date" : "minute",
      temporal: result.temporal,
      kind: result.kind,
      ...(result.recurrence ? { recurrence: result.recurrence } : {}),
      ...(result.reminders ? { reminders: result.reminders } : {}),
    }, "create");
    const withSeries = result.recurrence ? { ...item, seriesId: item.id } : item;
    if (!await this.mutations.allowDraftPlacement(withSeries, undefined, "create")) return;
    await this.mutations.dispatch({ type: "create", item: withSeries });
  }

  private async openDetails(occurrence: CalendarOccurrence): Promise<void> {
    if (this.isOccurrencePending(occurrence) || !this.canOpenOccurrence(occurrence)) return;
    this.hostHook("Calendar onOpen callback", () => this.options.callbacks?.onOpen?.(occurrence), undefined);
    const openHandler = this.options.callbacks?.handleOpen;
    if (openHandler && await this.hostHookAsync("Calendar handleOpen callback", () => openHandler(occurrence), false)) return;
    const presentation = this.occurrencePresentation(occurrence);
    const presentedTitle = presentation.title?.text ?? occurrence.title;
    const dialog = el("dialog", "dc-dialog dc-details-dialog");
    dialog.setAttribute("aria-label", `${presentation.accessibleLabel ?? presentation.title?.accessibleLabel ?? presentedTitle} details`);
    const card = el("div", "dc-details");
    const header = el("div", "dc-dialog-header");
    const heading = el("div", "dc-details-heading");
    if (presentation.icon) {
      const icon = el("span", "dc-details-icon", presentation.icon.text);
      if (presentation.icon.accessibleLabel) icon.setAttribute("aria-label", presentation.icon.accessibleLabel);
      else icon.setAttribute("aria-hidden", "true");
      heading.append(icon);
    }
    heading.append(el("h2", undefined, presentedTitle));
    if (presentation.subtitle) heading.append(el("div", "dc-details-subtitle", presentation.subtitle.text));
    header.append(heading);
    const close = el("button", "dc-icon-btn", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dialog.close());
    header.append(close);
    const body = el("div", "dc-dialog-body");
    const allDayEnd = new Date(toDate(occurrence.end).getTime() - 1);
    const allDayStart = toDate(occurrence.start);
    const allDayText = sameLocalDay(allDayStart, allDayEnd, this.timeZone)
      ? new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(allDayStart)
      : `${new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "short", year: "numeric", timeZone: this.timeZone }).format(allDayStart)} – ${new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "short", year: "numeric", timeZone: this.timeZone }).format(allDayEnd)}`;
    const when = occurrence.allDay || occurrence.precision === "date"
      ? `${allDayText} · All day`
      : isPointOccurrence(occurrence)
        ? formatDateTime(toDate(occurrence.start), this.locale, this.timeZone)
        : `${formatDateTime(toDate(occurrence.start), this.locale, this.timeZone)} – ${formatDateTime(toDate(occurrence.end), this.locale, this.timeZone)}`;
    body.append(this.detailRow("When", when), this.detailRow("Calendar", this.sourceTitle(occurrence.calendarId)), this.detailRow("Type", this.kindLabel(occurrence.kind)));
    if (occurrence.recurring) body.append(this.detailRow("Repeat", "Recurring series"));
    if (occurrence.location) body.append(this.detailRow("Location", occurrence.location));
    if (occurrence.description) body.append(this.detailRow("Notes", occurrence.description));
    for (const row of presentation.detailRows) body.append(this.detailRow(row.label, row.value));
    const activeReminders = occurrence.reminders?.filter(reminder => reminder.enabled !== false) ?? [];
    if (activeReminders.length) body.append(this.detailRow("Reminder", activeReminders.map(reminder => `${reminder.minutesBefore === 0 ? "At start" : `${reminder.minutesBefore}m before`} · ${reminder.channel}`).join(", ")));
    if (occurrence.editPolicy !== "full") {
      const capabilities = this.occurrenceCapabilities(occurrence);
      const access = this.canEditOccurrenceDetails(occurrence, capabilities)
        ? "Host-authorized editing"
        : occurrence.editPolicy === "schedule-only" ? "Schedule changes only" : "Read-only";
      body.append(this.detailRow("Access", access));
    }
    const footer = el("div", "dc-dialog-footer dc-details-actions");
    if (this.canInvokeActions(occurrence)) {
      for (const action of this.sourceActionsFor(occurrence)) {
        footer.append(this.sourceActionButton(action, occurrence, "dc-btn", () => dialog.close()));
      }
    }
    if (this.canEditOccurrence(occurrence)) footer.append(this.button("Edit", () => { dialog.close(); void this.editOccurrence(occurrence); }));
    if (this.canDuplicateOccurrence()) footer.append(this.button("Duplicate", () => { dialog.close(); void this.duplicateOccurrence(occurrence); }));
    for (const action of (this.options.addons ?? []).flatMap(addon => this.hostHook(`Calendar add-on ${addon.id} detail actions`, () => addon.detailActions?.(occurrence, this.addonContext()) ?? [], []))) {
      const button = this.button(action.label, () => { dialog.close(); void this.hostHookAsync("Calendar add-on detail action", action.run, undefined); });
      if (action.primary) button.classList.add("dc-primary");
      if (action.danger) button.classList.add("dc-danger");
      footer.append(button);
    }
    if (this.canDeleteOccurrence(occurrence)) {
      const remove = this.button("Delete", () => { dialog.close(); void this.deleteOccurrence(occurrence); });
      remove.classList.add("dc-danger");
      footer.append(remove);
    }
    card.append(header, body, footer);
    dialog.append(card);
    this.host.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  private detailRow(label: string, value: string): HTMLElement {
    const row = el("div", "dc-detail-row");
    row.append(el("div", "dc-detail-label", label), el("div", "dc-detail-value", value));
    return row;
  }

  private async editOccurrence(occurrence: CalendarOccurrence): Promise<void> {
    if (this.isOccurrencePending(occurrence) || !this.canEditOccurrence(occurrence)) return;
    const editHandler = this.options.callbacks?.handleEdit;
    if (editHandler && await this.hostHookAsync("Calendar handleEdit callback", () => editHandler(occurrence, this.placementValidationPort()), false)) return;
    const editCapabilities = this.occurrenceCapabilities(occurrence);
    if (!this.mutations.hasCommandPath(occurrence, editCapabilities)) {
      this.announce(`${occurrence.title}: editing was not handled by the host and no built-in command path is available.`);
      return;
    }
    const sourceItem = this.mutations.sourceItem(occurrence);
    const capabilities = editCapabilities;
    const result = await openEventEditor(
      this.host,
      { occurrence, ...(sourceItem ? { sourceItem } : {}) },
      this.sources,
      this.defaultCalendarId,
      this.weekStartsOn,
      this.timeZone,
      this.kindOptions(),
      this.options.reminderChannelOptions,
      {
        allowSemanticEdit: this.canEditOccurrenceDetails(occurrence, capabilities),
        allowAllDayConversion: capabilities.canMove && capabilities.canMoveBetweenAllDayAndTimed && !isPointOccurrence(occurrence),
        allowRecurrenceChange: capabilities.canChangeRecurrence,
        allowStartChange: isPointOccurrence(occurrence) ? capabilities.canMove : capabilities.canResizeStart,
        allowEndChange: !isPointOccurrence(occurrence) && capabilities.canResizeEnd,
      },
      this.dstOverlapDisambiguation,
    );
    if (!result) return;
    const fullEdit = this.canEditOccurrenceDetails(occurrence, capabilities);
    const recurrenceChanged = fullEdit && !sameRecurrence(sourceItem?.recurrence, result.recurrence);
    const patch: CalendarItemPatch = {
      ...(fullEdit ? { calendarId: result.calendarId, title: result.title, description: result.description ?? null, location: result.location ?? null, kind: result.kind } : {}),
      start: result.start,
      end: result.end,
      allDay: result.allDay,
      precision: result.allDay ? "date" : "minute",
      ...(fullEdit ? { temporal: result.temporal, reminders: result.reminders ?? null } : {}),
      ...(result.temporalForm ? { temporalForm: result.temporalForm } : {}),
      ...(recurrenceChanged ? { recurrence: result.recurrence ?? null } : {}),
    };
    let scope: SeriesEditScope = "all";
    if (occurrence.recurring) {
      const selected = await chooseSeriesScope(this.host, "Edit", !recurrenceChanged);
      if (!selected) return;
      scope = selected;
    }
    if (!await this.mutations.allowDraftPlacement(result, occurrence, "edit")) return;
    await this.mutations.dispatchOccurrence(
      { type: "update-occurrence", occurrence, patch, scope },
      this.mutations.patchRequirements(occurrence, patch),
      "edit",
    );
  }

  private async duplicateOccurrence(occurrence: CalendarOccurrence): Promise<void> {
    const sourceItem = this.mutations.sourceItem(occurrence);
    const result = await openEventEditor(this.host, { occurrence, ...(sourceItem ? { sourceItem } : {}), duplicate: true }, this.sources, this.defaultCalendarId, this.weekStartsOn, this.timeZone, this.kindOptions(), this.options.reminderChannelOptions, {}, this.dstOverlapDisambiguation);
    if (!result) return;
    const item = this.createCalendarItem({
      calendarId: result.calendarId,
      title: result.title,
      ...(result.description ? { description: result.description } : {}),
      ...(result.location ? { location: result.location } : {}),
      start: result.start, end: result.end, allDay: result.allDay, precision: result.allDay ? "date" : "minute", temporal: result.temporal,
      ...(result.temporalForm ? { temporalForm: result.temporalForm } : {}), kind: result.kind,
      ...(result.recurrence ? { recurrence: result.recurrence } : {}),
      ...(result.reminders ? { reminders: result.reminders } : {}),
    }, "duplicate", occurrence);
    const withSeries = result.recurrence ? { ...item, seriesId: item.id } : item;
    if (!await this.mutations.allowDraftPlacement(withSeries, undefined, "create")) return;
    await this.mutations.dispatch({ type: "create", item: withSeries });
  }

  private async deleteOccurrence(occurrence: CalendarOccurrence): Promise<void> {
    if (this.isOccurrencePending(occurrence) || !this.canDeleteOccurrence(occurrence)) return;
    let scope: SeriesEditScope = "all";
    if (occurrence.recurring) {
      const selected = await chooseSeriesScope(this.host, "Delete");
      if (!selected) return;
      scope = selected;
    }
    if (!await confirmCalendarAction(this.host, "Delete event", `Delete “${occurrence.title}”?`, "Delete", true)) return;
    await this.mutations.dispatchOccurrence({ type: "cancel-occurrence", occurrence, scope }, ["canDelete"], "delete");
  }

  private async moveToDay(occurrence: CalendarOccurrence, day: Date, allDay: boolean): Promise<void> {
    if (!this.canMoveOccurrenceToPlacement(occurrence, allDay)) {
      this.announce(`${occurrence.title}: this move is not allowed.`);
      return;
    }
    const originalStart = toDate(occurrence.start);
    if (allDay) {
      const start = startOfDay(day, this.timeZone);
      const days = calendarDaySpan(toDate(occurrence.start), toDate(occurrence.end), this.timeZone);
      const end = addDays(start, days, this.timeZone);
      if (!await this.allowPlacement(start, end, true, occurrence, "move")) return;
      await this.mutations.issueOccurrencePatch(
        occurrence,
        placementTimePatch(start, end, true, this.timeZone),
        "Move",
        this.mutations.moveRequirements(occurrence, true),
        "move",
      );
      return;
    }
    const start = withLocalTime(day, originalStart, this.timeZone, this.dstOverlapDisambiguation);
    if (!start) {
      this.announce("Move is unavailable because the target local time does not exist.");
      return;
    }
    const end = new Date(start.getTime() + durationMs(occurrence));
    if (!await this.allowPlacement(start, end, false, occurrence, "move")) return;
    await this.mutations.issueOccurrencePatch(
      occurrence,
      { start: start.toISOString(), end: end.toISOString(), allDay: false, precision: "minute" },
      "Move",
      this.mutations.moveRequirements(occurrence, false),
      "move",
    );
  }

  private async moveOccurrenceToStart(
    occurrence: CalendarOccurrence,
    startValue: ISODateTime,
    allDay: boolean,
  ): Promise<boolean> {
    const current = this.authoritativeOccurrence(occurrence);
    if (this.isOccurrencePending(current) || !this.canMoveOccurrenceToPlacement(current, allDay)) {
      this.announce(`${current.title}: this move is not allowed.`);
      return false;
    }

    const requestedStart = parseAbsoluteDateTime(startValue, "Custom view move start");
    let start: Date;
    let end: Date;
    if (allDay) {
      start = startOfDay(requestedStart, this.timeZone);
      end = addDays(start, calendarDaySpan(toDate(current.start), toDate(current.end), this.timeZone), this.timeZone);
    } else {
      start = requestedStart;
      const duration = isDateLikeOccurrence(current) ? 60 * 60_000 : durationMs(current);
      end = new Date(start.getTime() + duration);
    }
    if (!await this.allowPlacement(start, end, allDay, current, "move")) return false;

    const patch = allDay || isDateLikeOccurrence(current)
      ? placementTimePatch(start, end, allDay, this.timeZone)
      : { start: start.toISOString(), end: end.toISOString(), allDay: false, precision: "minute" as const };
    const status = await this.mutations.issueOccurrencePatch(
      current,
      patch,
      "Move",
      this.mutations.moveRequirements(current, allDay),
      "move",
    );
    return mutationCommitted(status);
  }

  private async resizeOccurrenceToInstant(
    occurrence: CalendarOccurrence,
    edge: CalendarResizeEdge,
    targetValue: ISODateTime,
  ): Promise<boolean> {
    const current = this.authoritativeOccurrence(occurrence);
    if (this.isOccurrencePending(current) || !this.canResizeOccurrence(current, edge) || isPointOccurrence(current)) {
      this.announce(`${current.title}: this resize is not allowed.`);
      return false;
    }

    const resized = resizeInterval(
      toDate(current.start),
      toDate(current.end),
      parseAbsoluteDateTime(targetValue, `Custom view resize ${edge}`),
      edge,
      this.slotMinutes,
    );
    if (!await this.allowPlacement(resized.start, resized.end, false, current, "resize")) return false;
    const status = await this.mutations.issueTimedCommand(
      {
        type: "resize-occurrence",
        occurrence: current,
        start: resized.start.toISOString(),
        end: resized.end.toISOString(),
        scope: "this",
      },
      "Resize",
      [edge === "start" ? "canResizeStart" : "canResizeEnd"],
    );
    return mutationCommitted(status);
  }

  private setOccurrencePending(occurrenceId: string, operation: string, pending: boolean): void {
    const occurrence = this.occurrenceIndex.get(occurrenceId);
    const actions = occurrence ? new Map(this.sourceActionsFor(occurrence).map(action => [action.id, action] as const)) : new Map<string, ResolvedCalendarSourceAction>();
    for (const node of this.host.querySelectorAll<HTMLElement>("[data-occurrence-id]")) {
      if (node.dataset.occurrenceId !== occurrenceId) continue;
      node.classList.toggle("is-pending", pending);
      if (pending) {
        node.setAttribute("aria-busy", "true");
        node.dataset.pendingOperation = operation;
      } else {
        node.removeAttribute("aria-busy");
        delete node.dataset.pendingOperation;
      }
      for (const button of node.querySelectorAll<HTMLButtonElement>("[data-action-id]")) {
        const action = button.dataset.actionId ? actions.get(button.dataset.actionId) : undefined;
        const actionPending = pending || action?.pending === true;
        button.disabled = !action || !action.enabled || actionPending;
        if (actionPending) button.setAttribute("aria-busy", "true");
        else button.removeAttribute("aria-busy");
        if (action?.pressed !== undefined) button.setAttribute("aria-pressed", String(action.pressed));
        else button.removeAttribute("aria-pressed");
        if (action?.state !== undefined) button.dataset.state = action.state;
        else delete button.dataset.state;
      }
    }
  }

  public async undo(): Promise<boolean> {
    return await this.mutations.undo();
  }

  public async redo(): Promise<boolean> {
    return await this.mutations.redo();
  }

  private announce(message: string): void {
    const status = this.host.querySelector<HTMLElement>("[data-role='status']");
    if (!status) return;
    status.textContent = "";
    requestAnimationFrame(() => { status.textContent = message; });
  }

  private reportHostHookError(label: string, error: unknown): void {
    if (this.reportedHostHookErrors.has(label)) return;
    this.reportedHostHookErrors.add(label);
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    this.announce(`${label} was ignored because the host extension failed${detail}`);
  }

  private hostHook<T>(label: string, run: () => T, fallback: T): T {
    try { return run(); } catch (error) { this.reportHostHookError(label, error); return fallback; }
  }

  private async hostHookAsync<T>(label: string, run: () => Promise<T> | T, fallback: T): Promise<T> {
    try { return await run(); } catch (error) { this.reportHostHookError(label, error); return fallback; }
  }

  private occurrenceAriaLabel(occurrence: CalendarOccurrence): string {
    const start = toDate(occurrence.start);
    const end = toDate(occurrence.end);
    const presentation = this.occurrencePresentation(occurrence);
    if (presentation.accessibleLabel) return presentation.accessibleLabel;
    const title = presentation.title?.accessibleLabel ?? presentation.title?.text ?? occurrence.title;
    const semanticDetail = [
      presentation.icon?.accessibleLabel,
      presentation.leading?.accessibleLabel ?? presentation.leading?.text,
      presentation.subtitle?.accessibleLabel ?? presentation.subtitle?.text,
      presentation.trailing?.accessibleLabel ?? presentation.trailing?.text,
      ...presentation.badges.map(badge => badge.accessibleLabel ?? badge.label),
    ].filter((value): value is string => Boolean(value)).join(". ");
    const when = occurrence.allDay || occurrence.precision === "date"
      ? `${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(start)}, all day`
      : isPointOccurrence(occurrence)
        ? `${formatDateTime(start, this.locale, this.timeZone)}, point in time`
        : `${formatDateTime(start, this.locale, this.timeZone)} to ${formatTime(end, this.locale, this.timeZone)}`;
    const hints: string[] = [];
    if (this.canEditOccurrence(occurrence)) hints.push("Press E to edit");
    if (this.canMoveOccurrence(occurrence)) hints.push("Alt plus arrow keys move");
    if (this.canResizeOccurrence(occurrence, "end")) hints.push("Alt plus Shift plus up or down resizes the end");
    const detail = semanticDetail ? `. ${semanticDetail}` : "";
    const editableHint = hints.length ? `. ${hints.join(". ")}.` : "";
    return `${title}${detail}. ${when}. ${this.sourceTitle(occurrence.calendarId)}${editableHint}`;
  }

  private async allowPlacement(
    start: Date,
    end: Date,
    allDay: boolean,
    occurrence: CalendarOccurrence | undefined,
    action: string,
    calendarId: CalendarId | undefined = occurrence?.calendarId,
  ): Promise<boolean> {
    return await this.mutations.allowPlacement(start, end, allDay, occurrence, action, calendarId);
  }

  private async keyboardTransformOccurrence(occurrence: CalendarOccurrence, key: string, resize: boolean): Promise<void> {
    if (this.isOccurrencePending(occurrence)) return;
    const start = toDate(occurrence.start);
    const end = toDate(occurrence.end);
    const allDay = Boolean(occurrence.allDay || occurrence.precision === "date");
    const step = this.snapPolicy.keyboardStepMinutes;
    let nextStart = new Date(start);
    let nextEnd = new Date(end);

    if (!resize) {
      if (allDay) {
        const days = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
        nextStart = addDays(start, days, this.timeZone);
        nextEnd = addDays(end, days, this.timeZone);
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        const days = key === "ArrowLeft" ? -1 : 1;
        nextStart = addDays(start, days, this.timeZone);
        nextEnd = addDays(end, days, this.timeZone);
      } else {
        const minutes = key === "ArrowUp" ? -step : step;
        const shifted = shiftCivilMinutes(start, minutes, this.timeZone, this.dstOverlapDisambiguation);
        if (!shifted) { this.announce("Move is unavailable because the target local time does not exist."); return; }
        nextStart = shifted;
        nextEnd = isPointOccurrence(occurrence) ? shifted : new Date(shifted.getTime() + durationMs(occurrence));
      }
      if (!await this.allowPlacement(nextStart, nextEnd, allDay, occurrence, "move")) return;
      const status = allDay
        ? await this.mutations.issueOccurrencePatch(occurrence, placementTimePatch(nextStart, nextEnd, true, this.timeZone), "Move", ["canMove"])
        : await this.mutations.issueTimedCommand({ type: "move-occurrence", occurrence, start: nextStart.toISOString(), end: nextEnd.toISOString(), scope: "this" }, "Move", ["canMove"]);
      if (status === "completed") this.announce(`${occurrence.title} moved to ${allDay ? new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "long", timeZone: this.timeZone }).format(nextStart) : formatDateTime(nextStart, this.locale, this.timeZone)}.`);
      return;
    }

    if (allDay) {
      const days = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
      nextEnd = addDays(end, days, this.timeZone);
      if (nextEnd.getTime() <= start.getTime()) nextEnd = addDays(start, 1, this.timeZone);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      nextEnd = addDays(end, key === "ArrowLeft" ? -1 : 1, this.timeZone);
      if (nextEnd.getTime() <= start.getTime()) {
        const minimumEnd = shiftCivilMinutes(start, step, this.timeZone, this.dstOverlapDisambiguation);
        if (!minimumEnd) { this.announce("Resize is unavailable because the minimum target local time does not exist."); return; }
        nextEnd = minimumEnd;
      }
    } else {
      const shifted = shiftCivilMinutes(end, key === "ArrowUp" ? -step : step, this.timeZone, this.dstOverlapDisambiguation);
      if (!shifted) { this.announce("Resize is unavailable because the target local time does not exist."); return; }
      nextEnd = shifted;
      if (nextEnd.getTime() <= start.getTime()) {
        const minimumEnd = shiftCivilMinutes(start, step, this.timeZone, this.dstOverlapDisambiguation);
        if (!minimumEnd) { this.announce("Resize is unavailable because the minimum target local time does not exist."); return; }
        nextEnd = minimumEnd;
      }
    }
    if (!await this.allowPlacement(start, nextEnd, allDay, occurrence, "resize")) return;
    const status = allDay
      ? await this.mutations.issueOccurrencePatch(occurrence, placementTimePatch(start, nextEnd, true, this.timeZone), "Resize", ["canResizeEnd"])
      : await this.mutations.issueTimedCommand({ type: "resize-occurrence", occurrence, start: start.toISOString(), end: nextEnd.toISOString(), scope: "this" }, "Resize", ["canResizeEnd"]);
    if (status === "completed") this.announce(`${occurrence.title} now ends ${allDay ? new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "long", timeZone: this.timeZone }).format(new Date(nextEnd.getTime() - 1)) : formatDateTime(nextEnd, this.locale, this.timeZone)}.`);
  }

  private kindLabel(kind: string): string {
    return this.kindOptions().find(option => option.value === kind)?.label ?? humanizeKind(kind);
  }

  private kindOptions(): readonly CalendarKindOption[] {
    const options = new Map<string, CalendarKindOption>();
    const defaults: readonly CalendarKindOption[] = this.options.kindOptions?.length
      ? this.options.kindOptions
      : [{ value: "event", label: "Event" }];
    for (const option of defaults) if (option.value.trim()) options.set(option.value, { value: option.value, label: option.label || humanizeKind(option.value) });
    for (const item of this.engine.snapshot().items) if (!options.has(item.kind)) options.set(item.kind, { value: item.kind, label: humanizeKind(item.kind) });
    for (const occurrence of this.occurrences) if (!options.has(occurrence.kind)) options.set(occurrence.kind, { value: occurrence.kind, label: humanizeKind(occurrence.kind) });
    return [...options.values()];
  }

  private toggleSourceMenu(button: HTMLElement): void {
    const existing = this.host.querySelector<HTMLElement>(".dc-source-menu");
    if (existing) { existing.remove(); return; }
    this.dismissContextMenu();
    const menu = el("div", "dc-source-menu");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Calendar visibility");
    menu.append(el("div", "dc-menu-title", "Calendars"));
    for (const source of this.sources) {
      const row = el("label", "dc-source-row");
      const check = el("input");
      check.type = "checkbox";
      check.checked = this.sourceVisibility.get(source.id) ?? source.visible;
      check.addEventListener("change", () => {
        this.sourceVisibility.set(source.id, check.checked);
        this.requestRefresh();
      });
      const mark = el("span", "dc-source-dot", source.display?.icon ?? "");
      mark.setAttribute("aria-hidden", "true");
      row.append(check, mark, el("span", undefined, source.title));
      menu.append(row);
    }
    for (const action of (this.options.addons ?? []).flatMap(addon => this.hostHook(`Calendar add-on ${addon.id} source actions`, () => addon.sourceMenuActions?.(this.addonContext()) ?? [], []))) {
      const item = el("button", `dc-menu-item${action.danger ? " dc-danger" : ""}`, action.label);
      item.type = "button";
      item.addEventListener("click", () => {
        menu.remove();
        void this.hostHookAsync("Calendar add-on source action", action.run, undefined);
      });
      menu.append(item);
    }
    const rect = button.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left - hostRect.left)}px`;
    menu.style.top = `${rect.bottom - hostRect.top + 4}px`;
    this.host.querySelector<HTMLElement>(".dc-root")?.append(menu);
  }

  private openContextMenu(occurrence: CalendarOccurrence, clientX: number, clientY: number): void {
    this.dismissContextMenu();
    const menu = el("div", "dc-context-menu");
    menu.setAttribute("role", "menu");
    const add = (label: string, action: () => void, danger = false) => {
      const button = el("button", `dc-menu-item${danger ? " dc-danger" : ""}`, label);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => { this.dismissContextMenu(); action(); });
      menu.append(button);
    };
    if (this.canOpenOccurrence(occurrence)) add("Open", () => void this.openDetails(occurrence));
    if (this.canInvokeActions(occurrence)) {
      for (const action of this.sourceActionsFor(occurrence)) {
        const button = this.sourceActionButton(action, occurrence, "dc-menu-item", () => this.dismissContextMenu(), false);
        button.setAttribute("role", "menuitem");
        menu.append(button);
      }
    }
    if (this.canEditOccurrence(occurrence)) add("Edit", () => void this.editOccurrence(occurrence));
    if (this.canDuplicateOccurrence()) add("Duplicate", () => void this.duplicateOccurrence(occurrence));
    for (const action of (this.options.addons ?? []).flatMap(addon => this.hostHook(`Calendar add-on ${addon.id} context actions`, () => addon.contextActions?.(occurrence, this.addonContext()) ?? [], []))) add(action.label, () => void this.hostHookAsync("Calendar add-on context action", action.run, undefined), Boolean(action.danger));
    if (this.canDeleteOccurrence(occurrence)) add("Delete", () => void this.deleteOccurrence(occurrence), true);
    const hostRect = this.host.getBoundingClientRect();
    menu.style.left = `${Math.max(4, clientX - hostRect.left)}px`;
    menu.style.top = `${Math.max(4, clientY - hostRect.top)}px`;
    menu.addEventListener("keydown", event => {
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { event.preventDefault(); this.dismissContextMenu(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        buttons[(current + delta + buttons.length) % buttons.length]?.focus();
      } else if (event.key === "Home") { event.preventDefault(); buttons[0]?.focus(); }
      else if (event.key === "End") { event.preventDefault(); buttons.at(-1)?.focus(); }
    });
    this.host.querySelector<HTMLElement>(".dc-root")?.append(menu);
    this.contextMenu = menu;
    requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("button")?.focus());
  }

  private setDraggingState(active: boolean): void {
    const root = this.host.querySelector<HTMLElement>(".dc-root");
    if (!root) return;
    if (active) root.dataset.dragging = "true";
    else delete root.dataset.dragging;
  }

  private dismissContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.gestures.isDragging()) {
      event.preventDefault();
      this.gestures.cancelActiveDrag();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input,textarea,select,dialog")) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "z") {
      event.preventDefault();
      if (event.shiftKey) void this.redo();
      else void this.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "y") {
      event.preventDefault();
      void this.redo();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key === "t") { event.preventDefault(); this.today(); }
    else if (key === "j") { event.preventDefault(); void this.jumpToDate(); }
    else if (key === "m") { event.preventDefault(); this.setView("month"); }
    else if (key === "w") { event.preventDefault(); this.setView("week"); }
    else if (key === "d") { event.preventDefault(); this.setView("day"); }
    else if (key === "y") { event.preventDefault(); this.setView("year"); }
    else if (key === "a") { event.preventDefault(); this.setView("agenda"); }
    else if ((key === "c" || key === "n") && this.canCreateItems()) { event.preventDefault(); void this.createAtAnchor(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); this.previous(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); this.next(); }
  }

  private async jumpToDate(): Promise<void> {
    const answer = await requestCalendarDate(this.host, "Jump to date", dateKey(this.anchor, this.timeZone), "Go", this.navigationBounds);
    if (!answer) return;
    this.goTo(toDate(answer, this.timeZone));
    this.announce(`Calendar moved to ${answer}.`);
  }

  private async executeSourceAction(actionId: string, occurrence: CalendarOccurrence): Promise<void> {
    await this.mutations.executeSourceAction(actionId, occurrence);
  }

  private occurrencePresentation(occurrence: CalendarOccurrence): ResolvedCalendarOccurrencePresentation {
    return resolveOccurrencePresentation(
      this.options.extensions ?? [],
      this.authoritativeOccurrence(occurrence),
      (index, error) => this.reportHostHookError(`Calendar presentation extension ${index + 1}`, error),
    );
  }

  private sourceActionsFor(occurrence: CalendarOccurrence): readonly ResolvedCalendarSourceAction[] {
    return this.mutations.sourceActionsFor(occurrence);
  }

  private presentationTitle(occurrence: CalendarOccurrence): string {
    return this.occurrencePresentation(occurrence).title?.text ?? occurrence.title;
  }

  private occurrenceContent(occurrence: CalendarOccurrence, timeText?: string): HTMLElement {
    const presentation = this.occurrencePresentation(occurrence);
    const layout = el("span", "dc-occurrence-layout");
    const leading = el("span", "dc-occurrence-leading");
    const presentationIcon = presentation.icon;
    const displayIcon = presentationIcon ? "" : this.sourceIcon(occurrence);
    if (presentationIcon) {
      const mark = el("span", "dc-event-icon dc-presentation-icon", presentationIcon.text);
      if (presentationIcon.accessibleLabel) mark.setAttribute("aria-label", presentationIcon.accessibleLabel);
      else mark.setAttribute("aria-hidden", "true");
      leading.append(mark);
    } else if (displayIcon) {
      const mark = el("span", "dc-event-icon", displayIcon);
      mark.setAttribute("aria-hidden", "true");
      leading.append(mark);
    }
    if (presentation.leading) {
      const value = el("span", "dc-occurrence-leading-text", presentation.leading.text);
      if (presentation.leading.accessibleLabel) value.setAttribute("aria-label", presentation.leading.accessibleLabel);
      leading.append(value);
    }
    if (leading.childNodes.length) layout.append(leading);

    const copy = el("span", "dc-occurrence-copy");
    const title = el("span", "dc-occurrence-title", presentation.title?.text ?? occurrence.title);
    if (presentation.title?.accessibleLabel) title.setAttribute("aria-label", presentation.title.accessibleLabel);
    copy.append(title);
    if (presentation.subtitle) {
      const subtitle = el("span", "dc-occurrence-subtitle", presentation.subtitle.text);
      if (presentation.subtitle.accessibleLabel) subtitle.setAttribute("aria-label", presentation.subtitle.accessibleLabel);
      copy.append(subtitle);
    }
    if (timeText) copy.append(el("span", "dc-occurrence-time", timeText));
    if (presentation.badges.length) {
      const badges = el("span", "dc-occurrence-badges");
      for (const badge of presentation.badges) {
        const node = el("span", "dc-occurrence-badge", badge.label);
        if (badge.accessibleLabel) node.setAttribute("aria-label", badge.accessibleLabel);
        badges.append(node);
      }
      copy.append(badges);
    }
    layout.append(copy);

    if (presentation.trailing) {
      const trailing = el("span", "dc-occurrence-trailing", presentation.trailing.text);
      if (presentation.trailing.accessibleLabel) trailing.setAttribute("aria-label", presentation.trailing.accessibleLabel);
      layout.append(trailing);
    }
    return layout;
  }

  private inlineActionBar(occurrence: CalendarOccurrence): HTMLElement | undefined {
    const actions = this.sourceActionsFor(occurrence).filter(action => action.inline);
    if (!actions.length) return undefined;
    const bar = el("span", "dc-inline-actions");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", `Actions for ${this.presentationTitle(occurrence)}`);
    for (const action of actions) bar.append(this.sourceActionButton(action, occurrence, "dc-inline-action"));
    return bar;
  }

  private sourceActionButton(
    action: ResolvedCalendarSourceAction,
    occurrence: CalendarOccurrence,
    className = "dc-btn",
    beforeRun?: () => void,
    isolateKeyboard = true,
  ): HTMLButtonElement {
    const button = el("button", className) as HTMLButtonElement;
    button.type = "button";
    if (action.icon) {
      const icon = el("span", "dc-action-icon", action.icon);
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
    }
    button.append(el("span", "dc-action-label", action.label));
    if (action.primary) button.classList.add("dc-primary");
    if (action.danger) button.classList.add("dc-danger");
    button.dataset.actionId = action.id;
    if (action.kind) button.dataset.kind = action.kind;
    if (action.state !== undefined) button.dataset.state = action.state;
    button.setAttribute("aria-label", action.accessibleLabel ?? action.label);
    if (action.pressed !== undefined) button.setAttribute("aria-pressed", String(action.pressed));
    const pending = action.pending || this.mutations.isPending(occurrence.occurrenceId);
    button.disabled = !action.enabled || pending;
    if (pending) button.setAttribute("aria-busy", "true");
    button.addEventListener("pointerdown", event => event.stopPropagation());
    button.addEventListener("dragstart", event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener("contextmenu", event => event.stopPropagation());
    if (isolateKeyboard) button.addEventListener("keydown", event => event.stopPropagation());
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      beforeRun?.();
      void this.executeSourceAction(action.id, occurrence);
    });
    return button;
  }

  private applyBackgroundPresentation(element: HTMLElement, range: CalendarBackgroundRange): void {
    const sourceDisplay = range.calendarId ? this.sources.find(source => source.id === range.calendarId)?.display : undefined;
    const color = range.display?.color ?? sourceDisplay?.color;
    const textColor = range.display?.textColor ?? sourceDisplay?.textColor;
    if (color) element.style.setProperty("--dc-background-range-color", color);
    if (textColor) element.style.setProperty("--dc-background-range-fg", textColor);
    for (const token of range.display?.className?.split(/\s+/u).filter(Boolean) ?? []) {
      if (isSafeHostClassName(token)) element.classList.add(token);
    }
  }

  private applyOccurrencePresentation(element: HTMLElement, occurrence: CalendarOccurrence): void {
    const sourceDisplay = this.sources.find(source => source.id === occurrence.calendarId)?.display;
    const display = { ...(sourceDisplay ?? {}), ...(occurrence.display ?? {}) };
    if (display.color) element.style.setProperty("--dc-event-bg", display.color);
    if (display.textColor) element.style.setProperty("--dc-event-fg", display.textColor);
    for (const token of display.className?.split(/\s+/u).filter(Boolean) ?? []) {
      if (isSafeHostClassName(token)) element.classList.add(token);
    }
    const presentation = this.occurrencePresentation(occurrence);
    for (const token of presentation.classNames) element.classList.add(token);
    for (const [key, value] of Object.entries(presentation.data)) element.setAttribute(`data-host-${hostDataAttributeName(key)}`, value);
    const pendingOperation = this.mutations.pendingOperation(occurrence.occurrenceId);
    if (pendingOperation) {
      element.classList.add("is-pending");
      element.setAttribute("aria-busy", "true");
      element.dataset.pendingOperation = pendingOperation;
    }
  }

  private addonEmptyMessage(): string | undefined {
    const context = this.addonContext();
    for (const addon of this.options.addons ?? []) {
      const message = this.hostHook(`Calendar add-on ${addon.id} empty message`, () => addon.emptyMessage?.(context), undefined);
      if (message) return message;
    }
    return undefined;
  }

  private placementValidationPort(): CalendarPlacementValidationPort {
    return this.mutations.placementValidationPort();
  }

  private addonContext(): CalendarUiAddonContext {
    const self = this;
    return {
      host: self.host,
      locale: self.locale,
      timeZone: self.timeZone,
      visibleRange: self.visibleRange,
      anchorDate: dateKey(self.anchor, self.timeZone),
      defaultCalendarId: self.defaultCalendarId,
      sources: self.sources,
      items: self.engine.snapshot().items,
      occurrences: self.occurrences,
      kindOptions: self.kindOptions(),
      canManageSources: () => self.engine.canManageSources(),
      canMoveOccurrence: occurrence => self.canMoveOccurrence(occurrence),
      refresh: () => self.refresh(),
      announce: message => self.announce(message),
      createSource: async source => { await self.engine.createSource(source); },
      createDraft: async (draft, purpose, original) => {
        const item = self.createCalendarItem(draft, purpose, original);
        if (!await self.mutations.allowDraftPlacement(item, original, String(purpose))) return null;
        await self.mutations.dispatch({ type: "create", item });
        return item;
      },
      ...self.placementValidationPort(),
      patchOccurrence: async (occurrence, patch, label = "Edit") => {
        if (!await self.mutations.allowPatchPlacement(occurrence, patch, label.toLocaleLowerCase())) return false;
        const status = await self.mutations.issueOccurrencePatch(occurrence, patch, label, self.mutations.patchRequirements(occurrence, patch), "edit");
        return mutationCommitted(status);
      },
    };
  }

  private sourceIcon(occurrence: CalendarOccurrence): string {
    return occurrence.display?.icon ?? this.sources.find(source => source.id === occurrence.calendarId)?.display?.icon ?? "";
  }

  private sourceTitle(id: string): string {
    return this.sources.find(source => source.id === id)?.title ?? id;
  }
}

