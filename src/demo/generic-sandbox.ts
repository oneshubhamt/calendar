import { CalendarEngine } from "../core/calendar-engine.js";
import { RepositoryCommandHandler } from "../core/commands.js";
import { MemoryCalendarRepository } from "../core/store.js";
import type { CalendarItem, CalendarSource } from "../core/types.js";
import { CalendarUi } from "../view/calendar-ui.js";

const SOURCES: readonly CalendarSource[] = [
  { id: "journeys", title: "Journeys", visible: true, sourceType: "travel", removable: true, display: { icon: "✦" }, metadata: { host: "travel-companion" } },
  { id: "notes", title: "Notes", visible: true, sourceType: "knowledge", removable: true, display: { icon: "N" }, metadata: { host: "notes-app" } },
  { id: "personal", title: "Personal", visible: true, sourceType: "personal", removable: true, display: { icon: "•" } },
];

const ITEMS: readonly CalendarItem[] = [
  {
    id: "travel:dinner", calendarId: "journeys", title: "Dinner in Tokyo", start: "2026-11-10T19:30:00", end: "2026-11-10T21:00:00",
    temporal: { kind: "zoned", timeZone: "Asia/Tokyo" }, kind: "journey-plan", ownership: "travel-host", editPolicy: "full",
    metadata: { journeyId: "tokyo-2026", category: "Tokyo" }, display: { color: "#e8f3ff", textColor: "#153e75", className: "host-travel-plan" },
  },
  {
    id: "personal:walk", calendarId: "personal", title: "Morning walk", start: "2026-11-08T06:30:00", end: "2026-11-08T07:00:00",
    temporal: { kind: "floating" }, kind: "habit", ownership: "personal", editPolicy: "full", seriesId: "personal:walk",
    recurrence: { rule: { frequency: "daily", count: 7 } }, metadata: { habitId: "walk", category: "Rhythm" },
  },
  {
    id: "notes:review", calendarId: "notes", title: "Review project note", start: "2026-11-09T15:00:00Z", end: "2026-11-09T15:45:00Z",
    temporal: { kind: "instant" }, kind: "note-review", ownership: "notes-host", editPolicy: "full", metadata: { noteId: "n-42", category: "Work" },
  },
  {
    id: "personal:passport", calendarId: "personal", title: "Passport renewal window", start: "2026-11-12", end: "2026-11-13",
    allDay: true, precision: "date", temporal: { kind: "date" }, kind: "document-date", ownership: "personal", editPolicy: "full",
  },
];

export function mountGenericCalendarSandbox(host: HTMLElement): CalendarUi {
  const repository = new MemoryCalendarRepository(SOURCES, ITEMS);
  const engine = new CalendarEngine(repository);
  const commands = new RepositoryCommandHandler(repository);
  const calendar = new CalendarUi(host, engine, {
    timeZone: "Asia/Kolkata",
    initialDate: "2026-11-08",
    initialView: "week",
    defaultCalendarId: "personal",
    commandHandler: commands,
    kindOptions: [
      { value: "event", label: "Event" }, { value: "journey-plan", label: "Journey plan" }, { value: "habit", label: "Habit" },
      { value: "note-review", label: "Note review" }, { value: "document-date", label: "Document date" },
    ],
    defaultOwnership: "personal",
    collisionPolicy: { mode: "warn", includeAllDay: false },
  });
  (globalThis as { genericCalendarSandbox?: unknown }).genericCalendarSandbox = { calendar, repository, engine };
  return calendar;
}

if (typeof document !== "undefined") {
  const host = document.getElementById("generic-calendar-sandbox");
  if (host) mountGenericCalendarSandbox(host);
}
