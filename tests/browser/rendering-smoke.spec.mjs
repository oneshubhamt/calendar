import { expect, test } from "@playwright/test";
import { mountVisualCalendar } from "./visual-fixture.mjs";

test("live temporal chrome advances across midnight without re-querying projections", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-10T23:59:30.000Z") });
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    let projectionCalls = 0;
    const projection = {
      id: "temporal-probe",
      project() {
        projectionCalls += 1;
        return [];
      },
    };
    const engine = new CalendarEngine(new MemoryCalendarRepository([source], []), [projection]);
    const host = document.getElementById("browser-test-host");
    const calendar = new CalendarUi(host, engine, {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-10",
      initialView: "week",
      dayStartHour: 0,
      dayEndHour: 24,
    });
    await calendar.refresh();
    globalThis.__temporalCalendar = { calendar, projectionCalls: () => projectionCalls };
  });
  await page.locator(".dc-now").waitFor();

  const before = await page.evaluate(() => ({
    queryCount: globalThis.__temporalCalendar.projectionCalls(),
    today: [...document.querySelectorAll(".dc-day-header.is-today")].map(node => node.dataset.calendarDate?.slice(0, 10)),
    nowTop: document.querySelector(".dc-now")?.style.top,
  }));
  expect(before.today).toEqual(["2026-11-10"]);
  expect(Number.parseFloat(before.nowTop)).toBeCloseTo(1439.5, 1);

  await page.clock.fastForward(31_000);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

  const midnight = await page.evaluate(() => ({
    queryCount: globalThis.__temporalCalendar.projectionCalls(),
    today: [...document.querySelectorAll(".dc-day-header.is-today")].map(node => node.dataset.calendarDate?.slice(0, 10)),
    nowTop: document.querySelector(".dc-now")?.style.top,
  }));
  expect(midnight.queryCount).toBe(before.queryCount);
  expect(midnight.today).toEqual(["2026-11-11"]);
  expect(Number.parseFloat(midnight.nowTop)).toBeCloseTo(0, 0);

  await page.clock.fastForward(60_000);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const afterMinute = await page.evaluate(() => ({
    queryCount: globalThis.__temporalCalendar.projectionCalls(),
    nowTop: document.querySelector(".dc-now")?.style.top,
  }));
  expect(afterMinute.queryCount).toBe(before.queryCount);
  expect(Number.parseFloat(afterMinute.nowTop)).toBeCloseTo(1, 1);
});

test("week view renders interactive events and passive background layers in a real browser", async ({ page }) => {
  await mountVisualCalendar(page, { view: "week" });
  await expect(page.getByRole("group", { name: "Week calendar" })).toBeVisible();
  await expect(page.locator(".dc-time-event").first()).toBeVisible();
  await expect(page.locator(".dc-background-range").first()).toBeVisible();
  await expect(page.locator(".dc-day-background-range").first()).toBeVisible();
  await expect(page.getByText("Morning focus", { exact: true })).toBeVisible();
  await expect(page.getByText("Noon checkpoint", { exact: true })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const gridTop = document.querySelector(".dc-time-grid")?.getBoundingClientRect().top;
    const primaryTop = document.querySelector(".dc-time-axis:not(.dc-secondary-time-axis)")?.getBoundingClientRect().top;
    const secondaryTop = document.querySelector(".dc-secondary-time-axis")?.getBoundingClientRect().top;
    return { gridTop, primaryTop, secondaryTop };
  });
  expect(geometry.primaryTop).toBeCloseTo(geometry.gridTop, 3);
  expect(geometry.secondaryTop).toBeCloseTo(geometry.gridTop, 3);
});

test("pointer drag still commits a timed move through the extracted gesture controller", async ({ page }) => {
  await mountVisualCalendar(page, { view: "week", scrollHour: 7 });
  const event = page.locator(".dc-time-event").filter({ hasText: "Morning focus" }).first();
  await expect(event).toBeVisible();
  const box = await event.boundingBox();
  expect(box).not.toBeNull();
  const startX = box.x + Math.min(30, box.width / 2);
  const startY = box.y + Math.min(20, box.height / 2);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 8, { steps: 2 });
  await page.mouse.move(startX, startY + 120, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__visualCalendar.repository.read().items.find(item => item.id === "focus")?.start,
  )).toBe("2026-11-09T05:30:00.000Z");
});


test("structured presentation, inline actions and embedded chrome behave through the real DOM", async ({ page }) => {
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "structured", calendarId: "personal", title: "Underlying title",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      kind: "event", ownership: "calendar", editPolicy: "full",
    };
    let actionCalls = 0;
    let openCalls = 0;
    const repository = new MemoryCalendarRepository([source], [item]);
    const calendar = new CalendarUi(document.getElementById("browser-test-host"), new CalendarEngine(repository), {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-10",
      initialView: "day",
      chrome: { toolbar: false },
      extensions: [{
        presentOccurrence() {
          return {
            title: "Presented title",
            subtitle: "Safe subtitle",
            badges: [{ label: "Confirmed" }],
            data: { hostStatus: "ready" },
          };
        },
      }],
      sourceActions: {
        actions() {
          return [{ id: "toggle", label: "Toggle state", inline: true, pressed: true }];
        },
        execute() { actionCalls += 1; },
      },
      callbacks: {
        handleOpen() { openCalls += 1; return true; },
      },
    });
    await calendar.refresh();
    globalThis.__structuredProbe = { actionCalls: () => actionCalls, openCalls: () => openCalls };
  });

  await expect(page.locator(".dc-toolbar")).toHaveCount(0);
  const event = page.locator(".dc-time-event").filter({ hasText: "Presented title" }).first();
  await expect(event).toContainText("Safe subtitle");
  await expect(event).toContainText("Confirmed");
  await expect(event).toHaveAttribute("data-host-host-status", "ready");

  const action = event.getByRole("button", { name: "Toggle state" });
  await expect(action).toHaveAttribute("aria-pressed", "true");
  await action.click();
  expect(await page.evaluate(() => globalThis.__structuredProbe.actionCalls())).toBe(1);
  expect(await page.evaluate(() => globalThis.__structuredProbe.openCalls())).toBe(0);

  await event.locator(".dc-occurrence-main").click();
  expect(await page.evaluate(() => globalThis.__structuredProbe.openCalls())).toBe(1);
});

test("DST fall-back day exposes duplicated local hour geometry without browser-specific failure", async ({ page }) => {
  await mountVisualCalendar(page, {
    view: "day",
    initialDate: "2026-11-01",
    timeZone: "America/New_York",
    secondaryTimeZone: "UTC",
    dayStartHour: 0,
    dayEndHour: 5,
    now: "2026-11-01T06:15:00.000Z",
    scrollHour: 0,
  });
  await expect(page.locator('.dc-time-axis:not(.dc-secondary-time-axis) .dc-time-axis-label[data-transition="overlap"]')).toContainText("01:00 ×2");
  await expect(page.getByText("First 1:30", { exact: true })).toBeVisible();
  await expect(page.getByText("Second 1:30", { exact: true })).toBeVisible();
});


test("registered custom views own range navigation rendering and use only the bounded Calendar action port", async ({ page }) => {
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { RepositoryCommandHandler }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
    ]);

    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "custom-event", calendarId: "personal", title: "Custom event",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      kind: "event", ownership: "calendar", editPolicy: "full",
    };
    const repository = new MemoryCalendarRepository([source], [item]);
    let backgroundCalls = 0;
    const backgrounds = {
      id: "custom-backgrounds",
      projectBackgroundRanges() {
        backgroundCalls += 1;
        return [{
          id: "background",
          start: "2026-11-10T08:00:00.000Z",
          end: "2026-11-10T12:00:00.000Z",
          label: "Custom background",
        }];
      },
    };
    const engine = new CalendarEngine(repository, [], [], [backgrounds]);
    const commands = new RepositoryCommandHandler(repository);
    const viewChanges = [];
    const rangeChanges = [];
    const created = [];
    let openCalls = 0;

    const rangeForTwoDays = context => {
      const start = new Date(context.anchor);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 2 * 86400000);
      return { start: start.toISOString(), end: end.toISOString() };
    };
    const shiftTwoDays = (context, direction) => new Date(context.anchor.getTime() + direction * 2 * 86400000);

    const lean = {
      id: "lean-two-day",
      label: "Lean",
      range: rangeForTwoDays,
      shiftAnchor: shiftTwoDays,
      title: context => `Lean ${context.anchor.toISOString().slice(0, 10)}`,
      includeBackgroundRanges: false,
      render(context) {
        const root = document.createElement("section");
        root.className = "custom-lean-view";
        root.dataset.backgroundCount = String(context.backgroundRanges.length);
        return root;
      },
    };

    const interactive = {
      id: "interactive-two-day",
      label: "Two Day",
      range: rangeForTwoDays,
      shiftAnchor: shiftTwoDays,
      title: context => `Two Day ${context.anchor.toISOString().slice(0, 10)}`,
      includeBackgroundRanges: true,
      render(context) {
        const root = document.createElement("section");
        root.className = "custom-two-day-view";
        root.dataset.viewId = context.viewId;
        root.dataset.occurrenceCount = String(context.occurrences.length);
        root.dataset.backgroundCount = String(context.backgroundRanges.length);
        root.dataset.contextKeys = Object.keys(context).sort().join(",");
        root.dataset.actionKeys = Object.keys(context.actions).sort().join(",");
        const occurrence = context.occurrences[0];
        if (!occurrence) return root;

        const open = document.createElement("button");
        open.textContent = "Open custom event";
        open.addEventListener("click", () => void context.actions.openOccurrence(occurrence));

        const create = document.createElement("button");
        create.textContent = "Create custom event";
        create.addEventListener("click", () => void context.actions.createFromSelection({
          start: "2026-11-10T14:00:00.000Z",
          end: "2026-11-10T15:00:00.000Z",
          allDay: false,
        }));

        const move = document.createElement("button");
        move.textContent = "Move custom event";
        move.addEventListener("click", () => void context.actions.moveOccurrence(
          occurrence,
          "2026-11-10T11:00:00.000Z",
        ));

        const resize = document.createElement("button");
        resize.textContent = "Resize custom event";
        resize.addEventListener("click", () => void context.actions.resizeOccurrence(
          occurrence,
          "end",
          new Date(Date.parse(occurrence.start) + 2 * 60 * 60_000).toISOString(),
        ));

        root.append(open, create, move, resize);
        return root;
      },
    };

    const calendar = new CalendarUi(document.getElementById("browser-test-host"), engine, {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-10",
      initialView: "lean-two-day",
      customViews: [lean, interactive],
      commandHandler: commands,
      callbacks: {
        handleOpen() { openCalls += 1; return true; },
        handleCreate(selection) { created.push(selection); return true; },
        onViewChange(view) { viewChanges.push(view); },
        onRangeChange(range, view) { rangeChanges.push({ range, view }); },
      },
    });
    await calendar.refresh();
    globalThis.__customViewProbe = {
      calendar,
      repository,
      backgroundCalls: () => backgroundCalls,
      viewChanges,
      rangeChanges,
      created,
      openCalls: () => openCalls,
    };
  });

  await expect(page.locator(".custom-lean-view")).toHaveAttribute("data-background-count", "0");
  expect(await page.evaluate(() => globalThis.__customViewProbe.backgroundCalls())).toBe(0);

  await page.getByRole("button", { name: "Two Day" }).click();
  await expect(page.locator(".custom-two-day-view")).toBeVisible();
  await expect(page.locator("[data-role='title']")).toHaveText("Two Day 2026-11-10");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-view-id", "interactive-two-day");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-occurrence-count", "1");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-background-count", "1");

  const exposed = await page.locator(".custom-two-day-view").evaluate(node => ({
    context: node.dataset.contextKeys,
    actions: node.dataset.actionKeys,
  }));
  expect(exposed.context).not.toMatch(/repository|storage|engine/i);
  expect(exposed.actions).not.toMatch(/repository|storage|engine|commandHandler/i);
  expect(exposed.actions).toContain("moveOccurrence");
  expect(exposed.actions).toContain("resizeOccurrence");

  await page.getByRole("button", { name: "Open custom event" }).click();
  expect(await page.evaluate(() => globalThis.__customViewProbe.openCalls())).toBe(1);

  await page.getByRole("button", { name: "Create custom event" }).click();
  await expect.poll(async () => await page.evaluate(() => globalThis.__customViewProbe.created.length)).toBe(1);
  expect(await page.evaluate(() => globalThis.__customViewProbe.created[0])).toEqual({
    start: "2026-11-10T14:00:00.000Z",
    end: "2026-11-10T15:00:00.000Z",
    allDay: false,
  });

  await page.getByRole("button", { name: "Move custom event" }).click();
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__customViewProbe.repository.read().items[0].start,
  )).toBe("2026-11-10T11:00:00.000Z");

  await page.getByRole("button", { name: "Resize custom event" }).click();
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__customViewProbe.repository.read().items[0].end,
  )).toBe("2026-11-10T13:00:00.000Z");

  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.locator("[data-role='title']")).toHaveText("Two Day 2026-11-12");
  expect(await page.evaluate(() => globalThis.__customViewProbe.rangeChanges.at(-1))).toEqual({
    range: { start: "2026-11-12T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" },
    view: "interactive-two-day",
  });
  expect(await page.evaluate(() => globalThis.__customViewProbe.viewChanges)).toContain("interactive-two-day");

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.locator(".dc-month-grid")).toBeVisible();
});
