import type { CalendarItem, CalendarProjectionProvider, CalendarRange, CalendarRepository, ISODateTime } from "../core/types.js";
import { toDate } from "../core/time.js";
import type { PracticeDeskCalendarInput } from "../adapters/practice-desk.js";
import { PracticeDeskProjection } from "../adapters/practice-desk.js";
import type { CalendarIntegrationInvalidationPort } from "./common.js";
import { subscribeCalendarIntegrationInvalidation } from "./common.js";
import { createCalendarIntegrationId } from "./id.js";

/**
 * Calendar-facing Practice Desk projection only. Practice Desk resolves its own
 * learning and revision-scheduling state into flattened attempts/due cards before
 * this boundary; Calendar receives no scheduling-policy evidence.
 */
export type PracticeDeskCalendarProjectionInput =
  Readonly<Pick<PracticeDeskCalendarInput, "attempts" | "dueCards">>;

export interface PracticeDeskCalendarReadPort {
  readCalendar(range: CalendarRange): PracticeDeskCalendarProjectionInput | Promise<PracticeDeskCalendarProjectionInput>;
  /** Native host subscription or a controller-owned CalendarIntegrationInvalidationNotifier. */
  readonly calendarInvalidation?: CalendarIntegrationInvalidationPort;
}

export interface PracticeDeskCalendarActionPort {
  launchMock?(paperId: string, examId: string): Promise<void> | void;
}

export interface PracticeDeskCalendarHost extends PracticeDeskCalendarReadPort, PracticeDeskCalendarActionPort {}

export interface PracticeMockScheduleRequest {
  readonly examId: string;
  readonly paperId: string;
  readonly title: string;
  readonly start: ISODateTime;
  readonly durationMinutes: number;
}

/**
 * Built-in Practice Desk projection adapter. It forwards the exact requested range
 * to the host and does not reinterpret Practice Desk scheduling policy.
 */
export class PracticeDeskLiveProjection extends PracticeDeskProjection implements CalendarProjectionProvider {
  public constructor(private readonly host: PracticeDeskCalendarReadPort) {
    super(range => host.readCalendar(range));
  }

  public subscribe(listener: () => void): () => void {
    return subscribeCalendarIntegrationInvalidation(this.host.calendarInvalidation, listener);
  }
}

/** Calendar-owned mock placement. Practice Desk remains authoritative for the actual attempt once launched. */
export class PracticeDeskMockScheduler {
  public constructor(
    private readonly repository: CalendarRepository,
    private readonly host?: PracticeDeskCalendarActionPort,
  ) {}

  public async schedule(request: PracticeMockScheduleRequest): Promise<CalendarItem> {
    const start = toDate(request.start);
    const end = new Date(start.getTime() + Math.max(1, request.durationMinutes) * 60_000);
    const item: CalendarItem = {
      id: `practice-plan:${createCalendarIntegrationId()}`,
      calendarId: "practice-desk:plan",
      title: request.title,
      start: start.toISOString(),
      end: end.toISOString(),
      kind: "practice",
      ownership: "practice-desk",
      editPolicy: "schedule-only",
      metadata: {
        app: "practice-desk",
        sourceId: request.paperId,
        examId: request.examId,
        paperId: request.paperId,
        plannedMinutes: request.durationMinutes,
        scheduleAuthority: "director-calendar",
      },
    };
    await this.repository.create(item);
    return item;
  }

  public async launch(item: CalendarItem): Promise<void> {
    if (item.calendarId !== "practice-desk:plan" || item.editPolicy !== "schedule-only" || item.metadata?.app !== "practice-desk" || typeof item.metadata.paperId !== "string" || typeof item.metadata.examId !== "string") {
      throw new Error("Not a scheduled Practice Desk mock.");
    }
    if (!this.host?.launchMock) throw new Error("Practice Desk launch port is not connected.");
    await this.host.launchMock(item.metadata.paperId, item.metadata.examId);
  }
}
