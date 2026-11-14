import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { mountVisualCalendar } from "../visual-fixture.mjs";
import { openHarness } from "../support/harness.mjs";

scenario("print.snapshot", "print snapshot is detached, read-only, isolated and print media expands clipped surfaces", async ({ page }) => {
  await mountVisualCalendar(page, { view: "week", scrollHour: 8, print: true });

  const structural = await page.evaluate(async () => {
    const first = globalThis.__visualCalendar.calendar;
    const liveBody = document.querySelector("#browser-test-host > .dc-root .dc-body");
    const liveEvent = document.querySelector("#browser-test-host > .dc-root .dc-time-event");
    if (!(liveBody instanceof HTMLElement) || !(liveEvent instanceof HTMLElement)) throw new Error("Primary calendar missing");

    const canonicalHeight = liveEvent.style.getPropertyValue("--dc-print-event-height");
    liveEvent.classList.add("is-dragging", "is-command-preview", "is-pending");
    liveEvent.setAttribute("aria-busy", "true");
    liveEvent.style.transform = "translateY(120px)";
    liveEvent.style.height = "180px";
    liveEvent.style.opacity = ".2";
    const scrollTopBefore = liveBody.scrollTop;

    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const secondHost = document.createElement("div");
    secondHost.id = "second-print-calendar";
    document.body.append(secondHost);
    const source = { id: "second", title: "Second", visible: true, removable: true };
    const item = {
      id: "second-only",
      calendarId: "second",
      title: "Second calendar only",
      start: "2026-11-10T09:00:00.000Z",
      end: "2026-11-10T10:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const second = new CalendarUi(
      secondHost,
      new CalendarEngine(new MemoryCalendarRepository([source], [item])),
      { locale: "en-US", timeZone: "UTC", initialDate: "2026-11-10", initialView: "day", chrome: { toolbar: false } },
    );
    await second.refresh();

    const revisionBefore = globalThis.__visualCalendar.repository.read().revision;
    const snapshot = first.createPrintSnapshot();
    const secondSnapshot = second.createPrintSnapshot({ title: "Second print" });
    const cloneEvent = snapshot.querySelector(".dc-time-event");
    cloneEvent?.querySelector(".dc-occurrence-main")?.click();
    const revisionAfter = globalThis.__visualCalendar.repository.read().revision;
    const detached = !snapshot.isConnected;
    const result = {
      detached,
      inert: snapshot.inert,
      styleCopies: snapshot.querySelectorAll("style[data-calendar-print-styles='true']").length,
      headings: snapshot.querySelectorAll(".dc-print-heading").length,
      toolbar: snapshot.querySelectorAll(".dc-toolbar").length,
      resizeHandles: snapshot.querySelectorAll(".dc-resize-handle,.dc-timeline-resize-handle").length,
      inlineActions: snapshot.querySelectorAll(".dc-inline-actions").length,
      ariaBusy: snapshot.querySelectorAll("[aria-busy]").length,
      transient: cloneEvent instanceof HTMLElement
        ? ["is-dragging", "is-command-preview", "is-pending"].some(token => cloneEvent.classList.contains(token))
        : true,
      cloneGeometryRestored: cloneEvent instanceof HTMLElement
        && cloneEvent.style.transform === ""
        && cloneEvent.style.height === canonicalHeight
        && cloneEvent.style.opacity === "",
      liveTransientPreserved: ["is-dragging", "is-command-preview", "is-pending"].every(token => liveEvent.classList.contains(token)),
      liveScrollUnchanged: liveBody.scrollTop === scrollTopBefore,
      firstContainsSecond: snapshot.textContent?.includes("Second calendar only") ?? false,
      secondContainsFirst: secondSnapshot.textContent?.includes("Morning focus") ?? false,
      secondTitle: secondSnapshot.querySelector(".dc-print-heading")?.textContent,
      repositoryUnchanged: revisionAfter === revisionBefore,
    };

    document.body.append(snapshot);
    globalThis.__printSnapshot = snapshot;
    globalThis.__secondPrintCalendar = second;
    return result;
  });

  expect(structural).toEqual({
    detached: true,
    inert: true,
    styleCopies: 1,
    headings: 1,
    toolbar: 0,
    resizeHandles: 0,
    inlineActions: 0,
    ariaBusy: 0,
    transient: false,
    cloneGeometryRestored: true,
    liveTransientPreserved: true,
    liveScrollUnchanged: true,
    firstContainsSecond: false,
    secondContainsFirst: false,
    secondTitle: "Second print",
    repositoryUnchanged: true,
  });

  await page.locator("#browser-test-host .dc-time-event .dc-occurrence-main").first().evaluate(node => node.click());
  await expect(page.locator(".dc-dialog")).toBeVisible();

  await page.emulateMedia({ media: "print" });
  const printStyles = await page.evaluate(() => {
    const snapshot = document.querySelector(".dc-print-snapshot");
    const snapshotRoot = snapshot?.querySelector(".dc-root");
    const snapshotBody = snapshot?.querySelector(".dc-body");
    const liveToolbar = document.querySelector("#browser-test-host > .dc-root .dc-toolbar");
    const liveToolbarButton = liveToolbar?.querySelector("button");
    const liveToolbarTitle = liveToolbar?.querySelector(".dc-title");
    const liveDialog = document.querySelector(".dc-dialog");
    const liveEvent = document.querySelector("#browser-test-host > .dc-root .dc-time-event");
    const weekHeaders = snapshot?.querySelector(".dc-day-headers");
    if (!(snapshotRoot instanceof HTMLElement) || !(snapshotBody instanceof HTMLElement)) throw new Error("Print snapshot missing");
    return {
      rootOverflow: getComputedStyle(snapshotRoot).overflow,
      bodyOverflow: getComputedStyle(snapshotBody).overflow,
      bodyHeight: getComputedStyle(snapshotBody).height,
      toolbarDisplay: liveToolbar instanceof HTMLElement ? getComputedStyle(liveToolbar).display : "missing",
      toolbarButtonDisplay: liveToolbarButton instanceof HTMLElement ? getComputedStyle(liveToolbarButton).display : "missing",
      toolbarTitleDisplay: liveToolbarTitle instanceof HTMLElement ? getComputedStyle(liveToolbarTitle).display : "missing",
      dialogDisplay: liveDialog instanceof HTMLElement ? getComputedStyle(liveDialog).display : "missing",
      headerPosition: weekHeaders instanceof HTMLElement ? getComputedStyle(weekHeaders).position : "missing",
      liveEventTransform: liveEvent instanceof HTMLElement ? getComputedStyle(liveEvent).transform : "missing",
      liveEventHeight: liveEvent instanceof HTMLElement ? getComputedStyle(liveEvent).height : "missing",
      liveEventPrintHeight: liveEvent instanceof HTMLElement ? liveEvent.style.getPropertyValue("--dc-print-event-height") : "missing",
      liveEventOpacity: liveEvent instanceof HTMLElement ? getComputedStyle(liveEvent).opacity : "missing",
    };
  });
  expect(printStyles.rootOverflow).toBe("visible");
  expect(printStyles.bodyOverflow).toBe("visible");
  expect(printStyles.bodyHeight).not.toBe("0px");
  expect(printStyles.toolbarDisplay).toBe("block");
  expect(printStyles.toolbarButtonDisplay).toBe("none");
  expect(printStyles.toolbarTitleDisplay).toBe("block");
  expect(printStyles.dialogDisplay).toBe("none");
  expect(printStyles.headerPosition).toBe("static");
  expect(printStyles.liveEventTransform).toBe("none");
  expect(printStyles.liveEventHeight).toBe(printStyles.liveEventPrintHeight);
  expect(printStyles.liveEventOpacity).toBe("1");
});


scenario("print.all-views", "print snapshots cover all built-in views plus optional Multi-Month and Timeline through one API", async ({ page }) => {
  await openHarness(page);
  const results = await page.evaluate(async () => {
    const [
      { CalendarEngine },
      { MemoryCalendarRepository },
      { CalendarUi },
      { createMultiMonthView },
      { createTimelineView },
    ] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/multi-month.js"),
      import("/dist/view/timeline.js"),
    ]);

    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "print-event",
      calendarId: "personal",
      title: "Printable event",
      start: "2026-11-10T09:00:00.000Z",
      end: "2026-11-10T10:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const calendar = new CalendarUi(
      document.getElementById("browser-test-host"),
      new CalendarEngine(new MemoryCalendarRepository([source], [item])),
      {
        locale: "en-US",
        timeZone: "UTC",
        initialDate: "2026-11-10",
        initialView: "month",
        customViews: [createMultiMonthView({ months: 3 }), createTimelineView({ spanDays: 7 })],
      },
    );
    await calendar.refresh();
    globalThis.__printCoverageCalendar = calendar;

    const cases = [
      ["month", ".dc-month-grid"],
      ["week", ".dc-time-grid"],
      ["day", ".dc-time-grid"],
      ["year", ".dc-year-grid"],
      ["agenda", ".dc-agenda"],
      ["multi-month", ".dc-multi-month"],
      ["timeline", ".dc-timeline"],
    ];
    const output = [];
    for (const [view, selector] of cases) {
      calendar.setView(view);
      await calendar.refresh();
      const snapshot = calendar.createPrintSnapshot({ title: `Print ${view}` });
      output.push({
        view,
        detached: !snapshot.isConnected,
        selectorFound: Boolean(snapshot.querySelector(selector)),
        heading: snapshot.querySelector(".dc-print-heading")?.textContent,
        toolbar: snapshot.querySelectorAll(".dc-toolbar").length,
      });
    }

    let invalidTitle = "";
    try {
      calendar.createPrintSnapshot({ title: "" });
    } catch (error) {
      invalidTitle = error instanceof Error ? error.message : String(error);
    }
    const noHeading = calendar.createPrintSnapshot({ title: false });

    return {
      output,
      invalidTitle,
      noHeadingCount: noHeading.querySelectorAll(".dc-print-heading").length,
    };
  });

  for (const entry of results.output) {
    expect(entry.detached).toBe(true);
    expect(entry.selectorFound, entry.view).toBe(true);
    expect(entry.heading).toBe(`Print ${entry.view}`);
    expect(entry.toolbar).toBe(0);
  }
  expect(results.invalidTitle).toMatch(/1–256 characters/);
  expect(results.noHeadingCount).toBe(0);

  for (const view of ["month", "week", "multi-month", "timeline"]) {
    await page.evaluate(async viewId => {
      const calendar = globalThis.__printCoverageCalendar;
      calendar.setView(viewId);
      await calendar.refresh();
      document.querySelector(".dc-print-snapshot")?.remove();
      const snapshot = calendar.createPrintSnapshot({ title: `Print ${viewId}` });
      document.body.append(snapshot);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, view);
  }
});
