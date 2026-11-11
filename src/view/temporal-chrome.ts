import type { CalendarClock } from "../core/time.js";
import { civilMinuteOfInstant } from "../core/civil-timeline.js";
import { dateKey, toDate } from "../core/time.js";

export interface CalendarTemporalChromeOptions {
  readonly host: HTMLElement;
  readonly clock: CalendarClock;
  readonly timeZone: string;
  readonly dayStartHour: number;
  readonly dayEndHour: number;
  readonly showNowIndicator: boolean;
  readonly onTick?: (now: Date) => void;
}

/**
 * Maintains time-sensitive DOM chrome without re-querying Calendar data.
 * Rendering marks date-bearing nodes with data-calendar-date; this controller
 * updates today classes and the current-time line on aligned minute ticks.
 */
export class CalendarTemporalChrome {
  private timer: number | null = null;

  public constructor(private readonly options: CalendarTemporalChromeOptions) {}

  public start(): void {
    this.stop();
    this.refresh();
    this.schedule();
  }

  public stop(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  public refresh(): void {
    const now = this.options.clock.now();
    const today = dateKey(now, this.options.timeZone);
    for (const node of this.options.host.querySelectorAll<HTMLElement>("[data-calendar-date]")) {
      const raw = node.dataset.calendarDate;
      if (!raw) continue;
      node.classList.toggle("is-today", dateKey(toDate(raw), this.options.timeZone) === today);
    }

    for (const marker of this.options.host.querySelectorAll<HTMLElement>(".dc-now")) marker.remove();
    if (this.options.showNowIndicator) {
      for (const column of this.options.host.querySelectorAll<HTMLElement>(".dc-time-column[data-calendar-date]")) {
        const raw = column.dataset.calendarDate;
        if (!raw || column.classList.contains("is-out-of-bounds")) continue;
        const day = toDate(raw);
        if (dateKey(day, this.options.timeZone) !== today) continue;
        const minute = civilMinuteOfInstant(now, day, this.options.timeZone) - this.options.dayStartHour * 60;
        const visibleMinutes = (this.options.dayEndHour - this.options.dayStartHour) * 60;
        if (minute < 0 || minute > visibleMinutes) continue;
        const marker = document.createElement("div");
        marker.className = "dc-now";
        marker.setAttribute("aria-hidden", "true");
        marker.style.top = `${minute}px`;
        column.append(marker);
      }
    }
    this.options.onTick?.(now);
  }

  private schedule(): void {
    const nowMs = this.options.clock.now().getTime();
    const delay = Math.max(50, 60_000 - (nowMs % 60_000) + 5);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh();
      this.schedule();
    }, delay);
  }
}
