import type { CalendarBackgroundRange, CalendarOccurrence } from "../core/types.js";
import {
  horizontalTimelineTicks,
  layoutHorizontalTimeline,
  resolveHorizontalTimelineRangeGeometry,
} from "../core/horizontal-timeline.js";
import {
  moveOccurrenceByCivilMinutes,
  resizeOccurrenceByCivilMinutes,
  snapMinuteCoordinate,
} from "../core/interaction.js";
import { addDays, startOfDay } from "../core/time.js";
import {
  CalendarPointerGestureController,
  type CalendarPointerGestureData,
  type CalendarPointerGestureMove,
} from "./pointer-gesture.js";
import type {
  CalendarCustomViewPlugin,
  CalendarCustomViewRenderContext,
  CalendarPresentationContent,
  CalendarSelection,
  CalendarViewNavigationContext,
  CalendarViewTitleContext,
} from "./types.js";

export interface CalendarTimelineViewOptions {
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  /** Civil days displayed from the anchor's local day. Defaults to 7. */
  readonly spanDays?: number | undefined;
  /** Civil days advanced by previous/next. Defaults to spanDays. */
  readonly stepDays?: number | undefined;
  /** Horizontal scale. Defaults to 72 CSS px/hour. */
  readonly pixelsPerHour?: number | undefined;
  /** Minimum scrollable timeline width. Defaults to 960px. */
  readonly minWidth?: number | undefined;
  /** Requested axis tick interval. Defaults to 360 minutes. */
  readonly axisTickMinutes?: number | undefined;
  /** Vertical lane height. Defaults to 32px. */
  readonly eventHeight?: number | undefined;
  /** Minimum event-track height. Defaults to 160px. */
  readonly minTrackHeight?: number | undefined;
}

interface ResolvedTimelineOptions {
  readonly id: string;
  readonly label: string;
  readonly spanDays: number;
  readonly stepDays: number;
  readonly pixelsPerHour: number;
  readonly minWidth: number;
  readonly axisTickMinutes: number;
  readonly eventHeight: number;
  readonly minTrackHeight: number;
}

interface TimelineGestureData extends CalendarPointerGestureData {
  readonly occurrence: CalendarOccurrence;
  readonly mode: "move" | "resize-start" | "resize-end";
  readonly scale: number;
  readonly originalLeft: number;
  readonly originalWidth: number;
  readonly touch: boolean;
}

interface TimelineDragPreview {
  readonly data: TimelineGestureData;
  deltaMinutes: number;
}

const OPTION_KEYS = new Set([
  "id",
  "label",
  "spanDays",
  "stepDays",
  "pixelsPerHour",
  "minWidth",
  "axisTickMinutes",
  "eventHeight",
  "minTrackHeight",
]);

function integer(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || Number(resolved) < minimum || Number(resolved) > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(resolved);
}

function positive(value: unknown, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be positive and finite`);
  }
  return resolved;
}

function resolveOptions(options: CalendarTimelineViewOptions = {}): ResolvedTimelineOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Timeline options must be an object");
  }
  if (Object.keys(options).some(key => !OPTION_KEYS.has(key))) {
    throw new TypeError("Timeline options contain an unexpected field");
  }
  const spanDays = integer(options.spanDays, 7, "Timeline spanDays", 1, 90);
  return Object.freeze({
    id: options.id ?? "timeline",
    label: options.label ?? "Timeline",
    spanDays,
    stepDays: integer(options.stepDays, spanDays, "Timeline stepDays", 1, 90),
    pixelsPerHour: positive(options.pixelsPerHour, 72, "Timeline pixelsPerHour"),
    minWidth: positive(options.minWidth, 960, "Timeline minWidth"),
    axisTickMinutes: positive(options.axisTickMinutes, 360, "Timeline axisTickMinutes"),
    eventHeight: positive(options.eventHeight, 32, "Timeline eventHeight"),
    minTrackHeight: positive(options.minTrackHeight, 160, "Timeline minTrackHeight"),
  });
}

function textContent(value: CalendarPresentationContent | undefined): string | undefined {
  return typeof value === "string" ? value : value?.text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timelineRange(context: CalendarViewNavigationContext, spanDays: number) {
  const start = startOfDay(context.anchor, context.timeZone);
  return Object.freeze({
    start: start.toISOString(),
    end: addDays(start, spanDays, context.timeZone).toISOString(),
  });
}

function timelineTitle(context: CalendarViewTitleContext, spanDays: number): string {
  const range = timelineRange(context, spanDays);
  const start = new Date(range.start);
  const endExclusive = new Date(range.end);
  const end = new Date(endExclusive.getTime() - 1);
  const formatter = new Intl.DateTimeFormat(context.locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: context.timeZone,
  });
  return spanDays === 1 ? formatter.format(start) : `${formatter.format(start)} – ${formatter.format(end)}`;
}

function selectionAtClientX(
  context: CalendarCustomViewRenderContext,
  geometry: ReturnType<typeof resolveHorizontalTimelineRangeGeometry>,
  track: HTMLElement,
  scale: number,
  clientX: number,
): CalendarSelection | undefined {
  const rect = track.getBoundingClientRect();
  const raw = clamp((clientX - rect.left) / scale, 0, geometry.widthMinutes);
  const minute = snapMinuteCoordinate(raw, context.slotMinutes, context.snapPolicy.selection);
  const start = geometry.instantAtCoordinate(minute, context.dstOverlapDisambiguation);
  const end = geometry.instantAtCoordinate(minute + context.slotMinutes, context.dstOverlapDisambiguation);
  if (!start || !end || end.getTime() <= start.getTime()) return undefined;
  return Object.freeze({ start: start.toISOString(), end: end.toISOString(), allDay: false });
}

function renderBackground(
  range: CalendarBackgroundRange,
  left: number,
  width: number,
  trackHeight: number,
): HTMLElement {
  const node = document.createElement("div");
  node.className = "dc-timeline-background";
  node.style.position = "absolute";
  node.style.left = `${left}px`;
  node.style.top = "0";
  node.style.width = `${Math.max(1, width)}px`;
  node.style.height = `${trackHeight}px`;
  node.style.pointerEvents = "none";
  node.style.borderInlineStart = "2px solid color-mix(in srgb,var(--dc-timeline-background-color,var(--dc-accent)) 30%,transparent)";
  node.style.background = "color-mix(in srgb,var(--dc-timeline-background-color,var(--dc-accent)) 10%,transparent)";
  node.style.zIndex = "0";
  if (range.display?.color) node.style.setProperty("--dc-timeline-background-color", range.display.color);
  if (range.label) {
    const label = document.createElement("span");
    label.textContent = range.label;
    label.style.position = "sticky";
    label.style.left = "4px";
    label.style.fontSize = "10px";
    label.style.color = "var(--dc-muted)";
    label.style.padding = "2px 4px";
    node.append(label);
  }
  return node;
}

function renderTimeline(
  context: CalendarCustomViewRenderContext,
  options: ResolvedTimelineOptions,
): HTMLElement {
  const geometry = resolveHorizontalTimelineRangeGeometry(context.visibleRange, context.timeZone);
  const timelineWidth = Math.max(options.minWidth, geometry.widthMinutes * options.pixelsPerHour / 60);
  const scale = timelineWidth / geometry.widthMinutes;
  const eventLayouts = layoutHorizontalTimeline(
    context.occurrences.map(occurrence => ({
      id: occurrence.occurrenceId,
      start: occurrence.start,
      end: occurrence.end,
      ...(occurrence.temporalForm === undefined ? {} : { temporalForm: occurrence.temporalForm }),
      value: occurrence,
    })),
    context.visibleRange,
    { timeZone: context.timeZone },
  );
  const laneCount = Math.max(1, ...eventLayouts.map(layout => layout.laneCount));
  const trackHeight = Math.max(options.minTrackHeight, laneCount * options.eventHeight + 24);

  const root = document.createElement("section");
  root.className = "dc-timeline";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${timelineTitle(context, options.spanDays)} timeline`);
  root.style.minHeight = "100%";
  root.style.background = "var(--dc-bg)";

  const scroll = document.createElement("div");
  scroll.className = "dc-timeline-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "Calendar timeline; scroll horizontally for time");
  scroll.style.overflow = "auto";
  scroll.style.position = "relative";
  scroll.style.maxWidth = "100%";

  const surface = document.createElement("div");
  surface.className = "dc-timeline-surface";
  surface.style.width = `${timelineWidth}px`;
  surface.style.minWidth = "100%";
  surface.style.position = "relative";

  const axis = document.createElement("div");
  axis.className = "dc-timeline-axis";
  axis.style.position = "sticky";
  axis.style.top = "0";
  axis.style.height = "42px";
  axis.style.zIndex = "6";
  axis.style.background = "var(--dc-bg)";
  axis.style.borderBottom = "1px solid var(--dc-border)";

  const includeDate = options.spanDays > 1;
  const tickFormatter = new Intl.DateTimeFormat(context.locale, {
    ...(includeDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone: context.timeZone,
  });
  for (const tickPoint of horizontalTimelineTicks(geometry, options.axisTickMinutes)) {
    const tick = document.createElement("div");
    tick.className = "dc-timeline-axis-tick";
    tick.textContent = tickFormatter.format(new Date(tickPoint.instant));
    tick.style.position = "absolute";
    tick.style.left = `${clamp(tickPoint.coordinate * scale, 0, timelineWidth)}px`;
    tick.style.top = "0";
    tick.style.height = "100%";
    tick.style.padding = "6px 5px";
    tick.style.borderInlineStart = "1px solid var(--dc-border)";
    tick.style.fontSize = "11px";
    tick.style.color = "var(--dc-muted)";
    tick.style.whiteSpace = "nowrap";
    tick.setAttribute("aria-hidden", "true");
    axis.append(tick);
  }

  const track = document.createElement("div");
  track.className = "dc-timeline-track";
  track.style.position = "relative";
  track.style.width = `${timelineWidth}px`;
  track.style.height = `${trackHeight}px`;
  track.style.background = "var(--dc-bg)";
  track.style.overflow = "hidden";
  track.setAttribute("aria-label", `${eventLayouts.length} calendar item${eventLayouts.length === 1 ? "" : "s"}`);

  const backgroundLayouts = layoutHorizontalTimeline(
    context.backgroundRanges.map((range, index) => ({
      id: `background:${index}:${range.id}`,
      start: range.start,
      end: range.end,
      laneGroup: range.id,
      value: range,
    })),
    context.visibleRange,
    { timeZone: context.timeZone },
  );
  for (const layout of backgroundLayouts) {
    track.append(renderBackground(layout.value, layout.xMinutes * scale, layout.widthMinutes * scale, trackHeight));
  }

  let activeDrag: TimelineDragPreview | undefined;
  const restorePreview = (): void => {
    const drag = activeDrag;
    activeDrag = undefined;
    if (!drag) return;
    drag.data.element.classList.remove("is-dragging", "is-command-preview");
    drag.data.element.style.transform = "";
    drag.data.element.style.width = `${drag.data.originalWidth}px`;
  };

  const pointer = new CalendarPointerGestureController<TimelineGestureData>({
    scrollElement: () => scroll,
    longPressMs: 420,
    autoScrollEdgePx: 48,
    autoScrollMaxPxPerFrame: 18,
    onArmingChange: (data, active) => data.element.classList.toggle("is-touch-arming", active),
    onActivate(session) {
      activeDrag = { data: session.data, deltaMinutes: 0 };
      session.data.element.classList.add("is-dragging");
      if (session.data.touch) {
        context.actions.announce(`${session.data.mode === "move" ? "Moving" : "Resizing"} ${session.data.occurrence.title}. Drag, then release.`);
      }
    },
    onMove(_session, move: CalendarPointerGestureMove) {
      const drag = activeDrag;
      if (!drag) return;
      const strategy = drag.data.mode === "move" ? context.snapPolicy.move : context.snapPolicy.resize;
      const deltaMinutes = snapMinuteCoordinate(move.deltaX / drag.data.scale, context.slotMinutes, strategy);
      drag.deltaMinutes = deltaMinutes;
      const dx = deltaMinutes * drag.data.scale;
      if (drag.data.mode === "move") {
        drag.data.element.style.transform = `translateX(${dx}px)`;
      } else if (drag.data.mode === "resize-start") {
        drag.data.element.style.transform = `translateX(${dx}px)`;
        drag.data.element.style.width = `${Math.max(1, drag.data.originalWidth - dx)}px`;
      } else {
        drag.data.element.style.width = `${Math.max(1, drag.data.originalWidth + dx)}px`;
      }
    },
    async onFinish() {
      const drag = activeDrag;
      if (!drag) return;
      drag.data.element.classList.remove("is-dragging");
      drag.data.element.classList.add("is-command-preview");
      try {
        if (!drag.deltaMinutes) return;
        if (drag.data.mode === "move") {
          const candidate = moveOccurrenceByCivilMinutes(
            drag.data.occurrence,
            drag.deltaMinutes,
            context.timeZone,
            context.dstOverlapDisambiguation,
          );
          if (!candidate) {
            context.actions.announce("Move is unavailable because that local time does not exist.");
            return;
          }
          await context.actions.moveOccurrence(drag.data.occurrence, candidate.start);
        } else {
          const edge = drag.data.mode === "resize-start" ? "start" : "end";
          const candidate = resizeOccurrenceByCivilMinutes(
            drag.data.occurrence,
            edge,
            drag.deltaMinutes,
            context.slotMinutes,
            context.timeZone,
            context.dstOverlapDisambiguation,
          );
          if (!candidate) {
            context.actions.announce("Resize is unavailable because that local time does not exist.");
            return;
          }
          await context.actions.resizeOccurrence(drag.data.occurrence, edge, candidate[edge]);
        }
      } finally {
        restorePreview();
      }
    },
    onCancel() {
      const title = activeDrag?.data.occurrence.title;
      restorePreview();
      if (title) context.actions.announce(`Timeline change cancelled for ${title}.`);
    },
  });

  const keyboardMove = async (occurrence: CalendarOccurrence, direction: -1 | 1): Promise<void> => {
    const candidate = moveOccurrenceByCivilMinutes(
      occurrence,
      direction * context.snapPolicy.keyboardStepMinutes,
      context.timeZone,
      context.dstOverlapDisambiguation,
    );
    if (!candidate) {
      context.actions.announce("Move is unavailable because that local time does not exist.");
      return;
    }
    await context.actions.moveOccurrence(occurrence, candidate.start);
  };

  const keyboardResize = async (
    occurrence: CalendarOccurrence,
    edge: "start" | "end",
    direction: -1 | 1,
  ): Promise<void> => {
    const candidate = resizeOccurrenceByCivilMinutes(
      occurrence,
      edge,
      direction * context.snapPolicy.keyboardStepMinutes,
      context.slotMinutes,
      context.timeZone,
      context.dstOverlapDisambiguation,
    );
    if (!candidate) {
      context.actions.announce("Resize is unavailable because that local time does not exist.");
      return;
    }
    await context.actions.resizeOccurrence(occurrence, edge, candidate[edge]);
  };

  for (const layout of eventLayouts) {
    const occurrence = layout.value;
    const presentation = context.actions.occurrencePresentation(occurrence);
    const event = document.createElement("div");
    event.className = "dc-timeline-event";
    for (const token of presentation.classNames) event.classList.add(token);
    if (layout.temporalForm === "point") event.classList.add("is-point");
    event.tabIndex = 0;
    event.setAttribute("role", context.actions.canOpenOccurrence(occurrence) ? "button" : "group");
    event.dataset.occurrenceId = occurrence.occurrenceId;
    event.style.position = "absolute";
    event.style.left = `${clamp(layout.xMinutes * scale, 0, timelineWidth)}px`;
    event.style.top = `${8 + layout.lane * options.eventHeight}px`;
    event.style.width = `${layout.temporalForm === "point" ? 10 : Math.max(20, layout.widthMinutes * scale)}px`;
    event.style.height = `${Math.max(22, options.eventHeight - 4)}px`;
    event.style.zIndex = "2";
    event.style.boxSizing = "border-box";
    event.style.border = "1px solid color-mix(in srgb,var(--dc-timeline-event-color,var(--dc-accent)) 35%,transparent)";
    event.style.borderRadius = layout.temporalForm === "point" ? "50%" : "6px";
    event.style.background = occurrence.display?.color ?? "color-mix(in srgb,var(--dc-accent) 14%,var(--dc-bg))";
    event.style.color = occurrence.display?.textColor ?? "var(--dc-text)";
    event.style.padding = layout.temporalForm === "point" ? "0" : "3px 6px";
    event.style.overflow = "hidden";
    event.style.whiteSpace = "nowrap";
    event.style.textOverflow = "ellipsis";
    event.style.cursor = context.actions.canMoveOccurrence(occurrence) ? "grab" : "default";
    const title = textContent(presentation.title) ?? occurrence.title;
    event.textContent = layout.temporalForm === "point" ? "" : title;
    event.title = title;
    event.setAttribute("aria-label", presentation.accessibleLabel ?? title);
    if (context.actions.isOccurrencePending(occurrence)) {
      event.setAttribute("aria-busy", "true");
      event.style.opacity = ".62";
    }

    const begin = (pointerEvent: PointerEvent, mode: TimelineGestureData["mode"]): void => {
      if (mode === "move" && !context.actions.canMoveOccurrence(occurrence)) return;
      if (mode === "resize-start" && !context.actions.canResizeOccurrence(occurrence, "start")) return;
      if (mode === "resize-end" && !context.actions.canResizeOccurrence(occurrence, "end")) return;
      pointer.begin(pointerEvent, {
        element: event,
        occurrence,
        mode,
        scale,
        originalLeft: Number.parseFloat(event.style.left),
        originalWidth: Number.parseFloat(event.style.width),
        touch: pointerEvent.pointerType === "touch",
      });
    };
    event.addEventListener("pointerdown", e => begin(e, "move"));
    event.addEventListener("click", e => {
      if (pointer.shouldSuppressClick()) {
        e.preventDefault();
        return;
      }
      if (context.actions.canOpenOccurrence(occurrence)) void context.actions.openOccurrence(occurrence);
    });
    event.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && context.actions.canOpenOccurrence(occurrence)) {
        e.preventDefault();
        void context.actions.openOccurrence(occurrence);
        return;
      }
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const direction = e.key === "ArrowRight" ? 1 : -1;
      if (e.shiftKey) void keyboardResize(occurrence, "end", direction);
      else void keyboardMove(occurrence, direction);
    });

    if (layout.temporalForm !== "point") {
      for (const edge of ["start", "end"] as const) {
        if (!context.actions.canResizeOccurrence(occurrence, edge)) continue;
        const handle = document.createElement("span");
        handle.className = `dc-timeline-resize-handle is-${edge}`;
        handle.tabIndex = 0;
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-label", `Resize ${edge} of ${occurrence.title}`);
        handle.style.position = "absolute";
        handle.style.top = "0";
        handle.style.bottom = "0";
        handle.style.width = "8px";
        handle.style[edge === "start" ? "left" : "right"] = "0";
        handle.style.cursor = "ew-resize";
        handle.addEventListener("pointerdown", e => {
          e.stopPropagation();
          begin(e, edge === "start" ? "resize-start" : "resize-end");
        });
        handle.addEventListener("click", e => e.stopPropagation());
        handle.addEventListener("keydown", e => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          void keyboardResize(occurrence, edge, e.key === "ArrowRight" ? 1 : -1);
        });
        event.append(handle);
      }
    }
    track.append(event);
  }

  if (context.actions.canCreateItems()) {
    context.actions.bindExternalDropTarget(track, event =>
      selectionAtClientX(context, geometry, track, scale, event.clientX));
    track.addEventListener("dblclick", event => {
      if ((event.target as Element).closest(".dc-timeline-event")) return;
      const selection = selectionAtClientX(context, geometry, track, scale, event.clientX);
      if (selection) void context.actions.createFromSelection(selection);
    });
  }

  surface.append(axis, track);
  scroll.append(surface);
  root.append(scroll);
  return root;
}

export function createTimelineView(options: CalendarTimelineViewOptions = {}): CalendarCustomViewPlugin {
  const resolved = resolveOptions(options);
  return Object.freeze({
    id: resolved.id,
    label: resolved.label,
    includeBackgroundRanges: true,
    range(context: CalendarViewNavigationContext) {
      return timelineRange(context, resolved.spanDays);
    },
    shiftAnchor(context: CalendarViewNavigationContext, direction: 1 | -1) {
      return addDays(startOfDay(context.anchor, context.timeZone), direction * resolved.stepDays, context.timeZone);
    },
    title(context: CalendarViewTitleContext) {
      return timelineTitle(context, resolved.spanDays);
    },
    render(context: CalendarCustomViewRenderContext) {
      return renderTimeline(context, resolved);
    },
  });
}
