import { expect, test } from "@playwright/test";
import {
  SOURCE,
  closeRepository,
  createItem,
  deleteDatabase,
  disableBroadcastChannel,
  event,
  installSilentBroadcastChannel,
  inspectDatabase,
  createDatabase,
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

async function repositoryOpenError(page, databaseName) {
  try {
    await openRepository(page, databaseName);
    return null;
  } catch (error) {
    return String(error);
  }
}

async function interopReadError(page, databaseName) {
  return await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore } = await import("/dist/interoperability/storage.js");
    try {
      await new IndexedDbSyncStateStore(databaseName).read("missing");
      return null;
    } catch (error) {
      return String(error);
    }
  }, databaseName);
}

test("canonical primary IndexedDB is exactly version 1 with one keyed store and no indexes", async ({ page }, testInfo) => {
  const databaseName = uniqueDatabaseName(testInfo, "canonical-primary");
  await openRepository(page, databaseName);
  expect(await inspectDatabase(page, databaseName)).toEqual({
    version: 1,
    stores: [{
      name: "calendar",
      keyPath: "key",
      autoIncrement: false,
      indexes: [],
    }],
  });
  await closeRepository(page);
  await deleteDatabase(page, databaseName);
});

test("primary IndexedDB rejects wrong physical topology, extra stores and later versions", async ({ page }, testInfo) => {
  const cases = [
    { suffix: "wrong-key", version: 1, stores: [{ name: "calendar" }] },
    { suffix: "extra-store", version: 1, stores: [{ name: "calendar", keyPath: "key" }, { name: "extra" }] },
    { suffix: "later-version", version: 2, stores: [{ name: "calendar", keyPath: "key" }] },
  ];
  for (const row of cases) {
    const databaseName = uniqueDatabaseName(testInfo, row.suffix);
    await createDatabase(page, databaseName, row.version, row.stores);
    const error = await repositoryOpenError(page, databaseName);
    expect(error).not.toBeNull();
    expect(error).toMatch(/canonical schema|VersionError/i);
    await deleteDatabase(page, databaseName);
  }
});

test("interoperability IndexedDB is exact version 1 and rejects alternate physical topology", async ({ page }, testInfo) => {
  const canonical = uniqueDatabaseName(testInfo, "canonical-interop");
  await page.goto("/tests/browser/harness.html");
  await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore, IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    await new IndexedDbSyncStateStore(databaseName).read("missing");
    await new IndexedDbReminderReceiptStore(databaseName).has("missing");
  }, canonical);
  expect(await inspectDatabase(page, canonical)).toEqual({
    version: 1,
    stores: [
      { name: "reminderReceipts", keyPath: null, autoIncrement: false, indexes: [] },
      { name: "syncStates", keyPath: null, autoIncrement: false, indexes: [] },
    ],
  });
  await deleteDatabase(page, canonical);

  const cases = [
    { suffix: "wrong-key", version: 1, stores: [{ name: "syncStates", keyPath: "key" }, { name: "reminderReceipts" }] },
    { suffix: "extra-store", version: 1, stores: [{ name: "syncStates" }, { name: "reminderReceipts" }, { name: "extra" }] },
    { suffix: "later-version", version: 2, stores: [{ name: "syncStates" }, { name: "reminderReceipts" }] },
  ];
  for (const row of cases) {
    const databaseName = uniqueDatabaseName(testInfo, row.suffix);
    await createDatabase(page, databaseName, row.version, row.stores);
    const error = await interopReadError(page, databaseName);
    expect(error).not.toBeNull();
    expect(error).toMatch(/canonical schema|VersionError/i);
    await deleteDatabase(page, databaseName);
  }
});

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
  await expect.poll(async () => (await repositoryState(observer)).revision, { timeout: 7_000 }).toBe(1);
  expect((await repositoryState(observer)).items.map(item => item.id)).toEqual(["fallback"]);

  await closeRepository(observer);
  await observer.close();
  await closeRepository(page);
  await deleteDatabase(page, databaseName);
});
