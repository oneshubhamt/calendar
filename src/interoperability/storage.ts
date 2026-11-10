import type { CalendarSyncConnectionState, SyncStateStore } from "./sync.js";
import type { ReminderReceiptStore } from "./reminders.js";
import type { ISODateTime } from "../core/types.js";

const DB_NAME = "calendar.interop";
const SYNC_STORE = "syncStates";
const REMINDER_STORE = "reminderReceipts";

export class IndexedDbSyncStateStore implements SyncStateStore {
  public constructor(private readonly dbName = DB_NAME) {}
  public async read(connectionId: string): Promise<CalendarSyncConnectionState | null> { return await getRecord<CalendarSyncConnectionState>(this.dbName, SYNC_STORE, connectionId); }
  public async write(state: CalendarSyncConnectionState): Promise<void> { await putRecord(this.dbName, SYNC_STORE, state, state.connectionId); }
  public async remove(connectionId: string): Promise<void> { await deleteRecord(this.dbName, SYNC_STORE, connectionId); }
}

export class IndexedDbReminderReceiptStore implements ReminderReceiptStore {
  public constructor(private readonly dbName = DB_NAME) {}
  public async has(key: string): Promise<boolean> { return Boolean(await getRecord<{ key: string; deliveredAt: ISODateTime }>(this.dbName, REMINDER_STORE, key)); }
  public async record(key: string, deliveredAt: ISODateTime): Promise<void> { await putRecord(this.dbName, REMINDER_STORE, { key, deliveredAt }, key); }
  public async prune(before: ISODateTime): Promise<void> {
    const db = await openDb(this.dbName);
    await transactionDone(db, REMINDER_STORE, "readwrite", store => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const value = current.value as { deliveredAt?: string };
        if (typeof value.deliveredAt === "string" && value.deliveredAt < before) current.delete();
        current.continue();
      };
    });
  }
}

async function openDb(dbName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable; provide a different interoperability state store.");
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SYNC_STORE)) db.createObjectStore(SYNC_STORE);
      if (!db.objectStoreNames.contains(REMINDER_STORE)) db.createObjectStore(REMINDER_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SYNC_STORE) || !db.objectStoreNames.contains(REMINDER_STORE)) {
        db.close();
        reject(new Error("Interoperability IndexedDB does not match the current schema."));
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open interoperability IndexedDB."));
  });
}

async function getRecord<T>(dbName: string, storeName: string, key: IDBValidKey): Promise<T | null> {
  const db = await openDb(dbName);
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = openTransaction(db, storeName, "readonly");
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed."));
    });
  } finally { db.close(); }
}

async function putRecord<T>(dbName: string, storeName: string, value: T, key: IDBValidKey): Promise<void> {
  const db = await openDb(dbName);
  try { await transactionDone(db, storeName, "readwrite", store => { store.put(value, key); }); }
  finally { db.close(); }
}

async function deleteRecord(dbName: string, storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDb(dbName);
  try { await transactionDone(db, storeName, "readwrite", store => { store.delete(key); }); }
  finally { db.close(); }
}

function openTransaction(db: IDBDatabase, storeName: string, mode: IDBTransactionMode): IDBTransaction {
  try { return db.transaction(storeName, mode, mode === "readwrite" ? { durability: "strict" } : undefined); }
  catch { return db.transaction(storeName, mode); }
}

async function transactionDone(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = openTransaction(db, storeName, mode);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    action(tx.objectStore(storeName));
  });
}
