import type { CalendarItem, CalendarProjectionProvider, CalendarRange, CalendarRepository, ISODateTime } from "../core/types.js";
import { toDate } from "../core/time.js";
import type { RevisionDirectorCalendarInput } from "../adapters/revision-director.js";
import { RevisionDirectorProjection } from "../adapters/revision-director.js";
import type { CalendarUiExtension } from "../view/types.js";
import type { CalendarIntegrationInvalidationPort } from "./common.js";
import { subscribeCalendarIntegrationInvalidation } from "./common.js";
import { createCalendarIntegrationId } from "./id.js";

export interface RevisionDirectorCalendarReadPort {
  /** Host-owned range-scoped projection; host resolves domain joins before this boundary. */
  readCalendar(range: CalendarRange): RevisionDirectorCalendarInput | Promise<RevisionDirectorCalendarInput>;
  /** Native host subscription or a controller-owned CalendarIntegrationInvalidationNotifier. */
  readonly calendarInvalidation?: CalendarIntegrationInvalidationPort;
}

export interface RevisionDirectorCalendarActionPort {
  markReviewTargetsStarted?(targets: string[], now: Date): Promise<void> | void;
}

export interface RevisionDirectorCalendarHost extends RevisionDirectorCalendarReadPort, RevisionDirectorCalendarActionPort {}

export interface RevisionScheduleRequest {
  readonly obligationId: string;
  readonly title: string;
  readonly start: ISODateTime;
  readonly durationMinutes: number;
  readonly dueAt: ISODateTime;
  readonly subject?: string;
  readonly examId?: string;
  readonly chunkId?: string;
}

/** Revision due presentation driven by Calendar's semantic render clock, never ambient wall time. */
export function createRevisionDirectorPresentationExtension(): CalendarUiExtension {
  let nowMs = Number.NaN;
  return {
    styles: ".revision-director-overdue{box-shadow:inset 3px 0 0 var(--dc-danger)}",
    prepare(context) { nowMs = context.now.getTime(); },
    presentOccurrence(occurrence) {
      if (occurrence.calendarId !== "revision-director:due") return undefined;
      const dueAt = occurrence.metadata?.dueAt;
      const dueMs = typeof dueAt === "string" ? Date.parse(dueAt) : Number.NaN;
      if (!Number.isFinite(nowMs) || !Number.isFinite(dueMs) || dueMs >= nowMs) return undefined;
      return {
        classNames: ["revision-director-overdue"],
        badges: [{ label: "Overdue" }],
      };
    },
  };
}

/** Calendar-owned placement for revision work. It never mutates Revision Director dueAt. */
export class RevisionCalendarScheduler {
  public constructor(
    private readonly repository: CalendarRepository,
    private readonly host?: RevisionDirectorCalendarActionPort,
  ) {}

  public async schedule(request: RevisionScheduleRequest): Promise<CalendarItem> {
    const start = toDate(request.start);
    const end = new Date(start.getTime() + Math.max(1, request.durationMinutes) * 60_000);
    const id = `revision-scheduled:${createCalendarIntegrationId()}`;
    const item: CalendarItem = {
      id,
      calendarId: "revision-director:scheduled",
      title: request.title,
      start: start.toISOString(),
      end: end.toISOString(),
      kind: "revision",
      ownership: "revision-plan",
      editPolicy: "schedule-only",
      metadata: {
        app: "revision-director",
        sourceId: request.obligationId,
        dueAt: request.dueAt,
        plannedMinutes: request.durationMinutes,
        subject: request.subject,
        examId: request.examId,
        chunkId: request.chunkId,
        scheduleAuthority: "director-calendar",
      },
    };
    await this.repository.create(item);
    return item;
  }

  public async markStarted(item: CalendarItem, now = new Date()): Promise<void> {
    if (item.calendarId !== "revision-director:scheduled" || item.ownership !== "revision-plan" || item.editPolicy !== "schedule-only" || item.metadata?.app !== "revision-director") throw new Error("Not a scheduled revision item.");
    const obligationId = item.metadata.sourceId;
    if (typeof obligationId !== "string") throw new Error("Scheduled revision item has no obligation identity.");
    const chunkId = item.metadata.chunkId;
    const target = typeof chunkId === "string" && chunkId ? `chunk:${chunkId}` : obligationId;
    await this.host?.markReviewTargetsStarted?.([target], now);
  }
}

/** Built-in host adapter: host performs domain joins/range selection; Calendar maps the returned DTOs. */
export class RevisionDirectorLiveProjection extends RevisionDirectorProjection implements CalendarProjectionProvider {
  public constructor(private readonly host: RevisionDirectorCalendarReadPort) {
    super(range => host.readCalendar(range));
  }

  public subscribe(listener: () => void): () => void {
    return subscribeCalendarIntegrationInvalidation(this.host.calendarInvalidation, listener);
  }
}
