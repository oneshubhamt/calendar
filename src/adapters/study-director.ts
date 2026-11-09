import type { CalendarItem, CalendarProjectionProvider, CalendarRange, ISODateTime } from "../core/types.js";
import { dateKey, dayBoundaryStart, toDate } from "../core/time.js";
import { addPlainDays, addPlainMinutes, parsePlainDate, plainToInstant, systemTimeZone } from "../core/temporal.js";

export interface StudyDirectorScheduleRow {
  readonly id?: string;
  readonly start: string;
  readonly dur: number;
  readonly name: string;
  readonly kind?: string;
  readonly area?: string;
  readonly measure?: string;
  readonly target?: number | string | null;
}

export interface StudyDirectorActualSession {
  readonly id: string;
  readonly title: string;
  readonly startedAt: ISODateTime;
  readonly endedAt: ISODateTime;
  readonly area?: string;
  readonly plannedMinutes?: number;
  readonly actualMinutes?: number;
}

export interface StudyDirectorSavedScheduleRow {
  readonly id: string;
  readonly start: string;
  readonly duration: number;
  readonly name: string;
  readonly kind?: string;
  readonly area?: string;
  readonly measure?: string;
  readonly target?: number | string | null;
}

export interface StudyDirectorSavedResult {
  readonly actualSeconds?: number | null;
  readonly actualStart?: ISODateTime | null;
  readonly actualEnd?: ISODateTime | null;
  readonly sessionCount?: number;
  readonly skipped?: boolean;
  readonly doneFlag?: boolean;
}

/** Calendar-relevant subset of Study Director DailyRecord.v16. */
export interface StudyDirectorDailyRecord {
  readonly version: number;
  readonly recordKind: "study" | "diary";
  readonly date: string;
  readonly schedule?: readonly StudyDirectorSavedScheduleRow[];
  readonly results?: Readonly<Record<string, StudyDirectorSavedResult>>;
}

export interface StudyDirectorCalendarInput {
  readonly studyDay: ISODateTime;
  readonly scheduleRows: readonly StudyDirectorScheduleRow[];
  readonly actualSessions?: readonly StudyDirectorActualSession[];
  readonly dailyRecords?: readonly StudyDirectorDailyRecord[];
  readonly calendarId?: string;
  readonly historyCalendarId?: string;
  /** IANA zone used by Study Director's wall-clock schedule. Defaults to the runtime zone. */
  readonly timeZone?: string;
  /** Logical study-day boundary. Rows before this hour belong to the following civil date. */
  readonly studyDayBoundaryHour?: number;
}

function parseClock(hhmm: string): { readonly hour: number; readonly minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new RangeError(`Invalid Study Director time: ${hhmm}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new RangeError(`Invalid Study Director time: ${hhmm}`);
  return { hour, minute };
}

function logicalStudyDate(studyDay: ISODateTime, timeZone: string, boundaryHour: number): string {
  if (!Number.isInteger(boundaryHour) || boundaryHour < 0 || boundaryHour > 23) throw new RangeError("Invalid Study Director study-day boundary");
  if (/^\d{4}-\d{2}-\d{2}$/.test(studyDay)) return studyDay;
  return dateKey(dayBoundaryStart(studyDay, boundaryHour, timeZone), timeZone);
}

function scheduledInstant(studyDate: string, hhmm: string, durationMinutes: number, timeZone: string, boundaryHour: number): { readonly start: Date; readonly end: Date } {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new RangeError("Invalid Study Director duration");
  const clock = parseClock(hhmm);
  let date = parsePlainDate(studyDate);
  if (clock.hour * 60 + clock.minute < boundaryHour * 60) date = addPlainDays(date, 1);
  const startPlain = { ...date, hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 };
  const endPlain = addPlainMinutes(startPlain, durationMinutes);
  return {
    start: new Date(plainToInstant(startPlain, timeZone, "compatible")),
    end: new Date(plainToInstant(endPlain, timeZone, "compatible")),
  };
}

export function projectStudyDirectorDailyRecords(
  records: readonly StudyDirectorDailyRecord[],
  historyCalendarId = "study-director:history",
): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const record of records) {
    if (record.recordKind !== "study" || !record.schedule?.length || !record.results) continue;
    const rowById = new Map(record.schedule.map(row => [row.id, row] as const));
    for (const [taskId, result] of Object.entries(record.results)) {
      const row = rowById.get(taskId);
      if (!row || !result.actualStart) continue;
      const start = toDate(result.actualStart);
      const seconds = Math.max(0, Number(result.actualSeconds ?? 0));
      const explicitEnd = result.actualEnd ? toDate(result.actualEnd) : null;
      const end = explicitEnd && explicitEnd.getTime() >= start.getTime()
        ? explicitEnd
        : seconds > 0 ? new Date(start.getTime() + seconds * 1000) : null;
      if (!end || end.getTime() <= start.getTime()) continue;
      items.push({
        id: `study-history:${record.date}:${taskId}`,
        calendarId: historyCalendarId,
        title: row.name,
        start: start.toISOString(),
        end: end.toISOString(),
        kind: "history",
        ownership: "study-history",
        editPolicy: "readonly",
        display: { dimmed: true },
        metadata: {
          app: "study-director",
          sourceId: `${record.date}:${taskId}`,
          relationId: `study:${record.date}:${taskId}`,
          relationRole: "actual",
          sourceRevision: record.version,
          area: row.area,
          measure: row.measure,
          target: row.target ?? null,
          plannedMinutes: row.duration,
          actualMinutes: seconds > 0 ? Math.round((seconds / 60) * 10) / 10 : undefined,
          sessionCount: result.sessionCount,
          studyDate: record.date,
          skipped: result.skipped,
          doneFlag: result.doneFlag,
        },
      });
    }
  }
  return items;
}

export function projectStudyDirector(input: StudyDirectorCalendarInput): CalendarItem[] {
  const timeZone = input.timeZone ?? systemTimeZone();
  const boundaryHour = input.studyDayBoundaryHour ?? 0;
  const studyDate = logicalStudyDate(input.studyDay, timeZone, boundaryHour);
  const calendarId = input.calendarId ?? "study-director:plan";
  const historyCalendarId = input.historyCalendarId ?? "study-director:history";
  const planned = input.scheduleRows.map((row, index): CalendarItem => {
    const { start, end } = scheduledInstant(studyDate, row.start, row.dur, timeZone, boundaryHour);
    return {
      id: `study-plan:${row.id ?? index}`,
      calendarId,
      title: row.name,
      start: start.toISOString(),
      end: end.toISOString(),
      temporal: { kind: "zoned", timeZone },
      kind: "study-block",
      ownership: "study-plan",
      editPolicy: "schedule-only",
      metadata: {
        app: "study-director",
        sourceId: row.id ?? String(index),
        relationId: `study:${studyDate}:${row.id ?? index}`,
        relationRole: "planned",
        sourceIndex: index,
        area: row.area,
        measure: row.measure,
        target: row.target ?? null,
        plannedMinutes: row.dur,
        scheduleKind: row.kind,
      },
    };
  });
  const explicitActual = (input.actualSessions ?? []).map((session): CalendarItem => ({
    id: `study-history:${session.id}`,
    calendarId: historyCalendarId,
    title: session.title,
    start: toDate(session.startedAt).toISOString(),
    end: toDate(session.endedAt).toISOString(),
    kind: "history",
    ownership: "study-history",
    editPolicy: "readonly",
    display: { dimmed: true },
    metadata: {
      app: "study-director",
      sourceId: session.id,
      relationId: `study-session:${session.id}`,
      relationRole: "actual",
      area: session.area,
      plannedMinutes: session.plannedMinutes,
      actualMinutes: session.actualMinutes,
    },
  }));
  return [...planned, ...explicitActual, ...projectStudyDirectorDailyRecords(input.dailyRecords ?? [], historyCalendarId)];
}

export class StudyDirectorProjection implements CalendarProjectionProvider {
  public readonly id = "study-director";
  public constructor(private readonly read: (range: CalendarRange) => StudyDirectorCalendarInput | Promise<StudyDirectorCalendarInput>) {}
  public async project(range: CalendarRange): Promise<readonly CalendarItem[]> {
    return projectStudyDirector(await this.read(range));
  }
}
