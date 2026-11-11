import type {
  CalendarResourceTimeGridAllDayItem,
  CalendarResourceTimeGridColumn,
  CalendarResourceTimeGridLayout,
  CalendarResourceTimeGridLayoutItem,
} from "../resource-scheduler/index.js";

export interface ResourceTimeGridSurfaceModel {
  readonly layout: CalendarResourceTimeGridLayout;
  readonly locale: string;
  readonly timeZone: string;
  readonly ariaLabel: string;
  readonly pixelsPerMinute: number;
  readonly minColumnWidth: number;
  readonly axisTickMinutes: number;
  readonly interactionHelpId?: string | undefined;
}

export interface ResourceTimeGridSurfaceActions {
  renderTimed(
    item: CalendarResourceTimeGridLayoutItem,
    column: CalendarResourceTimeGridColumn,
  ): HTMLElement;
  renderAllDay(
    item: CalendarResourceTimeGridAllDayItem,
    column: CalendarResourceTimeGridColumn,
  ): HTMLElement;
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

function gridTemplate(columnCount: number, minColumnWidth: number): string {
  return `58px repeat(${columnCount}, minmax(${minColumnWidth}px, 1fr))`;
}

function wallClockLabel(minute: number, locale: string): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  const date = new Date(Date.UTC(2000, 0, 1, Math.floor(normalized / 60), normalized % 60));
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function columnHeader(
  column: CalendarResourceTimeGridColumn,
  locale: string,
  timeZone: string,
): HTMLElement {
  const header = element("div", "dc-rtg-column-header");
  header.setAttribute("role", "columnheader");
  header.dataset.resourceId = column.resourceId;
  header.dataset.dayIndex = String(column.dayIndex);
  header.dataset.columnIndex = String(column.columnIndex);
  if (column.resource.display?.color) header.style.setProperty("--dc-rtg-resource-accent", column.resource.display.color);

  const date = element("span", "dc-rtg-column-date", new Intl.DateTimeFormat(locale, {
    weekday: "short", month: "short", day: "numeric", timeZone,
  }).format(column.day));
  const title = element("span", "dc-rtg-column-resource", column.resource.title);
  if (column.resource.display?.icon) {
    const icon = element("span", "dc-rtg-column-icon", column.resource.display.icon);
    icon.setAttribute("aria-hidden", "true");
    title.prepend(icon);
  }
  header.append(date, title);
  return header;
}

export function renderResourceTimeGridSurface(
  model: ResourceTimeGridSurfaceModel,
  actions: ResourceTimeGridSurfaceActions,
): HTMLElement {
  const { layout } = model;
  const surface = element("div", "dc-rtg-scroll");
  surface.tabIndex = 0;
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-label", `${model.ariaLabel}; scroll horizontally for resources and vertically for time`);

  if (!layout.columns.length) {
    const empty = element("div", "dc-rtg-empty", "No assignable resources in this range.");
    empty.setAttribute("role", "status");
    surface.append(empty);
    return surface;
  }

  if (model.interactionHelpId) {
    const help = element(
      "div",
      "dc-rtg-sr-only",
      "Use Alt+Up/Down to move in time and Alt+Left/Right to move between resource columns. Focus a resize handle and use Up/Down to resize.",
    );
    help.id = model.interactionHelpId;
    surface.append(help);
  }

  const template = gridTemplate(layout.columns.length, model.minColumnWidth);
  const minWidth = 58 + layout.columns.length * model.minColumnWidth;
  const grid = element("div", "dc-rtg-grid");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", model.ariaLabel);
  grid.setAttribute("aria-colcount", String(layout.columns.length + 1));

  const header = element("div", "dc-rtg-row dc-rtg-header-row");
  header.setAttribute("role", "row");
  header.style.gridTemplateColumns = template;
  header.style.minWidth = `${minWidth}px`;
  const corner = element("div", "dc-rtg-corner", "Time");
  corner.setAttribute("role", "columnheader");
  header.append(corner);
  for (const column of layout.columns) header.append(columnHeader(column, model.locale, model.timeZone));

  const allDay = element("div", "dc-rtg-row dc-rtg-all-day-row");
  allDay.setAttribute("role", "row");
  allDay.style.gridTemplateColumns = template;
  allDay.style.minWidth = `${minWidth}px`;
  const allDayLabel = element("div", "dc-rtg-all-day-label", "All-day");
  allDayLabel.setAttribute("role", "rowheader");
  allDay.append(allDayLabel);
  const allDayByColumn = new Map<number, CalendarResourceTimeGridAllDayItem[]>();
  for (const item of layout.allDay) {
    const bucket = allDayByColumn.get(item.columnIndex) ?? [];
    bucket.push(item);
    allDayByColumn.set(item.columnIndex, bucket);
  }
  for (const column of layout.columns) {
    const cell = element("div", "dc-rtg-all-day-cell");
    cell.dataset.resourceId = column.resourceId;
    cell.dataset.dayIndex = String(column.dayIndex);
    cell.dataset.columnIndex = String(column.columnIndex);
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", `All-day events for ${column.resource.title}`);
    for (const item of allDayByColumn.get(column.columnIndex) ?? []) {
      cell.append(actions.renderAllDay(item, column));
    }
    allDay.append(cell);
  }

  const body = element("div", "dc-rtg-row dc-rtg-body-row");
  body.setAttribute("role", "row");
  body.style.gridTemplateColumns = template;
  body.style.minWidth = `${minWidth}px`;
  const bodyHeight = (layout.endMinute - layout.startMinute) * model.pixelsPerMinute;

  const axis = element("div", "dc-rtg-time-axis");
  axis.style.height = `${bodyHeight}px`;
  axis.setAttribute("role", "rowheader");
  axis.setAttribute("aria-label", `Time axis in ${model.timeZone}`);
  const firstTick = Math.ceil(layout.startMinute / model.axisTickMinutes) * model.axisTickMinutes;
  for (let minute = firstTick; minute < layout.endMinute; minute += model.axisTickMinutes) {
    const tick = element("div", "dc-rtg-time-label", wallClockLabel(minute, model.locale));
    tick.style.top = `${(minute - layout.startMinute) * model.pixelsPerMinute}px`;
    axis.append(tick);
  }
  body.append(axis);

  const timedByColumn = new Map<number, CalendarResourceTimeGridLayoutItem[]>();
  for (const item of layout.timed) {
    const bucket = timedByColumn.get(item.columnIndex) ?? [];
    bucket.push(item);
    timedByColumn.set(item.columnIndex, bucket);
  }
  const availabilityByColumn = new Map<number, typeof layout.availability[number][]>();
  for (const item of layout.availability) {
    const bucket = availabilityByColumn.get(item.columnIndex) ?? [];
    bucket.push(item);
    availabilityByColumn.set(item.columnIndex, bucket);
  }

  for (const column of layout.columns) {
    const cell = element("div", "dc-rtg-time-column");
    cell.style.height = `${bodyHeight}px`;
    cell.style.setProperty("--dc-rtg-tick-px", `${model.axisTickMinutes * model.pixelsPerMinute}px`);
    cell.dataset.resourceId = column.resourceId;
    cell.dataset.dayIndex = String(column.dayIndex);
    cell.dataset.columnIndex = String(column.columnIndex);
    cell.dataset.dayKey = column.dayKey;
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", `Timed events for ${column.resource.title}, ${column.dayKey}`);

    for (const item of availabilityByColumn.get(column.columnIndex) ?? []) {
      const background = element("div", `dc-rtg-availability is-${item.availability.state}`);
      background.dataset.availabilityId = item.availability.id;
      background.style.top = `${(item.topMinutes - layout.startMinute) * model.pixelsPerMinute}px`;
      background.style.height = `${item.heightMinutes * model.pixelsPerMinute}px`;
      if (item.availability.display?.color) background.style.setProperty("--dc-rtg-availability-bg", item.availability.display.color);
      if (item.availability.label) {
        background.append(element("span", "dc-rtg-availability-label", item.availability.label));
        background.setAttribute("role", "note");
      } else {
        background.setAttribute("aria-hidden", "true");
      }
      cell.append(background);
    }
    for (const item of timedByColumn.get(column.columnIndex) ?? []) {
      cell.append(actions.renderTimed(item, column));
    }
    body.append(cell);
  }

  grid.append(header, allDay, body);
  surface.append(grid);
  return surface;
}
