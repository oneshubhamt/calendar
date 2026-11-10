import { expect, test } from "@playwright/test";
import {
  SOURCE,
  closeRepository,
  createItem,
  deleteDatabase,
  disableBroadcastChannel,
  event,
  installSilentBroadcastChannel,
  observedRevisions,
  openRepository,
  rawRecords,
  removeItem,
  replaceAtRevision,
  repositoryState,
  subscribeRevisions,
  uniqueDatabaseName,
  updateItem,
} from "./helpers.mjs";

test("native IndexedDB persists normalized create, update and delete state across reopen", async ({ page }, testInfo) => {
  const databaseName = uniqueDatabaseName(testInfo, "persistence");
  await openRepository(page, databaseName);
  await createItem(page, event("persisted", { title: "Persisted event" }));
  await closeRepository(page);

  await openRepository(page, databaseName);
  let state = await repositoryState(page);
  expect(state.revision).toBe(1);
  expect(state.items.map(item => item.title)).toEqual(["Persisted event"]);

  await updateItem(page, "persisted", { title: "Updated event" });
  await closeRepository(page);
  await openRepository(page, databaseName);
  state = await repositoryState(page);
  expect(state.revision).toBe(2);
  expect(state.items[0]?.title).toBe("Updated event");

  await removeItem(page, "persisted");
  await closeRepository(page);
  const records = await rawRecords(page, databaseName);
  expect(records.map(record => record.key).sort()).toEqual(["meta", "source:personal"]);
  const meta = records.find(record => record.key === "meta");
  expect(meta).toMatchObject({ revision: 3, itemOrder: [], sourceOrder: ["personal"] });

  await openRepository(page, databaseName);
  state = await repositoryState(page);
  expect(state).toMatchObject({ revision: 3, items: [] });
  expect(state.sources).toEqual([SOURCE]);

  await closeRepository(page);
  await deleteDatabase(page, databaseName);
});

test("two-tab guarded replacement rejects a durable revision that was not the local delta basis", async ({ page, context }, testInfo) => {
  const databaseName = uniqueDatabaseName(testInfo, "cas");
  const stalePage = await context.newPage();
  await installSilentBroadcastChannel(stalePage);

  await openRepository(page, databaseName);
  await openRepository(stalePage, databaseName);
  expect((await repositoryState(stalePage)).revision).toBe(0);

  await createItem(page, event("authoritative", { title: "Authoritative" }));
  expect((await repositoryState(page)).revision).toBe(1);
  expect((await repositoryState(stalePage)).revision).toBe(0);

  const result = await replaceAtRevision(
    stalePage,
    [event("replacement", { title: "Must not commit" })],
    1,
  );
  expect(result).toMatchObject({
    ok: false,
    name: "CalendarStaleRevisionError",
    code: "stale",
    expectedRevision: 1,
    actualRevision: 0,
  });

  const records = await rawRecords(page, databaseName);
  expect(records.map(record => record.key).sort()).toEqual(["item:authoritative", "meta", "source:personal"]);

  await closeRepository(stalePage);
  await stalePage.close();
  await closeRepository(page);
  await openRepository(page, databaseName);
  expect((await repositoryState(page)).items.map(item => item.id)).toEqual(["authoritative"]);

  await closeRepository(page);
  await deleteDatabase(page, databaseName);
});

test("BroadcastChannel invalidation converges a passive tab through a burst of commits", async ({ page, context }, testInfo) => {
  const databaseName = uniqueDatabaseName(testInfo, "broadcast");
  const observer = await context.newPage();

  await openRepository(page, databaseName);
  await openRepository(observer, databaseName);
  await subscribeRevisions(observer);

  for (let index = 1; index <= 8; index += 1) {
    await createItem(page, event(`burst-${index}`, {
      title: `Burst ${index}`,
      start: `2026-11-${String(10 + index).padStart(2, "0")}T09:00:00.000Z`,
      end: `2026-11-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`,
    }));
  }

  await expect.poll(async () => (await repositoryState(observer)).revision).toBe(8);
  const state = await repositoryState(observer);
  expect(state.items).toHaveLength(8);
  expect(state.items.at(-1)?.id).toBe("burst-8");
  expect((await observedRevisions(observer)).at(-1)).toBe(8);

  await closeRepository(observer);
  await observer.close();
  await closeRepository(page);
  await deleteDatabase(page, databaseName);
});

test("no-BroadcastChannel fallback refreshes when a passive tab returns to the foreground", async ({ page, context }, testInfo) => {
  const databaseName = uniqueDatabaseName(testInfo, "storage-event");
  await disableBroadcastChannel(context);
  const observer = await context.newPage();

  await openRepository(page, databaseName);
  await openRepository(observer, databaseName);
  expect(await page.evaluate(() => typeof BroadcastChannel)).toBe("undefined");
  expect(await observer.evaluate(() => typeof BroadcastChannel)).toBe("undefined");

  await page.bringToFront();
  await createItem(page, event("fallback", { title: "Fallback invalidation" }));
  await observer.bringToFront();
  await expect.poll(async () => (await repositoryState(observer)).revision).toBe(1);
  expect((await repositoryState(observer)).items.map(item => item.id)).toEqual(["fallback"]);

  await closeRepository(observer);
  await observer.close();
  await closeRepository(page);
  await deleteDatabase(page, databaseName);
});
