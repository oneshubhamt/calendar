import type { CalendarOccurrence, CalendarRange } from "../../core/types.js";
import type { CalendarUiExtension } from "../../view/types.js";
import { isSafeHostClassName, resolveOccurrencePresentation } from "../../view/presentation.js";
import {
  flattenCalendarResources,
  layoutResourceTimeline,
  type CalendarResource,
  type CalendarResourceAssignment,
  type CalendarResourceId,
  type CalendarResourceTimelineLayoutItem,
} from "../resource-scheduler/index.js";
import { resolveResourceTimelineRangeGeometry } from "../resource-scheduler/timeline-layout.js";
import { RESOURCE_SCHEDULER_CSS } from "./styles.js";

const MAX_AXIS_TICKS = 240;

export interface CalendarResourceSchedulerProjection {
  readonly resources: readonly CalendarResource[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly assignments: readonly CalendarResourceAssignment[];
  readonly range: CalendarRange;
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
  private collapsed = new Set<CalendarResourceId>();
  private projection: CalendarResourceSchedulerProjection | undefined;

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
    for (const id of options.initialCollapsedResourceIds ?? []) this.collapsed.add(id);
    // Validate locale/time zone eagerly so malformed UI configuration fails before mounting.
    new Intl.DateTimeFormat(this.locale, { timeZone: this.timeZone }).format(new Date(0));

    const style = element("style");
    style.textContent = RESOURCE_SCHEDULER_CSS;
    this.root = element("div", "dc-rs-root");
    this.root.setAttribute("aria-label", this.ariaLabel);
    this.root.addEventListener("keydown", event => this.onKeyDown(event));
    this.root.append(this.emptyState());
    this.host.replaceChildren(style, this.root);
  }

  public setProjection(projection: CalendarResourceSchedulerProjection): void {
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
    this.root.replaceChildren(rendered);
  }

  public setCollapsedResourceIds(ids: readonly CalendarResourceId[]): void {
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
    this.root.replaceChildren(rendered);
    this.notifyCollapseChange();
  }

  public collapsedResourceIds(): readonly CalendarResourceId[] {
    return [...this.collapsed];
  }

  public refresh(): void {
    if (!this.projection) {
      this.root.replaceChildren(this.emptyState());
      return;
    }
    const rendered = this.renderProjection(this.projection, this.collapsed);
    this.root.replaceChildren(rendered);
  }

  public destroy(): void {
    this.projection = undefined;
    this.collapsed.clear();
    this.host.replaceChildren();
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
    const node = activatable ? element("button", "dc-rs-event") : element("div", "dc-rs-event");
    if (node instanceof HTMLButtonElement) node.type = "button";
    else {
      node.tabIndex = 0;
      node.setAttribute("role", "group");
    }
    if (activatable) node.classList.add("is-activatable");
    if (layout.temporalForm === "point") node.classList.add("is-point");
    node.dataset.renderId = layout.renderId;
    node.dataset.resourceId = layout.resourceId;
    node.dataset.occurrenceId = layout.occurrenceId;
    node.dataset.resourceRow = String(rowIndex);
    node.dataset.xMinutes = String(layout.xMinutes);

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
    if (activatable) {
      node.addEventListener("click", () => {
        try { this.onOccurrenceActivate?.(occurrence, layout.resource); }
        catch (error) { this.reportError(error); }
      });
    }
    return node;
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
    if (!this.projection) return;
    const next = new Set(this.collapsed);
    const shouldExpand = expand ?? next.has(resourceId);
    if (shouldExpand) next.delete(resourceId);
    else next.add(resourceId);
    const rendered = this.renderProjection(this.projection, next);
    this.collapsed = next;
    this.root.replaceChildren(rendered);
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
    if (!current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
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
