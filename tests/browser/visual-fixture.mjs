const SOURCES = [
  { id: "personal", title: "Personal", visible: true, sourceType: "personal", removable: true, display: { color: "#e8f0fe", textColor: "#174ea6", icon: "•" } },
  { id: "work", title: "Work", visible: true, sourceType: "work", removable: true, display: { color: "#e6f4ea", textColor: "#137333", icon: "W" } },
];

const ITEMS = [
  {
    id: "focus", calendarId: "work", title: "Morning focus", start: "2026-11-09T03:30:00.000Z", end: "2026-11-09T05:00:00.000Z",
    temporal: { kind: "instant" }, kind: "focus", ownership: "calendar", editPolicy: "full",
  },
  {
    id: "review", calendarId: "personal", title: "Review", start: "2026-11-09T04:15:00.000Z", end: "2026-11-09T05:30:00.000Z",
    temporal: { kind: "instant" }, kind: "review", ownership: "calendar", editPolicy: "full",
  },
  {
    id: "walk", calendarId: "personal", title: "Morning walk", start: "2026-11-09T01:30:00.000Z", end: "2026-11-09T02:00:00.000Z",
    temporal: { kind: "instant" }, kind: "habit", ownership: "calendar", editPolicy: "full", seriesId: "walk",
    recurrence: { rule: { frequency: "daily", count: 5 } },
  },
  {
    id: "point", calendarId: "personal", title: "Noon checkpoint", start: "2026-11-11T06:30:00.000Z", end: "2026-11-11T06:30:00.000Z",
    temporal: { kind: "instant" }, temporalForm: "point", kind: "checkpoint", ownership: "calendar", editPolicy: "full",
  },
  {
    id: "cross-midnight", calendarId: "work", title: "Late deployment", start: "2026-11-10T17:30:00.000Z", end: "2026-11-10T19:30:00.000Z",
    temporal: { kind: "instant" }, kind: "deployment", ownership: "calendar", editPolicy: "full",
  },
  {
    id: "offsite", calendarId: "work", title: "Offsite", start: "2026-11-12", end: "2026-11-13",
    allDay: true, precision: "date", temporal: { kind: "date" }, kind: "offsite", ownership: "calendar", editPolicy: "full",
  },
  {
    id: "dst-first", calendarId: "personal", title: "First 1:30", start: "2026-11-01T05:30:00.000Z", end: "2026-11-01T05:50:00.000Z",
    temporal: { kind: "instant" }, kind: "dst", ownership: "calendar", editPolicy: "full",
  },
  {
    id: "dst-second", calendarId: "work", title: "Second 1:30", start: "2026-11-01T06:30:00.000Z", end: "2026-11-01T06:50:00.000Z",
    temporal: { kind: "instant" }, kind: "dst", ownership: "calendar", editPolicy: "full",
  },
];

const BACKGROUNDS = [
  { id: "focus-window", start: "2026-11-09T03:00:00.000Z", end: "2026-11-09T07:00:00.000Z", calendarId: "work", label: "Focus window", display: { color: "#34a853", textColor: "#0d652d" } },
  { id: "quiet-block", start: "2026-11-09T04:30:00.000Z", end: "2026-11-09T05:30:00.000Z", label: "Quiet block", display: { color: "#fbbc04", textColor: "#5f4300" } },
  { id: "overnight-window", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T20:00:00.000Z", calendarId: "work", label: "Deployment window", display: { color: "#4285f4", textColor: "#174ea6" } },
  { id: "all-day-window", start: "2026-11-11T18:30:00.000Z", end: "2026-11-12T18:30:00.000Z", allDay: true, calendarId: "work", label: "Travel day", display: { color: "#a142f4", textColor: "#681da8" } },
  { id: "dst-window", start: "2026-11-01T05:00:00.000Z", end: "2026-11-01T07:30:00.000Z", label: "Fallback window", display: { color: "#ea4335", textColor: "#8c1d18" } },
];

export async function mountVisualCalendar(page, {
  view = "week",
  initialDate = "2026-11-09",
  timeZone = "Asia/Kolkata",
  secondaryTimeZone = "UTC",
  dayStartHour = 6,
  dayEndHour = 23,
  now = "2026-11-10T05:00:00.000Z",
  scrollHour = 7,
  print = false,
} = {}) {
  await page.clock.setFixedTime(new Date(now));
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async ({ view, initialDate, timeZone, secondaryTimeZone, dayStartHour, dayEndHour, print, sources, items, backgrounds }) => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { RepositoryCommandHandler }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const repository = new MemoryCalendarRepository(sources, items);
    const engine = new CalendarEngine(repository, [], [], [{
      id: "browser-visual-backgrounds",
      projectBackgroundRanges: () => backgrounds,
    }]);
    const commands = new RepositoryCommandHandler(repository);
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const calendar = new CalendarUi(host, engine, {
      locale: "en-US",
      timeZone,
      secondaryTimeZone,
      initialDate,
      initialView: view,
      defaultCalendarId: "personal",
      commandHandler: commands,
      dayStartHour,
      dayEndHour,
      collisionPolicy: { mode: "warn", includeAllDay: false },
      ...(print ? { print: true } : {}),
    });
    await calendar.refresh();
    globalThis.__visualCalendar = { calendar, engine, repository };
  }, { view, initialDate, timeZone, secondaryTimeZone, dayStartHour, dayEndHour, print, sources: SOURCES, items: ITEMS, backgrounds: BACKGROUNDS });

  await page.locator(".dc-root").waitFor();
  if (view === "week" || view === "day") {
    await page.locator(".dc-body").evaluate((element, top) => { element.scrollTop = top; }, Math.max(0, scrollHour - dayStartHour) * 60);
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
