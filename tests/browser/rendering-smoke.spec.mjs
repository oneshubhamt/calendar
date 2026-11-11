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
        root.dataset.collectionsFrozen = String(
          Object.isFrozen(context.sources)
          && Object.isFrozen(context.occurrences)
          && Object.isFrozen(context.backgroundRanges),
        );
        const occurrence = context.occurrences[0];
        if (!occurrence) return root;
        root.dataset.forgedMovable = String(context.actions.canMoveOccurrence({
          ...occurrence,
          occurrenceId: "forged-occurrence",
        }));
        const presentation = context.actions.occurrencePresentation(occurrence);
        root.dataset.presentedTitle = typeof presentation.title === "string"
          ? presentation.title
          : presentation.title?.text ?? occurrence.title;

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
      extensions: [{
        presentOccurrence(occurrence) {
          if (occurrence.sourceItemId !== "custom-event") return undefined;
          return { title: "Presented custom event", badges: [{ label: "Custom badge" }] };
        },
      }],
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
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-presented-title", "Presented custom event");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-collections-frozen", "true");
  await expect(page.locator(".custom-two-day-view")).toHaveAttribute("data-forged-movable", "false");

  const exposed = await page.locator(".custom-two-day-view").evaluate(node => ({
    context: node.dataset.contextKeys,
    actions: node.dataset.actionKeys,
  }));
  expect(exposed.context).not.toMatch(/repository|storage|engine/i);
  expect(exposed.actions).not.toMatch(/repository|storage|engine|commandHandler/i);
  expect(exposed.actions).toContain("moveOccurrence");
  expect(exposed.actions).toContain("resizeOccurrence");
  expect(exposed.actions).toContain("occurrencePresentation");
  expect(exposed.actions).toContain("canAcceptExternalDrop");
  expect(exposed.actions).toContain("dropExternal");
  expect(exposed.actions).toContain("bindExternalDropTarget");

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


test("Month week numbers are optional accessible and narrow-screen safe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto("/tests/browser/harness.html");

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

  const visualCapture = await page.locator(".dc-month-panel").screenshot();
  expect(visualCapture.byteLength).toBeGreaterThan(1_000);
});

test("external DOM drops create through Calendar authority while internal drag remains a move", async ({ page }) => {
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async () => {
    const [
      { CalendarEngine },
      { MemoryCalendarRepository },
      { RepositoryCommandHandler },
      { CalendarUi },
      { CALENDAR_EXTERNAL_DROP_MIME, setCalendarExternalDropData },
    ] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/external-drop.js"),
    ]);

    const sources = [
      { id: "personal", title: "Personal", visible: true, removable: true },
      { id: "locked", title: "Locked", visible: true, removable: true, readOnly: true },
    ];
    const initial = {
      id: "internal",
      calendarId: "personal",
      title: "Internal event",
      start: "2026-11-05",
      end: "2026-11-06",
      allDay: true,
      precision: "date",
      temporal: { kind: "date" },
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const collision = {
      id: "collision",
      calendarId: "personal",
      title: "Collision fixture",
      start: "2026-11-10T12:00:00.000Z",
      end: "2026-11-10T13:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const repository = new MemoryCalendarRepository(sources, [initial, collision]);
    const purposes = [];
    let decoderCalls = 0;
    const customDropView = {
      id: "external-drop-view",
      label: "Drop view",
      range(context) {
        const start = new Date(context.anchor);
        start.setUTCHours(0, 0, 0, 0);
        return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
      },
      shiftAnchor(context, direction) {
        return new Date(context.anchor.getTime() + direction * 86400000);
      },
      title() { return "External drop custom view"; },
      render(context) {
        const target = document.createElement("section");
        target.className = "custom-external-drop-target";
        target.textContent = "Custom drop target";
        context.actions.bindExternalDropTarget(target, () => ({
          start: "2026-11-15T00:00:00.000Z",
          end: "2026-11-16T00:00:00.000Z",
          allDay: true,
        }));
        return target;
      },
    };
    const calendar = new CalendarUi(
      document.getElementById("browser-test-host"),
      new CalendarEngine(repository),
      {
        locale: "en-US",
        timeZone: "UTC",
        initialDate: "2026-11-10",
        initialView: "month",
        customViews: [customDropView],
        dayStartHour: 8,
        dayEndHour: 18,
        slotMinutes: 30,
        snapPolicy: { selection: "floor", move: "round", resize: "round", keyboardStepMinutes: 30 },
        commandHandler: new RepositoryCommandHandler(repository),
        navigationBounds: { min: "2026-11-01", max: "2026-11-15" },
        collisionPolicy: { mode: "prevent", includeAllDay: false },
        itemFactory({ id, now, purpose, draft }) {
          purposes.push(purpose);
          return {
            ...draft,
            ...(draft.title === "Factory redirect" ? { calendarId: "locked" } : {}),
            id,
            ownership: "calendar",
            editPolicy: "full",
            createdAt: now,
            updatedAt: now,
          };
        },
        externalDropDecoder: {
          types: ["application/x-host-task"],
          decode(dataTransfer) {
            decoderCalls += 1;
            return JSON.parse(dataTransfer.getData("application/x-host-task"));
          },
        },
        placementGuards: [{
          id: "block-nov-14",
          evaluate(context) {
            return context.start.startsWith("2026-11-14T")
              ? { mode: "prevent", message: "Fixture blocked date." }
              : { mode: "allow" };
          },
        }],
      },
    );
    await calendar.refresh();

    const addSource = (id, writer) => {
      const source = document.createElement("button");
      source.id = id;
      source.type = "button";
      source.draggable = true;
      source.textContent = id;
      source.addEventListener("dragstart", event => {
        if (event.dataTransfer) writer(event.dataTransfer);
      });
      document.body.append(source);
    };
    addSource("external-month", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "External month",
      durationDays: 2,
      metadata: { origin: "outside-dom" },
    }));
    addSource("external-locked", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Locked external",
      calendarId: "locked",
    }));
    addSource("external-malformed", dataTransfer => {
      dataTransfer.setData(CALENDAR_EXTERNAL_DROP_MIME, "{malformed");
      dataTransfer.effectAllowed = "copy";
    });
    addSource("external-custom", dataTransfer => {
      dataTransfer.setData("application/x-host-task", JSON.stringify({
        title: "Host decoded",
        durationDays: 1,
        kind: "task",
      }));
      dataTransfer.effectAllowed = "copy";
    });
    addSource("external-blocked", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Blocked external",
    }));
    addSource("external-lane", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "All-day lane",
    }));
    addSource("external-timed", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Timed external",
      durationMinutes: 90,
    }));
    addSource("external-collision", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Collision external",
      durationMinutes: 60,
    }));
    addSource("external-out-of-bounds", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Out of bounds external",
    }));
    addSource("external-factory-redirect", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Factory redirect",
    }));
    addSource("external-custom-view", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Custom view external",
    }));

    const dispatchDrag = (source, target, clientY) => {
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
      const rect = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.left + Math.min(12, Math.max(1, rect.width / 2)),
        clientY: clientY ?? rect.top + Math.min(12, Math.max(1, rect.height / 2)),
      };
      const callsBeforeHover = decoderCalls;
      target.dispatchEvent(new DragEvent("dragenter", init));
      target.dispatchEvent(new DragEvent("dragover", init));
      const accepted = target.classList.contains("is-external-drop-target");
      const callsAfterHover = decoderCalls;
      target.dispatchEvent(new DragEvent("drop", init));
      source.dispatchEvent(new DragEvent("dragend", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
      return {
        accepted,
        callsBeforeHover,
        callsAfterHover,
        callsAfterDrop: decoderCalls,
        targetStillActive: target.classList.contains("is-external-drop-target"),
      };
    };

    const monthCell = date => document.querySelector(
      `.dc-day-cell[data-calendar-date^="${date}"]`,
    );
    globalThis.__externalDropProbe = {
      calendar,
      repository,
      purposes,
      decoderCalls: () => decoderCalls,
      dropMonth(sourceId, date) {
        const source = document.getElementById(sourceId);
        const target = monthCell(date);
        if (!source || !target) throw new Error("Month drag fixture target missing");
        return dispatchDrag(source, target);
      },
      moveInternal(date) {
        const source = [...document.querySelectorAll(".dc-event")]
          .find(node => node.textContent?.includes("Internal event"));
        const target = monthCell(date);
        if (!source || !target) throw new Error("Internal drag fixture target missing");
        return dispatchDrag(source, target);
      },
      async showDay(date) {
        calendar.setView("day");
        calendar.goTo(new Date(`${date}T00:00:00.000Z`));
        await calendar.refresh();
      },
      dropAllDay(sourceId) {
        const source = document.getElementById(sourceId);
        const target = document.querySelector(".dc-all-day-col");
        if (!source || !target) throw new Error("All-day drag fixture target missing");
        return dispatchDrag(source, target);
      },
      dropTimed(sourceId, minuteOffset) {
        const source = document.getElementById(sourceId);
        const target = document.querySelector(".dc-time-column");
        if (!source || !target) throw new Error("Timed drag fixture target missing");
        const rect = target.getBoundingClientRect();
        return dispatchDrag(source, target, rect.top + minuteOffset);
      },
      async showCustomDropView() {
        calendar.setView("external-drop-view");
        await calendar.refresh();
      },
      dropCustomView(sourceId) {
        const source = document.getElementById(sourceId);
        const target = document.querySelector(".custom-external-drop-target");
        if (!source || !target) throw new Error("Custom-view drag fixture target missing");
        return dispatchDrag(source, target);
      },
    };
  });

  const internalResult = await page.evaluate(() => globalThis.__externalDropProbe.moveInternal("2026-11-06"));
  expect(internalResult.accepted).toBe(false);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.id === "internal")?.start,
  )).toBe("2026-11-06");
  expect(await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length)).toBe(2);

  const monthResult = await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-month", "2026-11-10"));
  expect(monthResult.accepted).toBe(true);
  expect(monthResult.targetStillActive).toBe(false);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "External month")?.end,
  )).toBe("2026-11-12");
  expect(await page.evaluate(() => {
    const item = globalThis.__externalDropProbe.repository.read().items.find(row => row.title === "External month");
    return {
      start: item?.start,
      allDay: item?.allDay,
      precision: item?.precision,
      temporalKind: item?.temporal?.kind,
      metadata: item?.metadata,
    };
  })).toEqual({
    start: "2026-11-10",
    allDay: true,
    precision: "date",
    temporalKind: "date",
    metadata: { origin: "outside-dom" },
  });

  await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-locked", "2026-11-11"));
  await page.waitForTimeout(20);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Locked external"),
  )).toBe(false);

  const beforeMalformed = await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length);
  const malformedResult = await page.evaluate(() =>
    globalThis.__externalDropProbe.dropMonth("external-malformed", "2026-11-12"),
  );
  expect(malformedResult.accepted).toBe(true);
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length)).toBe(beforeMalformed);

  const outOfBoundsResult = await page.evaluate(() =>
    globalThis.__externalDropProbe.dropMonth("external-out-of-bounds", "2026-11-16"),
  );
  expect(outOfBoundsResult.accepted).toBe(false);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Out of bounds external"),
  )).toBe(false);

  await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-factory-redirect", "2026-11-12"));
  await page.waitForTimeout(20);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Factory redirect"),
  )).toBe(false);

  const customResult = await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-custom", "2026-11-13"));
  expect(customResult.accepted).toBe(true);
  expect(customResult.callsAfterHover).toBe(customResult.callsBeforeHover);
  expect(customResult.callsAfterDrop).toBe(customResult.callsBeforeHover + 1);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "Host decoded")?.kind,
  )).toBe("task");

  await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-blocked", "2026-11-14"));
  await page.waitForTimeout(20);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Blocked external"),
  )).toBe(false);

  await page.evaluate(() => globalThis.__externalDropProbe.showDay("2026-11-10"));
  await expect(page.locator(".dc-all-day-col")).toBeVisible();

  const laneResult = await page.evaluate(() => globalThis.__externalDropProbe.dropAllDay("external-lane"));
  expect(laneResult.accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "All-day lane")?.start,
  )).toBe("2026-11-10");

  const timedResult = await page.evaluate(() => globalThis.__externalDropProbe.dropTimed("external-timed", 95));
  expect(timedResult.accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "Timed external")?.start,
  )).toBe("2026-11-10T09:30:00.000Z");
  expect(await page.evaluate(() => {
    const item = globalThis.__externalDropProbe.repository.read().items.find(row => row.title === "Timed external");
    return {
      end: item?.end,
      allDay: item?.allDay,
      temporalKind: item?.temporal?.kind,
    };
  })).toEqual({
    end: "2026-11-10T11:00:00.000Z",
    allDay: false,
    temporalKind: "instant",
  });

  const beforeCollision = await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length);
  const collisionResult = await page.evaluate(() =>
    globalThis.__externalDropProbe.dropTimed("external-collision", 245),
  );
  expect(collisionResult.accepted).toBe(true);
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length)).toBe(beforeCollision);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Collision external"),
  )).toBe(false);

  await page.evaluate(() => globalThis.__externalDropProbe.showCustomDropView());
  await expect(page.locator(".custom-external-drop-target")).toBeVisible();
  const customViewResult = await page.evaluate(() =>
    globalThis.__externalDropProbe.dropCustomView("external-custom-view"),
  );
  expect(customViewResult.accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "Custom view external")?.start,
  )).toBe("2026-11-15");

  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.purposes.filter(value => value === "external-drop").length,
  )).toBeGreaterThanOrEqual(7);
});
