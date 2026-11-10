import { expect, test } from "@playwright/test";
import { mountVisualCalendar } from "./visual-fixture.mjs";

test("week desktop visual baseline", async ({ page }) => {
  await mountVisualCalendar(page, { view: "week" });
  await expect(page.locator(".dc-root")).toHaveScreenshot("week-desktop.png");
});

test("month desktop visual baseline", async ({ page }) => {
  await mountVisualCalendar(page, { view: "month", initialDate: "2026-11-09" });
  await expect(page.locator(".dc-root")).toHaveScreenshot("month-desktop.png");
});

test("day narrow visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await mountVisualCalendar(page, {
    view: "day",
    initialDate: "2026-11-10",
    dayStartHour: 6,
    dayEndHour: 23,
    scrollHour: 8,
  });
  await expect(page.locator(".dc-root")).toHaveScreenshot("day-narrow.png");
});

test("DST fall-back day visual baseline", async ({ page }) => {
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
  await expect(page.locator(".dc-root")).toHaveScreenshot("day-dst-fallback.png");
});
