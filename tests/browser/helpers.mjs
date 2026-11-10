export const SOURCE = Object.freeze({
  id: "personal",
  title: "Personal",
  visible: true,
  sourceType: "personal",
  removable: true,
});

export const event = (id, overrides = {}) => ({
  id,
  calendarId: "personal",
  title: id,
  start: "2026-11-10T09:00:00.000Z",
  end: "2026-11-10T10:00:00.000Z",
  temporal: { kind: "instant" },
  kind: "event",
  ownership: "calendar",
  editPolicy: "full",
  ...overrides,
});

export function uniqueDatabaseName(testInfo, prefix) {
  return [
    "calendar-browser",
    prefix,
    testInfo.project.name,
    testInfo.workerIndex,
    testInfo.retry,
    Date.now(),
    Math.random().toString(36).slice(2),
  ].join("-");
}

export async function openRepository(page, databaseName, sources = [SOURCE]) {
  if (!page.url().includes("/tests/browser/harness.html")) {
    await page.goto("/tests/browser/harness.html");
  }
  await page.evaluate(async ({ databaseName, sources }) => {
    const { IndexedDbCalendarRepository } = await import("/dist/storage/indexeddb-repository.js");
    globalThis.__calendarRepo?.close?.();
    const repository = new IndexedDbCalendarRepository({ databaseName, sources });
    await repository.open();
    globalThis.__calendarRepo = repository;
  }, { databaseName, sources });
}

export async function closeRepository(page) {
  await page.evaluate(() => {
    globalThis.__calendarRepo?.close?.();
    delete globalThis.__calendarRepo;
    globalThis.__calendarUnsubscribe?.();
    delete globalThis.__calendarUnsubscribe;
  });
}

export async function repositoryState(page) {
  return await page.evaluate(() => globalThis.__calendarRepo.read());
}

export async function createItem(page, item) {
  await page.evaluate(async value => globalThis.__calendarRepo.create(value), item);
}

export async function updateItem(page, id, patch) {
  await page.evaluate(async ({ id, patch }) => globalThis.__calendarRepo.update(id, patch), { id, patch });
}

export async function removeItem(page, id) {
  await page.evaluate(async value => globalThis.__calendarRepo.remove(value), id);
}

export async function replaceAtRevision(page, items, expectedRevision) {
  return await page.evaluate(async ({ items, expectedRevision }) => {
    try {
      await globalThis.__calendarRepo.replaceAtRevision(items, expectedRevision);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        name: error instanceof Error ? error.name : String(error),
        message: error instanceof Error ? error.message : String(error),
        code: error?.code,
        expectedRevision: error?.expectedRevision,
        actualRevision: error?.actualRevision,
      };
    }
  }, { items, expectedRevision });
}

export async function subscribeRevisions(page) {
  await page.evaluate(() => {
    globalThis.__calendarRevisions = [];
    globalThis.__calendarUnsubscribe?.();
    globalThis.__calendarUnsubscribe = globalThis.__calendarRepo.subscribe(snapshot => {
      globalThis.__calendarRevisions.push(snapshot.revision);
    });
  });
}

export async function observedRevisions(page) {
  return await page.evaluate(() => [...(globalThis.__calendarRevisions ?? [])]);
}

export async function rawRecords(page, databaseName) {
  return await page.evaluate(async databaseName => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("calendar", "readonly").objectStore("calendar").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, databaseName);
}

export async function deleteDatabase(page, databaseName) {
  await page.evaluate(async databaseName => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`IndexedDB deletion blocked: ${databaseName}`));
    });
  }, databaseName);
}

export async function inspectDatabase(page, databaseName) {
  if (!page.url().includes("/tests/browser/harness.html")) {
    await page.goto("/tests/browser/harness.html");
  }
  return await page.evaluate(async databaseName => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = Array.from(db.objectStoreNames);
      const tx = names.length ? db.transaction(names, "readonly") : null;
      return {
        version: db.version,
        stores: names.map(name => {
          const store = tx.objectStore(name);
          return {
            name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames),
          };
        }),
      };
    } finally {
      db.close();
    }
  }, databaseName);
}

export async function createDatabase(page, databaseName, version, stores) {
  if (!page.url().includes("/tests/browser/harness.html")) {
    await page.goto("/tests/browser/harness.html");
  }
  await deleteDatabase(page, databaseName);
  await page.evaluate(async ({ databaseName, version, stores }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, version);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const spec of stores) {
          const options = {};
          if (Object.prototype.hasOwnProperty.call(spec, "keyPath")) options.keyPath = spec.keyPath;
          if (Object.prototype.hasOwnProperty.call(spec, "autoIncrement")) options.autoIncrement = spec.autoIncrement;
          const store = Object.keys(options).length
            ? db.createObjectStore(spec.name, options)
            : db.createObjectStore(spec.name);
          for (const index of spec.indexes ?? []) store.createIndex(index, index);
        }
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }, { databaseName, version, stores });
}

export async function disableBroadcastChannel(pageOrContext) {
  await pageOrContext.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });
}

export async function installSilentBroadcastChannel(page) {
  await page.addInitScript(() => {
    class SilentBroadcastChannel {
      onmessage = null;
      constructor(name) { this.name = name; }
      postMessage() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: SilentBroadcastChannel,
    });
  });
}
