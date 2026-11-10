import type { CalendarOccurrence, CalendarRange } from "../../core/types.js";
import { isSafeHostClassName } from "../../view/presentation.js";
import {
  flattenCalendarResources,
  layoutResourceTimeline,
  type CalendarResource,
  type CalendarResourceAssignment,
  type CalendarResourceId,
  type CalendarResourceTimelineLayoutItem,
} from "../resource-scheduler/index.js";
import { resolveResourceTimelineRangeGeometry } from "../resource-scheduler/timeline-layout.js";

const MAX_AXIS_TICKS = 240;

export interface ResourceSchedulerProjectionData {
  readonly resources: readonly CalendarResource[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly assignments: readonly CalendarResourceAssignment[];
  readonly range: CalendarRange;
}

export interface ResourceSchedulerSurfaceModel {
  readonly projection: ResourceSchedulerProjectionData;
  readonly collapsed: ReadonlySet<CalendarResourceId>;
  readonly locale: string;
  readonly timeZone: string;
  readonly ariaLabel: string;
  readonly pixelsPerMinute: number;
  readonly minTimelineWidth: number;
  readonly baseRowHeight: number;
  readonly eventHeight: number;
  readonly axisTickMinutes: number;
  readonly interactionHelpId?: string | undefined;
}

export interface ResourceSchedulerSurfaceActions {
  renderOccurrence(
    layout: CalendarResourceTimelineLayoutItem,
    rowIndex: number,
    timelineWidth: number,
    scale: number,
  ): HTMLElement;
  toggleResource(resourceId: CalendarResourceId): void;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function safeClassTokens(value: string | undefined): readonly string[] {
  return value?.split(/\s+/u).filter(isSafeHostClassName) ?? [];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resourceSchedulerEmptyState(): HTMLElement {
  const empty = element("div", "dc-rs-empty", "No resource schedule data.");
  empty.setAttribute("role", "status");
  return empty;
}

export function renderResourceSchedulerSurface(
  model: ResourceSchedulerSurfaceModel,
  actions: ResourceSchedulerSurfaceActions,
): HTMLElement {
  const { projection } = model;
  const collapsedIds = [...model.collapsed];
  const rows = flattenCalendarResources(projection.resources, collapsedIds);
  const layouts = layoutResourceTimeline(
    projection.resources,
    projection.occurrences,
    projection.assignments,
    projection.range,
    { timeZone: model.timeZone, collapsedResourceIds: collapsedIds },
  );
  const geometry = resolveResourceTimelineRangeGeometry(projection.range, model.timeZone);
  const timelineWidth = Math.max(model.minTimelineWidth, geometry.widthMinutes * model.pixelsPerMinute);
  const scale = timelineWidth / geometry.widthMinutes;
  const tickMinutes = resolvedTickMinutes(geometry.end - geometry.start, model.axisTickMinutes);

  const scroll = element("div", "dc-rs-scroll");
  scroll.tabIndex = 0;
  if (model.interactionHelpId) {
    const help = element(
      "div",
      "dc-rs-sr-only",
      "Use Alt+Left/Right to move in time and Alt+Up/Down to move between resources. Focus a resize handle and use Left/Right to resize.",
    );
    help.id = model.interactionHelpId;
    scroll.append(help);
  }
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", `${model.ariaLabel} timeline; scroll horizontally for time and vertically for resources`);

  const grid = element("div", "dc-rs-treegrid");
  grid.setAttribute("role", "treegrid");
  grid.setAttribute("aria-label", model.ariaLabel);
  grid.setAttribute("aria-rowcount", String(rows.length + 1));
  grid.append(headerRow(model, geometry, timelineWidth, scale, tickMinutes));

  const layoutsByRow = new Map<number, CalendarResourceTimelineLayoutItem[]>();
  for (const layout of layouts) {
    const row = layoutsByRow.get(layout.resourceRow) ?? [];
    row.push(layout);
    layoutsByRow.set(layout.resourceRow, row);
  }

  for (const row of rows) {
    grid.append(resourceRow(
      model,
      actions,
      row.resource,
      row.depth,
      row.hasChildren,
      row.acceptsAssignments,
      row.index,
      layoutsByRow.get(row.index) ?? [],
      timelineWidth,
      scale,
      tickMinutes,
      model.collapsed.has(row.resource.id),
    ));
  }
  if (!rows.length) {
    const empty = element("div", "dc-rs-empty", "No resources in this range.");
    empty.setAttribute("role", "row");
    grid.append(empty);
  }
  scroll.append(grid);
  return scroll;
}

function headerRow(
  model: ResourceSchedulerSurfaceModel,
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
  axis.setAttribute("aria-label", `Time axis in ${model.timeZone}`);
  axis.style.width = `${timelineWidth}px`;

  const elapsedMinutes = (geometry.end - geometry.start) / 60_000;
  const includeDate = elapsedMinutes >= 24 * 60;
  const formatter = new Intl.DateTimeFormat(model.locale, {
    ...(includeDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone: model.timeZone,
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
  axis.dataset.rangeStart = model.projection.range.start;
  axis.dataset.rangeEnd = model.projection.range.end;
  row.append(corner, axis);
  return row;
}

function resourceRow(
  model: ResourceSchedulerSurfaceModel,
  actions: ResourceSchedulerSurfaceActions,
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
    toggle.addEventListener("click", () => actions.toggleResource(resource.id));
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
  const rowHeight = Math.max(model.baseRowHeight, laneCount * model.eventHeight + 10);
  const track = element("div", "dc-rs-track");
  track.setAttribute("role", "gridcell");
  track.setAttribute("aria-label", `${resource.title}; ${layouts.length} scheduled item${layouts.length === 1 ? "" : "s"}`);
  track.style.width = `${timelineWidth}px`;
  track.style.height = `${rowHeight}px`;
  track.style.setProperty("--dc-rs-tick-px", `${tickMinutes * scale}px`);

  for (const layout of layouts) track.append(actions.renderOccurrence(layout, rowIndex, timelineWidth, scale));
  row.append(header, track);
  return row;
}

function resolvedTickMinutes(rangeMilliseconds: number, axisTickMinutes: number): number {
  const elapsedMinutes = Math.max(1, rangeMilliseconds / 60_000);
  const multiplier = Math.max(1, Math.ceil(elapsedMinutes / axisTickMinutes / MAX_AXIS_TICKS));
  return axisTickMinutes * multiplier;
}
