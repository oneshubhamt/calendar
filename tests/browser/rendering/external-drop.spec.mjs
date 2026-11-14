import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import {
  evaluateDormantExternalDropAndPrint,
  mountAuthorizedExternalDrop,
} from "../support/external-drop-fixtures.mjs";

scenario("drop.authorized", "external DOM drops wire to Calendar creation while internal drag remains a move", async ({ page }) => {
  await mountAuthorizedExternalDrop(page);

  await page.evaluate(() => globalThis.__externalDropProbe.moveInternal("2026-11-06"));
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.id === "internal")?.start,
  )).toBe("2026-11-06");

  const month = await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-month", "2026-11-10"));
  expect(month.accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() => {
    const item = globalThis.__externalDropProbe.repository.read().items.find(row => row.title === "External month");
    return item && {
      start: item.start,
      end: item.end,
      allDay: item.allDay,
      temporalKind: item.temporal?.kind,
      metadata: item.metadata,
    };
  })).toEqual({
    start: "2026-11-10",
    end: "2026-11-12",
    allDay: true,
    temporalKind: "date",
    metadata: { origin: "outside-dom" },
  });

  const custom = await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-custom", "2026-11-13"));
  expect(custom.accepted).toBe(true);
  expect(custom.callsAfterHover).toBe(custom.callsBeforeHover);
  expect(custom.callsAfterDrop).toBe(custom.callsBeforeHover + 1);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "Host decoded")?.kind,
  )).toBe("task");

  await page.evaluate(() => globalThis.__externalDropProbe.showDay("2026-11-10"));
  await expect(page.locator(".dc-all-day-col")).toBeVisible();
  expect((await page.evaluate(() => globalThis.__externalDropProbe.dropAllDay("external-lane"))).accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "All-day lane")?.start,
  )).toBe("2026-11-10");

  expect((await page.evaluate(() => globalThis.__externalDropProbe.dropTimed("external-timed", 95))).accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() => {
    const item = globalThis.__externalDropProbe.repository.read().items.find(row => row.title === "Timed external");
    return item && [item.start, item.end];
  })).toEqual(["2026-11-10T09:30:00.000Z", "2026-11-10T11:00:00.000Z"]);

  await page.evaluate(() => globalThis.__externalDropProbe.showCustomDropView());
  await expect(page.locator(".custom-external-drop-target")).toBeVisible();
  expect((await page.evaluate(() => globalThis.__externalDropProbe.dropCustomView("external-custom-view"))).accepted).toBe(true);
  await expect.poll(async () => await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.find(item => item.title === "Custom view external")?.start,
  )).toBe("2026-11-15");
});

scenario("drop.opt-in", "external drop and in-page print behavior remain dormant by default", async ({ page }) => {
  const result = await evaluateDormantExternalDropAndPrint(page);
  expect(result).toEqual({
    revisionBefore:0,
    revisionAfter:0,
    externalTarget:false,
    printStyles:0,
    snapshotStyles:1,
  });

  await page.emulateMedia({media:"print"});
  const live = await page.evaluate(() => {
    const toolbar=document.querySelector("#browser-test-host .dc-toolbar");
    const button=toolbar?.querySelector("button");
    return {
      toolbar:toolbar instanceof HTMLElement ? getComputedStyle(toolbar).display : "missing",
      button:button instanceof HTMLElement ? getComputedStyle(button).display : "missing",
    };
  });
  expect(live.toolbar).toBe("flex");
  expect(live.button).not.toBe("none");
});
