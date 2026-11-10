export const DEFAULT_CALENDAR_DATABASE_NAME = "director-calendar" as const;
export const CALENDAR_DATABASE_VERSION = 1 as const;
export const CALENDAR_STORE_NAME = "calendar" as const;
export const SYNC_STATE_STORE_NAME = "syncStates" as const;
export const REMINDER_RECEIPT_STORE_NAME = "reminderReceipts" as const;

const STORE_NAMES = [
  CALENDAR_STORE_NAME,
  SYNC_STATE_STORE_NAME,
  REMINDER_RECEIPT_STORE_NAME,
] as const;

function exactNames(names: DOMStringList, expected: readonly string[]): boolean {
  return names.length === expected.length && expected.every(name => names.contains(name));
}

export function assertCanonicalCalendarDatabase(db: IDBDatabase): void {
  if (db.version !== CALENDAR_DATABASE_VERSION || !exactNames(db.objectStoreNames, STORE_NAMES)) {
    throw new Error("Calendar IndexedDB does not match the canonical schema");
  }

  const tx = db.transaction([...STORE_NAMES], "readonly");
  const calendar = tx.objectStore(CALENDAR_STORE_NAME);
  if (calendar.keyPath !== "key" || calendar.autoIncrement || calendar.indexNames.length !== 0) {
    throw new Error("Calendar IndexedDB does not match the canonical schema");
  }

  for (const name of [SYNC_STATE_STORE_NAME, REMINDER_RECEIPT_STORE_NAME] as const) {
    const store = tx.objectStore(name);
    if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) {
      throw new Error("Calendar IndexedDB does not match the canonical schema");
    }
  }
}

export async function openCalendarDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable");

  return await new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DEFAULT_CALENDAR_DATABASE_NAME, CALENDAR_DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(CALENDAR_STORE_NAME, { keyPath: "key" });
      db.createObjectStore(SYNC_STATE_STORE_NAME);
      db.createObjectStore(REMINDER_RECEIPT_STORE_NAME);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Calendar IndexedDB open is blocked by another tab"));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open Calendar IndexedDB"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      try {
        assertCanonicalCalendarDatabase(db);
      } catch (error) {
        settled = true;
        db.close();
        reject(error);
        return;
      }
      settled = true;
      resolve(db);
    };
  });
}

export function openCalendarTransaction(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
): IDBTransaction {
  if (mode !== "readwrite") return db.transaction(storeNames, mode);
  try {
    return db.transaction(storeNames, mode, { durability: "strict" });
  } catch {
    return db.transaction(storeNames, mode);
  }
}
