import type { CalendarItem, CalendarProjectionProvider, CalendarRange, ISODateTime } from "../core/types.js";
import { addMinutes, toDate } from "../core/time.js";
import { addPlainDays, formatPlainDate, parsePlainDate } from "../core/temporal.js";

export interface RevisionDirectorObligation {
  readonly id: string;
  readonly unitId: string;
  readonly title: string;
  readonly subject?: string;
  readonly type: string;
  readonly status: string;
  readonly dueAt: ISODateTime;
  readonly expectedMinutes: number;
  readonly examId?: string;
}

export interface RevisionDirectorDailyPlanItem {
  readonly key: string;
  readonly obligationId: string;
  readonly chunkId?: string;
  readonly profileId: string;
  readonly unitId: string;
  readonly subject: string;
  readonly workflow: string;
  readonly title: string;
  readonly estimatedMinutes: number;
  readonly disposition: "selected" | "required-overrun" | "must-split" | "deferred";
}

export interface RevisionDirectorDailyPlanVersion {
  readonly version: number;
  readonly generatedAt: ISODateTime;
  readonly items: readonly RevisionDirectorDailyPlanItem[];
}

export interface RevisionDirectorDailyPlanOutcome {
  readonly itemKey: string;
  readonly status: "planned" | "started" | "completed" | "skipped";
  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly actualMinutes?: number;
}

export interface RevisionDirectorDailyPlanRecord {
  readonly id: string;
  readonly studyDayKey: string;
  readonly versions: readonly RevisionDirectorDailyPlanVersion[];
  readonly outcomes: readonly RevisionDirectorDailyPlanOutcome[];
}

export interface RevisionDirectorExam {
  readonly id: string;
  readonly name: string;
  readonly examDate: string;
}

export interface RevisionDirectorCalendarInput {
  readonly obligations: readonly RevisionDirectorObligation[];
  readonly dailyPlans?: readonly RevisionDirectorDailyPlanRecord[];
  readonly exams?: readonly RevisionDirectorExam[];
}

function dateRange(date: string): { start: string; end: string } {
  const start = parsePlainDate(date);
  return { start: formatPlainDate(start), end: formatPlainDate(addPlainDays(start, 1)) };
}

function projectDailyPlan(record: RevisionDirectorDailyPlanRecord): CalendarItem[] {
  const latest = record.versions.at(-1);
  if (!latest) return [];
  const outcomeByKey = new Map(record.outcomes.map(outcome => [outcome.itemKey, outcome] as const));
  const items: CalendarItem[] = [];
  for (const item of latest.items) {
    if (item.disposition === "deferred" || item.disposition === "must-split") continue;
    const outcome = outcomeByKey.get(item.key) ?? { itemKey: item.key, status: "planned" as const };
    const baseMetadata = {
      app: "revision-director" as const,
      sourceId: item.obligationId,
      planRecordId: record.id,
      planItemKey: item.key,
      chunkId: item.chunkId,
      subject: item.subject,
      examId: item.profileId,
      plannedMinutes: item.estimatedMinutes,
      planStatus: outcome.status,
      workflow: item.workflow,
      relationId: `revision:${record.id}:${item.key}`,
      relationRole: outcome.status === "completed" ? ("actual" as const) : ("planned" as const),
    };
    if (outcome.status === "completed" && outcome.completedAt) {
      const end = toDate(outcome.completedAt);
      const actual = Math.max(1, outcome.actualMinutes ?? item.estimatedMinutes);
      const start = outcome.startedAt ? toDate(outcome.startedAt) : addMinutes(end, -actual);
      items.push({
        id: `revision-history:${record.id}:${item.key}`,
        calendarId: "revision-director:history",
        title: item.title,
        start: start.toISOString(),
        end: end.toISOString(),
        kind: "history",
        ownership: "revision-plan",
        editPolicy: "readonly",
        display: { dimmed: true },
        metadata: { ...baseMetadata, actualMinutes: outcome.actualMinutes },
      });
      continue;
    }
    if (outcome.status === "started" && outcome.startedAt) {
      const start = toDate(outcome.startedAt);
      items.push({
        id: `revision-active:${record.id}:${item.key}`,
        calendarId: "revision-director:plan",
        title: item.title,
        start: start.toISOString(),
        end: addMinutes(start, item.estimatedMinutes).toISOString(),
        kind: "revision",
        ownership: "revision-engine",
        editPolicy: "generated",
        metadata: baseMetadata,
      });
      continue;
    }
    const range = dateRange(record.studyDayKey);
    items.push({
      id: `revision-dayplan:${record.id}:${item.key}`,
      calendarId: "revision-director:daily-plan",
      title: item.title,
      start: range.start,
      end: range.end,
      allDay: true,
      precision: "date",
      temporal: { kind: "date" },
      kind: "revision",
      ownership: "revision-engine",
      editPolicy: "generated",
      display: outcome.status === "skipped" ? { dimmed: true } : undefined,
      metadata: baseMetadata,
    });
  }
  return items;
}

export function projectRevisionDirector(input: RevisionDirectorCalendarInput): CalendarItem[] {
  const obligations = input.obligations
    .filter(obligation => obligation.status === "active")
    .map((obligation): CalendarItem => {
      const due = toDate(obligation.dueAt);
      return {
        id: `revision-due:${obligation.id}`,
        calendarId: "revision-director:due",
        title: obligation.title,
        start: due.toISOString(),
        end: due.toISOString(),
        temporalForm: "point",
        kind: "revision",
        ownership: "revision-engine",
        editPolicy: "generated",
        metadata: {
          app: "revision-director",
          sourceId: obligation.id,
          subject: obligation.subject,
          examId: obligation.examId,
          dueAt: obligation.dueAt,
          plannedMinutes: obligation.expectedMinutes,
          obligationType: obligation.type,
        },
      };
    });

  const plans = (input.dailyPlans ?? []).flatMap(projectDailyPlan);
  const exams = (input.exams ?? []).filter(exam => exam.examDate).map((exam): CalendarItem => {
    const range = dateRange(exam.examDate);
    return {
      id: `revision-exam:${exam.id}`,
      calendarId: "revision-director:exams",
      title: exam.name,
      start: range.start,
      end: range.end,
      allDay: true,
      precision: "date",
      temporal: { kind: "date" },
      kind: "exam",
      ownership: "revision-engine",
      editPolicy: "readonly",
      display: { emphasis: "strong" },
      metadata: { app: "revision-director", sourceId: exam.id, examId: exam.id },
    };
  });
  return [...obligations, ...plans, ...exams];
}

export class RevisionDirectorProjection implements CalendarProjectionProvider {
  public readonly id = "revision-director";
  public constructor(private readonly read: (range: CalendarRange) => RevisionDirectorCalendarInput | Promise<RevisionDirectorCalendarInput>) {}
  public async project(range: CalendarRange): Promise<readonly CalendarItem[]> {
    return projectRevisionDirector(await this.read(range));
  }
}
