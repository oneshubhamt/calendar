import { expect, test } from "@playwright/test";

const projection = {
  resources: [
    { id: "rooms", title: "Rooms" },
    { id: "a", title: "Room A", parentId: "rooms", order: 1, acceptsAssignments: true },
    { id: "b", title: "Room B", parentId: "rooms", order: 2, acceptsAssignments: true },
  ],
  occurrences: [{
    occurrenceId: "occ", sourceItemId: "item", calendarId: "calendar", title: "Visit",
    start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
    originalStart: "2026-11-10T09:00:00.000Z", recurring: false,
    kind: "event", ownership: "host", editPolicy: "full",
  }],
  assignments: [{ occurrenceId: "occ", resourceIds: ["a"], version: { revision: 1 } }],
  range: { start: "2026-11-10T08:00:00.000Z", end: "2026-11-10T12:00:00.000Z" },
};

test("Resource Scheduler renders authoritative hierarchy and collapse state in a real browser", async ({ page }) => {
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async projection => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, { timeZone: "UTC" });
    ui.setProjection(projection);
    globalThis.__resourceScheduler = ui;
  }, projection);

  await expect(page.getByRole("treegrid", { name: "Resource schedule" })).toBeVisible();
  await expect(page.locator(".dc-rs-resource-row")).toHaveCount(3);
  await expect(page.locator(".dc-rs-event")).toContainText("Visit");
  await page.getByRole("button", { name: "Collapse Rooms" }).click();
  await expect(page.locator(".dc-rs-resource-row")).toHaveCount(1);
  expect(await page.evaluate(() => globalThis.__resourceScheduler.collapsedResourceIds())).toEqual(["rooms"]);
});

test("Resource Scheduler keyboard reassignment commits one atomic host change and reprojects", async ({ page }) => {
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async projection => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, {
      timeZone: "UTC",
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
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceSchedulerProbe = { ui, commits };
  }, projection);

  const event = page.locator('.dc-rs-event[data-resource-id="a"]');
  await event.focus();
  await page.keyboard.press("Alt+ArrowDown");

  await expect(page.locator('.dc-rs-event[data-resource-id="b"]')).toBeVisible();
  const commits = await page.evaluate(() => globalThis.__resourceSchedulerProbe.commits);
  expect(commits).toHaveLength(1);
  expect(commits[0].fromResourceIds).toEqual(["a"]);
  expect(commits[0].toResourceIds).toEqual(["b"]);
  expect(commits[0].start).toBe("2026-11-10T09:00:00.000Z");
  expect(commits[0].end).toBe("2026-11-10T10:00:00.000Z");
});
