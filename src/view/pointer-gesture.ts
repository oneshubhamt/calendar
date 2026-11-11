export interface CalendarPointerGestureData {
  readonly element: HTMLElement;
}

export interface CalendarPointerGestureSession<T extends CalendarPointerGestureData> {
  readonly pointerId: number;
  readonly data: T;
  readonly pointerStartX: number;
  readonly pointerStartY: number;
  readonly activationX: number;
  readonly activationY: number;
  readonly scrollStartLeft: number;
  readonly scrollStartTop: number;
  lastClientX: number;
  lastClientY: number;
}

export interface CalendarPointerGestureMove {
  readonly clientX: number;
  readonly clientY: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly scrollDeltaX: number;
  readonly scrollDeltaY: number;
}

export interface CalendarPointerGestureControllerOptions<T extends CalendarPointerGestureData> {
  readonly scrollElement: () => HTMLElement | undefined;
  readonly longPressMs: number;
  readonly armThresholdPx?: number | undefined;
  readonly touchCancelDistancePx?: number | undefined;
  readonly autoScrollEdgePx: number;
  readonly autoScrollMaxPxPerFrame: number;
  readonly onArmingChange?: ((data: T, active: boolean) => void) | undefined;
  readonly onActivate: (session: CalendarPointerGestureSession<T>) => void;
  readonly onMove: (
    session: CalendarPointerGestureSession<T>,
    move: CalendarPointerGestureMove,
  ) => void;
  readonly onFinish: (
    session: CalendarPointerGestureSession<T>,
    event: PointerEvent,
  ) => void | Promise<void>;
  readonly onCancel: (session: CalendarPointerGestureSession<T>) => void;
}

/**
 * Axis-neutral pointer/touch lifecycle shared by Calendar-owned scheduling surfaces.
 * It owns arming, touch long-press, cancellation, pointer capture and frame-based
 * edge auto-scroll; callers own all temporal/spatial geometry and mutation semantics.
 */
export class CalendarPointerGestureController<T extends CalendarPointerGestureData> {
  private session: CalendarPointerGestureSession<T> | null = null;
  private pointerArmCleanup: (() => void) | null = null;
  private touchPress: {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    lastX: number;
    lastY: number;
    readonly timer: number;
    readonly data: T;
  } | null = null;
  private touchListenerCleanup: (() => void) | null = null;
  private activeListenerCleanup: (() => void) | null = null;
  private autoScrollFrame: number | null = null;
  private suppressClickUntil = 0;

  public constructor(private readonly options: CalendarPointerGestureControllerOptions<T>) {
    if (!Number.isFinite(options.longPressMs) || options.longPressMs < 0) {
      throw new RangeError("Pointer gesture longPressMs must be non-negative and finite");
    }
    if (!Number.isFinite(options.autoScrollEdgePx) || options.autoScrollEdgePx <= 0) {
      throw new RangeError("Pointer gesture autoScrollEdgePx must be positive and finite");
    }
    if (!Number.isFinite(options.autoScrollMaxPxPerFrame) || options.autoScrollMaxPxPerFrame <= 0) {
      throw new RangeError("Pointer gesture autoScrollMaxPxPerFrame must be positive and finite");
    }
  }

  public begin(pointer: PointerEvent, data: T): void {
    if (pointer.button !== 0 || this.session) return;
    pointer.stopPropagation();
    if (pointer.pointerType === "touch") this.armTouch(pointer, data);
    else this.armPointer(pointer, data);
  }

  public isActive(): boolean {
    return this.session !== null;
  }

  public shouldSuppressClick(): boolean {
    return Date.now() <= this.suppressClickUntil;
  }

  public cancel(): void {
    this.cancelPointerArm();
    this.cancelTouchPress();
    const session = this.session;
    if (!session) return;
    this.cleanupActive(session);
    this.options.onCancel(session);
  }

  public destroy(): void {
    this.cancel();
    this.stopAutoScroll();
  }

  private armPointer(pointer: PointerEvent, data: T): void {
    this.cancelPointerArm();
    const pointerId = pointer.pointerId;
    const startX = pointer.clientX;
    const startY = pointer.clientY;
    const threshold = this.options.armThresholdPx ?? 4;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < threshold) return;
      event.preventDefault();
      cleanup();
      this.activate(pointerId, startX, startY, event.clientX, event.clientY, data);
      this.dispatchMove(event.clientX, event.clientY);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId === pointerId) cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (this.pointerArmCleanup === cleanup) this.pointerArmCleanup = null;
    };
    this.pointerArmCleanup = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  private armTouch(pointer: PointerEvent, data: T): void {
    this.cancelTouchPress();
    const pointerId = pointer.pointerId;
    const startX = pointer.clientX;
    const startY = pointer.clientY;
    this.options.onArmingChange?.(data, true);
    const timer = window.setTimeout(() => {
      const press = this.touchPress;
      if (!press || press.pointerId !== pointerId) return;
      this.touchPress = null;
      this.options.onArmingChange?.(press.data, false);
      this.touchListenerCleanup?.();
      this.activate(pointerId, startX, startY, press.lastX, press.lastY, data);
    }, this.options.longPressMs);
    this.touchPress = { pointerId, startX, startY, lastX: startX, lastY: startY, timer, data };

    const move = (event: PointerEvent) => {
      const press = this.touchPress;
      if (!press || event.pointerId !== press.pointerId) return;
      press.lastX = event.clientX;
      press.lastY = event.clientY;
      const cancelDistance = this.options.touchCancelDistancePx ?? 10;
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > cancelDistance) {
        this.cancelTouchPress();
      }
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      this.cancelTouchPress();
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (this.touchListenerCleanup === cleanup) this.touchListenerCleanup = null;
    };
    this.touchListenerCleanup = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  private activate(
    pointerId: number,
    pointerStartX: number,
    pointerStartY: number,
    activationX: number,
    activationY: number,
    data: T,
  ): void {
    this.cancelTouchPress();
    this.cancelPointerArm();
    const scroll = this.options.scrollElement();
    const session: CalendarPointerGestureSession<T> = {
      pointerId,
      data,
      pointerStartX,
      pointerStartY,
      activationX,
      activationY,
      scrollStartLeft: scroll?.scrollLeft ?? 0,
      scrollStartTop: scroll?.scrollTop ?? 0,
      lastClientX: activationX,
      lastClientY: activationY,
    };
    try { data.element.setPointerCapture(pointerId); } catch { /* capture may be unavailable after synthetic transitions */ }
    this.session = session;
    this.options.onActivate(session);

    const move = (event: PointerEvent) => {
      if (!this.session || event.pointerId !== this.session.pointerId) return;
      event.preventDefault();
      this.dispatchMove(event.clientX, event.clientY);
    };
    const finish = (event: PointerEvent) => {
      const active = this.session;
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      this.cleanupActive(active);
      void this.options.onFinish(active, event);
    };
    const cancel = (event: PointerEvent) => {
      const active = this.session;
      if (!active || event.pointerId !== active.pointerId) return;
      this.cleanupActive(active);
      this.options.onCancel(active);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      if (this.activeListenerCleanup === cleanup) this.activeListenerCleanup = null;
    };
    this.activeListenerCleanup = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
    this.startAutoScroll();
  }

  private dispatchMove(clientX: number, clientY: number): void {
    const session = this.session;
    if (!session) return;
    session.lastClientX = clientX;
    session.lastClientY = clientY;
    const scroll = this.options.scrollElement();
    const scrollDeltaX = (scroll?.scrollLeft ?? 0) - session.scrollStartLeft;
    const scrollDeltaY = (scroll?.scrollTop ?? 0) - session.scrollStartTop;
    this.options.onMove(session, {
      clientX,
      clientY,
      deltaX: clientX - session.pointerStartX + scrollDeltaX,
      deltaY: clientY - session.pointerStartY + scrollDeltaY,
      scrollDeltaX,
      scrollDeltaY,
    });
  }

  private cleanupActive(session: CalendarPointerGestureSession<T>): void {
    this.activeListenerCleanup?.();
    this.session = null;
    this.stopAutoScroll();
    this.suppressClickUntil = Date.now() + 350;
    if (session.data.element.hasPointerCapture(session.pointerId)) {
      try { session.data.element.releasePointerCapture(session.pointerId); } catch { /* no-op */ }
    }
  }

  private cancelPointerArm(): void {
    this.pointerArmCleanup?.();
  }

  private cancelTouchPress(): void {
    const press = this.touchPress;
    if (press) {
      clearTimeout(press.timer);
      this.options.onArmingChange?.(press.data, false);
      this.touchPress = null;
    }
    this.touchListenerCleanup?.();
  }

  private startAutoScroll(): void {
    if (this.autoScrollFrame !== null) return;
    const tick = () => {
      this.autoScrollFrame = null;
      const session = this.session;
      const scroll = this.options.scrollElement();
      if (!session || !scroll) return;
      const rect = scroll.getBoundingClientRect();
      const edge = this.options.autoScrollEdgePx;
      const max = this.options.autoScrollMaxPxPerFrame;
      let vx = 0;
      let vy = 0;
      if (session.lastClientX < rect.left + edge) {
        const ratio = Math.min(1, (rect.left + edge - session.lastClientX) / edge);
        vx = -Math.max(2, ratio * max);
      } else if (session.lastClientX > rect.right - edge) {
        const ratio = Math.min(1, (session.lastClientX - (rect.right - edge)) / edge);
        vx = Math.max(2, ratio * max);
      }
      if (session.lastClientY < rect.top + edge) {
        const ratio = Math.min(1, (rect.top + edge - session.lastClientY) / edge);
        vy = -Math.max(2, ratio * max);
      } else if (session.lastClientY > rect.bottom - edge) {
        const ratio = Math.min(1, (session.lastClientY - (rect.bottom - edge)) / edge);
        vy = Math.max(2, ratio * max);
      }
      if (vx || vy) {
        scroll.scrollLeft += vx;
        scroll.scrollTop += vy;
        this.dispatchMove(session.lastClientX, session.lastClientY);
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
}
