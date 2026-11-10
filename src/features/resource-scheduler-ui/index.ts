import type {
  CalendarOccurrence,
  CalendarOverlapDisambiguation,
  CalendarRange,
  CalendarSnapPolicy,
  CalendarSource,
  SeriesEditScope,
} from "../../core/types.js";
import { normalizeSnapPolicy, snapMinuteCoordinate } from "../../core/interaction.js";
import type { CalendarUiExtension } from "../../view/types.js";
import { isSafeHostClassName, resolveOccurrencePresentation } from "../../view/presentation.js";
import {
  executeCalendarResourcePlacement,
  flattenCalendarResources,
  layoutResourceTimeline,
  replaceCalendarResourceAssignment,
  type CalendarResource,
  type CalendarResourceAssignment,
  type CalendarResourceId,
  type CalendarResourceTimelineLayoutItem,
  type CalendarResourcePlacementExecutionOptions,
  type CalendarResourcePlacementExecutionResult,
  type CalendarResourcePlacementRequest,
} from "../resource-scheduler/index.js";
import { resolveResourceTimelineRangeGeometry } from "../resource-scheduler/timeline-layout.js";
import {
  moveResourceOccurrenceByCivilMinutes,
  resizeResourceOccurrenceByCivilMinutes,
} from "./interaction.js";
import { RESOURCE_SCHEDULER_CSS } from "./styles.js";

const MAX_AXIS_TICKS = 240;
const POINTER_MOVE_THRESHOLD = 4;
const AUTO_SCROLL_ZONE = 32;
const AUTO_SCROLL_STEP = 18;
let schedulerUiSequence = 0;

type CalendarResourceInteractionMode = "move" | "resize-start" | "resize-end";

interface CalendarResourceDragState {
  readonly mode: CalendarResourceInteractionMode;
  readonly pointerId: number;
  readonly node: HTMLElement;
  readonly occurrence: CalendarOccurrence;
  readonly sourceResourceId: CalendarResourceId;
  readonly assignment: CalendarResourceAssignment;
  readonly originalStart: string;
  readonly originalEnd: string;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly scrollStartLeft: number;
  readonly scrollStartTop: number;
  readonly scale: number;
  readonly ghost: HTMLElement;
  moved: boolean;
  candidate: CalendarResourceInteractionCandidate | undefined;
}

interface CalendarResourceInteractionCandidate {
  readonly start: string;
  readonly end: string;
  readonly targetResourceId: CalendarResourceId;
  readonly toResourceIds: readonly CalendarResourceId[];
  readonly valid: boolean;
}

export interface CalendarResourceSchedulerProjection {
  readonly resources: readonly CalendarResource[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly assignments: readonly CalendarResourceAssignment[];
  readonly range: CalendarRange;
}

export interface CalendarResourceSchedulerInteractionOptions
  extends Omit<CalendarResourcePlacementExecutionOptions, "source" | "acceptWarnings"> {
  /** Shared Calendar snap interval. Defaults to 15 minutes. */
  readonly slotMinutes?: number | undefined;
  /** Shared Calendar move/resize/keyboard snapping semantics. */
  readonly snapPolicy?: CalendarSnapPolicy | undefined;
  readonly minimumDurationMinutes?: number | undefined;
  readonly dstOverlapDisambiguation?: CalendarOverlapDisambiguation | undefined;
  readonly sourceForOccurrence?: ((occurrence: CalendarOccurrence) => CalendarSource | undefined) | undefined;
  readonly resolveScope?: ((
    occurrence: CalendarOccurrence,
    action: CalendarResourcePlacementRequest["action"],
  ) => SeriesEditScope | null | Promise<SeriesEditScope | null>) | undefined;
  readonly confirmWarnings?: ((
    messages: readonly string[],
    request: CalendarResourcePlacementRequest,
  ) => boolean | Promise<boolean>) | undefined;
  readonly refreshProjection?: (() =>
    | CalendarResourceSchedulerProjection
    | void
    | Promise<CalendarResourceSchedulerProjection | void>) | undefined;
  readonly onResult?: ((
    result: CalendarResourcePlacementExecutionResult,
    request: CalendarResourcePlacementRequest,
  ) => void) | undefined;
}

export interface CalendarResourceSchedulerUiOptions {
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly pixelsPerMinute?: number | undefined;
  readonly minTimelineWidth?: number | undefined;
  readonly baseRowHeight?: number | undefined;
  readonly eventHeight?: number | undefined;
  readonly axisTickMinutes?: number | undefined;
  readonly initialCollapsedResourceIds?: readonly CalendarResourceId[] | undefined;
  /** Only structured prepare/presentOccurrence hooks are consumed; CalendarUi itself is never mounted here. */
  readonly occurrenceExtensions?: readonly CalendarUiExtension[] | undefined;
  readonly onOccurrenceActivate?: ((occurrence: CalendarOccurrence, resource: CalendarResource) => void) | undefined;
  readonly onCollapseChange?: ((collapsedResourceIds: readonly CalendarResourceId[]) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Omit to preserve the R4 read-only surface exactly. */
  readonly interaction?: CalendarResourceSchedulerInteractionOptions | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function positiveNumber(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RangeError(`${label} must be positive and finite`);
  return resolved;
}

function hostDataAttributeName(key: string): string {
  return key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`);
}

function safeClassTokens(value: string | undefined): readonly string[] {
  return value?.split(/\s+/u).filter(isSafeHostClassName) ?? [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class CalendarResourceSchedulerUi {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly locale: string;
  private readonly timeZone: string;
  private readonly ariaLabel: string;
  private readonly pixelsPerMinute: number;
  private readonly minTimelineWidth: number;
  private readonly baseRowHeight: number;
  private readonly eventHeight: number;
  private readonly axisTickMinutes: number;
  private readonly extensions: readonly CalendarUiExtension[];
  private readonly onOccurrenceActivate: CalendarResourceSchedulerUiOptions["onOccurrenceActivate"];
  private readonly onCollapseChange: CalendarResourceSchedulerUiOptions["onCollapseChange"];
  private readonly onError: CalendarResourceSchedulerUiOptions["onError"];
  private readonly interaction: CalendarResourceSchedulerInteractionOptions | undefined;
  private readonly slotMinutes: number;
  private readonly snapPolicy: Required<CalendarSnapPolicy>;
  private readonly interactionHelpId: string;
  private readonly status: HTMLElement;
  private readonly pendingOccurrences = new Set<string>();
  private collapsed = new Set<CalendarResourceId>();
  private projection: CalendarResourceSchedulerProjection | undefined;
  private drag: CalendarResourceDragState | undefined;

  public constructor(host: HTMLElement, options: CalendarResourceSchedulerUiOptions = {}) {
    if (!host || typeof host.replaceChildren !== "function") throw new TypeError("Resource Scheduler UI requires a host element");
    this.host = host;
    this.locale = options.locale ?? "en-US";
    this.timeZone = options.timeZone ?? "UTC";
    this.ariaLabel = options.ariaLabel ?? "Resource schedule";
    this.pixelsPerMinute = positiveNumber(options.pixelsPerMinute, 1, "pixelsPerMinute");
    this.minTimelineWidth = positiveNumber(options.minTimelineWidth, 720, "minTimelineWidth");
    this.baseRowHeight = positiveNumber(options.baseRowHeight, 46, "baseRowHeight");
    this.eventHeight = positiveNumber(options.eventHeight, 26, "eventHeight");
    this.axisTickMinutes = positiveNumber(options.axisTickMinutes, 60, "axisTickMinutes");
    this.extensions = options.occurrenceExtensions ?? [];
    this.onOccurrenceActivate = options.onOccurrenceActivate;
    this.onCollapseChange = options.onCollapseChange;
    this.onError = options.onError;
    this.interaction = options.interaction;
    this.slotMinutes = this.interaction?.slotMinutes ?? 15;
    this.snapPolicy = normalizeSnapPolicy(this.interaction?.snapPolicy, this.slotMinutes);
    this.interactionHelpId = `dc-rs-interaction-help-${++schedulerUiSequence}`;
    if (this.interaction) {
      positiveNumber(this.interaction.minimumDurationMinutes, 5, "interaction.minimumDurationMinutes");
      if (typeof this.interaction.mutationPort?.commit !== "function") {
        throw new Error("interaction.mutationPort.commit must be a function");
      }
      if (this.interaction.dstOverlapDisambiguation !== undefined
        && !["earlier", "later"].includes(this.interaction.dstOverlapDisambiguation)) {
        throw new Error("interaction.dstOverlapDisambiguation must be earlier or later");
      }
    }
    for (const id of options.initialCollapsedResourceIds ?? []) this.collapsed.add(id);
    // Validate locale/time zone eagerly so malformed UI configuration fails before mounting.
    new Intl.DateTimeFormat(this.locale, { timeZone: this.timeZone }).format(new Date(0));

    const style = element("style");
    style.textContent = RESOURCE_SCHEDULER_CSS;
    this.root = element("div", "dc-rs-root");
    this.root.setAttribute("aria-label", this.ariaLabel);
    this.root.addEventListener("keydown", event => this.onKeyDown(event));
    this.status = element("div", "dc-rs-sr-only");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("aria-atomic", "true");
    this.replaceSurface(this.emptyState());
    this.host.replaceChildren(style, this.root);
  }

  public setProjection(projection: CalendarResourceSchedulerProjection): void {
    this.cancelDrag();
    const stable: CalendarResourceSchedulerProjection = {
      resources: [...projection.resources],
      occurrences: [...projection.occurrences],
      assignments: [...projection.assignments],
      range: { start: projection.range.start, end: projection.range.end },
    };
    const ids = new Set(stable.resources.map(resource => resource.id));
    const nextCollapsed = new Set([...this.collapsed].filter(id => ids.has(id)));
    const rendered = this.renderProjection(stable, nextCollapsed);
    this.projection = stable;
    this.collapsed = nextCollapsed;
    this.replaceSurface(rendered);
  }

  public setCollapsedResourceIds(ids: readonly CalendarResourceId[]): void {
    this.cancelDrag();
    if (!this.projection) {
      this.collapsed = new Set(ids);
      return;
    }
    const next = new Set(ids);
    if (next.size !== ids.length) throw new Error("Collapsed resource IDs must be unique");
    // R2 validation rejects unknown collapse IDs before current UI state is changed.
    flattenCalendarResources(this.projection.resources, [...next]);
    const rendered = this.renderProjection(this.projection, next);
    this.collapsed = next;
    this.replaceSurface(rendered);
    this.notifyCollapseChange();
  }

  public collapsedResourceIds(): readonly CalendarResourceId[] {
    return [...this.collapsed];
  }

  public refresh(): void {
    this.cancelDrag();
    if (!this.projection) {
      this.replaceSurface(this.emptyState());
      return;
    }
    const rendered = this.renderProjection(this.projection, this.collapsed);
    this.replaceSurface(rendered);
  }

  public destroy(): void {
    this.cancelDrag();
    this.projection = undefined;
    this.collapsed.clear();
    this.pendingOccurrences.clear();
    this.host.replaceChildren();
  }

  private replaceSurface(surface: HTMLElement): void {
    const currentScroll = this.root.querySelector<HTMLElement>(".dc-rs-scroll");
    const scrollLeft = currentScroll?.scrollLeft ?? 0;
    const scrollTop = currentScroll?.scrollTop ?? 0;
    this.root.replaceChildren(surface, this.status);
    const nextScroll = surface.matches(".dc-rs-scroll")
      ? surface
      : surface.querySelector<HTMLElement>(".dc-rs-scroll");
    if (nextScroll) {
      nextScroll.scrollLeft = scrollLeft;
      nextScroll.scrollTop = scrollTop;
    }
  }

  private announce(message: string): void {
    this.status.textContent = "";
    queueMicrotask(() => { this.status.textContent = message; });
  }

  private emptyState(): HTMLElement {
    const empty = element("div", "dc-rs-empty", "No resource schedule data.");
    empty.setAttribute("role", "status");
    return empty;
  }

  private renderProjection(
    projection: CalendarResourceSchedulerProjection,
    collapsed: ReadonlySet<CalendarResourceId>,
  ): HTMLElement {
    const collapsedIds = [...collapsed];
    const rows = flattenCalendarResources(projection.resources, collapsedIds);
    const layouts = layoutResourceTimeline(
      projection.resources,
      projection.occurrences,
      projection.assignments,
      projection.range,
      { timeZone: this.timeZone, collapsedResourceIds: collapsedIds },
    );
    const rangeGeometry = resolveResourceTimelineRangeGeometry(projection.range, this.timeZone);
    const timelineWidth = Math.max(this.minTimelineWidth, rangeGeometry.widthMinutes * this.pixelsPerMinute);
    const scale = timelineWidth / rangeGeometry.widthMinutes;
    const tickMinutes = this.resolvedTickMinutes(rangeGeometry.end - rangeGeometry.start);
    this.prepareExtensions(projection);

    const scroll = element("div", "dc-rs-scroll");
    scroll.tabIndex = 0;
    if (this.interaction) {
      const help = element("div", "dc-rs-sr-only", "Use Alt+Left/Right to move in time and Alt+Up/Down to move between resources. Focus a resize handle and use Left/Right to resize.");
      help.id = this.interactionHelpId;
      scroll.append(help);
    }
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", `${this.ariaLabel} timeline; scroll horizontally for time and vertically for resources`);

    const grid = element("div", "dc-rs-treegrid");
    grid.setAttribute("role", "treegrid");
    grid.setAttribute("aria-label", this.ariaLabel);
    grid.setAttribute("aria-rowcount", String(rows.length + 1));
    grid.append(this.headerRow(projection.range, rangeGeometry, timelineWidth, scale, tickMinutes));

    const layoutsByRow = new Map<number, CalendarResourceTimelineLayoutItem[]>();
    for (const layout of layouts) {
      const row = layoutsByRow.get(layout.resourceRow) ?? [];
      row.push(layout);
      layoutsByRow.set(layout.resourceRow, row);
    }

    for (const row of rows) {
      const rowLayouts = layoutsByRow.get(row.index) ?? [];
      grid.append(this.resourceRow(row.resource, row.depth, row.hasChildren, row.acceptsAssignments, row.index, rowLayouts, timelineWidth, scale, tickMinutes, collapsed.has(row.resource.id)));
    }
    if (!rows.length) {
      const empty = element("div", "dc-rs-empty", "No resources in this range.");
      empty.setAttribute("role", "row");
      grid.append(empty);
    }
    scroll.append(grid);
    return scroll;
  }

  private headerRow(
    range: CalendarRange,
    geometry: ReturnType<typeof resolveResourceTimelineRangeGeometry>,
    timelineWidth: number,
    scale: number,
    tickMinutes: number,
  ): HTMLElement {
    const row = element("div", "dc-rs-row dc-rs-header-row");
    row.setAttribute("role", "row");
    const corner = element("div", "dc-rs-corner", "Resources");
    corner.setAttribute("role", "columnheader");
    const axis = element("div", "dc-rs-axis");
    axis.setAttribute("role", "columnheader");
    axis.setAttribute("aria-label", `Time axis in ${this.timeZone}`);
    axis.style.width = `${timelineWidth}px`;

    const elapsedMinutes = (geometry.end - geometry.start) / 60_000;
    const includeDate = elapsedMinutes >= 24 * 60;
    const formatter = new Intl.DateTimeFormat(this.locale, {
      ...(includeDate ? { month: "short", day: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
      timeZone: this.timeZone,
    });
    const tickMs = tickMinutes * 60_000;
    const seen = new Set<string>();
    for (let instant = geometry.start; instant <= geometry.end; instant += tickMs) {
      const minute = geometry.coordinate(instant);
      if (minute < 0 || minute > geometry.widthMinutes) continue;
      const key = minute.toFixed(6);
      if (seen.has(key)) continue;
      seen.add(key);
      const tick = element("div", "dc-rs-axis-tick", formatter.format(new Date(instant)));
      tick.style.left = `${clamp(minute * scale, 0, timelineWidth)}px`;
      tick.setAttribute("aria-hidden", "true");
      axis.append(tick);
    }
    axis.dataset.rangeStart = range.start;
    axis.dataset.rangeEnd = range.end;
    row.append(corner, axis);
    return row;
  }

  private resourceRow(
    resource: CalendarResource,
    depth: number,
    hasChildren: boolean,
    acceptsAssignments: boolean,
    rowIndex: number,
    layouts: readonly CalendarResourceTimelineLayoutItem[],
    timelineWidth: number,
    scale: number,
    tickMinutes: number,
    collapsed: boolean,
  ): HTMLElement {
    const row = element("div", "dc-rs-row dc-rs-resource-row");
    row.setAttribute("role", "row");
    row.setAttribute("aria-level", String(depth + 1));
    row.dataset.resourceId = resource.id;
    if (hasChildren) row.setAttribute("aria-expanded", String(!collapsed));

    const header = element("div", "dc-rs-row-header");
    header.setAttribute("role", "rowheader");
    header.style.setProperty("--dc-rs-depth", String(depth));
    if (resource.display?.color) header.style.setProperty("--dc-rs-resource-accent", resource.display.color);
    for (const token of safeClassTokens(resource.display?.className)) header.classList.add(token);

    if (hasChildren) {
      const toggle = element("button", "dc-rs-toggle", collapsed ? "▸" : "▾");
      toggle.type = "button";
      toggle.dataset.resourceId = resource.id;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${resource.title}`);
      toggle.addEventListener("click", () => this.toggleResource(resource.id));
      header.append(toggle);
    } else {
      const spacer = element("span", "dc-rs-toggle-spacer");
      spacer.setAttribute("aria-hidden", "true");
      header.append(spacer);
    }

    const copy = element("span", "dc-rs-resource-copy");
    const title = element("span", "dc-rs-resource-title");
    if (resource.display?.icon) {
      const icon = element("span", "dc-rs-resource-icon", resource.display.icon);
      icon.setAttribute("aria-hidden", "true");
      title.append(icon);
    }
    title.append(document.createTextNode(resource.title));
    copy.append(title);
    if (hasChildren || !acceptsAssignments) {
      copy.append(element("span", "dc-rs-resource-meta", hasChildren
        ? (acceptsAssignments ? "Group · assignable" : "Group")
        : "Not assignable"));
    }
    header.append(copy);

    const laneCount = Math.max(1, ...layouts.map(layout => layout.laneCount));
    const rowHeight = Math.max(this.baseRowHeight, laneCount * this.eventHeight + 10);
    const track = element("div", "dc-rs-track");
    track.setAttribute("role", "gridcell");
    track.setAttribute("aria-label", `${resource.title}; ${layouts.length} scheduled item${layouts.length === 1 ? "" : "s"}`);
    track.style.width = `${timelineWidth}px`;
    track.style.height = `${rowHeight}px`;
    track.style.setProperty("--dc-rs-tick-px", `${tickMinutes * scale}px`);

    for (const layout of layouts) {
      track.append(this.occurrenceElement(layout, rowIndex, timelineWidth, scale));
    }
    row.append(header, track);
    return row;
  }

  private occurrenceElement(
    layout: CalendarResourceTimelineLayoutItem,
    rowIndex: number,
    timelineWidth: number,
    scale: number,
  ): HTMLElement {
    const occurrence = layout.occurrence;
    const presentation = resolveOccurrencePresentation(
      this.extensions,
      occurrence,
      (index, error) => this.reportError({ stage: "present", index, error }),
    );
    const activatable = Boolean(this.onOccurrenceActivate);
    const interactive = Boolean(this.interaction);
    const node = element("div", "dc-rs-event");
    node.tabIndex = 0;
    node.setAttribute("role", interactive ? "group" : (activatable ? "button" : "group"));
    if (activatable) node.classList.add("is-activatable");
    if (interactive) {
      node.classList.add("is-interactive");
      node.setAttribute("aria-keyshortcuts", activatable
        ? "Enter Space Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
        : "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown");
    }
    if (layout.temporalForm === "point") node.classList.add("is-point");
    node.dataset.renderId = layout.renderId;
    node.dataset.resourceId = layout.resourceId;
    node.dataset.occurrenceId = layout.occurrenceId;
    node.dataset.resourceRow = String(rowIndex);
    node.dataset.xMinutes = String(layout.xMinutes);
    if (this.pendingOccurrences.has(occurrence.occurrenceId)) {
      node.classList.add("is-pending");
      node.setAttribute("aria-busy", "true");
    }

    const left = clamp(layout.xMinutes * scale, 0, timelineWidth);
    const desiredWidth = layout.temporalForm === "point" ? 10 : Math.max(18, layout.widthMinutes * scale);
    const width = Math.max(layout.temporalForm === "point" ? 10 : 1, Math.min(desiredWidth, Math.max(1, timelineWidth - left)));
    node.style.left = `${left}px`;
    node.style.width = `${width}px`;
    node.style.top = `${5 + layout.lane * this.eventHeight}px`;
    node.style.height = `${Math.max(20, this.eventHeight - 2)}px`;
    if (occurrence.display?.color) node.style.setProperty("--dc-rs-event-bg", occurrence.display.color);
    if (occurrence.display?.textColor) node.style.setProperty("--dc-rs-event-fg", occurrence.display.textColor);
    for (const token of safeClassTokens(occurrence.display?.className)) node.classList.add(token);
    for (const token of presentation.classNames) node.classList.add(token);
    for (const [key, value] of Object.entries(presentation.data)) {
      node.setAttribute(`data-host-${hostDataAttributeName(key)}`, value);
    }

    const label = presentation.accessibleLabel ?? this.occurrenceAccessibleLabel(occurrence, layout.resource);
    node.setAttribute("aria-label", label);
    node.append(this.occurrenceContent(occurrence, presentation));
    if (interactive) {
      node.setAttribute("aria-describedby", this.interactionHelpId);
      node.addEventListener("pointerdown", event => this.onOccurrencePointerDown(event, node, occurrence, layout.resourceId, "move"));
      if (layout.temporalForm !== "point") {
        node.append(
          this.resizeHandle(node, occurrence, layout.resourceId, "start"),
          this.resizeHandle(node, occurrence, layout.resourceId, "end"),
        );
      }
    }
    if (activatable) {
      node.addEventListener("click", event => {
        if (node.dataset.suppressActivation === "true") {
          delete node.dataset.suppressActivation;
          event.preventDefault();
          return;
        }
        try { this.onOccurrenceActivate?.(occurrence, layout.resource); }
        catch (error) { this.reportError(error); }
      });
    }
    return node;
  }

  private resizeHandle(
    node: HTMLElement,
    occurrence: CalendarOccurrence,
    resourceId: CalendarResourceId,
    edge: "start" | "end",
  ): HTMLElement {
    const handle = element("span", "dc-rs-resize-handle");
    handle.tabIndex = 0;
    handle.dataset.edge = edge;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize ${edge} of ${occurrence.title}`);
    handle.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
    handle.addEventListener("click", event => event.stopPropagation());
    handle.addEventListener("pointerdown", event => {
      event.stopPropagation();
      this.onOccurrencePointerDown(event, node, occurrence, resourceId, edge === "start" ? "resize-start" : "resize-end");
    });
    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const delta = (event.key === "ArrowRight" ? 1 : -1) * this.snapPolicy.keyboardStepMinutes;
      void this.keyboardResize(node, occurrence, resourceId, edge, delta);
    });
    return handle;
  }

  private minimumDurationMinutes(): number {
    return positiveNumber(this.interaction?.minimumDurationMinutes, 5, "interaction.minimumDurationMinutes");
  }

  private overlapDisambiguation(): CalendarOverlapDisambiguation {
    return this.interaction?.dstOverlapDisambiguation ?? "earlier";
  }

  private assignmentFor(occurrenceId: string): CalendarResourceAssignment | undefined {
    return this.projection?.assignments.find(assignment => assignment.occurrenceId === occurrenceId);
  }

  private resourceById(resourceId: CalendarResourceId): CalendarResource | undefined {
    return this.projection?.resources.find(resource => resource.id === resourceId);
  }

  private resourceAt(clientX: number, clientY: number): CalendarResource | undefined {
    const row = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".dc-rs-resource-row");
    if (!row || !this.root.contains(row)) return undefined;
    const id = row.dataset.resourceId;
    return id ? this.resourceById(id) : undefined;
  }

  private onOccurrencePointerDown(
    event: PointerEvent,
    node: HTMLElement,
    occurrence: CalendarOccurrence,
    sourceResourceId: CalendarResourceId,
    mode: CalendarResourceInteractionMode,
  ): void {
    if (!this.interaction || !this.projection || event.button !== 0 || this.pendingOccurrences.has(occurrence.occurrenceId)) return;
    if (this.drag) this.cancelDrag();
    const assignment = this.assignmentFor(occurrence.occurrenceId);
    if (!assignment || !assignment.resourceIds.includes(sourceResourceId)) return;
    const scroll = this.root.querySelector<HTMLElement>(".dc-rs-scroll");
    if (!scroll) return;
    const geometry = resolveResourceTimelineRangeGeometry(this.projection.range, this.timeZone);
    const timelineWidth = Math.max(this.minTimelineWidth, geometry.widthMinutes * this.pixelsPerMinute);
    const scale = timelineWidth / geometry.widthMinutes;
    const rect = node.getBoundingClientRect();
    const ghost = element("div", "dc-rs-drag-ghost", occurrence.title);
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${Math.max(10, rect.width)}px`;
    ghost.style.height = `${Math.max(20, rect.height)}px`;
    ghost.hidden = true;
    this.root.append(ghost);
    node.focus({ preventScroll: true });
    node.setPointerCapture(event.pointerId);
    node.classList.add("is-drag-source");
    this.drag = {
      mode,
      pointerId: event.pointerId,
      node,
      occurrence,
      sourceResourceId,
      assignment,
      originalStart: occurrence.start,
      originalEnd: occurrence.end,
      startClientX: event.clientX,
      startClientY: event.clientY,
      scrollStartLeft: scroll.scrollLeft,
      scrollStartTop: scroll.scrollTop,
      scale,
      ghost,
      moved: false,
      candidate: undefined,
    };
    node.addEventListener("pointermove", this.boundPointerMove);
    node.addEventListener("pointerup", this.boundPointerUp);
    node.addEventListener("pointercancel", this.boundPointerCancel);
    event.preventDefault();
  }

  private readonly boundPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const scroll = this.root.querySelector<HTMLElement>(".dc-rs-scroll");
    if (!scroll) return;
    this.autoScroll(scroll, event.clientX, event.clientY);
    const dx = event.clientX - drag.startClientX + (scroll.scrollLeft - drag.scrollStartLeft);
    const dy = event.clientY - drag.startClientY + (scroll.scrollTop - drag.scrollStartTop);
    if (!drag.moved && Math.hypot(dx, dy) < POINTER_MOVE_THRESHOLD) return;
    drag.moved = true;
    drag.ghost.hidden = false;
    const rawMinutes = dx / drag.scale;
    const strategy = drag.mode === "move" ? this.snapPolicy.move : this.snapPolicy.resize;
    const deltaMinutes = snapMinuteCoordinate(rawMinutes, this.slotMinutes, strategy);
    const candidate = this.interactionCandidate(drag, deltaMinutes, event.clientX, event.clientY);
    drag.candidate = candidate;
    this.updateDragPreview(drag, candidate);
    event.preventDefault();
  };

  private readonly boundPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const candidate = drag.candidate;
    const moved = drag.moved;
    this.cleanupDrag(drag);
    if (!moved) return;
    drag.node.dataset.suppressActivation = "true";
    if (!candidate?.valid) {
      this.announce("That placement cannot be targeted.");
      return;
    }
    void this.submitCandidate(drag.node, drag.occurrence, drag.sourceResourceId, drag.assignment, drag.mode, candidate);
  };

  private readonly boundPointerCancel = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.cancelDrag();
  };

  private interactionCandidate(
    drag: CalendarResourceDragState,
    deltaMinutes: number,
    clientX: number,
    clientY: number,
  ): CalendarResourceInteractionCandidate | undefined {
    let times;
    if (drag.mode === "move") {
      times = moveResourceOccurrenceByCivilMinutes(
        drag.occurrence, deltaMinutes, this.timeZone, this.overlapDisambiguation(),
      );
    } else {
      times = resizeResourceOccurrenceByCivilMinutes(
        drag.occurrence,
        drag.mode === "resize-start" ? "start" : "end",
        deltaMinutes,
        this.minimumDurationMinutes(),
        this.timeZone,
        this.overlapDisambiguation(),
      );
    }
    if (!times) return {
      start: drag.originalStart,
      end: drag.originalEnd,
      targetResourceId: drag.sourceResourceId,
      toResourceIds: drag.assignment.resourceIds,
      valid: false,
    };

    let targetResourceId = drag.sourceResourceId;
    let toResourceIds = drag.assignment.resourceIds;
    let valid = true;
    if (drag.mode === "move") {
      const target = this.resourceAt(clientX, clientY);
      if (target) {
        targetResourceId = target.id;
        valid = target.acceptsAssignments === true;
        if (valid) {
          try {
            toResourceIds = replaceCalendarResourceAssignment(
              drag.assignment.resourceIds, drag.sourceResourceId, target.id,
            );
          } catch {
            valid = false;
          }
        }
      }
    }
    return { ...times, targetResourceId, toResourceIds, valid };
  }

  private updateDragPreview(
    drag: CalendarResourceDragState,
    candidate: CalendarResourceInteractionCandidate | undefined,
  ): void {
    drag.ghost.classList.toggle("is-invalid", candidate?.valid === false);
    for (const row of this.root.querySelectorAll<HTMLElement>(".dc-rs-resource-row")) {
      row.classList.remove("is-drop-target", "is-drop-invalid");
      if (drag.mode !== "move" || !candidate || row.dataset.resourceId !== candidate.targetResourceId) continue;
      row.classList.add(candidate.valid ? "is-drop-target" : "is-drop-invalid");
    }
    if (!candidate || !this.projection) return;

    const targetRow = [...this.root.querySelectorAll<HTMLElement>(".dc-rs-resource-row")]
      .find(row => row.dataset.resourceId === candidate.targetResourceId);
    const track = targetRow?.querySelector<HTMLElement>(".dc-rs-track");
    if (track) {
      const geometry = resolveResourceTimelineRangeGeometry(this.projection.range, this.timeZone);
      const startMs = Date.parse(candidate.start);
      const endMs = Date.parse(candidate.end);
      const rawX = geometry.coordinate(startMs);
      const rawEnd = geometry.coordinate(endMs);
      const elapsedWidth = Math.max(0, (endMs - startMs) / 60_000);
      const civilWidth = rawEnd - rawX;
      const minuteWidth = drag.occurrence.temporalForm === "point" ? 0 : (civilWidth > 0 ? civilWidth : elapsedWidth);
      const trackRect = track.getBoundingClientRect();
      const left = clamp(rawX * drag.scale, 0, trackRect.width);
      const width = drag.occurrence.temporalForm === "point"
        ? 10
        : Math.max(18, Math.min(minuteWidth * drag.scale, Math.max(1, trackRect.width - left)));
      drag.ghost.style.left = `${trackRect.left + left}px`;
      drag.ghost.style.top = `${trackRect.top + 5}px`;
      drag.ghost.style.width = `${width}px`;
      drag.ghost.style.height = `${Math.max(20, this.eventHeight - 2)}px`;
    }

    const delta = (Date.parse(candidate.start) - Date.parse(drag.originalStart)) / 60_000;
    const targetName = this.resourceById(candidate.targetResourceId)?.title;
    drag.ghost.textContent = drag.mode === "move"
      ? `${drag.occurrence.title}${candidate.targetResourceId === drag.sourceResourceId ? "" : ` · ${targetName ?? candidate.targetResourceId}`} · ${delta >= 0 ? "+" : ""}${Math.round(delta)} min`
      : `${drag.occurrence.title} · ${drag.mode === "resize-start" ? "start" : "end"}`;
  }

  private cleanupDrag(drag: CalendarResourceDragState): void {
    drag.node.removeEventListener("pointermove", this.boundPointerMove);
    drag.node.removeEventListener("pointerup", this.boundPointerUp);
    drag.node.removeEventListener("pointercancel", this.boundPointerCancel);
    if (drag.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId);
    drag.node.classList.remove("is-drag-source");
    drag.ghost.remove();
    for (const row of this.root.querySelectorAll<HTMLElement>(".dc-rs-resource-row")) {
      row.classList.remove("is-drop-target", "is-drop-invalid");
    }
    if (this.drag === drag) this.drag = undefined;
  }

  private cancelDrag(): void {
    if (this.drag) this.cleanupDrag(this.drag);
  }

  private autoScroll(scroll: HTMLElement, clientX: number, clientY: number): void {
    const rect = scroll.getBoundingClientRect();
    if (clientX < rect.left + AUTO_SCROLL_ZONE) scroll.scrollLeft -= AUTO_SCROLL_STEP;
    else if (clientX > rect.right - AUTO_SCROLL_ZONE) scroll.scrollLeft += AUTO_SCROLL_STEP;
    if (clientY < rect.top + AUTO_SCROLL_ZONE) scroll.scrollTop -= AUTO_SCROLL_STEP;
    else if (clientY > rect.bottom - AUTO_SCROLL_ZONE) scroll.scrollTop += AUTO_SCROLL_STEP;
  }

  private async keyboardMove(
    node: HTMLElement,
    occurrence: CalendarOccurrence,
    sourceResourceId: CalendarResourceId,
    deltaMinutes: number,
    resourceDirection: -1 | 0 | 1,
  ): Promise<void> {
    const assignment = this.assignmentFor(occurrence.occurrenceId);
    if (!assignment) return;
    const times = moveResourceOccurrenceByCivilMinutes(
      occurrence, deltaMinutes, this.timeZone, this.overlapDisambiguation(),
    );
    if (!times) {
      this.announce("That wall-clock time does not exist.");
      return;
    }
    let targetResourceId = sourceResourceId;
    let toResourceIds = assignment.resourceIds;
    if (resourceDirection !== 0) {
      const rows = flattenCalendarResources(this.projection?.resources ?? [], [...this.collapsed])
        .filter(row => row.acceptsAssignments);
      const current = rows.findIndex(row => row.resource.id === sourceResourceId);
      const target = rows[current + resourceDirection];
      if (!target) return;
      targetResourceId = target.resource.id;
      toResourceIds = replaceCalendarResourceAssignment(assignment.resourceIds, sourceResourceId, targetResourceId);
    }
    await this.submitCandidate(node, occurrence, sourceResourceId, assignment, "move", {
      ...times, targetResourceId, toResourceIds, valid: true,
    });
  }

  private async keyboardResize(
    node: HTMLElement,
    occurrence: CalendarOccurrence,
    sourceResourceId: CalendarResourceId,
    edge: "start" | "end",
    deltaMinutes: number,
  ): Promise<void> {
    const assignment = this.assignmentFor(occurrence.occurrenceId);
    if (!assignment) return;
    const times = resizeResourceOccurrenceByCivilMinutes(
      occurrence, edge, deltaMinutes, this.minimumDurationMinutes(), this.timeZone, this.overlapDisambiguation(),
    );
    if (!times) {
      this.announce("That resize target is not available.");
      return;
    }
    await this.submitCandidate(node, occurrence, sourceResourceId, assignment, edge === "start" ? "resize-start" : "resize-end", {
      ...times,
      targetResourceId: sourceResourceId,
      toResourceIds: assignment.resourceIds,
      valid: true,
    });
  }

  private async submitCandidate(
    node: HTMLElement,
    occurrence: CalendarOccurrence,
    sourceResourceId: CalendarResourceId,
    assignment: CalendarResourceAssignment,
    mode: CalendarResourceInteractionMode,
    candidate: CalendarResourceInteractionCandidate,
  ): Promise<void> {
    const interaction = this.interaction;
    const projection = this.projection;
    if (!interaction || !projection || this.pendingOccurrences.has(occurrence.occurrenceId)) return;
    const timeChanged = Date.parse(candidate.start) !== Date.parse(occurrence.start)
      || Date.parse(candidate.end) !== Date.parse(occurrence.end);
    const action = mode === "move"
      ? (candidate.targetResourceId === sourceResourceId
        ? "move"
        : (timeChanged ? "resource-time-move" : "resource-reassign"))
      : mode;
    let scope: SeriesEditScope | null = "this";
    try {
      if (occurrence.recurring && interaction.resolveScope) {
        scope = await interaction.resolveScope(occurrence, action);
      }
    } catch (error) {
      this.reportError(error);
      return;
    }
    if (scope === null) return;
    if (!["this", "this-and-following", "all"].includes(scope)) {
      this.reportError(new Error("Resource Scheduler interaction returned an invalid recurrence scope"));
      return;
    }
    const request: CalendarResourcePlacementRequest = {
      occurrence,
      sourceResourceId,
      targetResourceId: candidate.targetResourceId,
      fromResourceIds: assignment.resourceIds,
      toResourceIds: candidate.toResourceIds,
      start: candidate.start,
      end: candidate.end,
      scope,
      timeZone: this.timeZone,
      action,
      ...(assignment.version === undefined ? {} : { assignmentVersion: assignment.version }),
    };

    this.setOccurrencePending(occurrence.occurrenceId, true);
    let result: CalendarResourcePlacementExecutionResult | undefined;
    try {
      const executionOptions = this.executionOptionsFor(occurrence, false);
      result = await executeCalendarResourcePlacement(projection.resources, request, executionOptions);
      if (result.status === "warning" && interaction.confirmWarnings) {
        let accepted = false;
        try {
          accepted = await interaction.confirmWarnings(result.evaluation.messages, request);
        } catch (error) {
          this.reportError(error);
        }
        if (accepted) {
          result = await executeCalendarResourcePlacement(
            projection.resources,
            request,
            this.executionOptionsFor(occurrence, true),
          );
        }
      }
    } catch (error) {
      this.reportError(error);
      this.announce(`${occurrence.title} was not changed.`);
    }

    if (result) {
      try { interaction.onResult?.(result, request); } catch (error) { this.reportError(error); }
      this.announce(this.resultAnnouncement(result, occurrence));
      if (result.status === "committed" || result.status === "stale") {
        try {
          await this.refreshAuthoritativeProjection();
        } catch (error) {
          this.reportError(error);
          if (result.status === "committed") this.announce(`${occurrence.title} changed, but authoritative refresh failed.`);
        }
      }
    }
    this.setOccurrencePending(occurrence.occurrenceId, false);
    if (node.isConnected) node.focus();
    else this.focusOccurrence(occurrence.occurrenceId, result?.status === "committed" ? candidate.targetResourceId : sourceResourceId);
  }

  private executionOptionsFor(
    occurrence: CalendarOccurrence,
    acceptWarnings: boolean,
  ): CalendarResourcePlacementExecutionOptions {
    const interaction = this.interaction;
    if (!interaction) throw new Error("Resource Scheduler interaction is not configured");
    return {
      mutationPort: interaction.mutationPort,
      ...(interaction.occurrenceCapabilityProvider === undefined ? {} : { occurrenceCapabilityProvider: interaction.occurrenceCapabilityProvider }),
      ...(interaction.resourceCapabilityProvider === undefined ? {} : { resourceCapabilityProvider: interaction.resourceCapabilityProvider }),
      ...(interaction.temporal === undefined ? {} : { temporal: interaction.temporal }),
      ...(interaction.resourceGuards === undefined ? {} : { resourceGuards: interaction.resourceGuards }),
      ...(interaction.resourceCollisionPolicy === undefined ? {} : { resourceCollisionPolicy: interaction.resourceCollisionPolicy }),
      ...(interaction.loadResourceCollisionProjection === undefined ? {} : { loadResourceCollisionProjection: interaction.loadResourceCollisionProjection }),
      ...(interaction.sourceForOccurrence === undefined ? {} : { source: interaction.sourceForOccurrence(occurrence) }),
      acceptWarnings,
    };
  }

  private resultAnnouncement(
    result: CalendarResourcePlacementExecutionResult,
    occurrence: CalendarOccurrence,
  ): string {
    if (result.status === "committed") return `${occurrence.title} changed.`;
    if (result.status === "stale") return `${occurrence.title} changed elsewhere; refreshing authoritative data.`;
    if (result.status === "warning") return result.evaluation.messages.join(" ");
    if (result.status === "prevented") return result.evaluation.messages.join(" ");
    return `${occurrence.title} is already in that position.`;
  }

  private async refreshAuthoritativeProjection(): Promise<void> {
    const refreshed = await this.interaction?.refreshProjection?.();
    if (refreshed) this.setProjection(refreshed);
  }

  private focusOccurrence(occurrenceId: string, preferredResourceId?: CalendarResourceId): void {
    const nodes = [...this.root.querySelectorAll<HTMLElement>(".dc-rs-event")]
      .filter(node => node.dataset.occurrenceId === occurrenceId);
    const preferred = preferredResourceId
      ? nodes.find(node => node.dataset.resourceId === preferredResourceId)
      : undefined;
    (preferred ?? nodes[0])?.focus();
  }

  private setOccurrencePending(occurrenceId: string, pending: boolean): void {
    if (pending) this.pendingOccurrences.add(occurrenceId);
    else this.pendingOccurrences.delete(occurrenceId);
    for (const node of this.root.querySelectorAll<HTMLElement>(".dc-rs-event")) {
      if (node.dataset.occurrenceId !== occurrenceId) continue;
      node.classList.toggle("is-pending", pending);
      if (pending) node.setAttribute("aria-busy", "true");
      else node.removeAttribute("aria-busy");
    }
  }

  private occurrenceContent(
    occurrence: CalendarOccurrence,
    presentation: ReturnType<typeof resolveOccurrencePresentation>,
  ): HTMLElement {
    const content = element("span", "dc-rs-event-content");
    const iconText = presentation.icon?.text ?? occurrence.display?.icon;
    if (iconText) {
      const icon = element("span", "dc-rs-event-icon", iconText);
      if (presentation.icon?.accessibleLabel) icon.setAttribute("aria-label", presentation.icon.accessibleLabel);
      else icon.setAttribute("aria-hidden", "true");
      content.append(icon);
    }
    if (presentation.leading) {
      const leading = element("span", "dc-rs-event-leading", presentation.leading.text);
      if (presentation.leading.accessibleLabel) leading.setAttribute("aria-label", presentation.leading.accessibleLabel);
      content.append(leading);
    }
    const title = element("span", "dc-rs-event-title", presentation.title?.text ?? occurrence.title);
    if (presentation.title?.accessibleLabel) title.setAttribute("aria-label", presentation.title.accessibleLabel);
    content.append(title);
    if (presentation.subtitle) content.append(element("span", "dc-rs-event-subtitle", presentation.subtitle.text));
    if (presentation.badges.length) {
      const badges = element("span", "dc-rs-event-badges");
      for (const badge of presentation.badges) {
        const item = element("span", "dc-rs-event-badge", badge.label);
        if (badge.accessibleLabel) item.setAttribute("aria-label", badge.accessibleLabel);
        badges.append(item);
      }
      content.append(badges);
    }
    if (presentation.trailing) content.append(element("span", "dc-rs-event-trailing", presentation.trailing.text));
    return content;
  }

  private occurrenceAccessibleLabel(occurrence: CalendarOccurrence, resource: CalendarResource): string {
    const formatter = new Intl.DateTimeFormat(this.locale, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: this.timeZone,
    });
    const start = formatter.format(new Date(occurrence.start));
    if (occurrence.temporalForm === "point") return `${occurrence.title}, ${start}, ${resource.title}`;
    const end = formatter.format(new Date(occurrence.end));
    return `${occurrence.title}, ${start} to ${end}, ${resource.title}`;
  }

  private prepareExtensions(projection: CalendarResourceSchedulerProjection): void {
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

  private resolvedTickMinutes(rangeMilliseconds: number): number {
    const elapsedMinutes = Math.max(1, rangeMilliseconds / 60_000);
    const multiplier = Math.max(1, Math.ceil(elapsedMinutes / this.axisTickMinutes / MAX_AXIS_TICKS));
    return this.axisTickMinutes * multiplier;
  }

  private toggleResource(resourceId: CalendarResourceId, expand?: boolean): void {
    this.cancelDrag();
    if (!this.projection) return;
    const next = new Set(this.collapsed);
    const shouldExpand = expand ?? next.has(resourceId);
    if (shouldExpand) next.delete(resourceId);
    else next.add(resourceId);
    const rendered = this.renderProjection(this.projection, next);
    this.collapsed = next;
    this.replaceSurface(rendered);
    this.notifyCollapseChange();
    const toggle = this.root.querySelector<HTMLElement>(`.dc-rs-toggle[data-resource-id="${CSS.escape(resourceId)}"]`);
    toggle?.focus();
  }

  private notifyCollapseChange(): void {
    try { this.onCollapseChange?.(this.collapsedResourceIds()); }
    catch (error) { this.reportError(error); }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const toggle = (event.target as HTMLElement | null)?.closest<HTMLElement>(".dc-rs-toggle");
    if (toggle && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const resourceId = toggle.dataset.resourceId;
      if (!resourceId) return;
      event.preventDefault();
      this.toggleResource(resourceId, event.key === "ArrowRight");
      return;
    }

    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>(".dc-rs-event");
    if (!current) return;
    const occurrenceId = current.dataset.occurrenceId;
    const resourceId = current.dataset.resourceId;
    const occurrence = this.projection?.occurrences.find(row => row.occurrenceId === occurrenceId);
    if (this.interaction && event.altKey && occurrence && resourceId
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const horizontal = event.key === "ArrowLeft" ? -this.snapPolicy.keyboardStepMinutes
        : event.key === "ArrowRight" ? this.snapPolicy.keyboardStepMinutes : 0;
      const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      void this.keyboardMove(current, occurrence, resourceId, horizontal, vertical as -1 | 0 | 1);
      return;
    }
    if (this.onOccurrenceActivate && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const resource = resourceId ? this.resourceById(resourceId) : undefined;
      if (occurrence && resource) {
        try { this.onOccurrenceActivate(occurrence, resource); }
        catch (error) { this.reportError(error); }
      }
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const events = [...this.root.querySelectorAll<HTMLElement>(".dc-rs-event")];
    const row = Number(current.dataset.resourceRow);
    const x = Number(current.dataset.xMinutes);
    const inRow = events.filter(node => Number(node.dataset.resourceRow) === row);
    let target: HTMLElement | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const index = inRow.indexOf(current);
      target = inRow[index + (event.key === "ArrowRight" ? 1 : -1)];
    } else if (event.key === "Home") {
      target = inRow[0];
    } else if (event.key === "End") {
      target = inRow.at(-1);
    } else {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const rowNumbers = [...new Set(events.map(node => Number(node.dataset.resourceRow)))].sort((a, b) => a - b);
      const currentIndex = rowNumbers.indexOf(row);
      const targetRow = rowNumbers[currentIndex + direction];
      if (targetRow !== undefined) {
        target = events.filter(node => Number(node.dataset.resourceRow) === targetRow)
          .sort((a, b) => Math.abs(Number(a.dataset.xMinutes) - x) - Math.abs(Number(b.dataset.xMinutes) - x))[0];
      }
    }
    if (target) {
      event.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private reportError(error: unknown): void {
    try { this.onError?.(error); } catch { /* host diagnostics must not break the read-only surface */ }
  }
}

export { RESOURCE_SCHEDULER_CSS } from "./styles.js";
