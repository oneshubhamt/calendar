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
    scrollHour: 6,
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


async function mountAdvancedCalendar(page, view, { narrow = false } = {}) {
  if (narrow) await page.setViewportSize({ width: 480, height: 900 });
  await page.clock.setFixedTime(new Date("2026-11-10T05:00:00.000Z"));
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async ({ view }) => {
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
    const sources=[
      {id:"personal",title:"Personal",visible:true,display:{color:"#e8f0fe",textColor:"#174ea6"}},
      {id:"work",title:"Work",visible:true,display:{color:"#e6f4ea",textColor:"#137333"}},
    ];
    const items=[
      {id:"a",calendarId:"personal",title:"Planning",start:"2026-11-10T09:00:00Z",end:"2026-11-10T10:30:00Z",kind:"event",ownership:"calendar",editPolicy:"full"},
      {id:"b",calendarId:"work",title:"Review",start:"2026-11-11T11:00:00Z",end:"2026-11-11T13:00:00Z",kind:"event",ownership:"calendar",editPolicy:"full"},
      {id:"c",calendarId:"personal",title:"Deadline",start:"2026-12-04",end:"2026-12-05",allDay:true,precision:"date",temporal:{kind:"date"},kind:"event",ownership:"calendar",editPolicy:"full"},
      {id:"d",calendarId:"work",title:"January planning",start:"2027-01-07T08:00:00Z",end:"2027-01-07T09:00:00Z",kind:"event",ownership:"calendar",editPolicy:"full"},
    ];
    const backgrounds={id:"advanced-bg",projectBackgroundRanges(){return [
      {id:"window",start:"2026-11-10T08:00:00Z",end:"2026-11-10T17:00:00Z",label:"Available window",display:{color:"#34a853"}},
    ];}};
    const calendar=new CalendarUi(
      document.getElementById("browser-test-host"),
      new CalendarEngine(new MemoryCalendarRepository(sources,items),[],[],[backgrounds]),
      {
        locale:"en-US",timeZone:"UTC",initialDate:"2026-11-09",initialView:view,
        customViews:[createMultiMonthView({months:3}),createTimelineView({spanDays:7,pixelsPerHour:64})],
        weekNumbers:{minimumDaysInFirstWeek:4},
      },
    );
    await calendar.refresh();
    globalThis.__advancedVisualCalendar=calendar;
  }, { view });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("Multi-Month desktop visual baseline", async ({ page }) => {
  await mountAdvancedCalendar(page, "multi-month");
  await expect(page.locator(".dc-root")).toHaveScreenshot("multi-month-desktop.png");
});

test("Multi-Month narrow visual baseline", async ({ page }) => {
  await mountAdvancedCalendar(page, "multi-month", { narrow: true });
  await expect(page.locator(".dc-root")).toHaveScreenshot("multi-month-narrow.png");
});

test("Timeline desktop visual baseline", async ({ page }) => {
  await mountAdvancedCalendar(page, "timeline");
  await expect(page.locator(".dc-root")).toHaveScreenshot("timeline-desktop.png");
});

test("detached print snapshot visual baseline", async ({ page }) => {
  await mountAdvancedCalendar(page, "multi-month");
  await page.evaluate(() => {
    const snapshot=globalThis.__advancedVisualCalendar.createPrintSnapshot({title:"Calendar print"});
    document.body.append(snapshot);
  });
  await expect(page.locator(".dc-print-snapshot")).toHaveScreenshot("print-multi-month.png");
});

test("Resource TimeGrid desktop visual baseline", async ({ page }) => {
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async () => {
    const { CalendarResourceTimeGridUi } = await import("/dist/features/resource-time-grid-ui/index.js");
    const host=document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui=new CalendarResourceTimeGridUi(host,{
      timeZone:"UTC",dayStartHour:8,dayEndHour:18,minColumnWidth:220,pixelsPerMinute:0.8,
    });
    ui.setProjection({
      resources:[
        {id:"rooms",title:"Rooms"},
        {id:"a",title:"Room A",parentId:"rooms",order:1,acceptsAssignments:true,display:{color:"#1a73e8"}},
        {id:"b",title:"Room B",parentId:"rooms",order:2,acceptsAssignments:true,display:{color:"#34a853"}},
      ],
      occurrences:[
        {occurrenceId:"visit",sourceItemId:"visit",calendarId:"calendar",title:"Consultation",start:"2026-11-10T09:00:00Z",end:"2026-11-10T10:30:00Z",originalStart:"2026-11-10T09:00:00Z",recurring:false,kind:"event",ownership:"host",editPolicy:"full"},
        {occurrenceId:"review",sourceItemId:"review",calendarId:"calendar",title:"Review",start:"2026-11-10T09:45:00Z",end:"2026-11-10T11:00:00Z",originalStart:"2026-11-10T09:45:00Z",recurring:false,kind:"event",ownership:"host",editPolicy:"full"},
        {occurrenceId:"maintenance",sourceItemId:"maintenance",calendarId:"calendar",title:"Maintenance",start:"2026-11-10",end:"2026-11-11",allDay:true,precision:"date",temporal:{kind:"date"},originalStart:"2026-11-10",recurring:false,kind:"event",ownership:"host",editPolicy:"full"},
      ],
      assignments:[
        {occurrenceId:"visit",resourceIds:["a"]},
        {occurrenceId:"review",resourceIds:["a","b"]},
        {occurrenceId:"maintenance",resourceIds:["b"]},
      ],
      availability:[
        {id:"a-open",definitionId:"open",resourceId:"a",state:"available",start:"2026-11-10T08:00:00Z",end:"2026-11-10T17:00:00Z",label:"Available"},
        {id:"b-block",definitionId:"block",resourceId:"b",state:"unavailable",start:"2026-11-10T12:00:00Z",end:"2026-11-10T13:00:00Z",label:"Unavailable"},
      ],
      range:{start:"2026-11-10T00:00:00Z",end:"2026-11-11T00:00:00Z"},
    });
  });
  await expect(page.locator(".dc-rtg-root")).toHaveScreenshot("resource-time-grid-desktop.png");
});
