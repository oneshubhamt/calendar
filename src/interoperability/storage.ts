import type {
  CalendarSyncConnectionState,
  CalendarSyncLink,
  ExternalEventIdentity,
  SyncStateStore,
} from "./sync.js";
import type { ReminderReceiptClaim, ReminderReceiptStore } from "./reminders.js";
import type { CalendarItem, ISODateTime } from "../core/types.js";
import { assertCalendarStateIntegrity } from "../core/store.js";
import { parseAbsoluteDateTime } from "../core/time.js";

const DB_NAME = "director-calendar.interop";
const DATABASE_VERSION = 1 as const;
const SYNC_STORE = "syncStates";
const REMINDER_STORE = "reminderReceipts";

export class IndexedDbSyncStateStore implements SyncStateStore {
  public constructor(private readonly dbName = DB_NAME) {}

  public async read(connectionId: string): Promise<CalendarSyncConnectionState | null> {
    const value = await getRecord<unknown>(this.dbName, SYNC_STORE, connectionId);
    return value === null ? null : validatedSyncState(value, connectionId);
  }

  public async write(state: CalendarSyncConnectionState): Promise<void> {
    const valid = validatedSyncState(state, state.connectionId);
    await putRecord(this.dbName, SYNC_STORE, valid, valid.connectionId);
  }

  public async remove(connectionId: string): Promise<void> { await deleteRecord(this.dbName, SYNC_STORE, connectionId); }
}

type StoredReminderReceipt =
  | { readonly key: string; readonly state: "claimed"; readonly claim: ReminderReceiptClaim }
  | { readonly key: string; readonly state: "delivered"; readonly deliveredAt: ISODateTime };

export class IndexedDbReminderReceiptStore implements ReminderReceiptStore {
  public constructor(private readonly dbName = DB_NAME) {}

  public async claim(key: string, claim: ReminderReceiptClaim): Promise<boolean> {
    const validClaim = validatedClaim(claim);
    const db = await openDb(this.dbName);
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = openTransaction(db, REMINDER_STORE, "readwrite");
        const store = tx.objectStore(REMINDER_STORE);
        let claimed = false;
        let failure: unknown = null;
        tx.oncomplete = () => resolve(claimed);
        tx.onabort = () => reject(failure ?? tx.error ?? new Error("Reminder claim transaction aborted."));
        tx.onerror = () => {
          if (!failure) failure = tx.error ?? new Error("Reminder claim transaction failed.");
        };
        const request = store.get(key);
        request.onerror = () => {
          failure = request.error ?? new Error("Reminder receipt read failed.");
        };
        request.onsuccess = () => {
          try {
            const existing = request.result === undefined ? null : validatedReminderReceipt(request.result, key);
            if (existing?.state === "delivered") return;
            if (existing?.state === "claimed" && Date.parse(existing.claim.expiresAt) > Date.parse(validClaim.claimedAt)) return;
            store.put({ key, state: "claimed", claim: validClaim } satisfies StoredReminderReceipt, key);
            claimed = true;
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      });
    } finally { db.close(); }
  }

  public async complete(key: string, token: string, deliveredAt: ISODateTime): Promise<void> {
    const validDeliveredAt = absoluteTimestamp(deliveredAt, "Reminder deliveredAt");
    await mutateReceipt(this.dbName, key, existing => {
      if (existing?.state !== "claimed" || existing.claim.token !== token) {
        throw new Error("Reminder receipt claim is no longer owned by this delivery");
      }
      return { key, state: "delivered", deliveredAt: validDeliveredAt };
    });
  }

  public async release(key: string, token: string): Promise<void> {
    await mutateReceipt(this.dbName, key, existing =>
      existing?.state === "claimed" && existing.claim.token === token ? null : existing);
  }

  public async prune(before: ISODateTime): Promise<void> {
    const cutoff = Date.parse(absoluteTimestamp(before, "Reminder receipt prune cutoff"));
    const db = await openDb(this.dbName);
    try {
      await transactionDone(db, REMINDER_STORE, "readwrite", store => {
        const cursor = store.openCursor();
        cursor.onerror = () => { throw cursor.error ?? new Error("Reminder receipt cursor failed."); };
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          const receipt = validatedReminderReceipt(current.value, String(current.key));
          if (receipt.state === "delivered" && Date.parse(receipt.deliveredAt) < cutoff) current.delete();
          current.continue();
        };
      });
    } finally {
      db.close();
    }
  }
}

const SYNC_MODES = new Set(["overlay", "import", "publish", "two-way"]);
const LINK_STATUSES = new Set(["clean", "pending-local", "pending-remote", "conflict", "deleted"]);

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) if (!permitted.has(key)) throw new Error(`${label} contains unexpected field ${key}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function absoluteTimestamp(value: unknown, label: string): ISODateTime {
  const raw = text(value, label);
  try {
    return parseAbsoluteDateTime(raw, label).toISOString();
  } catch {
    throw new Error(`${label} must be an absolute ISO date-time`);
  }
}

function identity(value: unknown, label: string): ExternalEventIdentity {
  const raw = objectRecord(value, label);
  exactKeys(raw, ["provider","connectionId","externalCalendarId","eventId","iCalUid","recurringEventId","originalStart","etag","sequence","updatedAt"], label);
  const sequence = raw.sequence;
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || Number(sequence) < 0)) throw new Error(`${label} sequence is invalid`);
  const updatedAt = raw.updatedAt === undefined ? undefined : absoluteTimestamp(raw.updatedAt, `${label} updatedAt`);
  return {
    provider: text(raw.provider, `${label} provider`),
    connectionId: text(raw.connectionId, `${label} connectionId`),
    externalCalendarId: text(raw.externalCalendarId, `${label} externalCalendarId`),
    eventId: text(raw.eventId, `${label} eventId`),
    ...(optionalText(raw.iCalUid, `${label} iCalUid`) ? { iCalUid: raw.iCalUid as string } : {}),
    ...(optionalText(raw.recurringEventId, `${label} recurringEventId`) ? { recurringEventId: raw.recurringEventId as string } : {}),
    ...(optionalText(raw.originalStart, `${label} originalStart`) ? { originalStart: raw.originalStart as string } : {}),
    ...(optionalText(raw.etag, `${label} etag`) ? { etag: raw.etag as string } : {}),
    ...(sequence !== undefined ? { sequence: Number(sequence) } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function validatedRemoteItem(value: unknown, label: string): CalendarItem {
  const raw = objectRecord(value, label);
  const calendarId = text(raw.calendarId, `${label} calendarId`);
  const item = structuredClone(value) as CalendarItem;
  assertCalendarStateIntegrity([{ id: calendarId, title: "Interoperability validation", visible: true }], [item]);
  return item;
}

interface SyncStateIdentityContext {
  readonly provider: string;
  readonly connectionId: string;
  readonly externalCalendarId: string;
  readonly localCalendarId: string;
}

function syncLink(value: unknown, state: SyncStateIdentityContext, label: string): CalendarSyncLink {
  const raw = objectRecord(value, label);
  exactKeys(raw, ["localItemId","identity","baseLocalFingerprint","baseRemoteFingerprint","baseRemoteItem","status","lastSyncedAt"], label);
  const parsedIdentity = identity(raw.identity, `${label} identity`);
  if (parsedIdentity.connectionId !== state.connectionId) throw new Error(`${label} connectionId does not match its state`);
  if (parsedIdentity.provider !== state.provider) throw new Error(`${label} provider does not match its state`);
  if (parsedIdentity.externalCalendarId !== state.externalCalendarId) throw new Error(`${label} externalCalendarId does not match its state`);
  if (!LINK_STATUSES.has(String(raw.status))) throw new Error(`${label} status is invalid`);
  const baseRemoteItem = raw.baseRemoteItem === undefined
    ? undefined
    : validatedRemoteItem(raw.baseRemoteItem, `${label} baseRemoteItem`);
  if (baseRemoteItem && baseRemoteItem.calendarId !== state.localCalendarId) {
    throw new Error(`${label} baseRemoteItem calendarId does not match its state`);
  }
  return {
    localItemId: text(raw.localItemId, `${label} localItemId`),
    identity: parsedIdentity,
    baseLocalFingerprint: text(raw.baseLocalFingerprint, `${label} baseLocalFingerprint`),
    baseRemoteFingerprint: text(raw.baseRemoteFingerprint, `${label} baseRemoteFingerprint`),
    ...(baseRemoteItem ? { baseRemoteItem } : {}),
    status: raw.status as CalendarSyncLink["status"],
    lastSyncedAt: absoluteTimestamp(raw.lastSyncedAt, `${label} lastSyncedAt`),
  };
}

function validatedSyncState(value: unknown, expectedConnectionId: string): CalendarSyncConnectionState {
  const raw = objectRecord(value, "Stored sync state");
  exactKeys(raw, ["provider","connectionId","mode","externalCalendarId","localCalendarId","syncToken","links","lastFullSyncAt","lastIncrementalSyncAt"], "Stored sync state");
  const provider = text(raw.provider, "Stored sync state provider");
  const connectionId = text(raw.connectionId, "Stored sync state connectionId");
  const externalCalendarId = text(raw.externalCalendarId, "Stored sync state externalCalendarId");
  const localCalendarId = text(raw.localCalendarId, "Stored sync state localCalendarId");
  if (connectionId !== expectedConnectionId) throw new Error("Stored sync state key does not match connectionId");
  if (!SYNC_MODES.has(String(raw.mode))) throw new Error("Stored sync state mode is invalid");
  if (!Array.isArray(raw.links)) throw new Error("Stored sync state links are invalid");
  const stateIdentity = { provider, connectionId, externalCalendarId, localCalendarId };
  const links = raw.links.map((entry, index) => syncLink(entry, stateIdentity, `Stored sync link ${index}`));
  const localIds = new Set<string>();
  const remoteIds = new Set<string>();
  for (const link of links) {
    if (localIds.has(link.localItemId)) throw new Error(`Stored sync state has duplicate local item ${link.localItemId}`);
    localIds.add(link.localItemId);
    const remote = `${link.identity.externalCalendarId}\u0000${link.identity.eventId}`;
    if (remoteIds.has(remote)) throw new Error(`Stored sync state has duplicate remote event ${link.identity.eventId}`);
    remoteIds.add(remote);
  }
  const lastFullSyncAt = raw.lastFullSyncAt === undefined ? undefined : absoluteTimestamp(raw.lastFullSyncAt, "Stored sync state lastFullSyncAt");
  const lastIncrementalSyncAt = raw.lastIncrementalSyncAt === undefined ? undefined : absoluteTimestamp(raw.lastIncrementalSyncAt, "Stored sync state lastIncrementalSyncAt");
  return {
    provider,
    connectionId,
    mode: raw.mode as CalendarSyncConnectionState["mode"],
    externalCalendarId,
    localCalendarId,
    ...(optionalText(raw.syncToken, "Stored sync state syncToken") ? { syncToken: raw.syncToken as string } : {}),
    links,
    ...(lastFullSyncAt !== undefined ? { lastFullSyncAt } : {}),
    ...(lastIncrementalSyncAt !== undefined ? { lastIncrementalSyncAt } : {}),
  };
}

function validatedClaim(claim: ReminderReceiptClaim): ReminderReceiptClaim {
  const raw = objectRecord(claim, "Reminder receipt claim");
  exactKeys(raw, ["token","claimedAt","expiresAt"], "Reminder receipt claim");
  const token = text(raw.token, "Reminder receipt claim token");
  const claimedAt = absoluteTimestamp(raw.claimedAt, "Reminder receipt claim claimedAt");
  const expiresAt = absoluteTimestamp(raw.expiresAt, "Reminder receipt claim expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) throw new Error("Reminder receipt claim expiry is invalid");
  return { token, claimedAt, expiresAt };
}

function validatedReminderReceipt(value: unknown, expectedKey: string): StoredReminderReceipt {
  const raw = objectRecord(value, "Stored reminder receipt");
  if (raw.key !== expectedKey) throw new Error("Stored reminder receipt key does not match its IndexedDB key");
  if (raw.state === "claimed") {
    exactKeys(raw, ["key","state","claim"], "Stored reminder receipt");
    return { key: expectedKey, state: "claimed", claim: validatedClaim(raw.claim as ReminderReceiptClaim) };
  }
  if (raw.state === "delivered") {
    exactKeys(raw, ["key","state","deliveredAt"], "Stored reminder receipt");
    return { key: expectedKey, state: "delivered", deliveredAt: absoluteTimestamp(raw.deliveredAt, "Stored reminder receipt deliveredAt") };
  }
  throw new Error("Stored reminder receipt state is invalid");
}

async function mutateReceipt(
  dbName: string,
  key: string,
  mutation: (existing: StoredReminderReceipt | null) => StoredReminderReceipt | null,
): Promise<void> {
  const db = await openDb(dbName);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = openTransaction(db, REMINDER_STORE, "readwrite");
      const store = tx.objectStore(REMINDER_STORE);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Reminder receipt transaction aborted."));
      tx.onerror = () => reject(tx.error ?? new Error("Reminder receipt transaction failed."));
      const request = store.get(key);
      request.onerror = () => reject(request.error ?? new Error("Reminder receipt read failed."));
      request.onsuccess = () => {
        try {
          const existing = request.result === undefined ? null : validatedReminderReceipt(request.result, key);
          const next = mutation(existing);
          if (next === null) store.delete(key);
          else store.put(next, key);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
    });
  } finally { db.close(); }
}

function exactNames(names: DOMStringList, expected: readonly string[]): boolean {
  return names.length === expected.length && expected.every(name => names.contains(name));
}

function assertCanonicalDatabase(db: IDBDatabase): void {
  if (db.version !== DATABASE_VERSION || !exactNames(db.objectStoreNames, [SYNC_STORE, REMINDER_STORE])) {
    throw new Error("Interoperability IndexedDB does not match the canonical schema");
  }
  const tx = db.transaction([SYNC_STORE, REMINDER_STORE], "readonly");
  for (const name of [SYNC_STORE, REMINDER_STORE]) {
    const store = tx.objectStore(name);
    if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) {
      throw new Error("Interoperability IndexedDB does not match the canonical schema");
    }
  }
}

async function openDb(dbName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable; provide a different interoperability state store.");
  return await new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(dbName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(SYNC_STORE);
      db.createObjectStore(REMINDER_STORE);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Interoperability IndexedDB open is blocked by another tab"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      try {
        assertCanonicalDatabase(db);
      } catch (error) {
        settled = true;
        db.close();
        reject(error);
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open interoperability IndexedDB."));
    };
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
