import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { openHarness } from "../support/harness.mjs";
import { closeRepository, deleteDatabase, event, openRepository, repositoryState } from "../helpers.mjs";

scenario("storage.single-flight", "repository open is single-flight across concurrent callers", async ({ page }) => {
  await openHarness(page);
  await deleteDatabase(page);

  const result = await page.evaluate(async () => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    const repository = new IndexedDbCalendarRepository({
      sources: [{ id: "personal", title: "Personal", visible: true }],
    });
    const first = repository.open();
    const second = repository.open();
    const third = repository.open();
    const samePromise = first === second && second === third;
    await Promise.all([first, second, third]);
    const revision = repository.read().revision;
    repository.close();
    return { samePromise, revision };
  });

  expect(result).toEqual({ samePromise: true, revision: 0 });
  await deleteDatabase(page);
});

scenario("storage.close-open", "close during open cancels the pending lifecycle and cannot resurrect a closed repository", async ({ page }) => {
  await openHarness(page);
  await deleteDatabase(page);

  const result = await page.evaluate(async () => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    const repository = new IndexedDbCalendarRepository({
      sources: [{ id: "personal", title: "Personal", visible: true }],
    });
    const opening = repository.open();
    repository.close();

    let openError = null;
    try { await opening; } catch (error) { openError = String(error); }

    let readError = null;
    try { repository.read(); } catch (error) { readError = String(error); }
    return { openError, readError };
  });

  expect(result.openError).toMatch(/cancelled by close/i);
  expect(result.readError).toMatch(/open\(\) must complete before read/i);
  await deleteDatabase(page);
});

scenario("storage.reopen-race", "immediate reopen after close wins over an older in-flight open", async ({ page }) => {
  await openHarness(page);
  await deleteDatabase(page);

  const result = await page.evaluate(async () => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    const repository = new IndexedDbCalendarRepository({
      sources: [{ id: "personal", title: "Personal", visible: true }],
    });

    const firstOpen = repository.open();
    repository.close();
    const secondOpen = repository.open();
    const [first, second] = await Promise.allSettled([firstOpen, secondOpen]);
    const state = repository.read();

    await repository.create({
      id: "after-reopen",
      calendarId: "personal",
      title: "After reopen",
      start: "2026-11-10T09:00:00.000Z",
      end: "2026-11-10T10:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    });
    const committed = repository.read();
    repository.close();

    return {
      firstStatus: first.status,
      firstReason: first.status === "rejected" ? String(first.reason) : null,
      secondStatus: second.status,
      initialRevision: state.revision,
      committedRevision: committed.revision,
      itemIds: committed.items.map(item => item.id),
    };
  });

  expect(result).toMatchObject({
    firstStatus: "rejected",
    secondStatus: "fulfilled",
    initialRevision: 0,
    committedRevision: 1,
    itemIds: ["after-reopen"],
  });
  expect(result.firstReason).toMatch(/cancelled by close/i);

  await openRepository(page);
  expect(await repositoryState(page)).toMatchObject({
    revision: 1,
    items: [{ id: "after-reopen" }],
  });
  await closeRepository(page);
  await deleteDatabase(page);
});

scenario("storage.reopen", "one repository instance can close and reopen persisted state deterministically", async ({ page }) => {
  await openHarness(page);
  await deleteDatabase(page);

  const result = await page.evaluate(async () => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    const repository = new IndexedDbCalendarRepository({
      sources: [{ id: "personal", title: "Personal", visible: true }],
    });
    await repository.open();
    await repository.create({
      id: "persisted-same-instance",
      calendarId: "personal",
      title: "Persisted same instance",
      start: "2026-11-10T09:00:00.000Z",
      end: "2026-11-10T10:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    });
    repository.close();
    await repository.open();
    const snapshot = repository.read();
    repository.close();
    return { revision: snapshot.revision, itemIds: snapshot.items.map(item => item.id) };
  });

  expect(result).toEqual({ revision: 1, itemIds: ["persisted-same-instance"] });
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
