import type { CalendarItem, CalendarProjectionProvider, CalendarRange, CalendarRepository, ISODateTime } from "../core/types.js";
import { toDate } from "../core/time.js";
import type { PracticeDeskAttempt, PracticeDeskCalendarInput, PracticeDeskDueCard } from "../adapters/practice-desk.js";
import { PracticeDeskProjection } from "../adapters/practice-desk.js";

export interface PracticeDeskAttemptRecord {
  readonly recordType: "generic-attempt";
  readonly id: string;
  readonly packageId: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly state: { readonly elapsedMs: number };
  readonly frozen: {
    readonly snapshot: { readonly examId: string };
    readonly paper: { readonly paperId: string };
  };
}

export interface PracticeDeskLearningCardRecord {
  readonly recordType: "learning-card";
  readonly id: string;
  readonly examId: string;
  readonly paperId: string;
  readonly sourceTitle: string;
  readonly customTopic: string;
  readonly customSubject?: string;
  readonly question: { readonly id: string };
  readonly createdAt: string;
  readonly reviews: readonly { readonly at: string; readonly rating: 1 | 2 | 3 | 4 }[];
}

export interface PracticeDeskRevisionSchedulerPort {
  readonly provider: string;
  replay(
    id: string,
    createdAt: string,
    reviews: readonly { readonly at: string; readonly rating: 1 | 2 | 3 | 4 }[],
  ): { readonly dueAt: Date };
}

export interface PracticeDeskCalendarHost {
  readAttempts(range: CalendarRange): readonly PracticeDeskAttemptRecord[] | Promise<readonly PracticeDeskAttemptRecord[]>;
  readLearningCards(range: CalendarRange): readonly PracticeDeskLearningCardRecord[] | Promise<readonly PracticeDeskLearningCardRecord[]>;
  readonly revisionScheduler: PracticeDeskRevisionSchedulerPort;
  resolveAttemptTitle?(attempt: PracticeDeskAttemptRecord): string;
  resolveCardTitle?(card: PracticeDeskLearningCardRecord): string;
  launchMock?(paperId: string, examId: string): Promise<void> | void;
}

export interface PracticeMockScheduleRequest {
  readonly examId: string;
  readonly paperId: string;
  readonly title: string;
  readonly start: ISODateTime;
  readonly durationMinutes: number;
}

function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function flattenAttempt(record: PracticeDeskAttemptRecord, host: PracticeDeskCalendarHost): PracticeDeskAttempt {
  return {
    id: record.id,
    examId: record.frozen.snapshot.examId,
    paperId: record.frozen.paper.paperId,
    title: host.resolveAttemptTitle?.(record) ?? record.packageId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    elapsedMs: record.state.elapsedMs,
  };
}

function flattenDueCard(record: PracticeDeskLearningCardRecord, host: PracticeDeskCalendarHost): PracticeDeskDueCard {
  const dueAt = host.revisionScheduler.replay(record.id, record.createdAt, record.reviews).dueAt;
  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) throw new Error(`Practice Desk scheduler returned an invalid due date for ${record.id}.`);
  return {
    id: record.id,
    examId: record.examId,
    paperId: record.paperId,
    title: host.resolveCardTitle?.(record) ?? (record.customTopic.trim() || record.sourceTitle || record.question.id),
    dueAt: dueAt.toISOString(),
    ...(record.customTopic ? { topic: record.customTopic } : {}),
  };
}

export class PracticeDeskLiveProjection extends PracticeDeskProjection implements CalendarProjectionProvider {
  public constructor(host: PracticeDeskCalendarHost) {
    super(async range => ({
      attempts: (await host.readAttempts(range)).map(record => flattenAttempt(record, host)),
      dueCards: (await host.readLearningCards(range)).map(record => flattenDueCard(record, host)),
    } satisfies PracticeDeskCalendarInput));
  }
}

/** Calendar-owned mock placement. Practice Desk remains authoritative for the actual attempt once launched. */
export class PracticeDeskMockScheduler {
  public constructor(
    private readonly repository: CalendarRepository,
    private readonly host?: PracticeDeskCalendarHost,
  ) {}

  public async schedule(request: PracticeMockScheduleRequest): Promise<CalendarItem> {
    const start = toDate(request.start);
    const end = new Date(start.getTime() + Math.max(1, request.durationMinutes) * 60_000);
    const item: CalendarItem = {
      id: `practice-plan:${randomId()}`,
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
