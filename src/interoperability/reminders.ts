import type { CalendarOccurrence, CalendarRange, CalendarReminder, ISODateTime } from "../core/types.js";
import { toDate } from "../core/time.js";

export interface DueCalendarReminder {
  readonly key: string;
  readonly occurrence: CalendarOccurrence;
  readonly reminder: CalendarReminder;
  readonly triggerAt: ISODateTime;
}

export interface ReminderReceiptClaim {
  readonly token: string;
  readonly claimedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}

export interface ReminderReceiptStore {
  /** Atomically reserve a reminder key. False means another live claim or a completed receipt already owns it. */
  claim(key: string, claim: ReminderReceiptClaim): Promise<boolean> | boolean;
  /** Mark a successfully delivered claim complete. Implementations must verify claim ownership. */
  complete(key: string, token: string, deliveredAt: ISODateTime): Promise<void> | void;
  /** Release a failed claim without disturbing a newer claimant or completed receipt. */
  release(key: string, token: string): Promise<void> | void;
  prune?(before: ISODateTime): Promise<void> | void;
}

type MemoryReminderReceipt =
  | { readonly state: "claimed"; readonly claim: ReminderReceiptClaim }
  | { readonly state: "delivered"; readonly deliveredAt: ISODateTime };

export class MemoryReminderReceiptStore implements ReminderReceiptStore {
  private readonly receipts = new Map<string, MemoryReminderReceipt>();

  public claim(key: string, claim: ReminderReceiptClaim): boolean {
    const existing = this.receipts.get(key);
    if (existing?.state === "delivered") return false;
    if (existing?.state === "claimed" && Date.parse(existing.claim.expiresAt) > Date.parse(claim.claimedAt)) return false;
    this.receipts.set(key, { state: "claimed", claim: structuredClone(claim) });
    return true;
  }

  public complete(key: string, token: string, deliveredAt: ISODateTime): void {
    const existing = this.receipts.get(key);
    if (existing?.state !== "claimed" || existing.claim.token !== token) {
      throw new Error("Reminder receipt claim is no longer owned by this delivery");
    }
    this.receipts.set(key, { state: "delivered", deliveredAt });
  }

  public release(key: string, token: string): void {
    const existing = this.receipts.get(key);
    if (existing?.state === "claimed" && existing.claim.token === token) this.receipts.delete(key);
  }

  public prune(before: ISODateTime): void {
    const cutoff = Date.parse(before);
    for (const [key, receipt] of this.receipts) {
      if (receipt.state === "delivered" && Date.parse(receipt.deliveredAt) < cutoff) this.receipts.delete(key);
    }
  }
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
  /** Crash-recovery lease for an in-flight delivery claim. Default 15 minutes. */
  readonly claimLeaseMinutes?: number | undefined;
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
      const delivery = this.options.deliveries.find(candidate => candidate.channel === reminder.reminder.channel);
      if (!delivery) { earliestFailedTrigger = minTime(earliestFailedTrigger, Date.parse(reminder.triggerAt)); continue; }

      const claim = reminderClaim(now, Math.max(1, this.options.claimLeaseMinutes ?? 15));
      if (!await this.options.receipts.claim(reminder.key, claim)) continue;
      let completed = false;
      try {
        if (await delivery.deliver(reminder)) {
          await this.options.receipts.complete(reminder.key, claim.token, now.toISOString());
          completed = true;
          delivered.push(reminder);
        } else earliestFailedTrigger = minTime(earliestFailedTrigger, Date.parse(reminder.triggerAt));
      } catch (error) {
        earliestFailedTrigger = minTime(earliestFailedTrigger, Date.parse(reminder.triggerAt));
        firstError ??= error;
      } finally {
        if (!completed) await this.options.receipts.release(reminder.key, claim.token);
      }
    }
    this.lastCheckAt = nowMs;
    this.retryFromMs = earliestFailedTrigger === null ? null : Math.max(nowMs - lookBack, earliestFailedTrigger - 1);
    if (firstError) throw firstError;
    return delivered;
  }
}

function reminderClaim(now: Date, leaseMinutes: number): ReminderReceiptClaim {
  const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
  return {
    token,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMinutes * 60_000).toISOString(),
  };
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
