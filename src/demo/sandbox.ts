import { CalendarUi } from "../view/calendar-ui.js";
import { createPlanningUiExtension } from "../features/planning.js";
import { createPersonalCalendarUiAddon } from "../features/personal-ui.js";
import { createDirectorFixtureEnvironment, DIRECTOR_FIXTURE_ROUTINES, DIRECTOR_FIXTURE_TIME_ZONE } from "../fixtures/director.js";

export function mountDirectorCalendarSandbox(host: HTMLElement): CalendarUi {
  const fixture = createDirectorFixtureEnvironment();
  const calendar = new CalendarUi(host, fixture.ecosystem.engine, {
    timeZone: DIRECTOR_FIXTURE_TIME_ZONE,
    initialDate: "2026-11-08",
    initialView: "week",
    commandHandler: fixture.ecosystem.commandHandler,
    sourceActions: fixture.ecosystem.sourceActions,
    extensions: [createPlanningUiExtension(), ...fixture.ecosystem.createUiExtensions()],
    addons: [createPersonalCalendarUiAddon({
      routineTemplates: DIRECTOR_FIXTURE_ROUTINES,
      quickCreateOptions: { kindKeywords: { study: "study-block", revision: "revision", mock: "mock", deadline: "deadline", exam: "milestone" } },
    })],
    kindOptions: [
      { value: "event", label: "Event" }, { value: "study-block", label: "Study block" }, { value: "revision", label: "Revision" },
      { value: "mock", label: "Mock" }, { value: "deadline", label: "Deadline" }, { value: "milestone", label: "Milestone" },
    ],
    collisionPolicy: { mode: "warn", includeAllDay: false },
  });
  (globalThis as { directorCalendarSandbox?: unknown }).directorCalendarSandbox = { calendar, fixture };
  return calendar;
}

if (typeof document !== "undefined") {
  const host = document.getElementById("director-calendar-sandbox");
  if (host) mountDirectorCalendarSandbox(host);
}
