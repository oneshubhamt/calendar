import type { CalendarOccurrence, CalendarProjectionProvider, CalendarRepository, CalendarSource } from "../core/types.js";
import type { CalendarSourceAction, CalendarSourceActionPort } from "../view/types.js";
import { CalendarEngine } from "../core/calendar-engine.js";
import { DirectorEcosystemCommandRouter, type SourceOpenPort } from "./common.js";
import type { StudyDirectorCalendarHost } from "./study-director.js";
import { StudyDirectorLiveProjection, StudyDirectorPlanCommandHandler } from "./study-director.js";
import type { RevisionDirectorCalendarHost } from "./revision-director.js";
import { RevisionCalendarScheduler, RevisionDirectorLiveProjection } from "./revision-director.js";
import type { PracticeDeskCalendarHost } from "./practice-desk.js";
import { PracticeDeskLiveProjection, PracticeDeskMockScheduler } from "./practice-desk.js";

export const DIRECTOR_ECOSYSTEM_SOURCES: readonly CalendarSource[] = Object.freeze([
  { id: "personal", title: "Personal", visible: true, sourceType: "personal", metadata: { category: "Personal" }, display: { icon: "•" } },
  { id: "study-director:plan", title: "Study plan", visible: true, removable: false, sourceType: "projected", allowCreate: true, display: { icon: "S" } },
  { id: "study-director:history", title: "Study history", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "✓" } },
  { id: "revision-director:due", title: "Revision due", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "R" } },
  { id: "revision-director:daily-plan", title: "Revision daily plan", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "R" } },
  { id: "revision-director:scheduled", title: "Scheduled revision", visible: true, removable: false, sourceType: "system", display: { icon: "R" } },
  { id: "revision-director:history", title: "Revision history", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "✓" } },
  { id: "revision-director:exams", title: "Exams", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "◆" } },
  { id: "practice-desk:plan", title: "Practice mocks", visible: true, removable: false, sourceType: "system", display: { icon: "P" } },
  { id: "practice-desk:history", title: "Practice history", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "✓" } },
  { id: "practice-desk:revision", title: "Practice revision due", visible: true, removable: false, sourceType: "projected", readOnly: true, display: { icon: "P" } },
]);

export interface DirectorEcosystemOptions {
  readonly repository: CalendarRepository;
  readonly studyDirector?: StudyDirectorCalendarHost;
  readonly revisionDirector?: RevisionDirectorCalendarHost;
  readonly practiceDesk?: PracticeDeskCalendarHost;
  readonly externalProjections?: readonly CalendarProjectionProvider[];
  readonly sourceOpen?: SourceOpenPort;
}


export class DirectorEcosystemSourceActions implements CalendarSourceActionPort {
  public constructor(
    private readonly revisionScheduler: RevisionCalendarScheduler,
    private readonly practiceScheduler: PracticeDeskMockScheduler,
    private readonly sourceOpen?: SourceOpenPort,
  ) {}

  public actions(occurrence: CalendarOccurrence): readonly CalendarSourceAction[] {
    const app = occurrence.metadata?.app;
    const actions: CalendarSourceAction[] = [];
    if (app === "revision-director" && occurrence.calendarId === "revision-director:scheduled" && occurrence.ownership === "revision-plan" && occurrence.editPolicy === "schedule-only") {
      actions.push({ id: "revision:start", label: "Start revision", kind: "start", primary: true });
    }
    if (app === "practice-desk" && occurrence.calendarId === "practice-desk:plan") {
      actions.push({ id: "practice:launch", label: "Launch mock", kind: "launch", primary: true });
    }
    if (this.sourceOpen && (app === "study-director" || app === "revision-director" || app === "practice-desk") && typeof occurrence.metadata?.sourceId === "string") {
      const label = app === "study-director" ? "Open in Study Director" : app === "revision-director" ? "Open in Revision Director" : "Open in Practice Desk";
      actions.push({ id: `${app}:open`, label, kind: "open" });
    }
    return actions;
  }

  public async execute(actionId: string, occurrence: CalendarOccurrence): Promise<void> {
    if (actionId === "revision:start") {
      const item = occurrence as unknown as import("../core/types.js").CalendarItem;
      await this.revisionScheduler.markStarted(item);
      return;
    }
    if (actionId === "practice:launch") {
      const item = occurrence as unknown as import("../core/types.js").CalendarItem;
      await this.practiceScheduler.launch(item);
      return;
    }
    if (actionId.endsWith(":open")) {
      const app = occurrence.metadata?.app;
      const sourceId = occurrence.metadata?.sourceId;
      if (!this.sourceOpen || (app !== "study-director" && app !== "revision-director" && app !== "practice-desk") || typeof sourceId !== "string") throw new Error("Source-open action is not connected.");
      await this.sourceOpen.open({ app, sourceId, action: actionId, ...(occurrence.metadata ? { metadata: occurrence.metadata } : {}) });
      return;
    }
    throw new Error(`Unknown Director source action: ${actionId}`);
  }
}

/** Assembles the independent calendar package around real host ports without changing any host repository. */
export function createDirectorEcosystem(options: DirectorEcosystemOptions) {
  const projections = [
    ...(options.studyDirector ? [new StudyDirectorLiveProjection(options.studyDirector)] : []),
    ...(options.revisionDirector ? [new RevisionDirectorLiveProjection(options.revisionDirector)] : []),
    ...(options.practiceDesk ? [new PracticeDeskLiveProjection(options.practiceDesk)] : []),
    ...(options.externalProjections ?? []),
  ];
  const studyCommands = options.studyDirector ? new StudyDirectorPlanCommandHandler(options.studyDirector) : undefined;
  const revisionScheduler = new RevisionCalendarScheduler(options.repository, options.revisionDirector);
  const practiceScheduler = new PracticeDeskMockScheduler(options.repository, options.practiceDesk);
  const sourceActions = new DirectorEcosystemSourceActions(revisionScheduler, practiceScheduler, options.sourceOpen);
  return Object.freeze({
    engine: new CalendarEngine(options.repository, projections),
    commandHandler: new DirectorEcosystemCommandRouter(options.repository, studyCommands),
    revisionScheduler,
    practiceScheduler,
    sourceActions,
    projections: Object.freeze(projections),
  });
}
