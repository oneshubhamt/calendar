import type { CalendarOccurrence, CalendarSnapPolicy, CalendarSnapStrategy } from "../core/types.js";
import { resizePreview, snapMinuteCoordinate, type CalendarResizeEdge } from "../core/interaction.js";
import { toDate } from "../core/time.js";
import {
  CalendarPointerGestureController,
  type CalendarPointerGestureData,
  type CalendarPointerGestureMove,
  type CalendarPointerGestureSession,
} from "./pointer-gesture.js";

export type CalendarDragMode = "move" | "resize-start" | "resize-end";

export interface CalendarDragState {
  readonly occurrence: CalendarOccurrence;
  readonly mode: CalendarDragMode;
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
}

interface CalendarGestureData extends CalendarPointerGestureData {
  readonly occurrence: CalendarOccurrence;
  readonly mode: CalendarDragMode;
  readonly touch: boolean;
}

export interface CalendarGestureControllerOptions {
  readonly host: HTMLElement;
  readonly slotMinutes: number;
  readonly snapPolicy: Required<CalendarSnapPolicy>;
  readonly longPressMs: number;
  readonly autoScrollEdgePx: number;
  readonly autoScrollMaxPxPerFrame: number;
  readonly setDragging: (active: boolean) => void;
  readonly announce: (message: string) => void;
  readonly finishDrag: (pointer: PointerEvent, drag: CalendarDragState) => Promise<void>;
}

/**
 * Calendar-specific vertical drag adapter over the shared axis-neutral pointer
 * lifecycle. Placement geometry and mutation authority remain in CalendarUi.
 */
export class CalendarGestureController {
  private drag: CalendarDragState | null = null;
  private readonly pointer: CalendarPointerGestureController<CalendarGestureData>;

  public constructor(private readonly options: CalendarGestureControllerOptions) {
    this.pointer = new CalendarPointerGestureController<CalendarGestureData>({
      scrollElement: () => this.options.host.querySelector<HTMLElement>(".dc-body") ?? undefined,
      longPressMs: options.longPressMs,
      autoScrollEdgePx: options.autoScrollEdgePx,
      autoScrollMaxPxPerFrame: options.autoScrollMaxPxPerFrame,
      onArmingChange: (data, active) => data.element.classList.toggle("is-touch-arming", active),
      onActivate: session => this.activateDrag(session),
      onMove: (_session, move) => this.moveDrag(move),
      onFinish: async (_session, event) => await this.finishDrag(event),
      onCancel: () => this.cancelDragVisual(),
    });
  }

  public beginDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: CalendarDragMode): void {
    this.pointer.begin(pointer, {
      occurrence,
      mode,
      element,
      touch: pointer.pointerType === "touch",
    });
  }

  public shouldSuppressOccurrenceClick(): boolean {
    return this.pointer.shouldSuppressClick();
  }

  public isDragging(): boolean {
    return this.pointer.isActive();
  }

  public cancelActiveDrag(): void {
    this.pointer.cancel();
  }

  public destroy(): void {
    this.pointer.destroy();
  }

  private activateDrag(session: CalendarPointerGestureSession<CalendarGestureData>): void {
    const { occurrence, mode, element, touch } = session.data;
    const rect = element.getBoundingClientRect();
    element.classList.add("is-dragging");
    this.options.setDragging(true);
    this.drag = {
      occurrence,
      mode,
      pointerId: session.pointerId,
      pointerStartX: session.pointerStartX,
      pointerStartY: session.pointerStartY,
      originalStart: toDate(occurrence.start),
      originalEnd: toDate(occurrence.end),
      element,
      originalHeightCss: element.style.height,
      grabOffsetMinutes: Math.max(0, session.activationY - rect.top),
      scrollStartTop: session.scrollStartTop,
      scrollStartLeft: session.scrollStartLeft,
    };
    if (touch) {
      this.options.announce(`${mode === "move" ? "Moving" : "Resizing"} ${occurrence.title}. Drag, then release.`);
    }
  }

  private moveDrag(move: CalendarPointerGestureMove): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode !== "move") {
      const delta = snapDragDeltaMinutes(move.deltaY, this.options.slotMinutes, this.options.snapPolicy.resize);
      const renderedHeight = Number.parseFloat(drag.originalHeightCss);
      const duration = Number.isFinite(renderedHeight)
        ? Math.max(this.options.slotMinutes, renderedHeight)
        : this.options.slotMinutes;
      const preview = resizePreview(duration, delta, dragResizeEdge(drag.mode), this.options.slotMinutes);
      drag.element.style.transform = `translateY(${preview.offsetMinutes}px)`;
      drag.element.style.height = `${preview.heightMinutes}px`;
      return;
    }
    const snappedDelta = snapDragDeltaMinutes(move.deltaY, this.options.slotMinutes, this.options.snapPolicy.move);
    drag.element.style.transform = `translate(${move.deltaX}px,${snappedDelta}px)`;
  }

  private cancelDragVisual(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    restoreDragVisual(drag);
    this.options.setDragging(false);
    this.options.announce(`${drag.mode === "move" ? "Move" : "Resize"} cancelled for ${drag.occurrence.title}.`);
  }

  private async finishDrag(pointer: PointerEvent): Promise<void> {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.element.classList.remove("is-dragging");
    drag.element.classList.add("is-command-preview");
    this.options.setDragging(false);
    try {
      await this.options.finishDrag(pointer, drag);
    } finally {
      restoreDragVisual(drag);
    }
  }
}

export function dragResizeEdge(mode: Exclude<CalendarDragMode, "move">): CalendarResizeEdge {
  return mode === "resize-start" ? "start" : "end";
}

export function snapDragDeltaMinutes(deltaPixels: number, slotMinutes: number, strategy: CalendarSnapStrategy): number {
  if (strategy === "none") return Math.round(deltaPixels);
  return snapMinuteCoordinate(deltaPixels, slotMinutes, strategy);
}

function restoreDragVisual(drag: CalendarDragState): void {
  drag.element.classList.remove("is-dragging", "is-command-preview");
  drag.element.style.transform = "";
  drag.element.style.height = drag.originalHeightCss;
}
