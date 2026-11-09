import type { CalendarOccurrence, CalendarRange, CalendarReminder, ISODateTime } from "../core/types.js";
import { toDate } from "../core/time.js";

export interface DueCalendarReminder {
  readonly key: string;
  readonly occurrence: CalendarOccurrence;
  readonly reminder: CalendarReminder;
  readonly triggerAt: ISODateTime;
}

export interface ReminderReceiptStore {
  has(key: string): Promise<boolean> | boolean;
  record(key: string, deliveredAt: ISODateTime): Promise<void> | void;
  prune?(before: ISODateTime): Promise<void> | void;
}

export class MemoryReminderReceiptStore implements ReminderReceiptStore {
  private readonly delivered = new Map<string, ISODateTime>();
  public has(key: string): boolean { return this.delivered.has(key); }
  public record(key: string, deliveredAt: ISODateTime): void { this.delivered.set(key, deliveredAt); }
  public prune(before: ISODateTime): void { const cutoff = Date.parse(before); for (const [key, at] of this.delivered) if (Date.parse(at) < cutoff) this.delivered.delete(key); }
}

export interface ReminderDeliveryPort {
  readonly channel: CalendarReminder["channel"];
  deliver(reminder: DueCalendarReminder): Promise<boolean> | boolean;
}

export interface InAppReminderMessage {
  readonly title: string;
  readonly body: string;
  readonly occurrenceId: string;
  readonly triggerAt: ISODateTime;
}

export class InAppReminderDelivery implements ReminderDeliveryPort {
  public readonly channel = "in-app" as const;
  public constructor(private readonly notify: (message: InAppReminderMessage) => Promise<void> | void) {}
  public async deliver(reminder: DueCalendarReminder): Promise<boolean> {
    await this.notify({ title: reminder.occurrence.title, body: reminderBody(reminder), occurrenceId: reminder.occurrence.occurrenceId, triggerAt: reminder.triggerAt });
    return true;
  }
}

export interface BrowserNotificationDeliveryOptions {
  readonly serviceWorkerRegistration?: ServiceWorkerRegistration | undefined;
  readonly icon?: string | undefined;
  readonly badge?: string | undefined;
  readonly tagPrefix?: string | undefined;
}

/** Delivery when the app/service worker is awake. This is intentionally not a browser-side alarm scheduler. */
export class BrowserNotificationDelivery implements ReminderDeliveryPort {
  public readonly channel = "browser" as const;
  public constructor(private readonly options: BrowserNotificationDeliveryOptions = {}) {}

  public async deliver(reminder: DueCalendarReminder): Promise<boolean> {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    const title = reminder.occurrence.title;
    const body = reminderBody(reminder);
    const tag = `${this.options.tagPrefix ?? "calendar"}:${reminder.key}`;
    if (this.options.serviceWorkerRegistration) {
      await this.options.serviceWorkerRegistration.showNotification(title, {
        body, tag,
        ...(this.options.icon ? { icon: this.options.icon } : {}),
        ...(this.options.badge ? { badge: this.options.badge } : {}),
        data: { occurrenceId: reminder.occurrence.occurrenceId, calendarItemId: reminder.occurrence.sourceItemId },
      });
      return true;
    }
    // Desktop browsers can display a page-owned notification while the page remains alive.
    new Notification(title, { body, tag, ...(this.options.icon ? { icon: this.options.icon } : {}) });
    return true;
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return await Notification.requestPermission();
}

export interface ReminderCalendarQueryPort {
  query(range: CalendarRange, options?: { readonly timeZone?: string | undefined }): Promise<{ readonly occurrences: readonly CalendarOccurrence[] }> | { readonly occurrences: readonly CalendarOccurrence[] };
}

export interface ReminderCoordinatorOptions {
  readonly engine: ReminderCalendarQueryPort;
  readonly receipts: ReminderReceiptStore;
  readonly deliveries: readonly ReminderDeliveryPort[];
  readonly timeZone?: string | undefined;
  /** Look back protects against throttled/paused foreground timers. */
  readonly lookBackMinutes?: number | undefined;
  /** Future event-start horizon needed to discover reminders that fire before the event. Default 28 days. */
  readonly lookAheadDays?: number | undefined;
}

export class ReminderCoordinator {
  private lastCheckAt: number | null = null;
  private retryFromMs: number | null = null;
  public constructor(private readonly options: ReminderCoordinatorOptions) {}

  public async check(now = new Date()): Promise<readonly DueCalendarReminder[]> {
    const nowMs = now.getTime();
    const lookBack = Math.max(1, this.options.lookBackMinutes ?? 15) * 60_000;
    if (this.retryFromMs !== null && nowMs - this.retryFromMs > lookBack) this.retryFromMs = null;
    const normalStart = this.lastCheckAt === null ? nowMs - lookBack : Math.min(this.lastCheckAt, nowMs - 1);
    const startMs = this.retryFromMs === null ? normalStart : Math.min(normalStart, this.retryFromMs);
    const lookAhead = Math.max(1, this.options.lookAheadDays ?? 28) * 24 * 60 * 60_000;
    const range: CalendarRange = { start: new Date(startMs - 60_000).toISOString(), end: new Date(nowMs + lookAhead).toISOString() };
    const query = await this.options.engine.query(range, { timeZone: this.options.timeZone });
    const due = collectDueReminders(query.occurrences, new Date(startMs), now);
    const delivered: DueCalendarReminder[] = [];
    let earliestFailedTrigger: number | null = null;
    let firstError: unknown = null;
    for (const reminder of due) {
      if (await this.options.receipts.has(reminder.key)) continue;
      const delivery = this.options.deliveries.find(candidate => candidate.channel === reminder.reminder.channel);
      if (!delivery) { earliestFailedTrigger = minTime(earliestFailedTrigger, Date.parse(reminder.triggerAt)); continue; }
      try {
        if (await delivery.deliver(reminder)) {
          await this.options.receipts.record(reminder.key, now.toISOString());
          delivered.push(reminder);
        } else earliestFailedTrigger = minTime(earliestFailedTrigger, Date.parse(reminder.triggerAt));
      } catch (error) {
        earliestFailedTrigger = minTime(earliestFailedTrigger, Date.parse(reminder.triggerAt));
        firstError ??= error;
      }
    }
    this.lastCheckAt = nowMs;
    this.retryFromMs = earliestFailedTrigger === null ? null : Math.max(nowMs - lookBack, earliestFailedTrigger - 1);
    if (firstError) throw firstError;
    return delivered;
  }
}

function minTime(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

export function collectDueReminders(occurrences: readonly CalendarOccurrence[], windowStart: Date, windowEnd: Date): DueCalendarReminder[] {
  const startMs = windowStart.getTime(), endMs = windowEnd.getTime();
  const due: DueCalendarReminder[] = [];
  for (const occurrence of occurrences) for (const reminder of occurrence.reminders ?? []) {
    if (reminder.enabled === false || reminder.channel === "external") continue;
    const triggerMs = toDate(occurrence.start).getTime() - Math.max(0, reminder.minutesBefore) * 60_000;
    if (triggerMs < startMs || triggerMs > endMs) continue;
    due.push({ key: reminderKey(occurrence, reminder), occurrence, reminder, triggerAt: new Date(triggerMs).toISOString() });
  }
  return due.sort((a, b) => Date.parse(a.triggerAt) - Date.parse(b.triggerAt));
}

export function reminderKey(occurrence: CalendarOccurrence, reminder: CalendarReminder): string {
  return `${occurrence.sourceItemId}|${occurrence.originalStart}|${reminder.id}|${reminder.minutesBefore}|${reminder.channel}`;
}

export const REMINDER_DELIVERY_STRATEGY = Object.freeze({
  foreground: "Use ReminderCoordinator while the PWA is running; it catches throttled timer gaps with a bounded look-back.",
  serviceWorker: "A service worker can present persistent notifications when it is already running/woken, but the calendar package does not assume a precise browser alarm API.",
  reliableClosedApp: "For reminders that must fire while the browser/app is fully closed, publish the event/reminder to an OS-backed calendar through iCalendar or Google Calendar and let that calendar own alarm delivery.",
} as const);

function reminderBody(reminder: DueCalendarReminder): string {
  const minutes = reminder.reminder.minutesBefore;
  return minutes === 0 ? "Starts now" : `Starts in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
