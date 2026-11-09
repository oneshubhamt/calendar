import type {
  CalendarAgendaSpan,
  CalendarCollisionPolicy,
  CalendarCommand,
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
  CalendarCreateDraft, CalendarItemFactoryInput, CalendarKindOption, CalendarSelection, CalendarUiAddonContext, CalendarUiOptions,
} from "./types.js";
import { CalendarEngine } from "../core/calendar-engine.js";
import { addDays, addMonths, addYears, dateKey, rangeForView, resolvedTimeZone, startOfDay, startOfYear, toDate } from "../core/time.js";
import { addPlainDays, instantToPlain, plainToInstant } from "../core/temporal.js";
import { groupAgendaByDay, groupByDay, layoutTimedDay } from "../core/layout.js";
import { minuteDelta, normalizeSnapPolicy, placementCollisions, placementTimePatch, resizeInterval, resizePreview, snapWithPolicy, type CalendarResizeEdge } from "../core/interaction.js";
import { chooseSeriesScope, openEventEditor } from "./event-editor.js";
import { CALENDAR_CSS } from "./styles.js";
import { confirmCalendarAction, requestCalendarDate } from "./dialogs.js";

interface DragState {
  readonly occurrence: CalendarOccurrence;
  readonly mode: "move" | "resize-start" | "resize-end";
  readonly pointerId: number;
  readonly pointerStartX: number;
  readonly pointerStartY: number;
  readonly originalStart: Date;
  readonly originalEnd: Date;
  readonly element: HTMLElement;
  readonly originalHeightCss: string;
  readonly grabOffsetMinutes: number;
  readonly scrollStartTop: number;
  readonly scrollStartLeft: number;
  lastClientX: number;
  lastClientY: number;
}

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

interface TouchPressState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  readonly timer: number;
  readonly occurrence: CalendarOccurrence;
  readonly element: HTMLElement;
  readonly mode: "move" | "resize-start" | "resize-end";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const NATIVE_DRAG_TYPE = "application/x-calendar-occurrence";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return dateKey(a, timeZone) === dateKey(b, timeZone);
}

function formatTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

function formatDateTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

function humanizeKind(value: string): string {
  const text = value.replace(/[-_]+/gu, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Event";
}

function weekdayOrder(weekStartsOn: Weekday): readonly Weekday[] {
  return Array.from({ length: 7 }, (_, i) => ((weekStartsOn + i) % 7) as Weekday);
}

function editable(occurrence: CalendarOccurrence): boolean {
  return occurrence.editPolicy !== "readonly" && occurrence.editPolicy !== "generated";
}

function writableSource(source: CalendarSource | undefined): boolean {
  return Boolean(source && !source.readOnly);
}

function creatableSource(source: CalendarSource | undefined): boolean {
  return Boolean(source && !source.readOnly && source.allowCreate !== false);
}

function durationMs(occurrence: CalendarOccurrence): number {
  return Math.max(1, toDate(occurrence.end).getTime() - toDate(occurrence.start).getTime());
}

function isDateLikeOccurrence(occurrence: CalendarOccurrence): boolean {
  return Boolean(occurrence.allDay || occurrence.precision === "date" || occurrence.temporal?.kind === "date");
}

function withLocalTime(day: Date, source: Date, timeZone: string): Date {
  const dayParts = instantToPlain(day.getTime(), timeZone);
  const time = instantToPlain(source.getTime(), timeZone);
  return new Date(plainToInstant({ ...dayParts, hour: time.hour, minute: time.minute, second: time.second, millisecond: time.millisecond }, timeZone, "compatible"));
}

function atMinuteOfDay(day: Date, minuteOfDay: number, timeZone: string): Date {
  const base = instantToPlain(day.getTime(), timeZone);
  const dayOffset = Math.floor(minuteOfDay / 1440);
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  const shifted = addPlainDays({ ...base, hour: 0, minute: 0, second: 0, millisecond: 0 }, dayOffset);
  return new Date(plainToInstant({ ...shifted, hour: Math.floor(minute / 60), minute: minute % 60 }, timeZone, "compatible"));
}

function calendarDaySpan(start: Date, end: Date, timeZone: string): number {
  const a = instantToPlain(start.getTime(), timeZone);
  const b = instantToPlain(end.getTime(), timeZone);
  return Math.max(1, Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000));
}

function sameRecurrence(a: CalendarItem["recurrence"], b: CalendarItem["recurrence"]): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class CalendarUi {
  private readonly locale: string;
  private readonly timeZone: string;
  private readonly weekStartsOn: Weekday;
  private readonly slotMinutes: number;
  private readonly snapPolicy: Required<CalendarSnapPolicy>;
  private readonly collisionPolicy: CalendarCollisionPolicy;
  private readonly longPressMs: number;
  private readonly autoScrollEdgePx: number;
  private readonly autoScrollMaxPxPerFrame: number;
  private readonly dayStartHour: number;
  private readonly dayEndHour: number;
  private agendaSpan: CalendarAgendaSpan;
  private sources: readonly CalendarSource[];
  private readonly sourceVisibility = new Map<string, boolean>();
  private readonly occurrenceIndex = new Map<string, CalendarOccurrence>();
  private readonly defaultCalendarId: string;
  private view: CalendarView;
  private anchor: Date;
  private visibleRange: CalendarRange;
  private occurrences: readonly CalendarOccurrence[] = [];
  private destroyed = false;
  private drag: DragState | null = null;
  private selectionDrag: SelectionDragState | null = null;
  private touchPress: TouchPressState | null = null;
  private autoScrollFrame: number | null = null;
  private renderGeneration = 0;
  private contextMenu: HTMLElement | null = null;
  private readonly unsubscribeRepository: () => void;
  private dragListenerCleanup: (() => void) | null = null;
  private pointerArmCleanup: (() => void) | null = null;
  private touchListenerCleanup: (() => void) | null = null;
  private suppressOccurrenceClickUntil = 0;

  public constructor(
    private readonly host: HTMLElement,
    private readonly engine: CalendarEngine,
    private readonly options: CalendarUiOptions = {},
  ) {
    this.locale = options.locale ?? (typeof navigator !== "undefined" ? navigator.language : undefined) ?? "en-US";
    this.timeZone = resolvedTimeZone(options.timeZone);
    this.weekStartsOn = options.weekStartsOn ?? 1;
    this.slotMinutes = options.slotMinutes ?? 15;
    this.snapPolicy = normalizeSnapPolicy(options.snapPolicy, this.slotMinutes);
    this.collisionPolicy = options.collisionPolicy ?? { mode: "allow", includeAllDay: false };
    this.longPressMs = Math.max(250, options.longPressMs ?? 420);
    this.autoScrollEdgePx = Math.max(20, options.autoScrollEdgePx ?? 56);
    this.autoScrollMaxPxPerFrame = Math.max(2, options.autoScrollMaxPxPerFrame ?? 18);
    this.dayStartHour = options.dayStartHour ?? 0;
    this.dayEndHour = options.dayEndHour ?? 24;
    this.agendaSpan = options.initialAgendaSpan ?? "30-days";
    this.view = options.initialView ?? "week";
    this.anchor = options.initialDate ? toDate(options.initialDate, this.timeZone) : new Date();
    this.visibleRange = rangeForView(this.anchor, this.view, this.weekStartsOn, this.timeZone, this.agendaSpan);
    this.sources = this.engine.snapshot().sources;
    for (const source of this.sources) this.sourceVisibility.set(source.id, source.visible);
    this.defaultCalendarId = options.defaultCalendarId ?? this.sources.find(source => !source.readOnly && source.allowCreate !== false)?.id ?? this.sources[0]?.id ?? "calendar";
    this.mountShell();
    this.unsubscribeRepository = this.engine.subscribe(() => { if (!this.destroyed) void this.refresh(); });
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.renderGeneration;
    const snapshot = this.engine.snapshot();
    this.sources = snapshot.sources;
    for (const source of this.sources) if (!this.sourceVisibility.has(source.id)) this.sourceVisibility.set(source.id, source.visible);
    for (const id of [...this.sourceVisibility.keys()]) if (!this.sources.some(source => source.id === id)) this.sourceVisibility.delete(id);
    this.visibleRange = rangeForView(this.anchor, this.view, this.weekStartsOn, this.timeZone, this.agendaSpan);
    const visibleSourceIds = new Set([...this.sourceVisibility].filter(([, visible]) => visible).map(([id]) => id));
    const sourceById = new Map(this.sources.map(source => [source.id, source] as const));
    const filters = (this.options.addons ?? []).filter(addon => addon.filterOccurrence);
    const result = await this.engine.query(this.visibleRange, {
      visibleSourceIds,
      timeZone: this.timeZone,
      ...(filters.length ? { predicate: (occurrence: CalendarOccurrence) => filters.every(addon => addon.filterOccurrence?.(occurrence, sourceById.get(occurrence.calendarId)) !== false) } : {}),
    });
    if (this.destroyed || generation !== this.renderGeneration) return;
    this.occurrences = result.occurrences;
    const extensionContext = { occurrences: this.occurrences, range: this.visibleRange, timeZone: this.timeZone, now: new Date() };
    for (const extension of this.options.extensions ?? []) extension.prepare?.(extensionContext);
    for (const addon of this.options.addons ?? []) addon.onRefresh?.(this.addonContext());
    this.occurrenceIndex.clear();
    for (const occurrence of this.occurrences) this.occurrenceIndex.set(occurrence.occurrenceId, occurrence);
    this.render();
    this.options.callbacks?.onRangeChange?.(this.visibleRange, this.view);
  }

  public setView(view: CalendarView): void {
    if (this.view === view) return;
    this.view = view;
    this.options.callbacks?.onViewChange?.(view);
    void this.refresh();
  }

  public setAgendaSpan(span: CalendarAgendaSpan): void {
    if (this.agendaSpan === span) return;
    this.agendaSpan = span;
    if (this.view === "agenda") void this.refresh();
  }

  public goTo(value: ISODateTime | Date): void {
    this.anchor = toDate(value, this.timeZone);
    void this.refresh();
  }

  public today(): void {
    this.goTo(new Date());
  }

  public next(): void {
    this.goTo(this.shiftAnchor(1));
  }

  public previous(): void {
    this.goTo(this.shiftAnchor(-1));
  }

  private shiftAnchor(direction: 1 | -1): Date {
    if (this.view === "year") return addYears(this.anchor, direction, this.timeZone);
    if (this.view === "month") return addMonths(this.anchor, direction, this.timeZone);
    if (this.view === "week") return addDays(this.anchor, 7 * direction, this.timeZone);
    if (this.view !== "agenda") return addDays(this.anchor, direction, this.timeZone);
    if (this.agendaSpan === "month") return addMonths(this.anchor, direction, this.timeZone);
    const days = this.agendaSpan === "week" ? 7 : this.agendaSpan === "day" ? 1 : 30;
    return addDays(this.anchor, days * direction, this.timeZone);
  }

  public destroy(): void {
    this.destroyed = true;
    this.cancelTouchPress();
    this.cancelPointerArm();
    this.cancelActiveDrag();
    this.stopAutoScroll();
    this.dismissContextMenu();
    for (const addon of this.options.addons ?? []) addon.destroy?.();
    this.unsubscribeRepository();
    this.host.replaceChildren();
  }

  /** Mutation controls fail closed when the host has not supplied a command path or source capability. */
  private canCreateItems(): boolean {
    if (this.options.allowCreate === false) return false;
    if (!this.sources.some(source => creatableSource(source))) return false;
    return Boolean(this.options.commandHandler || this.options.callbacks?.handleCreate);
  }

  private canScheduleOccurrence(occurrence: CalendarOccurrence): boolean {
    return editable(occurrence) && writableSource(this.sources.find(source => source.id === occurrence.calendarId)) && Boolean(this.options.commandHandler);
  }

  private canEditOccurrence(occurrence: CalendarOccurrence): boolean {
    return editable(occurrence) && writableSource(this.sources.find(source => source.id === occurrence.calendarId)) && Boolean(this.options.commandHandler || this.options.callbacks?.handleEdit);
  }

  private canDeleteOccurrence(occurrence: CalendarOccurrence): boolean {
    return editable(occurrence) && writableSource(this.sources.find(source => source.id === occurrence.calendarId)) && Boolean(this.options.commandHandler);
  }

  private canDuplicateOccurrence(): boolean {
    return Boolean(this.options.commandHandler) && this.sources.some(source => creatableSource(source));
  }

  private mountShell(): void {
    this.host.replaceChildren();
    const style = el("style");
    style.textContent = [CALENDAR_CSS, ...(this.options.extensions ?? []).map(extension => extension.styles ?? ""), ...(this.options.addons ?? []).map(addon => addon.styles ?? "")].filter(Boolean).join("\n");
    const root = el("section", "dc-root");
    root.tabIndex = -1;
    root.setAttribute("aria-label", this.options.ariaLabel ?? "Calendar");
    const live = el("div", "dc-sr-only");
    live.dataset.role = "status";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    root.append(this.toolbar(), el("div", "dc-body"), live);
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
    const create = this.canCreateItems() ? this.button("+ New", () => void this.createAtAnchor(), "Create event") : null;
    create?.classList.add("dc-primary");
    const addonHost = el("div", "dc-toolbar-addons");
    for (const addon of this.options.addons ?? []) addon.mountToolbar?.(addonHost, this.addonContext());
    const today = this.button("Today", () => this.today());
    const jump = this.button("Jump", () => void this.jumpToDate(), "Jump to date");
    const previous = this.button("‹", () => this.previous(), "Previous period");
    const next = this.button("›", () => this.next(), "Next period");
    const undo = this.button("↶", () => void this.undo(), "Undo calendar change");
    undo.dataset.history = "undo";
    const redo = this.button("↷", () => void this.redo(), "Redo calendar change");
    redo.dataset.history = "redo";
    const title = el("div", "dc-title");
    title.dataset.role = "title";
    const sources = this.button("Calendars", () => this.toggleSourceMenu(sources), "Show or hide calendars");
    sources.dataset.sourceToggle = "true";
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
    for (const view of ["month", "week", "day", "year", "agenda"] as const) {
      const button = this.button(view[0]!.toUpperCase() + view.slice(1), () => this.setView(view));
      button.dataset.view = view;
      switcher.append(button);
    }
    if (create) bar.append(create);
    if (addonHost.childNodes.length) bar.append(addonHost);
    bar.append(today, jump, previous, next);
    if (this.options.commandHandler?.undo) bar.append(undo);
    if (this.options.commandHandler?.redo) bar.append(redo);
    bar.append(title, sources, agendaSpan, switcher);
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
    if (!root || !body || !title) return;
    title.textContent = this.periodTitle();
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
      button.classList.toggle("is-active", button.dataset.view === this.view);
      button.setAttribute("aria-pressed", String(button.dataset.view === this.view));
    }
    const agendaSpan = root.querySelector<HTMLSelectElement>("[data-role='agenda-span']");
    if (agendaSpan) { agendaSpan.hidden = this.view !== "agenda"; agendaSpan.value = this.agendaSpan; }
    const history = this.options.commandHandler?.historyState?.();
    const undo = root.querySelector<HTMLButtonElement>("[data-history='undo']");
    const redo = root.querySelector<HTMLButtonElement>("[data-history='redo']");
    if (undo) undo.disabled = !history?.canUndo;
    if (redo) redo.disabled = !history?.canRedo;
    body.replaceChildren();
    if (this.view === "month") body.append(this.renderMonth());
    else if (this.view === "year") body.append(this.renderYear());
    else if (this.view === "agenda") body.append(this.renderAgenda());
    else body.append(this.renderTimeGrid(this.view === "week" ? 7 : 1));
  }

  private periodTitle(): string {
    if (this.view === "year") return new Intl.DateTimeFormat(this.locale, { year: "numeric", timeZone: this.timeZone }).format(this.anchor);
    if (this.view === "month" || (this.view === "agenda" && this.agendaSpan === "month")) return new Intl.DateTimeFormat(this.locale, { month: "long", year: "numeric", timeZone: this.timeZone }).format(this.anchor);
    if (this.view === "day" || (this.view === "agenda" && this.agendaSpan === "day")) return new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(this.anchor);
    const start = toDate(this.visibleRange.start);
    const end = new Date(toDate(this.visibleRange.end).getTime() - 1);
    return `${new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "short", timeZone: this.timeZone }).format(start)} – ${new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "short", year: "numeric", timeZone: this.timeZone }).format(end)}`;
  }

  private renderYear(): HTMLElement {
    const grid = el("div", "dc-year-grid");
    const buckets = groupByDay(this.occurrences, this.timeZone, this.visibleRange);
    const yearStart = startOfYear(this.anchor, this.timeZone);
    const today = new Date();
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const monthStart = addMonths(yearStart, monthIndex, this.timeZone);
      const month = el("section", "dc-year-month");
      const heading = el("button", "dc-year-month-title", new Intl.DateTimeFormat(this.locale, { month: "long", timeZone: this.timeZone }).format(monthStart));
      heading.type = "button";
      heading.addEventListener("click", () => { this.anchor = monthStart; this.setView("month"); });
      month.append(heading);
      const weekdays = el("div", "dc-year-weekdays");
      for (const weekday of weekdayOrder(this.weekStartsOn)) weekdays.append(el("span", undefined, DAY_NAMES[weekday]!.slice(0, 1)));
      month.append(weekdays);
      const days = el("div", "dc-year-days");
      const monthRange = rangeForView(monthStart, "month", this.weekStartsOn, this.timeZone);
      for (let cursor = toDate(monthRange.start); cursor < toDate(monthRange.end); cursor = addDays(cursor, 1, this.timeZone)) {
        const day = new Date(cursor);
        const parts = instantToPlain(day.getTime(), this.timeZone);
        const monthParts = instantToPlain(monthStart.getTime(), this.timeZone);
        const outside = parts.month !== monthParts.month;
        const button = el("button", "dc-year-day") as HTMLButtonElement;
        button.type = "button";
        button.classList.toggle("is-outside", outside);
        button.classList.toggle("is-today", sameLocalDay(day, today, this.timeZone));
        if (outside) {
          button.tabIndex = -1;
          button.setAttribute("aria-hidden", "true");
        } else {
          const bucket = buckets.get(dateKey(day, this.timeZone));
          const count = (bucket?.allDay.length ?? 0) + (bucket?.timed.length ?? 0);
          button.append(el("span", "dc-year-day-number", String(parts.day)));
          if (count) button.append(el("span", "dc-year-event-count", count > 9 ? "9+" : String(count)));
          button.setAttribute("aria-label", `${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(day)}${count ? `, ${count} event${count === 1 ? "" : "s"}` : ", no events"}`);
          button.addEventListener("click", () => { this.anchor = day; this.setView("day"); });
        }
        days.append(button);
      }
      month.append(days);
      grid.append(month);
    }
    return grid;
  }

  private renderMonth(): HTMLElement {
    const wrapper = el("div");
    const header = el("div", "dc-weekdays");
    for (const weekday of weekdayOrder(this.weekStartsOn)) header.append(el("div", "dc-weekday", DAY_NAMES[weekday]));
    const grid = el("div", "dc-month-grid");
    const buckets = groupByDay(this.occurrences, this.timeZone, this.visibleRange);
    const start = toDate(this.visibleRange.start);
    const end = toDate(this.visibleRange.end);
    const today = new Date();
    const anchorParts = instantToPlain(this.anchor.getTime(), this.timeZone);
    for (let cursor = new Date(start); cursor < end; cursor = addDays(cursor, 1, this.timeZone)) {
      const date = new Date(cursor);
      const parts = instantToPlain(date.getTime(), this.timeZone);
      const cell = el("div", "dc-day-cell");
      cell.tabIndex = 0;
      cell.setAttribute("role", "group");
      cell.setAttribute("aria-label", new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(date));
      cell.classList.toggle("is-outside", parts.month !== anchorParts.month);
      cell.classList.toggle("is-today", sameLocalDay(date, today, this.timeZone));
      cell.dataset.date = date.toISOString();
      const number = el("button", "dc-day-number", String(parts.day));
      number.type = "button";
      number.addEventListener("click", () => { this.anchor = date; this.setView("day"); });
      const events = el("div", "dc-month-events");
      const bucket = buckets.get(dateKey(date, this.timeZone));
      const rows = [...(bucket?.allDay ?? []), ...(bucket?.timed ?? [])];
      for (const occurrence of rows.slice(0, 4)) events.append(this.monthEvent(occurrence));
      if (rows.length > 4) {
        const more = el("button", "dc-more", `+${rows.length - 4} more`) as HTMLButtonElement;
        more.type = "button";
        more.setAttribute("aria-label", `Show all ${rows.length} events on ${new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "long", year: "numeric", timeZone: this.timeZone }).format(date)}`);
        more.addEventListener("click", event => { event.stopPropagation(); this.openMonthOverflow(date, rows); });
        events.append(more);
      }
      cell.append(number, events);
      cell.addEventListener("dragover", event => {
        if (this.dragOccurrenceFromTransfer(event.dataTransfer)) event.preventDefault();
      });
      cell.addEventListener("drop", event => {
        const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
        if (!occurrence || !this.canScheduleOccurrence(occurrence)) return;
        event.preventDefault();
        void this.moveToDay(occurrence, date, isDateLikeOccurrence(occurrence));
      });
      if (this.canCreateItems()) {
        cell.addEventListener("dblclick", event => {
          if ((event.target as Element).closest(".dc-event,.dc-day-number")) return;
          const startAt = startOfDay(date, this.timeZone);
          void this.createFromSelection({ start: startAt.toISOString(), end: addDays(startAt, 1, this.timeZone).toISOString(), allDay: true });
        });
      }
      grid.append(cell);
    }
    wrapper.append(header, grid);
    return wrapper;
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
    body.querySelector<HTMLElement>(".dc-event")?.focus();
  }

  private monthEvent(occurrence: CalendarOccurrence, allowDrag = true, bindInteractions = true): HTMLElement {
    const button = el("button", "dc-event");
    button.type = "button";
    button.setAttribute("aria-label", this.occurrenceAriaLabel(occurrence));
    button.dataset.occurrenceId = occurrence.occurrenceId;
    button.dataset.emphasis = occurrence.display?.emphasis ?? "normal";
    button.dataset.dimmed = String(Boolean(occurrence.display?.dimmed));
    button.dataset.kind = occurrence.kind;
    this.applyOccurrencePresentation(button, occurrence);
    if (!occurrence.allDay && occurrence.precision !== "date") button.append(el("span", "dc-event-time", formatTime(toDate(occurrence.start), this.locale, this.timeZone)));
    const icon = this.sourceIcon(occurrence);
    if (icon) { const mark = el("span", "dc-event-icon", icon); mark.setAttribute("aria-hidden", "true"); button.append(mark); }
    button.append(document.createTextNode(occurrence.title));
    button.title = occurrence.title;
    if (bindInteractions) this.bindOccurrenceElement(button, occurrence);
    if (bindInteractions && allowDrag && this.options.allowDrag !== false && this.canScheduleOccurrence(occurrence)) {
      this.bindNativeDrag(button, occurrence);
      button.addEventListener("pointerdown", pointer => {
        if (pointer.pointerType === "touch") this.beginDrag(pointer, occurrence, button, "move");
      });
    }
    return button;
  }

  private renderTimeGrid(dayCount: 1 | 7): HTMLElement {
    const shell = el("div", "dc-time-shell");
    shell.dataset.dayCount = String(dayCount);
    shell.setAttribute("role", "group");
    shell.setAttribute("aria-label", dayCount === 1 ? "Day calendar" : "Week calendar");
    const axis = el("div", "dc-time-axis");
    for (let hour = this.dayStartHour; hour < this.dayEndHour; hour += 1) axis.append(el("div", "dc-time-axis-label", `${String(hour).padStart(2, "0")}:00`));
    const content = el("div", "dc-time-content");
    const start = dayCount === 7 ? toDate(this.visibleRange.start) : startOfDay(this.anchor, this.timeZone);
    const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i, this.timeZone));
    const headers = el("div", "dc-day-headers");
    headers.style.gridTemplateColumns = `repeat(${dayCount},minmax(0,1fr))`;
    const allDay = el("div", "dc-all-day");
    allDay.style.gridTemplateColumns = `repeat(${dayCount},minmax(0,1fr))`;
    const grid = el("div", "dc-time-grid");
    grid.style.gridTemplateColumns = `repeat(${dayCount},minmax(0,1fr))`;
    grid.style.minHeight = `${(this.dayEndHour - this.dayStartHour) * 60}px`;
    const buckets = groupByDay(this.occurrences, this.timeZone, this.visibleRange);

    for (const day of days) {
      const head = el("button", "dc-day-header");
      head.type = "button";
      head.append(el("strong", undefined, new Intl.DateTimeFormat(this.locale, { weekday: "short", timeZone: this.timeZone }).format(day)), el("span", undefined, new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "short", timeZone: this.timeZone }).format(day)));
      head.addEventListener("click", () => { this.anchor = day; this.setView("day"); });
      headers.append(head);
      const all = el("div", "dc-all-day-col");
      all.dataset.date = day.toISOString();
      all.setAttribute("role", "group");
      all.setAttribute("aria-label", `All-day events for ${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(day)}`);
      for (const occurrence of buckets.get(dateKey(day, this.timeZone))?.allDay ?? []) all.append(this.monthEvent(occurrence));
      all.addEventListener("dragover", event => {
        if (this.dragOccurrenceFromTransfer(event.dataTransfer)) event.preventDefault();
      });
      all.addEventListener("drop", event => {
        const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
        if (!occurrence || !this.canScheduleOccurrence(occurrence)) return;
        event.preventDefault();
        void this.moveToDay(occurrence, day, true);
      });
      if (this.canCreateItems()) all.addEventListener("dblclick", () => void this.createFromSelection({ start: startOfDay(day, this.timeZone).toISOString(), end: addDays(startOfDay(day, this.timeZone), 1, this.timeZone).toISOString(), allDay: true }));
      allDay.append(all);
      grid.append(this.timeColumn(day));
    }
    content.append(headers, allDay, grid);
    shell.append(axis, content);
    return shell;
  }

  private timeColumn(day: Date): HTMLElement {
    const column = el("div", "dc-time-column");
    column.dataset.date = day.toISOString();
    column.setAttribute("role", "group");
    column.setAttribute("aria-label", `Timed events for ${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(day)}`);
    const layouts = layoutTimedDay(this.occurrences, day, this.timeZone);
    for (const layout of layouts) {
      const occurrence = layout.occurrence;
      const event = el("div", "dc-time-event");
      event.tabIndex = 0;
      event.setAttribute("role", "button");
      event.dataset.occurrenceId = occurrence.occurrenceId;
      event.dataset.emphasis = occurrence.display?.emphasis ?? "normal";
      event.dataset.dimmed = String(Boolean(occurrence.display?.dimmed));
      event.dataset.kind = occurrence.kind;
      this.applyOccurrencePresentation(event, occurrence);
      event.setAttribute("aria-label", this.occurrenceAriaLabel(occurrence));
      const startMinute = layout.topMinutes - this.dayStartHour * 60;
      const endMinute = startMinute + layout.heightMinutes;
      if (endMinute <= 0 || startMinute >= (this.dayEndHour - this.dayStartHour) * 60) continue;
      const top = Math.max(0, startMinute);
      const height = Math.max(18, Math.min((this.dayEndHour - this.dayStartHour) * 60 - top, layout.heightMinutes));
      const width = 100 / layout.columnCount;
      event.style.top = `${top}px`;
      event.style.height = `${height}px`;
      event.style.left = `calc(${layout.column * width}% + 2px)`;
      event.style.right = `calc(${100 - (layout.column + layout.columnSpan) * width}% + 2px)`;
      event.style.zIndex = String(2 + layout.column);
      const title = el("div", "dc-time-event-title");
      const icon = this.sourceIcon(occurrence);
      if (icon) { const mark = el("span", "dc-event-icon", icon); mark.setAttribute("aria-hidden", "true"); title.append(mark); }
      title.append(document.createTextNode(occurrence.title));
      event.append(title, el("div", "dc-time-event-time", `${formatTime(toDate(occurrence.start), this.locale, this.timeZone)} – ${formatTime(toDate(occurrence.end), this.locale, this.timeZone)}`));
      this.bindOccurrenceElement(event, occurrence);
      if (this.options.allowDrag !== false && this.canScheduleOccurrence(occurrence)) {
        event.addEventListener("pointerdown", pointer => {
          if ((pointer.target as Element).closest(".dc-resize-handle")) return;
          this.beginDrag(pointer, occurrence, event, "move");
        });
      }
      if (this.options.allowResize !== false && this.canScheduleOccurrence(occurrence)) {
        const startHandle = el("div", "dc-resize-handle dc-resize-start");
        startHandle.setAttribute("aria-hidden", "true");
        startHandle.addEventListener("pointerdown", pointer => this.beginDrag(pointer, occurrence, event, "resize-start"));
        const endHandle = el("div", "dc-resize-handle dc-resize-end");
        endHandle.setAttribute("aria-hidden", "true");
        endHandle.addEventListener("pointerdown", pointer => this.beginDrag(pointer, occurrence, event, "resize-end"));
        event.append(startHandle, endHandle);
      }
      column.append(event);
    }

    column.addEventListener("dragover", event => {
      if (this.dragOccurrenceFromTransfer(event.dataTransfer)) event.preventDefault();
    });
    column.addEventListener("drop", event => {
      const occurrence = this.dragOccurrenceFromTransfer(event.dataTransfer);
      if (!occurrence || !this.canScheduleOccurrence(occurrence)) return;
      event.preventDefault();
      const rect = column.getBoundingClientRect();
      const minutes = this.dayStartHour * 60 + Math.max(0, event.clientY - rect.top);
      const target = snapWithPolicy(atMinuteOfDay(day, minutes, this.timeZone), this.slotMinutes, this.snapPolicy.move);
      const dateLike = isDateLikeOccurrence(occurrence);
      const end = new Date(target.getTime() + (dateLike ? 60 * 60_000 : durationMs(occurrence)));
      void (async () => {
        if (!await this.allowPlacement(target, end, false, occurrence, "move")) return;
        const patch = dateLike
          ? placementTimePatch(target, end, false, this.timeZone)
          : { start: target.toISOString(), end: end.toISOString(), allDay: false, precision: "minute" as const };
        await this.issueOccurrencePatch(occurrence, patch, "Move");
      })();
    });

    if (this.canCreateItems()) {
      column.addEventListener("pointerdown", event => {
        if (event.button !== 0 || (event.target as Element).closest(".dc-time-event")) return;
        if (event.pointerType === "touch") return;
        this.beginRangeSelection(event, day, column);
      });
      column.addEventListener("dblclick", event => {
        if ((event.target as Element).closest(".dc-time-event")) return;
        const rect = column.getBoundingClientRect();
        const minute = this.dayStartHour * 60 + (event.clientY - rect.top);
        const start = snapWithPolicy(atMinuteOfDay(day, minute, this.timeZone), this.slotMinutes, this.snapPolicy.selection);
        void this.createFromSelection({ start: start.toISOString(), end: new Date(start.getTime() + 60 * 60_000).toISOString(), allDay: false });
      });
    }

    if (this.options.showNowIndicator !== false && sameLocalDay(day, new Date(), this.timeZone)) {
      const now = new Date();
      const nowParts = instantToPlain(now.getTime(), this.timeZone);
      const minute = nowParts.hour * 60 + nowParts.minute - this.dayStartHour * 60;
      if (minute >= 0 && minute <= (this.dayEndHour - this.dayStartHour) * 60) {
        const marker = el("div", "dc-now");
        marker.setAttribute("aria-hidden", "true");
        marker.style.top = `${minute}px`;
        column.append(marker);
      }
    }
    return column;
  }

  private bindOccurrenceElement(node: HTMLElement, occurrence: CalendarOccurrence): void {
    const shortcuts = ["Enter", "Space"];
    if (this.canEditOccurrence(occurrence)) shortcuts.push("E");
    if (this.canDeleteOccurrence(occurrence)) shortcuts.push("Delete");
    if (this.canScheduleOccurrence(occurrence)) shortcuts.push("Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown", "Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown");
    node.setAttribute("aria-keyshortcuts", shortcuts.join(" "));
    node.addEventListener("click", event => {
      event.stopPropagation();
      if (Date.now() <= this.suppressOccurrenceClickUntil) return;
      void this.openDetails(occurrence);
    });
    node.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      this.openContextMenu(occurrence, event.clientX, event.clientY);
    });
    node.addEventListener("keydown", event => {
      if (event.altKey && event.key.startsWith("Arrow") && this.canScheduleOccurrence(occurrence)) {
        event.preventDefault();
        event.stopPropagation();
        void this.keyboardTransformOccurrence(occurrence, event.key, event.shiftKey);
      } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void this.openDetails(occurrence); }
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

  private beginDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: "move" | "resize-start" | "resize-end"): void {
    if (pointer.button !== 0) return;
    pointer.stopPropagation();
    if (pointer.pointerType === "touch") {
      this.armTouchDrag(pointer, occurrence, element, mode);
      return;
    }
    this.armPointerDrag(pointer, occurrence, element, mode);
  }

  private armPointerDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: "move" | "resize-start" | "resize-end"): void {
    this.cancelPointerArm();
    const pointerId = pointer.pointerId;
    const startX = pointer.clientX;
    const startY = pointer.clientY;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
      event.preventDefault();
      cleanup();
      this.activateDrag(pointerId, startX, startY, occurrence, element, mode);
      this.moveDrag(event);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (this.pointerArmCleanup === cleanup) this.pointerArmCleanup = null;
    };
    this.pointerArmCleanup?.();
    this.pointerArmCleanup = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  private cancelPointerArm(): void {
    this.pointerArmCleanup?.();
  }

  private armTouchDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: "move" | "resize-start" | "resize-end"): void {
    this.cancelTouchPress();
    const pointerId = pointer.pointerId;
    const startX = pointer.clientX;
    const startY = pointer.clientY;
    element.classList.add("is-touch-arming");
    const timer = window.setTimeout(() => {
      const press = this.touchPress;
      if (!press || press.pointerId !== pointerId) return;
      this.touchPress = null;
      element.classList.remove("is-touch-arming");
      this.touchListenerCleanup?.();
      this.activateDrag(pointerId, press.lastX, press.lastY, occurrence, element, mode);
      this.announce(`${mode === "move" ? "Moving" : "Resizing"} ${occurrence.title}. Drag, then release.`);
    }, this.longPressMs);
    this.touchPress = { pointerId, startX, startY, lastX: startX, lastY: startY, timer, occurrence, element, mode };

    const move = (event: PointerEvent) => {
      const press = this.touchPress;
      if (!press || event.pointerId !== press.pointerId) return;
      press.lastX = event.clientX;
      press.lastY = event.clientY;
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 10) this.cancelTouchPress();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (this.touchListenerCleanup === cleanup) this.touchListenerCleanup = null;
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      this.cancelTouchPress();
      cleanup();
    };
    this.touchListenerCleanup?.();
    this.touchListenerCleanup = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  private cancelTouchPress(): void {
    if (this.touchPress) {
      clearTimeout(this.touchPress.timer);
      this.touchPress.element.classList.remove("is-touch-arming");
      this.touchPress = null;
    }
    this.touchListenerCleanup?.();
  }

  private activateDrag(pointerId: number, clientX: number, clientY: number, occurrence: CalendarOccurrence, element: HTMLElement, mode: "move" | "resize-start" | "resize-end"): void {
    this.cancelTouchPress();
    const rect = element.getBoundingClientRect();
    try { element.setPointerCapture(pointerId); } catch { /* pointer capture can be unavailable after synthetic/browser transitions */ }
    element.classList.add("is-dragging");
    this.setDraggingState(true);
    const body = this.host.querySelector<HTMLElement>(".dc-body");
    this.drag = {
      occurrence,
      mode,
      pointerId,
      pointerStartX: clientX,
      pointerStartY: clientY,
      originalStart: toDate(occurrence.start),
      originalEnd: toDate(occurrence.end),
      element,
      originalHeightCss: element.style.height,
      grabOffsetMinutes: Math.max(0, clientY - rect.top),
      scrollStartTop: body?.scrollTop ?? 0,
      scrollStartLeft: body?.scrollLeft ?? 0,
      lastClientX: clientX,
      lastClientY: clientY,
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", cancel, true);
      if (this.dragListenerCleanup === cleanup) this.dragListenerCleanup = null;
    };
    const move = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      event.preventDefault();
      this.moveDrag(event);
    };
    const end = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      event.preventDefault();
      cleanup();
      void this.finishDrag(event);
    };
    const cancel = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      cleanup();
      this.cancelActiveDrag();
    };
    this.dragListenerCleanup?.();
    this.dragListenerCleanup = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", cancel, true);
    this.startAutoScroll();
  }

  private cancelActiveDrag(): void {
    this.dragListenerCleanup?.();
    const drag = this.drag;
    this.drag = null;
    this.stopAutoScroll();
    if (!drag) return;
    this.suppressOccurrenceClickUntil = Date.now() + 350;
    drag.element.classList.remove("is-dragging");
    drag.element.style.transform = "";
    drag.element.style.height = drag.originalHeightCss;
    this.setDraggingState(false);
    this.announce(`${drag.mode === "move" ? "Move" : "Resize"} cancelled for ${drag.occurrence.title}.`);
  }

  private moveDrag(pointer: PointerEvent): void {
    if (!this.drag) return;
    this.drag.lastClientX = pointer.clientX;
    this.drag.lastClientY = pointer.clientY;
    const body = this.host.querySelector<HTMLElement>(".dc-body");
    const scrollDelta = (body?.scrollTop ?? 0) - this.drag.scrollStartTop;
    const horizontalScrollDelta = (body?.scrollLeft ?? 0) - this.drag.scrollStartLeft;
    const rawDelta = pointer.clientY - this.drag.pointerStartY + scrollDelta;
    if (this.drag.mode !== "move") {
      const delta = this.snappedDeltaMinutes(rawDelta, this.snapPolicy.resize);
      const duration = Math.max(this.slotMinutes, durationMs(this.drag.occurrence) / 60_000);
      const preview = resizePreview(duration, delta, this.resizeEdge(this.drag.mode), this.slotMinutes);
      this.drag.element.style.transform = `translateY(${preview.offsetMinutes}px)`;
      this.drag.element.style.height = `${preview.heightMinutes}px`;
      return;
    }
    const snappedDelta = this.snappedDeltaMinutes(rawDelta, this.snapPolicy.move);
    const deltaX = pointer.clientX - this.drag.pointerStartX + horizontalScrollDelta;
    this.drag.element.style.transform = `translate(${deltaX}px,${snappedDelta}px)`;
  }

  private resizeEdge(mode: DragState["mode"]): CalendarResizeEdge {
    return mode === "resize-start" ? "start" : "end";
  }

  private snappedDeltaMinutes(deltaPixels: number, strategy: CalendarSnapPolicy["move"]): number {
    if (strategy === "none") return Math.round(deltaPixels);
    const raw = deltaPixels / this.slotMinutes;
    const units = strategy === "floor" ? Math.floor(raw) : strategy === "ceil" ? Math.ceil(raw) : Math.round(raw);
    return units * this.slotMinutes;
  }

  private startAutoScroll(): void {
    if (this.autoScrollFrame !== null) return;
    const tick = () => {
      this.autoScrollFrame = null;
      const drag = this.drag;
      const body = this.host.querySelector<HTMLElement>(".dc-body");
      if (!drag || !body) return;
      const rect = body.getBoundingClientRect();
      let verticalVelocity = 0;
      let horizontalVelocity = 0;
      if (drag.lastClientY < rect.top + this.autoScrollEdgePx) {
        const ratio = Math.min(1, (rect.top + this.autoScrollEdgePx - drag.lastClientY) / this.autoScrollEdgePx);
        verticalVelocity = -Math.max(2, ratio * this.autoScrollMaxPxPerFrame);
      } else if (drag.lastClientY > rect.bottom - this.autoScrollEdgePx) {
        const ratio = Math.min(1, (drag.lastClientY - (rect.bottom - this.autoScrollEdgePx)) / this.autoScrollEdgePx);
        verticalVelocity = Math.max(2, ratio * this.autoScrollMaxPxPerFrame);
      }
      if (drag.lastClientX < rect.left + this.autoScrollEdgePx) {
        const ratio = Math.min(1, (rect.left + this.autoScrollEdgePx - drag.lastClientX) / this.autoScrollEdgePx);
        horizontalVelocity = -Math.max(2, ratio * this.autoScrollMaxPxPerFrame);
      } else if (drag.lastClientX > rect.right - this.autoScrollEdgePx) {
        const ratio = Math.min(1, (drag.lastClientX - (rect.right - this.autoScrollEdgePx)) / this.autoScrollEdgePx);
        horizontalVelocity = Math.max(2, ratio * this.autoScrollMaxPxPerFrame);
      }
      if (verticalVelocity || horizontalVelocity) {
        body.scrollTop += verticalVelocity;
        body.scrollLeft += horizontalVelocity;
        this.moveDrag({ clientX: drag.lastClientX, clientY: drag.lastClientY } as PointerEvent);
      }
      this.autoScrollFrame = requestAnimationFrame(tick);
    };
    this.autoScrollFrame = requestAnimationFrame(tick);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollFrame === null) return;
    cancelAnimationFrame(this.autoScrollFrame);
    this.autoScrollFrame = null;
  }

  private async finishDrag(pointer: PointerEvent): Promise<void> {
    const drag = this.drag;
    this.drag = null;
    this.stopAutoScroll();
    if (!drag) return;
    this.suppressOccurrenceClickUntil = Date.now() + 350;
    drag.element.classList.remove("is-dragging");
    drag.element.style.transform = "";
    drag.element.style.height = drag.originalHeightCss;
    this.setDraggingState(false);
    const body = this.host.querySelector<HTMLElement>(".dc-body");
    const scrollDelta = (body?.scrollTop ?? 0) - drag.scrollStartTop;
    const totalDelta = pointer.clientY - drag.pointerStartY + scrollDelta;

    drag.element.style.pointerEvents = "none";
    const under = document.elementFromPoint(pointer.clientX, pointer.clientY) as HTMLElement | null;
    drag.element.style.pointerEvents = "";
    if (drag.mode !== "move") {
      const edge = this.resizeEdge(drag.mode);
      const targetColumn = under?.closest<HTMLElement>(".dc-time-column");
      let target: Date;
      if (targetColumn?.dataset.date) {
        const day = toDate(targetColumn.dataset.date);
        const rect = targetColumn.getBoundingClientRect();
        const minute = this.dayStartHour * 60 + (pointer.clientY - rect.top);
        target = snapWithPolicy(atMinuteOfDay(day, minute, this.timeZone), this.slotMinutes, this.snapPolicy.resize);
      } else {
        const delta = this.snappedDeltaMinutes(totalDelta, this.snapPolicy.resize);
        if (!delta) return;
        target = minuteDelta(edge === "start" ? drag.originalStart : drag.originalEnd, delta);
      }
      const resized = resizeInterval(drag.originalStart, drag.originalEnd, target, edge, this.slotMinutes);
      if (resized.start.getTime() === drag.originalStart.getTime() && resized.end.getTime() === drag.originalEnd.getTime()) return;
      if (!await this.allowPlacement(resized.start, resized.end, false, drag.occurrence, "resize")) return;
      await this.issueTimedCommand({ type: "resize-occurrence", occurrence: drag.occurrence, start: resized.start.toISOString(), end: resized.end.toISOString(), scope: "this" }, "Resize");
      return;
    }
    const monthTarget = under?.closest<HTMLElement>(".dc-day-cell");
    if (monthTarget?.dataset.date) {
      await this.moveToDay(drag.occurrence, toDate(monthTarget.dataset.date), isDateLikeOccurrence(drag.occurrence));
      return;
    }
    const allDayTarget = under?.closest<HTMLElement>(".dc-all-day-col");
    if (allDayTarget?.dataset.date) {
      const day = toDate(allDayTarget.dataset.date);
      const start = startOfDay(day, this.timeZone);
      const days = calendarDaySpan(toDate(drag.occurrence.start), toDate(drag.occurrence.end), this.timeZone);
      const end = addDays(start, days, this.timeZone);
      if (!await this.allowPlacement(start, end, true, drag.occurrence, "move")) return;
      await this.issueOccurrencePatch(drag.occurrence, placementTimePatch(start, end, true, this.timeZone), "Move");
      return;
    }
    const column = under?.closest<HTMLElement>(".dc-time-column");
    if (column?.dataset.date) {
      const day = toDate(column.dataset.date);
      const rect = column.getBoundingClientRect();
      const rawMinute = this.dayStartHour * 60 + (pointer.clientY - rect.top) - drag.grabOffsetMinutes;
      const start = snapWithPolicy(atMinuteOfDay(day, rawMinute, this.timeZone), this.slotMinutes, this.snapPolicy.move);
      const dateLike = isDateLikeOccurrence(drag.occurrence);
      const end = new Date(start.getTime() + (dateLike ? 60 * 60_000 : durationMs(drag.occurrence)));
      if (!await this.allowPlacement(start, end, false, drag.occurrence, "move")) return;
      if (dateLike) await this.issueOccurrencePatch(drag.occurrence, placementTimePatch(start, end, false, this.timeZone), "Move");
      else await this.issueTimedCommand({ type: "move-occurrence", occurrence: drag.occurrence, start: start.toISOString(), end: end.toISOString(), scope: "this" }, "Move");
      return;
    }
    const deltaMinutes = this.snappedDeltaMinutes(totalDelta, this.snapPolicy.move);
    if (!deltaMinutes) return;
    const start = minuteDelta(drag.originalStart, deltaMinutes);
    const end = minuteDelta(drag.originalEnd, deltaMinutes);
    if (!await this.allowPlacement(start, end, false, drag.occurrence, "move")) return;
    await this.issueTimedCommand({ type: "move-occurrence", occurrence: drag.occurrence, start: start.toISOString(), end: end.toISOString(), scope: "this" }, "Move");
  }

  private beginRangeSelection(pointer: PointerEvent, day: Date, column: HTMLElement): void {
    pointer.preventDefault();
    pointer.stopPropagation();
    const rect = column.getBoundingClientRect();
    const minMinute = this.dayStartHour * 60;
    const maxMinute = this.dayEndHour * 60;
    const rawMinute = Math.min(maxMinute, Math.max(minMinute, minMinute + pointer.clientY - rect.top));
    const startDate = snapWithPolicy(atMinuteOfDay(day, rawMinute, this.timeZone), this.slotMinutes, this.snapPolicy.selection);
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
      const next = snapWithPolicy(atMinuteOfDay(day, minute, this.timeZone), this.slotMinutes, this.snapPolicy.selection);
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
      const start = atMinuteOfDay(day, a, this.timeZone);
      const finish = atMinuteOfDay(day, b, this.timeZone);
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
    const container = el("div", "dc-agenda");
    const groups = groupAgendaByDay(this.occurrences, this.visibleRange, this.timeZone);
    if (!groups.length) {
      container.append(el("div", "dc-empty", this.addonEmptyMessage() ?? "Nothing scheduled in this range."));
      return container;
    }
    for (const group of groups) {
      const date = toDate(group.date, this.timeZone);
      const section = el("section", "dc-agenda-day");
      const heading = el("div", "dc-agenda-heading");
      heading.append(el("span", undefined, new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(date)));
      const summaries = (this.options.extensions ?? []).map(extension => extension.presentAgendaDay?.(group.date, group.occurrences)?.summary).filter((value): value is string => Boolean(value));
      if (summaries.length) heading.append(el("span", "dc-agenda-totals", summaries.join(" · ")));
      section.append(heading);
      const rows = [...group.occurrences].sort((a, b) => {
        const aOrder = this.occurrencePresentation(a).agendaOrder;
        const bOrder = this.occurrencePresentation(b).agendaOrder;
        return aOrder - bOrder || toDate(a.start).getTime() - toDate(b.start).getTime() || a.title.localeCompare(b.title);
      });
      for (const occurrence of rows) {
        const row = el("div", "dc-agenda-row");
        row.dataset.kind = occurrence.kind;
        row.dataset.emphasis = occurrence.display?.emphasis ?? "normal";
        this.applyOccurrencePresentation(row, occurrence);
        const startsBeforeDay = dateKey(occurrence.start, this.timeZone) < group.date;
        const endsAfterDay = dateKey(new Date(toDate(occurrence.end).getTime() - 1), this.timeZone) > group.date;
        const time = occurrence.allDay || occurrence.precision === "date"
          ? "All day"
          : startsBeforeDay && endsAfterDay
            ? "Continues →"
            : startsBeforeDay
              ? `Continues · until ${formatTime(toDate(occurrence.end), this.locale, this.timeZone)}`
              : endsAfterDay
                ? `${formatTime(toDate(occurrence.start), this.locale, this.timeZone)} →`
                : formatTime(toDate(occurrence.start), this.locale, this.timeZone);
        row.append(el("div", "dc-agenda-time", time));
        const detailWrap = el("div", "dc-agenda-detail");
        const detail = this.monthEvent(occurrence);
        detail.classList.add("dc-agenda-event");
        detailWrap.append(detail);
        const presentation = this.occurrencePresentation(occurrence);
        const meta = presentation.agendaMeta.join(" · ");
        if (meta) detailWrap.append(el("div", "dc-agenda-meta", meta));
        row.append(detailWrap);
        section.append(row);
      }
      container.append(section);
    }
    return container;
  }

  private resolveDraftTime(value: string, temporal: CalendarCreateDraft["temporal"]): Date {
    if (temporal?.kind === "date") return toDate(value, this.timeZone);
    if (temporal?.kind === "zoned") return toDate(value, temporal.timeZone ?? this.timeZone);
    if (temporal?.kind === "floating") return toDate(value, this.timeZone);
    return toDate(value);
  }

  private createCalendarItem(draft: CalendarCreateDraft, purpose: CalendarItemFactoryInput["purpose"], original?: CalendarOccurrence): CalendarItem {
    const now = new Date().toISOString();
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
    const now = new Date();
    let start = atMinuteOfDay(day, 9 * 60, this.timeZone);
    if (sameLocalDay(day, now, this.timeZone)) start = snapWithPolicy(new Date(now.getTime() + 30 * 60_000), this.slotMinutes, "ceil");
    await this.createFromSelection({ start: start.toISOString(), end: new Date(start.getTime() + 60 * 60_000).toISOString(), allDay: false });
  }

  private async createFromSelection(selection: CalendarSelection): Promise<void> {
    this.options.callbacks?.onCreate?.(selection);
    if (await this.options.callbacks?.handleCreate?.(selection)) return;
    const result = await openEventEditor(this.host, { selection }, this.sources, this.defaultCalendarId, this.weekStartsOn, this.timeZone, this.kindOptions(), this.options.reminderChannelOptions);
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
    if (!await this.allowPlacement(this.resolveDraftTime(withSeries.start, withSeries.temporal), this.resolveDraftTime(withSeries.end, withSeries.temporal), Boolean(withSeries.allDay), undefined, "create")) return;
    await this.dispatch({ type: "create", item: withSeries });
  }

  private sourceItem(occurrence: CalendarOccurrence): CalendarItem | undefined {
    return this.engine.snapshot().items.find(item => item.id === occurrence.sourceItemId);
  }

  private async openDetails(occurrence: CalendarOccurrence): Promise<void> {
    this.options.callbacks?.onOpen?.(occurrence);
    if (await this.options.callbacks?.handleOpen?.(occurrence)) return;
    const dialog = el("dialog", "dc-dialog dc-details-dialog");
    dialog.setAttribute("aria-label", `${occurrence.title} details`);
    const card = el("div", "dc-details");
    const header = el("div", "dc-dialog-header");
    header.append(el("h2", undefined, occurrence.title));
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
      : `${formatDateTime(toDate(occurrence.start), this.locale, this.timeZone)} – ${formatDateTime(toDate(occurrence.end), this.locale, this.timeZone)}`;
    body.append(this.detailRow("When", when), this.detailRow("Calendar", this.sourceTitle(occurrence.calendarId)), this.detailRow("Type", this.kindLabel(occurrence.kind)));
    if (occurrence.recurring) body.append(this.detailRow("Repeat", "Recurring series"));
    if (occurrence.location) body.append(this.detailRow("Location", occurrence.location));
    if (occurrence.description) body.append(this.detailRow("Notes", occurrence.description));
    for (const row of this.occurrencePresentation(occurrence).detailRows) body.append(this.detailRow(row.label, row.value));
    const activeReminders = occurrence.reminders?.filter(reminder => reminder.enabled !== false) ?? [];
    if (activeReminders.length) body.append(this.detailRow("Reminder", activeReminders.map(reminder => `${reminder.minutesBefore === 0 ? "At start" : `${reminder.minutesBefore}m before`} · ${reminder.channel}`).join(", ")));
    if (occurrence.editPolicy !== "full") {
      const access = occurrence.editPolicy === "schedule-only" ? "Schedule changes only" : "Read-only";
      body.append(this.detailRow("Access", access));
    }
    const footer = el("div", "dc-dialog-footer dc-details-actions");
    for (const action of this.options.sourceActions?.actions(occurrence) ?? []) {
      const button = this.button(action.label, () => { dialog.close(); void this.executeSourceAction(action.id, occurrence); });
      if (action.primary) button.classList.add("dc-primary");
      footer.append(button);
    }
    if (this.canEditOccurrence(occurrence)) footer.append(this.button("Edit", () => { dialog.close(); void this.editOccurrence(occurrence); }));
    if (this.canDuplicateOccurrence()) footer.append(this.button("Duplicate", () => { dialog.close(); void this.duplicateOccurrence(occurrence); }));
    for (const action of (this.options.addons ?? []).flatMap(addon => addon.detailActions?.(occurrence, this.addonContext()) ?? [])) {
      const button = this.button(action.label, () => { dialog.close(); void action.run(); });
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
    if (!this.canEditOccurrence(occurrence)) return;
    if (await this.options.callbacks?.handleEdit?.(occurrence)) return;
    const sourceItem = this.sourceItem(occurrence);
    const result = await openEventEditor(this.host, { occurrence, ...(sourceItem ? { sourceItem } : {}) }, this.sources, this.defaultCalendarId, this.weekStartsOn, this.timeZone, this.kindOptions(), this.options.reminderChannelOptions);
    if (!result) return;
    const fullEdit = occurrence.editPolicy === "full";
    const recurrenceChanged = fullEdit && !sameRecurrence(sourceItem?.recurrence, result.recurrence);
    const patch: CalendarItemPatch = {
      ...(fullEdit ? { calendarId: result.calendarId, title: result.title, description: result.description ?? null, location: result.location ?? null, kind: result.kind } : {}),
      start: result.start,
      end: result.end,
      allDay: result.allDay,
      precision: result.allDay ? "date" : "minute",
      ...(fullEdit ? { temporal: result.temporal, reminders: result.reminders ?? null } : {}),
      ...(recurrenceChanged ? { recurrence: result.recurrence ?? null } : {}),
    };
    let scope: SeriesEditScope = "all";
    if (occurrence.recurring) {
      const selected = await chooseSeriesScope(this.host, "Edit", !recurrenceChanged);
      if (!selected) return;
      scope = selected;
    }
    if (!await this.allowPlacement(this.resolveDraftTime(result.start, result.temporal), this.resolveDraftTime(result.end, result.temporal), result.allDay, occurrence, "edit")) return;
    await this.dispatch({ type: "update-occurrence", occurrence, patch, scope });
  }

  private async duplicateOccurrence(occurrence: CalendarOccurrence): Promise<void> {
    const sourceItem = this.sourceItem(occurrence);
    const result = await openEventEditor(this.host, { occurrence, ...(sourceItem ? { sourceItem } : {}), duplicate: true }, this.sources, this.defaultCalendarId, this.weekStartsOn, this.timeZone, this.kindOptions(), this.options.reminderChannelOptions);
    if (!result) return;
    const item = this.createCalendarItem({
      calendarId: result.calendarId,
      title: result.title,
      ...(result.description ? { description: result.description } : {}),
      ...(result.location ? { location: result.location } : {}),
      start: result.start, end: result.end, allDay: result.allDay, precision: result.allDay ? "date" : "minute", temporal: result.temporal, kind: result.kind,
      ...(result.recurrence ? { recurrence: result.recurrence } : {}),
      ...(result.reminders ? { reminders: result.reminders } : {}),
    }, "duplicate", occurrence);
    const withSeries = result.recurrence ? { ...item, seriesId: item.id } : item;
    if (!await this.allowPlacement(this.resolveDraftTime(withSeries.start, withSeries.temporal), this.resolveDraftTime(withSeries.end, withSeries.temporal), Boolean(withSeries.allDay), undefined, "create")) return;
    await this.dispatch({ type: "create", item: withSeries });
  }

  private async deleteOccurrence(occurrence: CalendarOccurrence): Promise<void> {
    if (!this.canDeleteOccurrence(occurrence)) return;
    let scope: SeriesEditScope = "all";
    if (occurrence.recurring) {
      const selected = await chooseSeriesScope(this.host, "Delete");
      if (!selected) return;
      scope = selected;
    }
    if (!await confirmCalendarAction(this.host, "Delete event", `Delete “${occurrence.title}”?`, "Delete", true)) return;
    await this.dispatch({ type: "cancel-occurrence", occurrence, scope });
  }

  private async moveToDay(occurrence: CalendarOccurrence, day: Date, allDay: boolean): Promise<void> {
    const originalStart = toDate(occurrence.start);
    if (allDay) {
      const start = startOfDay(day, this.timeZone);
      const days = calendarDaySpan(toDate(occurrence.start), toDate(occurrence.end), this.timeZone);
      const end = addDays(start, days, this.timeZone);
      if (!await this.allowPlacement(start, end, true, occurrence, "move")) return;
      await this.issueOccurrencePatch(occurrence, placementTimePatch(start, end, true, this.timeZone), "Move");
      return;
    }
    const start = withLocalTime(day, originalStart, this.timeZone);
    const end = new Date(start.getTime() + durationMs(occurrence));
    if (!await this.allowPlacement(start, end, false, occurrence, "move")) return;
    await this.issueOccurrencePatch(occurrence, { start: start.toISOString(), end: end.toISOString(), allDay: false, precision: "minute" }, "Move");
  }

  private async issueOccurrencePatch(occurrence: CalendarOccurrence, patch: CalendarItemPatch, action: string): Promise<void> {
    let scope: SeriesEditScope = "all";
    if (occurrence.recurring) {
      const selected = await chooseSeriesScope(this.host, action);
      if (!selected) return;
      scope = selected;
    }
    await this.dispatch({ type: "update-occurrence", occurrence, patch, scope });
  }

  private async issueTimedCommand(command: Extract<CalendarCommand, { type: "move-occurrence" | "resize-occurrence" }>, action: string): Promise<void> {
    let next = command;
    if (command.occurrence.recurring) {
      const scope = await chooseSeriesScope(this.host, action);
      if (!scope) return;
      next = { ...command, scope };
    }
    await this.dispatch(next);
  }

  private async dispatch(command: CalendarCommand): Promise<void> {
    const occurrence = command.type === "update-occurrence" || command.type === "move-occurrence" || command.type === "resize-occurrence" || command.type === "cancel-occurrence"
      ? command.occurrence
      : undefined;
    if (this.options.commandHandler) await this.options.commandHandler.execute(command, { now: new Date().toISOString(), timeZone: this.timeZone, ...(occurrence ? { occurrence } : {}) });
    this.options.callbacks?.onCommand?.(command);
    if (this.options.commandHandler) await this.refresh();
  }

  public async undo(): Promise<boolean> {
    const undo = this.options.commandHandler?.undo;
    if (!undo) return false;
    const changed = await undo.call(this.options.commandHandler);
    if (changed) {
      this.announce("Calendar change undone.");
      await this.refresh();
    }
    return changed;
  }

  public async redo(): Promise<boolean> {
    const redo = this.options.commandHandler?.redo;
    if (!redo) return false;
    const changed = await redo.call(this.options.commandHandler);
    if (changed) {
      this.announce("Calendar change redone.");
      await this.refresh();
    }
    return changed;
  }

  private announce(message: string): void {
    const status = this.host.querySelector<HTMLElement>("[data-role='status']");
    if (!status) return;
    status.textContent = "";
    requestAnimationFrame(() => { status.textContent = message; });
  }

  private occurrenceAriaLabel(occurrence: CalendarOccurrence): string {
    const start = toDate(occurrence.start);
    const end = toDate(occurrence.end);
    const when = occurrence.allDay || occurrence.precision === "date"
      ? `${new Intl.DateTimeFormat(this.locale, { weekday: "long", day: "numeric", month: "long", timeZone: this.timeZone }).format(start)}, all day`
      : `${formatDateTime(start, this.locale, this.timeZone)} to ${formatTime(end, this.locale, this.timeZone)}`;
    const hints: string[] = [];
    if (this.canEditOccurrence(occurrence)) hints.push("Press E to edit");
    if (this.canScheduleOccurrence(occurrence)) hints.push("Alt plus arrow keys move; Alt plus Shift plus up or down resizes");
    const editableHint = hints.length ? `. ${hints.join(". ")}.` : "";
    return `${occurrence.title}. ${when}. ${this.sourceTitle(occurrence.calendarId)}${editableHint}`;
  }

  private async allowPlacement(
    start: Date,
    end: Date,
    allDay: boolean,
    occurrence: CalendarOccurrence | undefined,
    action: string,
  ): Promise<boolean> {
    if (this.collisionPolicy.mode === "allow") return true;
    const queryStart = addDays(startOfDay(start, this.timeZone), -1, this.timeZone);
    const queryEnd = addDays(startOfDay(end, this.timeZone), 2, this.timeZone);
    const allSources = new Set(this.sources.map(source => source.id));
    const result = await this.engine.query({ start: queryStart.toISOString(), end: queryEnd.toISOString() }, { visibleSourceIds: allSources, timeZone: this.timeZone });
    const collisions = placementCollisions(result.occurrences, start, end, allDay, this.collisionPolicy, occurrence?.occurrenceId);
    if (!collisions.length) return true;
    const names = [...new Set(collisions.map(row => row.occurrence.title))];
    const summary = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
    if (this.collisionPolicy.mode === "prevent") {
      this.announce(`${action} blocked because it overlaps ${summary}.`);
      return false;
    }
    const allowed = await confirmCalendarAction(this.host, "Scheduling conflict", `${action} overlaps ${summary}. Continue?`, "Continue");
    if (!allowed) this.announce(`${action} cancelled because of an overlap.`);
    return allowed;
  }

  private async keyboardTransformOccurrence(occurrence: CalendarOccurrence, key: string, resize: boolean): Promise<void> {
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
        nextStart = minuteDelta(start, minutes);
        nextEnd = minuteDelta(end, minutes);
      }
      if (!await this.allowPlacement(nextStart, nextEnd, allDay, occurrence, "move")) return;
      if (allDay) await this.issueOccurrencePatch(occurrence, placementTimePatch(nextStart, nextEnd, true, this.timeZone), "Move");
      else await this.issueTimedCommand({ type: "move-occurrence", occurrence, start: nextStart.toISOString(), end: nextEnd.toISOString(), scope: "this" }, "Move");
      this.announce(`${occurrence.title} moved to ${allDay ? new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "long", timeZone: this.timeZone }).format(nextStart) : formatDateTime(nextStart, this.locale, this.timeZone)}.`);
      return;
    }

    if (allDay) {
      const days = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
      nextEnd = addDays(end, days, this.timeZone);
      if (nextEnd.getTime() <= start.getTime()) nextEnd = addDays(start, 1, this.timeZone);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      nextEnd = addDays(end, key === "ArrowLeft" ? -1 : 1, this.timeZone);
      if (nextEnd.getTime() <= start.getTime()) nextEnd = minuteDelta(start, step);
    } else {
      nextEnd = minuteDelta(end, key === "ArrowUp" ? -step : step);
      if (nextEnd.getTime() <= start.getTime()) nextEnd = minuteDelta(start, step);
    }
    if (!await this.allowPlacement(start, nextEnd, allDay, occurrence, "resize")) return;
    if (allDay) await this.issueOccurrencePatch(occurrence, placementTimePatch(start, nextEnd, true, this.timeZone), "Resize");
    else await this.issueTimedCommand({ type: "resize-occurrence", occurrence, start: start.toISOString(), end: nextEnd.toISOString(), scope: "this" }, "Resize");
    this.announce(`${occurrence.title} now ends ${allDay ? new Intl.DateTimeFormat(this.locale, { day: "numeric", month: "long", timeZone: this.timeZone }).format(new Date(nextEnd.getTime() - 1)) : formatDateTime(nextEnd, this.locale, this.timeZone)}.`);
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
        void this.refresh();
      });
      const mark = el("span", "dc-source-dot", source.display?.icon ?? "");
      mark.setAttribute("aria-hidden", "true");
      row.append(check, mark, el("span", undefined, source.title));
      menu.append(row);
    }
    for (const action of (this.options.addons ?? []).flatMap(addon => addon.sourceMenuActions?.(this.addonContext()) ?? [])) {
      const item = el("button", `dc-menu-item${action.danger ? " dc-danger" : ""}`, action.label);
      item.type = "button";
      item.addEventListener("click", () => { menu.remove(); void action.run(); });
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
    add("Open", () => void this.openDetails(occurrence));
    for (const action of this.options.sourceActions?.actions(occurrence) ?? []) add(action.label, () => void this.executeSourceAction(action.id, occurrence));
    if (this.canEditOccurrence(occurrence)) add("Edit", () => void this.editOccurrence(occurrence));
    if (this.canDuplicateOccurrence()) add("Duplicate", () => void this.duplicateOccurrence(occurrence));
    for (const action of (this.options.addons ?? []).flatMap(addon => addon.contextActions?.(occurrence, this.addonContext()) ?? [])) add(action.label, () => void action.run(), Boolean(action.danger));
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
    if (event.key === "Escape" && this.drag) {
      event.preventDefault();
      this.cancelActiveDrag();
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
    const answer = await requestCalendarDate(this.host, "Jump to date", dateKey(this.anchor, this.timeZone), "Go");
    if (!answer) return;
    this.goTo(toDate(answer, this.timeZone));
    this.announce(`Calendar moved to ${answer}.`);
  }

  private async executeSourceAction(actionId: string, occurrence: CalendarOccurrence): Promise<void> {
    const port = this.options.sourceActions;
    if (!port) return;
    try {
      await port.execute(actionId, occurrence);
      this.announce(`${occurrence.title}: action completed.`);
      await this.refresh();
    } catch (error) {
      this.announce(error instanceof Error ? error.message : "Source action could not be completed.");
    }
  }

  private occurrencePresentation(occurrence: CalendarOccurrence): { readonly classNames: readonly string[]; readonly data: Readonly<Record<string, string>>; readonly agendaMeta: readonly string[]; readonly agendaOrder: number; readonly detailRows: readonly { readonly label: string; readonly value: string }[] } {
    const classNames: string[] = [];
    const data: Record<string, string> = {};
    const agendaMeta: string[] = [];
    const detailRows: Array<{ readonly label: string; readonly value: string }> = [];
    let agendaOrder = 0;
    for (const extension of this.options.extensions ?? []) {
      const presentation = extension.presentOccurrence?.(occurrence);
      if (!presentation) continue;
      if (presentation.classNames) classNames.push(...presentation.classNames);
      if (presentation.data) Object.assign(data, presentation.data);
      if (presentation.agendaMeta) agendaMeta.push(presentation.agendaMeta);
      if (presentation.detailRows) detailRows.push(...presentation.detailRows);
      if (presentation.agendaOrder !== undefined) agendaOrder += presentation.agendaOrder;
    }
    return { classNames, data, agendaMeta, agendaOrder, detailRows };
  }

  private applyOccurrencePresentation(element: HTMLElement, occurrence: CalendarOccurrence): void {
    const sourceDisplay = this.sources.find(source => source.id === occurrence.calendarId)?.display;
    const display = { ...(sourceDisplay ?? {}), ...(occurrence.display ?? {}) };
    if (display.color) element.style.setProperty("--dc-event-bg", display.color);
    if (display.textColor) element.style.setProperty("--dc-event-fg", display.textColor);
    for (const token of display.className?.split(/\s+/u).filter(Boolean) ?? []) {
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(token)) element.classList.add(token);
    }
    const presentation = this.occurrencePresentation(occurrence);
    for (const token of presentation.classNames) if (/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(token)) element.classList.add(token);
    for (const [key, value] of Object.entries(presentation.data)) element.dataset[key] = value;
  }

  private addonEmptyMessage(): string | undefined {
    const context = this.addonContext();
    for (const addon of this.options.addons ?? []) {
      const message = addon.emptyMessage?.(context);
      if (message) return message;
    }
    return undefined;
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
      refresh: () => self.refresh(),
      announce: message => self.announce(message),
      createSource: async source => { await self.engine.createSource(source); },
      createDraft: async (draft, purpose, original) => {
        const item = self.createCalendarItem(draft, purpose, original);
        if (!await self.allowPlacement(self.resolveDraftTime(item.start, item.temporal), self.resolveDraftTime(item.end, item.temporal), Boolean(item.allDay), undefined, String(purpose))) return null;
        await self.dispatch({ type: "create", item });
        return item;
      },
      canPlaceDraft: async (draft, original, action = "create") => self.allowPlacement(
        self.resolveDraftTime(draft.start, draft.temporal), self.resolveDraftTime(draft.end, draft.temporal), Boolean(draft.allDay), original, action,
      ),
      patchOccurrence: async (occurrence, patch, label = "Edit") => {
        const temporal = patch.temporal === null ? undefined : patch.temporal ?? occurrence.temporal;
        const start = self.resolveDraftTime(patch.start ?? occurrence.start, temporal);
        const end = self.resolveDraftTime(patch.end ?? occurrence.end, temporal);
        if (!await self.allowPlacement(start, end, Boolean(patch.allDay ?? occurrence.allDay), occurrence, label.toLocaleLowerCase())) return false;
        await self.issueOccurrencePatch(occurrence, patch, label);
        return true;
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

