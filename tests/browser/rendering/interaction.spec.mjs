import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { mountVisualCalendar } from "../visual-fixture.mjs";
import { openHarness } from "../support/harness.mjs";

scenario("view.week", "week view renders interactive events and passive background layers in a real browser", async ({ page }) => {
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


scenario("interaction.timed-drag", "pointer drag still commits a timed move through the extracted gesture controller", async ({ page }) => {
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



scenario("presentation.actions", "structured presentation, inline actions and embedded chrome behave through the real DOM", async ({ page }) => {
  await openHarness(page);
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


scenario("view.dst-fallback", "DST fall-back day exposes duplicated local hour geometry without browser-specific failure", async ({ page }) => {
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



scenario("view.week-numbers", "Month week numbers are optional accessible and narrow-screen safe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await openHarness(page);

  await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);

    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "jan-event",
      calendarId: "personal",
      title: "January event",
      start: "2021-01-01",
      end: "2021-01-02",
      allDay: true,
      precision: "date",
      temporal: { kind: "date" },
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const backgrounds = {
      id: "month-backgrounds",
      projectBackgroundRanges() {
        return [{
          id: "jan-background",
          start: "2021-01-01T00:00:00.000Z",
          end: "2021-01-02T00:00:00.000Z",
          allDay: true,
          label: "Background fixture",
        }];
      },
    };
    const repository = new MemoryCalendarRepository([source], [item]);
    const engine = new CalendarEngine(repository, [], [], [backgrounds]);
    const host = document.getElementById("browser-test-host");

    const mount = async weekNumbers => {
      host.replaceChildren();
      const calendar = new CalendarUi(host, engine, {
        locale: "en-US",
        timeZone: "UTC",
        initialDate: "2021-01-15T12:00:00.000Z",
        initialView: "month",
        weekStartsOn: 1,
        weekNumbers,
      });
      await calendar.refresh();
      return calendar;
    };

    let calendar = await mount(false);
    globalThis.__monthWeekProbe = {
      disabled: {
        weekNumbers: document.querySelectorAll(".dc-week-number").length,
        headerColumns: document.querySelector(".dc-weekdays")?.children.length ?? 0,
        dayCells: document.querySelectorAll(".dc-day-cell").length,
        gridHasWeekNumbers: document.querySelector(".dc-month-grid")?.classList.contains("has-week-numbers") ?? false,
      },
    };
    calendar.destroy();

    calendar = await mount({ minimumDaysInFirstWeek: 4 });
    globalThis.__monthWeekProbe.calendar = calendar;
  });

  expect(await page.evaluate(() => globalThis.__monthWeekProbe.disabled)).toEqual({
    weekNumbers: 0,
    headerColumns: 7,
    dayCells: 42,
    gridHasWeekNumbers: false,
  });

  await expect(page.locator(".dc-week-number-heading")).toHaveAttribute("aria-label", "Week number");
  await expect(page.locator(".dc-week-number")).toHaveCount(6);
  await expect(page.locator(".dc-week-number").first()).toHaveText("53");
  await expect(page.locator(".dc-week-number").first()).toHaveAttribute("aria-label", "Week 53 of 2020");
  await expect(page.locator(".dc-week-number").nth(1)).toHaveText("1");
  await expect(page.locator(".dc-week-number").nth(1)).toHaveAttribute("aria-label", "Week 1 of 2021");
  await expect(page.locator(".dc-week-number").first()).toHaveAttribute("title", "Week 53 of 2020");
  await expect(page.locator(".dc-day-cell")).toHaveCount(42);
  await expect(page.locator(".dc-weekdays")).toHaveClass(/has-week-numbers/);
  await expect(page.locator(".dc-month-grid")).toHaveClass(/has-week-numbers/);

  const januaryFirst = page.locator('.dc-day-cell[data-calendar-date^="2021-01-01"]');
  await expect(januaryFirst.getByText("January event")).toBeVisible();
  await expect(januaryFirst.locator(".dc-day-background-range")).toHaveCount(1);
  await expect(januaryFirst).toHaveAttribute("aria-label", /Background: Background fixture/);

  const layout = await page.evaluate(() => {
    const grid = document.querySelector(".dc-month-grid");
    const body = document.querySelector(".dc-body");
    if (!(grid instanceof HTMLElement) || !(body instanceof HTMLElement)) throw new Error("Month layout missing");
    const gridRect = grid.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return {
      gridWidth: gridRect.width,
      bodyWidth: bodyRect.width,
      scrollWidth: grid.scrollWidth,
      clientWidth: grid.clientWidth,
    };
  });
  expect(layout.gridWidth).toBeLessThanOrEqual(layout.bodyWidth + 1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});
