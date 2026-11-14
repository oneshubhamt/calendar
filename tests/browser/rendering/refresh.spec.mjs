import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { openHarness } from "../support/harness.mjs";

scenario("refresh.midnight", "live temporal chrome advances across midnight without re-querying projections", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-10T23:59:30.000Z") });
  await openHarness(page);
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


scenario("refresh.coalesce", "Calendar refresh coalesces invalidation bursts and awaited refresh includes the trailing authoritative query", async ({ page }) => {
  await openHarness(page);
  const result = await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const source = { id: "personal", title: "Personal", visible: true };
    const ranges = [];
    const releases = [];
    const projection = {
      id: "slow-refresh-probe",
      project(range) {
        ranges.push(structuredClone(range));
        return new Promise(resolve => releases.push(resolve));
      },
    };
    const engine = new CalendarEngine(new MemoryCalendarRepository([source], []), [projection]);
    const host = document.getElementById("browser-test-host");
    const calendar = new CalendarUi(host, engine, {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-10",
      initialView: "day",
    });

    const waitForCalls = async count => {
      while (releases.length < count) await new Promise(resolve => setTimeout(resolve, 0));
    };
    await waitForCalls(1);

    const awaited = calendar.refresh();
    let settled = false;
    void awaited.then(() => { settled = true; });
    calendar.goTo("2026-11-12");
    void calendar.refresh();
    void calendar.refresh();

    releases[0]([]);
    while (ranges.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    const settledBeforeTrailingQuery = settled;
    releases[1]([]);
    await awaited;

    const title = host.querySelector("[data-role='title']")?.textContent ?? "";
    calendar.destroy();
    return {
      calls: ranges.length,
      settledBeforeTrailingQuery,
      firstStart: ranges[0]?.start,
      trailingStart: ranges[1]?.start,
      title,
    };
  });

  expect(result.calls).toBe(2);
  expect(result.settledBeforeTrailingQuery).toBe(false);
  expect(result.firstStart).toBe("2026-11-10T00:00:00.000Z");
  expect(result.trailingStart).toBe("2026-11-12T00:00:00.000Z");
  expect(result.title).toMatch(/November 12, 2026/);
});


scenario("refresh.failure-recovery", "Calendar refresh drains a queued newer request when a superseded projection fails", async ({ page }) => {
  await openHarness(page);
  const result = await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const source = { id: "personal", title: "Personal", visible: true };
    const calls = [];
    const controls = [];
    const projection = {
      id: "failing-refresh-probe",
      project(range) {
        calls.push(structuredClone(range));
        return new Promise((resolve, reject) => controls.push({ resolve, reject }));
      },
    };
    const engine = new CalendarEngine(new MemoryCalendarRepository([source], []), [projection]);
    const host = document.getElementById("browser-test-host");
    const calendar = new CalendarUi(host, engine, {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-10",
      initialView: "day",
    });

    while (controls.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
    calendar.goTo("2026-11-12");
    const awaited = calendar.refresh();
    controls[0].reject(new Error("superseded projection failed"));

    while (controls.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    controls[1].resolve([]);
    await awaited;

    const title = host.querySelector("[data-role='title']")?.textContent ?? "";
    calendar.destroy();
    return {
      calls: calls.length,
      firstStart: calls[0]?.start,
      trailingStart: calls[1]?.start,
      title,
    };
  });

  expect(result).toMatchObject({
    calls: 2,
    firstStart: "2026-11-10T00:00:00.000Z",
    trailingStart: "2026-11-12T00:00:00.000Z",
  });
  expect(result.title).toMatch(/November 12, 2026/);
});
