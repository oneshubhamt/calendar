import type { CalendarItem, CalendarProjectionProvider, CalendarRange, ISODateTime } from "../core/types.js";
import { addMinutes, toDate } from "../core/time.js";

export interface PracticeDeskAttempt {
  readonly id: string;
  readonly examId: string;
  readonly paperId: string;
  readonly title?: string;
  readonly startedAt: number | ISODateTime;
  readonly finishedAt: number | null;
  readonly elapsedMs?: number;
}

export interface PracticeDeskDueCard {
  readonly id: string;
  readonly examId: string;
  readonly paperId: string;
  readonly title: string;
  readonly dueAt: ISODateTime;
  readonly topic?: string;
}

export interface PracticeDeskPlannedMock {
  readonly id: string;
  readonly examId: string;
  readonly paperId: string;
  readonly title: string;
  readonly start: ISODateTime;
  readonly durationMinutes: number;
}

export interface PracticeDeskCalendarInput {
  readonly attempts?: readonly PracticeDeskAttempt[];
  readonly dueCards?: readonly PracticeDeskDueCard[];
  readonly plannedMocks?: readonly PracticeDeskPlannedMock[];
}

function fromNumberish(value: number | string): Date {
  return typeof value === "number" ? new Date(value) : toDate(value);
}

export function projectPracticeDesk(input: PracticeDeskCalendarInput): CalendarItem[] {
  const attempts = (input.attempts ?? []).filter(attempt => attempt.finishedAt !== null).map((attempt): CalendarItem => {
    const finished = new Date(attempt.finishedAt!);
    const started = fromNumberish(attempt.startedAt);
    return {
      id: `practice-history:${attempt.id}`,
      calendarId: "practice-desk:history",
      title: attempt.title ?? attempt.paperId,
      start: started.toISOString(),
      end: finished.toISOString(),
      kind: "history",
      ownership: "practice-history",
      editPolicy: "readonly",
      display: { dimmed: true },
      metadata: {
        app: "practice-desk",
        sourceId: attempt.id,
        examId: attempt.examId,
        paperId: attempt.paperId,
        actualMinutes: attempt.elapsedMs !== undefined ? Math.round((attempt.elapsedMs / 60_000) * 10) / 10 : undefined,
      },
    };
  });

  const dueCards = (input.dueCards ?? []).map((card): CalendarItem => {
    const due = toDate(card.dueAt);
    return {
      id: `practice-due:${card.id}`,
      calendarId: "practice-desk:revision",
      title: card.title,
      start: due.toISOString(),
      end: due.toISOString(),
      temporalForm: "point",
      kind: "revision",
      ownership: "practice-desk",
      editPolicy: "generated",
      metadata: {
        app: "practice-desk",
        sourceId: card.id,
        examId: card.examId,
        paperId: card.paperId,
        topic: card.topic,
        dueAt: card.dueAt,
      },
    };
  });

  const plannedMocks = (input.plannedMocks ?? []).map((mock): CalendarItem => {
    const start = toDate(mock.start);
    const end = addMinutes(start, Math.max(1, mock.durationMinutes));
    return {
      id: `practice-plan:${mock.id}`,
      calendarId: "practice-desk:plan",
      title: mock.title,
      start: start.toISOString(),
      end: end.toISOString(),
      kind: "practice",
      ownership: "practice-desk",
      editPolicy: "schedule-only",
      metadata: {
        app: "practice-desk",
        sourceId: mock.id,
        examId: mock.examId,
        paperId: mock.paperId,
        plannedMinutes: mock.durationMinutes,
      },
    };
  });
  return [...attempts, ...dueCards, ...plannedMocks];
}

export class PracticeDeskProjection implements CalendarProjectionProvider {
  public readonly id = "practice-desk";
  public constructor(private readonly read: (range: CalendarRange) => PracticeDeskCalendarInput | Promise<PracticeDeskCalendarInput>) {}
  public async project(range: CalendarRange): Promise<readonly CalendarItem[]> {
    return projectPracticeDesk(await this.read(range));
  }
}
