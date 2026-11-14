import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { openHarness } from "../support/harness.mjs";

scenario("embed.isolation", "embedded Calendar contains owned DOM, themes opt in, and base styles do not leak", async ({ page }) => {
  await openHarness(page);
  const result = await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { CalendarUi }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/view/calendar-ui.js"),
    ]);

    const outside = document.createElement("button");
    outside.id = "outside-calendar-probe";
    outside.className = "is-dragging";
    outside.textContent = "Host control";
    document.body.append(outside);

    const host = document.getElementById("browser-test-host");
    host.style.setProperty("--dc-theme-accent", "rgb(1, 2, 3)");
    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "embed-event", calendarId: "personal", title: "Embedded event",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      kind: "event", ownership: "calendar", editPolicy: "readonly",
    };
    const repository = new MemoryCalendarRepository([source], [item]);
    const customView = {
      id: "embed-probe", label: "Embed probe",
      range: () => ({ start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" }),
      shiftAnchor: context => context.anchor,
      title: () => "Embedded probe",
      render() {
        const section = document.createElement("section");
        section.className = "host-custom-view-probe";
        section.textContent = "Custom view";
        return section;
      },
    };
    const addon = {
      id: "embed-addon",
      mountToolbar(container) {
        const button = document.createElement("button");
        button.className = "host-addon-probe";
        button.type = "button";
        button.textContent = "Host add-on";
        container.append(button);
      },
    };
    const calendar = new CalendarUi(host, new CalendarEngine(repository), {
      locale: "en-US", timeZone: "UTC", initialDate: "2026-11-10", initialView: "month",
      ariaLabel: "Embedded calendar", customViews: [customView], addons: [addon],
      theme: {
        background: "rgb(17, 24, 39)",
        softBackground: "rgb(31, 41, 55)",
        text: "rgb(243, 244, 246)",
        mutedText: "rgb(156, 163, 175)",
        border: "rgb(75, 85, 99)",
        accent: "rgb(34, 211, 238)",
        danger: "rgb(248, 113, 113)",
        fontFamily: "Georgia, serif",
      },
    });
    await calendar.refresh();

    const root = host.querySelector(".dc-root");
    const rootStyle = getComputedStyle(root);
    const initial = {
      rootAria: root.getAttribute("aria-label"),
      rootBackground: rootStyle.backgroundColor,
      rootColor: rootStyle.color,
      rootFont: rootStyle.fontFamily,
      outsideOpacity: getComputedStyle(outside).opacity,
      addonContained: Boolean(host.querySelector(".host-addon-probe")),
      outsideStillOutside: !host.contains(outside),
    };

    const eventButton = host.querySelector(".dc-event-main");
    eventButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const dialog = host.querySelector("dialog.dc-details-dialog");
    const dialogStyle = getComputedStyle(dialog);
    const dialogState = {
      contained: Boolean(dialog && host.contains(dialog)),
      directChild: dialog?.parentElement === host,
      aria: dialog?.getAttribute("aria-label") ?? "",
      background: dialogStyle.backgroundColor,
      color: dialogStyle.color,
    };
    dialog.close();
    await new Promise(resolve => setTimeout(resolve, 0));

    eventButton.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 30, clientY: 30,
    }));
    const menu = host.querySelector(".dc-context-menu");
    const contextContained = Boolean(menu && root.contains(menu));
    const snapshot = calendar.createPrintSnapshot();
    const printState = {
      detached: !snapshot.isConnected,
      hasRoot: Boolean(snapshot.querySelector(".dc-root")),
      stripsContextMenu: !snapshot.querySelector(".dc-context-menu"),
      hostStillOwnsLiveRoot: host.querySelector(".dc-root") === root,
    };

    calendar.setView("embed-probe");
    await calendar.refresh();
    const custom = host.querySelector(".host-custom-view-probe");
    const customContained = Boolean(custom && host.querySelector(".dc-body")?.contains(custom));
    const appliedAccent = host.style.getPropertyValue("--dc-theme-accent").trim();

    calendar.destroy();
    return {
      initial, dialogState, contextContained, printState, customContained, appliedAccent,
      restoredAccent: host.style.getPropertyValue("--dc-theme-accent").trim(),
      hostChildrenAfterDestroy: host.childElementCount,
      outsideConnectedAfterDestroy: outside.isConnected,
    };
  });

  expect(result.initial).toEqual({
    rootAria: "Embedded calendar",
    rootBackground: "rgb(17, 24, 39)",
    rootColor: "rgb(243, 244, 246)",
    rootFont: "Georgia, serif",
    outsideOpacity: "1",
    addonContained: true,
    outsideStillOutside: true,
  });
  expect(result.dialogState.contained).toBe(true);
  expect(result.dialogState.directChild).toBe(true);
  expect(result.dialogState.aria).toContain("Embedded event");
  expect(result.dialogState.background).toBe("rgb(17, 24, 39)");
  expect(result.dialogState.color).toBe("rgb(243, 244, 246)");
  expect(result.contextContained).toBe(true);
  expect(result.printState).toEqual({
    detached: true,
    hasRoot: true,
    stripsContextMenu: true,
    hostStillOwnsLiveRoot: true,
  });
  expect(result.customContained).toBe(true);
  expect(result.appliedAccent).toBe("rgb(34, 211, 238)");
  expect(result.restoredAccent).toBe("rgb(1, 2, 3)");
  expect(result.hostChildrenAfterDestroy).toBe(0);
  expect(result.outsideConnectedAfterDestroy).toBe(true);
});


scenario("host.overdue", "aggregate sandbox retains Revision Director overdue indicators with its Calendar host extension", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-09T10:00:00.000Z"));
  await openHarness(page);
  await page.evaluate(async () => {
    const { mountDirectorCalendarSandbox } = await import("/dist/demo/sandbox.js");
    const host = document.getElementById("browser-test-host");
    const calendar = mountDirectorCalendarSandbox(host);
    await calendar.refresh();
  });
  const overdue = page.locator(".revision-director-overdue").first();
  await expect(overdue).toBeVisible();
  await expect(overdue).toContainText("Overdue");
});
