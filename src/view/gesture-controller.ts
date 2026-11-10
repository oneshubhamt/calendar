import type { CalendarOccurrence, CalendarSnapPolicy, CalendarSnapStrategy } from "../core/types.js";
import { resizePreview, snapMinuteCoordinate, type CalendarResizeEdge } from "../core/interaction.js";
import { toDate } from "../core/time.js";

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
  lastClientX: number;
  lastClientY: number;
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

/** DOM gesture lifecycle only. CalendarUi retains placement semantics and command authority. */
export class CalendarGestureController {
  private drag: CalendarDragState | null = null;
  private touchPress: {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    lastX: number;
    lastY: number;
    readonly timer: number;
    readonly occurrence: CalendarOccurrence;
    readonly element: HTMLElement;
    readonly mode: CalendarDragMode;
  } | null = null;
  private autoScrollFrame: number | null = null;
  private dragListenerCleanup: (() => void) | null = null;
  private pointerArmCleanup: (() => void) | null = null;
  private touchListenerCleanup: (() => void) | null = null;
  private suppressOccurrenceClickUntil = 0;

  public constructor(private readonly options: CalendarGestureControllerOptions) {}

  public beginDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: CalendarDragMode): void {
    if (pointer.button !== 0) return;
    pointer.stopPropagation();
    if (pointer.pointerType === "touch") this.armTouchDrag(pointer, occurrence, element, mode);
    else this.armPointerDrag(pointer, occurrence, element, mode);
  }

  public shouldSuppressOccurrenceClick(): boolean {
    return Date.now() <= this.suppressOccurrenceClickUntil;
  }

  public destroy(): void {
    this.cancelTouchPress();
    this.cancelPointerArm();
    this.cancelActiveDrag();
    this.stopAutoScroll();
  }

  private armPointerDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: CalendarDragMode): void {
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

  private armTouchDrag(pointer: PointerEvent, occurrence: CalendarOccurrence, element: HTMLElement, mode: CalendarDragMode): void {
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
      this.options.announce(`${mode === "move" ? "Moving" : "Resizing"} ${occurrence.title}. Drag, then release.`);
    }, this.options.longPressMs);
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

  private activateDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
    occurrence: CalendarOccurrence,
    element: HTMLElement,
    mode: CalendarDragMode,
  ): void {
    this.cancelTouchPress();
    const rect = element.getBoundingClientRect();
    try { element.setPointerCapture(pointerId); } catch { /* unavailable after some synthetic/browser transitions */ }
    element.classList.add("is-dragging");
    this.options.setDragging(true);
    const body = this.options.host.querySelector<HTMLElement>(".dc-body");
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
    restoreDragVisual(drag);
    this.options.setDragging(false);
    this.options.announce(`${drag.mode === "move" ? "Move" : "Resize"} cancelled for ${drag.occurrence.title}.`);
  }

  private moveDrag(pointer: Pick<PointerEvent, "clientX" | "clientY">): void {
    if (!this.drag) return;
    this.drag.lastClientX = pointer.clientX;
    this.drag.lastClientY = pointer.clientY;
    const body = this.options.host.querySelector<HTMLElement>(".dc-body");
    const scrollDelta = (body?.scrollTop ?? 0) - this.drag.scrollStartTop;
    const horizontalScrollDelta = (body?.scrollLeft ?? 0) - this.drag.scrollStartLeft;
    const rawDelta = pointer.clientY - this.drag.pointerStartY + scrollDelta;
    if (this.drag.mode !== "move") {
      const delta = snapDragDeltaMinutes(rawDelta, this.options.slotMinutes, this.options.snapPolicy.resize);
      const renderedHeight = Number.parseFloat(this.drag.originalHeightCss);
      const duration = Number.isFinite(renderedHeight) ? Math.max(this.options.slotMinutes, renderedHeight) : this.options.slotMinutes;
      const preview = resizePreview(duration, delta, dragResizeEdge(this.drag.mode), this.options.slotMinutes);
      this.drag.element.style.transform = `translateY(${preview.offsetMinutes}px)`;
      this.drag.element.style.height = `${preview.heightMinutes}px`;
      return;
    }
    const snappedDelta = snapDragDeltaMinutes(rawDelta, this.options.slotMinutes, this.options.snapPolicy.move);
    const deltaX = pointer.clientX - this.drag.pointerStartX + horizontalScrollDelta;
    this.drag.element.style.transform = `translate(${deltaX}px,${snappedDelta}px)`;
  }

  private startAutoScroll(): void {
    if (this.autoScrollFrame !== null) return;
    const tick = () => {
      this.autoScrollFrame = null;
      const drag = this.drag;
      const body = this.options.host.querySelector<HTMLElement>(".dc-body");
      if (!drag || !body) return;
      const rect = body.getBoundingClientRect();
      let verticalVelocity = 0;
      let horizontalVelocity = 0;
      if (drag.lastClientY < rect.top + this.options.autoScrollEdgePx) {
        const ratio = Math.min(1, (rect.top + this.options.autoScrollEdgePx - drag.lastClientY) / this.options.autoScrollEdgePx);
        verticalVelocity = -Math.max(2, ratio * this.options.autoScrollMaxPxPerFrame);
      } else if (drag.lastClientY > rect.bottom - this.options.autoScrollEdgePx) {
        const ratio = Math.min(1, (drag.lastClientY - (rect.bottom - this.options.autoScrollEdgePx)) / this.options.autoScrollEdgePx);
        verticalVelocity = Math.max(2, ratio * this.options.autoScrollMaxPxPerFrame);
      }
      if (drag.lastClientX < rect.left + this.options.autoScrollEdgePx) {
        const ratio = Math.min(1, (rect.left + this.options.autoScrollEdgePx - drag.lastClientX) / this.options.autoScrollEdgePx);
        horizontalVelocity = -Math.max(2, ratio * this.options.autoScrollMaxPxPerFrame);
      } else if (drag.lastClientX > rect.right - this.options.autoScrollEdgePx) {
        const ratio = Math.min(1, (drag.lastClientX - (rect.right - this.options.autoScrollEdgePx)) / this.options.autoScrollEdgePx);
        horizontalVelocity = Math.max(2, ratio * this.options.autoScrollMaxPxPerFrame);
      }
      if (verticalVelocity || horizontalVelocity) {
        body.scrollTop += verticalVelocity;
        body.scrollLeft += horizontalVelocity;
        this.moveDrag({ clientX: drag.lastClientX, clientY: drag.lastClientY });
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
