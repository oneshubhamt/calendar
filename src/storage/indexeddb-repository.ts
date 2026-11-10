import type {
  CalendarItem,
  CalendarItemPatch,
  CalendarRepository,
  CalendarSnapshot,
  CalendarSource,
  CalendarSourcePatch,
} from "../core/types.js";
import { CalendarStaleRevisionError } from "../core/revision.js";
import { sameCanonicalValue } from "../core/canonical-value.js";
import { notifyObservers } from "../core/notifications.js";
import {
  assertCalendarStateIntegrity,
  materializeCalendarSnapshot,
} from "../core/store.js";
import {
  createCalendarItemInState,
  createCalendarSourceInState,
  removeCalendarItemFromState,
  removeCalendarSourceFromState,
  updateCalendarItemInState,
  updateCalendarSourceInState,
  type CalendarStateCollections,
} from "../core/state-transitions.js";
import {
  CALENDAR_STORE_NAME,
  DEFAULT_CALENDAR_DATABASE_NAME,
  openCalendarDatabase,
  openCalendarTransaction,
} from "./browser-database.js";

const META_KEY = "meta" as const;
const ITEM_PREFIX = "item:" as const;
const SOURCE_PREFIX = "source:" as const;

interface StoredMetaRecord {
  readonly key: typeof META_KEY;
  readonly type: "meta";
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
  if (raw.key !== META_KEY || raw.type !== "meta"
    || !Number.isInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new Error("Stored Calendar metadata is invalid");
  }
  return {
    key: META_KEY,
    type: "meta",
    revision: Number(raw.revision),
    itemOrder: idList(raw.itemOrder, "Stored Calendar item order"),
    sourceOrder: idList(raw.sourceOrder, "Stored Calendar source order"),
  };
}

function itemKey(id: string): string { return `${ITEM_PREFIX}${id}`; }
function sourceKey(id: string): string { return `${SOURCE_PREFIX}${id}`; }

function changedEntities<T extends { readonly id: string }>(
  current: readonly T[],
  next: readonly T[],
): readonly T[] {
  const currentById = new Map(current.map(value => [value.id, value] as const));
  return next.filter(value => !sameCanonicalValue(currentById.get(value.id), value));
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

export interface IndexedDbCalendarRepositoryOptions {
  readonly databaseName?: string;
  readonly sources: readonly CalendarSource[];
}

/**
 * Immutable in-memory snapshot + normalized durable records.
 * The public repository remains snapshot-oriented while IndexedDB writes only changed entities.
 */
export class IndexedDbCalendarRepository implements CalendarRepository {
  private readonly dbName: string;
  private snapshotValue: CalendarSnapshot | undefined;
  private readonly initialSources: readonly CalendarSource[];
  private loaded = false;
  private db: IDBDatabase | null = null;
  private channel: BroadcastChannel | null = null;
  private storageInvalidation: { readonly key: string; readonly dispose: () => void } | null = null;
  private refreshPromise: Promise<void> | null = null;
  private requestedRefreshRevision = -1;
  private readonly listeners = new Set<(snapshot: CalendarSnapshot) => void>();

  public constructor(options: IndexedDbCalendarRepositoryOptions) {
    this.dbName = options.databaseName ?? DEFAULT_CALENDAR_DATABASE_NAME;
    this.initialSources = materializeCalendarSnapshot(undefined, options.sources, [], 0).sources;
  }

  public async open(): Promise<void> {
    if (this.loaded) return;
    let opened: IDBDatabase | null = null;
    try {
      opened = await openCalendarDatabase(this.dbName);
      this.db = opened;
      opened.onversionchange = () => this.close();

      const persisted = await this.readPersistedState();
      this.snapshotValue = persisted
        ? materializeCalendarSnapshot(undefined, persisted.sources, persisted.items, persisted.revision)
        : materializeCalendarSnapshot(undefined, this.initialSources, [], 0);

      this.loaded = true;
      this.openInvalidationChannel();
    } catch (error) {
      this.closeInvalidationChannel();
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
    this.closeInvalidationChannel();
    this.db?.close();
    this.db = null;
    this.loaded = false;
    this.snapshotValue = undefined;
    this.refreshPromise = null;
    this.requestedRefreshRevision = -1;
  }

  public async create(item: CalendarItem): Promise<void> {
    const current = this.read();
    await this.commit(createCalendarItemInState(current, item), current.revision);
  }

  public async update(id: string, patch: CalendarItemPatch): Promise<void> {
    const current = this.read();
    await this.commit(updateCalendarItemInState(current, id, patch), current.revision);
  }

  public async remove(id: string): Promise<void> {
    const current = this.read();
    await this.commit(removeCalendarItemFromState(current, id), current.revision);
  }

  public async replace(items: readonly CalendarItem[]): Promise<void> {
    const current = this.read();
    await this.commit({ sources: current.sources, items }, current.revision);
  }

  public async replaceAtRevision(items: readonly CalendarItem[], expectedRevision: number): Promise<void> {
    const current = this.read();
    await this.commit({ sources: current.sources, items }, expectedRevision);
  }

  public async createSource(source: CalendarSource): Promise<void> {
    const current = this.read();
    await this.commit(createCalendarSourceInState(current, source), current.revision);
  }

  public async updateSource(id: string, patch: CalendarSourcePatch): Promise<void> {
    const current = this.read();
    await this.commit(updateCalendarSourceInState(current, id, patch), current.revision);
  }

  public async removeSource(id: string): Promise<void> {
    const current = this.read();
    await this.commit(removeCalendarSourceFromState(current, id), current.revision);
  }

  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async commit(
    state: CalendarStateCollections,
    expectedRevision: number,
  ): Promise<void> {
    if (!this.loaded || !this.db) throw new Error("IndexedDbCalendarRepository.open() must complete first");
    const { items, sources } = state;
    assertCalendarStateIntegrity(sources, items);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("Expected Calendar revision must be a non-negative integer");
    }

    const current = this.read();
    if (current.revision !== expectedRevision) {
      throw new CalendarStaleRevisionError(expectedRevision, current.revision);
    }
    const revision = expectedRevision + 1;
    const meta: StoredMetaRecord = {
      key: META_KEY,
      type: "meta",
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
        const tx = openCalendarTransaction(this.db!, CALENDAR_STORE_NAME, "readwrite");
        const store = tx.objectStore(CALENDAR_STORE_NAME);
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
    notifyObservers(this.listeners, this.snapshotValue);
    this.publishInvalidation(revision);
  }

  private requestReload(revision = -1): void {
    void this.reloadFromStorage(revision).catch(() => {
      // Cross-context invalidation is advisory. Preserve a known missed target so a later
      // invalidation can retry; transactional revision CAS remains the write-safety boundary.
      if (this.loaded && revision >= 0) {
        this.requestedRefreshRevision = Math.max(this.requestedRefreshRevision, revision);
      }
    });
  }

  private requestRevisionCheck(): void {
    void this.readPersistedRevision().then(revision => {
      if (!this.loaded || revision <= this.read().revision) return;
      this.requestReload(revision);
    }).catch(() => {
      // Advisory freshness check only; the next signal or poll can retry.
    });
  }

  private openInvalidationChannel(): void {
    if (this.channel || this.storageInvalidation) return;
    const key = `@director/calendar:${this.dbName}:revision`;
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(`@director/calendar:${this.dbName}`);
      channel.onmessage = event => {
        const value = event.data as { readonly revision?: unknown } | null;
        const revision = value && Number.isInteger(value.revision) ? Number(value.revision) : -1;
        if (!this.loaded || revision <= this.read().revision) return;
        this.requestReload(revision);
      };
      this.channel = channel;
      return;
    }

    if (typeof window === "undefined") return;
    try {
      const onStorage = (event: StorageEvent): void => {
        if (event.key !== key || event.newValue === null || !this.loaded) return;
        const revision = Number(event.newValue);
        if (!Number.isInteger(revision) || revision <= this.read().revision) return;
        this.requestReload(revision);
      };
      const onForeground = (): void => {
        if (this.loaded) this.requestRevisionCheck();
      };
      const onVisibility = (): void => {
        if (document.visibilityState === "visible") onForeground();
      };
      const pollTimer = window.setInterval(onForeground, 3_000);
      window.addEventListener("storage", onStorage);
      window.addEventListener("focus", onForeground);
      window.addEventListener("pageshow", onForeground);
      document.addEventListener("visibilitychange", onVisibility);
      this.storageInvalidation = {
        key,
        dispose: () => {
          window.clearInterval(pollTimer);
          window.removeEventListener("storage", onStorage);
          window.removeEventListener("focus", onForeground);
          window.removeEventListener("pageshow", onForeground);
          document.removeEventListener("visibilitychange", onVisibility);
        },
      };
    } catch {
      // Cross-context freshness is best-effort; IndexedDB revision CAS still protects writes.
    }
  }

  private closeInvalidationChannel(): void {
    this.channel?.close();
    this.channel = null;
    this.storageInvalidation?.dispose();
    this.storageInvalidation = null;
  }

  private publishInvalidation(revision: number): void {
    if (this.channel) {
      try { this.channel.postMessage({ revision }); } catch { /* advisory invalidation only */ }
      return;
    }
    if (!this.storageInvalidation || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.storageInvalidation.key, String(revision));
    } catch {
      // Advisory invalidation failure cannot weaken transactional write correctness.
    }
  }

  private async reloadFromStorage(minimumRevision = -1): Promise<void> {
    if (!this.loaded) return;
    this.requestedRefreshRevision = Math.max(this.requestedRefreshRevision, minimumRevision);
    if (this.refreshPromise) return await this.refreshPromise;

    this.refreshPromise = (async () => {
      while (this.loaded) {
        this.requestedRefreshRevision = -1;

        const persisted = await this.readPersistedState();
        if (!this.loaded) return;
        if (persisted) {
          const current = this.read();
          if (persisted.revision > current.revision) {
            this.snapshotValue = materializeCalendarSnapshot(current, persisted.sources, persisted.items, persisted.revision);
            notifyObservers(this.listeners, this.snapshotValue);
          }
        }

        const currentRevision = this.read().revision;
        if (this.requestedRefreshRevision <= currentRevision) {
          this.requestedRefreshRevision = -1;
          return;
        }
      }
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
      if (!this.loaded) this.requestedRefreshRevision = -1;
    }
  }

  private async readPersistedRevision(): Promise<number> {
    if (!this.db) throw new Error("Calendar IndexedDB is not open");
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = openCalendarTransaction(this.db!, CALENDAR_STORE_NAME, "readonly");
      const request = tx.objectStore(CALENDAR_STORE_NAME).get(META_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not read Calendar revision"));
    });
    return storedMeta(value)?.revision ?? 0;
  }

  private async readPersistedState(): Promise<PersistedCalendarState | undefined> {
    if (!this.db) throw new Error("Calendar IndexedDB is not open");
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const tx = openCalendarTransaction(this.db!, CALENDAR_STORE_NAME, "readonly");
      const request = tx.objectStore(CALENDAR_STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read Calendar storage"));
    });

    let meta: StoredMetaRecord | undefined;
    const items = new Map<string, CalendarItem>();
    const sources = new Map<string, CalendarSource>();

    for (const value of records) {
      const raw = record(value, "Stored Calendar record");
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
