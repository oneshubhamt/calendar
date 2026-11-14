import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { openHarness } from "../support/harness.mjs";

scenario("custom.host-view", "registered custom views own range navigation rendering and use only the bounded Calendar action port", async ({ page }) => {
  await openHarness(page);
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
      metadata: { nested: { value: "safe" } },
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
        root.dataset.minimumDaysInFirstWeek = String(context.weekNumbering?.minimumDaysInFirstWeek ?? "");
        root.dataset.contextKeys = Object.keys(context).sort().join(",");
        root.dataset.actionKeys = Object.keys(context.actions).sort().join(",");
        root.dataset.rendererKeys = Object.keys(context.renderers).sort().join(",");
        root.dataset.renderersFrozen = String(Object.isFrozen(context.renderers));
        root.dataset.collectionsFrozen = String(
          Object.isFrozen(context.sources)
          && Object.isFrozen(context.occurrences)
          && Object.isFrozen(context.backgroundRanges),
        );
        const occurrence = context.occurrences[0];
        root.dataset.occurrenceFrozen = String(Boolean(
          occurrence
          && Object.isFrozen(occurrence)
          && Object.isFrozen(occurrence.metadata)
          && Object.isFrozen(occurrence.metadata?.nested),
        ));
        if (occurrence) {
          try { occurrence.title = "mutated"; } catch {}
          try { occurrence.metadata.nested.value = "mutated"; } catch {}
          root.dataset.occurrenceOwned = String(
            occurrence.title === "Custom event" && occurrence.metadata?.nested?.value === "safe",
          );
        }
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
      weekNumbers: { minimumDaysInFirstWeek: 4 },
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
  await openHarness(page);
  await page.evaluate(async () => {
    const [
      { CalendarEngine },
      { MemoryCalendarRepository },
      { RepositoryCommandHandler },
      { CalendarUi },
      { createMultiMonthView },
      { setCalendarExternalDropData },
    ] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/multi-month.js"),
      import("/dist/view/external-drop.js"),
    ]);

    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const items = [
      {
        id: "move-me",
        calendarId: "personal",
        title: "Move me",
        start: "2026-11-12T09:00:00.000Z",
        end: "2026-11-12T10:00:00.000Z",
        kind: "event",
        ownership: "calendar",
        editPolicy: "full",
      },
      {
        id: "monthly-review",
        calendarId: "personal",
        seriesId: "monthly-review",
        title: "Monthly review",
        start: "2026-11-10T11:00:00.000Z",
        end: "2026-11-10T12:00:00.000Z",
        kind: "event",
        ownership: "calendar",
        editPolicy: "full",
        recurrence: { rule: { frequency: "monthly", count: 3 } },
      },
    ];
    const repository = new MemoryCalendarRepository([source], items);
    const commands = new RepositoryCommandHandler(repository);
    let projectionCalls = 0;
    let backgroundCalls = 0;
    const projectedRanges = [];
    const projection = {
      id: "multi-month-query-probe",
      project(range) {
        projectionCalls += 1;
        projectedRanges.push({ ...range });
        return [];
      },
    };
    const backgrounds = {
      id: "multi-month-backgrounds",
      projectBackgroundRanges() {
        backgroundCalls += 1;
        return [{
          id: "january-background",
          start: "2027-01-05T00:00:00.000Z",
          end: "2027-01-06T00:00:00.000Z",
          allDay: true,
          label: "January background",
        }];
      },
    };
    const engine = new CalendarEngine(repository, [projection], [], [backgrounds]);
    const createdSelections = [];
    const view = createMultiMonthView({ months: 3, columns: "auto", stepMonths: 3 });
    const calendar = new CalendarUi(document.getElementById("browser-test-host"), engine, {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-15T12:00:00.000Z",
      initialView: "multi-month",
      customViews: [view],
      externalDrop: true,
      weekStartsOn: 1,
      weekNumbers: { minimumDaysInFirstWeek: 4 },
      defaultCalendarId: "personal",
      commandHandler: commands,
      callbacks: {
        handleCreate(selection) {
          createdSelections.push(selection);
          return true;
        },
      },
    });

    projectionCalls = 0;
    backgroundCalls = 0;
    projectedRanges.length = 0;
    await calendar.refresh();

    const dispatchExternal = (date, title) => {
      const target = document.querySelector(`.dc-day-cell[data-calendar-date^="${date}"]`);
      if (!(target instanceof HTMLElement)) throw new Error(`Multi-Month drop target missing for ${date}`);
      const transfer = new DataTransfer();
      setCalendarExternalDropData(transfer, { title });
      target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    };

    const createOn = date => {
      const target = document.querySelector(`.dc-day-cell[data-calendar-date^="${date}"]`);
      if (!(target instanceof HTMLElement)) throw new Error(`Multi-Month create target missing for ${date}`);
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    };

    const moveInternal = date => {
      const source = [...document.querySelectorAll(".dc-event")]
        .find(node => node.textContent?.includes("Move me"));
      const target = document.querySelector(`.dc-day-cell[data-calendar-date^="${date}"]`);
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        throw new Error("Multi-Month internal drag fixture target missing");
      }
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
      const rect = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.left + Math.min(12, Math.max(1, rect.width / 2)),
        clientY: rect.top + Math.min(12, Math.max(1, rect.height / 2)),
      };
      target.dispatchEvent(new DragEvent("dragenter", init));
      target.dispatchEvent(new DragEvent("dragover", init));
      target.dispatchEvent(new DragEvent("drop", init));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
    };

    globalThis.__multiMonthProbe = {
      calendar,
      repository,
      projectionCalls: () => projectionCalls,
      backgroundCalls: () => backgroundCalls,
      projectedRanges,
      createdSelections,
      dispatchExternal,
      createOn,
      moveInternal,
    };
  });

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
  expect(await page.evaluate(() => globalThis.__multiMonthProbe.projectedRanges[0])).toEqual({
    start: "2026-10-26T00:00:00.000Z",
    end: "2027-02-08T00:00:00.000Z",
  });

  await expect(page.getByText("Monthly review", { exact: true })).toHaveCount(3);
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
  await page.setViewportSize({ width: 980, height: 760 });
  await openHarness(page);
  await page.evaluate(async () => {
    const [
      { CalendarEngine },
      { MemoryCalendarRepository },
      { RepositoryCommandHandler },
      { CalendarUi },
      { createTimelineView },
      { setCalendarExternalDropData },
    ] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/timeline.js"),
      import("/dist/view/external-drop.js"),
    ]);

    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const items = [
      {
        id: "timeline-a", calendarId: "personal", title: "Timeline A",
        start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T11:00:00.000Z",
        kind: "event", ownership: "calendar", editPolicy: "full",
      },
      {
        id: "timeline-b", calendarId: "personal", title: "Timeline B",
        start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T12:00:00.000Z",
        kind: "event", ownership: "calendar", editPolicy: "full",
      },
      {
        id: "timeline-point", calendarId: "personal", title: "Timeline point",
        start: "2026-11-10T10:30:00.000Z", end: "2026-11-10T10:30:00.000Z",
        temporalForm: "point",
        kind: "event", ownership: "calendar", editPolicy: "full",
      },
    ];
    const repository = new MemoryCalendarRepository([source], items);
    let projectionCalls = 0;
    const projectedRanges = [];
    const projection = {
      id: "timeline-query-probe",
      project(range) {
        projectionCalls += 1;
        projectedRanges.push({ ...range });
        return [];
      },
    };
    let backgroundCalls = 0;
    const backgrounds = {
      id: "timeline-backgrounds",
      projectBackgroundRanges() {
        backgroundCalls += 1;
        return [{
          id: "focus-window",
          start: "2026-11-10T08:00:00.000Z",
          end: "2026-11-10T13:00:00.000Z",
          label: "Focus window",
        }];
      },
    };
    const engine = new CalendarEngine(repository, [projection], [], [backgrounds]);
    const createdSelections = [];
    let openCalls = 0;
    const calendar = new CalendarUi(document.getElementById("browser-test-host"), engine, {
      locale: "en-US",
      timeZone: "UTC",
      initialDate: "2026-11-10T12:00:00.000Z",
      initialView: "timeline",
      externalDrop: true,
      customViews: [createTimelineView({
        spanDays: 2,
        stepDays: 2,
        pixelsPerHour: 120,
        minWidth: 1600,
        axisTickMinutes: 360,
      })],
      defaultCalendarId: "personal",
      commandHandler: new RepositoryCommandHandler(repository),
      slotMinutes: 15,
      snapPolicy: { move: "round", resize: "round", selection: "round", keyboardStepMinutes: 15 },
      callbacks: {
        handleOpen() { openCalls += 1; return true; },
        handleCreate(selection) { createdSelections.push({ ...selection }); return true; },
      },
    });
    projectionCalls = 0;
    backgroundCalls = 0;
    projectedRanges.length = 0;
    await calendar.refresh();

    const dispatchExternal = title => {
      const track = document.querySelector(".dc-timeline-track");
      if (!(track instanceof HTMLElement)) throw new Error("Timeline track missing");
      const transfer = new DataTransfer();
      setCalendarExternalDropData(transfer, { title, durationMinutes: 45 });
      const rect = track.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width * 0.35,
        clientY: rect.top + 30,
      };
      track.dispatchEvent(new DragEvent("dragenter", init));
      track.dispatchEvent(new DragEvent("dragover", init));
      track.dispatchEvent(new DragEvent("drop", init));
    };

    const doubleClickTrack = () => {
      const track = document.querySelector(".dc-timeline-track");
      if (!(track instanceof HTMLElement)) throw new Error("Timeline track missing");
      const rect = track.getBoundingClientRect();
      track.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width * 0.55,
        clientY: rect.top + 80,
      }));
    };

    const pointerMove = (occurrenceId, dx) => {
      const event = document.querySelector(`.dc-timeline-event[data-occurrence-id="${occurrenceId}"]`);
      if (!(event instanceof HTMLElement)) throw new Error("Timeline pointer fixture missing");
      const rect = event.getBoundingClientRect();
      const pointerId = 77;
      event.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
        clientX: rect.left + 10, clientY: rect.top + 10,
      }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
        clientX: rect.left + 10 + dx, clientY: rect.top + 10,
      }));
      window.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
        clientX: rect.left + 10 + dx, clientY: rect.top + 10,
      }));
    };

    globalThis.__timelineProbe = {
      calendar,
      repository,
      projectionCalls: () => projectionCalls,
      backgroundCalls: () => backgroundCalls,
      projectedRanges,
      createdSelections,
      openCalls: () => openCalls,
      dispatchExternal,
      doubleClickTrack,
      pointerMove,
    };
  });

  await expect(page.locator(".dc-timeline")).toBeVisible();
  await expect(page.locator("[data-role='title']")).toHaveText("Nov 10, 2026 – Nov 11, 2026");
  await expect(page.locator(".dc-timeline-event")).toHaveCount(3);
  await expect(page.locator(".dc-timeline-event.is-point")).toHaveCount(1);
  await expect(page.locator(".dc-timeline-background")).toHaveCount(1);
  await expect(page.getByText("Focus window", { exact: true })).toBeVisible();
  await expect(page.locator(".dc-timeline-axis-tick")).not.toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__timelineProbe.projectionCalls())).toBe(1);
  expect(await page.evaluate(() => globalThis.__timelineProbe.backgroundCalls())).toBe(1);
  expect(await page.evaluate(() => globalThis.__timelineProbe.projectedRanges[0])).toEqual({
    start: "2026-11-10T00:00:00.000Z",
    end: "2026-11-12T00:00:00.000Z",
  });

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
  await openHarness(page);
  const counts = await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);
    const source={id:"personal",title:"Personal",visible:true};
    let renders=0, disposes=0;
    const plugin={
      id:"lifecycle-probe",label:"Probe",
      range(context){const start=new Date(context.anchor);start.setUTCHours(0,0,0,0);return {start:start.toISOString(),end:new Date(start.getTime()+86400000).toISOString()};},
      shiftAnchor(context,direction){return new Date(context.anchor.getTime()+direction*86400000);},
      title(){return "Probe";},
      render(){renders+=1;const node=document.createElement("section");node.className="lifecycle-probe";return node;},
      dispose(element){if(!element.classList.contains("lifecycle-probe")) throw new Error("wrong element");disposes+=1;},
    };
    const calendar=new CalendarUi(document.getElementById("browser-test-host"),new CalendarEngine(new MemoryCalendarRepository([source],[])),{
      locale:"en-US",timeZone:"UTC",initialDate:"2026-11-10",initialView:"lifecycle-probe",customViews:[plugin],
    });
    await calendar.refresh();
    const afterInitial={renders,disposes};
    await calendar.refresh();
    const afterRefresh={renders,disposes};
    calendar.setView("month");
    await calendar.refresh();
    const afterSwitch={renders,disposes};
    calendar.setView("lifecycle-probe");
    await calendar.refresh();
    calendar.destroy();
    const afterDestroy={renders,disposes};
    return {afterInitial,afterRefresh,afterSwitch,afterDestroy};
  });
  expect(counts.afterRefresh.disposes).toBeGreaterThan(counts.afterInitial.disposes);
  expect(counts.afterSwitch.disposes).toBeGreaterThanOrEqual(counts.afterRefresh.disposes);
  expect(counts.afterDestroy.disposes).toBe(counts.afterDestroy.renders);
});
