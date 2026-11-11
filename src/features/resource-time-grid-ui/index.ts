import type {
  CalendarOccurrence,
  CalendarOverlapDisambiguation,
  CalendarRange,
  CalendarSnapPolicy,
} from "../../core/types.js";
import {
  moveOccurrenceByCivilMinutes,
  normalizeSnapPolicy,
  resizeOccurrenceByCivilMinutes,
  snapMinuteCoordinate,
} from "../../core/interaction.js";
import { layoutTimedDay } from "../../core/layout.js";
import {
  CalendarPointerGestureController,
  type CalendarPointerGestureData,
  type CalendarPointerGestureMove,
  type CalendarPointerGestureSession,
} from "../../view/pointer-gesture.js";
import type { CalendarUiExtension } from "../../view/types.js";
import { hostDataAttributeName, isSafeHostClassName, resolveOccurrencePresentation } from "../../view/presentation.js";
import {
  executeCalendarResourceInteraction,
  replaceCalendarResourceAssignment,
  type CalendarResource,
  type CalendarResourceAssignment,
  type CalendarResourceId,
  type CalendarResourceInteractionCandidate,
  type CalendarResourceInteractionExecutionOptions,
  type CalendarResourcePlacementExecutionResult,
  type CalendarResourcePlacementRequest,
} from "../resource-scheduler/index.js";
import type { CalendarResourceAvailabilityRange } from "../resource-availability.js";
import {
  layoutResourceTimeGrid,
  type CalendarResourceTimeGridColumn,
  type CalendarResourceTimeGridLayout,
  type CalendarResourceTimeGridLayoutItem,
  type CalendarResourceTimeGridAllDayItem,
} from "../resource-time-grid/index.js";
import { RESOURCE_TIME_GRID_CSS } from "./styles.js";
import {
  element,
  renderResourceTimeGridSurface,
} from "./rendering.js";

let resourceTimeGridSequence = 0;
type InteractionMode = "move" | "resize-start" | "resize-end";

interface GestureData extends CalendarPointerGestureData {
  readonly node: HTMLElement;
  readonly item: CalendarResourceTimeGridLayoutItem;
  readonly assignment: CalendarResourceAssignment;
  readonly mode: InteractionMode;
  readonly touch: boolean;
}

interface DragState {
  readonly node: HTMLElement;
  readonly item: CalendarResourceTimeGridLayoutItem;
  readonly assignment: CalendarResourceAssignment;
  readonly mode: InteractionMode;
  readonly ghost: HTMLElement;
  moved: boolean;
  candidate?: CalendarResourceInteractionCandidate | undefined;
  targetColumn?: CalendarResourceTimeGridColumn | undefined;
}

export interface CalendarResourceTimeGridProjection {
  readonly resources: readonly CalendarResource[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly assignments: readonly CalendarResourceAssignment[];
  readonly range: CalendarRange;
  readonly availability?: readonly CalendarResourceAvailabilityRange[] | undefined;
}

export interface CalendarResourceTimeGridInteractionOptions
  extends CalendarResourceInteractionExecutionOptions {
  readonly slotMinutes?: number | undefined;
  readonly snapPolicy?: CalendarSnapPolicy | undefined;
  readonly minimumDurationMinutes?: number | undefined;
  readonly dstOverlapDisambiguation?: CalendarOverlapDisambiguation | undefined;
  readonly longPressMs?: number | undefined;
  readonly autoScrollEdgePx?: number | undefined;
  readonly autoScrollMaxPxPerFrame?: number | undefined;
  readonly refreshProjection?: (() =>
    | CalendarResourceTimeGridProjection
    | void
    | Promise<CalendarResourceTimeGridProjection | void>) | undefined;
  readonly onResult?: ((
    result: CalendarResourcePlacementExecutionResult,
    request: CalendarResourcePlacementRequest,
  ) => void) | undefined;
}

export interface CalendarResourceTimeGridUiOptions {
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly pixelsPerMinute?: number | undefined;
  readonly minColumnWidth?: number | undefined;
  readonly dayStartHour?: number | undefined;
  readonly dayEndHour?: number | undefined;
  readonly axisTickMinutes?: number | undefined;
  readonly occurrenceExtensions?: readonly CalendarUiExtension[] | undefined;
  readonly onOccurrenceActivate?: ((occurrence: CalendarOccurrence, resource: CalendarResource) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly interaction?: CalendarResourceTimeGridInteractionOptions | undefined;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RangeError(`${label} must be positive and finite`);
  return resolved;
}

function hour(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 24) throw new RangeError(`${label} must be an integer from 0 to 24`);
  return resolved;
}

function safeClassTokens(value: string | undefined): readonly string[] {
  return value?.split(/\s+/u).filter(isSafeHostClassName) ?? [];
}

export class CalendarResourceTimeGridUi {
  private readonly root: HTMLElement;
  private readonly locale: string;
  private readonly timeZone: string;
  private readonly ariaLabel: string;
  private readonly pixelsPerMinute: number;
  private readonly minColumnWidth: number;
  private readonly dayStartHour: number;
  private readonly dayEndHour: number;
  private readonly axisTickMinutes: number;
  private readonly extensions: readonly CalendarUiExtension[];
  private readonly onOccurrenceActivate: CalendarResourceTimeGridUiOptions["onOccurrenceActivate"];
  private readonly onError: CalendarResourceTimeGridUiOptions["onError"];
  private readonly interaction: CalendarResourceTimeGridInteractionOptions | undefined;
  private readonly slotMinutes: number;
  private readonly snapPolicy: Required<CalendarSnapPolicy>;
  private readonly helpId: string;
  private readonly status: HTMLElement;
  private readonly pointer: CalendarPointerGestureController<GestureData>;
  private readonly pending = new Set<string>();
  private projection?: CalendarResourceTimeGridProjection | undefined;
  private layout?: CalendarResourceTimeGridLayout | undefined;
  private drag?: DragState | undefined;

  public constructor(
    private readonly host: HTMLElement,
    options: CalendarResourceTimeGridUiOptions = {},
  ) {
    if (!host || typeof host.replaceChildren !== "function") throw new TypeError("Resource TimeGrid UI requires a host element");
    this.locale = options.locale ?? "en-US";
    this.timeZone = options.timeZone ?? "UTC";
    this.ariaLabel = options.ariaLabel ?? "Resource time grid";
    this.pixelsPerMinute = positive(options.pixelsPerMinute, 1, "pixelsPerMinute");
    this.minColumnWidth = positive(options.minColumnWidth, 150, "minColumnWidth");
    this.dayStartHour = hour(options.dayStartHour, 0, "dayStartHour");
    this.dayEndHour = hour(options.dayEndHour, 24, "dayEndHour");
    if (this.dayEndHour <= this.dayStartHour) throw new RangeError("dayEndHour must be greater than dayStartHour");
    this.axisTickMinutes = positive(options.axisTickMinutes, 60, "axisTickMinutes");
    this.extensions = options.occurrenceExtensions ?? [];
    this.onOccurrenceActivate = options.onOccurrenceActivate;
    this.onError = options.onError;
    this.interaction = options.interaction;
    this.slotMinutes = this.interaction?.slotMinutes ?? 15;
    this.snapPolicy = normalizeSnapPolicy(this.interaction?.snapPolicy, this.slotMinutes);
    if (this.interaction) positive(this.interaction.minimumDurationMinutes, 5, "interaction.minimumDurationMinutes");
    if (this.interaction?.dstOverlapDisambiguation !== undefined
      && !["earlier", "later"].includes(this.interaction.dstOverlapDisambiguation)) {
      throw new Error("interaction.dstOverlapDisambiguation must be earlier or later");
    }
    new Intl.DateTimeFormat(this.locale, { timeZone: this.timeZone }).format(new Date(0));

    this.helpId = `dc-rtg-help-${++resourceTimeGridSequence}`;
    const style = element("style");
    style.textContent = RESOURCE_TIME_GRID_CSS;
    this.root = element("div", "dc-rtg-root");
    this.root.setAttribute("aria-label", this.ariaLabel);
    this.status = element("div", "dc-rtg-sr-only");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("aria-atomic", "true");
    this.pointer = new CalendarPointerGestureController<GestureData>({
      scrollElement: () => this.root.querySelector<HTMLElement>(".dc-rtg-scroll") ?? undefined,
      longPressMs: Math.max(250, this.interaction?.longPressMs ?? 420),
      autoScrollEdgePx: Math.max(20, this.interaction?.autoScrollEdgePx ?? 32),
      autoScrollMaxPxPerFrame: Math.max(2, this.interaction?.autoScrollMaxPxPerFrame ?? 18),
      onArmingChange: (data, active) => data.node.classList.toggle("is-touch-arming", active),
      onActivate: session => this.activateGesture(session),
      onMove: (_session, move) => this.moveGesture(move),
      onFinish: async () => await this.finishGesture(),
      onCancel: () => this.cleanupDrag(),
    });
    this.root.replaceChildren(this.emptyState(), this.status);
    this.host.replaceChildren(style, this.root);
  }

  public setProjection(projection: CalendarResourceTimeGridProjection): void {
    this.pointer.cancel();
    const stable: CalendarResourceTimeGridProjection = {
      resources: [...projection.resources],
      occurrences: [...projection.occurrences],
      assignments: [...projection.assignments],
      range: { start: projection.range.start, end: projection.range.end },
      ...(projection.availability === undefined ? {} : { availability: [...projection.availability] }),
    };
    const rendered = this.renderProjection(stable);
    this.projection = stable;
    this.replaceSurface(rendered);
  }

  public refresh(): void {
    this.pointer.cancel();
    if (!this.projection) {
      this.layout = undefined;
      this.replaceSurface(this.emptyState());
      return;
    }
    this.replaceSurface(this.renderProjection(this.projection));
  }

  public destroy(): void {
    this.pointer.destroy();
    this.projection = undefined;
    this.layout = undefined;
    this.pending.clear();
    this.host.replaceChildren();
  }

  private emptyState(): HTMLElement {
    const empty = element("div", "dc-rtg-empty", "No resource time grid data.");
    empty.setAttribute("role", "status");
    return empty;
  }

  private replaceSurface(surface: HTMLElement): void {
    const current = this.root.querySelector<HTMLElement>(".dc-rtg-scroll");
    const left = current?.scrollLeft ?? 0;
    const top = current?.scrollTop ?? 0;
    this.root.replaceChildren(surface, this.status);
    const next = surface.matches(".dc-rtg-scroll") ? surface : surface.querySelector<HTMLElement>(".dc-rtg-scroll");
    if (next) {
      next.scrollLeft = left;
      next.scrollTop = top;
    }
  }

  private renderProjection(projection: CalendarResourceTimeGridProjection): HTMLElement {
    this.prepareExtensions(projection);
    const layout = layoutResourceTimeGrid(
      projection.resources,
      projection.occurrences,
      projection.assignments,
      projection.range,
      {
        timeZone: this.timeZone,
        startMinute: this.dayStartHour * 60,
        endMinute: this.dayEndHour * 60,
        ...(projection.availability === undefined ? {} : { availability: projection.availability }),
      },
    );
    this.layout = layout;
    return renderResourceTimeGridSurface({
      layout,
      locale: this.locale,
      timeZone: this.timeZone,
      ariaLabel: this.ariaLabel,
      pixelsPerMinute: this.pixelsPerMinute,
      minColumnWidth: this.minColumnWidth,
      axisTickMinutes: this.axisTickMinutes,
      ...(this.interaction ? { interactionHelpId: this.helpId } : {}),
    }, {
      renderTimed: item => this.timedElement(item),
      renderAllDay: item => this.allDayElement(item),
    });
  }

  private timedElement(item: CalendarResourceTimeGridLayoutItem): HTMLElement {
    const occurrence = item.occurrence;
    const presentation = resolveOccurrencePresentation(
      this.extensions,
      occurrence,
      (index, error) => this.reportError({ stage: "present", index, error }),
    );
    const node = element("div", "dc-rtg-event");
    node.tabIndex = 0;
    node.setAttribute("role", this.onOccurrenceActivate ? "button" : "group");
    node.dataset.renderId = item.renderId;
    node.dataset.occurrenceId = occurrence.occurrenceId;
    node.dataset.resourceId = item.resourceId;
    node.dataset.columnIndex = String(item.columnIndex);
    node.dataset.dayIndex = String(item.dayIndex);
    node.classList.toggle("is-point", item.temporalForm === "point");
    node.classList.toggle("is-activatable", Boolean(this.onOccurrenceActivate));
    if (this.interaction) {
      node.classList.add("is-interactive");
      node.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight");
    }
    if (this.pending.has(occurrence.occurrenceId)) {
      node.classList.add("is-pending");
      node.setAttribute("aria-busy", "true");
    }
    if (occurrence.display?.color) node.style.setProperty("--dc-rtg-event-bg", occurrence.display.color);
    if (occurrence.display?.textColor) node.style.setProperty("--dc-rtg-event-fg", occurrence.display.textColor);
    for (const token of safeClassTokens(occurrence.display?.className)) node.classList.add(token);
    for (const token of presentation.classNames) node.classList.add(token);
    for (const [key, value] of Object.entries(presentation.data)) {
      node.setAttribute(`data-host-${hostDataAttributeName(key)}`, value);
    }

    const top = (item.topMinutes - (this.dayStartHour * 60)) * this.pixelsPerMinute;
    const height = item.temporalForm === "point"
      ? 10
      : Math.max(18, item.heightMinutes * this.pixelsPerMinute);
    const baseWidth = 100 / item.columnCount;
    const baseLeft = item.column * baseWidth;
    const spanWidth = item.columnSpan * baseWidth;
    const visualLeft = baseLeft + (spanWidth * item.visualLane) / item.visualLaneCount;
    const visualRight = baseLeft + (spanWidth * (item.visualLane + 1)) / item.visualLaneCount;
    node.style.top = `${top}px`;
    node.style.height = `${height}px`;
    node.style.left = `calc(${visualLeft}% + 2px)`;
    node.style.right = `calc(${100 - visualRight}% + 2px)`;
    node.setAttribute("aria-label", presentation.accessibleLabel ?? this.accessibleLabel(occurrence, item.resource));
    node.append(this.occurrenceContent(occurrence, presentation));

    if (this.interaction) {
      node.addEventListener("pointerdown", event => {
        if ((event.target as Element).closest(".dc-rtg-resize-handle")) return;
        this.beginGesture(event, node, item, "move");
      });
      if (item.temporalForm !== "point" && item.startsInDay) node.append(this.resizeHandle(node, item, "start"));
      if (item.temporalForm !== "point" && item.endsInDay) node.append(this.resizeHandle(node, item, "end"));
    }
    node.addEventListener("keydown", event => this.onEventKeyDown(event, node, item));
    node.addEventListener("click", () => {
      if (this.pointer.shouldSuppressClick() || !this.onOccurrenceActivate) return;
      try { this.onOccurrenceActivate(occurrence, item.resource); } catch (error) { this.reportError(error); }
    });
    return node;
  }

  private allDayElement(item: CalendarResourceTimeGridAllDayItem): HTMLElement {
    const presentation = resolveOccurrencePresentation(
      this.extensions,
      item.occurrence,
      (index, error) => this.reportError({ stage: "present", index, error }),
    );
    const node = element("div", "dc-rtg-all-day-event", presentation.title?.text ?? item.occurrence.title);
    node.tabIndex = this.onOccurrenceActivate ? 0 : -1;
    node.dataset.occurrenceId = item.occurrenceId;
    node.dataset.resourceId = item.resourceId;
    if (item.occurrence.display?.color) node.style.setProperty("--dc-rtg-event-bg", item.occurrence.display.color);
    if (item.occurrence.display?.textColor) node.style.setProperty("--dc-rtg-event-fg", item.occurrence.display.textColor);
    for (const token of safeClassTokens(item.occurrence.display?.className)) node.classList.add(token);
    for (const token of presentation.classNames) node.classList.add(token);
    for (const [key, value] of Object.entries(presentation.data)) {
      node.setAttribute(`data-host-${hostDataAttributeName(key)}`, value);
    }
    node.setAttribute(
      "aria-label",
      presentation.accessibleLabel ?? `${item.occurrence.title}, all-day, ${item.resource.title}, ${item.dayKey}`,
    );
    if (this.onOccurrenceActivate) {
      node.setAttribute("role", "button");
      node.addEventListener("click", () => {
        try { this.onOccurrenceActivate?.(item.occurrence, item.resource); } catch (error) { this.reportError(error); }
      });
      node.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        try { this.onOccurrenceActivate?.(item.occurrence, item.resource); } catch (error) { this.reportError(error); }
      });
    }
    return node;
  }

  private resizeHandle(
    node: HTMLElement,
    item: CalendarResourceTimeGridLayoutItem,
    edge: "start" | "end",
  ): HTMLElement {
    const handle = element("div", "dc-rtg-resize-handle");
    handle.dataset.edge = edge;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", `Resize ${edge} of ${item.occurrence.title}`);
    handle.addEventListener("pointerdown", event => this.beginGesture(event, node, item, edge === "start" ? "resize-start" : "resize-end"));
    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      event.stopPropagation();
      const delta = (event.key === "ArrowDown" ? 1 : -1) * this.snapPolicy.keyboardStepMinutes;
      void this.keyboardResize(node, item, edge, delta);
    });
    return handle;
  }

  private beginGesture(
    event: PointerEvent,
    node: HTMLElement,
    item: CalendarResourceTimeGridLayoutItem,
    mode: InteractionMode,
  ): void {
    if (!this.interaction || event.button !== 0 || this.pending.has(item.occurrenceId)) return;
    const assignment = this.assignmentFor(item.occurrenceId);
    if (!assignment || !assignment.resourceIds.includes(item.resourceId)) return;
    this.pointer.begin(event, {
      element: node,
      node,
      item,
      assignment,
      mode,
      touch: event.pointerType === "touch",
    });
  }

  private activateGesture(session: CalendarPointerGestureSession<GestureData>): void {
    const { node, item, assignment, mode, touch } = session.data;
    const rect = node.getBoundingClientRect();
    const ghost = element("div", "dc-rtg-drag-ghost", item.occurrence.title);
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${Math.max(20, rect.width)}px`;
    ghost.style.height = `${Math.max(18, rect.height)}px`;
    ghost.hidden = true;
    this.root.append(ghost);
    node.classList.add("is-drag-source");
    node.focus({ preventScroll: true });
    this.drag = { node, item, assignment, mode, ghost, moved: false };
    if (touch) this.announce(`${mode === "move" ? "Moving" : "Resizing"} ${item.occurrence.title}. Drag, then release.`);
  }

  private moveGesture(move: CalendarPointerGestureMove): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved && Math.hypot(move.deltaX, move.deltaY) < 1) return;
    drag.moved = true;
    drag.ghost.hidden = false;
    const strategy = drag.mode === "move" ? this.snapPolicy.move : this.snapPolicy.resize;
    const verticalMinutes = snapMinuteCoordinate(move.deltaY / this.pixelsPerMinute, this.slotMinutes, strategy);
    const target = drag.mode === "move" ? (this.columnAt(move.clientX, move.clientY) ?? this.columnFor(drag.item.columnIndex)) : this.columnFor(drag.item.columnIndex);
    const candidate = target ? this.interactionCandidate(drag, verticalMinutes, target) : undefined;
    drag.targetColumn = target;
    drag.candidate = candidate;
    this.updateDragPreview(drag, candidate, target);
  }

  private interactionCandidate(
    drag: DragState,
    verticalMinutes: number,
    target: CalendarResourceTimeGridColumn,
  ): CalendarResourceInteractionCandidate | undefined {
    let times;
    if (drag.mode === "move") {
      const dayDelta = target.dayIndex - drag.item.dayIndex;
      times = moveOccurrenceByCivilMinutes(
        drag.item.occurrence,
        dayDelta * 1440 + verticalMinutes,
        this.timeZone,
        this.overlapDisambiguation(),
      );
    } else {
      times = resizeOccurrenceByCivilMinutes(
        drag.item.occurrence,
        drag.mode === "resize-start" ? "start" : "end",
        verticalMinutes,
        this.minimumDurationMinutes(),
        this.timeZone,
        this.overlapDisambiguation(),
      );
    }
    if (!times) return undefined;
    let toResourceIds = drag.assignment.resourceIds;
    if (drag.mode === "move" && target.resourceId !== drag.item.resourceId) {
      toResourceIds = replaceCalendarResourceAssignment(
        drag.assignment.resourceIds,
        drag.item.resourceId,
        target.resourceId,
      );
    }
    return {
      ...times,
      targetResourceId: drag.mode === "move" ? target.resourceId : drag.item.resourceId,
      toResourceIds,
    };
  }

  private updateDragPreview(
    drag: DragState,
    candidate: CalendarResourceInteractionCandidate | undefined,
    target: CalendarResourceTimeGridColumn | undefined,
  ): void {
    drag.ghost.classList.toggle("is-invalid", !candidate);
    for (const column of this.root.querySelectorAll<HTMLElement>(".dc-rtg-time-column")) {
      column.classList.toggle("is-drop-target", Boolean(
        drag.mode === "move" && candidate && target && Number(column.dataset.columnIndex) === target.columnIndex,
      ));
    }
    if (!candidate || !target) return;
    const cell = this.root.querySelector<HTMLElement>(`.dc-rtg-time-column[data-column-index="${target.columnIndex}"]`);
    if (!cell) return;
    const preview = { ...drag.item.occurrence, start: candidate.start, end: candidate.end };
    const geometry = layoutTimedDay([preview], target.day, this.timeZone)[0];
    if (!geometry) return;
    const rect = cell.getBoundingClientRect();
    const top = Math.max(0, (geometry.topMinutes - this.dayStartHour * 60) * this.pixelsPerMinute);
    const height = geometry.temporalForm === "point" ? 10 : Math.max(18, geometry.heightMinutes * this.pixelsPerMinute);
    drag.ghost.style.left = `${rect.left + 3}px`;
    drag.ghost.style.top = `${rect.top + top}px`;
    drag.ghost.style.width = `${Math.max(20, rect.width - 6)}px`;
    drag.ghost.style.height = `${height}px`;
    drag.ghost.textContent = target.resourceId === drag.item.resourceId
      ? drag.item.occurrence.title
      : `${drag.item.occurrence.title} · ${target.resource.title}`;
  }

  private async finishGesture(): Promise<void> {
    const drag = this.drag;
    const candidate = drag?.candidate;
    const moved = drag?.moved === true;
    if (drag) this.cleanupDrag();
    if (!drag || !moved) return;
    drag.node.dataset.suppressActivation = "true";
    if (!candidate) {
      this.announce("That placement cannot be targeted.");
      return;
    }
    await this.submitCandidate(drag.node, drag.item, drag.assignment, drag.mode, candidate);
  }

  private cleanupDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;
    drag.node.classList.remove("is-drag-source");
    drag.ghost.remove();
    for (const column of this.root.querySelectorAll<HTMLElement>(".dc-rtg-time-column")) column.classList.remove("is-drop-target");
  }

  private onEventKeyDown(
    event: KeyboardEvent,
    node: HTMLElement,
    item: CalendarResourceTimeGridLayoutItem,
  ): void {
    if (this.interaction && event.altKey && ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const delta = (event.key === "ArrowDown" ? 1 : -1) * this.snapPolicy.keyboardStepMinutes;
        void this.keyboardMove(node, item, delta, 0);
      } else {
        void this.keyboardMove(node, item, 0, event.key === "ArrowRight" ? 1 : -1);
      }
      return;
    }
    if (this.onOccurrenceActivate && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      try { this.onOccurrenceActivate(item.occurrence, item.resource); } catch (error) { this.reportError(error); }
      return;
    }
    if (!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
    const nodes = [...this.root.querySelectorAll<HTMLElement>(".dc-rtg-event")];
    const column = Number(node.dataset.columnIndex);
    const top = Number.parseFloat(node.style.top) || 0;
    let target: HTMLElement | undefined;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const inColumn = nodes.filter(candidate => Number(candidate.dataset.columnIndex) === column)
        .sort((a,b)=>(Number.parseFloat(a.style.top)||0)-(Number.parseFloat(b.style.top)||0));
      const index = inColumn.indexOf(node);
      target = inColumn[index + (event.key === "ArrowDown" ? 1 : -1)];
    } else if (event.key === "Home" || event.key === "End") {
      const inColumn = nodes.filter(candidate => Number(candidate.dataset.columnIndex) === column)
        .sort((a,b)=>(Number.parseFloat(a.style.top)||0)-(Number.parseFloat(b.style.top)||0));
      target = event.key === "Home" ? inColumn[0] : inColumn.at(-1);
    } else {
      const targetColumn = column + (event.key === "ArrowRight" ? 1 : -1);
      target = nodes.filter(candidate => Number(candidate.dataset.columnIndex) === targetColumn)
        .sort((a,b)=>Math.abs((Number.parseFloat(a.style.top)||0)-top)-Math.abs((Number.parseFloat(b.style.top)||0)-top))[0];
    }
    if (target) {
      event.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private async keyboardMove(
    node: HTMLElement,
    item: CalendarResourceTimeGridLayoutItem,
    deltaMinutes: number,
    columnDirection: -1 | 0 | 1,
  ): Promise<void> {
    const assignment = this.assignmentFor(item.occurrenceId);
    if (!assignment || !this.layout) return;
    const target = this.columnFor(item.columnIndex + columnDirection);
    if (!target) return;
    const dayDelta = target.dayIndex - item.dayIndex;
    const times = moveOccurrenceByCivilMinutes(
      item.occurrence,
      dayDelta * 1440 + deltaMinutes,
      this.timeZone,
      this.overlapDisambiguation(),
    );
    if (!times) {
      this.announce("That wall-clock time does not exist.");
      return;
    }
    const toResourceIds = target.resourceId === item.resourceId
      ? assignment.resourceIds
      : replaceCalendarResourceAssignment(assignment.resourceIds, item.resourceId, target.resourceId);
    await this.submitCandidate(node, item, assignment, "move", {
      ...times,
      targetResourceId: target.resourceId,
      toResourceIds,
    });
  }

  private async keyboardResize(
    node: HTMLElement,
    item: CalendarResourceTimeGridLayoutItem,
    edge: "start" | "end",
    deltaMinutes: number,
  ): Promise<void> {
    const assignment = this.assignmentFor(item.occurrenceId);
    if (!assignment) return;
    const times = resizeOccurrenceByCivilMinutes(
      item.occurrence,
      edge,
      deltaMinutes,
      this.minimumDurationMinutes(),
      this.timeZone,
      this.overlapDisambiguation(),
    );
    if (!times) {
      this.announce("That resize target is not available.");
      return;
    }
    await this.submitCandidate(node, item, assignment, edge === "start" ? "resize-start" : "resize-end", {
      ...times,
      targetResourceId: item.resourceId,
      toResourceIds: assignment.resourceIds,
    });
  }

  private async submitCandidate(
    node: HTMLElement,
    item: CalendarResourceTimeGridLayoutItem,
    assignment: CalendarResourceAssignment,
    mode: InteractionMode,
    candidate: CalendarResourceInteractionCandidate,
  ): Promise<void> {
    const interaction = this.interaction;
    const projection = this.projection;
    if (!interaction || !projection || this.pending.has(item.occurrenceId)) return;
    this.setPending(item.occurrenceId, true);
    try {
      const execution = await executeCalendarResourceInteraction(
        projection.resources,
        item.occurrence,
        item.resourceId,
        assignment,
        mode,
        candidate,
        this.timeZone,
        interaction,
      );
      if (execution.status === "cancelled" || !execution.result || !execution.request) return;
      try { interaction.onResult?.(execution.result, execution.request); } catch (error) { this.reportError(error); }
      this.announce(this.resultAnnouncement(execution.result, item.occurrence));
      if (execution.result.status === "committed" || execution.result.status === "stale") {
        try {
          const refreshed = await interaction.refreshProjection?.();
          if (refreshed) this.setProjection(refreshed);
        } catch (error) {
          this.reportError(error);
          if (execution.result.status === "committed") {
            this.announce(`${item.occurrence.title} changed, but authoritative refresh failed.`);
          }
        }
      }
    } catch (error) {
      this.reportError(error);
      this.announce(`${item.occurrence.title} was not changed.`);
    } finally {
      this.setPending(item.occurrenceId, false);
      if (node.isConnected) node.focus();
      else this.focusOccurrence(item.occurrenceId, candidate.targetResourceId);
    }
  }

  private assignmentFor(occurrenceId: string): CalendarResourceAssignment | undefined {
    return this.projection?.assignments.find(assignment => assignment.occurrenceId === occurrenceId);
  }

  private columnFor(columnIndex: number): CalendarResourceTimeGridColumn | undefined {
    return this.layout?.columns.find(column => column.columnIndex === columnIndex);
  }

  private columnAt(clientX: number, clientY: number): CalendarResourceTimeGridColumn | undefined {
    const node = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".dc-rtg-time-column");
    if (!node || !this.root.contains(node)) return undefined;
    return this.columnFor(Number(node.dataset.columnIndex));
  }

  private minimumDurationMinutes(): number {
    return positive(this.interaction?.minimumDurationMinutes, 5, "interaction.minimumDurationMinutes");
  }

  private overlapDisambiguation(): CalendarOverlapDisambiguation {
    return this.interaction?.dstOverlapDisambiguation ?? "earlier";
  }

  private setPending(occurrenceId: string, pending: boolean): void {
    if (pending) this.pending.add(occurrenceId);
    else this.pending.delete(occurrenceId);
    for (const node of this.root.querySelectorAll<HTMLElement>(".dc-rtg-event")) {
      if (node.dataset.occurrenceId !== occurrenceId) continue;
      node.classList.toggle("is-pending", pending);
      if (pending) node.setAttribute("aria-busy", "true");
      else node.removeAttribute("aria-busy");
    }
  }

  private focusOccurrence(occurrenceId: string, resourceId?: CalendarResourceId): void {
    const nodes = [...this.root.querySelectorAll<HTMLElement>(".dc-rtg-event")]
      .filter(node => node.dataset.occurrenceId === occurrenceId);
    const preferred = resourceId ? nodes.find(node => node.dataset.resourceId === resourceId) : undefined;
    (preferred ?? nodes[0])?.focus();
  }

  private occurrenceContent(
    occurrence: CalendarOccurrence,
    presentation: ReturnType<typeof resolveOccurrencePresentation>,
  ): HTMLElement {
    const content = element("span", "dc-rtg-event-content");
    const iconText = presentation.icon?.text ?? occurrence.display?.icon;
    if (iconText) content.append(element("span", "dc-rtg-event-icon", iconText));
    if (presentation.leading) content.append(element("span", "dc-rtg-event-leading", presentation.leading.text));
    content.append(element("span", "dc-rtg-event-title", presentation.title?.text ?? occurrence.title));
    if (presentation.subtitle) content.append(element("span", "dc-rtg-event-subtitle", presentation.subtitle.text));
    if (presentation.badges.length) {
      const badges = element("span", "dc-rtg-event-badges");
      for (const badge of presentation.badges) badges.append(element("span", "dc-rtg-event-badge", badge.label));
      content.append(badges);
    }
    if (presentation.trailing) content.append(element("span", "dc-rtg-event-trailing", presentation.trailing.text));
    return content;
  }

  private accessibleLabel(occurrence: CalendarOccurrence, resource: CalendarResource): string {
    const formatter = new Intl.DateTimeFormat(this.locale, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: this.timeZone,
    });
    const start = formatter.format(new Date(occurrence.start));
    if (occurrence.temporalForm === "point") return `${occurrence.title}, ${start}, ${resource.title}`;
    const end = formatter.format(new Date(occurrence.end));
    return `${occurrence.title}, ${start} to ${end}, ${resource.title}`;
  }

  private prepareExtensions(projection: CalendarResourceTimeGridProjection): void {
    for (const [index, extension] of this.extensions.entries()) {
      try {
        extension.prepare?.({
          occurrences: projection.occurrences,
          range: projection.range,
          timeZone: this.timeZone,
          now: new Date(),
        });
      } catch (error) {
        this.reportError({ stage: "prepare", index, error });
      }
    }
  }

  private resultAnnouncement(result: CalendarResourcePlacementExecutionResult, occurrence: CalendarOccurrence): string {
    if (result.status === "committed") return `${occurrence.title} changed.`;
    if (result.status === "stale") return `${occurrence.title} changed elsewhere; refreshing authoritative data.`;
    if (result.status === "warning" || result.status === "prevented") return result.evaluation.messages.join(" ");
    return `${occurrence.title} is already in that position.`;
  }

  private announce(message: string): void {
    this.status.textContent = "";
    queueMicrotask(() => { this.status.textContent = message; });
  }

  private reportError(error: unknown): void {
    try { this.onError?.(error); } catch { /* host diagnostics must not break the scheduling surface */ }
  }
}

export { RESOURCE_TIME_GRID_CSS } from "./styles.js";
