import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { openHarness } from "../support/harness.mjs";
import { deleteDatabase } from "../helpers.mjs";

scenario("storage.lifecycle", "IndexedDB repository open close and reopen lifecycle remains race-safe and persistent", async ({ page }) => {
  await openHarness(page);
  await deleteDatabase(page);

  const result = await page.evaluate(async () => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    const source = { id: "personal", title: "Personal", visible: true };
    const createRepository = () => new IndexedDbCalendarRepository({ sources: [source] });
    const erase = () => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("calendar");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("database deletion blocked"));
    });
    const row = id => ({
      id,
      calendarId: "personal",
      title: id,
      start: "2026-11-10T09:00:00.000Z",
      end: "2026-11-10T10:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    });

    const single = createRepository();
    const first = single.open();
    const second = single.open();
    const third = single.open();
    const singleFlight = {
      samePromise: first === second && second === third,
    };
    await Promise.all([first, second, third]);
    singleFlight.revision = single.read().revision;
    single.close();
    await erase();

    const cancelled = createRepository();
    const opening = cancelled.open();
    cancelled.close();
    let openError = null;
    try { await opening; } catch (error) { openError = String(error); }
    let readError = null;
    try { cancelled.read(); } catch (error) { readError = String(error); }
    await erase();

    const raced = createRepository();
    const staleOpen = raced.open();
    raced.close();
    const freshOpen = raced.open();
    const [stale, fresh] = await Promise.allSettled([staleOpen, freshOpen]);
    await raced.create(row("after-reopen"));
    const racedSnapshot = raced.read();
    raced.close();

    const verifyRace = createRepository();
    await verifyRace.open();
    const persistedRace = verifyRace.read();
    verifyRace.close();
    await erase();

    const sameInstance = createRepository();
    await sameInstance.open();
    await sameInstance.create(row("persisted-same-instance"));
    sameInstance.close();
    await sameInstance.open();
    const reopened = sameInstance.read();
    sameInstance.close();

    return {
      singleFlight,
      closeDuringOpen: { openError, readError },
      reopenRace: {
        staleStatus: stale.status,
        staleReason: stale.status === "rejected" ? String(stale.reason) : null,
        freshStatus: fresh.status,
        revision: racedSnapshot.revision,
        itemIds: racedSnapshot.items.map(item => item.id),
        persistedRevision: persistedRace.revision,
        persistedItemIds: persistedRace.items.map(item => item.id),
      },
      sameInstance: {
        revision: reopened.revision,
        itemIds: reopened.items.map(item => item.id),
      },
    };
  });

  expect(result.singleFlight).toEqual({ samePromise: true, revision: 0 });
  expect(result.closeDuringOpen.openError).toMatch(/cancelled by close/i);
  expect(result.closeDuringOpen.readError).toMatch(/open\(\) must complete before read/i);
  expect(result.reopenRace).toMatchObject({
    staleStatus: "rejected",
    freshStatus: "fulfilled",
    revision: 1,
    itemIds: ["after-reopen"],
    persistedRevision: 1,
    persistedItemIds: ["after-reopen"],
  });
  expect(result.reopenRace.staleReason).toMatch(/cancelled by close/i);
  expect(result.sameInstance).toEqual({ revision: 1, itemIds: ["persisted-same-instance"] });

  await deleteDatabase(page);
});

scenario("storage.reload-generation", "close and reopen isolate an older cross-tab reload from the new repository generation", async ({ page }) => {
  await openHarness(page);
  await deleteDatabase(page);

  const result = await page.evaluate(async () => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    const repository = new IndexedDbCalendarRepository({
      sources: [{ id: "personal", title: "Personal", visible: true }],
    });
    await repository.open();

    const originalRead = repository.readPersistedState.bind(repository);
    let readCalls = 0;
    let releaseOld;
    let releaseFresh;
    let oldStartedResolve;
    let freshStartedResolve;
    const oldStarted = new Promise(resolve => { oldStartedResolve = resolve; });
    const freshStarted = new Promise(resolve => { freshStartedResolve = resolve; });
    const oldBlock = new Promise(resolve => { releaseOld = resolve; });
    const freshBlock = new Promise(resolve => { releaseFresh = resolve; });

    repository.readPersistedState = async (...args) => {
      readCalls += 1;
      if (readCalls === 1) {
        oldStartedResolve();
        await oldBlock;
      } else if (readCalls === 3) {
        freshStartedResolve();
        await freshBlock;
      }
      return await originalRead(...args);
    };

    const oldReload = repository.reloadFromStorage();
    await oldStarted;
    repository.close();
    await repository.open();

    const freshReload = repository.reloadFromStorage();
    await freshStarted;
    releaseOld();
    await oldReload;

    const coalescedReload = repository.reloadFromStorage();
    await new Promise(resolve => setTimeout(resolve, 0));
    const callsWhileFreshBlocked = readCalls;

    releaseFresh();
    await Promise.all([freshReload, coalescedReload]);
    const revision = repository.read().revision;
    repository.close();
    return { callsWhileFreshBlocked, finalReadCalls: readCalls, revision };
  });

  expect(result).toEqual({ callsWhileFreshBlocked: 3, finalReadCalls: 3, revision: 0 });
  await deleteDatabase(page);
});
