import { expect } from "@playwright/test";
import { scenario } from "./scenario-registry.mjs";
import { openHarness } from "./support/harness.mjs";

const projection = {
  resources: [
    { id: "rooms", title: "Rooms" },
    { id: "a", title: "Room A", parentId: "rooms", order: 1, acceptsAssignments: true },
    { id: "b", title: "Room B", parentId: "rooms", order: 2, acceptsAssignments: true },
  ],
  occurrences: [
    {
      occurrenceId: "visit", sourceItemId: "visit-item", calendarId: "calendar", title: "Visit",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      originalStart: "2026-11-10T09:00:00.000Z", recurring: false,
      kind: "event", ownership: "host", editPolicy: "full",
    },
    {
      occurrenceId: "day", sourceItemId: "day-item", calendarId: "calendar", title: "Maintenance",
      start: "2026-11-10", end: "2026-11-11", allDay: true, precision: "date", temporal: { kind: "date" },
      originalStart: "2026-11-10", recurring: false,
      kind: "event", ownership: "host", editPolicy: "full",
    },
  ],
  assignments: [
    { occurrenceId: "visit", resourceIds: ["a"], version: { revision: 1 } },
    { occurrenceId: "day", resourceIds: ["b"] },
  ],
  availability: [
    {
      id: "a-open", definitionId: "open", resourceId: "a", state: "available",
      start: "2026-11-10T08:00:00.000Z", end: "2026-11-10T17:00:00.000Z", label: "Open",
    },
    {
      id: "b-block", definitionId: "block", resourceId: "b", state: "unavailable",
      start: "2026-11-10T12:00:00.000Z", end: "2026-11-10T13:00:00.000Z", label: "Unavailable",
    },
  ],
  range: { start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" },
};

scenario("resource.grid.render", "Resource TimeGrid renders resources as columns, all-day assignments and passive availability", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceTimeGridUi } = await import("/dist/features/resource-time-grid-ui/index.js");
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceTimeGridUi(host, {
      timeZone: "UTC", dayStartHour: 8, dayEndHour: 18, minColumnWidth: 180,
    });
    ui.setProjection(projection);
    globalThis.__resourceTimeGrid = ui;
  }, projection);

  await expect(page.getByRole("region", { name: /Resource time grid/i })).toBeVisible();
  await expect(page.locator(".dc-rtg-column-header")).toHaveCount(2);
  await expect(page.locator(".dc-rtg-column-resource")).toHaveText(["Room A", "Room B"]);
  await expect(page.locator('.dc-rtg-event[data-occurrence-id="visit"]')).toBeVisible();
  await expect(page.locator('.dc-rtg-all-day-event[data-occurrence-id="day"]')).toBeVisible();
  await expect(page.locator(".dc-rtg-availability")).toHaveCount(2);
  await expect(page.locator(".dc-rtg-availability.is-unavailable")).toContainText("Unavailable");
  await expect(page.locator('.dc-rtg-all-day-cell[data-resource-id="a"]'))
    .toHaveAttribute("aria-label", /Room A.*November 10, 2026/);
});

scenario("resource.grid.diagonal-move", "Resource TimeGrid keyboard diagonal move produces one atomic host mutation and authoritative reprojection", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceTimeGridUi } = await import("/dist/features/resource-time-grid-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceTimeGridUi(host, {
      timeZone: "UTC", dayStartHour: 8, dayEndHour: 18, minColumnWidth: 180,
      interaction: {
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
              assignments: current.assignments.map(assignment => assignment.occurrenceId === change.occurrence.occurrenceId
                ? { ...assignment, resourceIds: [...change.toResourceIds], version: { revision: 2 } }
                : assignment),
            };
          },
        },
        resourceCapabilityProvider: { capabilities() { return { canReassign: true }; } },
        occurrenceCapabilityProvider: { capabilities() { return { canMove: true, canResizeStart: true, canResizeEnd: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceTimeGridProbe = { ui, commits };
  }, projection);

  const event = page.locator('.dc-rtg-event[data-occurrence-id="visit"]');
  await event.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator('.dc-rtg-event[data-resource-id="b"][data-occurrence-id="visit"]')).toBeVisible();
  const commits = await page.evaluate(() => globalThis.__resourceTimeGridProbe.commits);
  expect(commits).toHaveLength(1);
  expect(commits[0].fromResourceIds).toEqual(["a"]);
  expect(commits[0].toResourceIds).toEqual(["b"]);
  expect(commits[0].start).toBe("2026-11-10T09:00:00.000Z");
  expect(commits[0].end).toBe("2026-11-10T10:00:00.000Z");
});

scenario("resource.grid.vertical-keyboard", "Resource TimeGrid vertical keyboard movement reuses temporal authority and civil snapping", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceTimeGridUi } = await import("/dist/features/resource-time-grid-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceTimeGridUi(host, {
      timeZone: "UTC", dayStartHour: 8, dayEndHour: 18,
      interaction: {
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
            };
          },
        },
        occurrenceCapabilityProvider: { capabilities() { return { canMove: true, canResizeStart: true, canResizeEnd: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceTimeGridMove = { commits };
  }, projection);

  const event = page.locator('.dc-rtg-event[data-occurrence-id="visit"]');
  await event.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => await page.evaluate(() => globalThis.__resourceTimeGridMove.commits.at(-1)?.start))
    .toBe("2026-11-10T09:15:00.000Z");
  expect(await page.evaluate(() => globalThis.__resourceTimeGridMove.commits.length)).toBe(1);
});


scenario("resource.grid.resize", "Resource TimeGrid keyboard end resize uses edge authority and one atomic authoritative mutation", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceTimeGridUi } = await import("/dist/features/resource-time-grid-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceTimeGridUi(host, {
      timeZone: "UTC", dayStartHour: 8, dayEndHour: 18,
      interaction: {
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
              assignments: current.assignments.map(assignment => assignment.occurrenceId === change.occurrence.occurrenceId
                ? { ...assignment, resourceIds: [...change.toResourceIds], version: { revision: 2 } }
                : assignment),
            };
          },
        },
        occurrenceCapabilityProvider: { capabilities() { return { canResizeStart: true, canResizeEnd: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceTimeGridResize = { commits };
  }, projection);

  const handle = page.getByRole("separator", { name: "Resize end of Visit" });
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => await page.evaluate(() => globalThis.__resourceTimeGridResize.commits.length)).toBe(1);
  const [commit] = await page.evaluate(() => globalThis.__resourceTimeGridResize.commits);
  expect(commit.start).toBe("2026-11-10T09:00:00.000Z");
  expect(commit.end).toBe("2026-11-10T10:15:00.000Z");
  expect(commit.fromResourceIds).toEqual(["a"]);
  expect(commit.toResourceIds).toEqual(["a"]);
  await expect(page.getByRole("separator", { name: "Resize end of Visit" })).toBeVisible();
});

scenario("resource.grid.pointer", "Resource TimeGrid pointer drag combines time and resource changes into one atomic commit", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceTimeGridUi } = await import("/dist/features/resource-time-grid-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceTimeGridUi(host, {
      timeZone: "UTC", dayStartHour: 8, dayEndHour: 18, minColumnWidth: 220, pixelsPerMinute: 1,
      interaction: {
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
              assignments: current.assignments.map(assignment => assignment.occurrenceId === change.occurrence.occurrenceId
                ? { ...assignment, resourceIds: [...change.toResourceIds], version: { revision: 2 } }
                : assignment),
            };
          },
        },
        resourceCapabilityProvider: { capabilities() { return { canReassign: true }; } },
        occurrenceCapabilityProvider: { capabilities() { return { canMove: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceTimeGridPointer = { commits };
  }, projection);

  const event = page.locator('.dc-rtg-event[data-occurrence-id="visit"]');
  const target = page.locator('.dc-rtg-time-column[data-resource-id="b"]');
  const eventBox = await event.boundingBox();
  const targetBox = await target.boundingBox();
  expect(eventBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(eventBox.x + eventBox.width / 2, eventBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, eventBox.y + 38, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => await page.evaluate(() => globalThis.__resourceTimeGridPointer.commits.length)).toBe(1);
  const [commit] = await page.evaluate(() => globalThis.__resourceTimeGridPointer.commits);
  expect(commit.toResourceIds).toEqual(["b"]);
  expect(commit.start).toBe("2026-11-10T09:30:00.000Z");
  expect(commit.end).toBe("2026-11-10T10:30:00.000Z");
});
