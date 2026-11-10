import type {
  CalendarItem,
  CalendarItemPatch,
  CalendarRepository,
  CalendarSnapshot,
  CalendarSource,
  CalendarSourcePatch,
} from "../core/types.js";
import { CalendarStaleRevisionError } from "../core/revision.js";
import {
  applyCalendarItemPatch,
  applyCalendarSourcePatch,
  assertCalendarStateIntegrity,
  materializeCalendarSnapshot,
} from "../core/store.js";

const DATABASE_VERSION = 2;
const FORMAT_VERSION = 2;
const META_KEY = "meta" as const;
const LEGACY_KEY = "snapshot" as const;
const ITEM_PREFIX = "item:" as const;
const SOURCE_PREFIX = "source:" as const;

interface StoredMetaRecord {
  readonly key: typeof META_KEY;
  readonly type: "meta";
  readonly format: typeof FORMAT_VERSION;
  readonly revision: number;
  readonly itemOrder: readonly string[];
  readonly sourceOrder: readonly string[];
}

interface StoredItemRecord {
  readonly key: string;
  readonly type: "item";
  readonly id: string;
  readonly value: CalendarItem;
}

interface StoredSourceRecord {
  readonly key: string;
  readonly type: "source";
  readonly id: string;
  readonly value: CalendarSource;
}

interface LegacyStoredEnvelope {
  readonly key: typeof LEGACY_KEY;
  readonly revision: number;
  readonly items: CalendarItem[];
  readonly sources?: CalendarSource[];
}

interface PersistedCalendarState {
  readonly revision: number;
  readonly items: readonly CalendarItem[];
  readonly sources: readonly CalendarSource[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function idList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  const seen = new Set<string>();
  return value.map(entry => {
    if (typeof entry !== "string" || !entry || seen.has(entry)) throw new Error(`${label} is invalid`);
    seen.add(entry);
    return entry;
  });
}

function storedMeta(value: unknown): StoredMetaRecord | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, "Stored Calendar metadata");
  if (raw.key !== META_KEY || raw.type !== "meta" || raw.format !== FORMAT_VERSION
    || !Number.isInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new Error("Stored Calendar metadata is invalid");
  }
  return {
    key: META_KEY,
    type: "meta",
    format: FORMAT_VERSION,
    revision: Number(raw.revision),
    itemOrder: idList(raw.itemOrder, "Stored Calendar item order"),
    sourceOrder: idList(raw.sourceOrder, "Stored Calendar source order"),
  };
}

function legacyEnvelope(value: unknown): LegacyStoredEnvelope | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, "Stored legacy Calendar snapshot");
  if (raw.key !== LEGACY_KEY || !Number.isInteger(raw.revision) || Number(raw.revision) < 0 || !Array.isArray(raw.items)) {
    throw new Error("Stored legacy Calendar snapshot is invalid");
  }
  if (raw.sources !== undefined && !Array.isArray(raw.sources)) throw new Error("Stored legacy Calendar source collection is invalid");
  return raw as unknown as LegacyStoredEnvelope;
}

function itemKey(id: string): string { return `${ITEM_PREFIX}${id}`; }
function sourceKey(id: string): string { return `${SOURCE_PREFIX}${id}`; }

function sameEntity(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function changedEntities<T extends { readonly id: string }>(
  current: readonly T[],
  next: readonly T[],
): readonly T[] {
  const currentById = new Map(current.map(value => [value.id, value] as const));
  return next.filter(value => !sameEntity(currentById.get(value.id), value));
}

function removedIds<T extends { readonly id: string }>(
  current: readonly T[],
  next: readonly T[],
): readonly string[] {
  const nextIds = new Set(next.map(value => value.id));
  return current.filter(value => !nextIds.has(value.id)).map(value => value.id);
}

function orderedValues<T extends { readonly id: string }>(
  order: readonly string[],
  values: Map<string, T>,
  label: string,
): readonly T[] {
  if (order.length !== values.size) throw new Error(`${label} order does not match persisted records`);
  return order.map(id => {
    const value = values.get(id);
    if (!value) throw new Error(`${label} order references missing record ${id}`);
    return value;
  });
}

function openTransaction(db: IDBDatabase, storeName: string, mode: IDBTransactionMode): IDBTransaction {
  if (mode !== "readwrite") return db.transaction(storeName, mode);
  try {
    return db.transaction(storeName, mode, { durability: "strict" });
  } catch {
    return db.transaction(storeName, mode);
  }
}

export interface IndexedDbCalendarRepositoryOptions {
  readonly databaseName?: string;
  readonly storeName?: string;
  readonly sources: readonly CalendarSource[];
}

/**
 * Immutable in-memory snapshot + normalized durable records.
 * The public repository remains snapshot-oriented while IndexedDB writes only changed entities.
 */
export class IndexedDbCalendarRepository implements CalendarRepository {
  private readonly dbName: string;
  private readonly storeName: string;
  private snapshotValue: CalendarSnapshot | undefined;
  private readonly initialSources: readonly CalendarSource[];
  private loaded = false;
  private db: IDBDatabase | null = null;
  private channel: BroadcastChannel | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly listeners = new Set<(snapshot: CalendarSnapshot) => void>();

  public constructor(options: IndexedDbCalendarRepositoryOptions) {
    this.dbName = options.databaseName ?? "calendar";
    this.storeName = options.storeName ?? "calendar";
    this.initialSources = materializeCalendarSnapshot(undefined, options.sources, [], 0).sources;
  }

  public async open(): Promise<void> {
    if (this.loaded) return;
    let opened: IDBDatabase | null = null;
    try {
      opened = await this.openDatabase();
      this.db = opened;
      opened.onversionchange = () => this.close();

      await this.migrateLegacySnapshot();
      const persisted = await this.readPersistedState();
      this.snapshotValue = persisted
        ? materializeCalendarSnapshot(undefined, persisted.sources, persisted.items, persisted.revision)
        : materializeCalendarSnapshot(undefined, this.initialSources, [], 0);

      this.loaded = true;
      this.openInvalidationChannel();
    } catch (error) {
      this.channel?.close();
      this.channel = null;
      opened?.close();
      if (this.db === opened) this.db = null;
      this.snapshotValue = undefined;
      this.loaded = false;
      this.refreshPromise = null;
      throw error;
    }
  }

  public read(): CalendarSnapshot {
    if (!this.loaded || !this.snapshotValue) throw new Error("IndexedDbCalendarRepository.open() must complete before read()");
    return this.snapshotValue;
  }

  /** Release the browser database handle. The repository may be opened again later. */
  public close(): void {
    this.channel?.close();
    this.channel = null;
    this.db?.close();
    this.db = null;
    this.loaded = false;
    this.snapshotValue = undefined;
    this.refreshPromise = null;
  }

  public async create(item: CalendarItem): Promise<void> {
    const current = this.read();
    if (current.items.some(existing => existing.id === item.id)) throw new Error(`Duplicate calendar item: ${item.id}`);
    if (!current.sources.some(source => source.id === item.calendarId)) throw new Error(`Unknown calendar source: ${item.calendarId}`);
    await this.commit([...current.items, item], current.sources, current.revision);
  }

  public async update(id: string, patch: CalendarItemPatch): Promise<void> {
    const current = this.read();
    const index = current.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Calendar item not found: ${id}`);
    const next = applyCalendarItemPatch(current.items[index]!, patch);
    if (!current.sources.some(source => source.id === next.calendarId)) throw new Error(`Unknown calendar source: ${next.calendarId}`);
    await this.commit(current.items.map((item, i) => i === index ? next : item), current.sources, current.revision);
  }

  public async remove(id: string): Promise<void> {
    const current = this.read();
    const next = current.items.filter(item => item.id !== id);
    if (next.length === current.items.length) throw new Error(`Calendar item not found: ${id}`);
    await this.commit(next, current.sources, current.revision);
  }

  public async replace(items: readonly CalendarItem[]): Promise<void> {
    const current = this.read();
    assertCalendarStateIntegrity(current.sources, items);
    await this.commit(items, current.sources, current.revision);
  }

  public async replaceAtRevision(items: readonly CalendarItem[], expectedRevision: number): Promise<void> {
    const current = this.read();
    assertCalendarStateIntegrity(current.sources, items);
    await this.commit(items, current.sources, expectedRevision);
  }

  public async createSource(source: CalendarSource): Promise<void> {
    const current = this.read();
    if (current.sources.some(existing => existing.id === source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
    await this.commit(current.items, [...current.sources, source], current.revision);
  }

  public async updateSource(id: string, patch: CalendarSourcePatch): Promise<void> {
    const current = this.read();
    const index = current.sources.findIndex(source => source.id === id);
    if (index < 0) throw new Error(`Calendar source not found: ${id}`);
    const next = current.sources.map((source, i) => i === index ? applyCalendarSourcePatch(source, patch) : source);
    await this.commit(current.items, next, current.revision);
  }

  public async removeSource(id: string): Promise<void> {
    const current = this.read();
    const source = current.sources.find(row => row.id === id);
    if (!source) throw new Error(`Calendar source not found: ${id}`);
    if (source.removable !== true) throw new Error("Calendar source is not removable");
    if (current.items.some(item => item.calendarId === id)) throw new Error("Move or delete events from this calendar before removing it");
    await this.commit(current.items, current.sources.filter(row => row.id !== id), current.revision);
  }

  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async openDatabase(): Promise<IDBDatabase> {
    const existing = await this.openDatabaseRequest();
    if (existing.objectStoreNames.contains(this.storeName) && existing.version >= DATABASE_VERSION) return existing;

    const upgradeVersion = Math.max(DATABASE_VERSION, existing.version + 1);
    existing.close();
    return await this.openDatabaseRequest(upgradeVersion, true);
  }

  private async openDatabaseRequest(version?: number, requireStore = false): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = version === undefined ? indexedDB.open(this.dbName) : indexedDB.open(this.dbName, version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: "key" });
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error("Calendar storage upgrade is blocked by another open tab; reload or close the older tab and try again"));
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
        if (requireStore && !db.objectStoreNames.contains(this.storeName)) {
          settled = true;
          db.close();
          reject(new Error(`Calendar IndexedDB store was not created: ${this.storeName}`));
          return;
        }
        settled = true;
        resolve(db);
      };
    });
  }

  private async commit(
    items: readonly CalendarItem[],
    sources: readonly CalendarSource[],
    expectedRevision: number,
  ): Promise<void> {
    if (!this.loaded || !this.db) throw new Error("IndexedDbCalendarRepository.open() must complete first");
    assertCalendarStateIntegrity(sources, items);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("Expected Calendar revision must be a non-negative integer");
    }

    const current = this.read();
    const revision = expectedRevision + 1;
    const meta: StoredMetaRecord = {
      key: META_KEY,
      type: "meta",
      format: FORMAT_VERSION,
      revision,
      itemOrder: items.map(item => item.id),
      sourceOrder: sources.map(source => source.id),
    };
    const changedItems = changedEntities(current.items, items);
    const changedSources = changedEntities(current.sources, sources);
    const deletedItems = removedIds(current.items, items);
    const deletedSources = removedIds(current.sources, sources);
    let stale: CalendarStaleRevisionError | undefined;
    let transactionFailure: unknown;

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = openTransaction(this.db!, this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const metaRequest = store.get(META_KEY);
        metaRequest.onsuccess = () => {
          try {
            const persistedMeta = storedMeta(metaRequest.result);
            const actualRevision = persistedMeta?.revision ?? 0;
            if (actualRevision !== expectedRevision) {
              stale = new CalendarStaleRevisionError(expectedRevision, actualRevision);
              tx.abort();
              return;
            }

            const firstNormalizedWrite = persistedMeta === undefined;
            for (const item of firstNormalizedWrite ? items : changedItems) {
              const record: StoredItemRecord = { key: itemKey(item.id), type: "item", id: item.id, value: item };
              store.put(record);
            }
            for (const source of firstNormalizedWrite ? sources : changedSources) {
              const record: StoredSourceRecord = { key: sourceKey(source.id), type: "source", id: source.id, value: source };
              store.put(record);
            }
            if (!firstNormalizedWrite) {
              for (const id of deletedItems) store.delete(itemKey(id));
              for (const id of deletedSources) store.delete(sourceKey(id));
            }
            store.delete(LEGACY_KEY);
            store.put(meta);
          } catch (error) {
            transactionFailure = error;
            tx.abort();
          }
        };
        metaRequest.onerror = () => reject(metaRequest.error ?? new Error("Could not verify Calendar revision"));
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(stale ?? transactionFailure ?? tx.error ?? new Error("Calendar transaction aborted"));
        tx.onerror = () => { /* tx.onabort reports the durable failure once */ };
      });
    } catch (error) {
      if ((error as { readonly code?: unknown })?.code === "stale") await this.reloadFromStorage();
      throw error;
    }

    this.snapshotValue = materializeCalendarSnapshot(current, sources, items, revision);
    for (const listener of this.listeners) listener(this.snapshotValue);
    this.channel?.postMessage({ revision });
  }

  private openInvalidationChannel(): void {
    if (this.channel || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`@director/calendar:${this.dbName}:${this.storeName}`);
    channel.onmessage = event => {
      const value = event.data as { readonly revision?: unknown } | null;
      const revision = value && Number.isInteger(value.revision) ? Number(value.revision) : -1;
      if (!this.loaded || revision <= this.read().revision) return;
      void this.reloadFromStorage(revision);
    };
    this.channel = channel;
  }

  private async reloadFromStorage(minimumRevision = -1): Promise<void> {
    if (!this.loaded) return;
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = (async () => {
      const persisted = await this.readPersistedState();
      if (!this.loaded || !persisted) return;
      const current = this.read();
      if (persisted.revision <= current.revision || persisted.revision < minimumRevision) return;
      this.snapshotValue = materializeCalendarSnapshot(current, persisted.sources, persisted.items, persisted.revision);
      for (const listener of this.listeners) listener(this.snapshotValue);
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async migrateLegacySnapshot(): Promise<void> {
    if (!this.db) throw new Error("Calendar IndexedDB is not open");
    await new Promise<void>((resolve, reject) => {
      let failure: unknown;
      const tx = openTransaction(this.db!, this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const records = request.result as unknown[];
          if (records.some(value => {
            const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
            return raw?.key === META_KEY;
          })) return;

          const legacyValue = records.find(value => {
            const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
            return raw?.key === LEGACY_KEY;
          });
          const legacy = legacyEnvelope(legacyValue);
          if (!legacy) return;

          const sources = legacy.sources ?? this.initialSources;
          assertCalendarStateIntegrity(sources, legacy.items);
          const meta: StoredMetaRecord = {
            key: META_KEY,
            type: "meta",
            format: FORMAT_VERSION,
            revision: legacy.revision,
            itemOrder: legacy.items.map(item => item.id),
            sourceOrder: sources.map(source => source.id),
          };
          for (const item of legacy.items) {
            const record: StoredItemRecord = { key: itemKey(item.id), type: "item", id: item.id, value: item };
            store.put(record);
          }
          for (const source of sources) {
            const record: StoredSourceRecord = { key: sourceKey(source.id), type: "source", id: source.id, value: source };
            store.put(record);
          }
          store.put(meta);
          store.delete(LEGACY_KEY);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Could not inspect legacy Calendar storage"));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Calendar storage migration aborted"));
      tx.onerror = () => { /* tx.onabort reports the durable failure once */ };
    });
  }

  private async readPersistedState(): Promise<PersistedCalendarState | undefined> {
    if (!this.db) throw new Error("Calendar IndexedDB is not open");
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const tx = openTransaction(this.db!, this.storeName, "readonly");
      const request = tx.objectStore(this.storeName).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read Calendar storage"));
    });

    let meta: StoredMetaRecord | undefined;
    const items = new Map<string, CalendarItem>();
    const sources = new Map<string, CalendarSource>();

    for (const value of records) {
      const raw = record(value, "Stored Calendar record");
      if (raw.key === LEGACY_KEY) continue;
      if (raw.key === META_KEY) {
        if (meta) throw new Error("Duplicate stored Calendar metadata");
        meta = storedMeta(value);
        continue;
      }
      if (raw.type === "item") {
        const id = typeof raw.id === "string" ? raw.id : "";
        if (!id || raw.key !== itemKey(id) || items.has(id)) throw new Error("Stored Calendar item record is invalid");
        const valueRecord = record(raw.value, `Stored Calendar item ${id}`) as unknown as CalendarItem;
        if (valueRecord.id !== id) throw new Error(`Stored Calendar item identity mismatch: ${id}`);
        items.set(id, valueRecord);
        continue;
      }
      if (raw.type === "source") {
        const id = typeof raw.id === "string" ? raw.id : "";
        if (!id || raw.key !== sourceKey(id) || sources.has(id)) throw new Error("Stored Calendar source record is invalid");
        const valueRecord = record(raw.value, `Stored Calendar source ${id}`) as unknown as CalendarSource;
        if (valueRecord.id !== id) throw new Error(`Stored Calendar source identity mismatch: ${id}`);
        sources.set(id, valueRecord);
        continue;
      }
      throw new Error("Unknown stored Calendar record");
    }

    if (!meta) {
      if (items.size || sources.size) throw new Error("Stored Calendar records are missing metadata");
      return undefined;
    }
    const orderedItems = orderedValues(meta.itemOrder, items, "Stored Calendar item");
    const orderedSources = orderedValues(meta.sourceOrder, sources, "Stored Calendar source");
    assertCalendarStateIntegrity(orderedSources, orderedItems);
    return { revision: meta.revision, items: orderedItems, sources: orderedSources };
  }
}
