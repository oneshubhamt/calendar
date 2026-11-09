import type { CalendarCommand, CalendarCommandContext, CalendarCommandHandler, CalendarOccurrence, CalendarRange, ISODateTime } from "../core/types.js";
import { dateKey, dayBoundaryStart, toDate } from "../core/time.js";
import { instantToPlain, plainMinutesBetween, systemTimeZone } from "../core/temporal.js";
import type { StudyDirectorCalendarInput, StudyDirectorDailyRecord, StudyDirectorScheduleRow } from "../adapters/study-director.js";
import { StudyDirectorProjection } from "../adapters/study-director.js";

export interface StudyDirectorScheduleGatewaySnapshot {
  readonly tasks: readonly StudyDirectorScheduleRow[];
}

export interface StudyDirectorScheduleGatewayPort {
  read(): StudyDirectorScheduleGatewaySnapshot;
  apply(
    rows: readonly StudyDirectorScheduleRow[],
    options?: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
  hasLiveState(): boolean;
  captureMigration(rows: readonly StudyDirectorScheduleRow[]): unknown | Promise<unknown>;
  reconcile(source?: string): unknown | Promise<unknown>;
  flush(): unknown | Promise<unknown>;
}

export interface StudyDirectorCalendarHost {
  readonly scheduleGateway: StudyDirectorScheduleGatewayPort;
  readonly timeZone?: string;
  readonly studyDayBoundaryHour?: number;
  studyDay(): ISODateTime;
  readDailyRecords(range: CalendarRange): readonly StudyDirectorDailyRecord[] | Promise<readonly StudyDirectorDailyRecord[]>;
  canMutate?(): boolean;
}

function cloneRows(rows: readonly StudyDirectorScheduleRow[]): StudyDirectorScheduleRow[] {
  return rows.map(row => ({ ...row }));
}

function sourceIndex(occurrence: CalendarOccurrence, rows: readonly StudyDirectorScheduleRow[]): number {
  const rawIndex = occurrence.metadata?.sourceIndex;
  if (typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < rows.length) return rawIndex;
  const sourceId = occurrence.metadata?.sourceId;
  if (typeof sourceId === "string") {
    const byId = rows.findIndex(row => row.id === sourceId);
    if (byId >= 0) return byId;
    const parsed = Number(sourceId);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed < rows.length) return parsed;
  }
  throw new Error("Study Director plan row can no longer be matched to the live schedule.");
}

function clockFromInstant(value: string, timeZone: string): string {
  const p = instantToPlain(toDate(value).getTime(), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function studyOrderMinute(hhmm: string, boundaryHour: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`Study Director row has invalid start time: ${hhmm}`);
  const minute = Number(match[1]) * 60 + Number(match[2]);
  if (!Number.isInteger(minute) || minute < 0 || minute >= 1440) throw new Error(`Study Director row has invalid start time: ${hhmm}`);
  return minute < boundaryHour * 60 ? minute + 1440 : minute;
}

function insertStudyRow(rows: readonly StudyDirectorScheduleRow[], row: StudyDirectorScheduleRow, boundaryHour: number): StudyDirectorScheduleRow[] {
  const at = studyOrderMinute(row.start, boundaryHour);
  const index = rows.findIndex(candidate => studyOrderMinute(candidate.start, boundaryHour) > at);
  return index < 0 ? [...rows, row] : [...rows.slice(0, index), row, ...rows.slice(index)];
}

function studyDateKey(value: ISODateTime, timeZone: string, boundaryHour: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return dateKey(dayBoundaryStart(value, boundaryHour, timeZone), timeZone);
}

function assertSameStudyDate(studyDay: ISODateTime, occurrenceStart: string, timeZone: string, boundaryHour: number): void {
  const occurrenceStudyDay = dateKey(dayBoundaryStart(occurrenceStart, boundaryHour, timeZone), timeZone);
  if (studyDateKey(studyDay, timeZone, boundaryHour) !== occurrenceStudyDay) {
    throw new Error("Study Director's current scheduleGateway owns one study day. Move this block within that day; cross-day planning belongs to a saved plan/day integration.");
  }
}

function rowWithTemporalChange(
  row: StudyDirectorScheduleRow,
  start: string,
  end: string,
  studyDay: ISODateTime,
  timeZone: string,
  boundaryHour: number,
): StudyDirectorScheduleRow {
  assertSameStudyDate(studyDay, start, timeZone, boundaryHour);
  const duration = Math.max(1, Math.round(plainMinutesBetween(instantToPlain(toDate(start).getTime(), timeZone), instantToPlain(toDate(end).getTime(), timeZone))));
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError("Study Director block duration is invalid.");
  return { ...row, start: clockFromInstant(start, timeZone), dur: duration };
}

/** Concrete write-back boundary for Study Director's existing scheduleGateway. */
interface StudyHistoryEntry { readonly before: readonly StudyDirectorScheduleRow[]; readonly after: readonly StudyDirectorScheduleRow[]; }

function rowSignature(rows: readonly StudyDirectorScheduleRow[]): string {
  return JSON.stringify(rows.map(row => [row.id ?? null, row.start, row.dur, row.name, row.kind ?? null, row.area ?? null, row.measure ?? null, row.target ?? null]));
}

export class StudyDirectorPlanCommandHandler implements CalendarCommandHandler {
  private readonly undoStack: StudyHistoryEntry[] = [];
  private readonly redoStack: StudyHistoryEntry[] = [];

  public constructor(private readonly host: StudyDirectorCalendarHost, private readonly historyLimit = 100) {}

  public historyState(): { readonly canUndo: boolean; readonly canRedo: boolean } {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  public async undo(): Promise<boolean> {
    const entry = this.undoStack.at(-1);
    if (!entry) return false;
    const current = this.host.scheduleGateway.read().tasks;
    if (rowSignature(current) !== rowSignature(entry.after)) throw new Error("Study Director schedule changed outside Director Calendar; undo was not applied because it would overwrite newer plan state.");
    await this.commit(entry.before, "director-calendar-undo");
    this.undoStack.pop();
    this.redoStack.push(entry);
    return true;
  }

  public async redo(): Promise<boolean> {
    const entry = this.redoStack.at(-1);
    if (!entry) return false;
    const current = this.host.scheduleGateway.read().tasks;
    if (rowSignature(current) !== rowSignature(entry.before)) throw new Error("Study Director schedule changed outside Director Calendar; redo was not applied because it would overwrite newer plan state.");
    await this.commit(entry.after, "director-calendar-redo");
    this.redoStack.pop();
    this.undoStack.push(entry);
    return true;
  }

  public async execute(command: CalendarCommand, _context: CalendarCommandContext): Promise<void> {
    if (this.host.canMutate && !this.host.canMutate()) throw new Error("Study Director plan control is not available in this tab.");
    if (command.type === "create") {
      if (command.item.calendarId !== "study-director:plan") throw new Error("This Study Director handler only creates Study plan blocks.");
      if (command.item.allDay || command.item.precision === "date") throw new Error("Study Director plan blocks must be timed events.");
      if (!command.item.title.trim()) throw new Error("Study Director plan blocks require a title.");
      const timeZone = this.host.timeZone ?? systemTimeZone();
      const boundaryHour = this.host.studyDayBoundaryHour ?? 0;
      assertSameStudyDate(this.host.studyDay(), command.item.start, timeZone, boundaryHour);
      const area = typeof command.item.metadata?.area === "string" && command.item.metadata.area.trim()
        ? command.item.metadata.area.trim()
        : typeof command.item.metadata?.category === "string" ? command.item.metadata.category.trim() : "";
      if (!area) throw new Error("Study Director blocks require an area. Enter it in the event Category field.");
      const before = cloneRows(this.host.scheduleGateway.read().tasks);
      const duration = Math.max(1, Math.round(plainMinutesBetween(instantToPlain(toDate(command.item.start).getTime(), timeZone), instantToPlain(toDate(command.item.end).getTime(), timeZone))));
      const row: StudyDirectorScheduleRow = {
        start: clockFromInstant(command.item.start, timeZone),
        dur: duration,
        name: command.item.title.trim(),
        kind: typeof command.item.metadata?.scheduleKind === "string" ? command.item.metadata.scheduleKind : "work",
        area,
        ...(typeof command.item.metadata?.measure === "string" && command.item.metadata.measure ? { measure: command.item.metadata.measure } : {}),
        ...(command.item.metadata?.target !== undefined ? { target: command.item.metadata.target as number | string | null } : {}),
      };
      const current = insertStudyRow(before, row, boundaryHour);
      await this.commit(current, "director-calendar-create");
      this.undoStack.push({ before, after: cloneRows(current) });
      if (this.undoStack.length > Math.max(1, this.historyLimit)) this.undoStack.shift();
      this.redoStack.length = 0;
      return;
    }
    if (command.type === "update" || command.type === "remove") throw new Error("Study Director projected rows must be mutated through occurrence commands.");

    const occurrence = command.occurrence;
    if (occurrence.ownership !== "study-plan") throw new Error("This command does not target a Study Director plan row.");
    if (command.scope !== "all") throw new Error("Study Director plan rows are not calendar recurrence series.");
    if (command.type === "cancel-occurrence") throw new Error("Delete Study Director rows through its Plan authoring surface; calendar cancellation is not a scheduleGateway operation.");

    const before = cloneRows(this.host.scheduleGateway.read().tasks);
    const current = cloneRows(before);
    const index = sourceIndex(occurrence, current);
    const row = current[index]!;
    const timeZone = this.host.timeZone ?? systemTimeZone();
    const start = command.type === "update-occurrence" ? command.patch.start ?? occurrence.start : command.start;
    const end = command.type === "update-occurrence" ? command.patch.end ?? occurrence.end : command.end;
    current[index] = rowWithTemporalChange(row, start, end, this.host.studyDay(), timeZone, this.host.studyDayBoundaryHour ?? 0);
    if (rowSignature(before) === rowSignature(current)) return;
    await this.commit(current, "director-calendar");
    this.undoStack.push({ before, after: cloneRows(current) });
    if (this.undoStack.length > Math.max(1, this.historyLimit)) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private async commit(rows: readonly StudyDirectorScheduleRow[], source: string): Promise<void> {
    const gateway = this.host.scheduleGateway;
    const progressMigration = gateway.hasLiveState() ? await gateway.captureMigration(rows) : null;
    await gateway.apply(rows, { source, progressMigration });
    await gateway.reconcile(source);
    await gateway.flush();
  }
}

export class StudyDirectorLiveProjection extends StudyDirectorProjection {
  public constructor(host: StudyDirectorCalendarHost) {
    super(async range => ({
      studyDay: host.studyDay(),
      scheduleRows: host.scheduleGateway.read().tasks,
      dailyRecords: await host.readDailyRecords(range),
      ...(host.timeZone ? { timeZone: host.timeZone } : {}),
      ...(host.studyDayBoundaryHour !== undefined ? { studyDayBoundaryHour: host.studyDayBoundaryHour } : {}),
    } satisfies StudyDirectorCalendarInput));
  }
}
