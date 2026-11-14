import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { settleBrowserFrames } from "../support/harness.mjs";
import {
  evaluateDormantExternalDropAndPrint,
  mountAuthorizedExternalDrop,
} from "../support/external-drop-fixtures.mjs";

scenario("drop.authorized", "external DOM drops create through Calendar authority while internal drag remains a move", async ({ page }) => {
  await mountAuthorizedExternalDrop(page);

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
  await settleBrowserFrames(page);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Locked external"),
  )).toBe(false);

  const beforeMalformed = await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length);
  const malformedResult = await page.evaluate(() =>
    globalThis.__externalDropProbe.dropMonth("external-malformed", "2026-11-12"),
  );
  expect(malformedResult.accepted).toBe(true);
  await settleBrowserFrames(page);
  expect(await page.evaluate(() => globalThis.__externalDropProbe.repository.read().items.length)).toBe(beforeMalformed);

  const outOfBoundsResult = await page.evaluate(() =>
    globalThis.__externalDropProbe.dropMonth("external-out-of-bounds", "2026-11-16"),
  );
  expect(outOfBoundsResult.accepted).toBe(false);
  expect(await page.evaluate(() =>
    globalThis.__externalDropProbe.repository.read().items.some(item => item.title === "Out of bounds external"),
  )).toBe(false);

  await page.evaluate(() => globalThis.__externalDropProbe.dropMonth("external-factory-redirect", "2026-11-12"));
  await settleBrowserFrames(page);
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
  await settleBrowserFrames(page);
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
  await settleBrowserFrames(page);
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
