import { expect, test } from "@playwright/test";
import {
  DATABASE_NAME,
  SOURCE,
  closeRepository,
  createItem,
  createSource,
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
  removeSource,
  replaceAtRevision,
  repositoryOperationError,
  repositoryState,
  subscribeRevisions,
  updateItem,
  updateSource,
} from "./helpers.mjs";

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

test("calendar repository and interoperability share one exact version-1 IndexedDB topology", async ({ page }) => {
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

test("all IndexedDB entry points reject any non-canonical physical topology", async ({ page }) => {
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

test("interop persistence rejects malformed sync state and reminder records", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await page.goto("/tests/browser/harness.html");

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

test("interop persistence canonicalizes absolute timestamps and rejects enclosing identity mismatches", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await page.goto("/tests/browser/harness.html");

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

test("two tabs atomically claim one reminder receipt and completed delivery stays deduplicated", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const second = await context.newPage();
  await Promise.all([page.goto("/tests/browser/harness.html"), second.goto("/tests/browser/harness.html")]);

  const claim = async (target, token) => await target.evaluate(async ({ databaseName, token }) => {
    const { IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    return await new IndexedDbReminderReceiptStore().claim("same-reminder", {
      token,
      claimedAt: "2026-11-10T10:00:00.000Z",
      expiresAt: "2026-11-10T10:15:00.000Z",
    });
  }, { databaseName, token });

  const [first, secondClaim] = await Promise.all([claim(page, "first"), claim(second, "second")]);
  expect([first, secondClaim].filter(Boolean)).toHaveLength(1);
  const winner = first ? { target: page, token: "first" } : { target: second, token: "second" };

  await winner.target.evaluate(async ({ databaseName, token }) => {
    const { IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    await new IndexedDbReminderReceiptStore().complete("same-reminder", token, "2026-11-10T10:00:01.000Z");
  }, { databaseName, token: winner.token });

  expect(await claim(first ? second : page, "third")).toBe(false);
  await second.close();
  await deleteDatabase(page);
});

test("two tabs serialize one Google connection before remote publish and shared state write", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const second = await context.newPage();
  await Promise.all([page.goto("/tests/browser/harness.html"), second.goto("/tests/browser/harness.html")]);
  await page.evaluate(() => {
    localStorage.setItem("calendar-google-inserts", "0");
    localStorage.setItem("calendar-google-active", "0");
    localStorage.setItem("calendar-google-max-active", "0");
  });

  const run = async target => await target.evaluate(async databaseName => {
    const Calendar = await import("/dist/index.js");
    const Google = await import("/dist/interoperability/google-calendar.js");
    const { IndexedDbSyncStateStore } = await import("/dist/interoperability/storage.js");
    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "e1", calendarId: "personal", title: "Event",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      kind: "event", ownership: "calendar", editPolicy: "full",
    };
    const repo = new Calendar.MemoryCalendarRepository([source], [item]);
    const transport = {
      async listEvents() {
        const active = Number(localStorage.getItem("calendar-google-active") ?? "0") + 1;
        localStorage.setItem("calendar-google-active", String(active));
        localStorage.setItem("calendar-google-max-active", String(Math.max(
          active, Number(localStorage.getItem("calendar-google-max-active") ?? "0"),
        )));
        await new Promise(resolve => setTimeout(resolve, 80));
        localStorage.setItem("calendar-google-active", String(active - 1));
        return { items: [], nextSyncToken: "sync-token" };
      },
      async getEvent() { throw new Error("unused"); },
      async listInstances() { return { items: [] }; },
      async insertEvent(_calendarId, event) {
        const count = Number(localStorage.getItem("calendar-google-inserts") ?? "0") + 1;
        localStorage.setItem("calendar-google-inserts", String(count));
        return { id: "g1", etag: '"etag-1"', ...event };
      },
      async updateEvent() { throw new Error("unused"); },
      async patchEvent() { throw new Error("unexpected patch"); },
      async deleteEvent() { throw new Error("unused"); },
    };
    const adapter = new Google.GoogleCalendarSyncAdapter(
      transport, repo, new IndexedDbSyncStateStore(),
      { id: "shared-connection", googleCalendarId: "remote", localCalendarId: "personal", mode: "publish" },
    );
    return await adapter.sync();
  }, databaseName);

  await Promise.all([run(page), run(second)]);
  const observed = await page.evaluate(() => ({
    inserts: Number(localStorage.getItem("calendar-google-inserts") ?? "0"),
    maxActive: Number(localStorage.getItem("calendar-google-max-active") ?? "0"),
  }));
  expect(observed).toEqual({ inserts: 1, maxActive: 1 });

  const state = await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore } = await import("/dist/interoperability/storage.js");
    return await new IndexedDbSyncStateStore().read("shared-connection");
  }, databaseName);
  expect(state.links).toHaveLength(1);
  expect(state.links[0].identity.eventId).toMatch(/^dcal[0-9a-v]{28}$/);

  await second.close();
  await deleteDatabase(page);
});

test("native IndexedDB persists normalized create, update and delete state across reopen", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openRepository(page);
  await createItem(page, event("persisted", { title: "Persisted event" }));
  await closeRepository(page);

  await openRepository(page);
  let state = await repositoryState(page);
  expect(state.revision).toBe(1);
  expect(state.items.map(item => item.title)).toEqual(["Persisted event"]);

  await updateItem(page, "persisted", { title: "Updated event" });
  await closeRepository(page);
  await openRepository(page);
  state = await repositoryState(page);
  expect(state.revision).toBe(2);
  expect(state.items[0]?.title).toBe("Updated event");

  await removeItem(page, "persisted");
  await closeRepository(page);
  const records = await rawRecords(page);
  expect(records.map(record => record.key).sort()).toEqual(["meta", "source:personal"]);
  const meta = records.find(record => record.key === "meta");
  expect(meta).toMatchObject({ revision: 3, itemOrder: [], sourceOrder: ["personal"] });

  await openRepository(page);
  state = await repositoryState(page);
  expect(state).toMatchObject({ revision: 3, items: [] });
  expect(state.sources).toEqual([SOURCE]);

  await closeRepository(page);
  await deleteDatabase(page);
});

test("native IndexedDB item and source CRUD preserve the canonical transition semantics", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openRepository(page);

  const work = { id: "work", title: "Work", visible: true, removable: true };
  await createSource(page, work);
  await updateSource(page, "work", { title: "Work calendar", visible: false });
  expect((await repositoryState(page)).sources.find(source => source.id === "work")).toMatchObject({
    title: "Work calendar",
    visible: false,
  });

  await createItem(page, event("work-item", { calendarId: "work" }));
  expect(await repositoryOperationError(page, {
    type: "create-item",
    item: event("work-item", { calendarId: "work" }),
  })).toMatch(/Duplicate calendar item/);
  expect(await repositoryOperationError(page, {
    type: "update-item",
    id: "work-item",
    patch: { calendarId: "missing" },
  })).toMatch(/Unknown calendar source/);
  expect(await repositoryOperationError(page, {
    type: "remove-source",
    id: "work",
  })).toMatch(/Move or delete events/);

  await removeItem(page, "work-item");
  await removeSource(page, "work");
  const state = await repositoryState(page);
  expect(state.items).toEqual([]);
  expect(state.sources).toEqual([SOURCE]);
  expect(state.revision).toBe(5);

  await closeRepository(page);
  await deleteDatabase(page);
});

test("two-tab guarded replacement rejects a durable revision that was not the local delta basis", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const stalePage = await context.newPage();
  await installSilentBroadcastChannel(stalePage);

  await openRepository(page);
  await openRepository(stalePage);
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

  const records = await rawRecords(page);
  expect(records.map(record => record.key).sort()).toEqual(["item:authoritative", "meta", "source:personal"]);

  await closeRepository(stalePage);
  await stalePage.close();
  await closeRepository(page);
  await openRepository(page);
  expect((await repositoryState(page)).items.map(item => item.id)).toEqual(["authoritative"]);

  await closeRepository(page);
  await deleteDatabase(page);
});

test("BroadcastChannel invalidation converges a passive tab through a burst of commits", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const observer = await context.newPage();

  await openRepository(page);
  await openRepository(observer);
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
  await deleteDatabase(page);
});

test("no-BroadcastChannel fallback refreshes when a passive tab returns to the foreground", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  await disableBroadcastChannel(context);
  const observer = await context.newPage();

  await openRepository(page);
  await openRepository(observer);
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
  await deleteDatabase(page);
});
