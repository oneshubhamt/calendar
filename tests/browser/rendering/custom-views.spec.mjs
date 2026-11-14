import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import {
  exerciseCustomViewLifecycle,
  mountCustomHostView,
  mountMultiMonthView,
  mountTimelineView,
} from "../support/custom-view-fixtures.mjs";

scenario("custom.host-view", "registered custom views own range navigation rendering and use only the bounded Calendar action port", async ({ page }) => {
  await mountCustomHostView(page);

  await expect(page.locator(".custom-lean-view")).toHaveAttribute("data-background-count", "0");
  expect(await page.evaluate(() => globalThis.__customViewProbe.backgroundCalls())).toBe(0);

  await page.getByRole("button", { name: "Two Day" }).click();
  await expect(page.locator(".custom-two-day-view")).toBeVisible();
  await expect(page.locator("[data-role='title']")).toHaveText("Two Day 2026-11-10");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-view-id", "interactive-two-day");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-occurrence-count", "1");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-background-count", "1");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-minimum-days-in-first-week", "4");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-presented-title", "Presented custom event");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-collections-frozen", "true");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-occurrence-frozen", "true");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-occurrence-owned", "true");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-forged-movable", "false");

  const exposed = await page.locator(".custom-two-day-view").evaluate(node => ({
    context: node.dataset.contextKeys,
    actions: node.dataset.actionKeys,
    renderers: node.dataset.rendererKeys,
    renderersFrozen: node.dataset.renderersFrozen,
  }));
  expect(exposed.context).not.toMatch(/repository|storage|engine/i);
  expect(exposed.actions).not.toMatch(/repository|storage|engine|commandHandler/i);
  expect(exposed.actions).toContain("moveOccurrence");
  expect(exposed.actions).toContain("resizeOccurrence");
  expect(exposed.actions).toContain("occurrencePresentation");
  expect(exposed.actions).toContain("canAcceptExternalDrop");
  expect(exposed.actions).toContain("dropExternal");
  expect(exposed.actions).toContain("bindExternalDropTarget");
  expect(exposed.renderers).toBe("monthPanel");
  expect(exposed.renderersFrozen).toBe("true");
  expect(exposed.renderers).not.toMatch(/repository|storage|engine/i);

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



scenario("custom.multi-month", "optional Multi-Month composes canonical Month panels across years with one query", async ({ page }) => {
  await mountMultiMonthView(page);

  await expect(page.locator(".dc-multi-month")).toHaveAttribute("data-month-count", "3");
  await expect(page.locator(".dc-multi-month-section")).toHaveCount(3);
  await expect(page.locator(".dc-multi-month-title")).toHaveText([
    "November 2026",
    "December 2026",
    "January 2027",
  ]);
  await expect(page.locator("[data-role='title']")).toHaveText("November 2026 – January 2027");
  expect(await page.evaluate(() => globalThis.__multiMonthProbe.projectionCalls())).toBe(1);
  expect(await page.evaluate(() => globalThis.__multiMonthProbe.backgroundCalls())).toBe(1);
  await expect(page.locator(".dc-week-number")).not.toHaveCount(0);
  const januaryFifth = page.locator('.dc-day-cell[data-calendar-date^="2027-01-05"]');
  await expect(januaryFifth.locator(".dc-day-background-range")).toHaveCount(1);
  await expect(januaryFifth).toHaveAttribute("aria-label", /Background: January background/);

  await page.evaluate(() => globalThis.__multiMonthProbe.moveInternal("2026-12-20"));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__multiMonthProbe.repository.read().items.find(item => item.id === "move-me")?.start,
  )).toBe("2026-12-20T09:00:00.000Z");

  await page.evaluate(() => globalThis.__multiMonthProbe.dispatchExternal("2026-12-15", "External multi"));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__multiMonthProbe.repository.read().items.some(item => item.title === "External multi"),
  )).toBe(true);

  await page.evaluate(() => globalThis.__multiMonthProbe.createOn("2027-01-20"));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__multiMonthProbe.createdSelections.length,
  )).toBe(1);
  expect(await page.evaluate(() => globalThis.__multiMonthProbe.createdSelections[0])).toEqual({
    start: "2027-01-20T00:00:00.000Z",
    end: "2027-01-21T00:00:00.000Z",
    allDay: true,
  });

  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.locator(".dc-multi-month-title")).toHaveText([
    "February 2027",
    "March 2027",
    "April 2027",
  ]);
  await expect(page.locator("[data-role='title']")).toHaveText("February – April 2027");
  await page.getByRole("button", { name: "Previous period" }).click();
  await expect(page.locator(".dc-multi-month-title").first()).toHaveText("November 2026");

  const desktopLayout = await page.locator(".dc-multi-month-section").evaluateAll(nodes =>
    nodes.slice(0, 3).map(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width };
    }),
  );
  expect(desktopLayout).toHaveLength(3);
  expect(Math.max(...desktopLayout.map(item => item.top)) - Math.min(...desktopLayout.map(item => item.top))).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 820 });
  const responsive = await page.locator(".dc-multi-month-section").evaluateAll(nodes =>
    nodes.slice(0, 2).map(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width };
    }),
  );
  expect(responsive[0].width).toBeLessThanOrEqual(366);
  expect(responsive[1].top).toBeGreaterThan(responsive[0].top);
  expect(Math.abs(responsive[1].left - responsive[0].left)).toBeLessThanOrEqual(1);
});


scenario("custom.timeline", "optional Timeline renders and mutates through generic horizontal mechanics", async ({ page }) => {
  await mountTimelineView(page);

  await expect(page.locator(".dc-timeline")).toBeVisible();
  await expect(page.locator("[data-role='title']")).toHaveText("Nov 10, 2026 – Nov 11, 2026");
  await expect(page.locator(".dc-timeline-event")).toHaveCount(3);
  await expect(page.locator(".dc-timeline-event.is-point")).toHaveCount(1);
  await expect(page.locator(".dc-timeline-background")).toHaveCount(1);
  await expect(page.getByText("Focus window", { exact: true })).toBeVisible();
  await expect(page.locator(".dc-timeline-axis-tick")).not.toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__timelineProbe.projectionCalls())).toBe(1);
  expect(await page.evaluate(() => globalThis.__timelineProbe.backgroundCalls())).toBe(1);
  const laneTops = await page.locator(".dc-timeline-event").evaluateAll(nodes =>
    nodes.map(node => Number.parseFloat(node.style.top)),
  );
  expect(new Set(laneTops).size).toBe(3);
  expect(await page.locator(".dc-timeline-event.is-point").evaluate(node => node.style.width)).toBe("10px");

  await page.locator('.dc-timeline-event[data-occurrence-id="item:timeline-a"]').click();
  expect(await page.evaluate(() => globalThis.__timelineProbe.openCalls())).toBe(1);

  const eventA = page.locator('.dc-timeline-event[data-occurrence-id="item:timeline-a"]');
  await eventA.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__timelineProbe.repository.read().items.find(item => item.id === "timeline-a")?.start,
  )).toBe("2026-11-10T09:15:00.000Z");

  const resizeEnd = page.getByRole("separator", { name: "Resize end of Timeline A" });
  await resizeEnd.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__timelineProbe.repository.read().items.find(item => item.id === "timeline-a")?.end,
  )).toBe("2026-11-10T11:30:00.000Z");

  await page.evaluate(() => globalThis.__timelineProbe.pointerMove("item:timeline-b", 60));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__timelineProbe.repository.read().items.find(item => item.id === "timeline-b")?.start,
  )).toBe("2026-11-10T10:30:00.000Z");

  await page.evaluate(() => globalThis.__timelineProbe.dispatchExternal("External timeline"));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__timelineProbe.repository.read().items.some(item => item.title === "External timeline"),
  )).toBe(true);

  await page.evaluate(() => globalThis.__timelineProbe.doubleClickTrack());
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__timelineProbe.createdSelections.length,
  )).toBe(1);
  expect(await page.evaluate(() => globalThis.__timelineProbe.createdSelections[0].allDay)).toBe(false);

  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.locator("[data-role='title']")).toHaveText("Nov 12, 2026 – Nov 13, 2026");
  await page.getByRole("button", { name: "Previous period" }).click();
  await expect(page.locator("[data-role='title']")).toHaveText("Nov 10, 2026 – Nov 11, 2026");

  await page.setViewportSize({ width: 390, height: 760 });
  const scroll = await page.locator(".dc-timeline-scroll").evaluate(node => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
});


scenario("custom.dispose", "custom-view render instances are disposed on refresh, view switch and Calendar destruction", async ({ page }) => {
  const counts = await exerciseCustomViewLifecycle(page);
  expect(counts.afterRefresh.disposes).toBeGreaterThan(counts.afterInitial.disposes);
  expect(counts.afterSwitch.disposes).toBeGreaterThanOrEqual(counts.afterRefresh.disposes);
  expect(counts.afterDestroy.disposes).toBe(counts.afterDestroy.renders);
});
