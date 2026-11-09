import { MemoryCalendarRepository } from "../core/store.js";
import type { CalendarItem, CalendarRange } from "../core/types.js";
import type { CalendarRoutineTemplate } from "../features/personal.js";
import { createDirectorEcosystem, DIRECTOR_ECOSYSTEM_SOURCES } from "../integration/ecosystem.js";
import type { SourceOpenRequest } from "../integration/common.js";
import type { StudyDirectorCalendarHost, StudyDirectorScheduleGatewaySnapshot } from "../integration/study-director.js";
import type { StudyDirectorDailyRecord, StudyDirectorScheduleRow } from "../adapters/study-director.js";
import type { RevisionDirectorCalendarHost, RevisionDirectorRawNode, RevisionDirectorRawObligation, RevisionDirectorRawProfile, RevisionDirectorRawUnit } from "../integration/revision-director.js";
import type { RevisionDirectorDailyPlanRecord } from "../adapters/revision-director.js";
import type { PracticeDeskAttemptRecord, PracticeDeskCalendarHost, PracticeDeskLearningCardRecord } from "../integration/practice-desk.js";

export const DIRECTOR_FIXTURE_TIME_ZONE = "Asia/Kolkata";
export const DIRECTOR_FIXTURE_STUDY_DAY = "2026-11-08";

export const DIRECTOR_FIXTURE_ROUTINES: readonly CalendarRoutineTemplate[] = Object.freeze([
  {
    id: "routine:upsc-morning",
    title: "UPSC morning block",
    calendarId: "personal",
    blocks: [
      { title: "Current affairs", offsetMinutes: 5 * 60 + 30, durationMinutes: 75, kind: "study-block", category: "UPSC" },
      { title: "Public Administration", offsetMinutes: 7 * 60 + 15, durationMinutes: 120, kind: "study-block", category: "UPSC" },
      { title: "Revision recall", offsetMinutes: 10 * 60, durationMinutes: 45, kind: "revision", category: "Revision" },
    ],
    repeat: { frequency: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5, 6], weekStartsOn: 1 },
  },
]);

export const DIRECTOR_FIXTURE_CALENDAR_ITEMS: readonly CalendarItem[] = Object.freeze([
  {
    id: "fixture:personal:income-tax",
    calendarId: "personal",
    title: "Income-tax document review",
    start: "2026-11-09T11:00:00+05:30",
    end: "2026-11-09T12:00:00+05:30",
    temporal: { kind: "zoned", timeZone: DIRECTOR_FIXTURE_TIME_ZONE },
    kind: "deadline",
    ownership: "calendar",
    editPolicy: "full",
    metadata: { category: "Administration" },
    reminders: [{ id: "fixture-reminder", minutesBefore: 30, channel: "browser" }],
  },
  {
    id: "fixture:revision:scheduled",
    calendarId: "revision-director:scheduled",
    title: "Companies Act review",
    start: "2026-11-08T10:30:00.000Z",
    end: "2026-11-08T10:55:00.000Z",
    kind: "revision",
    ownership: "revision-plan",
    editPolicy: "schedule-only",
    metadata: { app: "revision-director", sourceId: "obl-companies", dueAt: "2026-11-08T03:30:00.000Z", plannedMinutes: 25, scheduleAuthority: "director-calendar" },
  },
  {
    id: "fixture:practice:scheduled",
    calendarId: "practice-desk:plan",
    title: "PFRDA Mock 4",
    start: "2026-11-08T08:30:00.000Z",
    end: "2026-11-08T09:10:00.000Z",
    kind: "practice",
    ownership: "practice-desk",
    editPolicy: "schedule-only",
    metadata: { app: "practice-desk", sourceId: "mock-4", examId: "pfrda", paperId: "mock-4", plannedMinutes: 40, scheduleAuthority: "director-calendar" },
  },
]);

const STUDY_ROWS: readonly StudyDirectorScheduleRow[] = Object.freeze([
  { id: "sd-ca", start: "05:30", dur: 75, name: "Current Affairs", kind: "work", area: "Current Affairs", measure: "minutes", target: 75 },
  { id: "sd-pubad", start: "07:15", dur: 120, name: "Public Administration — Thinkers", kind: "work", area: "Public Administration", measure: "pages", target: 20 },
  { id: "sd-costing", start: "10:00", dur: 75, name: "PFRDA — Costing", kind: "work", area: "PFRDA", measure: "questions", target: 20 },
  { id: "sd-late", start: "02:00", dur: 40, name: "Late-night revision", kind: "work", area: "Revision", measure: "minutes", target: 40 },
]);

const STUDY_HISTORY: readonly StudyDirectorDailyRecord[] = Object.freeze([
  {
    version: 16,
    recordKind: "study",
    date: "2026-11-07",
    schedule: [
      { id: "hist-pubad", start: "07:00", duration: 100, name: "Public Administration — Administrative Thinkers", kind: "work", area: "Public Administration" },
      { id: "hist-pfrda", start: "10:00", duration: 60, name: "PFRDA — Companies Act", kind: "work", area: "PFRDA" },
    ],
    results: {
      "hist-pubad": { actualSeconds: 6_420, actualStart: "2026-11-07T01:34:00.000Z", actualEnd: "2026-11-07T03:21:00.000Z", sessionCount: 1, doneFlag: true },
      "hist-pfrda": { actualSeconds: 3_360, actualStart: "2026-11-07T04:34:00.000Z", actualEnd: "2026-11-07T05:30:00.000Z", sessionCount: 1, doneFlag: true },
    },
  },
]);

class FixtureStudyHost implements StudyDirectorCalendarHost {
  private rows = STUDY_ROWS.map(row => ({ ...row }));
  public readonly timeZone = DIRECTOR_FIXTURE_TIME_ZONE;
  public readonly studyDayBoundaryHour = 4;
  public readonly scheduleGateway = {
    read: (): StudyDirectorScheduleGatewaySnapshot => ({ tasks: this.rows.map(row => ({ ...row })) }),
    apply: async (rows: readonly StudyDirectorScheduleRow[]) => { this.rows = rows.map(row => ({ ...row })); },
    hasLiveState: () => false,
    captureMigration: async (_rows: readonly StudyDirectorScheduleRow[]) => null,
    reconcile: async (_source?: string) => undefined,
    flush: async () => undefined,
  };
  public studyDay(): string { return DIRECTOR_FIXTURE_STUDY_DAY; }
  public readDailyRecords(_range: CalendarRange): readonly StudyDirectorDailyRecord[] { return STUDY_HISTORY; }
  public canMutate(): boolean { return true; }
}

const REVISION_OBLIGATIONS: readonly RevisionDirectorRawObligation[] = Object.freeze([
  { id: "obl-companies", unitId: "unit-companies", type: "memory-recall", status: "active", dueAt: "2026-11-08T03:30:00.000Z", expectedMinutes: 25 },
  { id: "obl-costing", unitId: "unit-costing", type: "application-practice", status: "active", dueAt: "2026-11-09T04:30:00.000Z", expectedMinutes: 35 },
]);
const REVISION_UNITS: readonly RevisionDirectorRawUnit[] = Object.freeze([
  { id: "unit-companies", profileId: "exam-pfrda", topicNodeId: "topic-companies", title: "Companies Act — Directors" },
  { id: "unit-costing", profileId: "exam-pfrda", topicNodeId: "topic-costing", title: "Costing — Break-even analysis" },
]);
const REVISION_NODES: readonly RevisionDirectorRawNode[] = Object.freeze([
  { id: "sub-finance", parentId: null, kind: "subject", name: "Finance & Management" },
  { id: "sec-company", parentId: "sub-finance", kind: "section", name: "Companies Act" },
  { id: "topic-companies", parentId: "sec-company", kind: "topic", name: "Directors" },
  { id: "sec-costing", parentId: "sub-finance", kind: "section", name: "Costing" },
  { id: "topic-costing", parentId: "sec-costing", kind: "topic", name: "Break-even" },
]);
const REVISION_PROFILES: readonly RevisionDirectorRawProfile[] = Object.freeze([
  { id: "exam-pfrda", name: "PFRDA Grade A — Phase II", examDate: "2026-11-20", status: "active" },
]);
const REVISION_PLANS: readonly RevisionDirectorDailyPlanRecord[] = Object.freeze([
  {
    id: "dayplan-2026-11-08",
    studyDayKey: "2026-11-08",
    versions: [{
      version: 1,
      generatedAt: "2026-11-08T00:30:00.000Z",
      capacityMinutes: 90,
      reason: "initial",
      items: [
        { key: "obl-companies", obligationId: "obl-companies", profileId: "exam-pfrda", unitId: "unit-companies", subject: "Finance & Management", workflow: "recall", title: "Companies Act — Directors", estimatedMinutes: 25, score: 88, disposition: "selected", reasons: ["overdue", "exam proximity"] },
        { key: "obl-costing", obligationId: "obl-costing", profileId: "exam-pfrda", unitId: "unit-costing", subject: "Finance & Management", workflow: "questions", title: "Costing — Break-even analysis", estimatedMinutes: 35, score: 76, disposition: "selected", reasons: ["due soon"] },
      ],
    }],
    outcomes: [{ itemKey: "obl-companies", status: "planned" }, { itemKey: "obl-costing", status: "planned" }],
  },
]);

class FixtureRevisionHost implements RevisionDirectorCalendarHost {
  public readonly startedTargets: string[][] = [];
  public obligations() { return REVISION_OBLIGATIONS; }
  public units() { return REVISION_UNITS; }
  public nodes() { return REVISION_NODES; }
  public profiles() { return REVISION_PROFILES; }
  public dailyPlanHistory() { return REVISION_PLANS; }
  public markReviewTargetsStarted(targets: string[]): void { this.startedTargets.push([...targets]); }
}

const PRACTICE_ATTEMPTS: readonly PracticeDeskAttemptRecord[] = Object.freeze([
  { recordType: "generic-attempt", id: "attempt-pfrda-3", packageId: "PFRDA Mock 3", startedAt: Date.parse("2026-11-06T08:30:00.000Z"), finishedAt: Date.parse("2026-11-06T09:10:00.000Z"), state: { elapsedMs: 2_400_000 }, frozen: { snapshot: { examId: "pfrda" }, paper: { paperId: "mock-3" } } },
]);
const PRACTICE_CARDS: readonly PracticeDeskLearningCardRecord[] = Object.freeze([
  { recordType: "learning-card", id: "learning-card:costing-q12", examId: "pfrda", paperId: "mock-3", sourceTitle: "PFRDA Mock 3", customTopic: "Marginal costing", customSubject: "Costing", question: { id: "costing-q12" }, createdAt: "2026-11-06T09:15:00.000Z", reviews: [{ at: "2026-11-07T09:15:00.000Z", rating: 2 }] },
]);

class FixturePracticeHost implements PracticeDeskCalendarHost {
  public readonly launched: Array<{ paperId: string; examId: string }> = [];
  public readonly revisionScheduler = {
    provider: "fixture-fsrs",
    replay: (id: string) => ({ dueAt: new Date(id.includes("costing") ? "2026-11-08T12:30:00.000Z" : "2026-11-09T12:30:00.000Z") }),
  };
  public readAttempts(_range: CalendarRange) { return PRACTICE_ATTEMPTS; }
  public readLearningCards(_range: CalendarRange) { return PRACTICE_CARDS; }
  public resolveAttemptTitle(record: PracticeDeskAttemptRecord): string { return record.packageId; }
  public resolveCardTitle(record: PracticeDeskLearningCardRecord): string { return record.customTopic || record.sourceTitle; }
  public launchMock(paperId: string, examId: string): void { this.launched.push({ paperId, examId }); }
}

export function createDirectorFixtureEnvironment() {
  const repository = new MemoryCalendarRepository(DIRECTOR_ECOSYSTEM_SOURCES, DIRECTOR_FIXTURE_CALENDAR_ITEMS);
  const studyDirector = new FixtureStudyHost();
  const revisionDirector = new FixtureRevisionHost();
  const practiceDesk = new FixturePracticeHost();
  const opened: SourceOpenRequest[] = [];
  const ecosystem = createDirectorEcosystem({
    repository,
    studyDirector,
    revisionDirector,
    practiceDesk,
    sourceOpen: { open(request) { opened.push(structuredClone(request)); } },
  });
  return { repository, ecosystem, studyDirector, revisionDirector, practiceDesk, opened };
}
