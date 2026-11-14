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


async function exerciseRefreshQueue(page, mode) {
  await openHarness(page);
  return await page.evaluate(async mode => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const source = { id: "personal", title: "Personal", visible: true };
    const ranges = [];
    const controls = [];
    const projection = {
      id: "refresh-queue-probe",
      project(range) {
        ranges.push(structuredClone(range));
        return new Promise((resolve, reject) => controls.push({ resolve, reject }));
      },
    };
    const calendar = new CalendarUi(
      document.getElementById("browser-test-host"),
      new CalendarEngine(new MemoryCalendarRepository([source], []), [projection]),
      {
        locale: "en-US",
        timeZone: "UTC",
        initialDate: "2026-11-10",
        initialView: "day",
      },
    );
    const waitForCalls = async count => {
      while (controls.length < count) await new Promise(resolve => setTimeout(resolve, 0));
    };
    await waitForCalls(1);

    let awaited;
    let settled = false;
    if (mode === "coalesce") {
      awaited = calendar.refresh();
      void awaited.then(() => { settled = true; });
      calendar.goTo("2026-11-12");
      void calendar.refresh();
      void calendar.refresh();
      controls[0].resolve([]);
    } else {
      calendar.goTo("2026-11-12");
      awaited = calendar.refresh();
      controls[0].reject(new Error("superseded projection failed"));
    }

    await waitForCalls(2);
    const settledBeforeTrailingQuery = settled;
    controls[1].resolve([]);
    await awaited;

    const title = document.querySelector("#browser-test-host [data-role='title']")?.textContent ?? "";
    calendar.destroy();
    return {
      calls: ranges.length,
      firstStart: ranges[0]?.start,
      trailingStart: ranges[1]?.start,
      settledBeforeTrailingQuery,
      title,
    };
  }, mode);
}

scenario("refresh.queue", "Calendar refresh queue coalesces bursts and recovers from superseded projection failure", async ({ page }) => {
  const coalesced = await exerciseRefreshQueue(page, "coalesce");
  expect(coalesced).toMatchObject({
    calls: 2,
    firstStart: "2026-11-10T00:00:00.000Z",
    trailingStart: "2026-11-12T00:00:00.000Z",
    settledBeforeTrailingQuery: false,
  });
  expect(coalesced.title).toMatch(/November 12, 2026/);

  const recovered = await exerciseRefreshQueue(page, "failure");
  expect(recovered).toMatchObject({
    calls: 2,
    firstStart: "2026-11-10T00:00:00.000Z",
    trailingStart: "2026-11-12T00:00:00.000Z",
  });
  expect(recovered.title).toMatch(/November 12, 2026/);
});
