import { expect } from "@playwright/test";
import { scenario } from "./scenario-registry.mjs";
import { openHarness, settleBrowserFrames } from "./support/harness.mjs";
import { RESOURCE_TREE } from "./support/resource-fixtures.mjs";

const projection = {
  resources: RESOURCE_TREE,
  occurrences: [{
    occurrenceId: "occ", sourceItemId: "item", calendarId: "calendar", title: "Visit",
    start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
    originalStart: "2026-11-10T09:00:00.000Z", recurring: false,
    kind: "event", ownership: "host", editPolicy: "full",
  }],
  assignments: [{ occurrenceId: "occ", resourceIds: ["a"], version: { revision: 1 } }],
  range: { start: "2026-11-10T08:00:00.000Z", end: "2026-11-10T12:00:00.000Z" },
};

scenario("resource.timeline.hierarchy", "Resource Scheduler renders authoritative hierarchy and collapse state in a real browser", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, { timeZone: "UTC" });
    ui.setProjection(projection);
    globalThis.__resourceScheduler = ui;
  }, projection);

  await expect(page.getByRole("treegrid", { name: "Resource schedule" })).toBeVisible();
  await expect(page.locator(".dc-rs-resource-row")).toHaveCount(3);
  await expect(page.locator(".dc-rs-event")).toContainText("Visit");
  await page.getByRole("button", { name: "Collapse Rooms" }).click();
  await expect(page.locator(".dc-rs-resource-row")).toHaveCount(1);
  expect(await page.evaluate(() => globalThis.__resourceScheduler.collapsedResourceIds())).toEqual(["rooms"]);
});

scenario("resource.timeline.keyboard-reassign", "Resource Scheduler keyboard reassignment commits one atomic host change and reprojects", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, {
      timeZone: "UTC",
      interaction: {
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
              assignments: current.assignments.map(assignment => assignment.occurrenceId === change.occurrence.occurrenceId
                ? { ...assignment, resourceIds: [...change.toResourceIds], version: { revision: 2 } }
                : assignment),
            };
          },
        },
        resourceCapabilityProvider: { capabilities() { return { canReassign: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceSchedulerProbe = { ui, commits };
  }, projection);

  const event = page.locator('.dc-rs-event[data-resource-id="a"]');
  await event.focus();
  await page.keyboard.press("Alt+ArrowDown");

  await expect(page.locator('.dc-rs-event[data-resource-id="b"]')).toBeVisible();
  const commits = await page.evaluate(() => globalThis.__resourceSchedulerProbe.commits);
  expect(commits).toHaveLength(1);
  expect(commits[0].fromResourceIds).toEqual(["a"]);
  expect(commits[0].toResourceIds).toEqual(["b"]);
  expect(commits[0].start).toBe("2026-11-10T09:00:00.000Z");
  expect(commits[0].end).toBe("2026-11-10T10:00:00.000Z");
});


async function mountResourceRefreshFailure(page, mode) {
  await openHarness(page);
  await page.evaluate(async ({ projection, mode }) => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    const commits = [];
    const errors = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, {
      timeZone: "UTC",
      onError(error) { errors.push(String(error)); },
      interaction: {
        mutationPort: {
          commit(change) {
            if (mode === "stale") {
              const error = new Error("stale assignment");
              error.code = "stale";
              throw error;
            }
            commits.push(structuredClone(change));
          },
        },
        resourceCapabilityProvider: { capabilities() { return { canReassign: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { throw new Error("projection offline"); },
      },
    });
    ui.setProjection(projection);
    globalThis.__resourceSchedulerRefreshFailure = { commits, errors };
  }, { projection, mode });
}

scenario("resource.timeline.refresh-failures", "Resource Scheduler distinguishes committed and stale mutations when authoritative refresh fails", async ({ page }) => {
  await mountResourceRefreshFailure(page, "committed");
  let event = page.locator('.dc-rs-event[data-resource-id="a"]');
  await event.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => await page.evaluate(() => globalThis.__resourceSchedulerRefreshFailure.commits.length)).toBe(1);
  await expect(page.getByRole("status")).toContainText("Visit changed, but authoritative refresh failed.");
  expect(await page.evaluate(() => globalThis.__resourceSchedulerRefreshFailure.errors)).toEqual(["Error: projection offline"]);
  await expect(event).not.toHaveAttribute("aria-busy", "true");
  await expect(event).toBeFocused();

  await mountResourceRefreshFailure(page, "stale");
  event = page.locator('.dc-rs-event[data-resource-id="a"]');
  await event.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByRole("status")).toContainText("Visit changed elsewhere, but authoritative refresh failed.");
  expect(await page.evaluate(() => globalThis.__resourceSchedulerRefreshFailure.errors)).toEqual(["Error: projection offline"]);
  await expect(event).not.toHaveAttribute("aria-busy", "true");
  await expect(event).toBeFocused();
});

scenario("resource.timeline.resize", "Resource Scheduler keyboard end resize uses edge authority and one atomic authoritative mutation", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, {
      timeZone: "UTC",
      interaction: {
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
              assignments: current.assignments.map(assignment => assignment.occurrenceId === change.occurrence.occurrenceId
                ? { ...assignment, resourceIds: [...change.toResourceIds], version: { revision: 2 } }
                : assignment),
            };
          },
        },
        occurrenceCapabilityProvider: { capabilities() { return { canResizeStart: true, canResizeEnd: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);
    globalThis.__resourceSchedulerResize = { commits };
  }, projection);

  const handle = page.getByRole("separator", { name: "Resize end of Visit" });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => await page.evaluate(() => globalThis.__resourceSchedulerResize.commits.length)).toBe(1);
  const [commit] = await page.evaluate(() => globalThis.__resourceSchedulerResize.commits);
  expect(commit.start).toBe("2026-11-10T09:00:00.000Z");
  expect(commit.end).toBe("2026-11-10T10:15:00.000Z");
  expect(commit.fromResourceIds).toEqual(["a"]);
  expect(commit.toResourceIds).toEqual(["a"]);
  await expect(page.getByRole("separator", { name: "Resize end of Visit" })).toBeVisible();
});

scenario("resource.timeline.pointer", "Resource Scheduler reuses shared pointer arming, long-press, cancellation and horizontal move", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async projection => {
    const { CalendarResourceSchedulerUi } = await import("/dist/features/resource-scheduler-ui/index.js");
    let current = structuredClone(projection);
    const commits = [];
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();
    const ui = new CalendarResourceSchedulerUi(host, {
      timeZone: "UTC",
      pixelsPerMinute: 2,
      minTimelineWidth: 480,
      interaction: {
        longPressMs: 250,
        autoScrollEdgePx: 32,
        autoScrollMaxPxPerFrame: 18,
        mutationPort: {
          commit(change) {
            commits.push(structuredClone(change));
            current = {
              ...current,
              occurrences: current.occurrences.map(occurrence => occurrence.occurrenceId === change.occurrence.occurrenceId
                ? { ...occurrence, start: change.start, end: change.end }
                : occurrence),
              assignments: current.assignments.map(assignment => assignment.occurrenceId === change.occurrence.occurrenceId
                ? { ...assignment, resourceIds: [...change.toResourceIds], version: { revision: 2 } }
                : assignment),
            };
          },
        },
        resourceCapabilityProvider: { capabilities() { return { canReassign: true }; } },
        sourceForOccurrence() { return { id: "calendar", title: "Calendar", visible: true }; },
        refreshProjection() { return structuredClone(current); },
      },
    });
    ui.setProjection(current);

    const mouseMove = dx => {
      const event = document.querySelector('.dc-rs-event[data-occurrence-id="occ"]');
      if (!(event instanceof HTMLElement)) throw new Error("Resource pointer fixture missing");
      const rect = event.getBoundingClientRect();
      const pointerId = 91;
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

    const beginTouch = () => {
      const event = document.querySelector('.dc-rs-event[data-occurrence-id="occ"]');
      if (!(event instanceof HTMLElement)) throw new Error("Resource touch fixture missing");
      const rect = event.getBoundingClientRect();
      event.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId: 92, pointerType: "touch", button: 0,
        clientX: rect.left + 10, clientY: rect.top + 10,
      }));
    };

    const cancelTouch = () => {
      window.dispatchEvent(new PointerEvent("pointercancel", {
        bubbles: true, cancelable: true, pointerId: 92, pointerType: "touch", button: 0,
      }));
    };

    globalThis.__resourcePointerProbe = { ui, commits, mouseMove, beginTouch, cancelTouch };
  }, projection);

  await page.evaluate(() => globalThis.__resourcePointerProbe.mouseMove(60));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__resourcePointerProbe.commits.at(-1)?.start,
  )).toBe("2026-11-10T09:30:00.000Z");
  await expect(page.locator('.dc-rs-event[data-occurrence-id="occ"]')).toBeVisible();

  await page.evaluate(() => globalThis.__resourcePointerProbe.beginTouch());
  await expect(page.locator('.dc-rs-event[data-occurrence-id="occ"]')).toHaveClass(/is-touch-arming/);
  // Wait for the actual long-press activation rather than guessing the timeout.
  await expect(page.locator('.dc-rs-event[data-occurrence-id="occ"]')).toHaveClass(/is-drag-source/);
  await page.evaluate(() => globalThis.__resourcePointerProbe.cancelTouch());
  await expect(page.locator('.dc-rs-event[data-occurrence-id="occ"]')).not.toHaveClass(/is-drag-source|is-touch-arming/);
});


scenario("resource.timeline.auto-scroll", "shared pointer gesture lifecycle auto-scrolls horizontally and cancels cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await openHarness(page);
  await page.evaluate(async () => {
    const { CalendarPointerGestureController } = await import("/dist/view/pointer-gesture.js");
    const host = document.getElementById("browser-test-host");
    host.replaceChildren();

    const scroll = document.createElement("div");
    scroll.style.width = "220px";
    scroll.style.height = "120px";
    scroll.style.overflow = "auto";
    scroll.style.position = "relative";
    const content = document.createElement("div");
    content.style.width = "1200px";
    content.style.height = "100px";
    content.style.position = "relative";
    const target = document.createElement("button");
    target.textContent = "Gesture target";
    target.style.position = "absolute";
    target.style.left = "20px";
    target.style.top = "20px";
    content.append(target);
    scroll.append(content);
    host.append(scroll);

    let cancelled = 0;
    const controller = new CalendarPointerGestureController({
      scrollElement: () => scroll,
      longPressMs: 250,
      autoScrollEdgePx: 40,
      autoScrollMaxPxPerFrame: 20,
      onActivate() {},
      onMove() {},
      onFinish() {},
      onCancel() { cancelled += 1; },
    });
    target.addEventListener("pointerdown", event => controller.begin(event, { element: target }));

    const beginAndEdge = () => {
      scroll.scrollLeft = 0;
      const targetRect = target.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const pointerId = 101;
      target.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
        clientX: targetRect.left + 5, clientY: targetRect.top + 5,
      }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
        clientX: targetRect.left + 12, clientY: targetRect.top + 5,
      }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
        clientX: scrollRect.right - 2, clientY: scrollRect.top + 60,
      }));
      return pointerId;
    };

    globalThis.__pointerLifecycleProbe = {
      scroll,
      controller,
      beginAndEdge,
      cancelled: () => cancelled,
    };
  });

  const pointerId = await page.evaluate(() => globalThis.__pointerLifecycleProbe.beginAndEdge());
  await expect.poll(async () => await page.evaluate(() => globalThis.__pointerLifecycleProbe.scroll.scrollLeft))
    .toBeGreaterThan(0);

  await page.evaluate(pointerId => {
    window.dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0,
    }));
  }, pointerId);
  expect(await page.evaluate(() => globalThis.__pointerLifecycleProbe.cancelled())).toBe(1);
  const settled = await page.evaluate(() => globalThis.__pointerLifecycleProbe.scroll.scrollLeft);
  await settleBrowserFrames(page, 4);
  expect(await page.evaluate(() => globalThis.__pointerLifecycleProbe.scroll.scrollLeft)).toBe(settled);
});
