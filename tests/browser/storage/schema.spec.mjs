import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { openHarness } from "../support/harness.mjs";
import { DATABASE_NAME, closeRepository, deleteDatabase, event, inspectDatabase, createDatabase, openRepository } from "../helpers.mjs";

async function repositoryOpenError(page) {
  try {
    await openRepository(page);
    return null;
  } catch (error) {
    return String(error);
  }
}

async function interopReadError(page) {
  return await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore } = await import("/dist/interoperability/storage.js");
    try {
      await new IndexedDbSyncStateStore().read("missing");
      return null;
    } catch (error) {
      return String(error);
    }
  });
}

scenario("storage.schema", "calendar repository and interoperability share one exact version-1 IndexedDB topology", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openRepository(page);
  await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore, IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    await new IndexedDbSyncStateStore().read("missing");
    const receipts = new IndexedDbReminderReceiptStore();
    await receipts.claim("schema-probe", {
      token: "schema-probe",
      claimedAt: "2026-11-10T10:00:00.000Z",
      expiresAt: "2026-11-10T10:15:00.000Z",
    });
    await receipts.release("schema-probe", "schema-probe");
  }, databaseName);

  expect(await inspectDatabase(page)).toEqual({
    version: 1,
    stores: [
      { name: "calendar", keyPath: "key", autoIncrement: false, indexes: [] },
      { name: "reminderReceipts", keyPath: null, autoIncrement: false, indexes: [] },
      { name: "syncStates", keyPath: null, autoIncrement: false, indexes: [] },
    ],
  });

  await closeRepository(page);
  await deleteDatabase(page);
});

scenario("storage.schema-reject", "all IndexedDB entry points reject any non-canonical physical topology", async ({ page }) => {
  const canonicalStores = [
    { name: "calendar", keyPath: "key" },
    { name: "syncStates" },
    { name: "reminderReceipts" },
  ];
  const cases = [
    {
      suffix: "wrong-calendar-key",
      version: 1,
      stores: [{ name: "calendar" }, { name: "syncStates" }, { name: "reminderReceipts" }],
      expected: /canonical schema/i,
    },
    {
      suffix: "wrong-sync-key",
      version: 1,
      stores: [{ name: "calendar", keyPath: "key" }, { name: "syncStates", keyPath: "key" }, { name: "reminderReceipts" }],
      expected: /canonical schema/i,
    },
    {
      suffix: "missing-store",
      version: 1,
      stores: [{ name: "calendar", keyPath: "key" }, { name: "syncStates" }],
      expected: /canonical schema/i,
    },
    {
      suffix: "extra-store",
      version: 1,
      stores: [...canonicalStores, { name: "extra" }],
      expected: /canonical schema/i,
    },
    {
      suffix: "later-version",
      version: 2,
      stores: canonicalStores,
      expected: /VersionError|higher version than the version requested/i,
    },
  ];

  for (const row of cases) {
    const databaseName = DATABASE_NAME;
    await createDatabase(page, row.version, row.stores);

    const repositoryError = await repositoryOpenError(page);
    expect(repositoryError).not.toBeNull();
    expect(repositoryError).toMatch(row.expected);

    const interoperabilityError = await interopReadError(page);
    expect(interoperabilityError).not.toBeNull();
    expect(interoperabilityError).toMatch(row.expected);

    await deleteDatabase(page);
  }
});

scenario("storage.interop-invalid", "interop persistence rejects malformed sync state and reminder records", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openHarness(page);

  const errors = await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore, IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    const sync = new IndexedDbSyncStateStore();
    await sync.write({
      provider: "google",
      connectionId: "conn",
      mode: "publish",
      externalCalendarId: "remote",
      localCalendarId: "personal",
      links: [],
    });

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["syncStates", "reminderReceipts"], "readwrite");
      tx.objectStore("syncStates").put({
        provider: "google", connectionId: "conn", mode: "invalid",
        externalCalendarId: "remote", localCalendarId: "personal", links: [],
      }, "conn");
      tx.objectStore("reminderReceipts").put({
        key: "bad-reminder",
        state: "claimed",
        claim: { token: "t", claimedAt: "not-a-date", expiresAt: "also-bad" },
      }, "bad-reminder");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const result = {};
    try { await sync.read("conn"); } catch (error) { result.sync = String(error); }
    try {
      await new IndexedDbReminderReceiptStore().claim("bad-reminder", {
        token: "new",
        claimedAt: "2026-11-10T10:00:00.000Z",
        expiresAt: "2026-11-10T10:15:00.000Z",
      });
    } catch (error) { result.reminder = String(error); }
    return result;
  }, databaseName);

  expect(errors.sync).toMatch(/mode is invalid/i);
  expect(errors.reminder).toMatch(/claimedAt.*absolute ISO date-time/i);
  await deleteDatabase(page);
});

scenario("storage.interop-identity", "interop persistence canonicalizes absolute timestamps and rejects enclosing identity mismatches", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openHarness(page);

  const result = await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore, IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    const sync = new IndexedDbSyncStateStore();
    const baseItem = {
      id: "remote-base", calendarId: "personal", title: "Remote base",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      kind: "event", ownership: "external", editPolicy: "full",
    };
    const baseLink = {
      localItemId: "local",
      identity: { provider: "google", connectionId: "conn", externalCalendarId: "remote", eventId: "g1" },
      baseLocalFingerprint: "local-fingerprint",
      baseRemoteFingerprint: "remote-fingerprint",
      baseRemoteItem: baseItem,
      status: "clean",
      lastSyncedAt: "2026-11-10T15:30:00+05:30",
    };
    const baseState = {
      provider: "google", connectionId: "conn", mode: "two-way",
      externalCalendarId: "remote", localCalendarId: "personal",
      links: [baseLink],
      lastFullSyncAt: "2026-11-10T15:30:00+05:30",
      lastIncrementalSyncAt: "2026-11-10T16:30:00+05:30",
    };

    const errors = {};
    try { await sync.write({ ...baseState, lastFullSyncAt: "2026-11-10" }); }
    catch (error) { errors.timestamp = String(error); }
    try {
      await sync.write({
        ...baseState,
        links: [{ ...baseLink, identity: { ...baseLink.identity, provider: "other" } }],
      });
    } catch (error) { errors.provider = String(error); }
    try {
      await sync.write({
        ...baseState,
        links: [{ ...baseLink, baseRemoteItem: { ...baseItem, calendarId: "wrong-local-calendar" } }],
      });
    } catch (error) { errors.remoteCalendar = String(error); }

    const receipts = new IndexedDbReminderReceiptStore();
    try {
      await receipts.claim("floating-claim", {
        token: "t", claimedAt: "2026-11-10T10:00:00", expiresAt: "2026-11-10T10:15:00Z",
      });
    } catch (error) { errors.claim = String(error); }

    await sync.write(baseState);
    return { errors, state: await sync.read("conn") };
  }, databaseName);

  expect(result.errors.timestamp).toMatch(/absolute ISO date-time/i);
  expect(result.errors.provider).toMatch(/provider does not match/i);
  expect(result.errors.remoteCalendar).toMatch(/baseRemoteItem calendarId does not match/i);
  expect(result.errors.claim).toMatch(/absolute ISO date-time/i);
  expect(result.state.lastFullSyncAt).toBe("2026-11-10T10:00:00.000Z");
  expect(result.state.lastIncrementalSyncAt).toBe("2026-11-10T11:00:00.000Z");
  expect(result.state.links[0].lastSyncedAt).toBe("2026-11-10T10:00:00.000Z");

  await deleteDatabase(page);
});
